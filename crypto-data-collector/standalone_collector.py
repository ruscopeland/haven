"""
Standalone Alpha Data Collector
================================
Run this in its own terminal window. It connects to Binance Alpha WebSocket,
buckets every aggTrade into 1-minute intervals, and saves to crypto_data.db.
Latest 24hr ticker data is also stored per token.

Ctrl+C to stop cleanly. Arrow-up + Enter to restart.
"""

import sys
import os
import time
import asyncio
import json
import websockets
from collections import defaultdict
from datetime import datetime, timezone

# Ensure the project root is on the path so we can import sibling modules
sys.path.append(os.path.dirname(os.path.abspath(__file__)))

from sqlalchemy import func

from database.db import SessionLocal, engine, Base, ensure_db_settings, dialect_insert
from database.models import (Token, OneMinBucket, FifteenMinBucket, LatestTicker,
                             Heartbeat, DebugLog)
from fetcher.alpha_api import BinanceAlphaAPI


# ── Console logging (simple, visible, no file baggage) ──────────────────────
def log(msg, level="INFO"):
    ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    print(f"{ts} | {level:<8} | {msg}")


# ── Collector ────────────────────────────────────────────────────────────────
class AlphaCollector:
    WS_URL = "wss://nbstream.binance.com/w3w/wsa/stream"
    CHUNK_SIZE = 100
    FLUSH_INTERVAL = 10       # seconds between flushing completed buckets to DB
    RETENTION_DAYS = 7
    TICKER_INTERVAL = 60      # seconds between bulk-ticker syncs
    REST_TICKER_INTERVAL = 300  # seconds between REST API ticker fetch for quiet tokens
    ALPHA_VOLUME_INTERVAL = 60  # seconds between Alpha token-list volume/pct refreshes
    LIVE_PRICE_INTERVAL = 3   # seconds between persisting live trade prices to latest_tickers
    TOKEN_SYNC_INTERVAL = 24 * 60 * 60  # seconds between token-list refreshes
    DEBUG_LOG_RETENTION_HOURS = 48
    # 15-minute downsampled archive (Token Finder long lookback): recomputed
    # from one_min_buckets every ARCHIVE_INTERVAL over a rolling recent window
    # (idempotent — no incremental merge logic), retained ~90 days vs the
    # 1-minute table's 7. /universe reads it for older ranges.
    ARCHIVE_INTERVAL = 15 * 60          # seconds between archive recomputes
    ARCHIVE_WINDOW_MS = 2 * 60 * 60 * 1000   # recompute the last 2h each pass
    ARCHIVE_RETENTION_DAYS = 90

    def __init__(self):
        self.is_running = True

        # Symbols whose ticker data changed since the last DB save
        self._tickers_changed = set()
        # Symbols Binance REST reported as invalid — don't retry until restart
        self._invalid_symbols = set()
        # Set when the token list changed and the WS should resubscribe
        self._resubscribe = False

        # ── In-memory working buckets ──
        # { symbol: { bucket_start, open, high, low, close, buy_vol, sell_vol, trade_count } }
        self.buckets = {}

        # ── Tick-rule state ──
        self.last_prices = {}
        self.last_sides = {}  # False = Buy (up-tick), True = Sell (down-tick)

        # ── Latest ticker per symbol (updated on each ticker event) ──
        self.tickers = {}  # { symbol: { price_change_24h, volume_24h, last_price } }

    # ── helpers ──────────────────────────────────────────────────────────────

    @staticmethod
    def _minute_start(ts_ms: int) -> int:
        """Round down to the nearest minute boundary in ms."""
        return (ts_ms // 60_000) * 60_000

    @staticmethod
    def _now_ms() -> int:
        return int(time.time() * 1000)

    @staticmethod
    def _write_debug_log(source: str, level: str, message: str, metadata_json: str = None):
        """Write a structured debug log entry directly to the DB."""
        db = SessionLocal()
        try:
            db.add(DebugLog(
                source=source,
                level=level,
                message=message,
                timestamp=AlphaCollector._now_ms(),
                metadata_json=metadata_json,
            ))
            db.commit()
        except Exception:
            db.rollback()
        finally:
            db.close()

    @staticmethod
    def _now_minute() -> int:
        return AlphaCollector._minute_start(AlphaCollector._now_ms())

    # ── Token sync ───────────────────────────────────────────────────────────

    async def sync_tokens(self):
        """Upsert the active Alpha token list from Binance into the DB.

        Adds newly listed tokens, updates changed metadata, and removes tokens
        that are now delisted/offline. Returns True if the set of tradable
        symbols changed (caller should resubscribe the WebSocket).
        """
        db = SessionLocal()
        api = BinanceAlphaAPI()
        changed = False
        try:
            log("Syncing active Alpha tokens from Binance...")
            response = await api.get_all_tokens()
            existing = {t.id: t for t in db.query(Token).all()}
            seen_ids = set()
            added = updated = 0
            for t_data in response.get("data", []):
                if t_data.get("fullyDelisted") or t_data.get("offline"):
                    continue
                alpha_id = t_data.get("alphaId")
                token_id = t_data.get("tokenId")
                if not alpha_id or not token_id:
                    continue
                seen_ids.add(token_id)
                symbol = f"{alpha_id}USDT"
                name = f"{t_data.get('symbol')} ({t_data.get('name')})"
                chain_id = str(t_data.get("chainId"))
                contract = t_data.get("contractAddress")
                row = existing.get(token_id)
                if row is None:
                    db.add(Token(id=token_id, symbol=symbol, name=name,
                                 chain_id=chain_id, contract_address=contract))
                    added += 1
                elif (row.symbol != symbol or row.name != name
                      or row.chain_id != chain_id or row.contract_address != contract):
                    if row.symbol != symbol:
                        changed = True
                    row.symbol, row.name = symbol, name
                    row.chain_id, row.contract_address = chain_id, contract
                    updated += 1

            removed = 0
            if seen_ids:  # never wipe the table on an empty/short API response
                for token_id, row in existing.items():
                    if token_id not in seen_ids:
                        db.delete(row)
                        removed += 1

            db.commit()
            if added or removed:
                changed = True
            log(f"Token sync: +{added} added, {updated} updated, -{removed} removed "
                f"({len(seen_ids)} active pairs).")
            self._write_debug_log("collector", "INFO",
                f"Token sync: +{added}/-{removed} ({len(seen_ids)} active pairs)")
        except Exception as e:
            db.rollback()
            log(f"Token sync failed: {e}", "ERROR")
            self._write_debug_log("collector", "ERROR", f"Token sync failed: {e}")
        finally:
            await api.close()
            db.close()
        return changed

    # ── Bucket flushing ──────────────────────────────────────────────────────

    def _upsert_buckets(self, db, items):
        """Batch-upsert (symbol, bucket) pairs in ONE statement.

        Uses SQLite INSERT ... ON CONFLICT(symbol, bucket_start) DO UPDATE, which
        replaces the old per-row SELECT-then-update (N queries → 1) and is
        race-free against the composite PK.
        """
        if not items:
            return
        rows = [{
            "symbol": symbol,
            "bucket_start": b["bucket_start"],
            "open_price": b["open"],
            "high_price": b["high"],
            "low_price": b["low"],
            "close_price": b["close"],
            "buy_volume": b["buy_vol"],
            "sell_volume": b["sell_vol"],
            "trade_count": b["trade_count"],
        } for symbol, b in items]
        stmt = dialect_insert(OneMinBucket).values(rows)
        stmt = stmt.on_conflict_do_update(
            index_elements=["symbol", "bucket_start"],
            set_={
                "open_price": stmt.excluded.open_price,
                "high_price": stmt.excluded.high_price,
                "low_price": stmt.excluded.low_price,
                "close_price": stmt.excluded.close_price,
                "buy_volume": stmt.excluded.buy_volume,
                "sell_volume": stmt.excluded.sell_volume,
                "trade_count": stmt.excluded.trade_count,
            },
        )
        db.execute(stmt)

    def _flush_completed_buckets(self):
        """Flush all buckets whose minute has ended to the database.

        Also flushes orphaned buckets (tokens that stopped trading).
        A bucket is orphaned if its last trade was more than 5 minutes ago.
        """
        now_minute = self._now_minute()
        five_min_ago = now_minute - 5 * 60_000
        db = SessionLocal()
        flushed = 0
        total_symbols = len(self.buckets)
        try:
            to_flush = []
            for symbol, bucket in list(self.buckets.items()):
                # Normal: flush completed past minutes.
                # Orphaned: stale bucket still on the current minute (token went quiet).
                if bucket["bucket_start"] < now_minute or bucket["bucket_start"] < five_min_ago:
                    to_flush.append((symbol, bucket))

            self._upsert_buckets(db, to_flush)
            flushed = len(to_flush)
            for symbol, _ in to_flush:
                del self.buckets[symbol]

            if flushed:
                db.commit()
                self._write_debug_log("collector", "INFO",
                    f"Bucket flush: {flushed} completed bucket(s) saved to DB ({total_symbols} active in-memory)")

            # Prune buckets older than RETENTION_DAYS
            cutoff = self._now_ms() - self.RETENTION_DAYS * 24 * 60 * 60 * 1000
            deleted = db.query(OneMinBucket).filter(OneMinBucket.bucket_start < cutoff).delete()
            if deleted:
                db.commit()
                self._write_debug_log("collector", "INFO",
                    f"Pruned {deleted} bucket(s) older than {self.RETENTION_DAYS} days")

            # Prune old debug logs — this table grows fast and is the main DB bloat
            log_cutoff = self._now_ms() - self.DEBUG_LOG_RETENTION_HOURS * 60 * 60 * 1000
            pruned_logs = db.query(DebugLog).filter(DebugLog.timestamp < log_cutoff).delete()
            if pruned_logs:
                db.commit()

        except Exception as e:
            db.rollback()
            log(f"Bucket flush failed: {e}", "ERROR")
            self._write_debug_log("collector", "ERROR", f"Bucket flush failed: {e}")
        finally:
            db.close()

        if flushed:
            log(f"Flushed {flushed} completed bucket(s) to DB")

    def _archive_15m_buckets(self):
        """Downsample recent one_min_buckets into the fifteen_min_buckets archive.

        Recomputes the last ARCHIVE_WINDOW_MS from scratch each pass (an
        INSERT..ON CONFLICT full-row replace), so late-arriving 1m buckets are
        picked up on the next pass with zero merge logic. Open/close per group
        use first_value() window functions — portable across SQLite and
        Postgres (the old bare-column-with-MIN/MAX trick was SQLite-only).
        """
        interval = 15 * 60_000
        end_ms = (self._now_ms() // interval) * interval   # exclude in-progress group
        start_ms = end_ms - self.ARCHIVE_WINDOW_MS
        db = SessionLocal()
        try:
            # Modulo, not `/`: SQLAlchemy 2.0 renders `/` as true division,
            # which would degrade the GROUP BY to one group per 1m row.
            grp = OneMinBucket.bucket_start - (OneMinBucket.bucket_start % interval)

            def base(q):
                return (q.filter(OneMinBucket.bucket_start >= start_ms)
                         .filter(OneMinBucket.bucket_start < end_ms)
                         .group_by(OneMinBucket.symbol, grp))

            rows = {}
            agg = base(db.query(
                OneMinBucket.symbol, grp.label("g"),
                func.max(OneMinBucket.high_price), func.min(OneMinBucket.low_price),
                func.coalesce(func.sum(OneMinBucket.buy_volume), 0.0),
                func.coalesce(func.sum(OneMinBucket.sell_volume), 0.0),
                func.coalesce(func.sum(OneMinBucket.trade_count), 0),
            )).all()
            for sym, g, hi, lo, buy, sell, trades in agg:
                rows[(sym, int(g))] = {
                    "symbol": sym, "bucket_start": int(g),
                    "open_price": None, "high_price": hi, "low_price": lo,
                    "close_price": None, "buy_volume": buy, "sell_volume": sell,
                    "trade_count": trades,
                }
            # first_value over ascending/descending bucket_start = the group's
            # true open/close; DISTINCT collapses the window rows to one per group.
            oc = (db.query(
                      OneMinBucket.symbol.label("s"), grp.label("g"),
                      func.first_value(OneMinBucket.open_price).over(
                          partition_by=[OneMinBucket.symbol, grp],
                          order_by=OneMinBucket.bucket_start.asc()).label("o"),
                      func.first_value(OneMinBucket.close_price).over(
                          partition_by=[OneMinBucket.symbol, grp],
                          order_by=OneMinBucket.bucket_start.desc()).label("c"))
                  .filter(OneMinBucket.bucket_start >= start_ms)
                  .filter(OneMinBucket.bucket_start < end_ms)
                  .distinct().all())
            for sym, g, o, c in oc:
                if (sym, int(g)) in rows:
                    rows[(sym, int(g))]["open_price"] = o
                    rows[(sym, int(g))]["close_price"] = c

            if rows:
                # Chunked: 9 bind params per row against SQLite's variable cap.
                values = list(rows.values())
                for i in range(0, len(values), 500):
                    stmt = dialect_insert(FifteenMinBucket).values(values[i:i + 500])
                    stmt = stmt.on_conflict_do_update(
                        index_elements=["symbol", "bucket_start"],
                        set_={c: getattr(stmt.excluded, c)
                              for c in ("open_price", "high_price", "low_price", "close_price",
                                        "buy_volume", "sell_volume", "trade_count")},
                    )
                    db.execute(stmt)
                db.commit()

            cutoff = self._now_ms() - self.ARCHIVE_RETENTION_DAYS * 24 * 60 * 60 * 1000
            deleted = db.query(FifteenMinBucket).filter(
                FifteenMinBucket.bucket_start < cutoff).delete()
            if deleted:
                db.commit()
                self._write_debug_log("collector", "INFO",
                    f"Pruned {deleted} archive bucket(s) older than {self.ARCHIVE_RETENTION_DAYS} days")
            if rows:
                log(f"Archive: {len(rows)} fifteen-min bucket(s) upserted")
        except Exception as e:
            db.rollback()
            log(f"15m archive failed: {e}", "ERROR")
            self._write_debug_log("collector", "ERROR", f"15m archive failed: {e}")
        finally:
            db.close()

    def _flush_all_buckets(self):
        """Flush everything in-memory (used during shutdown)."""
        db = SessionLocal()
        count = 0
        try:
            items = list(self.buckets.items())
            self._upsert_buckets(db, items)
            count = len(items)
            if count:
                db.commit()
                log(f"Shutdown flush: {count} bucket(s) saved")
        except Exception as e:
            db.rollback()
            log(f"Shutdown flush failed: {e}", "ERROR")
        finally:
            db.close()

    # ── REST ticker sync ─────────────────────────────────────────────────────

    async def _sync_tickers_rest(self):
        """Fetch ticker data via REST for all tokens (fills in quiet ones).

        Binance only pushes 24hrTicker WebSocket events for tokens with recent
        activity. This REST call ensures every token has at least some data.
        """
        db = SessionLocal()
        try:
            tokens = db.query(Token).filter(Token.symbol.like("%USDT")).all()
        finally:
            db.close()

        if not tokens:
            return

        api = BinanceAlphaAPI()
        sem = asyncio.Semaphore(20)  # limit concurrent requests

        async def fetch_one(token):
            if token.symbol in self._invalid_symbols:
                return  # skip previously failed tokens
            async with sem:
                try:
                    resp = await api.get_ticker(token.symbol)
                    success = resp.get("success", False)
                    data = resp.get("data")
                    if success and data:
                        # 24h volume/pct now come from the Alpha token-list sync
                        # (aggregated figure matching the Binance Alpha page); this
                        # per-token endpoint only refreshes last_price for quiet tokens.
                        lp = float(data.get("lastPrice", 0))
                        old = self.tickers.get(token.symbol)
                        if old is None:
                            self.tickers[token.symbol] = {
                                "price_change_24h": 0.0, "volume_24h": 0.0, "last_price": lp,
                            }
                            self._tickers_changed.add(token.symbol)
                        elif old.get("last_price") != lp:
                            old["last_price"] = lp
                            self._tickers_changed.add(token.symbol)
                    elif not success:
                        # Binance explicitly rejected the symbol — cache so we don't retry.
                        # (success + empty data just means a quiet token: leave it alone.)
                        self._invalid_symbols.add(token.symbol)
                except Exception:
                    # Transient error (network, timeout, 5xx) — retry on the next sync.
                    pass

        await asyncio.gather(*[fetch_one(t) for t in tokens], return_exceptions=True)
        await api.close()
        log(f"REST ticker sync done - {len(self.tickers)} tokens have ticker data, "
            f"{len(self._invalid_symbols)} invalid tokens cached")

    def _write_heartbeat(self):
        """Write a heartbeat timestamp to the DB so the /health endpoint sees us."""
        db = SessionLocal()
        try:
            existing = db.query(Heartbeat).filter_by(process="collector").first()
            if existing:
                existing.last_heartbeat = self._now_ms()
            else:
                db.add(Heartbeat(process="collector", last_heartbeat=self._now_ms()))
            db.commit()
        except Exception:
            db.rollback()
        finally:
            db.close()

    async def _periodic_rest_ticker_sync(self):
        """Run REST ticker sync every REST_TICKER_INTERVAL seconds."""
        # Do one sync immediately to fill gaps fast
        await self._sync_tickers_rest()
        self._save_tickers()

        while self.is_running:
            await asyncio.sleep(self.REST_TICKER_INTERVAL)
            if self.is_running:
                await self._sync_tickers_rest()
                self._save_tickers()

    async def _periodic_alpha_volume_sync(self):
        """Refresh 24h volume + pct-change from the Alpha token-LIST endpoint.

        The per-token ticker endpoint's quoteVolume is CEX-order-book only and
        reads far lower than the aggregated 24h volume shown on the Binance Alpha
        page. The token-list endpoint (get_all_tokens) carries that aggregated
        figure per token, so it is the authoritative source for
        latest_tickers.volume_24h / price_change_24h. One bulk request covers
        every token. Runs immediately on start, then every ALPHA_VOLUME_INTERVAL.
        """
        while self.is_running:
            try:
                api = BinanceAlphaAPI()
                try:
                    resp = await api.get_all_tokens()
                finally:
                    await api.close()
                updated = 0
                for t in (resp or {}).get("data", []) or []:
                    alpha_id = t.get("alphaId")
                    if not alpha_id:
                        continue
                    symbol = f"{alpha_id}USDT"
                    try:
                        vol = float(t.get("volume24h") or 0)
                        pct = float(t.get("percentChange24h") or 0)
                    except (TypeError, ValueError):
                        continue
                    row = self.tickers.setdefault(
                        symbol, {"price_change_24h": pct, "volume_24h": vol, "last_price": 0.0})
                    row["volume_24h"] = vol
                    row["price_change_24h"] = pct
                    self._tickers_changed.add(symbol)
                    updated += 1
                await asyncio.to_thread(self._save_tickers)
                log(f"Alpha volume sync done - updated {updated} tokens from token list")
            except Exception as e:
                log(f"Alpha volume sync failed: {e}", "ERROR")
            await asyncio.sleep(self.ALPHA_VOLUME_INTERVAL)

    # ── Ticker persistence ───────────────────────────────────────────────────

    def _save_tickers(self):
        """Write the in-memory ticker state to the DB.

        Only writes tickers that have actually changed since the last save.
        """
        symbols_to_write = set(self._tickers_changed)
        if not symbols_to_write:
            return
        db = SessionLocal()
        try:
            for symbol in symbols_to_write:
                data = self.tickers.get(symbol)
                if not data:
                    continue
                existing = db.query(LatestTicker).filter_by(symbol=symbol).first()
                if existing:
                    existing.price_change_24h = data.get("price_change_24h", 0.0)
                    existing.volume_24h = data.get("volume_24h", 0.0)
                    existing.last_price = data.get("last_price", 0.0)
                    existing.last_updated = self._now_ms()
                else:
                    db.add(
                        LatestTicker(
                            symbol=symbol,
                            price_change_24h=data.get("price_change_24h", 0.0),
                            volume_24h=data.get("volume_24h", 0.0),
                            last_price=data.get("last_price", 0.0),
                            last_updated=self._now_ms(),
                        )
                    )
            db.commit()
            # Only clear what we actually wrote — new changes may have arrived meanwhile
            self._tickers_changed -= symbols_to_write
        except Exception as e:
            db.rollback()
            log(f"Ticker save failed: {e}", "ERROR")
        finally:
            db.close()

    def _save_live_prices(self):
        """Persist live trade prices (from the aggTrade WS stream) into latest_tickers.

        latest_tickers.last_price is what the wallet dashboard "Current" column and the
        marker execution engine read. The REST ticker sync only runs every few minutes,
        so without this those consumers would lag far behind the live market. Only the
        last_price/last_updated fields are touched here — the 24h pct/volume stay owned
        by the slower REST/WS ticker sync.
        """
        if not self.last_prices:
            return
        last_saved = getattr(self, "_last_saved_prices", {})
        changed = {s: p for s, p in self.last_prices.items() if last_saved.get(s) != p}
        if not changed:
            return
        db = SessionLocal()
        try:
            now = self._now_ms()
            existing = {
                r.symbol: r for r in db.query(LatestTicker)
                .filter(LatestTicker.symbol.in_(list(changed.keys()))).all()
            }
            for symbol, price in changed.items():
                row = existing.get(symbol)
                if row:
                    row.last_price = price
                    row.last_updated = now
                else:
                    db.add(LatestTicker(
                        symbol=symbol, price_change_24h=0.0, volume_24h=0.0,
                        last_price=price, last_updated=now,
                    ))
            db.commit()
            self._last_saved_prices = dict(self.last_prices)
        except Exception as e:
            db.rollback()
            log(f"Live price save failed: {e}", "ERROR")
        finally:
            db.close()

    # ── Trade processing ─────────────────────────────────────────────────────

    def _process_trade(self, symbol: str, price: float, qty: float, timestamp_ms: int, is_buyer_maker: bool):
        """Upsert a trade into the in-memory working bucket.

        Completed buckets are flushed to DB by the periodic flush task,
        not here — keeps this path fast.
        """
        bucket_start = self._minute_start(timestamp_ms)

        # If we already have a newer bucket for this symbol, this trade is stale — ignore
        if symbol in self.buckets and self.buckets[symbol]["bucket_start"] > bucket_start:
            return

        # If the trade belongs to a new minute, swap to a new bucket
        # (the old one will be flushed by periodic_flush on its next tick)
        if symbol in self.buckets and self.buckets[symbol]["bucket_start"] < bucket_start:
            del self.buckets[symbol]

        # Create or update bucket
        if symbol not in self.buckets:
            self.buckets[symbol] = {
                "bucket_start": bucket_start,
                "open": price,
                "high": price,
                "low": price,
                "close": price,
                "buy_vol": 0.0,
                "sell_vol": 0.0,
                "trade_count": 0,
            }

        b = self.buckets[symbol]
        vol = price * qty

        # OHLC
        if b["trade_count"] == 0:
            b["open"] = price
        b["high"] = max(b["high"], price)
        b["low"] = min(b["low"], price)
        b["close"] = price

        # Volume by side
        if is_buyer_maker:  # Sell — buyer was the maker (sell order ate by buyer)
            b["sell_vol"] += vol
        else:  # Buy
            b["buy_vol"] += vol

        b["trade_count"] += 1

    # ── WebSocket ────────────────────────────────────────────────────────────

    async def _run_ws(self):
        """Main WebSocket loop — connects, subscribes, processes events."""
        while self.is_running:
            try:
                # Re-read the token list on every (re)connect so newly synced
                # tokens get streams without a manual restart.
                db = SessionLocal()
                try:
                    tokens = db.query(Token).filter(Token.symbol.like("%USDT")).all()
                finally:
                    db.close()

                if not tokens:
                    log("No tokens found in database. Retrying sync in 60s...", "WARNING")
                    await asyncio.sleep(60)
                    await self.sync_tokens()
                    continue

                streams = []
                for t in tokens:
                    streams.append(f"{t.symbol.lower()}@aggTrade")
                    streams.append(f"{t.symbol.lower()}@ticker")

                log(f"Loaded {len(tokens)} tokens ({len(streams)} streams)")
                log(f"Connecting to Binance Alpha WebSocket...")
                async with websockets.connect(
                    self.WS_URL, ping_interval=20, ping_timeout=20
                ) as ws:
                    # Subscribe in chunks
                    for i in range(0, len(streams), self.CHUNK_SIZE):
                        chunk = streams[i : i + self.CHUNK_SIZE]
                        payload = {"method": "SUBSCRIBE", "params": chunk, "id": i // self.CHUNK_SIZE + 1}
                        await ws.send(json.dumps(payload))

                    log(f"Subscribed to {len(streams)} streams. Listening...")
                    self._write_debug_log("collector", "INFO",
                        f"WebSocket connected — subscribed to {len(streams)} streams ({len(tokens)} tokens)")

                    # Timer-based flush tasks run concurrently. The DB writes run in
                    # a worker thread (asyncio.to_thread) so a slow SQLite commit never
                    # stalls the WS message-processing loop.
                    async def periodic_flush():
                        while self.is_running:
                            await asyncio.sleep(self.FLUSH_INTERVAL)
                            await asyncio.to_thread(self._flush_completed_buckets)

                    async def periodic_ticker_save():
                        while self.is_running:
                            await asyncio.sleep(self.TICKER_INTERVAL)
                            if self.tickers:
                                await asyncio.to_thread(self._save_tickers)
                                log(f"Saved {len(self.tickers)} ticker records")
                                self._write_debug_log("collector", "INFO",
                                    f"Ticker save: {len(self.tickers)} records written to DB")

                    async def periodic_live_price_save():
                        while self.is_running:
                            await asyncio.sleep(self.LIVE_PRICE_INTERVAL)
                            await asyncio.to_thread(self._save_live_prices)

                    async def periodic_token_sync():
                        while self.is_running:
                            await asyncio.sleep(self.TOKEN_SYNC_INTERVAL)
                            if self.is_running and await self.sync_tokens():
                                # Token set changed — reconnect to pick up new streams
                                self._resubscribe = True

                    async def periodic_archive():
                        # First pass shortly after connect (backfills whatever the
                        # 2h window covers), then every 15 minutes.
                        await asyncio.sleep(30)
                        while self.is_running:
                            await asyncio.to_thread(self._archive_15m_buckets)
                            await asyncio.sleep(self.ARCHIVE_INTERVAL)

                    flush_task = asyncio.create_task(periodic_flush())
                    ticker_task = asyncio.create_task(periodic_ticker_save())
                    rest_ticker_task = asyncio.create_task(self._periodic_rest_ticker_sync())
                    alpha_volume_task = asyncio.create_task(self._periodic_alpha_volume_sync())
                    live_price_task = asyncio.create_task(periodic_live_price_save())
                    token_sync_task = asyncio.create_task(periodic_token_sync())
                    archive_task = asyncio.create_task(periodic_archive())

                    async def periodic_heartbeat():
                        while self.is_running:
                            self._write_heartbeat()
                            await asyncio.sleep(30)

                    heartbeat_task = asyncio.create_task(periodic_heartbeat())

                    try:
                        while self.is_running:
                            if self._resubscribe:
                                self._resubscribe = False
                                log("Token list changed — reconnecting to resubscribe streams...")
                                break
                            try:
                                message = await asyncio.wait_for(ws.recv(), timeout=1.0)
                            except asyncio.TimeoutError:
                                continue

                            try:
                                data = json.loads(message)
                            except json.JSONDecodeError:
                                continue

                            # Subscription acknowledgement
                            if "result" in data:
                                continue

                            raw = data.get("data")
                            if not raw:
                                continue

                            event_type = raw.get("e")

                            # ── AggTrade ──
                            if event_type == "aggTrade":
                                sym = raw.get("s")
                                price = float(raw.get("p", 0))
                                qty = float(raw.get("q", 0))
                                ts = int(raw.get("E", 0))

                                # Tick-rule: Binance Alpha's 'm' flag is unreliable,
                                # so we use price movement to determine side.
                                last_price = self.last_prices.get(sym, price)
                                last_side = self.last_sides.get(sym, False)

                                if price > last_price:
                                    is_sell = False  # Up-tick = buy
                                elif price < last_price:
                                    is_sell = True   # Down-tick = sell
                                else:
                                    is_sell = last_side  # Flat = inherit

                                self.last_prices[sym] = price
                                self.last_sides[sym] = is_sell

                                self._process_trade(sym, price, qty, ts, is_sell)

                            # ── 24hr Ticker ──
                            elif event_type == "24hrTicker":
                                sym = raw.get("s")
                                lp = float(raw.get("c", 0.0))
                                # 24h pct/volume now come from the Alpha token-list sync
                                # (aggregated figure matching the Binance Alpha page); the
                                # WS ticker only refreshes last_price here.
                                row = self.tickers.setdefault(
                                    sym, {"price_change_24h": 0.0, "volume_24h": 0.0, "last_price": lp})
                                row["last_price"] = lp
                                # Mark for persistence so periodic_ticker_save writes it —
                                # without this, WS ticker updates never reach the DB.
                                self._tickers_changed.add(sym)
                    finally:
                        background_tasks = [flush_task, ticker_task, rest_ticker_task,
                                            alpha_volume_task, live_price_task,
                                            token_sync_task, heartbeat_task, archive_task]
                        for task in background_tasks:
                            task.cancel()
                        for task in background_tasks:
                            try:
                                await task
                            except asyncio.CancelledError:
                                pass

            except websockets.exceptions.ConnectionClosed:
                log("WebSocket disconnected. Reconnecting in 5s...", "WARNING")
                self._write_debug_log("collector", "ERROR", "WebSocket disconnected — reconnecting in 5s")
                await asyncio.sleep(5)
            except Exception as e:
                log(f"WebSocket error: {e}. Reconnecting in 5s...", "ERROR")
                self._write_debug_log("collector", "ERROR", f"WebSocket error: {e} — reconnecting in 5s")
                await asyncio.sleep(5)

    # ── Run ──────────────────────────────────────────────────────────────────

    async def run_async(self):
        # Ensure tables exist with WAL mode
        Base.metadata.create_all(bind=engine)
        ensure_db_settings()
        log("Database tables ensured (WAL mode enabled).")
        # Sync tokens if needed
        await self.sync_tokens()

        log("=" * 55)
        log("   Alpha Data Collector started")
        log("   Saving 1-minute buckets to crypto_data.db")
        log("   Ctrl+C to stop cleanly")
        log("=" * 55)
        self._write_debug_log("collector", "INFO", "Alpha Data Collector started — saving 1-minute buckets")

        await self._run_ws()

    def run(self):
        try:
            asyncio.run(self.run_async())
        except KeyboardInterrupt:
            self.is_running = False
            log("\nShutting down... saving remaining buckets...")
            self._write_debug_log("collector", "INFO", "Shutdown signal received — flushing remaining data")
            self._flush_all_buckets()
            if self.tickers:
                self._save_tickers()
            log("Goodbye.")
            self._write_debug_log("collector", "INFO", "Collector shutdown complete")


if __name__ == "__main__":
    collector = AlphaCollector()
    collector.run()
