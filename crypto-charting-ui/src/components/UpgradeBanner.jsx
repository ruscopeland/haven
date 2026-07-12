// Always-visible upgrade strip while on free paper trial.
import { useEffect, useState } from 'react';
import { API_URL } from '../authFetch.js';

export default function UpgradeBanner({ onOpenSettings }) {
  const [status, setStatus] = useState(null);
  const [pricing, setPricing] = useState(null);
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const [s, p] = await Promise.all([
          fetch(`${API_URL}/billing/status`).then(r => r.ok ? r.json() : null),
          fetch(`${API_URL}/billing/pricing`).then(r => r.ok ? r.json() : null),
        ]);
        if (!alive) return;
        setStatus(s);
        setPricing(p);
      } catch { /* ignore */ }
    };
    load();
    const iv = setInterval(load, 60_000);
    return () => { alive = false; clearInterval(iv); };
  }, []);

  if (!status) return null;
  // Paid Stripe plans: status active + live_allowed. Paper trial only.
  const isPaper = status.plan === 'solo'
    ? false
    : (status.live_allowed === false && (status.plan === 'paper' || status.trial || status.status === 'trialing'));
  if (!isPaper) return null;

  const monthly = pricing?.monthly_usd ?? 10;
  const annual = pricing?.annual_usd ?? 60;
  const trialEnds = status.current_period_end
    ? new Date(status.current_period_end).toLocaleDateString()
    : null;

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
      window.location.href = (await r.json()).url;
    } catch (e) {
      setErr(e.message || 'Checkout failed');
      setBusy('');
    }
  };

  return (
    <div className="upgrade-banner" role="region" aria-label="Upgrade subscription">
      <div className="upgrade-banner-copy">
        <strong>You are on a free paper trial</strong>
        {trialEnds ? <span> · ends {trialEnds}</span> : null}
        <span className="upgrade-banner-sub">
          {' '}— subscribe for live trading, full bots, and the desktop engine.
        </span>
      </div>
      <div className="upgrade-banner-actions">
        <button
          type="button"
          className="btn-primary"
          disabled={!!busy}
          onClick={() => checkout('monthly')}
        >
          {busy === 'monthly' ? '…' : `Upgrade · $${monthly}/mo`}
        </button>
        <button
          type="button"
          className="btn-secondary"
          disabled={!!busy}
          onClick={() => checkout('annual')}
        >
          {busy === 'annual' ? '…' : `Annual · $${annual}/yr`}
        </button>
        {onOpenSettings && (
          <button type="button" className="btn-ghost" onClick={onOpenSettings}>
            Settings
          </button>
        )}
      </div>
      {err && <div className="upgrade-banner-err">{err}</div>}
    </div>
  );
}
