// Token Finder runtime — loading, universe normalization, ranking, and the
// slot-rebinding rule. Pure ESM, no I/O; runs identically in the browser
// (Finder tab, workbench portfolio backtests) and Node (engine evaluator).
//
// Finder contract (evaluated with new Function, must define `finder`):
//   const finder = {
//     name: 'Flow momentum',
//     params: { ...defaults },
//     filter(ctx)?  -> boolean   // hard exclude (illiquid, too new, ...)
//     score(ctx)    -> number    // higher = better; null/undefined = skip this bar
//   }
// ctx is the strategy ctx minus trading (no position/buy/sell) plus
// ctx.token = { symbol, name, volume24h, priceChange24h }. In finder ctxs,
// ctx.volume is Binance Alpha's USD OHLCV volume for the candle.

import { createBaseCtx, mergeParams } from './runtime.js';

// Evaluate finder source. Returns { finder, error } — never throws.
export function loadFinder(code) {
  try {
    const finder = new Function('"use strict";\n' + code + '\n;return finder;')();
    if (!finder || typeof finder.score !== 'function') {
      return { finder: null, error: 'finder.score(ctx) is required' };
    }
    if (finder.filter && typeof finder.filter !== 'function') {
      return { finder: null, error: 'finder.filter must be a function when present' };
    }
    return { finder, error: null };
  } catch (e) {
    return { finder: null, error: e.message || String(e) };
  }
}

// ── Universe normalization ───────────────────────────────────────────────────
// Input: the GET /universe payload { interval, times (ms), tokens: [{symbol,
// name, volume24h, priceChange24h, o,h,l,c,volume}] } with nulls where
// a token has no data.
// Output shape shared by the ranking engine, the portfolio backtester, and the
// live evaluator — ONE parser, never three:
//   {
//     interval, intervalSec,
//     times,                 // unix SECONDS, ascending (SDK bar convention)
//     tokens: [{
//       symbol, name, volume24h, priceChange24h,
//       offset,              // global index of this token's first covered bar
//       bars,                // [{time, open, high, low, close, volume}] from offset on,
//                            //  interior gaps forward-filled flat with volume 0
//     }]
//   }
export function normalizeUniverse(payload) {
  const timesMs = payload?.times || [];
  const times = timesMs.map(t => t / 1000);
  const intervalSec = times.length > 1 ? times[1] - times[0] : 60;
  const tokens = [];

  for (const t of payload?.tokens || []) {
    const n = timesMs.length;
    let offset = 0;
    while (offset < n && (t.c[offset] == null || t.o[offset] == null)) offset++;
    if (offset >= n) continue;                     // no covered bars at all

    const bars = [];
    let prevClose = null;
    for (let i = offset; i < n; i++) {
      const covered = t.c[i] != null && t.o[i] != null;
      if (covered) {
        bars.push({
          time: times[i],
          open: t.o[i], high: t.h[i], low: t.l[i], close: t.c[i],
          volume: t.volume?.[i] ?? ((t.buy?.[i] || 0) + (t.sell?.[i] || 0)),
        });
        prevClose = t.c[i];
      } else {
        // Interior gap (token went quiet): flat forward-fill so indicator math
        // stays sane while preserving a zero-volume gap.
        bars.push({ time: times[i], open: prevClose, high: prevClose, low: prevClose, close: prevClose, volume: 0 });
      }
    }
    tokens.push({
      symbol: t.symbol, name: t.name ?? t.symbol,
      chain: t.chain ?? null,                       // chain slug passthrough (M3)
      volume24h: t.volume24h ?? 0, priceChange24h: t.priceChange24h ?? 0,
      offset, bars,
    });
  }
  return { interval: payload?.interval, intervalSec, times, tokens };
}

// Finder ctx: base ctx + token metadata, no trading surface.
export function createFinderCtx({ token, params, state, log }) {
  const ctx = createBaseCtx({
    bars: token.bars, params, state,
    log: log || (() => {}),
  });
  ctx.token = {
    symbol: token.symbol, name: token.name,
    chain: token.chain ?? null,
    volume24h: token.volume24h, priceChange24h: token.priceChange24h,
  };
  return ctx;
}

