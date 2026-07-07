"""Per-chain EVM ingester (DATA-ROADMAP AD-D4).

The loop: every poll_seconds → head = eth_blockNumber − finality_lag → if new
blocks, eth_getLogs over the watched pools + factories → decode in
(block, logIndex) order → BucketStore. Reconnect/backfill is the SAME code
path with a wider range — an outage loses nothing (the chain replays).

Timestamps: one header fetch per processed range; other blocks interpolate at
the chain's block_time. ±2s on a 1-minute bucket is noise.

Single provider by owner decision (2026-07-07): failures here go LOUD —
heartbeat stops → health dot red → uptime alert; the engine's stale-price
guard (M3) stops trading meanwhile.
"""
import asyncio
import time

from database.db import SessionLocal
from database.models import EngineSetting

from . import evm
from .chains import CHAINS, rpc_url
from .rpc import RpcClient, RpcError
from .store import BucketStore, log, now_ms, write_debug_log
from .universe import UniverseManager

# Never backfill more than ~24h of blocks on startup; older gaps are noted
# and skipped (the 15m archive keeps the long series usable).
MAX_BACKFILL_SECONDS = 24 * 3600
ADDRESS_CHUNK = 800          # pools per getLogs call (provider filter caps)
BLOCK_CHUNK_LIVE = 2_000     # max blocks per getLogs in normal operation
MIN_TRADE_USD_FOR_PRICE = 1.0  # dust swaps still count volume, not OHLC

TRADE_TOPICS = [evm.TOPIC_V2_SWAP, evm.TOPIC_V3_SWAP,
                evm.TOPIC_V2_PAIR_CREATED, evm.TOPIC_V3_POOL_CREATED]


