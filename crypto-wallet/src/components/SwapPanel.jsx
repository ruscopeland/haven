import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useWallet } from '../context/WalletContext';
import { checkAllowance, approveToken, getPancakeQuote, getOpenOceanQuote, executePancakeSwap, executeBuiltSwap, WBNB_ADDRESS, getTokenData } from '../utils/blockchain';
import { ArrowDown, RefreshCw, AlertTriangle, ArrowUpDown, ChevronDown, CheckCircle2, DollarSign } from 'lucide-react';
import { ethers } from 'ethers';

// Standard tokens on BNB Chain for easy selection
const STANDARD_TOKENS = [
  { address: '0x0000000000000000000000000000000000000000', symbol: 'BNB', name: 'Binance Coin', decimals: 18 },
  { address: '0x55d398326f99059ff775485246999027b3197955', symbol: 'USDT', name: 'Tether USD', decimals: 18 },
  { address: '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d', symbol: 'USDC', name: 'USD Coin', decimals: 18 },
  { address: '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c', symbol: 'WBNB', name: 'Wrapped BNB', decimals: 18 },
  { address: '0x0e09fabb73bd3ade0a17ecc321fd13a19e81ce82', symbol: 'CAKE', name: 'PancakeSwap Token', decimals: 18 }
];

export default function SwapPanel({ initialFromTokenAddress }) {
  const { wallet, address, tokens, tokenPrices, bnbPrice, config, refreshWallet, provider } = useWallet();

  const [fromToken, setFromToken] = useState(STANDARD_TOKENS[0]);
  const [toToken, setToToken] = useState(STANDARD_TOKENS[1]);
  
  const [amountIn, setAmountIn] = useState('');
  const [amountOut, setAmountOut] = useState('');
  
  const [isQuoting, setIsQuoting] = useState(false);
  const [quotes, setQuotes] = useState([]); // List of quotes from aggregators
  const [bestQuoteIndex, setBestQuoteIndex] = useState(-1);

  // Selector modal state
  const [isSelectorOpen, setIsSelectorOpen] = useState(false);
  const [selectorType, setSelectorType] = useState('from'); // 'from' | 'to'
  const [selectorSearch, setSelectorSearch] = useState('');
  const [loadingCustomToken, setLoadingCustomToken] = useState(false);
  const [customTokenError, setCustomTokenError] = useState('');

  // Transaction states
  const [needsApproval, setNeedsApproval] = useState(false);
  const [isApproving, setIsApproving] = useState(false);
  const [isSwapping, setIsSwapping] = useState(false);
  const [txHash, setTxHash] = useState('');
  const [swapError, setSwapError] = useState('');
  const [swapSuccess, setSwapSuccess] = useState(false);

  // Preset token balances for select options
  const tokenBalancesMap = useMemo(() => {
    const map = {};
    tokens.forEach(t => {
      map[t.address.toLowerCase()] = t.balance;
    });
    return map;
  }, [tokens]);

  // Combine standard tokens and auto-discovered tokens for selection list
  const selectableTokens = useMemo(() => {
    const list = [...STANDARD_TOKENS];
    tokens.forEach(t => {
      if (!list.some(item => item.address.toLowerCase() === t.address.toLowerCase())) {
        list.push({
          address: t.address,
          symbol: t.symbol,
          name: t.name,
          decimals: t.decimals
        });
      }
    });
    return list;
  }, [tokens]);

  // Set initial from token if provided
  useEffect(() => {
    if (initialFromTokenAddress) {
      const match = selectableTokens.find(t => t.address.toLowerCase() === initialFromTokenAddress.toLowerCase());
      if (match) {
        setFromToken(match);
      }
    }
  }, [initialFromTokenAddress, selectableTokens]);

  const fromBalance = tokenBalancesMap[fromToken.address.toLowerCase()] || '0';
  const toBalance = tokenBalancesMap[toToken.address.toLowerCase()] || '0';

  // Toggle/Swap FROM and TO tokens
  const handleToggleTokens = () => {
    const temp = fromToken;
    setFromToken(toToken);
    setToToken(temp);
    setAmountIn('');
    setAmountOut('');
    setQuotes([]);
    setBestQuoteIndex(-1);
    setNeedsApproval(false);
  };

  // Check token allowance
  const handleCheckAllowance = useCallback(async (amount) => {
    if (!wallet || !amount || parseFloat(amount) <= 0) return;
    try {
      const isApproved = await checkAllowance(
        fromToken.address,
        address,
        // For DefiLlama swaps, spender is the contract returned in the quote.
        // For PancakeSwap direct swaps, it's the PancakeSwap Router.
        // We will do a generic check here for PancakeSwap Router as a baseline, 
        // but we'll re-verify spender once the quotes are retrieved.
        quotes[bestQuoteIndex]?.spender || '0x10ED43C718714eb63d5aA57B78B54704E256024E', 
        amount,
        fromToken.decimals,
        provider
      );
      setNeedsApproval(!isApproved);
    } catch (e) {
      console.error('Allowance check error:', e);
    }
  }, [wallet, provider, address, fromToken, quotes, bestQuoteIndex]);

  // Fetch Quotes from DefiLlama and PancakeSwap on-chain
  const getQuotes = useCallback(async (amount) => {
    if (!amount || parseFloat(amount) <= 0) {
      setQuotes([]);
      setBestQuoteIndex(-1);
      setAmountOut('');
      return;
    }

    setIsQuoting(true);
    setSwapError('');
    
    let lastError = null;
    const fetchedQuotes = [];
    const fromAddr = fromToken.address;
    const toAddr = toToken.address;
    
    // 1. Fetch PancakeSwap (V2+V3) quote via OpenOcean constraint
    try {
      const pancakeData = await getOpenOceanQuote(
        fromAddr,
        toAddr,
        amount,
        slippage,
        wallet?.address,
        '3',
        '1,46,50,64,65'
      );
      
      if (pancakeData && pancakeData.data) {
        const valOut = parseFloat(ethers.formatUnits(pancakeData.data.outAmount, toToken.decimals));
        const estGasUsd = parseFloat(pancakeData.data.estimatedGas) * 1e-9 * bnbPrice * 3; // rough gas estimate

        fetchedQuotes.push({
          name: 'PancakeSwap (V2+V3)',
          amountOut: ethers.formatUnits(pancakeData.data.outAmount, toToken.decimals),
          gasFeeUsd: estGasUsd,
          routeType: 'aggregator_pancake',
          spender: pancakeData.data.to, // dynamic aggregator router
          txData: pancakeData.data, // built tx data
          netValueUsd: (valOut * (tokenPrices[toToken.address.toLowerCase()] || 0)) - estGasUsd
        });
      }
    } catch (e) {
      console.warn('PancakeSwap Direct quote failed:', e);
      lastError = e;
    }

    // 2. Fetch KyberSwap aggregator quotes
    try {
      const slippagePct = parseFloat(config.slippage) || 0.5;

      const ooQuoteData = await getOpenOceanQuote(
        fromAddr,
        toAddr,
        amount,
        slippagePct,
        address
      );

      if (ooQuoteData.code === 200 && ooQuoteData.data) {
        const qData = ooQuoteData.data;
        const amtOutFormatted = ethers.formatUnits(qData.outAmount, toToken.decimals);
        const valOut = parseFloat(amtOutFormatted);
        
        // Parse gas fees (estimatedGas is in gas units, we assume gasPrice is 3 gwei)
        const gasPriceGwei = 3; 
        const gasBnb = (parseFloat(qData.estimatedGas || 250000) * gasPriceGwei * 1e9) / 1e18;
        const gasFeeUsd = gasBnb * bnbPrice;

        fetchedQuotes.push({
          name: 'OpenOcean (Aggregator)',
          amountOut: amtOutFormatted,
          gasFeeUsd,
          routeType: 'built_swap',
          spender: qData.to,
          txData: qData,
          netValueUsd: (valOut * (tokenPrices[toToken.address.toLowerCase()] || 0)) - gasFeeUsd
        });
      }
    } catch (e) {
      console.warn('KyberSwap quote fetch failed:', e);
    }

    if (fetchedQuotes.length === 0) {
      setQuotes([]);
      setBestQuoteIndex(-1);
      setAmountOut('');
      const details = lastError ? ` Details: ${lastError.message || lastError}` : '';
      setSwapError(`No routing pathways found.${details} Please verify your asset selection or ensure sufficient pool liquidity exists.`);
      setIsQuoting(false);
      return;
    }

    // Sort quotes by amount received descending (or net value)
    fetchedQuotes.sort((a, b) => parseFloat(b.amountOut) - parseFloat(a.amountOut));
    
    setQuotes(fetchedQuotes);
    setBestQuoteIndex(0); // Best quote is sorted to index 0
    setAmountOut(fetchedQuotes[0].amountOut);
    setIsQuoting(false);
  }, [fromToken, toToken, provider, bnbPrice, config.slippage, address, tokenPrices]);

  // Trigger quote fetching when inputs change
  useEffect(() => {
    const timer = setTimeout(() => {
      if (amountIn) {
        getQuotes(amountIn);
      }
    }, 600); // debounce input typing

    return () => clearTimeout(timer);
  }, [amountIn, fromToken.address, toToken.address, getQuotes]);

  // Recalculate allowance when best quote changes
  useEffect(() => {
    if (amountIn && bestQuoteIndex >= 0) {
      handleCheckAllowance(amountIn);
    }
  }, [bestQuoteIndex, amountIn, handleCheckAllowance]);

  // Handle Token Approval
  const handleApprove = async () => {
    if (!wallet || bestQuoteIndex < 0) return;
    setIsApproving(true);
    setSwapError('');
    try {
      const activeQuote = quotes[bestQuoteIndex];
      const spender = activeQuote.spender;
      
      const tx = await approveToken(
        fromToken.address,
        spender,
        amountIn,
        fromToken.decimals,
        wallet
      );

      setTxHash(tx.hash);
      await tx.wait();
      setNeedsApproval(false);
      setIsApproving(false);
      setTxHash('');
    } catch (e) {
      console.error(e);
      setSwapError(e.message || 'Token approval transaction failed.');
      setIsApproving(false);
    }
  };

  // Handle Swap Execution
  const handleSwap = async () => {
    if (!wallet || bestQuoteIndex < 0) return;
    setIsSwapping(true);
    setSwapError('');
    setSwapSuccess(false);

    const activeQuote = quotes[bestQuoteIndex];
    const slippagePct = parseFloat(config.slippage) || 0.5;

    try {
      let tx;
      // All quotes in SwapPanel now contain txData (DefiLlama or KyberSwap)
      tx = await executeBuiltSwap(activeQuote.txData, config.gasPrice || '3', wallet);

      setTxHash(tx.hash);
      await tx.wait();
      setSwapSuccess(true);
      setAmountIn('');
      setAmountOut('');
      setQuotes([]);
      setBestQuoteIndex(-1);
      refreshWallet(); // reload balances
    } catch (e) {
      console.error(e);
      setSwapError(e.message || 'Swap execution failed. Try increasing slippage in configuration.');
    } finally {
      setIsSwapping(false);
    }
  };

  // Open Selector Modal
  const openSelector = (type) => {
    setSelectorType(type);
    setSelectorSearch('');
    setCustomTokenError('');
    setIsSelectorOpen(true);
  };

  // Handle Token selection
  const handleSelectToken = (selected) => {
    if (selectorType === 'from') {
      setFromToken(selected);
      // Ensure we don't have same from/to
      if (selected.address.toLowerCase() === toToken.address.toLowerCase()) {
        setToToken(fromToken);
      }
    } else {
      setToToken(selected);
      if (selected.address.toLowerCase() === fromToken.address.toLowerCase()) {
        setFromToken(toToken);
      }
    }
    setAmountIn('');
    setAmountOut('');
    setQuotes([]);
    setBestQuoteIndex(-1);
    setIsSelectorOpen(false);
  };

  // Load custom token by contract address
  const handleLoadCustomToken = async (addr) => {
    if (!ethers.isAddress(addr)) {
      setCustomTokenError('Invalid BSC contract address format.');
      return;
    }
    setLoadingCustomToken(true);
    setCustomTokenError('');
    try {
      const data = await getTokenData(addr, null, provider);
      const customToken = {
        address: addr.toLowerCase(),
        symbol: data.symbol,
        name: data.name,
        decimals: data.decimals
      };
      
      // select it
      handleSelectToken(customToken);
    } catch (e) {
      console.error('Failed to load custom token:', e);
      setCustomTokenError(`Failed to fetch details from BNB Chain: ${e.message || String(e)}. Ensure this contract address exists.`);
    } finally {
      setLoadingCustomToken(false);
    }
  };

  // Filter list of selectable tokens in modal
  const filteredTokens = useMemo(() => {
    const search = selectorSearch.toLowerCase().trim();
    if (!search) return selectableTokens;
    
    return selectableTokens.filter(t => 
      t.symbol.toLowerCase().includes(search) || 
      t.name.toLowerCase().includes(search) ||
      t.address.toLowerCase() === search
    );
  }, [selectableTokens, selectorSearch]);

  // Detect if search is a valid contract address not in selection list
  const isAddressSearch = selectorSearch.length === 42 && selectorSearch.startsWith('0x');
  const isAlreadySelectable = selectableTokens.some(t => t.address.toLowerCase() === selectorSearch.toLowerCase());
  const showCustomTokenImport = isAddressSearch && !isAlreadySelectable;

  const currentFromPrice = tokenPrices[fromToken.address.toLowerCase()] || 0;
  const currentToPrice = tokenPrices[toToken.address.toLowerCase()] || 0;

  return (
    <div className="swap-card glass-panel">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
        <h3>Swaps</h3>
        <span className="badge badge-gain" style={{ background: 'rgba(255,255,255,0.05)', color: 'var(--text-muted)' }}>
          Max Slippage: {config.slippage}%
        </span>
      </div>

      {swapError && <div className="error-banner">{swapError}</div>}
      
      {swapSuccess && (
        <div className="info-banner" style={{ background: 'var(--success-glow)', border: '1px solid rgba(16, 185, 129, 0.3)', color: '#a7f3d0', padding: '16px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontWeight: 600 }}>
            <CheckCircle2 size={16} /> Swap executed successfully!
          </div>
          {txHash && (
            <a 
              href={`https://bscscan.com/tx/${txHash}`} 
              target="_blank" 
              rel="noopener noreferrer" 
              style={{ color: 'var(--primary)', fontSize: '13px', display: 'block', marginTop: '8px', textDecoration: 'none' }}
            >
              View receipt on BSCScan &rarr;
            </a>
          )}
        </div>
      )}

      {/* From Token Block */}
      <div className="swap-input-box">
        <div className="swap-input-header">
          <span>Pay With</span>
          <span>Balance: {parseFloat(fromBalance).toLocaleString(undefined, { maximumFractionDigits: 6 })}</span>
        </div>
        <div className="swap-input-container">
          <input
            type="number"
            className="swap-input"
            placeholder="0.0"
            value={amountIn}
            onChange={(e) => setAmountIn(e.target.value)}
          />
          <button className="token-select-btn" onClick={() => openSelector('from')}>
            {fromToken.symbol} <ChevronDown size={14} />
          </button>
        </div>
        {amountIn && currentFromPrice > 0 && (
          <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '6px' }}>
            ~${(parseFloat(amountIn) * currentFromPrice).toFixed(2)} USD
          </div>
        )}
        <button 
          className="btn-secondary" 
          onClick={() => setAmountIn(fromBalance)} 
          style={{ position: 'absolute', right: '16px', bottom: '-12px', padding: '2px 8px', fontSize: '10px', height: '20px', borderRadius: '4px' }}
        >
          MAX
        </button>
      </div>

      {/* Switch Arrow */}
      <div className="swap-divider">
        <button className="swap-arrow-btn" onClick={handleToggleTokens}>
          <ArrowDown size={16} />
        </button>
      </div>

      {/* To Token Block */}
      <div className="swap-input-box" style={{ marginTop: '14px' }}>
        <div className="swap-input-header">
          <span>Receive Asset</span>
          <span>Balance: {parseFloat(toBalance).toLocaleString(undefined, { maximumFractionDigits: 6 })}</span>
        </div>
        <div className="swap-input-container">
          <input
            type="text"
            className="swap-input"
            placeholder="0.0"
            value={isQuoting ? '...' : parseFloat(amountOut).toLocaleString(undefined, { maximumFractionDigits: 6 })}
            readOnly
          />
          <button className="token-select-btn" onClick={() => openSelector('to')}>
            {toToken.symbol} <ChevronDown size={14} />
          </button>
        </div>
        {amountOut && !isQuoting && currentFromPrice > 0 && (
          <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '6px' }}>
            ~${(parseFloat(amountIn) * currentFromPrice).toFixed(2)} USD (1 {toToken.symbol} = ${((parseFloat(amountIn) * currentFromPrice) / parseFloat(amountOut)).toLocaleString(undefined, { maximumFractionDigits: 6 })})
          </div>
        )}
      </div>

      {/* Quotes & Routing Panel */}
      {amountIn && !isQuoting && quotes.length > 0 && bestQuoteIndex >= 0 && (
        <div className="quote-container">
          <div className="quote-row">
            <span className="quote-label">DEX Route choice</span>
            <select 
              value={bestQuoteIndex} 
              onChange={(e) => {
                const idx = parseInt(e.target.value);
                setBestQuoteIndex(idx);
                setAmountOut(quotes[idx].amountOut);
              }}
              style={{ background: '#0a0f1d', border: '1px solid var(--border-glass)', borderRadius: '6px', color: '#fff', fontSize: '13px', padding: '2px 6px' }}
            >
              {quotes.map((q, idx) => (
                <option key={idx} value={idx}>
                  {idx === 0 ? '🏆 ' : ''}{q.name} ({parseFloat(q.amountOut).toFixed(4)} {toToken.symbol})
                </option>
              ))}
            </select>
          </div>

          <div className="quote-row">
            <span className="quote-label">Effective Price You Pay</span>
            <span className="quote-value">
              1 {toToken.symbol} = {(parseFloat(amountIn) / parseFloat(amountOut)).toLocaleString(undefined, { maximumFractionDigits: 6 })} {fromToken.symbol}
              {currentFromPrice > 0 && ` (~$${((parseFloat(amountIn) * currentFromPrice) / parseFloat(amountOut)).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 6 })} USD)`}
            </span>
          </div>

          <div className="quote-row">
            <span className="quote-label">Aggregator Route Gas Fee</span>
            <span className="quote-value">${quotes[bestQuoteIndex].gasFeeUsd.toFixed(2)} USD</span>
          </div>

          <div className="quote-row">
            <span className="quote-label">Expected Slippage</span>
            <span className="quote-value">&le; {config.slippage}%</span>
          </div>
        </div>
      )}

      {/* Action Buttons */}
      <div style={{ marginTop: '24px' }}>
        {!wallet ? (
          <div className="text-muted" style={{ textAlign: 'center', fontSize: '14px' }}>
            Configure your private keys in settings to swap assets.
          </div>
        ) : isApproving ? (
          <button className="btn-primary" style={{ width: '100%', cursor: 'wait' }} disabled>
            <RefreshCw className="spin-animation" size={16} style={{ animation: 'spin 1s linear infinite' }} />
            Approving {fromToken.symbol}...
          </button>
        ) : isSwapping ? (
          <button className="btn-primary" style={{ width: '100%', cursor: 'wait' }} disabled>
            <RefreshCw className="spin-animation" size={16} style={{ animation: 'spin 1s linear infinite' }} />
            Broadcasting Swap...
          </button>
        ) : needsApproval ? (
          <button className="btn-primary" onClick={handleApprove} style={{ width: '100%', background: 'var(--success-gradient)' }}>
            Approve {fromToken.symbol}
          </button>
        ) : (
          <button 
            className="btn-primary" 
            onClick={handleSwap} 
            style={{ width: '100%' }}
            disabled={!amountIn || parseFloat(amountIn) <= 0 || parseFloat(amountIn) > parseFloat(fromBalance) || isQuoting}
          >
            {parseFloat(amountIn) > parseFloat(fromBalance) ? 'Insufficient Balance' : 'Confirm Swap'}
          </button>
        )}
      </div>

      {txHash && (isSwapping || isApproving) && (
        <div style={{ fontSize: '11px', textAlign: 'center', marginTop: '12px', color: 'var(--text-muted)' }}>
          Transaction Hash: <code>{txHash.substring(0, 10)}...</code>
        </div>
      )}

      {/* Selector Modal Overlay */}
      {isSelectorOpen && (
        <div className="modal-overlay" onClick={() => setIsSelectorOpen(false)}>
          <div className="modal-content glass-panel" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h4>Select Asset</h4>
              <button className="btn-secondary" onClick={() => setIsSelectorOpen(false)} style={{ padding: '4px 8px', height: '24px', borderRadius: '4px', fontSize: '11px' }}>X</button>
            </div>
            
            <div className="search-input-wrapper">
              <input
                type="text"
                className="input-control"
                placeholder="Search symbol, name, or paste contract address..."
                value={selectorSearch}
                onChange={(e) => setSelectorSearch(e.target.value)}
                autoFocus
              />
            </div>

            {customTokenError && <div className="error-banner" style={{ fontSize: '12px', padding: '8px' }}>{customTokenError}</div>}

            {showCustomTokenImport && (
              <div style={{ marginBottom: '12px' }}>
                <button 
                  className="btn-primary" 
                  onClick={() => handleLoadCustomToken(selectorSearch)}
                  disabled={loadingCustomToken}
                  style={{ width: '100%', background: 'var(--success-gradient)', fontSize: '12px', padding: '10px' }}
                >
                  {loadingCustomToken ? 'Querying BNB Chain...' : 'Import Custom Contract Address'}
                </button>
              </div>
            )}

            <div className="token-list-scroll">
              {filteredTokens.map((t) => {
                const bal = tokenBalancesMap[t.address.toLowerCase()] || '0';
                
                return (
                  <button 
                    key={t.address} 
                    className="token-item-btn"
                    onClick={() => handleSelectToken(t)}
                  >
                    <div>
                      <div style={{ fontWeight: 700, color: '#fff' }}>{t.symbol}</div>
                      <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{t.name}</div>
                    </div>
                    <div style={{ textAlign: 'right' }}>
                      <div style={{ fontWeight: 600 }}>{parseFloat(bal).toLocaleString(undefined, { maximumFractionDigits: 4 })}</div>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
