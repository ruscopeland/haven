import { log } from './logger';

/**
 * Fetches OHLCV data from GeckoTerminal API for a specific liquidity pool.
 * Uses 15-minute candles to calculate a 4-hour S/R window (16 candles).
 */
export async function get4HourOHLCV(poolAddress) {
  // GeckoTerminal API: /networks/bsc/pools/{pool_address}/ohlcv/minute
  // aggregate=15 (15 min candles), limit=20 (fetch 20 to be safe for a 16-candle window)
  const url = `https://api.geckoterminal.com/api/v2/networks/bsc/pools/${poolAddress.toLowerCase()}/ohlcv/minute?aggregate=15&limit=20`;
  
  try {
    log(`GeckoTerminal OHLCV Request: ${url}`, 'info');
    const res = await fetch(url);
    if (!res.ok) {
      if (res.status === 429) {
        throw new Error('GeckoTerminal rate limit exceeded. Please wait a minute.');
      }
      throw new Error(`HTTP ${res.status}`);
    }
    
    const data = await res.json();
    if (!data.data || !data.data.attributes || !Array.isArray(data.data.attributes.ohlcv_list)) {
      throw new Error('Invalid response format from GeckoTerminal');
    }
    
    const ohlcvList = data.data.attributes.ohlcv_list;
    log(`Successfully fetched OHLCV data: ${ohlcvList.length} candles for pool ${poolAddress}.`, 'success');
    return ohlcvList;
    
  } catch (err) {
    log(`GeckoTerminal OHLCV Error: ${err.message}`, 'error');
    throw err;
  }
}

/**
 * Calculates Support and Resistance over the given OHLCV dataset
 * using the 10th and 90th percentiles of closing prices to filter spikes.
 */
export function calculateSupportResistance(ohlcvList) {
  if (!ohlcvList || ohlcvList.length === 0) {
    return { support: 0, resistance: 0 };
  }
  
  // GeckoTerminal format: [timestamp, open, high, low, close, volume]
  // Extract closing prices (index 4)
  const closes = ohlcvList.slice(0, 16).map(candle => parseFloat(candle[4]));
  
  // Sort ascending
  closes.sort((a, b) => a - b);
  
  // Calculate percentiles
  const getPercentile = (arr, p) => {
    const index = (arr.length - 1) * p;
    const lower = Math.floor(index);
    const upper = Math.ceil(index);
    const weight = index - lower;
    if (upper >= arr.length) return arr[lower];
    return arr[lower] * (1 - weight) + arr[upper] * weight;
  };
  
  const support = getPercentile(closes, 0.10); // 10th percentile
  const resistance = getPercentile(closes, 0.90); // 90th percentile
  
  return {
    support: support,
    resistance: resistance
  };
}
