// Strategy runner — lives inside the marker-engine process and turns saved
// strategies (the `strategies` table, edited/backtested in the charting UI)
// into signals on live closed bars.
//
//   LIVE mode: a signal POSTs an immediate-fire STRAT_BUY/STRAT_SELL marker;
//     the MarkerEngine's next tick claims and executes it through the full
//     guard stack (claim atomicity, sizing, max_trade_usd, impact, retries).
//     This module never touches chain code — the engine stays the money path.
//   DRY mode: a signal records a simulated fill directly to trade_history with
//     status='PAPER' (excluded from /dashboard/overview, so it can never touch
//     real PnL or the engine's daily cap). TP/SL are simulated locally with
//     the same pessimistic rules as the backtester.
//
// Bars come from GET /klines via the API — the exact series backtests ran on,
// so live behavior matches what the workbench showed. No new price feed.
//
// PORTFOLIO strategies (rows with finder_id): instead of one fixed symbol,
// up to max_positions slots each run an isolated instance of the strategy on
// the token the Token Finder currently ranks best. The rebinding rule is the
// SDK's chooseBinding — the exact function the workbench's portfolio backtest
// uses — fed by the FinderHub's live rankings. A slot holding a position is
// locked; flat slots follow the ranking with hysteresis. If the finder is
// erroring, rebinding stops (no NEW exposure) but bound slots keep managing
// what they hold.
import { randomUUID } from 'node:crypto';
import {
  createCtx, mergeParams, chooseBinding,
} from '../strategy-sdk/src/index.js';
import { loadIsolatedStrategy as loadStrategy } from './sandbox-runtime.js';

const LIST_REFRESH_MS = 15_000;
const HEARTBEAT_MS = 30_000;
const BAR_FETCH_LAG_MS = 5_000;      // let Binance Alpha finalize and persist the bar first
const RETRY_MS = 30_000;             // transient fetch failures
const MAX_BARS = 600;                // rolling history window per strategy
const PAPER_SLIPPAGE_PCT = 0.1;
const TOKENS_REFRESH_MS = 300_000;   // tradeable-token set (has contract address)
const INTERVAL_SEC = { '1m': 60, '5m': 300, '15m': 900, '30m': 1800, '1h': 3600, '4h': 14400, '1d': 86400 };

export class StrategyRunner {
  constructor({ api, log, finderHub = null }) {
    this.api = api;
    this.log = log;
    this.finderHub = finderHub;
    this.runners = new Map();        // strategy id -> runner state
    this.lastListFetch = 0;
    this.lastHeartbeat = 0;
    this.lastTokensFetch = 0;
    // Slot-binding filters (AD-D8): DRY strategies may bind any chain's token
    // (paper needs no wallet); LIVE slots bind BSC tokens only — the engine
    // can't execute anywhere else. Both null until first fetched.
    this.tradeable = null;           // dry: Set(symbol) with a contract address
    this.tradeableLive = null;       // live: same, restricted to chain 'bsc'
  }

  // Called from the daemon's main loop, alongside engine.tick().
  async tick() {
    const now = Date.now();
    if (now - this.lastListFetch >= LIST_REFRESH_MS) {
      this.lastListFetch = now;
      try {
        const list = await this.api.listStrategies();
        this.reconcile(list);
      } catch { /* API down — engine loop already reports it */ }
    }

    if (this.runners.size > 0 && now - this.lastHeartbeat >= HEARTBEAT_MS) {
      this.lastHeartbeat = now;
      this.api.heartbeat('strategy_runner').catch(() => {});
    }

    // Portfolio prerequisites: live rankings + which tokens are swappable.
    const needs = [];
    for (const r of this.runners.values()) {
      if (r.portfolio) needs.push({ finderId: r.finderId, interval: r.interval });
    }
    if (needs.length > 0) {
      if (now - this.lastTokensFetch >= TOKENS_REFRESH_MS) {
        this.lastTokensFetch = now;
        try {
          const tokens = await this.api.getTokens();
          const withAddr = tokens.filter(t => t.contract_address);
          this.tradeable = new Set(withAddr.map(t => t.symbol));
          // Normalize the numeric BSC id if an older local row still carries it.
          this.tradeableLive = new Set(withAddr
            .filter(t => !t.chain_id || t.chain_id === 'bsc' || t.chain_id === '56')
            .map(t => t.symbol));
        } catch { /* keep the previous sets */ }
      }
      if (this.finderHub) {
        try {
          await this.finderHub.tick(needs);
        } catch (e) {
          this.log('ERROR', `Finder hub tick failed: ${e.message}`);
        }
      }
    }

    for (const r of this.runners.values()) {
      try {
        if (r.portfolio) await this.tickPortfolio(r);
        else await this.tickRunner(r);
      } catch (e) {
        await this.reportError(r, e.message || String(e), RETRY_MS);
      }
    }
  }

