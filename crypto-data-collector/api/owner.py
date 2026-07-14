"""Private owner operations API."""

from __future__ import annotations

import json
import os
import time
from pathlib import Path

from alembic.config import Config
from alembic.script import ScriptDirectory
from fastapi import APIRouter, Depends
from sqlalchemy import func, text
from sqlalchemy.orm import Session

from api.auth import Identity, require_owner
from database.db import DATABASE_URL, IS_SQLITE, get_db
from database.models import (
    ApiKey, BackupRun, AlphaAsset, MarketCandle, OperationAlert, ProviderStatus,
    ProviderUsage, Strategy, Subscription, TradeHistory,
)


router = APIRouter(prefix="/owner", tags=["owner"])


def _links() -> dict:
    return {
        "deployment": os.environ.get("HAVEN_DEPLOYMENT_DASHBOARD_URL"),
        "binance_alpha": "https://www.binance.com/en/alpha",
        "clerk": os.environ.get("HAVEN_CLERK_DASHBOARD_URL", "https://dashboard.clerk.com"),
        "monitoring": os.environ.get("HAVEN_MONITORING_DASHBOARD_URL"),
        "backups": os.environ.get("HAVEN_BACKUP_DASHBOARD_URL"),
        "repository": os.environ.get("HAVEN_REPOSITORY_URL"),
    }


def _migration_state(db: Session) -> dict:
    root = Path(__file__).resolve().parents[1]
    config = Config(str(root / "alembic.ini"))
    config.set_main_option("script_location", str(root / "migrations"))
    expected = ScriptDirectory.from_config(config).get_current_head()
    try:
        current = db.execute(text("SELECT version_num FROM alembic_version")).scalar()
    except Exception:
        current = None
    return {"current": current, "expected": expected, "up_to_date": current == expected}


def _json_object(value: str | None) -> dict:
    try:
        parsed = json.loads(value or "{}")
        return parsed if isinstance(parsed, dict) else {}
    except (TypeError, ValueError):
        return {}


@router.get("/overview")
def overview(db: Session = Depends(get_db), identity: Identity = Depends(require_owner)):
    now = int(time.time() * 1000)
    provider = db.query(ProviderStatus).filter(ProviderStatus.provider == "binance_alpha").first()
    backup = (db.query(BackupRun).filter(BackupRun.status == "succeeded")
              .order_by(BackupRun.completed_at.desc()).first())
    migration = _migration_state(db)
    alerts = []
    if not (os.environ.get("HAVEN_MONITORING_DSN") or
            os.environ.get("HAVEN_MONITORING_DASHBOARD_URL")):
        alerts.append({"severity": "warning", "code": "monitoring_not_configured",
                       "message": "Production error monitoring is not configured."})
    if os.environ.get("HAVEN_SECRET_ROTATION_CONFIRMED") != "1":
        alerts.append({"severity": "critical", "code": "credentials_need_rotation",
                       "message": "Previously exposed service credentials still need rotation."})
    if os.environ.get("HAVEN_DATA_LICENSE_CONFIRMED") != "1":
        alerts.append({"severity": "critical", "code": "data_license_unconfirmed",
                       "message": "Binance Alpha market-data terms have not been acknowledged."})
    if not os.environ.get("HAVEN_ENGINE_RELEASE_PUBLIC_KEY"):
        alerts.append({"severity": "critical", "code": "release_signing_missing",
                       "message": "Engine release signature verification is not configured."})
    if not provider or provider.state != "connected":
        alerts.append({"severity": "critical", "code": "binance_alpha_down",
                       "message": "Binance Alpha catalogue polling is not connected."})
    elif not provider.last_event_at or now - provider.last_event_at > 120_000:
        alerts.append({"severity": "warning", "code": "binance_alpha_stale",
                       "message": "Binance Alpha catalogue polling has not refreshed recently."})
    if not migration["up_to_date"]:
        alerts.append({"severity": "critical", "code": "migration_drift",
                       "message": "Database migrations are not at the deployed revision."})
    pending = db.query(TradeHistory).filter(
        TradeHistory.status == "PENDING",
        TradeHistory.submitted_at < now - 300_000,
    ).count()
    if pending:
        alerts.append({"severity": "critical", "code": "trade_reconciliation",
                       "message": f"{pending} submitted trade(s) still need reconciliation."})
    if not backup or now - backup.started_at > 86_400_000:
        alerts.append({"severity": "warning", "code": "backup_stale",
                       "message": "No successful backup is recorded in the last 24 hours."})
    expiring_keys = db.query(ApiKey).filter(
        ApiKey.revoked == 0, ApiKey.expires_at.isnot(None),
        ApiKey.expires_at < now + 7 * 86_400_000,
    ).count()
    if expiring_keys:
        alerts.append({"severity": "warning", "code": "engine_keys_expiring",
                       "message": f"{expiring_keys} engine credential(s) expire within seven days."})

    configured_db = "sqlite" if IS_SQLITE else "postgresql"
    db_size = None
    if IS_SQLITE:
        path = DATABASE_URL.removeprefix("sqlite:///")
        try:
            db_size = Path(path).stat().st_size
        except OSError:
            pass
    else:
        try:
            db_size = db.execute(text("SELECT pg_database_size(current_database())")).scalar()
        except Exception:
            pass
    subscription_rows = db.query(
        Subscription.plan, Subscription.status, func.count(Subscription.user_id)
    ).group_by(Subscription.plan, Subscription.status).all()

    return {
        "generated_at": now, "alerts": alerts,
        "service": {"status": "ok" if not any(a["severity"] == "critical" for a in alerts) else "degraded"},
        "provider": {
            "name": "Binance Alpha", "state": provider.state if provider else "unknown",
            "last_event_at": provider.last_event_at if provider else None,
            "last_reconciled_at": provider.last_reconciled_at if provider else None,
            "reconnect_count": provider.reconnect_count if provider else 0,
            "gap_count": provider.gap_count if provider else 0,
            "error": provider.error if provider else None,
            "details": _json_object(provider.details_json) if provider else {},
            "usage": None,
        },
        "database": {
            "engine": configured_db, "size_bytes": db_size, "migrations": migration,
            "assets": db.query(AlphaAsset).count(), "candles": db.query(MarketCandle).count(),
            "pending_reconciliation": pending,
        },
        "trading": {
            "active_bots": db.query(Strategy).filter(Strategy.mode != "off").count(),
            "live_bots": db.query(Strategy).filter(Strategy.mode == "live").count(),
        },
        "subscriptions": [
            {"plan": plan, "status": status, "count": count}
            for plan, status, count in subscription_rows
        ],
        "backup": ({"status": backup.status, "started_at": backup.started_at,
                    "completed_at": backup.completed_at, "provider": backup.provider,
                    "error": backup.error} if backup else None),
        "links": _links(),
    }
