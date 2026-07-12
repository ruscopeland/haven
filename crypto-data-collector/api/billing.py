"""Haven billing — Stripe subscriptions + free paper trial.

Pricing (set by the owner 2026-07-06):
  - Monthly: $10/mo, drops to $20/mo after the first 500 subscribers.
  - Annual:  $60/yr ($5/mo), drops to $120/yr after the first 500.
  - Free paper trial: PAPER_TRIAL_DAYS of cloud paper-trading (no LIVE),
    started via POST /billing/start-paper-trial without a card.

The "first 500" tier is enforced HERE, at checkout time: we count active
subscriptions and pick the founding price while under the cap. Whichever price
a user checks out on is the price Stripe keeps billing them — Stripe owns the
recurring amount once the subscription exists, so early adopters are
grandfathered automatically. We also stamp subscriptions.early=1 so the app can
show a "founding member" badge and so we never accidentally re-price them.

Four Stripe Price IDs live in env (created once in the Stripe dashboard, see
DEPLOY.md): HAVEN_PRICE_MONTHLY_EARLY / _MONTHLY_STANDARD /
_ANNUAL_EARLY / _ANNUAL_STANDARD.

This whole module is dormant in SOLO_MODE (the owner's own stack never bills).
"""
import os
import time

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel
from sqlalchemy.orm import Session

from database.db import get_db
from database.models import Subscription, Strategy
from api.auth import (
    get_identity, Identity, ACTIVE_STATUSES, SOLO_MODE, entitlements,
    PAPER_TRIAL_DAYS, subscription_active,
)

router = APIRouter(prefix="/billing", tags=["billing"])

STRIPE_SECRET_KEY = os.environ.get("STRIPE_SECRET_KEY", "")
STRIPE_WEBHOOK_SECRET = os.environ.get("STRIPE_WEBHOOK_SECRET", "")
WEB_APP_URL = os.environ.get("HAVEN_WEB_URL", "http://localhost:5173")

EARLY_LIMIT = int(os.environ.get("HAVEN_EARLY_LIMIT", "500"))
# Optional Stripe free-trial window (days) attached to checkout. 0 = none.
# While a subscription is `trialing`, entitlements limit it to paper-only bots.
TRIAL_DAYS = int(os.environ.get("HAVEN_TRIAL_DAYS", "0"))

PRICES = {
    ("monthly", True): os.environ.get("HAVEN_PRICE_MONTHLY_EARLY", ""),
    ("monthly", False): os.environ.get("HAVEN_PRICE_MONTHLY_STANDARD", ""),
    ("annual", True): os.environ.get("HAVEN_PRICE_ANNUAL_EARLY", ""),
    ("annual", False): os.environ.get("HAVEN_PRICE_ANNUAL_STANDARD", ""),
}


def _stripe():
    if not STRIPE_SECRET_KEY:
        raise HTTPException(status_code=503, detail="Billing not configured")
    import stripe
    stripe.api_key = STRIPE_SECRET_KEY
    return stripe


def active_subscriber_count(db: Session) -> int:
    # Count real paying/active seats only (exclude free paper trials for founding cap).
    return (db.query(Subscription)
            .filter(Subscription.status.in_(("active", "past_due")))
            .filter(Subscription.plan != "paper")
            .count())


def _founding_available(db: Session) -> bool:
    return active_subscriber_count(db) < EARLY_LIMIT


class CheckoutRequest(BaseModel):
    plan: str = "monthly"       # monthly | annual


@router.get("/pricing")
def get_pricing(db: Session = Depends(get_db)):
    """Public-ish pricing snapshot for the landing/subscribe page.

    Reports whether the founding price is still available and how many seats
    are left, so the UI can show "Founding price — N of 500 left".
    """
    count = active_subscriber_count(db)
    early = count < EARLY_LIMIT
    return {
        "early_available": early,
        "early_limit": EARLY_LIMIT,
        "seats_taken": count,
        "seats_left": max(0, EARLY_LIMIT - count),
        "monthly_usd": 10 if early else 20,
        "annual_usd": 60 if early else 120,
        "paper_trial_days": PAPER_TRIAL_DAYS,
        "paper_trial_bots": int(os.environ.get("HAVEN_TRIAL_BOTS", "1")),
    }


