# Haven Desktop — Advertising Campaign Execution Plan

**Status: READY TO EXECUTE**  
**Created: July 17, 2026**  
**Budget: $0 organic → $200-500/mo when traction justifies paid**

---

## Pre-flight Checklist

Before launching any advertising, confirm these are done (they are):

- [x] Landing page live at haven.trading
- [x] Download button links to GitHub Releases
- [x] SEO meta tags on landing page (description, keywords, OG, Twitter card)
- [x] Cloud service deployed (subscription verification works)
- [x] Signed desktop releases available

---

## Week 1: Organic Ground Game (Day 1-7)

### 1. Reddit — Post in these subreddits

**r/CryptoCurrency** (7.5M members)  
Post title: *"I built a desktop crypto strategy workspace that keeps your keys local. Looking for honest feedback."*

Body:
> Hey r/CryptoCurrency — I've been building Haven, a desktop app for crypto research and strategy automation. The core idea: everything runs on your computer. Your wallet keys are encrypted with your OS credential store. No cloud custody.  
>
> What it does:
> - **Backtesting**: Run strategies against historical Binance Alpha data
> - **Token Finder**: Write custom JS ranking code to scan tokens by momentum, volume, etc.
> - **Paper & Live Trading**: Same engine for both — paper-trade first, flip to live when confident
> - **14 built-in indicators**: SMA, EMA, RSI, MACD, Bollinger, ATR, OBV, and more
>
> It's free to download. Starter plan is $9/mo for live trading.  
> Landing page: https://haven.trading  
>
> I'd love feedback from people who actually trade. What's missing? What would make you switch from your current setup?

**r/defi** (500K members)  
Post title: *"Non-custodial desktop trading app — your keys never leave your machine"*

Body:
> Built a DeFi strategy workspace that runs locally. Key features for this community:
> - Wallet keys encrypted with OS-level DPAPI/Keychain — never touch a cloud server
> - Strategy code runs in a sandboxed JS VM with time/memory/capability limits
> - Source available, build it yourself if you want
> - Uses Binance Alpha data (free, no API key needed to start)
>
> https://haven.trading

**r/CryptoCurrencyTrading** (200K members)  
Post title: *"Show HN-style: Desktop backtesting + trading app — looking for beta testers"*

### 2. Twitter/X — @HavenTrading

Register the handle @HavenTrading on Twitter/X.

**Pin this tweet:**
> Haven — Crypto Research & Strategy Workspace  
> Your keys. Your computer. Your edge.  
> Download free: haven.trading  
> 
> • Backtesting • Token Finder • Paper & Live Trading  
> • Wallet keys encrypted locally • Binance Alpha data  
> • $9/mo Starter • 7-day free trial

