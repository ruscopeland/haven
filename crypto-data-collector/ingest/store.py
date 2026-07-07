"""Bucket store — the DB-writing half of the on-chain collector.

Ported from standalone_collector.py (the proven flush/archive/prune/ticker
machinery) with the Binance-specific parts removed. One store instance is
shared by every chain ingester; buckets are keyed by token SLUG so the rest
of the stack (API, SDK, UI, engine) reads exactly the tables it always has.

24h ticker stats are OURS to compute now (no exchange feed): volume/pct come
from a periodic scan of the 15-minute archive (96 rows/token/day — cheap).
"""
import time
from datetime import datetime

from sqlalchemy import func

from database.db import SessionLocal, dialect_insert
from database.models import (OneMinBucket, FifteenMinBucket, LatestTicker,
                             Heartbeat, DebugLog)

import os


def env_int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, default))
    except (TypeError, ValueError):
        return default


def log(msg, level="INFO"):
    ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    line = f"{ts} | {level:<8} | {msg}"
    try:
        print(line)
    except UnicodeEncodeError:
        # Windows consoles are cp1252; token names can contain anything.
        print(line.encode("ascii", "replace").decode("ascii"))


def now_ms() -> int:
    return int(time.time() * 1000)


def minute_start(ts_ms: int) -> int:
    return (ts_ms // 60_000) * 60_000


def write_debug_log(level: str, message: str, metadata_json: str = None):
    db = SessionLocal()
    try:
        db.add(DebugLog(source="collector", level=level, message=message,
                        timestamp=now_ms(), metadata_json=metadata_json))
        db.commit()
    except Exception:
        db.rollback()
    finally:
        db.close()


class BucketStore:
    # Retention knobs surfaced per AD-D10 (owner: "a week or two" is fine).
    RETENTION_DAYS = env_int("RETENTION_1M_DAYS", 7)
    ARCHIVE_RETENTION_DAYS = env_int("RETENTION_15M_DAYS", 90)
    DEBUG_LOG_RETENTION_HOURS = 48
    ARCHIVE_WINDOW_MS = 2 * 60 * 60 * 1000

    def __init__(self):
        # { slug: {bucket_start, open, high, low, close, buy_vol, sell_vol, trade_count} }
        self.buckets: dict = {}
        self.last_prices: dict = {}          # slug → live price (3s save lifeline)
        self._last_saved_prices: dict = {}
        self.tickers_dirty: set = set()      # slugs whose 24h stats need a write

    # ── Trade ingestion (called by chain ingesters, in (block, logIndex) order) ──

    def add_trade(self, slug: str, price: float, usd_volume: float,
                  is_buy: bool, ts_ms: int):
        bucket_start = minute_start(ts_ms)
        b = self.buckets.get(slug)
        if b is not None and b["bucket_start"] > bucket_start:
            return  # stale (already rolled to a newer minute)
        if b is not None and b["bucket_start"] < bucket_start:
            self._stash_completed(slug, b)
            b = None
        if b is None:
            b = self.buckets[slug] = {
                "bucket_start": bucket_start, "open": price, "high": price,
                "low": price, "close": price, "buy_vol": 0.0, "sell_vol": 0.0,
                "trade_count": 0,
            }
        if b["trade_count"] == 0:
            b["open"] = price
        b["high"] = max(b["high"], price)
        b["low"] = min(b["low"], price)
        b["close"] = price
        if is_buy:
            b["buy_vol"] += usd_volume
        else:
            b["sell_vol"] += usd_volume
        b["trade_count"] += 1
        self.last_prices[slug] = price

    # Completed buckets displaced mid-flush-cycle are stashed so nothing is
    # lost between the 10s flush ticks (the old collector deleted + relied on
    # flush cadence; backfill can roll many minutes in one pass, so stash).
    def _stash_completed(self, slug: str, bucket: dict):
        self._stash = getattr(self, "_stash", [])
        self._stash.append((slug, bucket))

    def set_live_price(self, slug: str, price: float):
        self.last_prices[slug] = price

    # ── Flush / prune (10s cadence, ported behavior) ─────────────────────────

    def _upsert_buckets(self, db, items):
        if not items:
            return
        rows = [{
            "symbol": slug, "bucket_start": b["bucket_start"],
            "open_price": b["open"], "high_price": b["high"],
            "low_price": b["low"], "close_price": b["close"],
            "buy_volume": b["buy_vol"], "sell_volume": b["sell_vol"],
            "trade_count": b["trade_count"],
        } for slug, b in items]
        for i in range(0, len(rows), 500):  # bind-param cap safety
            stmt = dialect_insert(OneMinBucket).values(rows[i:i + 500])
            stmt = stmt.on_conflict_do_update(
                index_elements=["symbol", "bucket_start"],
                set_={c: getattr(stmt.excluded, c)
                      for c in ("open_price", "high_price", "low_price",
                                "close_price", "buy_volume", "sell_volume",
                                "trade_count")})
            db.execute(stmt)

    def flush_completed(self):
        now_minute = minute_start(now_ms())
        five_min_ago = now_minute - 5 * 60_000
        to_flush = list(getattr(self, "_stash", []))
        self._stash = []
        for slug, b in list(self.buckets.items()):
            if b["bucket_start"] < now_minute or b["bucket_start"] < five_min_ago:
                to_flush.append((slug, b))
                del self.buckets[slug]
        db = SessionLocal()
        try:
            self._upsert_buckets(db, to_flush)
            if to_flush:
                db.commit()
            cutoff = now_ms() - self.RETENTION_DAYS * 86_400_000
            deleted = db.query(OneMinBucket).filter(
                OneMinBucket.bucket_start < cutoff).delete()
            log_cutoff = now_ms() - self.DEBUG_LOG_RETENTION_HOURS * 3_600_000
            pruned = db.query(DebugLog).filter(DebugLog.timestamp < log_cutoff).delete()
            if deleted or pruned:
                db.commit()
        except Exception as e:
            db.rollback()
            log(f"Bucket flush failed: {e}", "ERROR")
            write_debug_log("ERROR", f"Bucket flush failed: {e}")
        finally:
            db.close()
        if to_flush:
            log(f"Flushed {len(to_flush)} completed bucket(s)")

    def flush_all(self):
        """Shutdown flush — everything in memory, including in-progress minutes."""
        items = list(getattr(self, "_stash", [])) + list(self.buckets.items())
        self._stash, self.buckets = [], {}
        db = SessionLocal()
        try:
            self._upsert_buckets(db, items)
            if items:
                db.commit()
                log(f"Shutdown flush: {len(items)} bucket(s) saved")
        except Exception as e:
            db.rollback()
            log(f"Shutdown flush failed: {e}", "ERROR")
        finally:
            db.close()

    # ── 15m archive (verbatim port — incl. the %-not-/ GROUP BY gotcha) ─────

    def archive_15m(self):
        interval = 15 * 60_000
        end_ms = (now_ms() // interval) * interval
        start_ms = end_ms - self.ARCHIVE_WINDOW_MS
        db = SessionLocal()
        try:
            grp = OneMinBucket.bucket_start - (OneMinBucket.bucket_start % interval)
            rows = {}
            agg = (db.query(
                       OneMinBucket.symbol, grp.label("g"),
                       func.max(OneMinBucket.high_price), func.min(OneMinBucket.low_price),
                       func.coalesce(func.sum(OneMinBucket.buy_volume), 0.0),
                       func.coalesce(func.sum(OneMinBucket.sell_volume), 0.0),
                       func.coalesce(func.sum(OneMinBucket.trade_count), 0))
                   .filter(OneMinBucket.bucket_start >= start_ms)
                   .filter(OneMinBucket.bucket_start < end_ms)
                   .group_by(OneMinBucket.symbol, grp).all())
            for sym, g, hi, lo, buy, sell, trades in agg:
                rows[(sym, int(g))] = {
                    "symbol": sym, "bucket_start": int(g),
                    "open_price": None, "high_price": hi, "low_price": lo,
                    "close_price": None, "buy_volume": buy, "sell_volume": sell,
                    "trade_count": trades}
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
                values = list(rows.values())
                for i in range(0, len(values), 500):
                    stmt = dialect_insert(FifteenMinBucket).values(values[i:i + 500])
                    stmt = stmt.on_conflict_do_update(
                        index_elements=["symbol", "bucket_start"],
                        set_={c: getattr(stmt.excluded, c)
                              for c in ("open_price", "high_price", "low_price",
                                        "close_price", "buy_volume", "sell_volume",
                                        "trade_count")})
                    db.execute(stmt)
                db.commit()
            cutoff = now_ms() - self.ARCHIVE_RETENTION_DAYS * 86_400_000
            deleted = db.query(FifteenMinBucket).filter(
                FifteenMinBucket.bucket_start < cutoff).delete()
            if deleted:
                db.commit()
        except Exception as e:
            db.rollback()
            log(f"15m archive failed: {e}", "ERROR")
            write_debug_log("ERROR", f"15m archive failed: {e}")
        finally:
            db.close()

    # ── latest_tickers: live price (3s) + computed 24h stats (5 min) ────────

    def save_live_prices(self):
        changed = {s: p for s, p in self.last_prices.items()
                   if self._last_saved_prices.get(s) != p}
        if not changed:
            return
        db = SessionLocal()
        try:
            ts = now_ms()
            existing = {r.symbol: r for r in db.query(LatestTicker)
                        .filter(LatestTicker.symbol.in_(list(changed.keys()))).all()}
            for slug, price in changed.items():
                row = existing.get(slug)
                if row:
                    row.last_price = price
                    row.last_updated = ts
                else:
                    db.add(LatestTicker(symbol=slug, price_change_24h=0.0,
                                        volume_24h=0.0, last_price=price,
                                        last_updated=ts))
            db.commit()
            self._last_saved_prices.update(changed)
        except Exception as e:
            db.rollback()
            log(f"Live price save failed: {e}", "ERROR")
        finally:
            db.close()

    def compute_24h_stats(self):
        """volume_24h + price_change_24h from OUR archive (no exchange feed).

        Scans fifteen_min_buckets over the last 24h (≤96 rows/token) — one
        grouped query + one window query, same shape as the archive pass.
        """
        start = now_ms() - 86_400_000
        db = SessionLocal()
        try:
            vol = dict(db.query(
                           FifteenMinBucket.symbol,
                           func.coalesce(func.sum(FifteenMinBucket.buy_volume), 0.0)
                           + func.coalesce(func.sum(FifteenMinBucket.sell_volume), 0.0))
                       .filter(FifteenMinBucket.bucket_start >= start)
                       .group_by(FifteenMinBucket.symbol).all())
            opens = {s: o for s, o in (db.query(
                         FifteenMinBucket.symbol.label("s"),
                         func.first_value(FifteenMinBucket.open_price).over(
                             partition_by=FifteenMinBucket.symbol,
                             order_by=FifteenMinBucket.bucket_start.asc()).label("o"))
                     .filter(FifteenMinBucket.bucket_start >= start)
                     .distinct().all())}
            if not vol:
                return
            rows = {r.symbol: r for r in db.query(LatestTicker)
                    .filter(LatestTicker.symbol.in_(list(vol.keys()))).all()}
            ts = now_ms()
            for slug, v in vol.items():
                open_24h = opens.get(slug) or 0.0
                last = (rows[slug].last_price if slug in rows
                        else self.last_prices.get(slug, 0.0)) or 0.0
                pct = ((last - open_24h) / open_24h * 100.0) if open_24h > 0 else 0.0
                row = rows.get(slug)
                if row:
                    row.volume_24h = v
                    row.price_change_24h = pct
                    row.last_updated = max(row.last_updated or 0, ts - 1)
                else:
                    db.add(LatestTicker(symbol=slug, price_change_24h=pct,
                                        volume_24h=v, last_price=last,
                                        last_updated=ts))
            db.commit()
        except Exception as e:
            db.rollback()
            log(f"24h stats failed: {e}", "ERROR")
        finally:
            db.close()

    # ── Heartbeats (per chain + the umbrella "collector" the UI dot reads) ──

    @staticmethod
    def heartbeat(process: str):
        db = SessionLocal()
        try:
            row = db.query(Heartbeat).filter_by(process=process).first()
            if row:
                row.last_heartbeat = now_ms()
            else:
                db.add(Heartbeat(process=process, last_heartbeat=now_ms()))
            db.commit()
        except Exception:
            db.rollback()
        finally:
            db.close()
