// Signed-in gate. Access: anyone signed in (paper). Paid plan/feature from Clerk Billing.
import { useAuth } from '@clerk/clerk-react';
import App from '../App.jsx';
import Subscribe from './Subscribe.jsx';
import HavenLogo from './HavenLogo.jsx';
import { isClerkPaid } from '../clerkBilling.js';

export default function Gate() {
  const { isLoaded, has } = useAuth();

  if (!isLoaded) {
    return (
      <div className="gate-loading">
        <div className="gate-skeleton-logo"><HavenLogo size={36} /></div>
        <div>Loading your account…</div>
      </div>
    );
  }

  // Always enter the app when signed in. Clerk Billing owns paper vs paid.
  // Subscribe screen is only a dedicated upgrade view (user can open Settings).
  // Show subscribe only when ?subscribe=1 (optional deep link).
  const params = new URLSearchParams(window.location.search);
  if (params.get('subscribe') === '1' && !isClerkPaid(has)) {
    return <Subscribe onActivated={() => { window.location.href = '/'; }} />;
  }

  return <App />;
}
