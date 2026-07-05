import { ethers } from 'ethers';
import { log } from './logger.js';

// Default public BSC RPC urls
export const DEFAULT_RPC_URLS = [
  'https://bsc-dataseed.binance.org',
  'https://bsc-dataseed1.defibit.io',
  'https://bsc-dataseed1.ninicoin.io',
  'https://binance.llamarpc.com'
];

export const WBNB_ADDRESS = '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c';
export const PANCAKE_ROUTER_ADDRESS = '0x10ed43c718714eb63d5aa57b78b54704e256024e';
// OpenOcean v4 BSC swap contract — the spender that must be approved before a
// token can be swapped through the app's OpenOcean path (verified via the v4 API).
export const OPENOCEAN_SPENDER = '0x6352a56caadC4F1E25CD6c75970Fa768A3304e64';

const ERC20_ABI = [
  'function balanceOf(address owner) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function name() view returns (string)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 value) returns (bool)',
];

const PANCAKE_ROUTER_ABI = [
  'function getAmountsOut(uint amountIn, address[] memory path) view returns (uint[] memory amounts)',
];

// Helper to get a provider
export function getProvider(rpcUrl) {
  const url = rpcUrl || DEFAULT_RPC_URLS[0];
  log(`Initializing RPC Provider connected to: ${url}`, 'info');
  return new ethers.JsonRpcProvider(url);
}

// Get wallet from phrase or private key
export function getWallet(input, provider) {
  if (!input) return null;
  const cleanInput = input.trim();
  
  // Check if it's a seed phrase (usually contains spaces)
  if (cleanInput.split(/\s+/).length >= 12) {
    try {
      log('Importing wallet via mnemonic seed phrase...', 'info');
      const mnemonic = ethers.Mnemonic.fromPhrase(cleanInput);
      const walletInstance = ethers.HDNodeWallet.fromMnemonic(mnemonic, `m/44'/60'/0'/0/0`).connect(provider);
      log(`Wallet imported successfully. Address: ${walletInstance.address}`, 'success');
      return walletInstance;
    } catch (e) {
      log('Failed to import wallet: Invalid seed phrase format', 'error');
      throw new Error('Invalid seed phrase format. Please check the words.');
    }
  } else {
    // Treat as private key
    try {
      log('Importing wallet via private key...', 'info');
      let key = cleanInput;
      if (!key.startsWith('0x') && key.length === 64) {
        key = '0x' + key;
      }
      const walletInstance = new ethers.Wallet(key, provider);
      log(`Wallet imported successfully. Address: ${walletInstance.address}`, 'success');
      return walletInstance;
    } catch (e) {
      log('Failed to import wallet: Invalid private key format', 'error');
      throw new Error('Invalid private key format.');
    }
  }
}

// Get BNB balance
export async function getBnbBalance(address, provider) {
  const balance = await provider.getBalance(address);
  return ethers.formatEther(balance);
}

// Get Token metadata & balance
export async function getTokenData(tokenAddress, walletAddress, provider) {
  if (!ethers.isAddress(tokenAddress)) {
    throw new Error('Invalid contract address');
  }

  log(`Fetching contract metadata for token: ${tokenAddress}`, 'info');
  const contract = new ethers.Contract(tokenAddress, ERC20_ABI, provider);

  try {
    const [rawDecimals, symbol, name] = await Promise.all([
      contract.decimals(),
      contract.symbol(),
      contract.name()
    ]);
    const decimals = Number(rawDecimals);

    let balance = '0';
    if (walletAddress) {
      const rawBalance = await contract.balanceOf(walletAddress);
      balance = ethers.formatUnits(rawBalance, decimals);
    }

    log(`Metadata fetched: ${symbol} (${name}), Decimals: ${decimals}, Balance: ${balance}`, 'success');
    return {
      address: tokenAddress,
      decimals,
      symbol,
      name,
      balance
    };
  } catch (error) {
    log(`Failed to fetch token metadata: ${error.message}`, 'error');
    console.error('Error fetching token data:', error);
    throw new Error(`Failed to fetch metadata: ${error.message || String(error)}`);
  }
}

// Check if token allowance is enough
export async function checkAllowance(tokenAddress, ownerAddress, spenderAddress, amount, decimals, provider) {
  if (tokenAddress === ethers.ZeroAddress || tokenAddress.toLowerCase() === WBNB_ADDRESS.toLowerCase()) {
    return true; // BNB doesn't need approval
  }
  const contract = new ethers.Contract(tokenAddress, ERC20_ABI, provider);
  const rawAllowance = await contract.allowance(ownerAddress, spenderAddress);
  const rawAmount = ethers.parseUnits(amount, decimals);
  return rawAllowance >= rawAmount;
}