class EvmIngester:
    def __init__(self, chain: str, store: BucketStore):
        self.chain = chain
        self.cfg = CHAINS[chain]
        self.store = store
        self.rpc = RpcClient(rpc_url(chain))
        self.universe = UniverseManager(chain, self.rpc)
        self.last_ok = 0            # unix ms of last successful poll (health)
        self._native_slug = None
        self._logs_processed = 0
        self._factory_by_addr = {f["address"]: f for f in self.cfg["factories"]}
        # getLogs block-range that this provider actually allows — learned by
        # halving on errors (Alchemy free tier caps at 10), re-grown hourly so
        # a plan upgrade is picked up automatically.
        self._logs_step = BLOCK_CHUNK_LIVE

    # ── last-processed-block persistence (system KV in engine_settings) ─────

    def _kv_key(self):
        return f"ingest_last_block_{self.chain}"

    def _load_last_block(self) -> int | None:
        db = SessionLocal()
        try:
            row = (db.query(EngineSetting)
                   .filter_by(user_id="system", key=self._kv_key()).first())
            return int(row.value) if row else None
        finally:
            db.close()

    def _save_last_block(self, block: int):
        db = SessionLocal()
        try:
            row = (db.query(EngineSetting)
                   .filter_by(user_id="system", key=self._kv_key()).first())
            if row:
                row.value = str(block)
            else:
                db.add(EngineSetting(user_id="system", key=self._kv_key(),
                                     value=str(block)))
            db.commit()
        except Exception:
            db.rollback()
        finally:
            db.close()

    # ── Main loop ────────────────────────────────────────────────────────────

    async def run(self):
        await self.universe.bootstrap()
        db_native = self.universe._tid(self.universe.native_addr)
        db = SessionLocal()
        try:
            from database.models import Token
            row = db.query(Token).filter_by(id=db_native).first()
            self._native_slug = row.symbol if row else None
        finally:
            db.close()
        if self._native_slug and self.universe.native_usd > 0:
            self.store.set_live_price(self._native_slug, self.universe.native_usd)

        head = await self.rpc.block_number()
        target_start = head - self.cfg["finality_lag"]
        saved = self._load_last_block()
        max_back = int(MAX_BACKFILL_SECONDS / self.cfg["block_time"])
        if saved and target_start - saved > max_back:
            log(f"[{self.chain}] gap of {target_start - saved} blocks exceeds the "
                f"24h backfill cap — skipping ahead (data hole logged)", "WARNING")
            write_debug_log("ERROR", f"[{self.chain}] backfill cap hit: skipped "
                                     f"{target_start - saved} blocks")
            saved = None
        last = saved if saved else target_start - 1

        sweep_at = time.time() + 600
        report_at = time.time() + 3600
        while True:
            try:
                head = await self.rpc.block_number()
                target = head - self.cfg["finality_lag"]
                if target > last:
                    await self._process_range(last + 1, target)
                    last = target
                    self._save_last_block(last)
                    self.last_ok = now_ms()
                if time.time() >= sweep_at:
                    sweep_at = time.time() + 600
                    await self.universe.sweep()
                if time.time() >= report_at:
                    report_at = time.time() + 3600
                    self._logs_step = min(self._logs_step * 2, BLOCK_CHUNK_LIVE)
                    log(f"[{self.chain}] hourly: {self.rpc.calls} RPC calls, "
                        f"{self.rpc.batch_items} batch items, "
                        f"{self._logs_processed} logs so far")
                    write_debug_log("INFO",
                        f"[{self.chain}] usage: calls={self.rpc.calls} "
                        f"batch_items={self.rpc.batch_items} logs={self._logs_processed}")
            except (RpcError, Exception) as e:
                log(f"[{self.chain}] poll error: {e} — retrying", "ERROR")
                write_debug_log("ERROR", f"[{self.chain}] poll error: {e}")
                await asyncio.sleep(5)
            await asyncio.sleep(self.cfg["poll_seconds"])

    async def _process_range(self, from_block: int, to_block: int):
        total = to_block - from_block + 1
        if total > 100:
            log(f"[{self.chain}] backfilling {total} blocks "
                f"(step {self._logs_step})...")
        lo = from_block
        while lo <= to_block:
            hi = min(lo + max(self._logs_step, 1) * 10 - 1, to_block)
            await self._process_chunk(lo, hi)
            lo = hi + 1

    async def _process_chunk(self, lo: int, hi: int):
        addresses = list(self.universe.pool_ctx.keys()) + list(self._factory_by_addr)
        chunks = [addresses[i:i + ADDRESS_CHUNK]
                  for i in range(0, len(addresses), ADDRESS_CHUNK)] or [[]]

        async def fetch(addr_chunk):
            out, a = [], lo
            while a <= hi:
                b = min(a + self._logs_step - 1, hi)
                try:
                    out += await self.rpc.get_logs(a, b, addr_chunk, [TRADE_TOPICS])
                    a = b + 1
                except RpcError:
                    if self._logs_step > 8:  # range cap / too large → halve, sticky
                        self._logs_step = max(8, self._logs_step // 2)
                        continue
                    raise
            return out

        results = await asyncio.gather(*[fetch(c) for c in chunks])
        logs = [lg for r in results for lg in r]
        if not logs:
            return
        logs.sort(key=lambda lg: (int(lg["blockNumber"], 16), int(lg["logIndex"], 16)))

        # One header fetch anchors timestamps for the whole range.
        end_ts_s = await self.rpc.get_block_timestamp(hi)
        bt = self.cfg["block_time"]

        def ts_ms(block_num: int) -> int:
            return int((end_ts_s - (hi - block_num) * bt) * 1000)

        for lg in logs:
            self._logs_processed += 1
            topic0 = lg["topics"][0]
            addr = lg["address"].lower()
            if addr in self._factory_by_addr:
                f = self._factory_by_addr[addr]
                if topic0 == evm.TOPIC_V2_PAIR_CREATED and f["kind"] == "v2":
                    self.universe.on_pool_created(
                        evm.decode_v2_pair_created(lg), f["dex"], "v2")
                elif topic0 == evm.TOPIC_V3_POOL_CREATED and f["kind"] == "v3":
                    self.universe.on_pool_created(
                        evm.decode_v3_pool_created(lg), f["dex"], "v3")
                continue
            ctx = self.universe.pool_ctx.get(addr)
            if ctx is None:
                continue
            if topic0 == evm.TOPIC_V2_SWAP and ctx["kind"] == "v2":
                trade = evm.v2_trade(evm.decode_v2_swap(lg), ctx["token_is_token0"],
                                     ctx["token_decimals"], ctx["quote_decimals"])
            elif topic0 == evm.TOPIC_V3_SWAP and ctx["kind"] == "v3":
                trade = evm.v3_trade(evm.decode_v3_swap(lg), ctx["token_is_token0"],
                                     ctx["token_decimals"], ctx["quote_decimals"])
            else:
                continue
            if trade is None:
                continue
            quote_usd = 1.0 if ctx["pegged"] else self.universe.native_usd
            if quote_usd <= 0:
                continue
            usd_volume = trade["quote_amount"] * quote_usd
            price = evm.trade_price_usd(trade, quote_usd)
            if price is None or price <= 0:
                continue
            block_num = int(lg["blockNumber"], 16)
            if usd_volume >= MIN_TRADE_USD_FOR_PRICE:
                self.store.add_trade(ctx["slug"], price, usd_volume,
                                     trade["is_buy"], ts_ms(block_num))
            else:
                self.store.set_live_price(ctx["slug"], price)
            # Anchor-pool trades ARE the native/USD feed.
            if ctx["slug"] == self._native_slug and ctx["pegged"]:
                self.universe.native_usd = price
