// Desktop app entry — Clerk auth gate → subscription verify → full program.
import { StrictMode, useState, useEffect, useCallback } from 'react'
import { createRoot } from 'react-dom/client'
import { ClerkProvider, useAuth, SignIn, UserButton } from '@clerk/clerk-react'
import './index.css'
import './haven-saas.css'
import App from './App.jsx'

const PUBLISHABLE_KEY = 'pk_test_cHJlcGFyZWQtc2t5bGFyay0xMi5jbGVyay5hY2NvdW50cy5kZXYk'
const hasRealKey = PUBLISHABLE_KEY && !PUBLISHABLE_KEY.includes('YOUR_CLERK_KEY')
const API = 'http://localhost:8000'
const RECHECK_MS = 4 * 60 * 60 * 1000

// ── Clerk subscription gate ──────────────────────────────────────────────

function SubscriptionGate() {
  const { isSignedIn, isLoaded, getToken } = useAuth()
  const [entitlement, setEntitlement] = useState(null)
  const [status, setStatus] = useState('loading')

  const verify = useCallback(async () => {
    if (!isSignedIn) return
    try {
      const token = await getToken()
      const r = await fetch(`${API}/subscription/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clerk_token: token }),
      })
      if (!r.ok) { setStatus('locked'); return }
      const data = await r.json()
      if (data.app_access) { setEntitlement(data); setStatus('active') }
      else { setStatus('locked') }
    } catch {
      try {
        const r = await fetch(`${API}/subscription/status`)
        if (r.ok) {
          const data = await r.json()
          if (data.app_access) { setEntitlement(data); setStatus('active'); return }
        }
      } catch {}
      setStatus('locked')
    }
  }, [isSignedIn, getToken])

  useEffect(() => {
    if (isLoaded && isSignedIn) { verify(); const iv = setInterval(verify, RECHECK_MS); return () => clearInterval(iv) }
    if (isLoaded && !isSignedIn) setStatus('locked')
  }, [isLoaded, isSignedIn, verify])

  if (!isLoaded || status === 'loading') return <LoadingScreen />
  if (!isSignedIn || status === 'locked') return <LockedScreen onRetry={verify} isSignedIn={isSignedIn} />
  return <App entitlement={entitlement} />
}

// ── Standalone (no Clerk key) ────────────────────────────────────────────

function StandaloneGate() {
  const [entitlement, setEntitlement] = useState(null)
  useEffect(() => {
    fetch(`${API}/subscription/status`)
      .then(r => r.json())
      .then(d => { if (d.app_access) setEntitlement(d) })
      .catch(() => {})
  }, [])
  if (!entitlement) return <LoadingScreen />
  return <App entitlement={entitlement} />
}

// ── Shared UI ────────────────────────────────────────────────────────────

function LoadingScreen() {
  return <div style={center}><h1 style={{fontSize:24,color:'#f0f6fc'}}>Haven</h1><p style={{color:'#8b949e'}}>Loading...</p></div>
}

function LockedScreen({ onRetry, isSignedIn }) {
  return (
    <div style={center}>
      <h1 style={{fontSize:24,color:'#f0f6fc',marginBottom:16}}>Haven</h1>
      <p style={{color:'#8b949e',maxWidth:360,textAlign:'center',marginBottom:24}}>
        {isSignedIn
          ? 'Your subscription is not active. Please subscribe to continue using Haven.'
          : 'Sign in to verify your subscription and access Haven.'}
      </p>
      {isSignedIn ? (
        <>
          <p style={{color:'#8b949e',fontSize:13,marginBottom:16}}>Visit <a href="https://haven.trading" style={{color:'#58a6ff'}}>haven.trading</a> to manage your subscription.</p>
          <button onClick={onRetry} style={btn}>Retry</button>
          <div style={{marginTop:16}}><UserButton afterSignOutUrl="/" /></div>
        </>
      ) : (
        <SignIn routing="virtual" />
      )}
    </div>
  )
}

// ── Root ─────────────────────────────────────────────────────────────────

function Root() {
  if (!hasRealKey) return <StandaloneGate />
  return (
    <ClerkProvider publishableKey={PUBLISHABLE_KEY} afterSignOutUrl="/">
      <SubscriptionGate />
    </ClerkProvider>
  )
}

createRoot(document.getElementById('root')).render(<StrictMode><Root /></StrictMode>)

const center = { minHeight: '100vh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: 24, background: '#0d1117' }
const btn = { background: '#238636', color: '#fff', border: 'none', padding: '8px 20px', borderRadius: 6, cursor: 'pointer', fontSize: 14, fontWeight: 600 }
