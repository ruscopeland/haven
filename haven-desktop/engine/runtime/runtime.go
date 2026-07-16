// Package runtime provides the goja JavaScript VM integration for executing
// user-authored strategies and finders. It creates a sandboxed JS environment
// where user code can only access explicitly exposed functions (ctx.ema, ctx.buy, etc.).
package runtime

import (
	"fmt"
	"math"
	"sync"

	"github.com/dop251/goja"

	"github.com/ruscopeland/haven-desktop/engine/indicators"
)

// Strategy is a loaded user strategy ready for execution.
type Strategy struct {
	vm       *goja.Runtime
	stratObj goja.Value
	onBar    goja.Callable
}

// BacktestCtx is the context object passed to user strategies during backtesting.
// It implements the strategy-sdk API surface: indicators, buy/sell, position info.
type BacktestCtx struct {
	mu       sync.Mutex
	bars     []BarData
	cursor   int
	usd      float64
	feePct   float64
	slipPct  float64
	vm       *goja.Runtime
	ctxObj   *goja.Object

	// Indicator cache: key → []float64
	indicatorCache map[string][]float64

	// Pending signal queues
	buyQueue  []pendingBuy
	sellQueue []pendingSell

	// User state (ctx.state) — persisted across bars
	state map[string]interface{}

	logs []string
}

type pendingBuy struct {
	usd float64
	tp  float64
	sl  float64
}

type pendingSell struct {
	pct float64
	qty float64
}

// BarData is a single OHLCV bar exposed to strategies.
type BarData struct {
	Time   int64
	Open   float64
	High   float64
	Low    float64
	Close  float64
	Volume float64
}

// LoadStrategy loads user JavaScript strategy code into a goja VM.
// The code must define `const strategy = { onBar(bar, ctx) { ... } }`.
// Returns the loaded strategy or an error string.
func LoadStrategy(code string, params map[string]float64) (*Strategy, string) {
	vm := goja.New()

	// Set up the console for debugging
	console := vm.NewObject()
	console.Set("log", func(call goja.FunctionCall) goja.Value {
		// Logging is captured but not surfaced to the UI by default
		return goja.Undefined()
	})
	vm.Set("console", console)

	// Run the user code to define `strategy`
	_, err := vm.RunString(`"use strict";` + "\n" + code + "\n;void 0;")
	if err != nil {
		return nil, fmt.Sprintf("syntax error: %v", err)
	}

	// Extract the strategy object
	stratVal := vm.Get("strategy")
	if stratVal == nil || goja.IsUndefined(stratVal) {
		return nil, "strategy object not found — code must define `const strategy = { ... }`"
	}

	stratObj := stratVal.ToObject(vm)
	onBarVal := stratObj.Get("onBar")
	if onBarVal == nil || goja.IsUndefined(onBarVal) {
		return nil, "strategy must define `onBar(bar, ctx)`"
	}

	onBar, ok := goja.AssertFunction(onBarVal)
	if !ok {
		return nil, "strategy.onBar is not a function"
	}

	// Merge params
	paramsObj := stratObj.Get("params")
	if paramsObj != nil && !goja.IsUndefined(paramsObj) {
		if pObj, ok := paramsObj.(*goja.Object); ok {
			for _, key := range pObj.Keys() {
				if _, exists := params[key]; !exists {
					if v := pObj.Get(key); v != nil {
						params[key] = v.ToFloat()
					}
				}
			}
		}
	}

	// Run init() if defined
	if initVal := stratObj.Get("init"); initVal != nil && !goja.IsUndefined(initVal) {
		if initFn, ok := goja.AssertFunction(initVal); ok {
			initFn(stratObj)
		}
	}

	return &Strategy{
		vm:       vm,
		stratObj: stratVal,
		onBar:    onBar,
	}, ""
}

// NewBacktestCtx creates a new context for backtesting.
func NewBacktestCtx(bars []BarData, startUsd, feePct, slippagePct float64, params map[string]float64) *BacktestCtx {
	vm := goja.New()
	ctx := &BacktestCtx{
		bars:           bars,
		cursor:         -1,
		usd:            startUsd,
		feePct:         feePct,
		slipPct:        slippagePct,
		vm:             vm,
		indicatorCache: make(map[string][]float64),
		state:          make(map[string]interface{}),
	}

	// Build the ctx object exposed to user JS
	ctx.ctxObj = ctx.buildJSContext(params)
	return ctx
}

