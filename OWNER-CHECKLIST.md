# Owner checklist — everything YOU do to take haven.trading live

Written 2026-07-06. This is your half of the launch. My half (all code, all deploys,
all wiring) is covered by `DATA-ROADMAP.md` + `DEPLOY.md` and runs at machine speed —
**the only things that set the launch date are the items on this page and two outside
companies' verification queues (Stripe, and later the code-signing company).**

**How the split works:** anything that needs a human identity, a credit card, or
account ownership is yours. Everything else, you hand me a key/token and I do it
through that service's API — you never configure servers, DNS, webhooks, or products.
You paste values to me in a chat session on this PC; I store them only in `.env`
files that git never saves. Every token can be revoked/rotated in its dashboard at
any time — handing me a token is not permanent.

Already done ✅: domain **haven.trading** on Cloudflare; Railway, Stripe, Clerk
accounts created.

---

## The collection list (what you're gathering — the whole point of this page)

| # | From | Value(s) to paste to me |
|---|------|------------------------|
| 1 | Stripe | Secret key — **test mode** now (`sk_test_…`), **live mode** later (`sk_live_…`) |
| 2 | Alchemy | 1 API key |
| 3 | QuickNode | BSC endpoint HTTP + WSS URLs (fallback provider) |
| 4 | Railway | 1 project token |
| 5 | Cloudflare | 1 API token + your Account ID |
| 6 | Clerk | Publishable key (`pk_test_…`) + Secret key (`sk_test_…`) |
| 7 | DeepSeek | 1 API key (for the AI assistant feature) |
| 8 | GitHub | nothing to copy — we do a 30-second approval together in a session |

Do the steps below in order (step 1 first — it has the longest outside wait), then
start a session and say **"here are the keys"** and paste them. Partial is fine;
hand me 2–3 at a time as you get them and I work with what exists.

---

## Step 1 — Stripe: finish activation + copy the test key (~15 min + their review wait)

Activation is the one step with a real outside wait (they verify your identity and
bank details — can be minutes, can be days). Start it first.

1. dashboard.stripe.com → complete **"Activate payments"**: business type
   *Individual/Sole proprietor* is fine to start, your details, your bank account.
2. While that reviews, you can already get the TEST key: make sure the dashboard
   shows **Test mode** (toggle, top right) → **Developers → API keys** → reveal
   **Secret key** (`sk_test_…`) → copy. **COLLECT #1a.**
3. When activation is approved (they email you): switch to **Live mode** → same
   place → copy the live Secret key (`sk_live_…`). **COLLECT #1b** (later is fine).

I use the key to create the Haven product, the four prices ($10/$20 monthly,
$60/$120 annual — the early prices auto-retire at 500 subscribers, as planned), and
the payment webhooks. You never touch those screens.

## Step 2 — Alchemy: the market-data node provider (~5 min, no card)

This replaces Binance as the raw data source — one account covers all four chains.

1. alchemy.com → Sign up (free tier, no card).
2. **Create app** → name it `haven-data` → on the app's **Networks** setup, enable:
   **BNB Smart Chain**, **Ethereum**, **Base**, **Solana** (Mainnet each).
3. Copy the app's **API key** (one string works across the networks). **COLLECT #2.**
4. Don't add a card yet. My ingester logs its real usage in week one; if it exceeds
   the free 30M compute units/month I'll tell you the exact number and the plan to
   click (budget expectation: $0–50/mo, worst case ~$120 before tuning).

## Step 3 — QuickNode: the fallback provider (~3 min, no card)

If Alchemy hiccups, the collector fails over instead of going dark.

1. quicknode.com → Sign up (free tier).
2. **Create endpoint** → chain **BNB Smart Chain** → Mainnet → free plan.
3. Copy both URLs it shows (HTTP `https://…` and WSS `wss://…`). **COLLECT #3.**

## Step 4 — Railway: card + project + token (~5 min)

1. railway.app → your account → **add a payment card** (expected bill $10–30/mo).
2. **New Project** → *Empty project* → rename it `haven`.
3. In the project: **Settings → Tokens → Create token** (any name, environment
   *production*) → copy it. **COLLECT #4.**

With that token I create the Postgres database and the three services (API,
collector, paper-runner), set every environment variable, and deploy — the whole
DEPLOY.md §3, without you clicking any of it.

## Step 5 — Cloudflare: one API token + support email (~7 min)

1. dash.cloudflare.com → click the **haven.trading** site → on the Overview page's
   right side, copy the **Account ID**. **COLLECT #5a.**
