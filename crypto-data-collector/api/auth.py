"""Haven authentication + authorization.

Three ways a request proves who it is, checked in this order:

1. SOLO MODE (local development / the owner's own stack). Active when the
   HAVEN_SOLO env var is "1", or automatically when Clerk is not configured.
   Every request becomes the 'local' user with full (paid) access — exactly
   the pre-SaaS behavior, zero login required.

2. X-Api-Key header (engine daemons + the cloud paper-runner). The raw key is
   SHA-256-hashed and looked up in api_keys. The special SERVICE_API_KEY env
   value identifies our own paper-runner, which may read every user's DRY
   strategies (never live).

3. Authorization: Bearer <Clerk session JWT> (the web app). Verified against
   Clerk's JWKS (public keys fetched once and cached by PyJWT); the token's
   `sub` claim is the user id.

Payment gate: Haven has no free tier. `require_paid` guards every data
endpoint; identity resolution itself only answers "who are you".
"""
import hashlib
import os
import threading
import time
from dataclasses import dataclass

from fastapi import Depends, HTTPException, Request
from sqlalchemy.orm import Session

from database.db import get_db
from database.models import ApiKey, Subscription

CLERK_JWKS_URL = os.environ.get("CLERK_JWKS_URL", "")
CLERK_ISSUER = os.environ.get("CLERK_ISSUER", "")
SERVICE_API_KEY = os.environ.get("SERVICE_API_KEY", "")
SOLO_MODE = os.environ.get("HAVEN_SOLO", "1" if not CLERK_JWKS_URL else "0") == "1"

# Subscription statuses that count as paid. `past_due` gets a grace window so
# a card hiccup doesn't insta-kill someone's running strategies.
ACTIVE_STATUSES = ("active", "trialing", "past_due")
PAST_DUE_GRACE_MS = 3 * 24 * 3600 * 1000


@dataclass
class Identity:
    user_id: str
    kind: str          # solo | user | engine | service
    paid: bool = False

    @property
    def is_service(self) -> bool:
        return self.kind == "service"


_jwk_client = None
_jwk_lock = threading.Lock()


def _get_jwk_client():
    global _jwk_client
    if _jwk_client is None:
        with _jwk_lock:
            if _jwk_client is None:
                import jwt
                _jwk_client = jwt.PyJWKClient(CLERK_JWKS_URL, cache_keys=True,
                                              lifespan=3600)
    return _jwk_client


def _verify_clerk_jwt(token: str) -> str:
    """Return the Clerk user id (sub) or raise 401."""
    import jwt
    try:
        signing_key = _get_jwk_client().get_signing_key_from_jwt(token)
        options = {"verify_aud": False}   # Clerk session tokens carry azp, not aud
        kwargs = {}
        if CLERK_ISSUER:
            kwargs["issuer"] = CLERK_ISSUER
        claims = jwt.decode(token, signing_key.key, algorithms=["RS256"],
                            options=options, leeway=10, **kwargs)
    except Exception:
        raise HTTPException(status_code=401, detail="Invalid or expired session token")
    sub = claims.get("sub")
    if not sub:
        raise HTTPException(status_code=401, detail="Token has no subject")
    return sub


def hash_key(raw: str) -> str:
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def subscription_active(db: Session, user_id: str) -> bool:
    sub = db.query(Subscription).filter(Subscription.user_id == user_id).first()
    if not sub or sub.status not in ACTIVE_STATUSES:
        return False
    if sub.status == "past_due":
        end = sub.current_period_end or 0
        return (time.time() * 1000) < end + PAST_DUE_GRACE_MS
    return True


# ── Tiny in-process rate limiter (per identity, per minute) ─────────────────
# Not a DDoS shield (the host's edge handles that) — this stops one runaway
# browser tab or script from monopolizing the API.
_RATE_LIMIT_PER_MIN = int(os.environ.get("RATE_LIMIT_PER_MIN", "600"))
_rate: dict = {}
_rate_lock = threading.Lock()


