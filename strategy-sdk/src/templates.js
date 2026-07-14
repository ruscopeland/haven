// Starter strategies offered by the workbench's "new from template" menu.
// Each is a plain source string evaluated by loadStrategy().

export const TEMPLATES = [
  {
    name: 'RSI dip buyer',
    code: `// Buy oversold dips, exit when RSI recovers. Stop-loss via bracket.
const strategy = {
  name: 'RSI dip buyer',
  params: { rsiLen: 14, buyBelow: 30, sellAbove: 65, usd: 50, slPct: 8 },

  onBar(bar, ctx) {
    const rsi = ctx.rsi(ctx.params.rsiLen);
    if (rsi[ctx.i] == null) return;                 // indicator warm-up

    if (!ctx.position.qty && rsi[ctx.i] < ctx.params.buyBelow) {
      ctx.buy(ctx.params.usd, {
        sl: bar.close * (1 - ctx.params.slPct / 100),
        tag: 'rsi-dip',
      });
    }
    if (ctx.position.qty && rsi[ctx.i] > ctx.params.sellAbove) {
      ctx.sell({ pct: 100 }, { tag: 'rsi-exit' });
    }
  },
};
`,
  },
  {
    name: 'EMA cross',
    code: `// Classic trend-follow: buy the golden cross, sell the death cross.
const strategy = {
  name: 'EMA cross',
  params: { fast: 9, slow: 21, usd: 50 },

  onBar(bar, ctx) {
    const fast = ctx.ema(ctx.params.fast);
    const slow = ctx.ema(ctx.params.slow);

    if (!ctx.position.qty && ctx.crossover(fast, slow)) {
      ctx.buy(ctx.params.usd, { tag: 'golden' });
    }
    if (ctx.position.qty && ctx.crossunder(fast, slow)) {
      ctx.sell({ pct: 100 }, { tag: 'death' });
    }
  },
};
`,
  },
  {
    name: 'Bollinger mean-revert',
    code: `// Buy touches of the lower band, take profit at the middle band.
const strategy = {
  name: 'Bollinger mean-revert',
  params: { len: 20, mult: 2, usd: 50, slPct: 10 },

  onBar(bar, ctx) {
    const bb = ctx.bb(ctx.params.len, ctx.params.mult);
    if (bb.lower[ctx.i] == null) return;

    if (!ctx.position.qty && bar.close <= bb.lower[ctx.i]) {
      ctx.buy(ctx.params.usd, {
        tp: bb.middle[ctx.i],
        sl: bar.close * (1 - ctx.params.slPct / 100),
        tag: 'bb-dip',
      });
    }
  },
};
`,
  },
  {
    name: 'MACD momentum rider',
    code: `// Ride MACD momentum: enter when the histogram flips positive, bank half at
// an ATR-sized target (stop jumps to breakeven), exit the rest when momentum
// dies. Stop is managed in code, so live behavior matches the backtest exactly.
const strategy = {
  name: 'MACD momentum rider',
  params: { fast: 12, slow: 26, signal: 9, atrLen: 14, bankAtr: 2.5, slAtr: 2, usd: 60 },

  onBar(bar, ctx) {
    const { hist } = ctx.macd(ctx.params.fast, ctx.params.slow, ctx.params.signal);
    const atr = ctx.atr(ctx.params.atrLen);
    if (hist[ctx.i] == null || hist[ctx.i - 1] == null || atr[ctx.i] == null) return;

    if (!ctx.position.qty) {
      if (ctx.crossover(hist, 0)) {
        ctx.state.stop = bar.close - ctx.params.slAtr * atr[ctx.i];
        ctx.state.banked = false;
        ctx.buy(ctx.params.usd, { tag: 'macd-flip' });
      }
      return;
    }

    // Self-heal after a restart mid-position (state.stop lost).
    if (ctx.state.stop == null) {
      ctx.state.stop = ctx.position.avgCost - ctx.params.slAtr * atr[ctx.i];
    }
    if (bar.close < ctx.state.stop) {
      ctx.sell({ pct: 100 }, { tag: 'stop' });
      return;
    }
    if (!ctx.state.banked &&
        bar.close >= ctx.position.avgCost + ctx.params.bankAtr * atr[ctx.i]) {
      ctx.state.banked = true;
      ctx.state.stop = ctx.position.avgCost;      // rest of the trade rides risk-free
      ctx.sell({ pct: 50 }, { tag: 'bank-half' });
    }
    if (ctx.crossunder(hist, 0)) {
      ctx.sell({ pct: 100 }, { tag: 'hist-flip' });
    }
  },
};
`,
  },
  {
    name: 'Donchian chandelier',
    code: `// Breakout trend-follow with a ratcheting exit: buy a close above the prior
// N-bar high, then trail a chandelier stop (highest point reached minus
// k*ATR) that only ever moves up. No fixed target — winners run.
const strategy = {
  name: 'Donchian chandelier',
  params: { chLen: 24, atrLen: 14, trailMult: 3, usd: 60 },

  onBar(bar, ctx) {
    const hh = ctx.highest(ctx.high, ctx.params.chLen);
    const atr = ctx.atr(ctx.params.atrLen);
    if (hh[ctx.i - 1] == null || atr[ctx.i] == null) return;

    if (!ctx.position.qty) {
      if (bar.close > hh[ctx.i - 1]) {
        ctx.state.trail = bar.close - ctx.params.trailMult * atr[ctx.i];
        ctx.buy(ctx.params.usd, { tag: 'breakout' });
      }
      return;
    }

    // Ratchet: the stop follows price up, never down. The null check also
    // re-seeds the trail after a restart mid-position.
    const candidate = bar.high - ctx.params.trailMult * atr[ctx.i];
    if (ctx.state.trail == null || candidate > ctx.state.trail) {
      ctx.state.trail = candidate;
    }
    if (bar.close < ctx.state.trail) {
      ctx.sell({ pct: 100 }, { tag: 'chandelier' });
    }
  },
};
`,
  },
  {
    name: 'Squeeze breakout',
    code: `// TTM-style squeeze: when the Bollinger bands compress inside the Keltner
// channel, volatility is coiled. Buy the upward release after enough coiling;
// exit on a close back below the channel midline. Bracket SL under the base.
const strategy = {
  name: 'Squeeze breakout',
  params: { len: 20, bbMult: 2, kcMult: 1.5, minSqueeze: 6, slAtr: 2, usd: 60 },

  onBar(bar, ctx) {
    const bb = ctx.bb(ctx.params.len, ctx.params.bbMult);
    const mid = ctx.ema(ctx.params.len);
    const atr = ctx.atr(ctx.params.len);
    if (bb.upper[ctx.i] == null || mid[ctx.i] == null || atr[ctx.i] == null) return;

    // Trade management first — a re-squeeze must not pause the exit.
    if (ctx.position.qty && bar.close < mid[ctx.i]) {
      ctx.sell({ pct: 100 }, { tag: 'mid-fail' });
    }

    const squeezed =
      bb.upper[ctx.i] < mid[ctx.i] + ctx.params.kcMult * atr[ctx.i] &&
      bb.lower[ctx.i] > mid[ctx.i] - ctx.params.kcMult * atr[ctx.i];

    if (squeezed) {
      ctx.state.squeezeBars = (ctx.state.squeezeBars || 0) + 1;
      return;
    }
    const coiled = (ctx.state.squeezeBars || 0) >= ctx.params.minSqueeze;
    ctx.state.squeezeBars = 0;

    if (!ctx.position.qty && coiled && bar.close > bb.upper[ctx.i]) {
      ctx.buy(ctx.params.usd, {
        sl: bar.close - ctx.params.slAtr * atr[ctx.i],
        tag: 'squeeze-pop',
      });
    }
  },
};
`,
  },
  {
    name: 'Trend pullback (stoch)',
    code: `// Buy-the-dip in an established uptrend: EMA trend filter + a stochastic
// hook up from oversold. Exits on overbought stochastic or trend failure.
const strategy = {
  name: 'Trend pullback (stoch)',
  params: { trendLen: 50, kLen: 14, dLen: 3, buyZone: 35, exitZone: 80, slPct: 6, usd: 60 },

  onBar(bar, ctx) {
    const ema = ctx.ema(ctx.params.trendLen);
    const st = ctx.stoch(ctx.params.kLen, ctx.params.dLen);
    if (ema[ctx.i] == null || ema[ctx.i - 5] == null || st.d[ctx.i] == null) return;

    const uptrend = bar.close > ema[ctx.i] && ema[ctx.i] > ema[ctx.i - 5];

    if (!ctx.position.qty && uptrend &&
        st.k[ctx.i] < ctx.params.buyZone && ctx.crossover(st.k, st.d)) {
      ctx.buy(ctx.params.usd, {
        sl: bar.close * (1 - ctx.params.slPct / 100),
        tag: 'pullback',
      });
    }
    if (ctx.position.qty &&
        (st.k[ctx.i] > ctx.params.exitZone || ctx.crossunder(ctx.close, ema))) {
      ctx.sell({ pct: 100 }, {
        tag: st.k[ctx.i] > ctx.params.exitZone ? 'stoch-high' : 'trend-fail',
      });
    }
  },
};
`,
  },
  {
    name: 'RSI divergence',
    code: `// Bullish RSI divergence: price prints a lower low while RSI prints a higher
// low — sellers pushing with fading force. Pivot lows confirm pivotStrength
// bars after the fact and are tracked in ctx.state.
const strategy = {
  name: 'RSI divergence',
  params: { rsiLen: 14, pivotStrength: 2, maxGapBars: 40, maxRsi: 45, exitRsi: 60, slPct: 5, usd: 50 },

  onBar(bar, ctx) {
    const rsi = ctx.rsi(ctx.params.rsiLen);
    const w = ctx.params.pivotStrength;
    const p = ctx.i - w;                          // candidate pivot bar
    if (p - w < 0 || rsi[p] == null) return;

    // p is a pivot low if its low undercuts the w bars on each side.
    let isPivot = true;
    for (let j = 1; j <= w; j++) {
      if (ctx.low[p] > ctx.low[p - j] || ctx.low[p] > ctx.low[p + j]) {
        isPivot = false;
        break;
      }
    }

    if (isPivot) {
      const prev = ctx.state.lastPivot;
      if (prev && p - prev.bar <= ctx.params.maxGapBars && !ctx.position.qty &&
          ctx.low[p] < prev.low && rsi[p] > prev.rsi && rsi[p] < ctx.params.maxRsi) {
        ctx.buy(ctx.params.usd, {
          sl: ctx.low[p] * (1 - ctx.params.slPct / 100),
          tag: 'bull-div',
        });
      }
      ctx.state.lastPivot = { bar: p, low: ctx.low[p], rsi: rsi[p] };
    }

    if (ctx.position.qty && rsi[ctx.i] != null && rsi[ctx.i] > ctx.params.exitRsi) {
      ctx.sell({ pct: 100 }, { tag: 'rsi-exit' });
    }
  },
};
`,
  },
  {
    name: 'DCA ladder',
    code: `// Laddered accumulation: open a starter position on weakness, add a rung each
// time price drops another step below the last fill, then exit the whole
// stack at a profit target measured from the blended average cost.
const strategy = {
  name: 'DCA ladder',
  params: { rsiLen: 14, startBelow: 40, stepPct: 3, maxRungs: 4, tpPct: 4, usd: 40 },

  onBar(bar, ctx) {
    const rsi = ctx.rsi(ctx.params.rsiLen);
    if (rsi[ctx.i] == null) return;

    if (!ctx.position.qty) {
      ctx.state.rungs = 0;
      if (rsi[ctx.i] < ctx.params.startBelow) {
        ctx.state.rungs = 1;
        ctx.state.lastRungPrice = bar.close;
        ctx.buy(ctx.params.usd, { tag: 'rung-1' });
      }
      return;
    }

    // Self-heal after a restart mid-position.
    if (ctx.state.lastRungPrice == null) {
      ctx.state.lastRungPrice = bar.close;
      ctx.state.rungs = ctx.state.rungs || 1;
    }

    // Whole-stack take-profit from the blended entry.
    if (bar.close >= ctx.position.avgCost * (1 + ctx.params.tpPct / 100)) {
      ctx.sell({ pct: 100 }, { tag: 'ladder-tp' });
      return;
    }

    // Add the next rung one step lower.
    if (ctx.state.rungs < ctx.params.maxRungs &&
        bar.close <= ctx.state.lastRungPrice * (1 - ctx.params.stepPct / 100)) {
      ctx.state.rungs += 1;
      ctx.state.lastRungPrice = bar.close;
      ctx.buy(ctx.params.usd, { tag: 'rung-' + ctx.state.rungs });
    }
  },
};
`,
  },
  {
    name: 'OBV breakout',
    code: `// A price breakout only counts when cumulative volume flow (OBV) breaks out
// with it — otherwise it's a thin push that fades. Pure bracket exit, sized
// in ATRs, so the engine manages the trade live.
const strategy = {
  name: 'OBV breakout',
  params: { chLen: 24, atrLen: 14, tpAtr: 3, slAtr: 1.5, usd: 60 },

  onBar(bar, ctx) {
    const obv = ctx.obv();
    const hhPrice = ctx.highest(ctx.high, ctx.params.chLen);
    const hhObv = ctx.highest(obv, ctx.params.chLen);
    const atr = ctx.atr(ctx.params.atrLen);
    if (hhPrice[ctx.i - 1] == null || hhObv[ctx.i - 1] == null || atr[ctx.i] == null) return;

    if (!ctx.position.qty &&
        bar.close > hhPrice[ctx.i - 1] && obv[ctx.i] > hhObv[ctx.i - 1]) {
      ctx.buy(ctx.params.usd, {
        tp: bar.close + ctx.params.tpAtr * atr[ctx.i],
        sl: bar.close - ctx.params.slAtr * atr[ctx.i],
        tag: 'obv-breakout',
      });
    }
  },
};
`,
  },
];

