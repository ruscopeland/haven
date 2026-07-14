// Haven public front door — signed-out visitors.
// Positioning: software + shared data, not advice. Keys stay with the user.
import { useEffect, useState } from 'react';
import { SignInButton, SignUpButton } from '@clerk/clerk-react';
import { API_URL } from '../authFetch.js';
import MarketTicker from './MarketTicker.jsx';
import LandingMovers from './LandingMovers.jsx';
import { CmcBadge } from './CmcSecurity.jsx';
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
    'CoinMarketCap contract-security flags help you inspect tokens. They can be wrong or incomplete. You remain responsible.',
  ],
];

const STEPS = [
  ['Start a seven-day trial', 'Choose a plan and add a card. You are not billed until the seven-day trial ends, and you can cancel beforehand.'],
  ['Build your own process', 'Templates or your code. Backtest on history you can access in-product.'],
  ['Keys on your desk for live', 'The desktop engine and your encrypted key stay on your PC in trial or paid mode.'],
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

  const trialDays = pricing?.trial_days ?? 7;
  const plans = pricing?.plans || [];

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
              <button className="btn-primary btn-lg">Start seven-day trial</button>
            </SignUpButton>
            <span className="landing-early" style={{ color: 'var(--warning, #f59e0b)' }}>
              {trialDays}-day paper + live trial · card required · no charge until the trial ends
            </span>
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
            comparable data capacity; members share the stack. The trial includes the useful paper and live workflow.
          </p>
          <div className="pricing-cards">
            <div className="pricing-card">
              <div className="pricing-name">Seven-day trial</div>
              <div className="pricing-amount">$0<span>/{trialDays}d</span></div>
              <div className="pricing-note">Card required · no charge for 7 days · 1 bot · 3 strategies · 1 finder · paper + live</div>
              <SignUpButton mode="modal"><button className="btn-secondary">Start free</button></SignUpButton>
            </div>
            {plans.map((plan, index) => (
              <div className={`pricing-card${index === 1 ? ' featured' : ''}`} key={plan.key}>
                {index === 1 && <div className="pricing-badge">Most popular</div>}
                <div className="pricing-name">{plan.key[0].toUpperCase() + plan.key.slice(1)}</div>
                <div className="pricing-amount">${plan.monthly_price}<span>/mo</span></div>
                <div className="pricing-note">
                  ${plan.annual_price}/year · {plan.bots} bots · {plan.strategies} strategies · {plan.finders} finders · {plan.ai_daily} AI/day
                </div>
                <SignUpButton mode="modal"><button className="btn-primary">Choose {plan.key}</button></SignUpButton>
              </div>
            ))}
          </div>
          <p className="landing-fineprint">
            By signing up you agree to our{' '}
            <button type="button" className="legal-inline-link" onClick={() => openLegal('terms')}>Terms</button>,{' '}
            <button type="button" className="legal-inline-link" onClick={() => openLegal('privacy')}>Privacy</button>, and{' '}
            <button type="button" className="legal-inline-link" onClick={() => openLegal('risk')}>Risk disclosure</button>.
            Live trading requires the desktop engine you control and is available during trial and paid access. You can lose funds you commit.
            Not financial advice. Operators may also be members using the same software.
          </p>
          <div style={{ marginTop: 28, display: 'flex', justifyContent: 'center' }}>
            <CmcBadge />
          </div>
          <p className="landing-fineprint" style={{ marginTop: 8 }}>
            Token risk checks use licensed CoinMarketCap security data where available. Incomplete by nature.
          </p>
        </section>

        <LegalFooter onOpen={openLegal} />
      </div>
    </div>
  );
}
