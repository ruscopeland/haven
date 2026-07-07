"""Unit tests for ingest/evm.py — runnable standalone:  python tests/test_ingest.py

Covers the pure math the whole feed depends on: event decoding (v2/v3 swap,
sync, pool-created), buy/sell semantics, decimal handling, aggregate3
encode/decode round-trip, string decoding (incl. bytes32 symbols), slugs,
and the BucketStore aggregation path (in-memory, no DB).
"""
import os
import sys

sys.path.append(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

from ingest import evm  # noqa: E402

PASS = 0


def check(name, cond):
    global PASS
    if not cond:
        print(f"FAIL: {name}")
        sys.exit(1)
    PASS += 1
    print(f"  ok: {name}")


def w(v: int) -> str:
    return hex(v)[2:].rjust(64, "0")


def sw(v: int) -> str:  # signed word (two's complement)
    return w(v & ((1 << 256) - 1))


TOKEN = "0x1111111111111111111111111111111111111111"   # ranked token, 9 decimals
QUOTE = "0x2222222222222222222222222222222222222222"   # quote, 18 decimals
POOL = "0x3333333333333333333333333333333333333333"


def test_v2_swap_buy():
    # token is token0; buyer paid 2 quote in, got 100 token out
    log = {"data": "0x" + w(0) + w(2 * 10**18) + w(100 * 10**9) + w(0),
           "topics": ["", "", ""]}
    s = evm.decode_v2_swap(log)
    t = evm.v2_trade(s, True, 9, 18)
    check("v2 buy detected", t["is_buy"] is True)
    check("v2 buy token amount", abs(t["token_amount"] - 100) < 1e-9)
    check("v2 buy quote amount", abs(t["quote_amount"] - 2) < 1e-12)
    # price with quote at $600 → (2/100)*600 = $12
    check("v2 buy price", abs(evm.trade_price_usd(t, 600.0) - 12.0) < 1e-9)


def test_v2_swap_sell():
    # token is token1; seller paid 50 token in, got 1 quote out
    log = {"data": "0x" + w(0) + w(50 * 10**9) + w(1 * 10**18) + w(0),
           "topics": ["", "", ""]}
    s = evm.decode_v2_swap(log)
    t = evm.v2_trade(s, False, 9, 18)
    check("v2 sell detected", t["is_buy"] is False)
    check("v2 sell amounts", abs(t["token_amount"] - 50) < 1e-9
          and abs(t["quote_amount"] - 1) < 1e-12)


def test_v3_swap_signs():
    # token0 = ranked token: amount0 negative (token OUT), amount1 positive
    # (quote IN) = BUY. sqrtPrice/liquidity words present but unused here.
    log = {"data": "0x" + sw(-100 * 10**9) + sw(2 * 10**18) + w(1 << 96) + w(1) + sw(-5),
           "topics": ["", "", ""]}
    s = evm.decode_v3_swap(log)
    check("v3 signed decode", s["a0"] == -100 * 10**9 and s["a1"] == 2 * 10**18)
    t = evm.v3_trade(s, True, 9, 18)
    check("v3 buy detected", t["is_buy"] is True)
    check("v3 price", abs(evm.trade_price_usd(t, 600.0) - 12.0) < 1e-9)
    # flip: token into the pool = SELL
    log2 = {"data": "0x" + sw(100 * 10**9) + sw(-2 * 10**18) + w(1 << 96) + w(1) + sw(5),
            "topics": ["", "", ""]}
    t2 = evm.v3_trade(evm.decode_v3_swap(log2), True, 9, 18)
    check("v3 sell detected", t2["is_buy"] is False)


def test_pool_created_decode():
    v2 = {"topics": ["", "0x" + evm.pad_address(TOKEN), "0x" + evm.pad_address(QUOTE)],
          "data": "0x" + evm.pad_address(POOL) + w(7)}
    d = evm.decode_v2_pair_created(v2)
    check("v2 PairCreated", d["token0"] == TOKEN and d["token1"] == QUOTE
          and d["pool"] == POOL and d["fee"] == 0)
    v3 = {"topics": ["", "0x" + evm.pad_address(TOKEN), "0x" + evm.pad_address(QUOTE),
                     "0x" + w(2500)],
          "data": "0x" + w(50) + evm.pad_address(POOL)}
    d3 = evm.decode_v3_pool_created(v3)
    check("v3 PoolCreated", d3["pool"] == POOL and d3["fee"] == 2500)


def test_reserves_price():
    # 1000 token (9dec) vs 30 quote (18dec) at quote=$600 → 30/1000*600 = $18
    p = evm.v2_price_from_reserves(1000 * 10**9, 30 * 10**18, 9, 18, 600.0)
    check("reserves price", abs(p - 18.0) < 1e-9)


def test_aggregate3_roundtrip():
    calls = [(TOKEN, evm.SEL_DECIMALS), (QUOTE, evm.calldata_balance_of(POOL))]
    enc = evm.encode_aggregate3(calls)
    check("agg3 selector", enc.startswith(evm.SEL_AGGREGATE3))
    body = enc[len(evm.SEL_AGGREGATE3):]
    check("agg3 array offset", int(body[:64], 16) == 0x20)
    check("agg3 length", int(body[64:128], 16) == 2)
    # decode a synthetic result: [(true, uint 9), (true, uint 12345)]
    def res_struct(data_hex):
        dlen = len(data_hex) // 2
        return (w(1) + w(0x40) + w(dlen) + data_hex.ljust(((dlen + 31) // 32) * 64, "0"))
    s1, s2 = res_struct(w(9)), res_struct(w(12345))
    result = ("0x" + w(0x20) + w(2) + w(0x40) + w(0x40 + len(s1) // 2)
              + s1 + s2)
    out = evm.decode_aggregate3(result, 2)
    check("agg3 decode ok flags", out[0][0] and out[1][0])
    check("agg3 decode values", evm.uint(out[0][1], 0) == 9
          and evm.uint(out[1][1], 0) == 12345)


def test_string_decode():
    # standard string "CAKE"
    std = "0x" + w(0x20) + w(4) + "43414b45".ljust(64, "0")
    check("string decode", evm.decode_string_result(std) == "CAKE")
    # bytes32-style legacy symbol "MKR"
    b32 = "0x" + "4d4b52".ljust(64, "0")
    check("bytes32 decode", evm.decode_string_result(b32) == "MKR")
    check("garbage tolerated", evm.decode_string_result("0x") == "")


def test_sqrt_price():
    # WETH(18)/USDT(6), WETH=token0, target $1782: p_raw = 1782e-12
    # sqrtPriceX96 = sqrt(1782e-12) * 2^96
    sqrt_p = int((1782e-12 ** 0.5) if False else (1782e-12) ** 0.5 * (1 << 96))
    p = evm.price_from_sqrt_x96(sqrt_p, 18, 6)
    check("sqrt price math", abs(p - 1782.0) < 0.01)
    # inverted orientation: USDT(6)/WBNB(18) with USDT=token0 at BNB=$600
    # price of USDT in WBNB = 1/600 → p_raw human = 1/600
    sqrt_p2 = int(((1 / 600) * 10 ** (18 - 6)) ** 0.5 * (1 << 96))
    p2 = evm.price_from_sqrt_x96(sqrt_p2, 6, 18)
    check("sqrt price inverted", abs(1.0 / p2 - 600.0) < 0.01)


def test_slugs():
    check("sanitize", evm.sanitize_display_symbol(" pepe!2 ") == "PEPE2")
    check("sanitize empty", evm.sanitize_display_symbol("$$$") == "TOKEN")
    check("sanitize non-ascii", evm.sanitize_display_symbol("木ANA木") == "ANA")
    taken = set()
    s1 = evm.make_slug("PEPE", "bsc", taken, TOKEN)
    taken.add(s1)
    s2 = evm.make_slug("PEPE", "bsc", taken, QUOTE)
    check("slug base", s1 == "PEPE_bsc")
    check("slug collision suffix", s2 == "PEPE-2222_bsc")


def test_bucket_store():
    # In-memory aggregation only (no DB session touched).
    from ingest.store import BucketStore, minute_start
    st = BucketStore.__new__(BucketStore)
    st.buckets, st.last_prices = {}, {}
    st._last_saved_prices, st.tickers_dirty = {}, set()
    t0 = 1_700_000_000_000
    st.add_trade("PEPE_bsc", 1.0, 100.0, True, t0)
    st.add_trade("PEPE_bsc", 1.2, 50.0, False, t0 + 10_000)
    b = st.buckets["PEPE_bsc"]
    check("bucket ohlc", b["open"] == 1.0 and b["close"] == 1.2 and b["high"] == 1.2)
    check("bucket sides", b["buy_vol"] == 100.0 and b["sell_vol"] == 50.0)
    # minute rollover stashes the completed bucket instead of dropping it
    st.add_trade("PEPE_bsc", 1.3, 10.0, True, t0 + 61_000)
    check("rollover stash", len(getattr(st, "_stash", [])) == 1
          and st.buckets["PEPE_bsc"]["bucket_start"] == minute_start(t0 + 61_000))


if __name__ == "__main__":
    for fn in [test_v2_swap_buy, test_v2_swap_sell, test_v3_swap_signs,
               test_pool_created_decode, test_reserves_price, test_sqrt_price,
               test_aggregate3_roundtrip, test_string_decode, test_slugs,
               test_bucket_store]:
        print(fn.__name__)
        fn()
    print(f"\nALL {PASS} CHECKS PASSED")
