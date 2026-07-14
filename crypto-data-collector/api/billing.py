"""Haven access and plan status; Clerk Billing owns paid subscriptions."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from database.db import get_db
from database.models import Finder, Strategy, Subscription
from api.auth import (
    Identity, SOLO_MODE, entitlements, ensure_automatic_trial, get_identity,
)
from api.plans import PLANS, TRIAL, TRIAL_DAYS


router = APIRouter(prefix="/billing", tags=["billing"])


@router.get("/pricing")
def pricing():
    """Public configurable catalogue; Clerk plan slugs remain server-owned."""
    return {
        "trial_days": TRIAL_DAYS,
        "trial": TRIAL.public(),
        "plans": [PLANS[key].public() for key in ("starter", "pro", "advanced")],
        "billing_provider": "clerk",
    }


@router.get("/status")
def status(db: Session = Depends(get_db), identity: Identity = Depends(get_identity)):
    ent = entitlements(db, identity)
    sub = db.query(Subscription).filter(Subscription.user_id == identity.user_id).first()
    return {
        **ent,
        "paid": bool(SOLO_MODE or (ent.get("app_access") and not ent.get("trial"))),
        "bots_running": db.query(Strategy).filter(
            Strategy.user_id == identity.user_id, Strategy.mode != "off").count(),
        "strategies_saved": db.query(Strategy).filter(
            Strategy.user_id == identity.user_id).count(),
        "finders_saved": db.query(Finder).filter(Finder.user_id == identity.user_id).count(),
        "current_period_end": sub.current_period_end if sub else None,
        "billing_provider": "clerk",
    }


@router.post("/start-paper-trial")
def start_trial(db: Session = Depends(get_db), identity: Identity = Depends(get_identity)):
    """Compatibility route; trials now start automatically on first sign-in."""
    if identity.kind != "user" and not SOLO_MODE:
        raise HTTPException(status_code=403, detail="Sign in to start a trial")
    if SOLO_MODE:
        return {"ok": True, "status": "active", "plan": "solo"}
    sub = ensure_automatic_trial(db, identity.user_id)
    return {
        "ok": True, "status": sub.status, "plan": sub.plan,
        "current_period_end": sub.current_period_end,
        "message": "Your seven-day Haven trial starts automatically on first sign-in.",
    }
