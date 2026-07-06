"""One-time data migration: local SQLite -> cloud Postgres.

Copies every table from the collector's SQLite file into a Postgres database so
the cloud launches with your existing market-data history (and, if you want,
your own strategies/finders/trades under the 'local' user).

Usage (from the repo root, with the cloud DB URL in your shell):

    # market data only (recommended for a clean multi-user launch):
    DATABASE_URL="postgresql://…"  python tools/migrate_sqlite_to_postgres.py

    # include your own user-owned rows too (strategies, trades, markers…):
    DATABASE_URL="postgresql://…"  python tools/migrate_sqlite_to_postgres.py --with-user-data

The target URL comes from $DATABASE_URL (Railway shows it on the Postgres
plugin's Connect tab). Safe to re-run: rows are inserted with ON CONFLICT DO
NOTHING, so existing rows are left untouched.
"""
import argparse
import os
import sys

from sqlalchemy import create_engine, insert, inspect
from sqlalchemy.orm import sessionmaker

# Make the collector package importable (models + Base live there).
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "crypto-data-collector"))

from database.models import (  # noqa: E402
    Token, OneMinBucket, FifteenMinBucket, LatestTicker, Heartbeat,
    ChartMarker, TradeHistory, Strategy, Finder, EngineSetting, DebugLog,
    ApiKey, Subscription,
)
from database.db import Base  # noqa: E402

MARKET_TABLES = [Token, OneMinBucket, FifteenMinBucket, LatestTicker, Heartbeat]
USER_TABLES = [Strategy, Finder, ChartMarker, TradeHistory, EngineSetting,
               ApiKey, Subscription, DebugLog]

SQLITE_PATH = os.path.join(ROOT, "crypto-data-collector", "crypto_data.db")
BATCH = 500


def copy_table(src_session, dst_engine, model):
    rows = src_session.query(model).all()
    if not rows:
        print(f"  {model.__tablename__}: 0 rows")
        return
    cols = [c.name for c in model.__table__.columns]
    payload = [{c: getattr(r, c) for c in cols} for r in rows]

    from sqlalchemy.dialects.postgresql import insert as pg_insert
    with dst_engine.begin() as conn:
        for i in range(0, len(payload), BATCH):
            stmt = pg_insert(model.__table__).values(payload[i:i + BATCH])
            stmt = stmt.on_conflict_do_nothing()
            conn.execute(stmt)
    print(f"  {model.__tablename__}: {len(payload)} rows copied")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--with-user-data", action="store_true",
                    help="also copy strategies/finders/markers/trades/settings/logs")
    args = ap.parse_args()

    dst_url = os.environ.get("DATABASE_URL", "")
    if not dst_url:
        sys.exit("Set DATABASE_URL to the target Postgres URL first.")
    if dst_url.startswith("postgres://"):
        dst_url = dst_url.replace("postgres://", "postgresql+psycopg2://", 1)
    if not os.path.exists(SQLITE_PATH):
        sys.exit(f"Source SQLite DB not found at {SQLITE_PATH}")

    src_engine = create_engine(f"sqlite:///{SQLITE_PATH.replace(os.sep, '/')}")
    dst_engine = create_engine(dst_url)

    print("Creating tables on the target (if missing)...")
    Base.metadata.create_all(bind=dst_engine)

    SrcSession = sessionmaker(bind=src_engine)
    src = SrcSession()

    tables = list(MARKET_TABLES)
    if args.with_user_data:
        tables += USER_TABLES
    print(f"Copying {len(tables)} table(s) -> Postgres:")
    for model in tables:
        # Skip tables that don't exist in the source (older SQLite files).
        if inspect(src_engine).has_table(model.__tablename__):
            copy_table(src, dst_engine, model)
        else:
            print(f"  {model.__tablename__}: (not in source, skipped)")

    src.close()
    print("Done.")


if __name__ == "__main__":
    main()
