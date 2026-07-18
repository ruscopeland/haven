import { useState, useEffect, useRef, useCallback } from 'react';
import { formatUnits } from 'ethers';
import {
  multicallBalanceOf, multicallDecimals, getNativeBalance,
  CHAIN_NATIVE,
} from '../utils/multicall';

// Key-free multi-chain wallet data. Private key never enters this app.
// Discovers ERC-20 balances even when our /tokens DB is empty or filtered:
//   1) natives always (BNB/ETH)
//   2) contracts from /tokens (full scan)
//   3) contracts from engine trade history
//   4) optional extra contracts in localStorage

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:8000';
const ADDR_KEY = 'alpha_wallet_address';
const EXTRA_CONTRACTS_KEY = 'havenWalletExtraContracts'; // JSON: { bsc: ['0x…'], … }
const TOKENLIST_CACHE_KEY = 'havenTokenListCache';       // { [url]: { ts, tokens } }
const TOKENLIST_CACHE_TTL = 24 * 60 * 60 * 1000;        // 24 hours
const SCAN_CHAINS = ['bsc', 'ethereum', 'base', 'arbitrum', 'polygon', 'optimism', 'avalanche'];

const NATIVE_PRICE_SYMBOL = { bsc: 'BNB', ethereum: 'ETH', base: 'ETH', arbitrum: 'ETH', polygon: 'POL', optimism: 'ETH', avalanche: 'AVAX' };

// Official / community-maintained token lists per chain (standard tokenlists.org format).
// Each list contains thousands of verified tokens. Fetched at scan time, cached 24h.
const TOKEN_LIST_SOURCES = [
  { url: 'https://tokens.uniswap.org',                                              chain: 'ethereum' },
  { url: 'https://tokens.pancakeswap.finance/pancakeswap-extended.json',             chain: 'bsc' },
  { url: 'https://unpkg.com/quickswap-default-token-list@latest/build/quickswap-default.tokenlist.json', chain: 'polygon' },
  { url: 'https://static.optimism.io/optimism.tokenlist.json',                       chain: 'optimism' },
  { url: 'https://raw.githubusercontent.com/traderjoe-xyz/joe-tokenlists/main/mc.tokenlist.json', chain: 'avalanche' },
];

export function getSavedAddress() {
  // Multi-tenant rule: never default every account to a shared wallet.
  // Only this browser's localStorage address applies for signed-in users.
  // VITE_WALLET_ADDRESS is solo/local-dev only (import.meta.env.DEV) so a
  // production build cannot bake the operator's test address into the bundle.
  const saved = localStorage.getItem(ADDR_KEY);
  if (saved) return saved;
  if (import.meta.env.DEV) {
    return import.meta.env.VITE_WALLET_ADDRESS || '';
  }
  return '';
}

async function fetchNativeUsd(chain) {
  const symbol = NATIVE_PRICE_SYMBOL[chain];
  if (!symbol) return null;
  const r = await fetch(`${API_URL}/market/prices?symbols=${symbol}`);
  if (!r.ok) return null;
  const j = await r.json();
  const price = j.prices?.[symbol]?.price;
  return price > 0 ? Number(price) : null;
}

