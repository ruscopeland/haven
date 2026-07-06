# SaaS Master Plan — "Haven", from personal tool to paid product

**This is the ONE plan.** It supersedes ROADMAP.md Phase F, absorbs the two leftover
items from the old roadmap (D2 — done 2026-07-05; E3b — now task S6.1), and replaces
every earlier "future/multi-user" note scattered across the repo. When this file and an
older note disagree, this file wins. Written 2026-07-05.

> ## ⚡ BUILD STATUS — 2026-07-06 (product name: **Haven**, $10/mo → $20 after 500 users,
> annual $60 → $120, no free tier)
>
> **All the CODE for Phases 2–5 and 7 is written, committed (`9fc92c9`), and tested.**
> The app is multi-user, key-free, Clerk-authenticated, Stripe-billed, and ships a
> downloadable engine. What remains is **not code** — it is YOUR account setup + the
> deploy clicks, all scripted step-by-step in **`DEPLOY.md`**. Follow that file top to
> bottom and Haven goes live.
>
> Done in code: Postgres support + per-user data isolation (verified: two users can't
> see each other, service key sees all, unpaid = 402); Clerk auth + engine API keys;
> Stripe checkout/webhook/portal + founding-500 pricing; cloud paper-runner; web
> Landing/Subscribe/Gate + Settings billing & engine-connect; Dockerfiles; sqlite→
> postgres migration; engine setup wizard + zip builder. Solo mode still runs the old
> local stack login-free.
>
> **2026-07-06 (later session): bot performance pages + bot-slot entitlements (S4.7)**
> are also code-complete and verified — every plan includes **3 bots** running at once
> (a bot = a strategy armed DRY or LIVE; saved strategies stay unlimited), extra slots
> sellable via `subscriptions.extra_bots` (Stripe add-on product = post-launch task),
> optional Stripe trial via `HAVEN_TRIAL_DAYS` env = **1 paper-only bot**. Solo mode is
> never limited.
>
> Honestly NOT done (post-launch, none block a paying beta): signed Windows installer
> (ships as a zip needing Node today), lawyer-reviewed legal pages, Sentry/uptime/backup
> tests, engine auto-update. Tracked in Phases 5–6 below and DEPLOY.md §10.
>
> **Your next move:** do Phase 1 (accounts/domain), then work `DEPLOY.md`.

The old ROADMAP.md stays in the repo as the historical record of Phases A–E (all done).
Work sessions keep the same protocol as before (WORKFLOW.md): one task per session,
commit before and after, task IDs now look like **S2.1** instead of B1.

---

## 1. The finished product — what we are building

Picture the end state. There are exactly **two things** in the final product:

**Thing 1 — Your cloud service (you rent servers; one copy serves every customer):**
- A website at your domain. The front page sells the product; behind the login is
  Alpha Terminal — the same charts, strategies, Token Finder, and dashboard you use
  today, except each customer sees only *their own* strategies, trades, and settings.
- Customers create an account (Clerk handles the login boxes, passwords, emails) and
  subscribe (Stripe handles the credit cards and monthly billing).
- Behind the website, in the cloud, run the pieces customers never see: the
  **collector** (one copy — market data is the same for everyone, so your costs do NOT
  grow per customer), the **API server**, the **database** (PostgreSQL — a database
  built for many users at once, replacing the single-file SQLite we use now), and a
  **paper-trading runner** that executes everyone's DRY strategies in the cloud so free
  and trial users can test-drive strategies without installing anything.

**Thing 2 — The downloadable engine (the ONLY thing that ships to customers):**
- A small Windows desktop app — the marker engine, packaged with a proper installer, a
  tray icon, and a little status window. A customer installs it, pastes in a
  "connection key" copied from their Settings page on the website, and enters their
  wallet's private key **which is stored encrypted on their own computer and never
  sent anywhere**. From then on, their live strategies and markers execute real trades
  from their own machine, with their own key, on their own IP address.

