from fastapi import FastAPI, Depends, HTTPException
from sqlalchemy.orm import Session
from sqlalchemy import desc, func, case
from database.db import get_db, engine, Base, ensure_db_settings
from database.models import (
    Token, OneMinBucket, LatestTicker, Heartbeat, ChartMarker, TradeHistory,
    DebugLog, EngineSetting, Strategy, Finder, FifteenMinBucket, DailyBucket,
    MARKER_TYPES, STRATEGY_MODES, FINDER_INTERVALS,
)
from api.auth import (
    get_identity, require_paid, Identity, SOLO_MODE, hash_key, entitlements,
)
from ingest.chains import LEGACY_CHAIN_ID_MAP
from pydantic import BaseModel
from typing import List, Any
from collections import defaultdict
from fastapi.middleware.cors import CORSMiddleware
from fastapi import Request
from contextlib import asynccontextmanager
import asyncio
import os
import time
import json


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Ensure tables exist before serving (replaces deprecated @app.on_event).
    Base.metadata.create_all(bind=engine)
    ensure_db_settings()  # pragmas/indexes + idempotent column upgrades
    print(f"Database tables ensured on startup. SOLO_MODE={SOLO_MODE}")

    # Periodic CMC rank refresh for landing movers/ticker (real market caps).
    # Runs in a worker thread so it never blocks request handling.
    stop = asyncio.Event()

    async def _cmc_loop():
        interval = int(os.environ.get("CMC_RANK_INTERVAL_SEC", str(6 * 3600)))
        # First run after a short delay so boot isn't blocked on CMC.
        await asyncio.sleep(15)
        while not stop.is_set():
            try:
                from cmc_ranking import run_ranking
                result = await asyncio.to_thread(run_ranking, 2000, False, False)
                print(f"CMC ranking refresh: {result}")
            except Exception as e:
                print(f"CMC ranking refresh failed: {e}")
            try:
                await asyncio.wait_for(stop.wait(), timeout=interval)
            except asyncio.TimeoutError:
                pass

    task = asyncio.create_task(_cmc_loop())
    yield
    stop.set()
    task.cancel()
    try:
        await task
    except asyncio.CancelledError:
        pass


app = FastAPI(title="Haven API", lifespan=lifespan)

# CORS: locked to the web app's origin(s) in production (comma-separated
# HAVEN_CORS_ORIGINS env), wide-open in solo/local dev.
_cors_env = os.environ.get("HAVEN_CORS_ORIGINS", "").strip()
_cors_origins = [o.strip() for o in _cors_env.split(",") if o.strip()] or ["*"]
app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Stripe billing endpoints (dormant in solo mode; router still mounts).
from api.billing import router as billing_router  # noqa: E402
app.include_router(billing_router)
# Public landing-page market data (unauthenticated, rate-limited, real DB).
from api.public_market import router as public_router  # noqa: E402
app.include_router(public_router)

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
    # GoPlus Security summary (parsed from security_json). None until scanned.
    security: dict | None = None

    class Config:
        from_attributes = True


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
    buy_vol_1m: float
    sell_vol_1m: float
    net_flow_1m: float
    buy_vol_5m: float
    sell_vol_5m: float
    net_flow_5m: float
    buy_vol_15m: float = 0.0
    sell_vol_15m: float = 0.0
    net_flow_15m: float = 0.0
    buy_vol_1h: float = 0.0
    sell_vol_1h: float = 0.0
    net_flow_1h: float = 0.0
    trade_count: int
    price_change_24h: float
    volume_24h: float = 0.0
    market_cap: float = 0.0
    last_price: float | None = None  # live collector price for screener

    class Config:
        from_attributes = True


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

    class Config:
        from_attributes = True


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
    user_id: str | None = None   # honored ONLY from the service identity (paper-runner)


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

    class Config:
        from_attributes = True


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
    """Record a filled trade from the execution engine (owned by the caller).

    The cloud paper-runner (service identity) may write PAPER trades on behalf
    of the strategy's owner — it passes the target user via t.user_id; every
    other caller is pinned to its own identity.
    """
    import uuid
    owner = identity.user_id
    if identity.is_service and t.user_id:
        owner = t.user_id
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

    class Config:
        from_attributes = True


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
    """List this user's strategies without code bodies (runner + UI poll this).

    The cloud paper-runner (service identity) gets EVERY user's strategies so
    it can execute all DRY strategies centrally — it filters to mode=dry itself.
    """
    q = db.query(Strategy)
    if not identity.is_service:
        q = q.filter(Strategy.user_id == identity.user_id)
    return q.order_by(Strategy.created_at).all()


@app.get("/strategies/{strategy_id}", response_model=StrategyResponse)
def get_strategy(strategy_id: str, db: Session = Depends(get_db),
                 identity: Identity = Depends(require_paid)):
    q = db.query(Strategy).filter(Strategy.id == strategy_id)
    if not identity.is_service:
        q = q.filter(Strategy.user_id == identity.user_id)
    strat = q.first()
    if not strat:
        raise HTTPException(status_code=404, detail="Strategy not found")
    return strat


