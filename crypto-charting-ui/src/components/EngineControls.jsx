import { useState, useEffect } from 'react';

const API_URL = 'http://localhost:8000';

function Dot({ status }) {
  const colors = { ok: '#00ff88', warning: '#fbbf24', down: '#ff3366', unknown: '#2a2f42' };
  return <span style={{ display: 'inline-block', width: 9, height: 9, borderRadius: '50%', background: colors[status] || colors.unknown, marginRight: 5 }} />;
}

// B2: engine pause toggle + risk caps + process health. PATCHes the same
// /engine/settings key the old wallet app uses, so the two stay in sync
// within one poll cycle whichever end you flip.
export default function EngineControls() {
  const [settings, setSettings] = useState(null);
  const [health, setHealth] = useState({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const loadSettings = async () => {
    try {
      const r = await fetch(`${API_URL}/engine/settings`);
      if (!r.ok) throw new Error(r.statusText);
      setSettings(await r.json());
      setError(null);
    } catch (e) { setError(String(e.message || e)); }
  };

  const loadHealth = async () => {
    try {
      const r = await fetch(`${API_URL}/health`);
      const data = await r.json();
      const statuses = {};
      Object.entries(data).forEach(([k, v]) => { statuses[k] = v.status; });
      setHealth(statuses);
    } catch { setHealth({}); }
  };

  useEffect(() => {
    loadSettings(); loadHealth();
    const a = setInterval(loadSettings, 10_000);
    const b = setInterval(loadHealth, 15_000);
    return () => { clearInterval(a); clearInterval(b); };
  }, []);

  const togglePause = async () => {
    if (!settings || busy) return;
    setBusy(true);
    try {
      const r = await fetch(`${API_URL}/engine/settings`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paused: settings.paused ? 0 : 1 }),
      });
      if (!r.ok) throw new Error(r.statusText);
      await loadSettings();
    } catch (e) { setError(String(e.message || e)); }
    setBusy(false);
  };

  const paused = !!settings?.paused;
  return (
    <div className="dash-panel">
      <h3>Engine</h3>
      {error && <div className="dash-error">{error}</div>}
      <button className={`engine-toggle ${paused ? 'paused' : 'live'}`}
        onClick={togglePause} disabled={!settings || busy}>
        {settings == null ? '…' : paused ? '⏸ ENGINE PAUSED — click to resume' : '● ENGINE LIVE — click to pause'}
      </button>

      {settings && (
        <div className="engine-caps">
          <span>Max/day <b>{settings.max_trades_per_day}</b></span>
          <span>Max trade <b>${settings.max_trade_usd}</b></span>
          <span>Max impact <b>{settings.max_price_impact_pct}%</b></span>
          <span>Retries <b>{settings.max_retry_attempts}</b></span>
        </div>
      )}

      <div style={{ marginTop: 12, fontSize: 11, color: '#a0a5b8', display: 'flex', gap: 14, flexWrap: 'wrap' }}>
        <span><Dot status={health.collector} />Collector</span>
        <span><Dot status={health.execution_engine} />Engine</span>
        <span><Dot status={health.strategy_runner} />Strategy runner</span>
      </div>
      <div className="qt-note">Risk limits are edited in ⚙ Settings.</div>
    </div>
  );
}
