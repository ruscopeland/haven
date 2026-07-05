import { fmtUsd } from '../utils/format';
import usePortfolioStats from '../hooks/usePortfolioStats';

// Top metric-card row of the Dashboard — net worth, unrealized P/L, realized
// P/L. Asset allocation lives in its own AssetAllocation panel (right column)
// so this row stays compact. Fed by the key-free data sources: RPC balances,
// collector prices, engine trades.
export default function PortfolioSummary({ wallet, prices, tokenMap, pnlBySymbol, openOrdersCount, filledCount }) {
  const stats = usePortfolioStats({ wallet, prices, tokenMap, pnlBySymbol });

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
    </div>
  );
}
