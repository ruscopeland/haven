# Reorganization Roadmap — Alpha Terminal

Goal: merge the three browser apps' functionality into ONE app (the charting UI, working
title "Alpha Terminal") with a Dashboard home page, while the money path stays in the
headless marker-engine daemon. Zero-breakage strategy: the old wallet app keeps running
in parallel until the merged app reaches parity — only then is it retired.

**Read `WORKFLOW.md` before executing anything.**

---

## Execution rules (BINDING for every session, every model)

1. **One task per session.** Do the task named by the user. Do NOT start the next one.
2. **Touch only the files listed in the task.** If you believe another file must change,
   STOP and report why instead of editing it.
3. **No refactoring beyond the task.** No renaming, no "cleanups", no dependency upgrades.
4. **Commit before and after.** Start: `git add -A && git commit -m "checkpoint before <task>"`
   (skip if working tree clean). End: commit with the task ID in the message.
5. **Definition of done is the checklist in the task.** If you cannot verify a checklist
   item, say so explicitly — do not claim success.
6. **Never touch:** `marker-engine/pure.js` claim/TTL logic, the `/markers/{id}/claim`
   endpoint, `chooseBinding` in strategy-sdk — unless the task explicitly says so.
7. **Restart rules in CLAUDE.md apply** (API before Engine, etc.).

Task markers: 🧠 = do with the strongest model (design/judgment). 🔧 = mechanical,
fully specified, any model. Status: `[ ]` todo · `[x]` done (update this file as you go).

---

## Architecture decisions (settled — do not re-litigate)

- **AD-1: One SPA is safe.** The old fear ("other pages stop working") came from when the
  browser executed trades. Today the money path is the headless marker-engine daemon;
  collector/API are separate processes. The browser is display + control only. Switching
  tabs in a single-page app does not stop anything that matters; even closing the browser
  doesn't stop trading. The ONE exception is the wallet's legacy in-browser auto-trade
  engine (60s localStorage loop) — it dies with its tab. It is retired in Phase D.
- **AD-2: The browser must end up key-free.** Manual swaps become **immediate-fire
  markers** executed by the engine (same path strategies already use: full guard stack,
  TTL, atomic claim). After Phase C the private key exists ONLY in `marker-engine/.env`.
  This is also the correct shape for a future multi-user product.
