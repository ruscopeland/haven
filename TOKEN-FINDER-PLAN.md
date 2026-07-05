# Token Finder Module — Implementation Plan

Status: **IMPLEMENTED 2026-07-03** — all phases A–G built, tested, and verified the same day
(see CLAUDE.md "Token Finder module" for the as-built documentation, which supersedes this
plan where they differ). Notable as-built deviations: `strategies.symbol` stores `''` (not
NULL) when finder-bound (SQLite NOT NULL constraint); rankings run at the STRATEGY's interval
(finder.interval is only the Finder tab's default view); resample GROUP BY uses modulo, not
division (SQLAlchemy 2.0 true-division pitfall).
Companion to the Strategies module. Read CLAUDE.md first — this plan reuses its
patterns deliberately (same SDK, same table shape, same runner lifecycle).

---

## 0. Concept recap + the three design refinements

The Token Finder lets you write a small JS **finder** (same authoring experience as
strategies) that scores every Alpha token at each bar. The system keeps a constantly
evolving ranking; when a strategy trade slot opens, the best-ranked token is used for
the next trade. The UI shows how the ranking *would have evolved* over a chosen
timeframe, re-computed instantly when you tweak parameters, and lets you backtest a
strategy trading the top-ranked tokens instead of one fixed symbol.

Refinements to the original concept (idea kept intact):

1. **Finders never trade — strategies subscribe to them.** A finder is a passive,
   versioned ranking function (`finders` table, sibling of `strategies`). A strategy
   opts in via `finder_id` + `max_positions` instead of a fixed `symbol`. Marker
   engine (`engine.js`, the money path) is **untouched** — dynamic-symbol trades ride
   the existing STRAT_BUY/STRAT_SELL immediate-fire markers, which already carry a
   per-marker `symbol`. All live-safety guards (atomic claim, TTL, impact, caps)
   apply automatically.

2. **Fetch once, re-rank in the browser.** The ranking dataset (multi-token OHLC +
   buy/sell flow) is served by one new bulk endpoint, resampled server-side from
   `one_min_buckets`. The Finder tab downloads it once per timeframe selection, then
   every parameter tweak re-runs the ranking locally in milliseconds — the same
   instant-feedback loop the Strategy Workbench has.

3. **Flat-slot rebinding with hysteresis.** The finder decides *what* occupies a
   slot; the strategy still decides *when* to buy/sell. A slot holding a position is
   locked to its token until the strategy exits. A **flat** slot tracks the current
   top-ranked unheld token, rebinding only when a challenger's score beats the bound
   token's by a hysteresis margin (default 10%) — prevents churn. Identical rule in
   backtest and live, so cross-analysis results are honest.

## 1. Data reality check (why this design)

- `one_min_buckets` (collector, WAL SQLite): per-symbol 1-min OHLC + buy/sell USD
  volume + trade_count for **every** Alpha token, `bucket_start` indexed, pruned at
  ~7 days. This is the only multi-token history in the system — klines are a
  per-symbol Binance proxy and would need hundreds of REST calls per refresh.
- Therefore: **max honest ranking lookback = 7 days** at MVP. Longer lookback is a
  deliberate later phase (§9: downsampled archive table), not a blocker — 7 days of
  15-min bars is plenty to iterate on finder logic.
- Sizing: ~300 tokens × 672 bars (7d @ 15m) × 7 numbers ≈ manageable as compact JSON
  arrays (a few MB with a min-volume filter applied server-side). 1-min resolution
  for the full universe is too heavy for the browser — the endpoint resamples.

## 2. Finder authoring contract (strategy-sdk)

Same evaluation style as strategies (`new Function`, must define a top-level object):

```js
const finder = {
  name: 'Flow Momentum',
  params: { volWeight: 1.0, momoWeight: 2.0, minVol24hUsd: 100_000, lookback: 24 },

  // OPTIONAL hard filter — return false to exclude a token entirely (illiquid,
  // too new, etc.). Runs before score(). Excluded tokens never rank.
  filter(ctx) {
    return ctx.token.volume24h >= ctx.params.minVol24hUsd;
  },

  // REQUIRED — return a number (higher = better) or null to exclude at this bar.
  // ctx is the SAME shape as a strategy ctx (close/high/low/volume arrays, flow
  // buy/sell/net arrays, cached indicators, look-ahead guard) PLUS ctx.token
  // metadata { symbol, name, volume24h, priceChange24h }.
  score(ctx) {
    const momo = ctx.roc(ctx.params.lookback)[ctx.i];
    const netFlow = ctx.flow.net[ctx.i];
    if (momo == null || netFlow == null) return null;
    return ctx.params.momoWeight * momo + ctx.params.volWeight * (netFlow / 1000);
  },
};
```

New SDK files (plain ESM, zero deps, unit-tested like the rest):

- `strategy-sdk/src/finder.js`
  - `loadFinder(code)` → `{ finder, error }` (mirror of `loadStrategy`; requires
    `score`).
  - `createFinderCtx({ bars, flow, token, params, state })` — thin wrapper reusing
    `createCtx`'s guard/indicator-cache machinery (refactor the reusable core out of
    `runtime.js` rather than duplicating it). No `buy`/`sell`/`position` — finders
    can't trade. One ctx per token per run; indicator caches persist across bars.
  - `runRanking({ code|finder, universe, params, topN })` → for each evaluation time
    `t`: `rankings[t] = [{ symbol, score, rank }]` sorted desc, plus per-token
    exclusion reasons and `error`. `universe` = the parsed `/universe` payload
    (§3.2): aligned bar arrays per symbol on a common time axis.
  - `forwardReturns(rankings, universe, horizonBars)` → for finder validation: at
    each time, forward % return of each ranked token over the horizon, top-K average
    vs universe median. This is the "did the finder actually pick winners?" metric.
