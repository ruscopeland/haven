// Shown when a user is signed in but has no active subscription or paper trial.
// Paper trial is free (no card). Paid plans unlock LIVE trading + full bot slots.
import { useEffect, useState } from 'react';
import { UserButton } from '@clerk/clerk-react';
import { API_URL } from '../authFetch.js';
import HavenLogo from './HavenLogo.jsx';

export default function Subscribe({ onActivated }) {
  const [pricing, setPricing] = useState(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    fetch(`${API_URL}/billing/pricing`).then(r => r.json()).then(setPricing).catch(() => {});
  }, []);

  const startPaper = async () => {
    setBusy('paper'); setError('');
    try {
      const res = await fetch(`${API_URL}/billing/start-paper-trial`, { method: 'POST' });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.detail || `HTTP ${res.status}`);
      onActivated?.();
    } catch (e) {
      setError(typeof e.message === 'string' ? e.message : 'Could not start trial');
      setBusy('');
    }
  };

  const checkout = async (plan) => {
    setBusy(plan); setError('');
    try {
      const res = await fetch(`${API_URL}/billing/checkout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ plan }),
      });
      if (!res.ok) throw new Error((await res.json()).detail || `HTTP ${res.status}`);
      const { url } = await res.json();
      window.location.href = url;
    } catch (e) {
      setError(e.message);
      setBusy('');
    }
  };

  const early = pricing?.early_available;
  const monthly = pricing?.monthly_usd ?? 10;
  const annual = pricing?.annual_usd ?? 60;
  const trialDays = pricing?.paper_trial_days ?? 14;

  return (
    <div className="subscribe-root">
      <div className="subscribe-topbar">
        <div className="landing-brand"><HavenLogo size={28} /></div>
        <UserButton afterSignOutUrl="/" />
      </div>
      <div className="subscribe-card">
        <h1>Choose how you want to start</h1>
        <p className="subscribe-sub">
          Start free with paper trading, or subscribe for live execution and full bot slots.
          Charts, strategies, and Token Finder are included either way.
        </p>
        {early && pricing && (
          <div className="subscribe-early">
            🔥 Founding price — {pricing.seats_left} of {pricing.early_limit} seats left.
            Whatever you lock in stays your price.
          </div>
        )}
        <div className="pricing-cards">
          <div className="pricing-card featured">
            <div className="pricing-badge">Free</div>
            <div className="pricing-name">Paper trial</div>
            <div className="pricing-amount">$0<span>/{trialDays}d</span></div>
            <div className="pricing-note">Paper bots only · no card</div>
            <button className="btn-primary" disabled={!!busy} onClick={startPaper}>
              {busy === 'paper' ? 'Starting…' : 'Start paper trial'}
            </button>
          </div>
          <div className="pricing-card">
            <div className="pricing-name">Monthly</div>
            <div className="pricing-amount">${monthly}<span>/mo</span></div>
            <button className="btn-primary" disabled={!!busy} onClick={() => checkout('monthly')}>
              {busy === 'monthly' ? 'Redirecting…' : 'Subscribe monthly'}
            </button>
          </div>
          <div className="pricing-card">
            <div className="pricing-badge" style={{ background: 'var(--primary)' }}>Best value</div>
            <div className="pricing-name">Annual</div>
            <div className="pricing-amount">${annual}<span>/yr</span></div>
            <div className="pricing-note">{early ? '$5/mo billed yearly' : `$${(annual / 12).toFixed(0)}/mo billed yearly`}</div>
            <button className="btn-primary" disabled={!!busy} onClick={() => checkout('annual')}>
              {busy === 'annual' ? 'Redirecting…' : 'Subscribe annually'}
            </button>
          </div>
        </div>
        {error && <div className="subscribe-error">{error}</div>}
        <p className="landing-fineprint">
          Paper trial never executes live trades. LIVE trading requires a paid plan and the
          desktop engine. Payments by Stripe. Cancel anytime from Settings. Not financial advice.
        </p>
      </div>
    </div>
  );
}
