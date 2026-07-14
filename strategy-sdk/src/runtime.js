// Strategy loading + the ctx object handed to strategies. Works identically in
// the browser (backtests) and Node (live/dry runner) — no ESM/CJS tricks, the
// strategy source is evaluated with new Function and must define `strategy`.

import * as ind from './indicators.js';

// Evaluate strategy source. The snippet defines a top-level `strategy` object:
//   { name, params: {...defaults}, init(ctx)?, onBar(bar, ctx) }
// Returns { strategy, error } — never throws.
export function loadStrategy(code) {
  try {
    const strategy = new Function('"use strict";\n' + code + '\n;return strategy;')();
    if (!strategy || typeof strategy.onBar !== 'function') {
      return { strategy: null, error: 'strategy.onBar(bar, ctx) is required' };
    }
    return { strategy, error: null };
  } catch (e) {
    return { strategy: null, error: e.message || String(e) };
  }
}

// Build the shared, read-only half of a ctx: guarded series, cached
// indicators, cross helpers, params/state/log. Used by BOTH strategy ctxs
// (createCtx adds position + buy/sell) and finder ctxs (createFinderCtx adds
// token metadata; finders can't trade). The driver advances the bar cursor
// with ctx.__setBar(i) and supplies:
//   bars     [{time (unix sec), open, high, low, close, volume}], oldest first
//   params   defaults merged with user overrides
//   state    persistent object (ctx.state)
//   log      (msg) => void
export function createBaseCtx({ bars, params, state, log }) {
  const cursor = { i: -1 };

  // Look-ahead guard: reads at indices beyond the current bar return undefined.
  // Cheap Proxy over the raw arrays; raw arrays are kept for indicator math.
  const rawOf = new WeakMap();
  const guard = (arr) => {
    const p = new Proxy(arr, {
      get(t, prop) {
        if (typeof prop === 'string') {
          const idx = Number(prop);
          if (Number.isInteger(idx) && idx > cursor.i) return undefined;
        }
        return Reflect.get(t, prop);
      },
    });
    rawOf.set(p, arr);
    return p;
  };
  const raw = (arr) => rawOf.get(arr) || arr;

  const open = bars.map(b => b.open);
  const high = bars.map(b => b.high);
  const low = bars.map(b => b.low);
  const close = bars.map(b => b.close);
  const volume = bars.map(b => b.volume);
  const time = bars.map(b => b.time);

  // Indicator results are cached per (name, source, args) for the whole run.
  const cache = new Map();
  let srcSeq = 0;
  const srcIds = new WeakMap();
  const srcId = (arr) => {
    if (!srcIds.has(arr)) srcIds.set(arr, ++srcSeq);
    return srcIds.get(arr);
  };
  const cached = (key, compute) => {
    if (!cache.has(key)) cache.set(key, compute());
    return cache.get(key);
  };
  const guardObj = (obj) => {
    const out = {};
    for (const k of Object.keys(obj)) out[k] = guard(obj[k]);
    return out;
  };

  // Single-series indicators accept (len) over close, or (srcArray, len).
  const overSrc = (name, fn) => (a, b) => {
    const src = typeof a === 'number' ? close : raw(a);
    const len = typeof a === 'number' ? a : b;
    return cached(`${name}:${src === close ? 'c' : srcId(src)}:${len}`, () => guard(fn(src, len)));
  };

  const ctx = {
    get i() { return cursor.i; },
    bars: guard(bars),
    open: guard(open), high: guard(high), low: guard(low),
    close: guard(close), volume: guard(volume), time: guard(time),
    params,
    state,

    sma: overSrc('sma', ind.sma),
    ema: overSrc('ema', ind.ema),
    wma: overSrc('wma', ind.wma),
    rsi: overSrc('rsi', ind.rsi),
    stddev: overSrc('stddev', ind.stddev),
    highest: overSrc('highest', ind.highest),
    lowest: overSrc('lowest', ind.lowest),
    roc: overSrc('roc', ind.roc),
    macd: (fast = 12, slow = 26, signal = 9) =>
      cached(`macd:${fast}:${slow}:${signal}`, () => guardObj(ind.macd(close, fast, slow, signal))),
    bb: (len = 20, mult = 2) =>
      cached(`bb:${len}:${mult}`, () => guardObj(ind.bollinger(close, len, mult))),
    atr: (len = 14) => cached(`atr:${len}`, () => guard(ind.atr(high, low, close, len))),
    stoch: (kLen = 14, dLen = 3) =>
      cached(`stoch:${kLen}:${dLen}`, () => guardObj(ind.stochastic(high, low, close, kLen, dLen))),
    vwap: () => cached('vwap', () => guard(ind.vwap(high, low, close, volume))),
    obv: () => cached('obv', () => guard(ind.obv(close, volume))),

    // Accept guarded arrays or plain numbers on either side.
    crossover: (a, b) => ind.crossover(raw(a), raw(b), cursor.i),
    crossunder: (a, b) => ind.crossunder(raw(a), raw(b), cursor.i),

    log: (msg) => log(String(msg)),
  };

  // Driver-only bar cursor; not part of the authoring surface.
  Object.defineProperty(ctx, '__setBar', {
    value: (i) => { cursor.i = i; },
    enumerable: false,
  });

  return ctx;
}

// Full strategy ctx: the base plus the trading surface. Same signature and
// behavior as before the finder refactor — position is a live getter, buy/sell
// forward to the driver's emit sinks.
export function createCtx({ bars, params, state, position, emit, log }) {
  const ctx = createBaseCtx({ bars, params, state, log });
  Object.defineProperty(ctx, 'position', {
    get() { return position; },
    enumerable: true,
  });
  ctx.buy = (usd, opts = {}) => emit.buy(usd, opts);
  ctx.sell = (spec, opts = {}) => emit.sell(spec, opts);
  return ctx;
}

// Merge user param overrides over the strategy's declared defaults, coercing
// numerics (the params form and params_json hand us strings).
export function mergeParams(defaults = {}, overrides = {}) {
  const out = { ...defaults };
  for (const [k, v] of Object.entries(overrides || {})) {
    if (!(k in out)) continue;
    const n = typeof v === 'string' ? Number(v) : v;
    out[k] = typeof out[k] === 'number' && Number.isFinite(n) ? n : v;
  }
  return out;
}
