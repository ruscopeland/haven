// Marker engine daemon — headless executor for chart markers.
//
// Watches collector prices via the FastAPI server and fires real swaps when a
// price crosses a marker line. This replaces the old in-browser wallet engine:
// no browser tab, no HMR duplicate loops, no background-tab throttling.
//
// Runs in observe-only mode (logs crosses, never trades) when no key is set.
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeProvider, makeWallet } from './chain.js';
import { MarkerEngine } from './engine.js';
import { StrategyRunner } from './strategy-runner.js';
import { FinderHub } from './finder-runner.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Config ──────────────────────────────────────────────────────────────────
function loadPrivateKey() {
  if (process.env.PRIVATE_KEY) return process.env.PRIVATE_KEY.trim();
  // Fall back to the wallet app's .env so the key lives in exactly one place.
  try {
    const walletEnv = fs.readFileSync(path.join(__dirname, '..', 'crypto-wallet', '.env'), 'utf8');
    const m = walletEnv.match(/^\s*VITE_PRIVATE_KEY\s*=\s*(\S+)\s*$/m);
    if (m) return m[1].trim();
  } catch { /* no wallet .env */ }
  return '';
}

const API_URL = process.env.API_URL || 'http://localhost:8000';
const RPC_URL = process.env.RPC_URL || 'https://bsc-dataseed.binance.org';
const POLL_MS = parseInt(process.env.POLL_MS || '3000', 10);
const config = {
  gasPriceGwei: process.env.GAS_PRICE_GWEI || '1',
  slippagePct: process.env.SLIPPAGE_PCT || '0.5',
  quickBuyPercent: parseFloat(process.env.QUICK_BUY_PERCENT || '5'),
  quickSellPercent: parseFloat(process.env.QUICK_SELL_PERCENT || '100'),
};

// ── Tiny API client ─────────────────────────────────────────────────────────
class ApiClient {
  constructor(baseUrl) { this.base = baseUrl; }

  async #json(pathname, options) {
    const res = await fetch(this.base + pathname, options);
    if (!res.ok) throw new Error(`API ${pathname} → HTTP ${res.status}`);
    return res.json();
  }
  #post(pathname, body) {
    return this.#json(pathname, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  getOverview() { return this.#json('/dashboard/overview'); }
  getTokens() { return this.#json('/tokens?limit=2000'); }
  getEngineSettings() { return this.#json('/engine/settings'); }
  claimMarker(id) { return this.#post(`/markers/${id}/claim`); }
  recordTrade(trade) { return this.#post('/trades', trade); }
  createMarker(marker) { return this.#post('/markers', marker); }
  deleteMarker(id) {
    return fetch(`${this.base}/markers/${id}`, { method: 'DELETE' })
      .then(r => { if (!r.ok) throw new Error(`DELETE /markers/${id} → HTTP ${r.status}`); });
  }
  heartbeat(process = 'execution_engine') { return this.#post('/heartbeat', { process }); }

  // Strategy runner endpoints
  listStrategies() { return this.#json('/strategies'); }
  getStrategy(id) { return this.#json(`/strategies/${id}`); }
  patchStrategy(id, body) {
    return this.#json(`/strategies/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  // Token Finder endpoints (finder hub + portfolio strategies)
  listFinders() { return this.#json('/finders'); }
  getFinder(id) { return this.#json(`/finders/${id}`); }
  patchFinder(id, body) {
    return this.#json(`/finders/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }
  getUniverse(interval, startMs, minVol24h = 50_000) {
    return this.#json(`/universe?interval=${interval}&start_ms=${startMs}&min_vol_24h=${minVol24h}`);
  }
  getKlines(symbol, interval, limit) {
    return this.#json(`/klines/${symbol}?interval=${interval}&limit=${limit}`);
  }
  getFlow(symbol, startMs) {
    return this.#json(`/flow/${symbol}?limit=10080${startMs ? `&start_ms=${startMs}` : ''}`);
  }
  getTrades({ symbol, status, strategy_id, limit = 50 } = {}) {
    const q = new URLSearchParams();
    if (symbol) q.set('symbol', symbol);
    if (status) q.set('status', status);
    if (strategy_id) q.set('strategy_id', strategy_id);
    q.set('limit', String(limit));
    return this.#json(`/trades?${q}`);
  }
  postLog(level, message, metadata) {
    return this.#post('/debug/logs', {
      source: 'engine', level, message,
      metadata_json: metadata ? JSON.stringify(metadata) : null,
    });
  }
  rearmMarker(id) {
    return this.#json(`/markers/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ active: 1 }),
    });
  }
}

// ── Wiring ──────────────────────────────────────────────────────────────────
const api = new ApiClient(API_URL);

function consoleLog(level, message) {
  const ts = new Date().toISOString().slice(0, 19).replace('T', ' ');
  console.log(`${ts} | ${level.padEnd(5)} | ${message}`);
}

function log(level, message, metadata) {
  consoleLog(level, message);
  api.postLog(level, message, metadata).catch(() => {});
}

async function main() {
  consoleLog('INFO', '======================================');
  consoleLog('INFO', '  Marker Engine daemon starting');
  consoleLog('INFO', `  API: ${API_URL}`);
  consoleLog('INFO', `  RPC: ${RPC_URL}`);
  consoleLog('INFO', '======================================');

  const provider = makeProvider(RPC_URL);
  const key = loadPrivateKey();
  let wallet = null;
  if (key) {
    try {
      wallet = makeWallet(key, provider);
      consoleLog('INFO', `Trading wallet loaded: ${wallet.address}`);
    } catch (e) {
      consoleLog('ERROR', `Invalid private key: ${e.message} — running observe-only.`);
    }
  } else {
    consoleLog('WARN', 'No PRIVATE_KEY found (marker-engine/.env or crypto-wallet/.env). Observe-only mode.');
  }

  const engine = new MarkerEngine({ api, provider, wallet, config, log });
  const finderHub = new FinderHub({ api, log });
  const strategyRunner = new StrategyRunner({ api, log, finderHub });
  log('INFO', `Marker engine daemon started${wallet ? ` (executor ${wallet.address.slice(0, 8)}…)` : ' (observe-only)'}.`);

  // Heartbeat lights the "Engine" dot in the chart UI. Only beat when we can
  // actually execute — a green dot must mean "trades will fire".
  if (wallet) {
    const beat = () => api.heartbeat().catch(() => {});
    beat();
    setInterval(beat, 30_000);
  }

  let apiWasDown = false;
  for (;;) {
    const started = Date.now();
    try {
      await engine.tick();
      if (apiWasDown) {
        apiWasDown = false;
        log('INFO', 'API connection restored.');
      }
    } catch (e) {
      if (!apiWasDown) {
        apiWasDown = true;
        consoleLog('ERROR', `Tick failed (API down?): ${e.message} — retrying quietly.`);
      }
    }
    // Strategy runner: separate try so a strategy problem never stalls marker
    // execution (and vice versa). It emits signals as markers; engine executes.
    try {
      await strategyRunner.tick();
    } catch (e) {
      consoleLog('ERROR', `Strategy runner tick failed: ${e.message}`);
    }
    const elapsed = Date.now() - started;
    await new Promise(r => setTimeout(r, Math.max(500, POLL_MS - elapsed)));
  }
}

main().catch(e => {
  consoleLog('ERROR', `Fatal: ${e.stack || e.message}`);
  process.exit(1);
});