@router.get("/status")
def billing_status(db: Session = Depends(get_db),
                   identity: Identity = Depends(get_identity)):
    """This user's subscription state — drives the app's gate + badges.

    Also reports bot entitlements (a bot = a strategy armed DRY or LIVE):
    max_bots (null = unlimited, i.e. solo mode), how many are running now,
    whether LIVE mode is allowed (trials are paper-only), and the saved-
    strategy library usage (strategies_saved / max_strategies, null = unlimited).
    """
    ent = entitlements(db, identity)
    bots_running = (db.query(Strategy)
                    .filter(Strategy.user_id == identity.user_id,
                            Strategy.mode != "off").count())
    strategies_saved = (db.query(Strategy)
                        .filter(Strategy.user_id == identity.user_id).count())
    bots = {"max_bots": ent["max_bots"], "bots_running": bots_running,
            "live_allowed": ent["live_allowed"],
            "trial": ent.get("trial", False),
            "max_strategies": ent["max_strategies"],
            "strategies_saved": strategies_saved}
    if SOLO_MODE:
        return {"status": "active", "plan": "solo", "early": True, "paid": True, **bots}
    sub = db.query(Subscription).filter(Subscription.user_id == identity.user_id).first()
    if not sub:
        return {"status": "none", "plan": None, "early": False, "paid": False, **bots}
    return {
        "status": sub.status,
        "plan": sub.plan,
        "early": bool(sub.early),
        "paid": identity.paid,
        "current_period_end": sub.current_period_end,
        "extra_bots": sub.extra_bots or 0,
        **bots,
    }


@router.post("/start-paper-trial")
def start_paper_trial(db: Session = Depends(get_db),
                      identity: Identity = Depends(get_identity)):
    """Start a free paper-only trial (no card). Idempotent if already active.

    Creates/updates subscriptions row: status=trialing, plan=paper,
    current_period_end = now + PAPER_TRIAL_DAYS. Cannot stack on a paid plan;
    expired trials cannot be restarted (subscribe instead).
    """
    if SOLO_MODE:
        return {"ok": True, "status": "active", "plan": "solo", "paid": True,
                "message": "Solo mode — full access already"}
    if identity.kind not in ("user",):
        raise HTTPException(status_code=403, detail="Sign in with the web app to start a trial")

    now_ms = int(time.time() * 1000)
    end_ms = now_ms + PAPER_TRIAL_DAYS * 24 * 3600 * 1000
    sub = db.query(Subscription).filter(Subscription.user_id == identity.user_id).first()

    if sub and sub.status in ("active", "past_due") and sub.plan not in (None, "paper"):
        raise HTTPException(status_code=400, detail="You already have a paid subscription")

    if sub and subscription_active(db, identity.user_id):
        # Already on an unexpired trial or paid access.
        return {
            "ok": True,
            "status": sub.status,
            "plan": sub.plan,
            "paid": True,
            "current_period_end": sub.current_period_end,
            "message": "Already active",
        }

    if sub and sub.plan == "paper" and sub.status == "trialing":
        # Expired paper trial — do not restart free.
        raise HTTPException(
            status_code=402,
            detail="Paper trial has ended. Subscribe to keep trading.")

    if not sub:
        sub = Subscription(user_id=identity.user_id, created_at=now_ms)
        db.add(sub)
    sub.status = "trialing"
    sub.plan = "paper"
    sub.current_period_end = end_ms
    sub.updated_at = now_ms
    db.commit()
    return {
        "ok": True,
        "status": "trialing",
        "plan": "paper",
        "paid": True,
        "current_period_end": end_ms,
        "trial_days": PAPER_TRIAL_DAYS,
        "message": f"Paper trial started — {PAPER_TRIAL_DAYS} days, paper bots only",
    }


def _plain(obj):
    """Stripe SDK objects are not plain dicts — never call .get on them directly."""
    if obj is None:
        return {}
    if isinstance(obj, dict):
        return obj
    if hasattr(obj, "to_dict_recursive"):
        try:
            return obj.to_dict_recursive()
        except Exception:
            pass
    if hasattr(obj, "to_dict"):
        try:
            return obj.to_dict()
        except Exception:
            pass
    try:
        return dict(obj)
    except Exception:
        return {}


def _meta(obj) -> dict:
    return _plain(_plain(obj).get("metadata"))


def _upsert_subscription(db: Session, user_id: str, **fields):
    sub = db.query(Subscription).filter(Subscription.user_id == user_id).first()
    now_ms = int(time.time() * 1000)
    if not sub:
        sub = Subscription(user_id=user_id, created_at=now_ms)
        db.add(sub)
    for k, v in fields.items():
        if v is not None:
            setattr(sub, k, v)
    sub.updated_at = now_ms
    db.commit()
    return sub