- **AD-3: Multi-user/SaaS is deferred (Phase F), but every phase must keep these
  boundaries:** one API as the only data door, headless execution, key-free UI. The
  custody question (who holds users' keys) is a business+legal decision — flagged, not
  solved here. Do not add auth/billing code before Phase F.
- **AD-4: The charting UI is the surviving app.** The wallet app is ported INTO it panel
  by panel, then deleted. `crypto-wallet` code stays untouched until Phase D (it keeps
  working as the fallback dashboard the whole time).

---

## Phase A — Safety net + navigation fix ✅ 2026-07-05

- [x] A1 🧠 Git repo, `.gitignore` (secrets/DB excluded), baseline commit, tag `v0-baseline`.
- [x] A2 🧠 This roadmap + `WORKFLOW.md` + DB backup script (`tools/backup_db.py` + `backup-db.bat`).
- [x] A3 🔧 Nav restructure in `crypto-charting-ui/src/App.jsx`: proper tabs
      (📊 Charts / ⚡ Strategies / 🔍 Token Finder), presets shown only inside Charts.

## Phase B — Dashboard tab: see what's running ✅ 2026-07-05 (tag `v1-dashboard`)

The user's top ask: when a strategy runs DRY or LIVE, its status/results must be visible.

- [x] B1 🔧 **Strategy status board.** New file
      `crypto-charting-ui/src/components/StrategyStatusBoard.jsx`, rendered by a new
      `🏠 Dashboard` view in `App.jsx` (add `'dashboard'` to the tab list, make it the
      DEFAULT view on load).
      Data: `GET /strategies` every 10s; for each strategy with `mode != 'off'`, fetch
      `GET /trades?strategy_id=<id>&status=PAPER` (dry) or `&status=FILLED` (live).
      Per strategy show: name, mode badge (OFF grey / DRY yellow / LIVE red), symbol or
      finder name, freshness dot from `last_run_at` (green < 2× interval, else yellow/red),
      `last_error` (red text, truncated, full on hover), open position (net token qty from
      trades), trades today, realized PnL (sum of sell proceeds − buy costs from the trade
      rows; unrealized = open qty × current price from `/dashboard/overview.token_prices`).
      Done when: board renders live data with API running; a DRY strategy shows PAPER
      trades accumulating; OFF strategies show greyed with no trade fetch; no console errors.
      ✔ Verified in browser 2026-07-05: DRY "RSI dip buyer 1" showed paper PnL +$6.58.
- [x] B2 🔧 **Engine panel on Dashboard.** Show `/engine/settings` (paused, caps) with the
      LIVE/PAUSED toggle (PATCH), plus health dots (collector/API/engine — reuse existing
      `HealthDot`). Mirror of the wallet's toggle — both apps PATCH the same key, safe.
      Done when: toggling pause in the new panel is reflected in the old wallet app within
      15s and vice versa.
      ✔ Toggle verified round-trip against the API (pause→GET→resume); both apps PATCH the
      same key so wallet-side display follows within its 15s poll (not visually re-checked).
- [x] B3 🔧 **Activity tables on Dashboard.** Recent trades (last 50, from
      `/dashboard/overview.trades`, columns: time, symbol, side, USD, price, reason,
      status) + active markers table (symbol, type, price, direction, USD). Read-only.
      Done when: placing a marker on a chart makes it appear in the table within one poll.
      ✔ Existing live markers + trades render (incl. legacy block-number rows).
- [x] B4 🧠 **Review checkpoint.** Strongest model reviews Phase B diff (`git diff v0-baseline`)
      for: polling leaks (intervals not cleared), duplicate fetch storms, PnL math errors.
      Fix findings. Tag `v1-dashboard`. ✔ Done with C4 (commit d06addf) — 2 QuickTrade
      guards tightened; all polls verified to clear intervals on unmount.

## Phase C — Port wallet money panels ✅ 2026-07-05 (tag `v2-wallet-panels`; C3 live test pending user)

- [x] C1 🧠 **Design the lean wallet-data hook.** Read `crypto-wallet/src/context/
      WalletContext.jsx` (58 KB) and extract ONLY: address derivation, BNB+token balances,
      DexScreener price fetch, PnL calc. Output: a design note in `docs/C1-wallet-hook.md`
      listing exact functions to port and what to drop (signing, swap execution, auto-trade).
      No signing code may be ported — AD-2. ✔ docs/C1-wallet-hook.md.
- [x] C2 🔧 **Implement `useWalletData` hook + Wallet panel on Dashboard** per C1 note:
      balances, USD values, total PnL — same numbers the old wallet shows.
      Done when: values match the old wallet app side by side (±1 poll cycle).
      ✔ Balances verified against the chain directly (raw JSON-RPC is ground truth, no
      ethers dep, no key). DEVIATION (documented in C1 doc): token USD uses collector
      prices, not DexScreener — one source of truth with the engine, so cents-level
      differences vs the old wallet are expected. PnL lives on the strategy board.
- [x] C3 🧠 **Manual trade via engine.** Add a "Quick Trade" box (symbol, side, USD) that
      POSTs an immediate-fire marker (`marker_type: STRAT_BUY/STRAT_SELL`-style manual
      type — decide: reuse STRAT_* or add MANUAL_* to `MARKER_TYPES` server-side + engine
      whitelist; remember the API-before-Engine restart rule when adding types).
      Engine executes it with full guards. Done when: a $5 test buy placed from the new UI
      fills on-chain and appears in trade history with the right reason.
      ✔ DECISION: reuse STRAT_BUY/STRAT_SELL (zero API/engine changes, no marker-type
      deployment hazard, full guard stack + 120s TTL + atomic claim for free). Implemented
      with a fresh pause check + explicit REAL-money confirm. Verified up to the confirm
      dialog then cancelled. ⚠ REMAINING FOR USER: place one $5 test buy from Quick Trade
      and check it appears in Recent trades as FILLED with reason "Manual BUY $5".
- [x] C4 🧠 **Review checkpoint.** Tag `v2-wallet-panels`. ✔ See B4 (shared review commit).

## Phase D — Retire the old wallet app + in-browser auto-trade (D2 ← NEEDS USER)

D2 deletes the user's working fallback dashboard — that happens only after he has used
the new Dashboard for a while and placed the C3 $5 test trade successfully.

- [x] D1 🧠 **Auto-trade migration decision.** ✔ DECIDED by the user 2026-07-05: the old
      wallet's auto-trade will **not be used at all anymore** — dropped entirely, no
      migration to strategies/markers. Nothing to port. Do not build on, fix, or extend
      the wallet's auto-trade code; it is dead pending D2.
      ⚠ Practical note until D2 lands: the 60s loop only runs while the old wallet tab
      is open in a browser. Any leftover auto-trade jobs saved in that browser's
      localStorage could still fire real trades if the old wallet tab is opened with the
      key loaded — so don't leave the old wallet open unattended, and cancel any jobs
      still listed there. D2 removes this risk permanently.
- [ ] D2 🔧 **Retire.** Remove wallet window from `start.bat`; `git rm -r crypto-wallet`
      (history keeps it forever; `git checkout v2-wallet-panels -- crypto-wallet` brings
      it back). Update CLAUDE.md sections that mention the wallet app. Tag `v3-one-app`.

## Phase E — Product polish (E1+E2 ✅ 2026-07-05)

- [x] E1 🔧 App title/branding "Alpha Terminal", favicon, consistent dark theme spacing;
      Dashboard is default tab (done in B1), Charts/Strategies/Finder/Settings order.
- [x] E2 🔧 Settings tab: engine risk limits editor (port of wallet ConfigPanel, PATCH
      `/engine/settings`) + collector/API health detail. ✔ Save verified round-trip
      against the API and restored to original values.
- [x] E3a 🧠 **Visual parity + token page pass (2026-07-05).** User feedback: new
      Dashboard was "plain and boring" vs. the old wallet, tokens weren't clickable, and
      clicking one opened a second browser tab instead of an in-app page. Fixed:
      - Ported the wallet app's whole glassmorphism theme into
        `crypto-charting-ui/src/index.css` (CSS vars, glass panels, gradients, nav pills) —
        applies app-wide (Dashboard/Charts/Strategies/Finder/Settings all inherit it, no
        per-tab edits needed beyond the shared vars).
      - `PortfolioSummary.jsx` (new): metric cards (net worth, unrealized P/L, realized
        trading P/L) + asset-allocation donut, same shape as the old wallet's Dashboard.
      - `WalletPanel.jsx` rewritten: styled holdings rows (icon, price, 24h%, P/L),
        clickable → opens the token page. PnL math in new `utils/pnl.js` (avg-cost walk
        over FILLED trades).
      - `TokenDetailView.jsx` (new): in-app token page (no second browser tab) — header
        (price/24h/contract+BscScan), the **same `Chart.jsx` component embedded** at
        page-appropriate size (was previously dead code in the wallet's `TokenDetails.jsx`
        that just did `window.open` to the chart UI — now actually renders inline), a
        BUY/SELL box, and this token's trade history + active markers.
      - **Buy/Sell is key-free**, same path as C3 Quick Trade: POSTs an immediate-fire
        `STRAT_BUY`/`STRAT_SELL` marker, engine executes with full guard stack + 120s TTL.
        Deliberately no auto-trade section (user asked to drop that from the token page).
      - Removed `QuickTrade.jsx` from the Dashboard per user request — same order flow
        now lives on the token page instead. Nothing else referenced it.
      - Verified in browser (chart-preview :5199, live API): dashboard shows real
        balances/PnL/donut, token page shows embedded chart + correct held balance +
        trade history, Strategies/Finder/Settings/Charts tabs all re-themed with zero
        console errors.
      - **Answered user's "two engines?" question (see chat, not a code change):** there is
        one execution engine — the headless `marker-engine` daemon. Manual buy/sell from
        the token page, live strategies, and markers placed on a chart all funnel through
        the same immediate-fire marker path into that one engine. The *separate* system is
        the **old wallet app's own in-browser auto-trade loop** (60s localStorage jobs,
        `crypto-wallet/src/context/WalletContext.jsx`) — untouched, still running, still
        Phase D backlog (AD-1 flags it as the one thing that dies with its browser tab).
        Nothing conflates the two today; retiring the wallet's auto-trade loop is D1/D2.
