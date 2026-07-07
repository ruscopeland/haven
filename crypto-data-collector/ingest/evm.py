"""EVM decoding + price math (DATA-ROADMAP AD-D5) — dependency-free.

Everything here is pure functions over hex strings, unit-tested in
tests/test_ingest.py. Event layouts are the immutable on-chain ABI of
Uniswap/Pancake v2+v3 — they cannot drift under us.

Trade semantics: a swap where a QUOTE token flowed INTO the pool is a BUY of
the ranked token (someone paid quote to get token); token flowing in = SELL.
USD volume = |quote amount| × quote USD. OHLC uses the swap's own execution
price (quote/token) — immune to fee-on-transfer distortion because both
amounts are pool-side.
"""

# ── Event topic0 hashes (keccak of the canonical signatures) ─────────────────
TOPIC_V2_PAIR_CREATED = "0x0d3648bd0f6ba80134a33ba9275ac585d9d315f0ad8355cddefde31afa28d0e9"
TOPIC_V2_SWAP        = "0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822"
TOPIC_V2_SYNC        = "0x1c411e9a96e071241c2f21f7726b17ae89e3cab4c78be50e062b03a9fffbbad1"
TOPIC_V3_POOL_CREATED = "0x783cca1c0412dd0d695e784568c96da2e9c22ff989357a2e8b1d9b2b4e6b7118"
TOPIC_V3_SWAP        = "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67"

# ── ERC-20 / factory call selectors ──────────────────────────────────────────
SEL_SYMBOL       = "0x95d89b41"
SEL_NAME         = "0x06fdde03"
SEL_DECIMALS     = "0x313ce567"
SEL_TOTAL_SUPPLY = "0x18160ddd"
SEL_BALANCE_OF   = "0x70a08231"
SEL_V2_GET_PAIR  = "0xe6a43905"   # getPair(address,address)
SEL_V3_GET_POOL  = "0x1698ee82"   # getPool(address,address,uint24)
SEL_AGGREGATE3   = "0x82ad56cb"   # Multicall3.aggregate3((address,bool,bytes)[])

ZERO_ADDRESS = "0x" + "0" * 40


# ── Hex primitives ───────────────────────────────────────────────────────────

def _hx(data: str) -> str:
    return data[2:] if data.startswith("0x") else data


def word(data: str, i: int) -> str:
    """The i-th 32-byte word of ABI-encoded data, as a hex string (no 0x)."""
    h = _hx(data)
    return h[i * 64:(i + 1) * 64]


def uint(data: str, i: int) -> int:
    w = word(data, i)
    return int(w, 16) if w else 0


def sint(data: str, i: int) -> int:
    """Signed int256 (two's complement) at word i."""
    v = uint(data, i)
    return v - (1 << 256) if v >= (1 << 255) else v


def topic_address(topic: str) -> str:
    """An indexed address topic → lowercase 0x address."""
    return "0x" + _hx(topic)[-40:].lower()


def word_address(data: str, i: int) -> str:
    return "0x" + word(data, i)[-40:].lower()


def pad_address(addr: str) -> str:
    return _hx(addr).lower().rjust(64, "0")


def decode_string_result(data: str) -> str:
    """ERC-20 symbol()/name() result → str; tolerates bytes32-style tokens."""
    h = _hx(data or "")
    if not h:
        return ""
    try:
        if len(h) == 64:  # legacy bytes32 symbol
            raw = bytes.fromhex(h).rstrip(b"\x00")
            return raw.decode("utf-8", errors="replace")
        offset = int(h[:64], 16) * 2
        length = int(h[offset:offset + 64], 16) * 2
        raw = bytes.fromhex(h[offset + 64:offset + 64 + length])
        return raw.decode("utf-8", errors="replace")
    except (ValueError, IndexError):
        return ""


# ── Event decoders (each returns a plain dict or None if not applicable) ────

