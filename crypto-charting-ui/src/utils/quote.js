// Pre-trade quote preview for the token page — mirrors the marker engine's
// execution path so what the user sees is what the engine will do:
//   sizing   = marker-engine/pure.js sizeTrade  (buy: usd/bnbPrice BNB in;
//              sell: usd/Binance Alpha market price tokens, capped at balance)
//   quote    = OpenOcean v4 aggregator (the engine's router, chain.js)
//   impact   = marker-engine/pure.js priceImpactPct (quoted out vs what the
//              Binance Alpha market price predicts)
// The engine re-quotes at execution; this preview is informational. Keep it
// ON-DEMAND only (no polling) — OpenOcean allows ~1 req/1.6s per IP and the
// engine quotes from this same machine when a trade fires.

const OO_NATIVE = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';

// Engine config (marker-engine/index.js defaults; no .env overrides are set).
export const ENGINE_SLIPPAGE_PCT = 0.5;
export const ENGINE_GAS_GWEI = 1;

// Same server-side Binance Alpha source used by the engine and charts.
export async function fetchBnbPriceUsd() {
  const api = import.meta.env.VITE_API_URL || 'http://localhost:8000';
  const r = await fetch(`${api}/market/prices?symbols=BNB`);
  if (!r.ok) throw new Error(`BNB price fetch failed (HTTP ${r.status})`);
  const j = await r.json();
  const price = Number(j.prices?.BNB?.price || 0);
  if (!(price > 0)) throw new Error('BNB price unavailable');
  return price;
}

// The chosen route out of the quote payload: path.routes[].subRoutes[].dexes[].dex.
// Defensive — returns [] if OpenOcean changes the shape.
function extractRoute(data) {
  try {
    const names = [];
    for (const route of data?.path?.routes || []) {
      for (const sub of route?.subRoutes || []) {
        for (const d of sub?.dexes || []) {
          if (d?.dex) names.push(d.percentage != null ? `${d.dex} ${d.percentage}%` : String(d.dex));
        }
      }
    }
    return [...new Set(names)];
  } catch {
    return [];
  }
}

// side: 'BUY' | 'SELL'. usd: user's USD intent. contract: token address.
// marketPrice: the live Binance Alpha price the chart/engine use. heldQty: wallet
// balance for sells (null = unknown, no cap applied).
export async function fetchSwapPreview({ side, usd, contract, marketPrice, heldQty }) {
  if (!(marketPrice > 0)) throw new Error('No live market price from Binance Alpha');
  const bnbPrice = await fetchBnbPriceUsd();
  const isBuy = side === 'BUY';

  let amountIn, usdNotional, expectedOut, capped = false;
  if (isBuy) {
    amountIn = usd / bnbPrice;                 // BNB in — engine sizing
    usdNotional = usd;
    expectedOut = usd / marketPrice;        // tokens the market price predicts
  } else {
    let amtToken = usd / marketPrice;       // tokens out of the wallet — engine sizing
    if (heldQty != null && amtToken > heldQty) { amtToken = heldQty; capped = true; }
    if (!(amtToken > 0)) throw new Error('Nothing to sell');
    amountIn = amtToken;
    usdNotional = amtToken * marketPrice;
    expectedOut = usdNotional / bnbPrice;      // BNB the market price predicts
  }

  const inAddr = isBuy ? OO_NATIVE : contract;
  const outAddr = isBuy ? contract : OO_NATIVE;
  const amountStr = isBuy ? amountIn.toFixed(6) : amountIn.toFixed(8);
  const url = `https://open-api.openocean.finance/v4/bsc/quote` +
    `?inTokenAddress=${inAddr}&outTokenAddress=${outAddr}&amount=${amountStr}` +
    `&gasPrice=${ENGINE_GAS_GWEI}&slippage=${ENGINE_SLIPPAGE_PCT}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`OpenOcean HTTP ${res.status}`);
  const body = await res.json();
  const data = body?.data;
  if (!data || !data.outAmount) throw new Error(`OpenOcean returned no quote (code ${body?.code})`);

  const outDecimals = Number((isBuy ? data.outToken?.decimals : 18) ?? 18);
  const quotedOut = Number(data.outAmount) / 10 ** outDecimals;
  if (!(quotedOut > 0)) throw new Error('OpenOcean quoted zero output');

  // priceImpactPct from marker-engine/pure.js: positive = you get less than
  // the market price predicts.
  const impactPct = (1 - quotedOut / expectedOut) * 100;
  const effPrice = isBuy ? usdNotional / quotedOut : (quotedOut * bnbPrice) / amountIn;
  const minOut = quotedOut * (1 - ENGINE_SLIPPAGE_PCT / 100);

  // Engine sends the tx with a +20% gas-limit buffer; actual cost is usually
  // at or below the estimate.
  const gasUnits = Number(data.estimatedGas || data.gasLimit || 0);
  const gasBnb = gasUnits > 0 ? gasUnits * 1.2 * ENGINE_GAS_GWEI * 1e-9 : null;
  const gasUsd = gasBnb != null ? gasBnb * bnbPrice : null;

  return {
    side, usdNotional, capped, bnbPrice, amountIn, expectedOut, quotedOut,
    impactPct, effPrice, minOut, gasBnb, gasUsd,
    route: extractRoute(data),
    fetchedAt: Date.now(),
  };
}
