// Haven public landing page — no auth, no Clerk, purely marketing.
// Renders at haven.trading as a standalone Vite entry point.
import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import './haven-saas.css';
import HavenLogo from './components/HavenLogo.jsx';
import { RISK_SUMMARY_SHORT } from './legal/content.js';

// ── Content ──────────────────────────────────────────────────────────────

const FEATURES = [
  {
    icon: '📊',
    title: 'Strategy Backtesting',
    desc: 'Build and test trading strategies against historical Binance Alpha data. See equity curves, drawdowns, and performance metrics before risking a single satoshi.',
  },
  {
    icon: '🔍',
    title: 'Token Finder',
    desc: 'Write custom ranking code to scan tokens by momentum, volume, or any metric you define. Run forward-returns analysis and sort with hysteresis to reduce noise.',
  },
  {
    icon: '📝',
    title: 'Paper & Live Trading',
    desc: 'Paper-trade strategies risk-free, then switch to live execution when you\'re confident. The same engine runs both modes — no surprises.',
  },
  {
    icon: '🔐',
    title: 'Local Wallet Encryption',
    desc: 'Your private keys are encrypted with your OS credential store (Windows DPAPI, macOS Keychain, Linux keyring). They never touch a cloud server.',
  },
  {
    icon: '🧠',
    title: 'Sandboxed Strategy Runtime',
    desc: 'Custom strategy code runs in an isolated JavaScript sandbox with time, memory, and capability limits. Your machine stays in control.',
  },
  {
    icon: '⚡',
    title: 'Binance Alpha Data',
    desc: 'Free market data from Binance Alpha — no API keys required to get started. Real-time prices, OHLCV candles, and token metadata.',
  },
];

const STEPS = [
  {
    num: '1',
    title: 'Download',
    desc: 'Get the Haven desktop app for Windows, macOS, or Linux. One double-click install — no setup wizard, no terminal required.',
  },
  {
    num: '2',
    title: 'Connect Binance',
    desc: 'Link your Binance account with a read-only API key for market data. Add trading permissions when you\'re ready to go live.',
  },
  {
    num: '3',
    title: 'Trade',
    desc: 'Paper-trade first. When you\'re confident, flip the switch to live. Your keys, your computer, your edge.',
  },
];

const PRICING = [
  {
    name: 'Starter',
    price: 9,
    bots: 1,
    strategies: 5,
    finders: 2,
    live: false,
    featured: false,
  },
  {
    name: 'Pro',
    price: 29,
    bots: 5,
    strategies: 20,
    finders: 10,
    live: true,
    featured: true,
  },
  {
    name: 'Advanced',
    price: 79,
    bots: 20,
    strategies: 100,
    finders: 50,
    live: true,
    featured: false,
  },
];

const FAQ = [
  {
    q: 'Do I need to connect a wallet to use Haven?',
    a: 'No. You can backtest, use the Token Finder, and paper-trade without any wallet or API keys. You only need a Binance account when you are ready to go live.',
  },
  {
    q: 'Where are my private keys stored?',
    a: 'Your keys are encrypted and stored locally on your computer using your operating system\'s built-in credential manager (Windows DPAPI, macOS Keychain, or Linux keyring). They never leave your machine.',
  },
  {
    q: 'What is Binance Alpha?',
    a: 'Binance Alpha is Binance\'s free market data API covering spot and futures markets. It provides real-time prices, OHLCV candles, and token metadata — no API key required for reading data.',
  },
  {
    q: 'Can I write my own strategies?',
    a: 'Yes. Strategies are written in JavaScript and run in a sandboxed runtime on your machine. You can use 14 built-in indicators or write your own logic.',
  },
  {
    q: 'Is this financial advice?',
    a: 'Absolutely not. Haven is software tools for research and strategy execution. Nothing in the app constitutes investment, trading, or financial advice. You are responsible for your own trading decisions and risk.',
  },
];