2. Top-right person icon → **My Profile → API Tokens → Create Token** → start from
   the **"Edit zone DNS"** template → under *Zone Resources* pick **haven.trading**
   → **+ Add more** permissions: **Account → Cloudflare Pages → Edit** → Continue →
   Create → copy the token. **COLLECT #5b.**
   (This lets me publish the website and set the DNS records myself.)
3. Support email, free: site → **Email → Email Routing → Get started** → create
   address `support@haven.trading` → forward to `ruscopeland@gmail.com` → click the
   verification link they email you. Done — customers can reach you, and Stripe/
   Clerk settings get a professional address.

## Step 6 — Clerk: the login system (~5 min)

1. dashboard.clerk.com → **Create application** → name `Haven` → sign-in options:
   enable **Email** (code sign-in). Skip Google for launch — it needs an extra
   Google Cloud setup; we can add it any time later.
2. After it creates: left sidebar **API Keys** → copy **Publishable key**
   (`pk_test_…`) and **Secret key** (`sk_test_…`). **COLLECT #6.**
3. Later, when I say "Clerk production is ready": you'll click **Add domain**
   (haven.trading) in Clerk if it asks for a confirmation only you can give — I
   prepare the DNS records it needs via the Cloudflare token first.

## Step 7 — DeepSeek: the AI assistant's brain (~5 min)

1. platform.deepseek.com → sign up → **Top up $5** (its per-use costs are tiny;
   $5 lasts a long time and it's metered to paying subscribers only).
2. **API Keys → Create** → copy. **COLLECT #7.**

## Step 8 — GitHub: code's cloud home (~3 min + 30 sec together)

1. github.com → create an account (free) if you don't have one.
2. That's it alone. In our next session I run the login handshake: I give you a
   short code and a github.com link, you type the code, click Approve — then I
   create the **private** repo and push the code myself, and verify no secrets
   went up.

## Step 9 — optional but recommended, can be after launch (~5 min each)

- **Sentry** (sentry.io, free): emails us the exact error when any user hits a bug.
  Sign up → create project (Python) → copy the **DSN** value to me.
- **UptimeRobot** (uptimerobot.com, free): emails you if the site/API goes down.
  Sign up and tell me — I'll give you the two URLs to paste into its "add monitor".

---

## The two genuinely slow outside items (start them, don't wait on them)

- **Code-signing certificate** (~$100–400/yr, identity verification takes days to
  weeks). Without it, Windows shows "unknown publisher" when customers install the
  engine. The engine currently ships as a zip anyway (works fine for beta users you
  talk to); buy the cert when you're ready to market to strangers. I'll hand you a
  vendor comparison when you ask.
- **Lawyer review** of the Terms/Privacy/Risk pages. I draft them and wire them into
  signup; a few hundred dollars of review is strongly recommended **before charging
  strangers real money**. Your risk call on timing. (The old "Binance data
  redistribution" lawyer question is dead — we serve our own chain-derived data now.)

---

## What I do with the pile (my half, for your reference)

Data independence first (`DATA-ROADMAP.md` M1–M9: Binance out, our own multichain
feed in — needs #2/#3), then the full cloud deploy (`DEPLOY.md`: push code, stand up
Postgres + API + collector + paper-runner on Railway — #4; publish the web app on
Cloudflare Pages at **haven.trading** and point **api.haven.trading** at Railway —
#5; wire logins — #6; create products/prices/webhooks in Stripe — #1; AI assistant —
#7), build the downloadable engine zip pre-set to api.haven.trading, set your own
account as unlimited owner, and run the full smoke test with a fresh test account.

## The final walkthrough — how you'll know it's done

1. Visit **haven.trading** in a normal browser → landing page loads.
2. Sign up with a fresh email → subscribe with Stripe's test card
   `4242 4242 4242 4242` → the terminal opens.
3. Create a strategy → **Deploy (paper)** → within minutes the cloud runner logs
   PAPER trades with your PC's stack completely off.
4. Settings → **Download the engine** → set it up on your PC with a generated
   connection key → place a **$5** real buy from a token page → it fills on-chain
   and shows in Recent Trades.
5. I verify a second account sees none of the first account's data, and hand you a
   written smoke-test report.
6. Flip Stripe to live mode (you copy the live key, I re-point products/webhooks) —
   Haven is open for paying subscribers.

Your own daily trading never moves: the local solo stack keeps running through all
of this, and after cutover it runs on our own data feed.
