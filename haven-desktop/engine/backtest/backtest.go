// Package backtest implements a single-symbol strategy backtester.
//
// Fill semantics (matching strategy-sdk):
//   - Signal emitted during onBar(bar, ctx) at index i fills at bar i+1's open.
//   - SL/TP brackets are simulated intrabar: SL checked first (pessimistic rule).
//   - Signals on the final bar are reported as pending, never filled.
//   - Fees and slippage apply to every fill.
package backtest

import (
	"fmt"
	"math"

	"github.com/ruscopeland/haven-desktop/engine/runtime"
)

// Bar is a single OHLCV candle.
type Bar struct {
	Time   int64   `json:"time"`
	Open   float64 `json:"open"`
	High   float64 `json:"high"`
	Low    float64 `json:"low"`
	Close  float64 `json:"close"`
	Volume float64 `json:"volume"`
}

// Result holds the backtest output.
type Result struct {
	Trades     []runtime.Trade       `json:"trades"`
	Equity     []float64             `json:"equity"`
	EquityTime []int64               `json:"equity_time"`
	Stats      Stats                 `json:"stats"`
	Error      string                `json:"error,omitempty"`
	Pending    []runtime.PendingSignal `json:"pending,omitempty"`
	Logs       []string              `json:"logs,omitempty"`
}

// Stats holds summary statistics.
type Stats struct {
	TotalTrades    int     `json:"total_trades"`
	WinTrades      int     `json:"win_trades"`
	LossTrades     int     `json:"loss_trades"`
	WinRate        float64 `json:"win_rate"`
	TotalReturn    float64 `json:"total_return"`
	TotalReturnPct float64 `json:"total_return_pct"`
	MaxDD          float64 `json:"max_dd"`
	MaxDDPct       float64 `json:"max_dd_pct"`
	Sharpe         float64 `json:"sharpe"`
	StartUsd       float64 `json:"start_usd"`
	EndUsd         float64 `json:"end_usd"`
}

// Params configures the backtest.
type Params struct {
	Symbol       string             `json:"symbol"`
	Interval     string             `json:"interval"`
	Bars         []Bar              `json:"bars"`
	Code         string             `json:"code"`
	Params       map[string]float64 `json:"params"`
	StartUsd     float64            `json:"start_usd"`
	FeePct       float64            `json:"fee_pct"`
	SlippagePct  float64            `json:"slippage_pct"`
}

// Run executes a single-symbol backtest.
func Run(p Params) Result {
	if len(p.Bars) == 0 {
		return Result{Error: "no bars", Stats: emptyStats(p.StartUsd)}
	}
	if p.StartUsd <= 0 {
		p.StartUsd = 10000
	}
	if p.FeePct <= 0 {
		p.FeePct = 0.001
	}
	if p.SlippagePct <= 0 {
		p.SlippagePct = 0.0005
	}

	// Convert bars to runtime format
	rtBars := make([]runtime.BarData, len(p.Bars))
	for i, b := range p.Bars {
		rtBars[i] = runtime.BarData{
			Time: b.Time, Open: b.Open, High: b.High,
			Low: b.Low, Close: b.Close, Volume: b.Volume,
		}
	}

	// Load the user's strategy via goja
	strat, errStr := runtime.LoadStrategy(p.Code, p.Params)
	if errStr != "" {
		return Result{Error: errStr, Stats: emptyStats(p.StartUsd)}
	}

	// Set up context
	ctx := runtime.NewBacktestCtx(rtBars, p.StartUsd, p.FeePct, p.SlippagePct, p.Params)

	var (
		trades     []runtime.Trade
		equity     []float64
		equityTime []int64
		pending    []runtime.PendingSignal
		logs       []string
		position   runtime.Position
	)

	// Initial equity point
	equity = append(equity, p.StartUsd)
	equityTime = append(equityTime, p.Bars[0].Time)

	for i := 0; i < len(p.Bars); i++ {
		bar := rtBars[i]

		// 1. Fill signals queued from the PREVIOUS bar at this bar's OPEN
		if i > 0 {
			ctx.FillQueuedBuys(bar, &position, &trades)
			ctx.FillQueuedSells(bar, &position, &trades)
		}

		// 2. Simulate bracket lots intrabar
		simulateBrackets(bar, &position, &trades)

		// 3. Run strategy.onBar for this closed bar
		stratErr := ctx.RunOnBar(i, strat)
		if stratErr != "" {
			logs = append(logs, fmt.Sprintf("bar %d: %s", i, stratErr))
		}

		// Record equity
		eq := ctx.Equity(bar.Close, position)
		equity = append(equity, eq)
		equityTime = append(equityTime, bar.Time)

		// 4. Collect pending signals from the final bar
		if i == len(p.Bars)-1 {
			pending = ctx.PendingSignals()
		}
	}

	return Result{
		Trades:     trades,
		Equity:     equity,
		EquityTime: equityTime,
		Stats:      computeStats(p.StartUsd, trades, equity),
		Pending:    pending,
		Logs:       logs,
	}
}

