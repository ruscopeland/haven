import { useEffect, useRef, useState } from 'react';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:8000';

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
  const s = p.toFixed(12).replace(/0+$/, '');
  return `$${s}`;
}

function hitKey(hit) {
  if (hit.symbol) return `sym:${hit.symbol}`;
  if (hit.cmc_id) return `cmc:${hit.cmc_id}`;
  if (hit.contract_address) return `addr:${hit.chain}:${hit.contract_address}`;
  return `name:${hit.display}:${hit.name}`;
}

export default function Screener({ onToggle, selectedTokens, signals = [], sortBy = "vol_24h", setSortBy }) {
  const [searchQuery, setSearchQuery] = useState("");
  const [remoteHits, setRemoteHits] = useState([]);
  const [searching, setSearching] = useState(false);
  const [ensuringKey, setEnsuringKey] = useState(null);
  const [searchError, setSearchError] = useState(null);
  const debounceRef = useRef(null);
  const abortRef = useRef(null);

  const q = searchQuery.trim();
  const qLower = q.toLowerCase();

  const filteredSignals = signals.filter(sig => {
    if (!qLower) return true;
    const sym = sig.symbol.toLowerCase();
    const name = (sig.name || "").toLowerCase();
    const disp = (sig.display_symbol || "").toLowerCase();
    return sym.includes(qLower) || name.includes(qLower) || disp.includes(qLower);
  });

  // Debounced CMC + local typeahead (beyond client-side signal filter)
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (q.length < 2) {
      setRemoteHits([]);
      setSearching(false);
      setSearchError(null);
      return undefined;
    }
    debounceRef.current = setTimeout(async () => {
      if (abortRef.current) abortRef.current.abort();
      const ac = new AbortController();
      abortRef.current = ac;
      setSearching(true);
      setSearchError(null);
      try {
        const res = await fetch(
          `${API_URL}/tokens/search?q=${encodeURIComponent(q)}&limit=12`,
          { signal: ac.signal },
        );
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).detail || res.statusText);
        const data = await res.json();
        setRemoteHits(Array.isArray(data) ? data : []);
      } catch (e) {
        if (e.name === 'AbortError') return;
        setRemoteHits([]);
        setSearchError(e.message || 'Search failed');
      } finally {
        setSearching(false);
      }
    }, 280);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [q]);

  const ensureAndToggle = async (hit) => {
    // Already in our signal list / DB with a slug → toggle like normal
    if (hit.in_db && hit.symbol) {
      const sig = signals.find(s => s.symbol === hit.symbol);
      onToggle({
        symbol: hit.symbol,
        name: hit.display || hit.name || hit.symbol,
        priceChange24h: sig?.price_change_24h ?? 0,
      });
      setSearchQuery('');
      setRemoteHits([]);
      return;
    }

    const key = hitKey(hit);
    setEnsuringKey(key);
    setSearchError(null);
    try {
      const res = await fetch(`${API_URL}/tokens/ensure`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cmc_id: hit.cmc_id || null,
          chain: hit.chain || null,
          contract_address: hit.contract_address || null,
          display: hit.display || null,
          name: hit.name || null,
          cmc_slug: hit.cmc_slug || null,
          cmc_rank: hit.cmc_rank || null,
          market_cap: hit.market_cap || null,
          price: hit.price || null,
          volume_24h: hit.volume_24h || null,
          price_change_24h: hit.price_change_24h || null,
          backfill: true,
          scan_security: true,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.detail || res.statusText || 'Ensure failed');
      if (!data.symbol) throw new Error('Ensure returned no symbol');
      onToggle({
        symbol: data.symbol,
        name: data.display || data.name || data.symbol,
        priceChange24h: 0,
        risk: data.trade_policy || null,
        security: data.security || null,
      });
      setSearchQuery('');
      setRemoteHits([]);
    } catch (e) {
      setSearchError(e.message || 'Could not load token');
    } finally {
      setEnsuringKey(null);
    }
  };

  // Remote hits not already shown as local signal cards
  const signalSyms = new Set(signals.map(s => s.symbol));
  const extraHits = remoteHits.filter(h => !(h.in_db && h.symbol && signalSyms.has(h.symbol)));

  return (
    <div className="screener-sidebar">
      <div className="screener-header">
        <h2>Alpha Screener</h2>
        <div className="screener-search-wrap">
          <input
            type="text"
            className="screener-search"
            placeholder="Search CMC or local tokens…"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
          {searching && <div className="screener-search-hint">Searching CMC…</div>}
          {ensuringKey && <div className="screener-search-hint">Downloading data + security scan…</div>}
          {searchError && <div className="screener-search-err">{searchError}</div>}
        </div>
      </div>

      {q.length >= 2 && extraHits.length > 0 && (
        <div className="screener-typeahead">
          <div className="screener-typeahead-label">
            CMC / not in feed yet — select to download &amp; chart
          </div>
          {extraHits.map((hit) => {
            const key = hitKey(hit);
            const busy = ensuringKey === key;
            const label = hit.display || hit.name || 'Token';
            const chain = hit.chain || '—';
            // cmc_id alone is enough — ensure() resolves contract via CMC detail
            const canLoad = !!(hit.symbol || hit.cmc_id || hit.contract_address);
            return (
              <button
                type="button"
                key={key}
                className="screener-typeahead-row"
                disabled={busy || !canLoad}
                onClick={() => ensureAndToggle(hit)}
                title={canLoad ? 'Load CMC token details and chart history' : 'Cannot load this entry'}
              >
                <div className="screener-typeahead-main">
                  {hit.logo_url ? (
                    <img src={hit.logo_url} alt="" className="screener-typeahead-logo" />
                  ) : (
                    <span className="screener-typeahead-logo placeholder">{label.slice(0, 2)}</span>
                  )}
                  <div style={{ minWidth: 0, textAlign: 'left' }}>
                    <div className="screener-typeahead-title">
                      <b>{label}</b>
                      {hit.cmc_rank != null && <span className="muted">#{hit.cmc_rank}</span>}
                    </div>
                    <div className="muted" style={{ fontSize: 11 }}>
                      {(hit.name && hit.name !== label) ? hit.name + ' · ' : ''}
                      {chain}
                      {hit.in_db ? ' · in DB' : ' · CMC'}
                    </div>
                  </div>
                </div>
                <span className="screener-typeahead-cta">{busy ? '…' : 'Open'}</span>
              </button>
            );
          })}
        </div>
      )}

      <div className="screener-tabs" style={{ flexWrap: 'wrap' }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', fontSize: 12, color: 'var(--text-muted)' }}>
          Sort
          <select
            className="input-control"
            style={{ flex: 1, padding: '6px 10px' }}
            value={sortBy}
            onChange={e => setSortBy(e.target.value)}
          >
            <option value="market_cap">Market Cap</option>
            <option value="mcap_vol">Mkt Cap + Vol</option>
            <option value="vol_24h">24h Volume</option>
            <option value="price_change_24h">24h Performance</option>
          </select>
        </label>
      </div>
      <div style={{ padding: '4px 15px 8px', fontSize: 11, color: 'var(--text-muted)' }}>
        {selectedTokens.length} selected · {filteredSignals.length} shown
        {q.length >= 2 ? ' · typeahead active' : ''}
      </div>
      <div className="screener-list">
        {signals.length === 0 ? (
          <div style={{ padding: 20, textAlign: 'center', color: 'var(--text-muted)' }}>
            <div className="mkt-ticker-empty">Loading scanner…</div>
            <div style={{ fontSize: 11, marginTop: 8 }}>Waiting for live signal feed — or search CMC above</div>
          </div>
        ) : filteredSignals.length === 0 ? (
          <div style={{ padding: 20, textAlign: 'center', color: 'var(--text-muted)' }}>
            No tokens match in the live feed.
            {q.length >= 2 && extraHits.length === 0 && !searching
              ? ' Try another spelling, or wait for CMC results.'
              : ' Check CMC results above if shown.'}
          </div>
        ) : (
          filteredSignals.map((sig) => {
            const isSelected = selectedTokens.some(t => t.symbol === sig.symbol);
            const chg = sig.price_change_24h;
            const chgUp = (chg || 0) >= 0;
            const label = sig.display_symbol || sig.name || sig.symbol.replace(/USDT$/, '');

            let primary;
            if (sortBy === 'market_cap') {
              primary = <span style={{ color: '#fff' }}>{sig.market_cap > 0 ? formatMoney(sig.market_cap) : '—'}</span>;
            } else if (sortBy === 'mcap_vol') {
              primary = (
                <span style={{ color: '#34d399', fontWeight: 'bold' }}>
                  {sig.market_cap > 0 ? (Math.log10(sig.market_cap + 1) + Math.log10(sig.volume_24h + 1)).toFixed(1) : '0.0'}
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
                      {sig.cmc_rank && <span className="flow-label">CMC #{sig.cmc_rank}</span>}
                      <span className="token-live-price" title="Live CoinMarketCap price">
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
                    {sortBy === 'market_cap' ? 'Market Cap'
                      : sortBy === 'mcap_vol' ? 'Mkt+Vol'
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
