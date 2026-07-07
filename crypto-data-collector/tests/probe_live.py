"""Live-chain probe (needs RPC_HTTP_* in .env) — verifies the risky knowledge:
Multicall3 aggregate3 encoding against the real contract, factory addresses,
and event topic hashes, on every enabled chain.   python tests/probe_live.py
"""
import asyncio
import os
import sys

sys.path.append(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

from ingest import evm  # noqa: E402
from ingest.chains import CHAINS, MULTICALL3, load_env_file, enabled_evm_chains, rpc_url  # noqa: E402
from ingest.rpc import RpcClient  # noqa: E402


async def probe(chain):
    cfg = CHAINS[chain]
    rpc = RpcClient(rpc_url(chain))
    try:
        head = await rpc.block_number()
        native = cfg["native"]["address"]
        stables = [a for a, i in cfg["quotes"].items() if i[2]]
        # 1) Multicall3 aggregate3 round-trip: decimals + symbol of the native.
        res = await rpc.eth_call(MULTICALL3, evm.encode_aggregate3(
            [(native, evm.SEL_DECIMALS), (native, evm.SEL_SYMBOL)]))
        (ok1, d), (ok2, s) = evm.decode_aggregate3(res, 2)
        dec = evm.uint(d, 0) if ok1 else None
        sym = evm.decode_string_result(s) if ok2 else "?"
        assert dec == cfg["native"]["decimals"], f"decimals {dec}"
        print(f"[{chain}] head={head}  multicall OK  native={sym} dec={dec}")
        # 2) Factories answer getPair/getPool for native/stable.
        pair = None
        for f in cfg["factories"]:
            if f["kind"] == "v2":
                r = await rpc.eth_call(f["address"],
                                       evm.calldata_v2_get_pair(native, stables[0]))
                pair = evm.word_address(r, 0)
                assert pair != evm.ZERO_ADDRESS, f"{f['dex']} returned zero pair"
                print(f"[{chain}] {f['dex']} getPair OK -> {pair}")
            else:
                found = None
                for fee in cfg["v3_fee_tiers"]:
                    r = await rpc.eth_call(f["address"],
                                           evm.calldata_v3_get_pool(native, stables[0], fee))
                    p = evm.word_address(r, 0)
                    if p != evm.ZERO_ADDRESS:
                        found = (fee, p)
                        break
                assert found, f"{f['dex']} no pool at any fee tier"
                print(f"[{chain}] {f['dex']} getPool OK fee={found[0]} -> {found[1]}")
        # 3) Topic hashes are real: the v2 native/stable pair must have Swap+Sync
        #    logs recently (these pools trade constantly). Alchemy free tier
        #    caps getLogs at 10 blocks — walk back in 9-block windows.
        swaps, logs, hi = [], [], head
        for _ in range(40):
            got = await rpc.get_logs(hi - 8, hi, [pair],
                                     [[evm.TOPIC_V2_SWAP, evm.TOPIC_V2_SYNC]])
            logs += got
            swaps = [l for l in logs if l["topics"][0] == evm.TOPIC_V2_SWAP]
            if swaps:
                break
            hi -= 9
        assert swaps, "no swap logs in 360 blocks — topic hash or pair wrong"
        t = evm.v2_trade(evm.decode_v2_swap(swaps[-1]), True,
                         cfg["native"]["decimals"], cfg["quotes"][stables[0]][1])
        # native is token0 iff its address sorts below the stable's
        if native.lower() > stables[0].lower():
            t = evm.v2_trade(evm.decode_v2_swap(swaps[-1]), False,
                             cfg["native"]["decimals"], cfg["quotes"][stables[0]][1])
        px = evm.trade_price_usd(t, 1.0)
        print(f"[{chain}] topics OK - {len(swaps)} swaps/{len(logs) - len(swaps)} syncs "
              f"in ~10min; last native trade ~ ${px:,.2f}")
    finally:
        await rpc.close()


async def main():
    load_env_file()
    chains = enabled_evm_chains()
    print(f"probing: {chains}")
    for c in chains:
        await probe(c)
    print("\nLIVE PROBE PASSED")


if __name__ == "__main__":
    asyncio.run(main())
