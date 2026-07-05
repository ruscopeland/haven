import { ethers } from 'ethers';
import { WBNB_ADDRESS } from './blockchain.js';
import { log } from './logger.js';

// Local storage cache keys
const BNB_PRICE_CACHE_KEY = 'crypto_wallet_bnb_price_cache';
const TOKEN_PRICE_CACHE_KEY = 'crypto_wallet_token_price_cache';

// Helper to get historical prices from DefiLlama Coins API
export async function getHistoricalPrice(tokenAddress, timestamp) {
  const isBnb = tokenAddress === ethers.ZeroAddress || tokenAddress.toLowerCase() === WBNB_ADDRESS.toLowerCase();
  const address = isBnb ? WBNB_ADDRESS : tokenAddress;
  
  // Format token address for DefiLlama
  const coinId = `bsc:${address}`;
  
  // Try to load from cache first
  const cacheKey = `${coinId}_${Math.floor(timestamp / 3600) * 3600}`; // cache hourly
  const cached = localStorage.getItem(cacheKey);
  if (cached) {
    return parseFloat(cached);
  }

  const url = `https://coins.llama.fi/prices/historical/${timestamp}/${coinId}`;
  try {
    log(`DefiLlama GET Request: ${url}`, 'info');
    const res = await fetch(url);
    if (!res.ok) {
      log(`DefiLlama GET Response Error (HTTP ${res.status}): ${res.statusText}`, 'warning');
      return 0;
    }
    const data = await res.json();
    log(`DefiLlama GET Response: ${JSON.stringify(data).substring(0, 500)}`, 'success');
    const coinData = data ? (data.coins ? data.coins[coinId] : null) : null;
    if (coinData && coinData.price) {
      localStorage.setItem(cacheKey, coinData.price.toString());
      return coinData.price;
    }
  } catch (e) {
    log(`Error fetching historical price from DefiLlama: ${e.message}`, 'warning');
    console.error(`Error fetching historical price for ${coinId}:`, e);
  }
  return 0;
}

