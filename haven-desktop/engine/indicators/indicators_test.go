package indicators

import (
	"math"
	"testing"
)

func TestSMA(t *testing.T) {
	data := []float64{1, 2, 3, 4, 5, 6}
	result := SMA(data, 3)

	if len(result) != 6 {
		t.Fatalf("expected 6 values, got %d", len(result))
	}
	if !math.IsNaN(result[0]) || !math.IsNaN(result[1]) {
		t.Error("first two values should be NaN")
	}
	// bar 2: (1+2+3)/3 = 2.0
	if result[2] != 2.0 {
		t.Errorf("bar 2: expected 2.0, got %.2f", result[2])
	}
	// bar 3: (2+3+4)/3 = 3.0
	if result[3] != 3.0 {
		t.Errorf("bar 3: expected 3.0, got %.2f", result[3])
	}
}

func TestEMA(t *testing.T) {
	data := []float64{10, 10, 10, 20, 20, 20}
	result := EMA(data, 3)

	if len(result) != 6 {
		t.Fatalf("expected 6 values, got %d", len(result))
	}
	if !math.IsNaN(result[0]) || !math.IsNaN(result[1]) {
		t.Error("first two values should be NaN")
	}
	// seed at bar 2: (10+10+10)/3 = 10.0
	if math.Abs(result[2]-10.0) > 0.01 {
		t.Errorf("bar 2: expected 10.0, got %.4f", result[2])
	}
	// After a spike to 20, EMA should rise above 10
	if result[5] <= 10.0 {
		t.Errorf("bar 5: EMA should be above 10 after spike, got %.4f", result[5])
	}
}

func TestRSI(t *testing.T) {
	// Generate up-then-down data for RSI
	data := []float64{100, 101, 102, 103, 104, 105, 104, 103, 102, 101, 100, 99, 98, 97, 96, 95}
	result := RSI(data, 14)

	if len(result) != 16 {
		t.Fatalf("expected 16 values, got %d", len(result))
	}
	// All first period values should be NaN
	for i := 0; i < 14; i++ {
		if !math.IsNaN(result[i]) {
			t.Errorf("bar %d: expected NaN, got %.2f", i, result[i])
		}
	}
	// RSI should be in [0, 100]
	for i := 14; i < len(result); i++ {
		if result[i] < 0 || result[i] > 100 {
			t.Errorf("bar %d: RSI out of range: %.2f", i, result[i])
		}
	}
}

func TestBollinger(t *testing.T) {
	data := []float64{10, 12, 11, 13, 12, 14, 13, 15, 14, 16, 15, 17, 16, 18, 17, 19, 18, 20, 19, 21}
	middle, upper, lower := Bollinger(data, 5, 2)

	if len(middle) != 20 {
		t.Fatalf("expected 20 values, got %d", len(middle))
	}
	for i := 0; i < len(middle); i++ {
		if !math.IsNaN(middle[i]) && !math.IsNaN(upper[i]) && !math.IsNaN(lower[i]) {
			if upper[i] < middle[i] {
				t.Errorf("bar %d: upper (%.2f) < middle (%.2f)", i, upper[i], middle[i])
			}
			if lower[i] > middle[i] {
				t.Errorf("bar %d: lower (%.2f) > middle (%.2f)", i, lower[i], middle[i])
			}
		}
	}
}

func TestATR(t *testing.T) {
	high := []float64{105, 106, 107, 108, 107}
	low := []float64{98, 99, 100, 101, 100}
	close := []float64{100, 101, 102, 103, 102}
	result := ATR(high, low, close, 3)

	if len(result) != 5 {
		t.Fatalf("expected 5 values, got %d", len(result))
	}
	// First period-1 values should be NaN
	if !math.IsNaN(result[0]) || !math.IsNaN(result[1]) {
		t.Error("first two values should be NaN")
	}
	// ATR should be positive
	if result[2] <= 0 {
		t.Errorf("ATR should be positive, got %.2f", result[2])
	}
}

func TestMACD(t *testing.T) {
	data := make([]float64, 100)
	for i := range data {
		data[i] = 100 + float64(i)*0.1
	}
	macdLine, signal, hist := MACD(data, 12, 26, 9)

	if len(macdLine) != 100 {
		t.Fatalf("expected 100 values, got %d", len(macdLine))
	}
	// In a steady uptrend, MACD should be positive
	for i := 30; i < len(macdLine); i++ {
		if !math.IsNaN(macdLine[i]) {
			if macdLine[i] <= 0 {
				t.Errorf("bar %d: MACD should be positive in uptrend, got %.4f", i, macdLine[i])
				break // only report first failure
			}
		}
	}
	_ = signal
	_ = hist
}

func TestCrossover(t *testing.T) {
	fast := []float64{1, 2, 3, 2, 5}
	slow := []float64{1, 1.5, 2, 3, 3}

	// bar 1: fast crosses above slow (1→2 vs 1→1.5, and prev 1<=1)
	if !Crossover(fast, slow, 1) {
		t.Error("bar 1: should cross (fast 2 > slow 1.5, prev fast 1 <= slow 1)")
	}
	// bar 2: fast stays above (3 > 2, but prev fast 2 > slow 1.5, so no new cross)
	if Crossover(fast, slow, 2) {
		t.Error("bar 2: should not cross (prev fast 2 > slow 1.5)")
	}
	// bar 3: fast drops below slow (2 < 3) — not a crossover, it's a crossunder
	if Crossover(fast, slow, 3) {
		t.Error("bar 3: should not cross (fast 2 < slow 3)")
	}
}
