// Pure backtester — no I/O. Semantics (kept simple but honest):
//   • A signal emitted while processing bar i fills at bar i+1's OPEN (never the
//     same bar — no look-ahead). Signals on the final bar are reported as
//     `pending`, not filled.
//   • tp/sl attached to a buy become a bracket on that lot, simulated intrabar
//     from the fill bar onward: SL fills at min(open, sl) when low <= sl, TP at
//     max(open, tp) when high >= tp. If both hit in one bar, SL wins
//     (pessimistic — mirrors what the engine's real bracket legs would risk).
//   • feePct and slippagePct are charged against the trader on every fill.
//   • Long-only, pyramiding allowed: buys average into avgCost; sells reduce.
//   • Equity is cumulative PnL in USD (starts at 0): realized + mark-to-market
//     of the open position. netPnl in stats is REALIZED only; the open position
//     is reported separately (openPositionUsd / unrealizedPnlUsd).

import { loadStrategy, createCtx, mergeParams } from './runtime.js';

export function runBacktest({
  code, strategy, bars, params = {},
  feePct = 0.25, slippagePct = 0.1,
}) {
  const empty = { trades: [], equity: [], pending: [], logs: [], stats: emptyStats(), error: null };
  if (!strategy) {
    const loaded = loadStrategy(code || '');
    if (loaded.error) return { ...empty, error: loaded.error };
    strategy = loaded.strategy;
  }
  if (!bars || bars.length === 0) return { ...empty, error: 'no bars' };

  const mergedParams = mergeParams(strategy.params, params);
  const fee = feePct / 100;
  const slip = slippagePct / 100;

  const position = { qty: 0, avgCost: 0, costUsd: 0 };
  const lots = [];            // open bracket lots: { qty, tp, sl }
  const trades = [];
  const equity = [];
  const logs = [];
  let pendingOrders = [];     // signals from the previous bar, fill at this open
  let realized = 0;
  let feesUsd = 0;
  let totalBuyUsd = 0;
  let grossWin = 0, grossLoss = 0, wins = 0, closes = 0;
  let barIndex = -1;

  const fillBuy = (order, price, time) => {
    const fillPrice = price * (1 + slip);
    const feeAmt = order.usd * fee;
    const qty = (order.usd - feeAmt) / fillPrice;
    if (!(qty > 0)) return;
    position.costUsd += order.usd;
    position.qty += qty;
    position.avgCost = position.costUsd / position.qty;
    totalBuyUsd += order.usd;
    feesUsd += feeAmt;
    if (order.tp > 0 || order.sl > 0) lots.push({ qty, tp: order.tp, sl: order.sl });
    trades.push({ time, side: 'BUY', price: fillPrice, qty, usd: order.usd, tag: order.tag || null, realizedPnl: null });
  };

  const fillSell = (qty, price, time, tag) => {
    qty = Math.min(qty, position.qty);
    if (!(qty > 0)) return;
    const fillPrice = price * (1 - slip);
    const gross = qty * fillPrice;
    const feeAmt = gross * fee;
    const proceeds = gross - feeAmt;
    const pnl = proceeds - qty * position.avgCost;
    realized += pnl;
    feesUsd += feeAmt;
    closes++;
    if (pnl > 0) { wins++; grossWin += pnl; } else { grossLoss += -pnl; }
    position.costUsd -= qty * position.avgCost;
    position.qty -= qty;
    if (position.qty <= 1e-12) { position.qty = 0; position.costUsd = 0; position.avgCost = 0; lots.length = 0; }
    trades.push({ time, side: 'SELL', price: fillPrice, qty, usd: proceeds, tag: tag || null, realizedPnl: pnl });
  };

  const emit = {
    buy: (usd, opts = {}) => {
      if (!(usd > 0)) { logs.push(`[bar ${barIndex}] buy skipped: usd must be > 0`); return; }
      pendingOrders.push({ side: 'buy', usd, tp: parseFloat(opts.tp) || 0, sl: parseFloat(opts.sl) || 0, tag: opts.tag });
    },
    sell: (spec = {}, opts = {}) => {
      pendingOrders.push({ side: 'sell', usd: spec.usd, pct: spec.pct, tag: opts.tag });
    },
  };

  const state = {};
  const ctx = createCtx({
    bars, params: mergedParams, state, position, emit,
    log: (msg) => logs.push(`[bar ${barIndex}] ${msg}`),
  });

  let error = null;
  try {
    if (typeof strategy.init === 'function') strategy.init(ctx);

    for (let i = 0; i < bars.length; i++) {
      barIndex = i;
      const bar = bars[i];

      // 1. Fill signals queued on the previous bar at this bar's open.
      const toFill = pendingOrders;
      pendingOrders = [];
      for (const o of toFill) {
        if (o.side === 'buy') fillBuy(o, bar.open, bar.time);
        else {
          const qty = o.usd > 0 ? o.usd / (bar.open * (1 - slip)) : position.qty * ((o.pct ?? 100) / 100);
          fillSell(qty, bar.open, bar.time, o.tag);
        }
      }

      // 2. Bracket lots, intrabar, SL first (pessimistic).
      for (let l = lots.length - 1; l >= 0; l--) {
        const lot = lots[l];
        if (lot.sl > 0 && bar.low <= lot.sl) {
          fillSell(lot.qty, Math.min(bar.open, lot.sl), bar.time, 'sl');
          lots.splice(l, 1);
        } else if (lot.tp > 0 && bar.high >= lot.tp) {
          fillSell(lot.qty, Math.max(bar.open, lot.tp), bar.time, 'tp');
          lots.splice(l, 1);
        }
      }

      // 3. Run the strategy on the closed bar.
      ctx.__setBar(i);
      strategy.onBar(bar, ctx);

      equity.push({ time: bar.time, value: realized + position.qty * (bar.close - position.avgCost) });
    }
  } catch (e) {
    error = `bar ${barIndex}: ${e.message || e}`;
  }

  const lastClose = bars[bars.length - 1].close;
  const unrealized = position.qty * (lastClose - position.avgCost);

  // Drawdown over the PnL equity curve; percent is relative to peak deployed
  // capital so it stays meaningful for a curve that starts at 0.
  let peak = 0, maxDD = 0;
  for (const p of equity) {
    if (p.value > peak) peak = p.value;
    if (peak - p.value > maxDD) maxDD = peak - p.value;
  }

  return {
    trades,
    equity,
    pending: pendingOrders.map(o => ({ side: o.side.toUpperCase(), usd: o.usd ?? null, pct: o.pct ?? null, tag: o.tag || null })),
    logs,
    error,
    stats: {
      netPnlUsd: round2(realized),
      netPnlPct: totalBuyUsd > 0 ? round2((realized / totalBuyUsd) * 100) : 0,
      nTrades: trades.length,
      winRate: closes > 0 ? round2((wins / closes) * 100) : null,
      profitFactor: grossLoss > 0 ? round2(grossWin / grossLoss) : (grossWin > 0 ? Infinity : null),
      maxDrawdownUsd: round2(maxDD),
      maxDrawdownPct: totalBuyUsd > 0 ? round2((maxDD / totalBuyUsd) * 100) : 0,
      feesUsd: round2(feesUsd),
      openPositionQty: position.qty,
      openPositionUsd: round2(position.qty * lastClose),
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
