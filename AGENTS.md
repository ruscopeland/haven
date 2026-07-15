# Haven project guidance

## What this project is

Haven is a non-custodial crypto research and strategy workspace. The hosted
service provides licensed CoinMarketCap data, Clerk authentication and billing,
strategy storage, and operations visibility. A Windows-local engine runs both
paper and live strategies; wallet private keys must remain encrypted on the
trader's computer.

Read `README.md` first for the product summary. Use these documents as the
authoritative detailed references:

- `docs/USER_GUIDE.md` — intended user workflow and safety language.
- `docs/PRODUCTION_RUNBOOK.md` — deployment ownership and launch checks.
- `docs/SECURITY_ROTATION_REQUIRED.md` — unresolved credential-rotation work.
- `strategy-sdk/docs/` — strategy/finder behavior and public authoring contract.
- `.github/workflows/production-checks.yml` — release verification commands.

`crypto-charting-ui/README.md` is still the generic Vite template; do not treat
it as product documentation.

## Persistent operations context

This section is the starting point for a fresh task. Do not rely on a previous
chat for operational context, and never add secrets, key values, account IDs,
or recovery phrases here.

- **Source and CI:** GitHub (`ruscopeland/haven`). GitHub Actions runs the
  repository checks; look there first for release automation.
- **API and database hosting:** Railway. Production configuration and protected
  API environment variables belong there.
- **Web edge and DNS:** Cloudflare. Do not change DNS, domains, or proxy/TLS
  settings without explicit owner approval.
- **Identity, plans, checkout, and subscription state:** Clerk. Stripe is
  managed only through Clerk; Haven has no direct Stripe keys or webhooks.
- **Engine downloads:** the API verifies a signed platform release before
  serving it. `crypto-data-collector/tools/build_engine_release.py` builds the
  Windows NSIS installer and Linux installer bundle. The private release-signing
  key must already exist in an approved protected secret store; never invent,
  print, move, or replace it. The corresponding public key is an API production
  setting. A release build also needs a Windows builder with NSIS (`makensis`).

If an operational task requires access that is not connected to the current
session, identify the existing system and request only the specific sign-in or
approval needed. Do not ask a non-technical owner to configure environment
variables or run build commands.

## Repository map

- `crypto-charting-ui/` — React 19/Vite web app. It displays data and strategy
  tooling but never holds private keys or signs transactions.
- `crypto-data-collector/` — FastAPI service, CMC integration, Clerk access and
  billing, SQLAlchemy models, Alembic migrations, monitoring, backups, and
  owner operations. The local default is port 8000.
- `marker-engine/` — Node.js desktop engine for paper and live execution. It
  stores sensitive credentials with Windows user-bound DPAPI and isolates
  user-authored code in `sandbox-runtime.js`.
- `strategy-sdk/` — dependency-free ESM runtime shared by browser backtests and
  the desktop engine. It owns indicators, backtesting, portfolio ranking, and
  the strategy/finder contracts.
- `docs/` — user, production, and security documentation.
- `start.bat` — Windows local launcher for API, engine, and web app.
- `backup-db.bat` — invokes the backend database backup tool.

## Core architecture and invariants

Preserve these unless the user explicitly requests an architectural change:

1. CoinMarketCap Startup REST/WebSocket APIs are the sole market-data source.
   Provider credentials and licensed data access stay server-side.
2. Paper (`DRY`) and live (`LIVE`) trading use the same local engine and shared
   strategy SDK. There is no cloud paper runner or separate live strategy
   implementation.
3. The same saved strategy logic must behave consistently in browser backtests,
   dry runs, and live runs. Maintain the no-look-ahead rule, closed-bar
   processing, next-bar-open simulated fills, and pessimistic stop-loss-first
   handling when TP and SL are both possible in one bar.
4. Wallet private keys never enter the browser, API, logs, repository, or
   plaintext environment files. They remain in the local engine's encrypted
   credential store. The browser never signs transactions.
5. User-authored code is untrusted. Browser evaluation remains in a disposable
   worker; engine evaluation remains behind the hardened VM/JSON bridge with
   time, size, capability, and code-generation restrictions.
6. Live strategy code is versioned and explicitly approved. Transaction
   validation, simulation, router/selector allowlists, size limits, daily caps,
   price-impact checks, and pause controls must fail closed.
7. All user-owned data and mutations remain scoped by authenticated identity.
   Preserve `require_paid`, `require_identity_scope`, engine credential scopes,
   Clerk verification, and owner-only access controls. Never broaden CORS or
   production authentication for convenience.
8. Production must continue to fail before serving when required safety,
   licensing, database, authentication, monitoring, signing, rotation, or HTTPS
   configuration is absent. Production requires hosted PostgreSQL; SQLite is
   for local development and tests.
