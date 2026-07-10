"""Historical data backfill from CMC keyless k-line endpoint.

Fetches daily + 15min candles for active tokens and populates:
  - daily_buckets (up to ~600 daily candles ≈ 1.6 years, 0 credits)
  - fifteen_min_buckets (up to ~600 15m candles ≈ 6 days, 0 credits)

Usage:
  python backfill_history.py                    # backfill top 500 active tokens
  python backfill_history.py --limit 2000        # backfill more
  python backfill_history.py --symbol CAKE_bsc    # single token
  python backfill_history.py --daily-only          # skip 15m (faster)
"""
import sys
import os
import time
import json
import urllib.request
import urllib.parse
import argparse

sys.path.append(os.path.dirname(os.path.abspath(__file__)))

from database.db import engine, Base, ensure_db_settings, SessionLocal, dialect_insert
from database.models import Token, DailyBucket, FifteenMinBucket

KLINE_BASE = "https://pro-api.coinmarketcap.com/public-api/v1/k-line/candles"

CMC_PLATFORM_MAP = {
    "bsc": "bsc",
    "ethereum": "ethereum",
    "base": "base",
}


def fetch_kline(platform: str, address: str, interval: str, limit: int = 600,
                 max_retries: int = 4) -> list:
    qs = urllib.parse.urlencode({
        "platform": platform,
        "address": address,
        "interval": interval,
        "limit": str(limit),
    })
    url = f"{KLINE_BASE}?{qs}"
    for attempt in range(max_retries):
        try:
            req = urllib.request.Request(url, headers={"Accept": "application/json"})
            with urllib.request.urlopen(req, timeout=30) as resp:
                payload = json.loads(resp.read())
            if payload.get("data"):
                return payload["data"]
            return []
        except urllib.error.HTTPError as e:
            if e.code == 429 and attempt < max_retries - 1:
                wait = 2 ** (attempt + 1)
                print(f"  Rate limited, waiting {wait}s...")
                time.sleep(wait)
                continue
            body = e.read().decode() if e.fp else ""
            print(f"  HTTP {e.code}: {body[:120]}")
            return []
        except Exception as e:
            if attempt < max_retries - 1:
                time.sleep(2)
                continue
            print(f"  Error: {e}")
            return []
    return []


def upsert_daily(db, symbol: str, candles: list):
    if not candles:
        return 0
    rows = []
    for c in candles:
        if len(c) < 6:
            continue
        o, h, l, cl, vol, ts = c[0], c[1], c[2], c[3], c[4], c[5]
        ts = int(ts)
        rows.append({
            "symbol": symbol,
            "bucket_start": ts,
            "open_price": float(o),
            "high_price": float(h),
            "low_price": float(l),
            "close_price": float(cl),
            "buy_volume": float(vol) if vol else 0.0,
            "sell_volume": 0.0,
            "trade_count": int(c[6]) if len(c) > 6 and c[6] else 0,
        })
    if not rows:
        return 0
    stmt = dialect_insert(DailyBucket).values(rows)
    stmt = stmt.on_conflict_do_update(
        index_elements=["symbol", "bucket_start"],
        set_={
            "open_price": stmt.excluded.open_price,
            "high_price": stmt.excluded.high_price,
            "low_price": stmt.excluded.low_price,
            "close_price": stmt.excluded.close_price,
            "buy_volume": stmt.excluded.buy_volume,
            "trade_count": stmt.excluded.trade_count,
        },
    )
    db.execute(stmt)
    db.commit()
    return len(rows)


