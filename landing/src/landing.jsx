// Haven public landing page — MP4 splash → typewriter → landing.
import { StrictMode, useState, useCallback, useEffect, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import './haven-saas.css';
import heroVideo from './hero.mp4';

const DOWNLOAD_URL = 'https://github.com/ruscopeland/haven/releases/download/v1.3.0-desktop/haven-desktop.exe';
const LINUX_URL = 'https://github.com/ruscopeland/haven/releases/download/v1.3.0-desktop/haven-desktop-v1.3.0-linux.tar.gz';
const LINUX_CMD = 'tar -xzf haven-desktop-v1.3.0-linux.tar.gz && chmod +x haven-desktop-v1.3.0-linux && ./haven-desktop-v1.3.0-linux';

// ── Animations ──────────────────────────────────────────────────────────

const animCSS = `
  @keyframes haven-shrink { 0%{transform:scale(1);opacity:1} 100%{transform:scale(0);opacity:0} }
  @keyframes haven-grow { 0%{transform:scale(0);opacity:0} 100%{transform:scale(1);opacity:1} }
  @keyframes blink { 0%,50%{opacity:1} 51%,100%{opacity:0} }
  @keyframes fadeIn { from{opacity:0} to{opacity:1} }
  @keyframes logoGlow { 0%,100%{filter:drop-shadow(0 0 30px rgba(124,58,237,0.3))} 50%{filter:drop-shadow(0 0 60px rgba(124,58,237,0.6))} }
  @keyframes lightsPulse { 0%,100%{opacity:0.15} 50%{opacity:0.35} }
  @keyframes zoomIn { from{transform:scale(1);opacity:0.3} to{transform:scale(50);opacity:0} }
  @keyframes blockFly { from{opacity:0;transform:translateY(40px)} to{opacity:1;transform:translateY(0)} }
`;

// ── Typewriter monologue text ──────────────────────────────────────────

const MONOLOGUE = [
  '', // initial pause
  'You know what I don\'t care too much for? Doing things their way.',
  'Do this, Do that, Take Profit, This Indicator, That indicator, Strategy, Strategy, Blahhhh......',
  '', // pause 1s
  'How many backtested Strategies you ran, awesome results, then WTF?',
  '', // pause 1s
  'A strategy............. buy low, sell high, simple.',
  'But what about the token?',
  '', // pause 1s
  'A strategy is only good if you pick the right token.',
  'Pick the right one, you win.',
  '', // pause 2s
  'Pick the wrong one, and you\'re punching your monitor.',
  '', // pause 2s
  'Finding the right token is hard, automating it is harder.',
  'Let\'s change that ..........',
  '', // pause
  'Welcome to Haven',
  '', // pause 2s then transition
];

const PAUSE_MAP = {
  0: 800,   // initial
  3: 1000,  // after Blahhhh
  5: 1000,  // after WTF
  8: 1000,  // after token
  10: 2000, // after you win
  12: 2000, // after monitor
  16: 1500, // after change that
  18: 2000, // after Welcome - transition
};

const TYPING_SPEED = 35; // ms per character
const FAST_SPEED = 8;   // for "Blahhhh" etc

// ── Typewriter ─────────────────────────────────────────────────────────

function Typewriter({ onDone }) {
  const [currentLine, setCurrentLine] = useState(0);
  const [displayedChars, setDisplayedChars] = useState(0);
  const line = MONOLOGUE[currentLine];

  useEffect(() => {
    if (currentLine >= MONOLOGUE.length) {
      setTimeout(onDone, 2000);
      return;
    }
    if (!line) {
      // pause line
      const delay = PAUSE_MAP[currentLine] || 500;
      const t = setTimeout(() => setCurrentLine(c => c + 1), delay);
      return () => clearTimeout(t);
    }
    if (displayedChars < line.length) {
      const speed = line.includes('Blahhhh') ? FAST_SPEED : TYPING_SPEED;
      const t = setTimeout(() => setDisplayedChars(c => c + 1), speed);
      return () => clearTimeout(t);
    }
    // line complete — pause then next
    const delay = PAUSE_MAP[currentLine] || (currentLine >= MONOLOGUE.length - 3 ? 1500 : 600);
    const t = setTimeout(() => { setCurrentLine(c => c + 1); setDisplayedChars(0); }, delay);
    return () => clearTimeout(t);
  }, [currentLine, displayedChars, onDone, line]);

  const isLastLine = currentLine >= MONOLOGUE.length - 2;

  return (
    <div style={{ position:'fixed',inset:0,zIndex:9998,background:'#0d1117',display:'flex',alignItems:'center',justifyContent:'center',flexDirection:'column' }}>
      <div style={{ maxWidth:700, padding:'0 24px', fontFamily:'var(--font-mono, monospace)', fontSize:18, color:'#c084fc', lineHeight:1.8 }}>
        {MONOLOGUE.slice(0, currentLine).map((l, i) => (
          l ? <div key={i} style={{ opacity: i === currentLine - 1 && currentLine < MONOLOGUE.length - 1 ? 1 : 0.5, marginBottom:4 }}>{l}</div> : <div key={i} style={{ height: 20 }} />
        ))}
        {line && (
          <div style={{ display:'inline' }}>
            <span>{line.slice(0, displayedChars)}</span>
            <span style={{ display:'inline-block',width:2,height:20,background:'#c084fc',marginLeft:2,animation:'blink 0.8s step-end infinite',verticalAlign:'text-bottom' }} />
          </div>
        )}
      </div>
      {isLastLine && <div style={{ color:'#8b5cf6',fontSize:14,marginTop:24,animation:'fadeIn 1s' }}>Loading Haven...</div>}
    </div>
  );
}

// ── MP4 Splash ────────────────────────────────────────────────────────

function SplashScreen({ onDone }) {
  const [phase, setPhase] = useState('playing');
  const handleEnded = useCallback(() => {
    setPhase('shrinking');
    setTimeout(() => setPhase('typewriter'), 500);
  }, []);
  const handleClick = useCallback(() => {
    setPhase('typewriter');
  }, []);

  if (phase === 'typewriter') return <Typewriter onDone={onDone} />;
  return (
    <div onClick={handleClick} style={{ position:'fixed',inset:0,zIndex:9999,background:'#0d1117',cursor:'pointer' }}>
      <video autoPlay muted playsInline onEnded={handleEnded}
        style={{ width:'100vw',height:'100vh',objectFit:'cover',
          animation: phase==='shrinking'?'haven-shrink .25s ease-in forwards':'none',
          transformOrigin:'center center' }}>
        <source src={heroVideo} type="video/mp4" />
      </video>
    </div>
  );
}

// ── Logo ───────────────────────────────────────────────────────────────

function HavenLogo({ size, glow }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" fill="none"
      style={{ animation: glow ? 'logoGlow 3s ease-in-out infinite' : 'none' }}>
      <defs>
        <linearGradient id="lg" x1="8" y1="8" x2="56" y2="56" gradientUnits="userSpaceOnUse">
          <stop stopColor="#67e8f9" /><stop offset="0.45" stopColor="#a78bfa" /><stop offset="1" stopColor="#7c3aed" />
        </linearGradient>
        <radialGradient id="lgg" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="rgba(124,58,237,0.2)" /><stop offset="100%" stopColor="transparent" />
        </radialGradient>
      </defs>
      <circle cx="32" cy="32" r="48" fill="url(#lgg)" style={{animation:'lightsPulse 4s ease-in-out infinite'}} />
      <path stroke="url(#lg)" strokeWidth="2.5" fill="rgba(13,20,38,0.85)" d="M32 4L56 18v28L32 60 8 46V18z"/>
      <path fill="url(#lg)" d="M22 20h5.2v9.2h9.6V20H42v24h-5.2v-9.8h-9.6V44H22V20z"/>
      <circle cx="32" cy="32" r="2.2" fill="#67e8f9"/>
    </svg>
  );
}

