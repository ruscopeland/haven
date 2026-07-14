"""Haven authentication + authorization.

Three ways a request proves who it is, checked in this order:

1. SOLO MODE (local development / the owner's own stack). Active when the
   HAVEN_SOLO env var is "1", or automatically when Clerk is not configured.
   Every request becomes the 'local' user with full (paid) access — exactly
   the pre-SaaS behavior, zero login required.

2. X-Api-Key header (a user's local engine). The raw key is SHA-256-hashed,
   scoped, expiring, and looked up in api_keys.

3. Authorization: Bearer <Clerk session JWT> (the web app). Verified against
   Clerk's JWKS (public keys fetched once and cached by PyJWT); the token's
   `sub` claim is the user id.

Payment gate: full data access requires a paid subscription or an unexpired
automatic trial. The trial permits both paper and live local-engine workflows,
with smaller capacity limits. Public marketing endpoints are unauthenticated.
"""
import hashlib
import os
import threading
import time
from dataclasses import dataclass

from fastapi import Depends, HTTPException, Request
from sqlalchemy.orm import Session

from database.db import get_db, dialect_insert
from database.models import ApiKey, Subscription
from api.clerk_billing import clerk_billing_configured, get_clerk_entitlements
from api.plans import TRIAL, TRIAL_DAYS, entitlement_payload, PLANS

CLERK_JWKS_URL = os.environ.get("CLERK_JWKS_URL", "")
CLERK_ISSUER = os.environ.get("CLERK_ISSUER", "")
SOLO_MODE = os.environ.get("HAVEN_SOLO", "1" if not CLERK_JWKS_URL else "0") == "1"

# Subscription statuses that count as paid. `past_due` gets a grace window so
# a card hiccup doesn't insta-kill someone's running strategies.
ACTIVE_STATUSES = ("active", "trialing", "past_due")
PAST_DUE_GRACE_MS = 3 * 24 * 3600 * 1000


@dataclass
class Identity:
    user_id: str
    kind: str          # solo | user | engine
    paid: bool = False
    scopes: frozenset[str] = frozenset()

    def allows(self, scope: str) -> bool:
        return self.kind in ("solo", "user") or scope in self.scopes


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
    if clerk_billing_configured():
        ent = get_clerk_entitlements(user_id)
        if ent.get("app_access"):
            return True

        sub = db.query(Subscription).filter(Subscription.user_id == user_id).first()
        # Clerk is authoritative for paid access. The only local fallback is
        # Haven's own one-time trial, never a stale paid row.
        if not sub or sub.plan != "trial":
            return False
    else:
        sub = db.query(Subscription).filter(Subscription.user_id == user_id).first()
    if not sub or sub.status not in ACTIVE_STATUSES:
        return False
    now_ms = time.time() * 1000
    if sub.status == "past_due":
        end = sub.current_period_end or 0
        return now_ms < end + PAST_DUE_GRACE_MS
    # Haven's automatic trial expires at current_period_end when set.
    if sub.status == "trialing" and sub.current_period_end:
        return now_ms < sub.current_period_end
    return True


def ensure_automatic_trial(db: Session, user_id: str) -> Subscription:
    """Create the user's one non-renewable seven-day trial on first sign-in."""
    sub = db.query(Subscription).filter(Subscription.user_id == user_id).first()
    if sub:
        return sub
    at = int(time.time() * 1000)
    values = dict(
        user_id=user_id, status="trialing", plan="trial",
        current_period_end=at + TRIAL_DAYS * 86_400_000,
        extra_bots=0, created_at=at, updated_at=at,
    )
    stmt = dialect_insert(Subscription).values(**values).on_conflict_do_nothing(
        index_elements=["user_id"])
    db.execute(stmt)
    db.commit()
    return db.get(Subscription, user_id)


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
        row = (db.query(ApiKey)
               .filter(ApiKey.key_hash == hash_key(api_key), ApiKey.revoked == 0)
               .first())
        if not row:
            raise HTTPException(status_code=401, detail="Invalid API key")
        _rate_check(f"k:{row.user_id}")
        now_ms = int(time.time() * 1000)
        if row.expires_at and row.expires_at <= now_ms:
            raise HTTPException(status_code=401, detail="Engine key expired")
        if not row.last_used_at or now_ms - row.last_used_at > 60_000:
            row.last_used_at = now_ms      # coarse "engine connected" signal
            db.commit()
        return Identity(
            user_id=row.user_id, kind="engine",
            paid=subscription_active(db, row.user_id),
            scopes=frozenset(s.strip() for s in (row.scopes or "").split(",") if s.strip()),
        )

    auth = request.headers.get("Authorization", "")
    if auth.startswith("Bearer "):
        user_id = _verify_clerk_jwt(auth[7:])
        ensure_automatic_trial(db, user_id)
        _rate_check(f"u:{user_id}")
        return Identity(user_id=user_id, kind="user",
                        paid=subscription_active(db, user_id))

    raise HTTPException(status_code=401, detail="Not authenticated")


