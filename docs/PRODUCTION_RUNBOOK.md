# Running Haven in production

This file explains the real launch state in plain language. It is not a list of
technical chores for the owner.

## What Haven already handles

- Clerk owns sign-up, sign-in, user profiles, plans, checkout, subscriptions,
  and billing status.
- Stripe is used only by Clerk to process cards. Haven does not use a Stripe
  key, receive Stripe webhooks, or maintain a second billing system.
- A new Clerk user automatically receives one seven-day Haven trial. The local
  database records that trial's end date and usage limits against the Clerk user
  ID. It is an access allowance, not a Stripe subscription.
- Binance Alpha Startup is the only outside market-data source. Its published
  plan permits commercial product use, historical data, and WebSocket access.
  Haven caches data to reduce repeat calls and does not resell Binance Alpha data as a
  standalone feed.
- Database upgrades run automatically when the API is deployed.
- The owner page reports service, database, market stream, backup, subscription,
  and deployment health.
- Paper and live trading use the same engine on the trader's computer. Wallet
  private keys stay on that computer.

## What the lead developer handles

The lead developer checks the existing Clerk, Railway, Cloudflare, Binance Alpha, and
monitoring setup; adds or corrects settings; deploys Haven; upgrades the
database; tests sign-up and all plans; verifies backups; and runs the full test
suite. Existing accounts should be reused, not recreated.

Replacement secrets belong in the hosting services' protected settings, never
in this workspace or in browser code. Plan names, prices, capacity limits, owner
user IDs, and service links are normal Haven settings and are maintained as part
of deployment.

## When the owner is actually needed

The owner is needed only when a service requires something a developer tool
cannot legally or physically supply, such as:

- entering a password, passkey, or two-factor code that only the owner has;
- approving a charge or accepting account terms in the owner's name;
- choosing the legal business name, contact address, or operating jurisdiction;
- moving funds from an old wallet after reviewing and approving the destination.

If one of those is required, the request must say exactly which website to open,
what to click or enter, why it is required, and what result to report back. The
owner should never be asked to run database commands, build software, configure
containers, or translate a technical checklist.

## Final launch check

Before launch, the lead developer verifies the real hosted website—not just a
local copy—including account creation, automatic trial, Clerk checkout for each
plan, paper and live workflows, Binance Alpha REST/WebSocket recovery, database upgrades,
monitoring, encrypted backup and restore, signed engine downloads, and the full
backend/frontend/engine test suite.

If any check cannot be performed because a signed-in account or owner approval
is unavailable, it is reported as one specific unfinished check. It is not
turned into a broad homework list.
