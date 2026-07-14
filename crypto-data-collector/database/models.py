from sqlalchemy import Column, Integer, String, Float, BigInteger, Text, UniqueConstraint
from database.db import Base

class Token(Base):
    """A Binance Alpha BSC contract supported by Haven's local engine."""
    __tablename__ = "tokens"

    id = Column(String, primary_key=True, index=True)
    symbol = Column(String, index=True, nullable=False)
    name = Column(String)
    chain_id = Column(String)
    contract_address = Column(String)
    display_symbol = Column(String)      # clean human symbol ("CAKE"); UI adds chain badge
    decimals = Column(Integer)
    liquidity_usd = Column(Float)        # Binance Alpha liquidity when available
    market_cap = Column(Float)           # USD market cap from Binance Alpha
    alpha_rank = Column(Integer)         # deterministic Alpha catalogue rank
    alpha_id = Column(String)            # Binance Alpha trading asset identifier
    listed_at = Column(BigInteger)       # unix ms first seen (pool creation)
    # staged  = ingested but hidden from /tokens until the M4 cutover flips it
    # active  = normal;  retired = no supported chain / delisted;  blacklisted = manual
    status = Column(String, default="active")
    security_json = Column(String)       # cached Binance Alpha eligibility summary


class LatestTicker(Base):
    """Latest 24hr ticker data per symbol — updated on every ticker event."""
    __tablename__ = "latest_tickers"

    symbol = Column(String, primary_key=True, index=True)
    price_change_24h = Column(Float)
    volume_24h = Column(Float)
    last_price = Column(Float)
    last_updated = Column(BigInteger)  # unix ms


class Heartbeat(Base):
    """Local engines report a coarse connection heartbeat."""
    __tablename__ = "heartbeats"

    process = Column(String, primary_key=True, index=True)
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
    user_id = Column(String, index=True, default="local", nullable=False)
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
    user_id = Column(String, index=True, default="local", nullable=False)
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
    chain_id = Column(String, nullable=True)
    submitted_at = Column(BigInteger, nullable=True)
    confirmed_at = Column(BigInteger, nullable=True)
    block_number = Column(BigInteger, nullable=True)
    reconciliation_state = Column(String, default="recorded")
    receipt_json = Column(Text, nullable=True)
    intent_hash = Column(String, index=True, nullable=True)


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
    user_id = Column(String, index=True, default="local", nullable=False)
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
    code_version = Column(Integer, default=1, nullable=False)
    live_approved_version = Column(Integer, nullable=True)


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
    user_id = Column(String, index=True, default="local", nullable=False)
    name = Column(String, nullable=False)
    code = Column(String, nullable=False)             # JS source (finder contract)
    params_json = Column(String, nullable=True)       # user overrides of the code's defaults
    interval = Column(String, default="15m")          # ranking evaluation interval
    created_at = Column(BigInteger)
    updated_at = Column(BigInteger)                   # bumped on code/params/interval only
    last_run_at = Column(BigInteger, nullable=True)   # evaluator writes after each ranking
    last_error = Column(String, nullable=True)        # evaluator writes when the finder throws


class EngineSetting(Base):
    """Key-value settings for the marker execution engine (pause flag, risk limits).

    Written via PATCH /engine/settings (wallet UI), read by the engine daemon on
    every poll. Values are stored as strings; defaults live in api/server.py.
    """
    __tablename__ = "engine_settings"

    # Composite PK so every user has their own pause flag + risk limits. The
    # legacy solo SQLite table keeps its physical PK on (key) alone — fine for
    # the single 'local' user; fresh Postgres DBs get the true composite PK.
    user_id = Column(String, primary_key=True, default="local")
    key = Column(String, primary_key=True)
    value = Column(String, nullable=False)


# ── Debug log levels ───────────────────────────────────────────────────────
DEBUG_LEVELS = ("DEBUG", "ERROR", "TRADE", "INFO", "API_REQUEST", "API_RESPONSE")
DEBUG_SOURCES = ("engine", "api", "wallet")


class ApiKey(Base):
    """Engine connection key (Haven SaaS).

    Generated once in the web app's Settings ("Connect your engine"), shown to
    the user a single time, stored ONLY as a SHA-256 hash. The engine daemon
    sends the raw key in X-Api-Key; the API hashes and looks it up here to
    know which user is trading.
    """
    __tablename__ = "api_keys"

    id = Column(String, primary_key=True)                 # UUID
    user_id = Column(String, index=True, nullable=False)
    key_hash = Column(String, unique=True, nullable=False)  # sha256 hex of raw key
    label = Column(String, default="engine")
    created_at = Column(BigInteger)
    last_used_at = Column(BigInteger, nullable=True)
    revoked = Column(Integer, default=0)                   # 1 = key disabled
    scopes = Column(String, default="engine:read,engine:trade,engine:report", nullable=False)
    expires_at = Column(BigInteger, nullable=True)


class Subscription(Base):
    """Local trial record and fail-closed cache of Clerk plan state."""
    __tablename__ = "subscriptions"

    user_id = Column(String, primary_key=True)             # Clerk user id
    status = Column(String, default="none")
    plan = Column(String, nullable=True)
    current_period_end = Column(BigInteger, nullable=True)  # unix ms
    extra_bots = Column(Integer, default=0)
    created_at = Column(BigInteger)
    updated_at = Column(BigInteger)


class StrategyVersion(Base):
    """Immutable strategy code versions and explicit live approvals."""
    __tablename__ = "strategy_versions"
    __table_args__ = (
        UniqueConstraint("strategy_id", "version", name="uq_strategy_version"),
    )

    id = Column(String, primary_key=True)
    strategy_id = Column(String, index=True, nullable=False)
    user_id = Column(String, index=True, nullable=False)
    version = Column(Integer, nullable=False)
    code = Column(Text, nullable=False)
    code_hash = Column(String, nullable=False)
    approved_for_live = Column(Integer, default=0, nullable=False)
    approved_at = Column(BigInteger)
    created_at = Column(BigInteger, nullable=False)


