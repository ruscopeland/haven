import { useState, useEffect, useRef, useCallback } from 'react';
import { formatUnits } from 'ethers';
import {
  multicallBalanceOf, multicallDecimals, getNativeBalance,
  CHAIN_NATIVE,
} from '../utils/multicall';

// Key-free multi-chain wallet data. Private key never enters this app.
// Scans BSC + Ethereum + Base for ERC-20 balances via Multicall3.

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:8000';
const ADDR_KEY = 'alpha_wallet_address';
const SCAN_CHAINS = ['bsc', 'ethereum', 'base'];

// Native price feeds (DexScreener) for portfolio USD.
const NATIVE_PRICE_ADDR = {
  bsc: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c',       // WBNB
  ethereum: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',  // WETH
  base: '0x4200000000000000000000000000000000000006',     // WETH on Base
};

export function getSavedAddress() {
  return localStorage.getItem(ADDR_KEY) || import.meta.env.VITE_WALLET_ADDRESS || '';
}

async function fetchNativeUsd(chain) {
  const addr = NATIVE_PRICE_ADDR[chain];
  if (!addr) return null;
  const r = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${addr}`);
  const j = await r.json();
  const pairs = (j.pairs || []).filter(p => p.priceUsd);
  pairs.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0));
  return pairs[0] ? parseFloat(pairs[0].priceUsd) : null;
}

export default function useWalletData() {
  const [address, setAddressState] = useState(getSavedAddress);
  // Legacy single-chain fields kept for Dashboard compatibility (BSC primary).
  const [bnb, setBnb] = useState(null);
  const [bnbPrice, setBnbPrice] = useState(null);
  const [tokens, setTokens] = useState([]); // [{symbol, name, qty, chain, contract}]
  const [natives, setNatives] = useState({}); // chain -> { qty, priceUsd, symbol }
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const decimalsCache = useRef({}); // `${chain}:${addr}` -> decimals

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
        // Full token universe for balance discovery (wallet must see held dust).
        const tokenList = [];
        let skip = 0;
        const page = 500;
        for (;;) {
          const tokensRes = await fetch(
            `${API_URL}/tokens?status=all&min_liquidity=0&quality=false&limit=${page}&skip=${skip}`);
          if (!tokensRes.ok) throw new Error('API unavailable');
          const batch = await tokensRes.json();
          if (!Array.isArray(batch) || batch.length === 0) break;
          tokenList.push(...batch);
          if (batch.length < page) break;
          skip += page;
          if (skip > 20000) break;
        }
        if (!alive) return;

        const byChain = { bsc: [], ethereum: [], base: [] };
        for (const t of tokenList) {
          if (!/^0x[0-9a-fA-F]{40}$/.test(t.contract_address || '')) continue;
          let chain = String(t.chain_id || 'bsc').toLowerCase();
          if (chain === '56') chain = 'bsc';
          if (chain === '1') chain = 'ethereum';
          if (chain === '8453') chain = 'base';
          if (!byChain[chain]) continue;
          byChain[chain].push(t);
        }

        const allHeld = [];
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

            const list = byChain[chain] || [];
            const contracts = list.map(t => t.contract_address);
            if (!contracts.length) return;

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
                name: t.name || t.display_symbol || t.symbol,
                qty: parseFloat(formatUnits(raw, decimals)),
                chain,
                contract: t.contract_address,
              });
            }
          } catch (e) {
            // One chain failing shouldn't blank the whole portfolio.
            console.warn(`wallet scan ${chain}:`, e);
          }
        }));

        if (!alive) return;
        setNatives(nextNatives);
        // BSC native = legacy bnb fields for existing Dashboard cards.
        setBnb(nextNatives.bsc?.qty ?? null);
        setBnbPrice(nextNatives.bsc?.priceUsd ?? null);
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
    bnb, bnbPrice,           // BSC native (dashboard compat)
    natives,                 // { bsc, ethereum, base }
    tokens,                  // multi-chain ERC-20s
    error, loading,
  };
}
