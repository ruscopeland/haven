# CoW Protocol — Swapping Tokens

> Everything you need to know about swapping tokens on CoW Protocol.
> Extracted from the full CoW Protocol documentation.

---

## What is CoW Protocol?

CoW Protocol is a meta-DEX aggregation protocol that leverages **trade intents** and **fair combinatorial batch auctions** to find users better prices for trading crypto assets.

The protocol relies on third parties known as **solvers** to find the best execution paths for trade intents — signed messages that specify conditions for executing transactions on Ethereum and EVM-compatible chains.

**How it works:**
1. You sign a message saying what you want to trade ("intent"), not an on-chain transaction
2. Your intent gets grouped with others into a batch auction
3. Solvers compete to find the best execution for the whole batch — matching traders peer-to-peer (Coincidence of Wants), routing through AMMs, or tapping private market makers
4. The winning solver settles everything on-chain; you get your tokens

Liquidity sources include: AMMs (Uniswap, Sushiswap, Balancer, Curve), DEX Aggregators (1inch, Paraswap, Matcha), and Private Market Makers. This makes CoW Protocol a **meta-DEX aggregator** — an aggregator of aggregators.

---

## CoW Protocol vs. CoW Swap

- **CoW Protocol** — the underlying trading protocol. Intents + batch auctions + solver competition.
- **CoW Swap** — the first (and most popular) trading interface built on top of CoW Protocol. Other apps (like Balancer) also integrate the protocol natively.

CoW Swap works with: Rabby, MetaMask, Trust Wallet, Safe, Trezor, Ledger, and any WalletConnect v2 wallet.

---

## Flow of an Order

```
User signs intent → Protocol groups into batch → Solvers compete → Winner settles on-chain → User gets tokens
```

Four steps:
1. User expresses their trade intent by signing a message specifying assets, amounts, and parameters
2. Protocol gathers intents into a fair combinatorial batch auction
3. Solvers have a set time to propose settlements — the one generating the most surplus wins
4. Winning solver submits the batch on-chain on behalf of users

Users don't worry about finding liquidity pools, setting gas prices, or picking optimal slippage. Solvers handle all of that plus MEV protection.

---

## Intents

Rather than signing a raw transaction that executes directly on-chain (like Uniswap), CoW Protocol users sign an **"intent to trade" message** specifying what they want. It's not executable — it's a signed set of trading constraints. Solvers compete to construct settlement solutions that satisfy those constraints.

### Financial Benefits of Intents
- Solvers scan all on-chain liquidity AND tap private market maker inventory for better prices
- **Coincidence of Wants** — P2P matching lets traders bypass LP fees and save gas
- **MEV Protection** — users never exposed to MEV bots; solvers bear that risk

### Technical Benefits of Intents
- Pay gas fees in your **sell token** — no need to hold ETH
- No fees for failed transactions
- Place multiple orders at once
- Uniform clearing prices prevent trade re-ordering attacks

---

## How Intents Are Formed

```
Intention → Quote → Intent
```

### Step 1: Intention (Get a Quote)

```
POST https://api.cow.fi/mainnet/api/v1/quote
```

```json
{
  "kind": "sell",
  "sellToken": "0x...",
  "buyToken": "0x...",
  "sellAmountBeforeFee": "1000000000000000000",
  "from": "0x...",
  "receiver": "0x...",
  "validFor": 1800
}
```

| Field | Description |
|---|---|
| `kind` | `"sell"` or `"buy"` |
| `sellToken` | Token address you're selling |
| `buyToken` | Token address you're buying |
| `sellAmountBeforeFee` | How much to sell (for sell orders) |
| `from` | Trader's address |
| `receiver` | Address receiving bought tokens (often same as `from`) |
| `validFor` | Order validity in seconds |

### Step 2: Quote Response

