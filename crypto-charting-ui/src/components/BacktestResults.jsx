import { formatPriceString } from './Chart';

const fmtUsd = (v) => (v == null ? '—' : `${v < 0 ? '-' : ''}$${Math.abs(v).toFixed(2)}`);
const pnlClass = (v) => (v > 0 ? 'stat-pos' : v < 0 ? 'stat-neg' : '');

function Stat({ label, value, cls = '' }) {
  return (
    <div className="bt-stat">
      <div className="bt-stat-label">{label}</div>
      <div className={`bt-stat-value ${cls}`}>{value}</div>
    </div>
  );
}

// Stats strip + simulated trade table + strategy logs for a backtest result.
export default function BacktestResults({ result, flowInfo }) {
  if (!result) {
    return <div className="bt-results bt-empty">Run a backtest to see results</div>;
  }
  const { stats, trades = [], logs = [], pending = [], error } = result;

  // No stats means the run never produced a result (e.g. a symbol whose Alpha
  // klines came back empty) — show the error and stop before touching stats.
  if (!stats) {
    return (
      <div className="bt-results">
        <div className="bt-error">⚠ {error || 'No backtest result for this symbol.'}</div>
      </div>
    );
  }

  // Portfolio (finder-bound) runs annotate trades with the token they hit.
  const showSymbol = trades.some(t => t.symbol);
  const shortSym = (s) => (s || '').replace(/^ALPHA_/, '').replace(/USDT$/, '');

  return (
    <div className="bt-results">
      {error && <div className="bt-error">⚠ {error}</div>}

      {flowInfo && flowInfo.used && (
        <div className="bt-flow-banner">
          Flow data covers {flowInfo.covered} of {flowInfo.total} bars (collector keeps ~7
          days of 1m buckets) — earlier bars saw <code>ctx.flow.* = null</code>.
        </div>
      )}

      <div className="bt-stats-row">
        <Stat label="Net PnL" value={`${fmtUsd(stats.netPnlUsd)} (${stats.netPnlPct}%)`} cls={pnlClass(stats.netPnlUsd)} />
        <Stat label="Trades" value={stats.nTrades} />
        <Stat label="Win rate" value={stats.winRate == null ? '—' : `${stats.winRate}%`} />
        <Stat label="Profit factor" value={stats.profitFactor == null ? '—' : stats.profitFactor === Infinity ? '∞' : stats.profitFactor} />
        <Stat label="Max drawdown" value={`${fmtUsd(stats.maxDrawdownUsd)} (${stats.maxDrawdownPct}%)`} cls={stats.maxDrawdownUsd > 0 ? 'stat-neg' : ''} />
        <Stat label="Fees" value={fmtUsd(stats.feesUsd)} />
        {stats.openPositionUsd > 0 && (
          <Stat
            label="Open position"
            value={`${fmtUsd(stats.openPositionUsd)} (${stats.unrealizedPnlUsd >= 0 ? '+' : ''}${fmtUsd(stats.unrealizedPnlUsd)} unrealized)`}
            cls={pnlClass(stats.unrealizedPnlUsd)}
          />
        )}
      </div>

      {pending && pending.length > 0 && (
        <div className="bt-pending">
          {pending.map((p, i) => (
            <span key={i}>⏳ {p.side} signal on the final bar — would fill next bar</span>
          ))}
        </div>
      )}

      <div className="bt-tables">
        <div className="bt-trades">
          <div className="bt-section-title">Simulated trades ({trades.length})</div>
          <table>
            <thead>
              <tr>
                <th>Time</th>
                {showSymbol && <th>Token</th>}
                <th>Side</th><th>Price</th><th>Qty</th><th>USD</th><th>Tag</th>
                {showSymbol && <th>Rank@bind</th>}
                <th>PnL</th>
              </tr>
            </thead>
            <tbody>
              {trades.slice().reverse().map((t, i) => (
                <tr key={i}>
                  <td>{new Date(t.time * 1000).toLocaleString([], { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</td>
                  {showSymbol && <td>{shortSym(t.symbol)}</td>}
                  <td className={t.side === 'BUY' ? 'stat-pos' : 'stat-neg'}>{t.side}</td>
                  <td>{formatPriceString(t.price)}</td>
                  <td>{t.qty.toPrecision(4)}</td>
                  <td>{fmtUsd(t.usd)}</td>
                  <td>{t.tag || ''}</td>
                  {showSymbol && <td>{t.entryRank ? `#${t.entryRank}` : ''}</td>}
                  <td className={pnlClass(t.realizedPnl)}>{t.realizedPnl == null ? '' : fmtUsd(t.realizedPnl)}</td>
                </tr>
              ))}
              {trades.length === 0 && <tr><td colSpan={showSymbol ? 9 : 7} className="bt-muted">No trades fired</td></tr>}
            </tbody>
          </table>
        </div>

        {logs && logs.length > 0 && (
          <div className="bt-logs">
            <div className="bt-section-title">Strategy log ({logs.length})</div>
            <pre>{logs.slice(-200).join('\n')}</pre>
          </div>
        )}
      </div>
    </div>
  );
}