@app.post("/strategies", response_model=StrategyResponse)
def create_strategy(s: StrategyCreate, db: Session = Depends(get_db),
                    identity: Identity = Depends(require_paid)):
    import uuid
    _validate_strategy_fields(s.interval, None)
    _validate_token_selection(db, identity.user_id, s.symbol, s.finder_id,
                              s.max_positions, s.switch_margin_pct)
    # Library cap (solo/service = unlimited): saved strategies per user, so one
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
                        "Delete a strategy you no longer use — larger libraries are a "
                        "planned plan upgrade."))
    now_ms = int(time.time() * 1000)
    strat = Strategy(
        id=str(uuid.uuid4()), user_id=identity.user_id, name=s.name, code=s.code,
        symbol=s.symbol if not s.finder_id else (s.symbol or ""),
        interval=s.interval, params_json=s.params_json, mode="off",
        finder_id=s.finder_id, max_positions=s.max_positions,
        switch_margin_pct=s.switch_margin_pct,
        created_at=now_ms, updated_at=now_ms,
    )
    db.add(strat)
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

    The cloud paper-runner (service identity) may PATCH last_run_at/last_error
    on any user's DRY strategy, but never its definition or mode.
    """
    q = db.query(Strategy).filter(Strategy.id == strategy_id)
    if not identity.is_service:
        q = q.filter(Strategy.user_id == identity.user_id)
    strat = q.first()
    if not strat:
        raise HTTPException(status_code=404, detail="Strategy not found")
    _validate_strategy_fields(s.interval, s.mode)
    # Validate the token selection the row will END UP with after this patch.
    next_symbol = s.symbol if s.symbol is not None else strat.symbol
    next_finder = None if s.clear_finder else (s.finder_id if s.finder_id is not None else strat.finder_id)
    _validate_token_selection(db, strat.user_id, next_symbol, next_finder,
                              s.max_positions, s.switch_margin_pct)

    # Bot entitlements: arming a strategy (mode off → dry/live) consumes a bot
    # slot; LIVE additionally requires a full (non-trial) subscription. The
    # service runner only PATCHes status fields, never mode, so this path is
    # user/engine-only. 409 = slots full, 403 = trial trying to go live; both
    # carry a human-readable detail the UI shows as-is.
    if s.mode in ("dry", "live") and not identity.is_service:
        ent = entitlements(db, identity)
        if s.mode == "live" and not ent["live_allowed"]:
            raise HTTPException(
                status_code=403,
                detail="Trial accounts run paper (DRY) bots only. Subscribe to unlock live trading.")
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
    if not identity.is_service:
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

    class Config:
        from_attributes = True


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
    """List this user's finders (service identity sees all, for the FinderHub)."""
    q = db.query(Finder)
    if not identity.is_service:
        q = q.filter(Finder.user_id == identity.user_id)
    return q.order_by(Finder.created_at).all()


@app.get("/finders/{finder_id}", response_model=FinderResponse)
def get_finder(finder_id: str, db: Session = Depends(get_db),
               identity: Identity = Depends(require_paid)):
    q = db.query(Finder).filter(Finder.id == finder_id)
    if not identity.is_service:
        q = q.filter(Finder.user_id == identity.user_id)
    f = q.first()
    if not f:
        raise HTTPException(status_code=404, detail="Finder not found")
    return f


