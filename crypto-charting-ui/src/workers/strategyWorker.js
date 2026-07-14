// Keep this entrypoint versioned with its worker-specific CSP policy.  A
// content change here gives clients a new immutable asset URL after a CSP fix.
import {
  loadStrategy, loadFinder, runBacktest, runPortfolioBacktest, runRanking,
  computeForwardReturns, finderQuality,
} from '@sdk/index.js';

self.onmessage = ({ data }) => {
  const { id, operation, payload } = data;
  try {
    let result;
    if (operation === 'validateStrategy') {
      const loaded = loadStrategy(payload.code || '');
      result = { error: loaded.error, params: loaded.strategy?.params || {} };
    } else if (operation === 'validateFinder') {
      const loaded = loadFinder(payload.code || '');
      result = { error: loaded.error, params: loaded.finder?.params || {} };
    } else if (operation === 'backtest') {
      result = runBacktest(payload);
    } else if (operation === 'portfolioBacktest') {
      result = runPortfolioBacktest(payload);
    } else if (operation === 'finderAnalysis') {
      const ranked = runRanking(payload);
      const fwd = computeForwardReturns(payload.universe, payload.horizon);
      result = {
        rankings: ranked.rankings, logs: ranked.logs, error: ranked.error,
        quality: finderQuality(ranked.rankings, fwd, payload.topN),
      };
    } else {
      throw new Error(`Unknown worker operation: ${operation}`);
    }
    self.postMessage({ id, result });
  } catch (error) {
    self.postMessage({ id, error: error?.message || String(error) });
  }
};
