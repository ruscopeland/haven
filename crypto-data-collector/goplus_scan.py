"""Run a quota-safe GoPlus security scan over liquid tokens only.

Usage:
  python goplus_scan.py              # up to daily remaining budget
  python goplus_scan.py --max 50     # hard cap this run
  python goplus_scan.py --status     # show budget + queue queue

Only status=active AND liquidity >= HAVEN_MIN_TOKEN_LIQUIDITY_USD ($100k).
Retired / thin garbage is never scanned.
"""
import argparse
import json
import os
import sys

sys.path.append(os.path.dirname(os.path.abspath(__file__)))

from database.db import Base, engine, ensure_db_settings
from ingest.chains import load_env_file
from ingest.goplus import GoPlusClient, eligible_tokens, run_scan
from database.db import SessionLocal


def show_status():
    load_env_file()
    ensure_db_settings()
    client = GoPlusClient()
    db = SessionLocal()
    try:
        need = eligible_tokens(db)
        print(f"configured:     {client.configured}")
        print(f"daily_budget:   {client.daily_budget}")
        print(f"day_used:       {client._load_usage().get('addresses', 0)}")
        print(f"remaining:      {client.remaining_budget()}")
        print(f"batch_size:     {client.batch_size}")
        print(f"min_interval_s: {client.min_interval}")
        print(f"refresh_days:   {client.refresh_days}")
        print(f"min_liquidity:  ${float(os.environ.get('HAVEN_MIN_TOKEN_LIQUIDITY_USD', '100000')):,.0f}")
        print(f"need_scan:      {len(need)} liquid tokens")
        if need:
            print("  next:", ", ".join(
                (t.display_symbol or t.symbol) for t in need[:8]
            ))
    finally:
        db.close()


def main():
    p = argparse.ArgumentParser(description="Quota-safe GoPlus scan")
    p.add_argument("--max", type=int, default=None, help="Max addresses this run")
    p.add_argument("--status", action="store_true", help="Show budget / queue only")
    args = p.parse_args()

    load_env_file()
    Base.metadata.create_all(bind=engine)
    ensure_db_settings()

    if args.status:
        show_status()
        return

    result = run_scan(max_addresses=args.max)
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
