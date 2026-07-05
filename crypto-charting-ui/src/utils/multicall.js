import { Interface, isAddress } from 'ethers';

// Multicall3 is deployed at this exact address on nearly every EVM chain,
// including BSC — same contract the old wallet app used (blockchain.js
// scanTokenBalances). Batches many read calls into ONE on-chain call/RPC
// round trip instead of one eth_call per token. Read-only: no signing, no
// private key, no Provider/Wallet — just ABI encode/decode + raw eth_call
// (matches the rest of this app's key-free RPC style).
const MULTICALL3_ADDRESS = '0xcA11bde05977b3631167028862bE2a173976CA11';
const BSC_RPC = 'https://bsc-dataseed.binance.org/';

const multicallIface = new Interface([
  'function aggregate3(tuple(address target, bool allowFailure, bytes callData)[] calls) returns (tuple(bool success, bytes returnData)[] returnData)',
]);
const erc20Iface = new Interface([
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
]);

async function ethCall(to, data) {
  const r = await fetch(BSC_RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to, data }, 'latest'] }),
  });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message);
  return j.result;
}

async function aggregate3(calls) {
  const data = multicallIface.encodeFunctionData('aggregate3', [calls]);
  const resultHex = await ethCall(MULTICALL3_ADDRESS, data);
  const [results] = multicallIface.decodeFunctionResult('aggregate3', resultHex);
  return results; // [{success, returnData}, ...] in call order
}

// Binance Alpha lists tokens on non-EVM chains too (e.g. Sui/Move-style
// addresses like "0x9c7…::xmn::XMN" — a 32-byte object id, not a truncated
// BSC address; stripping the "::…" suffix would NOT turn it into a valid
// 20-byte address). ethers throws if asked to ABI-encode a non-address as an
// `address` field, which would otherwise take down the entire batched call —
// so every call site here re-validates with the same guard `isAddress` uses,
// regardless of what the caller already filtered.
function keepValid(contracts) {
  return contracts.filter(isAddress);
}

// Batch balanceOf(owner) across every contract in `contracts` in one call.
// Returns Map<lowercaseAddress, bigint> — only entries that decoded
// successfully (allowFailure=true silently skips reverts/non-contracts, the
// same tolerance the old wallet's Multicall3 scan used).
export async function multicallBalanceOf(owner, contracts) {
  const out = new Map();
  const valid = keepValid(contracts);
  if (valid.length === 0) return out;
  const calls = valid.map(addr => ({
    target: addr, allowFailure: true,
    callData: erc20Iface.encodeFunctionData('balanceOf', [owner]),
  }));
  const results = await aggregate3(calls);
  results.forEach((r, i) => {
    if (!r.success || !r.returnData || r.returnData === '0x') return;
    try {
      const [bal] = erc20Iface.decodeFunctionResult('balanceOf', r.returnData);
      out.set(valid[i].toLowerCase(), bal);
    } catch { /* non-standard token return shape; skip */ }
  });
  return out;
}

// Batch decimals() across every contract in `contracts`. Defaults to 18 on
// any per-token failure (same fallback the rest of the app already uses).
export async function multicallDecimals(contracts) {
  const out = new Map();
  const valid = keepValid(contracts);
  if (valid.length === 0) return out;
  const calls = valid.map(addr => ({
    target: addr, allowFailure: true, callData: erc20Iface.encodeFunctionData('decimals', []),
  }));
  const results = await aggregate3(calls);
  results.forEach((r, i) => {
    const addr = valid[i].toLowerCase();
    if (!r.success || !r.returnData || r.returnData === '0x') { out.set(addr, 18); return; }
    try {
      const [d] = erc20Iface.decodeFunctionResult('decimals', r.returnData);
      out.set(addr, Number(d));
    } catch { out.set(addr, 18); }
  });
  return out;
}