// Fetch all transactions from BSC (NodeReal with Etherscan fallback)
export async function fetchBscScanTxData(walletAddress, apiKey, nodeRealApiKey) {
  const address = walletAddress.toLowerCase();
  log(`Querying assets transfer history from NodeReal API for address: ${address.substring(0, 8)}...`, 'info');

  // Use user's NodeReal API key if available, otherwise default to the working developer key
  const activeKey = nodeRealApiKey && nodeRealApiKey.trim() !== '' 
    ? nodeRealApiKey.trim() 
    : '51c445c6f2b841e59a5931ad50e0939d';

  const url = `https://bsc-mainnet.nodereal.io/v1/${activeKey}`;

  const fetchTransfers = async (params) => {
    const body = {
      jsonrpc: '2.0',
      method: 'nr_getAssetTransfers',
      params: [
        {
          order: 'desc',
          maxCount: '0x96', // Fetch up to 150 transfers per category
          ...params
        }
      ],
      id: 1
    };

    try {
      log(`NodeReal POST Request: ${url} - Body: ${JSON.stringify(body)}`, 'info');
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      if (!response.ok) {
        log(`NodeReal Response Error: HTTP ${response.status}`, 'warning');
        return [];
      }
      const data = await response.json();
      if (data.error) {
        log(`NodeReal API Response Error: ${JSON.stringify(data.error)}`, 'warning');
        return [];
      }
      log(`NodeReal POST Response [${JSON.stringify(params)}]: ${JSON.stringify(data).substring(0, 500)}...`, 'success');
      return data.result?.transfers || data.result || [];
    } catch (e) {
      log(`NodeReal connection failed: ${e.message}`, 'warning');
      return [];
    }
  };

  try {
    // Fetch external, 20, and internal transfers both FROM and TO the address in parallel
    log('Fetching transfers for external, internal, and BEP-20 categories in parallel...', 'info');
    const [
      fromExternal,
      from20,
      fromInternal,
      toExternal,
      to20,
      toInternal
    ] = await Promise.all([
      fetchTransfers({ fromAddress: address, category: ['external'] }),
      fetchTransfers({ fromAddress: address, category: ['20'] }),
      fetchTransfers({ fromAddress: address, category: ['internal'] }),
      fetchTransfers({ toAddress: address, category: ['external'] }),
      fetchTransfers({ toAddress: address, category: ['20'] }),
      fetchTransfers({ toAddress: address, category: ['internal'] })
    ]);

    const allExternal = [...fromExternal, ...toExternal];
    const all20 = [...from20, ...to20];
    const allInternal = [...fromInternal, ...toInternal];

    // Deduplicate transfers by unique key to prevent duplicate listing (e.g. self-transfers)
    const deduplicate = (transfers) => {
      const seen = new Set();
      const unique = [];
      transfers.forEach(tx => {
        const key = `${tx.hash}_${tx.category}_${tx.from ? tx.from.toLowerCase() : ''}_${tx.to ? tx.to.toLowerCase() : ''}_${tx.logIndex || tx.traceIndex || 0}_${tx.value}`;
        if (!seen.has(key)) {
          seen.add(key);
          unique.push(tx);
        }
      });
      return unique;
    };

    const uniqueExternal = deduplicate(allExternal);
    const unique20 = deduplicate(all20);
    const uniqueInternal = deduplicate(allInternal);

    const normal = [];
    const bep20 = [];
    const internal = [];

    const processTx = (tx, categoryName) => {
      const timeStamp = tx.blockTimeStamp ? tx.blockTimeStamp.toString() : '0';
      const blockNumber = tx.blockNum ? BigInt(tx.blockNum).toString() : '0';
      
      let valueDecimal = '0';
      if (tx.value) {
        try {
          valueDecimal = BigInt(tx.value).toString();
        } catch (e) {}
      }

      const gasPrice = tx.gasPrice ? tx.gasPrice.toString() : '0';
      const gasUsed = tx.gasUsed ? tx.gasUsed.toString() : '0';
      const gas = tx.gas ? tx.gas.toString() : '0';

      const mappedTx = {
        blockNumber,
        timeStamp,
        hash: tx.hash,
        from: tx.from ? tx.from.toLowerCase() : '',
        to: tx.to ? tx.to.toLowerCase() : '',
        value: valueDecimal,
        gas,
        gasPrice,
        isError: tx.receiptsStatus === 1 ? '0' : '1',
        txreceipt_status: tx.receiptsStatus === 1 ? '1' : '0',
        input: tx.input || '0x',
        contractAddress: tx.contractAddress && tx.contractAddress !== '0x0000000000000000000000000000000000000000' ? tx.contractAddress.toLowerCase() : '',
        cumulativeGasUsed: gasUsed,
        gasUsed,
        confirmations: '1'
      };

      if (categoryName === '20') {
        mappedTx.tokenName = tx.name || '';
        mappedTx.tokenSymbol = tx.asset || '';
        mappedTx.tokenDecimal = tx.decimal ? tx.decimal.toString() : '18';
        bep20.push(mappedTx);
      } else if (categoryName === 'internal') {
        internal.push(mappedTx);
      } else {
        normal.push(mappedTx);
      }
    };

    uniqueExternal.forEach(tx => processTx(tx, 'external'));
    uniqueInternal.forEach(tx => processTx(tx, 'internal'));
    unique20.forEach(tx => processTx(tx, '20'));

    log(`Transfers fetched: ${normal.length} normal, ${bep20.length} BEP-20, ${internal.length} internal.`, 'success');

    return {
      normal,
      bep20,
      internal
    };
  } catch (error) {
    log(`NodeReal API asset transfers query failed: ${error.message}`, 'error');
    console.error('Error fetching NodeReal transactions:', error);
    throw new Error(error.message || 'Failed to load transaction history from NodeReal API.');
  }
}

