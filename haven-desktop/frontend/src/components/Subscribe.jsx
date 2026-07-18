// Upgrade / plan picker via Clerk Billing (PricingTable).
// Plans and trials are configured in Clerk Dashboard → Billing.
import { UserButton, PricingTable } from '@clerk/clerk-react';
import HavenLogo from './HavenLogo.jsx';
import LegalFooter from './LegalFooter.jsx';
import { RISK_SUMMARY_SHORT } from '../legal/content.js';

export default function Subscribe({ access, onActivated }) {
  const hasPaidPlan = access?.paid === true;
  const hasTrial = access?.trial === true;
  const hasActivePlan = hasPaidPlan || hasTrial;

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
        <h1>{hasActivePlan ? 'Manage your subscription' : 'Choose your plan'}</h1>
        <p className="subscribe-sub">
          {hasPaidPlan
            ? 'Your subscription is active. Review your current plan and billing date, or choose a different plan below.'
            : hasTrial
              ? 'Your seven-day trial is active. Review your current plan and trial end date, or choose a different plan below.'
              : 'Choose a plan and add a card to start your seven-day trial. You will not be billed until the trial ends, and you can cancel beforehand.'}
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