  // Sync the runner set with the saved strategies. A changed updated_at (or
  // symbol/interval, which bump it server-side) recreates the runner from
  // scratch; a mode flip alone carries over without resetting warm-up state.
  reconcile(list) {
    const wanted = new Map(list.filter(s => s.mode !== 'off').map(s => [s.id, s]));

    for (const [id, r] of this.runners) {
      const s = wanted.get(id);
      if (!s) {
        this.runners.delete(id);
        this.log('INFO', `Strategy "${r.name}" stopped (${wanted.has(id) ? 'off' : 'off/deleted'}).`);
      } else if (s.updated_at !== r.updatedAt) {
        this.runners.delete(id);   // recreated below with fresh code/state
        this.log('INFO', `Strategy "${s.name}" definition changed — reloading.`);
      } else if (s.mode !== r.mode) {
        this.log('INFO', `Strategy "${s.name}" mode: ${r.mode} → ${s.mode}.`);
        r.mode = s.mode;
      }
    }

    for (const [id, s] of wanted) {
      if (!this.runners.has(id)) {
        if (s.finder_id) {
          // Portfolio runner — slots bind tokens from the finder's ranking.
          this.runners.set(id, {
            id, name: s.name, interval: s.interval,
            intervalSec: INTERVAL_SEC[s.interval] || 300,
            mode: s.mode, updatedAt: s.updated_at,
            portfolio: true,
            finderId: s.finder_id,
            maxPositions: s.max_positions || 1,
            switchMarginPct: s.switch_margin_pct ?? 10,
            slots: Array.from({ length: s.max_positions || 1 }, () => ({ sub: null })),
            code: '', paramsOverrides: {},
            initialized: false, broken: false, nextCheck: 0,
          });
          this.log('INFO',
            `Strategy "${s.name}" armed: ${s.mode.toUpperCase()} portfolio ×${s.max_positions || 1} via finder, ${s.interval}.`);
        } else {
          this.runners.set(id, {
            id, name: s.name, symbol: s.symbol, interval: s.interval,
            intervalSec: INTERVAL_SEC[s.interval] || 300,
            mode: s.mode, updatedAt: s.updated_at,
            initialized: false, broken: false,
            strategy: null, code: '', params: {}, state: {}, bars: [],
            position: { qty: 0, avgCost: 0, costUsd: 0 },
            lots: [],                 // dry-mode bracket lots {qty, tp, sl}
            lastBarTime: 0,           // unix sec, open time of last processed bar
            nextCheck: 0,
          });
          this.log('INFO', `Strategy "${s.name}" armed: ${s.mode.toUpperCase()} on ${s.symbol} ${s.interval}.`);
        }
      }
    }
  }

  // ── Portfolio runners (Token Finder dynamic selection) ────────────────────