def _rate_check(key: str):
    window = int(time.time() // 60)
    with _rate_lock:
        bucket, count = _rate.get(key, (window, 0))
        if bucket != window:
            bucket, count = window, 0
        count += 1
        _rate[key] = (bucket, count)
        if len(_rate) > 10000:            # bound memory
            _rate.clear()
    if count > _RATE_LIMIT_PER_MIN:
        raise HTTPException(status_code=429, detail="Rate limit exceeded")


def get_identity(request: Request, db: Session = Depends(get_db)) -> Identity:
    if SOLO_MODE:
        return Identity(user_id="local", kind="solo", paid=True)

    api_key = request.headers.get("X-Api-Key")
    if api_key:
        if SERVICE_API_KEY and api_key == SERVICE_API_KEY:
            return Identity(user_id="service", kind="service", paid=True)
        row = (db.query(ApiKey)
               .filter(ApiKey.key_hash == hash_key(api_key), ApiKey.revoked == 0)
               .first())
        if not row:
            raise HTTPException(status_code=401, detail="Invalid API key")
        _rate_check(f"k:{row.user_id}")
        now_ms = int(time.time() * 1000)
        if not row.last_used_at or now_ms - row.last_used_at > 60_000:
            row.last_used_at = now_ms      # coarse "engine connected" signal
            db.commit()
        return Identity(user_id=row.user_id, kind="engine",
                        paid=subscription_active(db, row.user_id))

    auth = request.headers.get("Authorization", "")
    if auth.startswith("Bearer "):
        user_id = _verify_clerk_jwt(auth[7:])
        _rate_check(f"u:{user_id}")
        return Identity(user_id=user_id, kind="user",
                        paid=subscription_active(db, user_id))

    raise HTTPException(status_code=401, detail="Not authenticated")


def require_paid(identity: Identity = Depends(get_identity)) -> Identity:
    """No free tier: every data endpoint sits behind an active subscription.

    402 tells the web app to show the subscribe screen; engines surface it as
    'subscription required' in their log.
    """
    if not identity.paid:
        raise HTTPException(status_code=402, detail="Active subscription required")
    return identity


# ── Bot + library entitlements ───────────────────────────────────────────────
# A "bot" is a strategy armed DRY or LIVE (mode != off). Plan allowances (owner
# decisions 2026-07-06): paid subscription includes BASE_BOTS running at once,
# extra slots can be sold on top (subscriptions.extra_bots); a Stripe trial gets
# TRIAL_BOTS and may only paper-trade. SAVED strategies are capped separately at
# MAX_STRATEGIES per user (storage control) — bigger libraries (50/100 slots,
# all trade history kept) are a planned sellable upgrade, same shape as
# extra_bots. Solo mode and the service runner are never limited by any of it.
BASE_BOTS = int(os.environ.get("HAVEN_BASE_BOTS", "3"))
TRIAL_BOTS = int(os.environ.get("HAVEN_TRIAL_BOTS", "1"))
MAX_STRATEGIES = int(os.environ.get("HAVEN_MAX_STRATEGIES", "20"))


def entitlements(db: Session, identity: Identity) -> dict:
    """What this identity may run/keep: {max_bots (None = unlimited),
    live_allowed, trial, max_strategies (None = unlimited)}. Enforced where a
    strategy's mode is armed (PATCH /strategies) and where one is saved
    (POST /strategies)."""
    if SOLO_MODE or identity.is_service:
        return {"max_bots": None, "live_allowed": True, "trial": False,
                "max_strategies": None}
    sub = db.query(Subscription).filter(Subscription.user_id == identity.user_id).first()
    if sub and sub.status == "trialing":
        return {"max_bots": TRIAL_BOTS, "live_allowed": False, "trial": True,
                "max_strategies": MAX_STRATEGIES}
    extra = (sub.extra_bots or 0) if sub else 0
    return {"max_bots": BASE_BOTS + extra, "live_allowed": True, "trial": False,
            "max_strategies": MAX_STRATEGIES}
