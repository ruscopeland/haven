import { fmtUsd } from '../utils/format';
import usePortfolioStats from '../hooks/usePortfolioStats';

// Portfolio metric cards — net worth, unrealized P/L, realized P/L. Stacked
// above AssetAllocation in the right dash-col (compact = single narrow
// column instead of spanning the page) so the left column can start at the
// top with Strategies/Token Assets, no scrolling needed to reach them.
export default function PortfolioSummary({ wallet, prices, tokenMap, pnlBySymbol, openOrdersCount, filledCount, compact }) {
  const stats = usePortfolioStats({ wallet, prices, tokenMap, pnlBySymbol });

  return (
    <div className={`metrics-grid${compact ? ' compact' : ''}`}>
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
    </div>
  );
}
