"""Trading-chain information exposed to the browser (never contains RPC URLs)."""

CHAINS = [{
    "chain": "bsc", "name": "BNB Smart Chain", "family": "evm",
    "enabled": True, "explorer": "https://bscscan.com", "native_symbol": "BNB",
}]


def chain_public_info() -> list[dict]:
    return [dict(item) for item in CHAINS]