  async initPortfolio(r) {
    const full = await this.api.getStrategy(r.id);
    r.code = full.code;
    try { r.paramsOverrides = JSON.parse(full.params_json || '{}'); } catch { r.paramsOverrides = {}; }
    const probe = loadStrategy(r.code);
    if (probe.error) {
      r.broken = true;    // stays broken until the definition changes (updated_at)
      return this.reportError(r, `strategy code failed to load: ${probe.error}`, 0);
    }

    // Restart recovery: slots re-attach to symbols that already hold a
    // position (from trade history), so an engine restart never orphans one.
    const posMap = await this.reloadPositionsBySymbol(r.id, r.mode);
    const open = [...posMap.entries()].filter(([, p]) => p.qty > 1e-12);
    let bound = 0;
    for (const [symbol] of open.slice(0, r.maxPositions)) {
      try {
        r.slots[bound].sub = await this.initSub(r, bound, symbol, null);
        bound++;
      } catch (e) {
        this.log('ERROR', `[${r.name}] could not re-attach open position on ${symbol}: ${e.message}`);
      }
    }
    r.initialized = true;
    this.log('INFO',
      `Strategy "${r.name}" portfolio ready (${bound} open position(s) recovered, ` +
      `${r.maxPositions - bound} flat slot(s) awaiting ranking).`);
    await this.api.patchStrategy(r.id, { last_run_at: Date.now(), clear_error: true }).catch(() => {});
  }

  // One slot sub-runner: the same shape tickRunner's helpers expect
  // (fetchBars/extendFlow/makeCtx/runBar/emit* all take this object), bound to
  // one symbol with an ISOLATED strategy instance + state, warm-replayed.
  async initSub(r, slotIdx, symbol, entryRank) {
    const { strategy, error } = loadStrategy(r.code);
    if (error) throw new Error(`strategy code failed to load: ${error}`);
    const sub = {
      id: r.id, name: `${r.name}#${slotIdx + 1}`, symbol,
      interval: r.interval, intervalSec: r.intervalSec, mode: r.mode,
      strategy, params: mergeParams(strategy.params, r.paramsOverrides),
      bars: [], state: {},
      position: { qty: 0, avgCost: 0, costUsd: 0 },
      lots: [], lastBarTime: 0, nextCheck: 0, entryRank,
    };
    const bars = await this.fetchBars(sub, 500);
    if (bars.length === 0) throw new Error(`no kline data for ${symbol}`);
    sub.bars = bars.slice(-MAX_BARS);
    sub.lastBarTime = sub.bars[sub.bars.length - 1].time;
    const posMap = await this.reloadPositionsBySymbol(r.id, r.mode);
    this.assignPosition(sub, posMap);

    // Warm-up replay with actions suppressed — primes indicators + ctx.state.
    const ctx = this.makeCtx(sub, () => {});
    if (typeof sub.strategy.init === 'function') sub.strategy.init(ctx);
    for (let i = 0; i < sub.bars.length; i++) {
      ctx.__setBar(i);
      sub.strategy.onBar(sub.bars[i], ctx);
    }
    sub.nextCheck = (sub.lastBarTime + 2 * r.intervalSec) * 1000 + BAR_FETCH_LAG_MS;
    return sub;
  }