const DOWNLOAD_URL = 'https://github.com/ruscopeland/haven/releases/latest/download/haven-desktop.exe';

// ── Components ───────────────────────────────────────────────────────────

function Nav() {
  return (
    <nav style={{
      display: 'flex', justifyContent: 'space-between', alignItems: 'center',
      padding: '20px 0', maxWidth: 1100, margin: '0 auto',
    }}>
      <HavenLogo size={32} />
      <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
        <a href="#features" style={navLinkStyle}>Features</a>
        <a href="#how-it-works" style={navLinkStyle}>How it works</a>
        <a href="#pricing" style={navLinkStyle}>Pricing</a>
        <a href="#faq" style={navLinkStyle}>FAQ</a>
        <a href={DOWNLOAD_URL} style={{
          ...navLinkStyle,
          background: 'var(--primary-gradient)',
          color: '#fff',
          padding: '8px 18px',
          borderRadius: 10,
          fontWeight: 600,
        }}>Download</a>
      </div>
    </nav>
  );
}

const navLinkStyle = {
  color: 'var(--text-normal)',
  textDecoration: 'none',
  fontSize: 14,
  fontFamily: 'var(--font-display)',
  fontWeight: 500,
  transition: 'color 0.15s',
};

function Hero() {
  return (
    <section style={{ textAlign: 'center', padding: '60px 20px 48px' }}>
      <h1 style={{
        fontSize: 'clamp(32px, 6vw, 56px)',
        lineHeight: 1.1,
        margin: '0 0 16px',
        background: 'linear-gradient(135deg, #67e8f9 0%, #a78bfa 50%, #7c3aed 100%)',
        WebkitBackgroundClip: 'text',
        WebkitTextFillColor: 'transparent',
      }}>
        Crypto Research &amp;<br />Strategy Workspace
      </h1>
      <p style={{
        fontSize: 'clamp(18px, 2.5vw, 24px)',
        color: 'var(--text-muted)',
        maxWidth: 640,
        margin: '0 auto 24px',
        lineHeight: 1.4,
      }}>
        Your keys. Your computer. Your edge.
      </p>
      <p style={{
        fontSize: 15,
        color: 'var(--text-muted)',
        maxWidth: 560,
        margin: '0 auto 32px',
        lineHeight: 1.6,
      }}>
        Haven is a desktop crypto strategy workspace. Backtest strategies, scan
        tokens with custom finders, and trade — all with your keys encrypted
        locally. No cloud custody. No advice. Just tools.
      </p>
      <div style={{ display: 'flex', gap: 14, justifyContent: 'center', flexWrap: 'wrap' }}>
        <a href={DOWNLOAD_URL} className="btn-primary btn-lg" style={{ textDecoration: 'none', display: 'inline-block' }}>
          Download for Windows
        </a>
        <a href="#pricing" className="btn-secondary" style={{ textDecoration: 'none', display: 'inline-block' }}>
          View plans →
        </a>
      </div>
      <p style={{ marginTop: 18, fontSize: 13, color: 'var(--text-muted)' }}>
        Also available for macOS and Linux · Free to download
      </p>
    </section>
  );
}

