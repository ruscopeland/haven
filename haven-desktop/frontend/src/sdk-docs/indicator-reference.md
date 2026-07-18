# Indicator & helper reference

Every helper returns a **full array aligned to the bars**, with `null` during
warm-up. Read the current value with `[ctx.i]`, always with a null guard.
Results are cached — repeated calls are free.

Single-series helpers take `(len)` over closes, or `(srcArray, len)` over any
series (e.g. `ctx.sma(ctx.volume, 20)`).

| Helper | Returns | Notes |
|--------|---------|-------|
| `ctx.sma(len)` | simple moving average | |
| `ctx.ema(len)` | exponential moving average | |
| `ctx.wma(len)` | weighted moving average | |
| `ctx.rsi(len)` | RSI 0–100 | 14 is the classic length |
| `ctx.roc(len)` | % change vs `len` bars ago | momentum in percent |
| `ctx.stddev(len)` | standard deviation | volatility in price units |
| `ctx.highest(len)` / `ctx.lowest(len)` | rolling extremes | breakout levels |
| `ctx.macd(fast, slow, signal)` | `{ macd, signal, histogram }` | defaults 12/26/9 |
| `ctx.bb(len, mult)` | `{ upper, middle, lower }` | Bollinger, defaults 20/2 |
| `ctx.atr(len)` | average true range | defaults 14; good for stops |
| `ctx.stoch(kLen, dLen)` | `{ k, d }` | defaults 14/3 |
| `ctx.vwap()` | volume-weighted avg price | anchored to the window start |
| `ctx.obv()` | on-balance volume | |

## Cross helpers

Booleans about the **current** bar — no array indexing needed:

```js
if (ctx.crossover(ctx.ema(9), ctx.ema(21))) ctx.buy(50);   // fast crossed above slow
if (ctx.crossunder(ctx.rsi(14), 70)) ctx.sell({ pct: 50 }); // arrays or numbers
```

## Series access

`ctx.open/high/low/close/volume/time` are plain arrays (guarded against
look-ahead), `ctx.bars[i]` the bar objects. `ctx.i` is the current index —
`ctx.close[ctx.i]` is the current close, `ctx.close[ctx.i - 1]` the previous.
