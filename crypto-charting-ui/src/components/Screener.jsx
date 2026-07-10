import React, { useState } from 'react';

function formatMoney(val) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(val);
}

// Compact live price for the screener list (handles micro-caps and large prices).
function formatScreenerPrice(p) {
  if (p == null || !(p > 0) || Number.isNaN(p)) return '—';
  if (p >= 1000) return `$${p.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
  if (p >= 1) return `$${p.toFixed(3)}`;
  if (p >= 0.01) return `$${p.toFixed(4)}`;
  if (p >= 0.0001) return `$${p.toFixed(6)}`;
  // micro: 0.0₄123 style not needed — scientific-ish compact
  const s = p.toFixed(12).replace(/0+$/, '');
  return `$${s}`;
}

export default function Screener({ onToggle, selectedTokens, signals = [], sortBy = "flow_1m", setSortBy }) {
  const [searchQuery, setSearchQuery] = useState("");

  const filteredSignals = signals.filter(sig => {
    const q = searchQuery.toLowerCase();
    const sym = sig.symbol.toLowerCase();
    const name = (sig.name || "").toLowerCase();
    const disp = (sig.display_symbol || "").toLowerCase();
    return sym.includes(q) || name.includes(q) || disp.includes(q);
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

      <div className="screener-tabs" style={{ flexWrap: 'wrap' }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', fontSize: 12, color: 'var(--text-muted)' }}>
          Sort
          <select
            className="input-control"
            style={{ flex: 1, padding: '6px 10px' }}
            value={sortBy}
            onChange={e => setSortBy(e.target.value)}
          >
            <option value="flow_15m">15m Flow</option>
            <option value="market_cap">Market Cap</option>
            <option value="mcap_vol">Mkt Cap + Vol</option>
            <option value="vol_spike">Vol Spikes</option>
            <option value="vol_24h">24h Volume</option>
            <option value="price_change_24h">24h Performance</option>
          </select>
        </label>
      </div>
      <div style={{ padding: '4px 15px 8px', fontSize: 11, color: 'var(--text-muted)' }}>
        {selectedTokens.length} selected · {filteredSignals.length} shown
      </div>
      <div className="screener-list">
        {signals.length === 0 ? (
          <div style={{ padding: 20, textAlign: 'center', color: 'var(--text-muted)' }}>
            <div className="mkt-ticker-empty">Loading scanner…</div>
            <div style={{ fontSize: 11, marginTop: 8 }}>Waiting for live signal feed</div>
          </div>
        ) : filteredSignals.length === 0 ? (
          <div style={{ padding: 20, textAlign: 'center', color: 'var(--text-muted)' }}>No tokens match your search</div>
        ) : (
          filteredSignals.map((sig) => {
            const isPositive = sig.net_flow_15m >= 0;
            const isSelected = selectedTokens.some(t => t.symbol === sig.symbol);
            const chg = sig.price_change_24h;
            const chgUp = (chg || 0) >= 0;
            const label = sig.display_symbol || sig.name || sig.symbol.replace(/USDT$/, '');

            let primary = null;
            if (sortBy === 'flow_15m') {
              primary = (
                <span className={isPositive ? 'flow-positive' : 'flow-negative'}>
                  {isPositive ? '+' : ''}{formatMoney(sig.net_flow_15m)}
                </span>
              );
            } else if (sortBy === 'market_cap') {
              primary = <span style={{ color: '#fff' }}>{sig.market_cap > 0 ? formatMoney(sig.market_cap) : '—'}</span>;
            } else if (sortBy === 'mcap_vol') {
              primary = (
                <span style={{ color: '#34d399', fontWeight: 'bold' }}>
                  {sig.market_cap > 0 ? (Math.log10(sig.market_cap + 1) + Math.log10(sig.volume_24h + 1)).toFixed(1) : '0.0'}
                </span>
              );
            } else if (sortBy === 'vol_spike') {
              primary = (
                <span style={{ color: '#34d399', fontWeight: 'bold' }}>
                  {sig.volume_24h > 0 ? (((sig.buy_vol_1h + sig.sell_vol_1h) / (sig.volume_24h / 24)).toFixed(1)) : '0.0'}x
                </span>
              );
            } else if (sortBy === 'vol_24h') {
              primary = <span style={{ color: '#fff' }}>{formatMoney(sig.volume_24h)}</span>;
            } else {
              primary = (
                <span className={chgUp ? 'flow-positive' : 'flow-negative'}>
                  {chgUp ? '+' : ''}{chg?.toFixed(2)}%
                </span>
              );
            }

            return (
              <div
                key={sig.symbol}
                className={`token-card ${isSelected ? 'active' : ''}`}
                onClick={() => onToggle({
                  symbol: sig.symbol,
                  name: sig.name || label,
                  priceChange24h: sig.price_change_24h
                })}
              >
                <div className="token-checkbox-container">
                  <input type="checkbox" className="token-checkbox" checked={isSelected} readOnly />
                  <div style={{ minWidth: 0 }}>
                    <div className="token-symbol-row">
                      <span className="token-symbol">{label}</span>
                      <span className="token-live-price" title="Live collector price">
                        {formatScreenerPrice(sig.last_price)}
                      </span>
                    </div>
                    {sortBy !== 'price_change_24h' && (
                      <div style={{ fontSize: 11, color: chgUp ? '#34d399' : '#fb7185', fontVariantNumeric: 'tabular-nums' }}>
                        {chg == null ? '—' : `${chgUp ? '+' : ''}${Number(chg).toFixed(2)}%`} 24h
                      </div>
                    )}
                  </div>
                </div>
                <div className="token-flow">
                  {primary}
                  <span className="flow-label">
                    {sortBy === 'flow_15m' ? '15m Flow'
                      : sortBy === 'market_cap' ? 'Market Cap'
                      : sortBy === 'mcap_vol' ? 'Mkt+Vol'
                      : sortBy === 'vol_spike' ? 'Vol spike'
                      : sortBy === 'vol_24h' ? '24h Vol'
                      : '24h Change'}
                  </span>
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