// Core function to parse and explain transactions
export async function traceTransactions(walletAddress, rawData) {
  log(`Tracing transaction history details for address ${walletAddress.substring(0, 8)}...`, 'info');
  const userAddress = walletAddress.toLowerCase();
  const { normal, bep20, internal } = rawData;

  // Group all BEP-20 token transfers by transaction hash
  const bep20ByHash = {};
  bep20.forEach(tx => {
    if (!bep20ByHash[tx.hash]) {
      bep20ByHash[tx.hash] = [];
    }
    bep20ByHash[tx.hash].push(tx);
  });

  // Group normal transactions by hash for easy gas fee retrieval
  const normalByHash = {};
  normal.forEach(tx => {
    normalByHash[tx.hash] = tx;
  });

  // Group internal transactions by hash (to detect incoming BNB transfers via smart contracts)
  const internalByHash = {};
  internal.forEach(tx => {
    if (!internalByHash[tx.hash]) {
      internalByHash[tx.hash] = [];
    }
    internalByHash[tx.hash].push(tx);
  });

  // Unique list of transaction hashes that contain token transfers or are standard BNB transfers
  const allHashes = new Set([
    ...bep20.map(t => t.hash),
    ...normal.map(t => t.hash)
  ]);

  const tracedTxs = [];
  
  // Sort hashes by timestamp of normal txs first, fallback to bep20 timestamps
  const txMeta = [];
  allHashes.forEach(hash => {
    const normalTx = normalByHash[hash];
    const bep20Txs = bep20ByHash[hash] || [];
    
    let timeStamp = 0;
    let blockNumber = 0;
    
    if (normalTx) {
      timeStamp = parseInt(normalTx.timeStamp);
      blockNumber = parseInt(normalTx.blockNumber);
    } else if (bep20Txs.length > 0) {
      timeStamp = parseInt(bep20Txs[0].timeStamp);
      blockNumber = parseInt(bep20Txs[0].blockNumber);
    }

    txMeta.push({ hash, timeStamp, blockNumber });
  });

  // Sort descending (newest first) to find the most recent 100 transaction hashes
  txMeta.sort((a, b) => b.timeStamp - a.timeStamp || b.blockNumber - a.blockNumber);

  // Slice to most recent 300 transactions to keep it fast
  const slicedTxMeta = txMeta.slice(0, 300);
  log(`Analyzing ${slicedTxMeta.length} most recent unique transactions chronologically...`, 'info');

  // Re-sort chronological (ascending) for cost basis tracking
  slicedTxMeta.sort((a, b) => a.timeStamp - b.timeStamp || a.blockNumber - b.blockNumber);

  // === PRE-FETCH all historical prices in parallel batches ===
  // First pass: collect all unique (address, hourKey) pairs we'll need
  const priceFetchSet = new Map(); // key: `${address}_${hourKey}` -> { address, timestamp }
  
  for (const { hash, timeStamp } of slicedTxMeta) {
    const normalTx = normalByHash[hash];
    const tokenTransfers = bep20ByHash[hash] || [];
    const internalTransfers = internalByHash[hash] || [];
    const hourKey = Math.floor(timeStamp / 3600);
    
    // Always need BNB price for gas fee calculation
    const bnbKey = `${ethers.ZeroAddress}_${hourKey}`;
    if (!priceFetchSet.has(bnbKey)) {
      // Check localStorage cache first
      const coinId = `bsc:${WBNB_ADDRESS}`;
      const cacheKey = `${coinId}_${hourKey * 3600}`;
      const cached = localStorage.getItem(cacheKey);
      if (!cached) {
        priceFetchSet.set(bnbKey, { address: ethers.ZeroAddress, timestamp: timeStamp });
      }
    }
    
    // Determine which token prices we'll need
    const incomingTokens = [];
    const outgoingTokens = [];

    if (normalTx) {
      const bnbVal = ethers.formatEther(normalTx.value);
      if (parseFloat(bnbVal) > 0) {
        if (normalTx.from.toLowerCase() === userAddress) outgoingTokens.push({ address: ethers.ZeroAddress });
        if (normalTx.to.toLowerCase() === userAddress) incomingTokens.push({ address: ethers.ZeroAddress });
      }
    }
    internalTransfers.forEach(itx => {
      const bnbVal = ethers.formatEther(itx.value);
      if (parseFloat(bnbVal) > 0) {
        if (itx.from.toLowerCase() === userAddress) outgoingTokens.push({ address: ethers.ZeroAddress });
        if (itx.to.toLowerCase() === userAddress) incomingTokens.push({ address: ethers.ZeroAddress });
      }
    });
    tokenTransfers.forEach(tx => {
      if (tx.to.toLowerCase() === userAddress) incomingTokens.push({ address: tx.contractAddress.toLowerCase() });
      if (tx.from.toLowerCase() === userAddress) outgoingTokens.push({ address: tx.contractAddress.toLowerCase() });
    });

    // If it's a swap (both in and out), we need prices for both tokens
    if (incomingTokens.length > 0 && outgoingTokens.length > 0) {
      [incomingTokens[0], outgoingTokens[0]].forEach(t => {
        const key = `${t.address}_${hourKey}`;
        if (!priceFetchSet.has(key)) {
          const isBnb = t.address === ethers.ZeroAddress || t.address.toLowerCase() === WBNB_ADDRESS.toLowerCase();
          const addr = isBnb ? WBNB_ADDRESS : t.address;
          const coinId = `bsc:${addr}`;
          const cacheKey = `${coinId}_${hourKey * 3600}`;
          if (!localStorage.getItem(cacheKey)) {
            priceFetchSet.set(key, { address: t.address, timestamp: timeStamp });
          }
        }
      });
    } else if (incomingTokens.length > 0) {
      const t = incomingTokens[0];
      const key = `${t.address}_${hourKey}`;
      if (!priceFetchSet.has(key)) {
        const isBnb = t.address === ethers.ZeroAddress || t.address.toLowerCase() === WBNB_ADDRESS.toLowerCase();
        const addr = isBnb ? WBNB_ADDRESS : t.address;
        const coinId = `bsc:${addr}`;
        const cacheKey = `${coinId}_${hourKey * 3600}`;
        if (!localStorage.getItem(cacheKey)) {
          priceFetchSet.set(key, { address: t.address, timestamp: timeStamp });
        }
      }
    } else if (outgoingTokens.length > 0) {
      const t = outgoingTokens[0];
      const key = `${t.address}_${hourKey}`;
      if (!priceFetchSet.has(key)) {
        const isBnb = t.address === ethers.ZeroAddress || t.address.toLowerCase() === WBNB_ADDRESS.toLowerCase();
        const addr = isBnb ? WBNB_ADDRESS : t.address;
        const coinId = `bsc:${addr}`;
        const cacheKey = `${coinId}_${hourKey * 3600}`;
        if (!localStorage.getItem(cacheKey)) {
          priceFetchSet.set(key, { address: t.address, timestamp: timeStamp });
        }
      }
    }
  }

  // Batch fetch all uncached prices in parallel (groups of 15 to avoid overwhelming the API)
  const priceFetchEntries = [...priceFetchSet.values()];
  const priceCache = {}; // key: `${address}_${hourKey}` -> price
  
  if (priceFetchEntries.length > 0) {
    log(`Pre-fetching ${priceFetchEntries.length} historical prices in parallel batches...`, 'info');
    const BATCH_SIZE = 15;
    for (let i = 0; i < priceFetchEntries.length; i += BATCH_SIZE) {
      const batch = priceFetchEntries.slice(i, i + BATCH_SIZE);
      const results = await Promise.all(
        batch.map(async ({ address: addr, timestamp: ts }) => {
          try {
            const price = await getHistoricalPrice(addr, ts);
            return { address: addr, hourKey: Math.floor(ts / 3600), price };
          } catch (e) {
            return { address: addr, hourKey: Math.floor(ts / 3600), price: 0 };
          }
        })
      );
      results.forEach(r => {
        priceCache[`${r.address}_${r.hourKey}`] = r.price;
      });
    }
    log(`Historical price pre-fetch complete. Cached ${Object.keys(priceCache).length} prices.`, 'success');
  }

  // Fast price lookup that uses pre-fetched cache, then falls back to localStorage cache
  const getCachedPrice = async (tokenAddress, ts) => {
    const hourKey = Math.floor(ts / 3600);
    const key = `${tokenAddress}_${hourKey}`;
    if (priceCache[key] !== undefined) return priceCache[key];
    // Fall back to getHistoricalPrice which checks localStorage
    const price = await getHistoricalPrice(tokenAddress, ts);
    priceCache[key] = price;
    return price;
  };

  const getBnbPriceCached = async (ts) => {
    return getCachedPrice(ethers.ZeroAddress, ts);
  };

  // Trace every transaction in the sliced set
  for (const { hash, timeStamp, blockNumber } of slicedTxMeta) {
    const normalTx = normalByHash[hash];
    const tokenTransfers = bep20ByHash[hash] || [];
    const internalTransfers = internalByHash[hash] || [];

    // Calculate Gas Fee
    let gasFeeBnb = '0';
    let isUserInitiated = false;
    
    if (normalTx) {
      isUserInitiated = normalTx.from.toLowerCase() === userAddress;
      const gasUsed = BigInt(normalTx.gasUsed || 0);
      const gasPrice = BigInt(normalTx.gasPrice || 0);
      gasFeeBnb = ethers.formatEther(gasUsed * gasPrice);
    } else if (tokenTransfers.length > 0) {
      const tx = tokenTransfers[0];
      isUserInitiated = tx.from.toLowerCase() === userAddress;
      const gasUsed = BigInt(tx.gasUsed || 0);
      const gasPrice = BigInt(tx.gasPrice || 0);
      gasFeeBnb = ethers.formatEther(gasUsed * gasPrice);
    }

    const bnbPrice = await getBnbPriceCached(timeStamp);
    const gasFeeUsd = parseFloat(gasFeeBnb) * bnbPrice;

    const incomingTokens = [];
    const outgoingTokens = [];

    if (normalTx) {
      const bnbVal = ethers.formatEther(normalTx.value);
      if (parseFloat(bnbVal) > 0) {
        if (normalTx.from.toLowerCase() === userAddress) {
          outgoingTokens.push({
            address: ethers.ZeroAddress,
            symbol: 'BNB',
            decimals: 18,
            value: bnbVal,
            name: 'Binance Coin'
          });
        }
        if (normalTx.to.toLowerCase() === userAddress) {
          incomingTokens.push({
            address: ethers.ZeroAddress,
            symbol: 'BNB',
            decimals: 18,
            value: bnbVal,
            name: 'Binance Coin'
          });
        }
      }
    }

    internalTransfers.forEach(itx => {
      const bnbVal = ethers.formatEther(itx.value);
      if (parseFloat(bnbVal) > 0) {
        if (itx.from.toLowerCase() === userAddress) {
          outgoingTokens.push({
            address: ethers.ZeroAddress,
            symbol: 'BNB',
            decimals: 18,
            value: bnbVal,
            name: 'Binance Coin'
          });
        }
        if (itx.to.toLowerCase() === userAddress) {
          incomingTokens.push({
            address: ethers.ZeroAddress,
            symbol: 'BNB',
            decimals: 18,
            value: bnbVal,
            name: 'Binance Coin'
          });
        }
      }
    });

    tokenTransfers.forEach(tx => {
      const val = ethers.formatUnits(tx.value, parseInt(tx.tokenDecimal));
      const token = {
        address: tx.contractAddress.toLowerCase(),
        symbol: tx.tokenSymbol,
        decimals: parseInt(tx.tokenDecimal),
        value: val,
        name: tx.tokenName
      };

      if (tx.to.toLowerCase() === userAddress) {
        incomingTokens.push(token);
      }
      if (tx.from.toLowerCase() === userAddress) {
        outgoingTokens.push(token);
      }
    });

    const combineTokens = (tokenList) => {
      const combined = {};
      tokenList.forEach(t => {
        if (!combined[t.address]) {
          combined[t.address] = { ...t, valueNum: parseFloat(t.value) };
        } else {
          combined[t.address].valueNum += parseFloat(t.value);
        }
      });
      return Object.values(combined).map(t => {
        t.value = t.valueNum.toString();
        delete t.valueNum;
        return t;
      });
    };

    const combinedIncoming = combineTokens(incomingTokens);
    const combinedOutgoing = combineTokens(outgoingTokens);

    let type = 'transfer';
    let description = '';
    let details = {};

    if (combinedIncoming.length > 0 && combinedOutgoing.length > 0) {
      type = 'swap';
      
      const inToken = combinedIncoming[0];
      const outToken = combinedOutgoing[0];

      const inPrice = await getCachedPrice(inToken.address, timeStamp);
      const outPrice = await getCachedPrice(outToken.address, timeStamp);

      let swapValueUsd = 0;
      const stablecoins = ['usdt', 'busd', 'usdc', 'dai'];
      
      if (stablecoins.includes(outToken.symbol.toLowerCase())) {
        swapValueUsd = parseFloat(outToken.value);
      } else if (stablecoins.includes(inToken.symbol.toLowerCase())) {
        swapValueUsd = parseFloat(inToken.value);
      } else if (outToken.symbol === 'BNB') {
        swapValueUsd = parseFloat(outToken.value) * bnbPrice;
      } else if (inToken.symbol === 'BNB') {
        swapValueUsd = parseFloat(inToken.value) * bnbPrice;
      } else {
        swapValueUsd = parseFloat(outToken.value) * outPrice || parseFloat(inToken.value) * inPrice || 0;
      }

      const rate = parseFloat(outToken.value) / parseFloat(inToken.value);
      const rateUsd = swapValueUsd / parseFloat(inToken.value);

      description = `Swapped ${parseFloat(outToken.value).toLocaleString(undefined, { maximumFractionDigits: 6 })} ${outToken.symbol} for ${parseFloat(inToken.value).toLocaleString(undefined, { maximumFractionDigits: 6 })} ${inToken.symbol} ($${swapValueUsd.toFixed(2)} USD). Actual purchase price: $${rateUsd.toFixed(4)} per ${inToken.symbol}.`;
      
      details = {
        fromToken: outToken,
        toToken: inToken,
        valueUsd: swapValueUsd,
        rate,
        rateUsd
      };

    } else if (combinedIncoming.length > 0) {
      type = 'receive';
      const token = combinedIncoming[0];
      const tokenPrice = await getCachedPrice(token.address, timeStamp);
      const valueUsd = parseFloat(token.value) * tokenPrice;

      const fromAddr = normalTx ? normalTx.from : (tokenTransfers[0] ? tokenTransfers[0].from : 'Unknown');
      
      description = `Received ${parseFloat(token.value).toLocaleString(undefined, { maximumFractionDigits: 6 })} ${token.symbol} ${valueUsd > 0 ? `($${valueUsd.toFixed(2)} USD)` : ''} from ${fromAddr.substring(0, 6)}...${fromAddr.substring(fromAddr.length - 4)}.`;
      
      details = {
        token,
        valueUsd,
        fromAddress: fromAddr
      };
    } else if (combinedOutgoing.length > 0) {
      type = 'send';
      const token = combinedOutgoing[0];
      const tokenPrice = await getCachedPrice(token.address, timeStamp);
      const valueUsd = parseFloat(token.value) * tokenPrice;
      
      const toAddr = normalTx ? normalTx.to : (tokenTransfers[0] ? tokenTransfers[0].to : 'Unknown');

      description = `Sent ${parseFloat(token.value).toLocaleString(undefined, { maximumFractionDigits: 6 })} ${token.symbol} ${valueUsd > 0 ? `($${valueUsd.toFixed(2)} USD)` : ''} to ${toAddr.substring(0, 6)}...${toAddr.substring(toAddr.length - 4)}.`;

      details = {
        token,
        valueUsd,
        toAddress: toAddr
      };
    } else {
      type = 'interaction';
      const toAddr = normalTx ? normalTx.to : 'Contract';
      const methodName = normalTx && normalTx.functionName ? normalTx.functionName.split('(')[0] : 'Interaction';
      
      description = `Executed transaction interaction [${methodName}] with contract ${toAddr.substring(0, 6)}...${toAddr.substring(toAddr.length - 4)}.`;
      
      details = {
        toAddress: toAddr,
        method: methodName
      };
    }

    tracedTxs.push({
      hash,
      timeStamp,
      blockNumber,
      type,
      description,
      gasFeeBnb,
      gasFeeUsd,
      isUserInitiated,
      details
    });
  }

  // Sort traced transactions descending (newest first)
  tracedTxs.sort((a, b) => b.timeStamp - a.timeStamp || b.blockNumber - a.blockNumber);
  log(`Successfully traced and explained ${tracedTxs.length} transactions.`, 'success');

  return tracedTxs;
}

