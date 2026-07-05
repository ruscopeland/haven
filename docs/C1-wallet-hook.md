# C1 — Lean wallet-data design for the merged app

Decision record for porting wallet functionality out of
`crypto-wallet/src/context/WalletContext.jsx` (1400+ lines) into the charting UI.
Rule applied: **AD-2 — the browser never holds the private key.**

## What is ported (into `src/hooks/useWalletData.js` + `WalletPanel.jsx`)

| WalletContext piece | Lean replacement |
|---|---|
| `address` (derived from private key in browser) | **Address only**, from `VITE_WALLET_ADDRESS` env or a localStorage input (`alpha_wallet_address`). Derived once, offline, by the lead dev — key never enters this app. |
| `bnbBalance` (ethers provider) | Raw JSON-RPC `eth_getBalance` via `fetch` to a public BSC node — no ethers dependency added. |
| `tokens` + balances (ethers contracts) | Raw `eth_call` `balanceOf`/`decimals` for tokens the wallet has actually traded (symbols from `GET /trades?status=FILLED`, contracts from `GET /tokens`). Decimals cached. |
| `bnbPrice` (DexScreener) | Same source: DexScreener WBNB endpoint, 60s poll. |
| `tokenPrices` (DexScreener batches) | **Collector prices** from `/dashboard/overview.token_prices` (already polled by the Dashboard) — one source of truth with the engine. |

## What is deliberately dropped (and why)

- **Wallet/signing derivation** (`getWallet`, `new ethers.Wallet`) — key-free rule.
  Manual trades go through the engine instead (C3: immediate-fire STRAT markers).
- **SwapPanel/TokenDetails swap execution** — same reason. The engine is the only
  swapper.
- **Auto-trade jobs loop** (localStorage, 60s, lines ~1077–1308) — superseded by
  strategies; retirement is task D1 (user decision). NOT ported.
- **txTracer BscScan PnL** (30 KB) — replaced by trade-history-based PnL on the
  strategy board; per-token realized PnL from on-chain traces goes to the backlog.
- **Custom/favorite token lists** — backlog; traded-token auto-discovery covers the
  main case.
- **Debug console** — wallet app still has it; port to a Dashboard panel later if
  wanted (backlog).

## Failure behavior

RPC or DexScreener failures show an inline panel error and keep last values; they
never block the rest of the Dashboard. Address unset ⇒ panel shows a setup hint
instead of numbers.
