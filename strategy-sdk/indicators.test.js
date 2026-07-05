// Unit tests for the indicator library. Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  sma, ema, wma, rsi, macd, bollinger, atr, stochastic, vwap, obv,
  highest, lowest, stddev, roc, crossover, crossunder,
} from './src/indicators.js';
import { aggregateFlow, flowCoverage } from './src/flow.js';

const approx = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} !~ ${b}`);

test('sma: nulls through warm-up, then rolling mean', () => {
  assert.deepEqual(sma([1, 2, 3, 4, 5], 3), [null, null, 2, 3, 4]);
});

test('ema: seeds with SMA then smooths', () => {
  // len 3 → k = 0.5; seed at i=2 is sma(1,2,3)=2; then 4*.5+2*.5=3; 5*.5+3*.5=4
  assert.deepEqual(ema([1, 2, 3, 4, 5], 3), [null, null, 2, 3, 4]);
});

test('wma: weights recent values more', () => {
  const w = wma([1, 2, 3, 4], 3);
  assert.equal(w[0], null);
  assert.equal(w[1], null);
  approx(w[2], 14 / 6);   // (3*3 + 2*2 + 1*1) / 6
  approx(w[3], 20 / 6);
});

test('rsi: 100 on pure gains, 50 on balanced gain/loss (Wilder)', () => {
  const r = rsi([1, 2, 3, 2], 2);
  assert.deepEqual(r.slice(0, 2), [null, null]);
  approx(r[2], 100);
  approx(r[3], 50);
});

test('stddev + bollinger: zero width on a flat series', () => {
  const bb = bollinger([5, 5, 5, 5], 3, 2);
  assert.equal(bb.middle[3], 5);
  assert.equal(bb.upper[3], 5);
  assert.equal(bb.lower[3], 5);
  assert.equal(stddev([5, 5, 5, 5], 3)[3], 0);
});

test('atr: Wilder smoothing over true ranges', () => {
  const high = [2, 3, 4], low = [1, 2, 3], close = [1.5, 2.5, 3.5];
  const a = atr(high, low, close, 2);
  assert.equal(a[0], null);
  approx(a[1], 1.25);      // (TR0=1 + TR1=1.5) / 2
  approx(a[2], 1.375);     // (1.25*1 + 1.5) / 2
});

test('stochastic: close at the top of the range → %K = 100', () => {
  const high = [2, 3, 4], low = [1, 2, 3], close = [2, 3, 4];
  const { k } = stochastic(high, low, close, 3, 1);
  approx(k[2], 100);
});

test('vwap: volume-weighted typical price, cumulative', () => {
  const v = vwap([2, 4], [2, 4], [2, 4], [1, 3]);
  approx(v[0], 2);
  approx(v[1], (2 * 1 + 4 * 3) / 4);   // 3.5
});

test('obv: adds volume on up closes, subtracts on down', () => {
  assert.deepEqual(obv([1, 2, 1], [10, 10, 10]), [0, 10, 0]);
});

test('highest/lowest/roc', () => {
  assert.deepEqual(highest([1, 5, 3], 2), [null, 5, 5]);
  assert.deepEqual(lowest([1, 5, 3], 2), [null, 1, 3]);
  approx(roc([10, 11], 1)[1], 10);
});

test('macd: defined after slow warm-up, hist = macd - signal', () => {
  const src = Array.from({ length: 60 }, (_, i) => 100 + Math.sin(i / 5) * 10);
  const m = macd(src, 5, 10, 3);
  assert.equal(m.macd[8], null);
  assert.notEqual(m.macd[20], null);
  assert.notEqual(m.signal[20], null);
  approx(m.hist[20], m.macd[20] - m.signal[20]);
});

test('crossover/crossunder: needs a genuine side change, handles constants and nulls', () => {
  assert.equal(crossover([1, 3], [2, 2], 1), true);
  assert.equal(crossover([2, 3], [2, 2], 1), true);    // from-equal counts
  assert.equal(crossover([3, 4], [2, 2], 1), false);   // already above
  assert.equal(crossunder([3, 1], 2, 1), true);        // constant side
  assert.equal(crossover([null, 3], [2, 2], 1), false); // warm-up null → no signal
  assert.equal(crossover([1, 3], [2, 2], 0), false);   // first bar
});

test('aggregateFlow: sums covered minutes, null (not 0) where no buckets exist', () => {
  const rows = [
    [120_000, 100, 40, 3],   // minute 2
    [180_000, 50, 10, 1],    // minute 3
  ];
  // Two 5-minute bars: [0, 300) covered, [300, 600) not covered at all.
  const f = aggregateFlow(rows, [0, 300], 300);
  assert.equal(f.buy[0], 150);
  assert.equal(f.sell[0], 50);
  assert.equal(f.net[0], 100);
  assert.equal(f.trades[0], 4);
  assert.equal(f.buy[1], null);   // absence ≠ zero flow
  assert.equal(flowCoverage(f), 1);
});

test('aggregateFlow: a covered zero-volume minute yields 0, not null', () => {
  const f = aggregateFlow([[0, 0, 0, 0]], [0], 60);
  assert.equal(f.buy[0], 0);
  assert.equal(f.net[0], 0);
});
