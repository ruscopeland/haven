import { Interface, isAddress } from 'ethers';

// Multicall3 is deployed at this exact address on nearly every EVM chain
// (BSC, Ethereum, Base). Read-only: no signing, no private key.
const MULTICALL3_ADDRESS = '0xcA11bde05977b3631167028862bE2a173976CA11';

export const CHAIN_RPC = {
  bsc:        'https://bsc-dataseed.binance.org/',
  ethereum:   'https://ethereum.publicnode.com',
  base:       'https://base.publicnode.com',
  arbitrum:   'https://arb1.arbitrum.io/rpc',
  polygon:    'https://polygon-rpc.com',
  optimism:   'https://mainnet.optimism.io',
  avalanche:  'https://api.avax.network/ext/bc/C/rpc',
};

export const CHAIN_NATIVE = {
  bsc:        { symbol: 'BNB',  name: 'BNB',                 decimals: 18 },
  ethereum:   { symbol: 'ETH',  name: 'Ether',               decimals: 18 },
  base:       { symbol: 'ETH',  name: 'Ether (Base)',         decimals: 18 },
  arbitrum:   { symbol: 'ETH',  name: 'Ether (Arbitrum)',     decimals: 18 },
  polygon:    { symbol: 'POL',  name: 'POL (Polygon)',         decimals: 18 },
  optimism:   { symbol: 'ETH',  name: 'Ether (Optimism)',     decimals: 18 },
  avalanche:  { symbol: 'AVAX', name: 'Avalanche',            decimals: 18 },
};

const multicallIface = new Interface([
  'function aggregate3(tuple(address target, bool allowFailure, bytes callData)[] calls) returns (tuple(bool success, bytes returnData)[] returnData)',
]);
const erc20Iface = new Interface([
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
]);

async function ethCall(rpcUrl, to, data) {
  const r = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to, data }, 'latest'] }),
  });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message);
  return j.result;
}

async function ethGetBalance(rpcUrl, address) {
  const r = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getBalance', params: [address, 'latest'] }),
  });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message);
  return BigInt(j.result);
}

async function aggregate3(rpcUrl, calls) {
  const data = multicallIface.encodeFunctionData('aggregate3', [calls]);
  const resultHex = await ethCall(rpcUrl, MULTICALL3_ADDRESS, data);
  const [results] = multicallIface.decodeFunctionResult('aggregate3', resultHex);
  return results;
}

function keepValid(contracts) {
  return contracts.filter(isAddress);
}

// Batch balanceOf(owner). Returns Map<lowercaseAddress, bigint>.
export async function multicallBalanceOf(owner, contracts, chain = 'bsc') {
  const out = new Map();
  const rpcUrl = CHAIN_RPC[chain] || CHAIN_RPC.bsc;
  const valid = keepValid(contracts);
  if (valid.length === 0) return out;
  // Chunk large universes to avoid RPC payload limits.
  const CHUNK = 400;
  for (let i = 0; i < valid.length; i += CHUNK) {
    const slice = valid.slice(i, i + CHUNK);
    const calls = slice.map(addr => ({
      target: addr, allowFailure: true,
      callData: erc20Iface.encodeFunctionData('balanceOf', [owner]),
    }));
    const results = await aggregate3(rpcUrl, calls);
    results.forEach((r, j) => {
      if (!r.success || !r.returnData || r.returnData === '0x') return;
      try {
        const [bal] = erc20Iface.decodeFunctionResult('balanceOf', r.returnData);
        out.set(slice[j].toLowerCase(), bal);
      } catch { /* skip */ }
    });
  }
  return out;
}

export async function multicallDecimals(contracts, chain = 'bsc') {
  const out = new Map();
  const rpcUrl = CHAIN_RPC[chain] || CHAIN_RPC.bsc;
  const valid = keepValid(contracts);
  if (valid.length === 0) return out;
  const CHUNK = 400;
  for (let i = 0; i < valid.length; i += CHUNK) {
    const slice = valid.slice(i, i + CHUNK);
    const calls = slice.map(addr => ({
      target: addr, allowFailure: true, callData: erc20Iface.encodeFunctionData('decimals', []),
    }));
    const results = await aggregate3(rpcUrl, calls);
    results.forEach((r, j) => {
      if (!r.success || !r.returnData || r.returnData === '0x') {
        out.set(slice[j].toLowerCase(), 18);
        return;
      }
      try {
        const [d] = erc20Iface.decodeFunctionResult('decimals', r.returnData);
        out.set(slice[j].toLowerCase(), Number(d));
      } catch {
        out.set(slice[j].toLowerCase(), 18);
      }
    });
  }
  return out;
}

export async function getNativeBalance(address, chain = 'bsc') {
  const rpcUrl = CHAIN_RPC[chain] || CHAIN_RPC.bsc;
  return ethGetBalance(rpcUrl, address);
}
