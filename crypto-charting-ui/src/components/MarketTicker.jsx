// Landing-page horizontal ticker + multi-select config.
// Real data: /public/ticker-universe + /public/ticker (prices, Binance Alpha logos, sparklines).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { API_URL } from '../authFetch.js';
import Sparkline, { TokenLogo } from './Sparkline.jsx';

const LS_KEY = 'havenLandingTickerSymbols';

function fmtPct(n) {
  if (n == null || Number.isNaN(n)) return '—';
  const s = n >= 0 ? `+${n.toFixed(2)}` : n.toFixed(2);
  return `${s}%`;
}

function fmtPrice(p) {
  if (p == null || p <= 0) return '—';
  if (p >= 1000) return `$${p.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
  if (p >= 1) return `$${p.toFixed(3)}`;
  if (p >= 0.01) return `$${p.toFixed(4)}`;
  return `$${p.toPrecision(3)}`;
}

export default function MarketTicker() {
  const [universe, setUniverse] = useState([]);
  const [selected, setSelected] = useState([]);
  const [quotes, setQuotes] = useState([]);
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [err, setErr] = useState('');
  const panelRef = useRef(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const r = await fetch(`${API_URL}/public/ticker-universe?limit=150`);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const list = await r.json();
        if (!alive) return;
        setUniverse(list);
        const saved = localStorage.getItem(LS_KEY);
        if (saved) {
          try {
            const syms = JSON.parse(saved);
            if (Array.isArray(syms) && syms.length) {
              setSelected(syms.filter(s => list.some(t => t.symbol === s)));
              return;
            }
          } catch { /* fall through */ }
        }
        const checked = list.filter(t => t.default_checked).map(t => t.symbol);
        setSelected(checked.length ? checked : list.slice(0, 10).map(t => t.symbol));
      } catch (e) {
        if (alive) setErr(e.message || 'Failed to load ticker');
      }
    })();
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    if (selected.length) {
      try { localStorage.setItem(LS_KEY, JSON.stringify(selected)); } catch { /* full */ }
    }
  }, [selected]);

  const refreshQuotes = useCallback(async () => {
    if (!selected.length) { setQuotes([]); return; }
    try {
      const r = await fetch(`${API_URL}/public/ticker?symbols=${encodeURIComponent(selected.join(','))}`);
      if (!r.ok) return;
      const data = await r.json();
      setQuotes(data);
      setErr('');
    } catch { /* keep last quotes */ }
  }, [selected]);

  useEffect(() => {
    refreshQuotes();
    const iv = setInterval(refreshQuotes, 30_000);
    return () => clearInterval(iv);
  }, [refreshQuotes]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e) => {
      if (panelRef.current && !panelRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return universe;
    return universe.filter(t =>
      `${t.display} ${t.name || ''} ${t.symbol}`.toLowerCase().includes(q));
  }, [universe, search]);

  const toggle = (symbol) => {
    setSelected(prev => {
      if (prev.includes(symbol)) {
        if (prev.length <= 3) return prev;
        return prev.filter(s => s !== symbol);
      }
      if (prev.length >= 30) return prev;
      return [...prev, symbol];
    });
  };

  const strip = quotes.length ? [...quotes, ...quotes] : [];

  return (
    <div className="mkt-ticker-wrap" ref={panelRef}>
      <div className="mkt-ticker-bar">
        <button
          type="button"
          className="mkt-ticker-config"
          onClick={() => setOpen(o => !o)}
          title="Configure ticker tokens"
        >
          Tokens
        </button>
        <div className="mkt-ticker-track" aria-label="Market ticker">
          {err && !quotes.length ? (
            <span className="mkt-ticker-empty">Ticker unavailable: {err}</span>
          ) : !strip.length ? (
            <span className="mkt-ticker-empty">Loading live prices…</span>
          ) : (
            <div className="mkt-ticker-marquee">
              {strip.map((t, i) => {
                const up = (t.price_change_24h || 0) >= 0;
                return (
                  <span className="mkt-ticker-item" key={`${t.symbol}-${i}`}>
                    <TokenLogo url={t.logo_url} label={t.display} size={18} />
                    <b>{t.display}</b>
                    <span className="mkt-px">{fmtPrice(t.price)}</span>
                    <Sparkline points={t.sparkline} up={up} width={48} height={16} />
                    <span className={up ? 'mkt-up' : 'mkt-down'}>{fmtPct(t.price_change_24h)}</span>
                  </span>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {open && (
        <div className="mkt-ticker-dropdown">
          <div className="mkt-ticker-dd-head">
            <input
              className="input-control mkt-ticker-search"
              placeholder="Search tokens…"
              value={search}
              onChange={e => setSearch(e.target.value)}
              autoFocus
            />
            <span className="mkt-ticker-count">{selected.length} selected</span>
          </div>
          <div className="mkt-ticker-list">
            {filtered.map(t => {
              const checked = selected.includes(t.symbol);
              const up = (t.price_change_24h || 0) >= 0;
              return (
                <label key={t.symbol} className={`mkt-ticker-row${checked ? ' on' : ''}`}>
                  <input type="checkbox" checked={checked} onChange={() => toggle(t.symbol)} />
                  <TokenLogo url={t.logo_url} label={t.display} size={20} />
                  <span className="mkt-ticker-sym">{t.display}</span>
                  <span className="mkt-ticker-name">{t.name || t.symbol}</span>
                  {t.alpha_rank != null && <span className="mkt-ticker-rank">#{t.alpha_rank}</span>}
                  <span className={up ? 'mkt-up' : 'mkt-down'}>{fmtPct(t.price_change_24h)}</span>
                </label>
              );
            })}
            {!filtered.length && (
              <div className="mkt-ticker-empty" style={{ padding: 16 }}>No matches</div>
            )}
          </div>
          <p className="mkt-ticker-hint">
            Defaults mix DeFi and larger alts from our live universe. Uncheck to remove;
            search and check to add. Logos from Binance Alpha; sparklines from Haven 15m history. Saved in this browser.
          </p>
        </div>
      )}
    </div>
  );
}
