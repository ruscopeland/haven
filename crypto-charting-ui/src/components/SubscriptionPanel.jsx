// Settings → Subscription. Shows the user's plan/status and opens the Stripe
// billing portal (update card / cancel). Hidden in solo mode (no billing).
import { useEffect, useState } from 'react';
import { API_URL } from '../authFetch.js';

const LABELS = {
  active: ['Active', 'dash-green'],
  trialing: ['Trial', 'dash-green'],
  past_due: ['Payment overdue', 'dash-error'],
  canceled: ['Canceled', 'dash-muted'],
  none: ['No subscription', 'dash-muted'],
  solo: ['Solo mode', 'dash-muted'],
};

export default function SubscriptionPanel() {
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => {
    fetch(`${API_URL}/billing/status`).then(r => r.json()).then(setStatus).catch(() => {});
  }, []);

  if (!status) return null;
  if (status.plan === 'solo') return null;   // owner's own stack — nothing to bill

  const openPortal = async () => {
    setBusy(true); setErr('');
    try {
      const r = await fetch(`${API_URL}/billing/portal`, { method: 'POST' });
      if (!r.ok) throw new Error((await r.json()).detail || `HTTP ${r.status}`);
      window.location.href = (await r.json()).url;
    } catch (e) { setErr(e.message); setBusy(false); }
  };

  const [label, cls] = LABELS[status.status] || LABELS.none;
  return (
    <div className="settings-root" style={{ marginBottom: 24 }}>
      <h2 style={{ color: '#e5e9f0', marginTop: 0 }}>💳 Subscription</h2>
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 12 }}>
        <span className={cls} style={{ fontWeight: 600 }}>{label}</span>
        {status.plan && <span className="dash-muted" style={{ fontSize: 12 }}>· {status.plan}</span>}
        {status.early ? <span className="pill" title="Founding member — price locked">🔥 Founding price</span> : null}
      </div>
      {status.max_bots != null && (
        <div className="dash-muted" style={{ fontSize: 12, marginBottom: 12 }}>
          🤖 Bots: <b style={{ color: '#e5e9f0' }}>{status.bots_running ?? 0} of {status.max_bots}</b> running
          (a bot is a strategy armed DRY or LIVE{status.extra_bots ? `; includes ${status.extra_bots} extra slot${status.extra_bots > 1 ? 's' : ''}` : ''}).
          {status.live_allowed === false && ' Trial accounts are paper-only — subscribe to unlock LIVE trading.'}
          {' '}Need more slots? Extra bots are coming as an add-on — contact support.
        </div>
      )}
      <button className="settings-save" disabled={busy} onClick={openPortal}>
        {busy ? 'Opening…' : 'Manage billing / cancel'}
      </button>
      {err && <div className="dash-error" style={{ marginTop: 10, fontSize: 12 }}>Could not open billing portal: {err}</div>}
    </div>
  );
}
