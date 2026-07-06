// Haven public front door — shown to signed-out visitors. Sells the product
// and routes to Clerk's sign-in / sign-up. Pricing is fetched live from the
// API so the founding-member ("N of 500 left") line is always accurate.
import { useEffect, useState } from 'react';
import { SignInButton, SignUpButton } from '@clerk/clerk-react';
import { API_URL } from '../authFetch.js';

const FEATURES = [
  ['Automate your BNB-chain trades', 'Draw price levels and strategies; Haven executes the swaps for you, on-chain, the moment your rules trigger.'],
  ['Your keys never leave your computer', 'Live trading runs from a small app on your machine. We never see or hold your private key — the strongest guarantee in the business.'],
  ['Backtest, then paper-trade free in the cloud', 'Prove a strategy on historical data, then run it live-simulated in our cloud — no risk, no install — before you ever commit real funds.'],
  ['Token Finder + strategy engine', 'Rank every Alpha token every bar with your own scoring code, and let strategies trade the top picks automatically.'],
  ['Run 3 bots side by side', 'Arm up to three strategies at once — paper or live — each with its own performance page: stats, equity curve, and every fill on the chart. Need more bots? Extra slots are coming as an add-on.'],
];

export default function Landing() {
  const [pricing, setPricing] = useState(null);

  useEffect(() => {
    fetch(`${API_URL}/billing/pricing`).then(r => r.json()).then(setPricing).catch(() => {});
  }, []);

  const early = pricing?.early_available;
  const monthly = pricing?.monthly_usd ?? 10;
  const annual = pricing?.annual_usd ?? 60;

  return (
    <div className="landing">
      <header className="landing-nav">
        <div className="landing-brand">⚓ Haven</div>
        <div className="landing-nav-actions">
          <SignInButton mode="modal"><button className="btn-ghost">Sign in</button></SignInButton>
          <SignUpButton mode="modal"><button className="btn-primary">Get started</button></SignUpButton>
        </div>
      </header>

      <section className="landing-hero">
        <h1>Automated crypto trading,<br />with your keys in your hands.</h1>
        <p className="landing-sub">
          Haven turns your chart markers and strategies into real on-chain trades on
          BNB Chain — while your wallet key stays on your own computer, never on our servers.
        </p>
        <div className="landing-cta">
          <SignUpButton mode="modal"><button className="btn-primary btn-lg">Start trading</button></SignUpButton>
          {early && pricing && (
            <span className="landing-early">
              🔥 Founding price — {pricing.seats_left} of {pricing.early_limit} seats left
            </span>
          )}
        </div>
      </section>

      <section className="landing-features">
        {FEATURES.map(([t, d]) => (
          <div className="landing-feature" key={t}>
            <h3>{t}</h3>
            <p>{d}</p>
          </div>
        ))}
      </section>

      <section className="landing-pricing">
        <h2>Simple pricing. No free-to-forever, no surprises.</h2>
        <div className="pricing-cards">
          <div className="pricing-card">
            <div className="pricing-name">Monthly</div>
            <div className="pricing-amount">${monthly}<span>/mo</span></div>
            {early && <div className="pricing-note">Founding price — locked in for life</div>}
            <SignUpButton mode="modal"><button className="btn-primary">Choose monthly</button></SignUpButton>
          </div>
          <div className="pricing-card featured">
            <div className="pricing-badge">Best value</div>
            <div className="pricing-name">Annual</div>
            <div className="pricing-amount">${annual}<span>/yr</span></div>
            <div className="pricing-note">{early ? '$5/mo — founding price' : `$${(annual / 12).toFixed(0)}/mo`}</div>
            <SignUpButton mode="modal"><button className="btn-primary">Choose annual</button></SignUpButton>
          </div>
        </div>
        <p className="landing-fineprint">
          Every plan includes 3 bots running at once (extra slots coming as an add-on) and
          unlimited saved strategies. Live trading requires a free desktop engine you
          download after signing up. Automated trading carries risk; you can lose funds
          you commit. Not financial advice.
        </p>
      </section>
    </div>
  );
}
