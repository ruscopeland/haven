"""Read a user's paid Haven plan from Clerk Billing.

Clerk owns accounts, plans, checkout, and subscriptions. Haven never calls
Stripe directly; Stripe is only the payment processor connected inside Clerk.
"""
from __future__ import annotations

import os
import time
import urllib.parse
import urllib.request
import json
import threading
from datetime import datetime
from api.plans import plan_for_slug, entitlement_payload

CLERK_SECRET_KEY = os.environ.get("CLERK_SECRET_KEY", "")
_cache: dict[str, tuple[float, dict]] = {}
_cache_lock = threading.Lock()
_CACHE_TTL = 30.0  # seconds


def clerk_billing_configured() -> bool:
    return bool(CLERK_SECRET_KEY)


def _http_get(path: str, params: dict | None = None) -> dict | list | None:
    if not CLERK_SECRET_KEY:
        return None
    q = f"?{urllib.parse.urlencode(params)}" if params else ""
    url = f"https://api.clerk.com/v1{path}{q}"
    req = urllib.request.Request(
        url,
        headers={
            "Authorization": f"Bearer {CLERK_SECRET_KEY}",
            "Content-Type": "application/json",
        },
        method="GET",
    )
    try:
        with urllib.request.urlopen(req, timeout=8) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except Exception as e:
        print(f"clerk_billing request failed {path}: {e}")
        return None


def _item_plan_slug(item: dict) -> str:
    plan = item.get("plan") or {}
    if isinstance(plan, dict):
        return str(plan.get("slug") or plan.get("name") or "").lower()
    return ""


def _payer_id(subscription: dict) -> str:
    payer = subscription.get("payer") or {}
    nested = payer.get("id") if isinstance(payer, dict) else ""
    return str(subscription.get("payerId") or subscription.get("payer_id") or nested or "")


def _period_end_ms(item: dict, subscription: dict) -> int | None:
    value = (
        item.get("periodEnd") or item.get("period_end")
        or subscription.get("periodEnd") or subscription.get("period_end")
    )
    if isinstance(value, (int, float)):
        number = int(value)
        return number * 1000 if number < 10_000_000_000 else number
    if isinstance(value, str) and value:
        try:
            return int(datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp() * 1000)
        except ValueError:
            return None
    return None


def get_clerk_entitlements(user_id: str) -> dict:
    """Return a paid entitlement only after exact user and plan validation.

    Trial access is owned by Haven's database, not inferred from a free Clerk
    account. Provider errors therefore fail closed instead of granting access.
    """
    now = time.time()
    with _cache_lock:
        hit = _cache.get(user_id)
        if hit and now - hit[0] < _CACHE_TTL:
            return hit[1]

    result = {
        "source": "clerk", "app_access": False, "live_allowed": False,
        "trial": False, "plan": None, "status": "none", "max_bots": 0,
        "max_strategies": 0, "max_finders": 0, "ai_daily": 0,
    }

    if not clerk_billing_configured():
        result["source"] = "clerk_unconfigured"
        return result

    safe_user_id = urllib.parse.quote(user_id, safe="")
    data = _http_get(f"/users/{safe_user_id}/billing/subscription")
    subscription = data if isinstance(data, dict) else {}
    if isinstance(subscription.get("data"), dict):
        subscription = subscription["data"]

    # Clerk's endpoint is user-scoped, and we additionally verify the payer
    # returned by Clerk before accepting any paid entitlement.
    if _payer_id(subscription) != user_id:
        subscription = {}

    items = (
        subscription.get("subscriptionItems")
        or subscription.get("subscription_items")
        or subscription.get("items")
        or []
    )
    subscription_status = str(subscription.get("status") or "").lower()

    for it in items:
        if not isinstance(it, dict):
            continue
        status = str(it.get("status") or subscription_status).lower()
        plan = plan_for_slug(_item_plan_slug(it))
        if plan and status in ("active", "past_due"):
            result = entitlement_payload(plan, trial=False, status=status, source="clerk")
            result["current_period_end"] = _period_end_ms(it, subscription)
            break

    with _cache_lock:
        _cache[user_id] = (now, result)
    return result
