"""Haven billing — Stripe subscriptions.

Pricing (set by the owner 2026-07-06):
  - Monthly: $10/mo, drops to $20/mo after the first 500 subscribers.
  - Annual:  $60/yr ($5/mo), drops to $120/yr after the first 500.
  - No free tier.

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
from database.models import Subscription
from api.auth import get_identity, Identity, ACTIVE_STATUSES, SOLO_MODE

router = APIRouter(prefix="/billing", tags=["billing"])

STRIPE_SECRET_KEY = os.environ.get("STRIPE_SECRET_KEY", "")
STRIPE_WEBHOOK_SECRET = os.environ.get("STRIPE_WEBHOOK_SECRET", "")
WEB_APP_URL = os.environ.get("HAVEN_WEB_URL", "http://localhost:5173")

EARLY_LIMIT = int(os.environ.get("HAVEN_EARLY_LIMIT", "500"))

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
    return (db.query(Subscription)
            .filter(Subscription.status.in_(ACTIVE_STATUSES)).count())


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
    }


@router.get("/status")
def billing_status(db: Session = Depends(get_db),
                   identity: Identity = Depends(get_identity)):
    """This user's subscription state — drives the app's gate + badges."""
    if SOLO_MODE:
        return {"status": "active", "plan": "solo", "early": True, "paid": True}
    sub = db.query(Subscription).filter(Subscription.user_id == identity.user_id).first()
    if not sub:
        return {"status": "none", "plan": None, "early": False, "paid": False}
    return {
        "status": sub.status,
        "plan": sub.plan,
        "early": bool(sub.early),
        "paid": identity.paid,
        "current_period_end": sub.current_period_end,
    }


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

    session = stripe.checkout.Session.create(
        mode="subscription",
        line_items=[{"price": price_id, "quantity": 1}],
        client_reference_id=identity.user_id,
        customer=customer_id or None,
        metadata={"user_id": identity.user_id, "plan": plan, "early": "1" if early else "0"},
        subscription_data={"metadata": {"user_id": identity.user_id,
                                        "early": "1" if early else "0"}},
        success_url=f"{WEB_APP_URL}/?billing=success",
        cancel_url=f"{WEB_APP_URL}/?billing=cancelled",
        allow_promotion_codes=True,
    )
    return {"url": session.url}


@router.post("/portal")
def create_portal(db: Session = Depends(get_db),
                  identity: Identity = Depends(get_identity)):
    """Stripe billing portal so users can update card / cancel themselves."""
    if SOLO_MODE:
        raise HTTPException(status_code=400, detail="Billing disabled in solo mode")
    sub = db.query(Subscription).filter(Subscription.user_id == identity.user_id).first()
    if not sub or not sub.stripe_customer_id:
        raise HTTPException(status_code=404, detail="No billing account yet")
    stripe = _stripe()
    portal = stripe.billing_portal.Session.create(
        customer=sub.stripe_customer_id,
        return_url=f"{WEB_APP_URL}/?tab=settings",
    )
    return {"url": portal.url}


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

    typ = event["type"]
    obj = event["data"]["object"]

    if typ == "checkout.session.completed":
        user_id = obj.get("client_reference_id") or (obj.get("metadata") or {}).get("user_id")
        if user_id:
            early = (obj.get("metadata") or {}).get("early") == "1"
            _upsert_subscription(
                db, user_id,
                stripe_customer_id=obj.get("customer"),
                stripe_subscription_id=obj.get("subscription"),
                status="active",
                plan=(obj.get("metadata") or {}).get("plan"),
                early=1 if early else 0,
            )
    elif typ in ("customer.subscription.updated", "customer.subscription.created"):
        user_id = (obj.get("metadata") or {}).get("user_id")
        if not user_id:
            user_id = _user_from_customer(db, obj.get("customer"))
        if user_id:
            items = (obj.get("items") or {}).get("data") or [{}]
            price_id = (items[0].get("price") or {}).get("id")
            _upsert_subscription(
                db, user_id,
                stripe_customer_id=obj.get("customer"),
                stripe_subscription_id=obj.get("id"),
                status=obj.get("status"),
                price_id=price_id,
                current_period_end=(obj.get("current_period_end") or 0) * 1000,
            )
    elif typ == "customer.subscription.deleted":
        user_id = (obj.get("metadata") or {}).get("user_id") or \
            _user_from_customer(db, obj.get("customer"))
        if user_id:
            _upsert_subscription(db, user_id, status="canceled")

    return {"received": True}


def _user_from_customer(db: Session, customer_id: str | None) -> str | None:
    if not customer_id:
        return None
    sub = (db.query(Subscription)
           .filter(Subscription.stripe_customer_id == customer_id).first())
    return sub.user_id if sub else None
