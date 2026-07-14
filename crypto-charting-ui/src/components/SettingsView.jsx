import { useState, useEffect } from 'react';
import '../dashboard.css';
import SubscriptionPanel from './SubscriptionPanel.jsx';
import EngineConnect from './EngineConnect.jsx';
import { AlphaBadge } from './AlphaRisk.jsx';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:8000';

const FIELDS = [
  { key: 'max_trades_per_day', label: 'Max trades per day', step: 1, min: 0,
    help: 'Engine stops opening new trades after this many FILLED trades in a day.' },
  { key: 'max_trade_usd', label: 'Max trade size (USD)', step: 10, min: 0,
    help: 'Any single trade above this is aborted before it reaches the chain.' },
  { key: 'max_price_impact_pct', label: 'Max price impact (%)', step: 0.5, min: 0,
    help: 'Swap quotes implying a worse price than this versus the Binance Alpha feed are rejected.' },
  { key: 'max_retry_attempts', label: 'Max retry attempts', step: 1, min: 0,
    help: 'Failed marker fires re-arm this many times, then the marker is disabled.' },
];

export default function SettingsView({ onOpenLegal }) {
  const [saved, setSaved] = useState(null);
  const [draft, setDraft] = useState({});
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);
  const [securityStatus, setSecurityStatus] = useState(null);

  const load = async () => {
    try {
      const r = await fetch(`${API_URL}/engine/settings`);
      if (!r.ok) throw new Error(r.statusText);
      const data = await r.json();
      setSaved(data);
      setDraft(Object.fromEntries(FIELDS.map(f => [f.key, data[f.key]])));
      setMsg(null);
    } catch (e) { setMsg({ kind: 'err', text: `Failed to load settings: ${e.message || e}` }); }
  };

  useEffect(() => { load(); }, []);

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const r = await fetch(`${API_URL}/security/status`);
        if (r.ok && alive) setSecurityStatus(await r.json());
      } catch { /* */ }
    };
    tick();
    const iv = setInterval(tick, 15_000);
    return () => { alive = false; clearInterval(iv); };
  }, []);

  const dirty = saved && FIELDS.some(f => Number(draft[f.key]) !== Number(saved[f.key]));

  const save = async () => {
    setBusy(true); setMsg(null);
    try {
      const body = Object.fromEntries(FIELDS.map(f => [f.key, Number(draft[f.key])]));
      const r = await fetch(`${API_URL}/engine/settings`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error((await r.json()).detail || r.statusText);
      await load();
      setMsg({ kind: 'ok', text: 'Saved — the engine picks this up on its next tick (~3s).' });
    } catch (e) { setMsg({ kind: 'err', text: `Save failed: ${e.message || e}` }); }
    setBusy(false);
  };

  return (
    <div className="settings-sections">
      {dirty && (
        <div className="settings-unsaved">
          You have unsaved risk limit changes.
          <button className="settings-save" style={{ marginLeft: 12, padding: '6px 14px' }}
            disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save now'}</button>
        </div>
      )}

      <section className="settings-section" id="settings-billing">
        <SubscriptionPanel />
      </section>

      <section className="settings-section" id="settings-security">
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8, flexWrap: 'wrap' }}>
          <h2 style={{ margin: 0 }}>Token security</h2>
          <AlphaBadge compact />
        </div>
        {!securityStatus ? (
          <p className="dash-muted" style={{ fontSize: 12 }}>Loading security status…</p>
        ) : !securityStatus.configured ? (
          <p className="dash-error" style={{ fontSize: 12 }}>
            Binance Alpha is not configured on the Haven server.
          </p>
        ) : (
          <div className="dash-muted" style={{ fontSize: 12, lineHeight: 1.6 }}>
            <div>Status: <b className="dash-green">configured</b> · {securityStatus.provider}</div>
            <div>Cached checks: {securityStatus.scanned_total} · blocked tokens: {securityStatus.blocked_total}</div>
            <div style={{ marginTop: 8, color: 'var(--text-bright)' }}>
              <b>Trade safety:</b> the engine never unlimited-approves tokens. Before any approve/swap it
              uses Binance Alpha DEX security information. Elevated risk still charts; manual trades require
              contract verification and an explicit risk acknowledgment.
            </div>
          </div>
        )}
      </section>

      <section className="settings-section" id="settings-engine">
        <h2>Desktop engine</h2>
        <p className="dash-muted" style={{ fontSize: 12, marginBottom: 12 }}>
          Live trading runs on your machine. Download the engine and connect an API key here.
        </p>
        <EngineConnect />
      </section>

      <section className="settings-section" id="settings-legal">
        <h2>Legal &amp; documentation</h2>
        <p className="dash-muted" style={{ fontSize: 12, marginBottom: 12 }}>
          Haven is software and shared data access — not investment advice. You control keys and outcomes.
          Subscription helps fund data, development, and updates.
        </p>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          {[
            ['docs', 'User guide'],
            ['terms', 'Terms of Service'],
            ['privacy', 'Privacy Policy'],
            ['risk', 'Risk disclosure'],
          ].map(([k, label]) => (
            <button key={k} type="button" className="btn-secondary" style={{ padding: '8px 12px', fontSize: 12 }}
              onClick={() => onOpenLegal?.(k)}>
              {label}
            </button>
          ))}
        </div>
      </section>

      <section className="settings-section" id="settings-risk">
        <h2>Engine risk limits</h2>
        <p className="dash-muted" style={{ fontSize: 12, marginBottom: 16 }}>
          These guards apply to every trade the engine executes — manual quick trades,
          marker fires and live strategies alike. Pause/resume lives on the top toolbar.
        </p>

        {FIELDS.map(f => (
          <div className="settings-field" key={f.key}>
            <label>{f.label}</label>
            <input type="number" step={f.step} min={f.min}
              value={draft[f.key] ?? ''}
              onChange={e => { setDraft({ ...draft, [f.key]: e.target.value }); setMsg(null); }} />
            <div className="dash-muted" style={{ fontSize: 11, marginTop: 3 }}>{f.help}</div>
          </div>
        ))}

        <button className="settings-save" disabled={!dirty || busy} style={{ opacity: dirty ? 1 : 0.4 }}
          onClick={save}>{busy ? 'Saving…' : 'Save changes'}</button>
        {msg && (
          <div className={msg.kind === 'ok' ? 'dash-green' : 'dash-error'} style={{ marginTop: 10, fontSize: 12 }}>
            {msg.text}
          </div>
        )}
      </section>
    </div>
  );
}
