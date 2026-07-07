# Data Independence Plan — Binance out, self-hosted on-chain data in (multichain)

**This file is the binding plan for the market-data migration.** It has the same
authority for data work that `SAAS-ROADMAP.md` has for SaaS work; when they overlap,
the newer statement here wins (reconciliation table in §8). Execution rules and the
never-touch list from `ROADMAP.md` still apply to every session. Written 2026-07-06.

> ## ⏰ HARD DEADLINE — end of day **2026-07-07**
>
> Binance market data may not be used commercially without an enterprise license the
> owner cannot obtain (region restriction). **Every Binance market-data feed must be
> OFF before the cutoff.** The four real dependencies (verified by grep, 2026-07-06):
>
> 1. `crypto-data-collector/standalone_collector.py` — `wss://nbstream.binance.com`
>    (aggTrade/ticker firehose)
> 2. `crypto-data-collector/fetcher/alpha_api.py` — `https://www.binance.com/bapi/defi/v1`
>    (token list, REST tickers, klines)
> 3. `crypto-data-collector/api/server.py` `/klines` — proxies Binance via alpha_api
> 4. `crypto-charting-ui/src/components/Chart.jsx` — direct `nbstream.binance.com`
>    kline WebSocket (live candles)
>
> Also being replaced while we're in here (not legally urgent, but third-party feeds in
> the money path): `marker-engine/chain.js getBnbPriceUsd` calls **DexScreener** for the
> BNB/USD price. The `bsc-dataseed.binance.org` URLs elsewhere are **public blockchain
> RPC nodes, not market data** — no license issue; swapped to our paid RPC for
> reliability, not legality.
>
> **Critical path: M0 → M1 → M2 → M3 → M4.** M4 is the cutover; it must land before
> the cutoff. M5+ (more chains, Solana, rug filter, listings) follow immediately after.
>
> **Pacing (owner decision 2026-07-06): machine speed.** The M-phases are commit-and-
> verify **checkpoints, not calendar units** — execute as many back-to-back in one
> session as context allows; a fresh window is context hygiene between big batches,
> nothing more. The only true gates are M0 (owner pastes RPC keys) and each phase's
> "Done when" checklist. Realistic batching: M1+M2 in one session, M3+M4 in the next,
> M5–M9 in one or two more.
>
> **Fail-safe (M-KILL):** if anything external stalls past the deadline, stop the
> Collector window, PAUSE the engine (stale prices must never drive trades), close
> chart tabs. Legal line held; trading resumes when M4 lands. Floor, not plan.

---

## 1. The shape — what replaces Binance

Binance never was the market. The tokens trade **on-chain in DEX pools** (PancakeSwap
etc.), and that is also where OUR trades execute (OpenOcean routes into those same
pools). So the replacement is not "another Binance": the collector will read the
blockchain itself — the same primary source every paid data vendor resells.

```
BSC / Ethereum / Base RPC nodes (QuickNode + public fallback)
        │  every ~2s: new blocks → getLogs over the watched pools
        ▼
  EVM ingester (one code path, N chain configs)      Solana ingester (M6, own module)
        │  decode Swap/Sync events → real buy/sell sides, USD via quote anchors
        ▼
  one_min_buckets / latest_tickers / tokens / pools   (same DB, same API, same UI)
        ▼
  FastAPI :8000 — /klines now served from OUR buckets (same response shape)
        ▼
  Alpha Terminal + strategy runner + engine — unchanged consumers
```

What gets BETTER, not just legal:
- **Real trade direction.** Today the collector *guesses* buy/sell with a tick rule.
  A swap event states its direction. Every finder and strategy's flow data improves.
- **One price feed.** The chart's separate Binance WebSocket dies; charts, engine, and
  dashboard all read the same buckets. The CLAUDE.md "two feeds" confusion section
  gets deleted, not documented.
- **Our own universe.** No more ~400-token Alpha list: every token above a liquidity
  floor, on every configured chain, discovered automatically at pool creation.