**Why this shape (the one big design decision):**
- You said it plainly: you will not hold customer keys. This architecture makes that a
  *feature*, not a limitation. "Your keys never leave your computer" is the strongest
  trust statement a trading product can make, and it keeps you out of the legal
  category of businesses that hold other people's money (custodians / money
  transmitters), which require licenses you do not want to need.
- It's also the smallest change to what already exists. The engine **already** talks to
  the API over plain HTTP — today the API happens to be on the same PC. Moving the API
  to the cloud and pointing the engine at it over the internet is exactly the design
  the reorg (Phases A–E) was quietly preparing for.

**The honest trade-off you must be comfortable selling:** a customer's computer must be
ON for their live trading to run. Paper trading runs in our cloud, so browsing,
backtesting, and DRY strategies work with their PC off — but live execution is on their
machine, because that's where their key is. We say this plainly on the website. (Down
the road there are fancy technologies to lift this limitation — "embedded wallets" run
by companies like Turnkey/Privy — but that is a version-2 discussion, not now.)

---

## 2. Who does what

**You (the owner):** business decisions and account clicking. Naming, pricing, the five
service accounts, the Stripe business/bank setup, DNS records, buying the code-signing
certificate, beta-tester wrangling, approving wording, and the final "go live" call.
Every one of your tasks below is a checklist of clicks — no code, ever. Where a
dashboard is confusing, we do it together in a session and I guide click-by-click.

**Me (your developer):** every line of code, the database migration, the deployment
configurations, the installer, the landing page, drafts of all legal/marketing text,
and testing my own work before telling you it's done.

---

## 3. The phases

Rough honest sizing: Phases 2–5 are about **15–25 work sessions** total. At a steady
pace that's 3–6 weeks. Phase 1 runs in parallel (it's you clicking, not me coding), and
Stripe account activation is the slowest external wait — start it first.

---

### Phase 1 — Business foundations (YOU, guided by me; no code; start now)

- [ ] **S1.1 (you) Name + domain.** Pick the product name (working title: Alpha
      Terminal — check nothing big already uses it) and buy the matching domain
      (~$10–15/year at Cloudflare or Namecheap). Everything else hangs off this.
- [ ] **S1.2 (you) Create the five accounts.** In this order, all free to open:
      1. **GitHub** — the cloud home for the code. Every hosting service deploys from
         it. (The repo goes up PRIVATE; the code is your product.)
      2. **Railway** — where the API, collector, paper-runner, and database will live.
      3. **Cloudflare** — where the website is served from (Pages) and ideally where
         the domain's DNS lives. (Switched from Vercel 2026-07-06 at the user's
         request: unlimited free static bandwidth means scrapers/bots can never run
         up a bill, built-in bot/DDoS protection, free plan allows commercial use.)
      4. **Clerk** — the login/accounts service.
      5. **Stripe** — the payments service. ⚠ START THIS FIRST-ish: activating a
         Stripe account means giving business details and a bank account, and their
         review can take days. Sole-proprietor is fine to start (an accountant can
         advise if an LLC is worth it for you — recommended question, not a blocker).
- [ ] **S1.3 (you decide, I advise) Pricing.** My recommendation to start:
      - **Free** — paper trading only (runs in our cloud), up to 2 strategies, no
        engine download. This is the funnel: people prove the strategies work risk-free.
      - **Pro, ~$29–49/month** — live trading (engine download), unlimited strategies
        and finders, the AI assistant. Pick one number; you can change it later and
        grandfather early users. Don't price cheap — this automates real trading.
