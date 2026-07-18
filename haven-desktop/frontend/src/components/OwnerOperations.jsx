import { useCallback, useEffect, useState } from 'react';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:8000';

function Status({ value }) {
  const normalized = String(value || 'unknown').toLowerCase();
  return <span className={`ops-status ${normalized}`}>{value || 'unknown'}</span>;
}

function Metric({ label, value, hint }) {
  return (
    <div className="ops-metric">
      <span>{label}</span>
      <strong>{value ?? '—'}</strong>
      {hint && <small>{hint}</small>}
    </div>
  );
}

export default function OwnerOperations() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    setRefreshing(true);
    try {
      const response = await fetch(`${API_URL}/owner/overview`);
      if (!response.ok) throw new Error((await response.json()).detail || response.statusText);
      setData(await response.json());
      setError(null);
    } catch (err) {
      setError(err.message || String(err));
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    load();
    const timer = setInterval(load, 30_000);
    return () => clearInterval(timer);
  }, [load]);

  if (!data && error) return <div className="ops-page"><div role="alert" className="dash-error">{error}</div></div>;
  if (!data) return <div className="ops-page" aria-busy="true">Loading operations…</div>;

  const usage = data.provider?.usage;
  return (
    <main className="ops-page">
      <header className="ops-head">
        <div><p className="eyebrow">Private owner view</p><h1>Haven operations</h1></div>
        <button className="btn-secondary" onClick={load} disabled={refreshing}>
          {refreshing ? 'Refreshing…' : 'Refresh'}
        </button>
      </header>

      {!!data.alerts?.length && (
        <section aria-labelledby="ops-alerts" className="ops-alerts">
          <h2 id="ops-alerts">Needs attention</h2>
          {data.alerts.map(alert => (
            <div key={alert.code} className={`ops-alert ${alert.severity}`} role="status">
              <strong>{alert.severity}</strong><span>{alert.message}</span>
            </div>
          ))}
        </section>
      )}

      <div className="ops-grid">
        <section className="ops-card">
          <h2>Service</h2><Status value={data.service?.status} />
          <Metric label="Active bots" value={data.trading?.active_bots} />
          <Metric label="Live bots" value={data.trading?.live_bots} />
        </section>
        <section className="ops-card">
          <h2>Binance Alpha</h2><Status value={data.provider?.state} />
          <Metric label="Subscriptions" value={data.provider?.details?.subscriptions} />
          <Metric label="Credits left" value={usage?.credits_left} hint={usage ? `Used ${usage.credits_used}` : null} />
          <Metric label="Reconnects / gaps" value={`${data.provider?.reconnect_count || 0} / ${data.provider?.gap_count || 0}`} />
          {data.provider?.error && <p className="dash-error" style={{ fontSize: 11 }}>{data.provider.error}</p>}
        </section>
        <section className="ops-card">
          <h2>Database</h2><Status value={data.database?.migrations?.up_to_date ? 'ok' : 'drift'} />
          <Metric label="Size" value={data.database?.size_bytes != null ? `${(data.database.size_bytes / 1048576).toFixed(1)} MB` : '—'} />
          <Metric label="Cached assets" value={data.database?.assets} />
          <Metric label="Cached candles" value={data.database?.candles} />
          <Metric label="Pending reconciliation" value={data.database?.pending_reconciliation} />
        </section>
        <section className="ops-card">
          <h2>Backups</h2><Status value={data.backup?.status || 'missing'} />
          <Metric label="Provider" value={data.backup?.provider} />
          <Metric label="Last run" value={data.backup?.started_at ? new Date(data.backup.started_at).toLocaleString() : 'Never'} />
        </section>
      </div>

      <section className="ops-card ops-wide">
        <h2>Subscriptions</h2>
        <div className="ops-subscriptions">
          {(data.subscriptions || []).map(row => (
            <Metric key={`${row.plan}-${row.status}`} label={`${row.plan || 'none'} · ${row.status}`} value={row.count} />
          ))}
          {!data.subscriptions?.length && <p className="dash-muted">No subscription records.</p>}
        </div>
      </section>

      <nav className="ops-links" aria-label="Provider and deployment dashboards">
        {Object.entries(data.links || {}).filter(([, url]) => url).map(([name, url]) => (
          <a key={name} href={url} target="_blank" rel="noopener noreferrer">{name}</a>
        ))}
      </nav>
    </main>
  );
}
