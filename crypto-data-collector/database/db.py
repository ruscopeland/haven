import os
import time
from sqlalchemy import create_engine, text
from sqlalchemy.orm import declarative_base, sessionmaker
from sqlalchemy.exc import OperationalError

# ── Database location ────────────────────────────────────────────────────────
# Default: the original single-file SQLite DB next to this package (solo mode,
# exactly the pre-SaaS behavior). Cloud/multi-user: set DATABASE_URL to a
# Postgres URL (Railway supplies one). Multi-user REQUIRES Postgres — the
# SQLite path exists for local solo development only.
_DB_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_SQLITE_URL = f"sqlite:///{os.path.join(_DB_DIR, 'crypto_data.db').replace(os.sep, '/')}"

DATABASE_URL = os.environ.get("DATABASE_URL", _SQLITE_URL)
# Railway/Heroku hand out postgres:// which SQLAlchemy 2.0 no longer accepts.
if DATABASE_URL.startswith("postgres://"):
    DATABASE_URL = DATABASE_URL.replace("postgres://", "postgresql+psycopg2://", 1)

IS_SQLITE = DATABASE_URL.startswith("sqlite")

engine = create_engine(
    DATABASE_URL,
    connect_args={"check_same_thread": False} if IS_SQLITE else {},
    pool_pre_ping=True,
)

SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)

Base = declarative_base()


def dialect_insert(model):
    """INSERT statement builder with .on_conflict_do_update on both dialects.

    SQLite and Postgres expose the same on_conflict API from different modules;
    every upsert in the collector goes through here so it works on both.
    """
    if IS_SQLITE:
        from sqlalchemy.dialects.sqlite import insert as _insert
    else:
        from sqlalchemy.dialects.postgresql import insert as _insert
    return _insert(model)


def _existing_columns(conn, table: str) -> set:
    """Column names for a table, on either dialect (empty set = table missing)."""
    if IS_SQLITE:
        return {row[1] for row in conn.execute(text(f"PRAGMA table_info({table});"))}
    rows = conn.execute(text(
        "SELECT column_name FROM information_schema.columns "
        "WHERE table_name = :t"), {"t": table})
    return {r[0] for r in rows}


def _ensure_column(conn, table: str, column: str, ddl: str):
    """ADD COLUMN if missing — idempotent upgrade for pre-existing tables.

    DDL uses a DEFAULT so existing rows stay valid (solo-mode rows become
    user_id='local' automatically, which is exactly what the API's solo
    identity expects).
    """
    cols = _existing_columns(conn, table)
    if cols and column not in cols:
        conn.execute(text(f"ALTER TABLE {table} ADD COLUMN {column} {ddl};"))


def ensure_db_settings():
    """Per-dialect setup: pragmas (sqlite), indexes, idempotent column upgrades.

    create_all() won't add columns/indexes to pre-existing tables, so every
    schema addition since v0 is repeated here as an ALTER-if-missing.
    """
    with engine.connect() as conn:
        if IS_SQLITE:
            # WAL lets the collector, API, and engine share one file locally.
            conn.execute(text("PRAGMA journal_mode=WAL;"))
            conn.execute(text("PRAGMA synchronous=NORMAL;"))
        conn.execute(text(
            "CREATE INDEX IF NOT EXISTS ix_one_min_buckets_bucket_start "
            "ON one_min_buckets (bucket_start);"
        ))
        conn.execute(text(
            "CREATE INDEX IF NOT EXISTS ix_fifteen_min_buckets_bucket_start "
            "ON fifteen_min_buckets (bucket_start);"
        ))
        # Token Finder columns (2026-07-03).
        _ensure_column(conn, "strategies", "finder_id", "TEXT")
        _ensure_column(conn, "strategies", "max_positions", "INTEGER DEFAULT 1")
        _ensure_column(conn, "strategies", "switch_margin_pct", "FLOAT DEFAULT 10.0")
        # Multi-user columns (2026-07-06, Haven SaaS). Existing solo rows are
        # owned by the 'local' pseudo-user; API/middleware logs by 'system'.
        for table in ("strategies", "finders", "chart_markers", "trade_history",
                      "engine_settings"):
            _ensure_column(conn, table, "user_id", "TEXT DEFAULT 'local'")
        _ensure_column(conn, "debug_logs", "user_id", "TEXT DEFAULT 'system'")
        for table in ("strategies", "chart_markers", "trade_history"):
            conn.execute(text(
                f"CREATE INDEX IF NOT EXISTS ix_{table}_user_id ON {table} (user_id);"
            ))
        conn.commit()


def db_write(fn, max_retries=3):
    """Execute a DB write with exponential backoff on SQLITE_BUSY.

    No-op safety on Postgres (the error string never matches there).
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
