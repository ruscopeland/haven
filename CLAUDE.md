# Alpha Trading Stack — how it actually works

A BNB-chain trading stack: a Python collector feeds market data into a shared SQLite DB,
a FastAPI server exposes it, a charting UI places order "markers" on price levels, and a
**headless Node daemon (`marker-engine/`) executes real on-chain swaps** when price crosses
them. The wallet app is the dashboard/control panel — it does NOT execute markers.
`start.bat` launches all five windows. This doc traces the real runtime flow from source.

---

## The pieces and how data moves

```
Binance Alpha WS ─aggTrade/ticker─► collector ──writes──► crypto_data.db ◄──reads/writes── FastAPI :8000
                                    (standalone_collector.py)   (SQLite, WAL)      (api/server.py via main.py)
                                                                                     ▲        ▲        ▲
                                    GET /klines + POST /markers ── charting-ui :5173┘        │        │
                                                                                              │        │
                    GET /dashboard/overview + /engine/settings ──────── marker-engine daemon ┘        │
                    POST /markers/{id}/claim → OpenOcean swap → POST /trades   (Node, headless)       │
                                                                                                       │
                    dashboard polls (overview/logs/settings) + pause toggle ───────── wallet :5174 ────┘
```

Everything is glued together by the **shared SQLite file `crypto-data-collector/crypto_data.db`**
and the **FastAPI server on :8000**. The UIs and the engine never talk to each other directly —
only through markers/trades/settings/strategies rows in that DB via the API.

**Strategies module** (added 2026-07-03): user-authored JS strategies live in the `strategies`
table, are edited + backtested in the charting UI's ⚡ Strategies tab, and are executed by a
**strategy runner inside the marker-engine process**. Shared runtime: **`strategy-sdk/`** (plain
ESM, zero deps — indicators, flow aggregation, backtester), imported by BOTH the chart UI (Vite
alias `@sdk`) and the engine (relative import). Same code backtests and runs live.

**Token Finder module** (added 2026-07-03): user-authored JS **finders** (`finders` table) rank
every Alpha token per bar from `one_min_buckets` data served in bulk by **`GET /universe`**.
Finders never trade — a strategy subscribes via `strategies.finder_id` + `max_positions`, and its
trade slots then bind the finder's top-ranked tokens (flat slots rebind with score hysteresis,
slots holding a position are locked). Edited/validated in the 🔍 Token Finder tab (ranking river
+ forward-return quality strip); cross-analyzed with strategies via the SDK's
`runPortfolioBacktest`; run live/dry by the **FinderHub** (`marker-engine/finder-runner.js`)
feeding portfolio slots inside the strategy runner. Both sides share the SDK's `chooseBinding` —
backtest slot behavior IS live slot behavior. A 📖 Guide panel (markdown in
`strategy-sdk/docs/*.md`, Vite alias `@sdk-docs`) opens from both workbench tabs.

---

## 1. Collector — `crypto-data-collector/standalone_collector.py`

The only writer of market data. On startup: creates tables (WAL mode), then `sync_tokens`
**upserts** the active Alpha token list from Binance REST (adds new listings, updates metadata,
removes delisted). A daily background task re-syncs; if the token set changed it forces a WS
reconnect so new streams get subscribed. The token list is re-read on every reconnect.

`_run_ws` opens one Binance Alpha WebSocket and subscribes, in chunks of 100, to
`{symbol}@aggTrade` and `{symbol}@ticker` for every token. Incoming events:

- **aggTrade** → side inferred by a **tick rule** (up-tick = buy, down-tick = sell, flat inherits)
  because Binance Alpha's maker flag is unreliable. `_process_trade` folds it into an in-memory
  1-minute OHLC bucket with buy/sell **USD** volume.
- **24hrTicker** → updates `self.tickers` AND marks the symbol in `_tickers_changed`, so WS
  ticker updates are persisted by the next ticker save (the old never-persisted gap is fixed).

Background tasks per connection:

