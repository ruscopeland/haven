import { useMemo } from 'react';
import usePortfolioStats from '../hooks/usePortfolioStats';

// Asset allocation donut — moved out of the top metric row into its own
// panel (was crowding that row and forcing it taller/wider than it needed).
export default function AssetAllocation({ wallet, prices, tokenMap, pnlBySymbol }) {
  const stats = usePortfolioStats({ wallet, prices, tokenMap, pnlBySymbol });

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
    <div className="dash-panel">
      <h3>Asset Allocation</h3>
      {stats.alloc.length > 0 ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          <svg width="120" height="120" style={{ flexShrink: 0 }}>
            <circle cx="60" cy="60" r="50" fill="transparent" stroke="rgba(255,255,255,0.03)" strokeWidth="12" />
            {donut}
          </svg>
          <div className="alloc-legend" style={{ maxHeight: 'none' }}>
            {stats.alloc.map((item, idx) => (
              <div className="item" key={idx}>
                <span className="swatch" style={{ backgroundColor: item.color }} />
                <span style={{ fontWeight: 600, color: 'var(--text-bright)' }}>{item.label}</span>
                <span style={{ color: 'var(--text-muted)' }}>{item.pct.toFixed(0)}%</span>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <div className="dash-muted" style={{ fontSize: 12 }}>
          No holdings yet — set your wallet address in the Token Assets panel.
        </div>
      )}
    </div>
  );
}