  async tickPortfolio(r) {
    if (r.broken) return;
    if (!r.initialized) return this.initPortfolio(r);
    let didWork = false;

    // 1. New closed bars on every bound slot.
    let posMap = null;
    for (const slot of r.slots) {
      const sub = slot.sub;
      if (!sub) continue;
      sub.mode = r.mode;                              // mode flips carry over live
      if (Date.now() < sub.nextCheck) continue;
      const nextCloseMs = (sub.lastBarTime + 2 * sub.intervalSec) * 1000;
      if (Date.now() < nextCloseMs + BAR_FETCH_LAG_MS) continue;

      const fresh = await this.fetchBars(sub, 3);
      const newBars = fresh.filter(b => b.time > sub.lastBarTime);
      if (newBars.length === 0) {
        sub.nextCheck = Date.now() + BAR_FETCH_LAG_MS;  // Binance Alpha reconciliation lagging — retry shortly
        continue;
      }
      if (!posMap) posMap = await this.reloadPositionsBySymbol(r.id, r.mode).catch(() => null);
      if (posMap) this.assignPosition(sub, posMap);

      for (const bar of newBars) {
        sub.bars.push(bar);
        if (sub.bars.length > MAX_BARS) sub.bars.shift();
        sub.lastBarTime = bar.time;
        if (r.mode === 'dry') await this.checkDryBrackets(sub, bar);
        await this.runBar(sub, bar, /* live actions */ true);
      }
      sub.nextCheck = (sub.lastBarTime + 2 * sub.intervalSec) * 1000 + BAR_FETCH_LAG_MS;
      didWork = true;
    }

    // 2. Rebinding — the SAME chooseBinding the portfolio backtest uses.
    // Fail-closed: no ranking / finder error → no new exposure, but bound
    // slots above keep managing their positions.
    const st = this.finderHub ? this.finderHub.getState(r.finderId, r.interval) : null;
    if (st && !st.error && st.ranking && st.ranking.length > 0) {
      const view = r.slots.map(s => ({
        symbol: s.sub?.symbol ?? null,
        hasPosition: !!s.sub && s.sub.position.qty > 0,
      }));
      const next = chooseBinding(view, st.ranking, {
        switchMarginPct: r.switchMarginPct,
        // LIVE slots may only bind what the engine can execute: BSC (AD-D8).
        tradeable: r.mode === 'live' ? (this.tradeableLive ?? this.tradeable)
                                     : this.tradeable,
      });
      const rankOf = new Map(st.ranking.map((x, i) => [x.symbol, i + 1]));
      for (let k = 0; k < r.slots.length; k++) {
        const cur = r.slots[k].sub?.symbol ?? null;
        if (next[k] === cur || next[k] == null) continue;
        this.log('INFO',
          `[${r.name}] slot ${k + 1}: ${cur ? `${cur} → ` : ''}${next[k]} (rank #${rankOf.get(next[k]) ?? '?'}).`);
        try {
          r.slots[k].sub = await this.initSub(r, k, next[k], rankOf.get(next[k]) ?? null);
        } catch (e) {
          r.slots[k].sub = null;                    // retry on the next ranking
          this.log('ERROR', `[${r.name}] slot ${k + 1} bind to ${next[k]} failed: ${e.message}`);
        }
        didWork = true;
      }
    }

    if (didWork) {
      await this.api.patchStrategy(r.id, { last_run_at: Date.now(), clear_error: true }).catch(() => {});
    }
  }

  // Per-symbol net positions for a strategy — portfolio slots each own the
  // position of THEIR symbol (PAPER rows for dry, FILLED for live).
  async reloadPositionsBySymbol(strategyId, mode) {
    const status = mode === 'dry' ? 'PAPER' : 'FILLED';
    const trades = await this.api.getTrades({ strategy_id: strategyId, status, limit: 1000 });
    const map = new Map();
    for (const t of trades.slice().reverse()) {           // API returns newest first
      let pos = map.get(t.symbol);
      if (!pos) { pos = { qty: 0, avgCost: 0, costUsd: 0 }; map.set(t.symbol, pos); }
      if (t.direction === 'BUY') this.applyFill(pos, 'BUY', t.amount_out, t.execution_price);
      else this.applyFill(pos, 'SELL', t.amount_in, t.execution_price);
    }
    return map;
  }

  assignPosition(sub, posMap) {
    const pos = posMap.get(sub.symbol) || { qty: 0, avgCost: 0, costUsd: 0 };
    sub.position.qty = pos.qty;
    sub.position.avgCost = pos.avgCost;
    sub.position.costUsd = pos.costUsd;
  }