**Sell order response:**
```json
{
  "protocolFeeBps": "2",
  "quote": {
    "buyAmount": "191179999",
    "feeAmount": "62483346430736",
    "sellAmount": "99937516653569264",
    "kind": "sell"
  }
}
```
- `quote.sellAmount` — sell amount **after** network costs deducted
- `quote.feeAmount` — network costs in sell token units
- `quote.buyAmount` — buy amount **after** network costs and protocol fee

**Buy order response:**
```json
{
  "protocolFeeBps": "2",
  "quote": {
    "buyAmount": "200000000",
    "feeAmount": "42560776189182",
    "sellAmount": "104486220751250279",
    "kind": "buy"
  }
}
```
For buy orders, `sellAmount` is after protocol fee, and `feeAmount` (network costs) is NOT yet included — add it separately.

### Step 3: Amount Stages

| Term | Description |
|---|---|
| `beforeAllFees` (= `spotPrice`) | Raw exchange rate, no fees. Reference for partner fee & slippage |
| `afterProtocolFees` | After CoW Protocol's own fee (`protocolFeeBps`) |
| `afterNetworkCosts` | After gas costs. Always in sell token |
| `afterPartnerFees` | After integrator/partner fee |
| `afterSlippage` | Final amount after slippage tolerance. **This is what gets signed** — minimum to receive (sell) or maximum to pay (buy) |

**Sell order flow:**
```ts
// /quote maps to afterNetworkCosts
const afterNetworkCosts = { sellAmount: quote.sellAmount, buyAmount: quote.buyAmount }

// Reconstruct spot price
const networkCostAmountInBuyCurrency = (quote.buyAmount * quote.feeAmount) / quote.sellAmount
const beforeAllFees = {
  sellAmount: quote.sellAmount + quote.feeAmount,
  buyAmount: quote.buyAmount + networkCostAmountInBuyCurrency + protocolFeeAmount,
}

// Partner fee from spot price
const afterPartnerFees = {
  sellAmount: afterNetworkCosts.sellAmount,
  buyAmount: afterNetworkCosts.buyAmount - partnerFeeAmount,
}

// Slippage from afterPartnerFees
const afterSlippage = {
  sellAmount: afterPartnerFees.sellAmount,
  buyAmount: afterPartnerFees.buyAmount - slippageAmount,
}

// What gets signed
const amountsToSign = {
  sellAmount: beforeAllFees.sellAmount,  // = quote.sellAmount + quote.feeAmount
  buyAmount: afterSlippage.buyAmount,    // minimum to receive
}
```

**Buy order flow:**
```ts
const afterProtocolFees = { sellAmount: quote.sellAmount, buyAmount: quote.buyAmount }
const beforeAllFees = { sellAmount: quote.sellAmount - protocolFeeAmount, buyAmount: quote.buyAmount }
const afterNetworkCosts = { sellAmount: quote.sellAmount + quote.feeAmount, buyAmount: quote.buyAmount }
const afterPartnerFees = { sellAmount: afterNetworkCosts.sellAmount + partnerFeeAmount, buyAmount: afterNetworkCosts.buyAmount }
const afterSlippage = { sellAmount: afterPartnerFees.sellAmount + slippageAmount, buyAmount: afterPartnerFees.buyAmount }

const amountsToSign = {
  sellAmount: afterSlippage.sellAmount,  // maximum to pay
  buyAmount: beforeAllFees.buyAmount,    // = quote.buyAmount
}
```

### Fee Types

| Fee | Description | Token |
|---|---|---|
| **Network costs** | Gas fees for on-chain execution | Sell token |
| **Protocol fee** | CoW Protocol's fee (`protocolFeeBps`) | Buy token (sell orders) / Sell token (buy orders) |
| **Partner fee** | Optional integrator fee | Buy token (sell orders) / Sell token (buy orders) |
| **Slippage** | Tolerance buffer for price movement | Buy token (sell orders) / Sell token (buy orders) |

### Forming the Final Order

