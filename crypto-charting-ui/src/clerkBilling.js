// Clerk Billing helpers (plans/features live in Clerk Dashboard).
// Configure plan/feature slugs to match what you create in Clerk → Billing → Plans.

/** Paid plan slug(s) in Clerk (comma-separated env). Default: pro */
export const PAID_PLAN_SLUGS = String(import.meta.env.VITE_CLERK_PAID_PLANS || 'pro')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

/** Feature that unlocks live trading + engine download. Attach to paid plan(s). */
export const LIVE_FEATURE = import.meta.env.VITE_CLERK_LIVE_FEATURE || 'live_trading';

/**
 * @param {(check: { plan?: string, feature?: string }) => boolean} has
 *   from useAuth().has
 */
export function isClerkPaid(has) {
  if (typeof has !== 'function') return false;
  if (LIVE_FEATURE && has({ feature: LIVE_FEATURE })) return true;
  return PAID_PLAN_SLUGS.some(plan => has({ plan }));
}

/** Any signed-in user may use paper tools; paid is separate. */
export function isClerkPaperOnly(has) {
  return !isClerkPaid(has);
}