// Approve token spending (Max Uint256 to prevent repetitive approvals)
export async function approveToken(tokenAddress, spenderAddress, amount, decimals, wallet) {
  log(`Requesting approval for spender ${spenderAddress} to spend token ${tokenAddress} (Infinite Approval)...`, 'info');
  const contract = new ethers.Contract(tokenAddress, ERC20_ABI, wallet);
  const tx = await contract.approve(spenderAddress, ethers.MaxUint256);
  log(`Approval transaction submitted: ${tx.hash}`, 'success');
  return tx;
}

// Fetch PancakeSwap V2 quote
export async function getPancakeQuote(fromAddress, toAddress, amountIn, fromDecimals, toDecimals, provider) {
  log(`Fetching PancakeSwap V2 quote: ${amountIn} (${fromAddress} -> ${toAddress})...`, 'info');
  const router = new ethers.Contract(PANCAKE_ROUTER_ADDRESS, PANCAKE_ROUTER_ABI, provider);
  
  // Format token addresses (BNB -> WBNB)
  const pathFrom = fromAddress === ethers.ZeroAddress ? WBNB_ADDRESS : fromAddress;
  const pathTo = toAddress === ethers.ZeroAddress ? WBNB_ADDRESS : toAddress;
  
  const path = [pathFrom, pathTo];
  const rawAmountIn = ethers.parseUnits(amountIn, fromDecimals);

  try {
    const amounts = await router.getAmountsOut(rawAmountIn, path);
    const amountOut = ethers.formatUnits(amounts[1], toDecimals);
    log(`PancakeSwap V2 quote received: ${amountOut} (Direct)`, 'success');
    return {
      name: 'PancakeSwap V2 (Direct)',
      amountOut,
      path,
      routerAddress: PANCAKE_ROUTER_ADDRESS
    };
  } catch (error) {
    log(`PancakeSwap direct quote failed: ${error.message}. Trying path via WBNB...`, 'warning');
    // If direct route fails, try routing via WBNB if it is not in the path already
    if (pathFrom !== WBNB_ADDRESS && pathTo !== WBNB_ADDRESS) {
      try {
        const indirectPath = [pathFrom, WBNB_ADDRESS, pathTo];
        const amounts = await router.getAmountsOut(rawAmountIn, indirectPath);
        const amountOut = ethers.formatUnits(amounts[2], toDecimals);
        log(`PancakeSwap V2 quote received: ${amountOut} (Via BNB)`, 'success');
        return {
          name: 'PancakeSwap V2 (Via BNB)',
          amountOut,
          path: indirectPath,
          routerAddress: PANCAKE_ROUTER_ADDRESS
        };
      } catch (indirectError) {
        log(`PancakeSwap indirect quote failed: ${indirectError.message}`, 'error');
        throw new Error('No PancakeSwap pool liquidity found for this pair.');
      }
    }
    throw new Error('No PancakeSwap pool liquidity found for this pair.');
  }
}

let openOceanLastRequestTime = 0;
let openOceanQueuePromise = Promise.resolve();

// Fetch OpenOcean V4 swap quote & built tx data
export async function getOpenOceanQuote(fromAddress, toAddress, amountIn, slippage, walletAddress, gasPriceGwei, enabledDexIds) {
  return new Promise((resolve, reject) => {
    openOceanQueuePromise = openOceanQueuePromise.then(async () => {
      const from = fromAddress === ethers.ZeroAddress ? '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE' : fromAddress;
      const to = toAddress === ethers.ZeroAddress ? '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE' : toAddress;
      
      const gasPrice = gasPriceGwei || '3';
      let url = `https://open-api.openocean.finance/v4/bsc/swap?inTokenAddress=${from}&outTokenAddress=${to}&amount=${amountIn}&gasPrice=${gasPrice}&slippage=${slippage}&account=${walletAddress || '0x0000000000000000000000000000000000000000'}`;
      if (enabledDexIds) {
        url += `&enabledDexIds=${enabledDexIds}`;
      }
      
      const now = Date.now();
      const timeSinceLast = now - openOceanLastRequestTime;
      // Delay 1.5 seconds to respect OpenOcean 1 req/sec strict IP limit
      if (timeSinceLast < 1500) {
        await new Promise(r => setTimeout(r, 1500 - timeSinceLast));
      }
      openOceanLastRequestTime = Date.now();
      
      try {
        log(`OpenOcean GET Request: ${url}`, 'info');
        let response = await fetch(url);
        
        if (response.status === 429) {
          log(`OpenOcean Rate Limited (429). Retrying in 2 seconds...`, 'warn');
          await new Promise(r => setTimeout(r, 2000));
          openOceanLastRequestTime = Date.now();
          response = await fetch(url);
        }

        if (!response.ok) {
          const errorMsg = await response.text();
          log(`OpenOcean Response Error (HTTP ${response.status}): ${errorMsg}`, 'error');
          return reject(new Error(`OpenOcean error: ${errorMsg || response.statusText}`));
        }
        const data = await response.json();
        resolve(data);
      } catch (error) {
        log(`OpenOcean quote fetch failed: ${error.message}`, 'error');
        reject(error);
      }
    });
  });
}

