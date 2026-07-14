// Haven legal copy — software / shared-data product positioning.
// Not a substitute for counsel; keep marketing aligned with these words.

export const LEGAL_EFFECTIVE = 'July 10, 2026';
export const LEGAL_ENTITY = 'Haven';
export const CONTACT_PLACEHOLDER = 'support via the product channels you publish';

export const MANIFESTO = {
  title: 'Welcome to Haven',
  lines: [
    'We do not give investment, trading, or financial advice.',
    'We do not promise you will make money. Markets can and do take money away.',
    'Haven is software: tools to research tokens, build strategies, backtest, paper-trade, and — if you choose — execute with an engine that runs on your machine.',
    'You pick the tokens. You write or choose the rules. You hold the keys. You are responsible for your own results.',
    'The subscription helps cover shared market data, development, hosting, and ongoing updates. Buying the same data feeds alone can cost hundreds of dollars; we pool that so members pay less.',
    'The person who runs this project is also a member — same tools, same rules, same risks.',
    'Welcome to Haven.',
  ],
};

export const RISK_SUMMARY_SHORT =
  'Haven is software, not advice. You control your keys and decisions. You can lose money. Past performance is not future results.';

export const TERMS = {
  title: 'Terms of Service',
  sections: [
    {
      h: '1. Agreement',
      p: [
        `These Terms of Service ("Terms") govern access to and use of the Haven website, application, APIs, desktop engine, documentation, and related services (collectively, the "Service"). By creating an account, starting a trial, subscribing, downloading the engine, or using the Service, you agree to these Terms.`,
        `If you do not agree, do not use the Service.`,
      ],
    },
    {
      h: '2. What Haven is (and is not)',
      p: [
        'Haven provides software tools and access to shared market-oriented data to help you research digital assets, design strategies, backtest, paper-trade, and optionally execute trades using software that runs under your control.',
        'Haven is not a broker, dealer, exchange, investment adviser, commodity trading advisor, bank, custodian, or money transmitter. Haven does not manage your money, pick trades for you as a fiduciary, or guarantee outcomes.',
        'Nothing in the Service is financial, investment, legal, or tax advice. Content (including charts, rankings, CoinMarketCap security flags, examples, templates, and AI/assistant text if any) is informational and educational tooling only.',
        'You alone decide what to trade, when, and whether to use any feature.',
      ],
    },
    {
      h: '3. Your keys, your trades, your responsibility',
      p: [
        'Live trading is designed so your private keys stay on your own computer (or wallet you control). Haven does not need custody of your private keys for the standard local-engine model.',
        'You are solely responsible for securing your devices, API connection keys, seed phrases, private keys, and accounts. You are solely responsible for every order, swap, approval, and on-chain transaction you authorize or that software you run executes on your behalf.',
        'You accept that automated or semi-automated software can fail, mis-price, mis-route, or interact with malicious or defective smart contracts. You use those features at your own risk.',
      ],
    },
    {
      h: '4. Subscription and fees',
      p: [
        'Paid subscriptions and trials are fees for software access, shared data infrastructure, development, hosting, and updates — not fees for investment advice or portfolio management.',
        'Shared data access is intended to be cheaper than each member buying equivalent raw market-data capacity alone. We do not guarantee feature parity with every third-party data vendor or uninterrupted data.',
        'Prices, plan limits (including bot slots, paper vs live), and founding-member terms may change as described at checkout or in-product. Taxes may apply. Refunds, if any, follow the policy stated at purchase or required by law.',
        'You authorize recurring billing if you choose a recurring plan until you cancel according to the billing provider flow.',
      ],
    },
    {
      h: '5. Accounts and acceptable use',
      p: [
        'You must provide accurate account information and keep credentials confidential. You are responsible for activity under your account.',
        'You will not: abuse the Service; attempt unauthorized access; scrape in a way that harms infrastructure; reverse engineer beyond what law allows; use the Service for fraud, market manipulation, sanctions evasion, or other illegal activity; or resell raw Service access without permission.',
        'We may suspend or terminate access for abuse, non-payment, legal risk, or Terms violations.',
      ],
    },
    {
      h: '6. Third-party services',
      p: [
        'The Service relies on third parties including blockchains, RPCs, DEX aggregators, licensed CoinMarketCap market and security data, authentication, billing, and hosting. Their terms and availability apply. We are not responsible for third-party outages, errors, or policy changes.',
        'On-chain activity is irreversible when confirmed. Network fees, slippage, MEV, and contract behavior are outside our control.',
      ],
    },
    {
      h: '7. Risk of loss',
      p: [
        'Digital assets are volatile and speculative. You can lose some or all capital. Tokens may be illiquid, taxed by contract logic, paused, blacklisted at the contract level, or fraudulent (including honeypots).',
        'Risk labels and security scans are incomplete and can be wrong or outdated. A “clear” or “safe-looking” result is not a green light to invest. A warning does not mean a token cannot still move in price either direction.',
        'Paper trading and backtests are not live markets. Results will differ.',
      ],
    },
    {
      h: '8. Intellectual property',
      p: [
        'Haven and its logos, UI, and software are owned by us or our licensors. You receive a limited, revocable, non-exclusive license to use the Service as offered.',
        'You retain rights to strategy code and configurations you create, and grant us a license to host and run them as needed to provide the Service to you.',
      ],
    },
    {
      h: '9. Disclaimers',
      p: [
        'THE SERVICE IS PROVIDED “AS IS” AND “AS AVAILABLE” WITHOUT WARRANTIES OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, AND NON-INFRINGEMENT. WE DO NOT WARRANT UNINTERRUPTED OR ERROR-FREE OPERATION, ACCURATE PRICES, COMPLETE SECURITY SCANS, OR PROFITABLE OUTCOMES.',
      ],
    },
    {
      h: '10. Limitation of liability',
      p: [
        'TO THE MAXIMUM EXTENT PERMITTED BY LAW, HAVEN AND ITS OPERATORS, MEMBERS, CONTRACTORS, AND SUPPLIERS ARE NOT LIABLE FOR INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL, EXEMPLARY, OR PUNITIVE DAMAGES, OR FOR LOST PROFITS, LOST DATA, TRADING LOSSES, OR BUSINESS INTERRUPTION, ARISING FROM THE SERVICE OR THESE TERMS — WHETHER IN CONTRACT, TORT, OR OTHERWISE — EVEN IF ADVISED OF THE POSSIBILITY.',
        'OUR TOTAL LIABILITY FOR CLAIMS RELATING TO THE SERVICE IN ANY TWELVE-MONTH PERIOD IS LIMITED TO THE FEES YOU PAID US FOR THE SERVICE IN THAT PERIOD (OR USD $50 IF YOU PAID NOTHING).',
        'Some jurisdictions do not allow certain limitations; in those places, limits apply to the fullest extent allowed.',
      ],
    },
    {
      h: '11. Indemnity',
      p: [
        'You will defend and indemnify Haven and its operators against claims, damages, and costs (including reasonable legal fees) arising from your use of the Service, your trading, your content, your violation of law or these Terms, or disputes between you and third parties.',
      ],
    },
    {
      h: '12. Changes',
      p: [
        'We may update the Service and these Terms. Material changes may be noticed in-product or on the site. Continued use after the effective date constitutes acceptance, except where law requires otherwise.',
      ],
    },
    {
      h: '13. Governing law',
      p: [
        'Unless mandatory local law says otherwise, these Terms are governed by the laws of the jurisdiction where the Service operator primarily resides, without conflict-of-law rules. Courts there have exclusive venue, subject to consumer rights you cannot waive.',
        'If any provision is unenforceable, the rest remains in effect.',
      ],
    },
    {
      h: '14. Contact',
      p: [
        `Questions about these Terms: use ${CONTACT_PLACEHOLDER}.`,
      ],
    },
  ],
};

