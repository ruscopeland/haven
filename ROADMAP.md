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

## Phase D — Retire the old wallet app + in-browser auto-trade ← NEEDS USER

Deliberately NOT done autonomously (2026-07-05): D1 is the user's call, and D2 deletes
the user's working fallback dashboard — that happens only after he has used the new
Dashboard for a while and placed the C3 $5 test trade successfully.

- [ ] D1 🧠 **Auto-trade migration decision.** The wallet's localStorage auto-trade jobs
      (60s browser loop) either map to strategies/markers (preferred) or are dropped.
      User decides live; document outcome here.
- [ ] D2 🔧 **Retire.** Remove wallet window from `start.bat`; `git rm -r crypto-wallet`
      (history keeps it forever; `git checkout v2-wallet-panels -- crypto-wallet` brings
      it back). Update CLAUDE.md sections that mention the wallet app. Tag `v3-one-app`.

## Phase E — Product polish (E1+E2 ✅ 2026-07-05)

- [x] E1 🔧 App title/branding "Alpha Terminal", favicon, consistent dark theme spacing;
      Dashboard is default tab (done in B1), Charts/Strategies/Finder/Settings order.
- [x] E2 🔧 Settings tab: engine risk limits editor (port of wallet ConfigPanel, PATCH
      `/engine/settings`) + collector/API health detail. ✔ Save verified round-trip
      against the API and restored to original values.
- [ ] E3 🧠 UX pass with the user: naming, empty states, confirmation dialogs for LIVE.
      Tag `v4-alpha-terminal`. ← NEEDS USER (it's your opinion that matters here).

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
