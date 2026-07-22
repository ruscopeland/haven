// Pre-trade quote preview — mirrors what the engine will execute.
// Uses CoW Protocol for on-chain swap pricing via intent-based batch auctions.
//   sizing   = USD intent → token amount using Binance Alpha market price
//   quote    = CoW Protocol /api/v1/quote (POST)
// Keep ON-DEMAND only (no polling).

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:8000';

// CoW Protocol native token address
const COW_NATIVE = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';
export const ENGINE_SLIPPAGE_PCT = 0.5;

// CoW Protocol API base per chain
const COW_BASE = {
  bsc:       'https://api.cow.fi/bnb/api/v1',
  ethereum:  'https://api.cow.fi/mainnet/api/v1',
  base:      'https://api.cow.fi/base/api/v1',
  arbitrum:  'https://api.cow.fi/arbitrum_one/api/v1',
};

// BNB price for gas estimation
export async function fetchBnbPriceUsd() {
  const r = await fetch(`${API_URL}/market/prices?symbols=BNB`);
  if (!r.ok) throw new Error(`BNB price fetch failed (HTTP ${r.status})`);
  const j = await r.json();
  const price = Number(j.prices?.BNB?.price || 0);
  if (!(price > 0)) throw new Error('BNB price unavailable');
  return price;
}

// side: 'BUY' | 'SELL'. usd: user's USD intent. contract: token address.
// marketPrice: Binance Alpha market price. heldQty: wallet balance (null = unknown).
// chain: chain id string ('bsc', 'ethereum', etc.)
export async function fetchSwapPreview({ side, usd, contract, marketPrice, heldQty, chain, walletAddress }) {
  if (!(marketPrice > 0)) throw new Error('No live market price from Binance Alpha');

  const cowURL = COW_BASE[chain || 'bsc'];
  if (!cowURL) throw new Error(`CoW Protocol not available on chain: ${chain}`);

  const bnbPrice = await fetchBnbPriceUsd();
  const isBuy = side === 'BUY';

  let sellToken, buyToken, sellAmountBeforeFee, expectedBuyAmount;
  let usdNotional;

  if (isBuy) {
    // Buying token with native (BNB/ETH)
    sellToken = COW_NATIVE;
    buyToken = contract;
    sellAmountBeforeFee = BigInt(Math.floor(usd / bnbPrice * 1e18)).toString(); // native in wei
    usdNotional = usd;
  } else {
    // Selling token for native
    sellToken = contract;
    buyToken = COW_NATIVE;
    let tokenAmt = usd / marketPrice;
    if (heldQty != null && tokenAmt > heldQty) tokenAmt = heldQty;
    if (!(tokenAmt > 0)) throw new Error('Nothing to sell');
    sellAmountBeforeFee = BigInt(Math.floor(tokenAmt * 1e18)).toString(); // 18 decimals default
    usdNotional = tokenAmt * marketPrice;
  }

  // POST quote to CoW Protocol
  const quoteBody = {
    kind: isBuy ? 'buy' : 'sell',
    sellToken,
    buyToken,
    sellAmountBeforeFee,
    from: walletAddress || '0x0000000000000000000000000000000000000000',
    receiver: walletAddress || '0x0000000000000000000000000000000000000000',
    validFor: 1800,
  };

  let res;
  try {
    res = await fetch(`${cowURL}/quote`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(quoteBody),
    });
  } catch {
    throw new Error('CoW Protocol API unreachable');
  }

  const text = await res.text();
  let body;
  try { body = JSON.parse(text); }
  catch { throw new Error(`CoW Protocol returned non-JSON: ${text.slice(0, 200)}`); }

  if (!res.ok) {
    throw new Error(body?.description || body?.errorType || `CoW Protocol HTTP ${res.status}`);
  }

  const q = body?.quote;
  if (!q || !q.buyAmount) throw new Error('CoW Protocol returned no quote');

  // CoW returns raw token amounts (sellAmount after fees, buyAmount after fees)
  // For sell: sellAmount is what leaves your wallet, buyAmount is what you receive
  // For buy: sellAmount is what you pay, buyAmount is what you receive
  const quotedBuyRaw = BigInt(q.buyAmount);
  const quotedOut = Number(quotedBuyRaw) / 1e18; // native has 18 decimals

  // Fee in sell token
  const feeAmount = q.feeAmount ? Number(BigInt(q.feeAmount)) / 1e18 : 0;

  // Price impact: compare quoted vs expected
  expectedBuyAmount = isBuy ? usd / marketPrice : usdNotional / bnbPrice;
  const impactPct = expectedBuyAmount > 0 ? (1 - quotedOut / expectedBuyAmount) * 100 : 0;

  const effPrice = isBuy ? usdNotional / quotedOut : (quotedOut * bnbPrice) / (usdNotional / marketPrice);

  return {
    side,
    usdNotional,
    bnbPrice,
    amountIn: isBuy ? usd / bnbPrice : usd / marketPrice,
    expectedOut: expectedBuyAmount,
    quotedOut,
    impactPct,
    effPrice,
    feeAmount,
    minOut: quotedOut * 0.995, // 0.5% slippage
    gasBnb: null, // CoW Protocol is gasless for the user
    gasUsd: null,
    route: ['CoW Protocol'],
    fetchedAt: Date.now(),
  };
}
