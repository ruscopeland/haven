import { useState, useEffect, useRef, useCallback } from 'react';
import {
  createChart, ColorType, CandlestickSeries, HistogramSeries,
  createSeriesMarkers, LineStyle,
} from 'lightweight-charts';
import { formatPriceString } from './Chart';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:8000';
const INTERVAL_SEC = { '1m': 60, '5m': 300, '15m': 900, '30m': 1800, '1h': 3600, '4h': 14400, '1d': 86400 };

// Price chart for the strategy performance page: the SAME kline series the
// runner trades on, with every real fill drawn as an arrow. Clicking a trade
// in the history table focuses it here — if the trade is older than the
// current window, a history window around it is fetched (klines end_ms) and a
// "↩ back to now" chip restores the live view.
export default function StrategyTradeChart({ symbol, interval, trades, selectedTradeId, avgCost }) {
  const containerRef = useRef(null);
  const chartRef = useRef(null);
  const seriesRef = useRef(null);
  const volumeRef = useRef(null);
  const markersApiRef = useRef(null);
  const avgCostLineRef = useRef(null);
  const barsRef = useRef([]);
  const pendingFocusRef = useRef(null);   // bar time (sec) to center after a load

  const [bars, setBars] = useState(null);
  const [windowEnd, setWindowEnd] = useState(null);  // null = live (newest candles)
  const [loading, setLoading] = useState(false);
  const [note, setNote] = useState('');

  const ivSec = INTERVAL_SEC[interval] || 300;

  // ── Chart lifecycle (created once) ─────────────────────────────────────
  useEffect(() => {
    const chart = createChart(containerRef.current, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: 'transparent' },
        textColor: '#a0a5b8',
      },
      grid: {
        vertLines: { color: 'rgba(42, 47, 66, 0.5)' },
        horzLines: { color: 'rgba(42, 47, 66, 0.5)' },
      },
      timeScale: { timeVisible: true, secondsVisible: false, borderColor: '#2a2f42' },
      rightPriceScale: { borderColor: '#2a2f42' },
      crosshair: {
        mode: 1,
        vertLine: { color: '#3388ff', style: 2 },
        horzLine: { color: '#3388ff', style: 2 },
      },
    });
    chartRef.current = chart;

    const candles = chart.addSeries(CandlestickSeries, {
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
    seriesRef.current = candles;

    const volume = chart.addSeries(HistogramSeries, {
      priceFormat: { type: 'volume' },
      priceScaleId: '',
    });
    volume.priceScale().applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });
    volumeRef.current = volume;

    markersApiRef.current = createSeriesMarkers(candles, []);

    return () => {
      markersApiRef.current = null;
      chartRef.current = null;
      seriesRef.current = null;
      volumeRef.current = null;
      avgCostLineRef.current = null;
      chart.remove();
    };
  }, []);

  // ── Kline data: live window (refreshed every 60s) or a history window ──
  useEffect(() => {
    if (!symbol) return undefined;
    let alive = true;
    const load = async () => {
      setLoading(true);
      try {
        const end = windowEnd ? `&end_ms=${windowEnd}` : '';
        const res = await fetch(`${API_URL}/klines/${symbol}?interval=${interval}&limit=1000${end}`);
        const json = await res.json();
        if (!alive) return;
        const fetched = (json.data || []).map(d => ({
          time: d[0] / 1000,
          open: parseFloat(d[1]), high: parseFloat(d[2]),
          low: parseFloat(d[3]), close: parseFloat(d[4]),
          volume: parseFloat(d[5]),
        }));
        setBars(fetched);
        if (fetched.length === 0) setNote('No candle data available for this window.');
      } catch {
        if (alive) setNote('Could not load candles — is the API running?');
      } finally {
        if (alive) setLoading(false);
      }
    };
    load();
    // Only the live window follows the market.
    const t = windowEnd == null ? setInterval(load, 60_000) : null;
    return () => { alive = false; if (t) clearInterval(t); };
  }, [symbol, interval, windowEnd]);

  // Reset to the live window when the symbol changes (portfolio strategies).
  useEffect(() => { setWindowEnd(null); setNote(''); }, [symbol]);

  const focusTime = useCallback((tSec) => {
    const data = barsRef.current;
    const chart = chartRef.current;
    if (!chart || !data || data.length === 0) return false;
    const i = data.findIndex(b => b.time >= tSec);
    if (i === -1 || Math.abs(data[Math.max(0, i)].time - tSec) > 50 * ivSec) return false;
    chart.timeScale().setVisibleLogicalRange({ from: i - 45, to: i + 45 });
    return true;
  }, [ivSec]);

  // ── Candles + volume into the chart ─────────────────────────────────────
  useEffect(() => {
    if (!seriesRef.current || !bars) return;
    barsRef.current = bars;
    seriesRef.current.setData(bars.map(b => ({
      time: b.time, open: b.open, high: b.high, low: b.low, close: b.close,
    })));
    volumeRef.current.setData(bars.map(b => ({
      time: b.time,
      value: b.volume,
      color: b.close >= b.open ? 'rgba(0, 255, 136, 0.4)' : 'rgba(255, 51, 102, 0.4)',
    })));
    if (pendingFocusRef.current != null) {
      const ok = focusTime(pendingFocusRef.current);
      if (!ok && bars.length > 0) {
        setNote('This trade is older than the CMC history available for this interval and plan.');
      }
      pendingFocusRef.current = null;
    } else {
      chartRef.current?.timeScale().fitContent();
    }
  }, [bars, focusTime]);

  // ── Fills as arrows; the selected trade gets the focus treatment ────────
  useEffect(() => {
    if (!markersApiRef.current) return;
    const first = barsRef.current[0]?.time ?? 0;
    const last = barsRef.current[barsRef.current.length - 1]?.time ?? Infinity;
    const markers = (trades || [])
      .filter(t => t.block_time > 1e12)
      .map(t => {
        const time = Math.floor(t.block_time / 1000 / ivSec) * ivSec;
        const selected = t.id === selectedTradeId;
        const buy = t.direction === 'BUY';
        return {
          time,
          position: buy ? 'belowBar' : 'aboveBar',
          shape: buy ? 'arrowUp' : 'arrowDown',
          color: selected ? '#3388ff' : buy ? '#00ff88' : '#ff3366',
          size: selected ? 3 : 1.5,
          text: selected
            ? `${buy ? 'BUY' : 'SELL'} $${(t.usd ?? 0).toFixed(2)}`
            : `${buy ? 'B' : 'S'} $${(t.usd ?? 0).toFixed(0)}`,
        };
      })
      .filter(m => m.time >= first && m.time <= last)
      .sort((a, b) => a.time - b.time);
    markersApiRef.current.setMarkers(markers);
  }, [trades, selectedTradeId, ivSec, bars]);

  // ── Selection → center the chart on that trade ──────────────────────────
  useEffect(() => {
    if (!selectedTradeId) return;
    const sel = (trades || []).find(t => t.id === selectedTradeId);
    if (!sel) return;
    if (!(sel.block_time > 1e12)) {
      setNote('This legacy trade row has no timestamp, so it cannot be located on the chart.');
      return;
    }
    setNote('');
    const tSec = Math.floor(sel.block_time / 1000 / ivSec) * ivSec;
    if (focusTime(tSec)) return;
    // Outside the loaded window — fetch a history window around the trade.
    pendingFocusRef.current = tSec;
    setWindowEnd(sel.block_time + 200 * ivSec * 1000);
  }, [selectedTradeId]);          // eslint-disable-line react-hooks/exhaustive-deps

  // ── Average-cost line while a position is open ──────────────────────────
  useEffect(() => {
    const s = seriesRef.current;
    if (!s) return;
    if (avgCostLineRef.current) {
      s.removePriceLine(avgCostLineRef.current);
      avgCostLineRef.current = null;
    }
    if (avgCost > 0) {
      avgCostLineRef.current = s.createPriceLine({
        price: avgCost,
        color: '#fbbf24',
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: true,
        title: 'avg cost',
      });
    }
  }, [avgCost, bars]);

  return (
    <div className="sd-chart-wrap">
      <div className="chart-wrapper" ref={containerRef}>
        {loading && !bars && <div className="loading-overlay">Loading candles…</div>}
      </div>
      {windowEnd != null && (
        <button className="sd-chart-back" onClick={() => { setWindowEnd(null); setNote(''); }}>
          ↩ Back to now
        </button>
      )}
      {note && <div className="sd-chart-note">{note}</div>}
    </div>
  );
}
