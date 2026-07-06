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
import { ApiClient } from './api-client.js';

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

// HAVEN_API_URL is the cloud name; API_URL kept as the legacy/solo alias.
const API_URL = process.env.HAVEN_API_URL || process.env.API_URL || 'http://localhost:8000';
const RPC_URL = process.env.RPC_URL || 'https://bsc-dataseed.binance.org';
const POLL_MS = parseInt(process.env.POLL_MS || '3000', 10);
// The connection key from the web app's "Connect your engine" screen. Sent as
// X-Api-Key so the cloud API knows which user this engine trades for. Empty in
// solo mode (the local API runs with HAVEN_SOLO=1 and needs no key).
const API_KEY = (process.env.HAVEN_API_KEY || '').trim();
const config = {
  gasPriceGwei: process.env.GAS_PRICE_GWEI || '1',
  slippagePct: process.env.SLIPPAGE_PCT || '0.5',
  quickBuyPercent: parseFloat(process.env.QUICK_BUY_PERCENT || '5'),
  quickSellPercent: parseFloat(process.env.QUICK_SELL_PERCENT || '100'),
};

// ── Wiring ──────────────────────────────────────────────────────────────────
const api = new ApiClient(API_URL, API_KEY);

function consoleLog(level, message) {
  const ts = new Date().toISOString().slice(0, 19).replace('T', ' ');
  console.log(`${ts} | ${level.padEnd(5)} | ${message}`);
}

function log(level, message, metadata) {
  consoleLog(level, message);
  api.postLog(level, message, metadata).catch(() => {});
}

async function main() {
  const remote = !/localhost|127\.0\.0\.1/.test(API_URL);
  consoleLog('INFO', '======================================');
  consoleLog('INFO', '  Haven Engine daemon starting');
  consoleLog('INFO', `  API: ${API_URL}${remote ? ' (cloud)' : ' (local)'}`);
  consoleLog('INFO', `  RPC: ${RPC_URL}`);
  consoleLog('INFO', `  Connection key: ${API_KEY ? 'set' : 'NOT set'}`);
  consoleLog('INFO', '======================================');
  if (remote && !API_KEY) {
    consoleLog('ERROR', 'Connecting to a cloud API with no HAVEN_API_KEY — every request will be 401.');
    consoleLog('ERROR', 'Run the setup wizard (setup.bat) or paste your key into .env, then restart.');
  }

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