9. Clerk owns checkout, plans, subscriptions, and Stripe integration. Haven
   does not directly own Stripe keys or webhooks. New users receive the
   server-recorded automatic trial described in the product docs.
10. Schema changes use SQLAlchemy models plus a new Alembic migration. Keep
    upgrade and downgrade paths working; deployments apply migrations at API
    startup.

## Cross-component change rules

- When changing the strategy or finder authoring surface, update the shared SDK,
  its tests and contract docs, then verify both the browser worker and local
  engine consumers. Do not duplicate the SDK inside either consumer.
- The frontend imports shared runtime code through Vite aliases `@sdk` and
  `@sdk-docs`. Keep `vite.config.js` filesystem allowances aligned with them.
- API response or request changes require checking the matching frontend
  client/components and `marker-engine/api-client.js` when the engine consumes
  that endpoint.
- Trading or credential changes require the engine security tests and a review
  for secret leakage, authorization scope, transaction simulation, and safe
  recovery after restart.
- Changes to `marker-engine/` or `strategy-sdk/` may require a newly signed
  downloadable engine archive. Build it only through
  `crypto-data-collector/tools/build_engine_release.py`; never hand-edit the zip
  or manifest, invent signing keys, or expose the release private key.
- Keep legal/risk wording consistent between `docs/USER_GUIDE.md` and
  `crypto-charting-ui/src/legal/content.js` when product behavior changes.
- Reuse existing external-service accounts and configuration. Do not create,
  rotate, revoke, deploy, charge, move funds, or accept legal terms unless the
  user specifically authorizes that action.

## Local development

Use Python 3.12 and Node.js 22 to match CI.

- Whole stack on Windows: run `start.bat`, then use `http://localhost:5173`.
- Backend: from `crypto-data-collector`, install `requirements.txt` and run
  `python main.py`.
- Frontend: from `crypto-charting-ui`, run `npm ci` and `npm run dev`.
- Engine: from `marker-engine`, run `npm ci`, then `npm start`. Use
  `npm run setup`/`setup.bat` for interactive local credential setup.
- Environment files: copy the relevant `.env.example` locally, use only the
  services needed for the task, and never commit `.env` files or real values.
  Frontend-exposed settings must be non-secret `VITE_*` values.

## Verification

Run checks proportional to the files changed. Before a release or broad
cross-component change, run the complete CI-equivalent suite.

### Backend

From `crypto-data-collector/`:

```text
python -m compileall -q api database market_data tools
python -m pytest -q
```

For dependency/release work, also run `pip-audit -r requirements.txt`. For a
schema change, test `alembic upgrade head`, `alembic downgrade base`, and a
second `alembic upgrade head` against a disposable database.

### Frontend

From `crypto-charting-ui/`:

```text
npm run lint
npm run build
```

For dependency/release work, also run `npm audit --omit=dev`.

### Shared runtime and local engine

```text
cd strategy-sdk && npm test
cd marker-engine && npm test
```

Also run `npm audit --omit=dev` in `marker-engine/` for dependency/release work.
On Windows PowerShell, run these as separate commands rather than relying on
the shell syntax shown above.

## Working expectations

- Conserve task usage: identify the actual blocker, use the smallest relevant
  search scope, avoid repeating settled investigations, and run checks
  proportional to the change.
- Keep `ISSUES.md` limited to unresolved problems. Record the next concrete
  action and the evidence needed to call each problem fixed; remove an item once
  that evidence exists.
- Treat passing comments as context, not permanent restrictions. Use GitHub or
  any other relevant service when it materially advances the task, but stop a
  tool path when it is looping or no longer producing useful evidence.
- Keep progress updates to decisions, discoveries, blockers, and completed
  outcomes. Do not repeatedly explain settled details.
- Inspect the relevant code and documentation before changing behavior; do not
  rely on filenames or the generic frontend README alone.
- Prefer a focused, minimal change. Keep API, shared runtime, UI, engine, docs,
  tests, and migrations synchronized where the behavior crosses boundaries.
- Add or update regression tests for bug fixes and for changes to authentication,
  billing entitlements, database migration, strategy execution, sandboxing,
  transaction safety, backups, or production gates.
- Do not weaken or delete a safety check merely to make a failing test pass.
- Never print, commit, or copy secrets, wallet keys, seed phrases, connection
  keys, signing keys, tokens, live database contents, or credential blobs.
- Preserve unrelated user changes in the working tree. Do not perform
  destructive Git operations or rewrite history without explicit permission.
- Explain user-facing outcomes in plain language. When owner action is truly
  required, ask for the one specific approval/login/legal choice needed rather
  than handing the owner a technical checklist.