def decode_v2_swap(log: dict) -> dict:
    """amount0In, amount1In, amount0Out, amount1Out (uint256 ×4 in data)."""
    d = log["data"]
    return {"a0in": uint(d, 0), "a1in": uint(d, 1),
            "a0out": uint(d, 2), "a1out": uint(d, 3)}


def decode_v2_sync(log: dict) -> dict:
    d = log["data"]
    return {"reserve0": uint(d, 0), "reserve1": uint(d, 1)}


def decode_v3_swap(log: dict) -> dict:
    """int256 amount0, int256 amount1 (positive = INTO the pool), sqrtPriceX96."""
    d = log["data"]
    return {"a0": sint(d, 0), "a1": sint(d, 1),
            "sqrt_price_x96": uint(d, 2), "liquidity": uint(d, 3)}


def decode_v2_pair_created(log: dict) -> dict:
    return {"token0": topic_address(log["topics"][1]),
            "token1": topic_address(log["topics"][2]),
            "pool": word_address(log["data"], 0), "fee": 0}


def decode_v3_pool_created(log: dict) -> dict:
    return {"token0": topic_address(log["topics"][1]),
            "token1": topic_address(log["topics"][2]),
            "fee": int(_hx(log["topics"][3]), 16),
            # data = int24 tickSpacing, address pool
            "pool": word_address(log["data"], 1)}


# ── Trade extraction (pool row context → normalized trade) ──────────────────

def v2_trade(swap: dict, token_is_token0: bool,
             token_decimals: int, quote_decimals: int) -> dict | None:
    """Normalize a v2 swap into {is_buy, token_amount, quote_amount} (human units)."""
    if token_is_token0:
        token_in, token_out = swap["a0in"], swap["a0out"]
        quote_in, quote_out = swap["a1in"], swap["a1out"]
    else:
        token_in, token_out = swap["a1in"], swap["a1out"]
        quote_in, quote_out = swap["a0in"], swap["a0out"]
    if quote_in > 0 and token_out > 0:      # paid quote, received token = BUY
        is_buy, token_amt, quote_amt = True, token_out, quote_in
    elif token_in > 0 and quote_out > 0:    # paid token, received quote = SELL
        is_buy, token_amt, quote_amt = False, token_in, quote_out
    else:
        return None  # zero-amount or same-side flash weirdness — skip
    return {"is_buy": is_buy,
            "token_amount": token_amt / 10 ** token_decimals,
            "quote_amount": quote_amt / 10 ** quote_decimals}


def v3_trade(swap: dict, token_is_token0: bool,
             token_decimals: int, quote_decimals: int) -> dict | None:
    a_token = swap["a0"] if token_is_token0 else swap["a1"]
    a_quote = swap["a1"] if token_is_token0 else swap["a0"]
    if a_token == 0 or a_quote == 0:
        return None
    # positive = into the pool: quote in (+) & token out (−) = BUY
    is_buy = a_quote > 0
    return {"is_buy": is_buy,
            "token_amount": abs(a_token) / 10 ** token_decimals,
            "quote_amount": abs(a_quote) / 10 ** quote_decimals}


def trade_price_usd(trade: dict, quote_usd: float) -> float | None:
    """Execution price of the ranked token in USD."""
    if trade["token_amount"] <= 0:
        return None
    return (trade["quote_amount"] / trade["token_amount"]) * quote_usd


def v2_price_from_reserves(reserve_token: int, reserve_quote: int,
                           token_decimals: int, quote_decimals: int,
                           quote_usd: float) -> float | None:
    """Mid price from v2 reserves (used for anchors + sanity, AD-D5)."""
    if reserve_token <= 0:
        return None
    t = reserve_token / 10 ** token_decimals
    q = reserve_quote / 10 ** quote_decimals
    return (q / t) * quote_usd


