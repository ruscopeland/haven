// Performance math for a strategy's REAL trade rows (PAPER dry-run fills or
// FILLED on-chain fills) from /strategies/{id}/performance.
//
// Uses the same avg-cost walk the strategy runner uses to rebuild positions
// (strategy-runner.js applyFill), so the page always agrees with what the
// runner believes it holds. Realized PnL is booked on each sell against the
// average cost at that moment; the equity curve is CUMULATIVE REALIZED PnL
// (honest without needing historical prices for every symbol); the open
// position's unrealized PnL is reported separately at current prices.
import { tradeQty, tradeUsd } from './format';

const EPS = 1e-9;

export default function computePerformance(trades, prices = {}) {
  const positions = new Map();   // symbol → {qty, avgCost, costUsd}
  const bySymbol = new Map();    // symbol → {symbol, trades, realized}
  const rows = [];
  const equity = [];
  let realized = 0, grossWin = 0, grossLoss = 0, wins = 0, closes = 0;
  let buys = 0, sells = 0, totalBuyUsd = 0, totalSellUsd = 0, feesBnb = 0;
  let tradesToday = 0, bestPnl = null, worstPnl = null;
  const dayAgo = Date.now() - 86_400_000;

  for (const t of trades) {              // ascending by block_time (API contract)
    const qty = tradeQty(t);
    const price = t.execution_price || t.expected_price || 0;
    const usd = tradeUsd(t);
    let pos = positions.get(t.symbol);
    if (!pos) { pos = { qty: 0, avgCost: 0, costUsd: 0 }; positions.set(t.symbol, pos); }
    const sym = bySymbol.get(t.symbol) || { symbol: t.symbol, trades: 0, realized: 0 };
    sym.trades++;

    let pnl = null;
    if (t.direction === 'BUY') {
      buys++; totalBuyUsd += usd;
      if (qty > 0) {
        pos.costUsd += qty * price;
        pos.qty += qty;
        pos.avgCost = pos.costUsd / pos.qty;
      }
    } else {
      sells++; totalSellUsd += usd;
      const sold = Math.min(qty, pos.qty);
      if (sold > 0 && pos.avgCost > 0) {
        pnl = sold * (price - pos.avgCost);
        realized += pnl; sym.realized += pnl; closes++;
        if (pnl > 0) { wins++; grossWin += pnl; } else { grossLoss += -pnl; }
        if (bestPnl == null || pnl > bestPnl) bestPnl = pnl;
        if (worstPnl == null || pnl < worstPnl) worstPnl = pnl;
      }
      pos.costUsd -= sold * pos.avgCost;
      pos.qty -= sold;
      if (pos.qty <= EPS) { pos.qty = 0; pos.costUsd = 0; pos.avgCost = 0; }
    }
    bySymbol.set(t.symbol, sym);
    feesBnb += t.gas_cost_native || 0;
    if ((t.block_time || 0) >= dayAgo) tradesToday++;
    rows.push({ ...t, qty, usd, price, pnl, cumRealized: realized });

    // Equity point per trade. Legacy rows store block NUMBERS in block_time —
    // skip those (they'd land in 1970 and wreck the time axis).
    if (t.block_time > 1e12) {
      const time = Math.floor(t.block_time / 1000);
      const point = { time, value: Math.round(realized * 100) / 100 };
      const last = equity[equity.length - 1];
      if (last && time < last.time) continue;          // out-of-order guard
      if (last && last.time === time) equity[equity.length - 1] = point;
      else equity.push(point);
    }
  }

  // Open positions valued at current prices.
  const openPositions = [];
  let openValue = 0, unrealized = 0;
  for (const [symbol, pos] of positions) {
    if (pos.qty > EPS) {
      const price = prices[symbol] || 0;
      const value = pos.qty * price;
      const upnl = price > 0 ? pos.qty * (price - pos.avgCost) : 0;
      openPositions.push({ symbol, qty: pos.qty, avgCost: pos.avgCost, price, value, unrealized: upnl });
      openValue += value;
      unrealized += upnl;
    }
  }

  // Per-symbol breakdown (portfolio strategies trade many tokens).
  const symbols = [...bySymbol.values()].map(s => {
    const pos = positions.get(s.symbol);
    const price = prices[s.symbol] || 0;
    const openQty = pos && pos.qty > EPS ? pos.qty : 0;
    const upnl = openQty > 0 && price > 0 ? openQty * (price - pos.avgCost) : 0;
    return { ...s, openQty, openValue: openQty * price, unrealized: upnl, total: s.realized + upnl };
  }).sort((a, b) => b.total - a.total);

  // Max drawdown over the realized-PnL curve.
  let peak = 0, maxDrawdown = 0;
  for (const p of equity) {
    if (p.value > peak) peak = p.value;
    if (peak - p.value > maxDrawdown) maxDrawdown = peak - p.value;
  }

  const losses = closes - wins;
  return {
    rows,
    equity,
    openPositions,
    bySymbol: symbols,
    stats: {
      netPnl: realized + unrealized,
      realized,
      unrealized,
      openValue,
      nTrades: trades.length,
      buys, sells, closes, wins, losses,
      winRate: closes > 0 ? (wins / closes) * 100 : null,
      profitFactor: grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? Infinity : null),
      avgWin: wins > 0 ? grossWin / wins : null,
      avgLoss: losses > 0 ? grossLoss / losses : null,
      bestPnl, worstPnl,
      maxDrawdown,
      totalBuyUsd, totalSellUsd,
      volumeUsd: totalBuyUsd + totalSellUsd,
      feesBnb,
      tradesToday,
      firstTradeAt: trades.length ? trades[0].block_time : null,
      lastTradeAt: trades.length ? trades[trades.length - 1].block_time : null,
    },
  };
}
