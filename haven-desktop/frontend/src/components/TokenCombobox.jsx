import { useState, useEffect, useRef, useMemo } from 'react';
import './TokenCombobox.css';

// Formats a symbol and name nicely (e.g. BTCUSDT -> BTC - Bitcoin)
export const prettySymbol = (sym, name) => {
  if (!sym) return '';
  if (name && name !== sym) return name;
  return sym.replace(/_\d+_bsc$/, '');
};

export default function TokenCombobox({ options, value, onChange }) {
  const [isOpen, setIsOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [favorites, setFavorites] = useState(() => {
    try { return JSON.parse(localStorage.getItem('haven_fav_tokens') || '[]'); } catch { return []; }
  });
  
  const containerRef = useRef(null);
  
  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClick = (e) => {
      if (containerRef.current && !containerRef.current.contains(e.target)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  const toggleFav = (e, sym) => {
    e.stopPropagation();
    setFavorites(prev => {
      const next = prev.includes(sym) ? prev.filter(s => s !== sym) : [...prev, sym];
      localStorage.setItem('haven_fav_tokens', JSON.stringify(next));
      return next;
    });
  };

  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    let favs = [];
    let others = [];
    for (const [sym, name] of options) {
      const p = prettySymbol(sym, name).toLowerCase();
      if (!q || sym.toLowerCase().includes(q) || p.includes(q)) {
        if (favorites.includes(sym)) favs.push([sym, name]);
        else others.push([sym, name]);
      }
    }
    return { favs, others };
  }, [options, search, favorites]);

  const selectedName = useMemo(() => {
    const opt = options.find(o => o[0] === value);
    return opt ? prettySymbol(opt[0], opt[1]) : value;
  }, [options, value]);

  return (
    <div className="token-combo" ref={containerRef}>
      <div 
        className="token-combo-input" 
        onClick={() => setIsOpen(!isOpen)}
        title="Select a specific token to backtest/trade"
      >
        <span>{selectedName || 'Select token...'}</span>
        <span className="combo-arrow">▼</span>
      </div>
      
      {isOpen && (
        <div className="token-combo-dropdown">
          <input
            type="text"
            className="token-combo-search"
            placeholder="Search tokens..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            autoFocus
          />
          <div className="token-combo-list">
            {filtered.favs.length > 0 && (
              <div className="combo-group">
                <div className="combo-group-label">Favorites ⭐</div>
                {filtered.favs.map(([sym, name]) => (
                  <div key={sym} className={`combo-item ${sym === value ? 'selected' : ''}`} onClick={() => { onChange(sym); setIsOpen(false); setSearch(''); }}>
                    <span className="fav-star active" onClick={(e) => toggleFav(e, sym)}>★</span>
                    {prettySymbol(sym, name)}
                  </div>
                ))}
              </div>
            )}
            
            {(filtered.favs.length > 0 && filtered.others.length > 0) && <div className="combo-divider" />}
            
            <div className="combo-group">
              {filtered.favs.length > 0 && <div className="combo-group-label">All Tokens</div>}
              {filtered.others.map(([sym, name]) => (
                <div key={sym} className={`combo-item ${sym === value ? 'selected' : ''}`} onClick={() => { onChange(sym); setIsOpen(false); setSearch(''); }}>
                  <span className="fav-star" onClick={(e) => toggleFav(e, sym)}>☆</span>
                  {prettySymbol(sym, name)}
                </div>
              ))}
              {filtered.favs.length === 0 && filtered.others.length === 0 && (
                <div className="combo-empty">No results found</div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