@app.post("/finders", response_model=FinderResponse)
def create_finder(f: FinderCreate, db: Session = Depends(get_db),
                  identity: Identity = Depends(require_paid)):
    import uuid
    _validate_finder_interval(f.interval)
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

    Service identity (FinderHub) may PATCH last_run_at/last_error on any finder.
    """
    q = db.query(Finder).filter(Finder.id == finder_id)
    if not identity.is_service:
        q = q.filter(Finder.user_id == identity.user_id)
    finder = q.first()
    if not finder:
        raise HTTPException(status_code=404, detail="Finder not found")
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


def _grouped_ohlc(db: Session, model, symbols: list[str], start_ms: int, end_ms: int,
                  interval_ms: int) -> dict:
    """Resample a bucket table to interval_ms groups, SQL-side.

    Returns {(symbol, group_start_ms): [o, h, l, c, buy, sell, trades]}.
    Three grouped scans: aggregates, then open/close via SQLite's documented
    bare-column-with-MIN/MAX behavior (the bare column comes from the row that
    won the MIN/MAX — exactly the first/last bucket of the group).
    """
    # NOT `(bucket_start / interval) * interval`: SQLAlchemy 2.0 renders `/`
    # as TRUE division (`? + 0.0`), which silently degrades the GROUP BY to
    # one group per row. Modulo stays integer-typed on every dialect.
    grp = model.bucket_start - (model.bucket_start % interval_ms)

    def base(q):
        return (q.filter(model.symbol.in_(symbols))
                 .filter(model.bucket_start >= start_ms)
                 .filter(model.bucket_start < end_ms)
                 .group_by(model.symbol, grp))

    out = {}
    agg = base(db.query(
        model.symbol, grp.label("g"),
        func.max(model.high_price), func.min(model.low_price),
        func.coalesce(func.sum(model.buy_volume), 0.0),
        func.coalesce(func.sum(model.sell_volume), 0.0),
        func.coalesce(func.sum(model.trade_count), 0),
    )).all()
    for sym, g, hi, lo, buy, sell, trades in agg:
        out[(sym, int(g))] = [None, hi, lo, None, buy, sell, trades]

    opens = base(db.query(model.symbol, grp.label("g"),
                          func.min(model.bucket_start), model.open_price)).all()
    for sym, g, _, o in opens:
        row = out.get((sym, int(g)))
        if row:
            row[0] = o

    closes = base(db.query(model.symbol, grp.label("g"),
                           func.max(model.bucket_start), model.close_price)).all()
    for sym, g, _, c in closes:
        row = out.get((sym, int(g)))
        if row:
            row[3] = c
    return out


def _token_chain_map(db: Session) -> dict:
    """symbol → chain slug ('bsc'/'ethereum'/...); legacy numeric ids mapped."""
    out = {}
    for t in db.query(Token).all():
        cid = str(t.chain_id or "")
        out[t.symbol] = LEGACY_CHAIN_ID_MAP.get(cid, cid) or None
    return out


@app.get("/universe")
def get_universe(interval: str = "15m", start_ms: int | None = None,
                 end_ms: int | None = None, min_vol_24h: float = 50_000,
                 symbols: str | None = None, chains: str | None = None,
                 db: Session = Depends(get_db),
                 identity: Identity = Depends(require_paid)):
    """Multi-token resampled OHLC + buy/sell flow — the Token Finder dataset.

    One payload with a common time axis; the UI/SDK fetch it once and re-rank
    locally on every parameter tweak. Sources: one_min_buckets (~7 days), and
    for intervals >= 15m the fifteen_min_buckets archive extends the range
    (one-minute data wins where both cover a group).

    `chains` (optional, comma-separated slugs e.g. "bsc,base") filters the
    universe to those chains; each token entry carries its `chain` so the SDK
    passes it through to finder ctxs (DATA-ROADMAP M3).

    Returns { interval, times: [ms...], tokens: [{symbol, name, chain,
    volume24h, priceChange24h, o, h, l, c, buy, sell, trades}] } with arrays
    aligned to times and null where a token has no data for that bar.
    """
    if interval not in UNIVERSE_INTERVALS:
        raise HTTPException(status_code=422,
                            detail=f"Invalid interval '{interval}'. Allowed: {tuple(UNIVERSE_INTERVALS)}")
    interval_ms = UNIVERSE_INTERVALS[interval]

    now_ms = int(time.time() * 1000)
    if end_ms is None:
        end_ms = (now_ms // interval_ms) * interval_ms   # exclude the in-progress bar
    if start_ms is None:
        start_ms = end_ms - 3 * 24 * 3600 * 1000
    start_ms = (start_ms // interval_ms) * interval_ms
    n_bars = (end_ms - start_ms) // interval_ms
    if n_bars <= 0:
        raise HTTPException(status_code=422, detail="start_ms must be before end_ms")
    if n_bars > UNIVERSE_MAX_BARS:
        start_ms = end_ms - UNIVERSE_MAX_BARS * interval_ms
        n_bars = UNIVERSE_MAX_BARS

    # Universe = tracked tokens over the volume floor (or an explicit list).
    tickers = {t.symbol: t for t in db.query(LatestTicker).all()}
    names = {t.symbol: t.name for t in db.query(Token).all()}
    chain_of = _token_chain_map(db)
    if symbols:
        wanted = [s.strip() for s in symbols.split(",") if s.strip()]
    else:
        wanted = [s for s, t in tickers.items()
                  if (t.volume_24h or 0) >= min_vol_24h and s in names]
        wanted.sort(key=lambda s: tickers[s].volume_24h or 0, reverse=True)
    if chains:
        allowed = {c.strip() for c in chains.split(",") if c.strip()}
        wanted = [s for s in wanted if chain_of.get(s) in allowed]
    wanted = wanted[:UNIVERSE_MAX_TOKENS]
    if not wanted:
        return {"interval": interval, "times": [], "tokens": []}

    # Archive first (coarser, longer retention), then 1-minute data on top.
    grouped = {}
    if interval_ms >= 900_000:
        grouped.update(_grouped_ohlc(db, FifteenMinBucket, wanted, start_ms, end_ms, interval_ms))
    grouped.update(_grouped_ohlc(db, OneMinBucket, wanted, start_ms, end_ms, interval_ms))

    times = list(range(start_ms, end_ms, interval_ms))
    index = {t: i for i, t in enumerate(times)}
    by_symbol = defaultdict(list)                     # one pass over all groups
    for (s, g), row in grouped.items():
        i = index.get(g)
        if i is not None:
            by_symbol[s].append((i, row))
    tokens_out = []
    for sym in wanted:
        cells = by_symbol.get(sym)
        if not cells:
            continue        # token had no data in range — omit entirely
        o = [None] * n_bars; h = [None] * n_bars; l = [None] * n_bars; c = [None] * n_bars
        buy = [None] * n_bars; sell = [None] * n_bars; trades = [None] * n_bars
        for i, row in cells:
            o[i], h[i], l[i], c[i], buy[i], sell[i], trades[i] = row
        t = tickers.get(sym)
        tokens_out.append({
            "symbol": sym, "name": names.get(sym),
            "chain": chain_of.get(sym),
            "volume24h": (t.volume_24h if t else 0) or 0,
            "priceChange24h": (t.price_change_24h if t else 0) or 0,
            "o": o, "h": h, "l": l, "c": c,
            "buy": buy, "sell": sell, "trades": trades,
        })

    return {"interval": interval, "times": times, "tokens": tokens_out}


# ── Debug log schemas ──────────────────────────────────────────────────────

class LogCreate(BaseModel):
    source: str       # collector | engine | api | wallet
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

    class Config:
        from_attributes = True


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
    # the engine's stale-price guard reads it so a frozen collector price can
    # never drive a marker execution (DATA-ROADMAP M3).
    price_updated: dict = {}


# ── Debug log endpoints ────────────────────────────────────────────────────


@app.get("/debug/logs", response_model=List[LogResponse])
def get_debug_logs(
    level: str | None = None,       # comma-separated: "ERROR,TRADE,INFO"
    source: str | None = None,       # comma-separated: "collector,engine"
    limit: int = 200,
    since_ms: int | None = None,     # only return logs newer than this timestamp
    db: Session = Depends(get_db),
    identity: Identity = Depends(require_paid),
):
    """Get debug logs for this user PLUS shared 'system' logs (collector/api)."""
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
    """Ingest a debug log entry. An engine's logs are owned by its user; the
    shared collector/api processes (service identity) log as 'system'."""
    import time as _time
    owner = "system" if identity.is_service else identity.user_id
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
            or request.url.path.startswith("/flow")
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
    raw = "haven_" + secrets.token_urlsafe(32)
    row = ApiKey(
        id=str(uuid.uuid4()), user_id=identity.user_id,
        key_hash=hash_key(raw), label=body.label[:60] or "engine",
        created_at=int(time.time() * 1000),
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
def download_engine(identity: Identity = Depends(require_paid)):
    """Serve the packaged desktop engine zip (paid users only).

    The zip is built by tools/build_engine_zip.py into api/static/. If it isn't
    present the endpoint 404s with guidance rather than erroring cryptically.
    """
    from fastapi.responses import FileResponse
    zip_path = os.path.join(os.path.dirname(__file__), "static", "haven-engine.zip")
    if not os.path.exists(zip_path):
        raise HTTPException(status_code=404,
                            detail="Engine build not available yet. Run tools/build_engine_zip.py.")
    return FileResponse(zip_path, media_type="application/zip",
                        filename="haven-engine.zip")


# Shared infrastructure processes — one instance serves everyone, so their
# heartbeats are global. A user's own engine/runner heartbeats are namespaced
# "{process}@{user_id}" so each account sees only its own engine dot.
SHARED_PROCESSES = {"collector", "api"}


@app.get("/health")
def health_check(db: Session = Depends(get_db)):
    """Live status of shared processes (collector) + engine/runner.

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

    statuses = {}
    for row in db.query(Heartbeat).all():
        proc, _, owner = row.process.partition("@")
        if owner:                                  # a user's engine/runner
            continue                               # private — requires auth
        elif proc not in SHARED_PROCESSES and not SOLO_MODE:
            continue
        age_sec = (now_ms - row.last_heartbeat) / 1000
        statuses[proc] = {"status": bucket(age_sec), "last_seen_sec_ago": int(age_sec)}

    return statuses