// buildJSContext creates the goja object that user strategies interact with.
func (c *BacktestCtx) buildJSContext(params map[string]float64) *goja.Object {
	obj := c.vm.NewObject()

	// --- ctx.buy(usd, { tp, sl }) ---
	obj.Set("buy", func(call goja.FunctionCall) goja.Value {
		usd := call.Argument(0).ToFloat()
		if !(usd > 0) {
			return goja.Undefined()
		}
		var tp, sl float64
		if opts := call.Argument(1); !goja.IsUndefined(opts) {
			if optsObj, ok := opts.(*goja.Object); ok {
				tp = safeFloat(optsObj.Get("tp"))
				sl = safeFloat(optsObj.Get("sl"))
			}
		}
		c.buyQueue = append(c.buyQueue, pendingBuy{usd: usd, tp: tp, sl: sl})
		return goja.Undefined()
	})

	// --- ctx.sell(pct, { tp, sl }) ---
	obj.Set("sell", func(call goja.FunctionCall) goja.Value {
		pct := call.Argument(0).ToFloat()
		if !(pct > 0 && pct <= 100) {
			return goja.Undefined()
		}
		c.sellQueue = append(c.sellQueue, pendingSell{pct: pct})
		return goja.Undefined()
	})

	// --- ctx.close — convenience for ctx.sell(100) ---
	obj.Set("close", func(call goja.FunctionCall) goja.Value {
		c.sellQueue = append(c.sellQueue, pendingSell{pct: 100})
		return goja.Undefined()
	})

	// --- Indicator bindings ---
	c.bindIndicators(obj)

	// --- ctx.params ---
	paramsObj := c.vm.NewObject()
	for k, v := range params {
		paramsObj.Set(k, v)
	}
	obj.Set("params", paramsObj)

	// --- ctx.state (persisted across bars) ---
	stateObj := c.vm.NewObject()
	obj.Set("state", stateObj)

	// --- ctx.bar — current bar data (read-only) ---
	barObj := c.vm.NewObject()
	obj.Set("bar", barObj)

	// --- ctx.usd — available USD ---
	obj.Set("usd", 0.0)

	// --- ctx.position ---
	posObj := c.vm.NewObject()
	obj.Set("position", posObj)

	// --- ctx.i — current bar index ---
	obj.Set("i", -1)

	// --- ctx.log ---
	obj.Set("log", func(call goja.FunctionCall) goja.Value {
		msg := call.Argument(0).String()
		c.logs = append(c.logs, msg)
		return goja.Undefined()
	})

	return obj
}

// indicatorKey creates a cache key for an indicator call.
func (c *BacktestCtx) indicatorKey(name string, args []float64) string {
	key := name
	for _, a := range args {
		key += fmt.Sprintf(":%.0f", a)
	}
	return key
}

// getOHLCV extracts OHLCV columns from the bars for indicator calculation.
func (c *BacktestCtx) getOHLCV() (open, high, low, close, volume []float64) {
	n := len(c.bars)
	open = make([]float64, n)
	high = make([]float64, n)
	low = make([]float64, n)
	close = make([]float64, n)
	volume = make([]float64, n)
	for i, b := range c.bars {
		open[i] = b.Open
		high[i] = b.High
		low[i] = b.Low
		close[i] = b.Close
		volume[i] = b.Volume
	}
	return
}

// RunOnBar advances the cursor and calls strategy.onBar(bar, ctx) for bar i.
func (c *BacktestCtx) RunOnBar(i int, strat *Strategy) string {
	c.mu.Lock()
	defer c.mu.Unlock()

	c.cursor = i
	bar := c.bars[i]

	// Update the ctx object for this bar
	c.updateJSBar(bar, i)

	// Call strategy.onBar(bar, ctx)
	jsBar := c.buildJSBar(bar)
	_, err := strat.onBar(strat.stratObj, jsBar, c.ctxObj)
	if err != nil {
		return fmt.Sprintf("strategy error at bar %d (%d): %v", i, bar.Time, err)
	}

	return ""
}