- [ ] **S1.4 (me draft → you + a lawyer review) Legal basics.** I draft: Terms of
      Service, Privacy Policy, and a Risk Disclosure ("this is not financial advice;
      automated trading can lose all funds committed; software provided as-is").
      Before you charge real money, pay a lawyer a few hundred dollars to review these
      AND answer two specific questions I'm flagging honestly:
      1. Redistribution of market data derived from Binance's public streams to paying
         subscribers — exchanges have terms about this; a lawyer should eyeball it.
      2. Whether your state/country adds anything for non-custodial trading software.
- **Done when:** domain owned; all five accounts exist; Stripe fully activated (test
  payment possible); a price is chosen; legal drafts exist and a lawyer is booked.

---

### Phase 2 — Make the program multi-user (ME; everything still runs on your PC)

This is the biggest code phase. Nothing deploys yet — at the end of it, the stack still
runs from start.bat exactly like today (a "solo mode" switch keeps local use working
forever), but the code underneath can tell users apart.

- [ ] **S2.1 (me) Database: SQLite → PostgreSQL.** Plain English: SQLite is a single
      file designed for one person on one machine; Postgres is a database *server*
      designed for many users hitting it at once, and it's what every cloud host
      offers managed (they run it, back it up, keep it alive). The code already uses
      SQLAlchemy (a translation layer), so this is a careful port, not a rewrite. The
      known sharp edges get re-verified on Postgres: the collector's bucket upserts,
      the atomic marker claim (the exactly-once trade guarantee), and the /universe
      time-grouping math. A migration script copies your current data over — nothing
      is lost. Local dev uses Postgres via Docker Desktop.
- [ ] **S2.2 (me) Teach the data about users.** Every user-owned table (strategies,
      finders, markers, trades, engine settings, debug logs) gets a user column;
      market data stays shared. Every API endpoint answers only with the logged-in
      user's rows. Two test accounts must be provably invisible to each other.
- [ ] **S2.3 (me) Clerk login.** The web app gets Clerk's sign-in (their pre-built
      login screens — we don't build password handling, ever), and the API learns to
      check Clerk's proof-of-login token on every request. A "solo mode" environment
      switch keeps localhost working with no login for development.
- [ ] **S2.4 (me) Engine connection keys.** The website's Settings page gets a
      "Connect your engine" section that generates a one-time-shown key. The engine
      sends it with every request; the API knows which user it is. This also gives
      each user their own "Engine connected" health dot. (The engine can't use normal
      login screens — it's a background program; a pasted key is the standard answer.)
- [ ] **S2.5 (me) Cloud paper-trading runner.** The strategy-runner already inside the
      engine gets a second home: a cloud copy that runs *everyone's DRY strategies*
      centrally. No keys involved — paper trades are just database rows — so this is
      custody-safe. Result: free users test-drive strategies with nothing installed,
      and their paper trading doesn't stop when their PC sleeps. LIVE signals are
      untouched: those only ever execute on the user's own machine.
- [ ] **S2.6 (me) Traffic protection.** Rate limits (one misbehaving browser tab can't
      hammer us), CORS locked to our domain, and caching for candles/universe data —
      every user asks for the *same* market data, so we answer from memory instead of
      hitting the database every time. This is what keeps hosting cheap.
- [ ] **S2.7 (me) Re-run every test suite on Postgres** including the two parity gates
      (backtest-equals-live). The never-touch rules from ROADMAP.md still stand: the
      claim endpoint, the TTL logic, and chooseBinding keep their exact semantics.
- **Done when:** on my machine, two accounts share market data but have fully separate
  strategies/trades/settings; solo mode still works; all tests green on Postgres.

---

### Phase 3 — Move the data machine into the cloud (ME + ~30 min of you clicking)

- [ ] **S3.1 (me) Code to GitHub.** Private repo, secrets verified excluded (the
      .gitignore already blocks all .env files — I re-verify before the first push).
- [ ] **S3.2 (me, you add a payment card) Deploy to Railway:** Postgres database + API
      + collector + paper-runner, with environment variables (the cloud version of
      .env files) for every secret. Your part: create the Railway project under YOUR
      account and add a card (~$10–30/month at this stage — see cost table).
- [ ] **S3.3 (me) 24-hour soak test.** The cloud collector fills the cloud database
      around the clock; health endpoint watched by a free uptime monitor that emails
      you if anything goes down. Your PC gets turned OFF and data keeps flowing —
      that's the acceptance test, and honestly it's the first big *personal* win: your
      own trading stops depending on your PC staying awake for data.
- **Done when:** api.«yourdomain» serves live market data 24/7 with your PC off.

---

### Phase 4 — The website: login, payments, front door (ME + ~1 hr of you clicking)

- [ ] **S4.1 (me) Deploy Haven to Cloudflare Pages** at app.«yourdomain», pointed at
      the cloud API, behind the Clerk sign-in wall. (Vercel's free tier forbids
      commercial use — we go straight to their $20/mo Pro plan at launch time.)
- [ ] **S4.2 (me + you in dashboards) Payments — two routes, we try A first:**
      - **Route A (recommended): Clerk Billing.** Clerk has a built-in subscriptions
        feature that uses *your Stripe account* under the hood. You define Free and
        Pro in the Clerk dashboard; I drop their ready-made pricing table into the
        app; and "is this user a paying customer?" becomes a one-line check in both
        the website and the API. Fees: Stripe's normal ~2.9% + 30¢ per charge, plus
        0.7% to Clerk. Dramatically less code to write and maintain = fewer bugs in
        the money path.
      - **Route B (fallback): classic Stripe.** Stripe Checkout pages + "webhooks"
        (Stripe calling our API to say "this customer paid/cancelled") + our own
        subscription bookkeeping. More code, more control. We take this road only if
        Route A turns out to be missing something we need — I verify feature-fit in
        the first session of this phase before committing.
- [ ] **S4.3 (me) Feature gating.** Free: paper only, 2 strategies, no engine key
      generation. Pro: everything, engine download, AI assistant (its DeepSeek API
      calls cost us per-use, so it's metered and Pro-only).
- [ ] **S4.4 (me build, you approve) Landing page.** The public front door: what it
      does, real screenshots, pricing, FAQ, the risk disclaimer, sign-up button. You
      approve the wording — it's your voice.
- [ ] **S4.5 (me) Legal pages wired in** (ToS/Privacy/Risk from S1.4) + sign-up
      requires accepting them.
- [ ] **S4.6 (you) DNS records** pointing app. and api. at Cloudflare Pages/Railway (I give you
      the exact two records to paste), Clerk + Stripe dashboard setup (guided).
- [x] **S4.7 (me) Bot performance pages + bot-slot entitlements (2026-07-06).** The user's
      ask: each running strategy ("bot") must be analyzable in its own dedicated section,
      and running several at once must be a first-class, sellable feature.
      - **Per-bot performance page** in the charting UI: Dashboard strategy cards now open
        it (workbench editing moved to the card's ✎ / an "Edit strategy" button; the
        workbench gained "📊 Performance"). Paper and live records in separate sections;
        KPI cards, realized-PnL equity curve, the runner's exact kline series with every
        fill as an arrow, **click a trade in the history → the chart jumps to and
        highlights that fill** (klines gained `end_ms` for windows older than 1000 bars —
        verified Binance honors `endTime`), avg-cost line, open orders, per-token breakdown
        for finder-bound bots, failed executions. New `GET /strategies/{id}/performance`
        serves it in one call.
      - **Entitlements**: multiple bots always worked engine-side (one runner per armed
        strategy — verified); now the API enforces the business rule at arm time
        (PATCH mode): paid = 3 + `extra_bots`, trial = 1 paper-only (LIVE → 403), over
        cap → 409, solo/service unlimited. `/billing/status` reports
        max_bots/bots_running/live_allowed; Dashboard shows "N of M bots running";
        Landing/Subscribe/Settings copy updated. 10/10 gate tests pass (scratch-DB
        TestClient run: 409 at cap, dry→live flip not double-counted, slot freed on stop,
        trial live-block, extra_bots honored).
      - Verified in browser against a second API instance (:8001, `chart-preview-apitest`
        launch config + `crypto-charting-ui/.env.apitest`) with the real "drop buyer" DRY
        portfolio bot: 23 paper fills, PnL matches the status board, trade-click chart
        focus works, zero console errors. ⚠ Remaining for launch: Stripe add-on product
        for extra bot slots (until then `extra_bots` is set manually), and choosing
        whether to enable `HAVEN_TRIAL_DAYS`.
- **Done when:** a stranger can sign up, pay with Stripe's test card, and run a paper
  strategy end-to-end in their browser — no help from you.

---

### Phase 5 — The downloadable engine (ME; you test-install; the product's crown jewel)

- [ ] **S5.1 (me) Package the engine as a Windows app** using Electron (plain
      English: the standard way to ship a program like ours with a real installer, a
      tray icon, and a window — it bundles everything so customers never install
      Node/Python/anything). First-run setup wizard: paste connection key → enter or
      import wallet private key (stored encrypted via Windows' own credential vault,
      with a plain-worded screen: *"This key stays on this computer. We never see it.
      If you lose it, we cannot recover it. Use a dedicated trading wallet with only
      the funds you trade."*) → done.
- [ ] **S5.2 (me) Status window:** connected/paused dot, wallet address + balances,
      today's trades, big pause button, readable log. Deliberately no strategy editing
      here — the website is the brain, this is the hands.
- [ ] **S5.3 (me) Auto-update.** The app checks for new versions and updates itself.
      This is the "release channel" WORKFLOW.md promised: I publish a new version, all
      customer engines update; your git tags are the releases.
- [ ] **S5.4 (you buy, ~$100–400/yr) Code-signing certificate.** Without one, Windows
      shows every customer a scary "unknown publisher — Windows protected your PC"
      wall that kills sales. Beta can run unsigned (we tell testers to click through);
      public launch must be signed.
- [ ] **S5.5 (me) Engine safety rails for strangers:** risk caps come from the user's
      cloud settings with safe defaults ON; the untouchable trio (atomic claim, 120s
      TTL, chooseBinding) ships exactly as-is; first-run defaults to PAUSED until the
      user explicitly goes live.
- **Done when:** on a fresh Windows machine: download → install → paste two keys → a
  $5 LIVE test trade fires on-chain and appears on the website dashboard.

---

### Phase 6 — Professional polish (BOTH; this is where "polished" gets earned)

- [ ] **S6.1 (both) The UX pass — old task E3b, absorbed here, plus the two dashboard
      deep-link changes from `changes to be verified.md` get their formal once-over.**
      We walk every screen together: naming, empty states ("No strategies yet — create
      your first"), confirmation dialogs on anything LIVE, error messages a human can
      act on. Your eyes matter most here — you're the closest thing we have to a
      customer who didn't build it.
- [ ] **S6.2 (me) Onboarding.** First-login checklist (make a paper strategy → watch
      it trade → upgrade → connect engine), and the existing 📖 Guide panel grows into
      a real docs section.
- [ ] **S6.3 (me) Ops safety net.** Sentry (a service that emails us the exact error
      when any user hits a bug — before they even complain), uptime alerts on every
      service, and a monthly test that database backups actually restore.
- [ ] **S6.4 (you pick, me wire) Support channel.** support@«yourdomain» at minimum; a
      Discord server is the norm for trading products and doubles as community/
      marketing. Decide response expectations you can actually keep.
- [ ] **S6.5 (me) Security pass.** Dependency audit, a hostile-eyes review of every
      authenticated endpoint (can user A ever see user B's anything?), and a full
      /security-review of the branch.
- **Done when:** the stranger test — someone who has never seen the product gets from
  the landing page to their first paper trade with zero questions to you.

---

### Phase 7 — Beta, then launch (YOU lead, I fix)

- [ ] **S7.1 (you) Private beta.** 3–5 people you trust get free Pro. They install the
      engine, run DRY for days, then a $5 LIVE trade. Every confusion they hit is a
      bug — the list comes to me, I fix, repeat until quiet.
- [ ] **S7.2 (both) Launch checklist:** Stripe switched from test to live mode; signed
      installer published; monitoring green 7 straight days; backups restore-tested;
      legal pages lawyer-approved; prices final.
- [ ] **S7.3 (you) Go public.** Marketing is the ongoing owner-job: the crypto corners
      of X/Twitter, a YouTube walkthrough, Product Hunt. I draft copy and record-ready
      demo scripts whenever you want them.
- **After launch, the rhythm:** you watch support + community; I ship a weekly release
  (fixes first, features second); every release goes beta-channel first, then to all
  engines via auto-update.

---

## 4. What it costs to run (monthly, before you have customers)

| Thing | Cost | Notes |
|---|---|---|
| Domain | ~$1/mo ($10–15/yr) | Cloudflare/Namecheap |
| Railway (API + collector + runner + Postgres) | $10–30 | grows slowly with users |
| Cloudflare Pages (website) | $0 | unlimited static bandwidth, commercial use OK |
| Clerk (logins) | $0 | free to 10,000 monthly users |
| Stripe | $0 monthly | ~2.9% + 30¢ per charge (+0.7% if Clerk Billing) |
| Sentry + uptime monitor | $0 | free tiers are plenty |
| Code-signing cert | ~$10–35/mo equivalent | yearly purchase, Phase 5 |
| DeepSeek (AI assistant) | usage-based, small | metered, Pro-only |
| **Total** | **~$25–90/mo** | roughly 1–3 subscribers to break even |

---

## 5. Honest risks — read once, then we manage them

1. **Live trading needs the customer's PC on.** We say it plainly everywhere. Paper
   trading in the cloud softens it. V2 options exist (embedded wallets, VPS guides).
2. **Binance data terms.** We re-serve *derived* data (our own buckets/rankings) from
   Binance's public streams to paying users. Lawyer question, flagged in S1.4 — and if
   it ever bites, there are engineering outs (customers' engines already can fetch
   candles from Binance directly).
3. **Customers can lose real money.** Risk disclosure at signup, LIVE confirmations,
   risk caps ON by default, paper-first onboarding, and we never promise returns.
4. **Support is a real job.** Beta will tell us how heavy. Docs + Discord absorb most.
5. **Keys on customer machines.** Encrypted vault storage + loud guidance to use a
   dedicated trading wallet holding only what they trade. We cannot lose their keys —
   because we never have them. They must know we also cannot *recover* them.
6. **Your own trading continues** on the same platform as customer #0 — solo mode and
   your local setup keep working through every phase; nothing is broken to build this.

---

## 6. What happened to every old plan (reconciliation)

| Old item | Status | Where it lives now |
|---|---|---|
| ROADMAP.md Phases A–C, E1–E3a6 | ✅ done | history (tags v0–v2) |
| D1 — drop wallet auto-trade | ✅ decided 2026-07-05 | — |
| D2 — retire wallet app | ✅ **done 2026-07-05** (this session; tag v3-one-app) | — |
| E3b — UX pass with user | open | → **S6.1** |
| ROADMAP Phase F — multi-user | superseded | → **this whole file** |
| TOKEN-FINDER-PLAN.md | built 2026-07-03 | deleted; CLAUDE.md documents as-built |
| changes to be verified.md (2 dashboard deep-links) | code in place; strategy-card link click-tested 2026-07-05 | formal check → **S6.1** |
| Backlog: WS/SSE push, positions table, shared executeSwap | not launch-blocking | post-launch backlog |

---

## 7. Your immediate next steps (this week, ~2 hours total)

1. Pick the product name; buy the domain (S1.1).
2. Open the GitHub account (S1.2 #1) — needed before anything deploys.
3. **Start the Stripe application today** (S1.2 #5) — it has the longest wait.
4. Open Clerk, Railway, Cloudflare accounts (S1.2) — 5 minutes each.
5. Sleep on pricing (S1.3) and tell me a number.
6. Say the word, and my next session starts **S2.1** (the database port).

My next steps: S2.1 → S2.2 → S2.3, in order, one per session, same commit-and-verify
discipline as Phases A–E. When Phase 2 is done you'll see nothing different — that's
the point; the ground gets rebuilt under a working app without dropping it.
