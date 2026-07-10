"""CMC ranking: fetch market cap + rank + 24h volume from CoinMarketCap.

Uses the keyless listings endpoint (0 credits) to get market_cap, volume_24h,
cmc_rank, and cmc_slug for CMC-listed tokens, matched to our tokens table by
platform + contract_address. Also computes market_cap = price × total_supply
for tokens not in CMC listings.

Usage:
  python cmc_ranking.py                # update all tokens (CMC + computed)
  python cmc_ranking.py --cmc-only      # only CMC-listed tokens (faster)
  python cmc_ranking.py --limit 500      # only top 500 CMC listings
"""
import sys
import os
import time
import json
import urllib.request
import urllib.parse
import argparse

sys.path.append(os.path.dirname(os.path.abspath(__file__)))

from database.db import engine, Base, ensure_db_settings, SessionLocal
from database.models import Token, LatestTicker

LISTINGS_URL = "https://pro-api.coinmarketcap.com/public-api/v3/cryptocurrency/listings/latest"

CMC_PLATFORM_TO_CHAIN = {
    "bnb": "bsc",
    "ethereum": "ethereum",
    "base": "base",
}


def fetch_listings(max_tokens: int = 5000) -> dict:
    """Fetch CMC listings. Returns {(chain, addr_lower): {market_cap, volume_24h, rank, slug}}."""
    matched = {}
    start = 1
    per_page = 500
    fetched = 0
    global_rank = 0

    while fetched < max_tokens:
        limit = min(per_page, max_tokens - fetched)
        qs = urllib.parse.urlencode({
            "start": str(start),
            "limit": str(limit),
            "convert": "USD",
        })
        url = f"{LISTINGS_URL}?{qs}"
        try:
            req = urllib.request.Request(url, headers={"Accept": "application/json"})
            with urllib.request.urlopen(req, timeout=30) as resp:
                payload = json.loads(resp.read())
        except urllib.error.HTTPError as e:
            if e.code == 429:
                wait = 5
                print(f"  Rate limited, waiting {wait}s...")
                time.sleep(wait)
                continue
            print(f"  HTTP {e.code}: {e.read().decode()[:120]}")
            break
        except Exception as e:
            print(f"  Error: {e}")
            break

        data = payload.get("data", [])
        if not data:
            break

        for token in data:
            global_rank += 1
            # Prefer CMC's own cmc_rank when present.
            rank = token.get("cmc_rank") or token.get("rank") or global_rank
            try:
                rank = int(rank)
            except (TypeError, ValueError):
                rank = global_rank
            cmc_slug = token.get("slug") or token.get("name")
            cmc_id = token.get("id")
            try:
                cmc_id = int(cmc_id) if cmc_id is not None else None
            except (TypeError, ValueError):
                cmc_id = None

            platform = token.get("platform")
            if not platform:
                continue
            pslug = platform.get("slug", "")
            addr = (platform.get("token_address") or "").lower()
            chain = CMC_PLATFORM_TO_CHAIN.get(pslug)
            if not chain or not addr:
                continue
            quote = None
            quotes = token.get("quote", [])
            if quotes and isinstance(quotes, list):
                for q in quotes:
                    if q.get("symbol") == "USD":
                        quote = q
                        break
            if not quote:
                continue
            mc = quote.get("market_cap")
            vol = quote.get("volume_24h")
            if mc is not None:
                matched[(chain, addr)] = {
                    "market_cap": float(mc),
                    "volume_24h": float(vol) if vol else None,
                    "rank": rank,
                    "slug": cmc_slug,
                    "id": cmc_id,
                }

        fetched += len(data)
        print(f"  Fetched {fetched} tokens from CMC listings...")
        if len(data) < limit:
            break
        start += limit
        time.sleep(0.5)

    return matched


def update_from_cmc(db, cmc_data: dict) -> int:
    """Update tokens.market_cap, cmc_rank, cmc_slug for CMC matches."""
    updated = 0
    tokens = db.query(Token).filter(Token.status == "active").all()
    for token in tokens:
        chain = token.chain_id or ""
        addr = (token.contract_address or "").lower()
        if not addr:
            continue
        key = (chain, addr)
        if key in cmc_data:
            row = cmc_data[key]
            token.market_cap = row["market_cap"]
            if row.get("rank"):
                token.cmc_rank = row["rank"]
            if row.get("slug"):
                token.cmc_slug = str(row["slug"])[:120]
            if row.get("id"):
                token.cmc_id = row["id"]
            vol = row.get("volume_24h")
            if vol is not None:
                ticker = db.query(LatestTicker).filter(
                    LatestTicker.symbol == token.symbol).first()
                if ticker:
                    ticker.volume_24h = vol
            updated += 1
    db.commit()
    return updated


def compute_market_cap(db) -> int:
    """Optional computed mcap ONLY for tokens already CMC-matched that lack mcap.

    Never invent market caps for random liquid scams (price × garbage supply
    produced $843T 'Little Pepe'). Prefer CMC listings exclusively.
    """
    updated = 0
    tokens = (db.query(Token)
              .filter(Token.status == "active")
              .filter(Token.cmc_id.isnot(None))
              .filter(Token.market_cap == None)
              .filter(Token.total_supply != None)
              .filter(Token.total_supply > 0)
              .all())
    ticker_map = {t.symbol: t for t in db.query(LatestTicker).all()}

    for token in tokens:
        ticker = ticker_map.get(token.symbol)
        if not ticker or not ticker.last_price or ticker.last_price <= 0:
            continue
        mc = ticker.last_price * (token.total_supply or 0)
        if mc > 1e12 or mc < 10_000:
            continue
        token.market_cap = mc
        updated += 1

    db.commit()
    return updated


def assign_local_ranks(db) -> int:
    """No longer assign fake ranks.

    Local ranks made 'Little Pepe' look like CMC #2002 with a trillion-dollar
    computed market cap. Rank and market_cap for product surfaces must come
    from real CMC matches (cmc_id set). Returns 0 always.
    """
    return 0


def run_ranking(limit: int = 5000, cmc_only: bool = False, no_cmc: bool = False) -> dict:
    """Programmatic entry for the API/collector periodic job."""
    Base.metadata.create_all(bind=engine)
    ensure_db_settings()
    db = SessionLocal()
    try:
        cmc_updated = 0
        if not no_cmc:
            cmc_data = fetch_listings(limit)
            cmc_updated = update_from_cmc(db, cmc_data)
        computed = 0
        if not cmc_only:
            computed = compute_market_cap(db)
        local = assign_local_ranks(db)
        return {"cmc": cmc_updated, "computed": computed, "local_ranks": local}
    finally:
        db.close()


def main():
    parser = argparse.ArgumentParser(description="Update market cap + rank from CMC")
    parser.add_argument("--cmc-only", action="store_true",
                        help="Only update CMC-listed tokens, skip computed market cap")
    parser.add_argument("--limit", type=int, default=5000,
                        help="Max tokens to fetch from CMC listings")
    parser.add_argument("--no-cmc", action="store_true",
                        help="Skip CMC fetch, only compute from price × supply")
    args = parser.parse_args()

    print(f"Fetching CMC listings (up to {args.limit} tokens)..." if not args.no_cmc else "Skipping CMC…")
    result = run_ranking(limit=args.limit, cmc_only=args.cmc_only, no_cmc=args.no_cmc)
    print(f"\nDone: {result['cmc']} CMC-matched, {result['computed']} computed, "
          f"{result['local_ranks']} local ranks assigned")


if __name__ == "__main__":
    main()
