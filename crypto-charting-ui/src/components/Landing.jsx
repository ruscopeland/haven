// Haven public front door — shown to signed-out visitors. Sells the product
// and routes to Clerk's sign-in / sign-up. Pricing is fetched live from the
// API so the founding-member ("N of 500 left") line is always accurate.
// Market ticker + mid-cap movers use real /public/* data only.
import { useEffect, useState } from 'react';
import { SignInButton, SignUpButton } from '@clerk/clerk-react';
import { API_URL } from '../authFetch.js';
import MarketTicker from './MarketTicker.jsx';
import LandingMovers from './LandingMovers.jsx';
import { GoPlusBadge } from './GoPlusSecurity.jsx';
import HavenLogo from './HavenLogo.jsx';

const FEATURES = [
  ['Automate your BNB-chain trades', 'Draw price levels and strategies; Haven executes the swaps for you, on-chain, the moment your rules trigger.'],
  ['Your keys never leave your computer', 'Live trading runs from a small app on your machine. We never see or hold your private key — the strongest guarantee in the business.'],
  ['Backtest, then paper-trade free in the cloud', 'Prove a strategy on historical data, then run it live-simulated in our cloud — free paper trial, no risk, no install — before you ever commit real funds.'],
  ['Token Finder + strategy engine', 'Rank every Alpha token every bar with your own scoring code, and let strategies trade the top picks automatically.'],
  ['Run bots side by side', 'Arm strategies paper or live — each with its own performance page: stats, equity curve, and every fill on the chart. Paid plans include 3 concurrent bots.'],
];

const STEPS = [
  ['Sign up free', 'Start a paper trial — no card required for paper bots.'],
  ['Build or pick a strategy', 'Use templates or write rules; backtest on real history.'],
  ['Paper, then go live', 'When ready, subscribe and run the desktop engine with your own keys.'],
];

export default function Landing() {
  const [pricing, setPricing] = useState(null);

  useEffect(() => {
    fetch(`${API_URL}/billing/pricing`).then(r => r.json()).then(setPricing).catch(() => {});
  }, []);

  const early = pricing?.early_available;
  const monthly = pricing?.monthly_usd ?? 10;
  const annual = pricing?.annual_usd ?? 60;
  const trialDays = pricing?.paper_trial_days ?? 14;

  return (
    <div className="landing-page">
      <MarketTicker />

      <div className="landing">
        <header className="landing-nav">
          <div className="landing-brand"><HavenLogo size={32} /></div>
          <div className="landing-nav-actions">
            <SignInButton mode="modal"><button className="btn-ghost">Sign in</button></SignInButton>
            <SignUpButton mode="modal"><button className="btn-primary">Get started free</button></SignUpButton>
          </div>
        </header>

        <section className="landing-hero">
          <h1>Automated crypto trading,<br />with your keys in your hands.</h1>
          <p className="landing-sub">
            Haven turns your chart markers and strategies into real on-chain trades on
            BNB Chain — while your wallet key stays on your own computer, never on our servers.
          </p>
          <div className="landing-cta">
            <SignUpButton mode="modal">
              <button className="btn-primary btn-lg">Start free paper trial</button>
            </SignUpButton>
            <span className="landing-early" style={{ color: 'var(--warning, #f59e0b)' }}>
              {trialDays}-day paper trial · no card · live trading when you subscribe
            </span>
            {early && pricing && (
              <span className="landing-early">
                🔥 Founding price — {pricing.seats_left} of {pricing.early_limit} seats left
              </span>
            )}
          </div>
        </section>

        <LandingMovers />

        <section className="landing-steps">
          <h2>How it works</h2>
          <div className="landing-steps-grid">
            {STEPS.map(([t, d], i) => (
              <div className="landing-step" key={t}>
                <div className="landing-step-num">{i + 1}</div>
                <h3>{t}</h3>
                <p>{d}</p>
              </div>
            ))}
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
          <h2>Simple pricing. Free paper trial, then subscribe for live.</h2>
          <div className="pricing-cards">
            <div className="pricing-card">
              <div className="pricing-name">Paper trial</div>
              <div className="pricing-amount">$0<span>/{trialDays}d</span></div>
              <div className="pricing-note">Cloud paper bots · no live trading</div>
              <SignUpButton mode="modal"><button className="btn-secondary">Start free</button></SignUpButton>
            </div>
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
            Paper trial includes limited concurrent paper bots and full charts, strategies, and
            Token Finder. Live trading requires a paid plan and a free desktop engine you
            download after signing up. Automated trading carries risk; you can lose funds
            you commit. Not financial advice.
          </p>
          <div style={{ marginTop: 28, display: 'flex', justifyContent: 'center' }}>
            <GoPlusBadge />
          </div>
          <p className="landing-fineprint" style={{ marginTop: 8 }}>
            Token risk checks powered by GoPlus Security. Only liquid tokens are scanned under a daily budget.
          </p>
        </section>
      </div>
    </div>
  );
}