export const PRIVACY = {
  title: 'Privacy Policy',
  sections: [
    {
      h: '1. Overview',
      p: [
        'This Privacy Policy describes how Haven handles information when you use the Service. We aim to collect only what we need to run accounts, subscriptions, software, and shared data features.',
      ],
    },
    {
      h: '2. Information we process',
      p: [
        'Account & auth: identifiers from our sign-in provider (e.g. user id, email if provided by that provider).',
        'Billing: handled largely by the payment processor; we store subscription status, plan, and related metadata — not full card numbers.',
        'Product data: strategies, finders, markers, settings, trade history records you create, engine connection keys (hashed), optional wallet addresses you enter for portfolio display, debug/diagnostic logs you or the engine send.',
        'Technical: IP address, device/browser metadata, and similar logs for security, rate limits, and reliability.',
        'Market data: public-chain and vendor data we aggregate for the Service; this is not “your” personal data but may appear next to your usage.',
      ],
    },
    {
      h: '3. What we do not want',
      p: [
        'In the standard design, live trading private keys stay on your machine. Do not upload seed phrases or private keys to Haven support or forms. If you paste secrets into strategy code or logs, treat that as your disclosure risk.',
      ],
    },
    {
      h: '4. How we use information',
      p: [
        'Provide and improve the Service; authenticate users; process subscriptions; prevent abuse; debug outages; comply with law; communicate service notices.',
      ],
    },
    {
      h: '5. Sharing',
      p: [
        'We use processors (hosting, auth, payments, email if any, analytics if enabled, data/security vendors). They process data on our instructions.',
        'We may disclose information if required by law, to protect rights and safety, or in a business transfer with appropriate continuity notices.',
        'We do not sell your personal information as a consumer data commodity.',
      ],
    },
    {
      h: '6. Retention',
      p: [
        'We retain account and product data while your account is active and as needed for legal, tax, and security purposes. You may request deletion subject to legal holds and backup cycles.',
      ],
    },
    {
      h: '7. Security',
      p: [
        'We use reasonable technical and organizational measures. No method of transmission or storage is perfectly secure. Protect your own devices and keys.',
      ],
    },
    {
      h: '8. Your choices',
      p: [
        'You may update account details via the auth provider, cancel subscription via billing portal where offered, and request access or deletion where applicable law grants those rights.',
      ],
    },
    {
      h: '9. International users',
      p: [
        'The Service may be hosted in multiple regions. By using it you understand your information may be processed outside your country with appropriate safeguards where required.',
      ],
    },
    {
      h: '10. Children',
      p: [
        'The Service is not directed to children under 18 (or higher age required where you live). Do not use it if you are under that age.',
      ],
    },
    {
      h: '11. Changes & contact',
      p: [
        `We may update this Policy; the effective date will change. Contact: ${CONTACT_PLACEHOLDER}.`,
      ],
    },
  ],
};

