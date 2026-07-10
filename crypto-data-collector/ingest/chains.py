"""Chain registry — the ONE place a chain is defined (DATA-ROADMAP AD-D3).

Adding an EVM chain = adding an entry here + an RPC_HTTP_<CHAIN> env var.
Every address is lowercase. Quote tokens are the ONLY tokens a pool may be
quoted in to be priced (AD-D5) — a scam pool against a garbage quote token
can never set a price. Stable quotes are pegged $1; the native wrapped token
is priced live from its own anchor stable pool.
"""
import os

# ── Tiny .env loader (no python-dotenv dependency) ──────────────────────────
_ENV_PATH = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), ".env")


def load_env_file(path: str = _ENV_PATH):
    """Load KEY=VALUE lines into os.environ (existing env vars win)."""
    try:
        with open(path, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, _, value = line.partition("=")
                key, value = key.strip(), value.split("#")[0].strip()
                if key and value and key not in os.environ:
                    os.environ[key] = value
    except FileNotFoundError:
        pass


MULTICALL3 = "0xca11bde05977b3631167028862be2a173976ca11"  # same address on all EVM chains

# Bulk-scan lane (NOT a live-feed failover — owner decision 2026-07-07 stands):
# one-time historical getLogs sweeps (bootstrap factory scan, big backfills)
# need thousand-block ranges that Alchemy's free tier caps at 10 blocks.
# These public endpoints are used ONLY for those one-time scans; if they're
# down the scan is skipped and the universe still works (legacy seed +
# forward-watch). Override with RPC_SCAN_<CHAIN> env vars.
SCAN_RPC_DEFAULTS = {
    "bsc": "https://bsc-rpc.publicnode.com",
    "ethereum": "https://ethereum-rpc.publicnode.com",
    "base": "https://base-rpc.publicnode.com",
}

# status flag used for ingester-created tokens until the M4 cutover
STAGED = "staged"

CHAINS = {
    "bsc": {
        "name": "BNB Smart Chain",
        "family": "evm",
        "enabled": True,
        "rpc_env": "RPC_HTTP_BSC",
        "explorer": "https://bscscan.com",
        "native": {  # wrapped native = a first-class token row (slug WBNB_bsc)
            "address": "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c",
            "symbol": "WBNB", "name": "Wrapped BNB", "decimals": 18,
        },
        # trusted quote tokens: address → (symbol, decimals, usd_pegged)
        "quotes": {
            "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c": ("WBNB", 18, False),
            "0x55d398326f99059ff775485246999027b3197955": ("USDT", 18, True),
            "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d": ("USDC", 18, True),
        },
        "factories": [
            {"dex": "pancake-v2", "kind": "v2",
             "address": "0xca143ce32fe78f1f7019d7d551a6402fc5350c73"},
            {"dex": "pancake-v3", "kind": "v3",
             "address": "0x0bfbcf9fa4f9c56b0f40a671ad40e0805a091865"},
        ],
        "v3_fee_tiers": [100, 500, 2500, 10000],
        # Cost model (owner decision 2026-07-07: BREADTH over latency, ≤$49/mo):
        # the Alchemy bill is per POLL, not per token — one getLogs (75 CU)
        # covers 800 pools; thousands of pools just add one call per 800.
        # Monthly ≈ (86400/poll_s) × (10 + 75×ceil(pools/800) + 16) × 30/1M
        # × $0.45 per chain. At 15s/30s/60s (bsc/base/eth) with ~4–6k pools
        # total: ≈ 100M CU ≈ $45/mo. Override with POLL_SECONDS_<CHAIN>.
        # BSC stays the fastest because live TP/SL protection fires off this
        # price (still 4 updates per 1m bar); strategies act on CLOSED bars
        # and don't care. POLL_SECONDS_BSC=60 shaves ~$20/mo if wanted.
        "poll_seconds": 15.0,
        # 8 blocks ≈ 6s: covers reorg depth AND Alchemy's load-balanced fleet
        # skew (their header nodes lag their tip nodes by a few blocks; at
        # lag=3 "block not yet available" fired every minute or two).
        "finality_lag": 8,
        "block_time": 0.75,         # avg seconds/block (timestamp interpolation)
        # Quality floor (owner 2026-07-10): $100k primary-pool depth. Pools
        # below this are not watched; tokens with no watched pool are retired
        # from /tokens and /signals. (Security/honeypot scoring is separate.)
        "liquidity_floor_usd": 100_000.0,
        "recent_pool_scan_days": 30,  # bootstrap factory-scan window (scan lane)
    },
    "ethereum": {
        "name": "Ethereum",
        "family": "evm",
        "enabled": True,
        "rpc_env": "RPC_HTTP_ETHEREUM",
        "explorer": "https://etherscan.io",
        "native": {
            "address": "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
            "symbol": "WETH", "name": "Wrapped Ether", "decimals": 18,
        },
        "quotes": {
            "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2": ("WETH", 18, False),
            "0xdac17f958d2ee523a2206206994597c13d831ec7": ("USDT", 6, True),
            "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48": ("USDC", 6, True),
        },
        "factories": [
            {"dex": "uniswap-v2", "kind": "v2",
             "address": "0x5c69bee701ef814a2b6a3edd4b1652cb9cc5aa6f"},
            {"dex": "uniswap-v3", "kind": "v3",
             "address": "0x1f98431c8ad98523631ae4a59f267346ea31f984"},
        ],
        "v3_fee_tiers": [100, 500, 3000, 10000],
        "poll_seconds": 15.0,   # equal treatment on all chains (owner order 2026-07-07)
        "finality_lag": 2,
        "block_time": 12.0,
        "liquidity_floor_usd": 100_000.0,  # same quality bar as BSC (owner 2026-07-10)
        "recent_pool_scan_days": 30,
    },
    "base": {
        "name": "Base",
        "family": "evm",
        "enabled": True,
        "rpc_env": "RPC_HTTP_BASE",
        "explorer": "https://basescan.org",
        "native": {
            "address": "0x4200000000000000000000000000000000000006",
            "symbol": "WETH", "name": "Wrapped Ether", "decimals": 18,
        },
        "quotes": {
            "0x4200000000000000000000000000000000000006": ("WETH", 18, False),
            "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913": ("USDC", 6, True),
        },
        "factories": [
            {"dex": "uniswap-v2", "kind": "v2",
             "address": "0x8909dc15e40173ff4699343b6eb8132c65e18ec6"},
            {"dex": "uniswap-v3", "kind": "v3",
             "address": "0x33128a8fc17869897dce68ed026d694621f6fdfd"},
            # Aerodrome uses a non-Uniswap event layout — config TODO for M5.
        ],
        "v3_fee_tiers": [100, 500, 3000, 10000],
        "poll_seconds": 15.0,   # equal treatment on all chains (owner order 2026-07-07)
        "finality_lag": 5,          # same provider-skew headroom as BSC
        "block_time": 2.0,
        "liquidity_floor_usd": 100_000.0,  # same quality bar as BSC (owner 2026-07-10)
        "recent_pool_scan_days": 30,
    },
    # Solana lands in DATA-ROADMAP M6 with its own (non-EVM) ingester module;
    # registered here so /chains and the UI know it exists.
    "solana": {
        "name": "Solana",
        "family": "svm",
        "enabled": False,
        "rpc_env": "RPC_HTTP_SOLANA",
        "explorer": "https://solscan.io",
    },
}

# Legacy Binance numeric chainId → our chain slug (remap tool, M4).
LEGACY_CHAIN_ID_MAP = {"56": "bsc", "1": "ethereum", "8453": "base"}


def poll_seconds(chain: str) -> float:
    """Cadence knob: POLL_SECONDS_<CHAIN> env overrides the registry default.

    This is the direct cost dial (see the bsc comment above): halving the
    cadence halves that chain's Alchemy bill; 15/30/30 fits the free tier.
    """
    try:
        return float(os.environ.get(f"POLL_SECONDS_{chain.upper()}",
                                    CHAINS[chain]["poll_seconds"]))
    except (TypeError, ValueError):
        return CHAINS[chain]["poll_seconds"]


def rpc_url(chain: str) -> str | None:
    cfg = CHAINS[chain]
    return os.environ.get(cfg["rpc_env"]) or None


def scan_rpc_url(chain: str) -> str | None:
    return os.environ.get(f"RPC_SCAN_{chain.upper()}") or SCAN_RPC_DEFAULTS.get(chain)


def enabled_evm_chains() -> list[str]:
    return [slug for slug, c in CHAINS.items()
            if c.get("enabled") and c.get("family") == "evm" and rpc_url(slug)]


def chain_public_info() -> list[dict]:
    """Shape served by GET /chains (no RPC URLs — those stay server-side)."""
    out = []
    for slug, c in CHAINS.items():
        out.append({
            "chain": slug, "name": c["name"], "family": c["family"],
            "enabled": bool(c.get("enabled")) and (c["family"] != "evm" or bool(rpc_url(slug))),
            "explorer": c.get("explorer"),
            "native_symbol": (c.get("native") or {}).get("symbol"),
        })
    return out