def price_from_sqrt_x96(sqrt_price_x96: int, token0_decimals: int,
                        token1_decimals: int) -> float:
    """v3 slot0/swap price → human price of token0 denominated in token1.

    (sqrtPriceX96 / 2^96)^2 is raw-token1-per-raw-token0; decimal adjustment
    converts to human units. NEVER use pool token balances for a v3 price —
    concentrated liquidity makes the balance ratio meaningless (found live:
    WETH read $1,135 instead of $1,782 off the balance ratio).
    """
    p_raw = (sqrt_price_x96 / (1 << 96)) ** 2
    return p_raw * 10 ** (token0_decimals - token1_decimals)


# ── Call-data builders ───────────────────────────────────────────────────────

def calldata_balance_of(owner: str) -> str:
    return SEL_BALANCE_OF + pad_address(owner)


def calldata_v2_get_pair(a: str, b: str) -> str:
    return SEL_V2_GET_PAIR + pad_address(a) + pad_address(b)


def calldata_v3_get_pool(a: str, b: str, fee: int) -> str:
    return SEL_V3_GET_POOL + pad_address(a) + pad_address(b) + hex(fee)[2:].rjust(64, "0")


def encode_aggregate3(calls: list[tuple[str, str]]) -> str:
    """ABI-encode Multicall3.aggregate3([(target, allowFailure=True, calldata)…]).

    Hand-rolled head/tail encoding for exactly this one dynamic-struct-array
    signature — verified by a round-trip unit test against known vectors.
    """
    n = len(calls)
    head = "0000000000000000000000000000000000000000000000000000000000000020"  # array offset
    head += hex(n)[2:].rjust(64, "0")                                          # array length
    tails = []
    offsets = []
    running = 32 * n  # offsets are relative to the start of the array ELEMENTS block
    for target, data in calls:
        d = _hx(data)
        dlen = len(d) // 2
        padded = d.ljust(((dlen + 31) // 32) * 64, "0")
        tail = (pad_address(target)
                + "0" * 63 + "1"                      # allowFailure = true
                + "0000000000000000000000000000000000000000000000000000000000000060"  # bytes offset within struct
                + hex(dlen)[2:].rjust(64, "0")
                + padded)
        offsets.append(running)
        tails.append(tail)
        running += len(tail) // 2
    body = "".join(hex(o)[2:].rjust(64, "0") for o in offsets) + "".join(tails)
    return SEL_AGGREGATE3 + head + body


def decode_aggregate3(result: str, n: int) -> list[tuple[bool, str]]:
    """aggregate3 result → [(success, returnData_hex_with_0x)] × n."""
    h = _hx(result or "")
    if not h:
        return [(False, "0x")] * n
    arr_off = int(h[:64], 16) * 2
    length = int(h[arr_off:arr_off + 64], 16)
    elems_base = arr_off + 64
    out = []
    for i in range(min(n, length)):
        struct_off = int(h[elems_base + i * 64: elems_base + (i + 1) * 64], 16) * 2
        s = elems_base + struct_off
        success = int(h[s:s + 64], 16) == 1
        data_off = int(h[s + 64:s + 128], 16) * 2
        d = s + data_off
        dlen = int(h[d:d + 64], 16) * 2
        out.append((success, "0x" + h[d + 64:d + 64 + dlen]))
    while len(out) < n:
        out.append((False, "0x"))
    return out


# ── Slug assignment (AD-D1) ─────────────────────────────────────────────────

def sanitize_display_symbol(raw: str) -> str:
    # ASCII alnum only — slugs live in URLs, DB keys, and cp1252 consoles.
    s = "".join(ch for ch in (raw or "").upper()
                if ch.isalnum() and ch.isascii())[:12]
    return s or "TOKEN"


def make_slug(display: str, chain: str, taken: set, address: str) -> str:
    """"{DISPLAY}_{chain}", deterministic -addr4 suffix on collision. Stable forever."""
    slug = f"{display}_{chain}"
    if slug not in taken:
        return slug
    return f"{display}-{_hx(address)[:4]}_{chain}"