**Daily posting plan (7 days):**
1. Day 1: Pin tweet + introduction thread (3 tweets: problem, solution, call to action)
2. Day 2: Screenshot of backtest equity curve + short explanation
3. Day 3: "Why I built a desktop app instead of a web dashboard" — thread about security
4. Day 4: Token Finder demo — scan 200 tokens in 30 seconds
5. Day 5: Engage with 20 crypto traders (reply thoughtfully, don't pitch)
6. Day 6: "Paper trading before real money — why it matters" thread
7. Day 7: Retweet positive feedback, share development roadmap

**Follow list to build:** Follow 200-300 crypto traders, analysts, and DeFi builders. Engage genuinely with their content.

### 3. Discord — Join these servers

Join as @Haven or your personal account:
- r/CryptoCurrency Discord
- r/defi Discord
- TradingView Discord
- Binance Discord
- Any active crypto trading servers you find

**Rules for Discord:**
- Never DM unsolicited links
- Answer questions helpfully in #help or #trading channels
- Mention Haven naturally when someone asks "what tools do you use?"
- Wait until you've been active for a few days before mentioning Haven

---

## Week 2-3: Content & Launch (Day 8-21)

### 4. YouTube — Record a 60-second demo

**Script outline:**
```
[0:00] "This is Haven. Desktop crypto strategy workspace."
[0:05] Show landing page → download button
[0:10] Open app, show strategy backtest (equity curve appearing)
[0:20] Switch to Token Finder — rank 200 tokens by momentum
[0:30] Open a strategy, show the JS code editor
[0:40] "Paper trade first..." → execute paper trade
[0:50] "When you're confident, flip to live. Your keys. Your computer. Your edge."
[0:55] haven.trading — download free
```

Record with OBS (free). Upload to YouTube channel "Haven Trading."

### 5. Product Hunt — Launch

**Launch date:** Day 14 (pick a Tuesday/Wednesday/Thursday — never Monday or Friday)

**Tagline:** "Haven — Desktop crypto strategy workspace. Your keys. Your computer. Your edge."

**Maker comment:**
> Hey Product Hunt! I built Haven because I was tired of:
> 1. Web-based trading platforms that hold your API keys on their servers
> 2. "No-code" strategy builders that lock you into their ecosystem
> 3. Paying $50-200/mo for basic backtesting features
>
> Haven runs entirely on your computer. Your Binance keys? Encrypted with your OS keychain. Your strategies? JavaScript you can read and modify. Your funds? You hold them — Haven just executes your logic.
>
> Tech stack: Go + React + Wails (desktop), Binance Alpha (market data), Ed25519 (release signing).
>
> Pricing: Starter $9/mo, Pro $29/mo, Advanced $79/mo. 7-day free trial.
>
> I'm here all day — AMA about building desktop crypto tools, Binance Alpha integration, or why I chose to build locally instead of in the cloud.

**PH launch checklist:**
- [ ] Upload icon (512x512 PNG)
- [ ] Upload 3-5 screenshots (backtest, finder, strategy editor, dashboard)
- [ ] Upload demo video (YouTube link)
- [ ] Set category: Crypto & Blockchain
- [ ] First comment ready (maker comment above)
- [ ] Share launch link on Twitter, Reddit, Discord 1 hour after launch

### 6. SEO — Submit to Google Search Console

1. Go to https://search.google.com/search-console
2. Add property: https://haven.trading
3. Verify ownership (DNS TXT record in Cloudflare)
4. Submit sitemap: https://haven.trading/sitemap.xml (create if not exists)
5. Request indexing of https://haven.trading

**Target keywords (already in meta tags):**
- "crypto backtesting tool"
- "defi strategy builder"  
- "binance alpha scanner"
- "crypto trading desktop app"

---

## Week 4+: Growth & Content

### 7. Blog Posts (publish on haven.trading/blog)

**Post 1: "How to Backtest a Trading Strategy"**
- What backtesting is and why it matters
- Common pitfalls (look-ahead bias, survivorship bias, overfitting)
- Walkthrough using Haven's backtester
- Real example: SMA crossover on BNB/USDT

**Post 2: "Token Finders Explained"**
- What a token finder/ranker is
- Why volume + momentum beats gut feeling
- How Haven's hysteresis reduces noise
- Code example: ranking by 24h volume change

**Post 3: "Paper Trading Before Real Money — Why It Matters"**
- The psychology gap between paper and live
- How to transition: paper → small live → full live
- Haven's DRY mode: identical engine, zero risk
- Signs you're ready to go live

### 8. Email Collection

Add a newsletter signup to the landing page footer:
> "Get weekly strategy ideas, market insights, and Haven updates. No spam."

Use a free tier of Buttondown or ConvertKit.

**Weekly digest content:**
- 1 market insight (what moved this week)
- 1 strategy idea with code snippet
- 1 Haven tip (lesser-known feature)
- 1 community highlight

### 9. Referral Program

Add to the subscription page:
> "Refer a friend → they get 7-day trial, you get 1 month free when they subscribe."

Implementation: unique referral codes stored in Clerk user metadata.

### 10. Reddit Ads (when $200-500/mo budget approved)

Target subreddits: r/CryptoCurrency, r/defi, r/CryptoCurrencyTrading, r/ethdev

**Ad copy A (problem-focused):**
> Tired of web platforms holding your API keys? Try Haven — desktop crypto workspace. Your keys, your computer. Free download.

**Ad copy B (feature-focused):**
> Backtest strategies. Scan tokens. Paper trade. Go live. All from your desktop. Haven — download free at haven.trading

**Google Ads keywords (when budget approved):**
- "crypto trading bot"
- "defi strategy builder"  
- "crypto backtesting software"
- "binance trading bot desktop"
- "automated crypto trading"

---

## Success Metrics (track weekly)

| Metric | Week 1 | Week 2 | Week 4 | Week 8 |
|--------|--------|--------|--------|--------|
| Landing page visitors | Baseline | +50% | +100% | +200% |
| GitHub Release downloads | Baseline | +30% | +50% | +100% |
| Twitter followers | 0 → 50 | 100 | 300 | 500+ |
| Discord server members | 0 → 20 | 50 | 100 | 200+ |
| Reddit post upvotes | 20+ | 50+ | — | — |
| Product Hunt upvotes | — | 100+ | — | — |
| YouTube views | — | 500 | 1K | 2K |
| Email subscribers | — | 50 | 200 | 500 |
| Trial signups | Baseline | +20% | +50% | +100% |

---

## This document is done when

- [ ] @HavenTrading Twitter account created and pinned tweet live
- [ ] Reddit posts published in r/CryptoCurrency, r/defi, r/CryptoCurrencyTrading
- [ ] Joined 5+ Discord crypto trading servers
- [ ] YouTube demo video recorded and uploaded
- [ ] Product Hunt launch submitted
- [ ] Google Search Console property verified
- [ ] Blog section planned on landing page
- [ ] Referral program designed
