// Haven public front door — signed-out visitors.
// Positioning: software + shared data, not advice. Keys stay with the user.
import { useEffect, useState } from 'react';
import { SignInButton, SignUpButton } from '@clerk/clerk-react';
import { API_URL } from '../authFetch.js';
import MarketTicker from './MarketTicker.jsx';
import LandingMovers from './LandingMovers.jsx';
import { GoPlusBadge } from './GoPlusSecurity.jsx';
import HavenLogo from './HavenLogo.jsx';
import LegalFooter from './LegalFooter.jsx';
import LegalDocView from './LegalDoc.jsx';
import { ManifestoBlock } from './LegalDoc.jsx';
import { RISK_SUMMARY_SHORT } from '../legal/content.js';

const FEATURES = [
  [
    'Software for strategies — not advice',
    'Build rules, backtest, paper-trade, and automate if you choose. You pick tokens and parameters. Haven does not tell you what will make money.',
  ],
  [
    'Your keys stay on your computer',
    'Live execution uses a small desktop engine on your machine. We do not need custody of your private key for that model.',
  ],
  [
    'Shared data, shared cost',
    'Subscription helps fund market data, hosting, development, and updates — so members are not each buying the same expensive feeds alone.',
  ],
  [
    'Charts, Finder, bots side by side',
    'Research liquid names, rank with your own code, run paper or live bots within plan limits — still your decisions.',
  ],
  [
    'Risk tools, not green lights',
    'Security flags (e.g. GoPlus) and warnings help you inspect contracts. They can be wrong or incomplete. You remain responsible.',
  ],
];

const STEPS = [
  ['Join free paper trial', 'No card for paper. Learn the tools with simulated bots.'],
  ['Build your own process', 'Templates or your code. Backtest on history you can access in-product.'],
  ['Keys on your desk for live', 'Subscribe when you want live path. Engine + your key on your PC.'],
];

export default function Landing() {
  const [pricing, setPricing] = useState(null);
  const [legalView, setLegalView] = useState(null); // terms | privacy | risk | docs

  useEffect(() => {
    fetch(`${API_URL}/billing/pricing`).then(r => r.json()).then(setPricing).catch(() => {});
  }, []);

  useEffect(() => {
    const fromHash = () => {
      const h = (window.location.hash || '').replace(/^#\/?/, '');
      if (['terms', 'privacy', 'risk', 'docs'].includes(h)) setLegalView(h);
    };
    fromHash();
    window.addEventListener('hashchange', fromHash);
    return () => window.removeEventListener('hashchange', fromHash);
  }, []);

  const openLegal = (key) => {
    setLegalView(key);
    window.location.hash = `/${key}`;
    window.scrollTo(0, 0);
  };
  const closeLegal = () => {
    setLegalView(null);
    window.history.replaceState({}, '', window.location.pathname + window.location.search);
  };

  if (legalView) {
    return (
      <div className="landing-page">
        <MarketTicker />
        <LegalDocView docKey={legalView} onBack={closeLegal} />
        <LegalFooter onOpen={openLegal} />
      </div>
    );
  }

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
            <button type="button" className="btn-ghost" onClick={() => openLegal('docs')}>Docs</button>
            <SignInButton mode="modal"><button className="btn-ghost">Sign in</button></SignInButton>
            <SignUpButton mode="modal"><button className="btn-primary">Get started free</button></SignUpButton>
          </div>
        </header>

        <section className="landing-hero">
          <h1>Software for your strategies.<br />Keys in your hands.</h1>
          <p className="landing-sub">
            Haven is tools and shared market data — not investment advice.
            You choose tokens, you write or pick rules, you run the desktop engine if you go live.
            We do not promise profits. You are responsible for your own results.
          </p>
          <p className="landing-risk-line">{RISK_SUMMARY_SHORT}</p>
          <div className="landing-cta">
            <SignUpButton mode="modal">
              <button className="btn-primary btn-lg">Start free paper trial</button>
            </SignUpButton>
            <span className="landing-early" style={{ color: 'var(--warning, #f59e0b)' }}>
              {trialDays}-day paper trial · no card · live path when you subscribe
            </span>
            {early && pricing && (
              <span className="landing-early">
                Founding price — {pricing.seats_left} of {pricing.early_limit} seats left
              </span>
            )}
          </div>
        </section>

        <section className="landing-manifesto-wrap glass-panel">
          <ManifestoBlock />
        </section>

        <LandingMovers />

        <section className="landing-steps">
          <h2>How members use it</h2>
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
          <h2>Subscription funds the toolbox — not “advice.”</h2>
          <p className="landing-pricing-lead">
            Fees help cover shared data, development, and updates. You could pay far more alone for
            comparable data capacity; members share the stack. Paper trial first; live execution is optional.
          </p>
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
            By signing up you agree to our{' '}
            <button type="button" className="legal-inline-link" onClick={() => openLegal('terms')}>Terms</button>,{' '}
            <button type="button" className="legal-inline-link" onClick={() => openLegal('privacy')}>Privacy</button>, and{' '}
            <button type="button" className="legal-inline-link" onClick={() => openLegal('risk')}>Risk disclosure</button>.
            Live trading requires a paid plan and a desktop engine you control. You can lose funds you commit.
            Not financial advice. Operators may also be members using the same software.
          </p>
          <div style={{ marginTop: 28, display: 'flex', justifyContent: 'center' }}>
            <GoPlusBadge />
          </div>
          <p className="landing-fineprint" style={{ marginTop: 8 }}>
            Token risk checks powered by GoPlus Security where available. Incomplete by nature.
          </p>
        </section>

        <LegalFooter onOpen={openLegal} />
      </div>
    </div>
  );
}
