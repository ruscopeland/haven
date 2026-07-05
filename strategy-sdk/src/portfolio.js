// Portfolio backtester — a strategy trading the Token Finder's top-ranked
// tokens across N slots, no I/O. Fill semantics DELIBERATELY mirror
// backtest.js exactly (next-bar-open fills, pessimistic SL-first brackets,
// same fee/slippage math); the parity test in portfolio.test.js pins a
// 1-token universe to the single-symbol backtester's trades. If you change
// fill rules there, change them here (and vice versa).
//
// Slot lifecycle per global bar gi:
//   1. every bound slot with data at gi processes the bar: fill pending orders
//      at the open, simulate bracket lots intrabar, then run onBar;
//   2. at the close, the ranking at gi feeds chooseBinding() — flat slots may
//      rebind (hysteresis in chooseBinding); a fresh binding warm-replays the
//      token's history with actions suppressed and goes active at gi+1.
// A slot is "locked" while it holds a position OR has pending orders — the
// exact rule the live runner applies, so backtests predict live behavior.

import { loadStrategy, createCtx, mergeParams } from './runtime.js';
import { runRanking, chooseBinding } from './finder.js';

export function runPortfolioBacktest({
  strategyCode, finderCode, universe,
  maxPositions = 1, switchMarginPct = 10,
  params = {}, finderParams = {},
  feePct = 0.25, slippagePct = 0.1,
  keep = 100,
}) {
  const empty = {
    trades: [], equity: [], logs: [], pending: [], slotTimeline: [],
    rankings: [], stats: emptyStats(), error: null,
  };
  if (!universe || universe.times.length === 0 || universe.tokens.length === 0) {
    return { ...empty, error: 'universe is empty' };
  }
  // Strategy source must load before we bother ranking.
  {
    const probe = loadStrategy(strategyCode || '');
    if (probe.error) return { ...empty, error: `strategy: ${probe.error}` };
  }
  const ranked = runRanking({ code: finderCode, universe, params: finderParams, keep });
  if (ranked.error) return { ...empty, error: `finder: ${ranked.error}`, rankings: ranked.rankings || [] };

  const fee = feePct / 100;
  const slip = slippagePct / 100;
  const n = universe.times.length;
  const tokenBySymbol = new Map(universe.tokens.map(t => [t.symbol, t]));

  const trades = [];
  const equity = [];
  const logs = ranked.logs.slice();
  const slotTimeline = [];
  const acct = {                          // shared across slots
    realized: 0, feesUsd: 0, totalBuyUsd: 0,
    grossWin: 0, grossLoss: 0, wins: 0, closes: 0,
  };

  // ── Per-slot simulator (one per binding; discarded on rebind) ─────────────
  const makeSim = (slotIdx, symbol, boundAtGi, entryRank) => {
    const token = tokenBySymbol.get(symbol);
    const { strategy, error } = loadStrategy(strategyCode);   // isolated instance
    if (error || !token) return null;
    const merged = mergeParams(strategy.params, params);
    const position = { qty: 0, avgCost: 0, costUsd: 0 };
    const lots = [];
    const sim = {
      slotIdx, symbol, token, strategy, position, lots,
      pendingOrders: [], suppressed: true, entryRank,
      boundAtGi, boundAtTime: universe.times[boundAtGi],
    };
    sim.ctx = createCtx({
      bars: token.bars, flow: token.flow, params: merged, state: {}, position,
      emit: {
        buy: (usd, opts = {}) => {
          if (sim.suppressed) return;
          if (!(usd > 0)) { logs.push(`[slot ${slotIdx} ${symbol}] buy skipped: usd must be > 0`); return; }
          sim.pendingOrders.push({ side: 'buy', usd, tp: parseFloat(opts.tp) || 0, sl: parseFloat(opts.sl) || 0, tag: opts.tag });
        },
        sell: (spec = {}, opts = {}) => {
          if (sim.suppressed) return;
          sim.pendingOrders.push({ side: 'sell', usd: spec.usd, pct: spec.pct, tag: opts.tag });
        },
      },
      log: (msg) => logs.push(`[slot ${slotIdx} ${symbol}] ${msg}`),
    });
    return sim;
  };

  // Same numbers as backtest.js fillBuy/fillSell, but recording symbol + slot.
  const fillBuy = (sim, order, price, time) => {
    const fillPrice = price * (1 + slip);
    const feeAmt = order.usd * fee;
    const qty = (order.usd - feeAmt) / fillPrice;
    if (!(qty > 0)) return;
    sim.position.costUsd += order.usd;
    sim.position.qty += qty;
    sim.position.avgCost = sim.position.costUsd / sim.position.qty;
    acct.totalBuyUsd += order.usd;
    acct.feesUsd += feeAmt;
    if (order.tp > 0 || order.sl > 0) sim.lots.push({ qty, tp: order.tp, sl: order.sl });
    trades.push({
      time, side: 'BUY', price: fillPrice, qty, usd: order.usd, tag: order.tag || null,
      realizedPnl: null, symbol: sim.symbol, slot: sim.slotIdx, entryRank: sim.entryRank,
    });
  };

  const fillSell = (sim, qty, price, time, tag) => {
    qty = Math.min(qty, sim.position.qty);
    if (!(qty > 0)) return;
    const fillPrice = price * (1 - slip);
    const gross = qty * fillPrice;
    const feeAmt = gross * fee;
    const proceeds = gross - feeAmt;
    const pnl = proceeds - qty * sim.position.avgCost;
    acct.realized += pnl;
    acct.feesUsd += feeAmt;
    acct.closes++;
    if (pnl > 0) { acct.wins++; acct.grossWin += pnl; } else { acct.grossLoss += -pnl; }
    sim.position.costUsd -= qty * sim.position.avgCost;
    sim.position.qty -= qty;
    if (sim.position.qty <= 1e-12) {
      sim.position.qty = 0; sim.position.costUsd = 0; sim.position.avgCost = 0;
      sim.lots.length = 0;
    }
    trades.push({
      time, side: 'SELL', price: fillPrice, qty, usd: proceeds, tag: tag || null,
      realizedPnl: pnl, symbol: sim.symbol, slot: sim.slotIdx, entryRank: sim.entryRank,
    });
  };

  const processBar = (sim, gi) => {
    const ti = gi - sim.token.offset;
    if (ti < 0) return;
    const bar = sim.token.bars[ti];
    if (bar.open == null) return;                 // leading gap safety

    // 1. Fill signals queued on the previous bar at this bar's open.
    const toFill = sim.pendingOrders;
    sim.pendingOrders = [];
    for (const o of toFill) {
      if (o.side === 'buy') fillBuy(sim, o, bar.open, bar.time);
      else {
        const qty = o.usd > 0 ? o.usd / (bar.open * (1 - slip)) : sim.position.qty * ((o.pct ?? 100) / 100);
        fillSell(sim, qty, bar.open, bar.time, o.tag);
      }
    }
    // 2. Bracket lots, intrabar, SL first (pessimistic).
    for (let l = sim.lots.length - 1; l >= 0; l--) {
      const lot = sim.lots[l];
      if (lot.sl > 0 && bar.low <= lot.sl) {
        fillSell(sim, lot.qty, Math.min(bar.open, lot.sl), bar.time, 'sl');
        sim.lots.splice(l, 1);
      } else if (lot.tp > 0 && bar.high >= lot.tp) {
        fillSell(sim, lot.qty, Math.max(bar.open, lot.tp), bar.time, 'tp');
        sim.lots.splice(l, 1);
      }
    }
    // 3. Run the strategy on the closed bar.
    sim.ctx.__setBar(ti);
    sim.strategy.onBar(bar, sim.ctx);
  };

  // Warm-up replay: prime ctx.state exactly as a from-scratch run would,
  // without emitting a single signal (mirrors the live runner's initRunner).
  const warmUp = (sim, throughGi) => {
    sim.suppressed = true;
    if (typeof sim.strategy.init === 'function') sim.strategy.init(sim.ctx);
    const last = Math.min(throughGi - sim.token.offset, sim.token.bars.length - 1);
    for (let ti = 0; ti <= last; ti++) {
      sim.ctx.__setBar(ti);
      sim.strategy.onBar(sim.token.bars[ti], sim.ctx);
    }
    sim.suppressed = false;
  };

  const closeTimelineEntry = (sim, gi) => {
    slotTimeline.push({
      slot: sim.slotIdx, symbol: sim.symbol,
      fromTime: sim.boundAtTime, toTime: universe.times[gi],
      entryRank: sim.entryRank,
    });
  };

  // ── Main loop ─────────────────────────────────────────────────────────────
  const slots = Array.from({ length: maxPositions }, () => ({ sim: null }));
  let error = null;
  let gi = 0;
  try {
    for (gi = 0; gi < n; gi++) {
      // 1. Trade the bar on every bound slot.
      for (const slot of slots) {
        if (slot.sim) processBar(slot.sim, gi);
      }

      // 2. Rebind flat slots against the ranking at this close.
      const ranking = ranked.rankings[gi];
      if (ranking && ranking.length > 0) {
        const view = slots.map(s => ({
          symbol: s.sim?.symbol ?? null,
          hasPosition: !!s.sim && (s.sim.position.qty > 0 || s.sim.pendingOrders.length > 0),
        }));
        const next = chooseBinding(view, ranking, { switchMarginPct });
        const rankOf = new Map(ranking.map((r, idx) => [r.symbol, idx + 1]));
        for (let k = 0; k < slots.length; k++) {
          const cur = slots[k].sim?.symbol ?? null;
          if (next[k] === cur || next[k] == null) continue;
          if (slots[k].sim) closeTimelineEntry(slots[k].sim, gi);
          const sim = makeSim(k, next[k], gi, rankOf.get(next[k]) ?? null);
          if (sim) {
            warmUp(sim, gi);
            slots[k].sim = sim;
          }
        }
      }

      // 3. Mark-to-market equity across all slots.
      let mtm = 0;
      for (const slot of slots) {
        const sim = slot.sim;
        if (!sim || sim.position.qty <= 0) continue;
        const ti = Math.min(gi - sim.token.offset, sim.token.bars.length - 1);
        const close = ti >= 0 ? sim.token.bars[ti].close : null;
        if (close != null) mtm += sim.position.qty * (close - sim.position.avgCost);
      }
      equity.push({ time: universe.times[gi], value: acct.realized + mtm });
    }
  } catch (e) {
    error = `bar ${gi}: ${e.message || e}`;
  }

  // Close open timeline entries + collect never-filled signals.
  const pending = [];
  for (const slot of slots) {
    if (!slot.sim) continue;
    closeTimelineEntry(slot.sim, n - 1);
    for (const o of slot.sim.pendingOrders) {
      pending.push({ side: o.side.toUpperCase(), usd: o.usd ?? null, pct: o.pct ?? null, tag: o.tag || null, symbol: slot.sim.symbol });
    }
  }

  // Stats — same definitions as backtest.js, summed across slots.
  let openQty = 0, openUsd = 0, unrealized = 0;
  for (const slot of slots) {
    const sim = slot.sim;
    if (!sim || sim.position.qty <= 0) continue;
    const lastClose = sim.token.bars[sim.token.bars.length - 1].close;
    openQty += sim.position.qty;
    openUsd += sim.position.qty * lastClose;
    unrealized += sim.position.qty * (lastClose - sim.position.avgCost);
  }
  let peak = 0, maxDD = 0;
  for (const p of equity) {
    if (p.value > peak) peak = p.value;
    if (peak - p.value > maxDD) maxDD = peak - p.value;
  }

  return {
    trades, equity, logs, pending, slotTimeline,
    rankings: ranked.rankings,
    error,
    stats: {
      netPnlUsd: round2(acct.realized),
      netPnlPct: acct.totalBuyUsd > 0 ? round2((acct.realized / acct.totalBuyUsd) * 100) : 0,
      nTrades: trades.length,
      winRate: acct.closes > 0 ? round2((acct.wins / acct.closes) * 100) : null,
      profitFactor: acct.grossLoss > 0 ? round2(acct.grossWin / acct.grossLoss) : (acct.grossWin > 0 ? Infinity : null),
      maxDrawdownUsd: round2(maxDD),
      maxDrawdownPct: acct.totalBuyUsd > 0 ? round2((maxDD / acct.totalBuyUsd) * 100) : 0,
      feesUsd: round2(acct.feesUsd),
      openPositionQty: openQty,
      openPositionUsd: round2(openUsd),
      unrealizedPnlUsd: round2(unrealized),
    },
  };
}

function emptyStats() {
  return {
    netPnlUsd: 0, netPnlPct: 0, nTrades: 0, winRate: null, profitFactor: null,
    maxDrawdownUsd: 0, maxDrawdownPct: 0, feesUsd: 0,
    openPositionQty: 0, openPositionUsd: 0, unrealizedPnlUsd: 0,
  };
}

const round2 = (x) => (Number.isFinite(x) ? Math.round(x * 100) / 100 : x);
