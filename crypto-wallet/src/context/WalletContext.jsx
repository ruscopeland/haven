import React, { createContext, useContext, useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { ethers } from 'ethers';
import { getProvider, getWallet, getBnbBalance, getTokenData, WBNB_ADDRESS, OPENOCEAN_SPENDER, getPancakeSwapTokens, scanTokenBalances, DEFAULT_RPC_URLS, getOpenOceanQuote, executeBuiltSwap, checkAllowance, approveToken, getPancakeQuote } from '../utils/blockchain';
import { get4HourOHLCV, calculateSupportResistance } from '../utils/technicalAnalysis';
import { fetchBscScanTxData, traceTransactions, calculateProfitLoss } from '../utils/txTracer';
import { registerLogCallback, log } from '../utils/logger';

const WalletContext = createContext();

// BEP-20 tokens the wallet tracks by default (never treated as user "custom" tokens)
const PRESEEDED_TOKENS = [
  '0x55d398326f99059ff775485246999027b3197955',
  '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d',
  '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c',
  '0x0e09fabb73bd3ade0a17ecc321fd13a19e81ce82',
  '0x7130d2a12b9bcbfae4f2634d864a1ee1ce3ead9c',
  '0x2170ed0880ac9a755fd29b2688956bd959f933f8',
  '0x1d2f0da169ceb9fc7b11387d27f43351f657a53d',
  '0xba2ae6b27d09034962970558644c79e122721117',
  '0x3ee2200efb3400f148897c269797e83d73611095',
  '0x7083609fce4d1d8dc0c979aab8c869ea2c873402',
  '0x2859e4544c4bb03966803b0c4d90d2e245809047',
  '0xfb1a3273ed458d2270b19008564755102f5a2fcc',
  '0xe9e7cea3ded0c158160365f8a912e4014d3d2c13',
];

const BNB_ADDRESS = '0x0000000000000000000000000000000000000000';

// The collector stores tokens.name as "TICKER (Full Name)" (e.g. "SUP (Superp)").
// Return the ticker so the UI/logs show "SUP" instead of "ALPHA_309USDT".
function tickerFromName(name, fallback) {
  if (!name) return fallback;
  const i = name.indexOf(' (');
  const t = (i > 0 ? name.slice(0, i) : name).trim();
  return t || fallback;
}

export function useWallet() {
  return useContext(WalletContext);
}

export function WalletProvider({ children }) {
  // Config state (synced with localStorage)
  const [config, setConfig] = useState(() => {
    const saved = localStorage.getItem('crypto_wallet_config');
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        if (parsed.rpcUrl === 'https://binance.llamarpc.com') {
          parsed.rpcUrl = 'https://bsc-dataseed.binance.org';
        }
        if (!parsed.nodeRealApiKey) {
          parsed.nodeRealApiKey = '51c445c6f2b841e59a5931ad50e0939d';
        }
        if (parsed.quickBuyPercent === undefined) {
          parsed.quickBuyPercent = '5';
        }
        if (parsed.quickSellPercent === undefined) {
          parsed.quickSellPercent = '100';
        }
        if (parsed.gasPrice === undefined) {
          parsed.gasPrice = '1';
        }
        localStorage.setItem('crypto_wallet_config', JSON.stringify(parsed));
        // If the saved config has no key, fall back to the .env key so a page
        // reload never leaves the wallet locked. The key is only held in memory
        // here — it is NOT written into localStorage by this fallback.
        if (!parsed.walletInput) {
          parsed.walletInput = import.meta.env.VITE_PRIVATE_KEY || '';
        }
        return parsed;
      } catch (e) {
        console.error('Failed to parse config:', e);
      }
    }
    // Auto-load private key from .env (VITE_PRIVATE_KEY) if not already configured
    const envKey = import.meta.env.VITE_PRIVATE_KEY || '';
    return {
      rpcUrl: 'https://bsc-dataseed.binance.org',
      bscScanApiKey: '',
      nodeRealApiKey: '51c445c6f2b841e59a5931ad50e0939d',
      slippage: '0.5',
      walletInput: envKey,  // auto-loaded from .env
      quickBuyPercent: '5',
      quickSellPercent: '100',
      gasPrice: '1'
    };
  });

  // Derived wallet address and state
  const [wallet, setWallet] = useState(null);
  const [address, setAddress] = useState('');
  
  // Balances and tokens
  const [bnbBalance, setBnbBalance] = useState('0');
  const [tokens, setTokens] = useState([]); // Array of token metadata + balance
  const [customTokens, setCustomTokens] = useState(() => {
    const saved = localStorage.getItem('crypto_wallet_custom_tokens');
    return saved ? JSON.parse(saved) : [];
  });
  
  const [favoriteTokens, setFavoriteTokens] = useState(() => {
    const saved = localStorage.getItem('crypto_wallet_favorites');
    return saved ? JSON.parse(saved) : ['0x0000000000000000000000000000000000000000'];
  });
  const [tokenPrices, setTokenPrices] = useState({}); // address -> price in USD
  const [priceChanges24h, setPriceChanges24h] = useState({}); // address -> 24h change %
  const [bnbPrice, setBnbPrice] = useState(0);
  const [dexPairData, setDexPairData] = useState({}); // address -> { chainId, pairAddress }

  // Directory of Alpha tokens from the collector: symbol ("ALPHA_309USDT") -> { ticker, name, address }
  // Used to show "SUP" instead of "ALPHA_309USDT" in the dashboard tables and engine logs.
  const [tokenDirectory, setTokenDirectory] = useState({});
  // Ref mirror so refreshWalletData can read the directory without taking it as
  // a dependency (which would re-trigger the refresh effect on every reload).
  const tokenDirectoryRef = useRef({});
  useEffect(() => { tokenDirectoryRef.current = tokenDirectory; }, [tokenDirectory]);
  const resolveSymbol = useCallback(
    (symbol) => tokenDirectory[symbol]?.ticker || symbol,
    [tokenDirectory]
  );

  // Auto-Trade State
  const [autoTradeJobs, setAutoTradeJobs] = useState(() => {
    try {
      const saved = localStorage.getItem('crypto_wallet_auto_trades');
      return saved ? JSON.parse(saved) : {};
    } catch (e) {
      return {};
    }
  });
  // Ref for customTokens to avoid it being a dependency in refreshWalletData
  const customTokensRef = useRef(customTokens);
  useEffect(() => { customTokensRef.current = customTokens; }, [customTokens]);

  // Transaction history and PnL
  const [transactions, setTransactions] = useState([]);
  const [pnlSummary, setPnlSummary] = useState({});

  // Loading and error states
  const [isLoading, setIsLoading] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [txError, setTxError] = useState('');

  // ── Trading Dashboard state (fetched from FastAPI :8000) ──────────────────
  const TRADING_API = 'http://localhost:8000';
  const [tradingData, setTradingData] = useState({
    trades: [],        // TradeWithReason[] from /dashboard/overview
    openMarkers: [],   // MarkerResponse[] 
    tokenPrices: {},   // symbol → last_price
  });
  const [isTradingLoading, setIsTradingLoading] = useState(false);
  
  // Cross-program debug log state
  const [debugLogs, setDebugLogs] = useState([]);
  const [isDebugLogsLoading, setIsDebugLogsLoading] = useState(false);
  // Watermark: only show logs newer than this. Set when the user hits "Clear" so the
  // 3s poller doesn't immediately refetch the same history back into the panel.
  const debugLogsClearedAtRef = useRef(0);
  const [debugLevelFilters, setDebugLevelFilters] = useState(() => {
    const saved = sessionStorage.getItem('crypto_wallet_debug_levels');
    return saved ? JSON.parse(saved) : {
      DEBUG: false,
      ERROR: true,
      TRADE: true,
      INFO: true,
      API_REQUEST: true,
      API_RESPONSE: false,
    };
  });

  // Logs state for Debug Console (persisted in sessionStorage to survive page refreshes)
  const [logs, setLogs] = useState(() => {
    try {
      const saved = sessionStorage.getItem('crypto_wallet_debug_logs');
      return saved ? JSON.parse(saved) : [];
    } catch (e) {
      console.error('Failed to parse logs from sessionStorage:', e);
      return [];
    }
  });

  // Debounce sessionStorage writes — write at most once per second
  const logFlushTimerRef = useRef(null);
  const addLog = useCallback((message, type = 'info') => {
    setLogs(prev => {
      const newLog = {
        id: Math.random().toString(36).substring(7) + Date.now(),
        timestamp: new Date().toLocaleTimeString(),
        message,
        type
      };
      const updated = [newLog, ...prev].slice(0, 100);
      // Debounced sessionStorage write
      if (!logFlushTimerRef.current) {
        logFlushTimerRef.current = setTimeout(() => {
          logFlushTimerRef.current = null;
          setLogs(current => {
            try {
              sessionStorage.setItem('crypto_wallet_debug_logs', JSON.stringify(current));
            } catch (e) { /* ignore quota errors */ }
            return current;
          });
        }, 1000);
      }
      return updated;
    });
  }, []);

  const clearLogs = useCallback(() => {
    setLogs([]);
    try {
      sessionStorage.removeItem('crypto_wallet_debug_logs');
    } catch (e) {}
  }, []);

  // ── Trading Dashboard fetch functions ─────────────────────────────────────

  const fetchTradingDashboard = useCallback(async () => {
    try {
      const res = await fetch(`${TRADING_API}/dashboard/overview`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setTradingData({
        trades: data.trades || [],
        openMarkers: data.open_markers || [],
        tokenPrices: data.token_prices || {},
      });
      setIsTradingLoading(false);
    } catch (err) {
      // Silently fail — API might not be running
      if (!isTradingLoading) {
        log(`Trading API unavailable: ${err.message}`, 'warning');
      }
    }
  }, []);

  const fetchDebugLogs = useCallback(async () => {
    const activeLevels = Object.entries(debugLevelFilters)
      .filter(([, on]) => on)
      .map(([level]) => level);
    if (activeLevels.length === 0) return;

    try {
      const levelParam = activeLevels.join(',');
      // When the panel is empty, fetch only logs newer than the last "Clear" (watermark),
      // otherwise we'd refetch the whole history right back in.
      const lastTs = debugLogs.length > 0 ? debugLogs[0].timestamp : debugLogsClearedAtRef.current;
      const url = `${TRADING_API}/debug/logs?level=${levelParam}&limit=100&since_ms=${lastTs}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (data.length > 0) {
        setDebugLogs(prev => {
          // Merge new logs at top, deduplicate by id, keep max 500
          const existingIds = new Set(prev.map(l => l.id));
          const newLogs = data.filter(l => !existingIds.has(l.id));
          return [...newLogs, ...prev].slice(0, 500);
        });
      }
      setIsDebugLogsLoading(false);
    } catch (err) {
      // Silently fail
    }
  }, [debugLevelFilters, debugLogs]);

  const toggleDebugLevel = useCallback((level) => {
    setDebugLevelFilters(prev => {
      const updated = { ...prev, [level]: !prev[level] };
      sessionStorage.setItem('crypto_wallet_debug_levels', JSON.stringify(updated));
      return updated;
    });
    // Changing filters should pull a fresh stream including history, so drop the watermark
    debugLogsClearedAtRef.current = 0;
    setDebugLogs([]);
  }, []);

  const clearDebugLogs = useCallback(() => {
    // Hide everything up to now; the poller will only show entries logged after this point
    debugLogsClearedAtRef.current = Date.now();
    setDebugLogs([]);
  }, []);

  // Poll trading dashboard + debug logs.
  // Runs regardless of whether a wallet key is loaded so the markers/prices feed
  // (and the marker engine's status logs) stay live — the engine itself checks for
  // an unlocked wallet before it tries to execute a swap.
  useEffect(() => {
    setIsTradingLoading(true);
    setIsDebugLogsLoading(true);

    fetchTradingDashboard();
    fetchDebugLogs();

    const tradingInterval = setInterval(fetchTradingDashboard, 5000);
    const debugInterval = setInterval(fetchDebugLogs, 3000);

    return () => {
      clearInterval(tradingInterval);
      clearInterval(debugInterval);
    };
  }, [fetchTradingDashboard, fetchDebugLogs]);

  useEffect(() => {
    registerLogCallback(addLog);
    log('Aether Wallet engine initialized.', 'info');
  }, [addLog]);

  // Memoized RPC Provider.
  // The old code force-routed every default config through a SHARED NodeReal dev
  // key, which is globally rate-limited (HTTP 429) — that made balance/token
  // scans fail and the wallet render empty. Now: honor an explicit custom RPC,
  // else use the user's OWN NodeReal key if they set one, else fall back to the
  // public keyless BSC dataseed (which tolerates our modest request volume).
  const provider = useMemo(() => {
    const SHARED_NODEREAL_KEY = '51c445c6f2b841e59a5931ad50e0939d';
    const rpc = config.rpcUrl;
    if (rpc && rpc !== 'https://bsc-dataseed.binance.org' && !DEFAULT_RPC_URLS.includes(rpc)) {
      return getProvider(rpc); // user typed a specific endpoint — honor it
    }
    if (config.nodeRealApiKey && config.nodeRealApiKey !== SHARED_NODEREAL_KEY) {
      return getProvider(`https://bsc-mainnet.nodereal.io/v1/${config.nodeRealApiKey}`);
    }
    return getProvider('https://bsc-dataseed.binance.org');
  }, [config.rpcUrl, config.nodeRealApiKey]);

  // Save config to localStorage
  const saveConfig = useCallback((newConfig) => {
    setConfig(prev => {
      const updated = { ...prev, ...newConfig };
      localStorage.setItem('crypto_wallet_config', JSON.stringify(updated));
      return updated;
    });
  }, []);

  // Sync wallet instance when input or RPC changes
  useEffect(() => {
    if (!config.walletInput) {
      setWallet(null);
      setAddress('');
      setBnbBalance('0');
      setTokens([]);
      setTransactions([]);
      setPnlSummary({});
      return;
    }

    try {
      const derivedWallet = getWallet(config.walletInput, provider);
      if (derivedWallet) {
        setWallet(derivedWallet);
        setAddress(derivedWallet.address);
        setError('');
      } else {
        setWallet(null);
        setAddress('');
      }
    } catch (e) {
      console.error(e);
      setError(e.message);
      setWallet(null);
      setAddress('');
    }
  }, [config.walletInput, provider]);

  // Load prices from DexScreener (no fallbacks, batched in chunks of 30)
  const fetchPrices = useCallback(async (tokenAddresses = [], tokenMap = null, providerInstance = null) => {
    const addresses = Array.from(new Set([...tokenAddresses.map(a => a.toLowerCase()), WBNB_ADDRESS.toLowerCase()]));
    
    const chunks = [];
    const chunkSize = 30;
    for (let i = 0; i < addresses.length; i += chunkSize) {
      chunks.push(addresses.slice(i, i + chunkSize));
    }
    
    const prices = {};
    const changes = {};
    let bnbPriceUsd = 0;
    const tokenPairs = {};
    const quoteTokenPairs = {};

    // Pre-initialize all to 0
    addresses.forEach(addr => {
      prices[addr] = 0;
      changes[addr] = 0;
    });
    prices['0x0000000000000000000000000000000000000000'] = 0; // native bnb

    try {
      const results = await Promise.all(
        chunks.map(async (chunk) => {
          const batchStr = chunk.join(',');
          const url = `https://api.dexscreener.com/latest/dex/tokens/${batchStr}`;
          try {
            log(`DexScreener GET Request (Batch of ${chunk.length}): ${url}`, 'info');
            const response = await fetch(url);
            if (!response.ok) {
              log(`DexScreener Response Error: HTTP ${response.status} for URL: ${url}`, 'error');
              return null;
            }
            const data = await response.json();
            return data;
          } catch (chunkErr) {
            log(`DexScreener Chunk Fetch Failed: ${chunkErr.message}`, 'error');
            return null;
          }
        })
      );

      const allPairs = [];
      results.forEach(data => {
        if (data && data.pairs) {
          allPairs.push(...data.pairs);
        }
      });

      if (allPairs.length > 0) {
        
        allPairs.forEach(pair => {
          if (!pair.baseToken || !pair.quoteToken) return;
          const baseAddr = pair.baseToken.address.toLowerCase();
          const quoteAddr = pair.quoteToken.address.toLowerCase();
          const liq = parseFloat(pair.liquidity?.usd || 0);
          
          if (!tokenPairs[baseAddr] || liq > parseFloat(tokenPairs[baseAddr].liquidity?.usd || 0)) {
            tokenPairs[baseAddr] = pair;
          }
          if (!quoteTokenPairs[quoteAddr] || liq > parseFloat(quoteTokenPairs[quoteAddr].liquidity?.usd || 0)) {
            quoteTokenPairs[quoteAddr] = pair;
          }
        });

        addresses.forEach(addr => {
          const addrLower = addr.toLowerCase();
          if (tokenPairs[addrLower]) {
            const pair = tokenPairs[addrLower];
            prices[addrLower] = parseFloat(pair.priceUsd || 0);
            changes[addrLower] = parseFloat(pair.priceChange?.h24 || 0);
          } else if (quoteTokenPairs[addrLower]) {
            const pair = quoteTokenPairs[addrLower];
            const priceUsd = parseFloat(pair.priceUsd || 0);
            const priceNative = parseFloat(pair.priceNative || 0);
            prices[addrLower] = priceNative > 0 ? priceUsd / priceNative : 0;
          }
        });
      }
    } catch (e) {
      log(`DexScreener price query failed: ${e.message}`, 'error');
    }

    const wbnbLower = WBNB_ADDRESS.toLowerCase();
    bnbPriceUsd = prices[wbnbLower] || 0;

    // === ON-CHAIN FALLBACK FOR BNB PRICE ===
    if (bnbPriceUsd === 0 && providerInstance) {
      log(`WBNB price missing from DexScreener. Using PancakeSwap fallback...`, 'warning');
      try {
        const USDT_ADDRESS = '0x55d398326f99059ff775485246999027b3197955';
        const quote = await getPancakeQuote(wbnbLower, USDT_ADDRESS, '1', 18, 18, providerInstance);
        bnbPriceUsd = parseFloat(quote.amountOut);
        prices[wbnbLower] = bnbPriceUsd;
        log(`WBNB Fallback Price: ${bnbPriceUsd}`, 'success');
      } catch (e) {
        log(`WBNB Fallback failed: ${e.message}`, 'error');
      }
    }

    prices['0x0000000000000000000000000000000000000000'] = bnbPriceUsd;

    // === ON-CHAIN FALLBACK FOR OTHER TOKENS ===
    if (bnbPriceUsd > 0 && tokenMap && providerInstance) {
      const fallbackPromises = [];
      for (const addr of addresses) {
        const addrLower = addr.toLowerCase();
        if (prices[addrLower] === 0 && addrLower !== wbnbLower && addrLower !== '0x0000000000000000000000000000000000000000') {
          const meta = tokenMap[addrLower];
          if (meta) {
            log(`Missing price for ${meta.symbol}. Using PancakeSwap fallback...`, 'warning');
            fallbackPromises.push(
              getPancakeQuote(addrLower, wbnbLower, '1', meta.decimals, 18, providerInstance)
                .then(quote => {
                  const bnbAmount = parseFloat(quote.amountOut);
                  prices[addrLower] = bnbAmount * bnbPriceUsd;
                  log(`Fallback USD price for ${meta.symbol}: ${prices[addrLower]}`, 'success');
                })
                .catch(e => {
                  log(`Fallback failed for ${meta.symbol}: ${e.message}`, 'error');
                })
            );
          }
        }
      }
      if (fallbackPromises.length > 0) {
        await Promise.all(fallbackPromises);
      }
    }

    if (bnbPriceUsd === 0) {
      log(`Critical: BNB Price is $0. USD values will be inaccurate.`, 'error');
    }

    const pairData = { ...quoteTokenPairs, ...tokenPairs };
    return { prices, changes, bnbPrice: bnbPriceUsd, pairData };
  }, []);

  // Full wallet reload (auto-discovery of tokens, balances, prices, tx tracer, PnL)
  const refreshWalletData = useCallback(async (showSkeleton = false) => {
    if (!address) return;
    
    log(`Refreshing wallet data for address ${address.substring(0, 8)}...${address.substring(address.length - 6)}...`, 'info');
    if (showSkeleton) setIsLoading(true);
    else setIsRefreshing(true);
    
    setError('');

    try {
      // Read custom tokens from ref (avoids dependency in useCallback)
      const currentCustomTokens = customTokensRef.current;

      // === PHASE 1: Fetch tx history + PancakeSwap token list IN PARALLEL ===
      let rawTxData = { normal: [], bep20: [], internal: [] };
      let hasTxError = false;
      setTxError('');

      const [txResult, pancakeTokens] = await Promise.all([
        // 1a. Fetch transaction history
        fetchBscScanTxData(address, config.bscScanApiKey, config.nodeRealApiKey)
          .then(data => {
            log(`Fetched raw transfers: ${data.normal.length} normal, ${data.bep20.length} BEP-20, ${data.internal.length} internal.`, 'success');
            return data;
          })
          .catch(txFetchErr => {
            log(`Could not load transaction history: ${txFetchErr.message}`, 'warning');
            setTxError(txFetchErr.message || 'Failed to load transaction history.');
            hasTxError = true;
            return { normal: [], bep20: [], internal: [] };
          }),
        // 1b. Fetch PancakeSwap token list (usually cached)
        getPancakeSwapTokens()
          .then(tokens => {
            log(`PancakeSwap Extended token list loaded: ${tokens.length} tokens.`, 'success');
            return tokens;
          })
          .catch(() => [])
      ]);
      rawTxData = txResult;

      // Build token map
      const tokenMap = {};
      pancakeTokens.forEach(t => {
        tokenMap[t.address.toLowerCase()] = {
          address: t.address.toLowerCase(),
          symbol: t.symbol,
          name: t.name,
          decimals: t.decimals
        };
      });

      const popularTokens = [
        { address: '0x55d398326f99059ff775485246999027b3197955', symbol: 'USDT', name: 'Tether', decimals: 18 },
        { address: '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d', symbol: 'USDC', name: 'USD Coin', decimals: 18 },
        { address: '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c', symbol: 'WBNB', name: 'Wrapped BNB', decimals: 18 },
        { address: '0x0e09fabb73bd3ade0a17ecc321fd13a19e81ce82', symbol: 'CAKE', name: 'PancakeSwap', decimals: 18 },
        { address: '0x7130d2a12b9bcbfae4f2634d864a1ee1ce3ead9c', symbol: 'BTCB', name: 'Wrapped Bitcoin', decimals: 18 },
        { address: '0x2170ed0880ac9a755fd29b2688956bd959f933f8', symbol: 'ETH', name: 'Wrapped Ethereum', decimals: 18 },
        { address: '0xba2ae6b27d09034962970558644c79e122721117', symbol: 'DOGE', name: 'Wrapped Dogecoin', decimals: 8 },
        { address: '0x3ee2200efb3400f148897c269797e83d73611095', symbol: 'ADA', name: 'Wrapped Cardano', decimals: 18 },
        { address: '0x7083609fce4d1d8dc0c979aab8c869ea2c873402', symbol: 'DOT', name: 'Wrapped Polkadot', decimals: 18 },
        { address: '0x2859e4544c4bb03966803b0c4d90d2e245809047', symbol: 'SHIB', name: 'Wrapped Shiba Inu', decimals: 18 },
        { address: '0xfb1a3273ed458d2270b19008564755102f5a2fcc', symbol: 'FLOKI', name: 'Floki Inu', decimals: 9 },
        { address: '0xe9e7cea3ded0c158160365f8a912e4014d3d2c13', symbol: 'BUSD', name: 'Binance USD', decimals: 18 }
      ];
      popularTokens.forEach(t => { tokenMap[t.address.toLowerCase()] = t; });

      // Include every Alpha token the collector knows (BSC only) in the scan set.
      // Without this, a token the marker engine just bought is invisible: it's not
      // in the PancakeSwap list, and the BscScan history fetch (which used to
      // surface such tokens) can be down — so Multicall never scanned its address
      // and the balance "never changed" in the UI even though the buy succeeded.
      Object.entries(tokenDirectoryRef.current).forEach(([sym, info]) => {
        if (!info?.address) return;
        const addr = info.address.toLowerCase();
        if (!tokenMap[addr]) {
          // decimals assumed 18 for the scan; verified below for actual holdings
          tokenMap[addr] = { address: addr, symbol: info.ticker || sym, name: info.name || sym, decimals: 18, decimalsUnverified: true };
        }
      });

      if (!hasTxError && rawTxData.bep20) {
        rawTxData.bep20.forEach(tx => {
          if (tx.contractAddress) {
            const addr = tx.contractAddress.toLowerCase();
            if (!tokenMap[addr]) {
              tokenMap[addr] = {
                address: addr,
                symbol: tx.tokenSymbol || 'UNKNOWN',
                name: tx.tokenName || 'Unknown Token',
                decimals: parseInt(tx.tokenDecimal) || 18
              };
            }
          }
        });
      }

      // Fetch metadata for custom tokens not yet in map
      const customTokensToFetch = currentCustomTokens.filter(addr => !tokenMap[addr.toLowerCase()]);
      if (customTokensToFetch.length > 0) {
        log(`Fetching on-chain metadata for ${customTokensToFetch.length} custom tokens...`, 'info');
        const fetchedMetadata = await Promise.all(
          customTokensToFetch.map(addr => 
            getTokenData(addr, null, provider)
              .catch(err => {
                log(`Failed to fetch metadata for token ${addr}: ${err.message}`, 'error');
                return null;
              })
          )
        );
        fetchedMetadata.forEach(meta => {
          if (meta) {
            tokenMap[meta.address.toLowerCase()] = {
              address: meta.address.toLowerCase(),
              symbol: meta.symbol,
              name: meta.name,
              decimals: meta.decimals
            };
          }
        });
      }

      // === PHASE 2a: Balance scan + BNB balance (concurrent) ===
      // Prices are fetched AFTER this, scoped to the tokens we actually display —
      // pricing the entire token map fired hundreds of on-chain PancakeSwap
      // fallback quotes per refresh, which rate-limited (429) the RPC and made the
      // essential balance calls fail too (blank wallet).
      log(`Scanning balances for ${Object.keys(tokenMap).length} tokens using Multicall3...`, 'info');

      const [scannedTokens, bnbBal] = await Promise.all([
        scanTokenBalances(address, Object.values(tokenMap), provider)
          .then(tokens => {
            log(`Multicall scan completed. Found ${tokens.length} active holdings.`, 'success');
            return tokens;
          })
          .catch(err => {
            log(`Balance scan failed: ${err.message}`, 'error');
            return [];
          }),
        getBnbBalance(address, provider)
          .then(bal => {
            log(`Native BNB Balance: ${parseFloat(bal).toFixed(4)} BNB`, 'success');
            return bal;
          })
          .catch(err => {
            log(`BNB balance fetch failed: ${err.message}`, 'error');
            return '0';
          }),
      ]);

      setBnbBalance(bnbBal);

      // Verify decimals for holdings discovered via the collector directory
      // (scanned with an assumed 18). Only the handful actually held get an RPC.
      for (let i = 0; i < scannedTokens.length; i++) {
        const entry = tokenMap[scannedTokens[i].address.toLowerCase()];
        if (entry && entry.decimalsUnverified) {
          try {
            const data = await getTokenData(scannedTokens[i].address, address, provider);
            scannedTokens[i] = {
              address: scannedTokens[i].address, symbol: data.symbol, name: data.name,
              decimals: data.decimals, balance: data.balance,
            };
          } catch { /* keep assumed values */ }
        }
      }

      // Merge tokens
      const loadedTokens = [...scannedTokens];
      currentCustomTokens.forEach(addr => {
        const lowerAddr = addr.toLowerCase();
        if (!loadedTokens.some(t => t.address.toLowerCase() === lowerAddr)) {
          const meta = tokenMap[lowerAddr];
          if (meta) {
            loadedTokens.push({ address: lowerAddr, symbol: meta.symbol, name: meta.name, decimals: meta.decimals, balance: '0' });
          }
        }
      });

      const bnbToken = { address: '0x0000000000000000000000000000000000000000', symbol: 'BNB', name: 'Binance Coin', decimals: 18, balance: bnbBal };
      const allTokens = [bnbToken, ...loadedTokens].filter(t => !t.symbol || t.symbol.toLowerCase() !== 'spcxx');

      // === PHASE 2b: Prices — ONLY for tokens we display (held + custom + popular) ===
      // A bounded set (a few dozen) instead of the whole token universe, so the
      // on-chain price fallback can't burst the RPC into a 429.
      const priceAddrs = Array.from(new Set([
        ...allTokens.map(t => t.address.toLowerCase()),
        ...popularTokens.map(t => t.address.toLowerCase()),
        WBNB_ADDRESS.toLowerCase(),
      ]));
      let priceResult = null;
      try {
        log(`Fetching USD prices for ${priceAddrs.length} displayed tokens...`, 'info');
        priceResult = await fetchPrices(priceAddrs, tokenMap, provider);
        log(`USD prices loaded. BNB Price: $${priceResult.bnbPrice.toFixed(2)} USD`, 'success');
      } catch (priceErr) {
        log(`Failed to load token prices: ${priceErr.message}. Continuing without price data...`, 'error');
      }

      // Process prices
      let prices = {};
      let changes = {};
      let currentBnbPrice = 0;

      if (priceResult) {
        prices = priceResult.prices;
        changes = priceResult.changes;
        currentBnbPrice = priceResult.bnbPrice;
        
        // Extract and cache DexScreener pair data for charts
        if (priceResult.pairData) {
          setDexPairData(prev => ({ ...prev, ...priceResult.pairData }));
        }
      } else {
        allTokens.forEach(t => {
          prices[t.address.toLowerCase()] = 0;
          changes[t.address.toLowerCase()] = 0;
        });
      }
      
      setTokenPrices(prices);
      setPriceChanges24h(changes);
      setBnbPrice(currentBnbPrice);

      const activeTokens = allTokens.filter(t => {
        if (t.address === '0x0000000000000000000000000000000000000000') return true;
        if (currentCustomTokens.map(a => a.toLowerCase()).includes(t.address.toLowerCase())) return true;
        return parseFloat(t.balance) > 0;
      });

      setTokens(activeTokens);

      // === PHASE 3: Trace transactions & PnL (uses prices from phase 2) ===
      if (!hasTxError) {
        try {
          log('Tracing transaction history & explaining events...', 'info');
          const tracedTxs = await traceTransactions(address, rawTxData);
          setTransactions(tracedTxs);
          log(`Successfully traced ${tracedTxs.length} transactions.`, 'success');

          const currentBalances = {};
          activeTokens.forEach(t => { currentBalances[t.address] = t.balance; });

          log('Reconstructing cost basis and calculating PnL...', 'info');
          const pnl = calculateProfitLoss(tracedTxs, currentBalances, prices);
          setPnlSummary(pnl);
          log('Cost basis & PnL calculation completed.', 'success');
        } catch (traceErr) {
          log(`Trace/PnL calculation failed: ${traceErr.message}`, 'error');
          setTransactions([]);
          setPnlSummary({});
        }
      } else {
        setTransactions([]);
        setPnlSummary({});
      }
      
      log('Wallet refresh complete.', 'success');

    } catch (e) {
      log(`Wallet refresh failed: ${e.message}`, 'error');
      console.error(e);
      setError(e.message || 'Failed to refresh wallet data.');
    } finally {
      setIsLoading(false);
      setIsRefreshing(false);
    }
  }, [address, config.bscScanApiKey, config.nodeRealApiKey, fetchPrices, provider]);

  // Refresh wallet when address changes
  useEffect(() => {
    if (address) {
      refreshWalletData(true);
    }
  }, [address, refreshWalletData]);

  // Clear wallet configuration
  const clearWallet = useCallback(() => {
    localStorage.removeItem('crypto_wallet_config');
    localStorage.removeItem('crypto_wallet_custom_tokens');
    setConfig({
      rpcUrl: 'https://bsc-dataseed.binance.org',
      bscScanApiKey: '',
      nodeRealApiKey: '51c445c6f2b841e59a5931ad50e0939d',
      slippage: '0.5',
      walletInput: '',
      quickBuyPercent: '5',
      quickSellPercent: '100'
    });
    setCustomTokens([]);
    setWallet(null);
    setAddress('');
    setBnbBalance('0');
    setTokens([]);
    setTokenPrices({});
    setPriceChanges24h({});
    setBnbPrice(0);
    setTransactions([]);
    setPnlSummary({});
    setError('');
    setTxError('');
  }, []);

  const addCustomToken = useCallback(async (tokenAddress) => {
    const addr = tokenAddress.trim().toLowerCase();
    if (!ethers.isAddress(addr)) {
      throw new Error('Invalid contract address format.');
    }
    
    if (customTokensRef.current.includes(addr)) {
      throw new Error('Token is already added.');
    }
    
    if (PRESEEDED_TOKENS.includes(addr)) {
      throw new Error('This token is already tracked by default.');
    }
    
    try {
      const data = await getTokenData(addr, address, provider);
      if (data && data.symbol) {
        setCustomTokens(prev => {
          const updated = [...prev, addr];
          localStorage.setItem('crypto_wallet_custom_tokens', JSON.stringify(updated));
          customTokensRef.current = updated;
          return updated;
        });
        
        setFavoriteTokens(prev => {
          if (!prev.includes(addr)) {
            const updatedFavs = [...prev, addr];
            localStorage.setItem('crypto_wallet_favorites', JSON.stringify(updatedFavs));
            return updatedFavs;
          }
          return prev;
        });

        // Trigger a wallet refresh (no setTimeout needed — just call directly)
        refreshWalletData(false);
      }
    } catch (e) {
      console.error('Failed to add custom token:', e);
      throw new Error(`Failed to verify token contract: ${e.message || String(e)}. Make sure it is a valid BEP-20 contract address on BNB Chain.`);
    }
  }, [provider, address, refreshWalletData]);

  const removeCustomToken = useCallback((tokenAddress) => {
    const addr = tokenAddress.toLowerCase();
    setCustomTokens(prev => {
      const updated = prev.filter(a => a !== addr);
      localStorage.setItem('crypto_wallet_custom_tokens', JSON.stringify(updated));
      customTokensRef.current = updated;
      return updated;
    });
    // Trigger a wallet refresh directly
    refreshWalletData(false);
  }, [refreshWalletData]);

  const toggleFavoriteToken = useCallback((tokenAddress, forceStatus) => {
    const addr = tokenAddress.toLowerCase();
    setFavoriteTokens(prev => {
      let updated;
      if (forceStatus === true) {
        if (prev.includes(addr)) return prev;
        updated = [...prev, addr];
      } else if (forceStatus === false) {
        updated = prev.filter(a => a !== addr);
      } else {
        if (prev.includes(addr)) updated = prev.filter(a => a !== addr);
        else updated = [...prev, addr];
      }
      localStorage.setItem('crypto_wallet_favorites', JSON.stringify(updated));
      return updated;
    });
  }, []);

  // Track a token = favorite it AND persist it as a custom token (so it survives
  // a 0-balance refresh). Idempotent; no throw on duplicates.
  const autoTrackToken = useCallback((tokenAddress) => {
    const addr = tokenAddress.toLowerCase();
    if (addr === BNB_ADDRESS) return;
    setFavoriteTokens(prev => {
      if (prev.includes(addr)) return prev;
      const updated = [...prev, addr];
      localStorage.setItem('crypto_wallet_favorites', JSON.stringify(updated));
      return updated;
    });
    if (!PRESEEDED_TOKENS.includes(addr) && !customTokensRef.current.includes(addr)) {
      setCustomTokens(prev => {
        if (prev.includes(addr)) return prev;
        const updated = [...prev, addr];
        localStorage.setItem('crypto_wallet_custom_tokens', JSON.stringify(updated));
        customTokensRef.current = updated;
        return updated;
      });
    }
  }, []);

  // Serializes auto-approve txs so they go out one nonce at a time; tracks which
  // tokens we've already handled this session so we don't re-check every render.
  const autoApproveChainRef = useRef(Promise.resolve());
  const autoManagedRef = useRef(new Set());

  // Pre-approve a held token for swapping via the OpenOcean router. Idempotent:
  // checks the on-chain allowance first and only sends an approve tx (MaxUint256)
  // if it isn't already sufficient — so this costs gas at most once per token.
  const ensureTokenApproved = useCallback(async (token, w) => {
    try {
      const amount = token.balance && parseFloat(token.balance) > 0 ? token.balance : '0';
      const ok = await checkAllowance(token.address, w.address, OPENOCEAN_SPENDER, amount, token.decimals || 18, w.provider);
      if (ok) return;
      log(`Auto-approving ${token.symbol} for swapping...`, 'info');
      const tx = await approveToken(token.address, OPENOCEAN_SPENDER, amount, token.decimals || 18, w);
      await tx.wait();
      log(`${token.symbol} approved for swapping.`, 'success');
    } catch (e) {
      log(`Auto-approve failed for ${token.symbol}: ${e.message}`, 'error');
      autoManagedRef.current.delete(token.address.toLowerCase()); // allow a retry next refresh
    }
  }, []);

  // Collector USD prices keyed by contract address. Binance Alpha tokens usually
  // have no DexScreener/PancakeSwap pool, so their DEX price is $0 — but the
  // collector (/dashboard/overview token_prices, symbol→last_price) does price
  // them. This lets the $1 auto-manage test work for held Alpha tokens too.
  const collectorPriceByAddr = useMemo(() => {
    const map = {};
    const cp = tradingData.tokenPrices || {};
    for (const [sym, price] of Object.entries(cp)) {
      const addr = tokenDirectory[sym]?.address;
      if (addr && price > 0) map[addr.toLowerCase()] = price;
    }
    return map;
  }, [tradingData.tokenPrices, tokenDirectory]);

  // Fill in USD prices for held Alpha tokens that DexScreener can't price, using
  // the collector feed — so the dashboard shows their real value (not $0) and the
  // $1 auto-manage test works through the normal tokenPrices path. Only adds
  // missing prices (returns prev unchanged otherwise → no render loop).
  useEffect(() => {
    if (Object.keys(collectorPriceByAddr).length === 0) return;
    setTokenPrices(prev => {
      let changed = false;
      const next = { ...prev };
      for (const [addr, p] of Object.entries(collectorPriceByAddr)) {
        if (p > 0 && !(prev[addr] > 0)) { next[addr] = p; changed = true; }
      }
      return changed ? next : prev;
    });
    // Depends on tokenPrices too: refreshWalletData / the 15s poll overwrite it
    // with DEX-only prices (0 for Alpha tokens), so we must re-apply the collector
    // prices afterward. The `changed` guard makes this converge (no render loop).
  }, [collectorPriceByAddr, tokenPrices]);

  // Auto-manage any held token worth more than $1: track it (favorite + persist)
  // and pre-approve it for swapping so selling never needs a manual approve step.
  useEffect(() => {
    if (!tokens || tokens.length === 0) return;
    for (const t of tokens) {
      const addr = (t.address || '').toLowerCase();
      if (!addr || addr === BNB_ADDRESS) continue;
      const price = tokenPrices[addr] || collectorPriceByAddr[addr] || 0;
      const value = parseFloat(t.balance || '0') * price;
      if (!(value > 1)) continue;

      // 1) Track it so it stays in the dashboard.
      if (!favoriteTokens.includes(addr) || !customTokensRef.current.includes(addr)) {
        log(`Auto-tracking ${t.symbol} — balance worth $${value.toFixed(2)}.`, 'info');
        autoTrackToken(addr);
      }

      // 2) Pre-approve it for swapping (once per token; on-chain allowance guards repeats).
      if (wallet && !autoManagedRef.current.has(addr)) {
        autoManagedRef.current.add(addr);
        const token = t;
        autoApproveChainRef.current = autoApproveChainRef.current
          .then(() => ensureTokenApproved(token, wallet))
          .catch(() => {});
      }
    }
  }, [tokens, tokenPrices, collectorPriceByAddr, favoriteTokens, wallet, autoTrackToken, ensureTokenApproved]);

  // React to NEW engine fills: the daemon executes trades out-of-process, so the
  // wallet must notice them itself. When a trade id we haven't seen appears in
  // /dashboard/overview, auto-track the traded token and rescan balances —
  // previously a daemon buy landed on-chain but the UI kept showing stale
  // balances until a manual reload ("it says it bought but nothing changed").
  const seenTradesRef = useRef({ inited: false, ids: new Set() });
  const tradeRefreshTimerRef = useRef(null);
  useEffect(() => {
    const trades = tradingData.trades || [];
    if (trades.length === 0) return;
    const seen = seenTradesRef.current;
    if (!seen.inited) {
      // First poll after page load: baseline history, don't refresh.
      trades.forEach(t => seen.ids.add(t.id));
      seen.inited = true;
      return;
    }
    const fresh = trades.filter(t => !seen.ids.has(t.id));
    if (fresh.length === 0) return;
    fresh.forEach(t => seen.ids.add(t.id));

    for (const t of fresh) {
      log(`Engine fill detected: ${t.direction} ${resolveSymbol(t.symbol)} — updating balances...`, 'success');
      const addr = tokenDirectoryRef.current[t.symbol]?.address;
      if (addr) autoTrackToken(addr);
    }
    // Debounce: fills can arrive in bursts (grid legs, bracket legs).
    if (tradeRefreshTimerRef.current) clearTimeout(tradeRefreshTimerRef.current);
    tradeRefreshTimerRef.current = setTimeout(() => {
      tradeRefreshTimerRef.current = null;
      refreshWalletData(false);
    }, 2500);
  }, [tradingData.trades, autoTrackToken, refreshWalletData, resolveSymbol]);

  const saveAutoTradeJobs = useCallback((newJobs) => {
    setAutoTradeJobs(newJobs);
    localStorage.setItem('crypto_wallet_auto_trades', JSON.stringify(newJobs));
  }, []);

  const addAutoTradeJob = useCallback((tokenAddress, buyPrice, sellPrice, buyAmount, sellPercent, activeRouter = 'openocean', isDynamicSR = false, jobType = 'cycle', stopLossPrice = 0) => {
    const addr = tokenAddress.toLowerCase();
    const newJobs = { ...autoTradeJobs };
    
    if (!newJobs[addr]) newJobs[addr] = [];
    
    const newJob = {
      id: Date.now().toString(),
      type: jobType,
      buyTarget: parseFloat(buyPrice) || 0,
      sellTarget: parseFloat(sellPrice) || 0,
      stopLossTarget: parseFloat(stopLossPrice) || 0,
      buyAmount: parseFloat(buyAmount) || 0,
      sellPercent: parseFloat(sellPercent) || 0,
      status: jobType === 'manual_sell' ? 'waiting_sell' : 'waiting_buy',
      activeRouter,
      isDynamicSR,
      createdAt: Date.now()
    };

    if (jobType === 'cycle') {
      // Only one cycle job per token allowed, remove existing ones
      newJobs[addr] = newJobs[addr].filter(j => j.type && j.type !== 'cycle');
      newJobs[addr].push(newJob);
      log(`Auto-trade Cycle started for ${addr}. Waiting to BUY at $${buyPrice}`, 'success');
    } else {
      newJobs[addr].push(newJob);
      log(`Manual Limit ${jobType === 'manual_buy' ? 'BUY' : 'SELL'} set for ${addr} at $${jobType === 'manual_buy' ? buyPrice : sellPrice}`, 'success');
    }
    
    saveAutoTradeJobs(newJobs);
  }, [autoTradeJobs, saveAutoTradeJobs]);

  const removeAutoTradeJob = useCallback((tokenAddress, jobId) => {
    const addr = tokenAddress.toLowerCase();
    if (!autoTradeJobs[addr]) return;
    const newJobs = { ...autoTradeJobs };
    newJobs[addr] = newJobs[addr].filter(j => j.id !== jobId);
    if (newJobs[addr].length === 0) delete newJobs[addr];
    saveAutoTradeJobs(newJobs);
  }, [autoTradeJobs, saveAutoTradeJobs]);

  // Auto-Trade Engine Loop
  const pricesRef = useRef(tokenPrices);
  useEffect(() => { pricesRef.current = tokenPrices; }, [tokenPrices]);
  const autoTradeJobsRef = useRef(autoTradeJobs);
  useEffect(() => { autoTradeJobsRef.current = autoTradeJobs; }, [autoTradeJobs]);
  const engineContextRef = useRef({ wallet, tokens, bnbBalance, config, dexPairData: {}, bnbPrice: 0 });
  useEffect(() => {
    engineContextRef.current = { wallet, tokens, bnbBalance, config, dexPairData, bnbPrice };
  }, [wallet, tokens, bnbBalance, config, dexPairData, bnbPrice]);

  // Lightweight Background Price Polling
  useEffect(() => {
    if (!wallet || tokens.length === 0) return;
    const timer = setInterval(async () => {
      try {
        const addresses = tokens.map(t => t.address);
        const ObjectKeys = Object.keys(autoTradeJobs);
        const allAddresses = Array.from(new Set([...addresses, ...ObjectKeys]));
        
        if (allAddresses.length > 0) {
          const res = await fetchPrices(allAddresses, null, provider);
          if (res && res.prices) {
            setTokenPrices(prev => ({ ...prev, ...res.prices }));
            setPriceChanges24h(prev => ({ ...prev, ...res.changes }));
            if (res.bnbPrice) setBnbPrice(res.bnbPrice);
            setDexPairData(prev => ({ ...prev, ...res.pairData }));
          }
        }
      } catch (e) {
        console.error("Background price poll error:", e);
      }
    }, 15000); // 15 seconds
    return () => clearInterval(timer);
  }, [wallet, tokens, autoTradeJobs, provider, fetchPrices]);

  useEffect(() => {
    if (!wallet) return;
    
    const interval = setInterval(async () => {
      const jobsMap = autoTradeJobsRef.current;
      const prices = pricesRef.current;
      const ctx = engineContextRef.current;
      
      let jobsUpdated = false;
      const newJobsMap = { ...jobsMap };
      
      for (const [tokenAddr, jobs] of Object.entries(jobsMap)) {
        const currentPrice = prices[tokenAddr];
        
        // --- DYNAMIC S/R ENGINE ---
        if (jobs.length > 0 && jobs[0].isDynamicSR) {
          const pairData = ctx.dexPairData?.[tokenAddr.toLowerCase()];
          if (pairData && pairData.pairAddress) {
            try {
              const ohlcv = await get4HourOHLCV(pairData.pairAddress);
              const { support, resistance } = calculateSupportResistance(ohlcv);
              if (support > 0 && resistance > 0) {
                jobs[0].buyTarget = support;
                jobs[0].sellTarget = resistance;
                log(`[Engine] Dynamically updated S/R for ${tokenAddr.substring(0,6)}... Buy < ${support.toFixed(4)} | Sell > ${resistance.toFixed(4)}`, 'info');
              }
            } catch (e) {
              log(`[Engine] Failed to dynamically update S/R for ${tokenAddr.substring(0,6)}... ${e.message}`, 'error');
            }
          }
        }

        if (!currentPrice || currentPrice <= 0) continue;
        
        for (let i = 0; i < jobs.length; i++) {
          const job = jobs[i];
          
          let triggeredBuy = false;
          let triggeredSell = false;
          
          let effectiveBuyPrice = currentPrice;
          let effectiveSellPrice = currentPrice;
          const isManual = job.type === 'manual_buy' || job.type === 'manual_sell';

          // If it's a manual job and we are within 5% of the target, start polling live quotes
          if (isManual && job.status === 'waiting_buy' && currentPrice <= job.buyTarget * 1.05) {
             const bnbPrice = prices[WBNB_ADDRESS.toLowerCase()] || 0;
             if (bnbPrice > 0) {
                 try {
                     const quote = await getOpenOceanQuote(ethers.ZeroAddress, tokenAddr, job.buyAmount.toString(), '0.5', ctx.wallet.address, '3');
                     if (quote && quote.data && quote.data.outAmount) {
                         const outAmt = parseFloat(ethers.formatUnits(quote.data.outAmount, quote.data.toToken.decimals || 18));
                         if (outAmt > 0) effectiveBuyPrice = (job.buyAmount * bnbPrice) / outAmt;
                     }
                 } catch (e) { /* ignore quote error */ }
             }
          }

          const isTakeProfitClose = job.sellTarget > 0 && currentPrice >= job.sellTarget * 0.95;
          const isStopLossClose = job.stopLossTarget > 0 && currentPrice <= job.stopLossTarget * 1.05;

          if (isManual && job.status === 'waiting_sell' && (isTakeProfitClose || isStopLossClose)) {
             const bnbPrice = prices[WBNB_ADDRESS.toLowerCase()] || 0;
             const tData = ctx.tokens.find(t => t.address === tokenAddr);
             if (bnbPrice > 0 && tData && parseFloat(tData.balance) > 0) {
                 try {
                     const amtToken = (parseFloat(tData.balance) * (job.sellPercent / 100)).toString();
                     const quote = await getOpenOceanQuote(tokenAddr, ethers.ZeroAddress, amtToken, '0.5', ctx.wallet.address, '1');
                     if (quote && quote.data && quote.data.outAmount) {
                         const outAmt = parseFloat(ethers.formatUnits(quote.data.outAmount, 18));
                         if (parseFloat(amtToken) > 0) effectiveSellPrice = (outAmt * bnbPrice) / parseFloat(amtToken);
                     }
                 } catch (e) { /* ignore quote error */ }
             }
          }

          if (job.status === 'waiting_buy' && effectiveBuyPrice <= job.buyTarget) {
            log(`Auto-Trade BUY triggered for ${tokenAddr.substring(0,6)}... at $${effectiveBuyPrice.toFixed(4)} (Target: $${job.buyTarget})`, 'info');
            triggeredBuy = true;
          } else if (job.status === 'waiting_sell') {
            const hitTP = job.sellTarget > 0 && effectiveSellPrice >= job.sellTarget;
            const hitSL = job.stopLossTarget > 0 && effectiveSellPrice <= job.stopLossTarget;
            
            if (hitTP || hitSL) {
              log(`Auto-Trade SELL triggered for ${tokenAddr.substring(0,6)}... at $${effectiveSellPrice.toFixed(4)} (TP: $${job.sellTarget}, SL: $${job.stopLossTarget})`, 'info');
              triggeredSell = true;
            }
          }
          
          if (triggeredBuy || triggeredSell) {
            // Optimistically update status to prevent double firing while executing
            newJobsMap[tokenAddr][i] = { 
              ...job, 
              status: triggeredBuy ? 'executing_buy' : 'executing_sell' 
            };
            jobsUpdated = true;
            
            // Background execution
            (async () => {
              try {
                const slippage = ctx.config.slippage || '0.5';
                const gasPrice = ctx.config.gasPrice || '1';
                const isBuy = triggeredBuy;
                
                const fromAddr = isBuy ? ethers.ZeroAddress : tokenAddr;
                const toAddr = isBuy ? tokenAddr : ethers.ZeroAddress;
                
                let amountInStr = '0';
                let decimalsIn = 18;
                
                if (isBuy) {
                  const maxBnb = parseFloat(ctx.bnbBalance || '0');
                  const amtBnb = Math.min(job.buyAmount, maxBnb);
                  if (amtBnb <= 0) throw new Error('Insufficient BNB balance for auto-buy');
                  amountInStr = amtBnb.toFixed(4);
                } else {
                  const tData = ctx.tokens.find(t => t.address === tokenAddr);
                  if (!tData || parseFloat(tData.balance) <= 0) throw new Error('Insufficient token balance for auto-sell');
                  const bal = parseFloat(tData.balance);
                  const amtToken = (bal * (job.sellPercent / 100));
                  amountInStr = amtToken.toFixed(tData.decimals || 18);
                  decimalsIn = tData.decimals || 18;
                  
                  // Check allowance against the router that will execute the swap
                  const spender = job.activeRouter === 'openocean' ? '0x6352a56caadC4F1E25CD6c75970Ce758faa8abcd' : '0x10ed43c718714eb63d5aa57b78b54704e256024e';
                  const approved = await checkAllowance(tokenAddr, ctx.wallet.address, spender, amountInStr, decimalsIn, ctx.wallet.provider);
                  if (!approved) {
                     log(`Auto-Trade: Approving token ${tokenAddr}...`, 'info');
                     const approveTx = await approveToken(tokenAddr, spender, amountInStr, decimalsIn, ctx.wallet);
                     await approveTx.wait();
                  }
                }

                log(`Auto-Trade: Requesting ${job.activeRouter} quote for ${amountInStr}...`, 'info');

                let tx;
                const quote = await getOpenOceanQuote(fromAddr, toAddr, amountInStr, slippage, ctx.wallet.address, gasPrice);
                if (!quote || !quote.data) throw new Error('Invalid OpenOcean quote');
                tx = await executeBuiltSwap(quote.data, gasPrice, ctx.wallet);
                
                log('Auto-Trade: Waiting for confirmation...', 'info');
                await tx.wait();
                log(`Auto-trade ${isBuy ? 'BUY' : 'SELL'} execution successful!`, 'success');
                
                // Switch mode
                setAutoTradeJobs(prev => {
                  const latestJobs = { ...prev };
                  if (latestJobs[tokenAddr]) {
                    const idx = latestJobs[tokenAddr].findIndex(j => j.id === job.id);
                    if (idx !== -1) {
                      if (job.type === 'manual_buy' || job.type === 'manual_sell') {
                         latestJobs[tokenAddr].splice(idx, 1);
                         if (latestJobs[tokenAddr].length === 0) delete latestJobs[tokenAddr];
                      } else {
                         latestJobs[tokenAddr][idx] = {
                           ...latestJobs[tokenAddr][idx],
                           status: isBuy ? 'waiting_sell' : 'waiting_buy'
                         };
                      }
                      localStorage.setItem('crypto_wallet_auto_trades', JSON.stringify(latestJobs));
                    }
                  }
                  return latestJobs;
                });
                
                setTimeout(() => refreshWalletData(false), 3000);
              } catch (e) {
                log(`Auto-Trade Execution Failed: ${e.message}`, 'error');
                // Revert status on failure
                setAutoTradeJobs(prev => {
                  const latestJobs = { ...prev };
                  if (latestJobs[tokenAddr]) {
                    const idx = latestJobs[tokenAddr].findIndex(j => j.id === job.id);
                    if (idx !== -1) {
                      latestJobs[tokenAddr][idx] = {
                        ...latestJobs[tokenAddr][idx],
                        status: isBuy ? 'waiting_buy' : 'waiting_sell'
                      };
                      localStorage.setItem('crypto_wallet_auto_trades', JSON.stringify(latestJobs));
                    }
                  }
                  return latestJobs;
                });
              }
            })();
          }
        }
      }
      if (jobsUpdated) saveAutoTradeJobs(newJobsMap);
    }, 60000); // 1 minute interval
    return () => clearInterval(interval);
  }, [wallet, saveAutoTradeJobs, refreshWalletData]);

  // ──────────────────────────────────────────────────────────────────────────
  // Marker execution now lives in the headless marker-engine daemon (see
  // marker-engine/). The wallet only DISPLAYS markers/trades/logs and controls
  // the engine via /engine/settings — no browser tab needs to stay open for
  // trades to fire, and HMR can no longer spawn duplicate execution loops.
  // ──────────────────────────────────────────────────────────────────────────

  // Build the token directory (symbol -> address + ticker/name) from the collector's token
  // table. Runs regardless of wallet state so the dashboard can label ALPHA_### symbols.
  useEffect(() => {
    let cancelled = false;
    const loadTokenMap = async () => {
      try {
        const res = await fetch(`${TRADING_API}/tokens?limit=2000`);
        if (!res.ok) return;
        const data = await res.json();
        if (cancelled || !Array.isArray(data)) return;
        const dir = {};
        for (const t of data) {
          if (!t.symbol || !t.contract_address || !ethers.isAddress(t.contract_address)) continue;
          const addr = ethers.getAddress(t.contract_address);
          dir[t.symbol] = { ticker: tickerFromName(t.name, t.symbol), name: t.name || t.symbol, address: addr };
        }
        setTokenDirectory(dir);
      } catch { /* API may be down */ }
    };
    loadTokenMap();
    const id = setInterval(loadTokenMap, 5 * 60 * 1000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  // ── Engine settings (pause flag + risk limits, served by the API) ─────────
  const [engineSettings, setEngineSettings] = useState(null);

  const fetchEngineSettings = useCallback(async () => {
    try {
      const res = await fetch(`${TRADING_API}/engine/settings`);
      if (res.ok) setEngineSettings(await res.json());
    } catch { /* API may be down */ }
  }, []);

  const updateEngineSettings = useCallback(async (patch) => {
    try {
      const res = await fetch(`${TRADING_API}/engine/settings`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      if (res.ok) {
        const updated = await res.json();
        setEngineSettings(updated);
        log(`Engine settings updated${patch.paused !== undefined ? ` — engine ${patch.paused ? 'PAUSED' : 'RESUMED'}` : ''}.`,
            patch.paused ? 'warning' : 'success');
      }
    } catch (e) {
      log(`Failed to update engine settings: ${e.message}`, 'error');
    }
  }, []);

  useEffect(() => {
    fetchEngineSettings();
    const id = setInterval(fetchEngineSettings, 15000);
    return () => clearInterval(id);
  }, [fetchEngineSettings]);


  return (
    <WalletContext.Provider value={{
      config,
      saveConfig,
      wallet,
      address,
      bnbBalance,
      tokens,
      customTokens,
      tokenPrices,
      priceChanges24h,
      bnbPrice,
      transactions,
      pnlSummary,
      isLoading,
      isRefreshing,
      error,
      txError,
      favoriteTokens,
      toggleFavoriteToken,
      refreshWallet: () => refreshWalletData(false),
      clearWallet,
      addCustomToken,
      removeCustomToken,
      provider,
      logs,
      clearLogs,
      dexPairData,
      autoTradeJobs,
      addAutoTradeJob,
      removeAutoTradeJob,
      // Trading dashboard
      tradingData,
      isTradingLoading,
      debugLogs,
      isDebugLogsLoading,
      debugLevelFilters,
      toggleDebugLevel,
      clearDebugLogs,
      fetchTradingDashboard,
      resolveSymbol,
      engineSettings,
      updateEngineSettings,
    }}>
      {children}
    </WalletContext.Provider>
  );
}