| Task | Interval | What it writes |
|------|----------|----------------|
| `periodic_flush` | 10s | completed 1-min buckets → `one_min_buckets`; prunes buckets >7 days and `debug_logs` >48h |
| `periodic_ticker_save` | 60s | changed tickers → `latest_tickers` (pct/vol/price) |
| `_periodic_rest_ticker_sync` | 300s | REST ticker for all tokens (fills quiet ones); only genuine "invalid symbol" responses are blacklisted, transient errors retry |
| `periodic_live_price_save` | 3s | live aggTrade price → `latest_tickers.last_price` only |
| `periodic_token_sync` | 24h | token list upsert (+ WS resubscribe if changed) |
| `periodic_heartbeat` | 30s | `heartbeats(process="collector")` |
| `periodic_archive` | 15m | recomputes the last 2h of `fifteen_min_buckets` from 1m data (idempotent full-row upsert, chunked); prunes archive >90 days. Extends `/universe` lookback past the 7-day 1m retention |

**The 3s live-price save is the fresh-price lifeline** — `latest_tickers.last_price` is what the
marker engine crosses against. If markers "aren't firing", check the collector first.

## 2. API — `crypto-data-collector/main.py` runs `api/server.py` (:8000)

FastAPI over the same DB. Schema in `database/models.py`. Key endpoints:

- **Markers** (`chart_markers`): `POST /markers` (validates `marker_type` against `MARKER_TYPES`
  and `direction` against above/below/cross — invalid types are rejected, they would otherwise
  execute as SELLs), `GET /markers/{symbol}`, `PATCH`, `DELETE`, and the critical
  **`POST /markers/{id}/claim`** — an atomic `UPDATE active 1→0 WHERE id=? AND active=1`
  returning `{claimed: bool}`. SQLite serializes writes, so exactly one racing caller wins —
  this is how a marker fires **exactly once**. Do not replace with client-side flags.
- **Trades** (`trade_history`): `POST /trades`, `GET /trades`. `block_time` now stores the real
  block timestamp in ms (legacy rows contain block *numbers*).
- **`GET /dashboard/overview`** — main poll for wallet + engine: last 200 trades (enriched with
  marker type/label as "reason"), up to 100 active markers, `token_prices` from `latest_tickers`.
- **`GET/PATCH /engine/settings`** — engine pause flag + risk limits (`paused`,
  `max_trades_per_day`, `max_trade_usd`, `max_price_impact_pct`, `max_retry_attempts`), stored in
  the `engine_settings` key-value table, defaults in `ENGINE_SETTING_DEFAULTS` (server.py).
- **`GET /signals`** — buy/sell/net flow over 1m/5m/15m/1h from `one_min_buckets`. Powers the screener.
- **`GET /klines/{symbol}`** — proxies Binance Alpha klines (force-prefixes `ALPHA_`).
- **`GET /flow/{symbol}?start_ms&end_ms&limit`** — raw ascending 1-minute buy/sell USD flow
  buckets (`[[bucket_ms, buy, sell, trade_count], …]`) for strategy backtests. Max honest
  lookback = the collector's ~7-day bucket retention.
- **Strategies** (`strategies`): `GET /strategies` (list, no code), `GET/POST/PATCH/DELETE
  /strategies/{id}`. **`updated_at` bumps ONLY on definition changes (code/params/symbol/
  interval/finder_id/max_positions/switch_margin_pct)** — it is the runner's hot-reload key; a
  mode flip must not reset a running strategy's warm-up state. DELETE also removes the
  strategy's still-active markers. `GET /trades` accepts `status` and `strategy_id` filters.
  Token selection: a fixed `symbol`, OR `finder_id` + `max_positions` (1–10) +
  `switch_margin_pct` with **`symbol=''`** (SQLite can't relax the NOT NULL; empty string +
  finder_id = dynamic). PATCH detaches a finder via the explicit `clear_finder` flag.
- **Finders** (`finders`): `GET /finders` (list, no code), `GET/POST/PATCH/DELETE /finders/{id}`.
  Same `updated_at` contract (bumps only on code/params/interval — it is the FinderHub's
  hot-reload key). DELETE returns **409 while any strategy references the finder**.