class AiDailyUsage(Base):
    __tablename__ = "ai_daily_usage"
    __table_args__ = (UniqueConstraint("user_id", "usage_date", name="uq_ai_daily_user"),)

    id = Column(Integer, primary_key=True, autoincrement=True)
    user_id = Column(String, index=True, nullable=False)
    usage_date = Column(String, index=True, nullable=False)
    requests = Column(Integer, default=0, nullable=False)
    updated_at = Column(BigInteger, nullable=False)


class DebugLog(Base):
    """Structured debug log entry from any program in the system.

    Each source (engine, API, or wallet) writes timestamped entries
    with a severity level. The wallet dashboard fetches these for the
    toggleable debug log panel.
    """
    __tablename__ = "debug_logs"

    id = Column(Integer, primary_key=True, autoincrement=True)
    user_id = Column(String, index=True, default="system", nullable=False)
    source = Column(String, index=True, nullable=False)   # engine | api | wallet
    level = Column(String, index=True, nullable=False)     # DEBUG | ERROR | TRADE | INFO | API_REQUEST | API_RESPONSE
    message = Column(String, nullable=False)
    timestamp = Column(BigInteger, index=True)             # unix ms
    metadata_json = Column(String, nullable=True)          # extra structured data


# ── Binance Alpha market-data cache ─────────────────────────────────────────

class AlphaAsset(Base):
    """Cached Binance Alpha identity and metadata for BSC-tradable tokens."""
    __tablename__ = "alpha_assets"

    alpha_id = Column(String, primary_key=True)
    symbol = Column(String, index=True, nullable=False)
    name = Column(String, nullable=False)
    rank = Column(Integer, index=True)
    chain_id = Column(String, index=True, nullable=False)
    contract_address = Column(String, index=True)
    metadata_json = Column(Text)
    fetched_at = Column(BigInteger, nullable=False)
    expires_at = Column(BigInteger, nullable=False, index=True)


class MarketCandle(Base):
    """Binance Alpha OHLCV cache; closed rows are immutable once persisted."""
    __tablename__ = "market_candles"
    __table_args__ = (
        UniqueConstraint("alpha_id", "contract_address", "interval",
                         "open_time", name="uq_market_candle_identity"),
    )

    id = Column(Integer, primary_key=True, autoincrement=True)
    alpha_id = Column(String, index=True, nullable=False)
    contract_address = Column(String, index=True, default="")
    interval = Column(String, index=True, nullable=False)
    open_time = Column(BigInteger, index=True, nullable=False)
    close_time = Column(BigInteger, nullable=False)
    open_price = Column(Float, nullable=False)
    high_price = Column(Float, nullable=False)
    low_price = Column(Float, nullable=False)
    close_price = Column(Float, nullable=False)
    volume = Column(Float, default=0.0)
    trader_count = Column(Integer)
    closed = Column(Integer, default=1, index=True)
    source = Column(String, default="binance_alpha")
    updated_at = Column(BigInteger, nullable=False)


class CandleCoverage(Base):
    """Durable REST coverage watermark, including intervals with no trades."""
    __tablename__ = "candle_coverage"
    __table_args__ = (
        UniqueConstraint("alpha_id", "contract_address", "interval",
                         name="uq_candle_coverage_identity"),
    )

    id = Column(Integer, primary_key=True, autoincrement=True)
    alpha_id = Column(String, index=True, nullable=False)
    contract_address = Column(String, nullable=False)
    interval = Column(String, nullable=False)
    start_time = Column(BigInteger, nullable=False)
    end_time = Column(BigInteger, nullable=False)
    updated_at = Column(BigInteger, nullable=False)


class ProviderStatus(Base):
    """Last known Binance Alpha provider state for health and owner operations."""
    __tablename__ = "provider_status"

    provider = Column(String, primary_key=True)
    state = Column(String, nullable=False)
    last_event_at = Column(BigInteger)
    last_reconciled_at = Column(BigInteger)
    reconnect_count = Column(Integer, default=0)
    gap_count = Column(Integer, default=0)
    error = Column(Text)
    details_json = Column(Text)
    updated_at = Column(BigInteger, nullable=False)


class ProviderUsage(Base):
    """Periodic Binance Alpha key-usage snapshot; the API key itself is never stored."""
    __tablename__ = "provider_usage"

    id = Column(Integer, primary_key=True, autoincrement=True)
    provider = Column(String, index=True, nullable=False)
    captured_at = Column(BigInteger, index=True, nullable=False)
    credits_used = Column(Integer)
    credits_left = Column(Integer)
    requests_left_minute = Column(Integer)
    payload_json = Column(Text)


class OperationAlert(Base):
    __tablename__ = "operation_alerts"

    id = Column(String, primary_key=True)
    severity = Column(String, index=True, nullable=False)
    code = Column(String, index=True, nullable=False)
    message = Column(Text, nullable=False)
    active = Column(Integer, default=1, index=True)
    created_at = Column(BigInteger, nullable=False)
    resolved_at = Column(BigInteger)
    details_json = Column(Text)


class BackupRun(Base):
    __tablename__ = "backup_runs"

    id = Column(String, primary_key=True)
    provider = Column(String, nullable=False)
    status = Column(String, index=True, nullable=False)
    started_at = Column(BigInteger, nullable=False)
    completed_at = Column(BigInteger)
    location = Column(String)
    checksum = Column(String)
    error = Column(Text)