// Starter finders for the Token Finder tab. Same evaluation style as
// strategies (loadFinder), but the contract is filter/score per token —
// finders rank, they never trade.
export const FINDER_TEMPLATES = [
  {
    name: 'Volume spike',
    code: `// Rank by how unusual current activity is vs the token's own baseline.
// Finds tokens "waking up" before the move is over.
const finder = {
  name: 'Volume spike',
  params: { fast: 4, slow: 48, minVol24hUsd: 50000, minSpike: 1.5 },

  filter(ctx) {
    return ctx.token.volume24h >= ctx.params.minVol24hUsd;
  },

  score(ctx) {
    // ctx.volume in finder ctxs = buy+sell USD per bar.
    const fast = ctx.sma(ctx.volume, ctx.params.fast)[ctx.i];
    const slow = ctx.sma(ctx.volume, ctx.params.slow)[ctx.i];
    if (fast == null || slow == null || slow <= 0) return null;

    const spike = fast / slow;                              // 1 = normal activity
    if (spike < ctx.params.minSpike) return null;           // nothing happening

    return spike;
  },
};
`,
  },
  {
    name: 'Relative strength',
    code: `// Rank by risk-adjusted momentum: return over the window divided by its
// volatility. Prefers steady climbers over single-candle spikes.
const finder = {
  name: 'Relative strength',
  params: { lookback: 24, minVol24hUsd: 100000 },

  filter(ctx) {
    return ctx.token.volume24h >= ctx.params.minVol24hUsd;
  },

  score(ctx) {
    const ret = ctx.roc(ctx.params.lookback)[ctx.i];
    const vol = ctx.stddev(ctx.params.lookback)[ctx.i];
    const price = ctx.close[ctx.i];
    if (ret == null || vol == null || !(price > 0)) return null;

    const volPct = (vol / price) * 100;                     // stddev as % of price
    if (volPct <= 0) return null;                           // flat line — untradeable
    return ret / volPct;                                    // "Sharpe-ish" momentum
  },
};
`,
  },
  {
    name: 'Squeeze scanner',
    code: `// Rank by volatility compression: Bollinger bandwidth at its tightest vs the
// token's own recent range. 3 = bands three times tighter than normal — a
// loaded spring. Pair with a breakout strategy.
const finder = {
  name: 'Squeeze scanner',
  params: { len: 20, mult: 2, baseline: 48, minVol24hUsd: 50000 },

  filter(ctx) {
    return ctx.token.volume24h >= ctx.params.minVol24hUsd;
  },

  score(ctx) {
    const bb = ctx.bb(ctx.params.len, ctx.params.mult);
    const m = bb.middle[ctx.i];
    if (m == null || !(m > 0)) return null;
    const width = (bb.upper[ctx.i] - bb.lower[ctx.i]) / m;
    if (!(width > 0)) return null;                   // dead flat = no data, not a squeeze

    // Average bandwidth over the baseline window, from the cached bb arrays.
    let sum = 0, n = 0;
    for (let j = 0; j < ctx.params.baseline; j++) {
      const u = bb.upper[ctx.i - j], l = bb.lower[ctx.i - j], mm = bb.middle[ctx.i - j];
      if (u == null || mm == null || !(mm > 0)) continue;
      sum += (u - l) / mm; n++;
    }
    if (n < ctx.params.baseline / 2 || sum <= 0) return null;

    return (sum / n) / width;
  },
};
`,
  },
  {
    name: 'Consistent climber',
    code: `// Rank steady stair-steppers: total return weighted by the fraction of green
// bars. A 20% pump in one candle scores far below 20% earned bar after bar —
// steadier trends are kinder to trend-following entries.
const finder = {
  name: 'Consistent climber',
  params: { lookback: 36, minVol24hUsd: 100000 },

  filter(ctx) {
    return ctx.token.volume24h >= ctx.params.minVol24hUsd;
  },

  score(ctx) {
    const ret = ctx.roc(ctx.params.lookback)[ctx.i];
    if (ret == null || ret <= 0) return null;

    let up = 0;
    for (let j = 0; j < ctx.params.lookback; j++) {
      const k = ctx.i - j;
      if (ctx.close[k] > ctx.open[k]) up++;          // gap bars are flat → not green
    }
    const consistency = up / ctx.params.lookback;    // 1 = every bar green
    return ret * consistency * consistency;
  },
};
`,
  },
  {
    name: 'VWAP reclaim',
    code: `// Rank fresh VWAP reclaims: tokens that spent a stretch below VWAP and just
// crossed back above it. Newer reclaims from deeper dips score highest —
// the classic "flush then reclaim" reversal shape.
const finder = {
  name: 'VWAP reclaim',
  params: { minBelowBars: 6, maxAgeBars: 3, minVol24hUsd: 50000 },

  filter(ctx) {
    return ctx.token.volume24h >= ctx.params.minVol24hUsd;
  },

  score(ctx) {
    const vwap = ctx.vwap();
    if (vwap[ctx.i] == null || ctx.close[ctx.i] <= vwap[ctx.i]) return null;

    // How many bars ago was the reclaim?
    let age = 0;
    while (age <= ctx.params.maxAgeBars && ctx.i - age - 1 >= 0 &&
           ctx.close[ctx.i - age - 1] > vwap[ctx.i - age - 1]) age++;
    if (age > ctx.params.maxAgeBars) return null;    // reclaim is stale news

    // How long and how deep was the stretch below? (walk capped for speed)
    let below = 0, deepest = 0;
    while (below < 200) {
      const k = ctx.i - age - 1 - below;
      if (k < 0 || vwap[k] == null || ctx.close[k] > vwap[k]) break;
      const depth = ((vwap[k] - ctx.close[k]) / vwap[k]) * 100;
      if (depth > deepest) deepest = depth;
      below++;
    }
    if (below < ctx.params.minBelowBars) return null;

    return deepest + (ctx.params.maxAgeBars - age);  // deeper dip + fresher = better
  },
};
`,
  },
];
