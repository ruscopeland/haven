import { useEffect, useRef } from 'react';
import { createChart, ColorType, BaselineSeries } from 'lightweight-charts';

// Realized-PnL curve for a running strategy — green above zero, red below.
// One point per recorded fill (see utils/strategyPerf.js).
export default function EquityChart({ points }) {
  const containerRef = useRef(null);
  const chartRef = useRef(null);
  const seriesRef = useRef(null);

  useEffect(() => {
    const chart = createChart(containerRef.current, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: 'transparent' },
        textColor: '#a0a5b8',
        fontSize: 10,
      },
      grid: {
        vertLines: { color: 'rgba(42, 47, 66, 0.4)' },
        horzLines: { color: 'rgba(42, 47, 66, 0.4)' },
      },
      timeScale: { timeVisible: true, secondsVisible: false, borderColor: '#2a2f42' },
      rightPriceScale: { borderColor: '#2a2f42' },
      crosshair: { mode: 1 },
    });
    chartRef.current = chart;
    seriesRef.current = chart.addSeries(BaselineSeries, {
      baseValue: { type: 'price', price: 0 },
      topLineColor: '#00ff88',
      topFillColor1: 'rgba(0, 255, 136, 0.25)',
      topFillColor2: 'rgba(0, 255, 136, 0.02)',
      bottomLineColor: '#ff3366',
      bottomFillColor1: 'rgba(255, 51, 102, 0.02)',
      bottomFillColor2: 'rgba(255, 51, 102, 0.25)',
      lineWidth: 2,
      priceLineVisible: false,
      priceFormat: {
        type: 'custom',
        formatter: (v) => `${v < 0 ? '-' : ''}$${Math.abs(v).toFixed(2)}`,
        minMove: 0.01,
      },
    });
    return () => {
      chartRef.current = null;
      seriesRef.current = null;
      chart.remove();
    };
  }, []);

  useEffect(() => {
    if (!seriesRef.current) return;
    seriesRef.current.setData(points || []);
    chartRef.current?.timeScale().fitContent();
  }, [points]);

  const empty = !points || points.length === 0;
  return (
    <div className="sd-equity-wrap">
      <div className="sd-equity-chart" ref={containerRef} />
      {empty && <div className="sd-chart-empty">No closed trades yet — the curve draws as fills come in.</div>}
    </div>
  );
}
