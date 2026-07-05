# Strategy contract

Your code must define a top-level `strategy` object:

```js
const strategy = {
  name: 'My strategy',                    // optional, cosmetic
  params: { rsiLen: 14, usd: 50 },        // defaults; editable in the params form

  init(ctx) {                             // optional, once before the first bar
    ctx.state.warmedUp = false;
  },

  onBar(bar, ctx) {                       // REQUIRED — once per closed bar
    const rsi = ctx.rsi(ctx.params.rsiLen);
    if (rsi[ctx.i] == null) return;       // indicator warm-up guard

    if (!ctx.position.qty && rsi[ctx.i] < 30) {
      ctx.buy(ctx.params.usd, { sl: bar.close * 0.92, tag: 'dip' });
    }
    if (ctx.position.qty && rsi[ctx.i] > 65) {
      ctx.sell({ pct: 100 }, { tag: 'exit' });
    }
  },
};
```

## Actions

| Call | Meaning |
|------|---------|
| `ctx.buy(usd, opts?)` | Buy `usd` dollars worth. `opts.tp` / `opts.sl` attach a bracket (the engine places real TP/SL legs live; the backtester simulates them). `opts.tag` labels the trade. |
| `ctx.sell({ usd })` | Sell `usd` dollars worth of the position. |
| `ctx.sell({ pct })` | Sell a percentage of the position (default 100). |
| `ctx.log(msg)` | Write to the backtest log panel / engine debug log. |

## Reading state

| Field | Meaning |
|-------|---------|
| `ctx.i` | Current bar index. |
| `ctx.position` | `{ qty, avgCost, costUsd }` — live object, updated on fills. |
| `ctx.params` | Defaults merged with your overrides from the params form. |
| `ctx.state` | Your persistent scratch object. |
| `ctx.open/high/low/close/volume/time` | Full series arrays (look-ahead-guarded). |
| `ctx.flow.buy/sell/net/trades` | USD flow per bar; `null` = no data. |

Indicators are on the Indicator reference page. All of them are cached — call
`ctx.ema(21)` every bar for free.

## Sizing reality check (live)

`ctx.buy(50)` live means ~$50 of BNB swapped through OpenOcean. The engine
aborts sized buys when the BNB price is unavailable, aborts anything above
`max_trade_usd`, and aborts when the quoted price impact exceeds the limit.
A backtest fill is guaranteed; a live fill is not — dry-run first.

## Dynamic token selection (Token Finder)

A strategy normally runs on one fixed symbol. Attach a **finder** in the
workbench (Token selection → Finder) and it runs on the finder's top-ranked
tokens instead, across up to `max positions` concurrent slots:

- a slot **holding a position** stays locked to its token until you exit;
- a **flat** slot follows the ranking: it rebinds when a challenger beats the
  current token's score by the **switch margin** (hysteresis, default 10%);
- each rebind warm-replays your code on the new token's history (suppressed),
  so indicators and `ctx.state` are primed before the first live bar.

The same rule drives the portfolio backtest and the live runner — the slot
timeline you see in a backtest is exactly what the runner would have done.
