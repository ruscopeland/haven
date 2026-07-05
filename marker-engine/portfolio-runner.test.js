// Portfolio (Token Finder) support in the strategy runner, tested against a
// mocked API + finder hub — no network, no chain, no real engine loop.
import test from 'node:test';
import assert from 'node:assert/strict';
import { StrategyRunner } from './strategy-runner.js';

const INTERVAL_SEC = 300;

// Deterministic 5m klines ending ~1h in the past (all bars closed).
function makeKlines(nBars, basePrice = 100) {
  const endSec = Math.floor(Date.now() / 1000 / INTERVAL_SEC) * INTERVAL_SEC - 3600;
  const rows = [];
  for (let i = 0; i < nBars; i++) {
    const t = (endSec - (nBars - 1 - i) * INTERVAL_SEC) * 1000;
    const p = basePrice + i * 0.1;
    rows.push([t, String(p), String(p * 1.01), String(p * 0.99), String(p), '1000']);
  }
  return rows;
}

// Mutable mock API: tests tweak `state` between ticks.
function makeMockApi() {
  const state = {
    klines: new Map(),          // symbol → rows (full series)
    cutoff: new Map(),          // symbol → how many rows are visible
    trades: [],                 // rows returned by getTrades
    recorded: [],               // recordTrade captures
    markers: [],                // createMarker captures
    strategy: null,             // getStrategy response
    patches: [],
  };
  const api = {
    state,
    async getStrategy() { return state.strategy; },
    async getTrades() { return state.trades; },
    async getKlines(symbol) {
      const rows = state.klines.get(symbol) || [];
      const cut = state.cutoff.get(symbol) ?? rows.length;
      return { data: rows.slice(0, cut) };
    },
    async getFlow() { return { data: [] }; },
    async getTokens() {
      return [...state.klines.keys()].map(s => ({ symbol: s, contract_address: '0xabc' }));
    },
    async patchStrategy(id, body) { state.patches.push(body); },
    async recordTrade(t) { state.recorded.push(t); return t; },
    async createMarker(m) { state.markers.push(m); return { id: 'm1', ...m }; },
    async heartbeat() {},
    async listStrategies() { return []; },
  };
  return api;
}

const BUY_WHEN_FLAT = `const strategy = {
  params: { usd: 10 },
  onBar(bar, ctx) { if (!ctx.position.qty) ctx.buy(ctx.params.usd, { tag: 'auto' }); },
}`;

function makeRunner(api, hubState) {
  const hub = {
    ticked: [],
    async tick(needs) { this.ticked.push(needs); },
    getState() { return hubState.current; },
  };
  const runner = new StrategyRunner({ api, log: () => {}, finderHub: hub });
  runner.tradeable = new Set([...api.state.klines.keys()]);
  return { runner, hub };
}

function armPortfolio(runner, { maxPositions = 2, mode = 'dry' } = {}) {
  runner.reconcile([{
    id: 'S1', name: 'pf', symbol: '', interval: '5m', mode,
    finder_id: 'F1', max_positions: maxPositions, switch_margin_pct: 10,
    updated_at: 1, last_run_at: null, last_error: null,
  }]);
  return runner.runners.get('S1');
}

test('reloadPositionsBySymbol groups trades per symbol', async () => {
  const api = makeMockApi();
  // Newest first, as the API returns them.
  api.state.trades = [
    { symbol: 'BBB', direction: 'SELL', amount_in: 2, amount_out: 220, execution_price: 110 },
    { symbol: 'BBB', direction: 'BUY', amount_in: 200, amount_out: 2, execution_price: 100 },
    { symbol: 'AAA', direction: 'BUY', amount_in: 50, amount_out: 5, execution_price: 10 },
  ];
  const { runner } = makeRunner(api, { current: null });
  const map = await runner.reloadPositionsBySymbol('S1', 'dry');
  assert.equal(map.get('AAA').qty, 5);
  assert.equal(map.get('BBB').qty, 0);              // bought 2, sold 2
});

test('initPortfolio re-attaches slots to open positions after a restart', async () => {
  const api = makeMockApi();
  api.state.klines.set('AAA', makeKlines(60));
  api.state.strategy = { code: BUY_WHEN_FLAT, params_json: '{}' };
  api.state.trades = [
    { symbol: 'AAA', direction: 'BUY', amount_in: 50, amount_out: 5, execution_price: 10 },
  ];
  const { runner } = makeRunner(api, { current: null });
  const r = armPortfolio(runner);
  await runner.tickPortfolio(r);                    // first tick = init
  assert.equal(r.initialized, true);
  assert.equal(r.slots[0].sub.symbol, 'AAA');
  assert.equal(r.slots[0].sub.position.qty, 5);
  assert.equal(r.slots[1].sub, null);               // second slot stays flat
});

