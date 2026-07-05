import { useMemo } from 'react';
import { fmtUsd, tokenColor } from '../utils/format';
import { unrealizedFor } from '../utils/pnl';

// Top metric-card row of the Dashboard — the old wallet's portfolio stats
// (net worth, unrealized P/L, realized trading P/L, allocation donut) fed by
// the key-free data sources: RPC balances, collector prices, engine trades.
export default function PortfolioSummary({ wallet, prices, tokenMap, pnlBySymbol, openOrdersCount, filledCount }) {
  const { bnb, bnbPrice, tokens } = wallet;

  const stats = useMemo(() => {
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

  const donut = useMemo(() => {
    const radius = 50, circ = 2 * Math.PI * radius;
    let acc = 0;
    return stats.alloc.map((item, idx) => {
      const len = (item.pct / 100) * circ;
      const off = circ - ((acc / 100) * circ);
      acc += item.pct;
      return (
        <circle key={idx} cx="60" cy="60" r={radius} fill="transparent"
          stroke={item.color} strokeWidth="12"
          strokeDasharray={`${len} ${circ - len}`} strokeDashoffset={off}
          transform="rotate(-90 60 60)"
          style={{ transition: 'stroke-dasharray 0.5s ease' }} />
      );
    });
  }, [stats.alloc]);

  return (
    <div className="metrics-grid">
      <div className="glass-panel metric-card">
        <div className="metric-title">Portfolio Net Worth</div>
        <div className="metric-value">{fmtUsd(stats.netWorth)}</div>
        <div className="metric-subvalue">BNB + traded Alpha tokens (collector prices)</div>
      </div>

      <div className={`glass-panel metric-card ${stats.unrealized >= 0 ? 'gain' : 'loss'}`}>
        <div className="metric-title">Holdings P/L (unrealized)</div>
        <div className="metric-value">{stats.unrealized >= 0 ? '+' : ''}{fmtUsd(stats.unrealized)}</div>
        <div className="metric-subvalue">
          <span className={`badge ${stats.unrealized >= 0 ? 'badge-gain' : 'badge-loss'}`}>
            {stats.unrealized >= 0 ? '+' : ''}{stats.unrealizedPct.toFixed(2)}%
          </span>
          <span>vs cost of open positions</span>
        </div>
      </div>

      <div className={`glass-panel metric-card ${stats.realized >= 0 ? 'gain' : 'loss'}`}>
        <div className="metric-title">Trading P/L (realized)</div>
        <div className="metric-value">{stats.realized >= 0 ? '+' : ''}{fmtUsd(stats.realized)}</div>
        <div className="metric-subvalue">{filledCount} filled trades · {openOrdersCount} open orders</div>
      </div>

      <div className="glass-panel metric-card" style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
        {stats.alloc.length > 0 ? (
          <>
            <svg width="120" height="120" style={{ flexShrink: 0 }}>
              <circle cx="60" cy="60" r="50" fill="transparent" stroke="rgba(255,255,255,0.03)" strokeWidth="12" />
              {donut}
            </svg>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0, flex: 1 }}>
              <span className="metric-title" style={{ fontSize: 11, marginBottom: 0 }}>Asset Allocation</span>
              <div className="alloc-legend">
                {stats.alloc.map((item, idx) => (
                  <div className="item" key={idx}>
                    <span className="swatch" style={{ backgroundColor: item.color }} />
                    <span style={{ fontWeight: 600, color: 'var(--text-bright)' }}>{item.label}</span>
                    <span style={{ color: 'var(--text-muted)' }}>{item.pct.toFixed(0)}%</span>
                  </div>
                ))}
              </div>
            </div>
          </>
        ) : (
          <div className="dash-muted" style={{ fontSize: 13 }}>
            No holdings yet — set your wallet address in the Token Assets panel.
          </div>
        )}
      </div>
    </div>
  );
}