- [x] E3a2 🧠 **Trade-quote transparency (2026-07-05).** User: "I do not want to be
      clicking buy or sell, only for it to do so at a price that is way off... critical
      piece, must not hide anything." Buy/Sell on the token page now fetches a live
      OpenOcean quote BEFORE the confirm button appears (new
      `crypto-charting-ui/src/utils/quote.js`, mirroring the engine's exact sizing from
      `pure.js sizeTrade` and its `priceImpactPct` formula). The confirm panel shows:
      DEX route (e.g. "PancakeV3 100%"), you-pay in USD + BNB (+BNB price), quoted
      receive amount, effective USD price per token vs the chart/collector market price,
      price impact % against the engine's `max_price_impact_pct` limit (confirm is
      DISABLED when the engine would reject it), minimum received at the engine's 0.5%
      slippage, gas fee estimate (+20% buffer like the engine), and a quote-age counter
      with manual refresh. If the quote API is down/rate-limited the user may still send
      with an explicit "without preview" button — honest because the engine always
      re-quotes at execution and enforces the impact guard regardless. Sell sizing is
      capped at the wallet balance with a visible "capped at your balance" note. Trade
      history gained a Fees (gas) column (BNB + ~USD). ⚠ Quote fetches are ON-DEMAND
      only (never polled): OpenOcean allows ~1 req/1.6s per IP and the ENGINE quotes
      from the same machine when trades fire. Verified live: real $5 buy quote (route
      PancakeV3, impact −0.17% vs 3% limit) and a capped sell quote (+0.42%), fees
      column showing real gas ($0.13), zero console errors; no trade was sent.