def _apply_checkout_session(db: Session, session_obj) -> str | None:
    """Mark user active from a completed Checkout Session. Returns user_id or None."""
    s = _plain(session_obj)
    meta = _meta(s)
    user_id = s.get("client_reference_id") or meta.get("user_id")
    if not user_id:
        return None
    plan = meta.get("plan") or "monthly"
    if plan not in ("monthly", "annual"):
        plan = "monthly"
    early = 1 if meta.get("early") == "1" else 0
    # Checkout complete ⇒ paid access (paper trial plan replaced).
    status = "active"
    if s.get("status") == "complete" or s.get("payment_status") in ("paid", "no_payment_required"):
        status = "active"
    _upsert_subscription(
        db, user_id,
        stripe_customer_id=s.get("customer"),
        stripe_subscription_id=s.get("subscription"),
        status=status,
        plan=plan,
        early=early,
    )
    return user_id


def _apply_stripe_subscription(db: Session, sub_obj, user_id: str | None = None) -> str | None:
    s = _plain(sub_obj)
    meta = _meta(s)
    uid = user_id or meta.get("user_id") or _user_from_customer(db, s.get("customer"))
    if not uid:
        return None
    items = _plain(s.get("items")).get("data") or []
    first = _plain(items[0]) if items else {}
    price = _plain(first.get("price"))
    price_id = price.get("id")
    period_end = s.get("current_period_end") or 0
    st = s.get("status") or "active"
    # Map Stripe "trialing" only when still a Stripe trial — paid checkout is active.
    plan = meta.get("plan")
    if not plan and price_id:
        # Infer monthly vs annual from configured price ids
        for (p, _early), pid in PRICES.items():
            if pid and pid == price_id:
                plan = p
                break
    fields = {
        "stripe_customer_id": s.get("customer"),
        "stripe_subscription_id": s.get("id"),
        "status": st,
        "price_id": price_id,
        "current_period_end": int(period_end) * 1000 if period_end else None,
    }
    if plan:
        fields["plan"] = plan
    if meta.get("early") == "1":
        fields["early"] = 1
    _upsert_subscription(db, uid, **fields)
    return uid


@router.post("/checkout")
def create_checkout(req: CheckoutRequest, db: Session = Depends(get_db),
                    identity: Identity = Depends(get_identity)):
    """Create a Stripe Checkout session for a new subscription.

    Picks the founding price while seats remain, else the standard price. The
    Clerk user id rides in metadata + client_reference_id so the webhook can
    map the resulting subscription back to the account.
    """
    if SOLO_MODE:
        raise HTTPException(status_code=400, detail="Billing disabled in solo mode")
    plan = req.plan if req.plan in ("monthly", "annual") else "monthly"
    early = _founding_available(db)
    price_id = PRICES.get((plan, early)) or PRICES.get((plan, False))
    if not price_id:
        raise HTTPException(status_code=503, detail=f"No Stripe price configured for {plan}")

    stripe = _stripe()
    sub = db.query(Subscription).filter(Subscription.user_id == identity.user_id).first()
    customer_id = sub.stripe_customer_id if sub else None

    subscription_data = {"metadata": {"user_id": identity.user_id,
                                      "early": "1" if early else "0",
                                      "plan": plan}}
    if TRIAL_DAYS > 0:
        subscription_data["trial_period_days"] = TRIAL_DAYS
    session = stripe.checkout.Session.create(
        mode="subscription",
        line_items=[{"price": price_id, "quantity": 1}],
        client_reference_id=identity.user_id,
        customer=customer_id or None,
        metadata={"user_id": identity.user_id, "plan": plan, "early": "1" if early else "0"},
        subscription_data=subscription_data,
        success_url=f"{WEB_APP_URL}/?billing=success&session_id={{CHECKOUT_SESSION_ID}}",
        cancel_url=f"{WEB_APP_URL}/?billing=cancelled",
        allow_promotion_codes=True,
    )
    return {"url": session.url}


class ConfirmCheckoutBody(BaseModel):
    session_id: str | None = None