// Perform Swap on PancakeSwap V2 Router directly
export async function executePancakeSwap(fromAddress, toAddress, amountIn, amountOutMin, decimalsIn, decimalsOut, slippage, gasPriceGwei, wallet) {
  log(`Executing PancakeSwap V2 direct swap: ${amountIn} (${fromAddress}) -> expected ${amountOutMin} (${toAddress}), slippage: ${slippage}%, gas: ${gasPriceGwei || 'default'} Gwei...`, 'info');
  const router = new ethers.Contract(PANCAKE_ROUTER_ADDRESS, [
    'function swapExactETHForTokens(uint amountOutMin, address[] calldata path, address to, uint deadline) payable returns (uint[] memory amounts)',
    'function swapExactTokensForETH(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline) returns (uint[] memory amounts)',
    'function swapExactTokensForTokens(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline) returns (uint[] memory amounts)'
  ], wallet);

  const pathFrom = fromAddress === ethers.ZeroAddress ? WBNB_ADDRESS : fromAddress;
  const pathTo = toAddress === ethers.ZeroAddress ? WBNB_ADDRESS : toAddress;
  
  let path = [pathFrom, pathTo];
  // Check if we need indirect path
  try {
    const v2Router = new ethers.Contract(PANCAKE_ROUTER_ADDRESS, PANCAKE_ROUTER_ABI, wallet.provider);
    await v2Router.getAmountsOut(ethers.parseUnits(amountIn, decimalsIn), path);
  } catch (e) {
    if (pathFrom !== WBNB_ADDRESS && pathTo !== WBNB_ADDRESS) {
      path = [pathFrom, WBNB_ADDRESS, pathTo];
    }
  }

  const rawAmountIn = ethers.parseUnits(amountIn, decimalsIn);
  
  // Calculate amountOutMin with slippage
  const expectedOutRaw = ethers.parseUnits(amountOutMin, decimalsOut);
  const slippageBps = BigInt(Math.floor(slippage * 100)); // e.g. 0.5% -> 50 bps
  const minOutRaw = expectedOutRaw * (10000n - slippageBps) / 10000n;

  const deadline = Math.floor(Date.now() / 1000) + 1200; // 20 minutes from now
  const recipient = wallet.address;

  const overrides = {};
  if (gasPriceGwei) {
    overrides.gasPrice = ethers.parseUnits(gasPriceGwei.toString(), 'gwei');
  }

  let tx;
  if (fromAddress === ethers.ZeroAddress) {
    // BNB -> Token
    tx = await router.swapExactETHForTokens(
      minOutRaw,
      path,
      recipient,
      deadline,
      { value: rawAmountIn, ...overrides }
    );
  } else if (toAddress === ethers.ZeroAddress) {
    // Token -> BNB
    tx = await router.swapExactTokensForETH(
      rawAmountIn,
      minOutRaw,
      path,
      recipient,
      deadline,
      overrides
    );
  } else {
    // Token -> Token
    tx = await router.swapExactTokensForTokens(
      rawAmountIn,
      minOutRaw,
      path,
      recipient,
      deadline,
      overrides
    );
  }

  log(`PancakeSwap V2 direct swap transaction submitted: ${tx.hash}`, 'success');
  return tx;
}

// Perform swap using custom built TX data (e.g. from OpenOcean Swap API)
export async function executeBuiltSwap(txData, gasPriceGwei, wallet) {
  // Back-compat: support both executeBuiltSwap(txData, wallet) and
  // executeBuiltSwap(txData, gasPriceGwei, wallet). If the 2nd arg is a signer,
  // treat it as the wallet and apply no explicit gas-price override.
  if (gasPriceGwei && typeof gasPriceGwei.sendTransaction === 'function') {
    wallet = gasPriceGwei;
    gasPriceGwei = undefined;
  }

  log(`Executing OpenOcean routed swap transaction...`, 'info');
  const gasVal = txData.gas || txData.estimatedGas;
  
  const overrides = {
    to: txData.to,
    data: txData.data,
    value: txData.value ? BigInt(txData.value) : 0n,
    gasLimit: gasVal ? (BigInt(gasVal) * 12n) / 10n : undefined, // add 20% gas buffer
  };

  if (gasPriceGwei) {
    overrides.gasPrice = ethers.parseUnits(gasPriceGwei.toString(), 'gwei');
  }

  const tx = await wallet.sendTransaction(overrides);
  log(`OpenOcean routed swap transaction submitted: ${tx.hash}`, 'success');
  return tx;
}

