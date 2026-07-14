"""Configurable Haven plan catalogue and capacity entitlements."""

from __future__ import annotations

import os
from dataclasses import dataclass, asdict


def _integer(name: str, default: int) -> int:
    return max(0, int(os.environ.get(name, str(default))))


@dataclass(frozen=True)
class Plan:
    key: str
    clerk_slug: str
    monthly_price: str
    annual_price: str
    bots: int
    strategies: int
    finders: int
    ai_daily: int
    live_allowed: bool = True

    def public(self) -> dict:
        return asdict(self)


TRIAL_DAYS = _integer("HAVEN_TRIAL_DAYS", 7)
TRIAL = Plan(
    key="trial", clerk_slug="", monthly_price="0", annual_price="0",
    bots=_integer("HAVEN_TRIAL_BOTS", 1),
    strategies=_integer("HAVEN_TRIAL_STRATEGIES", 3),
    finders=_integer("HAVEN_TRIAL_FINDERS", 1),
    ai_daily=_integer("HAVEN_TRIAL_AI_DAILY", 5),
    live_allowed=True,
)


def _plan(key: str, *, slug: str, monthly: str, annual: str,
          bots: int, strategies: int, finders: int, ai: int) -> Plan:
    prefix = f"HAVEN_{key.upper()}"
    return Plan(
        key=key,
        clerk_slug=os.environ.get(f"{prefix}_PLAN_SLUG", slug).strip().lower(),
        monthly_price=os.environ.get(f"{prefix}_PRICE_MONTHLY", monthly),
        annual_price=os.environ.get(f"{prefix}_PRICE_ANNUAL", annual),
        bots=_integer(f"{prefix}_BOTS", bots),
        strategies=_integer(f"{prefix}_STRATEGIES", strategies),
        finders=_integer(f"{prefix}_FINDERS", finders),
        ai_daily=_integer(f"{prefix}_AI_DAILY", ai),
    )


PLANS = {
    p.key: p for p in (
        _plan("starter", slug="haven_starter", monthly="19", annual="190",
              bots=3, strategies=15, finders=3, ai=25),
        _plan("pro", slug="haven_pro", monthly="49", annual="490",
              bots=10, strategies=50, finders=10, ai=100),
        _plan("advanced", slug="haven_advanced", monthly="99", annual="990",
              bots=30, strategies=200, finders=30, ai=500),
    )
}
BY_SLUG = {plan.clerk_slug: plan for plan in PLANS.values() if plan.clerk_slug}


def plan_for_slug(slug: str | None) -> Plan | None:
    return BY_SLUG.get(str(slug or "").strip().lower())


def entitlement_payload(plan: Plan, *, trial: bool, status: str, source: str) -> dict:
    return {
        "source": source, "app_access": True, "live_allowed": plan.live_allowed,
        "trial": trial, "plan": plan.key, "status": status,
        "max_bots": plan.bots, "max_strategies": plan.strategies,
        "max_finders": plan.finders, "ai_daily": plan.ai_daily,
    }
