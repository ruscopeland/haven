from fastapi import FastAPI, Depends, HTTPException
from sqlalchemy.orm import Session
from sqlalchemy import func
from database.db import get_db, run_migrations, dialect_insert
from database.models import (
    Token, LatestTicker, Heartbeat, ChartMarker, TradeHistory,
    DebugLog, EngineSetting, Strategy, StrategyVersion, Finder,
    AiDailyUsage, AlphaAsset, MarketCandle, ProviderStatus,
    MARKER_TYPES, STRATEGY_MODES, FINDER_INTERVALS,
)
from api.auth import (
    get_identity, require_paid, require_identity_scope, Identity, SOLO_MODE, hash_key, entitlements,
)
from api.chains import chain_public_info

LEGACY_CHAIN_ID_MAP = {"56": "bsc"}
from pydantic import BaseModel, ConfigDict
from typing import List, Any
from fastapi.middleware.cors import CORSMiddleware
from fastapi import Request
from contextlib import asynccontextmanager
from market_data import BinanceAlphaMarketDataService
from market_data.alpha_client import AlphaError
from api.config import validate_production_config
from api.monitoring import initialize_monitoring
import asyncio
import os
import time
import json
import hashlib


@asynccontextmanager
async def lifespan(app: FastAPI):
    validate_production_config()
    # Ensure tables exist before serving (replaces deprecated @app.on_event).
    run_migrations()
    print(f"Database tables ensured on startup. SOLO_MODE={SOLO_MODE}")

    await alpha_market.start()
    yield
    await alpha_market.stop()


alpha_market = BinanceAlphaMarketDataService()
initialize_monitoring()


app = FastAPI(title="Haven API", lifespan=lifespan)

# CORS: locked to the web app's origin(s) in production (comma-separated
# HAVEN_CORS_ORIGINS env), wide-open in solo/local dev.
_cors_env = os.environ.get("HAVEN_CORS_ORIGINS", "").strip()
_production = os.environ.get("HAVEN_ENV", "development").lower() == "production"
if _production and not _cors_env:
    raise RuntimeError("HAVEN_CORS_ORIGINS is required in production")