// Fetch and cache the PancakeSwap Extended Token List
export async function getPancakeSwapTokens() {
  const CACHE_KEY = 'crypto_wallet_pancake_tokens_cache';
  const CACHE_TIME_KEY = 'crypto_wallet_pancake_tokens_cache_time';
  const ONE_DAY = 24 * 60 * 60 * 1000; // 24 hours in ms

  const cached = localStorage.getItem(CACHE_KEY);
  const cachedTime = localStorage.getItem(CACHE_TIME_KEY);
  const now = Date.now();

  if (cached && cachedTime && (now - parseInt(cachedTime)) < ONE_DAY) {
    try {
      const tokens = JSON.parse(cached);
      log(`PancakeSwap extended token list loaded from local cache (${tokens.length} tokens).`, 'info');
      return tokens;
    } catch (e) {
      console.warn('Failed to parse cached pancake tokens:', e);
    }
  }

  try {
    log('Fetching PancakeSwap Extended token list from remote source...', 'info');
    const res = await fetch('https://tokens.pancakeswap.finance/pancakeswap-extended.json');
    if (!res.ok) throw new Error('Failed to fetch PancakeSwap tokens');
    const data = await res.json();
    const tokens = data.tokens.filter(t => t.chainId === 56);
    
    localStorage.setItem(CACHE_KEY, JSON.stringify(tokens));
    localStorage.setItem(CACHE_TIME_KEY, now.toString());
    log(`Successfully downloaded and cached ${tokens.length} PancakeSwap tokens.`, 'success');
    return tokens;
  } catch (e) {
    console.error('Error fetching PancakeSwap tokens:', e);
    // Return cached even if expired, as fallback
    if (cached) {
      try {
        return JSON.parse(cached);
      } catch (err) {}
    }
    return [];
  }
}

// Scan balances for a list of tokens using Multicall3
export async function scanTokenBalances(walletAddress, tokensList, provider) {
  const MULTICALL3_ADDRESS = '0xcA11bde05977b3631167028862bE2a173976CA11';
  const MULTICALL3_ABI = [
    {
      "inputs": [
        {
          "components": [
            {"internalType": "address", "name": "target", "type": "address"},
            {"internalType": "bool", "name": "allowFailure", "type": "bool"},
            {"internalType": "bytes", "name": "callData", "type": "bytes"}
          ],
          "internalType": "struct Multicall3.Call3[]",
          "name": "calls",
          "type": "tuple[]"
        }
      ],
      "name": "aggregate3",
      "outputs": [
        {
          "components": [
            {"internalType": "bool", "name": "success", "type": "bool"},
            {"internalType": "bytes", "name": "returnData", "type": "bytes"}
          ],
          "internalType": "struct Multicall3.Result[]",
          "name": "returnData",
          "type": "tuple[]"
        }
      ],
      "stateMutability": "view",
      "type": "function"
    }
  ];

  const contract = new ethers.Contract(MULTICALL3_ADDRESS, MULTICALL3_ABI, provider);
  const erc20Interface = new ethers.Interface([
    'function balanceOf(address owner) view returns (uint256)'
  ]);

  // Filter out invalid or zero addresses
  const validTokens = tokensList.filter(t => 
    t.address && 
    ethers.isAddress(t.address) && 
    t.address !== ethers.ZeroAddress &&
    t.address.toLowerCase() !== WBNB_ADDRESS.toLowerCase()
  );

  if (validTokens.length === 0) return [];

  const calls = validTokens.map(token => {
    const callData = erc20Interface.encodeFunctionData('balanceOf', [walletAddress]);
    return {
      target: token.address,
      allowFailure: true,
      callData
    };
  });

  try {
    log(`Executing Multicall3 batch query for ${calls.length} token balances...`, 'info');
    const results = await contract.aggregate3(calls);
    const discovered = [];

    results.forEach((result, index) => {
      if (result.success && result.returnData !== '0x') {
        try {
          const [balance] = erc20Interface.decodeFunctionResult('balanceOf', result.returnData);
          if (balance > 0n) {
            const token = validTokens[index];
            const formatted = ethers.formatUnits(balance, token.decimals);
            discovered.push({
              address: token.address.toLowerCase(),
              symbol: token.symbol,
              name: token.name,
              decimals: token.decimals,
              balance: formatted
            });
            log(`Discovered active holding: ${token.symbol} (Balance: ${parseFloat(formatted).toFixed(4)})`, 'success');
          }
        } catch (e) {
          // ignore decode errors
        }
      }
    });

    log(`Multicall3 balance scan complete. Found ${discovered.length} positive-balance holdings.`, 'success');
    return discovered;
  } catch (error) {
    log(`Multicall3 balance scan failed: ${error.message}`, 'error');
    console.error('Multicall token balance scan failed:', error);
    return [];
  }
}