  async tickRunner(r) {
    if (r.broken || Date.now() < r.nextCheck) return;
    if (!r.initialized) return this.initRunner(r);

    // A bar that OPENED at lastBarTime+interval closes one interval later.
    const nextCloseMs = (r.lastBarTime + 2 * r.intervalSec) * 1000;
    if (Date.now() < nextCloseMs + BAR_FETCH_LAG_MS) return;

    const fresh = await this.fetchBars(r, 3);
    const newBars = fresh.filter(b => b.time > r.lastBarTime);
    if (newBars.length === 0) {
      r.nextCheck = Date.now() + BAR_FETCH_LAG_MS;    // Binance Alpha reconciliation lagging — retry shortly
      return;
    }

    await this.reloadPosition(r).catch(() => {});      // pick up engine fills / prior paper trades

    for (const bar of newBars) {
      r.bars.push(bar);
      if (r.bars.length > MAX_BARS) r.bars.shift();
      r.lastBarTime = bar.time;
      if (r.mode === 'dry') await this.checkDryBrackets(r, bar);
      await this.runBar(r, bar, /* live actions */ true);
    }

    r.nextCheck = (r.lastBarTime + 2 * r.intervalSec) * 1000 + BAR_FETCH_LAG_MS;
    await this.api.patchStrategy(r.id, { last_run_at: Date.now(), clear_error: true }).catch(() => {});
  }

  // ── Initialization: code + history + warm-up replay (actions suppressed) ──
  async initRunner(r) {
    const full = await this.api.getStrategy(r.id);
    r.code = full.code;
    let overrides = {};
    try { overrides = JSON.parse(full.params_json || '{}'); } catch { /* legacy */ }

    const { strategy, error } = loadStrategy(r.code);
    if (error) {
      r.broken = true;    // stays broken until the definition changes (updated_at)
      return this.reportError(r, `strategy code failed to load: ${error}`, 0);
    }
    r.strategy = strategy;
    r.params = mergeParams(strategy.params, overrides);

    const bars = await this.fetchBars(r, 500);
    if (bars.length === 0) throw new Error(`no kline data for ${r.symbol}`);
    r.bars = bars.slice(-MAX_BARS);
    r.lastBarTime = r.bars[r.bars.length - 1].time;


    await this.reloadPosition(r);

    // Replay history so ctx.state and any internal counters are primed exactly
    // as a backtest would leave them — but without emitting a single signal.
    const ctx = this.makeCtx(r, () => {});   // suppressed emitter
    if (typeof r.strategy.init === 'function') r.strategy.init(ctx);
    for (let i = 0; i < r.bars.length; i++) {
      ctx.__setBar(i);
      r.strategy.onBar(r.bars[i], ctx);
    }

    r.initialized = true;
    r.nextCheck = (r.lastBarTime + 2 * r.intervalSec) * 1000 + BAR_FETCH_LAG_MS;
    this.log('INFO',
      `Strategy "${r.name}" warmed up on ${r.bars.length} bars of ${r.symbol} ${r.interval} ` +
      `(position: ${r.position.qty > 0 ? `${r.position.qty} @ ~$${r.position.avgCost.toPrecision(4)}` : 'flat'}).`);
    await this.api.patchStrategy(r.id, { last_run_at: Date.now(), clear_error: true }).catch(() => {});
  }

  // ── One live bar ─────────────────────────────────────────────────────────
  async runBar(r, bar, actionsLive) {
    const signals = [];
    const ctx = this.makeCtx(r, (signal) => { if (actionsLive) signals.push(signal); });
    ctx.__setBar(r.bars.length - 1);
    r.strategy.onBar(bar, ctx);

    for (const s of signals) {
      if (r.mode === 'live') await this.emitLive(r, s, bar);
      else await this.emitPaper(r, s, bar);
    }
  }

  makeCtx(r, onSignal) {
    return createCtx({
      bars: r.bars,
      params: r.params,
      state: r.state,
      position: r.position,
      emit: {
        buy: (usd, opts = {}) => onSignal({ side: 'BUY', usd: parseFloat(usd) || 0, tp: opts.tp, sl: opts.sl, tag: opts.tag }),
        sell: (spec = {}, opts = {}) => onSignal({ side: 'SELL', usd: parseFloat(spec.usd) || 0, pct: spec.pct, tag: opts.tag }),
      },
      log: (msg) => this.log('INFO', `[${r.name}] ${msg}`),
    });
  }