def require_paid(identity: Identity = Depends(get_identity)) -> Identity:
    """Data endpoints require an active paid plan or unexpired trial.

    402 tells the web app to show the subscribe / start-trial screen; engines
    surface it as 'subscription required' in their log.
    """
    if not identity.paid:
        raise HTTPException(status_code=402, detail="Active subscription or trial required")
    return identity


def require_identity_scope(identity: Identity, scope: str):
    if not identity.allows(scope):
        raise HTTPException(status_code=403, detail=f"Credential lacks required scope: {scope}")


def require_owner(identity: Identity = Depends(require_paid)) -> Identity:
    owners = {x.strip() for x in os.environ.get("HAVEN_OWNER_USER_IDS", "").split(",") if x.strip()}
    if identity.kind == "solo" or identity.user_id in owners:
        return identity
    raise HTTPException(status_code=403, detail="Owner access required")


# ── Bot + library entitlements ───────────────────────────────────────────────
# A "bot" is a strategy armed DRY or LIVE (mode != off). Plan allowances:
# Paid plans and the automatic trial use the central configurable catalogue.
BASE_BOTS = PLANS["starter"].bots
TRIAL_BOTS = TRIAL.bots
MAX_STRATEGIES = PLANS["starter"].strategies


def entitlements(db: Session, identity: Identity) -> dict:
    """What this identity may run/keep: {max_bots (None = unlimited),
    live_allowed, trial, max_strategies (None = unlimited), plan}. Enforced
    where a strategy's mode is armed (PATCH /strategies) and on save.
    """
    if SOLO_MODE:
        return {"max_bots": None, "live_allowed": True, "trial": False,
                "max_strategies": None, "max_finders": None, "ai_daily": None,
                "plan": "solo"}

    # Preferred path: Clerk Billing owns free vs paid.
    if clerk_billing_configured() and identity.kind in ("user", "engine"):
        paid = get_clerk_entitlements(identity.user_id)
        if paid.get("app_access"):
            at = int(time.time() * 1000)
            sub = db.get(Subscription, identity.user_id)
            if not sub:
                sub = Subscription(user_id=identity.user_id, created_at=at)
                db.add(sub)
            sub.plan = paid.get("plan")
            sub.status = paid.get("status") or "active"
            sub.current_period_end = paid.get("current_period_end")
            sub.updated_at = at
            db.commit()
            return paid

    sub = db.query(Subscription).filter(Subscription.user_id == identity.user_id).first()
    if sub and sub.status == "trialing" and subscription_active(db, identity.user_id):
        return entitlement_payload(TRIAL, trial=True, status="trialing", source="haven")
    if not sub or not subscription_active(db, identity.user_id):
        return {"max_bots": 0, "live_allowed": False, "trial": False,
                "max_strategies": 0, "max_finders": 0, "ai_daily": 0, "plan": None}
    plan = PLANS.get(sub.plan or "starter", PLANS["starter"])
    payload = entitlement_payload(plan, trial=False, status=sub.status, source="haven")
    payload["max_bots"] += sub.extra_bots or 0
    return payload
