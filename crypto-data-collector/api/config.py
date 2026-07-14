"""Production configuration gate: fail before serving an unsafe deployment."""

from __future__ import annotations

import os
import base64


REQUIRED_PRODUCTION_SETTINGS = (
    "DATABASE_URL", "HAVEN_CORS_ORIGINS",
    "CLERK_JWKS_URL", "CLERK_ISSUER", "CLERK_SECRET_KEY",
    "HAVEN_OWNER_USER_IDS", "HAVEN_LEGAL_ENTITY_NAME",
    "HAVEN_LEGAL_CONTACT_EMAIL", "HAVEN_TERMS_VERSION",
    "HAVEN_PRIVACY_VERSION", "HAVEN_MONITORING_DASHBOARD_URL",
    "HAVEN_BACKUP_DASHBOARD_URL", "HAVEN_ENGINE_RELEASE_PUBLIC_KEY",
)


def validate_production_config() -> None:
    if os.environ.get("HAVEN_ENV", "development").lower() != "production":
        return
    missing = [name for name in REQUIRED_PRODUCTION_SETTINGS
               if not os.environ.get(name, "").strip()]
    database_url = os.environ.get("DATABASE_URL", "")
    if database_url.startswith("sqlite"):
        missing.append("DATABASE_URL (hosted PostgreSQL required)")
    origins = [value.strip() for value in os.environ.get("HAVEN_CORS_ORIGINS", "").split(",") if value.strip()]
    if "*" in origins or any(not value.startswith("https://") for value in origins):
        missing.append("HAVEN_CORS_ORIGINS (explicit HTTPS origins required)")
    for name in ("CLERK_JWKS_URL", "CLERK_ISSUER", "HAVEN_MONITORING_DASHBOARD_URL",
                 "HAVEN_BACKUP_DASHBOARD_URL"):
        value = os.environ.get(name, "")
        if value and not value.startswith("https://"):
            missing.append(f"{name} (HTTPS required)")
    try:
        public_key = base64.b64decode(
            os.environ.get("HAVEN_ENGINE_RELEASE_PUBLIC_KEY", ""), validate=True)
        if len(public_key) != 32:
            raise ValueError
    except (ValueError, TypeError):
        missing.append("HAVEN_ENGINE_RELEASE_PUBLIC_KEY (raw-base64 Ed25519 key required)")
    if os.environ.get("HAVEN_DATA_LICENSE_CONFIRMED") != "1":
        missing.append("HAVEN_DATA_LICENSE_CONFIRMED=1")
    if os.environ.get("HAVEN_SECRET_ROTATION_CONFIRMED") != "1":
        missing.append("HAVEN_SECRET_ROTATION_CONFIRMED=1")
    slugs = [os.environ.get(name, default) for name, default in (
        ("HAVEN_STARTER_PLAN_SLUG", "haven_starter"),
        ("HAVEN_PRO_PLAN_SLUG", "haven_pro"),
        ("HAVEN_ADVANCED_PLAN_SLUG", "haven_advanced"),
    )]
    if len(set(slugs)) != len(slugs):
        missing.append("unique Clerk plan slugs")
    if missing:
        raise RuntimeError("Unsafe production configuration; missing: " + ", ".join(missing))
