import React, { useState, useMemo, useEffect, useRef } from 'react';
import { useWallet } from '../context/WalletContext';
import { Search, ArrowUpDown, TrendingUp, TrendingDown, RefreshCw, Layers, DollarSign, Wallet, AlertTriangle, Star, Zap, Clock, Activity, Bug, XCircle, Info, Globe, Send, FileText, ChevronDown, ChevronUp, ExternalLink } from 'lucide-react';

// Helper to generate a stable, beautiful gradient from token addresses/symbols
const getTokenColor = (address) => {
  if (address === '0x0000000000000000000000000000000000000000') return '#f3ba2f'; // Binance Gold
  const num = parseInt(address.slice(2, 10), 16);
  const hue = num % 360;
  return `hsl(${hue}, 75%, 60%)`;
};

// Format a number as USD
const fmtUSD = (val) => {
  if (val === null || val === undefined) return '$0.00';
  return '$' + val.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};

// Format timestamp to readable datetime
const fmtTime = (tsMs) => {
  if (!tsMs) return '—';
  return new Date(tsMs).toLocaleString(undefined, {
    month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
};

// Truncate hash for display
const truncHash = (hash) => {
  if (!hash) return '—';
  return hash.substring(0, 8) + '...' + hash.substring(hash.length - 6);
};

// Level icon/color map for debug log
const LEVEL_STYLES = {
  DEBUG:       { icon: Bug,       color: '#6b7280', bg: 'rgba(107,114,128,0.1)' },
  ERROR:       { icon: XCircle,   color: '#ef4444', bg: 'rgba(239,68,68,0.1)' },
  TRADE:       { icon: Zap,       color: '#f59e0b', bg: 'rgba(245,158,11,0.1)' },
  INFO:        { icon: Info,      color: '#3b82f6', bg: 'rgba(59,130,246,0.1)' },
  API_REQUEST:  { icon: Send,      color: '#06b6d4', bg: 'rgba(6,182,212,0.1)' },
  API_RESPONSE: { icon: FileText,  color: '#10b981', bg: 'rgba(16,185,129,0.1)' },
};

const SOURCE_COLORS = {
  collector: '#22d3ee',
  engine:    '#f59e0b',
  api:       '#8b5cf6',
  wallet:    '#3b82f6',
};

export default function Dashboard({ onSelectToken, onNavigateToSwap }) {
  const { 
    address, 
    tokens, 
    tokenPrices: walletPrices, 
    priceChanges24h, 
    pnlSummary, 
    isLoading, 
    isRefreshing, 
    refreshWallet,
    txError,
    addCustomToken,
    removeCustomToken,
    customTokens,
    favoriteTokens,
    toggleFavoriteToken,
    // Trading dashboard
    tradingData,
    isTradingLoading,
    debugLogs,
    debugLevelFilters,
    toggleDebugLevel,
    clearDebugLogs,
    resolveSymbol,
    engineSettings,
    updateEngineSettings,
  } = useWallet();

  const [searchQuery, setSearchQuery] = useState('');
  const [sortBy, setSortBy] = useState('value');
  const [sortOrder, setSortOrder] = useState('desc');
  const [showAddForm, setShowAddForm] = useState(false);
  const [showFavoritesOnly, setShowFavoritesOnly] = useState(true);
  const [customTokenAddress, setCustomTokenAddress] = useState('');
  const [isAddingToken, setIsAddingToken] = useState(false);
  const [tokenAddError, setTokenAddError] = useState('');
  const [tokenAddSuccess, setTokenAddSuccess] = useState('');
  
  // Debug log panel collapse
  const [showDebugLog, setShowDebugLog] = useState(true);
  const [debugLogAutoScroll, setDebugLogAutoScroll] = useState(true);
  const [showTokens, setShowTokens] = useState(true);

  const handleAddToken = async (e) => {
    e.preventDefault();
    setTokenAddError('');
    setTokenAddSuccess('');
    if (!customTokenAddress) return;
    setIsAddingToken(true);
    try {
      await addCustomToken(customTokenAddress);
      setTokenAddSuccess('Token added successfully!');
      setCustomTokenAddress('');
      setTimeout(() => setTokenAddSuccess(''), 3000);
      setShowAddForm(false);
    } catch (err) {
      setTokenAddError(err.message || 'Failed to add token.');
    } finally {
      setIsAddingToken(false);
    }
  };

  // ── Portfolio Stats ────────────────────────────────────────────────────
  const portfolioStats = useMemo(() => {
    let totalValueUsd = 0;
    let totalCostUsd = 0;
    let totalPnlUsd = 0;
    tokens.forEach(token => {
      const price = walletPrices[token.address.toLowerCase()] || 0;
      const bal = parseFloat(token.balance);
      const val = bal * price;
      totalValueUsd += val;
      const pnlData = pnlSummary[token.address.toLowerCase()];
      if (pnlData) {
        totalCostUsd += pnlData.totalCostUsd;
        totalPnlUsd += pnlData.pnlUsd;
      } else {
        totalCostUsd += val;
      }
    });
    const netPnlPercent = totalCostUsd > 0 ? (totalPnlUsd / totalCostUsd) * 100 : 0;
    return { totalValueUsd, totalPnlUsd, netPnlPercent };
  }, [tokens, walletPrices, pnlSummary]);

  // ── Trading P&L ─────────────────────────────────────────────────────────
  const tradingStats = useMemo(() => {
    const { trades } = tradingData;
    let totalBuyUsd = 0;
    let totalSellUsd = 0;
    let totalFeesUsd = 0;
    let totalGasUsd = 0;

    trades.forEach(t => {
      // All trading is USD pairs, so execution_price is already USD
      const tradeValIn = (t.amount_in || 0) * (t.execution_price || 0);
      const tradeValOut = (t.amount_out || 0) * (t.execution_price || 0);
      // For BNB trades, amount_in is in BNB — convert using tokenPrices or execution_price
      if (t.direction === 'BUY') {
        totalBuyUsd += (t.amount_in || 0) * (t.execution_price || 1);
      } else {
        totalSellUsd += (t.amount_out || 0) * (t.execution_price || 1);
      }
      totalFeesUsd += (t.fee_amount || 0);
      totalGasUsd += (t.gas_cost_native || 0);
    });

    const tradingPnl = totalSellUsd - totalBuyUsd;
    return {
      totalBuyUsd,
      totalSellUsd,
      tradingPnl,
      totalFeesUsd,
      totalGasUsd,
      tradeCount: trades.length,
      openOrderCount: tradingData.openMarkers.length,
    };
  }, [tradingData]);

  // ── Auto-scroll debug log ───────────────────────────────────────────────
  const debugLogRef = useRef(null);
  useEffect(() => {
    if (debugLogAutoScroll && debugLogRef.current) {
      debugLogRef.current.scrollTop = debugLogRef.current.scrollHeight;
    }
  }, [debugLogs, debugLogAutoScroll]);

  // ── Sort and Filter holdings ────────────────────────────────────────────
  const sortedAndFilteredHoldings = useMemo(() => {
    const query = searchQuery.toLowerCase().trim();
    let list = tokens.filter(token => {
      if (showFavoritesOnly && !favoriteTokens.includes(token.address.toLowerCase())) return false;
      return (
        token.symbol.toLowerCase().includes(query) ||
        token.name.toLowerCase().includes(query) ||
        token.address.toLowerCase().includes(query)
      );
    });
    list.sort((a, b) => {
      const addrA = a.address.toLowerCase();
      const addrB = b.address.toLowerCase();
      const priceA = walletPrices[addrA] || 0;
      const priceB = walletPrices[addrB] || 0;
      const balA = parseFloat(a.balance);
      const balB = parseFloat(b.balance);
      const valA = balA * priceA;
      const valB = balB * priceB;
      const pnlA = pnlSummary[addrA]?.pnlUsd || 0;
      const pnlB = pnlSummary[addrB]?.pnlUsd || 0;
      let compareVal = 0;
      if (sortBy === 'value') compareVal = valA - valB;
      else if (sortBy === 'name') compareVal = a.symbol.localeCompare(b.symbol);
      else if (sortBy === 'pnl') compareVal = pnlA - pnlB;
      return sortOrder === 'asc' ? compareVal : -compareVal;
    });
    return list;
  }, [tokens, searchQuery, sortBy, sortOrder, walletPrices, pnlSummary, showFavoritesOnly, favoriteTokens]);

  // Allocation chart
  const allocationChartData = useMemo(() => {
    if (portfolioStats.totalValueUsd === 0) return [];
    const allocations = tokens.map(token => {
      const price = walletPrices[token.address.toLowerCase()] || 0;
      const val = parseFloat(token.balance) * price;
      const pct = (val / portfolioStats.totalValueUsd) * 100;
      return { symbol: token.symbol, value: val, percentage: pct, color: getTokenColor(token.address) };
    });
    allocations.sort((a, b) => b.value - a.value);
    const threshold = 3;
    const majors = allocations.filter(a => a.percentage >= threshold);
    const minors = allocations.filter(a => a.percentage < threshold);
    if (minors.length > 0) {
      const minorValue = minors.reduce((s, i) => s + i.value, 0);
      const minorPct = minors.reduce((s, i) => s + i.percentage, 0);
      majors.push({ symbol: 'Other', value: minorValue, percentage: minorPct, color: '#6b7280' });
    }
    return majors;
  }, [tokens, walletPrices, portfolioStats.totalValueUsd]);

  const donutElements = useMemo(() => {
    const radius = 50, circ = 2 * Math.PI * radius;
    let acc = 0;
    return allocationChartData.map((item, idx) => {
      const len = (item.percentage / 100) * circ;
      const off = circ - ((acc / 100) * circ);
      acc += item.percentage;
      return (
        <circle key={idx} cx="60" cy="60" r={radius} fill="transparent"
          stroke={item.color} strokeWidth="12"
          strokeDasharray={`${len} ${circ - len}`} strokeDashoffset={off}
          transform="rotate(-90 60 60)"
          style={{ transition: 'stroke-dasharray 0.5s ease' }} />
      );
    });
  }, [allocationChartData]);

  const toggleSort = (field) => {
    if (sortBy === field) setSortOrder(prev => prev === 'asc' ? 'desc' : 'asc');
    else { setSortBy(field); setSortOrder('desc'); }
  };

  if (!address) {
    return (
      <div className="glass-panel" style={{ padding: '48px', textAlign: 'center', maxWidth: '600px', margin: '40px auto' }}>
        <Wallet size={48} className="text-muted" style={{ marginBottom: '16px', opacity: 0.5 }} />
        <h3>No Wallet Connected</h3>
        <p className="form-label" style={{ marginTop: '8px', marginBottom: '24px' }}>
          Please go to the Configuration panel to enter your seed phrase or private key and load your wallet data.
        </p>
      </div>
    );
  }

  return (
    <div>
      {/* ── Portfolio Stats Row ────────────────────────────────────────── */}
      <div className="metrics-grid">
        <div className="glass-panel metric-card">
          <div className="metric-title">Portfolio Net Worth</div>
          <div className="metric-value">{fmtUSD(portfolioStats.totalValueUsd)}</div>
          <div className="metric-subvalue text-muted">BNB and Auto-Discovered Assets</div>
        </div>

        <div className={`glass-panel metric-card ${portfolioStats.totalPnlUsd >= 0 ? 'gain' : 'loss'}`}>
          <div className="metric-title">Wallet Unrealized P/L</div>
          <div className="metric-value">
            {portfolioStats.totalPnlUsd >= 0 ? '+' : ''}{fmtUSD(portfolioStats.totalPnlUsd)}
          </div>
          <div className="metric-subvalue">
            <span className={`badge ${portfolioStats.totalPnlUsd >= 0 ? 'badge-gain' : 'badge-loss'}`}>
              {portfolioStats.totalPnlUsd >= 0 ? <TrendingUp size={12} /> : <TrendingDown size={12} />}
              {portfolioStats.totalPnlUsd >= 0 ? '+' : ''}{portfolioStats.netPnlPercent.toFixed(2)}%
            </span>
            <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}> cost basis</span>
          </div>
        </div>

        <div className={`glass-panel metric-card ${tradingStats.tradingPnl >= 0 ? 'gain' : 'loss'}`}>
          <div className="metric-title">Trading P/L (Realized)</div>
          <div className="metric-value">
            {tradingStats.tradingPnl >= 0 ? '+' : ''}{fmtUSD(tradingStats.tradingPnl)}
          </div>
          <div className="metric-subvalue">
            <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
              {tradingStats.tradeCount} trades · {tradingStats.openOrderCount} open orders
            </span>
            <span style={{ fontSize: '11px', color: 'var(--text-muted)', display: 'block' }}>
              Fees: {fmtUSD(tradingStats.totalFeesUsd)} · Gas: {fmtUSD(tradingStats.totalGasUsd)}
            </span>
          </div>
        </div>

        <div className="glass-panel metric-card" style={{ padding: '20px 24px', display: 'flex', alignItems: 'center', gap: '24px' }}>
          {allocationChartData.length > 0 ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: '16px', width: '100%' }}>
              <svg width="120" height="120" style={{ flexShrink: 0 }}>
                <circle cx="60" cy="60" r="50" fill="transparent" stroke="rgba(255,255,255,0.03)" strokeWidth="12" />
                {donutElements}
              </svg>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', width: '100%', overflow: 'hidden' }}>
                <span className="metric-title" style={{ fontSize: '11px', marginBottom: 0 }}>Asset Allocation</span>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', maxHeight: '70px', overflowY: 'auto' }}>
                  {allocationChartData.map((item, idx) => (
                    <div key={idx} style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '11px' }}>
                      <span style={{ width: '8px', height: '8px', borderRadius: '50%', backgroundColor: item.color, display: 'inline-block' }} />
                      <span style={{ fontWeight: 600, color: 'var(--text-bright)' }}>{item.symbol}</span>
                      <span style={{ color: 'var(--text-muted)' }}>{item.percentage.toFixed(0)}%</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          ) : (
            <div className="text-muted" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <Layers size={18} /> No token allocations to display
            </div>
          )}
        </div>
      </div>

      {txError && (
        <div className="error-banner" style={{ margin: '0 0 24px 0', fontSize: '13px', display: 'flex', alignItems: 'center', gap: '8px', background: 'rgba(245, 158, 11, 0.1)', border: '1px solid rgba(245, 158, 11, 0.3)', color: '#fcd34d' }}>
          <AlertTriangle size={16} style={{ flexShrink: 0 }} />
          <span>{txError}</span>
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '24px', marginBottom: '24px' }}>
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          {/* ── Token Holdings Section ──────────────────────────────────────── */}
          <div className="glass-panel" style={{ padding: '24px' }}>
        <div className="holdings-header">
          <button onClick={() => setShowTokens(!showTokens)} style={{ background: 'none', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '8px', padding: 0, color: 'var(--text-bright)' }}>
            <h3 style={{ margin: 0 }}>Token Assets</h3>
            {showTokens ? <ChevronUp size={18} style={{ color: 'var(--text-muted)' }} /> : <ChevronDown size={18} style={{ color: 'var(--text-muted)' }} />}
          </button>
          <div style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
            <div style={{ display: 'flex', background: 'rgba(255,255,255,0.05)', borderRadius: '8px', padding: '2px' }}>
              <button onClick={() => setShowFavoritesOnly(true)}
                style={{ padding: '6px 16px', fontSize: '12px', fontWeight: 600, border: 'none',
                  background: showFavoritesOnly ? 'var(--primary-gradient)' : 'transparent',
                  color: showFavoritesOnly ? '#fff' : 'var(--text-muted)', borderRadius: '6px', cursor: 'pointer', transition: 'all 0.2s' }}>
                Favorites
              </button>
              <button onClick={() => setShowFavoritesOnly(false)}
                style={{ padding: '6px 16px', fontSize: '12px', fontWeight: 600, border: 'none',
                  background: !showFavoritesOnly ? 'rgba(255,255,255,0.1)' : 'transparent',
                  color: !showFavoritesOnly ? '#fff' : 'var(--text-muted)', borderRadius: '6px', cursor: 'pointer', transition: 'all 0.2s' }}>
                All
              </button>
            </div>
            <button className="btn-secondary" onClick={() => { setShowAddForm(!showAddForm); setTokenAddError(''); setTokenAddSuccess(''); }}
              style={{ padding: '0 12px', height: '36px', fontSize: '13px', borderRadius: '8px', border: showAddForm ? '1px solid var(--primary)' : '' }}>
              {showAddForm ? 'Close' : '+ Add Token'}
            </button>
            <div style={{ position: 'relative' }}>
              <Search size={16} style={{ position: 'absolute', left: '12px', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)' }} />
              <input type="text" className="input-control" placeholder="Search..."
                value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)}
                style={{ padding: '8px 12px 8px 36px', fontSize: '13px', width: '220px', height: '36px' }} />
            </div>
            <button className="btn-secondary" onClick={refreshWallet} disabled={isRefreshing}
              style={{ padding: '0 12px', height: '36px', minWidth: '36px', borderRadius: '8px' }} title="Refresh">
              <RefreshCw size={14} className={isRefreshing ? 'spin-animation' : ''}
                style={{ animation: isRefreshing ? 'spin 1s linear infinite' : 'none' }} />
            </button>
            <style>{`
              @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
            `}</style>
          </div>
        </div>

        {showTokens && showAddForm && (
          <form onSubmit={handleAddToken} className="glass-panel" style={{ padding: '16px', marginBottom: '20px', border: '1px solid rgba(255,255,255,0.05)', background: 'rgba(255,255,255,0.01)', borderRadius: '12px' }}>
            <h4 style={{ margin: '0 0 8px 0', fontSize: '14px' }}>Track Custom BEP-20 Token</h4>
            <p className="form-label" style={{ margin: '0 0 12px 0', fontSize: '12px' }}>Enter the contract address of the BEP-20 token on BNB Chain to track its balance and prices.</p>
            <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
              <input type="text" className="input-control" placeholder="e.g. 0x0e09fabb73bd3ade0a17ecc321fd13a19e81ce82"
                value={customTokenAddress} onChange={(e) => setCustomTokenAddress(e.target.value)}
                style={{ flex: 1, minWidth: '250px', height: '38px', fontSize: '13px' }} required />
              <button type="submit" className="btn-primary" disabled={isAddingToken}
                style={{ height: '38px', padding: '0 20px', fontSize: '13px', borderRadius: '8px' }}>
                {isAddingToken ? 'Verifying...' : 'Add Token'}
              </button>
            </div>
            {tokenAddError && <div className="error-banner" style={{ marginTop: '12px', fontSize: '12px', padding: '8px 12px' }}>{tokenAddError}</div>}
            {tokenAddSuccess && <div className="info-banner" style={{ marginTop: '12px', fontSize: '12px', padding: '8px 12px', background: 'var(--success-glow)', border: '1px solid rgba(16, 185, 129, 0.3)', color: '#a7f3d0' }}>{tokenAddSuccess}</div>}
          </form>
        )}

        {!showTokens ? null : isLoading ? (
          <div className="holdings-grid">
            {[1, 2, 3].map(i => (<div key={i} className="glass-panel holding-row skeleton" style={{ height: '70px', border: 'none' }} />))}
          </div>
        ) : sortedAndFilteredHoldings.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '40px', color: 'var(--text-muted)' }}>No tokens found matching your query.</div>
        ) : (
          <div className="holdings-grid">
            <div className="holding-row" style={{ border: 'none', background: 'transparent', paddingBottom: '4px', fontSize: '12px', color: 'var(--text-muted)', fontWeight: 600 }}>
              <div style={{ cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '4px' }} onClick={() => toggleSort('name')}>ASSET <ArrowUpDown size={12} /></div>
              <div className="hide-mobile">PRICE (USD)</div>
              <div className="hide-mobile">24H Δ</div>
              <div style={{ cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '4px' }} onClick={() => toggleSort('value')}>HOLDINGS <ArrowUpDown size={12} /></div>
              <div style={{ cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '4px', justifyContent: 'flex-end' }} onClick={() => toggleSort('pnl')}>P/L <ArrowUpDown size={12} /></div>
            </div>
            {sortedAndFilteredHoldings.map((token) => {
              const addrLower = token.address.toLowerCase();
              const price = walletPrices[addrLower] || 0;
              const priceChange = priceChanges24h[addrLower] || 0;
              const valUsd = parseFloat(token.balance) * price;
              const pnlData = pnlSummary[addrLower];
              const pnlUsd = pnlData ? pnlData.pnlUsd : 0;
              const pnlPct = pnlData ? pnlData.pnlPercent : 0;
              const hasPnl = !!pnlData;
              return (
                <div key={token.address} className="glass-panel glass-panel-hover holding-row" onClick={() => onSelectToken(token.address)}>
                  <div className="holding-info">
                    <div className="token-icon-placeholder" style={{ background: `linear-gradient(135deg, ${getTokenColor(token.address)} 0%, #1e1e2d 100%)` }}>
                      {token.symbol.substring(0, 3)}
                    </div>
                    <div>
                      <div className="token-symbol">{token.symbol}</div>
                      <div className="token-name">{token.name}</div>
                    </div>
                  </div>
                  <div className="hide-mobile" style={{ fontFamily: 'var(--font-display)', fontWeight: 500, color: 'var(--text-bright)' }}>
                    ${price >= 0.01 ? price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 }) : price.toFixed(6)}
                  </div>
                  <div className="hide-mobile">
                    {priceChange !== 0 ? (
                      <span className={`badge ${priceChange >= 0 ? 'badge-gain' : 'badge-loss'}`} style={{ fontSize: '11px' }}>
                        {priceChange >= 0 ? '+' : ''}{priceChange.toFixed(2)}%
                      </span>
                    ) : (<span style={{ color: 'var(--text-muted)', fontSize: '11px' }}>0.00%</span>)}
                  </div>
                  <div>
                    <div style={{ fontWeight: 600, color: 'var(--text-bright)' }}>{parseFloat(token.balance).toLocaleString(undefined, { maximumFractionDigits: 6 })}</div>
                    <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>{fmtUSD(valUsd)}</div>
                  </div>
                  <div style={{ textAlign: 'right', display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '16px' }}>
                    {hasPnl ? (
                      <div className={`token-pnl ${pnlUsd >= 0 ? 'gain' : 'loss'}`} style={{ color: pnlUsd >= 0 ? 'var(--success)' : 'var(--danger)' }}>
                        <div style={{ fontWeight: 600 }}>{pnlUsd >= 0 ? '+' : ''}{fmtUSD(pnlUsd)}</div>
                        <div style={{ fontSize: '11px', display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '2px' }}>
                          {pnlUsd >= 0 ? <TrendingUp size={10} /> : <TrendingDown size={10} />}{pnlPct.toFixed(1)}%
                        </div>
                      </div>
                    ) : (<span style={{ color: 'var(--text-muted)', fontSize: '12px' }}>Tracing...</span>)}
                    {!showFavoritesOnly && (
                      <div onClick={(e) => { e.stopPropagation(); toggleFavoriteToken(addrLower); }}
                        style={{ cursor: 'pointer', padding: '4px', color: favoriteTokens.includes(addrLower) ? '#fbbf24' : 'var(--text-muted)' }}
                        title={favoriteTokens.includes(addrLower) ? "Remove from Favorites" : "Add to Favorites"}>
                        <Star size={18} fill={favoriteTokens.includes(addrLower) ? '#fbbf24' : 'none'} />
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

        {/* ── Trading Panels ──────────────────────────────────────────── */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
        
        {/* Open Orders */}
        <div className="glass-panel" style={{ padding: '24px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '16px' }}>
            <Clock size={18} style={{ color: '#f59e0b' }} />
            <h3 style={{ margin: 0, fontSize: '16px' }}>Open Orders</h3>
            {engineSettings && (
              <button
                onClick={() => updateEngineSettings({ paused: engineSettings.paused ? 0 : 1 })}
                title={engineSettings.paused
                  ? 'Engine is PAUSED — markers will not execute. Click to resume.'
                  : 'Engine is running — markers execute on cross. Click to pause all trading.'}
                style={{
                  marginLeft: '12px', padding: '4px 12px', fontSize: '11px', fontWeight: 700,
                  borderRadius: '6px', cursor: 'pointer',
                  border: `1px solid ${engineSettings.paused ? '#ff3366' : 'rgba(0,255,136,0.4)'}`,
                  background: engineSettings.paused ? 'rgba(255,51,102,0.15)' : 'rgba(0,255,136,0.08)',
                  color: engineSettings.paused ? '#ff3366' : '#00ff88',
                }}
              >
                {engineSettings.paused ? '⏸ ENGINE PAUSED' : '● ENGINE LIVE'}
              </button>
            )}
            <span className="badge" style={{ background: 'rgba(245,158,11,0.15)', color: '#f59e0b', marginLeft: 'auto', fontSize: '11px' }}>
              {tradingData.openMarkers.length} active
            </span>
          </div>
          {tradingData.openMarkers.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '30px', color: 'var(--text-muted)', fontSize: '13px' }}>
              No open orders. Place markers on the chart to create orders.
            </div>
          ) : (
            <div style={{ maxHeight: '360px', overflowY: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px' }}>
                <thead>
                  <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.05)', color: 'var(--text-muted)', textAlign: 'left' }}>
                    <th style={{ padding: '8px 6px', fontWeight: 600 }}>Symbol</th>
                    <th style={{ padding: '8px 6px', fontWeight: 600 }}>Type</th>
                    <th style={{ padding: '8px 6px', fontWeight: 600 }}>Trigger</th>
                    <th style={{ padding: '8px 6px', fontWeight: 600 }}>Current</th>
                    <th style={{ padding: '8px 6px', fontWeight: 600 }}>Direction</th>
                    <th style={{ padding: '8px 6px', fontWeight: 600 }}>Created</th>
                  </tr>
                </thead>
                <tbody>
                  {tradingData.openMarkers.map(m => {
                    const currentPrice = tradingData.tokenPrices[m.symbol] || m.price;
                    return (
                      <tr key={m.id} style={{ borderBottom: '1px solid rgba(255,255,255,0.02)' }}>
                        <td style={{ padding: '8px 6px', fontWeight: 600, color: 'var(--text-bright)' }} title={m.symbol}>{resolveSymbol(m.symbol)}</td>
                        <td style={{ padding: '8px 6px' }}>
                          <span style={{ 
                            padding: '2px 8px', borderRadius: '4px', fontSize: '10px', fontWeight: 600,
                            background: m.marker_type.includes('BUY') || m.marker_type === 'DCA_ENTRY' ? 'rgba(0,255,136,0.1)' :
                                         m.marker_type.includes('SELL') || m.marker_type === 'SL' ? 'rgba(255,51,102,0.1)' :
                                         m.marker_type === 'TP' ? 'rgba(0,255,136,0.1)' : 'rgba(251,191,36,0.1)',
                            color: m.marker_type.includes('BUY') || m.marker_type === 'DCA_ENTRY' || m.marker_type === 'TP' ? '#00ff88' :
                                   m.marker_type.includes('SELL') || m.marker_type === 'SL' ? '#ff3366' : '#fbbf24',
                          }}>
                            {m.marker_type.replace('_', ' ')}
                          </span>
                        </td>
                        <td style={{ padding: '8px 6px', fontFamily: 'var(--font-display)' }}>${m.price.toFixed(8)}</td>
                        <td style={{ padding: '8px 6px', fontFamily: 'var(--font-display)', color: currentPrice >= m.price ? '#00ff88' : '#ff3366' }}>
                          ${currentPrice.toFixed(8)}
                        </td>
                        <td style={{ padding: '8px 6px', color: 'var(--text-muted)' }}>{m.direction || '—'}</td>
                        <td style={{ padding: '8px 6px', color: 'var(--text-muted)', fontSize: '11px' }}>{fmtTime(m.created_at)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Trade History */}
        <div className="glass-panel" style={{ padding: '24px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '16px' }}>
            <Activity size={18} style={{ color: '#3b82f6' }} />
            <h3 style={{ margin: 0, fontSize: '16px' }}>Trade History</h3>
            <span className="badge" style={{ background: 'rgba(59,130,246,0.15)', color: '#3b82f6', marginLeft: 'auto', fontSize: '11px' }}>
              {tradingData.trades.length} trades
            </span>
          </div>
          {tradingData.trades.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '30px', color: 'var(--text-muted)', fontSize: '13px' }}>
              No trades executed yet. Trades appear here when a chart marker is crossed and the wallet executes the swap.
            </div>
          ) : (
            <div style={{ maxHeight: '360px', overflowY: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px' }}>
                <thead>
                  <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.05)', color: 'var(--text-muted)', textAlign: 'left' }}>
                    <th style={{ padding: '8px 6px', fontWeight: 600 }}>Time</th>
                    <th style={{ padding: '8px 6px', fontWeight: 600 }}>Symbol</th>
                    <th style={{ padding: '8px 6px', fontWeight: 600 }}>B/S</th>
                    <th style={{ padding: '8px 6px', fontWeight: 600 }}>Reason</th>
                    <th style={{ padding: '8px 6px', fontWeight: 600 }}>Price</th>
                    <th style={{ padding: '8px 6px', fontWeight: 600 }}>Fees</th>
                    <th style={{ padding: '8px 6px', fontWeight: 600 }}>Tx</th>
                  </tr>
                </thead>
                <tbody>
                  {tradingData.trades.slice(0, 50).map(t => (
                    <tr key={t.id} style={{ borderBottom: '1px solid rgba(255,255,255,0.02)' }}>
                      <td style={{ padding: '8px 6px', color: 'var(--text-muted)', fontSize: '11px' }}>
                        {fmtTime(t.block_time ? t.block_time * 1000 : null)}
                      </td>
                      <td style={{ padding: '8px 6px', fontWeight: 600, color: 'var(--text-bright)' }} title={t.symbol}>{resolveSymbol(t.symbol)}</td>
                      <td style={{ padding: '8px 6px' }}>
                        <span style={{
                          padding: '2px 6px', borderRadius: '4px', fontSize: '10px', fontWeight: 700,
                          background: t.direction === 'BUY' ? 'rgba(0,255,136,0.1)' : 'rgba(255,51,102,0.1)',
                          color: t.direction === 'BUY' ? '#00ff88' : '#ff3366',
                        }}>{t.direction}</span>
                      </td>
                      <td style={{ padding: '8px 6px' }}>
                        <span style={{
                          padding: '2px 6px', borderRadius: '4px', fontSize: '10px',
                          background: 'rgba(139,92,246,0.1)', color: '#a78bfa',
                        }}>
                          {t.reason ? t.reason.replace('_', ' ') : 'manual'}
                          {t.reason_label ? ` (${t.reason_label})` : ''}
                        </span>
                      </td>
                      <td style={{ padding: '8px 6px', fontFamily: 'var(--font-display)', fontSize: '11px' }}>
                        <div style={{ color: 'var(--text-bright)' }}>${(t.execution_price || 0).toFixed(8)}</div>
                        {t.expected_price && t.expected_price !== t.execution_price && (
                          <div style={{ color: 'var(--text-muted)', fontSize: '10px' }}>
                            exp: ${t.expected_price.toFixed(8)}
                          </div>
                        )}
                      </td>
                      <td style={{ padding: '8px 6px', fontSize: '11px', color: 'var(--text-muted)' }}>
                        ${((t.fee_amount || 0) + (t.gas_cost_native || 0)).toFixed(4)}
                      </td>
                      <td style={{ padding: '8px 6px' }}>
                        {t.tx_hash ? (
                          <a href={`https://bscscan.com/tx/${t.tx_hash}`} target="_blank" rel="noopener noreferrer"
                            style={{ color: 'var(--primary)', textDecoration: 'none', fontSize: '11px', display: 'flex', alignItems: 'center', gap: '2px' }}>
                            {truncHash(t.tx_hash)} <ExternalLink size={10} />
                          </a>
                        ) : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
        </div>
      </div>

      {/* ── Debug Log Panel ─────────────────────────────────────────────── */}
      <div className="glass-panel" style={{ padding: '16px 24px', marginBottom: '24px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', cursor: 'pointer' }}
          onClick={() => setShowDebugLog(!showDebugLog)}>
          <Bug size={16} style={{ color: '#6b7280' }} />
          <h3 style={{ margin: 0, fontSize: '15px', flex: 1 }}>System Debug Log</h3>
          
          {/* Level toggle buttons */}
          <div style={{ display: 'flex', gap: '4px' }} onClick={e => e.stopPropagation()}>
            {Object.entries(LEVEL_STYLES).map(([level, style]) => {
              const Icon = style.icon;
              const isOn = debugLevelFilters[level];
              return (
                <button key={level}
                  onClick={() => toggleDebugLevel(level)}
                  title={`${level}: ${isOn ? 'ON' : 'OFF'}`}
                  style={{
                    display: 'flex', alignItems: 'center', gap: '4px',
                    padding: '4px 10px', borderRadius: '6px', border: 'none', cursor: 'pointer',
                    fontSize: '10px', fontWeight: 600, transition: 'all 0.15s',
                    background: isOn ? style.bg : 'rgba(255,255,255,0.02)',
                    color: isOn ? style.color : 'rgba(255,255,255,0.2)',
                    border: `1px solid ${isOn ? style.color : 'rgba(255,255,255,0.05)'}`,
                  }}>
                  <Icon size={12} />
                  {level.replace('_', ' ')}
                </button>
              );
            })}
          </div>

          {/* Clear + collapse */}
          <button onClick={(e) => { e.stopPropagation(); clearDebugLogs(); }}
            style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', padding: '4px', fontSize: '11px' }}
            title="Clear logs">Clear</button>
          <button onClick={(e) => { e.stopPropagation(); setDebugLogAutoScroll(!debugLogAutoScroll); }}
            style={{ background: 'none', border: 'none', color: debugLogAutoScroll ? 'var(--primary)' : 'var(--text-muted)', cursor: 'pointer', padding: '4px', fontSize: '11px' }}
            title={debugLogAutoScroll ? 'Auto-scroll ON' : 'Auto-scroll OFF'}>Auto</button>
          {showDebugLog ? <ChevronUp size={16} style={{ color: 'var(--text-muted)' }} /> : <ChevronDown size={16} style={{ color: 'var(--text-muted)' }} />}
        </div>

        {/* Source legend */}
        <div style={{ display: 'flex', gap: '16px', marginTop: showDebugLog ? '8px' : '0', fontSize: '10px', color: 'var(--text-muted)' }}>
          {Object.entries(SOURCE_COLORS).map(([src, color]) => (
            <span key={src} style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
              <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: color, display: 'inline-block' }} />
              {src}
            </span>
          ))}
          <span style={{ marginLeft: 'auto' }}>{debugLogs.length} entries</span>
        </div>

        {showDebugLog && (
          <div style={{
            marginTop: '12px', maxHeight: '300px', overflowY: 'auto',
            background: 'rgba(0,0,0,0.3)', borderRadius: '8px', padding: '12px',
            fontFamily: '"JetBrains Mono", "Fira Code", monospace', fontSize: '11px',
            lineHeight: '1.6',
          }} ref={debugLogRef}>
            {debugLogs.length === 0 ? (
              <div style={{ color: 'var(--text-muted)', textAlign: 'center', padding: '20px' }}>
                No log entries yet. Toggle levels above to start streaming.
              </div>
            ) : (
              debugLogs.map(entry => {
                const levelStyle = LEVEL_STYLES[entry.level] || LEVEL_STYLES.DEBUG;
                const LevelIcon = levelStyle.icon;
                const sourceColor = SOURCE_COLORS[entry.source] || '#6b7280';
                return (
                  <div key={entry.id} style={{
                    display: 'flex', gap: '8px', padding: '2px 0',
                    borderBottom: '1px solid rgba(255,255,255,0.01)',
                  }}>
                    <span style={{ color: 'var(--text-muted)', fontSize: '10px', whiteSpace: 'nowrap', minWidth: '70px' }}>
                      {new Date(entry.timestamp).toLocaleTimeString()}
                    </span>
                    <span style={{ color: sourceColor, fontWeight: 600, whiteSpace: 'nowrap', minWidth: '70px', fontSize: '10px' }}>
                      [{entry.source}]
                    </span>
                    <span style={{ color: levelStyle.color, fontWeight: 600, whiteSpace: 'nowrap', minWidth: '70px', fontSize: '10px', display: 'flex', alignItems: 'center', gap: '2px' }}>
                      <LevelIcon size={10} />{entry.level}
                    </span>
                    <span style={{ color: 'var(--text-bright)', wordBreak: 'break-all' }}>
                      {entry.message}
                    </span>
                  </div>
                );
              })
            )}

          </div>
        )}
      </div>

    </div>
  );
}