- **`GET /universe?interval=5m|15m|30m|1h&start_ms&end_ms&min_vol_24h&symbols`** — the Token
  Finder dataset: multi-token OHLC + buy/sell flow resampled SQL-side from `one_min_buckets`
  (plus `fifteen_min_buckets` archive for ≥15m intervals — 1m data wins where both cover a
  group), one common time axis, nulls where a token has no data. Capped at 2200 bars / 400
  tokens. ⚠ The resample GROUP BY uses `bucket_start - (bucket_start % interval)` on purpose:
  SQLAlchemy 2.0 renders `/` as TRUE division, which silently degrades grouping to one group
  per row.
- **`GET /health`** reads heartbeats → ok/warning/down by age; `/debug/logs` GET/POST/DELETE.
- The request-logging middleware **skips polling endpoints** (`NOISY_PATHS` + `/klines` +
  `/flow` + `/strategies` + `/finders` + `/universe`) — this previously wrote millions of rows
  and bloated the DB to 470 MB (`/universe` responses are also several MB each).

## 3. Charting UI — `crypto-charting-ui`, `src/components/Chart.jsx` (:5173)

- Historical candles: `GET /klines/{symbol}`. **Live candles: a DIRECT Binance kline WebSocket**,
  *not* the collector — the chart can look alive while the collector (and thus the engine's price
  feed) is down.
- **Placing a marker**: left-click a price, type "Amount in USD". The USD number is stored
  **untouched** as `metadata_json.usd`; the engine converts it to size at fire time. Direction
  defaults to `below` for BUY_GRID/DCA_ENTRY, `above` for the rest.
- **Bracket (OCO)**: a BUY entry may carry optional `metadata_json.tp` / `.sl` prices. When the
  entry fills, the engine auto-places a TP (sell, above) and SL (sell, below) leg sized to the
  tokens actually bought; filling either leg cancels the other (shared `metadata_json.bracketId`).
- **Grid**: the popup can place N evenly-spaced BUY_GRID lines between the clicked price and a
  target in one action (`createGrid`), each carrying the per-line USD amount.
- Right-click near a line deletes that marker. Active markers + FILLED trades render as
  horizontal price lines (the trades fetch filters `status=FILLED` so strategy dry-run PAPER
  rows never draw BOUGHT/SOLD lines).
- **⚡ Strategies tab** (`StrategyWorkbench.jsx` + `BacktestChart.jsx` + `BacktestResults.jsx`):
  CodeMirror editor for JS strategies (contract: a `strategy` object with `params`, optional
  `init(ctx)`, `onBar(bar, ctx)`; `ctx` gives candles, cached indicators, `ctx.flow` buy/sell
  USD arrays, `position`, `buy(usd,{tp,sl,tag})`/`sell({usd|pct})`). Every edit re-runs
  `runBacktest` from `strategy-sdk` (debounced 600 ms) over 500 `/klines` bars (+`/flow` when
  the code references `ctx.flow`) and overlays fills as arrows via `createSeriesMarkers`, plus
  an equity line and a stats/trades panel. Backtest fills at next-bar open, SL beats TP intrabar
  (pessimistic), fee/slippage inputs in the toolbar. Per-strategy OFF/DRY/LIVE toggle PATCHes
  `mode` (LIVE shows a confirm dialog; engine risk limits still apply).
  **Token selection control**: "Fixed symbol" or a saved 🔍 finder + max positions + switch
  margin — with a finder attached the backtest becomes `runPortfolioBacktest` over `/universe`
  data (interval restricted to 5m/15m/30m/1h) and the chart pane becomes a **slot timeline**
  (colored binding bands per slot with fills painted on, combined equity below); the trades
  table gains Token and Rank@bind columns.
- **🔍 Token Finder tab** (`FinderWorkbench.jsx` + `RankingRiver.jsx`): CodeMirror editor for JS
  finders (contract: a `finder` object with `params`, optional `filter(ctx)`, required
  `score(ctx)`; ctx = strategy ctx minus trading plus `ctx.token` metadata). `/universe` is
  fetched ONCE per interval/lookback/min-vol selection, then every edit re-ranks locally
  (debounced 400 ms) — the instant-feedback loop. Panels: **ranking river** (top-N bump chart,
  click to pin a moment), **finder quality strip** (avg forward return of top-N picks vs
  universe median — the green line above the grey one is the whole point), and the pinned
  ranked table with actual forward returns per token.
