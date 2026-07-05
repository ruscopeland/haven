import { fmtUsd, fmtPrice, fmtTime, tokenLabel, tradeUsd } from '../utils/format';

// B3: read-only recent trades + active markers, fed entirely by the
// DashboardView's shared /dashboard/overview poll (no fetching here).
export default function ActivityTables({ overview, tokenMap, onOpenMarkerChart }) {
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
              <thead><tr><th>Time</th><th>Token</th><th>Side</th><th>USD</th><th>Price</th><th>Reason</th><th>Status</th></tr></thead>
              <tbody>
                {trades.map(t => (
                  <tr key={t.id}>
                    <td className="dash-muted">{fmtTime(t.block_time)}</td>
                    <td>{tokenLabel(t.symbol, tokenMap)}</td>
                    <td className={t.direction === 'BUY' ? 'dash-green' : 'dash-red'}>{t.direction}</td>
                    <td>{fmtUsd(tradeUsd(t))}</td>
                    <td>{fmtPrice(t.execution_price || t.expected_price)}</td>
                    <td className="dash-muted">{t.reason_label || t.reason || '—'}</td>
                    <td><span className={`status-pill ${['FILLED', 'PAPER'].includes(t.status) ? t.status : 'other'}`}>{t.status}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}
