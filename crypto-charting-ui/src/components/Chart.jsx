import { useEffect, useRef, useState, useCallback } from 'react';
import { createChart, ColorType, CandlestickSeries, HistogramSeries } from 'lightweight-charts';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:8000';
const LIVE_POLL_MS = 3000;   // forming-bar poll — replaced the Binance kline WS (M4)

// Chain registry (GET /chains) — fetched once per app, drives the chain badge
// and explorer links. Failure is harmless: the badge simply doesn't render.
let chainsPromise = null;
function fetchChains() {
  if (!chainsPromise) {
    chainsPromise = fetch(`${API_URL}/chains`).then(r => r.json()).catch(() => []);
  }
  return chainsPromise;
}

// Marker type → visual style mapping. Only these appear in the placement
// popup — hand-placeable types.
const MARKER_STYLES = {
  BUY_GRID:  { color: '#00ff88', lineStyle: 2, label: 'BUY' },
  SELL_GRID: { color: '#ff3366', lineStyle: 2, label: 'SELL' },
  TP:        { color: '#00ff88', lineStyle: 0, label: 'TP' },
  SL:        { color: '#ff3366', lineStyle: 0, label: 'SL' },
  DCA_ENTRY: { color: '#22d3ee', lineStyle: 3, label: 'DCA' },
  ALERT:     { color: '#fbbf24', lineStyle: 2, label: 'ALERT' },
};

// System-placed types (strategy runner) — rendered if seen, but deliberately
// NOT in MARKER_STYLES: they are immediate-fire orders and must never be
// placeable from the popup.
const SYSTEM_MARKER_STYLES = {
  STRAT_BUY:  { color: '#3388ff', lineStyle: 2, label: 'S-BUY' },
  STRAT_SELL: { color: '#3388ff', lineStyle: 2, label: 'S-SELL' },
};

function getMarkerStyle(type) {
  return MARKER_STYLES[type] || SYSTEM_MARKER_STYLES[type]
    || { color: '#a0a5b8', lineStyle: 2, label: '?' };
}

export const formatPriceString = (p) => {
  if (p === null || p === undefined) return 'Loading...';
  if (p === 0) return '0.00';
  if (p >= 1) {
    if (p >= 100) return p.toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2});
    return p.toLocaleString('en-US', {minimumFractionDigits: 3, maximumFractionDigits: 3});
  }
  
  const str = p.toFixed(20).replace(/0+$/, ''); 
  const match = str.match(/^0\.0*/);
  if (!match) return p.toString();
  
  const leadingZeros = match[0].length - 2; 
  const sigStr = str.substring(match[0].length, match[0].length + 3).padEnd(3, '0');
  
  const toUnicodeSubscript = (num) => {
    const map = ['\u2080', '\u2081', '\u2082', '\u2083', '\u2084', '\u2085', '\u2086', '\u2087', '\u2088', '\u2089'];
    return num.toString().split('').map(d => map[parseInt(d)]).join('');
  };
  
  if (leadingZeros >= 4) {
    return '0.0' + toUnicodeSubscript(leadingZeros) + sigStr;
  } else {
    return '0.' + '0'.repeat(leadingZeros) + sigStr;
  }
};