- [x] E3a3 🧠 **Balance accuracy + trade-history parity (2026-07-05).** User: dashboard
      showed $14.80 vs old wallet's $18.69; quote panel labels/numbers were "hard to
      read" because they sat at opposite edges of a wide panel; Dashboard's Recent
      Trades was missing fee/tx/expected-vs-actual price that the token page already had.
      - **Root cause of the balance gap**: `useWalletData.js` only discovered tokens
        that appeared in `GET /trades?status=FILLED` — any token held but never traded
        through the engine (leftover from before the reorg, airdrops, etc.) was invisible.
        Fixed by scanning the **entire Alpha token universe from `GET /tokens`** in one
        batched **Multicall3** call (`utils/multicall.js`, new `ethers` dependency in
        `crypto-charting-ui` — read-only ABI encode/decode only, no signing/Provider/key,
        consistent with AD-2) — the same technique
        `crypto-wallet/src/utils/blockchain.js scanTokenBalances` already used. This is
        also the "auto-approve new tokens" mechanism the user asked for: since the scan
        set IS the collector's Alpha token directory, any token a strategy starts trading
        appears automatically on the next 30s poll — no approval step, nothing to build.
      - ⚠ Found and fixed a real bug during verification: Binance Alpha lists tokens on
        non-EVM chains too (e.g. Sui/Move-style addresses like `0x9c7…::xmn::XMN`), and
        one bad address threw during ABI encoding and silently zeroed the ENTIRE scan.
        Filtered to `^0x[0-9a-fA-F]{40}$` before building the call list (BSC-only, matches
        this stack's scope). Verified: net worth went from $14.80 → **$18.27**, within
        $0.42 of the old wallet's $18.69 — remaining gap is expected (different price
        source: collector vs DexScreener, documented C1 deviation; any non-Alpha "popular"
        tokens like leftover USDT are out of scope per the user's own instruction).
      - Also fixed a latent precision bug while touching this: raw ERC-20 balances are
        256-bit; `Number(raw) / 10**decimals` can silently lose precision above
        `Number.MAX_SAFE_INTEGER` for high-supply tokens. Switched to `ethers.formatUnits`
        (string-based division) in both the new hook and `TokenDetailView`'s single-token
        balance check.
      - **Dust filter with a recency exception**: holdings under $1 are hidden from the
        list UNLESS the symbol has a FILLED trade in the last 14 days ("still actively
        trading it, want to click and see its stats") — Portfolio Net Worth still sums
        everything, and a muted note discloses the hidden count so nothing is silently
        dropped. Verified live: a near-zero VELVET remainder correctly stayed visible
        because it was traded minutes earlier; 8 untouched dust holdings were hidden with
        a visible "8 holdings under $1 hidden… still counted" note.
      - **Dashboard Recent Trades now matches the old wallet's Trade History**: added
        execution price with expected price shown alongside when they differ, a Fees
        (gas) column (BNB + ~USD), and a BscScan tx link — same `side-pill`/`status-pill`
        colors already used on the token page. (`ActivityTables.jsx`, new `bnbPrice` prop
        threaded from `DashboardView`.)
      - **Quote-panel readability**: `.trade-line` rows were `justify-content:
        space-between` with no width cap, so in the full-width confirm panel the label
        sat at the left edge and the number at the right edge of the whole screen.
        Capped at `max-width: 480px` — label and value now sit close together.
      - Verified live in browser: real holdings (SUP, KGEN, BBU, XPIN, VELVET) now show
        with correct prices/qty/P&L, the donut includes them, Recent Trades shows the
        user's actual SELL VELVET $3.79 fill with fee + tx + expected-vs-actual price,
        quote panel is easy to read, zero console errors.
- [ ] E3b 🧠 Remaining UX pass with the user: naming, empty states, confirmation dialogs
      for LIVE. Tag `v4-alpha-terminal`. ← NEEDS USER (it's your opinion that matters here).

## Phase F — Multi-user platform (DO NOT START without a dedicated planning session)

Open decisions, in order: custody model (non-custodial strongly recommended: each user
runs their own engine or connects a wallet — you holding keys = money-transmitter
territory), auth, per-user data isolation (SQLite → Postgres), hosting, billing,
update/release channel for subscribers. Each is its own 🧠 session. Nothing in Phases A–E
blocks any of these choices; that is deliberate.

---

## Backlog (valuable, not scheduled)

- WS/SSE push instead of polling; positions table with realized PnL (from CLAUDE.md).
- Shared `executeSwap()` note becomes moot after Phase C/D (browser stops swapping).
- Auto-update path for subscriber installs (Phase F concern).
