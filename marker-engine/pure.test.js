// Unit tests for the engine's pure decision logic. Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  sideOf, detectCross, countTradesToday, sizeTrade, priceImpactPct,
  bracketChildMarkers, bracketSiblingIds, isBuyMarker, immediateFireState,
  IMMEDIATE_TTL_MS,
} from './pure.js';

test('sideOf: at/above the level is "above"', () => {
  assert.equal(sideOf(10, 5), 'above');
  assert.equal(sideOf(5, 5), 'above');
  assert.equal(sideOf(4, 5), 'below');
});

test('detectCross: first observation only sets a baseline, never fires', () => {
  assert.deepEqual(detectCross(undefined, 4, 5, 'below'), { side: 'below', fires: false });
});

test('detectCross: no fire when the side did not change', () => {
  assert.equal(detectCross('above', 12, 10, 'cross').fires, false);
});

test('detectCross: "below" fires only on a downward cross', () => {
  // was above, price drops below → downward cross → fires
  assert.deepEqual(detectCross('above', 4, 5, 'below'), { side: 'below', fires: true });
  // was below, price rises above → upward cross → does NOT fire for a "below" marker
  assert.deepEqual(detectCross('below', 6, 5, 'below'), { side: 'above', fires: false });
});

test('detectCross: "above" fires only on an upward cross', () => {
  assert.equal(detectCross('below', 6, 5, 'above').fires, true);
  assert.equal(detectCross('above', 4, 5, 'above').fires, false);
});

test('detectCross: "cross"/null fire on either direction', () => {
  assert.equal(detectCross('above', 4, 5, 'cross').fires, true);
  assert.equal(detectCross('below', 6, 5, null).fires, true);
});

test('countTradesToday: counts only FILLED rows dated today (ms), ignores legacy block numbers', () => {
  const now = Date.UTC(2026, 6, 2, 12, 0, 0);
  const todayMs = Date.UTC(2026, 6, 2, 1, 0, 0);
  const yesterdayMs = Date.UTC(2026, 6, 1, 23, 0, 0);
  const trades = [
    { status: 'FILLED', block_time: todayMs },
    { status: 'FILLED', block_time: todayMs },
    { status: 'FILLED', block_time: yesterdayMs },   // wrong day
    { status: 'FAILED', block_time: todayMs },        // not filled
    { status: 'FILLED', block_time: 41234567 },        // legacy block number → ignored
  ];
  assert.equal(countTradesToday(trades, now), 2);
});

test('sizeTrade buy: USD notional converts to BNB via bnbPrice', () => {
  const r = sizeTrade({ isBuy: true, metaUsd: 30, bnbPrice: 600, balance: 1 });
  assert.equal(r.amountIn, '0.050000');           // 30 / 600
  assert.ok(Math.abs(r.usdNotional - 30) < 1e-9);
});

test('sizeTrade buy: aborts when BNB price is unavailable (no silent fallback)', () => {
  assert.throws(() => sizeTrade({ isBuy: true, metaUsd: 30, bnbPrice: 0, balance: 1 }),
    /BNB price unavailable/);
});

test('sizeTrade buy: caps at 98% of balance (gas reserve)', () => {
  const r = sizeTrade({ isBuy: true, metaUsd: 100000, bnbPrice: 600, balance: 1 });
  assert.equal(r.amountIn, '0.980000');
});

test('sizeTrade buy: legacy token-qty intent honored when no USD', () => {
  // metaAmount tokens * currentPrice / bnbPrice
  const r = sizeTrade({ isBuy: true, metaAmount: 1000, currentPrice: 0.6, bnbPrice: 600, balance: 10 });
  assert.equal(r.amountIn, '1.000000');           // 1000*0.6/600
});

test('sizeTrade sell: USD notional converts to tokens and caps at balance', () => {
  const r = sizeTrade({ isBuy: false, metaUsd: 30, currentPrice: 0.01, balance: 5000, decimalsIn: 18 });
  assert.equal(parseFloat(r.amountIn), 3000);     // 30 / 0.01
  assert.ok(Math.abs(r.usdNotional - 30) < 1e-9);
});

test('sizeTrade sell: caps at balance when intent exceeds holdings', () => {
  const r = sizeTrade({ isBuy: false, metaUsd: 1000, currentPrice: 0.01, balance: 5000 });
  assert.equal(parseFloat(r.amountIn), 5000);     // wanted 100k tokens, only 5k held
});

test('sizeTrade sell: throws when nothing to sell', () => {
  assert.throws(() => sizeTrade({ isBuy: false, metaUsd: 10, currentPrice: 1, balance: 0 }),
    /No balance to sell/);
});

test('priceImpactPct: positive when quote returns less than expected', () => {
  // buy $30 at $0.01 → expect 3000 tokens; quote only 2850 → 5% impact
  const impact = priceImpactPct({ isBuy: true, usdNotional: 30, currentPrice: 0.01, bnbPrice: 600, quotedOut: 2850 });
  assert.ok(Math.abs(impact - 5) < 1e-9);
});

