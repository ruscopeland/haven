// Shared display helpers for the Dashboard tab.

export function fmtUsd(v, digits = 2) {
  if (v == null || Number.isNaN(v)) return '—';
  const sign = v < 0 ? '-' : '';
  return `${sign}$${Math.abs(v).toLocaleString(undefined, { maximumFractionDigits: digits, minimumFractionDigits: digits })}`;
}

export function fmtQty(v) {
  if (v == null || Number.isNaN(v)) return '—';
  if (Math.abs(v) >= 1000) return v.toLocaleString(undefined, { maximumFractionDigits: 0 });
  if (Math.abs(v) >= 1) return v.toLocaleString(undefined, { maximumFractionDigits: 4 });
  return v.toPrecision(4);
}

export function fmtPrice(v) {
  if (v == null || Number.isNaN(v) || v === 0) return '—';
  if (v >= 1000) return v.toLocaleString(undefined, { maximumFractionDigits: 2 });
  if (v >= 1) return v.toFixed(4);
  return v.toPrecision(4);
}

export function fmtTime(ms) {
  if (!ms) return '—';
  // Legacy trade rows store block numbers (small) instead of ms timestamps.
  if (ms < 1e12) return `block ${ms}`;
  return new Date(ms).toLocaleString(undefined, {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

export function timeAgo(ms) {
  if (!ms) return 'never';
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return `${Math.round(s)}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

const INTERVAL_MS = { '1m': 60e3, '3m': 180e3, '5m': 300e3, '15m': 900e3, '30m': 1800e3, '1h': 3600e3, '4h': 14400e3, '1d': 86400e3 };
export function intervalToMs(interval) {
  return INTERVAL_MS[interval] || 300e3;
}

// Stable display color for a token:
// hash of the contract address (fallback: symbol) → hue. BNB gets gold.
export function tokenColor(seed, isBnb = false) {
  if (isBnb) return '#f3ba2f';
  let num = 0;
  const s = String(seed || '');
  if (/^0x[0-9a-fA-F]{8,}/.test(s)) num = parseInt(s.slice(2, 10), 16);
  else for (let i = 0; i < s.length; i++) num = (num * 31 + s.charCodeAt(i)) >>> 0;
  return `hsl(${num % 360}, 75%, 60%)`;
}

// Human name for an internal token symbol, falling back to the raw symbol.
export function tokenLabel(symbol, tokenMap) {
  const t = tokenMap?.[symbol];
  return t?.name || symbol;
}

// USD notional of a trade row: token qty × execution price. Works for both
// PAPER rows (amount_in already USD on buys) and FILLED rows (amount_in is
// BNB on buys) because qty×price is unit-consistent for both.
export function tradeUsd(t) {
  const qty = t.direction === 'BUY' ? t.amount_out : t.amount_in;
  return qty * (t.execution_price || t.expected_price || 0);
}

export function tradeQty(t) {
  return t.direction === 'BUY' ? t.amount_out : t.amount_in;
}
