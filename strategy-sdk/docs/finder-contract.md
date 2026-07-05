# Finder contract (Token Finder)

A finder ranks **every Alpha token** at every bar. It never trades — it
answers one question: *if a trade slot opened right now, which token should
get it?* Strategies subscribe to a finder to trade its top picks.

Your code must define a top-level `finder` object:

```js
const finder = {
  name: 'Flow momentum',
  params: { lookback: 8, minVol24hUsd: 100000 },   // defaults; editable in the form

  // OPTIONAL hard gate — return false and the token is excluded entirely.
  // Use it for liquidity floors so illiquid tokens can never rank.
  filter(ctx) {
    return ctx.token.volume24h >= ctx.params.minVol24hUsd;
  },

  // REQUIRED — return a number (higher = better) or null to skip this bar.
  score(ctx) {
    const momo = ctx.roc(ctx.params.lookback)[ctx.i];
    if (momo == null) return null;                 // warm-up guard
    return momo;
  },
};
```

## The finder ctx

Identical to a strategy ctx (same series, indicators, flow, look-ahead guard,
`ctx.params`, `ctx.state`, `ctx.log`) with two differences:

- **no trading surface** — there is no `ctx.buy` / `ctx.sell` / `ctx.position`;
- **`ctx.token`** = `{ symbol, name, volume24h, priceChange24h }` for the
  token being scored right now.

One more quirk: `ctx.volume` in finder code is **buy+sell USD volume** per
bar (the multi-token dataset has no token-quantity volume).

`score()` runs once per token per bar — a 3-day, 15-minute window over 100
tokens is ~29k calls per edit. Keep it simple; indicators are cached per
token, so `ctx.ema(48)` is still cheap.

## Scores are relative

Only the **ordering** matters, plus the switch margin: a flat strategy slot
rebinds when a challenger beats its current token's score by the margin
(default 10%). Keep scores on a stable scale — mixing units (e.g. raw USD
flow + percent momentum) makes the margin meaningless; normalize first, as
the templates do.

## Reading the panels

- **Ranking river** — who held each top-N spot over time. Choppy lines = a
  nervous finder; consider longer lookbacks or stronger filters.
- **Finder quality** — average forward return of your top-N picks vs the
  median of everything you scored. The green line living above the grey one
  is the entire point of a finder. If it isn't, the ranking has no edge at
  this horizon, and no strategy on top of it will fix that.
- **Pinned table** — click any moment in the river: full ranking, scores, and
  what each token actually did over the next N bars.

## From ranking to trades

Attach the finder to a strategy in the Strategies tab (Token selection →
Finder). Backtest = the portfolio simulator; DRY = paper trades on live
rankings; LIVE = real swaps, still behind every engine risk guard. The
data window is the collector's bucket history (~7 days at 1-minute
resolution, ~90 days at 15-minute via the archive), so rankings older than
that simply don't exist.
