// Aggregate 1-minute buy/sell flow buckets (from GET /flow/{symbol}) onto the
// strategy's bar grid. Bars with NO covered minutes get null, not 0 — the
// collector only retains ~7 days of buckets, and "no data" must be
// distinguishable from "no flow" so strategies can guard with `nf == null`.

// oneMinRows: [[bucket_start_ms, buy_volume, sell_volume, trade_count], ...] ascending.
// barTimesSec: bar open times in unix SECONDS (lightweight-charts convention).
// intervalSec: bar width in seconds.
// Returns { buy, sell, net, trades } arrays aligned to barTimesSec.
export function aggregateFlow(oneMinRows, barTimesSec, intervalSec) {
  const n = barTimesSec.length;
  const buy = new Array(n).fill(null);
  const sell = new Array(n).fill(null);
  const net = new Array(n).fill(null);
  const trades = new Array(n).fill(null);
  if (!oneMinRows || oneMinRows.length === 0 || n === 0) return { buy, sell, net, trades };

  let r = 0;
  for (let i = 0; i < n; i++) {
    const startMs = barTimesSec[i] * 1000;
    const endMs = startMs + intervalSec * 1000;
    // Rows and bars are both ascending; advance a single cursor.
    while (r < oneMinRows.length && oneMinRows[r][0] < startMs) r++;
    let b = 0, s = 0, t = 0, covered = 0;
    let rr = r;
    while (rr < oneMinRows.length && oneMinRows[rr][0] < endMs) {
      b += oneMinRows[rr][1] || 0;
      s += oneMinRows[rr][2] || 0;
      t += oneMinRows[rr][3] || 0;
      covered++;
      rr++;
    }
    if (covered > 0) {
      buy[i] = b; sell[i] = s; net[i] = b - s; trades[i] = t;
    }
  }
  return { buy, sell, net, trades };
}

// How many bars have flow coverage (for the UI's "flow covers N of M bars" banner).
export function flowCoverage(flow) {
  if (!flow || !flow.buy) return 0;
  return flow.buy.reduce((acc, v) => acc + (v != null ? 1 : 0), 0);
}
