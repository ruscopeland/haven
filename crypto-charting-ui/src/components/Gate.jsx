// Signed-in gate. Clerk owns plan selection, card collection, trials, and billing.
import App from '../App.jsx';
import Subscribe from './Subscribe.jsx';
import HavenLogo from './HavenLogo.jsx';
import useEntitlements from '../hooks/useEntitlements.js';

export default function Gate() {
  const { loading, data, error, refresh } = useEntitlements();

  if (loading) {
    return (
      <div className="gate-loading">
        <div className="gate-skeleton-logo"><HavenLogo size={36} /></div>
        <div>Loading your account…</div>
      </div>
    );
  }

  const params = new URLSearchParams(window.location.search);
  if (params.get('subscribe') === '1' || data?.app_access === false) {
    return <Subscribe onActivated={() => { window.location.href = '/'; }} />;
  }
  if (error || !data) {
    return (
      <div className="gate-loading" role="alert">
        <HavenLogo size={36} />
        <div>Haven could not verify your account access.</div>
        <button type="button" className="btn-primary" onClick={refresh}>Try again</button>
      </div>
    );
  }

  return <App />;
}
