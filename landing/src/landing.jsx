// Haven public landing page — splash animation → single-screen dashboard.
import { StrictMode, useState, useCallback } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import './haven-saas.css';
import { RISK_SUMMARY_SHORT } from './legal/content.js';
import heroVideo from './hero.mp4';

const splashCSS = `
  @keyframes haven-shrink { 0%{transform:scale(1);opacity:1} 100%{transform:scale(0);opacity:0} }
  @keyframes haven-grow { 0%{transform:scale(0);opacity:0} 100%{transform:scale(1);opacity:1} }
`;

const DOWNLOAD_URL = 'https://github.com/ruscopeland/haven/releases/download/v1.2.0-desktop/haven-desktop.exe';
const LINUX_URL = 'https://github.com/ruscopeland/haven/releases/download/v1.2.0-desktop/haven-desktop-v1.2.0-linux.tar.gz';
const LINUX_CMD = 'tar -xzf haven-desktop-v1.2.0-linux.tar.gz && chmod +x haven-desktop-v1.2.0-linux && ./haven-desktop-v1.2.0-linux';

// ── SVG logo reuse ────────────────────────────────────────────────────────

function Logo({ size }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" fill="none" aria-hidden>
      <defs>
        <linearGradient id="lg" x1="8" y1="8" x2="56" y2="56" gradientUnits="userSpaceOnUse">
          <stop stopColor="#67e8f9" /><stop offset="0.45" stopColor="#a78bfa" /><stop offset="1" stopColor="#7c3aed" />
        </linearGradient>
      </defs>
      <path stroke="url(#lg)" strokeWidth="2.5" fill="rgba(13,20,38,0.85)" d="M32 4L56 18v28L32 60 8 46V18z"/>
      <path fill="url(#lg)" d="M22 20h5.2v9.2h9.6V20H42v24h-5.2v-9.8h-9.6V44H22V20z"/>
      <circle cx="32" cy="32" r="2.2" fill="#67e8f9"/>
    </svg>
  );
}

// ── Splash ────────────────────────────────────────────────────────────────

function SplashScreen({ onTrigger }) {
  const [phase, setPhase] = useState('idle');
  const trigger = useCallback(() => {
    if (phase !== 'idle') return;
    setPhase('shrinking');
    setTimeout(() => { setPhase('gone'); onTrigger(); }, 500);
  }, [phase, onTrigger]);
  if (phase === 'gone') return null;
  return (
    <div onClick={trigger} style={{ position:'fixed',inset:0,zIndex:9999,display:'flex',alignItems:'center',justifyContent:'center',background:'#0d1117', cursor:'pointer' }}>
      <video autoPlay loop muted playsInline
        style={{
          width: 'min(55vw,55vh)',
          height: 'min(55vw,55vh)',
          objectFit: 'contain',
          animation: phase==='shrinking'?'haven-shrink .25s ease-in forwards':'none',
          transformOrigin:'center center',
        }}>
        <source src={heroVideo} type="video/mp4" />
      </video>
    </div>
  );
}

// ── Compact card ──────────────────────────────────────────────────────────

const card = { background:'rgba(255,255,255,0.03)', border:'1px solid rgba(255,255,255,0.06)', borderRadius:10, padding:'10px 12px' };

function CCard({ icon, title, desc }) {
  return <div style={card}><b style={{fontSize:13}}>{icon} {title}</b><br/><span style={{fontSize:11,color:'var(--text-muted)',lineHeight:1.5}}>{desc}</span></div>;
}

// ── Main dashboard ────────────────────────────────────────────────────────