  // ── LIVE: post an immediate-fire marker; the engine does the rest ────────
  async emitLive(r, s, bar) {
    let usd = s.usd;
    if (s.side === 'SELL' && !(usd > 0)) {
      const pct = s.pct ?? 100;
      usd = r.position.qty * (pct / 100) * bar.close;
    }
    if (!(usd > 0)) {
      this.log('ERROR', `[${r.name}] ${s.side} signal skipped: no positive USD size (buy needs usd, sell needs usd/pct/position).`);
      return;
    }
    const meta = { usd };
    if (s.side === 'BUY' && parseFloat(s.tp) > 0) meta.tp = parseFloat(s.tp);
    if (s.side === 'BUY' && parseFloat(s.sl) > 0) meta.sl = parseFloat(s.sl);
    if (s.tag) meta.tag = s.tag;

    await this.api.createMarker({
      symbol: r.symbol,
      price: bar.close,
      marker_type: s.side === 'BUY' ? 'STRAT_BUY' : 'STRAT_SELL',
      direction: 'cross',
      label: r.name,
      strategy_id: r.id,
      metadata_json: JSON.stringify(meta),
    });
    this.log('TRADE', `[${r.name}] LIVE ${s.side} signal → $${usd.toFixed(2)} ${r.symbol} (bar close ${bar.close}).`);
    // Optimistic position bump; the pre-bar reloadPosition() reconciles with
    // what the engine actually filled (or didn't).
    this.applyFill(r.position, s.side, usd / bar.close, bar.close);
  }

  // ── DRY: record a simulated fill, simulate brackets locally ──────────────
  async emitPaper(r, s, bar) {
    const slip = PAPER_SLIPPAGE_PCT / 100;
    if (s.side === 'BUY') {
      if (!(s.usd > 0)) {
        this.log('ERROR', `[${r.name}] paper BUY skipped: ctx.buy(usd) needs a positive USD amount.`);
        return;
      }
      const fillPrice = bar.close * (1 + slip);
      const qty = s.usd / fillPrice;
      await this.postPaperTrade(r, 'BUY', bar.close, fillPrice, s.usd, qty);
      this.applyFill(r.position, 'BUY', qty, fillPrice);
      if (parseFloat(s.tp) > 0 || parseFloat(s.sl) > 0) {
        r.lots.push({ qty, tp: parseFloat(s.tp) || 0, sl: parseFloat(s.sl) || 0 });
      }
      this.log('TRADE', `[${r.name}] PAPER BUY $${s.usd.toFixed(2)} → ${qty.toPrecision(6)} ${r.symbol} @ ${fillPrice.toPrecision(6)}`);
    } else {
      let qty = s.usd > 0 ? s.usd / bar.close : r.position.qty * ((s.pct ?? 100) / 100);
      qty = Math.min(qty, r.position.qty);
      if (!(qty > 0)) {
        this.log('INFO', `[${r.name}] paper SELL skipped: no position.`);
        return;
      }
      const fillPrice = bar.close * (1 - slip);
      await this.postPaperTrade(r, 'SELL', bar.close, fillPrice, qty * fillPrice, qty);
      this.applyFill(r.position, 'SELL', qty, fillPrice);
      this.log('TRADE', `[${r.name}] PAPER SELL ${qty.toPrecision(6)} ${r.symbol} @ ${fillPrice.toPrecision(6)} (~$${(qty * fillPrice).toFixed(2)})`);
    }
  }