- **Gap-proof.** A dropped Binance WebSocket lost data forever. The chain is
  replayable — after any outage the ingester re-reads the missed blocks exactly.
- **Liquidity known per token** (finders can filter; the engine's impact guard gets a
  sanity input), and later per-token security data (M7 rug filter).

What we give up (accepted by owner 2026-07-06): deep history — charts/backtests build
up from cutover day (1m strategies backtestable after ~8h, 15m after ~5 days, 1h after
~3 weeks; a paid archive backfill remains possible later if ever wanted). Holder
counts / smart-money analytics are out of scope (sidecar API later if a feature needs
them). Multichain **data** is day one; multichain **live trading** is not (AD-D8).

---

## 2. Architecture decisions (settled — do not re-litigate)

- **AD-D1: Token identity is `(chain, contract_address)`.** `tokens.id` becomes
  `"{chain}:{address_lowercase}"` (e.g. `bsc:0xabc…`). The human-facing **slug** stored
  in `tokens.symbol` is `"{SYMBOL}_{chain}"` (e.g. `CAKE_bsc`, `PEPE_eth`); if that
  slug is somehow taken on the same chain, append the first 4 address hex chars
  (`PEPE-1a2b_eth`). Slugs are assigned once and never change. UI shows the clean
  display symbol + a chain badge; slugs are the internal join key.
- **AD-D2: Hot tables keep `symbol` as their key.** `one_min_buckets`,
  `fifteen_min_buckets`, `latest_tickers`, `chart_markers`, `trade_history`,
  `strategies` keep their existing `symbol` column — it now holds slugs. Chain lives
  on `tokens` only. This preserves every cross-app contract (marker shape, /universe
  payload, strategies.symbol='' + finder_id) with minimal churn.
- **AD-D3: One EVM ingester, N chain configs.** A chain registry (Python config)
  defines per chain: RPC endpoints (primary + fallback), DEX factories (Pancake v2/v3
  on BSC; Uniswap v2/v3 on Ethereum/Base…), trusted quote tokens (WBNB/WETH/stables),
  the stable anchor pool, liquidity floor, poll cadence, finality lag, explorer URL.
  Adding an EVM chain = config, not code. `GET /chains` exposes it to the UI.
  Launch set: **bsc, ethereum, base** (arbitrum ready in config, off by default).
  Solana is a separate ingester module (M6) writing the same tables (`chain='solana'`,
  address = mint).
- **AD-D4: Poll blocks, don't stream logs.** The ingester loop asks every ~2s (per
  chain cadence): current block → `eth_getLogs(fromBlock, toBlock, watched pool
  addresses, Swap/Sync topics)` → decode → buckets. One or two RPC calls per tick
  instead of a per-event push firehose = ~50–60M provider credits/month across three
  chains (fits QuickNode's free/Build tier) vs. hundreds of millions for per-event
  subscriptions. Freshness ≈ the 3s lifeline the engine already lives on. Gap
  backfill after downtime is the SAME code path with a wider block range. A 2-block
  finality lag (config) absorbs reorgs.
- **AD-D5: Prices via quote anchors, reserve-based.** v2 pools: price from Sync-event
  reserves; v3: from the Swap event's sqrtPriceX96 — both immune to fee-on-transfer
  distortion. Token USD = pool ratio × quote-token USD; quote USD comes from deep
  stable anchor pools (WBNB/USDT, WETH/USDC…). Only pools quoted in a trusted quote
  token are priced — a scammer's fake pool against a garbage quote token can never
  set a price. Native-coin slugs (`WBNB_bsc`, `WETH_eth`…) get `latest_tickers` rows
  like any token — the engine's BNB price comes from here (AD-D7).
- **AD-D6: Curated pool watchlist, self-maintaining.** New `pools` table (address,
  chain, dex, kind v2/v3, token0/1, fee tier, liquidity USD, watch flag, created_at).
  Bootstrap per chain = one-time factory-history scan (chunked getLogs) + multicall
  reserve check; watch pools ≥ the chain's liquidity floor (default $25k). Live:
  factory PairCreated/PoolCreated events are in the same getLogs poll → new pool →
  fetch token metadata (symbol/name/decimals/totalSupply via multicall) → if it
  clears the floor, auto-added and data flows. Hourly reserve sweep re-checks;
  pools drop at 50% of the floor (hysteresis, no flapping). 24h ticker stats
  (`price_change_24h`, `volume_24h`) are computed from our own buckets.
- **AD-D7: Engine price/RPC hygiene.** `getBnbPriceUsd` primary source becomes our
  API (`WBNB_bsc` from `token_prices`), keeping the existing on-chain PancakeSwap
  router call as fallback; the DexScreener call is deleted. Engine `RPC_URL` default
  moves to the paid endpoint (env), public dataseed stays as fallback.
- **AD-D8: Multichain trading is OUT of scope.** The engine live-trades BSC only.
  The tradeable filter (slot binding + LIVE arm validation) = `chain=='bsc'` AND has
  contract address. DRY/paper strategies may run on ANY chain's data (paper needs no
  wallet). Arming LIVE on a non-BSC symbol → 4xx with a human-readable message.
  Multichain execution is a future roadmap item, not this plan.