test('priceImpactPct: 0 when it cannot be computed', () => {
  assert.equal(priceImpactPct({ isBuy: true, usdNotional: 30, currentPrice: 0, bnbPrice: 600, quotedOut: 100 }), 0);
  assert.equal(priceImpactPct({ isBuy: false, usdNotional: 30, currentPrice: 1, bnbPrice: 600, quotedOut: 0 }), 0);
});

test('bracketChildMarkers: creates TP (above) + SL (below) sized to tokens bought', () => {
  const kids = bracketChildMarkers({
    symbol: 'ALPHA_1USDT', entryId: 'e1',
    entryMeta: { usd: 30, tp: 0.02, sl: 0.008 }, tokenAmount: 3000,
  });
  assert.equal(kids.length, 2);
  const tp = kids.find(k => k.marker_type === 'TP');
  const sl = kids.find(k => k.marker_type === 'SL');
  assert.equal(tp.direction, 'above');
  assert.equal(sl.direction, 'below');
  assert.deepEqual(JSON.parse(tp.metadata_json), { amount: 3000, bracketId: 'e1' });
  assert.deepEqual(JSON.parse(sl.metadata_json), { amount: 3000, bracketId: 'e1' });
});

test('bracketChildMarkers: only the legs that are specified', () => {
  assert.equal(bracketChildMarkers({ symbol: 'X', entryId: 'e', entryMeta: { tp: 5 }, tokenAmount: 10 }).length, 1);
  assert.equal(bracketChildMarkers({ symbol: 'X', entryId: 'e', entryMeta: {}, tokenAmount: 10 }).length, 0);
});

test('bracketChildMarkers: nothing when no tokens were bought', () => {
  assert.equal(bracketChildMarkers({ symbol: 'X', entryId: 'e', entryMeta: { tp: 5, sl: 1 }, tokenAmount: 0 }).length, 0);
});

test('bracketSiblingIds: returns the OCO sibling(s) sharing a bracketId', () => {
  const fired = { id: 'tp1', metadata_json: JSON.stringify({ amount: 10, bracketId: 'e1' }) };
  const open = [
    { id: 'tp1', metadata_json: JSON.stringify({ bracketId: 'e1' }) },   // self — excluded
    { id: 'sl1', metadata_json: JSON.stringify({ bracketId: 'e1' }) },   // sibling
    { id: 'other', metadata_json: JSON.stringify({ bracketId: 'e2' }) }, // different bracket
    { id: 'plain', metadata_json: null },                                 // not bracketed
  ];
  assert.deepEqual(bracketSiblingIds(fired, open), ['sl1']);
});

test('bracketSiblingIds: empty when the fired marker is not bracketed', () => {
  assert.deepEqual(bracketSiblingIds({ id: 'x', metadata_json: null }, [{ id: 'y', metadata_json: '{}' }]), []);
});

test('isBuyMarker: STRAT_BUY buys, STRAT_SELL and grid sells do not', () => {
  assert.equal(isBuyMarker('BUY_GRID'), true);
  assert.equal(isBuyMarker('DCA_ENTRY'), true);
  assert.equal(isBuyMarker('STRAT_BUY'), true);
  assert.equal(isBuyMarker('STRAT_SELL'), false);
  assert.equal(isBuyMarker('SELL_GRID'), false);
  assert.equal(isBuyMarker('TP'), false);
  assert.equal(isBuyMarker('SL'), false);
});

test('immediateFireState: fresh STRAT markers fire, stale ones expire, others pass through', () => {
  const now = 1_750_000_000_000;
  const fresh = { marker_type: 'STRAT_BUY', created_at: now - 10_000 };
  const stale = { marker_type: 'STRAT_SELL', created_at: now - IMMEDIATE_TTL_MS - 1 };
  const atTtl = { marker_type: 'STRAT_BUY', created_at: now - IMMEDIATE_TTL_MS };
  const normal = { marker_type: 'BUY_GRID', created_at: now - 999_999_999 };
  assert.equal(immediateFireState(fresh, now), 'fire');
  assert.equal(immediateFireState(stale, now), 'expired');
  assert.equal(immediateFireState(atTtl, now), 'fire');       // TTL boundary is inclusive
  assert.equal(immediateFireState(normal, now), 'not-immediate');
});

test('countTradesToday: PAPER dry-run rows never count toward the daily cap', () => {
  const now = Date.UTC(2026, 6, 3, 12, 0, 0);
  const todayMs = Date.UTC(2026, 6, 3, 1, 0, 0);
  const trades = [
    { status: 'FILLED', block_time: todayMs },
    { status: 'PAPER', block_time: todayMs },
    { status: 'PAPER', block_time: todayMs },
  ];
  assert.equal(countTradesToday(trades, now), 1);
});

test('bracketChildMarkers: propagates strategy_id from a strategy entry to its legs', () => {
  const kids = bracketChildMarkers({
    symbol: 'X', entryId: 'e1', entryMeta: { tp: 2, sl: 1 }, tokenAmount: 10, strategyId: 'strat-9',
  });
  assert.equal(kids.length, 2);
  for (const k of kids) assert.equal(k.strategy_id, 'strat-9');
  // manual entries stay untagged
  const manual = bracketChildMarkers({ symbol: 'X', entryId: 'e2', entryMeta: { tp: 2 }, tokenAmount: 10 });
  assert.equal('strategy_id' in manual[0], false);
});