export default function Chart({ token, onClose, onIntervalChange, signals = [], onOpenSwap, onOpenToken }) {
  const symbol = token?.symbol;
  const name = token?.name;
  const interval = token?.interval || '5m';

  const chartContainerRef = useRef(null);
  const chartRef = useRef(null);
  const seriesRef = useRef(null);
  const volumeSeriesRef = useRef(null);
  const priceLinesRef = useRef([]);       // active priceline refs for cleanup
  const markersRef = useRef([]);           // mirror markers state for use in closures
  const [loading, setLoading] = useState(false);
  const [livePrice, setLivePrice] = useState(null);
  const [tokenInfo, setTokenInfo] = useState(null);   // /tokens/{symbol} row
  const [chainInfo, setChainInfo] = useState(null);   // matching /chains entry
  const [cachedSignal, setCachedSignal] = useState(null);
  const [showMarkerMenu, setShowMarkerMenu] = useState(false);
  const [clickedPrice, setClickedPrice] = useState(null);
  const [markerAmount, setMarkerAmount] = useState('');
  const [tpPrice, setTpPrice] = useState('');       // optional bracket take-profit
  const [slPrice, setSlPrice] = useState('');       // optional bracket stop-loss
  const [gridCount, setGridCount] = useState('');   // grid: number of lines
  const [gridTo, setGridTo] = useState('');         // grid: opposite bound price
  const [markers, setMarkers] = useState([]);      // active markers from API
  const [trades, setTrades] = useState([]);        // trade history for this symbol

  useEffect(() => {
    const s = signals.find(s => s.symbol === symbol);
    if (s) setCachedSignal(s);
  }, [signals, symbol]);

  // Compute the live percentages using the cached signal
  const liveSignal = cachedSignal;
  let buy5mPct = 0;
  let sell5mPct = 0;
  let buy1hPct = 0;
  let sell1hPct = 0;
  
  if (liveSignal && liveSignal.volume_24h > 0) {
    buy5mPct = (liveSignal.buy_vol_5m / liveSignal.volume_24h) * 100;
    sell5mPct = (Math.abs(liveSignal.sell_vol_5m) / liveSignal.volume_24h) * 100;
    buy1hPct = (liveSignal.buy_vol_1h / liveSignal.volume_24h) * 100;
    sell1hPct = (Math.abs(liveSignal.sell_vol_1h) / liveSignal.volume_24h) * 100;
  }

  // Use live priceChange24h if available, otherwise fallback to token state
  const priceChange24h = liveSignal ? liveSignal.price_change_24h : token?.priceChange24h;

  // ── Fetch markers + trades ───────────────────────────────────────────
  const loadMarkers = useCallback(async () => {
    if (!symbol) return;
    try {
      const [markerRes, tradeRes] = await Promise.all([
        fetch(`${API_URL}/markers/${symbol}?active_only=true`),
        // FILLED only — strategy dry-run PAPER rows must not draw BOUGHT/SOLD lines
        fetch(`${API_URL}/trades?symbol=${symbol}&limit=50&status=FILLED`),
      ]);
      const markerData = await markerRes.json();
      const tradeData = await tradeRes.json();
      setMarkers(Array.isArray(markerData) ? markerData : []);
      setTrades(Array.isArray(tradeData) ? tradeData : []);
    } catch (err) {
      console.error("Failed to load markers/trades", err);
    }
  }, [symbol]);

  // ── Create marker via API ───────────────────────────────────────────
  // Post a single marker. opts may carry { tp, sl } to attach a bracket to a BUY
  // entry (the engine spawns linked TP/SL sell legs when the entry fills) and
  // { skipReload } to batch grid placement. Returns true on success.
  const postMarker = useCallback(async (price, markerType, usdAmount = '', opts = {}) => {
    if (!symbol) return false;
    // Store the user's USD notional untouched. The execution engine converts it
    // to BNB/token size at fire time — storing a converted token quantity here
    // drifted from user intent when price moved between placement and fill.
    const meta = {};
    const usd = parseFloat(usdAmount);
    if (usd > 0) meta.usd = usd;
    const isBuy = markerType === 'BUY_GRID' || markerType === 'DCA_ENTRY';
    if (isBuy) {
      const tp = parseFloat(opts.tp);
      const sl = parseFloat(opts.sl);
      if (tp > 0) meta.tp = tp;
      if (sl > 0) meta.sl = sl;
    }
    try {
      const res = await fetch(`${API_URL}/markers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          symbol,
          price,
          marker_type: markerType,
          label: opts.label || '',
          direction: isBuy ? 'below' : 'above',
          metadata_json: Object.keys(meta).length ? JSON.stringify(meta) : null,
        }),
      });
      if (!opts.skipReload) await loadMarkers();
      return res.ok;
    } catch (err) {
      console.error("Failed to create marker", err);
      return false;
    }
  }, [symbol, loadMarkers]);

  // Place N evenly-spaced markers of one type between two prices in one action.
  const createGrid = useCallback(async (priceA, priceB, count, markerType, usdPerLine, opts = {}) => {
    const n = Math.max(2, Math.min(50, parseInt(count, 10) || 0));
    const hi = Math.max(priceA, priceB);
    const lo = Math.min(priceA, priceB);
    if (!(hi > lo) || n < 2) return;
    const step = (hi - lo) / (n - 1);
    for (let i = 0; i < n; i++) {
      const price = lo + step * i;
      // eslint-disable-next-line no-await-in-loop
      await postMarker(price, markerType, usdPerLine, { ...opts, skipReload: true });
    }
    await loadMarkers();
  }, [postMarker, loadMarkers]);

  // ── Delete marker via API ────────────────────────────────────────────
  const deleteMarker = useCallback(async (markerId) => {
    try {
      await fetch(`${API_URL}/markers/${markerId}`, { method: 'DELETE' });
      await loadMarkers();
    } catch (err) {
      console.error("Failed to delete marker", err);
    }
  }, [loadMarkers]);

  // ── Effect 1: Chart init + klines + WebSocket (runs on symbol/interval change only) ──
  useEffect(() => {
    if (!symbol) return;

    const chartOptions = {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: 'transparent' },
        textColor: '#a0a5b8',
      },
      grid: {
        vertLines: { color: 'rgba(42, 47, 66, 0.5)' },
        horzLines: { color: 'rgba(42, 47, 66, 0.5)' },
      },
      timeScale: {
        timeVisible: true,
        secondsVisible: false,
        borderColor: '#2a2f42',
      },
      rightPriceScale: {
        borderColor: '#2a2f42',
      },
      crosshair: {
        mode: 1,
        vertLine: { color: '#3388ff', style: 2 },
        horzLine: { color: '#3388ff', style: 2 },
      }
    };

    const chart = createChart(chartContainerRef.current, chartOptions);
    chartRef.current = chart;

    const candlestickSeries = chart.addSeries(CandlestickSeries, {
      upColor: '#00ff88',
      downColor: '#ff3366',
      borderVisible: false,
      wickUpColor: '#00ff88',
      wickDownColor: '#ff3366',
      priceFormat: {
        type: 'custom',
        formatter: (price) => formatPriceString(price),
        minMove: 0.00000001,
      },
    });
    seriesRef.current = candlestickSeries;

    const volumeSeries = chart.addSeries(HistogramSeries, {
      priceFormat: { type: 'volume' },
      priceScaleId: '',
    });
    volumeSeries.priceScale().applyOptions({
      scaleMargins: { top: 0.8, bottom: 0 },
    });
    volumeSeriesRef.current = volumeSeries;

    // Fetch klines once
    const loadHistory = async () => {
      setLoading(true);
      try {
        const res = await fetch(`${API_URL}/klines/${symbol}?interval=${interval}&limit=500`);
        const json = await res.json();
        if (json.data && Array.isArray(json.data)) {
          const formattedData = [];
          const volumeData = [];
          json.data.forEach(d => {
            const time = d[0] / 1000;
            const open = parseFloat(d[1]), high = parseFloat(d[2]), low = parseFloat(d[3]), close = parseFloat(d[4]);
            const volume = parseFloat(d[5]), isGreen = close >= open;
            formattedData.push({ time, open, high, low, close });
            volumeData.push({ time, value: volume, color: isGreen ? 'rgba(0, 255, 136, 0.4)' : 'rgba(255, 51, 102, 0.4)' });
          });
          if (json.data.length > 0) setLivePrice(parseFloat(json.data[json.data.length - 1][4]));
          candlestickSeries.setData(formattedData);
          volumeSeries.setData(volumeData);
        }
      } catch (err) {
        console.error("Error fetching klines", err);
      } finally {
        setLoading(false);
      }
    };

    loadHistory();
    // Note: live polling starts after this, independent of the history fetch

    // Click handler
    chart.subscribeClick((param) => {
      if (!param.point) return;
      const price = candlestickSeries.coordinateToPrice(param.point.y);
      if (price !== null) { setClickedPrice(price); setShowMarkerMenu(true); }
    });

    // Right-click — delete the line closest to the cursor.
    // Compare rendered pixel positions (not a wide price band) so the line you click
    // on is the one removed, even when grid lines are tightly spaced.
    const handleContext = (e) => {
      e.preventDefault();
      const rect = chartContainerRef.current.getBoundingClientRect();
      const clickY = e.clientY - rect.top;
      let nearest = null;
      let nearestDist = Infinity;
      for (const m of markersRef.current) {
        if (!m.active) continue;
        const lineY = candlestickSeries.priceToCoordinate(m.price);
        if (lineY === null) continue;
        const dist = Math.abs(lineY - clickY);
        if (dist < nearestDist) { nearestDist = dist; nearest = m; }
      }
      // Only delete if the click actually landed on/near a line (within 12px)
      if (nearest && nearestDist <= 12 &&
          window.confirm(`Delete ${nearest.marker_type.replace('_', ' ')} marker at ${nearest.price}?`)) {
        deleteMarker(nearest.id);
      }
    };
    chartContainerRef.current?.addEventListener('contextmenu', handleContext);

    // Live candles: poll OUR /klines forming bar every ~3s. Same feed the
    // engine and dashboard read — the separate Binance kline WebSocket died at
    // the M4 cutover, so a moving chart now MEANS the collector is alive.
    let stopped = false;
    let pollTimer = null;
    const pollLive = async () => {
      try {
        const res = await fetch(`${API_URL}/klines/${symbol}?interval=${interval}&limit=2&include_open=1`);
        const json = await res.json();
        const rows = (json.data || []).slice(-2);   // last closed + forming bar
        if (!stopped && rows.length > 0) {
          for (const d of rows) {
            const time = d[0] / 1000;
            const open = parseFloat(d[1]), high = parseFloat(d[2]), low = parseFloat(d[3]), close = parseFloat(d[4]);
            const volume = parseFloat(d[5]), isGreen = close >= open;
            candlestickSeries.update({ time, open, high, low, close });
            volumeSeries.update({ time, value: volume, color: isGreen ? 'rgba(0, 255, 136, 0.4)' : 'rgba(255, 51, 102, 0.4)' });
          }
          setLivePrice(parseFloat(rows[rows.length - 1][4]));
        }
      } catch { /* API down — the next poll retries */ }
      if (!stopped) pollTimer = setTimeout(pollLive, LIVE_POLL_MS);
    };
    pollLive();

    return () => {
      stopped = true;
      if (pollTimer) clearTimeout(pollTimer);
      chartContainerRef.current?.removeEventListener('contextmenu', handleContext);
      chart.remove();
    };
  }, [symbol, interval]);  // ONLY symbol/interval — no markers/trades

  // ── Effect 2: Load markers on mount + re-fetch after changes ──────────
  useEffect(() => {
    if (!symbol) return;
    loadMarkers();
  }, [symbol, loadMarkers]);

  // ── Effect 2b: token row + chain registry → chain badge / explorer link ──
  useEffect(() => {
    if (!symbol) return;
    let cancelled = false;
    (async () => {
      try {
        const [tok, chains] = await Promise.all([
          fetch(`${API_URL}/tokens/${symbol}`).then(r => (r.ok ? r.json() : null)),
          fetchChains(),
        ]);
        if (cancelled) return;
        setTokenInfo(tok);
        setChainInfo(tok ? (chains || []).find(c => c.chain === tok.chain_id) || null : null);
      } catch { /* no badge — chart still works */ }
    })();
    return () => { cancelled = true; };
  }, [symbol]);

  // Keep markersRef in sync for closures (right-click handler)
  markersRef.current = markers;

  // ── Effect 3: Render markers as price lines when markers/trades change ──
  useEffect(() => {
    const series = seriesRef.current;
    if (!series) return;
    // Clear old lines
    priceLinesRef.current.forEach(pl => series.removePriceLine(pl));
    priceLinesRef.current = [];
    // Planned markers
    (markers || []).forEach(m => {
      if (!m.active) return;
      const style = getMarkerStyle(m.marker_type);
      const pl = series.createPriceLine({
        price: m.price, color: style.color, lineWidth: 2, lineStyle: style.lineStyle,
        axisLabelVisible: true, title: `${style.label} ${m.label || ''}`,
      });
      priceLinesRef.current.push(pl);
    });
    // Filled trades
    (trades || []).forEach(t => {
      const color = t.direction === 'BUY' ? '#00ff88' : '#ff3366';
      const pl = series.createPriceLine({
        price: t.execution_price, color, lineWidth: 1, lineStyle: 0,
        axisLabelVisible: true, title: `${t.direction === 'BUY' ? 'BOUGHT' : 'SOLD'} @ ${t.execution_price.toFixed(6)}`,
      });
      priceLinesRef.current.push(pl);
    });
  }, [markers, trades]);

  const inputStyle = {
    width: '100%', padding: '8px', borderRadius: '6px',
    border: '1px solid var(--border-color)', background: 'var(--bg-tertiary)',
    color: '#fff', fontSize: '13px', boxSizing: 'border-box',
  };
  const resetMarkerMenu = () => {
    setShowMarkerMenu(false);
    setMarkerAmount(''); setTpPrice(''); setSlPrice('');
    setGridCount(''); setGridTo('');
  };

  return (
    <div className="chart-container">
      <div className="chart-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <h1 style={{ fontSize: '0.6rem', margin: 0 }}>
            {tokenInfo?.display_symbol || name || symbol || 'Select a Token'}
          </h1>
          {chainInfo && (
            <a
              href={tokenInfo?.contract_address
                ? `${chainInfo.explorer}/token/${tokenInfo.contract_address}`
                : chainInfo.explorer}
              target="_blank"
              rel="noreferrer"
              title={`View on ${chainInfo.name} explorer`}
              style={{
                fontSize: '0.45rem', padding: '2px 6px', borderRadius: '4px',
                background: '#2a2f42', color: '#22d3ee',
                border: '1px solid #3388ff', textDecoration: 'none',
                textTransform: 'uppercase', letterSpacing: '0.5px',
              }}
            >
              {chainInfo.chain}
            </a>
          )}
          <select 
            value={interval}
            onChange={(e) => onIntervalChange && onIntervalChange(e.target.value)}
            style={{
              background: '#2a2f42',
              color: '#fff',
              border: '1px solid #3388ff',
              borderRadius: '4px',
              padding: '4px 8px',
              outline: 'none',
              cursor: 'pointer',
              fontSize: '0.6rem'
            }}
          >
            <option value="1m">1m</option>
            <option value="5m">5m</option>
            <option value="15m">15m</option>
            <option value="30m">30m</option>
            <option value="1h">1h</option>
            <option value="4h">4h</option>
            <option value="1d">1d</option>
          </select>
        </div>

        <div style={{ flex: 1, display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: '20px', paddingRight: '15px' }}>
          {liveSignal && liveSignal.volume_24h > 0 && (
            <>
              <div style={{ fontSize: '0.6rem' }}>
                <span style={{ color: '#a0a5b8', marginRight: '4px' }}>5m:</span>
                <span style={{ color: '#00ff88' }}>{buy5mPct.toFixed(2)}% B</span> / <span style={{ color: '#ff3366' }}>{sell5mPct.toFixed(2)}% S</span>
              </div>
              <div style={{ fontSize: '0.6rem', borderLeft: '1px solid #2a2f42', paddingLeft: '15px' }}>
                <span style={{ color: '#a0a5b8', marginRight: '4px' }}>1h:</span>
                <span style={{ color: '#00ff88' }}>{buy1hPct.toFixed(2)}% B</span> / <span style={{ color: '#ff3366' }}>{sell1hPct.toFixed(2)}% S</span>
              </div>
            </>
          )}

          {(onOpenSwap || onOpenToken) && symbol && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, borderLeft: '1px solid #2a2f42', paddingLeft: 12 }}>
              {onOpenSwap && (
                <button
                  type="button"
                  title="Open portfolio swap for this token"
                  onClick={() => onOpenSwap(symbol, name || tokenInfo?.display_symbol || symbol)}
                  style={{
                    fontSize: '0.55rem', padding: '3px 8px', borderRadius: 6, cursor: 'pointer',
                    border: '1px solid rgba(139,92,246,0.5)', background: 'rgba(139,92,246,0.15)', color: '#c4b5fd',
                    fontWeight: 700,
                  }}
                >
                  Swap
                </button>
              )}
              {onOpenToken && (
                <button
                  type="button"
                  title="Token overview page"
                  onClick={() => onOpenToken({ symbol, name: name || tokenInfo?.display_symbol || symbol })}
                  style={{
                    fontSize: '0.55rem', padding: '3px 8px', borderRadius: 6, cursor: 'pointer',
                    border: '1px solid #2a2f42', background: '#1a1f33', color: '#a0a5b8',
                  }}
                >
                  Token
                </button>
              )}
            </div>
          )}

          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', borderLeft: '1px solid #2a2f42', paddingLeft: '15px' }}>
            <div style={{ fontSize: '0.6rem', fontWeight: 'bold' }}>
              ${livePrice !== null ? formatPriceString(Number(livePrice)) : 'Loading...'}
            </div>
            <div style={{ 
              color: typeof priceChange24h === 'number' && priceChange24h >= 0 ? '#00ff88' : (typeof priceChange24h === 'number' && priceChange24h < 0 ? '#ff3366' : '#a0a5b8'), 
              fontSize: '0.45rem'
            }}>
              {typeof priceChange24h === 'number' ? `${priceChange24h >= 0 ? '+' : ''}${priceChange24h.toFixed(2)}%` : ''}
            </div>
          </div>
          {onClose && (
            <button 
              onClick={onClose}
              style={{
                background: 'transparent',
                border: 'none',
                color: '#a0a5b8',
                fontSize: '1.8rem',
                cursor: 'pointer',
                padding: '0 5px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                transition: 'color 0.2s ease',
              }}
              onMouseEnter={(e) => e.target.style.color = '#ff3366'}
              onMouseLeave={(e) => e.target.style.color = '#a0a5b8'}
              title="Close Chart"
            >
              &times;
            </button>
          )}
        </div>
      </div>
      <div className="chart-wrapper" ref={chartContainerRef}>
        {loading && <div className="loading-overlay">Loading Historical Data...</div>}
      </div>

      {/* Marker creation popup */}
      {showMarkerMenu && clickedPrice !== null && (
        <div className="marker-menu-overlay" onClick={() => setShowMarkerMenu(false)}>
          <div className="marker-menu" onClick={e => e.stopPropagation()}>
            <div className="marker-menu-header">
              Place marker at ${formatPriceString(clickedPrice)}
              <button className="marker-close-btn" onClick={() => setShowMarkerMenu(false)}>&times;</button>
            </div>
            <div style={{ marginBottom: 10 }}>
              <input
                type="number"
                step="any"
                placeholder="Amount in USD (leave blank for full balance)"
                value={markerAmount}
                onChange={(e) => setMarkerAmount(e.target.value)}
                style={inputStyle}
                autoFocus
              />
            </div>

            {/* Optional bracket (only used by BUY entries) */}
            <div style={{ marginBottom: 10 }}>
              <div style={{ fontSize: 11, color: '#a0a5b8', marginBottom: 4 }}>
                Bracket (optional, for BUY entries) — auto-places TP + SL on fill:
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <input type="number" step="any" placeholder="Take-profit price"
                  value={tpPrice} onChange={(e) => setTpPrice(e.target.value)}
                  style={{ ...inputStyle, borderColor: '#00ff88' }} />
                <input type="number" step="any" placeholder="Stop-loss price"
                  value={slPrice} onChange={(e) => setSlPrice(e.target.value)}
                  style={{ ...inputStyle, borderColor: '#ff3366' }} />
              </div>
            </div>

            <div className="marker-menu-grid">
              {Object.entries(MARKER_STYLES).map(([type, style]) => (
                <button
                  key={type}
                  className="marker-type-btn"
                  style={{ borderColor: style.color, color: style.color }}
                  onClick={() => {
                    postMarker(clickedPrice, type, markerAmount, { tp: tpPrice, sl: slPrice });
                    resetMarkerMenu();
                  }}
                >
                  <span className="marker-type-label">{style.label}</span>
                  <span className="marker-type-name">{type.replace('_', ' ')}</span>
                </button>
              ))}
            </div>

            {/* Grid generator: N evenly-spaced BUY lines between here and a target */}
            <div style={{ marginTop: 12, paddingTop: 10, borderTop: '1px solid var(--border-color)' }}>
              <div style={{ fontSize: 11, color: '#a0a5b8', marginBottom: 4 }}>
                Buy grid — {gridCount || 'N'} lines from ${formatPriceString(clickedPrice)} to target,
                ${markerAmount || '?'} each:
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <input type="number" step="1" min="2" max="50" placeholder="# lines"
                  value={gridCount} onChange={(e) => setGridCount(e.target.value)}
                  style={{ ...inputStyle, flex: '0 0 80px' }} />
                <input type="number" step="any" placeholder="Target price"
                  value={gridTo} onChange={(e) => setGridTo(e.target.value)}
                  style={inputStyle} />
                <button
                  className="marker-type-btn"
                  style={{ borderColor: '#00ff88', color: '#00ff88', flex: '0 0 90px', cursor: 'pointer' }}
                  disabled={!(parseFloat(gridTo) > 0 && parseInt(gridCount, 10) >= 2)}
                  onClick={() => {
                    createGrid(clickedPrice, parseFloat(gridTo), gridCount, 'BUY_GRID', markerAmount);
                    resetMarkerMenu();
                  }}
                >
                  Place Grid
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