// Calculate the average cost basis and current unrealized PnL
export function calculateProfitLoss(transactions, currentBalances, currentPrices) {
  log(`Calculating average cost basis and PnL for active holdings...`, 'info');
  const holdings = {};

  // Sort transactions chronologically
  const sortedTxs = [...transactions].sort((a, b) => a.timeStamp - b.timeStamp);

  // 1. Calculate net change from historical transactions for each token to determine the starting balance
  const netChanges = {};
  
  sortedTxs.forEach(tx => {
    if (tx.type === 'swap') {
      const { fromToken, toToken } = tx.details;
      const fromAddr = fromToken.address.toLowerCase();
      const toAddr = toToken.address.toLowerCase();
      
      if (fromAddr !== ethers.ZeroAddress.toLowerCase()) {
        netChanges[fromAddr] = (netChanges[fromAddr] || 0) - parseFloat(fromToken.value);
      }
      if (toAddr !== ethers.ZeroAddress.toLowerCase()) {
        netChanges[toAddr] = (netChanges[toAddr] || 0) + parseFloat(toToken.value);
      }
    } else if (tx.type === 'receive') {
      const { token } = tx.details;
      const tokenAddr = token.address.toLowerCase();
      if (tokenAddr !== ethers.ZeroAddress.toLowerCase()) {
        netChanges[tokenAddr] = (netChanges[tokenAddr] || 0) + parseFloat(token.value);
      }
    } else if (tx.type === 'send') {
      const { token } = tx.details;
      const tokenAddr = token.address.toLowerCase();
      if (tokenAddr !== ethers.ZeroAddress.toLowerCase()) {
        netChanges[tokenAddr] = (netChanges[tokenAddr] || 0) - parseFloat(token.value);
      }
    }
  });

  // 2. Initialize holdings with starting balance before history, using oldest transaction price as cost basis
  Object.keys(currentBalances).forEach(tokenAddr => {
    const addrLower = tokenAddr.toLowerCase();
    if (addrLower === ethers.ZeroAddress.toLowerCase()) return; // ignore BNB
    
    const balance = parseFloat(currentBalances[tokenAddr]);
    if (balance <= 0) return;
    
    const netChange = netChanges[addrLower] || 0;
    const startingBalance = Math.max(0, balance - netChange);
    
    if (startingBalance > 0) {
      // Find the price at the oldest tracked transaction for this token
      let oldestPrice = 0;
      
      // Search sortedTxs chronologically to find the first transaction involving this token
      const firstTx = sortedTxs.find(tx => {
        if (tx.type === 'swap') {
          return tx.details.fromToken.address.toLowerCase() === addrLower || 
                 tx.details.toToken.address.toLowerCase() === addrLower;
        } else if (tx.type === 'receive' || tx.type === 'send') {
          return tx.details.token && tx.details.token.address.toLowerCase() === addrLower;
        }
        return false;
      });
      
      if (firstTx) {
        if (firstTx.type === 'swap') {
          const { fromToken, toToken, valueUsd } = firstTx.details;
          if (fromToken.address.toLowerCase() === addrLower) {
            const qty = parseFloat(fromToken.value);
            if (qty > 0) oldestPrice = valueUsd / qty;
          } else {
            const qty = parseFloat(toToken.value);
            if (qty > 0) oldestPrice = valueUsd / qty;
          }
        } else {
          const { token, valueUsd } = firstTx.details;
          const qty = parseFloat(token.value);
          if (qty > 0) oldestPrice = (valueUsd || 0) / qty;
        }
      }
      
      // If we couldn't find a price or price is 0, fallback to current price
      if (oldestPrice <= 0) {
        oldestPrice = currentPrices[tokenAddr] || 0;
      }
      
      holdings[addrLower] = {
        totalQuantity: startingBalance,
        totalCostUsd: startingBalance * oldestPrice,
        avgCostBasisUsd: oldestPrice
      };
    }
  });

  // 3. Process transactions chronologically
  sortedTxs.forEach(tx => {
    // We look at swaps and transfers
    const gasFee = tx.isUserInitiated ? tx.gasFeeUsd : 0;

    if (tx.type === 'swap') {
      const { fromToken, toToken, valueUsd } = tx.details;

      const fromAddr = fromToken.address.toLowerCase();
      const toAddr = toToken.address.toLowerCase();

      // Process the sold token (fromToken)
      if (fromAddr !== ethers.ZeroAddress.toLowerCase()) {
        if (!holdings[fromAddr]) {
          holdings[fromAddr] = { totalQuantity: 0, totalCostUsd: 0, avgCostBasisUsd: 0 };
        }
        
        const h = holdings[fromAddr];
        const soldQty = parseFloat(fromToken.value);
        const realizedCostBasis = soldQty * h.avgCostBasisUsd;

        h.totalQuantity = Math.max(0, h.totalQuantity - soldQty);
        h.totalCostUsd = Math.max(0, h.totalCostUsd - realizedCostBasis);
        if (h.totalQuantity === 0) {
          h.avgCostBasisUsd = 0;
        }
      }

      // Process the bought token (toToken)
      if (toAddr !== ethers.ZeroAddress.toLowerCase()) {
        if (!holdings[toAddr]) {
          holdings[toAddr] = { totalQuantity: 0, totalCostUsd: 0, avgCostBasisUsd: 0 };
        }

        const h = holdings[toAddr];
        const boughtQty = parseFloat(toToken.value);
        // Cost of purchase is the swap USD value plus the gas fee if the user initiated the swap!
        const purchaseCostUsd = valueUsd + gasFee;

        h.totalQuantity += boughtQty;
        h.totalCostUsd += purchaseCostUsd;
        h.avgCostBasisUsd = h.totalQuantity > 0 ? h.totalCostUsd / h.totalQuantity : 0;
      }
    } else if (tx.type === 'receive') {
      const { token, valueUsd } = tx.details;
      const tokenAddr = token.address.toLowerCase();

      if (tokenAddr !== ethers.ZeroAddress.toLowerCase()) {
        if (!holdings[tokenAddr]) {
          holdings[tokenAddr] = { totalQuantity: 0, totalCostUsd: 0, avgCostBasisUsd: 0 };
        }

        const h = holdings[tokenAddr];
        const qty = parseFloat(token.value);
        
        // Deposits: add to holdings. If valueUsd is available, use it. Otherwise, use 0.
        h.totalQuantity += qty;
        h.totalCostUsd += (valueUsd || 0) + gasFee;
        h.avgCostBasisUsd = h.totalQuantity > 0 ? h.totalCostUsd / h.totalQuantity : 0;
      }
    } else if (tx.type === 'send') {
      const { token } = tx.details;
      const tokenAddr = token.address.toLowerCase();

      if (tokenAddr !== ethers.ZeroAddress.toLowerCase()) {
        if (!holdings[tokenAddr]) {
          holdings[tokenAddr] = { totalQuantity: 0, totalCostUsd: 0, avgCostBasisUsd: 0 };
        }

        const h = holdings[tokenAddr];
        const qty = parseFloat(token.value);
        const realizedCostBasis = qty * h.avgCostBasisUsd;

        h.totalQuantity = Math.max(0, h.totalQuantity - qty);
        h.totalCostUsd = Math.max(0, h.totalCostUsd - realizedCostBasis);
        if (h.totalQuantity === 0) {
          h.avgCostBasisUsd = 0;
        }
      }
    }
  });

  // 4. Calculate current PnL based on current prices and balances
  const pnlSummary = {};
  
  Object.keys(currentBalances).forEach(tokenAddr => {
    const addrLower = tokenAddr.toLowerCase();
    const balance = parseFloat(currentBalances[tokenAddr]);
    if (balance <= 0) return;

    const price = currentPrices[tokenAddr] || 0;
    const currentValUsd = balance * price;

    if (addrLower === ethers.ZeroAddress.toLowerCase()) {
      pnlSummary[addrLower] = {
        address: addrLower,
        balance,
        currentPrice: price,
        currentValueUsd: currentValUsd,
        avgCostBasis: price,
        totalCostUsd: currentValUsd,
        pnlUsd: 0,
        pnlPercent: 0
      };
      return;
    }

    const holding = holdings[addrLower];
    let avgCostBasis = holding ? holding.avgCostBasisUsd : 0;
    
    // Fallback if we have no history at all for this token, or avgCostBasis was computed as 0
    if (avgCostBasis <= 0) {
      avgCostBasis = price;
    }
    
    const totalCost = balance * avgCostBasis;
    const pnlUsd = currentValUsd - totalCost;
    const pnlPercent = totalCost > 0 ? (pnlUsd / totalCost) * 100 : 0;

    pnlSummary[addrLower] = {
      address: addrLower,
      balance,
      currentPrice: price,
      currentValueUsd: currentValUsd,
      avgCostBasis,
      totalCostUsd: totalCost,
      pnlUsd,
      pnlPercent
    };
  });
  log(`PnL and cost basis calculations complete. Summarized ${Object.keys(pnlSummary).length} assets.`, 'success');

  return pnlSummary;
}