  // Same pessimistic intrabar rules as the backtester: SL first, gap-aware.
  async checkDryBrackets(r, bar) {
    for (let i = r.lots.length - 1; i >= 0; i--) {
      const lot = r.lots[i];
      let trigger = null;
      if (lot.sl > 0 && bar.low <= lot.sl) trigger = { price: Math.min(bar.open, lot.sl), tag: 'sl' };
      else if (lot.tp > 0 && bar.high >= lot.tp) trigger = { price: Math.max(bar.open, lot.tp), tag: 'tp' };
      if (!trigger) continue;
      const qty = Math.min(lot.qty, r.position.qty);
      r.lots.splice(i, 1);
      if (!(qty > 0)) continue;
      await this.postPaperTrade(r, 'SELL', trigger.price, trigger.price, qty * trigger.price, qty);
      this.applyFill(r.position, 'SELL', qty, trigger.price);
      this.log('TRADE', `[${r.name}] PAPER ${trigger.tag.toUpperCase()} hit → sold ${qty.toPrecision(6)} @ ${trigger.price.toPrecision(6)}`);
    }
  }

  postPaperTrade(r, direction, expectedPrice, fillPrice, usd, qty) {
    return this.api.recordTrade({
      symbol: r.symbol,
      direction,
      marker_id: null,
      expected_price: expectedPrice,
      execution_price: fillPrice,
      // BUY: in = USD spent, out = tokens. SELL: in = tokens, out = USD.
      amount_in: direction === 'BUY' ? usd : qty,
      amount_out: direction === 'BUY' ? qty : usd,
      fee_token: 'PAPER',
      fee_amount: 0,
      gas_used: 0, gas_price_gwei: 0, gas_cost_native: 0,
      tx_hash: `paper-${randomUUID()}`,          // tx_hash is UNIQUE in the DB
      block_time: Date.now(),
      status: 'PAPER',
      strategy_id: r.id,
    });
  }

  // ── Position: rebuilt from trade_history so restarts and engine-side fills
  // (or aborted fires) are always reflected. ────────────────────────────────
  async reloadPosition(r) {
    const status = r.mode === 'dry' ? 'PAPER' : 'FILLED';
    const trades = await this.api.getTrades({ strategy_id: r.id, status, limit: 1000 });
    const pos = { qty: 0, avgCost: 0, costUsd: 0 };
    for (const t of trades.slice().reverse()) {           // API returns newest first
      if (t.direction === 'BUY') this.applyFill(pos, 'BUY', t.amount_out, t.execution_price);
      else this.applyFill(pos, 'SELL', t.amount_in, t.execution_price);
    }
    r.position.qty = pos.qty;
    r.position.avgCost = pos.avgCost;
    r.position.costUsd = pos.costUsd;
  }

  applyFill(pos, side, qty, price) {
    if (!(qty > 0)) return;
    if (side === 'BUY') {
      pos.costUsd += qty * price;
      pos.qty += qty;
      pos.avgCost = pos.costUsd / pos.qty;
    } else {
      const sold = Math.min(qty, pos.qty);
      pos.costUsd -= sold * pos.avgCost;
      pos.qty -= sold;
      if (pos.qty <= 1e-12) { pos.qty = 0; pos.costUsd = 0; pos.avgCost = 0; }
    }
  }

  // ── Data fetch helpers ────────────────────────────────────────────────────
  async fetchBars(r, limit) {
    const json = await this.api.getKlines(r.symbol, r.interval, limit);
    const nowSec = Date.now() / 1000;
    return (json.data || [])
      .map(d => ({
        time: d[0] / 1000,
        open: parseFloat(d[1]), high: parseFloat(d[2]),
        low: parseFloat(d[3]), close: parseFloat(d[4]),
        volume: parseFloat(d[5]),
      }))
      .filter(b => b.time + r.intervalSec <= nowSec);      // closed bars only
  }

  async reportError(r, message, retryMs) {
    this.log('ERROR', `Strategy "${r.name}": ${message}`);
    r.nextCheck = Date.now() + (retryMs || RETRY_MS);
    await this.api.patchStrategy(r.id, { last_error: message.slice(0, 500) }).catch(() => {});
  }
}
