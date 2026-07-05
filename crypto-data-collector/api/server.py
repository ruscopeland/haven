from fastapi import FastAPI, Depends, HTTPException
from sqlalchemy.orm import Session
from sqlalchemy import desc, func, case
from database.db import get_db, engine, Base, ensure_db_settings
from database.models import (
    Token, OneMinBucket, LatestTicker, Heartbeat, ChartMarker, TradeHistory,
    DebugLog, EngineSetting, Strategy, Finder, FifteenMinBucket,
    MARKER_TYPES, STRATEGY_MODES, FINDER_INTERVALS,
)
from fetcher.alpha_api import BinanceAlphaAPI
from pydantic import BaseModel
from typing import List, Any
from collections import defaultdict
from fastapi.middleware.cors import CORSMiddleware
from fastapi import Request
from contextlib import asynccontextmanager
import asyncio
import time
import json


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Ensure tables exist before serving (replaces deprecated @app.on_event).
    Base.metadata.create_all(bind=engine)
    ensure_db_settings()  # WAL + bucket_start index
    print("Database tables ensured on startup.")
    yield


app = FastAPI(title="Crypto Data Collector API", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

class TokenResponse(BaseModel):
    id: str
    symbol: str
    name: str | None
    chain_id: str | None
    contract_address: str | None

    class Config:
        from_attributes = True

class SignalResponse(BaseModel):
    symbol: str
    name: str | None = None
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
def get_markers(symbol: str, active_only: bool = True, db: Session = Depends(get_db)):
    """Get all markers for a symbol."""
    q = db.query(ChartMarker).filter(ChartMarker.symbol == symbol)
    if active_only:
        q = q.filter(ChartMarker.active == 1)
    return q.order_by(ChartMarker.price).all()


VALID_MARKER_DIRECTIONS = ("above", "below", "cross")


@app.post("/markers", response_model=MarkerResponse)
def create_marker(m: MarkerCreate, db: Session = Depends(get_db)):
    """Create a new marker."""
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
def update_marker(marker_id: str, m: MarkerUpdate, db: Session = Depends(get_db)):
    """Update a marker's price, label, or active status."""
    marker = db.query(ChartMarker).filter(ChartMarker.id == marker_id).first()
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
def claim_marker(marker_id: str, db: Session = Depends(get_db)):
    """Atomically claim a marker for execution.

    Sets active 1 -> 0 in a single conditional UPDATE and reports whether THIS caller
    won the claim. Because SQLite serializes writes, only one racing caller (across
    duplicate poll loops, browser tabs, or processes) can get claimed=True, so a marker
    executes exactly once. Callers that lose the race must not execute.
    """
    from datetime import datetime, timezone
    now_ms = int(datetime.now(timezone.utc).timestamp() * 1000)
    updated = (
        db.query(ChartMarker)
        .filter(ChartMarker.id == marker_id, ChartMarker.active == 1)
        .update({ChartMarker.active: 0, ChartMarker.triggered_at: now_ms})
    )
    db.commit()
    return {"claimed": updated == 1}


@app.delete("/markers/{marker_id}")
def delete_marker(marker_id: str, db: Session = Depends(get_db)):
    """Delete a marker."""
    marker = db.query(ChartMarker).filter(ChartMarker.id == marker_id).first()
    if not marker:
        from fastapi import HTTPException
        raise HTTPException(status_code=404, detail="Marker not found")
    db.delete(marker)
    db.commit()
    return {"ok": True}


# ── Trade endpoints ────────────────────────────────────────────────────────


@app.get("/trades", response_model=List[TradeResponse])
def get_trades(symbol: str | None = None, limit: int = 50, status: str | None = None,
               strategy_id: str | None = None, db: Session = Depends(get_db)):
    """Get trade history, optionally filtered by symbol/status/strategy."""
    q = db.query(TradeHistory)
    if symbol:
        q = q.filter(TradeHistory.symbol == symbol)
    if status:
        q = q.filter(TradeHistory.status == status)
    if strategy_id:
        q = q.filter(TradeHistory.strategy_id == strategy_id)
    return q.order_by(TradeHistory.block_time.desc()).limit(limit).all()


@app.post("/trades", response_model=TradeResponse)
def create_trade(t: TradeCreate, db: Session = Depends(get_db)):
    """Record a filled trade from the execution engine."""
    import uuid
    trade = TradeHistory(
        id=str(uuid.uuid4()),
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


def _validate_token_selection(db: Session, symbol: str, finder_id: str | None,
                              max_positions: int | None, switch_margin_pct: float | None):
    """A strategy needs exactly one token source: a symbol, or a finder."""
    if finder_id:
        if not db.query(Finder).filter(Finder.id == finder_id).first():
            raise HTTPException(status_code=422, detail=f"Finder '{finder_id}' does not exist")
    elif not symbol:
        raise HTTPException(status_code=422,
                            detail="Strategy needs a symbol, or a finder_id for dynamic selection")
    if max_positions is not None and not (1 <= max_positions <= 10):
        raise HTTPException(status_code=422, detail="max_positions must be between 1 and 10")
    if switch_margin_pct is not None and not (0 <= switch_margin_pct <= 100):
        raise HTTPException(status_code=422, detail="switch_margin_pct must be between 0 and 100")


@app.get("/strategies", response_model=List[StrategyListItem])
def list_strategies(db: Session = Depends(get_db)):
    """List strategies without their code bodies (the runner + UI list poll this)."""
    return db.query(Strategy).order_by(Strategy.created_at).all()


@app.get("/strategies/{strategy_id}", response_model=StrategyResponse)
def get_strategy(strategy_id: str, db: Session = Depends(get_db)):
    strat = db.query(Strategy).filter(Strategy.id == strategy_id).first()
    if not strat:
        raise HTTPException(status_code=404, detail="Strategy not found")
    return strat


@app.post("/strategies", response_model=StrategyResponse)
def create_strategy(s: StrategyCreate, db: Session = Depends(get_db)):
    import uuid
    _validate_strategy_fields(s.interval, None)
    _validate_token_selection(db, s.symbol, s.finder_id, s.max_positions, s.switch_margin_pct)
    now_ms = int(time.time() * 1000)
    strat = Strategy(
        id=str(uuid.uuid4()), name=s.name, code=s.code,
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
def update_strategy(strategy_id: str, s: StrategyUpdate, db: Session = Depends(get_db)):
    """Update a strategy.

    updated_at bumps ONLY when the strategy definition changes (code / params /
    symbol / interval) — the runner uses it as its hot-reload signal, and a
    mode flip or status write must not reset a running strategy's state.
    """
    strat = db.query(Strategy).filter(Strategy.id == strategy_id).first()
    if not strat:
        raise HTTPException(status_code=404, detail="Strategy not found")
    _validate_strategy_fields(s.interval, s.mode)
    # Validate the token selection the row will END UP with after this patch.
    next_symbol = s.symbol if s.symbol is not None else strat.symbol
    next_finder = None if s.clear_finder else (s.finder_id if s.finder_id is not None else strat.finder_id)
    _validate_token_selection(db, next_symbol, next_finder, s.max_positions, s.switch_margin_pct)

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


@app.delete("/strategies/{strategy_id}")
def delete_strategy(strategy_id: str, db: Session = Depends(get_db)):
    """Delete a strategy AND any still-active markers it posted (a queued
    STRAT_BUY/STRAT_SELL must not fire for a strategy that no longer exists)."""
    strat = db.query(Strategy).filter(Strategy.id == strategy_id).first()
    if not strat:
        raise HTTPException(status_code=404, detail="Strategy not found")
    orphaned = (db.query(ChartMarker)
                .filter(ChartMarker.strategy_id == strategy_id, ChartMarker.active == 1)
                .delete())
    db.delete(strat)
    db.commit()
    return {"ok": True, "deleted_active_markers": orphaned}


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
def list_finders(db: Session = Depends(get_db)):
    """List finders without code bodies (UI list + engine evaluator poll this)."""
    return db.query(Finder).order_by(Finder.created_at).all()


@app.get("/finders/{finder_id}", response_model=FinderResponse)
def get_finder(finder_id: str, db: Session = Depends(get_db)):
    f = db.query(Finder).filter(Finder.id == finder_id).first()
    if not f:
        raise HTTPException(status_code=404, detail="Finder not found")
    return f


@app.post("/finders", response_model=FinderResponse)
def create_finder(f: FinderCreate, db: Session = Depends(get_db)):
    import uuid
    _validate_finder_interval(f.interval)
    now_ms = int(time.time() * 1000)
    finder = Finder(
        id=str(uuid.uuid4()), name=f.name, code=f.code, interval=f.interval,
        params_json=f.params_json, created_at=now_ms, updated_at=now_ms,
    )
    db.add(finder)
    db.commit()
    db.refresh(finder)
    return finder


@app.patch("/finders/{finder_id}", response_model=FinderResponse)
def update_finder(finder_id: str, f: FinderUpdate, db: Session = Depends(get_db)):
    """updated_at bumps ONLY on definition changes (code/params/interval) —
    status writes (last_run_at/last_error) must not reset live evaluators."""
    finder = db.query(Finder).filter(Finder.id == finder_id).first()
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
def delete_finder(finder_id: str, db: Session = Depends(get_db)):
    """Delete a finder — refused while any strategy still references it, so a
    running portfolio strategy can never lose its token source mid-flight."""
    finder = db.query(Finder).filter(Finder.id == finder_id).first()
    if not finder:
        raise HTTPException(status_code=404, detail="Finder not found")
    users = db.query(Strategy).filter(Strategy.finder_id == finder_id).all()
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


@app.get("/universe")
def get_universe(interval: str = "15m", start_ms: int | None = None,
                 end_ms: int | None = None, min_vol_24h: float = 50_000,
                 symbols: str | None = None, db: Session = Depends(get_db)):
    """Multi-token resampled OHLC + buy/sell flow — the Token Finder dataset.

    One payload with a common time axis; the UI/SDK fetch it once and re-rank
    locally on every parameter tweak. Sources: one_min_buckets (~7 days), and
    for intervals >= 15m the fifteen_min_buckets archive extends the range
    (one-minute data wins where both cover a group).

    Returns { interval, times: [ms...], tokens: [{symbol, name, volume24h,
    priceChange24h, o, h, l, c, buy, sell, trades}] } with arrays aligned to
    times and null where a token has no data for that bar.
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
    if symbols:
        wanted = [s.strip() for s in symbols.split(",") if s.strip()]
    else:
        wanted = [s for s, t in tickers.items()
                  if (t.volume_24h or 0) >= min_vol_24h and s in names]
        wanted.sort(key=lambda s: tickers[s].volume_24h or 0, reverse=True)
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


# ── Debug log endpoints ────────────────────────────────────────────────────


@app.get("/debug/logs", response_model=List[LogResponse])
def get_debug_logs(
    level: str | None = None,       # comma-separated: "ERROR,TRADE,INFO"
    source: str | None = None,       # comma-separated: "collector,engine"
    limit: int = 200,
    since_ms: int | None = None,     # only return logs newer than this timestamp
    db: Session = Depends(get_db),
):
    """Get debug logs with optional level/source/time filtering."""
    q = db.query(DebugLog)
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
def create_debug_log(entry: LogCreate, db: Session = Depends(get_db)):
    """Ingest a debug log entry from any program."""
    import time as _time
    log_entry = DebugLog(
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
def clear_debug_logs(db: Session = Depends(get_db)):
    """Clear all debug logs (truncate the table)."""
    count = db.query(DebugLog).count()
    db.query(DebugLog).delete()
    db.commit()
    return {"deleted": count}


# ── Dashboard overview endpoint ────────────────────────────────────────────


@app.get("/dashboard/overview", response_model=DashboardOverview)
def get_dashboard_overview(db: Session = Depends(get_db)):
    """Return all trading data needed by the wallet dashboard in one call."""
    # All REAL trades, newest first, joined with markers for reason. PAPER rows
    # (strategy dry-runs) are excluded here on purpose: the wallet PnL sums
    # every row it receives, the engine's daily-cap counter reads this list,
    # and a chatty dry-run would otherwise flood the 200-row window.
    trades = (db.query(TradeHistory)
              .filter(TradeHistory.status != "PAPER")
              .order_by(TradeHistory.block_time.desc()).limit(200).all())
    all_marker_ids = [t.marker_id for t in trades if t.marker_id]
    markers_map = {}
    if all_marker_ids:
        marker_rows = db.query(ChartMarker).filter(ChartMarker.id.in_(all_marker_ids)).all()
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

    # Active markers
    open_markers = db.query(ChartMarker).filter(ChartMarker.active == 1).order_by(ChartMarker.created_at.desc()).limit(100).all()

    # Latest prices per symbol
    tickers = db.query(LatestTicker).all()
    token_prices = {t.symbol: t.last_price for t in tickers if t.last_price and t.last_price > 0}

    return DashboardOverview(
        trades=trade_responses,
        open_markers=[MarkerResponse.model_validate(m) for m in open_markers],
        token_prices=token_prices,
    )


# ── API request/response logging middleware ────────────────────────────────

# Endpoints polled every few seconds by the UIs/engine. Logging these to the DB
# generated millions of debug_logs rows (the main DB bloat) while adding no
# diagnostic value — the pollers themselves report failures.
NOISY_PATHS = {
    "/", "/health", "/heartbeat", "/signals", "/tokens",
    "/dashboard/overview", "/debug/logs", "/engine/settings", "/favicon.ico",
}


@app.middleware("http")
async def debug_log_middleware(request: Request, call_next):
    """Log non-polling API requests/responses to the debug_logs table."""
    if (request.url.path in NOISY_PATHS
            or request.url.path.startswith("/klines")
            or request.url.path.startswith("/flow")
            or request.url.path.startswith("/strategies")
            or request.url.path.startswith("/finders")      # UI + evaluator poll
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
    return {"message": "Crypto Data Collector API is running. Check /docs for endpoints."}


@app.get("/health")
def health_check(db: Session = Depends(get_db)):
    """Returns live status of all background processes."""
    now_ms = 0
    from datetime import datetime, timezone
    now_ms = int(datetime.now(timezone.utc).timestamp() * 1000)

    rows = db.query(Heartbeat).all()
    statuses = {}
    for row in rows:
        age_sec = (now_ms - row.last_heartbeat) / 1000
        if age_sec < 60:
            statuses[row.process] = {"status": "ok", "last_seen_sec_ago": int(age_sec)}
        elif age_sec < 180:
            statuses[row.process] = {"status": "warning", "last_seen_sec_ago": int(age_sec)}
        else:
            statuses[row.process] = {"status": "down", "last_seen_sec_ago": int(age_sec)}

    return statuses

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


@app.get("/engine/settings")
def get_engine_settings(db: Session = Depends(get_db)):
    """Current engine settings (stored values merged over defaults)."""
    stored = {r.key: r.value for r in db.query(EngineSetting).all()}
    merged = {**ENGINE_SETTING_DEFAULTS, **stored}
    return {
        "paused": int(merged["paused"]),
        "max_trades_per_day": int(float(merged["max_trades_per_day"])),
        "max_trade_usd": float(merged["max_trade_usd"]),
        "max_price_impact_pct": float(merged["max_price_impact_pct"]),
        "max_retry_attempts": int(float(merged["max_retry_attempts"])),
    }


@app.patch("/engine/settings")
def update_engine_settings(u: EngineSettingsUpdate, db: Session = Depends(get_db)):
    """Update one or more engine settings (partial update)."""
    for key, val in u.model_dump(exclude_none=True).items():
        row = db.query(EngineSetting).filter(EngineSetting.key == key).first()
        if row:
            row.value = str(val)
        else:
            db.add(EngineSetting(key=key, value=str(val)))
    db.commit()
    return get_engine_settings(db)


class HeartbeatCreate(BaseModel):
    process: str


@app.post("/heartbeat")
def write_heartbeat(hb: HeartbeatCreate, db: Session = Depends(get_db)):
    """Record a liveness heartbeat for a process (e.g. the wallet executor)."""
    from datetime import datetime, timezone
    now_ms = int(datetime.now(timezone.utc).timestamp() * 1000)
    existing = db.query(Heartbeat).filter_by(process=hb.process).first()
    if existing:
        existing.last_heartbeat = now_ms
    else:
        db.add(Heartbeat(process=hb.process, last_heartbeat=now_ms))
    db.commit()
    return {"ok": True, "process": hb.process, "last_heartbeat": now_ms}


@app.get("/tokens", response_model=List[TokenResponse])
def get_tokens(skip: int = 0, limit: int = 100, db: Session = Depends(get_db)):
    """Retrieve the list of tracked Alpha tokens."""
    tokens = db.query(Token).offset(skip).limit(limit).all()
    return tokens

@app.get("/signals", response_model=List[SignalResponse])
def get_top_signals(limit: int = 400, sort_by: str = "flow_1m", db: Session = Depends(get_db)):
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

    # Tickers + names (both small tables)
    ticker_rows = {t.symbol: t for t in db.query(LatestTicker).all()}
    token_map = {t.symbol: t.name for t in db.query(Token).all()}

    signals = []
    for symbol, name in token_map.items():
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

        signals.append(
            SignalResponse(
                symbol=symbol,
                name=name,
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
    elif sort_by == "flow_15m":
        signals.sort(key=lambda s: s.net_flow_15m, reverse=True)
    else:
        # Default: flow_1m
        signals.sort(key=lambda s: s.net_flow_1m, reverse=True)

    return signals[:limit]

@app.get("/klines/{symbol}")
async def get_klines(symbol: str, interval: str = "5m", limit: int = 500):
    """Retrieve historical klines for charting directly from Binance API"""
    # Binance Alpha klines API strictly requires the "ALPHA_" prefix
    alpha_symbol = f"ALPHA_{symbol}" if not symbol.startswith("ALPHA_") else symbol

    api = BinanceAlphaAPI()
    try:
        return await api.get_klines(symbol=alpha_symbol, interval=interval, limit=limit)
    finally:
        await api.close()


@app.get("/flow/{symbol}")
def get_flow(symbol: str, start_ms: int | None = None, end_ms: int | None = None,
             limit: int = 10080, db: Session = Depends(get_db)):
    """Raw 1-minute buy/sell USD flow buckets for strategy backtests.

    Returns ascending [[bucket_start_ms, buy_volume, sell_volume, trade_count], ...].
    The collector prunes buckets after ~7 days (= 10080 minutes), so this is the
    maximum honest lookback for flow-based strategies.
    """
    alpha_symbol = f"ALPHA_{symbol}" if not symbol.startswith("ALPHA_") else symbol
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