func (c *BacktestCtx) updateJSBar(bar BarData, i int) {
	barObj := c.ctxObj.Get("bar").(*goja.Object)
	barObj.Set("time", bar.Time)
	barObj.Set("open", bar.Open)
	barObj.Set("high", bar.High)
	barObj.Set("low", bar.Low)
	barObj.Set("close", bar.Close)
	barObj.Set("volume", bar.Volume)
	barObj.Set("index", i)

	c.ctxObj.Set("i", i)
	c.ctxObj.Set("usd", c.usd)
}

func (c *BacktestCtx) buildJSBar(bar BarData) goja.Value {
	obj := c.vm.NewObject()
	obj.Set("time", bar.Time)
	obj.Set("open", bar.Open)
	obj.Set("high", bar.High)
	obj.Set("low", bar.Low)
	obj.Set("close", bar.Close)
	obj.Set("volume", bar.Volume)
	obj.Set("index", c.cursor)
	return obj
}

// FillQueuedBuys processes buy signals from the previous bar at this bar's open.
func (c *BacktestCtx) FillQueuedBuys(bar BarData, pos *Position, trades *[]Trade) {
	if len(c.buyQueue) == 0 {
		return
	}

	fillPrice := bar.Open * (1 + c.slipPct)
	for _, bq := range c.buyQueue {
		if bq.usd <= 0 || c.usd <= 0 {
			continue
		}
		usdAfterFee := bq.usd * (1 - c.feePct)
		if usdAfterFee > c.usd {
			usdAfterFee = c.usd
		}
		qty := usdAfterFee / fillPrice
		if !(qty > 0) {
			continue
		}

		costUsd := qty * fillPrice
		feeUsd := bq.usd * c.feePct

		*trades = append(*trades, Trade{
			Time: bar.Time, Side: "buy", Qty: qty,
			Price: fillPrice, Usd: costUsd, FeeUsd: feeUsd,
			Slippage: costUsd - qty*bar.Open,
			Type:     "signal",
		})

		c.usd -= bq.usd

		// Add to position (for bracket tracking by the caller)
		pos.Qty += qty
		pos.CostUsd += costUsd
		if pos.Qty > 0 {
			pos.AvgCost = pos.CostUsd / pos.Qty
		}

		if bq.tp > 0 || bq.sl > 0 {
			pos.Lots = append(pos.Lots, BracketLot{
				Qty: qty, CostUsd: costUsd, AvgCost: fillPrice,
				Tp: bq.tp, Sl: bq.sl,
			})
		}
	}
	c.buyQueue = nil
}

// FillQueuedSells processes sell signals from the previous bar at this bar's open.
func (c *BacktestCtx) FillQueuedSells(bar BarData, pos *Position, trades *[]Trade) {
	if len(c.sellQueue) == 0 || pos.Qty <= 0 {
		c.sellQueue = nil
		return
	}

	fillPrice := bar.Open * (1 - c.slipPct)
	for _, sq := range c.sellQueue {
		qty := pos.Qty * sq.pct / 100.0
		if !(qty > 0) {
			continue
		}
		if qty > pos.Qty {
			qty = pos.Qty
		}

		usd := qty * fillPrice
		feeUsd := usd * c.feePct

		*trades = append(*trades, Trade{
			Time: bar.Time, Side: "sell", Qty: qty,
			Price: fillPrice, Usd: usd - feeUsd, FeeUsd: feeUsd,
			Slippage: qty*bar.Open - qty*fillPrice,
			Type:     "signal",
		})

		c.usd += usd - feeUsd
		pos.Qty -= qty
		pos.CostUsd -= pos.AvgCost * qty

		if pos.Qty <= 0 {
			pos.Qty = 0
			pos.CostUsd = 0
			pos.AvgCost = 0
			pos.Lots = nil
		}
	}
	c.sellQueue = nil
}

// Equity calculates the current total equity (USD + position value).
func (c *BacktestCtx) Equity(price float64, pos Position) float64 {
	return math.Round((c.usd+pos.Qty*price)*100) / 100
}

