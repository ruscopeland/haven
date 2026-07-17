# Haven Desktop — Complete Launch Handoff

**Read this first in the new session.** You are responsible for completing
everything below. Do not stop until the landing page is live, the cloud
service is deployed, the desktop app is downloadable with integrity checks,
and the advertising campaign is planned and launched.

## What we're building

Haven is a desktop crypto trading strategy workspace. Everything runs on the
user's machine — Binance Alpha market data (free, no keys), strategy
backtesting, paper/live trading, wallet keys in OS encrypted storage. The
cloud only handles three things: subscription verification (Clerk + Stripe),
AI assistant (DeepSeek proxy), and signed updates.

## Current state

Two new projects built in this session, plus the existing frontend:

### `haven-desktop/` — Desktop app (Go + React + Wails)
Fully functional. Single .exe, double-click to run. Currently on GitHub
Releases at `v1.0.0-desktop`. All of this works:

| Package | Status |
|---|---|
| `engine/indicators` | 14 indicators, 7 tests |
| `engine/backtest` | Single-symbol backtester, 11 tests |
| `engine/finder` | Token ranking, forward returns, hysteresis |
| `engine/runtime` | goja JS sandbox for user strategies |
| `internal/db` | SQLite store (strategies, finders, trades, candles) |
| `internal/api` | Local HTTP API on :8000 (20+ endpoints) |
| `internal/market` | Binance Alpha client (BAPI, ALPHA_1011USDT format) |
| `internal/trading` | Trading engine + strategy runner |
| `internal/credentials` | DPAPI (Win) / keyring (Unix) |
| `cmd/haven` | Wails v3 desktop shell, 1400x900 webview |

Release binary: https://github.com/ruscopeland/haven/releases/tag/v1.0.0-desktop
Build command: `powershell -File build.ps1` from `haven-desktop/`
Branch: `desktop-rewrite` (NOT main)

### `haven-cloud/` — Cloud service (Go)
Compiles but NOT deployed. Three endpoints needed:

| Endpoint | Purpose |
|---|---|
| `POST /v1/subscription/verify` | Clerk JWT → subscription tier + limits |
| `POST /v1/assistant/chat` | DeepSeek LLM proxy |
| `GET /v1/releases/{version}/{platform}` | Signed update downloads |

### `crypto-charting-ui/` — React frontend
Shared between desktop app and landing page. Desktop mode entry is
`src/desktop.jsx`. Web app entry is `src/main.jsx`.

Key files added this session:
- `src/desktop.jsx` — desktop mode entry (subscription gate, localhost API)
- `desktop.html` — Vite entry for desktop builds
- `src/components/Screener.jsx` — client-side sort fix (useMemo)
- `src/authFetch.js` — no-op in desktop mode

## What needs to be done (in order)

### 1. Build the landing page at haven.trading

Create a new Vite entry `landing.html` and `src/landing.jsx` in
`crypto-charting-ui/`. This is a PUBLIC marketing page — no Clerk, no auth.

Sections needed:
- **Hero**: "Haven — Crypto Research & Strategy Workspace" with tagline
  "Your keys. Your computer. Your edge." Download button.
- **Features**: Backtesting, Token Finder, paper/live trading, local wallet
  encryption. Three-column grid with icons.
- **How it works**: Three steps — Download, Connect Binance, Trade.
- **Pricing**: Starter ($9/mo), Pro ($29/mo), Advanced ($79/mo). Link to
  Clerk sign-in for subscription management.
- **Safety**: "Wallet keys never leave your computer. Strategy code runs in
  a sandbox. Only you control your funds."
- **Footer**: Terms, Privacy, Risk Disclosure, Contact.

The download button links to the latest GitHub Release:
`https://github.com/ruscopeland/haven/releases/latest/download/haven-desktop.exe`

Build with:
```
cd crypto-charting-ui
cp landing.html index.html
VITE_BUILD_ID=$(git rev-parse --short HEAD) npm run build
git checkout index.html
```

Deploy to Cloudflare Pages:
```
npx wrangler pages deploy dist --project-name haven --commit-dirty
```

Wrangler is signed in as ruscopeland@gmail.com with pages:write scope.
Cloudflare Pages project name: haven. Domain: haven.trading (already
configured in Cloudflare DNS).

### 2. Deploy haven-cloud to Railway

Railway project: haven (ID: 28ad7d1e-51bd-4df4-b47c-2bd9ee65b827)
Railway environment: production (ID: 51044258-3ee9-41f1-8f02-51fa62e85c3d)
Railway service: api (ID: 99c398a9-5acf-4d70-bed8-212ba0b3af8e)

The Railway project token is in GitHub secrets (production environment)
as `HAVEN_RAILWAY_PROJECT_TOKEN`. Never inspect or print its value.

Deployment approach — create a new GitHub Actions workflow at
`.github/workflows/deploy-cloud.yml`:

```yaml
name: Deploy cloud service
on:
  push:
    branches: [desktop-rewrite]
    paths: [haven-cloud/**]
  workflow_dispatch:

jobs:
  deploy:
    runs-on: ubuntu-latest
    environment: production
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-go@v5
        with: { go-version: '1.22' }
      - name: Build
        working-directory: haven-cloud
        run: CGO_ENABLED=0 go build -ldflags="-s -w" -o server ./cmd/server/
      - name: Deploy to Railway
        uses: railwayapp/railway-deploy@v1
        with:
          railway_token: ${{ secrets.HAVEN_RAILWAY_PROJECT_TOKEN }}
          service: api
```

