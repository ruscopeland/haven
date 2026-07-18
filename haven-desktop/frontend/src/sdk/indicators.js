// Indicator library — plain functions, array-in / array-out, `null` during the
// warm-up period so strategies can guard with `x[i] == null`. No dependencies.
// Extending: export one more function here and wire it into the ctx table in
// runtime.js (one line each).

export function sma(src, len) {
  const out = new Array(src.length).fill(null);
  let sum = 0;
  for (let i = 0; i < src.length; i++) {
    sum += src[i];
    if (i >= len) sum -= src[i - len];
    if (i >= len - 1) out[i] = sum / len;
  }
  return out;
}

export function ema(src, len) {
  const out = new Array(src.length).fill(null);
  const k = 2 / (len + 1);
  let prev = null;
  let seed = 0;
  for (let i = 0; i < src.length; i++) {
    if (i < len - 1) { seed += src[i]; continue; }
    if (i === len - 1) { prev = (seed + src[i]) / len; }       // seed with SMA
    else { prev = src[i] * k + prev * (1 - k); }
    out[i] = prev;
  }
  return out;
}

export function wma(src, len) {
  const out = new Array(src.length).fill(null);
  const denom = (len * (len + 1)) / 2;
  for (let i = len - 1; i < src.length; i++) {
    let sum = 0;
    for (let j = 0; j < len; j++) sum += src[i - j] * (len - j);
    out[i] = sum / denom;
  }
  return out;
}

// Wilder's RSI.
export function rsi(src, len) {
  const out = new Array(src.length).fill(null);
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i < src.length; i++) {
    const change = src[i] - src[i - 1];
    const gain = Math.max(change, 0);
    const loss = Math.max(-change, 0);
    if (i <= len) {
      avgGain += gain / len;
      avgLoss += loss / len;
      if (i < len) continue;
    } else {
      avgGain = (avgGain * (len - 1) + gain) / len;
      avgLoss = (avgLoss * (len - 1) + loss) / len;
    }
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

export function macd(src, fastLen = 12, slowLen = 26, signalLen = 9) {
  const fast = ema(src, fastLen);
  const slow = ema(src, slowLen);
  const macdLine = src.map((_, i) =>
    fast[i] != null && slow[i] != null ? fast[i] - slow[i] : null);
  // Signal = EMA of the macd line, starting where it becomes defined.
  const start = macdLine.findIndex(v => v != null);
  const signal = new Array(src.length).fill(null);
  if (start !== -1) {
    const seg = ema(macdLine.slice(start), signalLen);
    for (let i = 0; i < seg.length; i++) signal[start + i] = seg[i];
  }
  const hist = macdLine.map((v, i) =>
    v != null && signal[i] != null ? v - signal[i] : null);
  return { macd: macdLine, signal, hist };
}

export function stddev(src, len) {
  const out = new Array(src.length).fill(null);
  const mean = sma(src, len);
  for (let i = len - 1; i < src.length; i++) {
    let sumSq = 0;
    for (let j = i - len + 1; j <= i; j++) sumSq += (src[j] - mean[i]) ** 2;
    out[i] = Math.sqrt(sumSq / len);
  }
  return out;
}

export function bollinger(src, len = 20, mult = 2) {
  const middle = sma(src, len);
  const sd = stddev(src, len);
  const upper = middle.map((m, i) => (m != null ? m + mult * sd[i] : null));
  const lower = middle.map((m, i) => (m != null ? m - mult * sd[i] : null));
  return { upper, middle, lower };
}

// Wilder's ATR.
export function atr(high, low, close, len = 14) {
  const out = new Array(close.length).fill(null);
  let prev = null;
  let seed = 0;
  for (let i = 0; i < close.length; i++) {
    const tr = i === 0
      ? high[i] - low[i]
      : Math.max(high[i] - low[i], Math.abs(high[i] - close[i - 1]), Math.abs(low[i] - close[i - 1]));
    if (i < len - 1) { seed += tr; continue; }
    if (i === len - 1) prev = (seed + tr) / len;
    else prev = (prev * (len - 1) + tr) / len;
    out[i] = prev;
  }
  return out;
}

export function stochastic(high, low, close, kLen = 14, dLen = 3) {
  const k = new Array(close.length).fill(null);
  for (let i = kLen - 1; i < close.length; i++) {
    let hh = -Infinity, ll = Infinity;
    for (let j = i - kLen + 1; j <= i; j++) {
      if (high[j] > hh) hh = high[j];
      if (low[j] < ll) ll = low[j];
    }
    k[i] = hh === ll ? 50 : ((close[i] - ll) / (hh - ll)) * 100;
  }
  // %D = SMA of %K over its defined segment.
  const d = new Array(close.length).fill(null);
  const start = k.findIndex(v => v != null);
  if (start !== -1) {
    const seg = sma(k.slice(start), dLen);
    for (let i = 0; i < seg.length; i++) d[start + i] = seg[i];
  }
  return { k, d };
}

// Cumulative (session-less) VWAP over the whole series.
export function vwap(high, low, close, volume) {
  const out = new Array(close.length).fill(null);
  let pv = 0, v = 0;
  for (let i = 0; i < close.length; i++) {
    const typical = (high[i] + low[i] + close[i]) / 3;
    pv += typical * volume[i];
    v += volume[i];
    out[i] = v > 0 ? pv / v : null;
  }
  return out;
}

export function obv(close, volume) {
  const out = new Array(close.length).fill(null);
  let acc = 0;
  for (let i = 0; i < close.length; i++) {
    if (i > 0) {
      if (close[i] > close[i - 1]) acc += volume[i];
      else if (close[i] < close[i - 1]) acc -= volume[i];
    }
    out[i] = acc;
  }
  return out;
}

export function highest(src, len) {
  const out = new Array(src.length).fill(null);
  for (let i = len - 1; i < src.length; i++) {
    let hh = -Infinity;
    for (let j = i - len + 1; j <= i; j++) if (src[j] > hh) hh = src[j];
    out[i] = hh;
  }
  return out;
}

export function lowest(src, len) {
  const out = new Array(src.length).fill(null);
  for (let i = len - 1; i < src.length; i++) {
    let ll = Infinity;
    for (let j = i - len + 1; j <= i; j++) if (src[j] < ll) ll = src[j];
    out[i] = ll;
  }
  return out;
}

// Rate of change, percent.
export function roc(src, len) {
  const out = new Array(src.length).fill(null);
  for (let i = len; i < src.length; i++) {
    if (src[i - len] !== 0) out[i] = ((src[i] - src[i - len]) / src[i - len]) * 100;
  }
  return out;
}

// a crossed above/below b at index i. Either side may be an array or a constant.
const at = (s, i) => (Array.isArray(s) ? s[i] : s);

export function crossover(a, b, i) {
  if (i < 1) return false;
  const a0 = at(a, i - 1), a1 = at(a, i), b0 = at(b, i - 1), b1 = at(b, i);
  if (a0 == null || a1 == null || b0 == null || b1 == null) return false;
  return a0 <= b0 && a1 > b1;
}

export function crossunder(a, b, i) {
  if (i < 1) return false;
  const a0 = at(a, i - 1), a1 = at(a, i), b0 = at(b, i - 1), b1 = at(b, i);
  if (a0 == null || a1 == null || b0 == null || b1 == null) return false;
  return a0 >= b0 && a1 < b1;
}
