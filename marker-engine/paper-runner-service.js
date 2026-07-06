// Haven cloud paper-runner — runs EVERY user's DRY strategies centrally.
//
// This is the free-of-keys half of the engine: it has no wallet and never
// touches chain code. It authenticates with the SERVICE_API_KEY (admin scope),
// so GET /strategies returns all users' strategies; StrategyRunner in
// `paperOnly` mode ignores anything that isn't mode='dry' and records only
// PAPER trades, each attributed to its owner via the trade's user_id.
//
// Why it exists: paper trading must keep running when a user's PC is off, so
// they can prove a strategy works before subscribing to live trading. LIVE
// strategies are deliberately NOT run here — those execute only on each user's
// own machine, where their private key lives.
//
// Deploy: one small always-on worker (see Dockerfile.paper-runner + DEPLOY.md).
import 'dotenv/config';
import { ApiClient } from './api-client.js';
import { StrategyRunner } from './strategy-runner.js';
import { FinderHub } from './finder-runner.js';

const API_URL = process.env.HAVEN_API_URL || process.env.API_URL || 'http://localhost:8000';
const SERVICE_KEY = (process.env.SERVICE_API_KEY || '').trim();
const POLL_MS = parseInt(process.env.POLL_MS || '3000', 10);

function consoleLog(level, message) {
  const ts = new Date().toISOString().slice(0, 19).replace('T', ' ');
  console.log(`${ts} | ${level.padEnd(5)} | ${message}`);
}

const api = new ApiClient(API_URL, SERVICE_KEY);

function log(level, message, metadata) {
  consoleLog(level, message);
  api.postLog(level, message, metadata).catch(() => {});
}

async function main() {
  consoleLog('INFO', '======================================');
  consoleLog('INFO', '  Haven cloud paper-runner starting');
  consoleLog('INFO', `  API: ${API_URL}`);
  consoleLog('INFO', '  Runs all users\' DRY strategies (no keys, PAPER only)');
  consoleLog('INFO', '======================================');
  if (!SERVICE_KEY) {
    consoleLog('ERROR', 'SERVICE_API_KEY is not set — the runner cannot see any strategies. Exiting.');
    process.exit(1);
  }

  const finderHub = new FinderHub({ api, log });
  const runner = new StrategyRunner({ api, log, finderHub, paperOnly: true });

  for (;;) {
    const started = Date.now();
    try {
      await runner.tick();
    } catch (e) {
      consoleLog('ERROR', `Paper-runner tick failed: ${e.message}`);
    }
    const elapsed = Date.now() - started;
    await new Promise(r => setTimeout(r, Math.max(500, POLL_MS - elapsed)));
  }
}

main().catch((e) => {
  consoleLog('ERROR', `Fatal: ${e.stack || e.message}`);
  process.exit(1);
});
