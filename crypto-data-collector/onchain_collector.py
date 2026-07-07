"""
On-chain Data Collector (DATA-ROADMAP M2)
=========================================
Replaces the Binance-fed standalone_collector.py: reads DEX swaps directly
from the blockchains in the chain registry (ingest/chains.py) and writes the
SAME tables the whole stack already reads (one_min_buckets, latest_tickers,
fifteen_min_buckets, tokens, pools).

Run in its own terminal window (start.bat "Alpha Collector" window after the
M4 cutover). Ctrl+C stops cleanly and flushes in-memory buckets.

Env (crypto-data-collector/.env): RPC_HTTP_BSC / _ETHEREUM / _BASE — a chain
with no URL simply doesn't start. RETENTION_1M_DAYS / RETENTION_15M_DAYS
override retention.
"""
import sys
import os
import asyncio

sys.path.append(os.path.dirname(os.path.abspath(__file__)))

from database.db import engine, Base, ensure_db_settings
from ingest.chains import load_env_file, enabled_evm_chains
from ingest.evm_ingester import EvmIngester
from ingest.store import BucketStore, log, now_ms, write_debug_log


async def run_async():
    Base.metadata.create_all(bind=engine)
    ensure_db_settings()
    load_env_file()

    chains = enabled_evm_chains()
    if not chains:
        log("No chain RPC URLs configured — set RPC_HTTP_BSC etc. in "
            "crypto-data-collector/.env", "ERROR")
        return

    store = BucketStore()
    ingesters = [EvmIngester(c, store) for c in chains]

    log("=" * 55)
    log("   On-chain Data Collector started")
    log(f"   Chains: {', '.join(chains)}  (1m retention {store.RETENTION_DAYS}d, "
        f"15m archive {store.ARCHIVE_RETENTION_DAYS}d)")
    log("   Ctrl+C to stop cleanly")
    log("=" * 55)
    write_debug_log("INFO", f"On-chain collector started: {', '.join(chains)}")

    async def periodic(fn, seconds, *, thread=True, initial_delay=None):
        await asyncio.sleep(seconds if initial_delay is None else initial_delay)
        while True:
            try:
                if thread:
                    await asyncio.to_thread(fn)
                else:
                    await fn()
            except Exception as e:
                log(f"periodic {getattr(fn, '__name__', fn)} failed: {e}", "ERROR")
            await asyncio.sleep(seconds)

    def umbrella_heartbeat():
        # The existing UI health dot reads process="collector"; keep it alive
        # while ANY chain ingester polled successfully in the last 90s. Each
        # chain also heartbeats as collector:<chain> for per-chain health.
        alive = [i for i in ingesters if now_ms() - i.last_ok < 90_000]
        for i in ingesters:
            if now_ms() - i.last_ok < 90_000:
                BucketStore.heartbeat(f"collector:{i.chain}")
        if alive:
            BucketStore.heartbeat("collector")

    async def run_chain(ing):
        # One chain's failure never kills the others (alert-first, M0.1):
        # log loudly, let the heartbeat go stale, retry in a minute.
        while True:
            try:
                await ing.run()
            except Exception as e:
                log(f"[{ing.chain}] ingester crashed: {e} — retrying in 60s", "ERROR")
                write_debug_log("ERROR", f"[{ing.chain}] ingester crashed: {e}")
                await asyncio.sleep(60)

    tasks = [asyncio.create_task(run_chain(i)) for i in ingesters]
    tasks += [
        asyncio.create_task(periodic(store.flush_completed, 10)),
        asyncio.create_task(periodic(store.save_live_prices, 3)),
        asyncio.create_task(periodic(store.archive_15m, 15 * 60, initial_delay=60)),
        asyncio.create_task(periodic(store.compute_24h_stats, 5 * 60, initial_delay=90)),
        asyncio.create_task(periodic(umbrella_heartbeat, 30, initial_delay=30)),
    ]
    try:
        await asyncio.gather(*tasks)
    finally:
        for t in tasks:
            t.cancel()
        store.flush_all()
        for i in ingesters:
            await i.rpc.close()


def main():
    try:
        asyncio.run(run_async())
    except KeyboardInterrupt:
        log("Shutting down (buckets flushed by the run loop)...")
        write_debug_log("INFO", "On-chain collector shutdown")


if __name__ == "__main__":
    main()
