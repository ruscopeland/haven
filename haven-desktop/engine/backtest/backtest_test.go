package backtest

import (
	"math"
	"testing"
)

// generateBars creates a simple OHLCV series for testing.
func generateBars(n int, trend float64) []Bar {
	bars := make([]Bar, n)
	price := 100.0
	for i := 0; i < n; i++ {
		open := price
		close := price + trend
		high := math.Max(open, close) + 0.5
		low := math.Min(open, close) - 0.5
		bars[i] = Bar{
			Time:   int64(i * 60000),
			Open:   math.Round(open*100) / 100,
			High:   math.Round(high*100) / 100,
			Low:    math.Round(low*100) / 100,
			Close:  math.Round(close*100) / 100,
			Volume: 1000,
		}
		price = close
	}
	return bars
}

func TestRun_EmptyBars(t *testing.T) {
	result := Run(Params{Bars: nil, StartUsd: 10000})
	if result.Error != "no bars" {
		t.Errorf("expected 'no bars' error, got: %q", result.Error)
	}
}

func TestRun_SyntaxError(t *testing.T) {
	bars := generateBars(10, 0.1)
	result := Run(Params{
		Bars:     bars,
		StartUsd: 10000,
		Code:     "this is not valid javascript {{{",
	})
	if result.Error == "" {
		t.Error("expected syntax error")
	}
}

func TestRun_MissingStrategy(t *testing.T) {
	bars := generateBars(10, 0.1)
	result := Run(Params{
		Bars:     bars,
		StartUsd: 10000,
		Code:     "const x = 1;",
	})
	if result.Error == "" {
		t.Error("expected error for missing strategy object")
	}
}

func TestRun_BasicBuy(t *testing.T) {
	// Strategy: buy $1000 on bar 0
	code := `
	const strategy = {
		onBar(bar, ctx) {
			if (ctx.i === 0) {
				ctx.buy(1000);
			}
		}
	};
	`
	bars := generateBars(10, 0.1)
	result := Run(Params{
		Bars:     bars,
		StartUsd: 10000,
		Code:     code,
	})
	if result.Error != "" {
		t.Fatalf("unexpected error: %s", result.Error)
	}

	// Should have 1 trade (buy filled at bar 1's open)
	if len(result.Trades) != 1 {
		t.Fatalf("expected 1 trade, got %d", len(result.Trades))
	}
	if result.Trades[0].Side != "buy" {
		t.Errorf("expected buy, got %s", result.Trades[0].Side)
	}
	if result.Trades[0].Time != bars[1].Time {
		t.Errorf("fill should be at bar 1, got bar time %d", result.Trades[0].Time)
	}
	// Equity should have 11 points (initial + 10 bars)
	if len(result.Equity) != 11 {
		t.Errorf("expected 11 equity points, got %d", len(result.Equity))
	}
}

func TestRun_BuyOnFinalBar_Pending(t *testing.T) {
	// Strategy: buy only on the very last bar (index 4 of 5 bars)
	code := `
	const strategy = {
		onBar(bar, ctx) {
			if (ctx.i === 4) {
				ctx.buy(1000);
			}
		}
	};
	`
	bars := generateBars(5, 0.1)
	result := Run(Params{
		Bars:     bars,
		StartUsd: 10000,
		Code:     code,
	})
	if result.Error != "" {
		t.Fatalf("unexpected error: %s", result.Error)
	}

	// No trades should be filled (signal on last bar has no bar+1)
	if len(result.Trades) != 0 {
		t.Errorf("expected 0 trades, got %d", len(result.Trades))
	}
	// Should have 1 pending signal
	if len(result.Pending) != 1 {
		t.Fatalf("expected 1 pending signal, got %d", len(result.Pending))
	}
	if result.Pending[0].Side != "buy" {
		t.Errorf("expected pending buy, got %s", result.Pending[0].Side)
	}
}