test('flat slots bind the ranking; finder error means no new exposure', async () => {
  const api = makeMockApi();
  api.state.klines.set('AAA', makeKlines(60, 100));
  api.state.klines.set('BBB', makeKlines(60, 50));
  api.state.strategy = { code: `const strategy = { onBar() {} }`, params_json: '{}' };
  const hubState = { current: { error: 'boom', ranking: [{ symbol: 'AAA', score: 1 }] } };
  const { runner } = makeRunner(api, hubState);
  const r = armPortfolio(runner);
  await runner.tickPortfolio(r);                    // init (no open positions)
  await runner.tickPortfolio(r);
  assert.equal(r.slots[0].sub, null);               // fail-closed on finder error

  hubState.current = {
    error: null,
    ranking: [{ symbol: 'BBB', score: 9 }, { symbol: 'AAA', score: 3 }],
  };
  await runner.tickPortfolio(r);
  assert.equal(r.slots[0].sub.symbol, 'BBB');       // best first
  assert.equal(r.slots[1].sub.symbol, 'AAA');
  assert.equal(r.slots[0].sub.entryRank, 1);
});

test('tradeable filter keeps unswappable tokens out of slots', async () => {
  const api = makeMockApi();
  api.state.klines.set('AAA', makeKlines(60));
  api.state.klines.set('BBB', makeKlines(60));
  api.state.strategy = { code: `const strategy = { onBar() {} }`, params_json: '{}' };
  const hubState = {
    current: { error: null, ranking: [{ symbol: 'BBB', score: 9 }, { symbol: 'AAA', score: 3 }] },
  };
  const { runner } = makeRunner(api, hubState);
  runner.tradeable = new Set(['AAA']);              // BBB has no contract address
  const r = armPortfolio(runner, { maxPositions: 1 });
  await runner.tickPortfolio(r);
  await runner.tickPortfolio(r);
  assert.equal(r.slots[0].sub.symbol, 'AAA');
});

test('a slot with a position is locked; a flat slot rebinds past the margin', async () => {
  const api = makeMockApi();
  api.state.klines.set('AAA', makeKlines(60));
  api.state.klines.set('BBB', makeKlines(60));
  api.state.klines.set('CCC', makeKlines(60));
  api.state.strategy = { code: `const strategy = { onBar() {} }`, params_json: '{}' };
  const hubState = {
    current: { error: null, ranking: [{ symbol: 'AAA', score: 10 }, { symbol: 'BBB', score: 5 }] },
  };
  const { runner } = makeRunner(api, hubState);
  const r = armPortfolio(runner);
  await runner.tickPortfolio(r);
  await runner.tickPortfolio(r);
  assert.equal(r.slots[0].sub.symbol, 'AAA');
  assert.equal(r.slots[1].sub.symbol, 'BBB');

  // Give slot 0 a position, then let CCC take over the top of the ranking.
  r.slots[0].sub.position.qty = 5;
  hubState.current = {
    error: null,
    ranking: [{ symbol: 'CCC', score: 100 }, { symbol: 'AAA', score: 10 }, { symbol: 'BBB', score: 5 }],
  };
  await runner.tickPortfolio(r);
  assert.equal(r.slots[0].sub.symbol, 'AAA');       // locked by the position
  assert.equal(r.slots[1].sub.symbol, 'CCC');       // flat slot switched
});

test('DRY: a new closed bar produces a PAPER trade on the bound symbol', async () => {
  const api = makeMockApi();
  api.state.klines.set('BBB', makeKlines(60));
  api.state.cutoff.set('BBB', 59);                  // last bar hidden for now
  api.state.strategy = { code: BUY_WHEN_FLAT, params_json: '{}' };
  const hubState = { current: { error: null, ranking: [{ symbol: 'BBB', score: 9 }] } };
  const { runner } = makeRunner(api, hubState);
  const r = armPortfolio(runner, { maxPositions: 1 });
  await runner.tickPortfolio(r);                    // init
  await runner.tickPortfolio(r);                    // bind BBB (warm-up suppressed)
  assert.equal(r.slots[0].sub.symbol, 'BBB');
  assert.equal(api.state.recorded.length, 0);       // warm-up emitted nothing

  api.state.cutoff.set('BBB', 60);                  // the next bar closes
  r.slots[0].sub.nextCheck = 0;                     // skip the wall-clock wait
  await runner.tickPortfolio(r);
  assert.equal(api.state.recorded.length, 1);
  const t = api.state.recorded[0];
  assert.equal(t.symbol, 'BBB');
  assert.equal(t.status, 'PAPER');
  assert.equal(t.direction, 'BUY');
  assert.equal(t.strategy_id, 'S1');
});

test('LIVE: the same bar posts an immediate-fire STRAT_BUY marker instead', async () => {
  const api = makeMockApi();
  api.state.klines.set('BBB', makeKlines(60));
  api.state.cutoff.set('BBB', 59);
  api.state.strategy = { code: BUY_WHEN_FLAT, params_json: '{}' };
  const hubState = { current: { error: null, ranking: [{ symbol: 'BBB', score: 9 }] } };
  const { runner } = makeRunner(api, hubState);
  const r = armPortfolio(runner, { maxPositions: 1, mode: 'live' });
  await runner.tickPortfolio(r);
  await runner.tickPortfolio(r);

  api.state.cutoff.set('BBB', 60);
  r.slots[0].sub.nextCheck = 0;
  await runner.tickPortfolio(r);
  assert.equal(api.state.markers.length, 1);
  const m = api.state.markers[0];
  assert.equal(m.symbol, 'BBB');
  assert.equal(m.marker_type, 'STRAT_BUY');
  assert.equal(m.strategy_id, 'S1');
  assert.equal(api.state.recorded.length, 0);       // no direct trade writes live
});