_cors_origins = [o.strip() for o in _cors_env.split(",") if o.strip()] or ["http://localhost:5173"]
app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins,
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def security_headers(request: Request, call_next):
    response = await call_next(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
    response.headers["Permissions-Policy"] = "camera=(), geolocation=(), microphone=()"
    response.headers["Cross-Origin-Opener-Policy"] = "same-origin-allow-popups"
    response.headers["Cross-Origin-Resource-Policy"] = "same-site"
    if _production:
        response.headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains"
    return response

# Clerk-owned subscription and entitlement endpoints.
from api.billing import router as billing_router  # noqa: E402
app.include_router(billing_router)
# Public landing-page market data (unauthenticated, rate-limited, real DB).
from api.public_market import router as public_router  # noqa: E402
app.include_router(public_router)
from api.owner import router as owner_router  # noqa: E402
app.include_router(owner_router)

class TokenResponse(BaseModel):
    id: str
    symbol: str
    name: str | None
    chain_id: str | None
    contract_address: str | None
    # On-chain data migration fields (DATA-ROADMAP M1) — optional so legacy
    # rows serialize unchanged.
    display_symbol: str | None = None
    decimals: int | None = None
    status: str | None = None
    liquidity_usd: float | None = None
    market_cap: float | None = None
    listed_at: int | None = None
    # Cached Binance Alpha DEX security summary. None until requested.
    security: dict | None = None

    model_config = ConfigDict(from_attributes=True)


def _token_to_response(tok) -> TokenResponse:
    sec = None
    if tok.security_json:
        try:
            sec = json.loads(tok.security_json)
            # Don't ship huge raw_subset to the browser if present — keep UI fields.
            if isinstance(sec, dict) and "raw_subset" in sec:
                sec = {k: v for k, v in sec.items() if k != "raw_keys"}
        except Exception:
            sec = None
    return TokenResponse(
        id=tok.id,
        symbol=tok.symbol,
        name=tok.name,
        chain_id=tok.chain_id,
        contract_address=tok.contract_address,
        display_symbol=tok.display_symbol,
        decimals=tok.decimals,
        status=tok.status,
        liquidity_usd=tok.liquidity_usd,
        market_cap=tok.market_cap,
        listed_at=tok.listed_at,
        security=sec,
    )

class SignalResponse(BaseModel):
    symbol: str
    name: str | None = None
    display_symbol: str | None = None
    timestamp: int
    price_change_24h: float
    volume_24h: float = 0.0
    market_cap: float = 0.0
    alpha_rank: int | None = None
    last_price: float | None = None  # live Binance Alpha price for screener

    model_config = ConfigDict(from_attributes=True)


# ── Marker / Trade schemas ─────────────────────────────────────────────────

class MarkerCreate(BaseModel):
    symbol: str
    price: float
    marker_type: str
    label: str = ""
    direction: str = "below"
    strategy_id: str | None = None
    metadata_json: str | None = None


class MarkerResponse(BaseModel):
    id: str
    symbol: str
    price: float
    marker_type: str
    label: str
    active: int
    direction: str | None
    strategy_id: str | None
    user_placed: int
    created_at: int
    triggered_at: int | None
    metadata_json: str | None

    model_config = ConfigDict(from_attributes=True)


class MarkerUpdate(BaseModel):
    price: float | None = None
    label: str | None = None
    active: int | None = None
    direction: str | None = None


class TradeCreate(BaseModel):
    symbol: str
    direction: str
    marker_id: str | None = None
    expected_price: float
    execution_price: float
    amount_in: float
    amount_out: float
    fee_token: str = ""
    fee_amount: float = 0.0
    gas_used: int = 0
    gas_price_gwei: float = 0.0
    gas_cost_native: float = 0.0
    tx_hash: str
    block_time: int = 0
    status: str = "FILLED"
    strategy_id: str | None = None


class TradeResponse(BaseModel):
    id: str
    symbol: str
    direction: str
    marker_id: str | None
    expected_price: float
    execution_price: float
    amount_in: float
    amount_out: float
    fee_token: str
    fee_amount: float
    gas_used: int
    gas_price_gwei: float
    gas_cost_native: float
    tx_hash: str
    block_time: int
    status: str
    strategy_id: str | None

    model_config = ConfigDict(from_attributes=True)


# ── Marker endpoints ───────────────────────────────────────────────────────


@app.get("/markers/{symbol}", response_model=List[MarkerResponse])
def get_markers(symbol: str, active_only: bool = True, db: Session = Depends(get_db),
                identity: Identity = Depends(require_paid)):
    """Get all markers for a symbol (this user's markers only)."""
    q = (db.query(ChartMarker)
         .filter(ChartMarker.user_id == identity.user_id)
         .filter(ChartMarker.symbol == symbol))
    if active_only:
        q = q.filter(ChartMarker.active == 1)
    return q.order_by(ChartMarker.price).all()


VALID_MARKER_DIRECTIONS = ("above", "below", "cross")


@app.post("/markers", response_model=MarkerResponse)
def create_marker(m: MarkerCreate, db: Session = Depends(get_db),
                  identity: Identity = Depends(require_paid)):
    """Create a new marker owned by the caller."""
    import uuid
    from datetime import datetime, timezone
    # Reject unknown types/directions — the engine treats every non-ALERT type as
    # tradeable, so a typo'd type would otherwise become a live order.
    if m.marker_type not in MARKER_TYPES:
        raise HTTPException(status_code=422,
                            detail=f"Invalid marker_type '{m.marker_type}'. Allowed: {MARKER_TYPES}")
    if m.direction not in VALID_MARKER_DIRECTIONS:
        raise HTTPException(status_code=422,
                            detail=f"Invalid direction '{m.direction}'. Allowed: {VALID_MARKER_DIRECTIONS}")
    if not (m.price > 0):
        raise HTTPException(status_code=422, detail="Marker price must be positive")
    marker = ChartMarker(
        id=str(uuid.uuid4()),
        user_id=identity.user_id,
        symbol=m.symbol,
        price=m.price,
        marker_type=m.marker_type,
        label=m.label,
        direction=m.direction,
        strategy_id=m.strategy_id,
        metadata_json=m.metadata_json,
        created_at=int(datetime.now(timezone.utc).timestamp() * 1000),
        user_placed=1 if m.strategy_id is None else 0,
    )
    db.add(marker)
    db.commit()
    db.refresh(marker)
    return marker


@app.patch("/markers/{marker_id}", response_model=MarkerResponse)
def update_marker(marker_id: str, m: MarkerUpdate, db: Session = Depends(get_db),
                  identity: Identity = Depends(require_paid)):
    """Update a marker's price, label, or active status (owner only)."""
    marker = (db.query(ChartMarker)
              .filter(ChartMarker.id == marker_id, ChartMarker.user_id == identity.user_id)
              .first())
    if not marker:
        from fastapi import HTTPException
        raise HTTPException(status_code=404, detail="Marker not found")
    if m.price is not None:
        marker.price = m.price
    if m.label is not None:
        marker.label = m.label
    if m.active is not None:
        marker.active = m.active
    if m.direction is not None:
        marker.direction = m.direction
    db.commit()
    db.refresh(marker)
    return marker


@app.post("/markers/{marker_id}/claim")
def claim_marker(marker_id: str, db: Session = Depends(get_db),
                 identity: Identity = Depends(require_paid)):
    """Atomically claim a marker for execution.

    Sets active 1 -> 0 in a single conditional UPDATE and reports whether THIS caller
    won the claim. The database serializes the write, so only one racing caller (across
    duplicate poll loops, browser tabs, or processes) can get claimed=True, so a marker
    executes exactly once. Callers that lose the race must not execute.

    The user_id filter is defense-in-depth: an engine's key scopes it to one user,
    so it can only ever claim that user's markers — it does not change the
    exactly-once semantics (the atomic active==1 predicate still does that).
    """
    if identity.kind not in ("engine", "solo"):
        raise HTTPException(status_code=403, detail="Only the local engine may claim trades")
    require_identity_scope(identity, "engine:trade")
    from datetime import datetime, timezone
    now_ms = int(datetime.now(timezone.utc).timestamp() * 1000)
    updated = (
        db.query(ChartMarker)
        .filter(ChartMarker.id == marker_id,
                ChartMarker.user_id == identity.user_id,
                ChartMarker.active == 1)
        .update({ChartMarker.active: 0, ChartMarker.triggered_at: now_ms})
    )
    db.commit()
    return {"claimed": updated == 1}


@app.delete("/markers/{marker_id}")
def delete_marker(marker_id: str, db: Session = Depends(get_db),
                  identity: Identity = Depends(require_paid)):
    """Delete a marker (owner only)."""
    marker = (db.query(ChartMarker)
              .filter(ChartMarker.id == marker_id, ChartMarker.user_id == identity.user_id)
              .first())
    if not marker:
        from fastapi import HTTPException
        raise HTTPException(status_code=404, detail="Marker not found")
    db.delete(marker)
    db.commit()
    return {"ok": True}


# ── Trade endpoints ────────────────────────────────────────────────────────


@app.get("/trades", response_model=List[TradeResponse])
def get_trades(symbol: str | None = None, limit: int = 50, status: str | None = None,
               strategy_id: str | None = None, db: Session = Depends(get_db),
               identity: Identity = Depends(require_paid)):
    """Get this user's trade history, optionally filtered by symbol/status/strategy."""
    q = db.query(TradeHistory).filter(TradeHistory.user_id == identity.user_id)
    if symbol:
        q = q.filter(TradeHistory.symbol == symbol)
    if status:
        q = q.filter(TradeHistory.status == status)
    if strategy_id:
        q = q.filter(TradeHistory.strategy_id == strategy_id)
    return q.order_by(TradeHistory.block_time.desc()).limit(limit).all()


@app.post("/trades", response_model=TradeResponse)
def create_trade(t: TradeCreate, db: Session = Depends(get_db),
                 identity: Identity = Depends(require_paid)):
    """Idempotently record submission/finalization from the local engine."""
    import uuid
    import math
    if identity.kind not in ("engine", "solo"):
        raise HTTPException(status_code=403, detail="Only the local engine may report trades")
    require_identity_scope(identity, "engine:report")
    if t.direction not in ("BUY", "SELL") or t.status not in ("PENDING", "FILLED", "FAILED", "PAPER"):
        raise HTTPException(status_code=422, detail="Invalid trade direction or status")
    numeric = (t.expected_price, t.execution_price, t.amount_in, t.amount_out,
               t.fee_amount, t.gas_price_gwei, t.gas_cost_native)
    if any(not math.isfinite(float(v)) or float(v) < 0 for v in numeric):
        raise HTTPException(status_code=422, detail="Trade numeric values must be finite and non-negative")
    is_paper = t.status == "PAPER"
    if is_paper:
        if not t.tx_hash.startswith("paper-"):
            raise HTTPException(status_code=422, detail="Paper trade id must use the paper- prefix")
    elif not (t.tx_hash.startswith("0x") and len(t.tx_hash) == 66
              and all(c in "0123456789abcdefABCDEF" for c in t.tx_hash[2:])):
        raise HTTPException(status_code=422, detail="Invalid blockchain transaction hash")
    owner = identity.user_id
    existing = db.query(TradeHistory).filter(
        TradeHistory.user_id == owner, TradeHistory.tx_hash == t.tx_hash).first()
    if existing:
        if (existing.symbol, existing.direction, existing.marker_id) != (t.symbol, t.direction, t.marker_id):
            raise HTTPException(status_code=409, detail="Transaction identity does not match its submission")
        for field in ("execution_price", "amount_in", "amount_out", "fee_token", "fee_amount",
                      "gas_used", "gas_price_gwei", "gas_cost_native", "block_time", "status",
                      "strategy_id"):
            setattr(existing, field, getattr(t, field))
        existing.confirmed_at = int(time.time() * 1000) if t.status in ("FILLED", "FAILED") else None
        existing.reconciliation_state = "confirmed" if t.status == "FILLED" else t.status.lower()
        db.commit()
        db.refresh(existing)
        return existing
    trade = TradeHistory(
        id=str(uuid.uuid4()),
        user_id=owner,
        symbol=t.symbol,
        direction=t.direction,
        marker_id=t.marker_id,
        expected_price=t.expected_price,
        execution_price=t.execution_price,
        amount_in=t.amount_in,
        amount_out=t.amount_out,
        fee_token=t.fee_token,
        fee_amount=t.fee_amount,
        gas_used=t.gas_used,
        gas_price_gwei=t.gas_price_gwei,
        gas_cost_native=t.gas_cost_native,
        tx_hash=t.tx_hash,
        block_time=t.block_time,
        status=t.status,
        strategy_id=t.strategy_id,
        submitted_at=int(time.time() * 1000),
        confirmed_at=int(time.time() * 1000) if t.status in ("FILLED", "FAILED") else None,
        reconciliation_state="confirmed" if t.status == "FILLED" else t.status.lower(),
    )
    db.add(trade)
    db.commit()
    db.refresh(trade)
    return trade


# ── Strategy schemas + endpoints ───────────────────────────────────────────

VALID_STRATEGY_INTERVALS = ("1m", "5m", "15m", "30m", "1h", "4h", "1d")


class StrategyCreate(BaseModel):
    name: str
    code: str
    symbol: str = ""                 # '' allowed only with finder_id (dynamic selection)
    interval: str = "5m"
    params_json: str | None = None
    finder_id: str | None = None     # Token Finder dynamic selection
    max_positions: int = 1
    switch_margin_pct: float = 10.0


class StrategyUpdate(BaseModel):
    name: str | None = None
    code: str | None = None
    symbol: str | None = None
    interval: str | None = None
    params_json: str | None = None
    mode: str | None = None
    finder_id: str | None = None
    clear_finder: bool = False       # explicit flag — None can't mean "unset" in PATCH
    max_positions: int | None = None
    switch_margin_pct: float | None = None
    last_run_at: int | None = None
    last_error: str | None = None
    clear_error: bool = False   # explicit flag — None can't mean "clear" in PATCH


class StrategyListItem(BaseModel):
    id: str
    user_id: str
    name: str
    symbol: str
    interval: str
    mode: str
    finder_id: str | None = None
    max_positions: int = 1
    switch_margin_pct: float = 10.0
    created_at: int
    updated_at: int
    last_run_at: int | None
    last_error: str | None
    code_version: int = 1
    live_approved_version: int | None = None

    model_config = ConfigDict(from_attributes=True)


class StrategyResponse(StrategyListItem):
    code: str
    params_json: str | None


def _validate_strategy_fields(interval: str | None, mode: str | None):
    if interval is not None and interval not in VALID_STRATEGY_INTERVALS:
        raise HTTPException(status_code=422,
                            detail=f"Invalid interval '{interval}'. Allowed: {VALID_STRATEGY_INTERVALS}")
    if mode is not None and mode not in STRATEGY_MODES:
        raise HTTPException(status_code=422,
                            detail=f"Invalid mode '{mode}'. Allowed: {STRATEGY_MODES}")


def _validate_token_selection(db: Session, user_id: str, symbol: str, finder_id: str | None,
                              max_positions: int | None, switch_margin_pct: float | None):
    """A strategy needs exactly one token source: a symbol, or a finder.

    A finder can only be attached if it belongs to the same user (no
    referencing another account's finder).
    """
    if finder_id:
        if not (db.query(Finder)
                .filter(Finder.id == finder_id, Finder.user_id == user_id).first()):
            raise HTTPException(status_code=422, detail=f"Finder '{finder_id}' does not exist")
    elif not symbol:
        raise HTTPException(status_code=422,
                            detail="Strategy needs a symbol, or a finder_id for dynamic selection")
    if max_positions is not None and not (1 <= max_positions <= 10):
        raise HTTPException(status_code=422, detail="max_positions must be between 1 and 10")
    if switch_margin_pct is not None and not (0 <= switch_margin_pct <= 100):
        raise HTTPException(status_code=422, detail="switch_margin_pct must be between 0 and 100")


@app.get("/strategies", response_model=List[StrategyListItem])
def list_strategies(db: Session = Depends(get_db),
                    identity: Identity = Depends(require_paid)):
    """List the caller's strategies; paper and live both run locally."""
    q = db.query(Strategy).filter(Strategy.user_id == identity.user_id)
    return q.order_by(Strategy.created_at).all()


@app.get("/strategies/{strategy_id}", response_model=StrategyResponse)
def get_strategy(strategy_id: str, db: Session = Depends(get_db),
                 identity: Identity = Depends(require_paid)):
    q = db.query(Strategy).filter(
        Strategy.id == strategy_id, Strategy.user_id == identity.user_id)
    strat = q.first()
    if not strat:
        raise HTTPException(status_code=404, detail="Strategy not found")
    return strat


@app.post("/strategies", response_model=StrategyResponse)
def create_strategy(s: StrategyCreate, db: Session = Depends(get_db),
                    identity: Identity = Depends(require_paid)):
    import uuid
    if identity.kind not in ("user", "solo"):
        raise HTTPException(status_code=403, detail="Engine credentials cannot create strategies")
    _validate_strategy_fields(s.interval, None)
    _validate_token_selection(db, identity.user_id, s.symbol, s.finder_id,
                              s.max_positions, s.switch_margin_pct)
    # Library cap: saved strategies per user, so one
    # account can't grow the DB without bound. 409 detail is shown to the user
    # as-is by the workbench's save message.
    ent = entitlements(db, identity)
    if ent["max_strategies"] is not None:
        saved = (db.query(Strategy)
                 .filter(Strategy.user_id == identity.user_id).count())
        if saved >= ent["max_strategies"]:
            raise HTTPException(
                status_code=409,
                detail=(f"Strategy library full: {saved} of {ent['max_strategies']} saved. "
                        "Delete one you no longer use or choose a larger plan."))
    now_ms = int(time.time() * 1000)
    strat = Strategy(
        id=str(uuid.uuid4()), user_id=identity.user_id, name=s.name, code=s.code,
        symbol=s.symbol if not s.finder_id else (s.symbol or ""),
        interval=s.interval, params_json=s.params_json, mode="off",
        finder_id=s.finder_id, max_positions=s.max_positions,
        switch_margin_pct=s.switch_margin_pct,
        created_at=now_ms, updated_at=now_ms, code_version=1,
    )
    db.add(strat)
    db.add(StrategyVersion(
        id=str(uuid.uuid4()), strategy_id=strat.id, user_id=identity.user_id,
        version=1, code=s.code, code_hash=hashlib.sha256(s.code.encode()).hexdigest(),
        approved_for_live=0, created_at=now_ms,
    ))
    db.commit()
    db.refresh(strat)
    return strat


@app.patch("/strategies/{strategy_id}", response_model=StrategyResponse)
def update_strategy(strategy_id: str, s: StrategyUpdate, db: Session = Depends(get_db),
                    identity: Identity = Depends(require_paid)):
    """Update a strategy (owner only).

    updated_at bumps ONLY when the strategy definition changes (code / params /
    symbol / interval) — the runner uses it as its hot-reload signal, and a
    mode flip or status write must not reset a running strategy's state.

    A scoped local-engine credential may report run status, but cannot edit the
    definition or change its mode.
    """
    q = db.query(Strategy).filter(
        Strategy.id == strategy_id, Strategy.user_id == identity.user_id)
    strat = q.first()
    if not strat:
        raise HTTPException(status_code=404, detail="Strategy not found")
    if identity.kind == "engine":
        supplied = {k for k, v in s.model_dump().items()
                    if v not in (None, False) and k not in ("last_run_at", "last_error", "clear_error")}
        if supplied:
            raise HTTPException(status_code=403, detail="Engine credentials may only report strategy status")
        require_identity_scope(identity, "engine:report")
    _validate_strategy_fields(s.interval, s.mode)
    # Validate the token selection the row will END UP with after this patch.
    next_symbol = s.symbol if s.symbol is not None else strat.symbol
    next_finder = None if s.clear_finder else (s.finder_id if s.finder_id is not None else strat.finder_id)
    _validate_token_selection(db, strat.user_id, next_symbol, next_finder,
                              s.max_positions, s.switch_margin_pct)

    # Bot entitlements: arming a strategy (mode off → dry/live) consumes a bot
    # slot. Both the automatic trial and paid plans permit LIVE. The
    # Engine credentials only PATCH status fields, never mode. Capacity errors
    # carry human-readable details that the UI shows directly.
    if s.mode in ("dry", "live"):
        ent = entitlements(db, identity)
        if s.mode == "live" and not ent["live_allowed"]:
            raise HTTPException(
                status_code=403,
                detail="Your current plan does not permit live trading.")
        if s.mode == "live" and s.code is not None and s.code != strat.code:
            raise HTTPException(
                status_code=409,
                detail="Save the new code, review it, and approve that version before enabling live trading.")
        if s.mode == "live" and strat.live_approved_version != strat.code_version:
            raise HTTPException(
                status_code=409,
                detail="Approve the current strategy code version before enabling live trading.")
        # Live trading is BSC-only (DATA-ROADMAP AD-D8). Paper (DRY) bots may
        # run on any chain's data. Finder-bound strategies (symbol='') are
        # policed at slot-bind time by the runner's tradeable filter instead.
        if s.mode == "live" and next_symbol:
            tok = db.query(Token).filter(Token.symbol == next_symbol).first()
            tok_chain = str(tok.chain_id or "") if tok else ""
            tok_chain = LEGACY_CHAIN_ID_MAP.get(tok_chain, tok_chain)
            if tok and tok_chain and tok_chain != "bsc":
                raise HTTPException(
                    status_code=422,
                    detail=(f"Live trading is BSC-only for now — '{next_symbol}' is on "
                            f"{tok_chain}. Run it as a paper (DRY) bot instead."))
        if ent["max_bots"] is not None and strat.mode == "off":
            running = (db.query(Strategy)
                       .filter(Strategy.user_id == strat.user_id,
                               Strategy.mode != "off",
                               Strategy.id != strategy_id).count())
            if running >= ent["max_bots"]:
                raise HTTPException(
                    status_code=409,
                    detail=(f"Bot limit reached: {running} of {ent['max_bots']} bots already running. "
                            "Stop one first (set it to OFF), or add bot slots to your plan."))

    definition_changed = False
    code_changed = s.code is not None and s.code != strat.code
    for field in ("code", "symbol", "interval", "params_json", "finder_id",
                  "max_positions", "switch_margin_pct"):
        val = getattr(s, field)
        if val is not None and val != getattr(strat, field):
            setattr(strat, field, val)
            definition_changed = True
    if s.clear_finder and strat.finder_id is not None:
        strat.finder_id = None
        definition_changed = True
    if s.name is not None:
        strat.name = s.name
    if s.mode is not None:
        # Arming LIVE archives the current dry run (owner decision 2026-07-06):
        # PAPER rows flip to PAPER_ARCH so live stats start clean while the dry
        # record stays viewable on the performance page. PAPER_ARCH is excluded
        # from /dashboard/overview like PAPER, and the runner's dry position
        # rebuild (status=PAPER) never sees it — no phantom positions if the
        # strategy later returns to DRY.
        if s.mode == "live" and strat.mode != "live":
            (db.query(TradeHistory)
             .filter(TradeHistory.user_id == strat.user_id,
                     TradeHistory.strategy_id == strategy_id,
                     TradeHistory.status == "PAPER")
             .update({"status": "PAPER_ARCH"}, synchronize_session=False))
        strat.mode = s.mode
    if s.last_run_at is not None:
        strat.last_run_at = s.last_run_at
    if s.last_error is not None:
        strat.last_error = s.last_error
    if s.clear_error:
        strat.last_error = None
    if definition_changed:
        strat.updated_at = int(time.time() * 1000)
    if code_changed:
        import uuid
        strat.code_version = int(strat.code_version or 1) + 1
        strat.live_approved_version = None
        strat.mode = "off"
        db.add(StrategyVersion(
            id=str(uuid.uuid4()), strategy_id=strat.id, user_id=strat.user_id,
            version=strat.code_version, code=strat.code,
            code_hash=hashlib.sha256(strat.code.encode()).hexdigest(),
            approved_for_live=0, created_at=int(time.time() * 1000),
        ))
    db.commit()
    db.refresh(strat)
    return strat


class LiveApproval(BaseModel):
    version: int
    code_hash: str


@app.post("/strategies/{strategy_id}/approve-live", response_model=StrategyResponse)
def approve_strategy_for_live(strategy_id: str, approval: LiveApproval,
                              db: Session = Depends(get_db),
                              identity: Identity = Depends(require_paid)):
    """Approve one immutable code version; edits invalidate the approval."""
    if identity.kind not in ("user", "solo"):
        raise HTTPException(status_code=403, detail="Live approval requires the signed-in user")
    strat = db.query(Strategy).filter(
        Strategy.id == strategy_id, Strategy.user_id == identity.user_id).first()
    if not strat:
        raise HTTPException(status_code=404, detail="Strategy not found")
    version = db.query(StrategyVersion).filter(
        StrategyVersion.strategy_id == strategy_id,
        StrategyVersion.version == approval.version,
        StrategyVersion.user_id == identity.user_id,
    ).first()
    if (not version or approval.version != strat.code_version
            or not hashlib.sha256(strat.code.encode()).hexdigest() == approval.code_hash
            or version.code_hash != approval.code_hash):
        raise HTTPException(status_code=409, detail="Strategy version or code hash changed; review again")
    at = int(time.time() * 1000)
    version.approved_for_live = 1
    version.approved_at = at
    strat.live_approved_version = strat.code_version
    db.commit()
    db.refresh(strat)
    return strat


@app.post("/strategies/{strategy_id}/reset_dry")
def reset_dry_run(strategy_id: str, db: Session = Depends(get_db),
                  identity: Identity = Depends(require_paid)):
    """Clear the strategy's CURRENT dry run: delete its PAPER trade rows.

    Archived dry runs (PAPER_ARCH, created when the bot went live) are kept —
    they are the historical record the performance page's archive view shows.
    The runner rebuilds its dry position from PAPER rows before each bar, so
    after a reset a running DRY bot simply starts flat with fresh stats."""
    strat = (db.query(Strategy)
             .filter(Strategy.id == strategy_id, Strategy.user_id == identity.user_id)
             .first())
    if not strat:
        raise HTTPException(status_code=404, detail="Strategy not found")
    deleted = (db.query(TradeHistory)
               .filter(TradeHistory.user_id == identity.user_id,
                       TradeHistory.strategy_id == strategy_id,
                       TradeHistory.status == "PAPER")
               .delete(synchronize_session=False))
    db.commit()
    return {"ok": True, "deleted_paper_trades": deleted}


@app.delete("/strategies/{strategy_id}")
def delete_strategy(strategy_id: str, db: Session = Depends(get_db),
                    identity: Identity = Depends(require_paid)):
    """Delete a strategy completely: the row, any still-active markers it
    posted (a queued STRAT_BUY/STRAT_SELL must not fire for a strategy that no
    longer exists), and its simulated/failed trade rows (PAPER, PAPER_ARCH,
    FAILED). FILLED rows are deliberately KEPT: they are real on-chain history
    — the wallet's avg-cost PnL walk and the dashboard trade log would corrupt
    if money that actually moved disappeared from the books."""
    if identity.kind not in ("user", "solo"):
        raise HTTPException(status_code=403, detail="Engine credentials cannot delete strategies")
    strat = (db.query(Strategy)
             .filter(Strategy.id == strategy_id, Strategy.user_id == identity.user_id)
             .first())
    if not strat:
        raise HTTPException(status_code=404, detail="Strategy not found")
    orphaned = (db.query(ChartMarker)
                .filter(ChartMarker.strategy_id == strategy_id,
                        ChartMarker.user_id == identity.user_id,
                        ChartMarker.active == 1)
                .delete())
    deleted_trades = (db.query(TradeHistory)
                      .filter(TradeHistory.user_id == identity.user_id,
                              TradeHistory.strategy_id == strategy_id,
                              TradeHistory.status.in_(("PAPER", "PAPER_ARCH", "FAILED")))
                      .delete(synchronize_session=False))
    db.delete(strat)
    db.commit()
    return {"ok": True, "deleted_active_markers": orphaned,
            "deleted_trade_rows": deleted_trades}


@app.get("/strategies/{strategy_id}/performance")
def strategy_performance(strategy_id: str, limit: int = 1000, archived: int = 0,
                         db: Session = Depends(get_db),
                         identity: Identity = Depends(require_paid)):
    """Everything the per-strategy performance page needs, in one call.

    Returns the strategy row plus its trade history split by kind — `paper`
    (PAPER dry-run fills), `live` (FILLED on-chain fills), `failed` (aborted
    executions, last 100) — each ASCENDING by block_time (the newest `limit`
    rows), enriched with the triggering marker's type/label as reason (TP/SL
    legs identify themselves this way). Also: this strategy's still-active
    markers (queued signals + open bracket legs), current prices for every
    symbol involved, and the attached finder's name. Stats/equity are computed
    client-side from these rows so the math lives in one place (the UI's
    strategyPerf util).

    `paper_archived_count` is always included (dry runs archived when the bot
    went live); pass ?archived=1 to also get those rows as `paper_archived` —
    the page only fetches them when the user opens the archive view.
    """
    q = db.query(Strategy).filter(Strategy.id == strategy_id)
    q = q.filter(Strategy.user_id == identity.user_id)
    strat = q.first()
    if not strat:
        raise HTTPException(status_code=404, detail="Strategy not found")
    limit = max(1, min(limit, 5000))
    owner = strat.user_id

    def fetch_trades(status: str, n: int):
        rows = (db.query(TradeHistory)
                .filter(TradeHistory.user_id == owner,
                        TradeHistory.strategy_id == strategy_id,
                        TradeHistory.status == status)
                .order_by(TradeHistory.block_time.desc()).limit(n).all())
        rows.reverse()          # ascending — stats walk oldest → newest
        return rows

    paper = fetch_trades("PAPER", limit)
    live = fetch_trades("FILLED", limit)
    failed = fetch_trades("FAILED", 100)
    paper_archived_count = (db.query(TradeHistory)
                            .filter(TradeHistory.user_id == owner,
                                    TradeHistory.strategy_id == strategy_id,
                                    TradeHistory.status == "PAPER_ARCH").count())
    paper_archived = fetch_trades("PAPER_ARCH", limit) if archived else []

    marker_ids = {t.marker_id for t in [*live, *failed] if t.marker_id}
    markers_map = {}
    if marker_ids:
        for m in (db.query(ChartMarker)
                  .filter(ChartMarker.user_id == owner,
                          ChartMarker.id.in_(marker_ids)).all()):
            markers_map[m.id] = m

    def trade_dict(t):
        m = markers_map.get(t.marker_id)
        return {
            "id": t.id, "symbol": t.symbol, "direction": t.direction,
            "marker_id": t.marker_id, "expected_price": t.expected_price,
            "execution_price": t.execution_price, "amount_in": t.amount_in,
            "amount_out": t.amount_out, "fee_token": t.fee_token,
            "fee_amount": t.fee_amount, "gas_used": t.gas_used,
            "gas_price_gwei": t.gas_price_gwei, "gas_cost_native": t.gas_cost_native,
            "tx_hash": t.tx_hash, "block_time": t.block_time, "status": t.status,
            "strategy_id": t.strategy_id,
            "reason": m.marker_type if m else None,
            "reason_label": (m.label or None) if m else None,
        }

    open_markers = (db.query(ChartMarker)
                    .filter(ChartMarker.user_id == owner,
                            ChartMarker.strategy_id == strategy_id,
                            ChartMarker.active == 1)
                    .order_by(ChartMarker.created_at.desc()).limit(100).all())

    symbols = {t.symbol for t in [*paper, *live, *failed, *paper_archived]}
    symbols.update(m.symbol for m in open_markers)
    if strat.symbol:
        symbols.add(strat.symbol)
    token_prices = {}
    if symbols:
        for tk in db.query(LatestTicker).filter(LatestTicker.symbol.in_(symbols)).all():
            if tk.last_price and tk.last_price > 0:
                token_prices[tk.symbol] = tk.last_price

    finder_name = None
    if strat.finder_id:
        f = db.query(Finder).filter(Finder.id == strat.finder_id).first()
        finder_name = f.name if f else None

    return {
        "strategy": StrategyListItem.model_validate(strat).model_dump(),
        "paper": [trade_dict(t) for t in paper],
        "live": [trade_dict(t) for t in live],
        "failed": [trade_dict(t) for t in failed],
        "paper_archived_count": paper_archived_count,
        "paper_archived": [trade_dict(t) for t in paper_archived],
        "open_markers": [MarkerResponse.model_validate(m).model_dump() for m in open_markers],
        "token_prices": token_prices,
        "finder_name": finder_name,
    }


# ── Finder schemas + endpoints (Token Finder module) ───────────────────────
# Finders are passive ranking functions — no mode; strategies subscribe via
# strategies.finder_id. Same updated_at contract as strategies: bumped ONLY on
# definition changes (code/params/interval); it is the evaluator's hot-reload key.


class FinderCreate(BaseModel):
    name: str
    code: str
    interval: str = "15m"
    params_json: str | None = None


class FinderUpdate(BaseModel):
    name: str | None = None
    code: str | None = None
    interval: str | None = None
    params_json: str | None = None
    last_run_at: int | None = None
    last_error: str | None = None
    clear_error: bool = False


class FinderListItem(BaseModel):
    id: str
    name: str
    interval: str
    created_at: int
    updated_at: int
    last_run_at: int | None
    last_error: str | None

    model_config = ConfigDict(from_attributes=True)


class FinderResponse(FinderListItem):
    code: str
    params_json: str | None


def _validate_finder_interval(interval: str | None):
    if interval is not None and interval not in FINDER_INTERVALS:
        raise HTTPException(status_code=422,
                            detail=f"Invalid finder interval '{interval}'. Allowed: {FINDER_INTERVALS}")


@app.get("/finders", response_model=List[FinderListItem])
def list_finders(db: Session = Depends(get_db),
                 identity: Identity = Depends(require_paid)):
    """List this user's finders."""
    q = db.query(Finder).filter(Finder.user_id == identity.user_id)
    return q.order_by(Finder.created_at).all()


@app.get("/finders/{finder_id}", response_model=FinderResponse)
def get_finder(finder_id: str, db: Session = Depends(get_db),
               identity: Identity = Depends(require_paid)):
    q = db.query(Finder).filter(Finder.id == finder_id, Finder.user_id == identity.user_id)
    f = q.first()
    if not f:
        raise HTTPException(status_code=404, detail="Finder not found")
    return f


@app.post("/finders", response_model=FinderResponse)
def create_finder(f: FinderCreate, db: Session = Depends(get_db),
                  identity: Identity = Depends(require_paid)):
    import uuid
    if identity.kind not in ("user", "solo"):
        raise HTTPException(status_code=403, detail="Engine credentials cannot create finders")
    _validate_finder_interval(f.interval)
    ent = entitlements(db, identity)
    saved = db.query(Finder).filter(Finder.user_id == identity.user_id).count()
    if ent.get("max_finders") is not None and saved >= ent["max_finders"]:
        raise HTTPException(
            status_code=409,
            detail=f"Finder limit reached: {saved} of {ent['max_finders']} saved.")
    now_ms = int(time.time() * 1000)
    finder = Finder(
        id=str(uuid.uuid4()), user_id=identity.user_id, name=f.name, code=f.code,
        interval=f.interval, params_json=f.params_json,
        created_at=now_ms, updated_at=now_ms,
    )
    db.add(finder)
    db.commit()
    db.refresh(finder)
    return finder


@app.patch("/finders/{finder_id}", response_model=FinderResponse)
def update_finder(finder_id: str, f: FinderUpdate, db: Session = Depends(get_db),
                  identity: Identity = Depends(require_paid)):
    """updated_at bumps ONLY on definition changes (code/params/interval) —
    status writes (last_run_at/last_error) must not reset live evaluators.

    A scoped local-engine FinderHub may report status for its user's finder.
    """
    q = db.query(Finder).filter(Finder.id == finder_id, Finder.user_id == identity.user_id)
    finder = q.first()
    if not finder:
        raise HTTPException(status_code=404, detail="Finder not found")
    if identity.kind == "engine":
        supplied = {k for k, v in f.model_dump().items()
                    if v not in (None, False) and k not in ("last_run_at", "last_error", "clear_error")}
        if supplied:
            raise HTTPException(status_code=403, detail="Engine credentials may only report finder status")
        require_identity_scope(identity, "engine:report")
    _validate_finder_interval(f.interval)

    definition_changed = False
    for field in ("code", "interval", "params_json"):
        val = getattr(f, field)
        if val is not None and val != getattr(finder, field):
            setattr(finder, field, val)
            definition_changed = True
    if f.name is not None:
        finder.name = f.name
    if f.last_run_at is not None:
        finder.last_run_at = f.last_run_at
    if f.last_error is not None:
        finder.last_error = f.last_error
    if f.clear_error:
        finder.last_error = None
    if definition_changed:
        finder.updated_at = int(time.time() * 1000)
    db.commit()
    db.refresh(finder)
    return finder


@app.delete("/finders/{finder_id}")
def delete_finder(finder_id: str, db: Session = Depends(get_db),
                  identity: Identity = Depends(require_paid)):
    """Delete a finder — refused while any strategy still references it, so a
    running portfolio strategy can never lose its token source mid-flight."""
    if identity.kind not in ("user", "solo"):
        raise HTTPException(status_code=403, detail="Engine credentials cannot delete finders")
    finder = (db.query(Finder)
              .filter(Finder.id == finder_id, Finder.user_id == identity.user_id)
              .first())
    if not finder:
        raise HTTPException(status_code=404, detail="Finder not found")
    users = (db.query(Strategy)
             .filter(Strategy.finder_id == finder_id,
                     Strategy.user_id == identity.user_id).all())
    if users:
        names = ", ".join(s.name for s in users[:5])
        raise HTTPException(status_code=409,
                            detail=f"Finder is used by {len(users)} strateg{'y' if len(users) == 1 else 'ies'} ({names}). Detach them first.")
    db.delete(finder)
    db.commit()
    return {"ok": True}


# ── Universe endpoint (bulk multi-token ranking dataset) ────────────────────

UNIVERSE_INTERVALS = {"5m": 300_000, "15m": 900_000, "30m": 1_800_000, "1h": 3_600_000}
UNIVERSE_MAX_BARS = 2200      # ~7.6 days of 5m; keeps payloads browser-friendly
UNIVERSE_MAX_TOKENS = 400


@app.get("/universe")
async def get_universe(interval: str = "15m", start_ms: int | None = None,
                 end_ms: int | None = None, min_vol_24h: float = 50_000,
                 symbols: str | None = None, chains: str | None = None,
                 db: Session = Depends(get_db),
                 identity: Identity = Depends(require_paid)):
    if interval not in UNIVERSE_INTERVALS:
        raise HTTPException(status_code=422,
                            detail=f"Invalid interval '{interval}'. Allowed: {tuple(UNIVERSE_INTERVALS)}")
    interval_ms = UNIVERSE_INTERVALS[interval]
    now = int(time.time() * 1000)
    end_ms = min(int(end_ms or now), now)
    end_ms -= end_ms % interval_ms
    start_ms = int(start_ms or end_ms - 3 * 86_400_000)
    start_ms -= start_ms % interval_ms
    if start_ms >= end_ms:
        raise HTTPException(status_code=422, detail="start_ms must be before end_ms")
    if (end_ms - start_ms) // interval_ms > UNIVERSE_MAX_BARS:
        start_ms = end_ms - UNIVERSE_MAX_BARS * interval_ms

    query = (db.query(Token, LatestTicker, AlphaAsset)
             .join(LatestTicker, LatestTicker.symbol == Token.symbol)
             .join(AlphaAsset, AlphaAsset.alpha_id == Token.alpha_id)
             .filter((Token.status == "active") | Token.status.is_(None))
             .filter(LatestTicker.volume_24h >= min_vol_24h))
    if symbols:
        requested = [item.strip() for item in symbols.split(",") if item.strip()]
        query = query.filter(Token.symbol.in_(requested))
    if chains:
        allowed = [item.strip() for item in chains.split(",") if item.strip()]
        query = query.filter(Token.chain_id.in_(allowed))
    maximum = min(UNIVERSE_MAX_TOKENS,
                  max(1, int(os.environ.get("BINANCE_ALPHA_FINDER_ASSET_LIMIT", "50"))))
    selected = query.order_by(LatestTicker.volume_24h.desc()).limit(maximum).all()
    specs = [{
        "symbol": token.symbol, "name": token.name, "chain": token.chain_id,
        "alpha_id": token.alpha_id, "volume": ticker.volume_24h or 0,
        "change": ticker.price_change_24h or 0,
    } for token, ticker, asset in selected if token.alpha_id]
    semaphore = asyncio.Semaphore(max(1, int(os.environ.get("BINANCE_ALPHA_REST_CONCURRENCY", "4"))))

    async def load(spec):
        async with semaphore:
            try:
                candles = await alpha_market.candles(alpha_id=spec["alpha_id"], interval=interval,
                                                     limit=UNIVERSE_MAX_BARS)
            except AlphaError:
                return spec, []
        return spec, candles

    loaded = await asyncio.gather(*(load(spec) for spec in specs))
    times = list(range(start_ms, end_ms, interval_ms))
    index = {opened: idx for idx, opened in enumerate(times)}
    tokens_out = []
    for spec, candles in loaded:
        o = [None] * len(times); h = [None] * len(times)
        low = [None] * len(times); c = [None] * len(times)
        volume = [None] * len(times)
        for candle in candles:
            idx = index.get(candle.open_time)
            if idx is None or not candle.closed:
                continue
            o[idx], h[idx], low[idx], c[idx] = (
                candle.open_price, candle.high_price, candle.low_price, candle.close_price)
            volume[idx] = candle.volume or 0
        if not any(value is not None for value in c):
            continue
        tokens_out.append({
            "symbol": spec["symbol"], "name": spec["name"], "chain": spec["chain"],
            "volume24h": spec["volume"], "priceChange24h": spec["change"],
            "o": o, "h": h, "l": low, "c": c,
            "volume": volume,
        })
    return {"interval": interval, "times": times, "tokens": tokens_out,
            "source": "binance_alpha"}

# ── Debug log schemas ──────────────────────────────────────────────────────

class LogCreate(BaseModel):
    source: str       # engine | api | wallet
    level: str        # DEBUG | ERROR | TRADE | INFO | API_REQUEST | API_RESPONSE
    message: str
    metadata_json: str | None = None


class LogResponse(BaseModel):
    id: int
    source: str
    level: str
    message: str
    timestamp: int
    metadata_json: str | None

    model_config = ConfigDict(from_attributes=True)


# ── Dashboard overview schemas ─────────────────────────────────────────────

class TradeWithReason(BaseModel):
    """A trade enriched with the marker's type and label as the 'reason'."""
    id: str
    symbol: str
    direction: str
    marker_id: str | None
    expected_price: float
    execution_price: float
    amount_in: float
    amount_out: float
    fee_token: str
    fee_amount: float
    gas_used: int
    gas_price_gwei: float
    gas_cost_native: float
    tx_hash: str
    block_time: int
    status: str
    strategy_id: str | None
    # Enriched from marker
    reason: str | None = None       # marker_type: BUY_GRID, SELL_GRID, TP, SL, etc.
    reason_label: str | None = None  # user's label on the marker


class DashboardOverview(BaseModel):
    trades: List[TradeWithReason]
    open_markers: List[MarkerResponse]
    token_prices: dict  # symbol → last_price
    # symbol → last_updated (unix ms). Additive (old consumers ignore it);
    # the engine's stale-price guard reads it so a frozen Binance Alpha price can
    # never drive a marker execution (DATA-ROADMAP M3).
    price_updated: dict = {}


# ── Debug log endpoints ────────────────────────────────────────────────────


@app.get("/debug/logs", response_model=List[LogResponse])
def get_debug_logs(
    level: str | None = None,       # comma-separated: "ERROR,TRADE,INFO"
    source: str | None = None,       # comma-separated: "api,engine,wallet"
    limit: int = 200,
    since_ms: int | None = None,     # only return logs newer than this timestamp
    db: Session = Depends(get_db),
    identity: Identity = Depends(require_paid),
):
    """Get this user's logs plus shared API system logs."""
    q = db.query(DebugLog).filter(DebugLog.user_id.in_([identity.user_id, "system"]))
    if level:
        levels = [l.strip() for l in level.split(",") if l.strip()]
        if levels:
            q = q.filter(DebugLog.level.in_(levels))
    if source:
        sources = [s.strip() for s in source.split(",") if s.strip()]
        if sources:
            q = q.filter(DebugLog.source.in_(sources))
    if since_ms:
        q = q.filter(DebugLog.timestamp > since_ms)
    return q.order_by(DebugLog.timestamp.desc()).limit(limit).all()


@app.post("/debug/logs", response_model=LogResponse)
def create_debug_log(entry: LogCreate, db: Session = Depends(get_db),
                     identity: Identity = Depends(require_paid)):
    """Ingest a debug log entry owned by the local engine's user."""
    import time as _time
    owner = identity.user_id
    log_entry = DebugLog(
        user_id=owner,
        source=entry.source,
        level=entry.level,
        message=entry.message,
        timestamp=int(_time.time() * 1000),
        metadata_json=entry.metadata_json,
    )
    db.add(log_entry)
    db.commit()
    db.refresh(log_entry)
    return log_entry


@app.delete("/debug/logs")
def clear_debug_logs(db: Session = Depends(get_db),
                     identity: Identity = Depends(require_paid)):
    """Clear this user's debug logs (never touches other users or 'system')."""
    count = (db.query(DebugLog)
             .filter(DebugLog.user_id == identity.user_id).delete())
    db.commit()
    return {"deleted": count}


# ── Dashboard overview endpoint ────────────────────────────────────────────


@app.get("/dashboard/overview", response_model=DashboardOverview)
def get_dashboard_overview(db: Session = Depends(get_db),
                           identity: Identity = Depends(require_paid)):
    """Return all trading data needed by the dashboard in one call (this user).

    The engine daemon (its own user) calls this to see its markers + trades;
    the web app calls it for the same user. token_prices is shared market data.
    """
    # This user's REAL trades, newest first, joined with markers for reason.
    # PAPER rows (strategy dry-runs) and PAPER_ARCH (dry runs archived when a
    # bot went live) are excluded here on purpose: dashboard PnL sums every row
    # it receives, the engine's daily-cap counter reads this list, and a chatty
    # dry-run would otherwise flood the 200-row window.
    trades = (db.query(TradeHistory)
              .filter(TradeHistory.user_id == identity.user_id)
              .filter(TradeHistory.status.notin_(("PAPER", "PAPER_ARCH")))
              .order_by(TradeHistory.block_time.desc()).limit(200).all())
    all_marker_ids = [t.marker_id for t in trades if t.marker_id]
    markers_map = {}
    if all_marker_ids:
        marker_rows = (db.query(ChartMarker)
                       .filter(ChartMarker.user_id == identity.user_id)
                       .filter(ChartMarker.id.in_(all_marker_ids)).all())
        markers_map = {m.id: m for m in marker_rows}

    trade_responses = []
    for t in trades:
        reason = None
        reason_label = None
        if t.marker_id and t.marker_id in markers_map:
            m = markers_map[t.marker_id]
            reason = m.marker_type
            reason_label = m.label or None
        trade_responses.append(TradeWithReason(
            id=t.id, symbol=t.symbol, direction=t.direction,
            marker_id=t.marker_id, expected_price=t.expected_price,
            execution_price=t.execution_price, amount_in=t.amount_in,
            amount_out=t.amount_out, fee_token=t.fee_token,
            fee_amount=t.fee_amount, gas_used=t.gas_used,
            gas_price_gwei=t.gas_price_gwei, gas_cost_native=t.gas_cost_native,
            tx_hash=t.tx_hash, block_time=t.block_time, status=t.status,
            strategy_id=t.strategy_id, reason=reason, reason_label=reason_label,
        ))

    # Active markers (this user)
    open_markers = (db.query(ChartMarker)
                    .filter(ChartMarker.user_id == identity.user_id, ChartMarker.active == 1)
                    .order_by(ChartMarker.created_at.desc()).limit(100).all())

    # Latest prices per symbol (+ freshness for the engine's stale-price guard)
    tickers = db.query(LatestTicker).all()
    token_prices = {t.symbol: t.last_price for t in tickers if t.last_price and t.last_price > 0}
    price_updated = {t.symbol: t.last_updated for t in tickers
                     if t.last_price and t.last_price > 0 and t.last_updated}

    return DashboardOverview(
        trades=trade_responses,
        open_markers=[MarkerResponse.model_validate(m) for m in open_markers],
        token_prices=token_prices,
        price_updated=price_updated,
    )


# ── API request/response logging middleware ────────────────────────────────

# Endpoints polled every few seconds by the UIs/engine. Logging these to the DB
# generated millions of debug_logs rows (the main DB bloat) while adding no
# diagnostic value — the pollers themselves report failures.
NOISY_PATHS = {
    "/", "/health", "/heartbeat", "/signals", "/tokens",
    "/dashboard/overview", "/debug/logs", "/engine/settings", "/favicon.ico",
    "/public/movers", "/public/ticker", "/public/ticker-universe",
    "/public/ticker-defaults", "/billing/pricing",
}


@app.middleware("http")
async def debug_log_middleware(request: Request, call_next):
    """Log non-polling API requests/responses to the debug_logs table."""
    if (request.url.path in NOISY_PATHS
            or request.url.path.startswith("/klines")
            or request.url.path.startswith("/strategies")
            or request.url.path.startswith("/finders")      # UI + evaluator poll
            or request.url.path.startswith("/assistant")     # chat turns — no DB value, may be large
            or request.url.path.startswith("/universe")):   # large payload, refetched per timeframe
        return await call_next(request)

    import time as _time
    start_ms = int(_time.time() * 1000)

    # Log the request
    try:
        db = next(get_db())
        req_entry = DebugLog(
            source="api",
            level="API_REQUEST",
            message=f"{request.method} {request.url.path}",
            timestamp=start_ms,
            metadata_json=json.dumps({
                "method": request.method,
                "path": request.url.path,
                "query": str(request.query_params) if request.query_params else None,
            }),
        )
        db.add(req_entry)
        db.commit()
    except Exception:
        pass
    finally:
        try:
            db.close()
        except Exception:
            pass

    # Process the request
    response = await call_next(request)
    elapsed_ms = int(_time.time() * 1000) - start_ms

    # Log the response
    try:
        db2 = next(get_db())
        resp_entry = DebugLog(
            source="api",
            level="API_RESPONSE",
            message=f"{request.method} {request.url.path} → {response.status_code} ({elapsed_ms}ms)",
            timestamp=int(_time.time() * 1000),
            metadata_json=json.dumps({
                "status": response.status_code,
                "duration_ms": elapsed_ms,
            }),
        )
        db2.add(resp_entry)
        db2.commit()
    except Exception:
        pass
    finally:
        try:
            db2.close()
        except Exception:
            pass

    return response


@app.get("/")
def read_root():
    return {"message": "Haven API is running. Check /docs for endpoints."}


# ── Engine connection keys (Haven "Connect your engine") ────────────────────
# The web app generates a key here; the desktop engine sends it as X-Api-Key.
# Only the sha256 hash is stored — the raw key is shown ONCE, at creation.

from database.models import ApiKey  # noqa: E402


class ApiKeyInfo(BaseModel):
    id: str
    label: str
    created_at: int | None
    last_used_at: int | None
    revoked: int
    scopes: str
    expires_at: int | None


class ApiKeyCreate(BaseModel):
    label: str = "My engine"


@app.get("/engine/keys", response_model=List[ApiKeyInfo])
def list_engine_keys(db: Session = Depends(get_db),
                     identity: Identity = Depends(require_paid)):
    """This user's engine keys (metadata only — raw keys are never stored)."""
    rows = (db.query(ApiKey)
            .filter(ApiKey.user_id == identity.user_id, ApiKey.revoked == 0)
            .order_by(ApiKey.created_at.desc()).all())
    return rows


@app.post("/engine/keys")
def create_engine_key(body: ApiKeyCreate, db: Session = Depends(get_db),
                      identity: Identity = Depends(require_paid)):
    """Generate a new engine connection key. Returns the RAW key exactly once.

    The user pastes it into the desktop engine's setup wizard. We keep only the
    hash, so it can never be shown again — lost keys are revoked + regenerated.
    """
    import uuid
    import secrets
    if identity.kind not in ("user", "solo"):
        raise HTTPException(status_code=403, detail="Only the signed-in user may create engine keys")
    active = db.query(ApiKey).filter(
        ApiKey.user_id == identity.user_id, ApiKey.revoked == 0).count()
    if active >= int(os.environ.get("HAVEN_MAX_ENGINE_KEYS", "3")):
        raise HTTPException(status_code=409, detail="Revoke an old engine key before creating another")
    at = int(time.time() * 1000)
    raw = "haven_" + secrets.token_urlsafe(32)
    row = ApiKey(
        id=str(uuid.uuid4()), user_id=identity.user_id,
        key_hash=hash_key(raw), label=body.label[:60] or "engine",
        created_at=at, scopes="engine:read,engine:trade,engine:report",
        expires_at=at + int(os.environ.get("HAVEN_ENGINE_KEY_DAYS", "90")) * 86_400_000,
    )
    db.add(row)
    db.commit()
    return {"id": row.id, "label": row.label, "api_key": raw,
            "note": "Copy this now — it is shown only once."}


@app.delete("/engine/keys/{key_id}")
def revoke_engine_key(key_id: str, db: Session = Depends(get_db),
                      identity: Identity = Depends(require_paid)):
    """Revoke an engine key (the engine using it stops being able to trade)."""
    row = (db.query(ApiKey)
           .filter(ApiKey.id == key_id, ApiKey.user_id == identity.user_id).first())
    if not row:
        raise HTTPException(status_code=404, detail="Key not found")
    row.revoked = 1
    db.commit()
    return {"ok": True}


@app.get("/engine/download")
def download_engine(db: Session = Depends(get_db),
                    identity: Identity = Depends(require_paid)):
    """Serve the signed desktop engine archive to entitled users.

    The zip is built by tools/build_engine_release.py into api/static/. If it isn't
    present the endpoint 404s with guidance rather than erroring cryptically.
    """
    from fastapi.responses import FileResponse
    ent = entitlements(db, identity)
    if not ent.get("live_allowed"):
        raise HTTPException(status_code=403, detail="Your plan does not include the local engine")
    zip_path = os.path.join(os.path.dirname(__file__), "static", "haven-engine.zip")
    manifest_path = zip_path + ".manifest.json"
    if not os.path.exists(zip_path) or not os.path.exists(manifest_path):
        raise HTTPException(status_code=404,
                            detail="A signed engine release is not currently available.")
    try:
        import base64
        from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
        with open(manifest_path, encoding="utf8") as handle:
            manifest = json.load(handle)
        signature = manifest.pop("signature")
        public = base64.b64decode(os.environ["HAVEN_ENGINE_RELEASE_PUBLIC_KEY"])
        Ed25519PublicKey.from_public_bytes(public).verify(
            base64.b64decode(signature),
            json.dumps(manifest, sort_keys=True, separators=(",", ":")).encode(),
        )
        with open(zip_path, "rb") as handle:
            digest = hashlib.sha256(handle.read()).hexdigest()
        if digest != manifest.get("sha256"):
            raise ValueError("archive checksum mismatch")
    except Exception:
        raise HTTPException(status_code=503,
                            detail="Engine release signature verification failed")
    response = FileResponse(zip_path, media_type="application/zip",
                            filename="haven-engine.zip")
    response.headers["X-Haven-Release"] = str(manifest.get("version", ""))
    response.headers["X-Haven-SHA256"] = digest
    return response


# Shared API infrastructure is global. Each user's local engine heartbeat is
# namespaced "{process}@{user_id}" so accounts see only their own engine dot.
SHARED_PROCESSES = {"api"}


@app.get("/health")
def health_check(db: Session = Depends(get_db)):
    """Live status of the Binance Alpha market service and API.

    Public (no auth) so UptimeRobot can monitor it and the subscribe screen
    can show health dots before login. Only shared process health is exposed;
    per-user engine health requires authentication.
    """
    from datetime import datetime, timezone
    now_ms = int(datetime.now(timezone.utc).timestamp() * 1000)

    def bucket(age_sec):
        if age_sec < 60:
            return "ok"
        return "warning" if age_sec < 180 else "down"

    statuses = {"api": {"status": "ok", "last_seen_sec_ago": 0}}
    provider = db.query(ProviderStatus).filter(ProviderStatus.provider == "binance_alpha").first()
    if provider:
        age = (now_ms - (provider.last_event_at or provider.updated_at)) / 1000
        statuses["market_data"] = {
            "status": "ok" if provider.state == "connected" and age < 120 else
                      "warning" if provider.state in ("starting", "reconnecting") or age < 300 else "down",
            "last_seen_sec_ago": int(age), "provider": "Binance Alpha",
        }
    else:
        statuses["market_data"] = {"status": "down", "provider": "Binance Alpha"}
    for row in db.query(Heartbeat).all():
        proc, _, owner = row.process.partition("@")
        if owner:                                  # a user's engine/runner
            continue                               # private — requires auth
        elif proc not in SHARED_PROCESSES and not SOLO_MODE:
            continue
        age_sec = (now_ms - row.last_heartbeat) / 1000
        statuses[proc] = {"status": bucket(age_sec), "last_seen_sec_ago": int(age_sec)}

    return statuses


@app.get("/engine/health")
def engine_health(db: Session = Depends(get_db),
                  identity: Identity = Depends(require_paid)):
    row = db.query(Heartbeat).filter(
        Heartbeat.process == f"execution_engine@{identity.user_id}").first()
    if not row and SOLO_MODE:
        row = db.query(Heartbeat).filter(Heartbeat.process == "execution_engine").first()
    if not row:
        return {"status": "down", "last_seen_sec_ago": None}
    age = max(0, int((time.time() * 1000 - row.last_heartbeat) / 1000))
    return {"status": "ok" if age < 60 else "warning" if age < 180 else "down",
            "last_seen_sec_ago": age}


class SecurityCheckBody(BaseModel):
    force: bool = False


@app.post("/security/check/{symbol}")
async def security_check_token(symbol: str, body: SecurityCheckBody | None = None,
                               force: int = 0,
                               db: Session = Depends(get_db),
                               identity: Identity = Depends(require_paid)):
    """Pre-trade Alpha catalogue gate; Binance Alpha does not provide an audit."""
    tok = db.query(Token).filter(Token.symbol == symbol).first()
    if not tok:
        raise HTTPException(status_code=404, detail="Token not found")
    if not tok.contract_address:
        return {
            "symbol": symbol, "safe": False, "blocked": True,
            "critical": ["no_contract"], "flags": [],
            "chart_allowed": True,
            "trade_policy": {"mode": "blocked", "auto_allowed": False},
            "message": "No contract address — cannot trade.",
        }
    asset = db.get(AlphaAsset, tok.alpha_id) if tok.alpha_id else None
    # Inclusion in the current BSC Alpha catalogue proves the exact pair we chart,
    # but is not a contract-security audit. It remains elevated-risk: no automatic
    # strategy execution, while manual execution retains its acknowledgement gate.
    result = {"provider": "Binance Alpha", "scanned_at": int(time.time() * 1000),
              "safe": False, "critical": ["security_audit_unavailable"], "flags": [],
              "verified": bool(asset and asset.contract_address.lower() == tok.contract_address.lower()),
              "from_cache": False}
    if not asset:
        result["critical"].append("not_in_alpha_catalogue")
    result.update({"symbol": symbol, "status": tok.status,
                   "contract_address": tok.contract_address, "chain_id": tok.chain_id,
                   "chart_allowed": True})
    if tok.status == "blacklisted":
        result["critical"] = list(dict.fromkeys([*(result.get("critical") or []), "blacklisted"]))
        result["safe"] = False
    result["trade_policy"] = {
        "mode": "standard" if result.get("safe") is True else "elevated_risk",
        "auto_allowed": result.get("safe") is True,
        "manual_ack_required": result.get("safe") is not True,
    }
    # `blocked` = auto/strategy path must not trade without manual risk ack.
    if result["trade_policy"]["mode"] == "elevated_risk":
        result["blocked"] = True
        result["message"] = (
            "ELEVATED RISK — chart OK. Manual trade requires contract verification "
            "and risk acknowledgment; start with a small probe. "
            f"Flags: {', '.join(result.get('critical') or result.get('flags') or [])}"
        )
    return result


@app.get("/security/status")
def security_status(db: Session = Depends(get_db),
                    identity: Identity = Depends(require_paid)):
    return {
        "configured": True,
        "provider": "Binance Alpha catalogue (not a security audit)",
        "scanned_total": db.query(Token).filter(Token.security_json.isnot(None)).count(),
        "blocked_total": db.query(Token).filter(Token.status == "blacklisted").count(),
        "cache_seconds": 0,
    }


# ── Engine settings (pause flag + risk limits for the execution daemon) ────

ENGINE_SETTING_DEFAULTS = {
    "paused": "0",                  # 1 = engine watches but never executes
    "max_trades_per_day": "20",     # hard cap on marker executions per UTC day
    "max_trade_usd": "250",         # abort any single trade sized above this
    "max_price_impact_pct": "3",    # abort if quote implies more slippage than this
    "max_retry_attempts": "3",      # failed marker is disabled after this many tries
}


class EngineSettingsUpdate(BaseModel):
    paused: int | None = None
    max_trades_per_day: int | None = None
    max_trade_usd: float | None = None
    max_price_impact_pct: float | None = None
    max_retry_attempts: int | None = None


def _engine_settings_for(db: Session, user_id: str):
    stored = {r.key: r.value for r in
              db.query(EngineSetting).filter(EngineSetting.user_id == user_id).all()}
    merged = {**ENGINE_SETTING_DEFAULTS, **stored}
    return {
        "paused": int(merged["paused"]),
        "max_trades_per_day": int(float(merged["max_trades_per_day"])),
        "max_trade_usd": float(merged["max_trade_usd"]),
        "max_price_impact_pct": float(merged["max_price_impact_pct"]),
        "max_retry_attempts": int(float(merged["max_retry_attempts"])),
    }


@app.get("/engine/settings")
def get_engine_settings(db: Session = Depends(get_db),
                        identity: Identity = Depends(require_paid)):
    """This user's engine settings (stored values merged over defaults)."""
    return _engine_settings_for(db, identity.user_id)


@app.patch("/engine/settings")
def update_engine_settings(u: EngineSettingsUpdate, db: Session = Depends(get_db),
                           identity: Identity = Depends(require_paid)):
    """Update one or more of this user's engine settings (partial update)."""
    for key, val in u.model_dump(exclude_none=True).items():
        row = (db.query(EngineSetting)
               .filter(EngineSetting.user_id == identity.user_id,
                       EngineSetting.key == key).first())
        if row:
            row.value = str(val)
        else:
            db.add(EngineSetting(user_id=identity.user_id, key=key, value=str(val)))
    db.commit()
    return _engine_settings_for(db, identity.user_id)


class HeartbeatCreate(BaseModel):
    process: str


@app.post("/heartbeat")
def write_heartbeat(hb: HeartbeatCreate, db: Session = Depends(get_db),
                    identity: Identity = Depends(get_identity)):
    """Record a liveness heartbeat for a process.

    A user's engine/runner is namespaced "{process}@{user_id}" so each account
    sees only its own local engine state.
    """
    from datetime import datetime, timezone
    now_ms = int(datetime.now(timezone.utc).timestamp() * 1000)
    proc = hb.process
    if not SOLO_MODE and proc not in SHARED_PROCESSES:
        proc = f"{proc}@{identity.user_id}"
    existing = db.query(Heartbeat).filter_by(process=proc).first()
    if existing:
        existing.last_heartbeat = now_ms
    else:
        db.add(Heartbeat(process=proc, last_heartbeat=now_ms))
    db.commit()
    return {"ok": True, "process": proc, "last_heartbeat": now_ms}


# Optional Binance Alpha DEX-liquidity floor for operator-curated token views.
MIN_TOKEN_LIQUIDITY_USD = float(os.environ.get("HAVEN_MIN_TOKEN_LIQUIDITY_USD", "100000"))
# Reject absurd market caps on the product surface (fake supply × price scams).
MAX_PRODUCT_MARKET_CAP = float(os.environ.get("HAVEN_MAX_PRODUCT_MCAP", str(50_000_000_000)))
# Prefer Binance Alpha-identified tokens; non-Binance Alpha allowed only with sane/unknown mcap.
REQUIRE_ALPHA_CATALOGUE = os.environ.get("HAVEN_REQUIRE_ALPHA_CATALOGUE", "1") == "1"


def _product_token_filters(q, *, floor: float, enforce_quality: bool = True):
    """Shared WHERE clauses for screener/product token lists."""
    if floor > 0:
        q = q.filter(Token.liquidity_usd.isnot(None)).filter(Token.liquidity_usd >= floor)
    if not enforce_quality:
        return q
    # Drop blacklisted honeypots always.
    q = q.filter((Token.status.is_(None)) | (Token.status != "blacklisted"))
    # Cap displayed mcap (NULL ok — sorts last on mcap sort).
    q = q.filter(
        (Token.market_cap.is_(None)) | (Token.market_cap <= MAX_PRODUCT_MARKET_CAP)
    )
    if REQUIRE_ALPHA_CATALOGUE:
        # Market-cap figures without alpha_id are untrusted — force NULL at write
        # time (apply_quality_filter). Here we also hide rows that still claim
        # an absurd mcap (belt and suspenders).
        from sqlalchemy import or_
        q = q.filter(or_(
            Token.market_cap.is_(None),
            Token.alpha_id.isnot(None),
            Token.market_cap <= 1_000_000_000,
        ))
    return q


@app.get("/tokens", response_model=List[TokenResponse])
def get_tokens(skip: int = 0, limit: int = 100, status: str = "active",
               min_liquidity: float | None = None,
               quality: bool = True,
               db: Session = Depends(get_db),
               identity: Identity = Depends(require_paid)):
    """Retrieve supported Binance Alpha-identified trading contracts."""
    q = db.query(Token)
    if status != "all":
        # Legacy rows predate the status column; NULL counts as active.
        q = q.filter((Token.status == status) | (Token.status.is_(None))) \
            if status == "active" else q.filter(Token.status == status)
    floor = 0.0 if min_liquidity is None else float(min_liquidity)
    # Wallet scans need every contract; product lists need quality.
    enforce = quality and floor > 0
    q = _product_token_filters(q, floor=floor, enforce_quality=enforce)
    tokens = q.offset(skip).limit(limit).all()
    return [_token_to_response(t) for t in tokens]


class TokenSearchHit(BaseModel):
    source: str
    in_db: bool = False
    symbol: str | None = None
    display: str | None = None
    name: str | None = None
    chain: str | None = None
    contract_address: str | None = None
    alpha_id: str | None = None
    alpha_rank: int | None = None
    market_cap: float | None = None
    logo_url: str | None = None
    status: str | None = None
    liquidity_usd: float | None = None


@app.get("/tokens/search", response_model=List[TokenSearchHit])
def search_tokens_endpoint(
    q: str = "",
    limit: int = 12,
    db: Session = Depends(get_db),
    identity: Identity = Depends(require_paid),
):
    """Search Haven's server-cached Binance Alpha BSC catalogue."""
    q = (q or "").strip()
    if len(q) < 1:
        return []
    limit = max(1, min(int(limit or 12), 25))
    needle = f"%{q.lower()}%"
    assets = (db.query(AlphaAsset)
              .filter((func.lower(AlphaAsset.symbol).like(needle)) |
                      (func.lower(AlphaAsset.name).like(needle)) |
                      (func.lower(AlphaAsset.alpha_id).like(needle)))
              .order_by(AlphaAsset.rank.asc().nullslast()).limit(limit).all())
    tokens = {t.alpha_id: t for t in db.query(Token).filter(
        Token.alpha_id.in_([a.alpha_id for a in assets])).all()} if assets else {}
    hits = []
    for asset in assets:
        tok = tokens.get(asset.alpha_id)
        metadata = {}
        try:
            metadata = json.loads(asset.metadata_json or "{}")
        except (ValueError, TypeError):
            pass
        hits.append(TokenSearchHit(
            source="binance_alpha", in_db=bool(tok),
            symbol=tok.symbol if tok else None, display=asset.symbol,
            name=asset.name, chain=tok.chain_id if tok else None,
            contract_address=asset.contract_address, alpha_id=asset.alpha_id,
            alpha_rank=asset.rank, logo_url=metadata.get("iconUrl"), status=tok.status if tok else None,
            market_cap=tok.market_cap if tok else None,
            liquidity_usd=tok.liquidity_usd if tok else None,
        ))
    return hits


class TokenEnsureBody(BaseModel):
    alpha_id: str | None = None
    chain: str | None = None
    contract_address: str | None = None
    display: str | None = None
    name: str | None = None
    market_cap: float | None = None
    price: float | None = None
    volume_24h: float | None = None
    price_change_24h: float | None = None
    backfill: bool = True
    scan_security: bool = True


@app.post("/tokens/ensure")
async def ensure_token_endpoint(
    body: TokenEnsureBody,
    db: Session = Depends(get_db),
    identity: Identity = Depends(require_paid),
):
    """Make a supported cached Binance Alpha BSC contract available to charts/trading."""
    asset = db.get(AlphaAsset, body.alpha_id) if body.alpha_id else None
    if not asset and body.contract_address:
        asset = db.query(AlphaAsset).filter(
            func.lower(AlphaAsset.contract_address) == body.contract_address.lower()).first()
    if not asset:
        raise HTTPException(status_code=404, detail="Asset is not in the cached Binance Alpha catalogue")
    tok = db.query(Token).filter(Token.alpha_id == asset.alpha_id).first()
    if not tok:
        raise HTTPException(status_code=422, detail=(
            "This Binance Alpha asset does not expose a BSC contract"))
    return {
        "symbol": tok.symbol, "display": tok.display_symbol, "name": tok.name,
        "status": tok.status, "security": None, "trade_policy": None,
        "chart_allowed": True, "source": "binance_alpha",
    }


@app.get("/tokens/{symbol}", response_model=TokenResponse)
def get_token(symbol: str, db: Session = Depends(get_db),
              identity: Identity = Depends(require_paid)):
    """One token row by slug — the chart's chain badge / explorer link lookup."""
    tok = db.query(Token).filter(Token.symbol == symbol).first()
    if not tok:
        raise HTTPException(status_code=404, detail="Token not found")
    return _token_to_response(tok)


@app.get("/market/prices")
def market_prices(symbols: str, db: Session = Depends(get_db),
                  identity: Identity = Depends(require_paid)):
    """Small Binance Alpha-backed quote lookup for first-party UI valuation."""
    requested = [s.strip().upper() for s in symbols.split(",") if s.strip()][:50]
    rows = db.query(LatestTicker).filter(LatestTicker.symbol.in_(requested)).all()
    return {
        "source": "binance_alpha",
        "prices": {row.symbol: {"price": row.last_price, "change_24h": row.price_change_24h,
                                "volume_24h": row.volume_24h, "updated_at": row.last_updated}
                   for row in rows},
    }


@app.get("/chains")
def get_chains(identity: Identity = Depends(require_paid)):
    """Trading chains supported by the current local engine."""
    return chain_public_info()

@app.get("/signals", response_model=List[SignalResponse])
def get_top_signals(limit: int = 400, sort_by: str = "vol_24h", db: Session = Depends(get_db),
                    identity: Identity = Depends(require_paid)):
    """Return a compact Binance Alpha BSC trading watchlist."""
    current_minute = (int(time.time() * 1000) // 60_000) * 60_000
    limit = max(1, min(limit, 500))
    rows = (db.query(Token, LatestTicker, AlphaAsset)
            .join(LatestTicker, LatestTicker.symbol == Token.symbol)
            .join(AlphaAsset, AlphaAsset.alpha_id == Token.alpha_id)
            .filter((Token.status == "active") | Token.status.is_(None))
            .filter(LatestTicker.last_price.isnot(None))
            .all())
    signals = [SignalResponse(
        symbol=tok.symbol, name=tok.name, display_symbol=tok.display_symbol,
        timestamp=ticker.last_updated or current_minute,
        price_change_24h=ticker.price_change_24h or 0,
        volume_24h=ticker.volume_24h or 0, market_cap=tok.market_cap or 0,
        last_price=ticker.last_price, alpha_rank=asset.rank,
    ) for tok, ticker, asset in rows]
    if sort_by == "price_change_24h":
        signals.sort(key=lambda item: item.price_change_24h, reverse=True)
    elif sort_by == "market_cap":
        signals.sort(key=lambda item: item.market_cap, reverse=True)
    elif sort_by == "mcap_vol":
        signals.sort(key=lambda item: (item.market_cap or 0) * (item.volume_24h or 0), reverse=True)
    else:
        signals.sort(key=lambda item: item.volume_24h, reverse=True)
    # The screener is a cached ranked view, not a request to buy a live stream
    # for every row it returns. Charts, valuation lookups, and armed strategies
    # register their own exact demand with the shared market service.
    return signals[:limit]

# ── In-app coding assistant (DeepSeek proxy) ─────────────────────────────────
# The chart UI embeds a chat window under the code editor on the Strategies and
# Token Finder pages. The DeepSeek key stays in the server secret manager; the
# browser only ever talks to this proxy. Scoped by `mode` to helping the user
# write the strategy/finder JS for the page it is on.

_DEEPSEEK_KEY = None            # cached once found
_SDK_DOC_CACHE = {}
DEEPSEEK_URL = "https://api.deepseek.com/chat/completions"
DEEPSEEK_MODEL = os.environ.get("DEEPSEEK_MODEL", "deepseek-v4-flash")


def _load_deepseek_key():
    """Read the AI credential from the process environment only."""
    global _DEEPSEEK_KEY
    if _DEEPSEEK_KEY:
        return _DEEPSEEK_KEY
    key = os.environ.get("DEEPSEEK_API_KEY")
    if key:
        _DEEPSEEK_KEY = key
    return key or None


def _read_sdk_doc(name):
    """Read (and cache) a strategy-sdk contract doc to embed in the system prompt."""
    if name in _SDK_DOC_CACHE:
        return _SDK_DOC_CACHE[name]
    path = os.path.join(os.path.dirname(__file__), "..", "..", "strategy-sdk", "docs", name)
    try:
        with open(path, "r", encoding="utf-8") as f:
            text = f.read()
    except OSError:
        text = ""
    _SDK_DOC_CACHE[name] = text
    return text


def _assistant_system_prompt(mode, code):
    if mode == "finder":
        role = ("You are a coding assistant embedded in the Token Finder page of the "
                "Haven trading app. Your ONLY job is to help the user write and "
                "debug the JavaScript for a Token Finder — a `finder` object that ranks "
                "tokens (params, optional filter(ctx), required score(ctx)).")
        contract = _read_sdk_doc("finder-contract.md")
    else:
        role = ("You are a coding assistant embedded in Haven's Strategies page. "
                "Your ONLY job is to help the user write and debug "
                "the JavaScript for a trading strategy — a `strategy` object with params, "
                "optional init(ctx), and an onBar(bar, ctx) handler.")
        contract = _read_sdk_doc("strategy-contract.md")
    parts = [
        role,
        "Stay strictly on that task. If asked about anything unrelated to writing this "
        "page's code (small talk, other topics, unrelated parts of the app, trading "
        "advice, or moving money), briefly decline and steer back to the code.",
        "Be concise. When you provide code, return a COMPLETE, runnable definition in a "
        "single ```js fenced block that follows the contract exactly, so it can be pasted "
        "straight into the editor. Only use the ctx surface and indicators documented below.",
        "=== CONTRACT ===\n" + contract,
        "=== INDICATOR REFERENCE ===\n" + _read_sdk_doc("indicator-reference.md"),
    ]
    if code and code.strip():
        parts.append("=== USER'S CURRENT EDITOR CODE ===\n```js\n" + code.strip()[:8000] + "\n```")
    return "\n\n".join(parts)


class AssistantMessage(BaseModel):
    role: str
    content: str


class AssistantChatRequest(BaseModel):
    mode: str = "strategy"
    messages: List[AssistantMessage] = []
    code: str | None = None


@app.post("/assistant/chat")
async def assistant_chat(req: AssistantChatRequest,
                         db: Session = Depends(get_db),
                         identity: Identity = Depends(require_paid)):
    """Proxy a plan-limited coding-assistant turn (key stays server-side)."""
    key = _load_deepseek_key()
    if not key:
        raise HTTPException(
            status_code=503,
            detail="AI assistant is not configured on the Haven server.")
    mode = req.mode if req.mode in ("strategy", "finder") else "strategy"
    # We own the system prompt; only forward user/assistant turns from the client.
    convo = [{"role": m.role, "content": m.content}
             for m in req.messages
             if m.role in ("user", "assistant") and m.content]
    if not convo:
        raise HTTPException(status_code=422, detail="No message to send.")
    convo = convo[-20:]   # cap history length
    entitlement = entitlements(db, identity)
    allowance = entitlement.get("ai_daily")
    if allowance is not None:
        from datetime import datetime, timezone
        today = datetime.now(timezone.utc).date().isoformat()
        at = int(time.time() * 1000)
        stmt = dialect_insert(AiDailyUsage).values(
            user_id=identity.user_id, usage_date=today, requests=1, updated_at=at)
        stmt = stmt.on_conflict_do_update(
            index_elements=["user_id", "usage_date"],
            set_={"requests": AiDailyUsage.requests + 1, "updated_at": at})
        db.execute(stmt)
        usage = db.query(AiDailyUsage).filter(
            AiDailyUsage.user_id == identity.user_id,
            AiDailyUsage.usage_date == today,
        ).one()
        if usage.requests > allowance:
            db.rollback()
            raise HTTPException(status_code=429,
                                detail=f"Daily AI allowance reached ({allowance}).")
        db.commit()

    payload = {
        "model": DEEPSEEK_MODEL,
        "messages": [{"role": "system", "content": _assistant_system_prompt(mode, req.code)}] + convo,
        "temperature": 0.3,
        "stream": False,
    }
    headers = {"Authorization": f"Bearer {key}", "Content-Type": "application/json"}

    import aiohttp
    try:
        timeout = aiohttp.ClientTimeout(total=90)
        async with aiohttp.ClientSession(timeout=timeout) as session:
            async with session.post(DEEPSEEK_URL, json=payload, headers=headers) as resp:
                text = await resp.text()
                if resp.status != 200:
                    raise HTTPException(status_code=502,
                                        detail=f"DeepSeek error {resp.status}: {text[:300]}")
                data = json.loads(text)
    except aiohttp.ClientError as e:
        raise HTTPException(status_code=502, detail=f"DeepSeek request failed: {e}")

    try:
        reply = data["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError):
        raise HTTPException(status_code=502, detail="DeepSeek returned no reply.")
    return {"reply": reply}


KLINE_INTERVALS = {"1m": 60_000, "3m": 180_000, "5m": 300_000, "15m": 900_000,
                   "30m": 1_800_000, "1h": 3_600_000, "4h": 14_400_000,
                   "1d": 86_400_000}
KLINES_MAX_LIMIT = 1500


@app.get("/klines/{symbol}")
async def get_klines(symbol: str, interval: str = "5m", limit: int = 500,
                     end_ms: int | None = None, include_open: int = 0,
                     db: Session = Depends(get_db),
                     identity: Identity = Depends(require_paid)):
    """Binance Alpha historical candles with durable closed-candle caching."""
    if interval not in KLINE_INTERVALS:
        raise HTTPException(status_code=422,
                            detail=f"Invalid interval '{interval}'. Allowed: {tuple(KLINE_INTERVALS)}")
    interval_ms = KLINE_INTERVALS[interval]
    limit = max(1, min(limit, KLINES_MAX_LIMIT))

    sym = symbol
    tok = db.query(Token).filter(Token.symbol == sym).first()
    if not tok:
        raise HTTPException(status_code=404, detail="Token not found")
    if not tok.alpha_id or not tok.contract_address:
        raise HTTPException(status_code=422, detail="Token is missing its Binance Alpha ID or BSC contract address")
    try:
        rows = await alpha_market.candles(alpha_id=tok.alpha_id, interval=interval, limit=limit + 2)
    except (AlphaError, ValueError) as exc:
        raise HTTPException(status_code=503, detail=f"Binance Alpha candle data unavailable: {exc}")
    rows = [r for r in rows if include_open or r.closed == 1]
    rows = rows[-limit:]
    return {
        "code": "000000", "message": None, "symbol": sym, "interval": interval,
        "source": "binance_alpha",
        "data": [[r.open_time, str(r.open_price), str(r.high_price),
                  str(r.low_price), str(r.close_price), str(r.volume or 0),
                  r.close_time] for r in rows],
    }
