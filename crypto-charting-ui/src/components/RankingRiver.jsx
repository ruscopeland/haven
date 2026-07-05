// Ranking river (bump chart) + finder-quality strip for the Token Finder tab.
// Pure SVG, no chart deps — lightweight-charts has no bump-chart concept.
// X = time, Y = rank position (1 at the top). One colored line per token,
// drawn only while it holds a top-N spot; click a column to pin that moment
// (the workbench shows the full ranked table for the pinned time).
import { useRef, useState, useEffect, useMemo } from 'react';

// Distinct line colors; tokens get one by first appearance in the top N.
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

// Assign stable colors by first top-N appearance across the whole range.
export function colorMap(rankings, topN) {
  const colors = new Map();
  for (const r of rankings) {
    if (!r) continue;
    for (const { symbol } of r.slice(0, topN)) {
      if (!colors.has(symbol)) colors.set(symbol, PALETTE[colors.size % PALETTE.length]);
    }
  }
  return colors;
}

export default function RankingRiver({
  rankings = [], times = [], topN = 5, pinnedGi = null, onPin,
  displayName = (s) => s, height = 240,
}) {
  const [wrapRef, width] = useMeasuredWidth();
  const [hoverGi, setHoverGi] = useState(null);

  const n = rankings.length;
  const colors = useMemo(() => colorMap(rankings, topN), [rankings, topN]);

  const padL = 14, padR = 118, padT = 18, padB = 26;
  const plotW = Math.max(50, width - padL - padR);
  const plotH = height - padT - padB;
  const x = (gi) => padL + (n <= 1 ? 0 : (gi / (n - 1)) * plotW);
  const y = (rank) => padT + (topN <= 1 ? plotH / 2 : ((rank - 1) / (topN - 1)) * plotH);

  // Per-symbol run segments: consecutive bars where it holds a top-N rank.
  const segments = useMemo(() => {
    const bySymbol = new Map();
    for (let gi = 0; gi < n; gi++) {
      const r = rankings[gi];
      if (!r) continue;
      for (let k = 0; k < Math.min(topN, r.length); k++) {
        const sym = r[k].symbol;
        if (!bySymbol.has(sym)) bySymbol.set(sym, []);
        const runs = bySymbol.get(sym);
        const last = runs[runs.length - 1];
        if (last && last[last.length - 1].gi === gi - 1) last.push({ gi, rank: k + 1 });
        else runs.push([{ gi, rank: k + 1 }]);
      }
    }
    return bySymbol;
  }, [rankings, topN, n]);

  // Right-edge legend: tokens in the LAST available ranking, ordered by rank.
  const lastGi = useMemo(() => {
    for (let gi = n - 1; gi >= 0; gi--) if (rankings[gi]) return gi;
    return -1;
  }, [rankings, n]);
  const legend = lastGi >= 0 ? rankings[lastGi].slice(0, topN) : [];

  const giFromEvent = (e) => {
    const rect = wrapRef.current.getBoundingClientRect();
    const px = e.clientX - rect.left - padL;
    const gi = Math.round((px / plotW) * (n - 1));
    return Math.max(0, Math.min(n - 1, gi));
  };

  if (n === 0) {
    return <div ref={wrapRef} className="rr-empty">No ranking data yet</div>;
  }

  const markGi = hoverGi ?? pinnedGi;
  const tickEvery = Math.max(1, Math.floor(n / Math.max(2, Math.floor(plotW / 110))));

  return (
    <div ref={wrapRef} className="rr-wrap">
      <svg
        width={width} height={height}
        onMouseMove={(e) => setHoverGi(giFromEvent(e))}
        onMouseLeave={() => setHoverGi(null)}
        onClick={(e) => onPin && onPin(giFromEvent(e))}
        style={{ cursor: 'pointer', display: 'block' }}
      >
        {/* rank grid lines + labels */}
        {Array.from({ length: topN }, (_, k) => (
          <g key={k}>
            <line x1={padL} y1={y(k + 1)} x2={padL + plotW} y2={y(k + 1)} stroke="#2a2f42" strokeWidth="1" />
            <text x={padL - 4} y={y(k + 1) + 3} fill="#a0a5b8" fontSize="9" textAnchor="end">{k + 1}</text>
          </g>
        ))}
        {/* time ticks */}
        {times.map((t, gi) => (gi % tickEvery === 0 ? (
          <text key={gi} x={x(gi)} y={height - 8} fill="#a0a5b8" fontSize="9" textAnchor="middle">
            {fmtTime(t)}
          </text>
        ) : null))}

        {/* token rank lines */}
        {[...segments.entries()].map(([sym, runs]) => (
          <g key={sym}>
            {runs.map((run, ri) => (
              run.length === 1 ? (
                <circle key={ri} cx={x(run[0].gi)} cy={y(run[0].rank)} r="2.5" fill={colors.get(sym)} />
              ) : (
                <polyline
                  key={ri}
                  points={run.map(p => `${x(p.gi)},${y(p.rank)}`).join(' ')}
                  fill="none" stroke={colors.get(sym)} strokeWidth="2" strokeLinejoin="round"
                  opacity="0.9"
                >
                  <title>{displayName(sym)}</title>
                </polyline>
              )
            ))}
          </g>
        ))}

        {/* hover / pin column */}
        {markGi != null && (
          <line x1={x(markGi)} y1={padT - 6} x2={x(markGi)} y2={padT + plotH + 6}
                stroke={hoverGi != null ? '#a0a5b8' : '#3388ff'} strokeDasharray="3,3" strokeWidth="1" />
        )}
        {markGi != null && (
          <text x={Math.min(x(markGi) + 4, padL + plotW - 60)} y={padT - 6} fill="#a0a5b8" fontSize="9">
            {fmtTime(times[markGi])}{pinnedGi === markGi && hoverGi == null ? ' (pinned)' : ''}
          </text>
        )}

        {/* legend: latest top-N, right edge */}
        {legend.map((r, k) => (
          <g key={r.symbol}>
            <circle cx={padL + plotW + 10} cy={y(k + 1)} r="3" fill={colors.get(r.symbol)} />
            <text x={padL + plotW + 18} y={y(k + 1) + 3} fill="#d7dbe8" fontSize="9.5">
              {displayName(r.symbol)}
            </text>
          </g>
        ))}
      </svg>
    </div>
  );
}

