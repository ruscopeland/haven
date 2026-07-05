# Recipes

Worked examples you can insert and edit. Each block has an **Insert into
editor** button — inserting replaces the editor contents.

## Strategy: breakout with ATR stop

Buys a 20-bar high breakout, stop at 2×ATR, half off at +2R.

```js
const strategy = {
  name: 'ATR breakout',
  params: { hiLen: 20, atrLen: 14, atrMult: 2, usd: 50 },

  onBar(bar, ctx) {
    const hi = ctx.highest(ctx.params.hiLen);
    const atr = ctx.atr(ctx.params.atrLen);
    if (hi[ctx.i - 1] == null || atr[ctx.i] == null) return;

    if (!ctx.position.qty && bar.close > hi[ctx.i - 1]) {
      const stop = bar.close - ctx.params.atrMult * atr[ctx.i];
      const target = bar.close + 2 * (bar.close - stop);     // +2R
      ctx.buy(ctx.params.usd, { sl: stop, tp: target, tag: 'breakout' });
    }
  },
};
```

## Strategy: flow-confirmed dip

Only buys an RSI dip when real taker money agrees (net USD inflow).

```js
const strategy = {
  name: 'Flow-confirmed dip',
  params: { rsiLen: 14, buyBelow: 32, minNetUsd: 1000, usd: 50, slPct: 8 },

  onBar(bar, ctx) {
    const rsi = ctx.rsi(ctx.params.rsiLen);
    const nf = ctx.flow.net[ctx.i];
    if (rsi[ctx.i] == null || nf == null) return;

    if (!ctx.position.qty && rsi[ctx.i] < ctx.params.buyBelow && nf > ctx.params.minNetUsd) {
      ctx.buy(ctx.params.usd, { sl: bar.close * (1 - ctx.params.slPct / 100), tag: 'dip+flow' });
    }
    if (ctx.position.qty && rsi[ctx.i] > 60) {
      ctx.sell({ pct: 100 }, { tag: 'recovered' });
    }
  },
};
```

## Finder: normalized two-factor rank

The pattern most finders should follow: hard liquidity filter, then a score
built from **normalized** components so the switch margin stays meaningful.

```js
const finder = {
  name: 'Two-factor',
  params: { lookback: 16, flowWeight: 1, momoWeight: 1, minVol24hUsd: 100000 },

  filter(ctx) {
    return ctx.token.volume24h >= ctx.params.minVol24hUsd;
  },

  score(ctx) {
    const momo = ctx.roc(ctx.params.lookback)[ctx.i];        // already in %
    if (momo == null) return null;

    let net = 0;
    for (let j = 0; j < ctx.params.lookback; j++) {
      const v = ctx.flow.net[ctx.i - j];
      if (v == null) return null;
      net += v;
    }
    const flowPct = (net / ctx.token.volume24h) * 100;       // normalize to %

    return ctx.params.momoWeight * momo + ctx.params.flowWeight * flowPct;
  },
};
```

## Finder + strategy together

The full loop, end to end:

1. **Finder tab**: build a ranking (start from a template). Watch the quality
   strip — the green top-picks line should sit above the grey median line at
   the horizon you care about. Tune lookbacks/filters until it does. Save.
2. **Strategies tab**: pick or write a strategy. Set **Token selection →
   Finder**, choose your finder, set max positions (start with 2–3) and keep
   the 10% switch margin. The backtest becomes a portfolio run: the slot
   timeline shows which token each slot held when, with your fills on it.
3. Compare against the same strategy on a fixed symbol. Dynamic selection
   should beat it — if it doesn't, the finder adds churn, not edge.
4. **DRY** for at least a day. The runner ranks live bars, paper-trades the
   picks, and the workbench shows the paper fills. Check that dry behavior
   matches what backtests led you to expect.
5. **LIVE** when satisfied. Engine risk limits (max trade USD, daily cap,
   impact guard, pause flag) still apply to every finder-selected trade.

## Debugging checklist

- **No trades in a backtest** — indicator warm-up longer than the window?
  `ctx.flow` null (older than retention)? Filter too strict (finder)?
- **Red dot on a saved strategy/finder** — hover it: the runner recorded a
  runtime error (`last_error`). Fix the code and save; saving clears it on
  the next successful run.
- **Backtest ≠ dry run** — different interval? Unsaved draft (the runner
  executes the SAVED code)? Flow-dependent logic outside the 7-day window?
- **`ctx.log()`** output lands in the backtest log panel (and the engine
  debug log when live) — the fastest way to see why a bar didn't signal.
