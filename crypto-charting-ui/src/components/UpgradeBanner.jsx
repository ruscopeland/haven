// Paper-only banner: send users to Clerk PricingTable (Settings or /?subscribe=1).
import { useAuth } from '@clerk/clerk-react';
import { isClerkPaid } from '../clerkBilling.js';

export default function UpgradeBanner({ onOpenSettings }) {
  const { isLoaded, has } = useAuth();
  if (!isLoaded || isClerkPaid(has)) return null;

  return (
    <div className="upgrade-banner" role="region" aria-label="Upgrade subscription">
      <div className="upgrade-banner-copy">
        <strong>You are on the free paper tier</strong>
        <span className="upgrade-banner-sub">
          {' '}— subscribe for live trading, full bots, and the desktop engine.
        </span>
      </div>
      <div className="upgrade-banner-actions">
        <button
          type="button"
          className="btn-primary"
          onClick={() => {
            if (onOpenSettings) onOpenSettings();
            else window.location.href = '/?subscribe=1';
          }}
        >
          Upgrade
        </button>
        <button
          type="button"
          className="btn-secondary"
          onClick={() => { window.location.href = '/?subscribe=1'; }}
        >
          View plans
        </button>
      </div>
    </div>
  );
}
