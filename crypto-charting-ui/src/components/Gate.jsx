// Subscription / paper-trial gate for signed-in users.
// On first sign-in with no plan: auto-starts the free paper trial (no extra click).
// Paid or unexpired paper trial → App; expired / blocked → Subscribe.
import { useCallback, useEffect, useRef, useState } from 'react';
import App from '../App.jsx';
import Subscribe from './Subscribe.jsx';
import { API_URL } from '../authFetch.js';
import HavenLogo from './HavenLogo.jsx';

export default function Gate() {
  const [state, setState] = useState({ loading: true, paid: false, message: '' });
  const autoTried = useRef(false);

  const check = useCallback(async () => {
    try {
      const r = await fetch(`${API_URL}/billing/status`);
      const d = await r.json();
      setState({
        loading: false,
        paid: !!d.paid,
        status: d.status,
        plan: d.plan,
        message: '',
      });
      return d;
    } catch {
      setState({ loading: false, paid: false, message: '' });
      return null;
    }
  }, []);

  useEffect(() => {
    let alive = true;
    const boot = async () => {
      const d = await check();
      if (!alive || !d) return;

      // Auto paper trial: no active access yet, and we have not already tried.
      if (!d.paid && !autoTried.current) {
        autoTried.current = true;
        // Only when they have never subscribed / never had a trial row.
        if (d.status === 'none' || !d.status) {
          setState(s => ({ ...s, loading: true, message: 'Starting your free paper trial…' }));
          try {
            const res = await fetch(`${API_URL}/billing/start-paper-trial`, { method: 'POST' });
            const body = await res.json().catch(() => ({}));
            if (res.ok && body.paid !== false) {
              await check();
              return;
            }
            // 402 expired trial or other — fall through to Subscribe.
          } catch { /* show Subscribe */ }
          if (alive) setState(s => ({ ...s, loading: false, paid: false }));
        }
      }
    };
    boot();

    const params = new URLSearchParams(window.location.search);
    let poll;
    if (params.get('billing') === 'success') {
      // Apply Stripe checkout immediately (webhook is backup — was broken on .get()).
      (async () => {
        setState(s => ({ ...s, loading: true, message: 'Confirming your subscription…' }));
        const sessionId = params.get('session_id');
        try {
          await fetch(`${API_URL}/billing/confirm-checkout`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(sessionId ? { session_id: sessionId } : {}),
          });
        } catch { /* still poll status below */ }
        if (alive) await check();
        window.history.replaceState({}, '', window.location.pathname || '/');
      })();

      let tries = 0;
      poll = setInterval(async () => {
        if (++tries > 15) clearInterval(poll);
        if (!alive) return;
        const d = await check();
        if (d && d.plan && d.plan !== 'paper' && d.status === 'active') clearInterval(poll);
      }, 2000);
    }
    return () => { alive = false; if (poll) clearInterval(poll); };
  }, [check]);

  if (state.loading) {
    return (
      <div className="gate-loading">
        <div className="gate-skeleton-logo"><HavenLogo size={36} /></div>
        <div>{state.message || 'Loading your account…'}</div>
      </div>
    );
  }
  return state.paid
    ? <App />
    : <Subscribe onActivated={() => check()} />;
}