// "Did the finder pick winners?" — avg forward return of the top-K picks vs
// the median of everything the finder scored. Above the median line = edge.
export function QualityStrip({ quality, times = [], horizonLabel = '', height = 110 }) {
  const [wrapRef, width] = useMeasuredWidth();
  const n = times.length;
  if (!quality || n === 0) return null;

  const padL = 40, padR = 118, padT = 12, padB = 18;
  const plotW = Math.max(50, width - padL - padR);
  const plotH = height - padT - padB;

  const vals = [...quality.topKAvg, ...quality.median].filter(v => v != null);
  if (vals.length === 0) return null;
  let lo = Math.min(...vals, 0), hi = Math.max(...vals, 0);
  if (hi - lo < 1e-9) { hi += 1; lo -= 1; }
  const x = (gi) => padL + (n <= 1 ? 0 : (gi / (n - 1)) * plotW);
  const y = (v) => padT + (1 - (v - lo) / (hi - lo)) * plotH;

  const path = (arr) => {
    let d = '', pen = false;
    for (let gi = 0; gi < n; gi++) {
      const v = arr[gi];
      if (v == null) { pen = false; continue; }
      d += `${pen ? 'L' : 'M'}${x(gi).toFixed(1)},${y(v).toFixed(1)}`;
      pen = true;
    }
    return d;
  };

  return (
    <div ref={wrapRef} className="rr-wrap">
      <svg width={width} height={height} style={{ display: 'block' }}>
        <line x1={padL} y1={y(0)} x2={padL + plotW} y2={y(0)} stroke="#2a2f42" strokeWidth="1" />
        <text x={padL - 4} y={y(0) + 3} fill="#a0a5b8" fontSize="9" textAnchor="end">0%</text>
        <text x={padL - 4} y={padT + 4} fill="#a0a5b8" fontSize="9" textAnchor="end">{hi.toFixed(1)}%</text>
        <text x={padL - 4} y={padT + plotH} fill="#a0a5b8" fontSize="9" textAnchor="end">{lo.toFixed(1)}%</text>
        <path d={path(quality.median)} fill="none" stroke="#a0a5b8" strokeWidth="1.5" opacity="0.7" />
        <path d={path(quality.topKAvg)} fill="none" stroke="#00ff88" strokeWidth="2" />
        <g>
          <circle cx={padL + plotW + 10} cy={padT + 8} r="3" fill="#00ff88" />
          <text x={padL + plotW + 18} y={padT + 11} fill="#d7dbe8" fontSize="9.5">top picks {horizonLabel}</text>
          <circle cx={padL + plotW + 10} cy={padT + 24} r="3" fill="#a0a5b8" />
          <text x={padL + plotW + 18} y={padT + 27} fill="#d7dbe8" fontSize="9.5">universe median</text>
        </g>
      </svg>
    </div>
  );
}
