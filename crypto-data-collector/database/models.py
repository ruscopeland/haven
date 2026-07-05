from sqlalchemy import Column, Integer, String, Float, BigInteger
from database.db import Base

class Token(Base):
    __tablename__ = "tokens"

    id = Column(String, primary_key=True, index=True) # Binance tokenId
    symbol = Column(String, index=True, nullable=False)
    name = Column(String)
    chain_id = Column(String)
    contract_address = Column(String)


class OneMinBucket(Base):
    """One-minute aggregated bucket of trade data.

    Each row is one minute of trades for one symbol.
    Composite PK (symbol, bucket_start) so upsert with merge() works cleanly.
    """
    __tablename__ = "one_min_buckets"

    symbol = Column(String, primary_key=True, index=True)
    # Indexed on its own: /signals and pruning filter by bucket_start across all
    # symbols, which otherwise full-scans the (symbol, bucket_start) PK.
    bucket_start = Column(BigInteger, primary_key=True, index=True)  # unix ms of minute boundary
    open_price = Column(Float)
    high_price = Column(Float)
    low_price = Column(Float)
    close_price = Column(Float)
    buy_volume = Column(Float)   # USD volume of buy-side trades
    sell_volume = Column(Float)  # USD volume of sell-side trades
    trade_count = Column(Integer)


class LatestTicker(Base):
    """Latest 24hr ticker data per symbol — updated on every ticker event."""
    __tablename__ = "latest_tickers"

    symbol = Column(String, primary_key=True, index=True)
    price_change_24h = Column(Float)
    volume_24h = Column(Float)
    last_price = Column(Float)
    last_updated = Column(BigInteger)  # unix ms


class Heartbeat(Base):
    """Health-check heartbeat for background processes.

    Each process (collector, execution_engine) writes its name + timestamp
    every 30 seconds. The /health endpoint reads these to show live status.
    """
    __tablename__ = "heartbeats"

    process = Column(String, primary_key=True, index=True)  # e.g. "collector", "execution_engine"
    last_heartbeat = Column(BigInteger)  # unix ms


# ── Marker types ───────────────────────────────────────────────────────────
# STRAT_BUY / STRAT_SELL are IMMEDIATE-fire markers posted by the strategy
# runner (never hand-placed): the engine executes them on sight without a
# price cross, and discards them if they sat unclaimed past a short TTL.
MARKER_TYPES = ("BUY_GRID", "SELL_GRID", "TP", "SL", "DCA_ENTRY", "ALERT",
                "STRAT_BUY", "STRAT_SELL")
MARKER_DIRECTIONS = ("above", "below")
TRADE_DIRECTIONS = ("BUY", "SELL")
# PAPER = simulated dry-run fill from the strategy runner; excluded from
# /dashboard/overview so it never touches real PnL or the engine's daily cap.
TRADE_STATUSES = ("PENDING", "FILLED", "FAILED", "PAPER")


class ChartMarker(Base):
    """A price level marker placed on a chart — planned order, stop loss, etc."""
    __tablename__ = "chart_markers"

    id = Column(String, primary_key=True)       # UUID
    symbol = Column(String, index=True, nullable=False)
    price = Column(Float, nullable=False)
    marker_type = Column(String, nullable=False)  # BUY_GRID / SELL_GRID / TP / SL / DCA_ENTRY / ALERT
    label = Column(String, default="")
    active = Column(Integer, default=1)           # 1=waiting, 0=triggered/disabled
    direction = Column(String)                    # "above" | "below" — which cross triggers
    strategy_id = Column(String, nullable=True)   # links to a strategy config
    user_placed = Column(Integer, default=1)      # 1=manual, 0=strategy bot
    created_at = Column(BigInteger)
    triggered_at = Column(BigInteger, nullable=True)
    metadata_json = Column(String, nullable=True)  # JSON blob for extra fields


class TradeHistory(Base):
    """Record of an executed swap on the blockchain."""
    __tablename__ = "trade_history"

    id = Column(String, primary_key=True)         # UUID
    symbol = Column(String, index=True, nullable=False)
    direction = Column(String, nullable=False)     # BUY or SELL
    marker_id = Column(String, nullable=True)      # which marker triggered this
    expected_price = Column(Float)
    execution_price = Column(Float)
    amount_in = Column(Float)
    amount_out = Column(Float)
    fee_token = Column(String)
    fee_amount = Column(Float)
    gas_used = Column(BigInteger)
    gas_price_gwei = Column(Float)
    gas_cost_native = Column(Float)
    tx_hash = Column(String, unique=True)          # blockchain tx hash
    block_time = Column(BigInteger)
    status = Column(String, default="PENDING")     # PENDING / FILLED / FAILED
    strategy_id = Column(String, nullable=True)


# ── Strategies ─────────────────────────────────────────────────────────────
STRATEGY_MODES = ("off", "dry", "live")


