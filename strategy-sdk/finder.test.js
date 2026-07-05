// Token Finder runtime tests: loading, universe normalization, ranking
// determinism, the look-ahead guard on finder ctxs, forward returns, and the
// chooseBinding rebinding rule (shared by backtest + live runner).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  loadFinder, normalizeUniverse, runRanking,
  computeForwardReturns, finderQuality, chooseBinding,
} from './src/finder.js';

// ── Synthetic /universe payload builder ─────────────────────────────────────
// tokensSpec: { SYM: { closes: [...|null], buy?: [...], sell?: [...], vol24h? } }
function makePayload(tokensSpec, intervalMs = 60_000) {
  const n = Math.max(...Object.values(tokensSpec).map(t => t.closes.length));
  const times = Array.from({ length: n }, (_, i) => 1_700_000_000_000 + i * intervalMs);
  const tokens = Object.entries(tokensSpec).map(([symbol, spec]) => {
    const pad = (arr, fill) => Array.from({ length: n }, (_, i) => arr?.[i] ?? fill);
    const c = pad(spec.closes, null);
    return {
      symbol, name: symbol, volume24h: spec.vol24h ?? 1_000_000, priceChange24h: 0,
      o: c.map(v => (v == null ? null : v * 0.999)),
      h: c.map(v => (v == null ? null : v * 1.002)),
      l: c.map(v => (v == null ? null : v * 0.998)),
      c,
      buy: c.map((v, i) => (v == null ? null : (spec.buy?.[i] ?? 100))),
      sell: c.map((v, i) => (v == null ? null : (spec.sell?.[i] ?? 50))),
      trades: c.map(v => (v == null ? null : 5)),
    };
  });
  return { interval: '1m', times, tokens };
}

test('loadFinder: requires score()', () => {
  assert.equal(loadFinder('const finder = {}').error, 'finder.score(ctx) is required');
  assert.equal(loadFinder('const finder = { score(ctx){ return 1 } }').error, null);
  assert.ok(loadFinder('syntax error {{{').error);
});

test('normalizeUniverse: offset, seconds conversion, forward-fill, flow nulls', () => {
  const u = normalizeUniverse(makePayload({
    AAA: { closes: [null, null, 10, 11, null, 13] },
  }));
  const t = u.tokens[0];
  assert.equal(t.offset, 2);                      // two leading null bars
  assert.equal(t.bars.length, 4);                 // from offset to end
  assert.equal(u.times[0] * 1000, 1_700_000_000_000);
  assert.equal(u.intervalSec, 60);
  // interior gap at global index 4 → bars[2]: flat fill at previous close, flow null
  assert.equal(t.bars[2].close, 11);
  assert.equal(t.bars[2].volume, 0);
  assert.equal(t.flow.buy[2], null);
  assert.equal(t.flow.net[1], 50);                // 100 buy − 50 sell on covered bars
});

test('normalizeUniverse: token with no coverage is dropped', () => {
  const u = normalizeUniverse(makePayload({
    AAA: { closes: [1, 2, 3] },
    BBB: { closes: [null, null, null] },
  }));
  assert.deepEqual(u.tokens.map(t => t.symbol), ['AAA']);
});

test('runRanking: sorts desc, respects filter and null scores', () => {
  const u = normalizeUniverse(makePayload({
    HI: { closes: [1, 1, 1, 1], vol24h: 500 },
    LO: { closes: [1, 1, 1, 1], vol24h: 300 },
    OUT: { closes: [1, 1, 1, 1], vol24h: 5 },     // filtered out
  }));
  const { rankings, error } = runRanking({
    code: `const finder = {
      params: { minVol: 100 },
      filter(ctx) { return ctx.token.volume24h >= ctx.params.minVol; },
      score(ctx) { return ctx.token.volume24h; },
    }`,
    universe: u,
  });
  assert.equal(error, null);
  assert.equal(rankings[0], null);                // minBars=2 → no scores at bar 0
  assert.deepEqual(rankings[3].map(r => r.symbol), ['HI', 'LO']);
  assert.equal(rankings[3][0].score, 500);
});

