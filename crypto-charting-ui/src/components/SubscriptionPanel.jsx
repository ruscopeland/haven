// Settings → Subscription via Clerk Billing.
import { PricingTable, useAuth, UserProfile } from '@clerk/clerk-react';
import { useState } from 'react';
import { isClerkPaid } from '../clerkBilling.js';

export default function SubscriptionPanel() {
  const { isLoaded, has } = useAuth();
  const [showPlans, setShowPlans] = useState(false);

  if (!isLoaded) return null;

  const paid = isClerkPaid(has);

  return (
    <div style={{ marginBottom: 8 }}>
      <h2 style={{ color: 'var(--text-bright)', marginTop: 0 }}>Subscription</h2>
      <div style={{ marginBottom: 12 }}>
        {paid ? (
          <span className="dash-green" style={{ fontWeight: 600 }}>Paid plan active</span>
        ) : (
          <span className="dash-yellow" style={{ fontWeight: 600 }}>Free paper tier</span>
        )}
      </div>

      {paid ? (
        <p className="dash-muted" style={{ fontSize: 13, marginBottom: 12, lineHeight: 1.5 }}>
          Live trading and engine download are unlocked. Manage billing in your account menu
          (profile → Billing), or below.
        </p>
      ) : (
        <div className="upgrade-panel" style={{ marginBottom: 16 }}>
          <h3 className="upgrade-panel-title">Upgrade to subscribe</h3>
          <p className="dash-muted" style={{ fontSize: 13, margin: '0 0 14px', lineHeight: 1.5 }}>
            Pick a plan. Clerk handles subscription status; Stripe processes the card.
          </p>
          <button type="button" className="btn-primary" onClick={() => setShowPlans(true)}>
            Show plans
          </button>
        </div>
      )}

      {(showPlans || !paid) && (
        <div className="clerk-pricing-wrap" style={{ marginTop: 8 }}>
          <PricingTable />
        </div>
      )}

      {paid && (
        <details style={{ marginTop: 16 }}>
          <summary className="dash-muted" style={{ cursor: 'pointer', fontSize: 13 }}>
            Account &amp; billing profile
          </summary>
          <div style={{ marginTop: 12 }}>
            <UserProfile routing="hash" />
          </div>
        </details>
      )}
    </div>
  );
}