export const RISK = {
  title: 'Risk Disclosure',
  sections: [
    {
      h: 'Read this before trading',
      p: [
        'Using Haven involves substantial risk of loss. Only use capital you can afford to lose entirely.',
        'This disclosure is part of your agreement with Haven and supplements the Terms of Service.',
      ],
    },
    {
      h: 'No advice, no performance promises',
      p: [
        'Haven does not advise you to buy, sell, or hold any asset. We do not represent that you will profit. Any examples, rankings, “alpha,” or templates are tools and illustrations — not recommendations.',
        'Operators of Haven may use the same software as members. That does not mean their positions, timing, or results will match yours, or that you should copy anyone.',
      ],
    },
    {
      h: 'Market & protocol risk',
      p: [
        'Prices gap; liquidity vanishes; bridges and DEXes fail; smart contracts have bugs; teams abandon projects; regulations change.',
        'BNB Chain and other networks can congest, reorg, or halt. Gas and slippage can exceed expectations.',
      ],
    },
    {
      h: 'Token & contract risk',
      p: [
        'Tokens may be honeypots, high-tax, pausable, mintable, upgradeable, or able to blacklist wallets after you buy. CoinMarketCap security data is a partial snapshot and can miss issues or go stale.',
        'Haven may still chart risky tokens so you can research them. Charting is not an endorsement. If you insist on trading a flagged token, start small if at all, verify the contract yourself, and accept that a successful small trade does not prove the next trade is safe.',
      ],
    },
    {
      h: 'Software & automation risk',
      p: [
        'Bugs, bad configs, paused engines, stale quotes, failed approvals, and race conditions can cause missed trades, partial fills, or losses.',
        'You are responsible for testing (paper, small size) before scaling live automation.',
      ],
    },
    {
      h: 'Data risk',
      p: [
        'Shared market data can be delayed, incomplete, or wrong. Strategies based on bad data produce bad outcomes. Subscription fees support access and upkeep of data and software — not insurance against data errors.',
      ],
    },
    {
      h: 'Your acknowledgment',
      p: [
        'By using Haven you acknowledge: you understand these risks; you control your keys and decisions; you will not hold Haven responsible for trading losses to the maximum extent allowed by law; and you have read the Terms of Service and Privacy Policy.',
      ],
    },
  ],
};

