"""Create, verify and encrypt a Haven database backup.

Production usage requires `HAVEN_BACKUP_DIR` and a Fernet key in
`HAVEN_BACKUP_ENCRYPTION_KEY`. Store both outside the application workspace.
"""

from __future__ import annotations

import hashlib
import os
import sqlite3
import subprocess
import sys
import tempfile
import time
import uuid
from pathlib import Path

from cryptography.fernet import Fernet

# Running this file directly sets Python's import root to ``tools``. Add the
# backend directory so the same command works locally and in GitHub Actions.
BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from database.db import DATABASE_URL, IS_SQLITE, SessionLocal
from database.models import BackupRun


def _plain_backup(path: Path) -> None:
    if IS_SQLITE:
        source_path = DATABASE_URL.removeprefix("sqlite:///")
        source = sqlite3.connect(source_path)
        target = sqlite3.connect(path)
        try:
            source.backup(target)
        finally:
            target.close()
            source.close()
        check = sqlite3.connect(path)
        try:
            if check.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
                raise RuntimeError("SQLite backup integrity check failed")
        finally:
            check.close()
        return
    pg_dump = os.environ.get("PG_DUMP_BIN", "pg_dump")
    pg_restore = os.environ.get("PG_RESTORE_BIN", "pg_restore")
    subprocess.run(
        [pg_dump, "--format=custom", "--no-owner", "--file", str(path), DATABASE_URL],
        check=True, capture_output=True, timeout=3600,
    )
    subprocess.run([pg_restore, "--list", str(path)], check=True,
                   capture_output=True, timeout=300)


def main() -> None:
    raw_destination = os.environ.get("HAVEN_BACKUP_DIR", "").strip()
    destination = Path(raw_destination).expanduser()
    key = os.environ.get("HAVEN_BACKUP_ENCRYPTION_KEY", "").encode()
    if not raw_destination or not key:
        raise RuntimeError("HAVEN_BACKUP_DIR and HAVEN_BACKUP_ENCRYPTION_KEY are required")
    destination.mkdir(parents=True, exist_ok=True)
    run_id = str(uuid.uuid4())
    started = int(time.time() * 1000)
    with SessionLocal() as db:
        db.add(BackupRun(id=run_id, provider="encrypted-pg-dump" if not IS_SQLITE else "encrypted-sqlite",
                         status="running", started_at=started))
        db.commit()
    temp_name = None
    try:
        with tempfile.NamedTemporaryFile(prefix="haven-backup-", suffix=".dump", delete=False) as handle:
            temp_name = Path(handle.name)
        _plain_backup(temp_name)
        encrypted = Fernet(key).encrypt(temp_name.read_bytes())
        name = f"haven-{time.strftime('%Y%m%d-%H%M%S', time.gmtime())}.dump.enc"
        final = destination / name
        final.write_bytes(encrypted)
        digest = hashlib.sha256(encrypted).hexdigest()
        with SessionLocal() as db:
            row = db.get(BackupRun, run_id)
            row.status = "succeeded"; row.completed_at = int(time.time() * 1000)
            row.location = str(final); row.checksum = digest
            db.commit()
        print(f"Verified encrypted backup created: {final} ({digest})")
    except Exception as exc:
        with SessionLocal() as db:
            row = db.get(BackupRun, run_id)
            row.status = "failed"; row.completed_at = int(time.time() * 1000)
            row.error = f"{type(exc).__name__}: {exc}"[:2000]
            db.commit()
        raise
    finally:
        if temp_name:
            temp_name.unlink(missing_ok=True)


if __name__ == "__main__":
    main()
