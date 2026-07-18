import { fmtUsd } from '../utils/format';
import usePortfolioStats from '../hooks/usePortfolioStats';

// Portfolio mini-stats — net worth, unrealized P/L, realized P/L — as one
// row inside one panel, sized to the right dash-col (directly above
// AssetAllocation). Was three separate stacked cards; this is far more
// compact for three single numbers. Fed by the key-free data sources: RPC
// balances, Binance Alpha prices, and local-engine trades.
export default function PortfolioSummary({ wallet, prices, tokenMap, pnlBySymbol, openOrdersCount, filledCount }) {
  const stats = usePortfolioStats({ wallet, prices, tokenMap, pnlBySymbol });

  return (
    <div className="dash-panel">
      <h3>Portfolio</h3>
      <div className="mini-stats">
        <div className="mini-stat">
          <div className="mini-stat-label">Net Worth</div>
          <div className="mini-stat-value">{fmtUsd(stats.netWorth)}</div>
        </div>

        <div className="mini-stat">
          <div className="mini-stat-label">Holdings P/L</div>
          <div className={`mini-stat-value ${stats.unrealized >= 0 ? 'gain' : 'loss'}`}>
            {stats.unrealized >= 0 ? '+' : ''}{fmtUsd(stats.unrealized)}
          </div>
          <div className="mini-stat-sub">{stats.unrealized >= 0 ? '+' : ''}{stats.unrealizedPct.toFixed(2)}%</div>
        </div>

        <div className="mini-stat">
          <div className="mini-stat-label">Trading P/L</div>
          <div className={`mini-stat-value ${stats.realized >= 0 ? 'gain' : 'loss'}`}>
            {stats.realized >= 0 ? '+' : ''}{fmtUsd(stats.realized)}
          </div>
          <div className="mini-stat-sub">{filledCount} trades · {openOrdersCount} open</div>
        </div>
      </div>
    </div>
  );
}
