// Settings → Subscription. Paper trial: clear Stripe checkout upgrade.
// Paid: manage billing portal.
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
  const [pricing, setPricing] = useState(null);
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');

  useEffect(() => {
    fetch(`${API_URL}/billing/status`).then(r => r.json()).then(setStatus).catch(() => {});
    fetch(`${API_URL}/billing/pricing`).then(r => r.json()).then(setPricing).catch(() => {});
  }, []);

  if (!status) return null;
  if (status.plan === 'solo') return null;

  const isPaper = status.plan === 'paper' || status.trial || status.status === 'trialing';
  const isPaidPlan = status.paid && !isPaper && status.status === 'active';
  const [label, cls] = LABELS[status.status] || LABELS.none;
  const trialEnds = status.current_period_end
    ? new Date(status.current_period_end).toLocaleDateString()
    : null;
  const monthly = pricing?.monthly_usd ?? 10;
  const annual = pricing?.annual_usd ?? 60;
  const early = pricing?.early_available;

  const checkout = async (plan) => {
    setBusy(plan);
    setErr('');
    try {
      const r = await fetch(`${API_URL}/billing/checkout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ plan }),
      });
      if (!r.ok) throw new Error((await r.json()).detail || `HTTP ${r.status}`);
      const { url } = await r.json();
      window.location.href = url;
    } catch (e) {
      setErr(e.message || 'Checkout failed');
      setBusy('');
    }
  };

  const openPortal = async () => {
    setBusy('portal');
    setErr('');
    try {
      const r = await fetch(`${API_URL}/billing/portal`, { method: 'POST' });
      if (!r.ok) throw new Error((await r.json()).detail || `HTTP ${r.status}`);
      window.location.href = (await r.json()).url;
    } catch (e) {
      setErr(e.message || 'Could not open billing portal');
      setBusy('');
    }
  };

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
          Bots: <b style={{ color: 'var(--text-bright)' }}>{status.bots_running ?? 0} of {status.max_bots}</b> running.
          {status.live_allowed === false && ' Paper trial is paper-only.'}
        </div>
      )}

      {isPaper && (
        <div className="upgrade-panel">
          <h3 className="upgrade-panel-title">Upgrade to subscribe</h3>
          <p className="dash-muted" style={{ fontSize: 13, margin: '0 0 14px', lineHeight: 1.5 }}>
            Unlock live trading, full bot slots, and the desktop engine download.
            Checkout is one click — card via Stripe.
          </p>
          {early && pricing && (
            <div className="subscribe-early" style={{ marginBottom: 12, fontSize: 13 }}>
              Founding price — {pricing.seats_left} of {pricing.early_limit} seats left
            </div>
          )}
          <div className="upgrade-actions">
            <button
              type="button"
              className="btn-primary"
              disabled={!!busy}
              onClick={() => checkout('monthly')}
            >
              {busy === 'monthly' ? 'Redirecting…' : `Subscribe monthly · $${monthly}/mo`}
            </button>
            <button
              type="button"
              className="btn-primary"
              disabled={!!busy}
              onClick={() => checkout('annual')}
            >
              {busy === 'annual' ? 'Redirecting…' : `Subscribe annually · $${annual}/yr`}
            </button>
          </div>
        </div>
      )}

      {isPaidPlan && (
        <button className="settings-save" disabled={!!busy} onClick={openPortal}>
          {busy === 'portal' ? 'Opening…' : 'Manage billing / cancel'}
        </button>
      )}

      {!isPaper && !isPaidPlan && status.paid === false && (
        <div className="upgrade-actions">
          <button type="button" className="btn-primary" disabled={!!busy} onClick={() => checkout('monthly')}>
            {busy === 'monthly' ? 'Redirecting…' : `Subscribe monthly · $${monthly}/mo`}
          </button>
          <button type="button" className="btn-primary" disabled={!!busy} onClick={() => checkout('annual')}>
            {busy === 'annual' ? 'Redirecting…' : `Subscribe annually · $${annual}/yr`}
          </button>
        </div>
      )}

      {err && <div className="dash-error" style={{ marginTop: 10, fontSize: 12 }}>{err}</div>}
    </div>
  );
}
