"""Fresh database for pre-launch rebuilds.

Backs up crypto_data.db (if present), deletes market + all tables by removing
the SQLite file, then recreates empty schema via create_all + ensure_db_settings.

Use when you do not need old tokens/trades/strategies (solo build phase).

  python fresh_db.py
  python fresh_db.py --yes   # skip confirmation
"""
from __future__ import annotations

import argparse
import os
import shutil
import sys
import time
from datetime import datetime, timezone

sys.path.append(os.path.dirname(os.path.abspath(__file__)))

from database.db import engine, Base, ensure_db_settings, DATABASE_URL, IS_SQLITE


def _sqlite_path() -> str | None:
    if not IS_SQLITE:
        return None
    # sqlite:///C:/path/to/crypto_data.db
    url = DATABASE_URL
    if url.startswith("sqlite:///"):
        return url[len("sqlite:///"):].replace("/", os.sep)
    return None


def main():
    p = argparse.ArgumentParser(description="Wipe DB and recreate empty schema")
    p.add_argument("--yes", "-y", action="store_true", help="Skip confirm")
    args = p.parse_args()

    if not IS_SQLITE:
        print("fresh_db.py only supports local SQLite. For Postgres, use a new DATABASE_URL.")
        sys.exit(1)

    path = _sqlite_path()
    if not path:
        print("Could not resolve SQLite path from DATABASE_URL")
        sys.exit(1)

    if not args.yes:
        print(f"This DELETES all data in:\n  {path}")
        print("Strategies, trades, tokens, pools, tickers — everything.")
        ans = input("Type YES to continue: ").strip()
        if ans != "YES":
            print("Aborted.")
            sys.exit(0)

    # Dispose connections so Windows can delete the file
    engine.dispose()

    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    bak_dir = os.path.join(root, "backups")
    os.makedirs(bak_dir, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
    bak = os.path.join(bak_dir, f"crypto_data_pre_fresh_{stamp}.db")

    if os.path.isfile(path):
        shutil.copy2(path, bak)
        print(f"Backup: {bak}")
        for suffix in ("-wal", "-shm"):
            side = path + suffix
            if os.path.isfile(side):
                shutil.copy2(side, bak + suffix)
        # Remove live files
        for f in (path, path + "-wal", path + "-shm"):
            try:
                if os.path.isfile(f):
                    os.remove(f)
                    print(f"Removed {f}")
            except OSError as e:
                print(f"Could not remove {f}: {e}")
                print("Stop the API/collector (close start.bat windows) and re-run.")
                sys.exit(1)
    else:
        print("No existing DB file — creating new.")

    # Recreate empty schema
    from database import models  # noqa: F401 — register tables on Base
    Base.metadata.create_all(bind=engine)
    ensure_db_settings()
    print("Empty schema ready.")
    print()
    print("Next:")
    print("  1. Restart API + collector (start.bat)")
    print("  2. Seed market data from CMC (when CMC layer is wired)")
    print("  3. Optional: python goplus_scan.py after tokens exist")
    print()
    print("Alchemy free-tier: BSC-only @ 60s polls by default (see ingest/chains.py).")


if __name__ == "__main__":
    main()
