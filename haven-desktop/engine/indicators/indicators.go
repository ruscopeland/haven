// Package indicators provides technical analysis indicator functions.
// All functions operate on float64 slices and return null (NaN) for
// warm-up periods where there isn't enough data.
//
// These are the Go-native implementations used by the backtest engine.
// The same functions are exposed to user JavaScript strategies via goja bindings.
package indicators

import "math"

// SMA returns the Simple Moving Average over the last `period` values.
// Returns NaN for indices < period-1.
func SMA(data []float64, period int) []float64 {
	if period <= 0 || len(data) == 0 {
		return nil
	}
	out := make([]float64, len(data))
	sum := 0.0
	for i, v := range data {
		sum += v
		if i >= period {
			sum -= data[i-period]
		}
		if i >= period-1 {
			out[i] = sum / float64(period)
		} else {
			out[i] = math.NaN()
		}
	}
	return out
}

// EMA returns the Exponential Moving Average.
// Uses SMA for the initial seed value, then 2/(period+1) smoothing.
func EMA(data []float64, period int) []float64 {
	if period <= 0 || len(data) == 0 {
		return nil
	}
	out := make([]float64, len(data))
	k := 2.0 / float64(period+1)

	// Seed with SMA
	seedSum := 0.0
	for i := 0; i < period && i < len(data); i++ {
		seedSum += data[i]
		out[i] = math.NaN()
	}
	if len(data) < period {
		return out
	}

	prev := seedSum / float64(period)
	out[period-1] = prev
	for i := period; i < len(data); i++ {
		prev = (data[i]-prev)*k + prev
		out[i] = prev
	}
	return out
}

// WMA returns the Weighted Moving Average.
func WMA(data []float64, period int) []float64 {
	if period <= 0 || len(data) == 0 {
		return nil
	}
	out := make([]float64, len(data))
	weightSum := float64(period*(period+1)) / 2.0

	for i := 0; i < len(data); i++ {
		if i < period-1 {
			out[i] = math.NaN()
			continue
		}
		sum := 0.0
		for j := 0; j < period; j++ {
			sum += data[i-j] * float64(period-j)
		}
		out[i] = sum / weightSum
	}
	return out
}

// RSI returns the Relative Strength Index (Wilder's smoothing).
func RSI(data []float64, period int) []float64 {
	if period <= 0 || len(data) < period+1 {
		return makeNaNFilled(len(data))
	}
	out := make([]float64, len(data))
	for i := 0; i < period; i++ {
		out[i] = math.NaN()
	}

	// Initial average gain/loss using SMA
	avgGain := 0.0
	avgLoss := 0.0
	for i := 1; i <= period; i++ {
		delta := data[i] - data[i-1]
		if delta > 0 {
			avgGain += delta
		} else {
			avgLoss += -delta
		}
	}
	avgGain /= float64(period)
	avgLoss /= float64(period)

	if avgLoss == 0 {
		out[period] = 100.0
	} else {
		rs := avgGain / avgLoss
		out[period] = 100.0 - (100.0 / (1.0 + rs))
	}

	// Wilder's smoothing for remaining values
	for i := period + 1; i < len(data); i++ {
		delta := data[i] - data[i-1]
		gain := 0.0
		loss := 0.0
		if delta > 0 {
			gain = delta
		} else {
			loss = -delta
		}
		avgGain = (avgGain*float64(period-1) + gain) / float64(period)
		avgLoss = (avgLoss*float64(period-1) + loss) / float64(period)

		if avgLoss == 0 {
			out[i] = 100.0
		} else {
			rs := avgGain / avgLoss
			out[i] = 100.0 - (100.0 / (1.0 + rs))
		}
	}
	return out
}

// StdDev returns the population standard deviation over `period` values.
func StdDev(data []float64, period int) []float64 {
	if period <= 1 || len(data) == 0 {
		return nil
	}
	out := make([]float64, len(data))
	for i := 0; i < len(data); i++ {
		if i < period-1 {
			out[i] = math.NaN()
			continue
		}
		// Calculate mean of window
		sum := 0.0
		for j := i - period + 1; j <= i; j++ {
			sum += data[j]
		}
		mean := sum / float64(period)

		// Calculate variance
		varianceSum := 0.0
		for j := i - period + 1; j <= i; j++ {
			diff := data[j] - mean
			varianceSum += diff * diff
		}
		out[i] = math.Sqrt(varianceSum / float64(period))
	}
	return out
}

