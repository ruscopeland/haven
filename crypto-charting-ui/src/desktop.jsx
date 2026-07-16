// Desktop-mode entry point for the Haven desktop app.
// When VITE_DESKTOP_MODE is set, the app runs without Clerk — the Go backend
// handles subscription verification and the frontend just connects to localhost.
//
// Build with: VITE_DESKTOP_MODE=true VITE_API_URL=http://localhost:8000 npm run build
import { StrictMode, useState, useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import './haven-saas.css'
import App from './App.jsx'
import HavenLogo from './components/HavenLogo.jsx'

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:8000';

function DesktopGate() {
  const [status, setStatus] = useState('checking'); // checking | active | expired | error
  const [entitlement, setEntitlement] = useState(null);

  useEffect(() => {
    let alive = true;
    const check = async () => {
      try {
        const r = await fetch(`${API_URL}/subscription/status`);
        if (!alive) return;
        if (!r.ok) { setStatus('error'); return; }
        const data = await r.json();
        if (data.app_access) {
          setEntitlement(data);
          setStatus('active');
        } else {
          setStatus('expired');
        }
      } catch {
        if (alive) setStatus('error');
      }
    };
    check();
    // Re-check every 15 minutes
    const iv = setInterval(check, 900_000);
    return () => { alive = false; clearInterval(iv); };
  }, []);

  if (status === 'checking') {
    return (
      <main style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 24, background: '#0d1117' }}>
        <div style={{ textAlign: 'center', color: '#cbd5e1' }}>
          <HavenLogo size={36} />
          <h1 style={{ marginBottom: 8, color: '#f8fafc' }}>Haven</h1>
          <p>Verifying your subscription…</p>
          <p style={{ fontSize: '0.8rem', color: '#6b7280', marginTop: 16 }}>
            Haven connects to the licensing service to confirm your active subscription.
          </p>
        </div>
      </main>
    );
  }

  if (status === 'expired') {
    return (
      <main style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 24, background: '#0d1117' }}>
        <div style={{ textAlign: 'center', color: '#cbd5e1', maxWidth: 480 }}>
          <HavenLogo size={36} />
          <h1 style={{ marginBottom: 8, color: '#f8fafc' }}>Subscription Required</h1>
          <p>Your Haven subscription is not active. Please renew to continue using the app.</p>
          <p style={{ fontSize: '0.85rem', color: '#6b7280', marginTop: 16 }}>
            Visit <a href="https://haven.trading" style={{ color: '#60a5fa' }}>haven.trading</a> to manage your subscription.
          </p>
          <button
            className="btn-primary"
            style={{ marginTop: 20 }}
            onClick={() => setStatus('checking')}
          >
            Check Again
          </button>
        </div>
      </main>
    );
  }

  if (status === 'error') {
    return (
      <main style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 24, background: '#0d1117' }}>
        <div style={{ textAlign: 'center', color: '#cbd5e1' }}>
          <HavenLogo size={36} />
          <h1 style={{ marginBottom: 8, color: '#f8fafc' }}>Connection Error</h1>
          <p>Could not reach the Haven licensing service.</p>
          <p style={{ fontSize: '0.85rem', color: '#6b7280', marginTop: 16 }}>
            Haven requires an active subscription. Check your internet connection.
          </p>
          <button
            className="btn-primary"
            style={{ marginTop: 20 }}
            onClick={() => setStatus('checking')}
          >
            Retry
          </button>
        </div>
      </main>
    );
  }

  return <App entitlement={entitlement} />;
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <DesktopGate />
  </StrictMode>,
);