The signed order combines:
- `/quote` response → `sellAmount`, `buyAmount`, `feeAmount`, `protocolFeeBps`
- UI/integrator settings → `partnerFee`, `slippage`

**Sell order:**
```ts
const orderToSign = {
    sellAmount: beforeAllFees.sellAmount,
    buyAmount: afterSlippage.buyAmount
}
```

**Buy order:**
```ts
const orderToSign = {
    sellAmount: afterSlippage.sellAmount,
    buyAmount: beforeAllFees.buyAmount
}
```

---

## Order Types

### Market Orders (Swaps)

Buy or sell tokens ASAP at current market rate. **Fill or kill** — the entire order must be filled or it waits. You specify a slippage tolerance.

**Key advantage:** Your slippage tolerance CANNOT be extracted by MEV bots. If solvers find optimizations, you may actually get a better price than quoted.

### Limit Orders

Buy or sell at a specified price before an expiration date. If the market hits your price, it executes. Otherwise it expires.

**CoW Protocol advantages over other DEXs:**
- **Gasless order management** — create, modify, cancel without gas
- **Simultaneous orders** — use the same balance for multiple outstanding orders
- **Order surplus** — if the market price is better than your limit price, you get ALL the upside (not just your limit price like on other exchanges)

### TWAP Orders (Time-Weighted Average Price)

Splits a large order into smaller pieces executed at fixed intervals.

**Inputs:**
- Assets to swap
- **Price Protection** — minimum price you'll accept; if price drops below, that part waits
- **Number of Parts** — how many pieces
- **Total Duration** — over how long (hours, days, weeks, months)

**Benefits:** Lower slippage, lower price impact, 100% of surplus goes to you, smooths volatility.

**Requirements:**
- Mainnet: minimum $1,000 per order
- Gnosis Chain, Arbitrum One, Base: minimum $5
- Must use a Safe wallet with upgraded fallback handler
- Each part minimum: $5K on Mainnet, $5 on Gnosis Chain

### Milkman Orders

Uses price feeds (oracles) instead of fixed prices. Ideal for DAOs with slow governance — the order executes at fair market price whenever it passes, even far in the future. Supports Chainlink, Curve, SushiSwap, Uniswap V2, Uniswap V3, and custom oracles.

### Programmatic Orders

Smart contract orders using `ERC-1271` that execute based on on-chain conditions. The Programmatic Order Framework handles all boilerplate — you just code the order logic.

**Use cases:** stop-loss, take-profit, good-after-time, automated portfolio rebalancing, DAO payroll, yield farming automation. TWAP orders are built on top of this framework.

---

## CoW Hooks

Attach arbitrary Ethereum actions to your swap — executed before (pre-hooks) or after (post-hooks) the trade, all in one transaction. You pay gas in your sell token, only if everything succeeds.

**Pre-hook examples:** unstake tokens before trading, claim airdrops, sign approvals
**Post-hook examples:** bridge funds to L2, stake proceeds

Each hook has: `target` (contract address), `callData` (the call to make), `gasLimit` (max gas).

**Important:**
- Pre-hooks only execute on first fill for partially fillable orders
- Post-hooks execute on every fill
- Hook execution is NOT guaranteed — design defensively
- Hooks are specified through `appData`

---

## Additional Benefits of Every Order

- **Gasless trades** — pay fees in sell token; can be cheaper than gas if batched
- **No fees for failed/cancelled orders**
- Settlement at **Ethereum Best Bid Offer (EBBO)** or better
- Multiple orders at once
- Slippage protection on all orders
- Minimized smart contract risk (solvers take AMM exposure)
- Can trade exotic tokens (solvers abstract away intermediate steps)
- Tighter spreads from private market makers
- No deposits/withdrawals into exchange contracts — trades credited directly to you
- Funds only move if you've approved AND signed an order
- Signed orders have expiry; can be cancelled on-chain
- Only bonded solvers (subject to slashing) can settle