func TestRun_SellSignals(t *testing.T) {
	// Strategy: buy, then sell 50% two bars later
	code := `
	const strategy = {
		onBar(bar, ctx) {
			if (ctx.i === 1) ctx.buy(2000);
			if (ctx.i === 4) ctx.sell(50);
		}
	};
	`
	bars := generateBars(20, 0.5) // uptrend so sell is profitable
	result := Run(Params{
		Bars:     bars,
		StartUsd: 10000,
		Code:     code,
	})
	if result.Error != "" {
		t.Fatalf("unexpected error: %s", result.Error)
	}

	// Should have buy at bar 2 fill, sell at bar 5 fill
	if len(result.Trades) != 2 {
		t.Fatalf("expected 2 trades, got %d", len(result.Trades))
	}
	if result.Trades[0].Side != "buy" {
		t.Errorf("first trade should be buy, got %s", result.Trades[0].Side)
	}
	if result.Trades[1].Side != "sell" {
		t.Errorf("second trade should be sell, got %s", result.Trades[1].Side)
	}
}

func TestRun_Close(t *testing.T) {
	code := `
	const strategy = {
		onBar(bar, ctx) {
			if (ctx.i === 1) ctx.buy(2000);
			if (ctx.i === 4) ctx.close();
		}
	};
	`
	bars := generateBars(20, 0.5)
	result := Run(Params{
		Bars:     bars,
		StartUsd: 10000,
		Code:     code,
	})
	if result.Error != "" {
		t.Fatalf("unexpected error: %s", result.Error)
	}
	if len(result.Trades) != 2 {
		t.Fatalf("expected 2 trades, got %d", len(result.Trades))
	}
}

func TestRun_MultipleBuyPyramiding(t *testing.T) {
	code := `
	const strategy = {
		onBar(bar, ctx) {
			if (ctx.i === 0) ctx.buy(1000);
			if (ctx.i === 2) ctx.buy(1000);
			if (ctx.i === 4) ctx.buy(1000);
		}
	};
	`
	bars := generateBars(20, 0.1)
	result := Run(Params{
		Bars:     bars,
		StartUsd: 10000,
		Code:     code,
	})
	if result.Error != "" {
		t.Fatalf("unexpected error: %s", result.Error)
	}
	if len(result.Trades) != 3 {
		t.Fatalf("expected 3 trades, got %d", len(result.Trades))
	}
}

func TestRun_StrategyError(t *testing.T) {
	code := `
	const strategy = {
		onBar(bar, ctx) {
			if (ctx.i === 3) throw new Error("test error");
		}
	};
	`
	bars := generateBars(10, 0.1)
	result := Run(Params{
		Bars:     bars,
		StartUsd: 10000,
		Code:     code,
	})
	// Should not fail entirely — error captured in logs
	if len(result.Logs) == 0 {
		t.Error("expected error logs")
	}
}

func TestRun_Params(t *testing.T) {
	code := `
	const strategy = {
		params: { period: 14 },
		onBar(bar, ctx) {
			if (ctx.params.period === 14 && ctx.i === 0) {
				ctx.buy(1000);
			}
		}
	};
	`
	bars := generateBars(10, 0.1)
	result := Run(Params{
		Bars:     bars,
		StartUsd: 10000,
		Code:     code,
		Params:   map[string]float64{"period": 14},
	})
	if result.Error != "" {
		t.Fatalf("unexpected error: %s", result.Error)
	}
	if len(result.Trades) != 1 {
		t.Errorf("expected 1 trade, got %d", len(result.Trades))
	}
}

func TestRun_Stats(t *testing.T) {
	// Strategy that buys and sells for a known profit
	code := `
	const strategy = {
		onBar(bar, ctx) {
			if (ctx.i === 0) ctx.buy(5000);
			if (ctx.i === 5) ctx.sell(100);
		}
	};
	`
	bars := generateBars(20, 1.0) // steady uptrend
	result := Run(Params{
		Bars:     bars,
		StartUsd: 10000,
		Code:     code,
	})
	if result.Error != "" {
		t.Fatalf("unexpected error: %s", result.Error)
	}

	stats := result.Stats
	if stats.TotalTrades != 2 {
		t.Errorf("expected 2 trades in stats, got %d", stats.TotalTrades)
	}
	if stats.StartUsd != 10000 {
		t.Errorf("start_usd should be 10000, got %.2f", stats.StartUsd)
	}
	// With uptrend, end equity should be > start
	if stats.EndUsd <= stats.StartUsd {
		t.Errorf("expected end_usd > start_usd in uptrend, got %.2f vs %.2f", stats.EndUsd, stats.StartUsd)
	}
}
