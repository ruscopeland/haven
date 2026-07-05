import React, { useState } from 'react';

export default function Screener({ onToggle, selectedTokens, signals = [], sortBy = "flow_1m", setSortBy }) {
  const [searchQuery, setSearchQuery] = useState("");

  const formatMoney = (val) => {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(val);
  };

  const filteredSignals = signals.filter(sig => {
    const q = searchQuery.toLowerCase();
    const sym = sig.symbol.toLowerCase();
    const name = (sig.name || "").toLowerCase();
    return sym.includes(q) || name.includes(q);
  });

  return (
    <div className="screener-sidebar">
      <div className="screener-header">
        <h2>Alpha Screener</h2>
        <input 
          type="text" 
          className="screener-search" 
          placeholder="Search by name or symbol..." 
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
        />
      </div>
      
      <div className="screener-tabs">
        <button className={`screener-tab ${sortBy === 'flow_15m' ? 'active' : ''}`} onClick={() => setSortBy('flow_15m')}>15m Flow</button>
        <button className={`screener-tab ${sortBy === 'vol_spike' ? 'active' : ''}`} onClick={() => setSortBy('vol_spike')}>Vol Spikes</button>
        <button className={`screener-tab ${sortBy === 'vol_24h' ? 'active' : ''}`} onClick={() => setSortBy('vol_24h')}>24h Vol</button>
        <button className={`screener-tab ${sortBy === 'price_change_24h' ? 'active' : ''}`} onClick={() => setSortBy('price_change_24h')}>24h Perf</button>
      </div>
      <div className="screener-list">
        {signals.length === 0 ? (
          <div style={{ padding: 20, textAlign: 'center', color: '#a0a5b8' }}>Loading Scanner...</div>
        ) : (
          filteredSignals.map((sig) => {
            const isPositive = sig.net_flow_15m >= 0;
            const isSelected = selectedTokens.some(t => t.symbol === sig.symbol);
            
            return (
              <div 
                key={sig.symbol} 
                className={`token-card ${isSelected ? 'active' : ''}`}
                onClick={() => onToggle({ 
                  symbol: sig.symbol, 
                  name: sig.name,
                  priceChange24h: sig.price_change_24h
                })}
              >
                <div className="token-checkbox-container">
                  <input 
                    type="checkbox" 
                    className="token-checkbox"
                    checked={isSelected}
                    readOnly
                  />
                  <div className="token-symbol">{sig.name || sig.symbol.replace('USDT', '')}</div>
                </div>
                <div className="token-flow">
                  {sortBy === 'flow_15m' && (
                    <>
                      <span className={isPositive ? 'flow-positive' : 'flow-negative'}>
                        {isPositive ? '+' : ''}{formatMoney(sig.net_flow_15m)}
                      </span>
                      <span className="flow-label">15m Flow</span>
                    </>
                  )}
                  {sortBy === 'vol_spike' && (
                    <>
                      <span style={{ color: '#00ff88', fontWeight: 'bold' }}>
                        {sig.volume_24h > 0 ? (((sig.buy_vol_1h + sig.sell_vol_1h) / (sig.volume_24h / 24)).toFixed(1)) : '0.0'}x
                      </span>
                      <span className="flow-label">Avg 1h Vol</span>
                    </>
                  )}
                  {sortBy === 'vol_24h' && (
                    <>
                      <span style={{ color: '#fff' }}>
                        {formatMoney(sig.volume_24h)}
                      </span>
                      <span className="flow-label">24h Vol</span>
                    </>
                  )}
                  {sortBy === 'price_change_24h' && (
                    <>
                      <span className={sig.price_change_24h >= 0 ? 'flow-positive' : 'flow-negative'}>
                        {sig.price_change_24h >= 0 ? '+' : ''}{sig.price_change_24h?.toFixed(2)}%
                      </span>
                      <span className="flow-label">24h Change</span>
                    </>
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