function Dashboard() {
  return (
    <div style={{ height:'100vh', display:'flex', flexDirection:'column', padding:'0 16px', overflow:'hidden' }}>

      {/* NAV */}
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', padding:'8px 0', flexShrink:0 }}>
        <Logo size={24} />
        <div style={{ display:'flex', gap:8 }}>
          <a href={DOWNLOAD_URL} style={{ background:'var(--primary-gradient)', color:'#fff', padding:'6px 14px', borderRadius:8, fontWeight:600, fontSize:13, textDecoration:'none' }}>Windows</a>
          <a href={LINUX_URL} style={{ background:'var(--primary-gradient)', color:'#fff', padding:'6px 14px', borderRadius:8, fontWeight:600, fontSize:13, textDecoration:'none' }}>Linux</a>
        </div>
      </div>

      {/* HERO */}
      <div style={{ textAlign:'center', padding:'12px 0 8px', flexShrink:0 }}>
        <h1 style={{ fontSize:'clamp(22px,4vw,38px)', lineHeight:1.15, margin:'0 0 6px', background:'linear-gradient(135deg,#67e8f9 0%,#a78bfa 50%,#7c3aed 100%)', WebkitBackgroundClip:'text', WebkitTextFillColor:'transparent' }}>
          Crypto Research &amp; Strategy Workspace
        </h1>
        <p style={{ fontSize:14, color:'var(--text-muted)', margin:'0 auto', maxWidth:500, lineHeight:1.4 }}>
          Desktop Software. Backtest, scan, and trade — everything runs on your machine. Free Binance Alpha data, no accounts needed.
        </p>
      </div>

      {/* THREE-COLUMN BODY */}
      <div style={{ flex:1, display:'grid', gridTemplateColumns:'1fr 1fr 1fr', gap:10, minHeight:0 }}>

        {/* LEFT: Features */}
        <div style={{ display:'flex', flexDirection:'column', gap:6, overflow:'hidden' }}>
          <div style={{ fontSize:11, color:'var(--text-muted)', textTransform:'uppercase', letterSpacing:1, padding:'0 2px' }}>Features</div>
          <CCard icon={'\u{1F4CA}'} title="Strategy Backtesting" desc="Build and test strategies against Binance Alpha data. Equity curves, drawdowns, metrics." />
          <CCard icon={'\u{1F50D}'} title="Token Finder" desc="Custom ranking code. Scan by momentum, volume, any metric. Hysteresis reduces noise." />
          <CCard icon={'\u{1F4DD}'} title="Paper &amp; Live Trading" desc="Paper-trade risk-free. Same engine for both modes. Flip to live when ready." />
          <CCard icon={'\u26A1'} title="Binance Alpha Data" desc="Free market data. No API keys required. Real-time prices, candles, metadata." />
          <CCard icon={'\u{1F9E0}'} title="Sandboxed Runtime" desc="Custom JS runs isolated. Time, memory, and capability limits." />
        </div>

        {/* CENTER: How it works + CTA */}
        <div style={{ display:'flex', flexDirection:'column', gap:8, alignItems:'center', justifyContent:'center' }}>
          <div style={{ textAlign:'center' }}>
            <p style={{ fontSize:13, color:'var(--text-muted)', margin:'0 0 12px' }}>
              <b>1.</b> Download &nbsp; <b>2.</b> Explore with free data &nbsp; <b>3.</b> Trade when ready
            </p>

            <a href={DOWNLOAD_URL} className="btn-primary" style={{ textDecoration:'none', display:'inline-block', fontSize:14, padding:'8px 24px' }}>Download for Windows</a>
            <div style={{ marginTop:8, background:'rgba(255,255,255,0.03)', border:'1px solid rgba(255,255,255,0.08)', borderRadius:8, padding:'10px 12px', fontSize:11, color:'var(--text-muted)', maxWidth:520, margin:'8px auto 0', textAlign:'left', lineHeight:1.7 }}>
              <div style={{ color:'var(--text-bright)', marginBottom:4, fontWeight:600, fontSize:12 }}>Windows: download the .exe, double-click to run.</div>
              <div>If Windows SmartScreen shows a warning, click <b>More info</b> → <b>Run anyway</b>. This happens because the app is new and hasn't built up download reputation yet.</div>
            </div>

            <div style={{ margin:'20px 0', borderTop:'1px solid rgba(255,255,255,0.06)' }} />

            <a href={LINUX_URL} className="btn-primary" style={{ textDecoration:'none', display:'inline-block', fontSize:14, padding:'8px 24px' }}>Download for Linux</a>
            <div style={{ marginTop:8, background:'rgba(255,255,255,0.03)', border:'1px solid rgba(255,255,255,0.08)', borderRadius:8, padding:'10px 12px', fontSize:11, color:'var(--text-muted)', maxWidth:520, margin:'8px auto 0', textAlign:'left', lineHeight:1.7 }}>
              <div style={{ color:'var(--text-bright)', marginBottom:4, fontWeight:600, fontSize:12 }}>After downloading, open a terminal:</div>
              <div><b>1.</b> Go to your Downloads: <code style={{ background:'rgba(0,0,0,0.3)', padding:'1px 5px', borderRadius:3 }}>cd ~/Downloads</code></div>
              <div style={{ marginTop:4 }}><b>2.</b> Extract and run:</div>
              <code style={{ display:'block', background:'rgba(0,0,0,0.4)', padding:'5px 8px', borderRadius:4, fontSize:11, marginTop:3, wordBreak:'break-all', color:'#c9d1d9' }}>{LINUX_CMD}</code>
              <div style={{ marginTop:6 }}>
                <b>3.</b> Install so you can just type <code style={{ background:'rgba(0,0,0,0.3)', padding:'1px 5px', borderRadius:3 }}>haven</code> from anywhere:
                <code style={{ display:'block', background:'rgba(0,0,0,0.4)', padding:'5px 8px', borderRadius:4, fontSize:11, marginTop:3, color:'#c9d1d9' }}>sudo mv haven-desktop-v1.2.0-linux /usr/local/bin/haven</code>
              </div>
            </div>
          </div>
          <div style={{ ...card, textAlign:'center', fontSize:11, color:'var(--text-muted)', maxWidth:240 }}>
            <p style={{ margin:'0 0 4px', color:'var(--text-bright)', fontSize:12 }}>{'\u{1F6E1}'} Built to run locally</p>
            Haven is a desktop app — not a web service. Nothing leaves your computer without permission.
          </div>
        </div>

        {/* RIGHT: Pricing */}
        <div style={{ display:'flex', flexDirection:'column', gap:6 }}>
          <div style={{ fontSize:11, color:'var(--text-muted)', textTransform:'uppercase', letterSpacing:1, padding:'0 2px' }}>Pricing</div>
          {[
            { name:'Starter', price:9, strategies:5, finders:2, bots:1, live:true },
            { name:'Pro', price:29, strategies:20, finders:10, bots:5, live:true, featured:true },
            { name:'Advanced', price:79, strategies:100, finders:50, bots:20, live:true },
          ].map(p => (
            <div key={p.name} style={{ ...card, position:'relative', borderColor:p.featured?'var(--primary)':undefined, boxShadow:p.featured?'0 0 12px var(--primary-glow)':undefined }}>
              {p.featured && <div style={{ position:'absolute',top:-8,left:'50%',transform:'translateX(-50%)',background:'var(--primary-gradient)',color:'#fff',padding:'1px 12px',borderRadius:10,fontSize:10,fontWeight:600 }}>Popular</div>}
              <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center' }}>
                <b style={{ fontSize:13 }}>{p.name}</b>
                <span style={{ fontSize:18, fontWeight:700 }}>${p.price}<span style={{ fontSize:10, fontWeight:400, color:'var(--text-muted)' }}>/mo</span></span>
              </div>
              <div style={{ fontSize:10, color:'var(--text-muted)', marginTop:3 }}>
                {p.strategies} strategies · {p.finders} finders · {p.bots} bots · {p.live?'Live':'Paper'} trading
              </div>
            </div>
          ))}
          <p style={{ fontSize:10, color:'var(--text-muted)', textAlign:'center', margin:0 }}>7-day free trial · Cancel anytime</p>
        </div>
      </div>

      {/* FOOTER */}
      <div style={{ borderTop:'1px solid rgba(255,255,255,0.06)', padding:'6px 0', display:'flex', justifyContent:'space-between', alignItems:'center', fontSize:10, color:'var(--text-muted)', flexShrink:0 }}>
        <span>{'\u00A9'} {new Date().getFullYear()} Haven</span>
        <span style={{ display:'flex', gap:12 }}>
          <a href="https://app.haven.trading/#/terms" style={{ color:'var(--text-muted)', textDecoration:'none' }}>Terms</a>
          <a href="https://app.haven.trading/#/privacy" style={{ color:'var(--text-muted)', textDecoration:'none' }}>Privacy</a>
          <a href="https://app.haven.trading/#/risk" style={{ color:'var(--text-muted)', textDecoration:'none' }}>Risk</a>
          <a href="mailto:support@haven.trading" style={{ color:'var(--text-muted)', textDecoration:'none' }}>Contact</a>
        </span>
      </div>
    </div>
  );
}

// ── Root ──────────────────────────────────────────────────────────────────

function LandingPage() {
  const [showMain, setShowMain] = useState(false);
  return (
    <>
      <style>{splashCSS}</style>
      <div style={{ height:'100vh', background:'var(--bg-app)', backgroundImage:'var(--bg-gradient)', fontFamily:'var(--font-body)', color:'var(--text-normal)', overflow:'hidden' }}>
        <SplashScreen onTrigger={() => setShowMain(true)} />
        {showMain && <div style={{ animation:'haven-grow .5s ease-out forwards', height:'100%' }}><Dashboard /></div>}
      </div>
    </>
  );
}

createRoot(document.getElementById('root')).render(<StrictMode><LandingPage /></StrictMode>);