- `strategy-sdk/src/portfolio.js`
  - `runPortfolioBacktest({ strategyCode, finderCode, universe, maxPositions,
    switchMarginPct, feePct, slippagePct, intervalSec, params, finderParams })`.
  - Driver logic: maintain `maxPositions` slots. Per bar: (1) run the ranking,
    (2) for each **flat** slot apply the rebinding rule (bind top-ranked token not
    held/bound elsewhere; rebind only if challenger score > bound score ×
    (1 + switchMargin)), (3) run the bound strategy instance's `onBar` per slot —
    each slot is an independent single-symbol run reusing the existing
    `runBacktest` fill semantics (next-bar-open fills, pessimistic SL-first
    brackets, fees/slippage). On rebind, the new instance warm-replays that token's
    history with actions suppressed (same trick as the live runner's init).
  - Returns per-slot trade lists (annotated with symbol + "why bound" ranking
    snapshot), combined equity curve, combined stats, and the full ranking timeline
    (so the UI can draw fills on top of the ranking river).
- `strategy-sdk/src/templates.js` — add `FINDER_TEMPLATES` (flow-momentum,
  volume-spike, relative-strength vs universe, quiet-accumulation) with heavy
  comments; these double as guide material (§7).

Existing `runBacktest` stays byte-for-byte unchanged — single-symbol strategies keep
working and stay comparable to old results.

## 3. API + DB (crypto-data-collector)

### 3.1 `finders` table (`database/models.py`) — mirror of `strategies`

```
id (UUID pk) · name · code · params_json · interval (default '15m')
created_at · updated_at   ← bumped ONLY on code/params/interval changes
last_run_at · last_error  ← written by the engine-side finder evaluator
```

No `mode` column — finders are passive; arming lives on the strategy. CRUD endpoints
`GET /finders` (list, no code) / `GET|POST|PATCH|DELETE /finders/{id}` mirroring the
strategies endpoints exactly, including the **updated_at-only-on-definition-change
rule** (it is the runner's hot-reload key, same as strategies). DELETE must 409 if
any strategy references the finder.

### 3.2 `GET /universe` — the bulk ranking dataset

```
GET /universe?interval=15m&start_ms=&end_ms=&min_vol_24h=50000&symbols=
→ {
    interval, times: [t0, t1, ...],                  // common ms axis, ascending
    tokens: [{ symbol, name, volume24h, priceChange24h,
               o: [...], h: [...], l: [...], c: [...],
               buy: [...], sell: [...], trades: [...] }]   // aligned to times, null-padded
  }
```

One SQL `GROUP BY symbol, bucket_start/interval_ms` over `one_min_buckets`
(open = value at MIN(bucket_start) per group via window or two-pass, high = MAX,
low = MIN, close = value at MAX, volumes = SUM — same shape the collector already
writes, just resampled). `min_vol_24h` joins `latest_tickers` to pre-filter the
universe server-side — this is what keeps the payload a few MB. Allowed intervals:
5m/15m/30m/1h. Add `/universe` to `NOISY_PATHS` so the request-logging middleware
skips it (hard requirement — this response is large and the UI refetches on
timeframe change; we've had the 470 MB debug-log incident before).

### 3.3 `strategies` table migration + endpoint tweaks

- Add `finder_id (nullable FK-ish)` and `max_positions (int, default 1)`.
- `symbol` becomes nullable **only when** `finder_id` is set (validate in
  create/update). A symbol-bound strategy is unchanged.
- `finder_id`/`max_positions` changes **bump `updated_at`** (they change what the
  runner should do, same as a symbol change).
- `StrategyListItem`/`StrategyResponse` gain the new fields; wallet dashboard needs
  no change (trades already carry their own symbol).

### 3.4 Restart/ordering rules (add to CLAUDE.md when built)

API window restarts before Engine window (new columns + endpoints must exist before
the runner asks for them). No new marker types → no marker-type ordering hazard.

## 4. Charting UI — new 🔍 Token Finder tab

`view === 'finder'` in `App.jsx` next to ⚡ Strategies; new
`src/components/FinderWorkbench.jsx` cloning the workbench layout (saved-list rail,
CodeMirror editor, params form, toolbar). Data flow:

1. Toolbar: interval (5m/15m/30m/1h), lookback window (1–7 days), min-24h-volume
   filter, Top-N (default 5), forward-return horizon.
2. On toolbar change: one `GET /universe` fetch, cached in a ref (same
   `barsCache` pattern the workbench uses).
3. On code/param edit (debounced 600 ms, same as workbench): `runRanking` +
   `forwardReturns` locally — **no refetch**. This is the instant-feedback loop.

Visualization (top→bottom):

- **Ranking river (bump chart)** — the display you described: time across the
  bottom, top-N rank positions as rows, one colored line per token showing it
  entering/climbing/dropping out of the top N. Hover = scores at that time; click
  a time = pin it. Implemented as a custom SVG/canvas component (lightweight-charts
  doesn't do bump charts; ~150 lines, no new deps).
- **Pinned-time ranked table** — full ranking at the pinned (or latest) time:
  rank, symbol, score, score components if the finder `ctx.log`s them, 24h volume,
  and **forward return over the horizon** color-coded green/red. This is the
  "would have been selected here — and here's how it actually did" view, made
  quantitative instead of eyeball-only.
- **Finder quality strip** — per evaluation time: avg forward return of the top-K
  vs the universe median (two lines + spread). If the top-K line doesn't beat the
  median line, the finder isn't finding anything; this single chart answers that
  before you ever wire it to a strategy.
- Save/Save-As/Delete against `/finders`, red `last_error` dot, same as workbench.

## 5. Strategy Workbench integration (cross-analysis)

- Symbol picker becomes a **token-selection control**: `Fixed symbol` (unchanged
  path) or `Finder: <saved finder>` + `Max positions` (1–10) + switch-margin %.
- With a finder selected, the backtest button runs `runPortfolioBacktest` over the
  `/universe` dataset (fetched once, cached) instead of single-symbol `runBacktest`.
- Results view additions (BacktestResults/BacktestChart stay for fixed-symbol runs):
  - Combined equity curve + combined stats (same stat set, aggregated).
  - **Slot timeline**: per slot, colored bands showing which token was bound when,
    with buy/sell arrows inside the bands — this is the ranking river with the
    strategy's actual fills painted on it, i.e. exactly the "see how the strategy
    would have performed trading the highest-ranked tokens at each decision point"
    view.
  - Trades table gains a symbol column + the rank the token held at entry.
- OFF/DRY/LIVE toggle unchanged (LIVE confirm dialog unchanged; engine risk limits
  still the final guard).

## 6. Live/dry execution — marker-engine additions

New `marker-engine/finder-runner.js` + a portfolio mode inside
`strategy-runner.js`. Engine (`engine.js`/`pure.js`/`chain.js`) untouched.

- **FinderEvaluator** (one per finder referenced by any armed strategy): every
  finder-interval close (+ lag, same `BAR_FETCH_LAG_MS` idea), fetch a small
  `/universe` slice (enough bars for the finder's longest lookback — cheap, it's
  one SQL query), run `runRanking` for the latest bar only, cache the result,
  PATCH `last_run_at`/`last_error` on the finder row. Heartbeats as
  `strategy_runner` (already covered).
- **Portfolio strategy runner**: a strategy with `finder_id` gets `max_positions`
  slots instead of one symbol runner. Per slot: on finder tick, apply the same
  rebinding rule as the backtester (flat slots only, hysteresis). Rebinding = the
  existing `initRunner` dance on the new symbol (500 klines, warm-up replay with
  suppressed actions, flow if needed). Positions rebuild from
  `GET /trades?strategy_id=X` **grouped by symbol** (one strategy can now have
  fills across several tokens; PAPER for dry, FILLED for live — unchanged rows,
  just a groupby in `reloadPosition`).
- LIVE signal path: unchanged `POST /markers` STRAT_BUY/STRAT_SELL with the slot's
  current symbol. Claim atomicity, `IMMEDIATE_TTL_MS`, impact guard, daily cap,
  `max_trade_usd` all apply with zero new code. DRY path: unchanged PAPER trades,
  per-slot local bracket simulation.
- Safety additions specific to dynamic selection:
  - A slot may only bind tokens present in the engine's token map (tradeable on
    chain) — the finder's `filter` can't know that; the runner enforces it.
  - `reconcile()` treats `finder_id`/`max_positions` changes as definition changes
    (they bump `updated_at`, so this falls out for free).
  - If the finder row has `last_error`, portfolio strategies keep managing OPEN
    positions but stop rebinding flat slots (fail-closed for new exposure, fail-open
    for exits).

## 7. Guide system (both modules)

A shared slide-over **📖 Guide** panel, openable from the Strategies and Finder
tabs (and deep-linkable to a section, e.g. the Finder tab opens it at the finder
contract):

- New `crypto-charting-ui/src/components/GuidePanel.jsx` rendering markdown from
  `strategy-sdk/docs/*.md` (guide content lives in the SDK repo-side so it
  versions with the contract it documents; Vite `?raw` imports, no fetch needed).
- Content files: `authoring-basics.md` (what runs where, the no-look-ahead rule,
  bars/flow/ctx anatomy), `strategy-contract.md`, `finder-contract.md`,
  `indicator-reference.md` (every `ctx.*` helper with a one-liner + example),
  `recipes.md` (annotated walkthroughs of each template, including one full
  "finder + strategy together" example).
- Each code block gets an **"Insert into editor"** button (guide panel calls back
  into the active workbench), and each `ctx.*` reference links into the indicator
  reference — that's the "help the user use the module efficiently" requirement
  without building anything heavier. (A chat-assistant-style guide can be layered
  on later; static-but-interactive docs are the right MVP.)

## 8. Build order (each phase leaves the system working)

| Phase | Scope | Restart needed |
|-------|-------|----------------|
| **A** | DB: `finders` table + strategies migration; API: finders CRUD, `/universe`, NOISY_PATHS | API window |
| **B** | SDK: `finder.js`, `portfolio.js`, `runtime.js` core refactor, `FINDER_TEMPLATES`, unit tests (`finder.test.js`, `portfolio.test.js` — ranking determinism, look-ahead guard on finder ctx, rebind hysteresis, warm-up parity with single-symbol backtest on a 1-token universe) | none (nothing imports it yet) |
| **C** | Finder tab UI: FinderWorkbench, ranking river, ranked table, quality strip | Chart UI (Vite picks it up via HMR; no vite.config change — `@sdk` alias already exists) |
| **D** | Strategy Workbench integration: token-selection control, portfolio backtest results, slot timeline | none |
| **E** | Engine: finder-runner + portfolio slots in strategy-runner, grouped position rebuild | Engine window (after A is live) |
| **F** | Guide panel + docs content, wired into both tabs | none |
| **G** *(optional, later)* | Longer lookback: collector writes a `fifteen_min_buckets` archive (retention ~90 days, written in the same `periodic_flush`), `/universe` reads it for >7-day requests | Collector + API |

Key acceptance test before E goes live: a portfolio backtest over a 1-token universe
with `max_positions=1` must produce **identical trades** to the existing
single-symbol backtest of the same strategy — that's the parity proof that the
portfolio driver didn't change fill semantics.

## 9. Cross-app contracts introduced (CLAUDE.md additions when built)

- **Finder shape** (`finders` row + contract): written by Finder tab, read by
  Strategy Workbench (cross-analysis) and finder-runner. `updated_at` = hot-reload
  key, same rule as strategies — mode-less, so only definition edits bump it.
- **`strategies.finder_id` + `max_positions`**: chart UI writes, runner reads,
  API validates (`symbol` may be null only with `finder_id`). Bump `updated_at`.
- **`/universe` payload shape** is shared verbatim by FinderWorkbench,
  StrategyWorkbench portfolio backtests, and finder-runner — one parser in the SDK
  (`normalizeUniverse()`), never three.
- Rebinding rule (flat-only, hysteresis, warm-up replay) must stay identical in
  `portfolio.js` (backtest) and `strategy-runner.js` (live) — it lives in a shared
  pure function in the SDK (`chooseBinding(slots, ranking, opts)`) imported by both.
