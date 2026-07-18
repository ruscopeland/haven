# How strategies & finders run

Everything you write in the Strategies and Token Finder tabs is plain
JavaScript evaluated by the shared **strategy-sdk** runtime. The exact same
code runs in three places:

- **the workbench backtest** (this browser, instantly on every edit),
- **the dry runner** (paper trades in the engine daemon),
- **the live runner** (real on-chain swaps via the marker engine).

That is the core promise: *what the backtest showed is what live does*. Both
sides import one SDK; there is no separate "live version" of your code.

## The golden rule: no look-ahead

Your code runs once per **closed bar**. At bar `i` you can read bars `0..i` —
anything beyond returns `undefined`. The runtime enforces this: even if you
write `ctx.close[ctx.i + 1]`, you get `undefined`, in backtests AND live. If
a backtest looks too good, you are not accidentally peeking — you may still be
overfitting, though. Always sanity-check with the forward-return panel or a
dry run.

## Bars, warm-up, and `null`

- `bar` / `ctx.bars[i]` = `{ time, open, high, low, close, volume }`. `time`
  is Unix **seconds** and `volume` is licensed Binance Alpha USD OHLCV volume.
- Indicators need history: `ctx.rsi(14)[ctx.i]` is `null` for the first ~14
  bars. **Always guard**: `if (x == null) return;` — this is the single most
  common authoring bug.

## When do orders fill?

A signal emitted while processing bar `i` fills at bar `i+1`'s **open** —
never the same bar. TP/SL brackets are simulated intrabar, and when both could
fill in one bar, **SL wins** (pessimistic — mirrors the real engine's risk).
Fees and slippage are charged on every simulated fill (toolbar inputs).

## State that survives between bars

Use `ctx.state` — a plain object that persists for the whole run:

```js
init(ctx) { ctx.state.entries = 0; }
onBar(bar, ctx) { if (something) ctx.state.entries++; }
```

When a live runner starts, it **replays history through your code with
actions suppressed** so `ctx.state` is primed exactly as a backtest would
leave it. Restarting the engine never resets your logic mid-position: the
position itself is rebuilt from the trade history.

## Modes (strategies only)

- **OFF** — saved, not running.
- **DRY** — runs live bars, records PAPER trades. They never touch the wallet
  PnL, the engine's daily cap, or the chart's trade lines.
- **LIVE** — signals become real swaps through the marker engine, which still
  applies every risk guard: max trade USD, daily cap, price-impact abort,
  pause flag. The runner executes the **saved** code — save before arming.

Finders have no mode: they are passive rankings until a strategy subscribes
to one (see the Finder contract page).