// ── Feature definitions ────────────────────────────────────────────────

const FEATURES = [
  {
    icon: '🔍', title: 'Token Finder',
    short: 'Tell it your idea, it makes it happen.',
    detail: `Our token finder interface lets you describe what you want in plain English. An LLM helps you create a custom token finder — tell it what you're looking for, and it codes it up. Then it shows you what would have happened at different points in the previous week. It's backtesting for tokens, but better.

After you describe what you want, it puts the code up and displays a chart of the tokens your finder selects, ranks them, and shows the results. Select any point on the chart — a moment in the past days, weeks, or months — and see what the tokens would have done 8 bars past that point. Don't like 8 bars? Use 20 or 2, you choose.

Change your finder settings and the chart updates instantly. No waiting for a backtest to load. Want different settings? Tell it what you want — it will do its best.`

  },
  {
    icon: '📈', title: 'Strategy Builder',
    short: 'LLM-powered strategies with instant backtesting.',
    detail: `The strategy page works like the token finder. Select a finder you saved from the dropdown, then tell the LLM what kind of strategy you want to create. Anything you can think of, it will do its best to build. Just don't babble nonsense — junk in, junk out. But you also don't need to be an expert. Explain it the best you can and it will work with you.

The best part: change your indicator settings on the fly and see results instantly. Adjust the RSI, and the chart and results update immediately. Tweak something, see the results. No waiting for backtests to run over and over.

You can tell it to open trades from your token finder in rank order, or pick the 3rd ranked token on your next available slot — whatever fits your strategy. And yes, you still need a stop loss. You are not going to make money without some kind of risk mitigation. But it's your account, you do you.`
  },
  {
    icon: '📊', title: 'Charts & Screeners',
    short: 'Manual charts with buy/sell points and automated grids.',
    detail: `Full-featured charts where you can manually set up buy and sell points, or configure grids to run automatically. Screeners help you filter through the noise. We use Binance Alpha data — currently around 500 tokens, mostly on BSC, with more chains and tokens coming as we grow.

Remember this is DeFi — where things can go sideways fast. The volatility here is not your top-20 market cap. Make sure you understand what you're getting into.`
  },
  {
    icon: '🔄', title: 'CoW Protocol Swaps',
    short: 'Swap tokens through CoW Protocol. We take nothing.',
    detail: `Manual token swapping when you just want to swap. We use CoW Protocol for all swaps — intent-based batch auctions that find the best price across all DEXs. We don't make anything off swaps — period. All fees are determined and controlled by CoW Protocol.

The software runs completely on your machine. Your keys, your swaps — everything stays local. The only thing we serve you is data, LLM interaction, and news articles.`
  },
  {
    icon: '🔐', title: 'Local & Secure',
    short: 'Everything runs on your machine. Keys never leave.',
    detail: `When you first start, you can create a new wallet (recommended). The app sets it up, gives you your seed phrase — write it down somewhere safe. It only shows it once, then it's deleted from memory.

Your private key is stored in Windows Credential Manager and used only for signing your swaps. You can import your own wallet too — just don't use a cold wallet with all your funds. Keep that separate. Create a hot wallet for trading with only funds you can afford to lose.

We don't want or need your seed phrase after creation. If someone asks you for it, don't ever give it to them. The only person who will ever ask for your seed phrase is the person about to scam you. If you're a scammer, eat shit and choke on it, you fuck head.`
  },
];