function Features() {
  return (
    <section id="features" style={{ padding: '60px 0' }}>
      <h2 style={{ textAlign: 'center', fontSize: 28, marginBottom: 40 }}>
        Everything you need to research and trade
      </h2>
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))',
        gap: 20,
      }}>
        {FEATURES.map(({ icon, title, desc }) => (
          <div key={title} className="glass-panel" style={{ padding: 24, borderRadius: 14 }}>
            <div style={{ fontSize: 32, marginBottom: 12 }}>{icon}</div>
            <h3 style={{ fontSize: 17, margin: '0 0 8px' }}>{title}</h3>
            <p style={{ color: 'var(--text-muted)', fontSize: 14, lineHeight: 1.6, margin: 0 }}>{desc}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

function HowItWorks() {
  return (
    <section id="how-it-works" style={{ padding: '60px 0' }}>
      <h2 style={{ textAlign: 'center', fontSize: 28, marginBottom: 40 }}>
        How it works
      </h2>
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
        gap: 24,
      }}>
        {STEPS.map(({ num, title, desc }) => (
          <div key={num} style={{ textAlign: 'center', padding: 24 }}>
            <div style={{
              width: 48, height: 48, borderRadius: '50%',
              background: 'var(--primary-gradient)',
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 20, fontWeight: 700, color: '#fff', marginBottom: 16,
            }}>
              {num}
            </div>
            <h3 style={{ fontSize: 18, margin: '0 0 8px' }}>{title}</h3>
            <p style={{ color: 'var(--text-muted)', fontSize: 14, lineHeight: 1.6, margin: 0 }}>{desc}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

function Pricing() {
  return (
    <section id="pricing" style={{ padding: '60px 0' }}>
      <h2 style={{ textAlign: 'center', fontSize: 28, marginBottom: 12 }}>
        Simple, transparent pricing
      </h2>
      <p style={{ textAlign: 'center', color: 'var(--text-muted)', fontSize: 15, marginBottom: 40 }}>
        Subscribe to unlock live trading, more strategies, and priority support.
        <br />Manage your subscription through your Haven account.
      </p>
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))',
        gap: 20,
        maxWidth: 900,
        margin: '0 auto',
      }}>
        {PRICING.map(({ name, price, bots, strategies, finders, live, featured }) => (
          <div key={name} className={`glass-panel${featured ? ' pricing-featured' : ''}`} style={{
            padding: 28,
            borderRadius: 14,
            textAlign: 'center',
            position: 'relative',
            ...(featured ? {
              borderColor: 'var(--primary)',
              boxShadow: '0 0 24px var(--primary-glow)',
            } : {}),
          }}>
            {featured && (
              <div style={{
                position: 'absolute', top: -12, left: '50%', transform: 'translateX(-50%)',
                background: 'var(--primary-gradient)', color: '#fff',
                padding: '4px 16px', borderRadius: 20, fontSize: 12, fontWeight: 600,
              }}>
                Most popular
              </div>
            )}
            <h3 style={{ fontSize: 18, margin: '8px 0 4px' }}>{name}</h3>
            <div style={{ fontSize: 36, fontWeight: 700, margin: '12px 0' }}>
              ${price}<span style={{ fontSize: 16, fontWeight: 400, color: 'var(--text-muted)' }}>/mo</span>
            </div>
            <ul style={{ listStyle: 'none', padding: 0, margin: '0 0 20px', textAlign: 'left', fontSize: 14, color: 'var(--text-muted)', lineHeight: 2 }}>
              <li>✓ {strategies} strategies</li>
              <li>✓ {finders} finders</li>
              <li>✓ {bots} trading bots</li>
              <li>{live ? '✓ Live trading' : '✗ Paper trading only'}</li>
              <li>✓ Engine access</li>
              <li>✓ Binance Alpha data</li>
            </ul>
            <a href="https://app.haven.trading/sign-up" className={featured ? 'btn-primary' : 'btn-secondary'} style={{ textDecoration: 'none', display: 'inline-block' }}>
              Get started
            </a>
          </div>
        ))}
      </div>
      <p style={{ textAlign: 'center', color: 'var(--text-muted)', fontSize: 13, marginTop: 24 }}>
        All plans include a 7-day free trial. Cancel anytime.
      </p>
    </section>
  );
}

function Safety() {
  return (
    <section style={{
      padding: '48px 24px',
      margin: '40px 0',
      background: 'rgba(16, 185, 129, 0.05)',
      border: '1px solid rgba(16, 185, 129, 0.15)',
      borderRadius: 14,
      textAlign: 'center',
    }}>
      <div style={{ fontSize: 36, marginBottom: 12 }}>🛡️</div>
      <h2 style={{ fontSize: 22, marginBottom: 16 }}>
        Your security is the whole point
      </h2>
      <p style={{
        color: 'var(--text-normal)',
        maxWidth: 600,
        margin: '0 auto',
        fontSize: 15,
        lineHeight: 1.7,
      }}>
        Wallet keys never leave your computer. Strategy code runs in a sandbox
        with strict limits. Only you control your funds. Haven is a tool you run
        — not a service that holds your assets.
      </p>
      <p style={{
        color: 'var(--warning)',
        marginTop: 20,
        fontSize: 14,
        fontWeight: 500,
      }}>
        {RISK_SUMMARY_SHORT}
      </p>
    </section>
  );
}

function Faq() {
  const [open, setOpen] = useState(null);
  return (
    <section id="faq" style={{ padding: '40px 0' }}>
      <h2 style={{ textAlign: 'center', fontSize: 28, marginBottom: 32 }}>
        Frequently asked questions
      </h2>
      <div style={{ maxWidth: 700, margin: '0 auto' }}>
        {FAQ.map(({ q, a }, i) => (
          <div key={i} className="glass-panel" style={{ marginBottom: 12, borderRadius: 12, overflow: 'hidden' }}>
            <button
              onClick={() => setOpen(open === i ? null : i)}
              style={{
                width: '100%', textAlign: 'left', background: 'none', border: 'none',
                padding: '16px 20px', cursor: 'pointer',
                color: 'var(--text-bright)', fontSize: 15, fontWeight: 600,
                fontFamily: 'var(--font-display)',
                display: 'flex', justifyContent: 'space-between', alignItems: 'center',
              }}
            >
              {q}
              <span style={{ fontSize: 18, transition: 'transform 0.2s', transform: open === i ? 'rotate(45deg)' : 'none' }}>
                +
              </span>
            </button>
            {open === i && (
              <div style={{ padding: '0 20px 16px', color: 'var(--text-muted)', fontSize: 14, lineHeight: 1.6 }}>
                {a}
              </div>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

function Footer() {
  return (
    <footer style={{
      borderTop: '1px solid var(--border-glass)',
      padding: '32px 0',
      marginTop: 40,
      display: 'flex',
      justifyContent: 'space-between',
      flexWrap: 'wrap',
      gap: 16,
      fontSize: 13,
      color: 'var(--text-muted)',
    }}>
      <div>
        <HavenLogo size={20} showWordmark={false} />
        <span style={{ marginLeft: 8 }}>© {new Date().getFullYear()} Haven</span>
      </div>
      <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap' }}>
        <a href="https://app.haven.trading/#/terms" style={{ color: 'var(--text-muted)', textDecoration: 'none' }}>Terms</a>
        <a href="https://app.haven.trading/#/privacy" style={{ color: 'var(--text-muted)', textDecoration: 'none' }}>Privacy</a>
        <a href="https://app.haven.trading/#/risk" style={{ color: 'var(--text-muted)', textDecoration: 'none' }}>Risk Disclosure</a>
        <a href="mailto:support@haven.trading" style={{ color: 'var(--text-muted)', textDecoration: 'none' }}>Contact</a>
      </div>
    </footer>
  );
}

// ── Main ─────────────────────────────────────────────────────────────────

function LandingPage() {
  return (
    <div style={{
      minHeight: '100vh',
      background: 'var(--bg-app)',
      backgroundImage: 'var(--bg-gradient)',
      fontFamily: 'var(--font-body)',
      color: 'var(--text-normal)',
    }}>
      <div style={{ maxWidth: 1100, margin: '0 auto', padding: '0 24px' }}>
        <Nav />
        <Hero />
        <Features />
        <HowItWorks />
        <Pricing />
        <Safety />
        <Faq />
        <Footer />
      </div>
    </div>
  );
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <LandingPage />
  </StrictMode>,
);
