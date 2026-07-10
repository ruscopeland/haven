// On-chain helpers for the marker engine: provider/wallet, ERC-20 utilities,
// OpenOcean v4 quotes (rate-limited), tx sending, and real-fill parsing.
import { ethers } from 'ethers';

export const WBNB = '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c';
const USDT = '0x55d398326f99059ff775485246999027b3197955';
const PANCAKE_ROUTER = '0x10ed43c718714eb63d5aa57b78b54704e256024e';
const OO_NATIVE = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';

const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function allowance(address,address) view returns (uint256)',
  'function approve(address,uint256) returns (bool)',
];

export function makeProvider(rpcUrl) {
  return new ethers.JsonRpcProvider(rpcUrl);
}

export function makeWallet(privateKey, provider) {
  let key = privateKey.trim();
  if (!key.startsWith('0x') && key.length === 64) key = '0x' + key;
  return new ethers.Wallet(key, provider);
}

const decimalsCache = new Map();
export async function getDecimals(tokenAddress, provider) {
  const key = tokenAddress.toLowerCase();
  if (decimalsCache.has(key)) return decimalsCache.get(key);
  const c = new ethers.Contract(tokenAddress, ERC20_ABI, provider);
  const d = Number(await c.decimals());
  decimalsCache.set(key, d);
  return d;
}

export async function getTokenBalance(tokenAddress, owner, provider) {
  const c = new ethers.Contract(tokenAddress, ERC20_ABI, provider);
  const decimals = await getDecimals(tokenAddress, provider);
  const raw = await c.balanceOf(owner);
  return { raw, decimals, formatted: parseFloat(ethers.formatUnits(raw, decimals)) };
}

// Approve `spender` only for this trade's amount — NEVER MaxUint256.
// Infinite approvals are how airdrop/phishing routers drain wallets if the
// spender is malicious or the token is a scam that tricks users into selling.
// exactAmount=true (default): approve amountRaw only.
export async function ensureAllowance(tokenAddress, spender, amountRaw, wallet, {
  exactAmount = true,
} = {}) {
  const c = new ethers.Contract(tokenAddress, ERC20_ABI, wallet);
  const current = await c.allowance(wallet.address, spender);
  if (current >= amountRaw) return false;
  const approveAmount = exactAmount ? amountRaw : ethers.MaxUint256;
  // Some tokens (USDT-style) require resetting non-zero allowance to 0 first.
  if (current > 0n && exactAmount) {
    try {
      const reset = await c.approve(spender, 0n);
      await reset.wait();
    } catch { /* best-effort; continue to exact approve */ }
  }
  const tx = await c.approve(spender, approveAmount);
  await tx.wait();
  return true;
}

