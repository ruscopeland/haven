// Shown when a user is signed in but has no active subscription. Haven has no
// free tier, so this is the wall between sign-up and the terminal. Buttons hit
// POST /billing/checkout and redirect to Stripe Checkout; on return the webhook
// has already recorded the subscription, so the gate clears.
import { useEffect, useState } from 'react';
import { UserButton } from '@clerk/clerk-react';
import { API_URL } from '../authFetch.js';

export default function Subscribe() {
  const [pricing, setPricing] = useState(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    fetch(`${API_URL}/billing/pricing`).then(r => r.json()).then(setPricing).catch(() => {});
  }, []);

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
      window.location.href = url;                 // → Stripe Checkout
    } catch (e) {
      setError(e.message);
      setBusy('');
    }
  };

  const early = pricing?.early_available;
  const monthly = pricing?.monthly_usd ?? 10;
  const annual = pricing?.annual_usd ?? 60;

  return (
    <div className="subscribe-root">
      <div className="subscribe-topbar">
        <div className="landing-brand">⚓ Haven</div>
        <UserButton afterSignOutUrl="/" />
      </div>
      <div className="subscribe-card">
        <h1>Choose your plan</h1>
        <p className="subscribe-sub">
          One subscription unlocks everything: charts, strategies, Token Finder,
          cloud paper-trading, and the downloadable live-trading engine.
        </p>
        {early && pricing && (
          <div className="subscribe-early">
            🔥 Founding price — {pricing.seats_left} of {pricing.early_limit} seats left.
            Whatever you lock in stays your price.
          </div>
        )}
        <div className="pricing-cards">
          <div className="pricing-card">
            <div className="pricing-name">Monthly</div>
            <div className="pricing-amount">${monthly}<span>/mo</span></div>
            <button className="btn-primary" disabled={!!busy} onClick={() => checkout('monthly')}>
              {busy === 'monthly' ? 'Redirecting…' : 'Subscribe monthly'}
            </button>
          </div>
          <div className="pricing-card featured">
            <div className="pricing-badge">Best value</div>
            <div className="pricing-name">Annual</div>
            <div className="pricing-amount">${annual}<span>/yr</span></div>
            <div className="pricing-note">{early ? '$5/mo billed yearly' : `$${(annual / 12).toFixed(0)}/mo billed yearly`}</div>
            <button className="btn-primary" disabled={!!busy} onClick={() => checkout('annual')}>
              {busy === 'annual' ? 'Redirecting…' : 'Subscribe annually'}
            </button>
          </div>
        </div>
        {error && <div className="subscribe-error">Could not start checkout: {error}</div>}
        <p className="landing-fineprint">
          Payments are handled by Stripe. Cancel anytime from Settings. Automated
          trading carries risk; you can lose funds you commit. Not financial advice.
        </p>
      </div>
    </div>
  );
}