def upsert_15m(db, symbol: str, candles: list):
    if not candles:
        return 0
    rows = []
    for c in candles:
        if len(c) < 6:
            continue
        o, h, l, cl, vol, ts = c[0], c[1], c[2], c[3], c[4], c[5]
        ts = int(ts)
        bucket = ts - (ts % 900_000)
        rows.append({
            "symbol": symbol,
            "bucket_start": bucket,
            "open_price": float(o),
            "high_price": float(h),
            "low_price": float(l),
            "close_price": float(cl),
            "buy_volume": float(vol) if vol else 0.0,
            "sell_volume": 0.0,
            "trade_count": int(c[6]) if len(c) > 6 and c[6] else 0,
        })
    if not rows:
        return 0
    stmt = dialect_insert(FifteenMinBucket).values(rows)
    stmt = stmt.on_conflict_do_update(
        index_elements=["symbol", "bucket_start"],
        set_={
            "open_price": stmt.excluded.open_price,
            "high_price": stmt.excluded.high_price,
            "low_price": stmt.excluded.low_price,
            "close_price": stmt.excluded.close_price,
            "buy_volume": stmt.excluded.buy_volume,
            "trade_count": stmt.excluded.trade_count,
        },
    )
    db.execute(stmt)
    db.commit()
    return len(rows)


def backfill_token(db, token: Token, daily: bool = True, fifteen_min: bool = True) -> dict:
    chain = token.chain_id or ""
    platform = CMC_PLATFORM_MAP.get(chain)
    if not platform or not token.contract_address:
        return {"daily": 0, "15m": 0, "error": "no platform/address"}

    addr = token.contract_address
    result = {"daily": 0, "15m": 0, "error": None}

    if daily:
        candles = fetch_kline(platform, addr, "1d", limit=600)
        result["daily"] = upsert_daily(db, token.symbol, candles)
        time.sleep(1.0)

    if fifteen_min:
        candles = fetch_kline(platform, addr, "15min", limit=600)
        result["15m"] = upsert_15m(db, token.symbol, candles)
        time.sleep(1.0)

    return result


def main():
    parser = argparse.ArgumentParser(description="Backfill historical k-line data from CMC")
    parser.add_argument("--limit", type=int, default=500,
                        help="Max tokens to backfill (sorted by liquidity desc)")
    parser.add_argument("--symbol", type=str, default=None,
                        help="Backfill a single token by slug (e.g. CAKE_bsc)")
    parser.add_argument("--daily-only", action="store_true",
                        help="Skip 15m backfill (faster)")
    parser.add_argument("--min-liq", type=float, default=10000,
                        help="Minimum liquidity USD (default 10000)")
    args = parser.parse_args()

    Base.metadata.create_all(bind=engine)
    ensure_db_settings()
    db = SessionLocal()

    if args.symbol:
        token = db.query(Token).filter(Token.symbol == args.symbol).first()
        if not token:
            print(f"Token not found: {args.symbol}")
            return
        print(f"Backfilling {token.symbol} ({token.chain_id})...")
        r = backfill_token(db, token, daily=True, fifteen_min=not args.daily_only)
        print(f"  Daily: {r['daily']} candles, 15m: {r['15m']} candles")
        db.close()
        return

    query = (db.query(Token)
             .filter(Token.status == "active")
             .filter(Token.contract_address != None)
             .filter(Token.contract_address != "")
             .filter(Token.chain_id.in_(list(CMC_PLATFORM_MAP.keys()))))
    if args.min_liq > 0:
        query = query.filter((Token.liquidity_usd or 0) >= args.min_liq)
    query = query.order_by(Token.liquidity_usd.desc().nullslast())
    tokens = query.limit(args.limit).all()

    print(f"Backfilling {len(tokens)} tokens (daily={'yes'} 15m={'no' if args.daily_only else 'yes'})")
    total_daily = 0
    total_15m = 0
    errors = 0

    for i, token in enumerate(tokens):
        if i > 0 and i % 50 == 0:
            print(f"  Progress: {i}/{len(tokens)} tokens, "
                  f"{total_daily} daily candles, {total_15m} 15m candles, {errors} errors")

        r = backfill_token(db, token,
                           daily=True,
                           fifteen_min=not args.daily_only)
        total_daily += r["daily"]
        total_15m += r["15m"]
        if r["error"]:
            errors += 1

    print(f"\nDone: {len(tokens)} tokens, {total_daily} daily candles, "
          f"{total_15m} 15m candles, {errors} errors")
    db.close()


if __name__ == "__main__":
    main()
