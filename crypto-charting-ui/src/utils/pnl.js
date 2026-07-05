import { tradeQty, tradeUsd } from './format';

// Average-cost PnL walk over FILLED trade rows, per symbol.
// Sells relieve basis at the running average cost; selling more than the
// tracked position (tokens acquired outside the engine) counts the excess
// proceeds with zero known cost, so realized PnL is "proceeds minus known
// cost" — an approximation, same spirit as the old wallet dashboard.
export function computePnl(trades) {
  const rows = [...trades].sort((a, b) => (a.block_time || 0) - (b.block_time || 0));
  const bySymbol = {};
  for (const t of rows) {
    const s = bySymbol[t.symbol] ||
      (bySymbol[t.symbol] = { qty: 0, basis: 0, realized: 0, buyUsd: 0, sellUsd: 0 });
    const qty = tradeQty(t);
    const usd = tradeUsd(t);
    if (!qty || !usd) continue;
    if (t.direction === 'BUY') {
      s.qty += qty; s.basis += usd; s.buyUsd += usd;
    } else {
      const sold = Math.min(qty, s.qty);
      const avg = s.qty > 0 ? s.basis / s.qty : 0;
      s.realized += usd - avg * sold;
      s.qty -= sold;
      s.basis -= avg * sold;
      s.sellUsd += usd;
    }
  }
  return bySymbol;
}

// Unrealized P/L of the remaining engine-tracked position for one symbol.
export function unrealizedFor(pnl, price) {
  if (!pnl || pnl.qty <= 1e-9 || !price) return null;
  return pnl.qty * price - pnl.basis;
}
