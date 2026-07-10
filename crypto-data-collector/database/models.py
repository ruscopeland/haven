from sqlalchemy import Column, Integer, String, Float, BigInteger
from database.db import Base

class Token(Base):
    """A tracked token (DATA-ROADMAP AD-D1/AD-D2).

    New-format rows (on-chain ingester): id = "{chain}:{contract_lowercase}",
    symbol = the globally-unique SLUG "{DISPLAY}_{chain}" that every other
    table joins on, chain_id = the chain slug ("bsc", "ethereum", ...).
    Legacy Binance rows (id = Binance tokenId, symbol = "XXXUSDT", numeric
    chain_id) coexist until the M4 cutover remap (tools/remap_symbols.py).
    """
    __tablename__ = "tokens"

    id = Column(String, primary_key=True, index=True)
    symbol = Column(String, index=True, nullable=False)
    name = Column(String)
    chain_id = Column(String)
    contract_address = Column(String)
    display_symbol = Column(String)      # clean human symbol ("CAKE"); UI adds chain badge
    decimals = Column(Integer)
    total_supply = Column(Float)         # human units (raw / 10**decimals)
    liquidity_usd = Column(Float)        # primary-pool depth, refreshed by the sweep
    market_cap = Column(Float)           # USD market cap (from CMC ranking)
    cmc_rank = Column(Integer)           # global CoinMarketCap rank (1 = largest)
    cmc_slug = Column(String)            # CMC slug for identity
    cmc_id = Column(Integer)             # CMC numeric id — logo CDN uses this
    listed_at = Column(BigInteger)       # unix ms first seen (pool creation)
    # staged  = ingested but hidden from /tokens until the M4 cutover flips it
    # active  = normal;  retired = no supported chain / delisted;  blacklisted = manual
    status = Column(String, default="active")
    security_json = Column(String)       # GoPlus payload (DATA-ROADMAP M7)
    primary_pool = Column(String)        # pools.id used for pricing/liquidity


class Pool(Base):
    """A DEX pool the on-chain ingester watches (DATA-ROADMAP AD-D6).

    Only pools quoted in a chain's trusted quote tokens are ever stored —
    that is what makes prices unspoofable (AD-D5). `watch=1` pools are in the
    getLogs address filter; drops use floor/2 hysteresis so pools don't flap.
    """
    __tablename__ = "pools"

    id = Column(String, primary_key=True)        # "{chain}:{pool_address_lowercase}"
    chain = Column(String, index=True, nullable=False)
    dex = Column(String)                          # "pancake-v2" | "pancake-v3" | "uniswap-v2" | "uniswap-v3"
    kind = Column(String)                         # "v2" | "v3"
    token_id = Column(String, index=True)         # tokens.id of the non-quote side
    quote_address = Column(String)                # quote token contract (lowercase)
    token_is_token0 = Column(Integer)             # 1 = ranked token is token0
    fee_tier = Column(Integer, default=0)         # v3 fee (500/2500/10000); 0 for v2
    liquidity_usd = Column(Float, default=0.0)    # ≈ 2 × quote balance × quote USD
    watch = Column(Integer, default=0, index=True)
    created_at = Column(BigInteger)               # unix ms of pool creation
    last_checked = Column(BigInteger)             # last liquidity sweep


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


class DailyBucket(Base):
    """Daily OHLCV archive for long-term chart history (backfilled from CMC k-line).

    Written by the backfill script (cmc k-line keyless endpoint) and by the
    collector's daily archive task. Retained indefinitely (or a very long
    retention). /klines reads it for intervals >= 1d so charts can show
    1+ year of history instead of the 7-day/90-day limits of the finer tables.
    """
    __tablename__ = "daily_buckets"

    symbol = Column(String, primary_key=True, index=True)
    bucket_start = Column(BigInteger, primary_key=True, index=True)  # unix ms of UTC midnight
    open_price = Column(Float)
    high_price = Column(Float)
    low_price = Column(Float)
    close_price = Column(Float)
    buy_volume = Column(Float)   # total USD volume (k-line doesn't split buy/sell)
    sell_volume = Column(Float)  # 0 (no split available from k-line)
    trade_count = Column(Integer)


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
DEBUG_SOURCES = ("collector", "engine", "api", "wallet")


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


class Subscription(Base):
    """Stripe subscription state per user (Haven SaaS).

    Written ONLY by the Stripe webhook handler (and checkout bootstrap).
    status follows Stripe's vocabulary: active / trialing / past_due /
    canceled / incomplete. `early` freezes the founding-member price tier the
    user locked in (first 500 active subscribers).
    """
    __tablename__ = "subscriptions"

    user_id = Column(String, primary_key=True)             # Clerk user id
    stripe_customer_id = Column(String, index=True, nullable=True)
    stripe_subscription_id = Column(String, index=True, nullable=True)
    status = Column(String, default="none")
    plan = Column(String, nullable=True)                   # monthly | annual
    price_id = Column(String, nullable=True)
    current_period_end = Column(BigInteger, nullable=True)  # unix ms
    early = Column(Integer, default=0)                     # 1 = founding price lock
    # Bot slots purchased beyond the plan's included allowance (see
    # api/auth.py entitlements). Set by the owner / a future Stripe add-on;
    # a "bot" is a strategy armed DRY or LIVE.
    extra_bots = Column(Integer, default=0)
    created_at = Column(BigInteger)
    updated_at = Column(BigInteger)


class DebugLog(Base):
    """Structured debug log entry from any program in the system.

    Each source (collector, engine, api, wallet) writes timestamped entries
    with a severity level. The wallet dashboard fetches these for the
    toggleable debug log panel.
    """
    __tablename__ = "debug_logs"

    id = Column(Integer, primary_key=True, autoincrement=True)
    user_id = Column(String, index=True, default="system", nullable=False)
    source = Column(String, index=True, nullable=False)   # collector | engine | api | wallet
    level = Column(String, index=True, nullable=False)     # DEBUG | ERROR | TRADE | INFO | API_REQUEST | API_RESPONSE
    message = Column(String, nullable=False)
    timestamp = Column(BigInteger, index=True)             # unix ms
    metadata_json = Column(String, nullable=True)          # extra structured data
