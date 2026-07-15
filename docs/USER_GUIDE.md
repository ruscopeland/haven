# Haven user guide

**Effective reference:** July 13, 2026

This guide matches the in-app **Docs** page. Haven is software for research and strategy tooling — not investment advice.

---

## Welcome to Haven

We do not give investment, trading, or financial advice. We do not promise you will make money.

Haven helps you research tokens, build strategies, backtest, paper-trade, and optionally execute with a **desktop engine that keeps private keys on your computer**.

- **You** pick tokens and rules.  
- **You** control keys.  
- **You** own outcomes.  

The subscription helps cover **shared market data**, development, hosting, and updates — cheaper than every member buying equivalent data capacity alone. The project operator is also a member: same tools, same risks.

---

## Quick start

1. Sign up → automatic seven-day trial for paper or live workflows.
2. **Dashboard** — optional wallet address for balances.
3. **Charts** — pick tokens from the licensed Binance Alpha catalogue.
4. **Strategies** — template or code → backtest → **paper** first.
5. **Live** — download the signed installer for Windows or Linux; your private key stays encrypted on your computer.
6. Read **Risk disclosure** before live size.

---

## Charts & Alpha Screener

- Main nav stays full width; screener sits **under** the tabs next to Layouts.
- Search: Haven's server-side Binance Alpha cache; the provider key never reaches the browser.
- Layouts 1–5 save chart sets.
- Current Binance Alpha BSC catalogue tokens are available to chart and trade through the local engine; its price-impact, size, daily-cap, and pause controls apply to every swap.

---

## Desktop engine

Settings → download the installer for your operating system → generate connection key (once) → run setup
(creates a local wallet + seed phrase; save the seed offline) → start engine:

- **Windows:** install Node.js 22, then open `haven-engine-windows-installer.exe` and use the Start Menu shortcut. The first launch runs setup. Credentials use Windows user-bound DPAPI encryption.
- **Linux:** extract `haven-engine-linux.tar.gz`, run `./install.sh`, then run `haven-engine`. The installer requires Node.js 22 and `libsecret-tools`; credentials use your logged-in desktop keyring.
- API URL and connection key are entered only during local setup. The trading key is never stored in the browser or in `.env`.

Engine executes markers/strategies with size/impact/security guards.

---

## Strategies & Finder

- Backtest → paper → live.  
- Token Finder ranks with your code; strategies can consume ranks.  
- In-app Guide panels document the authoring contract.

---

## Legal

Always available in the app footer:

- [Terms of Service](#) (in-app: Terms)  
- [Privacy Policy](#) (in-app: Privacy)  
- [Risk Disclosure](#) (in-app: Risk disclosure)  

Using Haven means you accept those documents.

---

## Safety habits

Paper first. Small size. Verify contracts. Assume meme tokens can go to zero or trap sells. Keep keys offline-safe.
