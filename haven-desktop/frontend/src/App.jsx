// Desktop app shell — subscription gate, entitlement enforcement, main interface.
import { useState, useEffect, useCallback } from 'react'
import { useAuth, SignIn, UserButton } from '@clerk/clerk-react'

const API = 'http://localhost:8000'
const RECHECK_MS = 4 * 60 * 60 * 1000 // 4 hours

export default function App() {
  const { isSignedIn, isLoaded, getToken } = useAuth()
  const [entitlement, setEntitlement] = useState(null)
  const [status, setStatus] = useState('loading') // loading | active | locked

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
      if (data.app_access) {
        setEntitlement(data)
        if (data.build_warning) {
          alert(data.build_warning)
        }
        setStatus('active')
      } else {
        setStatus('locked')
      }
    } catch {
      // If cloud is unreachable, check local cache
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
    if (isLoaded && isSignedIn) {
      verify()
      const iv = setInterval(verify, RECHECK_MS)
      return () => clearInterval(iv)
    }
    if (isLoaded && !isSignedIn) {
      setStatus('locked')
    }
  }, [isLoaded, isSignedIn, verify])

  if (!isLoaded || status === 'loading') {
    return <LoadingScreen />
  }

  if (!isSignedIn || status === 'locked') {
    return <LockedScreen onRetry={verify} isSignedIn={isSignedIn} />
  }

  return <Dashboard entitlement={entitlement} />
}

function LoadingScreen() {
  return (
    <div style={center}>
      <h1 style={{ fontSize: 24, color: '#f0f6fc' }}>Haven</h1>
      <p style={{ color: '#8b949e' }}>Loading...</p>
    </div>
  )
}

function LockedScreen({ onRetry, isSignedIn }) {
  return (
    <div style={center}>
      <h1 style={{ fontSize: 24, color: '#f0f6fc', marginBottom: 16 }}>Haven</h1>
      <p style={{ color: '#8b949e', maxWidth: 360, textAlign: 'center', marginBottom: 24 }}>
        {isSignedIn
          ? 'Your subscription is not active. Please subscribe to continue using Haven.'
          : 'Sign in to verify your subscription and access Haven.'}
      </p>
      {isSignedIn ? (
        <>
          <p style={{ color: '#8b949e', fontSize: 13, marginBottom: 16 }}>
            Visit <a href="https://haven.trading" style={{ color: '#58a6ff' }}>haven.trading</a> to manage your subscription.
          </p>
          <button onClick={onRetry} style={btn}>Retry</button>
          <div style={{ marginTop: 16 }}>
            <UserButton afterSignOutUrl="/" />
          </div>
        </>
      ) : (
        <SignIn routing="virtual" />
      )}
    </div>
  )
}

function Dashboard({ entitlement }) {
  const t = entitlement || {}
  return (
    <div style={{ padding: 24, maxWidth: 1100, margin: '0 auto' }}>
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 32 }}>
        <h1 style={{ fontSize: 20, color: '#f0f6fc' }}>Haven</h1>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          <span style={{ fontSize: 12, color: '#8b949e', background: '#161b22', padding: '4px 10px', borderRadius: 12 }}>
            {t.tier || 'trial'}
          </span>
          <UserButton afterSignOutUrl="/" />
        </div>
      </header>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 16 }}>
        <InfoCard title="Subscription" items={[
          ['Tier', t.tier || 'trial'],
          ['Live Trading', t.live_trading ? 'Enabled' : 'Disabled'],
          ['LLM', `${t.llm_messages_per_window || 0} msgs / ${t.llm_window_minutes || 15}min`],
        ]} />
        <InfoCard title="Limits" items={[
          ['Strategies', `${t.max_strategies || 0}`],
          ['Finders', `${t.max_finders || 0}`],
          ['Trading Bots', `${t.max_bots || 0}`],
        ]} />
        <InfoCard title="Status" items={[
          ['Finder', t.finder_enabled ? 'Enabled' : 'Starter+ only'],
          ['Data Refresh', `${t.data_refresh_sec || 30}s`],
          ['Trial End', t.trial_end || 'N/A'],
        ]} />
      </div>

      <footer style={{ marginTop: 48, textAlign: 'center', color: '#30363d', fontSize: 12 }}>
        Haven Desktop · {t.tier} tier · Re-verifies every 4 hours
      </footer>
    </div>
  )
}

function InfoCard({ title, items }) {
  return (
    <div style={{ background: '#161b22', border: '1px solid #30363d', borderRadius: 8, padding: 16 }}>
      <h3 style={{ fontSize: 13, color: '#8b949e', marginBottom: 12, textTransform: 'uppercase', letterSpacing: 1 }}>{title}</h3>
      {items.map(([label, value]) => (
        <div key={label} style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', borderBottom: '1px solid #21262d' }}>
          <span style={{ color: '#8b949e' }}>{label}</span>
          <span style={{ color: '#c9d1d9', fontWeight: 500 }}>{value}</span>
        </div>
      ))}
    </div>
  )
}

const center = { minHeight: '100vh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: 24, background: '#0d1117' }
const btn = { background: '#238636', color: '#fff', border: 'none', padding: '8px 20px', borderRadius: 6, cursor: 'pointer', fontSize: 14, fontWeight: 600 }
