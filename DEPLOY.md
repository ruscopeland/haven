# Deploying Haven — the click-by-click runbook

This is the exact, ordered checklist to put Haven online. It is written so you
(or a cheaper AI model in a later session) can follow it without guessing.
Where a step is "yours", it's clicking in a dashboard — no code. Where it's
"mine", the code is already in this repo and I point you at it.

Everything Haven's code needs is already built (see `SAAS-ROADMAP.md` phases
2–7). This file is the wiring guide.

**Read this whole file once before starting.** Then do it top to bottom.

---

## 0. The shape of what you're deploying

Four things run in the cloud (all one instance, shared by every customer):

| Service | What it is | Repo folder | Dockerfile |
|---|---|---|---|
| **Postgres** | the database | (Railway plugin) | — |
| **API** | FastAPI server | `crypto-data-collector` | `Dockerfile.api` |
| **Collector** | market-data feed | `crypto-data-collector` | `Dockerfile.collector` |
| **Paper-runner** | runs everyone's DRY strategies | `marker-engine` | `Dockerfile.paper-runner` |

One thing runs in the browser: the **web app** (`crypto-charting-ui`) on Vercel.

One thing customers download: the **desktop engine** (built from `marker-engine`
by `tools/build_engine_zip.py`, served by the API's `/engine/download`).

Accounts you need (all from `SAAS-ROADMAP.md` S1.2): GitHub, Railway, Vercel,
Clerk, Stripe.

---

## 1. Push the code to GitHub (yours, 10 min)

1. Create a **private** repo on GitHub (the code is your product).
2. From the repo root:
   ```
   git remote add origin https://github.com/<you>/haven.git
   git push -u origin main
   ```
3. Confirm on GitHub that **no `.env` files** and **no `crypto_data.db`** were
   pushed (the `.gitignore` already excludes them — verify once with your eyes).

---

## 2. Clerk — accounts/login (yours + 2 values I need)

1. In the Clerk dashboard, create an application (email + Google is fine).
2. Copy two values from **API Keys**:
   - **Publishable key** (`pk_test_…`) → web app env `VITE_CLERK_PUBLISHABLE_KEY`
   - The **Frontend API URL** / **JWKS URL**. In Clerk it's under
     **API Keys → Show JWT public key / JWKS**. You want the **JWKS URL**, which
     looks like `https://<your-app>.clerk.accounts.dev/.well-known/jwks.json`,
     and the **Issuer**, `https://<your-app>.clerk.accounts.dev`.
3. Hold these for steps 3 (API) and 4 (web app).

(Clerk's free tier covers 10,000 monthly active users — plenty to launch.)

---

## 3. Railway — database + API + collector + paper-runner (yours, ~40 min)

Railway hosts four services in one project. Do them in this order.

### 3a. Project + Postgres
1. New Project → **Deploy from GitHub repo** → pick your Haven repo.
2. In the project, **New → Database → PostgreSQL**. Railway creates it and a
   `DATABASE_URL` variable you'll reference below.

### 3b. API service
1. **New → GitHub Repo** (same repo) → this becomes the API service.
2. Settings → **Root Directory**: `crypto-data-collector`
3. Settings → **Build**: Dockerfile, path `Dockerfile.api`
4. Variables (Settings → Variables) — add:
   - `DATABASE_URL` = `${{Postgres.DATABASE_URL}}` (reference the plugin)
   - `CLERK_JWKS_URL` = the JWKS URL from step 2
   - `CLERK_ISSUER` = the issuer from step 2
   - `HAVEN_SOLO` = `0`
   - `HAVEN_CORS_ORIGINS` = `https://app.<yourdomain>` (set after step 4; use
     `*` temporarily if you must, tighten later)
   - `SERVICE_API_KEY` = a long random string you make up (e.g. run
     `python -c "import secrets;print('svc_'+secrets.token_urlsafe(32))"`).
     **The paper-runner must use this same value.**
   - `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, the four `HAVEN_PRICE_*` — add
     in step 5 (leave unset for now; billing endpoints just 503 until then).
   - `HAVEN_WEB_URL` = `https://app.<yourdomain>` (set after step 4)
5. Settings → **Networking → Generate Domain**. Note the URL, e.g.
   `https://haven-api-production.up.railway.app`. This is your API URL.

### 3c. Collector service
1. **New → GitHub Repo** (same repo) again → the collector service.
2. Root Directory: `crypto-data-collector`; Dockerfile: `Dockerfile.collector`
3. Variables: `DATABASE_URL` = `${{Postgres.DATABASE_URL}}` (that's all it needs).
4. No public domain needed (it only writes to the DB).

### 3d. Paper-runner service
1. **New → GitHub Repo** (same repo) → the paper-runner service.
2. Root Directory: **(leave as repo root)** — it needs `strategy-sdk` too.
3. Build: Dockerfile, path `marker-engine/Dockerfile.paper-runner`
4. Variables:
   - `HAVEN_API_URL` = the API URL from 3b step 5
   - `SERVICE_API_KEY` = the **same** value you set on the API
5. No public domain needed.

### 3e. First boot + data
1. Watch the API and collector deploy logs. The API prints
   `Database tables ensured on startup. SOLO_MODE=False`. The collector starts
   filling buckets within a minute.
2. (Optional) Seed history from your local DB so charts aren't empty on day one.
   From your PC, with the Postgres URL from Railway's Postgres → **Connect**:
   ```
   DATABASE_URL="postgres://…railway…" python tools/migrate_sqlite_to_postgres.py
   ```
   Add `--with-user-data` if you also want your own strategies/trades copied.

---

## 4. Vercel — the web app (yours, ~20 min)

1. Vercel → **Add New → Project** → import the same GitHub repo.
2. **Root Directory**: `crypto-charting-ui`
3. Framework preset: **Vite** (the included `vercel.json` sets build + SPA
   rewrites; accept defaults).
4. Environment Variables:
   - `VITE_API_URL` = the Railway API URL from 3b
   - `VITE_CLERK_PUBLISHABLE_KEY` = the `pk_…` from step 2
5. Deploy. You get a URL like `haven.vercel.app`. (Custom domain in step 6.)
6. Go back to the **API** service on Railway and set `HAVEN_CORS_ORIGINS` and
   `HAVEN_WEB_URL` to this web URL, then redeploy the API.

At this point: visit the web URL → you should see the **Haven landing page**,
be able to sign up with Clerk, and land on the **Subscribe** screen (no plan
yet). Billing comes next.

---

## 5. Stripe — payments (yours + I already wrote the endpoints)

The API already has `/billing/checkout`, `/billing/webhook`, `/billing/portal`,
`/billing/pricing`, `/billing/status`. You just create the products and paste
keys.

1. Stripe dashboard (start in **Test mode**). Create **one Product** ("Haven")
   with **four Prices** (Product → Add price, recurring):
   - Monthly **$10** → copy its price id → `HAVEN_PRICE_MONTHLY_EARLY`
   - Monthly **$20** → `HAVEN_PRICE_MONTHLY_STANDARD`
   - Yearly **$60** → `HAVEN_PRICE_ANNUAL_EARLY`
   - Yearly **$120** → `HAVEN_PRICE_ANNUAL_STANDARD`
   (The code auto-picks EARLY until 500 active subs, then STANDARD. It also
   grandfathers early subscribers because Stripe keeps billing the price they
   signed up on.)
2. **Developers → API keys** → copy the **Secret key** → API var
   `STRIPE_SECRET_KEY`.
3. **Developers → Webhooks → Add endpoint**:
   - URL: `https://<your-railway-api>/billing/webhook`
   - Events: `checkout.session.completed`,
     `customer.subscription.created`, `customer.subscription.updated`,
     `customer.subscription.deleted`
   - Create, then **reveal the signing secret** (`whsec_…`) → API var
     `STRIPE_WEBHOOK_SECRET`.
4. Set all six Stripe vars on the **API** service, redeploy.
5. Test: sign up on the web app → pick a plan → Stripe **test card**
   `4242 4242 4242 4242`, any future date/CVC → you should return to the app
   **subscribed**, the terminal now loads, and Settings → Subscription shows
   "Active".

When you're ready for real money: redo keys/webhook in Stripe **Live mode**,
swap the four price ids + secret + webhook secret for their live versions.

---

## 6. Domain (yours, ~15 min + DNS wait)

1. Buy your domain (Cloudflare/Namecheap).
2. In **Vercel** → project → Domains → add `app.<yourdomain>`; Vercel shows one
   CNAME record — add it at your registrar.
3. In **Railway** → API service → Networking → Custom Domain → add
   `api.<yourdomain>`; Railway shows a CNAME — add it too.
4. Update env to the real domains and redeploy:
   - Vercel `VITE_API_URL` = `https://api.<yourdomain>`
   - API `HAVEN_CORS_ORIGINS` = `https://app.<yourdomain>`
   - API `HAVEN_WEB_URL` = `https://app.<yourdomain>`
5. In **Clerk** → Domains, add your production domain so login works there.

---

## 7. The desktop engine download (mine, one command)

1. Build the zip and let the API serve it:
   ```
   python tools/build_engine_zip.py
   ```
   This writes `crypto-data-collector/api/static/haven-engine.zip`. It's
   `.gitignore`d, so either build it in your deploy pipeline or run it and let
   the deploy include it. Simplest for now: build it locally and commit it once
   by force (`git add -f crypto-data-collector/api/static/haven-engine.zip`) so
   Railway ships it. (Later, a CI step rebuilds it per release — S5.3.)
2. A subscribed user goes to **Settings → Connect your engine**:
   - clicks **Download the engine (.zip)**,
   - clicks **Generate a connection key** (copies the one-time key),
   - unzips, runs `setup.bat`, pastes the key + their wallet private key,
   - runs `run.bat`. Their **Engine** health dot goes green and live trades fire
     from their machine.

The engine setup default API URL is `https://api.haven.trade` in
`marker-engine/setup.js` — change that constant to your real API domain before
building the zip (one line, `DEFAULT_API`).

---

## 8. Smoke test the whole thing (both)

1. Fresh browser / incognito → your app domain → sign up as a brand-new user.
2. Subscribe with the Stripe test card.
3. Create a strategy, set it **DRY** → within a couple of minutes the cloud
   paper-runner starts logging PAPER trades on it (Dashboard shows them).
4. Download + set up the engine on a Windows PC, generate a key, run it.
5. Place a **$5** manual buy from a token page → it fills on-chain and appears
   in Recent Trades. (This is the same real-money path you already tested.)
6. Confirm a **second** test account sees **none** of the first account's
   strategies/trades. (This is the per-user isolation from S2.2 — the whole
   product depends on it.)

If all six pass, Haven is live.

---

## 9. Env var reference (copy-paste checklist)

**API service (Railway):**
```
DATABASE_URL=${{Postgres.DATABASE_URL}}
CLERK_JWKS_URL=https://<app>.clerk.accounts.dev/.well-known/jwks.json
CLERK_ISSUER=https://<app>.clerk.accounts.dev
HAVEN_SOLO=0
HAVEN_CORS_ORIGINS=https://app.<yourdomain>
HAVEN_WEB_URL=https://app.<yourdomain>
SERVICE_API_KEY=svc_<random>
STRIPE_SECRET_KEY=sk_...
STRIPE_WEBHOOK_SECRET=whsec_...
HAVEN_PRICE_MONTHLY_EARLY=price_...
HAVEN_PRICE_MONTHLY_STANDARD=price_...
HAVEN_PRICE_ANNUAL_EARLY=price_...
HAVEN_PRICE_ANNUAL_STANDARD=price_...
```
**Collector service (Railway):** `DATABASE_URL=${{Postgres.DATABASE_URL}}`
**Paper-runner service (Railway):**
```
HAVEN_API_URL=https://api.<yourdomain>
SERVICE_API_KEY=svc_<random>   # SAME as the API's
```
**Web app (Vercel):**
```
VITE_API_URL=https://api.<yourdomain>
VITE_CLERK_PUBLISHABLE_KEY=pk_...
```

---

## 10. What is NOT done yet (honest gaps, post-launch)

These don't block a working paid product but are on the list (`SAAS-ROADMAP.md`
Phase 5–6):

- **Signed Windows installer.** The engine ships as a zip that needs Node
  installed, not a one-click signed `.exe` (S5.1/S5.4). Fine for a beta with
  people you talk to; buy a code-signing cert before a public push.
- **Lawyer-reviewed ToS/Privacy/Risk pages** (S1.4). Draft, then review before
  charging real money.
- **Sentry / uptime alerts / backup-restore test** (S6.3).
- **Auto-update for the engine** (S5.3) — today updating means re-downloading.

None of these stop you from onboarding real, paying beta users this week.