func simulateBrackets(bar runtime.BarData, pos *runtime.Position, trades *[]runtime.Trade) {
	if len(pos.Lots) == 0 {
		return
	}

	var surviving []runtime.BracketLot
	for _, lot := range pos.Lots {
		triggered := false

		// SL checked first (pessimistic rule)
		if lot.Sl > 0 && bar.Low <= lot.Sl {
			fillPrice := math.Min(bar.Open, lot.Sl)
			*trades = append(*trades, runtime.Trade{
				Time: bar.Time, Side: "sell", Qty: lot.Qty,
				Price: fillPrice, Usd: lot.Qty * fillPrice,
				Type: "sl",
			})
			pos.Qty -= lot.Qty
			pos.CostUsd -= lot.CostUsd
			if pos.Qty <= 0 {
				pos.Qty = 0
				pos.CostUsd = 0
				pos.AvgCost = 0
			} else {
				pos.AvgCost = pos.CostUsd / pos.Qty
			}
			triggered = true
		} else if lot.Tp > 0 && bar.High >= lot.Tp {
			fillPrice := math.Max(bar.Open, lot.Tp)
			*trades = append(*trades, runtime.Trade{
				Time: bar.Time, Side: "sell", Qty: lot.Qty,
				Price: fillPrice, Usd: lot.Qty * fillPrice,
				Type: "tp",
			})
			pos.Qty -= lot.Qty
			pos.CostUsd -= lot.CostUsd
			if pos.Qty <= 0 {
				pos.Qty = 0
				pos.CostUsd = 0
				pos.AvgCost = 0
			} else {
				pos.AvgCost = pos.CostUsd / pos.Qty
			}
			triggered = true
		}

		if !triggered {
			surviving = append(surviving, lot)
		}
	}
	pos.Lots = surviving
	if pos.Qty <= 0 {
		pos.Qty = 0
		pos.CostUsd = 0
		pos.AvgCost = 0
		pos.Lots = nil
	}
}

func computeStats(startUsd float64, trades []runtime.Trade, equity []float64) Stats {
	s := Stats{
		StartUsd: startUsd,
		EndUsd:   startUsd,
	}
	if len(equity) > 0 {
		s.EndUsd = equity[len(equity)-1]
	}

	s.TotalTrades = len(trades)

	type open struct {
		qty  float64
		cost float64
	}
	var openBuys []open

	for _, t := range trades {
		if t.Side == "buy" {
			openBuys = append(openBuys, open{qty: t.Qty, cost: t.Usd})
		} else {
			sellQty := t.Qty
			sellUsd := t.Usd
			for sellQty > 0 && len(openBuys) > 0 {
				b := &openBuys[0]
				matched := math.Min(sellQty, b.qty)
				avgBuyPrice := b.cost / b.qty
				pnl := matched*(sellUsd/sellQty) - matched*avgBuyPrice

				if pnl > 0 {
					s.WinTrades++
				} else {
					s.LossTrades++
				}

				b.qty -= matched
				b.cost -= matched * avgBuyPrice
				sellQty -= matched
				sellUsd -= matched * (sellUsd / t.Qty)

				if b.qty <= 0 {
					openBuys = openBuys[1:]
				}
			}
		}
	}

	if s.WinTrades+s.LossTrades > 0 {
		s.WinRate = float64(s.WinTrades) / float64(s.WinTrades+s.LossTrades) * 100
	}

	if startUsd > 0 {
		s.TotalReturn = s.EndUsd - startUsd
		s.TotalReturnPct = (s.EndUsd/startUsd - 1) * 100
	}

	peak := startUsd
	maxDD := 0.0
	for _, eq := range equity {
		if eq > peak {
			peak = eq
		}
		dd := peak - eq
		if dd > maxDD {
			maxDD = dd
		}
	}
	s.MaxDD = maxDD
	if peak > 0 {
		s.MaxDDPct = (maxDD / peak) * 100
	}

	if len(equity) > 1 {
		returns := make([]float64, len(equity)-1)
		sum := 0.0
		for i := 1; i < len(equity); i++ {
			if equity[i-1] > 0 {
				r := equity[i]/equity[i-1] - 1
				returns[i-1] = r
				sum += r
			}
		}
		if len(returns) > 0 {
			mean := sum / float64(len(returns))
			varSum := 0.0
			for _, r := range returns {
				varSum += (r - mean) * (r - mean)
			}
			stddev := math.Sqrt(varSum / float64(len(returns)))
			if stddev > 0 {
				s.Sharpe = (mean / stddev) * math.Sqrt(365)
			}
		}
	}

	return s
}

func emptyStats(startUsd float64) Stats {
	return Stats{
		StartUsd: startUsd,
		EndUsd:   startUsd,
	}
}
