"""Database engine, sessions and migration entrypoint."""

import os
from pathlib import Path

from sqlalchemy import create_engine
from sqlalchemy.orm import declarative_base, sessionmaker


_ROOT = Path(__file__).resolve().parents[1]
_SQLITE_URL = f"sqlite:///{(_ROOT / 'crypto_data.db').as_posix()}"
DATABASE_URL = os.environ.get("DATABASE_URL", _SQLITE_URL)
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


def run_migrations(revision: str = "head") -> None:
    """Apply checked-in Alembic migrations before accepting traffic."""
    from alembic import command
    from alembic.config import Config
    config = Config(str(_ROOT / "alembic.ini"))
    config.set_main_option("script_location", str(_ROOT / "migrations"))
    config.set_main_option("sqlalchemy.url", DATABASE_URL.replace("%", "%%"))
    command.upgrade(config, revision)


def dialect_insert(model):
    """Return the dialect-specific INSERT builder used for safe upserts."""
    if IS_SQLITE:
        from sqlalchemy.dialects.sqlite import insert
    else:
        from sqlalchemy.dialects.postgresql import insert
    return insert(model)


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
