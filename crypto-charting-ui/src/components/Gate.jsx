// Subscription gate for signed-in users. Fetches /billing/status once; a paid
// user drops straight into the terminal (App), everyone else sees Subscribe.
// The Clerk token rides on the request via the global authFetch interceptor.
import { useEffect, useState } from 'react';
import App from '../App.jsx';
import Subscribe from './Subscribe.jsx';
import { API_URL } from '../authFetch.js';

export default function Gate() {
  const [state, setState] = useState({ loading: true, paid: false });

  useEffect(() => {
    let alive = true;
    const check = () => fetch(`${API_URL}/billing/status`)
      .then(r => r.json())
      .then(d => { if (alive) setState({ loading: false, paid: !!d.paid }); })
      .catch(() => { if (alive) setState({ loading: false, paid: false }); });
    check();
    // Re-check shortly after returning from Stripe (?billing=success) so the
    // gate clears once the webhook lands, without a manual refresh.
    const params = new URLSearchParams(window.location.search);
    let poll;
    if (params.get('billing') === 'success') {
      let tries = 0;
      poll = setInterval(() => { if (++tries > 10) clearInterval(poll); check(); }, 2000);
    }
    return () => { alive = false; if (poll) clearInterval(poll); };
  }, []);

  if (state.loading) {
    return <div className="gate-loading">Loading your account…</div>;
  }
  return state.paid ? <App /> : <Subscribe />;
}
