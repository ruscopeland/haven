// Portfolio backtester tests. The parity test is the acceptance gate from the
// Token Finder plan: a 1-token universe with maxPositions=1 must produce
// EXACTLY the trades of the single-symbol backtester — proof the portfolio
// driver didn't change fill semantics.
import test from 'node:test';
import assert from 'node:assert/strict';
import { runBacktest } from './src/backtest.js';
import { normalizeUniverse } from './src/finder.js';
import { runPortfolioBacktest } from './src/portfolio.js';

function makePayload(tokensSpec, intervalMs = 60_000) {
  const n = Math.max(...Object.values(tokensSpec).map(t => t.closes.length));
  const times = Array.from({ length: n }, (_, i) => 1_700_000_000_000 + i * intervalMs);
  const tokens = Object.entries(tokensSpec).map(([symbol, spec]) => {
    const c = Array.from({ length: n }, (_, i) => spec.closes[i] ?? null);
    return {
      symbol, name: symbol, volume24h: spec.vol24h ?? 1_000_000, priceChange24h: 0,
      o: c.map(v => (v == null ? null : v * 0.999)),
      h: c.map(v => (v == null ? null : v * 1.01)),
      l: c.map(v => (v == null ? null : v * 0.99)),
      c,
      buy: c.map(v => (v == null ? null : 100)),
      sell: c.map(v => (v == null ? null : 50)),
      trades: c.map(v => (v == null ? null : 5)),
    };
  });
  return { interval: '1m', times, tokens };
}

const CONST_FINDER = `const finder = { score(ctx) { return ctx.token.volume24h; } }`;

// Deterministic strategy: buy on bar 5 with a bracket that never triggers,
// full exit on bar 12. Emits nothing before bar 5, so the portfolio's
// bind-then-active-next-bar warm-up cannot diverge from the plain backtest.
const PARITY_STRATEGY = `const strategy = {
  name: 'parity',
  params: { usd: 100 },
  onBar(bar, ctx) {
    if (ctx.i === 5 && !ctx.position.qty) {
      ctx.buy(ctx.params.usd, { sl: bar.close * 0.5, tp: bar.close * 5, tag: 'in' });
    }
    if (ctx.i === 12 && ctx.position.qty) {
      ctx.sell({ pct: 100 }, { tag: 'out' });
    }
  },
}`;

test('PARITY: 1-token universe + 1 slot === single-symbol backtest', () => {
  const closes = Array.from({ length: 20 }, (_, i) => 100 + i);
  const universe = normalizeUniverse(makePayload({ ONLY: { closes } }));

  const single = runBacktest({
    code: PARITY_STRATEGY,
    bars: universe.tokens[0].bars,
    feePct: 0.25, slippagePct: 0.1, intervalSec: 60,
  });
  const port = runPortfolioBacktest({
    strategyCode: PARITY_STRATEGY,
    finderCode: CONST_FINDER,
    universe,
    maxPositions: 1,
    feePct: 0.25, slippagePct: 0.1,
  });

  assert.equal(single.error, null);
  assert.equal(port.error, null);
  assert.equal(single.trades.length, 2);          // sanity: the test bites

  // Identical trades on the shared fields.
  const strip = t => ({ time: t.time, side: t.side, price: t.price, qty: t.qty, usd: t.usd, tag: t.tag, realizedPnl: t.realizedPnl });
  assert.deepEqual(port.trades.map(strip), single.trades.map(strip));

  // Identical equity curves and stats.
  assert.deepEqual(port.equity, single.equity);
  assert.deepEqual(port.stats, single.stats);

  // Portfolio extras are annotated.
  assert.equal(port.trades[0].symbol, 'ONLY');
  assert.equal(port.trades[0].slot, 0);
});

test('two slots bind two different tokens and both trade', () => {
  const closes = Array.from({ length: 20 }, (_, i) => 100 + i);
  const universe = normalizeUniverse(makePayload({
    BIG: { closes, vol24h: 900 },
    SMALL: { closes: closes.map(v => v * 2), vol24h: 400 },
  }));
  const buyEarly = `const strategy = {
    params: { usd: 50 },
    onBar(bar, ctx) { if (ctx.i === 4 && !ctx.position.qty) ctx.buy(ctx.params.usd); },
  }`;
  const port = runPortfolioBacktest({
    strategyCode: buyEarly, finderCode: CONST_FINDER, universe, maxPositions: 2,
  });
  assert.equal(port.error, null);
  const symbols = new Set(port.trades.map(t => t.symbol));
  assert.deepEqual([...symbols].sort(), ['BIG', 'SMALL']);
  assert.equal(port.trades.length, 2);            // one buy per slot
  // Slot timeline covers both bindings.
  const bound = new Set(port.slotTimeline.map(e => e.symbol));
  assert.deepEqual([...bound].sort(), ['BIG', 'SMALL']);
});

test('a slot holding a position never rebinds; a flat slot does', () => {
  const n = 30;
  const flat = Array.from({ length: n }, () => 100);
  // LATER overtakes EARLY's score from bar 15 on (scores = close values).
  const early = Array.from({ length: n }, (_, i) => (i < 15 ? 200 : 100));
  const later = Array.from({ length: n }, (_, i) => (i < 15 ? 100 : 500));
  const universe = normalizeUniverse(makePayload({
    EARLY: { closes: early }, LATER: { closes: later },
  }));
  const scoreByClose = `const finder = { score(ctx) { return ctx.close[ctx.i]; } }`;

  // Holder: buys as soon as it can and never sells → slot locks to EARLY.
  const holder = `const strategy = {
    params: { usd: 50 },
    onBar(bar, ctx) { if (!ctx.position.qty && ctx.i >= 3) ctx.buy(ctx.params.usd); },
  }`;
  const locked = runPortfolioBacktest({
    strategyCode: holder, finderCode: scoreByClose, universe, maxPositions: 1,
  });
  assert.equal(locked.error, null);
  assert.deepEqual([...new Set(locked.trades.map(t => t.symbol))], ['EARLY']);

  // Idler: never trades → flat slot must rebind to LATER once it overtakes.
  const idler = `const strategy = { onBar() {} }`;
  const rebound = runPortfolioBacktest({
    strategyCode: idler, finderCode: scoreByClose, universe, maxPositions: 1,
    switchMarginPct: 10,
  });
  assert.equal(rebound.error, null);
  const seq = rebound.slotTimeline.map(e => e.symbol);
  assert.deepEqual(seq, ['EARLY', 'LATER']);
});

test('finder error surfaces as error, not a throw', () => {
  const universe = normalizeUniverse(makePayload({ A: { closes: [1, 2, 3, 4] } }));
  const r = runPortfolioBacktest({
    strategyCode: `const strategy = { onBar() {} }`,
    finderCode: `const finder = {}`,
    universe,
  });
  assert.match(r.error, /finder: finder.score/);
});

test('strategy runtime throw aborts with bar context', () => {
  const universe = normalizeUniverse(makePayload({ A: { closes: [1, 2, 3, 4, 5, 6] } }));
  const r = runPortfolioBacktest({
    strategyCode: `const strategy = { onBar(bar, ctx) { if (ctx.i === 3) throw new Error('kaput'); } }`,
    finderCode: CONST_FINDER,
    universe,
  });
  assert.match(r.error, /kaput/);
});