// ── Ranking ──────────────────────────────────────────────────────────────────
// Run the finder across every token at every bar of the (normalized) universe.
// Returns:
//   {
//     rankings,   // array aligned to universe.times: sorted [{symbol, score}]
//                 //  (desc, capped at `keep`), or null before any token scored
//     error,      // first throw aborts the run (like the backtester)
//     logs,
//   }
export function runRanking({ code, finder, universe, params = {}, keep = 100, minBars = 2 }) {
  const empty = { rankings: [], error: null, logs: [] };
  if (!finder) {
    const loaded = loadFinder(code || '');
    if (loaded.error) return { ...empty, error: loaded.error };
    finder = loaded.finder;
  }
  if (!universe || universe.tokens.length === 0 || universe.times.length === 0) {
    return { ...empty, error: 'universe is empty' };
  }

  const merged = mergeParams(finder.params, params);
  const logs = [];
  const n = universe.times.length;

  // One ctx per token for the whole run — indicator caches persist.
  const perToken = universe.tokens.map(token => ({
    token,
    ctx: createFinderCtx({
      token, params: merged, state: {},
      log: (m) => logs.push(`[${token.symbol}] ${m}`),
    }),
  }));

  const rankings = new Array(n).fill(null);
  let error = null;
  try {
    for (let gi = 0; gi < n; gi++) {
      const scored = [];
      for (const { token, ctx } of perToken) {
        const ti = gi - token.offset;
        if (ti < minBars - 1) continue;            // not enough history yet
        ctx.__setBar(ti);
        let passesFilter;
        let s;
        try {
          passesFilter = !finder.filter || finder.filter(ctx);
          if (passesFilter) s = finder.score(ctx);
        } catch (e) {
          const phase = finder.filter && passesFilter === undefined ? 'filter' : 'score';
          const detail = e?.message || String(e);
          throw new Error(`${phase} failed for ${token.symbol} at ${new Date(universe.times[gi] * 1000).toISOString()}: ${detail}`);
        }
        if (!passesFilter) continue;
        if (s == null || Number.isNaN(s) || !Number.isFinite(s)) continue;
        scored.push({ symbol: token.symbol, score: s });
      }
      if (scored.length > 0) {
        scored.sort((a, b) => b.score - a.score);
        rankings[gi] = scored.slice(0, keep);
      }
    }
  } catch (e) {
    error = e.message || String(e);
  }
  return { rankings, error, logs };
}

// ── Forward returns (finder validation) ─────────────────────────────────────
// % return of each token from close[gi] to close[gi + horizonBars].
// Returns { bySymbol: Map(symbol -> Float64Array|nulls aligned to times) }.
export function computeForwardReturns(universe, horizonBars) {
  const n = universe.times.length;
  const bySymbol = new Map();
  for (const token of universe.tokens) {
    const arr = new Array(n).fill(null);
    for (let gi = token.offset; gi + horizonBars < n; gi++) {
      const a = token.bars[gi - token.offset]?.close;
      const b = token.bars[gi - token.offset + horizonBars]?.close;
      if (a > 0 && b != null) arr[gi] = ((b - a) / a) * 100;
    }
    bySymbol.set(token.symbol, arr);
  }
  return { bySymbol };
}

// "Did the finder pick winners?" — per bar: average forward return of the
// top-K ranked tokens vs the median forward return of ALL scored tokens.
export function finderQuality(rankings, forwardReturns, topK = 5) {
  const n = rankings.length;
  const topKAvg = new Array(n).fill(null);
  const median = new Array(n).fill(null);
  for (let gi = 0; gi < n; gi++) {
    const r = rankings[gi];
    if (!r || r.length === 0) continue;
    const rets = [];
    for (const { symbol } of r) {
      const v = forwardReturns.bySymbol.get(symbol)?.[gi];
      if (v != null) rets.push(v);
    }
    if (rets.length === 0) continue;
    const top = rets.slice(0, Math.min(topK, rets.length));
    topKAvg[gi] = top.reduce((a, b) => a + b, 0) / top.length;
    const sorted = rets.slice().sort((a, b) => a - b);
    const mid = sorted.length >> 1;
    median[gi] = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  }
  return { topKAvg, median };
}

// ── Slot rebinding rule ──────────────────────────────────────────────────────
// THE shared decision both the portfolio backtester and the live runner use —
// they must never diverge, or backtests stop predicting live behavior.
//
// slots:   [{ symbol: string|null, hasPosition: bool }] — hasPosition means
//          the slot is locked (open position OR an in-flight/pending order).
// ranking: [{ symbol, score }] sorted desc (a rankings[gi] entry), or null.
// Returns: array of symbols (or null), one per slot:
//   • locked slots keep their symbol untouched;
//   • flat slots keep their binding unless a challenger's score beats the
//     bound token's by switchMarginPct (hysteresis — prevents churn), the
//     bound token dropped out of the ranking entirely, or the slot was empty;
//   • no two slots ever bind the same symbol.
export function chooseBinding(slots, ranking, { switchMarginPct = 10, tradeable = null } = {}) {
  const result = slots.map(s => s.symbol ?? null);
  if (!ranking || ranking.length === 0) return result;

  const scores = new Map(ranking.map(r => [r.symbol, r.score]));
  const taken = new Set();
  for (const s of slots) {
    if (s.hasPosition && s.symbol) taken.add(s.symbol);
  }

  // Candidate stream: best-first, skipping untradeable and already-taken.
  const candidates = ranking.filter(r =>
    (!tradeable || tradeable.has(r.symbol)));

  for (let i = 0; i < slots.length; i++) {
    const slot = slots[i];
    if (slot.hasPosition) continue;                       // locked

    const best = candidates.find(r => !taken.has(r.symbol));
    if (!best) {                                          // nothing available
      if (slot.symbol && !taken.has(slot.symbol)) taken.add(slot.symbol);
      continue;
    }

    const boundScore = slot.symbol ? scores.get(slot.symbol) : undefined;
    let next = slot.symbol;
    if (!slot.symbol || boundScore === undefined || taken.has(slot.symbol)) {
      next = best.symbol;                                 // empty / dropped-out / stolen
    } else if (best.symbol !== slot.symbol &&
               best.score > boundScore + (switchMarginPct / 100) * Math.abs(boundScore)) {
      next = best.symbol;                                 // beat the hysteresis margin
    }
    result[i] = next;
    taken.add(next);
  }
  return result;
}
