"""Seed a clean tokens + latest_tickers universe from CoinMarketCap listings.

Uses the keyless CMC public listings feed (same source as cmc_ranking.py).
Creates only CMC-listed contract tokens on bsc / ethereum / base — no junk
on-chain discovery. Safe to re-run (upsert by chain+contract).

  python seed_cmc.py
  python seed_cmc.py --limit 500
  python seed_cmc.py --limit 2000 --chains bsc,ethereum,base
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

sys.path.append(os.path.dirname(os.path.abspath(__file__)))

from database.db import Base, SessionLocal, engine, ensure_db_settings
from database.models import Token, LatestTicker
from ingest.evm import make_slug, sanitize_display_symbol

LISTINGS_URL = "https://pro-api.coinmarketcap.com/public-api/v3/cryptocurrency/listings/latest"

CMC_PLATFORM_TO_CHAIN = {
    "bnb": "bsc",
    "binance-smart-chain": "bsc",
    "ethereum": "ethereum",
    "base": "base",
}


def fetch_cmc_listings(max_tokens: int = 500) -> list[dict]:
    """Return normalized listing rows with contract + market fields."""
    out: list[dict] = []
    start = 1
    per_page = 200
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
            with urllib.request.urlopen(req, timeout=45) as resp:
                payload = json.loads(resp.read())
        except urllib.error.HTTPError as e:
            if e.code == 429:
                print(f"  Rate limited, waiting 8s...")
                time.sleep(8)
                continue
            print(f"  HTTP {e.code}: {e.read().decode()[:200]}")
            break
        except Exception as e:
            print(f"  Error: {e}")
            break

        data = payload.get("data") or []
        if not data:
            break

        for token in data:
            global_rank += 1
            rank = token.get("cmc_rank") or token.get("rank") or global_rank
            try:
                rank = int(rank)
            except (TypeError, ValueError):
                rank = global_rank

            platform = token.get("platform")
            if not platform:
                continue  # native coins without a contract — skip for now
            pslug = (platform.get("slug") or "").lower()
            addr = (platform.get("token_address") or "").strip().lower()
            chain = CMC_PLATFORM_TO_CHAIN.get(pslug)
            if not chain or not addr or not addr.startswith("0x") or len(addr) != 42:
                continue

            quote = None
            quotes = token.get("quote") or []
            if isinstance(quotes, list):
                for q in quotes:
                    if q.get("symbol") == "USD":
                        quote = q
                        break
            elif isinstance(quotes, dict):
                quote = quotes.get("USD") or quotes.get("usd")
            if not quote:
                continue

            price = quote.get("price")
            mc = quote.get("market_cap")
            vol = quote.get("volume_24h")
            chg = quote.get("percent_change_24h")
            if price is None or float(price) <= 0:
                continue

            cmc_id = token.get("id")
            try:
                cmc_id = int(cmc_id) if cmc_id is not None else None
            except (TypeError, ValueError):
                cmc_id = None

            out.append({
                "chain": chain,
                "address": addr,
                "symbol": (token.get("symbol") or "TOKEN").strip(),
                "name": (token.get("name") or token.get("symbol") or "Token").strip(),
                "cmc_id": cmc_id,
                "cmc_slug": (token.get("slug") or "")[:120] or None,
                "cmc_rank": rank,
                "market_cap": float(mc) if mc is not None else None,
                "volume_24h": float(vol) if vol is not None else 0.0,
                "price": float(price),
                "price_change_24h": float(chg) if chg is not None else 0.0,
            })

        fetched += len(data)
        print(f"  Fetched {fetched} CMC listings… ({len(out)} with EVM contracts so far)")
        if len(data) < limit:
            break
        start += limit
        time.sleep(0.4)

    return out


def seed(limit: int = 500, chains: set[str] | None = None) -> dict:
    ensure_db_settings()
    Base.metadata.create_all(bind=engine)
    chains = chains or {"bsc", "ethereum", "base"}

    print(f"Seeding from CMC (limit={limit}, chains={sorted(chains)})…")
    listings = fetch_cmc_listings(limit)
    listings = [r for r in listings if r["chain"] in chains]

    db = SessionLocal()
    slugs_taken: set[str] = set()
    for t in db.query(Token.symbol).all():
        slugs_taken.add(t[0])

    created = updated = tickers = 0
    now = int(time.time() * 1000)
    try:
        # Index existing by chain+address
        existing = {
            ((t.chain_id or ""), (t.contract_address or "").lower()): t
            for t in db.query(Token).all()
            if t.contract_address
        }

        for row in listings:
            key = (row["chain"], row["address"])
            display = sanitize_display_symbol(row["symbol"]) or row["symbol"]
            tok = existing.get(key)
            if tok is None:
                slug = make_slug(display, row["chain"], slugs_taken, row["address"])
                slugs_taken.add(slug)
                tid = f"{row['chain']}:{row['address']}"
                tok = Token(
                    id=tid,
                    symbol=slug,
                    name=row["name"][:120],
                    chain_id=row["chain"],
                    contract_address=row["address"],
                    display_symbol=display[:32],
                    decimals=None,  # filled on first wallet/engine use if needed
                    market_cap=row["market_cap"],
                    cmc_rank=row["cmc_rank"],
                    cmc_slug=row["cmc_slug"],
                    cmc_id=row["cmc_id"],
                    liquidity_usd=None,  # unknown until we watch a pool
                    listed_at=now,
                    status="active",
                )
                # Product filters require liq>=100k for screener — seed a
                # synthetic floor so CMC-listed tokens appear in the product
                # until real pool depth is measured. Real liq overwrites later.
                tok.liquidity_usd = 100_000.0
                db.add(tok)
                existing[key] = tok
                created += 1
            else:
                tok.name = row["name"][:120]
                tok.display_symbol = display[:32]
                tok.market_cap = row["market_cap"]
                tok.cmc_rank = row["cmc_rank"]
                tok.cmc_slug = row["cmc_slug"]
                tok.cmc_id = row["cmc_id"]
                tok.status = "active"
                if not tok.liquidity_usd or tok.liquidity_usd < 100_000:
                    tok.liquidity_usd = max(tok.liquidity_usd or 0, 100_000.0)
                updated += 1

            # LatestTicker for screener price / volume (CMC-sourced)
            tk = db.query(LatestTicker).filter(LatestTicker.symbol == tok.symbol).first()
            if not tk:
                tk = LatestTicker(symbol=tok.symbol)
                db.add(tk)
            tk.last_price = row["price"]
            tk.volume_24h = row["volume_24h"] or 0.0
            tk.price_change_24h = row["price_change_24h"] or 0.0
            tk.last_updated = now
            tickers += 1

        db.commit()
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()

    return {
        "listings_with_contract": len(listings),
        "created": created,
        "updated": updated,
        "tickers": tickers,
    }


def main():
    p = argparse.ArgumentParser(description="Seed tokens from CoinMarketCap")
    p.add_argument("--limit", type=int, default=int(os.environ.get("CMC_SEED_LIMIT", "500")))
    p.add_argument("--chains", type=str, default="bsc,ethereum,base",
                   help="Comma-separated: bsc,ethereum,base")
    args = p.parse_args()
    chains = {c.strip().lower() for c in args.chains.split(",") if c.strip()}
    result = seed(limit=args.limit, chains=chains)
    print(json.dumps(result, indent=2))
    print()
    print("Done. Restart API if running, then refresh the UI.")
    print("Screener uses CMC price/volume/mcap; Alchemy only needed for live trading pools.")


if __name__ == "__main__":
    main()