---

## MEV Protection

MEV (maximal extractable value) attacks like sandwich attacks steal over $1B from traders. CoW Protocol protects you three ways:

1. **Uniform Clearing Prices** — same token pair in same batch clears at same price, making transaction order irrelevant
2. **Delegated Trade Execution** — solvers submit on-chain; you're never exposed to the public mempool
3. **Coincidence of Wants** — peer-to-peer matches don't touch AMMs, so no MEV surface

---

## Price Improvement (Surplus)

If execution price beats the quoted price, you get the difference. This applies to market, limit, and TWAP orders.

Better prices come from:
- **Efficient routing** — solvers search all on-chain liquidity, splitting across sources
- **Private off-chain liquidity** — market makers not indexed by other aggregators
- **Coincidence of Wants** — P2P matches skip LP fees and save gas

---

## Protocol Fees

### Surplus Fee (on out-of-market limit orders)
- 50% of surplus, capped at 0.98% of volume
- Applies to out-of-market limit orders and discrete TWAP orders not executable at generation time

### Quote Improvement Fee (on market orders/swaps)
- 50% of positive quote improvement, capped at 0.98% of volume
- Applies when you get a better price than quoted

### Volume Fee
- **Standard Assets:** 2 bps (0.0002 × volume)
- **Correlated Assets (Stables/RWAs):** 0.3 bps (0.00003 × volume)

All protocol fees are charged in the **surplus token** (buy token for sell orders, sell token for buy orders).

---

## Partner Fees

Integrators (widget/SDK users) can charge a partner fee up to 100 bps (1%). Calculated as a percentage of the spot price (`beforeAllFees`), in the surplus token.

CoW Protocol retains 25% as a service fee. Net partner fee is paid weekly in WETH (minimum 0.001 WETH to trigger payout).

---

## API Integration

**Base URL:** `https://api.cow.fi/`

### Key Endpoints

| Endpoint | Purpose |
|---|---|
| `POST /api/v1/quote` | Get trading quotes |
| `POST /api/v1/quote/stream` | Stream quotes via SSE as solvers respond |
| `POST /api/v1/orders` | Submit signed orders |
| `GET /api/v1/orders/{uid}` | Get order details |
| `DELETE /api/v1/orders/{uid}` | Cancel orders |
| `GET /api/v1/trades` | Get trade history |

### Network Endpoints

- **Mainnet:** `https://api.cow.fi/mainnet/api/v1/`
- **Gnosis Chain:** `https://api.cow.fi/xdai/api/v1/`
- **Arbitrum:** `https://api.cow.fi/arbitrum_one/api/v1/`
- **Base:** `https://api.cow.fi/base/api/v1/`
- **Sepolia (Testnet):** `https://api.cow.fi/sepolia/api/v1/`

### Quick Start: Quote → Sign → Submit → Track

```bash
# 1. Get a quote
curl -X POST "https://api.cow.fi/mainnet/api/v1/quote" \
  -H "Content-Type: application/json" \
  -d '{
    "sellToken": "0x...",
    "buyToken": "0x...",
    "sellAmountBeforeFee": "1000000",
    "kind": "sell",
    "from": "0xYourWalletAddress"
  }'
```