// PendingSignals returns signals that were queued on the final bar.
func (c *BacktestCtx) PendingSignals() []PendingSignal {
	var p []PendingSignal
	for _, bq := range c.buyQueue {
		p = append(p, PendingSignal{Side: "buy", Usd: bq.usd, Tp: bq.tp, Sl: bq.sl})
	}
	for _, sq := range c.sellQueue {
		p = append(p, PendingSignal{Side: "sell", Pct: sq.pct, Qty: sq.qty})
	}
	c.buyQueue = nil
	c.sellQueue = nil
	return p
}

// FinderFn is a loaded user finder function ready for evaluation.
type FinderFn struct {
	vm   *goja.Runtime
	fn   goja.Callable
	code string
}

// LoadFinder loads a user's JavaScript finder function.
// The code must define `const finder = (symbol, open, high, low, close, volume, index, time) => score`.
func LoadFinder(code string) (*FinderFn, string) {
	vm := goja.New()

	_, err := vm.RunString(`"use strict";` + "\n" + code + "\n;void 0;")
	if err != nil {
		return nil, fmt.Sprintf("finder syntax error: %v", err)
	}

	finderVal := vm.Get("finder")
	if finderVal == nil || goja.IsUndefined(finderVal) {
		return nil, "finder function not found — code must define `const finder = (...) => ...`"
	}

	fn, ok := goja.AssertFunction(finderVal)
	if !ok {
		return nil, "finder is not a function"
	}

	return &FinderFn{vm: vm, fn: fn, code: code}, ""
}

// Evaluate calls the finder function for a single token at a single bar.
func (f *FinderFn) Evaluate(symbol string, open, high, low, close, volume float64, index int, time int64) (float64, string, string) {
	result, err := f.fn(goja.Undefined(),
		f.vm.ToValue(symbol),
		f.vm.ToValue(open),
		f.vm.ToValue(high),
		f.vm.ToValue(low),
		f.vm.ToValue(close),
		f.vm.ToValue(volume),
		f.vm.ToValue(index),
		f.vm.ToValue(time),
	)
	if err != nil {
		return math.NaN(), "", fmt.Sprintf("finder error for %s at %d: %v", symbol, time, err)
	}

	score := result.ToFloat()
	return score, "", ""
}

func safeFloat(v goja.Value) float64 {
	if v == nil || goja.IsUndefined(v) || goja.IsNaN(v) {
		return 0
	}
	return v.ToFloat()
}