// ── Pricing ────────────────────────────────────────────────────────────

const PLANS = [
  { name:'Starter', price:9, strategies:5, finders:2, bots:1 },
  { name:'Pro', price:29, strategies:20, finders:10, bots:5, featured:true },
  { name:'Advanced', price:79, strategies:100, finders:50, bots:20 },
];

// ── Landing Page ───────────────────────────────────────────────────────

function HeroSection({ onDownload }) {
  const [zoomed, setZoomed] = useState(false);
  const [show, setShow] = useState(false);

  useEffect(() => {
    setTimeout(() => setZoomed(true), 500);
    setTimeout(() => setShow(true), 1800);
  }, []);

  return (
    <div style={{ position:'relative', minHeight:'100vh', background:'#0d1117', overflow:'hidden', animation:'fadeIn 1s ease-out' }}>
      {/* Background logo */}
      <div style={{ position:'absolute', inset:0, display:'flex', alignItems:'center', justifyContent:'center', opacity:zoomed?0:0.25 }}>
        <div style={{ animation: zoomed ? 'zoomIn 1.5s ease-in forwards' : 'none' }}>
          <HavenLogo size={Math.min(window.innerWidth, window.innerHeight) * 0.6} glow={!zoomed} />
        </div>
      </div>

      {/* Content */}
      {show && (
        <div style={{ position:'relative',zIndex:1,animation:'fadeIn 1s ease-out',padding:'40px 20px 0',minHeight:'100vh',display:'flex',flexDirection:'column',alignItems:'center' }}>
          {/* Header */}
          <div style={{ textAlign:'center',marginBottom:24,animation:'blockFly 0.6s ease-out' }}>
            <h1 style={{ fontSize:'clamp(36px,6vw,64px)',margin:0,background:'linear-gradient(135deg,#67e8f9,#a78bfa,#7c3aed)',WebkitBackgroundClip:'text',WebkitTextFillColor:'transparent',fontWeight:800 }}>
              Haven
            </h1>
            <p style={{ fontSize:'clamp(14px,2vw,20px)',color:'#a78bfa',margin:'4px 0 8px',fontStyle:'italic' }}>
              Trading your way made easy
            </p>
            <p style={{ fontSize:14,color:'#8b949e',maxWidth:600,margin:'0 auto',lineHeight:1.6 }}>
              Here at Haven we make things easier for you, but with full power and control. Our token finder lets you describe your idea and the LLM codes it up. We help you find the right tokens and build strategies around them — all running locally on your machine.
            </p>
          </div>

          {/* Download CTA */}
          <div style={{ marginBottom:32,animation:'blockFly 0.6s ease-out 0.2s both' }}>
            <button onClick={onDownload}
              style={{ background:'linear-gradient(135deg,#7c3aed,#a78bfa)',color:'#fff',border:'none',padding:'14px 48px',borderRadius:12,fontSize:18,fontWeight:700,cursor:'pointer',boxShadow:'0 0 30px rgba(124,58,237,0.4)' }}>
              Download
            </button>
          </div>

          {/* Feature grid */}
          <div style={{ display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(260px,1fr))',gap:12,maxWidth:1100,width:'100%',marginBottom:32 }}>
            {FEATURES.map((f, i) => (
              <FeatureCard key={f.title} {...f} delay={0.3 + i * 0.1} />
            ))}
          </div>

          {/* Pricing row */}
          <div style={{ display:'flex',gap:12,flexWrap:'wrap',justifyContent:'center',maxWidth:900,width:'100%',marginBottom:40,animation:'blockFly 0.6s ease-out 1s both' }}>
            {PLANS.map(p => (
              <div key={p.name} style={{
                background:'rgba(255,255,255,0.03)',border:`1px solid ${p.featured?'rgba(124,58,237,0.6)':'rgba(255,255,255,0.06)'}`,
                borderRadius:12,padding:'16px 24px',flex:'1 1 200px',maxWidth:280,textAlign:'center',position:'relative',
                boxShadow: p.featured ? '0 0 20px rgba(124,58,237,0.2)' : 'none',
              }}>
                {p.featured && <div style={{ position:'absolute',top:-10,left:'50%',transform:'translateX(-50%)',background:'linear-gradient(135deg,#7c3aed,#a78bfa)',color:'#fff',padding:'2px 14px',borderRadius:10,fontSize:11,fontWeight:600 }}>Popular</div>}
                <b style={{ fontSize:15,color:'#f0f6fc' }}>{p.name}</b>
                <div style={{ fontSize:28,fontWeight:700,color:'#a78bfa',margin:'8px 0' }}>${p.price}<span style={{fontSize:12,color:'#8b949e'}}>/mo</span></div>
                <div style={{fontSize:11,color:'#8b949e',lineHeight:1.6}}>
                  {p.strategies} strategies · {p.finders} finders · {p.bots} bots
                </div>
              </div>
            ))}
          </div>
          <p style={{ fontSize:11,color:'#8b949e',textAlign:'center',marginTop:-20,marginBottom:40 }}>7-day free trial · Cancel anytime · No refunds for crypto volatility losses</p>

          {/* Footer */}
          <div style={{ borderTop:'1px solid rgba(255,255,255,0.06)',padding:'12px 0',display:'flex',justifyContent:'space-between',alignItems:'center',fontSize:10,color:'#8b949e',width:'100%',maxWidth:1100 }}>
            <span>© {new Date().getFullYear()} Haven</span>
            <span style={{display:'flex',gap:12}}>
              <a href="https://app.haven.trading/#/terms" style={{color:'#8b949e',textDecoration:'none'}}>Terms</a>
              <a href="https://app.haven.trading/#/privacy" style={{color:'#8b949e',textDecoration:'none'}}>Privacy</a>
              <a href="https://app.haven.trading/#/risk" style={{color:'#8b949e',textDecoration:'none'}}>Risk</a>
              <a href="mailto:support@haven.trading" style={{color:'#8b949e',textDecoration:'none'}}>Contact</a>
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Feature Card ───────────────────────────────────────────────────────

function FeatureCard({ icon, title, short, detail, delay }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <div onClick={() => setOpen(true)}
        style={{
          background:'rgba(255,255,255,0.03)',border:'1px solid rgba(255,255,255,0.06)',borderRadius:10,
          padding:'14px 16px',cursor:'pointer',transition:'border-color 0.2s',
          animation:`blockFly 0.5s ease-out ${delay}s both`,
        }}
        onMouseEnter={e => e.currentTarget.style.borderColor='rgba(124,58,237,0.4)'}
        onMouseLeave={e => e.currentTarget.style.borderColor='rgba(255,255,255,0.06)'}>
        <div style={{fontSize:20,marginBottom:6}}>{icon}</div>
        <b style={{fontSize:14,color:'#f0f6fc'}}>{title}</b>
        <p style={{fontSize:12,color:'#8b949e',margin:'4px 0 0',lineHeight:1.5}}>{short}</p>
      </div>
      {open && (
        <div onClick={() => setOpen(false)} style={{position:'fixed',inset:0,zIndex:10000,background:'rgba(0,0,0,0.7)',display:'flex',alignItems:'center',justifyContent:'center',padding:20}}>
          <div onClick={e => e.stopPropagation()} style={{background:'#161b22',border:'1px solid #30363d',borderRadius:12,padding:'24px 32px',maxWidth:560,width:'100%',maxHeight:'80vh',overflow:'auto'}}>
            <div style={{fontSize:28,marginBottom:8}}>{icon}</div>
            <h2 style={{color:'#f0f6fc',margin:'0 0 12px',fontSize:20}}>{title}</h2>
            {detail.split('\n\n').map((p, i) => (
              <p key={i} style={{color:'#8b949e',fontSize:13,lineHeight:1.7,margin:'0 0 12px'}}>{p}</p>
            ))}
            <button onClick={() => setOpen(false)}
              style={{background:'#7c3aed',color:'#fff',border:'none',padding:'8px 20px',borderRadius:8,cursor:'pointer',fontSize:13,fontWeight:600,marginTop:8}}>
              Close
            </button>
          </div>
        </div>
      )}
    </>
  );
}

// ── Download Page ──────────────────────────────────────────────────────

function DownloadPage({ onBack }) {
  return (
    <div style={{minHeight:'100vh',background:'#0d1117',padding:'40px 20px',display:'flex',flexDirection:'column',alignItems:'center',animation:'fadeIn 0.5s'}}>
      <button onClick={onBack} style={{background:'transparent',color:'#8b949e',border:'1px solid rgba(255,255,255,0.1)',padding:'6px 16px',borderRadius:8,cursor:'pointer',fontSize:13,marginBottom:40,alignSelf:'flex-start'}}>← Back</button>

      <h1 style={{fontSize:'clamp(28px,5vw,48px)',color:'#f0f6fc',margin:'0 0 24px'}}>Download Haven</h1>

      <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:24,maxWidth:700,width:'100%'}}>
        {/* Windows */}
        <div style={{background:'rgba(255,255,255,0.03)',border:'1px solid rgba(255,255,255,0.08)',borderRadius:12,padding:24,textAlign:'center'}}>
          <div style={{fontSize:28,marginBottom:8}}>🪟</div>
          <h2 style={{color:'#f0f6fc',fontSize:18,margin:'0 0 12px'}}>Windows</h2>
          <a href={DOWNLOAD_URL} style={{display:'inline-block',background:'linear-gradient(135deg,#7c3aed,#a78bfa)',color:'#fff',padding:'10px 28px',borderRadius:10,fontWeight:600,textDecoration:'none',fontSize:14,marginBottom:12}}>Download .exe</a>
          <p style={{fontSize:11,color:'#8b949e',lineHeight:1.6}}>If SmartScreen shows a warning, click <b>More info</b> → <b>Run anyway</b>.</p>
        </div>

        {/* Linux */}
        <div style={{background:'rgba(255,255,255,0.03)',border:'1px solid rgba(255,255,255,0.08)',borderRadius:12,padding:24,textAlign:'center'}}>
          <div style={{fontSize:28,marginBottom:8}}>🐧</div>
          <h2 style={{color:'#f0f6fc',fontSize:18,margin:'0 0 12px'}}>Linux</h2>
          <a href={LINUX_URL} style={{display:'inline-block',background:'linear-gradient(135deg,#7c3aed,#a78bfa)',color:'#fff',padding:'10px 28px',borderRadius:10,fontWeight:600,textDecoration:'none',fontSize:14,marginBottom:12}}>Download .tar.gz</a>
          <div style={{background:'rgba(0,0,0,0.3)',borderRadius:6,padding:'8px 12px',fontSize:11,color:'#c9d1d9',textAlign:'left',fontFamily:'monospace',wordBreak:'break-all',lineHeight:1.6}}>
            <div>cd ~/Downloads</div>
            <div style={{marginTop:4}}>{LINUX_CMD}</div>
            <div style={{marginTop:4,color:'#8b949e'}}># Optional: install system-wide</div>
            <div>sudo mv haven-desktop-v1.3.0-linux /usr/local/bin/haven</div>
          </div>
        </div>
      </div>

      <div style={{background:'rgba(255,255,255,0.03)',border:'1px solid rgba(255,255,255,0.06)',borderRadius:10,padding:'14px 20px',maxWidth:700,marginTop:24,textAlign:'center',fontSize:11,color:'#8b949e',lineHeight:1.6}}>
        <b style={{color:'#f0f6fc'}}>⚠ Risk Warning:</b> This software is not going to make you rich. You will most likely lose money. You are the only one making the final decision with your money. We do not give advice — only tools. Crypto is dangerous. Trade with funds you can afford to lose.
      </div>
    </div>
  );
}

// ── Root ───────────────────────────────────────────────────────────────

function LandingPage() {
  const [phase, setPhase] = useState('splash');
  const [download, setDownload] = useState(false);

  if (download) return <><style>{animCSS}</style><DownloadPage onBack={() => setDownload(false)} /></>;
  if (phase === 'splash') return <><style>{animCSS}</style><SplashScreen onDone={() => setPhase('landing')} /></>;
  return <><style>{animCSS}</style><HeroSection onDownload={() => setDownload(true)} /></>;
}

createRoot(document.getElementById('root')).render(<StrictMode><LandingPage /></StrictMode>);