export const DOCS_SECTIONS = [
  {
    id: 'welcome',
    title: 'Welcome to Haven',
    body: [
      'Haven is member software for researching tokens, building strategies, and optionally automating execution — with your keys on your machine.',
      'Subscription supports shared data feeds, hosting, development, and updates. It is not payment for financial advice.',
      'If you only remember one rule: you pick tokens, you own outcomes.',
    ],
  },
  {
    id: 'quickstart',
    title: 'Quick start',
    body: [
      '1. Create an account and start the automatic seven-day paper and live trial (no card).',
      '2. Open Dashboard — set a watch address if you want portfolio balances.',
      '3. Open Charts — search or select tokens from Alpha Screener; open layouts.',
      '4. Open Strategies — load a template or write rules; backtest; arm paper first.',
      '5. For live during trial or paid access: download the desktop engine, create a scoped connection key, and let setup store the wallet key with Windows DPAPI on your PC.',
      '6. Read Risk Disclosure and verify contracts before any live size.',
    ],
  },
  {
    id: 'dashboard',
    title: 'Dashboard',
    body: [
      'Overview of bots, attention items, and portfolio snapshots.',
      'First-run checklist walks through wallet address, engine connect, and deploying a paper bot.',
      'Use Strategy pages for per-bot equity and fills.',
    ],
  },
  {
    id: 'charts',
    title: 'Charts & Alpha Screener',
    body: [
      'Nav tabs stay full width. On Charts, Alpha Screener sits under the tabs beside Layouts.',
      'Sort the live feed by market cap, volume, or 24-hour performance.',
      'Search by name or symbol: cached CoinMarketCap results can add a supported contract, fetch its history once, and open a chart.',
      'Layouts 1–5 save chart sets; Grid controls multi-chart layout.',
      'Markers on the chart plan levels; live execution goes through the engine.',
    ],
  },
  {
    id: 'risk-tokens',
    title: 'Risky tokens',
    body: [
      'Haven charts first, lectures second: elevated-risk tokens still open charts.',
      'CoinMarketCap security flags may show honeypot, tax, blacklist functions, and related risks.',
      'Manual trade requires: verify contract on the explorer, accept warnings, prefer a ~$1 probe first. Larger size needs an extra acknowledgment. Creators can still block wallets later.',
      'Strategy/auto paths stay blocked without a clean security posture — intentional.',
    ],
  },
  {
    id: 'strategies',
    title: 'Strategies & Token Finder',
    body: [
      'Strategies: code or templates that decide when to buy/sell using market context.',
      'Always backtest, then paper (DRY) before LIVE.',
      'Token Finder ranks tokens with your scoring logic; strategies can consume rankings.',
      'See in-app Guide panels and strategy-sdk docs for authoring contracts.',
      'Bot slots depend on plan (paper trial vs paid).',
    ],
  },
  {
    id: 'engine',
    title: 'Desktop engine (live)',
    body: [
      'Settings → Connect your engine → download zip → generate connection key (shown once).',
      'On your PC: configure API URL + connection key + PRIVATE_KEY in local env only.',
      'Engine pulls markers/strategies, runs risk guards (size, impact, security), swaps via aggregator routes.',
      'Pause in Settings stops new execution. Panic / limits are your responsibility to configure.',
      'Never put private keys in the browser or in chat.',
    ],
  },
  {
    id: 'portfolio',
    title: 'Portfolio',
    body: [
      'Shows balances for an address you configure, using chain reads + Haven token metadata.',
      'Manual swap UI goes through the engine path — same security gates.',
      'Open Token pages for a chart, trade ticket, and CoinMarketCap security panel.',
    ],
  },
  {
    id: 'subscription',
    title: 'Paper trial & subscription',
    body: [
      'Paper trial: learn the product and run simulated bots without live execution rights.',
      'Paid plan: unlocks live path and full bot entitlements as shown at checkout.',
      'Fees fund shared data + product development — not “alpha signals as advice.”',
      'Manage or cancel a paid plan through the Clerk billing portal when offered.',
    ],
  },
  {
    id: 'settings',
    title: 'Settings',
    body: [
      'Engine risk limits: max trades/day, max trade USD, max price impact, retries.',
      'Market status shows the server-side CoinMarketCap REST and WebSocket condition.',
      'Subscription panel for plan status.',
    ],
  },
  {
    id: 'safety',
    title: 'Safety habits',
    body: [
      'Paper first. Size small. Verify contract addresses character by character.',
      'Do not unlimited-approve random spenders; Haven engine prefers exact-amount approves for swaps.',
      'Assume every meme token can go to zero or trap sells.',
      'Keep OS and engine offline backups of keys in a safe place you control — not in screenshots in the cloud.',
    ],
  },
  {
    id: 'legal',
    title: 'Legal pages',
    body: [
      'Terms of Service, Privacy Policy, and Risk Disclosure are always available from the footer.',
      'Using Haven means you accept those documents.',
    ],
  },
];
