import { useState, useEffect, useRef, useCallback } from 'react';
import { formatUnits } from 'ethers';
import { multicallBalanceOf, multicallDecimals } from '../utils/multicall';

// Key-free wallet data (see docs/C1-wallet-hook.md). Reads balances with raw
// JSON-RPC calls to a public BSC node — the private key never enters this app.

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:8000';
const BSC_RPC = 'https://bsc-dataseed.binance.org/';
const WBNB = '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c';
const ADDR_KEY = 'alpha_wallet_address';

async function rpc(method, params) {
  const r = await fetch(BSC_RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message);
  return j.result;
}

export function getSavedAddress() {
  return localStorage.getItem(ADDR_KEY) || import.meta.env.VITE_WALLET_ADDRESS || '';
}

export default function useWalletData() {
  const [address, setAddressState] = useState(getSavedAddress);
  const [bnb, setBnb] = useState(null);          // BNB balance (float)
  const [bnbPrice, setBnbPrice] = useState(null); // USD per BNB
  const [tokens, setTokens] = useState([]);       // [{symbol, name, qty}]
  const [error, setError] = useState(null);
  const decimalsCache = useRef({}); // contract (lowercase) -> decimals, across polls

  const setAddress = useCallback((a) => {
    const trimmed = (a || '').trim();
    localStorage.setItem(ADDR_KEY, trimmed);
    setAddressState(trimmed);
    setBnb(null); setTokens([]);
  }, []);

  useEffect(() => {
    if (!/^0x[0-9a-fA-F]{40}$/.test(address)) return undefined;
    let alive = true;

    // Scans the WHOLE Alpha token universe the collector tracks (not just
    // symbols this wallet has traded via the engine) via a single batched
    // Multicall3 call — same technique the old wallet used (blockchain.js
    // scanTokenBalances), so any token a strategy or manual trade newly holds
    // shows up automatically on the next 30s poll, with no approval step:
    // every Binance Alpha token the collector lists is in scope already.
    const loadBalances = async () => {
      try {
        const balHex = await rpc('eth_getBalance', [address, 'latest']);
        if (!alive) return;
        setBnb(parseInt(balHex, 16) / 1e18);

        const tokensRes = await fetch(`${API_URL}/tokens?limit=500`);
        if (!tokensRes.ok) throw new Error('API unavailable');
        const tokenList = await tokensRes.json();
        // Binance Alpha lists tokens across multiple chains; non-EVM ones (e.g.
        // Sui/Move-style "0x…::module::TYPE") have contract_address values that
        // aren't 20-byte hex addresses and would throw during ABI encoding —
        // skip them, this scan is BSC-only.
        const withContract = tokenList.filter(t => /^0x[0-9a-fA-F]{40}$/.test(t.contract_address || ''));
        const contracts = withContract.map(t => t.contract_address);

        const balances = await multicallBalanceOf(address, contracts);
        if (!alive) return;

        const held = withContract.filter(t => {
          const bal = balances.get(t.contract_address.toLowerCase());
          return bal != null && bal > 0n;
        });

        const needDecimals = held
          .map(t => t.contract_address.toLowerCase())
          .filter(addr => decimalsCache.current[addr] == null);
        if (needDecimals.length > 0) {
          const fetched = await multicallDecimals(needDecimals);
          fetched.forEach((d, addr) => { decimalsCache.current[addr] = d; });
        }
        if (!alive) return;

        const rows = held.map(t => {
          const addr = t.contract_address.toLowerCase();
          const raw = balances.get(addr);
          const decimals = decimalsCache.current[addr] ?? 18;
          // formatUnits does the division as a string (BigInt-safe) — a raw
          // 256-bit balance can exceed Number.MAX_SAFE_INTEGER before scaling.
          return { symbol: t.symbol, name: t.name, qty: parseFloat(formatUnits(raw, decimals)) };
        });
        setTokens(rows);
        setError(null);
      } catch (e) {
        if (alive) setError(String(e.message || e));
      }
    };

    const loadBnbPrice = async () => {
      try {
        const r = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${WBNB}`);
        const j = await r.json();
        const pairs = (j.pairs || []).filter(p => p.priceUsd);
        pairs.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0));
        if (alive && pairs[0]) setBnbPrice(parseFloat(pairs[0].priceUsd));
      } catch { /* keep last price */ }
    };

    loadBalances(); loadBnbPrice();
    const a = setInterval(loadBalances, 30_000);
    const b = setInterval(loadBnbPrice, 60_000);
    return () => { alive = false; clearInterval(a); clearInterval(b); };
  }, [address]);

  return { address, setAddress, bnb, bnbPrice, tokens, error };
}