function loadExtraContracts() {
  try {
    const raw = localStorage.getItem(EXTRA_CONTRACTS_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function normChain(c) {
  const s = String(c || 'bsc').toLowerCase();
  if (s === '56')    return 'bsc';
  if (s === '1')     return 'ethereum';
  if (s === '8453')  return 'base';
  if (s === '42161') return 'arbitrum';
  if (s === '137')   return 'polygon';
  if (s === '10')    return 'optimism';
  if (s === '43114') return 'avalanche';
  return s;
}

async function fetchAllTokenRows() {
  const tokenList = [];
  let skip = 0;
  const page = 500;
  for (;;) {
    // quality=false + min_liquidity=0 + status=all → every row for balance scan
    const url = `${API_URL}/tokens?status=all&min_liquidity=0&quality=false&limit=${page}&skip=${skip}`;
    const tokensRes = await fetch(url);
    if (!tokensRes.ok) {
      // Don't hard-fail the whole wallet if API is empty/down — natives still load
      console.warn('wallet: /tokens failed', tokensRes.status);
      break;
    }
    const batch = await tokensRes.json();
    if (!Array.isArray(batch) || batch.length === 0) break;
    tokenList.push(...batch);
    if (batch.length < page) break;
    skip += page;
    if (skip > 20000) break;
  }
  return tokenList;
}

async function fetchTradeContracts() {
  // Tokens the engine has traded — always worth scanning even if retired/blacklisted
  try {
    const r = await fetch(`${API_URL}/trades?limit=1000`);
    if (!r.ok) return [];
    const trades = await r.json();
    const syms = [...new Set((trades || []).map(t => t.symbol).filter(Boolean))];
    const out = [];
    for (const sym of syms.slice(0, 200)) {
      try {
        const tr = await fetch(`${API_URL}/tokens/${encodeURIComponent(sym)}`);
        if (!tr.ok) continue;
        const t = await tr.json();
        if (t?.contract_address) out.push(t);
      } catch { /* skip */ }
    }
    return out;
  } catch {
    return [];
  }
}

// Fetches official token lists per chain (Uniswap, PancakeSwap, etc.).
// These cover thousands of established tokens the Binance Alpha catalogue misses.
// Results are cached in localStorage for 24 hours.
async function fetchTokenLists() {
  // Check cache
  let cache = {};
  try {
    const raw = localStorage.getItem(TOKENLIST_CACHE_KEY);
    if (raw) cache = JSON.parse(raw);
  } catch { /* corrupt — refetch */ }

  const allTokens = [];
  const now = Date.now();

  await Promise.all(TOKEN_LIST_SOURCES.map(async ({ url, chain }) => {
    // Use cache if fresh
    const entry = cache[url];
    if (entry && entry.ts && (now - entry.ts) < TOKENLIST_CACHE_TTL && Array.isArray(entry.tokens)) {
      allTokens.push(...entry.tokens);
      return;
    }

    try {
      const r = await fetch(url);
      if (!r.ok) return;
      const data = await r.json();
      const list = data?.tokens;
      if (!Array.isArray(list)) return;

      const tokens = [];
      for (const t of list) {
        const addr = t?.address;
        if (!addr || !/^0x[0-9a-fA-F]{40}$/.test(addr)) continue;
        tokens.push({
          contract_address: addr,
          symbol: t.symbol || addr.slice(0, 10),
          name: t.name || t.symbol || addr.slice(0, 10),
          chain_id: chain, // already a name like "ethereum", "bsc"
        });
      }

      // Cache the result
      cache[url] = { ts: now, tokens };
      allTokens.push(...tokens);
    } catch {
      // List fetch failed — use stale cache if available
      if (entry && Array.isArray(entry.tokens)) {
        allTokens.push(...entry.tokens);
      }
    }
  }));

  // Persist cache
  try { localStorage.setItem(TOKENLIST_CACHE_KEY, JSON.stringify(cache)); } catch { /* quota exceeded */ }

  return allTokens;
}

export default function useWalletData() {
  const [address, setAddressState] = useState(getSavedAddress);
  const [bnb, setBnb] = useState(null);
  const [bnbPrice, setBnbPrice] = useState(null);
  const [tokens, setTokens] = useState([]);
  const [natives, setNatives] = useState({});
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [recovering, setRecovering] = useState(false);
  const decimalsCache = useRef({});

  // On first mount, if localStorage has no address, try to recover it from
  // the backend credential store (survives localStorage clear / WebView2 reset).
  useEffect(() => {
    if (getSavedAddress()) return; // already have an address
    let alive = true;
    (async () => {
      try {
        const r = await fetch(`${API_URL}/wallet/status`);
        if (!r.ok) return;
        const d = await r.json();
        if (d.configured && d.address && alive) {
          localStorage.setItem(ADDR_KEY, d.address);
          setAddressState(d.address);
        }
      } catch { /* backend not ready yet — will retry next poll */ }
      if (alive) setRecovering(false);
    })();
    return () => { alive = false; };
  }, []);

  const setAddress = useCallback((a) => {
    const trimmed = (a || '').trim();
    localStorage.setItem(ADDR_KEY, trimmed);
    setAddressState(trimmed);
    setBnb(null); setTokens([]); setNatives({});
  }, []);

  useEffect(() => {
    if (!/^0x[0-9a-fA-F]{40}$/.test(address)) return undefined;
    let alive = true;

    const loadBalances = async () => {
      setLoading(true);
      try {
        // 1) Always load natives first so portfolio isn't blank if token list is empty
        const nextNatives = {};
        await Promise.all(SCAN_CHAINS.map(async (chain) => {
          try {
            const nativeQty = Number(await getNativeBalance(address, chain)) / 1e18;
            let priceUsd = null;
            try { priceUsd = await fetchNativeUsd(chain); } catch { /* */ }
            const meta = CHAIN_NATIVE[chain];
            nextNatives[chain] = {
              qty: nativeQty,
              priceUsd,
              symbol: meta.symbol,
              name: meta.name,
              usd: priceUsd != null ? nativeQty * priceUsd : 0,
            };
          } catch (e) {
            console.warn(`wallet native ${chain}:`, e);
          }
        }));
        if (!alive) return;
        setNatives(nextNatives);
        setBnb(nextNatives.bsc?.qty ?? null);
        setBnbPrice(nextNatives.bsc?.priceUsd ?? null);

        // 2) Build contract catalog from Binance Alpha + token lists + trades + extras
        const [apiTokens, tradeTokens, listTokens] = await Promise.all([
          fetchAllTokenRows(),
          fetchTradeContracts(),
          fetchTokenLists(),
        ]);
        if (!alive) return;

        const byChain = {};
        for (const c of SCAN_CHAINS) byChain[c] = new Map();
        const addRow = (t) => {
          if (!t || !/^0x[0-9a-fA-F]{40}$/.test(t.contract_address || '')) return;
          const chain = normChain(t.chain_id || 'bsc');
          if (!byChain[chain]) return;
          const addr = t.contract_address.toLowerCase();
          if (!byChain[chain].has(addr)) {
            byChain[chain].set(addr, {
              symbol: t.symbol || addr,
              name: t.name || t.display_symbol || t.symbol || addr,
              contract_address: t.contract_address,
              chain_id: chain,
            });
          }
        };
        for (const t of apiTokens) addRow(t);
        for (const t of tradeTokens) addRow(t);
        for (const t of listTokens) addRow(t);

        const extras = loadExtraContracts();
        for (const chain of SCAN_CHAINS) {
          for (const c of extras[chain] || []) {
            if (/^0x[0-9a-fA-F]{40}$/.test(c)) {
              addRow({
                contract_address: c,
                chain_id: chain,
                symbol: c.slice(0, 10),
                name: `Token ${c.slice(0, 8)}…`,
              });
            }
          }
        }

        // 3) Multicall balances per chain
        const allHeld = [];
        await Promise.all(SCAN_CHAINS.map(async (chain) => {
          try {
            const list = [...(byChain[chain]?.values() || [])];
            if (!list.length) return;
            const contracts = list.map(t => t.contract_address);
            const balances = await multicallBalanceOf(address, contracts, chain);
            const held = list.filter(t => {
              const bal = balances.get(t.contract_address.toLowerCase());
              return bal != null && bal > 0n;
            });
            const needDec = held
              .map(t => t.contract_address.toLowerCase())
              .filter(addr => decimalsCache.current[`${chain}:${addr}`] == null);
            if (needDec.length) {
              const fetched = await multicallDecimals(needDec, chain);
              fetched.forEach((d, addr) => { decimalsCache.current[`${chain}:${addr}`] = d; });
            }
            for (const t of held) {
              const addr = t.contract_address.toLowerCase();
              const raw = balances.get(addr);
              const decimals = decimalsCache.current[`${chain}:${addr}`] ?? 18;
              allHeld.push({
                symbol: t.symbol,
                name: t.name,
                qty: parseFloat(formatUnits(raw, decimals)),
                chain,
                contract: t.contract_address,
              });
            }
          } catch (e) {
            console.warn(`wallet scan ${chain}:`, e);
          }
        }));

        if (!alive) return;
        setTokens(allHeld);
        setError(null);
      } catch (e) {
        if (alive) setError(String(e.message || e));
      }
      if (alive) setLoading(false);
    };

    loadBalances();
    const a = setInterval(loadBalances, 45_000);
    return () => { alive = false; clearInterval(a); };
  }, [address]);

  return {
    address, setAddress,
    bnb, bnbPrice,
    natives,
    tokens,
    error, loading,
  };
}
