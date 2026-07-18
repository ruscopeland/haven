import { useEffect, useRef } from 'react';
import {
  createChart, ColorType, CandlestickSeries, HistogramSeries, LineSeries,
  createSeriesMarkers,
} from 'lightweight-charts';
import { formatPriceString } from './Chart';

// Lean, read-only sibling of Chart.jsx: same look, but no marker popups and no
// live WebSocket — it renders the exact series the backtest ran on, plus the
// simulated fills as arrows and an optional equity (cumulative PnL) line.
export default function BacktestChart({ bars, trades, equity, showEquity, loading }) {
  const containerRef = useRef(null);
  const chartRef = useRef(null);
  const seriesRef = useRef(null);
  const volumeRef = useRef(null);
  const equityRef = useRef(null);
  const markersApiRef = useRef(null);

  // Chart lifecycle — created once, data swapped in below.
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

    // Equity curve on its own hidden scale so it never distorts the candles.
    const equityLine = chart.addSeries(LineSeries, {
      color: '#3388ff',
      lineWidth: 2,
      priceScaleId: 'equity',
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
    });
    chart.priceScale('equity').applyOptions({
      visible: false,
      scaleMargins: { top: 0.05, bottom: 0.5 },
    });
    equityRef.current = equityLine;

    markersApiRef.current = createSeriesMarkers(candles, []);

    return () => {
      markersApiRef.current = null;
      chart.remove();
    };
  }, []);

  // Candles + volume
  useEffect(() => {
    if (!seriesRef.current || !bars) return;
    seriesRef.current.setData(bars.map(b => ({
      time: b.time, open: b.open, high: b.high, low: b.low, close: b.close,
    })));
    volumeRef.current.setData(bars.map(b => ({
      time: b.time,
      value: b.volume,
      color: b.close >= b.open ? 'rgba(0, 255, 136, 0.4)' : 'rgba(255, 51, 102, 0.4)',
    })));
    chartRef.current?.timeScale().fitContent();
  }, [bars]);

  // Simulated fills as arrows
  useEffect(() => {
    if (!markersApiRef.current) return;
    const markers = (trades || []).map(t => ({
      time: t.time,
      position: t.side === 'BUY' ? 'belowBar' : 'aboveBar',
      shape: t.side === 'BUY' ? 'arrowUp' : 'arrowDown',
      color: t.side === 'BUY' ? '#00ff88' : '#ff3366',
      text: `${t.tag === 'tp' ? 'TP' : t.tag === 'sl' ? 'SL' : t.side[0]} $${(t.usd ?? 0).toFixed(0)}`,
    }));
    markersApiRef.current.setMarkers(markers);
  }, [trades]);

  // Equity curve (toggleable)
  useEffect(() => {
    if (!equityRef.current) return;
    equityRef.current.setData(showEquity && equity ? equity : []);
  }, [equity, showEquity]);

  return (
    <div className="chart-wrapper" ref={containerRef}>
      {loading && <div className="loading-overlay">Loading Historical Data...</div>}
    </div>
  );
}
