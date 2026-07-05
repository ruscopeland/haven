import { useState, useEffect, useRef, useCallback } from 'react';

// Key-free wallet data (see docs/C1-wallet-hook.md). Reads balances with raw
// JSON-RPC calls to a public BSC node — the private key never enters this app.

const API_URL = 'http://localhost:8000';
const BSC_RPC = 'https://bsc-dataseed.binance.org/';
const WBNB = '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c';
const ADDR_KEY = 'alpha_wallet_address';
const MAX_TOKENS = 20;

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

const pad64 = (addr) => addr.toLowerCase().replace(/^0x/, '').padStart(64, '0');

async function erc20Call(contract, data) {
  return rpc('eth_call', [{ to: contract, data }, 'latest']);
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
  const decimalsCache = useRef({});

  const setAddress = useCallback((a) => {
    const trimmed = (a || '').trim();
    localStorage.setItem(ADDR_KEY, trimmed);
    setAddressState(trimmed);
    setBnb(null); setTokens([]);
  }, []);

  useEffect(() => {
    if (!/^0x[0-9a-fA-F]{40}$/.test(address)) return undefined;
    let alive = true;

    const loadBalances = async () => {
      try {
        // BNB balance
        const balHex = await rpc('eth_getBalance', [address, 'latest']);
        if (!alive) return;
        setBnb(parseInt(balHex, 16) / 1e18);

        // Token set = symbols this wallet actually traded (FILLED rows only)
        const [tradesRes, tokensRes] = await Promise.all([
          fetch(`${API_URL}/trades?status=FILLED&limit=200`),
          fetch(`${API_URL}/tokens?limit=500`),
        ]);
        if (!tradesRes.ok || !tokensRes.ok) throw new Error('API unavailable');
        const trades = await tradesRes.json();
        const tokenList = await tokensRes.json();
        const bySymbol = Object.fromEntries(tokenList.map(t => [t.symbol, t]));
        const symbols = [...new Set(trades.map(t => t.symbol))]
          .filter(s => bySymbol[s]?.contract_address).slice(0, MAX_TOKENS);

        const rows = [];
        for (const sym of symbols) {
          const contract = bySymbol[sym].contract_address;
          try {
            if (decimalsCache.current[contract] == null) {
              const d = await erc20Call(contract, '0x313ce567'); // decimals()
              decimalsCache.current[contract] = parseInt(d, 16) || 18;
            }
            const raw = await erc20Call(contract, '0x70a08231' + pad64(address)); // balanceOf(address)
            const qty = parseInt(raw, 16) / 10 ** decimalsCache.current[contract];
            if (qty > 0) rows.push({ symbol: sym, name: bySymbol[sym].name, qty });
          } catch { /* skip token on RPC hiccup; next poll retries */ }
        }
        if (!alive) return;
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