- **AD-D9: `/klines` keeps its exact response shape** (Binance kline array layout,
  incl. `end_ms` support), now resampled SQL-side from our buckets (1m base, 15m
  archive for older ranges; same GROUP BY integer-division pattern as `/universe` —
  beware the SQLAlchemy true-division gotcha). `volume` = buy+sell USD (semantic
  change, verify SDK/chart don't assume token qty). New `?include_open=1` returns the
  forming bar; Chart.jsx polls it every 3s to replace the Binance live WebSocket
  (SSE later, M9). The runner and workbench stay byte-compatible consumers.
- **AD-D10: Binance-derived data is purged at cutover** (`one_min_buckets`,
  `fifteen_min_buckets`, `latest_tickers`) after a DB backup. The owner's OWN records
  (`trade_history`, markers, strategies, finders) are kept and remapped
  ALPHA_X → new slug via `tokens.contract_address`. Alpha tokens with no supported-
  chain address are parked `status='retired'` under their old symbol (no prices, not
  tradeable, harmless). Retention knobs: `RETENTION_1M_DAYS` (default 7),
  `RETENTION_15M_DAYS` (default 90) — ~2.5–4 GB at ~5–6k tokens across 3 chains at
  defaults; owner can raise later, costs are pennies.

---

## 3. M0 — Owner prerequisites (~20 minutes, do BEFORE the M2 session)

- [x] **M0.1 (you) Node provider key.** ✔ Alchemy key received + verified live on
      all four chains (BSC/Ethereum/Base/Solana) 2026-07-07; stored in
      `crypto-data-collector/.env`. **OWNER DECISION 2026-07-07: NO failover
      provider** ("I don't want failsafe, I want to be alerted of an error") —
      single provider, failures must be LOUD: per-chain heartbeat → red health dot
      → uptime-monitor email, plus the engine's stale-price guard (M3) so trading
      pauses safely instead of running on frozen prices. Outages lose nothing —
      the chain replays, gap backfill recovers every missed block. No cards yet:
      M2 measures the real credit burn (budget $0–50/mo, worst case ~$120 before
      cadence tuning) before any paid tier.
- [x] **M0.2 (you) Confirm launch chains.** BSC + Ethereum + Base live 2026-07-07;
      Arbitrum config-ready but off, Solana in M6.
- [x] **M0.3 Backup** ✔ taken 2026-07-07 06:03 (`backups/crypto_data_2026-07-07_060336.db`)
      before M1; **another one runs before the M4 purge — non-negotiable.**

---

## 4. The phases (checkpoints — batch them per the pacing note; WORKFLOW.md protocol)

### M1 🧠 — Schema + chain registry + remap script ✅ 2026-07-07 (commit 34691ec)

All checklist items done; remap dry-run reviewed during M4 prep instead (the
mapping is deterministic and the tool prints it before writing).

### M2 🧠 — EVM ingester ✅ 2026-07-07 (commits 34691ec + 3747fec) — RUNNING

Live on bsc+ethereum+base in one session. 140/16/9 tokens above floors, 177
watched pools, WBNB within 0.4% of DexScreener (JAGER to 4 sig figs),
heartbeats green (`collector`, `collector:{chain}`), forward watch auto-added
a new BSC pool live. Findings that changed the design, recorded here:
- **Alchemy free tier caps eth_getLogs at 10 blocks** → adaptive range
  stepping (learns the cap, regrows hourly). Live polling fits; the 30-day
  bootstrap factory scan does NOT → runs on a public bulk-scan lane instead.
- **publicnode gates archive getLogs** → the event-based backscan is dead, BUT
  the real answer needed no archive at all: **v2 factories are enumerable by
  index (`allPairs(i)`)** — a background deep scan now walks EVERY pair on
  every factory (resumable cursor, throttle-proof, one chain at a time),
  keeps quote-paired pools ≥ the floor, probes v3 pools per surviving token.
  Owner decision 2026-07-07: **breadth over latency** — floors lowered to
  $10k (bsc/base), cadence bar-aligned (bsc 15s — live TP/SL rides this
  price — base 30s / eth 60s). BSC passed 1,000 watched pools while the scan
  was still in its first 2% of PancakeSwap's 2.6M pairs. Nothing is deferred.
- **Credit burn — RE-TUNED to the owner's ≤$49 budget (2026-07-07):** Alchemy
  has NO mid-tier plan (free 30M CU → PAYG $0.45/M), and getLogs (75 CU) is
  88% of every poll, so cost = poll cadence, linearly. Defaults now: BSC 4s /
  Base 10s / ETH 12s ≈ ~109M CU/mo ≈ **$45–49/mo**; `POLL_SECONDS_<CHAIN>`
  env overrides; 15/30/30 fits the FREE tier at ~15–30s staleness. Confirm
  the real number from the Alchemy dashboard + hourly debug_logs after 24h.
- **Parallel-run hazard burned in (2026-07-07):** the old collector's token
  sync DELETED all new-format token rows — its guard patch only applies
  after that process restarts. Restarted with the patch (verified "-0
  removed"); bootstrap now repairs orphaned pools automatically. Until M4,
  if the old collector window is ever relaunched from stale code, the
  repair self-heals on the next new-collector restart.
- v3 prices MUST come from slot0/swap sqrtPrice (balance ratios lie);
  finality lag 8 (bsc)/5 (base) absorbs load-balanced provider skew.

Original M1/M2 checklists: all items delivered as specified except two
deviations recorded above (bootstrap deep-scan deferred to M5 pending PAYG;
remap dry-run review moved to M4 prep). Both run alongside the old collector
now — the new feed is live data the old stack simply doesn't read yet.

### M3 🧠 — API cutover (/klines, /universe, engine price)

- [ ] `/klines` rewritten per AD-D9 (serve from buckets, same shape, `end_ms`,
      `include_open=1`); Binance import path unused. Verify the strategy runner and
      the workbench backtester against it (parity: same bars in = same fills out).
- [ ] `/universe` + SDK `normalizeUniverse`: chain passthrough + `chains` filter
      param (payload shape otherwise unchanged; both workbench tabs + FinderHub
      inherit it via the SDK — never hand-parse, per the existing contract).
- [ ] Engine: `getBnbPriceUsd` re-pointed per AD-D7 (API primary, on-chain router
      fallback, DexScreener deleted); `RPC_URL` env'd; token map from `/tokens`
      handles slugs + `status`/chain filtering; tradeable filter per AD-D8; LIVE-arm
      validation message for non-BSC symbols.
- [ ] **Stale-price guard** (M0.1 owner decision): the engine skips cross evaluation
      for a marker when its token's `last_updated` is older than a threshold
      (default 3 min, env) and logs loudly — data outage = safe pause + alert,
      never trades against frozen prices. (Pure sizing/claim/TTL logic untouched.)
- [ ] Engine + SDK test suites green (32 + 45, incl. both parity gates).
- **Done when:** with the NEW collector feeding, a chart loads candles for a slug
  token via /klines, the workbench backtests it, and the engine (dry) sizes a trade
  using the API's WBNB price. Old collector still running for the old symbols.

### M4 🧠 — CUTOVER + Binance removal (⏰ must land before EOD 2026-07-07)

Stack DOWN for this one (engine PAUSED first, then all four windows closed).
`backup-db.bat` before anything.

- [ ] Run `remap_symbols.py` for real (markers, trades, strategies → slugs).
- [ ] Purge Binance-derived rows (AD-D10).
- [ ] Chart.jsx: Binance WS deleted → 3s forming-bar poll; symbol prefix logic
      removed; chain badge + per-chain explorer links (registry-driven).
- [ ] Delete `standalone_collector.py` + `fetcher/alpha_api.py` (git keeps them);
      `start.bat` collector window → `onchain_collector.py`.
- [ ] **Verify: `grep -ri "binance" --` across the repo returns only public-RPC URLs,
      comments, and historical docs — zero market-data endpoints.** Record the
      output in the commit message.
- [ ] Restart in order (API → Engine → UI), full smoke test: dashboard prices tick,
      chart draws + live bar moves, a DRY strategy runs a bar on a slug symbol,
      wallet panel balances still resolve (remapped symbols join to tokens).
- [ ] Owner decision: one $5 LIVE test trade on a BSC slug token to prove the money
      path end-to-end (recommended; same $5 discipline as C3).
- **Done when:** the grep is clean, the stack runs on our data only, and this file's
  deadline banner is marked ✔ with the cutover timestamp.

### M5 🔧 — Multichain enablement (Ethereum + Base)

- [ ] Bootstrap + enable ethereum/base configs (scan, floors, anchors); verify
      per-chain heartbeats, /universe chain filter, finder tab chain selector, UI
      chain badges; raise/keep the /universe token cap (tune with payload size).
- [ ] DRY-run a strategy on an eth or base token end-to-end (paper only, AD-D8).
- [ ] Update `DEPLOY.md` (Railway collector needs the RPC env vars) + SaaS cost
      table (+$0–49 node provider).

### M6 🧠 — Solana ingester

- [ ] Uses the same Alchemy key (Solana enabled in M0.1; Helius is the fallback
      option if Alchemy's Solana methods disappoint); separate `ingest/solana.py`
      module: poll-based transaction/log ingestion for Raydium/Orca/Pump pools,
      same pricing-anchor + bucket-writer path, `chain='solana'`, mint addresses,
      SOL_solana anchor. Paper trading works on day one; live trading stays BSC.

### M7 🧠 — Token security / rug filter (first NEW feature)

- [ ] GoPlus API (free tier) fetch at listing + daily refresh → `tokens.security_json`
      (honeypot, buy/sell tax, LP lock, mint authority, top-10 concentration).
- [ ] Finder ctx: `ctx.token.security` exposed in the SDK (workbench + FinderHub,
      same object — backtest/live parity holds); slot-bind safety gate: flagged
      tokens are excluded from binding unless the strategy explicitly opts in.
- [ ] UI: security badges on token pages + finder ranked table; Guide docs updated.

### M8 🔧 — New-listing feed + screener/docs polish

- [ ] "New tokens" view fed by `pools.created_at`/`tokens.listed_at`; `listed_at` +
      liquidity exposed to finders (ctx.token) for sniper-style strategies.
- [ ] Sweep `strategy-sdk/docs/*.md`, Guide panel text, and the DeepSeek assistant
      prompts for stale "Binance Alpha" wording; CLAUDE.md rewritten as-built.

### M9 🔧 — Ops hardening (alert-first, per the M0.1 owner decision)

- [ ] **Failure-ALERT drill** (replaces the old failover drill): kill the RPC feed
      mid-run → per-chain heartbeat red within 2 min, `/health` degrades, uptime
      monitor emails the owner, stale-price guard holds trading; restore → gap
      backfill verified lossless. UptimeRobot monitors wired to `/health`.
- [ ] Credit-usage + bucket-coverage panel in Settings health; optional SSE live
      candles replacing the 3s poll; retention knobs surfaced.

---

## 5. Costs (monthly, replaces the old "which vendor" question)

| Thing | Cost | Notes |
|---|---|---|
| Alchemy (BSC+ETH+Base+Solana RPC) | $0 → ~$50 | free 30M CU/mo first; M2 measures real burn before paying |
| UptimeRobot (the error alarm) | $0 | owner decision: alerts instead of failover |
| GoPlus security API (M7) | $0 | free tier |
| Extra DB storage | ~$0 | 2.5–4 GB at default retention; pennies on Railway later |
| **Total** | **$0–100** | vs. $199–499/mo vendor route; zero licensing exposure |

## 6. Risks, honestly

1. **The 30-hour window.** M1–M4 is aggressive. The M-KILL fail-safe (banner) caps
   legal exposure if engineering slips; trading pauses rather than running on stale
   or unlicensed data. Decision pre-made, no deadline heroics.
2. **Price math bugs** (decimals, v3 tick math) put wrong prices in front of the
   engine. Mitigations: unit tests on recorded fixtures (M2), eyeball parity checks
   vs public screeners (M2/M4 checklists), the engine's existing impact guard
   (OpenOcean quote vs collector price) as the last line — a wrong collector price
   makes trades ABORT, not misfire.
3. **Single-provider outages** (owner decision, M0.1: no failover). An Alchemy
   outage stops the feed until it recovers; the system's response is pause + alert
   + lossless backfill (heartbeats red, uptime email, stale-price guard holds the
   engine, chain replay refills every missed bucket). Accepted trade-off.
4. **Universe noise**: an open universe admits scam tokens. Liquidity floor +
   trusted-quote pricing (AD-D5/D6) now; GoPlus gate (M7) next; the engine still
   only trades what a strategy/finder explicitly binds.
5. **Volume semantics** (`/klines` volume becomes USD) — audited in M3 against SDK
   and chart usage before cutover.

## 7. What this plan deliberately does NOT do

No multichain LIVE trading (AD-D8). No historical backfill purchase (owner accepted
build-up; option stays open). No holder/smart-money analytics. No WS/SSE push in the
critical path (M9 optional). No engine claim/TTL/chooseBinding changes — never-touch
list untouched throughout.

## 8. Reconciliation with the other plans

| Item elsewhere | Status now |
|---|---|
| SAAS-ROADMAP §5 risk 2 ("Binance data terms… lawyer question") | **Realized 2026-07-06; resolved by this plan** — no Binance data at all post-M4 |
| SAAS-ROADMAP S1.4 lawyer question #1 (redistributing Binance-derived data) | Moot after M4 (chain data is public; our buckets are our own work) — strike from the lawyer list |
| SAAS-ROADMAP S3.2 Railway deploy (collector) | Gains RPC env vars — handled in M5, noted in DEPLOY.md then |
| SAAS-ROADMAP §4 cost table | +node provider line (M5 updates it) |
| CLAUDE.md "Two independent price feeds" section | Obsolete after M4 (one feed); rewritten in M8 |
| ROADMAP.md execution rules + never-touch list | Apply unchanged to every M session |

## 9. Immediate next steps

1. **You, today:** `OWNER-CHECKLIST.md` steps 2–3 (Alchemy + QuickNode keys) and
   M0.3 backup (~15 min). The rest of the checklist in parallel as you get to it.
2. **Next session:** "Do DATA-ROADMAP" — M-phases execute back-to-back at machine
   speed, batched per the pacing note, each checkpoint committed and verified.
   M4 closes the legal gap; everything after it is upside; then the deploy
   (`DEPLOY.md`) proceeds as your checklist values arrive.