@router.post("/confirm-checkout")
def confirm_checkout(body: ConfirmCheckoutBody | None = None,
                     db: Session = Depends(get_db),
                     identity: Identity = Depends(get_identity)):
    """Apply a completed Checkout Session (or recover latest Stripe sub for this user).

    Called by the web app when it returns with ?billing=success. Works even when
    the webhook failed, so the account upgrades immediately after Stripe.
    """
    if SOLO_MODE:
        return {"ok": True, "status": "active", "plan": "solo", "paid": True}
    if identity.kind not in ("user",):
        raise HTTPException(status_code=403, detail="Sign in required")

    stripe = _stripe()
    session_id = (body.session_id if body else None) or None

    if session_id:
        try:
            session = stripe.checkout.Session.retrieve(session_id)
        except Exception as e:
            raise HTTPException(status_code=400, detail=f"Invalid session: {e}") from e
        s = _plain(session)
        ref = s.get("client_reference_id") or _meta(s).get("user_id")
        if ref and ref != identity.user_id:
            raise HTTPException(status_code=403, detail="Checkout session belongs to another account")
        if s.get("status") != "complete" and s.get("payment_status") not in ("paid", "no_payment_required"):
            raise HTTPException(status_code=400, detail="Checkout not complete yet")
        _apply_checkout_session(db, session)
        # Also pull subscription for period end / price id
        sub_id = s.get("subscription")
        if sub_id:
            try:
                stripe_sub = stripe.Subscription.retrieve(sub_id)
                _apply_stripe_subscription(db, stripe_sub, user_id=identity.user_id)
            except Exception:
                pass
    else:
        # Recover: find an active Stripe subscription tagged with this user.
        found = False
        try:
            result = stripe.Subscription.search(
                query=f"metadata['user_id']:'{identity.user_id}'",
                limit=5,
            )
            for stripe_sub in (result.data if hasattr(result, "data") else _plain(result).get("data") or []):
                st = _plain(stripe_sub).get("status")
                if st in ("active", "trialing", "past_due"):
                    _apply_stripe_subscription(db, stripe_sub, user_id=identity.user_id)
                    found = True
                    break
        except Exception:
            # Search API may be unavailable — fall through to customer lookup
            pass
        if not found:
            sub = db.query(Subscription).filter(Subscription.user_id == identity.user_id).first()
            if sub and sub.stripe_subscription_id:
                try:
                    stripe_sub = stripe.Subscription.retrieve(sub.stripe_subscription_id)
                    _apply_stripe_subscription(db, stripe_sub, user_id=identity.user_id)
                    found = True
                except Exception:
                    pass
        if not found:
            raise HTTPException(
                status_code=404,
                detail="No completed Stripe subscription found for this account yet",
            )

    # Return fresh status payload (same shape as GET /billing/status)
    return billing_status(db=db, identity=identity)


@router.post("/portal")
def create_portal(db: Session = Depends(get_db),
                  identity: Identity = Depends(get_identity)):
    """Stripe billing portal so users can update card / cancel themselves."""
    if SOLO_MODE:
        raise HTTPException(status_code=400, detail="Billing disabled in solo mode")
    sub = db.query(Subscription).filter(Subscription.user_id == identity.user_id).first()
    if not sub or not sub.stripe_customer_id:
        raise HTTPException(status_code=404, detail="No billing account yet — subscribe first")
    stripe = _stripe()
    portal = stripe.billing_portal.Session.create(
        customer=sub.stripe_customer_id,
        return_url=f"{WEB_APP_URL}/?tab=settings",
    )
    return {"url": portal.url}


@router.post("/webhook")
async def stripe_webhook(request: Request, db: Session = Depends(get_db)):
    """Stripe → Haven event sink (the source of truth for who has paid).

    Verifies the signature, then reconciles our subscriptions table. We handle
    the three events that change access: checkout completed, subscription
    updated (renewals, card recovery, plan changes), and deleted (cancel).
    """
    if not STRIPE_WEBHOOK_SECRET:
        raise HTTPException(status_code=503, detail="Webhook not configured")
    stripe = _stripe()
    payload = await request.body()
    sig = request.headers.get("stripe-signature", "")
    try:
        event = stripe.Webhook.construct_event(payload, sig, STRIPE_WEBHOOK_SECRET)
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid webhook signature")

    typ = event["type"] if isinstance(event, dict) else event["type"]
    data = _plain(event["data"] if isinstance(event, dict) else event["data"])
    obj = data.get("object") or event["data"]["object"]

    try:
        if typ == "checkout.session.completed":
            _apply_checkout_session(db, obj)
        elif typ in ("customer.subscription.updated", "customer.subscription.created"):
            _apply_stripe_subscription(db, obj)
        elif typ == "customer.subscription.deleted":
            s = _plain(obj)
            user_id = _meta(s).get("user_id") or _user_from_customer(db, s.get("customer"))
            if user_id:
                _upsert_subscription(db, user_id, status="canceled")
    except Exception as e:
        # Log and 500 so Stripe retries; never silently drop paid upgrades.
        print(f"stripe_webhook handler error type={typ}: {e}")
        raise HTTPException(status_code=500, detail=f"Webhook handler failed: {e}") from e

    return {"received": True}


def _user_from_customer(db: Session, customer_id: str | None) -> str | None:
    if not customer_id:
        return None
    sub = (db.query(Subscription)
           .filter(Subscription.stripe_customer_id == customer_id).first())
    return sub.user_id if sub else None
