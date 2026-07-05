"""Safe live backup of crypto_data.db into backups/ (works while the stack is running).

Uses sqlite3's online backup API, which is WAL-safe — never copy the .db file by hand
while the collector is writing.
"""
import sqlite3
import sys
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "crypto-data-collector" / "crypto_data.db"
DEST_DIR = ROOT / "backups"
KEEP = 10  # most recent backups to keep


def main():
    if not SRC.exists():
        sys.exit(f"Database not found: {SRC}")
    DEST_DIR.mkdir(exist_ok=True)
    dest = DEST_DIR / f"crypto_data_{datetime.now():%Y-%m-%d_%H%M%S}.db"

    src_conn = sqlite3.connect(f"file:{SRC}?mode=ro", uri=True)
    dst_conn = sqlite3.connect(dest)
    try:
        src_conn.backup(dst_conn)
    finally:
        dst_conn.close()
        src_conn.close()

    size_mb = dest.stat().st_size / 1_048_576
    print(f"Backup written: {dest.name} ({size_mb:.1f} MB)")

    backups = sorted(DEST_DIR.glob("crypto_data_*.db"))
    for old in backups[:-KEEP]:
        old.unlink()
        print(f"Pruned old backup: {old.name}")


if __name__ == "__main__":
    main()
