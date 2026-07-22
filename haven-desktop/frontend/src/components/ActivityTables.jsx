import { fmtUsd, fmtQty, fmtPrice, fmtTime, tokenLabel, tradeUsd } from '../utils/format';

// B3: read-only recent trades + active markers, fed entirely by the
// DashboardView's shared /dashboard/overview poll (no fetching here).
// Trades table matches the old wallet Dashboard's Trade History: execution
// price with the expected price shown alongside when they differ, the gas
// fee paid, and a BscScan link for the tx — same data, same colors.
export default function ActivityTables({ overview, tokenMap, bnbPrice, onOpenMarkerChart }) {
  const trades = (overview?.trades || []).slice(0, 50);
  const markers = overview?.open_markers || [];

  return (
    <>
      <div className="dash-panel">
        <h3>Active markers ({markers.length})</h3>
        {markers.length === 0 ? (
          <div className="dash-muted" style={{ fontSize: 12 }}>No active markers.</div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table className="dash-table">
              <thead><tr><th>Token</th><th>Type</th><th>Dir</th><th>Price</th><th>USD</th><th>Label</th></tr></thead>
              <tbody>
                {markers.map(m => {
                  let usd = null;
                  try { usd = JSON.parse(m.metadata_json || '{}').usd; } catch { /* legacy metadata */ }
                  return (
                    <tr
                      key={m.id}
                      onClick={() => onOpenMarkerChart?.(m.symbol, tokenLabel(m.symbol, tokenMap))}
                      style={{ cursor: onOpenMarkerChart ? 'pointer' : undefined }}
                      title="Open this marker's chart"
                    >
                      <td>{tokenLabel(m.symbol, tokenMap)}</td>
                      <td>{m.marker_type}</td>
                      <td>{m.direction || 'cross'}</td>
                      <td>{fmtPrice(m.price)}</td>
                      <td>{usd != null ? fmtUsd(Number(usd)) : '—'}</td>
                      <td className="dash-muted">{m.label || ''}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="dash-panel">
        <h3>Recent trades</h3>
        {trades.length === 0 ? (
          <div className="dash-muted" style={{ fontSize: 12 }}>No trades yet.</div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table className="dash-table">
              <thead>
                <tr>
                  <th>Time</th><th>Token</th><th>Side</th><th>USD</th><th>Price</th>
                  <th>Fees (gas)</th><th>Reason</th><th>Status</th><th>Tx</th>
                </tr>
              </thead>
              <tbody>
                {trades.map(t => {
                  const execPx = t.price || t.execution_price;
                  const expPx = t.price || t.expected_price;
                  const showExpected = expPx && execPx && expPx !== execPx && Math.abs((execPx - expPx) / expPx) > 0.005;
                  const gasBnb = t.gas_cost_native || 0;
                  const realTx = t.tx_hash && !t.tx_hash.startsWith('paper');
                  const timeMs = t.time || t.block_time;
                  const sideStr = (t.side || t.direction || '').toUpperCase();
                  const statusStr = t.mode === 'live' ? 'FILLED' : (t.mode === 'paper' ? 'PAPER' : (t.status || 'FILLED'));
                  return (
                    <tr key={t.id}>
                      <td className="dash-muted">{fmtTime(timeMs)}</td>
                      <td>{tokenLabel(t.symbol, tokenMap)}</td>
                      <td><span className={`side-pill ${sideStr === 'BUY' ? 'buy' : 'sell'}`}>{sideStr}</span></td>
                      <td>{fmtUsd(tradeUsd(t))}</td>
                      <td>
                        <div>{fmtPrice(execPx || expPx)}</div>
                        {showExpected && (
                          <div className="dash-muted" style={{ fontSize: 10 }}>expected {fmtPrice(expPx)}</div>
                        )}
                      </td>
                      <td className="dash-muted" title={gasBnb > 0 ? 'Gas paid in BNB; $ value at today’s BNB price' : ''}>
                        {gasBnb > 0 ? `${fmtQty(gasBnb)} BNB${bnbPrice ? ` (~${fmtUsd(gasBnb * bnbPrice)})` : ''}` : '—'}
                      </td>
                      <td className="dash-muted">{t.reason_label || t.reason || '—'}</td>
                      <td><span className={`status-pill ${['FILLED', 'PAPER'].includes(statusStr) ? statusStr : 'other'}`}>{statusStr}</span></td>
                      <td>
                        {realTx ? (
                          <a href={t.tx_hash.length > 66 ? `https://explorer.cow.fi/bsc/orders/${t.tx_hash}` : `https://bscscan.com/tx/${t.tx_hash}`} target="_blank" rel="noopener noreferrer"
                            style={{ color: 'var(--primary)', textDecoration: 'none', fontSize: 11 }}>
                            {t.tx_hash.substring(0, 8)}… ↗
                          </a>
                        ) : '—'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}
