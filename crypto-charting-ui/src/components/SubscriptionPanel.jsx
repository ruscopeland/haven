// Settings → Subscription. Shows the user's plan/status and opens the Stripe
// billing portal (update card / cancel). Hidden in solo mode (no billing).
import { useEffect, useState } from 'react';
import { API_URL } from '../authFetch.js';

const LABELS = {
  active: ['Active', 'dash-green'],
  trialing: ['Paper trial', 'dash-yellow'],
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
  const isPaper = status.plan === 'paper' || status.trial;
  const trialEnds = status.current_period_end
    ? new Date(status.current_period_end).toLocaleDateString()
    : null;

  return (
    <div style={{ marginBottom: 8 }}>
      <h2 style={{ color: 'var(--text-bright)', marginTop: 0 }}>Subscription</h2>
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 12, flexWrap: 'wrap' }}>
        <span className={cls} style={{ fontWeight: 600 }}>{label}</span>
        {status.plan && <span className="dash-muted" style={{ fontSize: 12 }}>· {status.plan}</span>}
        {status.early ? <span className="pill" title="Founding member — price locked">Founding price</span> : null}
        {isPaper && trialEnds && (
          <span className="dash-muted" style={{ fontSize: 12 }}>ends {trialEnds}</span>
        )}
      </div>
      {status.max_bots != null && (
        <div className="dash-muted" style={{ fontSize: 12, marginBottom: 12 }}>
          Bots: <b style={{ color: 'var(--text-bright)' }}>{status.bots_running ?? 0} of {status.max_bots}</b> running
          (a bot is a strategy armed DRY or LIVE{status.extra_bots ? `; includes ${status.extra_bots} extra slot${status.extra_bots > 1 ? 's' : ''}` : ''}).
          {status.live_allowed === false && ' Paper trial is paper-only — subscribe to unlock LIVE trading.'}
        </div>
      )}
      {status.stripe_customer_id !== undefined || status.plan !== 'paper' ? (
        <button className="settings-save" disabled={busy || isPaper && !status.paid} onClick={openPortal}
          style={{ opacity: isPaper && status.status === 'trialing' ? 0.9 : 1 }}>
          {busy ? 'Opening…' : isPaper ? 'Upgrade / manage billing' : 'Manage billing / cancel'}
        </button>
      ) : null}
      {isPaper && (
        <p className="dash-muted" style={{ fontSize: 11, marginTop: 10 }}>
          Upgrade from the subscribe screen or billing portal when you are ready for live trading.
        </p>
      )}
      {err && <div className="dash-error" style={{ marginTop: 10, fontSize: 12 }}>Could not open billing portal: {err}</div>}
    </div>
  );
}