// ── OpenOcean v4 swap quote (returns pre-built tx data) ────────────────────
// OpenOcean enforces ~1 req/sec per IP; space requests and retry one 429.
let ooLastRequest = 0;
export async function getOpenOceanSwap(fromToken, toToken, amountDecimal, slippagePct, account, gasPriceGwei) {
  const from = fromToken === ethers.ZeroAddress ? OO_NATIVE : fromToken;
  const to = toToken === ethers.ZeroAddress ? OO_NATIVE : toToken;
  const url = `https://open-api.openocean.finance/v4/bsc/swap` +
    `?inTokenAddress=${from}&outTokenAddress=${to}&amount=${amountDecimal}` +
    `&gasPrice=${gasPriceGwei}&slippage=${slippagePct}&account=${account}`;

  const wait = ooLastRequest + 1600 - Date.now();
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  ooLastRequest = Date.now();

  let res = await fetch(url);
  if (res.status === 429) {
    await new Promise(r => setTimeout(r, 2500));
    ooLastRequest = Date.now();
    res = await fetch(url);
  }
  if (!res.ok) throw new Error(`OpenOcean HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const body = await res.json();
  if (!body || !body.data || !body.data.to || !body.data.data) {
    throw new Error(`OpenOcean returned no swap data (code ${body?.code})`);
  }
  return body.data; // { to, data, value, estimatedGas/gas, outAmount, outToken, inAmount, ... }
}

export async function sendBuiltTx(txData, gasPriceGwei, wallet) {
  const gasVal = txData.gas || txData.estimatedGas;
  const tx = await wallet.sendTransaction({
    to: txData.to,
    data: txData.data,
    value: txData.value ? BigInt(txData.value) : 0n,
    gasLimit: gasVal ? (BigInt(gasVal) * 12n) / 10n : undefined, // +20% buffer
    gasPrice: gasPriceGwei ? ethers.parseUnits(String(gasPriceGwei), 'gwei') : undefined,
  });
  return tx;
}

// ── Real fill parsing ───────────────────────────────────────────────────────
// Reads what actually happened from the receipt instead of trusting the quote:
//  - token leg from ERC-20 Transfer logs to/from the wallet
//  - BNB leg (sells) from the wallet's balance delta across the block, net of gas
//  - the block's real timestamp (ms)
const TRANSFER_TOPIC = ethers.id('Transfer(address,address,uint256)');

export async function parseSwapFill(receipt, tokenAddress, tokenDecimals, walletAddress, isBuy, provider) {
  const fill = { tokenAmount: 0, bnbAmount: 0, blockTimestampMs: 0 };

  try {
    const block = await provider.getBlock(receipt.blockNumber);
    if (block) fill.blockTimestampMs = Number(block.timestamp) * 1000;
  } catch { /* keep 0; caller falls back to Date.now() */ }

  try {
    const walletTopic = ethers.zeroPadValue(walletAddress, 32).toLowerCase();
    const tokenLower = tokenAddress.toLowerCase();
    let total = 0n;
    for (const lg of receipt.logs || []) {
      if (lg.address.toLowerCase() !== tokenLower) continue;
      if (!lg.topics || lg.topics[0] !== TRANSFER_TOPIC) continue;
      const from = (lg.topics[1] || '').toLowerCase();
      const to = (lg.topics[2] || '').toLowerCase();
      if (isBuy ? to === walletTopic : from === walletTopic) total += BigInt(lg.data);
    }
    fill.tokenAmount = parseFloat(ethers.formatUnits(total, tokenDecimals));
  } catch { /* fall back to quote-based amount */ }

  if (!isBuy) {
    try {
      const [before, after] = await Promise.all([
        provider.getBalance(walletAddress, receipt.blockNumber - 1),
        provider.getBalance(walletAddress, receipt.blockNumber),
      ]);
      const gasCost = BigInt(receipt.gasUsed) * BigInt(receipt.gasPrice ?? receipt.effectiveGasPrice ?? 0n);
      fill.bnbAmount = parseFloat(ethers.formatEther(after - before + gasCost));
    } catch { /* fall back to quote-based amount */ }
  }

  return fill;
}

// ── BNB/USD price (60s cache) — DATA-ROADMAP AD-D7 ─────────────────────────
// Primary: OUR collector's WBNB_bsc price, passed in by the engine from the
// /dashboard/overview it already polls (one price source with the rest of the
// stack; the engine only passes it when it is FRESH per the stale-price
// guard). Fallback: the PancakeSwap router on-chain. No third-party feeds.
let bnbCache = { price: 0, ts: 0 };
export async function getBnbPriceUsd(provider, apiPriceUsd = 0) {
  if (apiPriceUsd > 0) {
    bnbCache = { price: apiPriceUsd, ts: Date.now() };
    return apiPriceUsd;
  }
  if (bnbCache.price > 0 && Date.now() - bnbCache.ts < 60_000) return bnbCache.price;

  try {
    const router = new ethers.Contract(PANCAKE_ROUTER,
      ['function getAmountsOut(uint,address[]) view returns (uint[])'], provider);
    const amounts = await router.getAmountsOut(ethers.parseEther('1'), [WBNB, USDT]);
    const price = parseFloat(ethers.formatUnits(amounts[1], 18));
    if (price > 0) {
      bnbCache = { price, ts: Date.now() };
      return price;
    }
  } catch { /* give up */ }

  return 0; // callers must abort sized trades when this is 0
}