```js
// 2. Sign and submit
const order = {
  ...quoteResponse,
  signature: await signOrder(quoteResponse, signer),
  signingScheme: "eip712"
}
const response = await fetch('https://api.cow.fi/mainnet/api/v1/orders', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(order)
})
const orderId = await response.text()

// 3. Monitor
const orderResponse = await fetch(`https://api.cow.fi/mainnet/api/v1/orders/${orderId}`)
const orderDetails = await orderResponse.json()
console.log('Order status:', orderDetails.status)
```

### Streaming Quotes

`POST /api/v1/quote/stream` returns Server-Sent Events. Each solver's quote arrives as its own event — show a price as soon as the fastest solver responds. The `id` can be used as `quoteId` when placing the order.

**Recommended timeouts:**

| Network | `timeout` (ms) |
|---|---|
| Base, Gnosis Chain, Linea | 1000 |
| Mainnet, BNB Chain | 1800 |
| Arbitrum, Polygon, Avalanche, Ink | 2500 |

### Order Signing

Orders must be EIP-712 signed. The domain separator uses:
- name: `"Gnosis Protocol"`, version: `"v2"`
- `verifyingContract`: `0x9008D19f58AAbD9eD0D60971565AA8510560ab41`

Four signing schemes:
| Scheme | Gasless | EOA | Smart Contract |
|---|---|---|---|
| `eth_sign` | ✅ | ✅ | ❌ |
| `EIP-712` (recommended) | ✅ | ✅ | ❌ |
| `ERC-1271` | ✅ | ❌ | ✅ |
| `PreSign` | ❌ | ✅ | ✅ |

### Rate Limits

- Quote requests: 10 req/s
- Order submission: 5 req/s
- General endpoints: 100 req/min

### Error Codes

- **200** Success | **400** Bad Request | **404** Order not found | **429** Rate limited | **500** Internal server error

---

## SDK Integration

The CoW SDK (`@cowprotocol/cow-sdk`) is a TypeScript library for programmatic trading.

### Installation

```bash
npm install @cowprotocol/cow-sdk
# Choose one adapter:
npm install @cowprotocol/sdk-viem-adapter viem
npm install @cowprotocol/sdk-ethers-v6-adapter ethers
npm install @cowprotocol/sdk-ethers-v5-adapter ethers@^5.7.0
```

### Quick Start

```ts
import { TradingSdk, SupportedChainId, OrderKind } from '@cowprotocol/cow-sdk'
import { ViemAdapter } from '@cowprotocol/sdk-viem-adapter'
import { createPublicClient, http, privateKeyToAccount } from 'viem'
import { mainnet } from 'viem/chains'

const adapter = new ViemAdapter({
  provider: createPublicClient({ chain: mainnet, transport: http('YOUR_RPC_URL') }),
  signer: privateKeyToAccount('YOUR_PRIVATE_KEY' as `0x${string}`)
})

const sdk = new TradingSdk({
  chainId: SupportedChainId.MAINNET,
  appCode: 'YOUR_APP_CODE',
}, {}, adapter)

const parameters = {
  kind: OrderKind.SELL,
  sellToken: '0x...', // USDC
  sellTokenDecimals: 6,
  buyToken: '0x...',  // WETH
  buyTokenDecimals: 18,
  amount: '1000000',  // 1 USDC
}

const { quoteResults, postSwapOrderFromQuote } = await sdk.getQuote(parameters)
const orderId = await postSwapOrderFromQuote()
console.log('Order created:', orderId)
```

### SDK Components

- **TradingSdk** — main tool for swaps and limit orders (quote, sign, post)
- **OrderSigningUtils** — signing orders and cancellations
- **OrderBookApi** — low-level API access for orders, trades, quotes
- **MetadataApi** — appData management
- **BridgingSdk** — cross-chain transfers
- **ConditionalOrder** — TWAP and programmatic orders
- **CowShedSdk** — account abstraction for EOAs with smart contract capabilities

### Low-Level Example

```ts
const orderBookApi = new OrderBookApi({ chainId: SupportedChainId.GNOSIS_CHAIN })

// Get quote
const { quote } = await orderBookApi.getQuote({
  sellToken: '0x...',
  buyToken: '0x...',
  from: account,
  receiver: account,
  sellAmountBeforeFee: (0.4 * 10 ** 18).toString(),
  kind: OrderQuoteSideKindSell.SELL,
})

// Build order (add fee to sellAmount for sell orders)
const orderData = {
  ...quote,
  sellAmount: (BigInt(quote.sellAmount) + BigInt(quote.feeAmount)).toString(),
  receiver: account,
  feeAmount: "0",
}