class SecurityCheckBody(BaseModel):
    force: bool = False


@app.post("/security/check/{symbol}")
def security_check_token(symbol: str, body: SecurityCheckBody | None = None,
                         force: int = 0,
                         db: Session = Depends(get_db),
                         identity: Identity = Depends(require_paid)):
    """Pre-trade GoPlus gate — engine/UI call this BEFORE any approve/swap.

    Policy (product):
      - Chart is ALWAYS allowed (research).
      - Auto/strategy execution is blocked when risk is elevated (`blocked=true`)
        unless the marker carries a manual risk acknowledgment.
      - Manual trades may proceed after contract verify + risk ack; UI should
        recommend a small probe first.
    """
    from ingest.goplus import scan_one_token
    from ingest.chains import load_env_file
    from cmc_discover import trade_policy_from_security
    load_env_file()
    tok = db.query(Token).filter(Token.symbol == symbol).first()
    if not tok:
        raise HTTPException(status_code=404, detail="Token not found")
    if not tok.contract_address:
        policy = trade_policy_from_security(
            {"safe": False, "critical": ["no_contract"], "flags": []},
            status=tok.status,
        )
        return {
            "symbol": symbol, "safe": False, "blocked": True,
            "critical": ["no_contract"], "flags": [],
            "chart_allowed": True,
            "trade_policy": policy,
            "message": "No contract address — cannot trade.",
        }
    do_force = bool(force) or bool(body and body.force)
    if tok.status == "blacklisted" and not do_force:
        # Still return cached security if present; chart allowed.
        cached = None
        if tok.security_json:
            try:
                cached = json.loads(tok.security_json)
            except Exception:
                cached = None
        result = {
            **(cached or {}),
            "symbol": symbol,
            "safe": False,
            "blocked": True,
            "critical": list(dict.fromkeys(
                list((cached or {}).get("critical") or []) + ["blacklisted"]
            )),
            "flags": list(dict.fromkeys(
                list((cached or {}).get("flags") or []) + ["blacklisted"]
            )),
            "status": tok.status,
            "contract_address": tok.contract_address,
            "chain_id": tok.chain_id,
            "from_cache": True,
        }
    else:
        result = scan_one_token(db, tok, force=do_force, count_budget=True)
        db.refresh(tok)
        result["symbol"] = symbol
        result["status"] = tok.status
        result["contract_address"] = tok.contract_address
        result["chain_id"] = tok.chain_id

    policy = trade_policy_from_security(result, status=tok.status)
    result["chart_allowed"] = True
    result["trade_policy"] = policy
    # `blocked` = auto/strategy path must not trade without manual risk ack.
    if policy["mode"] == "elevated_risk":
        result["blocked"] = True
        result["message"] = (
            "ELEVATED RISK — chart OK. Manual trade requires contract verification "
            "and risk acknowledgment; start with a small probe. "
            f"Flags: {', '.join(result.get('critical') or result.get('flags') or [])}"
        )
    elif result.get("safe") is True:
        result["blocked"] = False
        result["message"] = "GoPlus clear — exact-amount approve allowed for this trade only."
    else:
        result["blocked"] = True
        result["message"] = "Incomplete security data — trade blocked until a clean scan or risk ack."
    return result


