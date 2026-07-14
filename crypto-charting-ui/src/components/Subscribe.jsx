// Upgrade / plan picker via Clerk Billing (PricingTable).
// Plans and trials are configured in Clerk Dashboard → Billing.
import { UserButton, PricingTable } from '@clerk/clerk-react';
import HavenLogo from './HavenLogo.jsx';
import LegalFooter from './LegalFooter.jsx';
import { RISK_SUMMARY_SHORT } from '../legal/content.js';

export default function Subscribe({ onActivated }) {
  return (
    <div className="subscribe-root">
      <div className="subscribe-topbar">
        <div className="landing-brand"><HavenLogo size={28} /></div>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
          {onActivated && (
            <button type="button" className="btn-ghost" onClick={onActivated}>
              Back to app
            </button>
          )}
          <UserButton afterSignOutUrl="/" />
        </div>
      </div>
      <div className="subscribe-card">
        <h1>Choose your plan</h1>
        <p className="subscribe-sub">
          Your automatic seven-day trial includes paper and live trading. Choose a plan to keep access.
        </p>
        <p className="landing-risk-line" style={{ marginBottom: 20 }}>{RISK_SUMMARY_SHORT}</p>
        <div className="clerk-pricing-wrap">
          <PricingTable
            appearance={{
              elements: {
                rootBox: { width: '100%' },
              },
            }}
          />
        </div>
        <p className="landing-fineprint" style={{ marginTop: 24 }}>
          Subscription and payment status are managed through your Haven account with Clerk.
          Cancel anytime from your account profile.
        </p>
      </div>
      <LegalFooter onOpen={() => {}} />
    </div>
  );
}