The cloud service needs these env vars configured in Railway (set them
in the Railway dashboard under the `api` service → Variables):
- `CLERK_SECRET_KEY` — already exists from old API deployment
- `CLERK_PUBLISHABLE_KEY` — already exists
- `DEEPSEEK_API_KEY` — already exists
- `RELEASE_PUBLIC_KEY` — the Ed25519 public key matching the release signing key
- `RELEASE_DIR` — path where release files are stored (e.g., `/app/releases`)
- `PORT` — 8080

### 3. Add program integrity checking

Add a build hash to the desktop app that gets sent during subscription
verification. The cloud service checks it against known good builds.

**Desktop app changes** (`cmd/haven/main.go`):
- Add `var BuildHash = "dev"` variable
- Set it via `-ldflags "-X main.BuildHash=$(git rev-parse HEAD)"` during build
- In the subscription verification call, include `build_hash` in the request

**Cloud service changes** (`internal/subscription/verify.go`):
- Accept `build_hash` field in the verify request
- If it doesn't match the latest known hash, include `build_warning` in response
- Desktop app shows the warning text when `build_warning` is present

**Desktop app UI** (`src/desktop.jsx`):
- If subscription response includes `build_warning`, show a banner:
  "This version of Haven could not be verified. Only download Haven from
  haven.trading. Unverified software can steal your wallet keys."
- User can dismiss and continue

### 4. Sign releases with the existing Ed25519 key

The private signing key is DPAPI-protected at:
`%LOCALAPPAID%\Haven\engine-release-signing.dpapi`

Check status: `python crypto-data-collector/tools/engine_release_key.py status`

Update `haven-desktop/build.ps1` to:
1. Build the Go binary
2. Compute SHA256 hash
3. Create manifest JSON with version, platform, filename, sha256
4. Sign manifest with the release key (use engine_release_key.py)
5. Upload binary + manifest + signature to GitHub Release

### 5. Desktop app subscription check

Currently the desktop app returns `app_access: true` unconditionally
(dev mode). For production:

- Add `HAVEN_CLOUD_URL` env var to the desktop build (default:
  `https://api.haven.trading`)
- On launch, call `POST {cloud_url}/v1/subscription/verify` with the
  Clerk session token
- Cache the result locally in SQLite
- Re-verify every 15 minutes
- If subscription is not active, show the locked screen

The Clerk session token: the user signs in via the Clerk component
embedded in the landing page. After sign-in, they get a session JWT.
The desktop app stores this JWT (in DPAPI/keyring) and sends it with
verification requests.

### 6. Advertising campaign

Once the landing page is live and the desktop app is downloadable with
subscription verification working:

**Immediate (week 1):**
- Reddit: Post in r/cryptocurrency, r/defi, r/CryptoCurrencyTrading.
  "I built a desktop crypto strategy workspace that keeps your keys
  local. Looking for feedback."
- Twitter/X: Create @HavenTrading account. Pin the landing page.
  Follow crypto traders, engage genuinely. Post daily.
- Discord: Join crypto trading servers. Don't spam — answer questions
  helpfully and mention Haven when relevant.

**Week 2-3:**
- YouTube: Record a 60-second demo — backtesting a strategy, running
  a finder, executing a paper trade. Post on the Haven channel.
- Product Hunt: Launch with the demo video. Prep a maker comment
  explaining the problem (centralized trading platforms, key custody
  risk) and how Haven solves it.
- SEO: Basic meta tags on the landing page. Submit to Google Search
  Console. Target "crypto backtesting tool", "defi strategy builder",
  "binance alpha scanner" as initial keywords.

**Week 4+:**
- Affiliate/referral program: Give existing users a referral link.
  One free month per paid signup.
- Content: Write 3 blog posts — "How to Backtest a Trading Strategy",
  "Token Finders Explained", "Paper Trading Before Real Money".
- Email: Collect emails on the landing page. Weekly digest of new
  features, market insights, strategy ideas.

**Budget:** $0 for organic. If organic gains traction, allocate
$200-500/month for targeted Reddit ads and Google Ads on "crypto
trading bot" and "defi strategy" keywords.

## Files you'll create

| File | Purpose |
|---|---|
| `crypto-charting-ui/landing.html` | Vite entry for landing page |
| `crypto-charting-ui/src/landing.jsx` | Landing page component |
| `.github/workflows/deploy-landing.yml` | Deploy landing to Cloudflare Pages |
| `.github/workflows/deploy-cloud.yml` | Deploy haven-cloud to Railway |
| `haven-desktop/internal/integrity/` | Build hash and verification |

## Verification checklist

Before considering this complete, confirm:
- [ ] Landing page loads at haven.trading with download button
- [ ] Download button links to working GitHub Release
- [ ] haven-cloud deployed and responding at api.haven.trading/health
- [ ] `/v1/subscription/verify` accepts Clerk JWT and returns entitlement
- [ ] `/v1/assistant/chat` proxies to DeepSeek successfully
- [ ] Desktop app build includes integrity hash
- [ ] Cloud service checks integrity hash and returns warning
- [ ] Signed release available on GitHub Releases
- [ ] Build pipeline documented and reproducible
- [ ] Advertising campaign planned with specific dates and channels

## Important notes

- The desktop branch is `desktop-rewrite`. Work there, not `main`.
- The release binary is at haven-desktop/bin/haven-desktop.exe
- Cloudflare Wrangler is signed in (ruscopeland@gmail.com, pages:write)
- Railway token is in GitHub secrets — use GitHub Actions to deploy
- DeepSeek API key is in existing Railway environment variables
- Clerk secret and publishable keys are in existing Railway env vars
- Never write secrets into files, logs, or environment variables in this repo
- User's wallet keys never leave their computer — this is the core promise
- The screener had a sorting bug fixed in Screener.jsx — useMemo sort
- The old DB at ~/.haven/haven.db must be deleted when schema changes
