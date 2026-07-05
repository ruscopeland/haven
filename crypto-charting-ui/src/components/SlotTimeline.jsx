// Slot timeline for portfolio (finder-bound) backtests: one row per slot,
// colored bands showing which token the slot was bound to when, with the
// strategy's fills drawn on top — the ranking river with actual trades
// painted on it. Below: the combined equity curve.
import { useRef, useState, useEffect, useMemo } from 'react';

const PALETTE = [
  '#3388ff', '#00ff88', '#ff3366', '#fbbf24', '#a78bfa', '#22d3ee',
  '#f472b6', '#84cc16', '#fb923c', '#e879f9', '#2dd4bf', '#facc15',
];

function useMeasuredWidth(fallback = 900) {
  const ref = useRef(null);
  const [width, setWidth] = useState(fallback);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => setWidth(el.clientWidth || fallback);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [fallback]);
  return [ref, width];
}

const fmtTime = (sec) =>
  new Date(sec * 1000).toLocaleString([], { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });

export default function SlotTimeline({
  slotTimeline = [], trades = [], equity = [], times = [],
  maxPositions = 1, displayName = (s) => s,
}) {
  const [wrapRef, width] = useMeasuredWidth();
  const n = times.length;

  const rowH = 26, rowGap = 6, eqH = 70;
  const padL = 44, padR = 14, padT = 8, padB = 22;
  const bandsH = maxPositions * rowH + (maxPositions - 1) * rowGap;
  const height = padT + bandsH + 14 + eqH + padB;
  const plotW = Math.max(50, width - padL - padR);

  const t0 = times[0], t1 = times[n - 1] || t0 + 1;
  const x = (sec) => padL + ((sec - t0) / Math.max(1, t1 - t0)) * plotW;
  const rowY = (slot) => padT + slot * (rowH + rowGap);

  const colors = useMemo(() => {
    const m = new Map();
    for (const e of slotTimeline) {
      if (!m.has(e.symbol)) m.set(e.symbol, PALETTE[m.size % PALETTE.length]);
    }
    return m;
  }, [slotTimeline]);

  const eqTop = padT + bandsH + 14;
  const eqPath = useMemo(() => {
    if (equity.length === 0) return '';
    let lo = 0, hi = 0;
    for (const p of equity) { if (p.value < lo) lo = p.value; if (p.value > hi) hi = p.value; }
    if (hi - lo < 1e-9) { hi += 1; lo -= 1; }
    const y = (v) => eqTop + (1 - (v - lo) / (hi - lo)) * eqH;
    return {
      d: equity.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(p.time).toFixed(1)},${y(p.value).toFixed(1)}`).join(''),
      zeroY: y(0), lo, hi,
    };
  }, [equity, width, n]);   // eslint-disable-line react-hooks/exhaustive-deps

  if (n === 0 || slotTimeline.length === 0) {
    return <div ref={wrapRef} className="rr-empty">Portfolio backtest results appear here</div>;
  }

  const tickEvery = Math.max(1, Math.floor(n / Math.max(2, Math.floor(plotW / 110))));

  return (
    <div ref={wrapRef} className="rr-wrap">
      <svg width={width} height={height} style={{ display: 'block' }}>
        {/* slot rows */}
        {Array.from({ length: maxPositions }, (_, s) => (
          <g key={s}>
            <text x={padL - 6} y={rowY(s) + rowH / 2 + 3} fill="#a0a5b8" fontSize="9" textAnchor="end">
              slot {s + 1}
            </text>
            <rect x={padL} y={rowY(s)} width={plotW} height={rowH} fill="#1a1f2e" rx="3" />
          </g>
        ))}

        {/* binding bands */}
        {slotTimeline.map((e, k) => {
          const bx = x(e.fromTime);
          const bw = Math.max(2, x(e.toTime) - bx);
          return (
            <g key={k}>
              <rect x={bx} y={rowY(e.slot)} width={bw} height={rowH}
                    fill={colors.get(e.symbol)} opacity="0.28" rx="3" />
              {bw > 46 && (
                <text x={bx + 4} y={rowY(e.slot) + rowH / 2 + 3} fill="#d7dbe8" fontSize="9">
                  {displayName(e.symbol)}{e.entryRank ? ` #${e.entryRank}` : ''}
                </text>
              )}
              <title>{`${displayName(e.symbol)}  ${fmtTime(e.fromTime)} → ${fmtTime(e.toTime)}`}</title>
            </g>
          );
        })}

        {/* fills */}
        {trades.map((t, k) => {
          const cx = x(t.time);
          const cy = rowY(t.slot ?? 0) + rowH / 2;
          return t.side === 'BUY' ? (
            <path key={k} d={`M${cx},${cy - 5} L${cx - 4},${cy + 3} L${cx + 4},${cy + 3} Z`} fill="#00ff88">
              <title>{`BUY ${displayName(t.symbol)} $${(t.usd ?? 0).toFixed(2)} @ ${t.price}`}</title>
            </path>
          ) : (
            <path key={k} d={`M${cx},${cy + 5} L${cx - 4},${cy - 3} L${cx + 4},${cy - 3} Z`} fill="#ff3366">
              <title>{`SELL ${displayName(t.symbol)} $${(t.usd ?? 0).toFixed(2)} @ ${t.price}${t.tag ? ` (${t.tag})` : ''}`}</title>
            </path>
          );
        })}

        {/* equity */}
        <text x={padL - 6} y={eqTop + 10} fill="#a0a5b8" fontSize="9" textAnchor="end">PnL</text>
        {eqPath && (
          <>
            <line x1={padL} y1={eqPath.zeroY} x2={padL + plotW} y2={eqPath.zeroY}
                  stroke="#2a2f42" strokeWidth="1" />
            <path d={eqPath.d} fill="none" stroke="#3388ff" strokeWidth="1.5" />
            <text x={padL + plotW} y={eqTop + 8} fill="#a0a5b8" fontSize="9" textAnchor="end">
              {`$${eqPath.hi.toFixed(0)}`}
            </text>
            <text x={padL + plotW} y={eqTop + eqH} fill="#a0a5b8" fontSize="9" textAnchor="end">
              {`$${eqPath.lo.toFixed(0)}`}
            </text>
          </>
        )}

        {/* time ticks */}
        {times.map((t, gi) => (gi % tickEvery === 0 ? (
          <text key={gi} x={x(t)} y={height - 6} fill="#a0a5b8" fontSize="9" textAnchor="middle">
            {fmtTime(t)}
          </text>
        ) : null))}
      </svg>
    </div>
  );
}