// Sign
const orderSigningResult = await OrderSigningUtils.signOrder(orderData, chainId, adapter.signer)

// Submit
const orderId = await orderBookApi.sendOrder({
  ...orderData,
  ...orderSigningResult,
  signingScheme: SigningScheme.EIP712,
})

// Check status
const order = await orderBookApi.getOrder(orderId)
const trades = await orderBookApi.getTrades({ orderId })

// Cancel
const cancelResult = await OrderSigningUtils.signOrderCancellations([orderId], chainId, adapter.signer)
await orderBookApi.sendSignedOrderCancellations({ ...cancelResult, orderUids: [orderId] })
```

### Partner API (Authenticated Access)

Higher rate limits via `partners.cow.fi`:
```ts
const orderBookApi = new OrderBookApi({
  chainId: SupportedChainId.MAINNET,
  apiKey: 'your-api-key',
})
```

---

## Widget Integration

The fastest way to add CoW swapping to your app. A pre-built trading UI with a few lines of code.

### Installation
```bash
npm install @cowprotocol/widget-lib
# React wrapper:
npm install @cowprotocol/widget-react
```

### Quick Start

```ts
import { createCowSwapWidget, CowSwapWidgetParams } from '@cowprotocol/widget-lib'

const params = {
  appCode: 'YOUR-APP-NAME',
  rootStyle: { width: '600px', height: '640px' },
  sell: { asset: 'USDC' },
  buy: { asset: 'WETH', amount: '0.1' },
  theme: 'light',
  partnerFee: {
    bps: 50,  // 0.5%
    recipient: '0xYourFeeRecipientAddress',
  },
}

