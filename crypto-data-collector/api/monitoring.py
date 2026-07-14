"""Privacy-conscious production error monitoring."""

from __future__ import annotations

import os


def initialize_monitoring() -> None:
    dsn = os.environ.get("HAVEN_MONITORING_DSN", "").strip()
    if not dsn:
        return
    import sentry_sdk
    sentry_sdk.init(
        dsn=dsn,
        environment=os.environ.get("HAVEN_ENV", "development"),
        release=os.environ.get("HAVEN_RELEASE"),
        send_default_pii=False,
        traces_sample_rate=float(os.environ.get("HAVEN_TRACE_SAMPLE_RATE", "0.1")),
        profiles_sample_rate=0,
    )
