import { useMemo } from 'react';
import { tokenColor } from '../utils/format';
import { unrealizedFor } from '../utils/pnl';

// Shared portfolio math for the Dashboard's metric cards AND the Asset
// Allocation panel — one calculation, two places it's displayed.
export default function usePortfolioStats({ wallet, prices, tokenMap, pnlBySymbol }) {
  const { bnb, bnbPrice, tokens, natives } = wallet;

  return useMemo(() => {
    // Multi-chain natives (BNB + ETH + Base ETH) when available; else legacy BNB.
    let nativeUsd = 0;
    const slices = [];
    if (natives && Object.keys(natives).length) {
      for (const [chain, n] of Object.entries(natives)) {
        const usd = n?.usd || ((n?.qty || 0) * (n?.priceUsd || 0));
        if (usd > 0) {
          nativeUsd += usd;
          slices.push({
            label: `${n.symbol || chain.toUpperCase()}`,
            value: usd,
            color: tokenColor(null, chain === 'bsc'),
          });
        }
      }
    } else {
      const bnbUsd = bnb != null && bnbPrice != null ? bnb * bnbPrice : 0;
      nativeUsd = bnbUsd;
      if (bnbUsd > 0) slices.push({ label: 'BNB', value: bnbUsd, color: tokenColor(null, true) });
    }
    let tokensUsd = 0;
    for (const t of tokens) {
      const usd = t.qty * (prices?.[t.symbol] || 0);
      tokensUsd += usd;
      if (usd > 0) {
        slices.push({
          label: t.chain && t.chain !== 'bsc'
            ? `${t.name || t.symbol} (${t.chain})`
            : (t.name || t.symbol),
          value: usd,
          color: tokenColor(tokenMap?.[t.symbol]?.contract_address || t.contract || t.symbol),
        });
      }
    }
    const netWorth = nativeUsd + tokensUsd;

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

    return { netWorth, unrealized, unrealizedPct, realized, alloc, nativeUsd, tokensUsd };
  }, [bnb, bnbPrice, natives, tokens, prices, tokenMap, pnlBySymbol]);
}