createCowSwapWidget(document.getElementById('cowswap-widget'), { params })
```

### Configuration Options

- **Trading pairs** — pre-select sell/buy tokens and amounts
- **Partner fees** — earn up to 1% on trades through your integration
- **Custom themes** — light, dark, or full custom palette
- **Token lists** — URL or programmatic custom tokens
- **Token pair constraints** — lock widget to specific pairs only
- **Standalone mode** — widget provides its own wallet connection
- **Events** — listen to order lifecycle events
- **And more** — hide network selector, disable cross-chain, custom sounds/images, etc.

Configurator: **[widget.cow.fi](https://widget.cow.fi)**

---

## Using Wrappers with Orders

Wrappers (Atomic Bundles) add custom logic around settlement. To use an existing wrapper in your order, add it to `appData`:

```ts
appData: {
  wrappers: [
    {
      target: "0x1234...",     // Wrapper contract address
      data: "0xabcd...",       // Wrapper-specific data
      isOmittable: false       // Must execute (true = solver may skip)
    }
  ]
}
```

Multiple wrappers execute in sequence: Wrapper1 → Wrapper2 → Settlement → Wrapper2 (post) → Wrapper1 (post).

---

## Supported Tokens

CoW Protocol supports `ERC-20` tokens. Requirements:
- ERC-20 compliant
- Valid price from a price estimator for at least ~$30-50 worth (0.1 ETH on Mainnet/Arbitrum, 1 xDAI on Gnosis Chain)
- Not on the bad token list (e.g., fee-on-transfer tokens)

**NoLiquidity** error = token doesn't meet requirements. **UnsupportedToken** error = token is on the bad token list.

To make a new token tradeable: bootstrap a Uni v2 pool with the native token, let solvers know about liquidity sources.

---

## Signing Schemes (Reference)

### EIP-712 Domain
- `name`: `"Gnosis Protocol"`, `version`: `"v2"`, `verifyingContract`: `0x9008D19f58AAbD9eD0D60971565AA8510560ab41`

### `eth_sign`
Most common for EOAs. `signature = ethSign(orderDigest)`

### `EIP-712` (recommended for EOAs)
Typed structured data signing — user sees full order details in wallet. `signature = ecdsaSign(orderDigest)`

### `ERC-1271` (for smart contracts)
Contract must implement `isValidSignature(orderDigest, signature) == MAGICVALUE`. When submitting, the `from` field MUST be the contract address.

### `PreSign`
For EOA or smart contracts. Requires an on-chain transaction: `setPreSignature(orderUid, true)`. Signature is empty (`0x`).

---

## AppData

The `appData` field is a `bytes32` pointing to an IPFS JSON document with additional order info: referral address, CoW Hooks, UTM tracking, partner fees, wrapper config.

```json
{
  "version": "1.6.0",
  "appCode": "MyAwesomeUi",
  "metadata": {
    "referral": "0x1234567890123456789012345678901234567890"
  }
}
```

Use the [CoW Explorer appData utility](https://explorer.cow.fi/appdata?tab=encode) or the `@cowprotocol/app-data` SDK to create and manage appData.

---

## Hooks Specification

Hooks are specified in appData as arrays of `pre` and `post` hooks. Each hook:
- `target` — contract address to call
- `callData` — ABI-encoded function call
- `gasLimit` — max gas; if exceeded, the hook reverts internally but the order still executes

Order quotes use `gasLimit` to estimate total fees. Pre-hooks only execute on first fill for partially fillable orders; post-hooks execute on every fill.

Hook execution is NOT enforced by smart contracts — solvers include them via social consensus. Design defensively: if a pre-hook must succeed, make the trade impossible without it.

---

## Swap Tutorial — Market Orders on CoW Swap

### 1. Connect Wallet
Go to [swap.cow.fi](https://swap.cow.fi) and connect (Rabby, MetaMask, Safe, Trezor, Ledger, WalletConnect).

### 2. Select Tokens
Pick the sell and buy tokens. On first trade, you must approve the **vault relayer** contract (`0xC92E8bdf79f0507f65a392b0ab4667716BFE0110`) to spend your sell token.

Some tokens (USDC, DAI, COW) support **gasless approvals** — approve without having ETH for gas. CoW Swap auto-detects this.

By default, CoW Swap requests "unlimited" allowance so you don't re-approve every trade.

### 3. Confirm Swap
Review quote, slippage tolerance, and order details. Click "Confirm Swap", sign the order in your wallet.

**⚠️ Verify the `receiver` address** — it should be `0x0...0` (you) or your address. Scam sites change this.

### 4. Track Your Order
- Pop-up notification when executed
- Order history in the activity panel (click your address)
- Full details on [CoW Explorer](https://explorer.cow.fi)

### 5. Cancel Your Order
Two options:
- **Off-chain** (default) — free, gasless. Small risk of order being filled before cancellation processes
- **On-chain** — costs gas, but doesn't rely on the API. Still has a risk before the transaction confirms

---

## Swapping Native Tokens (ETH)

### Option 1: Wrap First
Select native token (ETH) as sell, wrapped version (WETH) as buy. The button changes to "Wrap". This is an on-chain transaction with a gas fee. After wrapping, swap WETH normally.

### Option 2: Eth-flow (One Transaction)
The Eth-flow contract automates wrap + swap in a single on-chain transaction.

**Benefits:** lower overall fees (one-and-done), simpler UX, no explicit WETH approval needed.

**Cost:** up-front gas fee in ETH (not refunded if order fails).

**To use:** select ETH as sell token, your desired token as buy, click "Swap". CoW Protocol auto-detects and uses Eth-flow.

**Note:** Eth-flow only works for market swaps (not limit orders), not for smart contract wallets in CoW Swap UI. For frequent ETH trading, wrap to WETH first — Eth-flow is more expensive per-trade.

**Cancellation:** only on-chain cancellation available.

---

## Cross-Chain Swaps

Swap a token on one network, receive a different token on another — all in one flow.

**Available for:** swap orders only (not smart contract wallets currently).

### Process
1. Select source token + network and destination token + network
2. Approve sell token if needed
3. Sign the post-hook (bridge provider call)
4. Sign the order (off-chain for ERC-20, on-chain transaction for native tokens)

### Quote Shows:
- Swap minimum to receive (after costs + slippage)
- Expected deposit amount
- Bridge cost
- Estimated bridging time
- Bridge minimum to receive

### Execution:
1. Swap completes first
2. Funds go to your Account Proxy (CoW Shed)
3. Bridge deposit submitted in same transaction
4. Bridge provider delivers on destination chain
5. Cancellation only possible during swap phase; once bridging starts, it completes or refunds per provider policy

If bridging fails, most providers auto-refund to your Account Proxy after expiration. Recover via the Account Proxy page.

---

## Limit Order Tutorial (CoW Swap)

Place limit orders from the "Limit" tab on CoW Swap.

1. Select tokens, enter your limit price and amount
2. Set expiry
3. Review and sign — gasless management (create, modify, cancel without gas)

**Simultaneous orders:** use the same balance for multiple outstanding limit orders. CoW Protocol fills them as long as you have funds.

---

## TWAP Order Tutorial (CoW Swap)

Requires a Safe wallet with upgraded fallback handler.

1. Connect Safe → open CoW Swap as a Safe App
2. Switch to "TWAP" tab
3. Select tokens and total amount
4. Configure:
   - **Price Protection** — % acceptable price deviation (e.g., 10% means order pauses if price moves >10%)
   - **Number of Parts** — granularity of strategy
   - **Total Duration** — overall timeframe
   - Part Duration and Sell/Buy per Part (calculated automatically)
5. Review, sign (may need multiple Safe signatures), submit on-chain
6. Monitor in Orders overview — expand TWAP to see individual parts, use 3-dot menu for actions

**Cancelling:** create a Safe transaction, collect all required signatures. Once the cancellation is fully signed and submitted, the TWAP stops. Individual parts can also be cancelled.

---

## Definitions

- **Intent** — a user's signed desire to swap X for Y. Delegates execution to solvers.
- **Order** — same as intent; a signed swap request.
- **Surplus** — the price improvement beyond your limit price. You keep all of it.
- **Quote deviation** — difference between quoted price and actual settlement price.
- **Gasless** — no on-chain transaction needed from the user; no native token gas payment.
- **EBBO (Ethereum Best Bid and Offer)** — baseline price sourced from well-known DEXs (Uniswap, Sushiswap, Balancer). Orders settle at EBBO or better.
- **Internal buffers** — tokens held in the settlement contract from fee collection, used by solvers to facilitate trading.

---

## CoW SDK — Supported Networks

| Network | Chain ID | `SupportedChainId` |
|---|---|---|
| Ethereum | 1 | `MAINNET` |
| Gnosis Chain | 100 | `GNOSIS_CHAIN` |
| Arbitrum One | 42161 | `ARBITRUM_ONE` |
| Base | 8453 | `BASE` |
| Polygon | 137 | `POLYGON` |
| Avalanche | 43114 | `AVALANCHE` |
| BNB | 56 | `BNB` |
| Linea | 59144 | `LINEA` |
| Plasma | 9745 | `PLASMA` |
| Ink | 57073 | `INK` |
| Sepolia (testnet) | 11155111 | `SEPOLIA` |

---

## Resources

- **CoW Swap:** https://swap.cow.fi
- **Widget Configurator:** https://widget.cow.fi
- **API Explorer:** https://api.cow.fi/docs/
- **CoW Explorer (order tracking):** https://explorer.cow.fi
- **Learn (live coding):** https://learn.cow.fi
- **SDK:** https://github.com/cowprotocol/cow-sdk
- **Widget:** https://github.com/cowprotocol/cowswap
- **Discord:** https://discord.gg/cowprotocol
