"""Purge garbage tokens that passed the $100k liquidity floor with fake market caps.

Many scam / meme tokens report absurd total_supply so price × supply looks like
hundreds of trillions. Real CMC-listed tokens have cmc_id set by cmc_ranking.py.

This script:
  1. Clears untrusted market_cap / local cmc_rank when cmc_id is missing and
     numbers fail sanity checks.
  2. Retires tokens that are clearly not product-quality (fake mega-mcap,
     extreme mcap/liquidity ratio, no CMC identity + absurd figures).

Safe to re-run. Does not delete history rows.

  python apply_quality_filter.py
  python apply_quality_filter.py --dry-run
"""
from __future__ import annotations

import argparse
import os
import sys

sys.path.append(os.path.dirname(os.path.abspath(__file__)))

from database.db import SessionLocal, ensure_db_settings, engine, Base
from database.models import Token

# Hard ceilings for non-CMC tokens (computed mcap is untrusted).
MAX_MCAP_NO_CMC = 5_000_000_000.0       # $5B without CMC id → clear/retire
MAX_MCAP_ANY = 500_000_000_000.0        # $500B even with CMC is suspicious for our set
MAX_MCAP_OVER_LIQ = 50_000.0            # mcap/liq ratio above this without CMC → junk

# Known large stables / bluechips we never auto-retire by mcap alone
KEEP_SYMBOLS = {
    "USDT", "USDC", "DAI", "BUSD", "TUSD", "FDUSD", "USDE", "WETH", "WBNB",
    "ETH", "BNB", "STETH", "WBTC", "BTCB",
}

# Name/slug substrings that are always blacklisted (airdrop phishing sites, etc.)
SCAM_NAME_SNIPPETS = (
    "zepe.io", "zepeio", "zepe", "zape.io", "zapeio",
    "airdrop claim", "claim airdrop", "visit zepe",
)


def _display(t: Token) -> str:
    return (t.display_symbol or t.name or t.symbol or "").upper()


def run(dry_run: bool = False) -> dict:
    ensure_db_settings()
    Base.metadata.create_all(bind=engine)
    db = SessionLocal()
    cleared_mcap = 0
    cleared_rank = 0
    retired = 0
    try:
        tokens = db.query(Token).filter(
            (Token.status == "active") | (Token.status.is_(None))
        ).all()
        for t in tokens:
            name = _display(t)
            blob = f"{name} {(t.name or '')} {(t.symbol or '')}".lower()
            keep = any(k in name.split() or name == k for k in KEEP_SYMBOLS) or name in KEEP_SYMBOLS
            mc = t.market_cap or 0.0
            liq = t.liquidity_usd or 0.0
            has_cmc = t.cmc_id is not None and int(t.cmc_id or 0) > 0

            # Known airdrop phishing brands (zepe.io etc.) — always blacklist.
            if any(s in blob for s in SCAM_NAME_SNIPPETS):
                if t.status != "blacklisted":
                    t.status = "blacklisted"
                    retired += 1  # counted in retired for summary; status is blacklisted
                continue

            # Fake local ranks (assigned without CMC id) — drop them.
            if not has_cmc and t.cmc_rank is not None:
                t.cmc_rank = None
                cleared_rank += 1

            # Untrusted computed market cap: ONLY trust CMC-matched rows.
            # price × total_supply for random tokens produced $843T "Little Pepe".
            ratio = (mc / liq) if liq > 0 else 0.0
            if not has_cmc and t.market_cap is not None:
                t.market_cap = None
                cleared_mcap += 1
            elif has_cmc and mc > MAX_MCAP_ANY and not keep:
                t.market_cap = None
                cleared_mcap += 1

            # Retire extreme junk that only cleared the liquidity floor with
            # fake mega-supply (ratio of claimed mcap to pool depth is absurd).
            should_retire = False
            if not keep and not has_cmc:
                if liq > 0 and mc > 0 and ratio > 200_000:
                    should_retire = True
                if mc > 50_000_000_000:
                    should_retire = True

            if should_retire and t.status != "blacklisted":
                t.status = "retired"
                retired += 1

        if dry_run:
            db.rollback()
        else:
            db.commit()

        active = (
            db.query(Token)
            .filter(Token.status == "active")
            .filter(Token.liquidity_usd.isnot(None))
            .filter(Token.liquidity_usd >= 100_000)
            .count()
        )
        with_cmc = (
            db.query(Token)
            .filter(Token.status == "active")
            .filter(Token.liquidity_usd >= 100_000)
            .filter(Token.cmc_id.isnot(None))
            .count()
        )
        return {
            "cleared_mcap": cleared_mcap,
            "cleared_rank": cleared_rank,
            "retired": retired,
            "active_liquid": active,
            "active_liquid_with_cmc": with_cmc,
            "dry_run": dry_run,
        }
    finally:
        db.close()


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--dry-run", action="store_true")
    args = p.parse_args()
    r = run(dry_run=args.dry_run)
    print(r)


if __name__ == "__main__":
    main()
