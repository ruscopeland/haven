# Practical recipes

These examples use only the licensed Binance Alpha OHLCV series available in backtests,
paper mode, and live mode.

## Strategy: RSI dip with a volume floor

```js
const strategy = {
  params: { rsiLen: 14, minVolume: 100000, usd: 25, slPct: 7 },
  onBar(bar, ctx) {
    const rsi = ctx.rsi(ctx.params.rsiLen)[ctx.i];
    if (rsi == null || bar.volume < ctx.params.minVolume) return;
    if (!ctx.position.qty && rsi < 30) {
      ctx.buy(ctx.params.usd, { sl: bar.close * (1 - ctx.params.slPct / 100), tag: 'rsi-dip' });
    } else if (ctx.position.qty && rsi > 60) {
      ctx.sell({ pct: 100 }, { tag: 'rsi-exit' });
    }
  },
};
```

## Finder: volume momentum

```js
const finder = {
  params: { fast: 4, slow: 24, minVol24hUsd: 100000 },
  filter(ctx) { return ctx.token.volume24h >= ctx.params.minVol24hUsd; },
  score(ctx) {
    const fast = ctx.sma(ctx.volume, ctx.params.fast)[ctx.i];
    const slow = ctx.sma(ctx.volume, ctx.params.slow)[ctx.i];
    return fast != null && slow > 0 ? fast / slow : null;
  },
};
```

If a helper returns `null`, it needs more warm-up bars. A live fill can still
be rejected by wallet balance, security, size, transaction, or impact guards.
