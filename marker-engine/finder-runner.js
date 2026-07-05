// Finder hub — evaluates saved Token Finder rankings on live closed bars,
// inside the marker-engine process. Passive: it produces rankings; the
// strategy runner's portfolio slots consume them. One evaluator per
// (finder id, interval) pair actually needed by an armed portfolio strategy —
// rankings run at the STRATEGY's interval so live rebinding matches the
// workbench's portfolio backtest bar-for-bar.
//
// Data source is GET /universe — the same resampled bucket dataset the
// workbench ranks on. Latest CLOSED bar only; the in-progress bar is excluded
// server-side.
import { loadFinder, normalizeUniverse, runRanking, mergeParams } from '../strategy-sdk/src/index.js';

const LIST_REFRESH_MS = 15_000;
const UNIVERSE_BARS = 300;           // enough history for typical finder warm-ups
const EVAL_LAG_MS = 25_000;          // collector flushes 1m buckets every ~10s; wait it out
const RETRY_MS = 30_000;
const INTERVAL_SEC = { '5m': 300, '15m': 900, '30m': 1800, '1h': 3600 };

export class FinderHub {
  constructor({ api, log }) {
    this.api = api;
    this.log = log;
    this.evaluators = new Map();     // `${finderId}|${interval}` → evaluator state
    this.rows = new Map();           // finderId → latest /finders list row
    this.lastListFetch = 0;
  }

  // Called once per daemon tick by the strategy runner with the (finderId,
  // interval) pairs its armed portfolio strategies need right now.
  async tick(needs) {
    const now = Date.now();
    if (needs.length > 0 && now - this.lastListFetch >= LIST_REFRESH_MS) {
      this.lastListFetch = now;
      try {
        const list = await this.api.listFinders();
        this.rows = new Map(list.map(f => [f.id, f]));
      } catch { /* API down — runner loop already reports it */ }
    }

    // Drop evaluators nothing needs anymore.
    const wanted = new Set(needs.map(n => `${n.finderId}|${n.interval}`));
    for (const key of this.evaluators.keys()) {
      if (!wanted.has(key)) this.evaluators.delete(key);
    }

    for (const { finderId, interval } of needs) {
      const key = `${finderId}|${interval}`;
      let e = this.evaluators.get(key);
      if (!e) {
        e = {
          finderId, interval,
          intervalSec: INTERVAL_SEC[interval] || 900,
          finder: null, params: {}, updatedAt: null,
          ranking: null, rankingBarSec: 0, error: null,
          nextEvalMs: 0,
        };
        this.evaluators.set(key, e);
      }
      try {
        await this.tickEvaluator(e);
      } catch (err) {
        e.error = err.message || String(err);
        e.nextEvalMs = Date.now() + RETRY_MS;
        this.log('ERROR', `Finder ${e.finderId} (${e.interval}): ${e.error}`);
        this.api.patchFinder(e.finderId, { last_error: e.error.slice(0, 500) }).catch(() => {});
      }
    }
  }

  async tickEvaluator(e) {
    // Hot-reload on definition change — same updated_at contract as strategies.
    const row = this.rows.get(e.finderId);
    if (row && row.updated_at !== e.updatedAt) {
      const full = await this.api.getFinder(e.finderId);
      const { finder, error } = loadFinder(full.code);
      if (error) {
        e.finder = null;
        e.updatedAt = full.updated_at;      // don't refetch every tick
        throw new Error(`finder code failed to load: ${error}`);
      }
      let overrides = {};
      try { overrides = JSON.parse(full.params_json || '{}'); } catch { /* legacy */ }
      e.finder = finder;
      e.params = mergeParams(finder.params, overrides);
      e.updatedAt = full.updated_at;
      e.nextEvalMs = 0;                     // rank immediately with the new code
      this.log('INFO', `Finder ${row.name || e.finderId} (re)loaded for ${e.interval} ranking.`);
    }
    if (!e.finder || Date.now() < e.nextEvalMs) return;

    const startMs = Date.now() - UNIVERSE_BARS * e.intervalSec * 1000;
    const payload = await this.api.getUniverse(e.interval, startMs);
    const universe = normalizeUniverse(payload);
    const { rankings, error } = runRanking({ finder: e.finder, universe, params: e.params });
    if (error) throw new Error(error);

    let lastGi = -1;
    for (let gi = rankings.length - 1; gi >= 0; gi--) {
      if (rankings[gi]) { lastGi = gi; break; }
    }
    e.ranking = lastGi >= 0 ? rankings[lastGi] : null;
    e.rankingBarSec = lastGi >= 0 ? universe.times[lastGi] : 0;
    e.error = null;

    // Next evaluation: just after the next interval boundary closes + flush lag.
    const intMs = e.intervalSec * 1000;
    e.nextEvalMs = (Math.floor(Date.now() / intMs) + 1) * intMs + EVAL_LAG_MS;
    this.api.patchFinder(e.finderId, { last_run_at: Date.now(), clear_error: true }).catch(() => {});
  }

  // Latest state for a (finder, interval) pair; null until first evaluation.
  // Consumers must treat state.error as "do not open NEW exposure" —
  // fail-closed for rebinding, fail-open for managing what's already held.
  getState(finderId, interval) {
    return this.evaluators.get(`${finderId}|${interval}`) || null;
  }
}
