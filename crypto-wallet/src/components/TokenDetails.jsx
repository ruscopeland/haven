import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useWallet } from '../context/WalletContext';
import { ArrowLeft, ArrowUpDown, ExternalLink, Copy, CheckCircle2, TrendingUp, TrendingDown, RefreshCw, ShoppingCart, AlertTriangle, Zap, Settings, Play, Pause } from 'lucide-react';
import { ethers } from 'ethers';
import { getOpenOceanQuote, executeBuiltSwap, checkAllowance, approveToken, getPancakeQuote, executePancakeSwap, PANCAKE_ROUTER_ADDRESS } from '../utils/blockchain';
import { log } from '../utils/logger';
import { get4HourOHLCV, calculateSupportResistance } from '../utils/technicalAnalysis';

export default function TokenDetails({ tokenAddress, onBack, onNavigateToSwap }) {
  const { 
    tokens, 
    tokenPrices, 
    priceChanges24h, 
    transactions, 
    pnlSummary, 
    isRefreshing, 
    refreshWallet,
    txError,
    customTokens,
    removeCustomToken,
    wallet,
    address,
    bnbBalance,
    bnbPrice,
    provider,
    config,
    saveConfig,
    dexPairData,
    autoTradeJobs,
    addAutoTradeJob,
    removeAutoTradeJob
  } = useWallet();

  const [copied, setCopied] = useState(false);
  const [pairAddress, setPairAddress] = useState('');
  const [chainId, setChainId] = useState('bsc');
  const token = tokens.find(t => t.address.toLowerCase() === tokenAddress.toLowerCase());
  const price = tokenPrices[tokenAddress.toLowerCase()] || 0;
  const priceChange = priceChanges24h[tokenAddress.toLowerCase()] || 0;
  const pnlData = pnlSummary[tokenAddress.toLowerCase()];

  // Quick trade state
  const [activeRouter, setActiveRouter] = useState('openocean'); // 'openocean' | 'pancake'
  const [showQuickSettings, setShowQuickSettings] = useState(false);
  const [buyQuote, setBuyQuote] = useState(null);
  const [sellQuote, setSellQuote] = useState(null);
  const [isQuoting, setIsQuoting] = useState(false);
  const [quoteError, setQuoteError] = useState('');
  
  // Rate limit and polling states
  const [isPollingPaused, setIsPollingPaused] = useState(false);
  const [countdown, setCountdown] = useState(10);
  const [rateLimitSwitched, setRateLimitSwitched] = useState(false);
  const [isTabVisible, setIsTabVisible] = useState(true);
  
  // Allowance and Approval
  const [isApproved, setIsApproved] = useState(true);
  const [isCheckingAllowance, setIsCheckingAllowance] = useState(false);
  const [isApproving, setIsApproving] = useState(false);
  
  // Execution state
  const [isExecuting, setIsExecuting] = useState(false);
  const [execStatus, setExecStatus] = useState('');
  const [execSuccess, setExecSuccess] = useState(false);
  const [execError, setExecError] = useState('');

  // Auto-Trading & S/R state
  const [supportPrice, setSupportPrice] = useState(null);
  const [resistancePrice, setResistancePrice] = useState(null);
  const [isCalculatingSR, setIsCalculatingSR] = useState(false);
  const [isDynamicSR, setIsDynamicSR] = useState(true);
  
  const [manualBuyTarget, setManualBuyTarget] = useState('');
  const [takeProfitTarget, setTakeProfitTarget] = useState('');
  const [stopLossTarget, setStopLossTarget] = useState('');

  const activeJobs = autoTradeJobs && autoTradeJobs[tokenAddress.toLowerCase()] ? autoTradeJobs[tokenAddress.toLowerCase()] : [];
  const activeCycleJob = activeJobs.find(j => !j.type || j.type === 'cycle');
  const activeManualBuyJob = activeJobs.find(j => j.type === 'manual_buy');
  const activeManualSellJob = activeJobs.find(j => j.type === 'manual_sell');

  const handleCalculateSR = async () => {
    setIsCalculatingSR(true);
    try {
      if (token?.dexPairData?.pairAddress) {
        const ohlcv = await get4HourOHLCV(token.dexPairData.pairAddress);
        const { support, resistance } = calculateSupportResistance(ohlcv);
        setSupportPrice(support);
        setResistancePrice(resistance);
      } else {
        alert('Pair address not available to calculate 4H SR.');
      }
    } catch (error) {
      console.error(error);
      alert('Failed to calculate SR');
    }
    setIsCalculatingSR(false);
  };

  const handleSetAutoCycle = () => {
    if (activeCycleJob) {
      removeAutoTradeJob(tokenAddress, activeCycleJob.id);
    } else {
      if (!supportPrice || !resistancePrice) return alert('Calculate SR first');
      // Set the mean reversion auto trade
      addAutoTradeJob(tokenAddress, supportPrice, resistancePrice, localBuyPercent, localSellPercent, activeRouter, isDynamicSR, 'cycle');
    }
  };

  const handleSetManualBuy = () => {
    if (!manualBuyTarget || parseFloat(manualBuyTarget) <= 0) return;
    addAutoTradeJob(tokenAddress, manualBuyTarget, 0, localBuyPercent, 0, activeRouter, false, 'manual_buy');
    setManualBuyTarget('');
  };

  const handleSetManualSell = () => {
    const tp = parseFloat(takeProfitTarget) || 0;
    const sl = parseFloat(stopLossTarget) || 0;
    if (tp <= 0 && sl <= 0) return;
    addAutoTradeJob(tokenAddress, 0, tp, 0, localSellPercent, activeRouter, false, 'manual_sell', sl);
    setTakeProfitTarget('');
    setStopLossTarget('');
  };

  const buyPercent = parseFloat(config?.quickBuyPercent) || 5;
  const sellPercent = parseFloat(config?.quickSellPercent) || 100;

  // Local interactive slider percentage states
  const [localBuyPercent, setLocalBuyPercent] = useState(buyPercent);
  const [localSellPercent, setLocalSellPercent] = useState(sellPercent);

  // Sync local states when global config changes
  useEffect(() => {
    setLocalBuyPercent(buyPercent);
  }, [buyPercent]);

  useEffect(() => {
    setLocalSellPercent(sellPercent);
  }, [sellPercent]);

  // Debounce saving config quick trade percentages to localStorage by 300ms
  useEffect(() => {
    const timer = setTimeout(() => {
      if (localBuyPercent !== buyPercent) {
        saveConfig({ quickBuyPercent: localBuyPercent.toString() });
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [localBuyPercent, buyPercent, saveConfig]);

  useEffect(() => {
    const timer = setTimeout(() => {
      if (localSellPercent !== sellPercent) {
        saveConfig({ quickSellPercent: localSellPercent.toString() });
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [localSellPercent, sellPercent, saveConfig]);
  
  // Calculate raw buy and sell amounts based on debounced config values (for quote querying)
  const buyAmountBnb = useMemo(() => {
    const bnb = parseFloat(bnbBalance) || 0;
    if (bnb <= 0) return '0';
    const calculated = (bnb * buyPercent) / 100;
    // Format to 4 decimals to keep it clean and prevent microscopic trades
    return calculated > 0.0001 ? calculated.toFixed(4) : '0';
  }, [bnbBalance, buyPercent]);

  const sellAmountToken = useMemo(() => {
    const bal = parseFloat(token?.balance) || 0;
    if (bal <= 0) return '0';
    const calculated = (bal * sellPercent) / 100;
    return calculated > 0.000001 ? calculated.toFixed(6) : '0';
  }, [token?.balance, sellPercent]);

  // Display values that react instantly to local slider values (for UI layout)
  const displayBuyAmountBnb = useMemo(() => {
    const bnb = parseFloat(bnbBalance) || 0;
    if (bnb <= 0) return '0';
    const calculated = (bnb * localBuyPercent) / 100;
    return calculated > 0.0001 ? calculated.toFixed(4) : '0';
  }, [bnbBalance, localBuyPercent]);

  const displaySellAmountToken = useMemo(() => {
    const bal = parseFloat(token?.balance) || 0;
    if (bal <= 0) return '0';
    const calculated = (bal * localSellPercent) / 100;
    return calculated > 0.000001 ? calculated.toFixed(6) : '0';
  }, [token?.balance, localSellPercent]);

  // Check allowance helper
  const checkTokenAllowance = useCallback(async (spender, amount) => {
    if (!wallet || !token || tokenAddress === '0x0000000000000000000000000000000000000000') return;
    setIsCheckingAllowance(true);
    try {
      const approved = await checkAllowance(
        tokenAddress,
        address,
        spender,
        amount,
        token.decimals,
        provider
      );
      setIsApproved(approved);
    } catch (e) {
      console.error('Failed to check allowance:', e);
    } finally {
      setIsCheckingAllowance(false);
    }
  }, [wallet, token, tokenAddress, address, provider]);

  // Fetch quotes function
  const fetchQuotes = useCallback(async () => {
    if (tokenAddress === '0x0000000000000000000000000000000000000000' || !wallet) {
      return;
    }
    
    setQuoteError('');
    setIsQuoting(true);
    const gasPriceGwei = config?.gasPrice || '1';
    
    try {
      const dexIds = activeRouter === 'openocean' ? undefined : '1,46,50,64,65';
      let buyData = null;
      let sellData = null;
      let rateLimited = false;
      let isGeneralError = false;
      let errorMsg = '';

      // 1. Fetch Buy Quote (BNB -> Token)
      if (parseFloat(buyAmountBnb) > 0) {
        try {
          const res = await getOpenOceanQuote(
            '0x0000000000000000000000000000000000000000', // BNB
            tokenAddress,
            buyAmountBnb,
            parseFloat(config?.slippage) || 0.5,
            address,
            gasPriceGwei,
            dexIds
          );
            if (res && res.code === 200) {
              buyData = res.data;
            } else {
              console.warn('Aggregator buy quote error:', res);
              errorMsg = res?.message || 'Invalid response from quote API';
              if (res?.code === 429 || errorMsg.toLowerCase().includes('rate limit') || errorMsg.toLowerCase().includes('too many requests')) {
                rateLimited = true;
              } else {
                isGeneralError = true;
              }
              setQuoteError(`Buy Quote error: ${errorMsg}`);
            }
          } catch (err) {
            console.warn('Failed to fetch buy quote:', err);
            errorMsg = err.message || String(err);
            if (errorMsg.toLowerCase().includes('rate limit') || errorMsg.includes('429') || errorMsg.toLowerCase().includes('too many requests')) {
              rateLimited = true;
            } else {
              isGeneralError = true;
            }
            setQuoteError(`Failed to fetch buy quote: ${errorMsg}`);
          }
        } else {
          const bnb = parseFloat(bnbBalance) || 0;
          if (bnb <= 0) {
            setQuoteError('Insufficient BNB balance to estimate buy quote.');
          } else {
            setQuoteError('Calculated buy amount is too small. Increase your buy percentage.');
          }
        }

        
        // Sleep to respect API rate limits if we just fetched buy quote
        if (parseFloat(buyAmountBnb) > 0 && !rateLimited && !isGeneralError) {
          await new Promise(r => setTimeout(r, 1100));
        }

        // 2. Fetch Sell Quote (Token -> BNB)
        if (!rateLimited && !isGeneralError && parseFloat(sellAmountToken) > 0) {
          try {
            const res = await getOpenOceanQuote(
              tokenAddress,
              '0x0000000000000000000000000000000000000000', // BNB
              sellAmountToken,
              parseFloat(config?.slippage) || 0.5,
              address,
              gasPriceGwei,
              dexIds
            );
            if (res && res.code === 200) {
              sellData = res.data;
              if (sellData.to) {
                await checkTokenAllowance(sellData.to, sellAmountToken);
              }
            } else {
              console.warn('Aggregator sell quote error:', res);
              errorMsg = res?.message || 'Invalid response from quote API';
              if (res?.code === 429 || errorMsg.toLowerCase().includes('rate limit') || errorMsg.toLowerCase().includes('too many requests')) {
                rateLimited = true;
              } else {
                isGeneralError = true;
              }
              setQuoteError(prev => prev ? prev : `Sell Quote error: ${errorMsg}`);
            }
          } catch (err) {
            console.warn('Failed to fetch sell quote:', err);
            errorMsg = err.message || String(err);
            if (errorMsg.toLowerCase().includes('rate limit') || errorMsg.includes('429') || errorMsg.toLowerCase().includes('too many requests')) {
              rateLimited = true;
            } else {
              isGeneralError = true;
            }
            setQuoteError(prev => prev ? prev : `Failed to fetch sell quote: ${errorMsg}`);
          }
        }

        if (rateLimited || isGeneralError) {
          setBuyQuote(null);
          setSellQuote(null);
          setQuoteError(rateLimited ? 'Rate limit reached. Waiting for next window...' : `Route query failed: ${errorMsg}`);
          return;
        }

        setBuyQuote(buyData);
        setSellQuote(sellData);
      // PancakeSwap route is now handled via constrained Aggregator query
      
    } catch (e) {
      console.error('Error fetching quick trade quotes:', e);
      setQuoteError(prev => prev ? prev : 'Failed to refresh trading quotes.');
    } finally {
      setIsQuoting(false);
    }
  }, [tokenAddress, buyAmountBnb, sellAmountToken, config?.slippage, config?.gasPrice, address, wallet, checkTokenAllowance, bnbBalance, activeRouter, provider, token?.decimals]);

  // Handle Visibility change to pause polling when tab is inactive
  useEffect(() => {
    const handleVisibilityChange = () => {
      setIsTabVisible(document.visibilityState === 'visible');
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, []);

  // Quote auto-refresh countdown (1 second ticks)
  useEffect(() => {
    if (address && tokenAddress !== '0x0000000000000000000000000000000000000000') {
      fetchQuotes();
    }
    setCountdown(10);
  }, [address, tokenAddress, fetchQuotes, activeRouter]);

  useEffect(() => {
    if (!address || tokenAddress === '0x0000000000000000000000000000000000000000') return;
    if (isPollingPaused || !isTabVisible || isExecuting || isApproving) return;

    const timer = setInterval(() => {
      setCountdown(prev => {
        if (prev <= 1) {
          fetchQuotes();
          return 10;
        }
        return prev - 1;
      });
    }, 1000);

    return () => clearInterval(timer);
  }, [address, tokenAddress, isPollingPaused, isTabVisible, isExecuting, isApproving, fetchQuotes]);

  const handleApprove = async () => {
    if (!wallet || !sellQuote || !sellQuote.to || !token) return;
    setIsApproving(true);
    setExecError('');
    setExecStatus('Approving token spending...');
    try {
      const tx = await approveToken(
        tokenAddress,
        sellQuote.to,
        token.balance, // approve max balance for convenience
        token.decimals,
        wallet
      );
      setExecStatus('Waiting for confirmation...');
      await tx.wait();
      setIsApproved(true);
      setExecStatus('');
      fetchQuotes();
    } catch (e) {
      console.error('Approval error:', e);
      setExecError(e.message || 'Token approval transaction failed.');
    } finally {
      setIsApproving(false);
    }
  };

  const handleQuickBuy = async () => {
    if (!wallet || !buyQuote) return;
    setIsExecuting(true);
    setExecError('');
    setExecSuccess(false);
    setExecStatus('Submitting Quick Buy transaction...');
    try {
      let tx;
      tx = await executeBuiltSwap(buyQuote, config?.gasPrice || '1', wallet);
      setExecStatus('Waiting for confirmation...');
      await tx.wait();
      setExecSuccess(true);
      setExecStatus('Quick Buy successful!');
      setTimeout(() => {
        setExecSuccess(false);
        setExecStatus('');
      }, 4000);
      refreshWallet();
    } catch (e) {
      console.error('Quick Buy error:', e);
      setExecError(e.message || 'Quick Buy failed. Try increasing slippage in settings.');
    } finally {
      setIsExecuting(false);
    }
  };

  const handleQuickSell = async () => {
    if (!wallet || !sellQuote) return;
    if (!isApproved) {
      await handleApprove();
      return;
    }
    setIsExecuting(true);
    setExecError('');
    setExecSuccess(false);
    setExecStatus('Submitting Quick Sell transaction...');
    try {
      let tx;
      tx = await executeBuiltSwap(sellQuote, config?.gasPrice || '3', wallet);
      setExecStatus('Waiting for confirmation...');
      await tx.wait();
      setExecSuccess(true);
      setExecStatus('Quick Sell successful!');
      setTimeout(() => {
        setExecSuccess(false);
        setExecStatus('');
      }, 4000);
      refreshWallet();
    } catch (e) {
      console.error('Quick Sell error:', e);
      setExecError(e.message || 'Quick Sell failed. Try increasing slippage in settings.');
    } finally {
      setIsExecuting(false);
    }
  };

  // Signal charting-ui to open this token's chart
  useEffect(() => {
    const symbol = token?.symbol;
    if (symbol) {
      const name = token?.name || '';
      const CHARTING_UI = 'http://localhost:5173';
      window.open(`${CHARTING_UI}/?token=${encodeURIComponent(symbol + '|' + name)}`, 'charting_ui');
    }
  }, []); // Only on mount

  const handleCopy = () => {
    navigator.clipboard.writeText(tokenAddress);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  if (!token) {
    return (
      <div className="glass-panel" style={{ padding: '24px', textAlign: 'center' }}>
        <h3>Asset not found</h3>
        <button className="btn-secondary" onClick={onBack} style={{ marginTop: '16px' }}>
          <ArrowLeft size={16} /> Back to Dashboard
        </button>
      </div>
    );
  }

  const isBnb = tokenAddress === '0x0000000000000000000000000000000000000000';
  const holdingsValue = parseFloat(token.balance) * price;

  // Filter transactions for this token
  const tokenTransactions = transactions.filter(tx => {
    if (tx.type === 'interaction') return false; // hide contract calls with no token transfer
    const details = tx.details;
    if (!details) return false;

    if (tx.type === 'swap') {
      return (
        details.fromToken.address.toLowerCase() === tokenAddress.toLowerCase() ||
        details.toToken.address.toLowerCase() === tokenAddress.toLowerCase()
      );
    } else {
      return details.token && details.token.address.toLowerCase() === tokenAddress.toLowerCase();
    }
  });

  // Calculate total fees paid for this token's transactions
  const totalFeesPaidUsd = tokenTransactions
    .filter(tx => tx.isUserInitiated)
    .reduce((sum, tx) => sum + (tx.gasFeeUsd || 0), 0);

  return (
    <div>
      {/* Navigation & Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '24px' }}>
        <button className="btn-secondary" onClick={onBack} style={{ padding: '8px 16px', borderRadius: '10px', height: '38px' }}>
          <ArrowLeft size={16} /> Dashboard
        </button>

        <div style={{ display: 'flex', gap: '12px' }}>
          {customTokens.map(a => a.toLowerCase()).includes(tokenAddress.toLowerCase()) && (
            <button 
              className="btn-secondary" 
              onClick={() => {
                if (window.confirm(`Are you sure you want to stop tracking ${token.symbol}?`)) {
                  removeCustomToken(tokenAddress);
                  onBack();
                }
              }}
              style={{ padding: '0 16px', height: '38px', borderRadius: '10px', fontSize: '14px', color: 'var(--danger)', borderColor: 'rgba(244, 63, 94, 0.2)' }}
            >
              Stop Tracking
            </button>
          )}

          <button 
            className="btn-primary" 
            onClick={() => onNavigateToSwap(tokenAddress)}
            style={{ padding: '0 16px', height: '38px', borderRadius: '10px', fontSize: '14px' }}
          >
            <ShoppingCart size={16} /> Swap {token.symbol}
          </button>
          
          <button 
            className="btn-secondary" 
            onClick={refreshWallet} 
            disabled={isRefreshing}
            style={{ padding: '0 12px', height: '38px', borderRadius: '10px' }}
          >
            <RefreshCw size={14} className={isRefreshing ? 'spin-animation' : ''} style={{ animation: isRefreshing ? 'spin 1s linear infinite' : 'none' }} />
          </button>
        </div>
      </div>

      {/* Asset Info Card */}
      <div className="glass-panel" style={{ padding: '24px', marginBottom: '24px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: '16px' }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
              <h1 style={{ fontSize: '32px' }}>{token.name}</h1>
              <span className="badge badge-gain" style={{ background: 'rgba(255,255,255,0.05)', color: 'var(--text-muted)', fontSize: '14px' }}>
                {token.symbol}
              </span>
            </div>
            
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '8px' }}>
              <span className="form-label" style={{ margin: 0, fontSize: '13px' }}>Contract:</span>
              <code style={{ background: 'rgba(255,255,255,0.03)', padding: '3px 8px', borderRadius: '6px', fontSize: '13px', color: '#fff' }}>
                {isBnb ? 'Native BNB Coin' : `${tokenAddress.substring(0, 8)}...${tokenAddress.substring(tokenAddress.length - 8)}`}
              </code>
              {!isBnb && (
                <>
                  <button onClick={handleCopy} style={{ background: 'none', border: 'none', cursor: 'pointer', color: copied ? 'var(--success)' : 'var(--text-muted)' }} title="Copy address">
                    {copied ? <CheckCircle2 size={14} /> : <Copy size={14} />}
                  </button>
                  <a href={`https://bscscan.com/token/${tokenAddress}`} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--text-muted)' }} title="View on BSCScan">
                    <ExternalLink size={14} />
                  </a>
                </>
              )}
            </div>
          </div>

          <div style={{ textAlign: 'right' }}>
            <div style={{ fontSize: '28px', fontWeight: 800, fontFamily: 'var(--font-display)', color: 'var(--text-bright)' }}>
              ${price >= 0.01 ? price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 }) : price.toFixed(6)}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '6px', marginTop: '4px' }}>
              {priceChange !== 0 ? (
                <span className={`badge ${priceChange >= 0 ? 'badge-gain' : 'badge-loss'}`}>
                  {priceChange >= 0 ? '+' : ''}
                  {priceChange.toFixed(2)}% (24h)
                </span>
              ) : (
                <span style={{ color: 'var(--text-muted)' }}>0.00%</span>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Quick Trade Panel */}
      {!isBnb && (
        <div className="glass-panel" style={{ padding: '24px', marginBottom: '24px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px', borderBottom: '1px solid rgba(255, 255, 255, 0.05)', paddingBottom: '12px', flexWrap: 'wrap', gap: '12px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <Zap size={20} style={{ color: 'var(--primary)' }} />
              <h3 style={{ margin: 0, fontSize: '18px', color: 'var(--text-bright)' }}>Quick Trade</h3>
            </div>
            
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
              {/* Route switch buttons */}
              <div style={{ display: 'flex', background: 'rgba(255, 255, 255, 0.05)', padding: '2px', borderRadius: '8px', border: '1px solid rgba(255, 255, 255, 0.05)' }}>
                <button
                  onClick={() => {
                    setActiveRouter('openocean');
                    setBuyQuote(null);
                    setSellQuote(null);
                    setRateLimitSwitched(false);
                    setQuoteError('');
                  }}
                  style={{
                    padding: '4px 10px',
                    fontSize: '11px',
                    borderRadius: '6px',
                    background: activeRouter === 'openocean' ? 'var(--primary)' : 'transparent',
                    color: activeRouter === 'openocean' ? '#000' : 'var(--text-muted)',
                    border: 'none',
                    fontWeight: 600,
                    cursor: 'pointer'
                  }}
                >
                  OpenOcean
                </button>
                <button
                  onClick={() => {
                    setActiveRouter('pancake');
                    setBuyQuote(null);
                    setSellQuote(null);
                    setRateLimitSwitched(false);
                    setQuoteError('');
                  }}
                  style={{
                    padding: '4px 10px',
                    fontSize: '11px',
                    borderRadius: '6px',
                    background: activeRouter === 'pancake' ? 'var(--primary)' : 'transparent',
                    color: activeRouter === 'pancake' ? '#000' : 'var(--text-muted)',
                    border: 'none',
                    fontWeight: 600,
                    cursor: 'pointer'
                  }}
                >
                  PancakeSwap
                </button>
              </div>

              {/* Gear settings button */}
              <button
                onClick={() => setShowQuickSettings(!showQuickSettings)}
                style={{
                  background: 'none',
                  border: 'none',
                  color: showQuickSettings ? 'var(--primary)' : 'var(--text-muted)',
                  cursor: 'pointer',
                  padding: '6px',
                  borderRadius: '6px',
                  display: 'flex',
                  alignItems: 'center',
                  background: showQuickSettings ? 'rgba(255,255,255,0.05)' : 'transparent'
                }}
                title="Quick settings"
              >
                <Settings size={16} />
              </button>

              {/* Play/Pause Button */}
              <button
                onClick={() => setIsPollingPaused(!isPollingPaused)}
                style={{
                  background: 'none',
                  border: 'none',
                  color: isPollingPaused ? 'var(--text-muted)' : 'var(--primary)',
                  cursor: 'pointer',
                  padding: '4px',
                  borderRadius: '4px',
                  display: 'flex',
                  alignItems: 'center',
                  background: 'rgba(255,255,255,0.03)'
                }}
                title={isPollingPaused ? 'Resume auto-updates' : 'Pause auto-updates'}
              >
                {isPollingPaused ? <Play size={12} /> : <Pause size={12} />}
              </button>

              {isQuoting ? (
                <span style={{ fontSize: '11px', color: 'var(--primary)', display: 'flex', alignItems: 'center', gap: '4px' }}>
                  <RefreshCw size={11} className="spin-animation" style={{ animation: 'spin 1s linear infinite' }} />
                  Updating...
                </span>
              ) : isPollingPaused ? (
                <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                  Paused
                </span>
              ) : (
                <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                  Sync in {countdown}s
                </span>
              )}
            </div>
          </div>

          {/* Quick Settings Panel */}
          {showQuickSettings && (
            <div className="glass-panel" style={{ padding: '16px', marginBottom: '20px', background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.05)', display: 'flex', flexDirection: 'column', gap: '16px', borderRadius: '12px' }}>
              <div style={{ display: 'flex', gap: '24px', flexWrap: 'wrap' }}>
                
                {/* Slippage tolerance controls */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', flex: 1, minWidth: '200px' }}>
                  <span style={{ fontSize: '12px', color: 'var(--text-muted)', fontWeight: 600 }}>SLIPPAGE TOLERANCE</span>
                  <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
                    {['0.1', '0.5', '1.0'].map(val => (
                      <button
                        key={val}
                        onClick={() => saveConfig({ slippage: val })}
                        style={{
                          padding: '6px 12px',
                          fontSize: '12px',
                          borderRadius: '8px',
                          background: config?.slippage === val ? 'rgba(255,255,255,0.1)' : 'rgba(255,255,255,0.02)',
                          color: config?.slippage === val ? 'var(--primary)' : 'var(--text-muted)',
                          border: config?.slippage === val ? '1px solid var(--primary)' : '1px solid rgba(255,255,255,0.05)',
                          cursor: 'pointer'
                        }}
                      >
                        {val}%
                      </button>
                    ))}
                    <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
                      <input
                        type="number"
                        step="0.1"
                        min="0.1"
                        max="50"
                        value={config?.slippage || '0.5'}
                        onChange={(e) => saveConfig({ slippage: e.target.value })}
                        style={{
                          width: '70px',
                          height: '30px',
                          padding: '0 16px 0 8px',
                          fontSize: '12px',
                          borderRadius: '8px',
                          background: 'rgba(0,0,0,0.2)',
                          border: '1px solid rgba(255,255,255,0.05)',
                          color: '#fff'
                        }}
                      />
                      <span style={{ position: 'absolute', right: '8px', fontSize: '11px', color: 'var(--text-muted)' }}>%</span>
                    </div>
                  </div>
                </div>

                {/* Gas speed settings */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', flex: 1, minWidth: '240px' }}>
                  <span style={{ fontSize: '12px', color: 'var(--text-muted)', fontWeight: 600 }}>TRANSACTION SPEED (GAS PRICE)</span>
                  <div style={{ display: 'flex', gap: '6px' }}>
                    {[
                      { key: '1', label: 'Standard (1 gwei)' },
                      { key: '2', label: 'Fast (2 gwei)' },
                      { key: '3', label: 'Instant (3 gwei)' }
                    ].map(speed => (
                      <button
                        key={speed.key}
                        onClick={() => saveConfig({ gasPrice: speed.key })}
                        style={{
                          padding: '6px 12px',
                          fontSize: '12px',
                          borderRadius: '8px',
                          background: (config?.gasPrice || '1') === speed.key ? 'rgba(255,255,255,0.1)' : 'rgba(255,255,255,0.02)',
                          color: (config?.gasPrice || '1') === speed.key ? 'var(--primary)' : 'var(--text-muted)',
                          border: (config?.gasPrice || '1') === speed.key ? '1px solid var(--primary)' : '1px solid rgba(255,255,255,0.05)',
                          cursor: 'pointer'
                        }}
                      >
                        {speed.label}
                      </button>
                    ))}
                  </div>
                </div>

              </div>
            </div>
          )}

          {/* Status Display */}
          {rateLimitSwitched && (
            <div className="warning-banner" style={{ marginBottom: '16px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px', background: 'rgba(245, 158, 11, 0.1)', border: '1px solid rgba(245, 158, 11, 0.3)', color: '#fcd34d', padding: '10px 14px', borderRadius: '8px', fontSize: '13px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <AlertTriangle size={16} />
                <span>OpenOcean quote limit/connection error. Automatically switched to PancakeSwap RPC.</span>
              </div>
              <button 
                onClick={() => setRateLimitSwitched(false)}
                style={{ background: 'none', border: 'none', color: '#fcd34d', cursor: 'pointer', fontWeight: 'bold', fontSize: '12px' }}
              >
                Dismiss
              </button>
            </div>
          )}
          {(isExecuting || isApproving || execSuccess) && (
            <div className="info-banner" style={{ marginBottom: '16px', display: 'flex', alignItems: 'center', gap: '8px', background: execSuccess ? 'var(--success-glow)' : 'rgba(59, 130, 246, 0.1)', border: execSuccess ? '1px solid rgba(16, 185, 129, 0.3)' : '1px solid rgba(59, 130, 246, 0.3)', color: execSuccess ? '#a7f3d0' : '#93c5fd' }}>
              {execSuccess ? <CheckCircle2 size={16} /> : <RefreshCw size={14} className="spin-animation" style={{ animation: 'spin 1s linear infinite' }} />}
              <span>{execStatus}</span>
            </div>
          )}
          {execError && (
            <div className="error-banner" style={{ marginBottom: '16px', display: 'flex', alignItems: 'center', gap: '8px' }}>
              <AlertTriangle size={16} />
              <span>{execError}</span>
            </div>
          )}
          {quoteError && (
            <div className="warning-banner" style={{ marginBottom: '16px', display: 'flex', alignItems: 'center', gap: '8px', background: 'rgba(245, 158, 11, 0.1)', border: '1px solid rgba(245, 158, 11, 0.3)', color: '#fcd34d', padding: '10px 14px', borderRadius: '8px', fontSize: '13px' }}>
              <AlertTriangle size={16} />
              <span>{quoteError}</span>
            </div>
          )}

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '24px' }}>
            {/* Quick Buy Card */}
            <div style={{ background: 'rgba(255, 255, 255, 0.02)', padding: '20px', borderRadius: '12px', border: '1px solid rgba(255, 255, 255, 0.04)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
                <span style={{ fontSize: '13px', color: 'var(--text-muted)', fontWeight: 600 }}>QUICK BUY ({localBuyPercent}%)</span>
                <span style={{ fontSize: '10px', color: 'var(--primary)', background: 'rgba(243, 186, 47, 0.1)', padding: '2px 6px', borderRadius: '4px', fontWeight: 600 }}>
                  via {activeRouter === 'openocean' ? 'OpenOcean' : 'PancakeSwap'}
                </span>
              </div>
              <div style={{ marginBottom: '20px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px' }}>
                  <span style={{ fontSize: '14px', color: 'var(--text-muted)' }}>Spend Amount:</span>
                  <span style={{ fontSize: '14px', color: 'var(--text-bright)', fontWeight: 700 }}>
                    {displayBuyAmountBnb} BNB <span style={{ fontSize: '12px', color: 'var(--text-muted)', fontWeight: 400 }}>(~${(parseFloat(displayBuyAmountBnb) * bnbPrice).toFixed(2)} USD)</span>
                  </span>
                </div>
                {/* Buy percentage slider */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', marginBottom: '14px', padding: '4px 0' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', color: 'var(--text-muted)' }}>
                    <span>Adjust Buy Amount:</span>
                    <span style={{ color: 'var(--primary)', fontWeight: 600 }}>{localBuyPercent}% of BNB</span>
                  </div>
                  <input 
                    type="range" 
                    min="1" 
                    max="100" 
                    value={localBuyPercent} 
                    onChange={(e) => setLocalBuyPercent(parseInt(e.target.value))}
                    style={{ 
                      width: '100%', 
                      accentColor: 'var(--primary)', 
                      background: 'rgba(255, 255, 255, 0.1)', 
                      height: '6px', 
                      borderRadius: '3px',
                      cursor: 'pointer'
                    }} 
                  />
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px', opacity: isQuoting ? 0.6 : 1, transition: 'opacity 0.2s' }}>
                  <span style={{ fontSize: '14px', color: 'var(--text-muted)' }}>Receive Amount:</span>
                  <span style={{ fontSize: '14px', color: 'var(--primary)', fontWeight: 700 }}>
                    {buyQuote ? parseFloat(ethers.formatUnits(buyQuote.outAmount, token.decimals)).toLocaleString(undefined, { maximumFractionDigits: 4 }) : '0.00'} {token.symbol}
                    {buyQuote && (
                      <span style={{ fontSize: '12px', color: 'var(--text-muted)', fontWeight: 400 }}>
                        {' '}(~${(parseFloat(ethers.formatUnits(buyQuote.outAmount, token.decimals)) * price).toFixed(2)} USD)
                      </span>
                    )}
                  </span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px', opacity: isQuoting ? 0.6 : 1, transition: 'opacity 0.2s' }}>
                  <span style={{ fontSize: '14px', color: 'var(--text-muted)' }}>Est. Gas Fee:</span>
                  <span style={{ fontSize: '14px', color: 'var(--text-muted)' }}>
                    {buyQuote ? `$${((parseFloat(buyQuote.estimatedGas || 150000) * (parseFloat(config?.gasPrice || '1') * 1e-9)) * bnbPrice).toFixed(2)}` : 'N/A'}
                  </span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px' }}>
                  <span style={{ fontSize: '14px', color: 'var(--text-muted)' }}>Token USD Price:</span>
                  <span style={{ fontSize: '14px', color: 'var(--success)', fontWeight: 600 }}>
                    {(() => {
                      const outAmt = buyQuote ? parseFloat(ethers.formatUnits(buyQuote.outAmount, token.decimals)) : 0;
                      const inAmt = parseFloat(displayBuyAmountBnb) || 0;
                      const effectivePrice = (outAmt > 0 && inAmt > 0) ? (inAmt * bnbPrice) / outAmt : price;
                      return `$${effectivePrice >= 0.01 ? effectivePrice.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 }) : effectivePrice.toFixed(6)}`;
                    })()}
                  </span>
                </div>
              </div>
              <button 
                className="btn-primary" 
                onClick={handleQuickBuy}
                disabled={isExecuting || isApproving || !buyQuote || parseFloat(displayBuyAmountBnb) <= 0}
                style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px', height: '42px', borderRadius: '10px' }}
              >
                <ShoppingCart size={16} /> Quick Buy {token.symbol} ({activeRouter === 'openocean' ? 'OpenOcean' : 'PancakeSwap'})
              </button>
              
              {/* Manual Auto-Buy Limit Order */}
              <div style={{ marginTop: '16px', paddingTop: '16px', borderTop: '1px solid rgba(255,255,255,0.05)' }}>
                {activeManualBuyJob ? (
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'rgba(16, 185, 129, 0.1)', padding: '12px', borderRadius: '8px', border: '1px solid rgba(16, 185, 129, 0.2)' }}>
                    <div>
                      <span style={{ fontSize: '11px', color: '#34d399', textTransform: 'uppercase', fontWeight: 600 }}>🟢 Auto-Buy Active</span>
                      <div style={{ fontSize: '15px', fontWeight: 'bold', color: '#fff' }}>Limit: ${activeManualBuyJob.buyTarget}</div>
                    </div>
                    <button className="btn-secondary" onClick={() => removeAutoTradeJob(tokenAddress, activeManualBuyJob.id)} style={{ padding: '6px 12px', fontSize: '12px', borderColor: 'rgba(255,255,255,0.1)' }}>Cancel</button>
                  </div>
                ) : (
                  <div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: '6px' }}>
                      <label style={{ fontSize: '12px', color: 'var(--text-muted)', fontWeight: 600 }}>Auto-Buy at USD Limit</label>
                      <span style={{ fontSize: '10px', color: 'var(--text-muted)' }}>Amount: {localBuyPercent} BNB</span>
                    </div>
                    <div style={{ display: 'flex', gap: '8px' }}>
                      <div style={{ flex: 1, display: 'flex', alignItems: 'center', background: 'var(--bg-darker, rgba(0,0,0,0.2))', borderRadius: '8px', border: '1px solid rgba(255, 255, 255, 0.1)' }}>
                        <span style={{ paddingLeft: '12px', color: 'var(--text-muted)', fontSize: '14px' }}>$</span>
                        <input type="number" style={{ background: 'transparent', border: 'none', color: '#fff', width: '100%', padding: '10px', outline: 'none', fontSize: '14px' }} placeholder="Target Price" value={manualBuyTarget} onChange={(e) => setManualBuyTarget(e.target.value)} />
                      </div>
                      <button className="btn-secondary" onClick={handleSetManualBuy} disabled={!manualBuyTarget || parseFloat(manualBuyTarget) <= 0} style={{ whiteSpace: 'nowrap', padding: '0 16px', borderRadius: '8px' }}>Set Limit</button>
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* Quick Sell Card */}
            <div style={{ background: 'rgba(255, 255, 255, 0.02)', padding: '20px', borderRadius: '12px', border: '1px solid rgba(255, 255, 255, 0.04)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
                <span style={{ fontSize: '13px', color: 'var(--text-muted)', fontWeight: 600 }}>QUICK SELL ({localSellPercent}%)</span>
                <span style={{ fontSize: '10px', color: '#fda4af', background: 'rgba(244, 63, 94, 0.1)', padding: '2px 6px', borderRadius: '4px', fontWeight: 600 }}>
                  via {activeRouter === 'openocean' ? 'OpenOcean' : 'PancakeSwap'}
                </span>
              </div>
              <div style={{ marginBottom: '20px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px' }}>
                  <span style={{ fontSize: '14px', color: 'var(--text-muted)' }}>Sell Amount:</span>
                  <span style={{ fontSize: '14px', color: 'var(--text-bright)', fontWeight: 700 }}>
                    {parseFloat(displaySellAmountToken).toLocaleString(undefined, { maximumFractionDigits: 4 })} {token.symbol}
                    <span style={{ fontSize: '12px', color: 'var(--text-muted)', fontWeight: 400 }}>(~${(parseFloat(displaySellAmountToken) * price).toFixed(2)} USD)</span>
                  </span>
                </div>
                {/* Sell percentage slider */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', marginBottom: '14px', padding: '4px 0' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', color: 'var(--text-muted)' }}>
                    <span>Adjust Sell Amount:</span>
                    <span style={{ color: '#f43f5e', fontWeight: 600 }}>{localSellPercent}% of holdings</span>
                  </div>
                  <input 
                    type="range" 
                    min="1" 
                    max="100" 
                    value={localSellPercent} 
                    onChange={(e) => setLocalSellPercent(parseInt(e.target.value))}
                    style={{ 
                      width: '100%', 
                      accentColor: '#f43f5e', 
                      background: 'rgba(255, 255, 255, 0.1)', 
                      height: '6px', 
                      borderRadius: '3px',
                      cursor: 'pointer'
                    }} 
                  />
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px', opacity: isQuoting ? 0.6 : 1, transition: 'opacity 0.2s' }}>
                  <span style={{ fontSize: '14px', color: 'var(--text-muted)' }}>Receive Amount:</span>
                  <span style={{ fontSize: '14px', color: 'var(--primary)', fontWeight: 700 }}>
                    {sellQuote ? parseFloat(ethers.formatUnits(sellQuote.outAmount, 18)).toFixed(4) : '0.00'} BNB
                    {sellQuote && (
                      <span style={{ fontSize: '12px', color: 'var(--text-muted)', fontWeight: 400 }}>
                        {' '}(~${(parseFloat(ethers.formatUnits(sellQuote.outAmount, 18)) * bnbPrice).toFixed(2)} USD)
                      </span>
                    )}
                  </span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px', opacity: isQuoting ? 0.6 : 1, transition: 'opacity 0.2s' }}>
                  <span style={{ fontSize: '14px', color: 'var(--text-muted)' }}>Est. Gas Fee:</span>
                  <span style={{ fontSize: '14px', color: 'var(--text-muted)' }}>
                    {sellQuote ? `$${((parseFloat(sellQuote.estimatedGas || 150000) * (parseFloat(config?.gasPrice || '1') * 1e-9)) * bnbPrice).toFixed(2)}` : 'N/A'}
                  </span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px' }}>
                  <span style={{ fontSize: '14px', color: 'var(--text-muted)' }}>Token USD Price:</span>
                  <span style={{ fontSize: '14px', color: 'var(--success)', fontWeight: 600 }}>
                    {(() => {
                      const outAmt = sellQuote ? parseFloat(ethers.formatUnits(sellQuote.outAmount, 18)) : 0;
                      const inAmt = parseFloat(displaySellAmountToken) || 0;
                      const effectivePrice = (outAmt > 0 && inAmt > 0) ? (outAmt * bnbPrice) / inAmt : price;
                      return `$${effectivePrice >= 0.01 ? effectivePrice.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 }) : effectivePrice.toFixed(6)}`;
                    })()}
                  </span>
                </div>
              </div>
              {!isApproved ? (
                <button 
                  className="btn-primary" 
                  onClick={handleApprove}
                  disabled={isExecuting || isApproving || !sellQuote || parseFloat(displaySellAmountToken) <= 0}
                  style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px', height: '42px', borderRadius: '10px', background: 'rgba(245, 158, 11, 0.1)', borderColor: 'rgba(245, 158, 11, 0.3)', color: '#fcd34d' }}
                >
                  <CheckCircle2 size={16} /> Approve {token.symbol}
                </button>
              ) : (
                <button 
                  className="btn-primary" 
                  onClick={handleQuickSell}
                  disabled={isExecuting || isApproving || !sellQuote || parseFloat(displaySellAmountToken) <= 0}
                  style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px', height: '42px', borderRadius: '10px', background: 'rgba(244, 63, 94, 0.1)', borderColor: 'rgba(244, 63, 94, 0.3)', color: '#fca5a5' }}
                >
                  <ArrowUpDown size={16} /> Quick Sell {token.symbol} ({activeRouter === 'openocean' ? 'OpenOcean' : 'PancakeSwap'})
                </button>
              )}

              {/* Manual Auto-Sell Limit Order */}
              <div style={{ marginTop: '16px', paddingTop: '16px', borderTop: '1px solid rgba(255,255,255,0.05)' }}>
                {activeManualSellJob ? (
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'var(--bg-darker, rgba(0,0,0,0.2))', padding: '12px', borderRadius: '8px', border: '1px solid rgba(255, 255, 255, 0.05)' }}>
                    <div>
                      <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>Active Auto-Sell ({activeManualSellJob.sellPercent}%)</div>
                      <div style={{ fontSize: '14px', fontWeight: 'bold', color: '#fff', marginTop: '4px' }}>
                        {activeManualSellJob.sellTarget > 0 && <span style={{ color: '#10b981' }}>TP: ${activeManualSellJob.sellTarget}</span>}
                        {activeManualSellJob.sellTarget > 0 && activeManualSellJob.stopLossTarget > 0 && ' | '}
                        {activeManualSellJob.stopLossTarget > 0 && <span style={{ color: '#ef4444' }}>SL: ${activeManualSellJob.stopLossTarget}</span>}
                      </div>
                    </div>
                    <button className="btn-secondary" onClick={() => removeAutoTradeJob(tokenAddress, activeManualSellJob.id)} style={{ padding: '6px 12px', fontSize: '12px', borderColor: 'rgba(255,255,255,0.1)' }}>Cancel</button>
                  </div>
                ) : (
                  <div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: '6px' }}>
                      <label style={{ fontSize: '12px', color: 'var(--text-muted)', fontWeight: 600 }}>Auto-Sell at USD Limit</label>
                      <span style={{ fontSize: '10px', color: 'var(--text-muted)' }}>Amount: {localSellPercent}%</span>
                    </div>
                    <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                      <div style={{ flex: '1 1 45%', display: 'flex', alignItems: 'center', background: 'var(--bg-darker, rgba(0,0,0,0.2))', borderRadius: '8px', border: '1px solid rgba(255, 255, 255, 0.1)' }}>
                        <span style={{ paddingLeft: '12px', color: 'var(--text-muted)', fontSize: '14px' }}>TP $</span>
                        <input type="number" style={{ background: 'transparent', border: 'none', color: '#fff', width: '100%', padding: '10px', outline: 'none', fontSize: '14px' }} placeholder="Take Profit" value={takeProfitTarget} onChange={(e) => setTakeProfitTarget(e.target.value)} />
                      </div>
                      <div style={{ flex: '1 1 45%', display: 'flex', alignItems: 'center', background: 'var(--bg-darker, rgba(0,0,0,0.2))', borderRadius: '8px', border: '1px solid rgba(255, 255, 255, 0.1)' }}>
                        <span style={{ paddingLeft: '12px', color: 'var(--text-muted)', fontSize: '14px' }}>SL $</span>
                        <input type="number" style={{ background: 'transparent', border: 'none', color: '#fff', width: '100%', padding: '10px', outline: 'none', fontSize: '14px' }} placeholder="Stop Loss" value={stopLossTarget} onChange={(e) => setStopLossTarget(e.target.value)} />
                      </div>
                      <button className="btn-secondary" onClick={handleSetManualSell} disabled={(!takeProfitTarget && !stopLossTarget)} style={{ whiteSpace: 'nowrap', padding: '0 16px', borderRadius: '8px', flex: '1 1 100%' }}>Set Limits</button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Auto-Trading & Technicals Panel */}
      {!isBnb && (
        <div className="glass-panel" style={{ padding: '24px', marginBottom: '24px', border: '1px solid rgba(139, 92, 246, 0.3)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '16px', borderBottom: '1px solid rgba(255, 255, 255, 0.05)', paddingBottom: '12px' }}>
            <Zap size={20} style={{ color: '#8b5cf6' }} />
            <h3 style={{ margin: 0, fontSize: '18px', color: 'var(--text-bright)' }}>Auto-Trading Cycle (Mean Reversion)</h3>
          </div>
          
          <div style={{ marginBottom: '20px' }}>
            
            {/* Live S/R Toggle */}
            <div style={{ marginBottom: '16px', padding: '12px', background: 'rgba(0,0,0,0.2)', borderRadius: '8px', border: '1px solid rgba(255,255,255,0.05)' }}>
              <label style={{ display: 'flex', alignItems: 'center', cursor: 'pointer' }}>
                <input 
                  type="checkbox" 
                  checked={isDynamicSR} 
                  onChange={(e) => setIsDynamicSR(e.target.checked)} 
                  disabled={activeCycleJob}
                  style={{ marginRight: '8px' }}
                />
                <span style={{ fontSize: '0.9rem', color: 'rgba(255,255,255,0.8)', fontWeight: 500 }}>Live S/R Tracking (Dynamic Targets)</span>
              </label>
              <div style={{ fontSize: '0.75rem', color: 'rgba(255,255,255,0.5)', marginTop: '4px', marginLeft: '21px', lineHeight: '1.4' }}>
                When enabled, the trading engine will automatically update the support and resistance boundaries every 60 seconds using GeckoTerminal's live OHLCV data.
              </div>
            </div>

            <button 
              className="btn-secondary" 

              disabled={isCalculatingSR || activeCycleJob}
              style={{ width: '100%', display: 'flex', justifyContent: 'center', alignItems: 'center', gap: '8px', height: '42px', borderRadius: '10px' }}
            >
              {isCalculatingSR ? <RefreshCw size={16} className="spin-animation" style={{ animation: 'spin 1s linear infinite' }} /> : <TrendingUp size={16} />}
              {isCalculatingSR ? 'Analyzing...' : 'Calculate 4H Support & Resistance'}
            </button>
            
            {(supportPrice || resistancePrice || activeCycleJob) && (
              <div style={{ display: 'flex', gap: '16px', marginTop: '16px', flexWrap: 'wrap' }}>
                <div style={{ flex: 1, minWidth: '200px', background: activeCycleJob && activeCycleJob.status === 'waiting_buy' ? 'rgba(16, 185, 129, 0.2)' : 'rgba(16, 185, 129, 0.05)', padding: '16px', borderRadius: '12px', border: '1px solid rgba(16, 185, 129, 0.2)' }}>
                  <div style={{ fontSize: '12px', color: '#34d399', marginBottom: '4px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                    {activeCycleJob && activeCycleJob.status === 'waiting_buy' ? '🟢 WAITING TO BUY' : 'Support Target'}
                  </div>
                  <div style={{ fontSize: '24px', fontWeight: '800', color: '#fff', fontFamily: 'var(--font-display)' }}>
                    ${activeCycleJob ? activeCycleJob.buyTarget.toFixed(activeCycleJob.buyTarget >= 0.01 ? 4 : 6) : (supportPrice >= 0.01 ? supportPrice.toFixed(4) : supportPrice.toFixed(6))}
                  </div>
                  <div style={{ marginTop: '8px', fontSize: '13px', color: 'var(--text-muted)' }}>
                    Buy ${activeCycleJob ? activeCycleJob.buyAmount : localBuyPercent} BNB worth
                  </div>
                </div>
                
                <div style={{ flex: 1, minWidth: '200px', background: activeCycleJob && activeCycleJob.status === 'waiting_sell' ? 'rgba(239, 68, 68, 0.2)' : 'rgba(239, 68, 68, 0.05)', padding: '16px', borderRadius: '12px', border: '1px solid rgba(239, 68, 68, 0.2)' }}>
                  <div style={{ fontSize: '12px', color: '#f87171', marginBottom: '4px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                    {activeCycleJob && activeCycleJob.status === 'waiting_sell' ? '🔴 WAITING TO SELL' : 'Resistance Target'}
                  </div>
                  <div style={{ fontSize: '24px', fontWeight: '800', color: '#fff', fontFamily: 'var(--font-display)' }}>
                    ${activeCycleJob ? activeCycleJob.sellTarget.toFixed(activeCycleJob.sellTarget >= 0.01 ? 4 : 6) : (resistancePrice >= 0.01 ? resistancePrice.toFixed(4) : resistancePrice.toFixed(6))}
                  </div>
                  <div style={{ marginTop: '8px', fontSize: '13px', color: 'var(--text-muted)' }}>
                    Sell ${activeCycleJob ? activeCycleJob.sellPercent : localSellPercent}% of holdings
                  </div>
                </div>

                <div style={{ width: '100%', marginTop: '8px' }}>
                  <button 
                    onClick={toggleAutoCycle}
                    style={{ 
                      width: '100%',
                      background: activeCycleJob ? '#3b82f6' : 'rgba(59, 130, 246, 0.1)', 
                      color: activeCycleJob ? '#fff' : '#3b82f6',
                      border: '1px solid rgba(59, 130, 246, 0.3)', 
                      borderRadius: '10px', 
                      padding: '12px', 
                      cursor: 'pointer', 
                      fontSize: '14px', 
                      fontWeight: 'bold', 
                      transition: 'all 0.2s',
                      display: 'flex',
                      justifyContent: 'center',
                      alignItems: 'center',
                      gap: '8px'
                    }}
                  >
                    {activeCycleJob ? <Pause size={16} /> : <Play size={16} />}
                    {activeCycleJob ? 'Stop Trading Cycle' : 'Start Trading Cycle'}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Metrics Row */}
      <div className="metrics-grid" style={{ marginBottom: '24px' }}>
        <div className="glass-panel metric-card">
          <div className="metric-title">Holdings Balance</div>
          <div className="metric-value">
            {parseFloat(token.balance).toLocaleString(undefined, { maximumFractionDigits: 6 })}
          </div>
          <div className="metric-subvalue text-muted">
            Total USD Value: ${holdingsValue.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
          </div>
        </div>

        <div className="glass-panel metric-card">
          <div className="metric-title">Average Buy Price</div>
          <div className="metric-value">
            {pnlData && pnlData.avgCostBasis > 0 
              ? `$${pnlData.avgCostBasis >= 0.01 ? pnlData.avgCostBasis.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 }) : pnlData.avgCostBasis.toFixed(6)}`
              : 'N/A'
            }
          </div>
          <div className="metric-subvalue text-muted">
            Total Swapped Cost: ${pnlData ? pnlData.totalCostUsd.toFixed(2) : '0.00'}
          </div>
        </div>

        <div className={`glass-panel metric-card ${(pnlData?.pnlUsd || 0) >= 0 ? 'gain' : 'loss'}`}>
          <div className="metric-title">Profit / Loss (PnL)</div>
          <div className="metric-value">
            {pnlData ? (
              <>
                {pnlData.pnlUsd >= 0 ? '+' : ''}
                ${pnlData.pnlUsd.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </>
            ) : '$0.00'}
          </div>
          <div className="metric-subvalue">
            {pnlData ? (
              <span className={`badge ${pnlData.pnlUsd >= 0 ? 'badge-gain' : 'badge-loss'}`} style={{ fontSize: '11px' }}>
                {pnlData.pnlUsd >= 0 ? '+' : ''}
                {pnlData.pnlPercent.toFixed(1)}%
              </span>
            ) : null}
            <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
              Gas Fees Paid: ${totalFeesPaidUsd.toFixed(2)}
            </span>
          </div>
        </div>
      </div>

      {/* Transaction History for Token */}
        <div>
          <h3 style={{ marginBottom: '16px' }}>Transaction Trace</h3>
          <div className="glass-panel" style={{ padding: '20px', minHeight: '450px', maxHeight: '450px', overflowY: 'auto' }}>
            {txError && (
              <div className="error-banner" style={{ margin: '0 0 16px 0', fontSize: '12px', display: 'flex', alignItems: 'center', gap: '6px', background: 'rgba(245, 158, 11, 0.1)', border: '1px solid rgba(245, 158, 11, 0.3)', color: '#fcd34d', padding: '8px 12px' }}>
                <AlertTriangle size={14} style={{ flexShrink: 0 }} />
                <span>{txError}</span>
              </div>
            )}
            {tokenTransactions.length === 0 ? (
              <div style={{ textAlign: 'center', padding: '40px 10px', color: 'var(--text-muted)', fontSize: '14px' }}>
                No BEP-20 transfer history or swap history discovered for this token on BSC.
              </div>
            ) : (
              <div className="timeline">
                {tokenTransactions.map((tx, idx) => {
                  const date = new Date(tx.timeStamp * 1000).toLocaleString(undefined, {
                    month: 'short',
                    day: 'numeric',
                    hour: '2-digit',
                    minute: '2-digit'
                  });

                  return (
                    <div key={idx} className="timeline-item" style={{ borderBottom: idx < tokenTransactions.length - 1 ? '1px solid rgba(255,255,255,0.03)' : 'none', paddingBottom: '14px' }}>
                      <div className="timeline-icon-container">
                        <div className={`timeline-icon ${tx.type}`}>
                          {tx.type === 'swap' && <ArrowUpDown size={14} />}
                          {tx.type === 'receive' && <TrendingUp size={14} />}
                          {tx.type === 'send' && <TrendingDown size={14} />}
                        </div>
                      </div>
                      
                      <div className="timeline-content">
                        <div className="timeline-time" style={{ display: 'flex', justifyContent: 'space-between' }}>
                          <span>{date}</span>
                          <a 
                            href={`https://bscscan.com/tx/${tx.hash}`} 
                            target="_blank" 
                            rel="noopener noreferrer" 
                            style={{ color: 'var(--primary)', textDecoration: 'none', display: 'flex', alignItems: 'center', gap: '3px' }}
                          >
                            TX <ExternalLink size={10} />
                          </a>
                        </div>
                        <div className="timeline-desc">{tx.description}</div>
                        {tx.isUserInitiated && (
                          <div className="timeline-fee">
                            <span>Gas paid: {parseFloat(tx.gasFeeBnb).toFixed(5)} BNB (${tx.gasFeeUsd.toFixed(2)})</span>
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>
  );
}
