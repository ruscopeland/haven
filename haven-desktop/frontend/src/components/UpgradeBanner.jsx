// Trial reminder: sends users to Clerk PricingTable without restricting workflow.
import useEntitlements from '../hooks/useEntitlements.js';

export default function UpgradeBanner({ onOpenSettings }) {
  const { loading, data } = useEntitlements();
  if (loading || !data?.trial) return null;

  return (
    <div className="upgrade-banner" role="region" aria-label="Upgrade subscription">
      <div className="upgrade-banner-copy">
        <strong>Your seven-day trial is active</strong>
        <span className="upgrade-banner-sub">
          {' '}— paper and live trading are available now; subscribe to keep access after the trial.
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