- **📖 Guide panel** (`GuidePanel.jsx`): slide-over docs from both tabs; renders
  `strategy-sdk/docs/*.md` (Vite alias `@sdk-docs`, `?raw` imports, tiny built-in markdown
  renderer). Code blocks defining a strategy/finder get an "Insert into editor" button.

## 4. Marker Engine — `marker-engine/` (Node daemon, the ONLY marker executor)

`index.js` (config + API client + loop), `engine.js` (orchestration + I/O), `pure.js`
(side-effect-free decision logic: cross detection, sizing, price-impact, brackets, immediate-fire
TTL — unit-tested in `pure.test.js`, run `npm test`), `chain.js` (ethers helpers),
`strategy-runner.js` (turns saved strategies into signals; see below).
Started by `start.bat` in the "Alpha Engine" window. Key: `marker-engine/.env` `PRIVATE_KEY`,
falling back to `crypto-wallet/.env` `VITE_PRIVATE_KEY`. Without a key it runs observe-only
and does NOT heartbeat (green "Engine" dot = trades will actually fire).

Each ~3s tick: fetch `/engine/settings` + `/dashboard/overview`, refresh token map (5 min), then:

1. **Cross detection** — per marker: `side = price >= marker.price ? above : below`. First
   observation is baseline; a side flip fires only if it matches `marker.direction`
   (`below` = downward cross only, `above` = upward only, `cross`/null = either).
2. **Guards before claiming**: ALERT markers just claim + log (notify-once, never trade);
   no key / paused / daily cap → skip with 60s cooldown.
3. **Claim first** (`POST /markers/{id}/claim`) — bail if another instance won.
4. **Sizing**: `metadata_json.usd` is USD notional (buy: `usd/bnbPrice` BNB in; sell:
   `usd/currentPrice` tokens, capped at balance). Legacy `metadata_json.amount` = token qty
   still honored. No amount → quickBuy/quickSell percent from env. **Sized buys abort if the
   BNB price is unavailable** — never silently fall back to percent-of-balance. Trades over
   `max_trade_usd` abort.
5. **Quote + impact guard**: OpenOcean v4 swap quote (rate-limited ~1/1.6s); abort if implied
   price impact vs the collector price exceeds `max_price_impact_pct`.
6. **Execute**: allowance/approve if selling, send pre-built tx (+20% gas buffer). Executions
   run **sequentially in one process** — nonces can't collide within the engine.
7. **Record real fills**: token amounts parsed from receipt Transfer logs; BNB received (sells)
   from balance delta net of gas; `execution_price` derived from actual amounts;
   `block_time` = real block timestamp ms. POST /trades. Marker stays inactive (claim did it).
8. **Failures**: re-arm (PATCH active=1) + 30s cooldown; after `max_retry_attempts` failures the
   marker stays disabled (logged as DISABLED). "No balance to sell" never re-arms.