// bindIndicators adds indicator functions (sma, ema, rsi, etc.) to the ctx object.
func (c *BacktestCtx) bindIndicators(obj *goja.Object) {
	// Get full OHLCV arrays (cached once)
	_, high, low, closeData, volume := c.getOHLCV()

	getArg := func(call goja.FunctionCall, idx int, def float64) float64 {
		if idx < len(call.Arguments) {
			return call.Arguments[idx].ToFloat()
		}
		return def
	}

	cached := func(name string, period int, compute func() []float64) goja.Value {
		key := fmt.Sprintf("%s:%d", name, period)
		if arr, ok := c.indicatorCache[key]; ok {
			if c.cursor >= 0 && c.cursor < len(arr) {
				return c.vm.ToValue(arr[c.cursor])
			}
			return goja.NaN()
		}
		arr := compute()
		c.indicatorCache[key] = arr
		if c.cursor >= 0 && c.cursor < len(arr) {
			return c.vm.ToValue(arr[c.cursor])
		}
		return goja.NaN()
	}

	obj.Set("sma", func(call goja.FunctionCall) goja.Value {
		period := int(getArg(call, 0, 14))
		src := closeData
		if len(call.Arguments) > 1 && !goja.IsUndefined(call.Arguments[1]) {
			src = extractSourceArray(call.Arguments[1], closeData)
		}
		return cached("sma", period, func() []float64 {
			return indicators.SMA(src, period)
		})
	})

	obj.Set("ema", func(call goja.FunctionCall) goja.Value {
		period := int(getArg(call, 0, 21))
		src := closeData
		if len(call.Arguments) > 1 && !goja.IsUndefined(call.Arguments[1]) {
			src = extractSourceArray(call.Arguments[1], closeData)
		}
		return cached("ema", period, func() []float64 {
			return indicators.EMA(src, period)
		})
	})

	obj.Set("wma", func(call goja.FunctionCall) goja.Value {
		period := int(getArg(call, 0, 14))
		src := closeData
		if len(call.Arguments) > 1 && !goja.IsUndefined(call.Arguments[1]) {
			src = extractSourceArray(call.Arguments[1], closeData)
		}
		return cached("wma", period, func() []float64 {
			return indicators.WMA(src, period)
		})
	})

	obj.Set("rsi", func(call goja.FunctionCall) goja.Value {
		period := int(getArg(call, 0, 14))
		src := closeData
		if len(call.Arguments) > 1 && !goja.IsUndefined(call.Arguments[1]) {
			src = extractSourceArray(call.Arguments[1], closeData)
		}
		return cached("rsi", period, func() []float64 {
			return indicators.RSI(src, period)
		})
	})

	obj.Set("bollingerUpper", func(call goja.FunctionCall) goja.Value {
		period := int(getArg(call, 0, 20))
		mult := getArg(call, 1, 2)
		return cached(fmt.Sprintf("bollinger_u:%d:%.1f", period, mult), period, func() []float64 {
			_, upper, _ := indicators.Bollinger(closeData, period, mult)
			return upper
		})
	})

	obj.Set("bollingerLower", func(call goja.FunctionCall) goja.Value {
		period := int(getArg(call, 0, 20))
		mult := getArg(call, 1, 2)
		return cached(fmt.Sprintf("bollinger_l:%d:%.1f", period, mult), period, func() []float64 {
			_, _, lower := indicators.Bollinger(closeData, period, mult)
			return lower
		})
	})

	obj.Set("atr", func(call goja.FunctionCall) goja.Value {
		period := int(getArg(call, 0, 14))
		return cached("atr", period, func() []float64 {
			return indicators.ATR(high, low, closeData, period)
		})
	})

	obj.Set("vwap", func(call goja.FunctionCall) goja.Value {
		return cached("vwap", 0, func() []float64 {
			return indicators.VWAP(closeData, volume)
		})
	})

	obj.Set("obv", func(call goja.FunctionCall) goja.Value {
		return cached("obv", 0, func() []float64 {
			return indicators.OBV(closeData, volume)
		})
	})

	obj.Set("macd", func(call goja.FunctionCall) goja.Value {
		fast := int(getArg(call, 0, 12))
		slow := int(getArg(call, 1, 26))
		signal := int(getArg(call, 2, 9))
		key := fmt.Sprintf("macd:%d:%d:%d", fast, slow, signal)
		arr, ok := c.indicatorCache[key]
		if !ok {
			macdLine, _, _ := indicators.MACD(closeData, fast, slow, signal)
			arr = macdLine
			c.indicatorCache[key] = arr
		}
		if c.cursor >= 0 && c.cursor < len(arr) {
			return c.vm.ToValue(arr[c.cursor])
		}
		return goja.NaN()
	})

	obj.Set("macdSignal", func(call goja.FunctionCall) goja.Value {
		fast := int(getArg(call, 0, 12))
		slow := int(getArg(call, 1, 26))
		signal := int(getArg(call, 2, 9))
		key := fmt.Sprintf("macd_signal:%d:%d:%d", fast, slow, signal)
		arr, ok := c.indicatorCache[key]
		if !ok {
			_, signalLine, _ := indicators.MACD(closeData, fast, slow, signal)
			arr = signalLine
			c.indicatorCache[key] = arr
		}
		if c.cursor >= 0 && c.cursor < len(arr) {
			return c.vm.ToValue(arr[c.cursor])
		}
		return goja.NaN()
	})

	obj.Set("macdHistogram", func(call goja.FunctionCall) goja.Value {
		fast := int(getArg(call, 0, 12))
		slow := int(getArg(call, 1, 26))
		signal := int(getArg(call, 2, 9))
		key := fmt.Sprintf("macd_hist:%d:%d:%d", fast, slow, signal)
		arr, ok := c.indicatorCache[key]
		if !ok {
			_, _, hist := indicators.MACD(closeData, fast, slow, signal)
			arr = hist
			c.indicatorCache[key] = arr
		}
		if c.cursor >= 0 && c.cursor < len(arr) {
			return c.vm.ToValue(arr[c.cursor])
		}
		return goja.NaN()
	})

	obj.Set("highest", func(call goja.FunctionCall) goja.Value {
		period := int(getArg(call, 0, 14))
		src := high
		if len(call.Arguments) > 1 && !goja.IsUndefined(call.Arguments[1]) {
			src = extractSourceArray(call.Arguments[1], high)
		}
		return cached(fmt.Sprintf("highest:h:%d", period), period, func() []float64 {
			return indicators.Highest(src, period)
		})
	})

	obj.Set("lowest", func(call goja.FunctionCall) goja.Value {
		period := int(getArg(call, 0, 14))
		src := low
		if len(call.Arguments) > 1 && !goja.IsUndefined(call.Arguments[1]) {
			src = extractSourceArray(call.Arguments[1], low)
		}
		return cached(fmt.Sprintf("lowest:l:%d", period), period, func() []float64 {
			return indicators.Lowest(src, period)
		})
	})

	obj.Set("roc", func(call goja.FunctionCall) goja.Value {
		period := int(getArg(call, 0, 10))
		src := closeData
		if len(call.Arguments) > 1 && !goja.IsUndefined(call.Arguments[1]) {
			src = extractSourceArray(call.Arguments[1], closeData)
		}
		return cached(fmt.Sprintf("roc:%d", period), period, func() []float64 {
			return indicators.ROC(src, period)
		})
	})

	obj.Set("stochasticK", func(call goja.FunctionCall) goja.Value {
		kPeriod := int(getArg(call, 0, 14))
		kSlow := int(getArg(call, 1, 3))
		dPeriod := int(getArg(call, 2, 3))
		key := fmt.Sprintf("stoch_k:%d:%d:%d", kPeriod, kSlow, dPeriod)
		arr, ok := c.indicatorCache[key]
		if !ok {
			k, _ := indicators.Stochastic(high, low, closeData, kPeriod, kSlow, dPeriod)
			arr = k
			c.indicatorCache[key] = arr
		}
		if c.cursor >= 0 && c.cursor < len(arr) {
			return c.vm.ToValue(arr[c.cursor])
		}
		return goja.NaN()
	})

	obj.Set("stochasticD", func(call goja.FunctionCall) goja.Value {
		kPeriod := int(getArg(call, 0, 14))
		kSlow := int(getArg(call, 1, 3))
		dPeriod := int(getArg(call, 2, 3))
		key := fmt.Sprintf("stoch_d:%d:%d:%d", kPeriod, kSlow, dPeriod)
		arr, ok := c.indicatorCache[key]
		if !ok {
			_, d := indicators.Stochastic(high, low, closeData, kPeriod, kSlow, dPeriod)
			arr = d
			c.indicatorCache[key] = arr
		}
		if c.cursor >= 0 && c.cursor < len(arr) {
			return c.vm.ToValue(arr[c.cursor])
		}
		return goja.NaN()
	})
}

// extractSourceArray extracts a numeric array from a goja value for indicator input.
func extractSourceArray(v goja.Value, defaultArr []float64) []float64 {
	// If v is a goja array, extract it
	if obj, ok := v.(*goja.Object); ok {
		if exported, ok := obj.Export().([]interface{}); ok {
			result := make([]float64, len(exported))
			for i, e := range exported {
				if f, ok := e.(float64); ok {
					result[i] = f
				}
			}
			return result
		}
	}
	return defaultArr
}

// These types are referenced from backtest.go but defined here to avoid import cycles.

type Position struct {
	Qty     float64
	CostUsd float64
	AvgCost float64
	Lots    []BracketLot
}

type BracketLot struct {
	Qty     float64
	CostUsd float64
	AvgCost float64
	Tp      float64
	Sl      float64
}

type Trade struct {
	Time     int64
	Side     string
	Qty      float64
	Price    float64
	Usd      float64
	FeeUsd   float64
	Slippage float64
	Type     string
}

type PendingSignal struct {
	Side string
	Usd  float64
	Qty  float64
	Pct  float64
	Tp   float64
	Sl   float64
}
