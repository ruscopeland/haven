import os
import time
from sqlalchemy import create_engine, text
from sqlalchemy.orm import declarative_base, sessionmaker
from sqlalchemy.exc import OperationalError

# Always resolve the DB path relative to this file's directory,
# not the current working directory — so it works from anywhere.
_DB_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATABASE_URL = f"sqlite:///{os.path.join(_DB_DIR, 'crypto_data.db').replace(os.sep, '/')}"

engine = create_engine(
    DATABASE_URL,
    connect_args={"check_same_thread": False},
    pool_pre_ping=True,
)

SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)

Base = declarative_base()


def ensure_db_settings():
    """Run PRAGMAs on engine creation to enable WAL mode.

    WAL mode allows one writer + many readers to proceed simultaneously,
    which is essential when the collector, API server, and execution engine
    all access the same SQLite file concurrently.
    """
    with engine.connect() as conn:
        conn.execute(text("PRAGMA journal_mode=WAL;"))
        conn.execute(text("PRAGMA synchronous=NORMAL;"))
        # create_all won't add new indexes to a pre-existing table, so ensure the
        # bucket_start index (used by /signals + pruning) exists explicitly.
        conn.execute(text(
            "CREATE INDEX IF NOT EXISTS ix_one_min_buckets_bucket_start "
            "ON one_min_buckets (bucket_start);"
        ))
        conn.execute(text(
            "CREATE INDEX IF NOT EXISTS ix_fifteen_min_buckets_bucket_start "
            "ON fifteen_min_buckets (bucket_start);"
        ))
        # create_all won't add new COLUMNS to a pre-existing table either. Token
        # Finder columns on strategies (2026-07): ADD COLUMN with a default fills
        # existing rows, so old strategies stay valid fixed-symbol rows.
        existing = {row[1] for row in conn.execute(text("PRAGMA table_info(strategies);"))}
        if existing:  # table exists (fresh DBs get these via create_all)
            if "finder_id" not in existing:
                conn.execute(text("ALTER TABLE strategies ADD COLUMN finder_id TEXT;"))
            if "max_positions" not in existing:
                conn.execute(text("ALTER TABLE strategies ADD COLUMN max_positions INTEGER DEFAULT 1;"))
            if "switch_margin_pct" not in existing:
                conn.execute(text("ALTER TABLE strategies ADD COLUMN switch_margin_pct FLOAT DEFAULT 10.0;"))
        conn.commit()


def db_write(fn, max_retries=3):
    """Execute a DB write with exponential backoff on SQLITE_BUSY.

    Usage:
        db_write(lambda: db.commit())
        # or as a decorator for a block:
        def do_commit():
            db.add(obj)
            db.commit()
        db_write(do_commit)
    """
    for attempt in range(max_retries):
        try:
            return fn()
        except OperationalError as e:
            if "database is locked" in str(e) and attempt < max_retries - 1:
                time.sleep(0.1 * (2 ** attempt))
                continue
            raise


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