class Strategy(Base):
    """A user-authored JS strategy (see strategy-sdk).

    Single source of truth shared by the charting UI (edit/backtest) and the
    strategy runner inside the marker engine (live/dry execution). The runner
    treats updated_at as its hot-reload key — PATCHes that only flip `mode`
    must NOT bump it, or every toggle would reset the runner's warm-up state.

    Token selection: either a fixed `symbol`, or dynamic via `finder_id` +
    `max_positions` (Token Finder module). SQLite can't relax NOT NULL without
    a table rebuild, so a finder-bound strategy stores symbol='' — the empty
    string, with finder_id set, means "dynamic". Never both empty.
    """
    __tablename__ = "strategies"

    id = Column(String, primary_key=True)           # UUID
    name = Column(String, nullable=False)
    code = Column(String, nullable=False)            # JS source (strategy-sdk contract)
    params_json = Column(String, nullable=True)      # user overrides of the code's defaults
    symbol = Column(String, nullable=False)          # '' when finder-bound (see docstring)
    interval = Column(String, default="5m")
    mode = Column(String, default="off")             # off | dry | live
    finder_id = Column(String, nullable=True)        # dynamic token selection (finders.id)
    max_positions = Column(Integer, default=1)       # concurrent slots when finder-bound
    switch_margin_pct = Column(Float, default=10.0)  # rebind hysteresis for flat slots
    created_at = Column(BigInteger)
    updated_at = Column(BigInteger)                  # bumped on definition changes only
    last_run_at = Column(BigInteger, nullable=True)  # runner writes after each processed bar
    last_error = Column(String, nullable=True)       # runner writes when the strategy throws


# ── Finders (Token Finder module) ──────────────────────────────────────────
FINDER_INTERVALS = ("5m", "15m", "30m", "1h")


class Finder(Base):
    """A user-authored JS token-ranking function (strategy-sdk finder contract).

    Finders are PASSIVE — they never trade and have no mode; strategies opt in
    via strategies.finder_id. Edited/backtested in the charting UI's Finder
    tab, evaluated live by the finder evaluator inside the marker engine.
    Same updated_at rule as strategies: bumped ONLY on code/params/interval
    changes (it is the evaluator's hot-reload key); status writes must not
    bump it.
    """
    __tablename__ = "finders"

    id = Column(String, primary_key=True)            # UUID
    name = Column(String, nullable=False)
    code = Column(String, nullable=False)             # JS source (finder contract)
    params_json = Column(String, nullable=True)       # user overrides of the code's defaults
    interval = Column(String, default="15m")          # ranking evaluation interval
    created_at = Column(BigInteger)
    updated_at = Column(BigInteger)                   # bumped on code/params/interval only
    last_run_at = Column(BigInteger, nullable=True)   # evaluator writes after each ranking
    last_error = Column(String, nullable=True)        # evaluator writes when the finder throws


class FifteenMinBucket(Base):
    """Downsampled 15-minute archive of one_min_buckets (Token Finder lookback).

    Written by the collector's periodic archive task (idempotent recompute of
    the recent window from one_min_buckets), retained ~90 days vs the 1-minute
    table's ~7. /universe reads it for ranges older than the 1-minute
    retention. Same column meanings as OneMinBucket.
    """
    __tablename__ = "fifteen_min_buckets"

    symbol = Column(String, primary_key=True, index=True)
    bucket_start = Column(BigInteger, primary_key=True, index=True)  # unix ms of 15-min boundary
    open_price = Column(Float)
    high_price = Column(Float)
    low_price = Column(Float)
    close_price = Column(Float)
    buy_volume = Column(Float)
    sell_volume = Column(Float)
    trade_count = Column(Integer)


class EngineSetting(Base):
    """Key-value settings for the marker execution engine (pause flag, risk limits).

    Written via PATCH /engine/settings (wallet UI), read by the engine daemon on
    every poll. Values are stored as strings; defaults live in api/server.py.
    """
    __tablename__ = "engine_settings"

    key = Column(String, primary_key=True)
    value = Column(String, nullable=False)


# ── Debug log levels ───────────────────────────────────────────────────────
DEBUG_LEVELS = ("DEBUG", "ERROR", "TRADE", "INFO", "API_REQUEST", "API_RESPONSE")
DEBUG_SOURCES = ("collector", "engine", "api", "wallet")


class DebugLog(Base):
    """Structured debug log entry from any program in the system.

    Each source (collector, engine, api, wallet) writes timestamped entries
    with a severity level. The wallet dashboard fetches these for the
    toggleable debug log panel.
    """
    __tablename__ = "debug_logs"

    id = Column(Integer, primary_key=True, autoincrement=True)
    source = Column(String, index=True, nullable=False)   # collector | engine | api | wallet
    level = Column(String, index=True, nullable=False)     # DEBUG | ERROR | TRADE | INFO | API_REQUEST | API_RESPONSE
    message = Column(String, nullable=False)
    timestamp = Column(BigInteger, index=True)             # unix ms
    metadata_json = Column(String, nullable=True)          # extra structured data
