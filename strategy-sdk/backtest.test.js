// Unit tests for the backtester + strategy runtime. Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runBacktest } from './src/backtest.js';
import { loadStrategy, mergeParams } from './src/runtime.js';

const approx = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} !~ ${b}`);

// Bars from [open, high, low, close] rows; time = i * 60 (1m grid).
const mkBars = (rows) => rows.map(([open, high, low, close], i) => ({
  time: i * 60, open, high, low, close, volume: 100,
}));
const noCosts = { feePct: 0, slippagePct: 0 };

test('fills happen at the NEXT bar open, never the signal bar', () => {
  const bars = mkBars([[10, 11, 9, 10], [20, 21, 19, 20], [30, 31, 29, 30]]);
  const strategy = {
    params: {},
    onBar(bar, ctx) { if (ctx.i === 0) ctx.buy(50); },
  };
  const r = runBacktest({ strategy, bars, ...noCosts });
  assert.equal(r.error, null);
  assert.equal(r.trades.length, 1);
  assert.equal(r.trades[0].price, 20);         // bar 1 open, not bar 0's 10
  approx(r.trades[0].qty, 2.5);                // 50 / 20
  assert.equal(r.trades[0].time, 60);
});

test('signal on the final bar is reported pending, not filled', () => {
  const bars = mkBars([[10, 11, 9, 10], [10, 11, 9, 10]]);
  const strategy = { params: {}, onBar(bar, ctx) { if (ctx.i === 1) ctx.buy(50, {}); } };
  const r = runBacktest({ strategy, bars, ...noCosts });
  assert.equal(r.trades.length, 0);
  assert.equal(r.pending.length, 1);
  assert.equal(r.pending[0].side, 'BUY');
});

test('bracket: SL wins when both TP and SL hit in the same bar (pessimistic)', () => {
  const bars = mkBars([
    [10, 10, 10, 10],          // signal bar
    [10, 13, 8, 11],           // fill at 10; high 13 >= tp 12, low 8 <= sl 9 → SL
  ]);
  const strategy = {
    params: {},
    onBar(bar, ctx) { if (ctx.i === 0) ctx.buy(100, { tp: 12, sl: 9 }); },
  };
  const r = runBacktest({ strategy, bars, ...noCosts });
  assert.equal(r.trades.length, 2);
  assert.equal(r.trades[1].tag, 'sl');
  assert.equal(r.trades[1].price, 9);          // min(open 10, sl 9)
  approx(r.trades[1].realizedPnl, 10 * (9 - 10));  // 10 tokens, −$1 each
});

test('bracket TP fills at max(open, tp) — gap-ups are kept', () => {
  const bars = mkBars([
    [10, 10, 10, 10],
    [10, 10, 10, 10],          // fill bar, nothing hit
    [15, 16, 14, 15],          // gaps open above tp 12 → fill at 15
  ]);
  const strategy = {
    params: {},
    onBar(bar, ctx) { if (ctx.i === 0) ctx.buy(100, { tp: 12 }); },
  };
  const r = runBacktest({ strategy, bars, ...noCosts });
  assert.equal(r.trades[1].tag, 'tp');
  assert.equal(r.trades[1].price, 15);
});

test('fee accounting: charged on both sides, reflected in realized PnL', () => {
  const bars = mkBars([[10, 10, 10, 10], [10, 10, 10, 10], [10, 10, 10, 10]]);
  const strategy = {
    params: {},
    onBar(bar, ctx) {
      if (ctx.i === 0) ctx.buy(100);
      if (ctx.i === 1) ctx.sell({ pct: 100 });
    },
  };
  const r = runBacktest({ strategy, bars, feePct: 1, slippagePct: 0 });
  // Buy $100: $1 fee → 9.9 tokens, cost basis $100. Sell: gross $99, fee $0.99
  // → proceeds $98.01. Round-trip at a flat price loses exactly both fees.
  approx(r.trades[0].qty, 9.9);
  approx(r.stats.feesUsd, 1.99);
  approx(r.trades[1].realizedPnl, -1.99, 1e-9);
  approx(r.stats.netPnlUsd, -1.99, 0.005);   // stats are rounded to cents
});

test('slippage moves fills against the trader on both sides', () => {
  const bars = mkBars([[10, 10, 10, 10], [10, 10, 10, 10], [10, 10, 10, 10]]);
  const strategy = {
    params: {},
    onBar(bar, ctx) {
      if (ctx.i === 0) ctx.buy(100);
      if (ctx.i === 1) ctx.sell({ pct: 100 });
    },
  };
  const r = runBacktest({ strategy, bars, feePct: 0, slippagePct: 1 });
  approx(r.trades[0].price, 10.1);             // buy pays up
  approx(r.trades[1].price, 9.9);              // sell receives less
});

test('pyramiding: buys average into avgCost; pct sell sizes off current qty', () => {
  const bars = mkBars([
    [10, 10, 10, 10], [10, 10, 10, 10],        // buy $30 fills at 10 → 3 tokens
    [20, 20, 20, 20],                            // (signal on bar 1) buy $30 fills at 20 → 1.5
    [20, 20, 20, 20], [20, 20, 20, 20],
  ]);
  const strategy = {
    params: {},
    onBar(bar, ctx) {
      if (ctx.i === 0 || ctx.i === 1) ctx.buy(30);
      if (ctx.i === 3) ctx.sell({ pct: 50 });
    },
  };
  const r = runBacktest({ strategy, bars, ...noCosts });
  const sell = r.trades[2];
  approx(sell.qty, 2.25);                       // half of 4.5
  // avgCost = 60 / 4.5 = 13.333…; pnl = 2.25 * (20 − 13.333…) = 15
  approx(sell.realizedPnl, 15);
  approx(r.stats.openPositionQty, 2.25);
});

test('look-ahead guard: reading beyond ctx.i returns undefined', () => {
  const bars = mkBars([[1, 1, 1, 1], [2, 2, 2, 2], [3, 3, 3, 3]]);
  const seen = [];
  const strategy = {
    params: {},
    onBar(bar, ctx) {
      if (ctx.i === 0) {
        seen.push(ctx.close[0], ctx.close[1], ctx.close[2]);
        seen.push(ctx.rsi(2)[2]);               // indicator arrays guarded too
      }
    },
  };
  const r = runBacktest({ strategy, bars, ...noCosts });
  assert.equal(r.error, null);
  assert.deepEqual(seen, [1, undefined, undefined, undefined]);
});

test('flow arrays reach the strategy aligned to bars, null outside coverage', () => {
  const bars = mkBars([[1, 1, 1, 1], [1, 1, 1, 1]]);
  // Only bar 0's minute has a bucket (times are i*60 sec → 0 ms and 60000 ms).
  const flowRows = [[0, 500, 200, 5]];
  const seen = [];
  const strategy = {
    params: {},
    onBar(bar, ctx) { seen.push(ctx.flow.net[ctx.i]); },
  };
  runBacktest({ strategy, bars, flowRows, intervalSec: 60, ...noCosts });
  assert.deepEqual(seen, [300, null]);
});

test('a throwing strategy reports the error with its bar index, keeps prior trades', () => {
  const bars = mkBars([[10, 10, 10, 10], [10, 10, 10, 10], [10, 10, 10, 10]]);
  const strategy = {
    params: {},
    onBar(bar, ctx) {
      if (ctx.i === 0) ctx.buy(10);
      if (ctx.i === 2) throw new Error('boom');
    },
  };
  const r = runBacktest({ strategy, bars, ...noCosts });
  assert.match(r.error, /bar 2: boom/);
  assert.equal(r.trades.length, 1);
});

test('loadStrategy: syntax errors and missing onBar are reported, never thrown', () => {
  assert.notEqual(loadStrategy('const strategy = {').error, null);
  assert.notEqual(loadStrategy('const strategy = { params: {} };').error, null);
  assert.equal(loadStrategy('const strategy = { onBar() {} };').error, null);
});

test('mergeParams: overrides coerce numeric strings, unknown keys ignored', () => {
  const merged = mergeParams({ len: 14, usd: 50 }, { len: '21', bogus: 9 });
  assert.deepEqual(merged, { len: 21, usd: 50 });
});

test('params flow into ctx.params merged over defaults', () => {
  const bars = mkBars([[10, 10, 10, 10], [10, 10, 10, 10]]);
  let got;
  const strategy = {
    params: { usd: 50, x: 1 },
    onBar(bar, ctx) { got = ctx.params; },
  };
  runBacktest({ strategy, bars, params: { usd: '25' }, ...noCosts });
  assert.deepEqual(got, { usd: 25, x: 1 });
});