// Bollinger returns Bollinger Bands (middle, upper, lower).
// Uses SMA for the middle band and `multiplier` standard deviations for the bands.
func Bollinger(data []float64, period int, multiplier float64) (middle, upper, lower []float64) {
	if period <= 1 || len(data) == 0 {
		return nil, nil, nil
	}
	middle = SMA(data, period)
	stddev := StdDev(data, period)
	upper = make([]float64, len(data))
	lower = make([]float64, len(data))

	for i := 0; i < len(data); i++ {
		if math.IsNaN(middle[i]) || math.IsNaN(stddev[i]) {
			upper[i] = math.NaN()
			lower[i] = math.NaN()
			continue
		}
		band := multiplier * stddev[i]
		upper[i] = middle[i] + band
		lower[i] = middle[i] - band
	}
	return
}

// ATR returns the Average True Range using Wilder's smoothing.
func ATR(high, low, close []float64, period int) []float64 {
	if period <= 0 || len(high) == 0 {
		return nil
	}
	n := len(high)
	out := make([]float64, n)

	// True range
	tr := make([]float64, n)
	tr[0] = high[0] - low[0]
	for i := 1; i < n; i++ {
		h := high[i]
		l := low[i]
		prevC := close[i-1]
		tr[i] = math.Max(h-l, math.Max(math.Abs(h-prevC), math.Abs(l-prevC)))
	}

	// Seed with SMA of first `period` TR values
	if n < period {
		return makeNaNFilled(n)
	}
	for i := 0; i < period-1; i++ {
		out[i] = math.NaN()
	}

	sum := 0.0
	for i := 0; i < period; i++ {
		sum += tr[i]
	}
	out[period-1] = sum / float64(period)

	// Wilder's smoothing
	for i := period; i < n; i++ {
		out[i] = (out[i-1]*float64(period-1) + tr[i]) / float64(period)
	}
	return out
}

// Stochastic returns the Stochastic Oscillator %K and %D lines.
func Stochastic(high, low, close []float64, kPeriod, kSlow, dPeriod int) (k, d []float64) {
	n := len(high)
	if kPeriod <= 0 || n < kPeriod {
		nf := makeNaNFilled(max(n, 0))
		return nf, nf
	}
	k = make([]float64, n)
	d = make([]float64, n)

	// Fast %K
	fastK := make([]float64, n)
	for i := 0; i < n; i++ {
		if i < kPeriod-1 {
			fastK[i] = math.NaN()
			continue
		}
		highestH := high[i]
		lowestL := low[i]
		for j := i - kPeriod + 1; j <= i; j++ {
			if high[j] > highestH {
				highestH = high[j]
			}
			if low[j] < lowestL {
				lowestL = low[j]
			}
		}
		denom := highestH - lowestL
		if denom == 0 {
			fastK[i] = 100.0
		} else {
			fastK[i] = ((close[i] - lowestL) / denom) * 100.0
		}
	}

	// Slow %K = SMA of fast %K
	k = SMA(fastK, kSlow)

	// %D = SMA of %K
	d = SMA(k, dPeriod)
	return
}

// VWAP returns the Volume-Weighted Average Price (cumulative from bar 0).
func VWAP(close, volume []float64) []float64 {
	n := len(close)
	out := make([]float64, n)
	cumPV := 0.0
	cumV := 0.0
	for i := 0; i < n; i++ {
		if volume[i] <= 0 {
			out[i] = math.NaN()
			continue
		}
		cumPV += close[i] * volume[i]
		cumV += volume[i]
		if cumV == 0 {
			out[i] = math.NaN()
		} else {
			out[i] = cumPV / cumV
		}
	}
	return out
}

