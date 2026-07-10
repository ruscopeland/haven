// Tiny SVG sparkline from real price points (no mock data).
import { useState } from 'react';

export default function Sparkline({ points = [], width = 56, height = 18, up = true }) {
  if (!points || points.length < 2) {
    return <span className="mkt-spark empty" style={{ width, height }} />;
  }
  const min = Math.min(...points);
  const max = Math.max(...points);
  const span = max - min || 1;
  const pad = 1;
  const w = width - pad * 2;
  const h = height - pad * 2;
  const coords = points.map((p, i) => {
    const x = pad + (i / (points.length - 1)) * w;
    const y = pad + h - ((p - min) / span) * h;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const stroke = up ? '#34d399' : '#fb7185';
  return (
    <svg className="mkt-spark" width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden>
      <polyline
        fill="none"
        stroke={stroke}
        strokeWidth="1.5"
        strokeLinejoin="round"
        strokeLinecap="round"
        points={coords.join(' ')}
      />
    </svg>
  );
}

export function TokenLogo({ url, label, size = 18 }) {
  const [broken, setBroken] = useState(false);
  const letter = (label || '?').replace(/[^A-Za-z0-9]/g, '').slice(0, 1).toUpperCase() || '?';
  if (!url || broken) {
    return (
      <span className="mkt-logo fallback" style={{ width: size, height: size, fontSize: Math.max(9, size * 0.45) }}>
        {letter}
      </span>
    );
  }
  return (
    <img
      className="mkt-logo"
      src={url}
      alt=""
      width={size}
      height={size}
      loading="lazy"
      referrerPolicy="no-referrer"
      onError={() => setBroken(true)}
    />
  );
}
