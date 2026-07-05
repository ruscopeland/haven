import { useMemo } from 'react';
import { tokenColor } from '../utils/format';
import { unrealizedFor } from '../utils/pnl';

// Shared portfolio math for the Dashboard's metric cards AND the Asset
// Allocation panel — one calculation, two places it's displayed.
export default function usePortfolioStats({ wallet, prices, tokenMap, pnlBySymbol }) {
  const { bnb, bnbPrice, tokens } = wallet;

  return useMemo(() => {
    const bnbUsd = bnb != null && bnbPrice != null ? bnb * bnbPrice : 0;
    let tokensUsd = 0;
    const slices = [];
    if (bnbUsd > 0) slices.push({ label: 'BNB', value: bnbUsd, color: tokenColor(null, true) });
    for (const t of tokens) {
      const usd = t.qty * (prices?.[t.symbol] || 0);
      tokensUsd += usd;
      if (usd > 0) {
        slices.push({
          label: t.name || t.symbol,
          value: usd,
          color: tokenColor(tokenMap?.[t.symbol]?.contract_address || t.symbol),
        });
      }
    }
    const netWorth = bnbUsd + tokensUsd;

    let unrealized = 0, unrealBasis = 0, realized = 0;
    for (const [symbol, pnl] of Object.entries(pnlBySymbol || {})) {
      realized += pnl.realized;
      const u = unrealizedFor(pnl, prices?.[symbol]);
      if (u != null) { unrealized += u; unrealBasis += pnl.basis; }
    }
    const unrealizedPct = unrealBasis > 0 ? (unrealized / unrealBasis) * 100 : 0;

    // Donut: group slices under 3% into "Other", like the old wallet.
    slices.sort((a, b) => b.value - a.value);
    const total = slices.reduce((s, x) => s + x.value, 0);
    const majors = [], minors = [];
    for (const s of slices) (total > 0 && (s.value / total) * 100 >= 3 ? majors : minors).push(s);
    if (minors.length > 0) {
      majors.push({ label: 'Other', value: minors.reduce((s, x) => s + x.value, 0), color: '#6b7280' });
    }
    const alloc = majors.map(s => ({ ...s, pct: total > 0 ? (s.value / total) * 100 : 0 }));

    return { netWorth, unrealized, unrealizedPct, realized, alloc };
  }, [bnb, bnbPrice, tokens, prices, tokenMap, pnlBySymbol]);
}