// OBV returns On-Balance Volume.
func OBV(close, volume []float64) []float64 {
	n := len(close)
	if n == 0 {
		return nil
	}
	out := make([]float64, n)
	out[0] = float64(volume[0])
	for i := 1; i < n; i++ {
		if close[i] > close[i-1] {
			out[i] = out[i-1] + volume[i]
		} else if close[i] < close[i-1] {
			out[i] = out[i-1] - volume[i]
		} else {
			out[i] = out[i-1]
		}
	}
	return out
}

// MACD returns the MACD line, signal line, and histogram.
func MACD(data []float64, fast, slow, signal int) (macdLine, signalLine, histogram []float64) {
	n := len(data)
	if n < slow {
		nf := makeNaNFilled(max(n, 0))
		return nf, nf, nf
	}
	fastEMA := EMA(data, fast)
	slowEMA := EMA(data, slow)

	macdLine = make([]float64, n)
	for i := 0; i < n; i++ {
		if math.IsNaN(fastEMA[i]) || math.IsNaN(slowEMA[i]) {
			macdLine[i] = math.NaN()
		} else {
			macdLine[i] = fastEMA[i] - slowEMA[i]
		}
	}

	signalLine = EMA(macdLine, signal)
	histogram = make([]float64, n)
	for i := 0; i < n; i++ {
		if math.IsNaN(macdLine[i]) || math.IsNaN(signalLine[i]) {
			histogram[i] = math.NaN()
		} else {
			histogram[i] = macdLine[i] - signalLine[i]
		}
	}
	return
}

// Highest returns the highest value over the last `period` bars.
func Highest(data []float64, period int) []float64 {
	if period <= 0 || len(data) == 0 {
		return nil
	}
	out := make([]float64, len(data))
	for i := 0; i < len(data); i++ {
		if i < period-1 {
			out[i] = math.NaN()
			continue
		}
		maxV := data[i]
		for j := i - period + 1; j <= i; j++ {
			if data[j] > maxV {
				maxV = data[j]
			}
		}
		out[i] = maxV
	}
	return out
}

// Lowest returns the lowest value over the last `period` bars.
func Lowest(data []float64, period int) []float64 {
	if period <= 0 || len(data) == 0 {
		return nil
	}
	out := make([]float64, len(data))
	for i := 0; i < len(data); i++ {
		if i < period-1 {
			out[i] = math.NaN()
			continue
		}
		minV := data[i]
		for j := i - period + 1; j <= i; j++ {
			if data[j] < minV {
				minV = data[j]
			}
		}
		out[i] = minV
	}
	return out
}

// ROC returns the Rate of Change (percentage) over `period` bars.
func ROC(data []float64, period int) []float64 {
	if period <= 0 || len(data) == 0 {
		return nil
	}
	out := make([]float64, len(data))
	for i := 0; i < len(data); i++ {
		if i < period {
			out[i] = math.NaN()
			continue
		}
		prev := data[i-period]
		if prev == 0 {
			out[i] = math.NaN()
		} else {
			out[i] = ((data[i] - prev) / prev) * 100.0
		}
	}
	return out
}

// Crossover returns true when `fast` crosses above `slow` at the current bar.
// Both inputs are indicator arrays (may contain NaN for warm-up).
func Crossover(fast, slow []float64, i int) bool {
	if i < 1 || i >= len(fast) || i >= len(slow) {
		return false
	}
	return fast[i] > slow[i] &&
		!math.IsNaN(fast[i-1]) && !math.IsNaN(slow[i-1]) &&
		fast[i-1] <= slow[i-1]
}

// Crossunder returns true when `fast` crosses below `slow` at the current bar.
func Crossunder(fast, slow []float64, i int) bool {
	if i < 1 || i >= len(fast) || i >= len(slow) {
		return false
	}
	return fast[i] < slow[i] &&
		!math.IsNaN(fast[i-1]) && !math.IsNaN(slow[i-1]) &&
		fast[i-1] >= slow[i-1]
}

func makeNaNFilled(n int) []float64 {
	out := make([]float64, n)
	for i := range out {
		out[i] = math.NaN()
	}
	return out
}