9. **Brackets**: after a BUY entry with `tp`/`sl` metadata fills, `handleBracket` POSTs the TP/SL
   sell legs (sized to real tokens bought, inheriting the entry's `strategy_id`); when any
   bracketed leg fills it DELETEs its OCO siblings (matched by `metadata_json.bracketId`).

### 4b. Strategy runner — `marker-engine/strategy-runner.js` (same process)

Ticked from the same loop as the engine (separate try/catch — one can't stall the other).
Every 15s it syncs `GET /strategies`: rows with `mode != off` get a runner; a changed
`updated_at` tears down + recreates it (fresh code/state); a mode flip alone carries over.

- **Bar stream = `GET /klines` polled ~5s after each interval boundary** — the exact series the
  workbench backtested, so live behavior matches backtests. Closed bars only. On start: 500
  bars, then a warm-up replay of `onBar` over history with actions suppressed (primes
  `ctx.state` without emitting signals).
- **Position** is rebuilt from `GET /trades?strategy_id=X` (PAPER for dry, FILLED for live)
  before each new bar — restarts, engine-side fills, and aborted fires all reconcile.
- **LIVE signal** → `POST /markers` with `marker_type: STRAT_BUY|STRAT_SELL`, `strategy_id`,
  `metadata_json {usd, tp?, sl?, tag?}`. These are **immediate-fire** markers: the engine
  executes them on sight (no cross), through the full guard stack. **TTL safety
  (`IMMEDIATE_TTL_MS` = 120s in pure.js)**: an immediate marker older than the TTL is
  claimed-and-discarded, never traded — protects against the engine being down when a strategy
  signaled and then executing at a stale price on restart.
- **DRY signal** → `POST /trades` directly with `status='PAPER'` and a synthetic
  `tx_hash` (`paper-<uuid>` — tx_hash is UNIQUE). TP/SL simulated locally with the
  backtester's pessimistic rules. PAPER rows are **excluded from `/dashboard/overview`**
  server-side, so they can never touch wallet PnL or the engine's daily cap
  (`countTradesToday` counts FILLED only anyway).
- Strategy exceptions → `PATCH last_error` (surfaces as a red dot in the workbench) + debug
  log; other strategies keep running. Successful bars set `last_run_at` and clear the error.
  Heartbeats as `strategy_runner` when any strategy is armed.

### 4c. Token Finder live path — `finder-runner.js` + portfolio slots (same process)

- **FinderHub** (`marker-engine/finder-runner.js`): one evaluator per (finder id, interval)
  pair needed by an armed portfolio strategy. After each interval close (+25s lag so the
  collector's 10s bucket flush lands), it fetches a 300-bar `/universe` slice, runs the SDK's
  `runRanking`, caches the latest ranking, and PATCHes the finder's `last_run_at`/`last_error`.
  Rankings run at the **strategy's** interval (finder.interval is just the Finder tab default),
  so live cadence matches the workbench's portfolio backtest.
- **Portfolio strategies** in `strategy-runner.js`: `max_positions` slot sub-runners instead of
  one symbol runner. Each sub is an isolated strategy instance (own `ctx.state`, own klines
  history, warm-up replay on bind — the `initRunner` dance per slot). Rebinding uses the SDK's
  `chooseBinding` with the hub's ranking + a **tradeable filter** (token must have a contract
  address). Emission paths are UNCHANGED: live = immediate-fire STRAT_BUY/STRAT_SELL markers
  (full engine guard stack + TTL apply), dry = PAPER trades. Positions rebuild from
  `GET /trades?strategy_id=` **grouped by symbol**; on restart, slots re-attach to symbols
  already holding a position before any flat slot binds.
- **Fail-closed rule**: hub error or no ranking yet → flat slots do NOT bind (no new exposure),
  but slots with positions keep running their strategy (exits still work).

## 5. Wallet — `crypto-wallet` (:5174) — dashboard + controls, NOT the marker executor

Polls `/dashboard/overview` (5s), `/debug/logs` (3s), `/engine/settings` (15s) with no key
needed. Shows Open Orders / Trade History / System Debug Log, and the **ENGINE LIVE / PAUSED
toggle** (Dashboard, Open Orders header) which PATCHes `/engine/settings`.

Still in the wallet: balances/prices/PnL (DexScreener + BscScan trace), manual swaps
(SwapPanel/TokenDetails), and a separate **auto-trade engine** (60s loop, localStorage jobs,
DexScreener prices) — ⚠️ it shares no nonce queue with the daemon, so a concurrent auto-trade
and marker fire can still collide; merging it into markers is planned (Phase 3).

---

## ⚠️ Three independent price feeds (source of most confusion)

1. **Collector `latest_tickers.last_price`** (aggTrade WS, 3s save) → `/dashboard/overview` →
   **what the marker engine crosses against.**
2. **DexScreener** → wallet USD display + auto-trade engine. Not used for marker crossing.
3. **Direct Binance kline WS** in `Chart.jsx` → the candles you watch. Purely visual.

## Restart rules (what needs a restart after an edit)

- `standalone_collector.py` → restart the **Collector** window.
- API endpoint change → restart the **API** window.
- `marker-engine/*.js` **or `strategy-sdk/*`** → restart the **Engine** window (plain Node, no
  hot reload; the SDK is imported by the engine).
- **When adding marker types**: restart the **API window BEFORE the Engine window** — the old
  engine treats unknown non-ALERT types as SELLs, so new types must never be creatable while an
  old engine runs.
- `vite.config.js` change (e.g. the `@sdk`/`@sdk-docs` aliases) → restart the **Chart UI**
  window (HMR does not reload config).
- **Token Finder deployments**: restart the **API window BEFORE the Engine window** — the
  runner needs `/finders` + `/universe` and the new strategy columns to exist. Never arm a
  finder-bound strategy while an old engine build is running (it would treat `symbol=''` as a
  broken symbol runner).
- Wallet/chart UI edits → Vite HMR usually suffices; hard-reload the wallet tab after context
  changes. (Marker execution no longer lives in the browser, so stale HMR instances can no
  longer double-fire trades.)
- Wallet key: auto-loads `VITE_PRIVATE_KEY` only when there is **no** saved
  `crypto_wallet_config` in localStorage; the engine daemon reads the key from .env directly.

## Cross-app contracts — do not change one side alone

- **Marker shape** is written by the chart, stored by the API/DB, read by the engine daemon and
  the wallet dashboard. Field/type changes must land in all of them.
- **Finder shape** (`finders` row + the `filter`/`score` contract) is written by the Finder tab,
  read by the Strategy Workbench (portfolio backtests) and the FinderHub. Same `updated_at`
  hot-reload contract as strategies.
- **`strategies.symbol = ''` + `finder_id` set = dynamic token selection.** Chart UI writes it,
  API validates it (a strategy needs exactly one token source), runner branches on it. Old
  engines treat such a row as a broken symbol runner — restart API **and** Engine together when
  deploying finder changes.
- **`/universe` payload shape** is parsed ONLY by the SDK's `normalizeUniverse()` — used by the
  Finder tab, the workbench portfolio backtest, and the FinderHub. Never hand-parse it.
- **The slot rebinding rule lives in ONE place**: `chooseBinding` in `strategy-sdk/src/finder.js`,
  imported by both `portfolio.js` (backtests) and `strategy-runner.js` (live). If they diverge,
  backtests stop predicting live behavior.
- **`metadata_json.usd` = USD notional** (the user's intent, converted at fire time). Legacy
  markers may still carry `metadata_json.amount` = token quantity; the engine honors both.
- **Duplicate-fire safety lives in the server-side atomic claim** (`/markers/{id}/claim`).
  Don't replace it with local flags, and don't re-add an end-of-function `PATCH active=0`.
- **`trade_history.block_time`** is a ms timestamp for new rows, a block number for legacy rows;
  the engine's daily-cap counter relies on ms values being astronomically larger.
- `_deprecated/` holds removed legacy code and the pre-cleanup DB backup — safe to delete.

## Improvement plan status (2026-07-02)

Done:
- **Token Finder module (2026-07-03)**: finders table + CRUD, `/universe`, `fifteen_min_buckets`
  archive (90d), SDK finder/portfolio runtimes + `chooseBinding`, 🔍 Finder tab, workbench
  portfolio backtests + slot timeline, FinderHub + portfolio slots in the engine, 📖 Guide
  panel + `strategy-sdk/docs/`. Tests: strategy-sdk 45 (incl. 1-token parity gate),
  marker-engine 32 (incl. mocked portfolio-runner suite).
- Phase 0 (correctness) + Phase 1 (headless engine + risk guards + retry caps).
- Phase 2: `bucket_start` index, SQL-side `/signals` (one GROUP BY), batched `ON CONFLICT`
  bucket upserts run off the WS loop (`asyncio.to_thread`), FastAPI `lifespan` (no more
  deprecated `on_event`).
- Phase 3 (partial): engine logic extracted to `pure.js` with a unit-test suite; risk limits
  moved into the wallet **Config panel** (not just the API).
- Phase 4 (partial): bracket (OCO) orders and the buy-grid generator.

Deliberately deferred (need browser verification / larger behavioral change):
- One shared `executeSwap()` across the three in-browser swap paths (auto-trade, TokenDetails,
  SwapPanel) and splitting the WalletContext god component — the daemon is the money path and is
  isolated+tested; the browser paths work and were left untouched to avoid a blind regression.
- Merging the wallet auto-trade engine into markers (still its own localStorage loop, no shared
  nonce queue with the daemon).
- WS/SSE push instead of polling; positions table with realized PnL.
