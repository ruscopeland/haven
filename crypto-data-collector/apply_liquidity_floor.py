"""One-shot: apply $100k liquidity policy to the existing DB.

Unwatches pools below floor*0.9, retires tokens with no watched pool.
Run after raising liquidity_floor_usd so the screener cleans up without
waiting for the collector's next hourly sweep.

  python apply_liquidity_floor.py
  python apply_liquidity_floor.py --floor 100000
"""
import argparse
import os
import sys

sys.path.append(os.path.dirname(os.path.abspath(__file__)))

from database.db import SessionLocal, ensure_db_settings, engine, Base
from database.models import Token, Pool
from ingest.chains import CHAINS


def apply(floor: float):
    ensure_db_settings()
    Base.metadata.create_all(bind=engine)
    drop_at = floor * 0.9
    db = SessionLocal()
    try:
        quote_addrs = set()
        for cfg in CHAINS.values():
            if cfg.get("family") != "evm":
                continue
            for addr in (cfg.get("quotes") or {}):
                quote_addrs.add(addr.lower())
            native = (cfg.get("native") or {}).get("address")
            if native:
                quote_addrs.add(native.lower())

        pools = db.query(Pool).all()
        unwatched = 0
        rearmed = 0
        for p in pools:
            liq = p.liquidity_usd or 0.0
            if p.watch and liq < drop_at:
                p.watch = 0
                unwatched += 1
            elif (not p.watch) and liq >= floor:
                p.watch = 1
                rearmed += 1

        watched_ids = {p.token_id for p in pools if p.watch == 1 and p.token_id}
        tokens = db.query(Token).all()
        retired = revived = 0
        for t in tokens:
            addr = (t.contract_address or "").lower()
            if addr in quote_addrs:
                if t.status != "active":
                    t.status = "active"
                continue
            if t.id in watched_ids:
                max_liq = max(
                    (p.liquidity_usd or 0.0) for p in pools
                    if p.token_id == t.id and p.watch == 1
                )
                t.liquidity_usd = max_liq
                if t.status == "retired":
                    t.status = "active"
                    revived += 1
                elif t.status is None:
                    t.status = "active"
            else:
                if t.status not in ("retired", "blacklisted"):
                    t.status = "retired"
                    retired += 1

        db.commit()
        active = (
            db.query(Token)
            .filter((Token.status == "active") | (Token.status.is_(None)))
            .filter(Token.liquidity_usd.isnot(None))
            .filter(Token.liquidity_usd >= floor)
            .count()
        )
        watched = db.query(Pool).filter(Pool.watch == 1).count()
        print(f"floor=${floor:,.0f}  drop_at=${drop_at:,.0f}")
        print(f"  pools unwatched: {unwatched}  re-armed: {rearmed}")
        print(f"  tokens retired:  {retired}  revived: {revived}")
        print(f"  watched pools now: {watched}")
        print(f"  active tokens with liq>={floor:,.0f}: {active}")
    finally:
        db.close()


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--floor", type=float,
                   default=float(os.environ.get("HAVEN_MIN_TOKEN_LIQUIDITY_USD", "100000")))
    args = p.parse_args()
    apply(args.floor)


if __name__ == "__main__":
    main()
