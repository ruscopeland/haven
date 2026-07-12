"""Clerk Billing status for Haven API (source of truth for paid vs free).

When HAVEN_USE_CLERK_BILLING=1 and CLERK_SECRET_KEY is set, subscription
lifecycle is owned by Clerk. Stripe only processes cards under Clerk Billing.
"""
from __future__ import annotations

import os
import time
import urllib.error
import urllib.parse
import urllib.request
import json
import threading

USE_CLERK_BILLING = os.environ.get("HAVEN_USE_CLERK_BILLING", "1") == "1"
CLERK_SECRET_KEY = os.environ.get("CLERK_SECRET_KEY", "")
# Plan slugs that unlock live trading / engine (match Clerk Dashboard).
PAID_PLAN_SLUGS = {
    s.strip().lower()
    for s in os.environ.get("HAVEN_CLERK_PAID_PLANS", "pro").split(",")
    if s.strip()
}
# Feature keys that also unlock live (optional).
LIVE_FEATURES = {
    s.strip().lower()
    for s in os.environ.get("HAVEN_CLERK_LIVE_FEATURES", "live_trading").split(",")
    if s.strip()
}

_cache: dict[str, tuple[float, dict]] = {}
_cache_lock = threading.Lock()
_CACHE_TTL = 30.0  # seconds


def clerk_billing_configured() -> bool:
    return bool(USE_CLERK_BILLING and CLERK_SECRET_KEY)


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


def _item_features(item: dict) -> set[str]:
    plan = item.get("plan") or {}
    feats = plan.get("features") if isinstance(plan, dict) else None
    out = set()
    if isinstance(feats, list):
        for f in feats:
            if isinstance(f, dict):
                slug = f.get("slug") or f.get("key") or f.get("name")
                if slug:
                    out.add(str(slug).lower())
            elif isinstance(f, str):
                out.add(f.lower())
    return out


def _is_paid_item(item: dict) -> bool:
    status = str(item.get("status") or "").lower()
    # active / past_due count; free_trial on a paid plan may still be "free_trial"
    if status in ("canceled", "ended", "expired", "incomplete", "abandoned"):
        return False
    slug = _item_plan_slug(item)
    if slug in PAID_PLAN_SLUGS:
        return True
    # free_user / free plans are not paid
    if "free" in slug:
        return False
    feats = _item_features(item)
    if feats & LIVE_FEATURES:
        return True
    # amount > 0 if present
    amount = item.get("amount") or item.get("plan", {}).get("amount") if isinstance(item.get("plan"), dict) else None
    try:
        if amount is not None and int(amount) > 0 and status in ("active", "past_due", "trialing", "free_trial"):
            # trialing on paid plan still "paid path" for live after trial ends —
            # during free_trial of a paid plan, treat as not live yet unless feature says so
            if status in ("free_trial", "trialing") and "free" not in slug:
                return False  # paper-equivalent during trial unless you want live during trial
            return status in ("active", "past_due")
    except Exception:
        pass
    return status == "active" and slug and "free" not in slug


def get_clerk_entitlements(user_id: str) -> dict:
    """Return entitlements derived from Clerk Billing subscription items."""
    now = time.time()
    with _cache_lock:
        hit = _cache.get(user_id)
        if hit and now - hit[0] < _CACHE_TTL:
            return hit[1]

    # Signed-in users always get paper access when using Clerk Billing.
    result = {
        "source": "clerk",
        "app_access": True,       # free + paid
        "live_allowed": False,
        "trial": True,
        "plan": "free",
        "status": "free",
        "max_bots": int(os.environ.get("HAVEN_TRIAL_BOTS", "1")),
        "max_strategies": int(os.environ.get("HAVEN_MAX_STRATEGIES", "20")),
    }

    if not clerk_billing_configured():
        result["source"] = "clerk_unconfigured"
        return result

    data = _http_get(
        "/billing/subscription_items",
        {
            "payer_type": "user",
            "query": user_id,
            "include_free": "true",
            "limit": "20",
        },
    )
    items = []
    if isinstance(data, dict):
        items = data.get("data") or data.get("subscription_items") or []
    elif isinstance(data, list):
        items = data

    paid = False
    plan = "free"
    status = "free"
    for it in items:
        if not isinstance(it, dict):
            continue
        # Prefer items for this user if payer id present
        payer = it.get("payer_id") or it.get("user_id") or ""
        if payer and payer != user_id and not str(payer).startswith("user_"):
            # still accept if query already scoped
            pass
        if _is_paid_item(it):
            paid = True
            plan = _item_plan_slug(it) or "pro"
            status = str(it.get("status") or "active")
            break
        # track free plan name
        st = str(it.get("status") or "").lower()
        if st in ("active", "free", "free_trial"):
            plan = _item_plan_slug(it) or plan
            status = st or status

    if paid:
        result.update({
            "live_allowed": True,
            "trial": False,
            "plan": plan,
            "status": status if status else "active",
            "max_bots": int(os.environ.get("HAVEN_BASE_BOTS", "3")),
        })
    else:
        result["plan"] = plan or "free"
        result["status"] = status or "free"

    with _cache_lock:
        _cache[user_id] = (now, result)
    return result
