# Haven

Haven is a non-custodial crypto strategy workspace. The hosted service supplies licensed Binance Alpha data, authentication, subscriptions, strategy storage, and operations visibility. One signed desktop engine runs both paper and live strategies; live private keys stay encrypted in the trader's Windows DPAPI store or Linux desktop keyring.

## Product architecture

- **Market data:** Binance Alpha Startup REST and WebSocket APIs only. Static metadata and closed candles are cached; current prices and on-chain candles stream through the server and reconcile through REST after gaps.
- **Trading:** the same local engine runs paper (`dry`) and live modes. There is no shared cloud paper runner.
- **Access:** every new account receives one automatic seven-day trial. Starter, Pro, and Advanced limits, prices, and Clerk slugs are environment-configurable.
- **Safety:** strategy code is versioned and must be explicitly approved for live use. Browser evaluation runs in a disposable worker; engine evaluation runs across a hardened VM bridge. Transactions are validated and simulated before signing, then durably reconciled.
- **Operations:** `/owner` is private to configured owner IDs and reports Binance Alpha usage, stream health, database migration state, backups, subscriptions, engine credentials, pending transactions, and launch gates.

See [Production runbook](docs/PRODUCTION_RUNBOOK.md) for deployment and [User guide](docs/USER_GUIDE.md) for the product workflow.
For the signed Windows/Linux engine release handoff, see [engine release operations](docs/ENGINE_RELEASE_OPERATIONS.md).

## Local development

Copy `crypto-data-collector/.env.example` to a local environment file outside source control and fill only the services you are testing. Run `start.bat` to open the API, desktop engine, and web app. Development may use SQLite; production deliberately refuses to start without hosted PostgreSQL and all safety gates.

Verification commands are encoded in `.github/workflows/production-checks.yml` and should remain green before release.
