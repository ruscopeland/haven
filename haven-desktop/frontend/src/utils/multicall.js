import { Contract, Interface, JsonRpcProvider, formatUnits, isAddress } from 'ethers';

// Multicall3 is deployed at this exact address on nearly every EVM chain.
const MULTICALL3_ADDRESS = '0xcA11bde05977b3631167028862bE2a173976CA11';

export const CHAIN_RPC = {
  bsc:        'https://bsc-dataseed.binance.org/',
  ethereum:   'https://ethereum.publicnode.com',
  base:       'https://base.publicnode.com',
  arbitrum:   'https://arb1.arbitrum.io/rpc',
  polygon:    'https://polygon.llamarpc.com',
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

// Lazy-initialised providers — one per chain, reused across calls.
const _providers = {};
function providerFor(chain) {
  const rpcUrl = CHAIN_RPC[chain] || CHAIN_RPC.bsc;
  if (!_providers[chain]) {
    _providers[chain] = new JsonRpcProvider(rpcUrl);
  }
  return _providers[chain];
}

const MULTICALL3_ABI = [
  {
    inputs: [{
      components: [
        { internalType: 'address', name: 'target',    type: 'address' },
        { internalType: 'bool',    name: 'allowFailure', type: 'bool' },
        { internalType: 'bytes',   name: 'callData',   type: 'bytes' },
      ],
      internalType: 'struct Multicall3.Call3[]',
      name: 'calls',
      type: 'tuple[]',
    }],
    name: 'aggregate3',
    outputs: [{
      components: [
        { internalType: 'bool',  name: 'success',    type: 'bool' },
        { internalType: 'bytes', name: 'returnData', type: 'bytes' },
      ],
      internalType: 'struct Multicall3.Result[]',
      name: 'returnData',
      type: 'tuple[]',
    }],
    stateMutability: 'view',
    type: 'function',
  },
];

const erc20Iface = new Interface([
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
]);

function keepValid(contracts) {
  return contracts.filter(isAddress);
}

// Batch balanceOf(owner). Returns Map<lowercaseAddress, bigint>.
export async function multicallBalanceOf(owner, contracts, chain = 'bsc') {
  const out = new Map();
  const valid = keepValid(contracts);
  if (valid.length === 0) return out;

  const provider = providerFor(chain);
  const multicall = new Contract(MULTICALL3_ADDRESS, MULTICALL3_ABI, provider);

  const CHUNK = 400;
  for (let i = 0; i < valid.length; i += CHUNK) {
    const slice = valid.slice(i, i + CHUNK);
    const calls = slice.map(addr => ({
      target: addr, allowFailure: true,
      callData: erc20Iface.encodeFunctionData('balanceOf', [owner]),
    }));
    
    let success = false;
    let lastErr = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const results = await multicall.aggregate3(calls);
        results.forEach((r, j) => {
          if (!r.success || !r.returnData || r.returnData === '0x') return;
          try {
            const [bal] = erc20Iface.decodeFunctionResult('balanceOf', r.returnData);
            out.set(slice[j].toLowerCase(), bal);
          } catch { /* skip decode errors */ }
        });
        success = true;
        break;
      } catch (e) {
        lastErr = e;
        await new Promise(r => setTimeout(r, 1000 * (attempt + 1))); // backoff
      }
    }
    if (!success) {
      throw new Error(`multicallBalanceOf ${chain} chunk ${i} failed after 3 attempts: ${lastErr?.message}`);
    }
  }
  return out;
}

// Batch decimals(). Returns Map<lowercaseAddress, number>.
export async function multicallDecimals(contracts, chain = 'bsc') {
  const out = new Map();
  const valid = keepValid(contracts);
  if (valid.length === 0) return out;

  const provider = providerFor(chain);
  const multicall = new Contract(MULTICALL3_ADDRESS, MULTICALL3_ABI, provider);

  const CHUNK = 400;
  for (let i = 0; i < valid.length; i += CHUNK) {
    const slice = valid.slice(i, i + CHUNK);
    const calls = slice.map(addr => ({
      target: addr, allowFailure: true,
      callData: erc20Iface.encodeFunctionData('decimals', []),
    }));
    try {
      const results = await multicall.aggregate3(calls);
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
    } catch (e) {
      console.warn(`multicallDecimals ${chain} chunk ${i}:`, e.message);
      // Default to 18 for failed chunks
      slice.forEach(addr => { if (!out.has(addr.toLowerCase())) out.set(addr.toLowerCase(), 18); });
    }
  }
  return out;
}

// Native coin balance (BNB, ETH, POL, AVAX).
export async function getNativeBalance(address, chain = 'bsc') {
  const provider = providerFor(chain);
  return provider.getBalance(address);
}
