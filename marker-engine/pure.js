// Pure decision logic for the marker engine — no network, no chain, no clock.
// Extracted so it can be unit-tested in isolation (see pure.test.js). engine.js
// imports these; keep them free of side effects.

// Which side of its level a price is on.
export function sideOf(price, markerPrice) {
  return price >= markerPrice ? 'above' : 'below';
}

// Marker types that BUY (everything else tradeable sells).
export const BUY_MARKER_TYPES = ['BUY_GRID', 'DCA_ENTRY', 'STRAT_BUY'];
export function isBuyMarker(markerType) {
  return BUY_MARKER_TYPES.includes(markerType);
}

// Immediate-fire markers posted by the strategy runner: the engine executes
// them on sight, no price cross needed. A marker that sat unexecuted past its
// TTL means the engine was down when the strategy signaled — executing it now
// would trade at a stale price, so it must be discarded, never fired.
export const IMMEDIATE_MARKER_TYPES = ['STRAT_BUY', 'STRAT_SELL'];
export const IMMEDIATE_TTL_MS = 120_000;

export function immediateFireState(marker, nowMs = Date.now()) {
  if (!IMMEDIATE_MARKER_TYPES.includes(marker.marker_type)) return 'not-immediate';
  return nowMs - (marker.created_at || 0) > IMMEDIATE_TTL_MS ? 'expired' : 'fire';
}

// Decide whether a marker fires given its previous observed side and the new price.
// direction: 'below' = fire only on a downward cross, 'above' = only upward,
// 'cross'/null/undefined = fire on either. Returns { side, fires }.
export function detectCross(prevSide, price, markerPrice, direction) {
  const side = sideOf(price, markerPrice);
  if (!prevSide || side === prevSide) return { side, fires: false };
  if ((direction === 'above' || direction === 'below') && side !== direction) {
    return { side, fires: false };
  }
  return { side, fires: true };
}

// Count FILLED trades that happened on the current UTC day. Legacy rows store a
// block NUMBER in block_time (~1e7); real ms timestamps (~1.7e12) dwarf the
// midnight threshold, so legacy rows never falsely count.
export function countTradesToday(trades, nowMs = Date.now()) {
  const utcMidnight = new Date(nowMs).setUTCHours(0, 0, 0, 0);
  return (trades || []).filter(t => t.status === 'FILLED' && t.block_time >= utcMidnight).length;
}

// Compute the trade size from the marker's intent. Returns { amountIn, usdNotional }
// (amountIn is a decimal string ready for the swap API). Throws on impossible sizing.
//   isBuy   → amountIn is BNB to spend; needs bnbPrice.
//   !isBuy  → amountIn is tokens to sell; capped at balance.
// metaUsd is the preferred (USD-notional) intent; metaAmount is the legacy token qty.
export function sizeTrade({
  isBuy, metaUsd = 0, metaAmount = 0, currentPrice = 0, bnbPrice = 0,
  balance = 0, quickBuyPercent = 5, quickSellPercent = 100, decimalsIn = 18,
}) {
  if (isBuy) {
    if (!(bnbPrice > 0)) throw new Error('BNB price unavailable — refusing to size a buy');
    let amtBnb;
    if (metaUsd > 0) amtBnb = metaUsd / bnbPrice;
    else if (metaAmount > 0 && currentPrice > 0) amtBnb = (metaAmount * currentPrice) / bnbPrice;
    else amtBnb = balance * (quickBuyPercent / 100);
    amtBnb = Math.min(amtBnb, balance * 0.98); // keep a gas reserve
    if (!(amtBnb > 0)) throw new Error('Insufficient BNB balance for marker buy');
    return { amountIn: amtBnb.toFixed(6), usdNotional: amtBnb * bnbPrice };
  }
  let amtToken;
  if (metaUsd > 0 && currentPrice > 0) amtToken = metaUsd / currentPrice;
  else if (metaAmount > 0) amtToken = metaAmount;
  else amtToken = balance * (quickSellPercent / 100);
  amtToken = Math.min(amtToken, balance);
  if (!(amtToken > 0)) throw new Error('No balance to sell');
  return { amountIn: amtToken.toFixed(Math.min(decimalsIn, 18)), usdNotional: amtToken * currentPrice };
}

// Bracket (OCO) orders: after a BUY entry fills, spawn its take-profit and/or
// stop-loss SELL legs sized to the amount actually bought. entryMeta is the
// parsed metadata_json of the entry marker; it may carry tp and/or sl prices.
// Returns an array of marker-create payloads (possibly empty).
// strategyId (when the entry came from a strategy) propagates to the legs so
// their fills are tagged in trade_history and the runner's position rebuild
// sees the exits.
export function bracketChildMarkers({ symbol, entryId, entryMeta = {}, tokenAmount = 0, strategyId = null }) {
  const children = [];
  if (!(tokenAmount > 0)) return children;
  const tp = parseFloat(entryMeta.tp);
  const sl = parseFloat(entryMeta.sl);
  if (tp > 0) {
    children.push({
      symbol, price: tp, marker_type: 'TP', direction: 'above',
      ...(strategyId ? { strategy_id: strategyId } : {}),
      metadata_json: JSON.stringify({ amount: tokenAmount, bracketId: entryId }),
    });
  }
  if (sl > 0) {
    children.push({
      symbol, price: sl, marker_type: 'SL', direction: 'below',
      ...(strategyId ? { strategy_id: strategyId } : {}),
      metadata_json: JSON.stringify({ amount: tokenAmount, bracketId: entryId }),
    });
  }
  return children;
}

// Given a just-fired marker and the currently-open markers, return the ids of its
// OCO siblings (same bracketId) that should be cancelled. Empty if not bracketed.
export function bracketSiblingIds(firedMarker, openMarkers) {
  const bid = parseBracketId(firedMarker);
  if (!bid) return [];
  return (openMarkers || [])
    .filter(m => m.id !== firedMarker.id && parseBracketId(m) === bid)
    .map(m => m.id);
}

function parseBracketId(marker) {
  try { return JSON.parse(marker.metadata_json || '{}').bracketId; }
  catch { return undefined; }
}

// Implied price impact (%) of a quote versus the CMC market price.
// Positive = you get less than expected. Returns 0 when it can't be computed.
export function priceImpactPct({ isBuy, usdNotional, currentPrice, bnbPrice, quotedOut }) {
  if (!(quotedOut > 0)) return 0;
  const expectedOut = isBuy
    ? (currentPrice > 0 ? usdNotional / currentPrice : 0)
    : (bnbPrice > 0 ? usdNotional / bnbPrice : 0);
  if (!(expectedOut > 0)) return 0;
  return (1 - quotedOut / expectedOut) * 100;
}