@app.get("/goplus/status")
def goplus_status(identity: Identity = Depends(require_paid)):
    """Quota + queue state for the GoPlus scanner (visible in Settings)."""
    from ingest.chains import load_env_file
    from ingest.goplus import GoPlusClient, eligible_tokens
    from database.db import SessionLocal as _SL
    load_env_file()
    client = GoPlusClient()
    usage = client._load_usage()
    db = _SL()
    try:
        need = len(eligible_tokens(db))
        scanned = db.query(Token).filter(Token.security_json.isnot(None)).count()
        blacklisted = db.query(Token).filter(Token.status == "blacklisted").count()
    finally:
        db.close()
    return {
        "configured": client.configured,
        "daily_budget": client.daily_budget,
        "day_used": int(usage.get("addresses") or 0),
        "remaining": client.remaining_budget(),
        "batch_size": client.batch_size,
        "min_interval_sec": client.min_interval,
        "refresh_days": client.refresh_days,
        "need_scan": need,
        "scanned_total": scanned,
        "blacklisted": blacklisted,
        "provider": "GoPlus Security",
        "docs": "https://gopluslabs.io/",
        # Clarify: this counter is Haven's self-limit, not GoPlus CU on the portal.
        "budget_kind": "local_address_cap",
        "budget_note": (
            "daily_budget/day_used count token addresses Haven allows itself to scan "
            "per UTC day (GOPLUS_DAILY_BUDGET). This is separate from GoPlus Compute "
            "Units (CU) shown in the GoPlus dashboard."
        ),
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

    A user's own engine/runner is namespaced "{process}@{user_id}" so each
    account tracks its own engine; shared infra (collector via the service key,
    or anything in solo mode) heartbeats under its plain process name.
    """
    from datetime import datetime, timezone
    now_ms = int(datetime.now(timezone.utc).timestamp() * 1000)
    proc = hb.process
    if not identity.is_service and not SOLO_MODE and proc not in SHARED_PROCESSES:
        proc = f"{proc}@{identity.user_id}"
    existing = db.query(Heartbeat).filter_by(process=proc).first()
    if existing:
        existing.last_heartbeat = now_ms
    else:
        db.add(Heartbeat(process=proc, last_heartbeat=now_ms))
    db.commit()
    return {"ok": True, "process": proc, "last_heartbeat": now_ms}


# Product-facing quality bar (matches chain liquidity floors after 2026-07-10).
# Tokens below this are retired by the collector; this is a hard API belt-and-
# suspenders filter so /signals and /tokens never re-surface thin junk.
MIN_TOKEN_LIQUIDITY_USD = float(os.environ.get("HAVEN_MIN_TOKEN_LIQUIDITY_USD", "100000"))
# Reject absurd market caps on the product surface (fake supply × price scams).
MAX_PRODUCT_MARKET_CAP = float(os.environ.get("HAVEN_MAX_PRODUCT_MCAP", str(50_000_000_000)))
# Prefer CMC-identified tokens; non-CMC allowed only with sane/unknown mcap.
REQUIRE_CMC_OR_SANE_MCAP = os.environ.get("HAVEN_REQUIRE_CMC_OR_SANE", "1") == "1"


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
    if REQUIRE_CMC_OR_SANE_MCAP:
        # Market-cap figures without cmc_id are untrusted — force NULL at write
        # time (apply_quality_filter). Here we also hide rows that still claim
        # an absurd mcap (belt and suspenders).
        from sqlalchemy import or_
        q = q.filter(or_(
            Token.market_cap.is_(None),
            Token.cmc_id.isnot(None),
            Token.market_cap <= 1_000_000_000,
        ))
    return q


@app.get("/tokens", response_model=List[TokenResponse])
def get_tokens(skip: int = 0, limit: int = 100, status: str = "active",
               min_liquidity: float | None = None,
               quality: bool = True,
               db: Session = Depends(get_db),
               identity: Identity = Depends(require_paid)):
    """Retrieve the list of tracked tokens (shared market data).

    `status=active` (default) hides staged/retired rows. By default also
    requires liquidity_usd >= $100k and blocks absurd/fake market caps.
    Pass min_liquidity=0&quality=false for wallet balance scans.
    """
    q = db.query(Token)
    if status != "all":
        # Legacy rows predate the status column; NULL counts as active.
        q = q.filter((Token.status == status) | (Token.status.is_(None))) \
            if status == "active" else q.filter(Token.status == status)
    floor = MIN_TOKEN_LIQUIDITY_USD if min_liquidity is None else float(min_liquidity)
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
    cmc_id: int | None = None
    cmc_rank: int | None = None
    cmc_slug: str | None = None
    market_cap: float | None = None
    logo_url: str | None = None
    status: str | None = None
    liquidity_usd: float | None = None


@app.get("/tokens/search", response_model=List[TokenSearchHit])
def search_tokens_endpoint(
    q: str = "",
    limit: int = 12,
    identity: Identity = Depends(require_paid),
):
    """Typeahead for screener — local DB first, then CMC public search."""
    from cmc_discover import search_tokens
    q = (q or "").strip()
    if len(q) < 1:
        return []
    limit = max(1, min(int(limit or 12), 25))
    try:
        return search_tokens(q, limit=limit)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Search failed: {e}")


class TokenEnsureBody(BaseModel):
    cmc_id: int | None = None
    chain: str | None = None
    contract_address: str | None = None
    display: str | None = None
    name: str | None = None
    cmc_slug: str | None = None
    cmc_rank: int | None = None
    market_cap: float | None = None
    price: float | None = None
    volume_24h: float | None = None
    price_change_24h: float | None = None
    backfill: bool = True
    scan_security: bool = True


@app.post("/tokens/ensure")
def ensure_token_endpoint(
    body: TokenEnsureBody,
    identity: Identity = Depends(require_paid),
):
    """Add/refresh a CMC (or contract) token, backfill chart history, GoPlus scan.

    Chart is always allowed. Elevated risk is returned in trade_policy — UI
    still opens the chart and only gates trading with acknowledgments.
    """
    from cmc_discover import ensure_token, trade_policy_from_security
    try:
        result = ensure_token(
            cmc_id=body.cmc_id,
            chain=body.chain,
            contract_address=body.contract_address,
            display=body.display,
            name=body.name,
            cmc_slug=body.cmc_slug,
            cmc_rank=body.cmc_rank,
            market_cap=body.market_cap,
            price=body.price,
            volume_24h=body.volume_24h,
            price_change_24h=body.price_change_24h,
            backfill=body.backfill,
            scan_security=body.scan_security,
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Ensure failed: {e}")

    sec = result.get("security") if isinstance(result.get("security"), dict) else None
    result["trade_policy"] = trade_policy_from_security(sec, status=result.get("status"))
    result["chart_allowed"] = True
    return result


@app.get("/tokens/{symbol}", response_model=TokenResponse)
def get_token(symbol: str, db: Session = Depends(get_db),
              identity: Identity = Depends(require_paid)):
    """One token row by slug — the chart's chain badge / explorer link lookup."""
    tok = db.query(Token).filter(Token.symbol == symbol).first()
    if not tok:
        raise HTTPException(status_code=404, detail="Token not found")
    return _token_to_response(tok)


@app.get("/chains")
def get_chains(identity: Identity = Depends(require_paid)):
    """Chain registry for UI filters/badges (DATA-ROADMAP M1, AD-D3)."""
    from ingest.chains import chain_public_info
    return chain_public_info()

@app.get("/signals", response_model=List[SignalResponse])
def get_top_signals(limit: int = 400, sort_by: str = "flow_1m", db: Session = Depends(get_db),
                    identity: Identity = Depends(require_paid)):
    """Retrieve signals computed from 1-minute buckets + latest tickers.

    Aggregation happens in SQL (one GROUP BY over the last hour of buckets)
    instead of pulling every row into Python. Tokens without recent activity
    return zero flows.
    """
    from datetime import datetime, timezone

    now_ms = int(datetime.now(timezone.utc).timestamp() * 1000)
    current_minute = (now_ms // 60_000) * 60_000

    # Completed minutes only (exclude the in-progress bucket)
    one_min_ago = current_minute - 60_000
    five_min_ago = current_minute - 5 * 60_000
    fifteen_min_ago = current_minute - 15 * 60_000
    one_hour_ago = current_minute - 60 * 60_000

    def window_sum(col, threshold):
        """SUM(col) over buckets at/after threshold, 0 elsewhere — SQLite side."""
        return func.coalesce(func.sum(case((OneMinBucket.bucket_start >= threshold, col), else_=0.0)), 0.0)

    # One grouped scan of the last hour, all four windows via conditional sums.
    agg_rows = (
        db.query(
            OneMinBucket.symbol.label("symbol"),
            window_sum(OneMinBucket.buy_volume, one_min_ago).label("buy_1m"),
            window_sum(OneMinBucket.sell_volume, one_min_ago).label("sell_1m"),
            window_sum(OneMinBucket.buy_volume, five_min_ago).label("buy_5m"),
            window_sum(OneMinBucket.sell_volume, five_min_ago).label("sell_5m"),
            window_sum(OneMinBucket.buy_volume, fifteen_min_ago).label("buy_15m"),
            window_sum(OneMinBucket.sell_volume, fifteen_min_ago).label("sell_15m"),
            window_sum(OneMinBucket.buy_volume, one_hour_ago).label("buy_1h"),
            window_sum(OneMinBucket.sell_volume, one_hour_ago).label("sell_1h"),
            func.coalesce(func.sum(OneMinBucket.trade_count), 0).label("trade_count"),
        )
        .filter(OneMinBucket.bucket_start >= one_hour_ago)
        .filter(OneMinBucket.bucket_start < current_minute)
        .group_by(OneMinBucket.symbol)
        .all()
    )
    agg_map = {r.symbol: r for r in agg_rows}

    # Tickers + names + market caps. Only quality tokens: active + min liquidity
    # + no absurd fake mcap (retired/thin/scam rows stay out of the screener).
    ticker_rows = {t.symbol: t for t in db.query(LatestTicker).all()}
    token_q = db.query(Token).filter(
        (Token.status == "active") | (Token.status.is_(None))
    )
    token_q = _product_token_filters(
        token_q, floor=MIN_TOKEN_LIQUIDITY_USD, enforce_quality=True)
    token_rows = token_q.all()
    token_map = {t.symbol: t for t in token_rows}

    signals = []
    for symbol, tok in token_map.items():
        a = agg_map.get(symbol)
        ticker = ticker_rows.get(symbol)
        buy_1m = a.buy_1m if a else 0.0
        sell_1m = a.sell_1m if a else 0.0
        buy_5m = a.buy_5m if a else 0.0
        sell_5m = a.sell_5m if a else 0.0
        buy_15m = a.buy_15m if a else 0.0
        sell_15m = a.sell_15m if a else 0.0
        buy_1h = a.buy_1h if a else 0.0
        sell_1h = a.sell_1h if a else 0.0

        last_px = ticker.last_price if ticker and (ticker.last_price or 0) > 0 else None
        signals.append(
            SignalResponse(
                symbol=symbol,
                name=tok.name,
                display_symbol=tok.display_symbol,
                timestamp=current_minute,
                buy_vol_1m=buy_1m,
                sell_vol_1m=sell_1m,
                net_flow_1m=buy_1m - sell_1m,
                buy_vol_5m=buy_5m,
                sell_vol_5m=sell_5m,
                net_flow_5m=buy_5m - sell_5m,
                buy_vol_15m=buy_15m,
                sell_vol_15m=sell_15m,
                net_flow_15m=buy_15m - sell_15m,
                buy_vol_1h=buy_1h,
                sell_vol_1h=sell_1h,
                net_flow_1h=buy_1h - sell_1h,
                trade_count=a.trade_count if a else 0,
                price_change_24h=ticker.price_change_24h if ticker else 0.0,
                volume_24h=ticker.volume_24h if ticker else 0.0,
                market_cap=tok.market_cap or 0.0,
                last_price=last_px,
            )
        )

    # Sort
    if sort_by == "vol_spike":
        # Tokens with >$10M 24h volume, sorted by (1h Total Vol) / (Average Hourly Vol)
        signals = [
            s for s in signals if s.volume_24h > 10_000_000
        ]
        signals.sort(
            key=lambda s: (s.buy_vol_1h + s.sell_vol_1h) / (s.volume_24h / 24) if s.volume_24h > 0 else 0,
            reverse=True,
        )
    elif sort_by == "vol_24h":
        signals.sort(key=lambda s: s.volume_24h, reverse=True)
    elif sort_by == "price_change_24h":
        signals.sort(key=lambda s: s.price_change_24h, reverse=True)
    elif sort_by == "market_cap":
        # Tokens with no trusted mcap sink to the bottom (not the top as zeros
        # would if we reverse-sorted missing as 0 — we put missing last).
        signals.sort(
            key=lambda s: (s.market_cap is not None and s.market_cap > 0, s.market_cap or 0.0),
            reverse=True,
        )
    elif sort_by == "mcap_vol":
        # Composite score: log(market_cap) + log(volume_24h) — rewards tokens
        # that are both large and actively traded.
        import math
        signals.sort(
            key=lambda s: (math.log10(s.market_cap + 1) + math.log10(s.volume_24h + 1)
                           if s.market_cap and s.market_cap > 0 else 0.0),
            reverse=True,
        )
    elif sort_by == "flow_15m":
        signals.sort(key=lambda s: s.net_flow_15m, reverse=True)
    else:
        # Default: flow_1m
        signals.sort(key=lambda s: s.net_flow_1m, reverse=True)

    return signals[:limit]

# ── In-app coding assistant (DeepSeek proxy) ─────────────────────────────────
# The chart UI embeds a chat window under the code editor on the Strategies and
# Token Finder pages. The DeepSeek key stays server-side (repo-root .env); the
# browser only ever talks to this proxy. Scoped by `mode` to helping the user
# write the strategy/finder JS for the page it is on.

_DEEPSEEK_KEY = None            # cached once found
_SDK_DOC_CACHE = {}
DEEPSEEK_URL = "https://api.deepseek.com/chat/completions"
DEEPSEEK_MODEL = "deepseek-v4-flash"


def _load_deepseek_key():
    """Read `deepseek_v4_flash_key` from the repo-root .env (env var wins)."""
    global _DEEPSEEK_KEY
    if _DEEPSEEK_KEY:
        return _DEEPSEEK_KEY
    key = os.environ.get("deepseek_v4_flash_key") or os.environ.get("DEEPSEEK_V4_FLASH_KEY")
    if not key:
        env_path = os.path.join(os.path.dirname(__file__), "..", "..", ".env")
        try:
            with open(env_path, "r", encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if not line or line.startswith("#") or "=" not in line:
                        continue
                    k, _, v = line.partition("=")
                    if k.strip().lower() == "deepseek_v4_flash_key":
                        key = v.strip().strip('"').strip("'")
                        break
        except OSError:
            key = None
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
                "Alpha Terminal trading app. Your ONLY job is to help the user write and "
                "debug the JavaScript for a Token Finder — a `finder` object that ranks "
                "tokens (params, optional filter(ctx), required score(ctx)).")
        contract = _read_sdk_doc("finder-contract.md")
    else:
        role = ("You are a coding assistant embedded in the Strategies page of the Alpha "
                "Terminal trading app. Your ONLY job is to help the user write and debug "
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
                         identity: Identity = Depends(require_paid)):
    """Proxy a coding-assistant chat turn to DeepSeek (key stays server-side).

    Paid-gated: each call costs us DeepSeek tokens, so it's Pro-only (there is
    no free tier anyway — require_paid covers it)."""
    key = _load_deepseek_key()
    if not key:
        raise HTTPException(
            status_code=503,
            detail="AI assistant not configured: set deepseek_v4_flash_key in the .env file.")
    mode = req.mode if req.mode in ("strategy", "finder") else "strategy"
    # We own the system prompt; only forward user/assistant turns from the client.
    convo = [{"role": m.role, "content": m.content}
             for m in req.messages
             if m.role in ("user", "assistant") and m.content]
    if not convo:
        raise HTTPException(status_code=422, detail="No message to send.")
    convo = convo[-20:]   # cap history length

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


def _resolve_bucket_symbol(db: Session, symbol: str) -> str:
    """Symbols are used as-is (slugs post-cutover); a legacy caller passing an
    un-prefixed Binance name still resolves via the historical ALPHA_ prefix."""
    if db.query(LatestTicker).filter(LatestTicker.symbol == symbol).first():
        return symbol
    if not symbol.startswith("ALPHA_"):
        legacy = f"ALPHA_{symbol}"
        if db.query(LatestTicker).filter(LatestTicker.symbol == legacy).first():
            return legacy
    return symbol


@app.get("/klines/{symbol}")
def get_klines(symbol: str, interval: str = "5m", limit: int = 500,
               end_ms: int | None = None, include_open: int = 0,
               db: Session = Depends(get_db),
               identity: Identity = Depends(require_paid)):
    """Historical klines served from OUR buckets (DATA-ROADMAP AD-D9).

    Same array layout the Binance proxy returned — {data: [[open_time_ms, o, h,
    l, c, volume, close_time_ms], ...]} with string prices — so the chart, the
    workbench backtester, and the strategy runner stay byte-compatible
    consumers. `volume` is buy+sell USD (our buckets carry no token-qty
    volume). Interior/trailing gaps are forward-filled flat with volume 0,
    matching the continuous-bar series Binance emitted.

    end_ms: return candles at/before that timestamp (performance-chart jumps).
    include_open=1: append the still-forming bar (built from the current
    interval's 1m buckets + the live ticker price) — Chart.jsx polls this
    every ~3s as the replacement for the old Binance kline WebSocket.

    Sources: one_min_buckets (~7-day retention) resampled SQL-side, plus the
    fifteen_min_buckets archive for >=15m intervals (1m data wins where both
    cover a group — same rule as /universe).
    """
    if interval not in KLINE_INTERVALS:
        raise HTTPException(status_code=422,
                            detail=f"Invalid interval '{interval}'. Allowed: {tuple(KLINE_INTERVALS)}")
    interval_ms = KLINE_INTERVALS[interval]
    limit = max(1, min(limit, KLINES_MAX_LIMIT))

    now_ms = int(time.time() * 1000)
    current_group = now_ms - (now_ms % interval_ms)
    last_group = current_group - interval_ms          # newest CLOSED bar
    if end_ms is not None:
        last_group = min((end_ms // interval_ms) * interval_ms, last_group)
    start_group = last_group - (limit - 1) * interval_ms

    sym = _resolve_bucket_symbol(db, symbol)
    grouped = {}
    if interval_ms >= 86_400_000:
        grouped.update(_grouped_ohlc(db, DailyBucket, [sym], start_group,
                                     last_group + interval_ms, interval_ms))
    if interval_ms >= 900_000:
        grouped.update(_grouped_ohlc(db, FifteenMinBucket, [sym], start_group,
                                     last_group + interval_ms, interval_ms))
    grouped.update(_grouped_ohlc(db, OneMinBucket, [sym], start_group,
                                 last_group + interval_ms, interval_ms))

    # Fallback: if no data in the time-based window (collector was down or
    # data is older than the requested window), anchor to the most recent
    # available bucket instead of leaving the chart empty. Skip when the
    # caller gave an explicit end_ms (performance-chart jump-back).
    if not grouped and end_ms is None:
        latest = db.query(func.max(OneMinBucket.bucket_start)).filter(
            OneMinBucket.symbol == sym).scalar()
        if latest:
            last_group = latest - (latest % interval_ms)
            start_group = last_group - (limit - 1) * interval_ms
            if interval_ms >= 86_400_000:
                grouped.update(_grouped_ohlc(db, DailyBucket, [sym],
                                             start_group,
                                             last_group + interval_ms, interval_ms))
            if interval_ms >= 900_000:
                grouped.update(_grouped_ohlc(db, FifteenMinBucket, [sym],
                                             start_group,
                                             last_group + interval_ms, interval_ms))
            grouped.update(_grouped_ohlc(db, OneMinBucket, [sym], start_group,
                                         last_group + interval_ms, interval_ms))

    data = []
    prev_close = None
    if grouped:
        first_group = min(g for (_, g) in grouped)
        for g in range(first_group, last_group + interval_ms, interval_ms):
            row = grouped.get((sym, g))
            if row:
                o, h, l, c, buy, sell, _ = row
                vol = (buy or 0.0) + (sell or 0.0)
                prev_close = c
            elif prev_close is not None:
                o = h = l = c = prev_close                 # quiet bar — flat fill
                vol = 0.0
            else:
                continue
            data.append([g, str(o), str(h), str(l), str(c), str(vol),
                         g + interval_ms - 1])

    if include_open:
        forming = _grouped_ohlc(db, OneMinBucket, [sym], current_group,
                                current_group + interval_ms, interval_ms
                                ).get((sym, current_group))
        ticker = (db.query(LatestTicker)
                  .filter(LatestTicker.symbol == sym).first())
        live = ticker.last_price if ticker and (ticker.last_price or 0) > 0 else None
        o = h = l = c = None
        vol = 0.0
        if forming:
            o, h, l, c, buy, sell, _ = forming
            vol = (buy or 0.0) + (sell or 0.0)
        if live is not None:
            c = live
            o = o if o is not None else (prev_close if prev_close is not None else live)
            h = max(h, live) if h is not None else max(o, live)
            l = min(l, live) if l is not None else min(o, live)
        elif forming is None and prev_close is not None:
            o = h = l = c = prev_close
        if c is not None:
            data.append([current_group, str(o), str(h), str(l), str(c),
                         str(vol), current_group + interval_ms - 1])

    return {"code": "000000", "message": None, "symbol": sym,
            "interval": interval, "data": data}


@app.get("/flow/{symbol}")
def get_flow(symbol: str, start_ms: int | None = None, end_ms: int | None = None,
             limit: int = 10080, db: Session = Depends(get_db),
             identity: Identity = Depends(require_paid)):
    """Raw 1-minute buy/sell USD flow buckets for strategy backtests.

    Returns ascending [[bucket_start_ms, buy_volume, sell_volume, trade_count], ...].
    The collector prunes buckets after ~7 days (= 10080 minutes), so this is the
    maximum honest lookback for flow-based strategies.
    """
    alpha_symbol = _resolve_bucket_symbol(db, symbol)
    q = db.query(OneMinBucket).filter(OneMinBucket.symbol == alpha_symbol)
    if start_ms is not None:
        q = q.filter(OneMinBucket.bucket_start >= start_ms)
    if end_ms is not None:
        q = q.filter(OneMinBucket.bucket_start < end_ms)
    limit = max(1, min(limit, 10080))
    # Newest N rows, then flip ascending — a plain ascending LIMIT would return
    # the oldest window instead of the most recent one.
    rows = q.order_by(desc(OneMinBucket.bucket_start)).limit(limit).all()
    rows.reverse()
    return {
        "symbol": alpha_symbol,
        "data": [[r.bucket_start, r.buy_volume, r.sell_volume, r.trade_count] for r in rows],
    }