test('runRanking: look-ahead guard hides future bars from score()', () => {
  const u = normalizeUniverse(makePayload({ AAA: { closes: [1, 2, 3, 4, 5] } }));
  const { rankings, error } = runRanking({
    // If the guard leaked, close[i+1] would be a number and the score would be
    // that future price. Guarded, it reads undefined → sentinel −1.
    code: `const finder = { score(ctx) { return ctx.close[ctx.i + 1] ?? -1; } }`,
    universe: u,
  });
  assert.equal(error, null);
  for (const r of rankings) {
    if (r) assert.equal(r[0].score, -1);
  }
});

test('runRanking: a throwing finder reports error, does not throw', () => {
  const u = normalizeUniverse(makePayload({ AAA: { closes: [1, 2, 3] } }));
  const { error } = runRanking({
    code: `const finder = { score() { throw new Error('boom'); } }`,
    universe: u,
  });
  assert.match(error, /boom/);
});

test('computeForwardReturns + finderQuality', () => {
  const u = normalizeUniverse(makePayload({
    UP: { closes: [100, 100, 110, 121] },        // +10% per bar from bar 1
    FLAT: { closes: [50, 50, 50, 50] },
  }));
  const fwd = computeForwardReturns(u, 1);
  assert.ok(Math.abs(fwd.bySymbol.get('UP')[1] - 10) < 1e-9);
  assert.equal(fwd.bySymbol.get('FLAT')[1], 0);
  assert.equal(fwd.bySymbol.get('UP')[3], null);  // no bar beyond the horizon

  const rankings = [null, [{ symbol: 'UP', score: 2 }, { symbol: 'FLAT', score: 1 }], null, null];
  const q = finderQuality(rankings, fwd, 1);
  assert.ok(Math.abs(q.topKAvg[1] - 10) < 1e-9);  // top-1 = UP = +10%
  assert.ok(Math.abs(q.median[1] - 5) < 1e-9);    // median of {10, 0}
});

// ── chooseBinding ───────────────────────────────────────────────────────────
const R = (...pairs) => pairs.map(([symbol, score]) => ({ symbol, score }));

test('chooseBinding: empty slots take best-first, no duplicates', () => {
  const out = chooseBinding(
    [{ symbol: null, hasPosition: false }, { symbol: null, hasPosition: false }],
    R(['A', 10], ['B', 5], ['C', 1]),
  );
  assert.deepEqual(out, ['A', 'B']);
});

test('chooseBinding: locked slot is never touched, its symbol is reserved', () => {
  const out = chooseBinding(
    [{ symbol: 'A', hasPosition: true }, { symbol: null, hasPosition: false }],
    R(['A', 10], ['B', 5]),
  );
  assert.deepEqual(out, ['A', 'B']);              // flat slot must skip taken A
});

test('chooseBinding: hysteresis — challenger must beat margin', () => {
  const slots = [{ symbol: 'B', hasPosition: false }];
  // B scores 100; A scores 105 → within 10% margin → keep B.
  assert.deepEqual(chooseBinding(slots, R(['A', 105], ['B', 100]), { switchMarginPct: 10 }), ['B']);
  // A scores 115 → beats 100 + 10% → switch.
  assert.deepEqual(chooseBinding(slots, R(['A', 115], ['B', 100]), { switchMarginPct: 10 }), ['A']);
});

test('chooseBinding: bound token that dropped out of the ranking is replaced', () => {
  const out = chooseBinding(
    [{ symbol: 'GONE', hasPosition: false }],
    R(['A', 1]),
  );
  assert.deepEqual(out, ['A']);
});

test('chooseBinding: empty ranking keeps current bindings', () => {
  const out = chooseBinding(
    [{ symbol: 'A', hasPosition: false }, { symbol: null, hasPosition: false }],
    null,
  );
  assert.deepEqual(out, ['A', null]);
});

test('chooseBinding: tradeable set excludes untradeable candidates', () => {
  const out = chooseBinding(
    [{ symbol: null, hasPosition: false }],
    R(['A', 10], ['B', 5]),
    { tradeable: new Set(['B']) },
  );
  assert.deepEqual(out, ['B']);
});
