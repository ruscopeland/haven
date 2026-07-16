// Package finder implements token finder ranking, forward-return analysis,
// and the chooseBinding hysteresis rule shared by portfolio backtester and live runner.
package finder

import (
	"fmt"
	"math"
	"sort"

	"github.com/ruscopeland/haven-desktop/engine/runtime"
)

// UniverseBar is a timestamp-aligned bar across multiple tokens.
type UniverseBar struct {
	Time   int64
	Tokens map[string]TokenBar
}

// TokenBar is a single OHLCV bar for one token with its timestamp.
type TokenBar struct {
	Time   int64
	Open   float64
	High   float64
	Low    float64
	Close  float64
	Volume float64
}

type scorePair struct {
	score  float64
	fwdRet float64
}

// RankEntry is a single token's ranking result at one point in time.
type RankEntry struct {
	Symbol string  `json:"symbol"`
	Score  float64 `json:"score"`
}

// RankingResult holds the output of one ranking run.
type RankingResult struct {
	Rankings [][]RankEntry `json:"rankings"`
	Logs     []string      `json:"logs"`
	Error    string        `json:"error,omitempty"`
}

// ForwardReturn maps token → return over the horizon.
type ForwardReturn map[string]float64

// QualityResult holds finder quality metrics.
type QualityResult struct {
	IC       float64 `json:"ic"`
	TopNHit  float64 `json:"top_n_hit"`
}

// NormalizeUniverse aligns bars from multiple tokens to a common timeline,
// forward-filling gaps and inserting null bars for completely missing tokens.
func NormalizeUniverse(tokenBars map[string][]TokenBar) ([]UniverseBar, []string) {
	// Collect all unique timestamps
	timeSet := make(map[int64]bool)
	for _, bars := range tokenBars {
		for _, b := range bars {
			timeSet[b.Time] = true
		}
	}

	times := make([]int64, 0, len(timeSet))
	for t := range timeSet {
		times = append(times, t)
	}
	sort.Slice(times, func(i, j int) bool { return times[i] < times[j] })

	// Get token list
	tokens := make([]string, 0, len(tokenBars))
	for sym := range tokenBars {
		tokens = append(tokens, sym)
	}
	sort.Strings(tokens)

	// Build per-token time-indexed maps
	type indexed struct {
		idx  int
		bar  TokenBar
	}
	tokenMaps := make(map[string]map[int64]TokenBar)
	for sym, bars := range tokenBars {
		bm := make(map[int64]TokenBar, len(bars))
		for _, b := range bars {
			bm[b.Time] = b
		}
		tokenMaps[sym] = bm
	}

	// Build universe bars with forward-fill
	universe := make([]UniverseBar, len(times))
	lastKnown := make(map[string]TokenBar)

	for ti, t := range times {
		ub := UniverseBar{Time: t, Tokens: make(map[string]TokenBar)}
		for _, sym := range tokens {
			if bar, ok := tokenMaps[sym][t]; ok {
				ub.Tokens[sym] = bar
				lastKnown[sym] = bar
			} else if last, ok := lastKnown[sym]; ok {
				// Forward-fill: carry last known bar with volume=0
				ff := last
				ff.Volume = 0
				ub.Tokens[sym] = ff
			}
			// If token never appeared, it's absent from this bar
		}
		universe[ti] = ub
		_ = indexed{} // avoid unused
	}

	return universe, tokens
}

// RunRanking evaluates a user's finder function across the universe,
// returning ranked token lists for each bar.
func RunRanking(universe []UniverseBar, tokens []string, code string, topN int) RankingResult {
	if len(universe) == 0 {
		return RankingResult{Error: "empty universe"}
	}

	finderFn, errStr := runtime.LoadFinder(code)
	if errStr != "" {
		return RankingResult{Error: errStr}
	}

	var allRankings [][]RankEntry
	var logs []string

	for bi, bar := range universe {
		// Build the bar object for the finder
		scores := make(map[string]float64)
		for sym, tb := range bar.Tokens {
			score, logMsg, err := runFinderOnToken(finderFn, sym, tb, bi, bar.Time)
			if logMsg != "" {
				logs = append(logs, logMsg)
			}
			if err == "" && !math.IsNaN(score) {
				scores[sym] = score
			}
		}

		// Sort by score descending
		entries := make([]RankEntry, 0, len(scores))
		for sym, score := range scores {
			entries = append(entries, RankEntry{Symbol: sym, Score: score})
		}
		sort.Slice(entries, func(i, j int) bool {
			return entries[i].Score > entries[j].Score
		})

		if topN > 0 && len(entries) > topN {
			entries = entries[:topN]
		}

		allRankings = append(allRankings, entries)
	}

	return RankingResult{Rankings: allRankings, Logs: logs}
}

func runFinderOnToken(fn *runtime.FinderFn, symbol string, bar TokenBar, index int, time int64) (float64, string, string) {
	return fn.Evaluate(symbol, bar.Open, bar.High, bar.Low, bar.Close, bar.Volume, index, time)
}

// ComputeForwardReturns calculates the forward return for each token at each bar
// over the given horizon (number of bars ahead).
func ComputeForwardReturns(universe []UniverseBar, tokens []string, horizon int) []ForwardReturn {
	if horizon <= 0 || len(universe) == 0 {
		return nil
	}

	result := make([]ForwardReturn, len(universe))
	for i := 0; i < len(universe); i++ {
		futureIdx := i + horizon
		fr := make(ForwardReturn)
		for _, sym := range tokens {
			curBar, curOk := universe[i].Tokens[sym]
			if !curOk || curBar.Close == 0 {
				fr[sym] = math.NaN()
				continue
			}
			if futureIdx >= len(universe) {
				fr[sym] = math.NaN()
				continue
			}
			futBar, futOk := universe[futureIdx].Tokens[sym]
			if !futOk || futBar.Close == 0 {
				fr[sym] = math.NaN()
				continue
			}
			fr[sym] = (futBar.Close/curBar.Close - 1) * 100
		}
		result[i] = fr
	}
	return result
}

// FinderQuality computes IC (information coefficient — rank correlation) and
// top-N hit rate between rankings and forward returns.
func FinderQuality(rankings [][]RankEntry, fwdReturns []ForwardReturn, topN int) QualityResult {
	if len(rankings) == 0 || len(fwdReturns) != len(rankings) {
		return QualityResult{}
	}

	var ics []float64
	totalTopNChecks := 0
	topNHits := 0

	for i := 0; i < len(rankings); i++ {
		if i >= len(fwdReturns) {
			break
		}
		ranking := rankings[i]
		fwd := fwdReturns[i]

		if len(ranking) < 2 {
			continue
		}

		// Build paired scores and forward returns
		var pairs []scorePair
		for _, r := range ranking {
			if fr, ok := fwd[r.Symbol]; ok && !math.IsNaN(fr) {
				pairs = append(pairs, scorePair{score: r.Score, fwdRet: fr})
			}
		}
		if len(pairs) < 2 {
			continue
		}

		// Spearman rank correlation
		ic := spearmanRankIC(pairs)
		if !math.IsNaN(ic) {
			ics = append(ics, ic)
		}

		// Top-N hit rate: is the #1 ranked token also #1 in forward return?
		if topN > 0 && len(ranking) > 0 && len(pairs) > 0 {
			totalTopNChecks++
			// Find the top-N by forward return among the ranked tokens
			bestSym := ""
			bestFwd := math.Inf(-1)
			for _, r := range ranking[:min(topN, len(ranking))] {
				if fr, ok := fwd[r.Symbol]; ok && fr > bestFwd {
					bestFwd = fr
					bestSym = r.Symbol
				}
			}
			// Check if the #1 ranked token is the best forward performer
			if bestSym == ranking[0].Symbol {
				topNHits++
			}
		}
	}

	q := QualityResult{}
	if len(ics) > 0 {
		sum := 0.0
		for _, ic := range ics {
			sum += ic
		}
		q.IC = sum / float64(len(ics))
	}
	if totalTopNChecks > 0 {
		q.TopNHit = float64(topNHits) / float64(totalTopNChecks) * 100
	}
	return q
}

func spearmanRankIC(pairs []scorePair) float64 {
	n := len(pairs)
	// Rank by score and by forward return
	scoreRanks := rankValues(pairs, func(p scorePair) float64 { return p.score })
	fwdRanks := rankValues(pairs, func(p scorePair) float64 { return p.fwdRet })

	sumD2 := 0.0
	for i := 0; i < n; i++ {
		d := scoreRanks[i] - fwdRanks[i]
		sumD2 += d * d
	}

	denom := float64(n * (n*n - 1))
	if denom == 0 {
		return math.NaN()
	}
	return 1.0 - (6.0*sumD2)/denom
}

func rankValues(pairs []scorePair, get func(scorePair) float64) []float64 {
	n := len(pairs)
	type indexed struct {
		idx int
		val float64
	}
	items := make([]indexed, n)
	for i, p := range pairs {
		items[i] = indexed{idx: i, val: get(p)}
	}
	sort.Slice(items, func(i, j int) bool { return items[i].val < items[j].val })

	ranks := make([]float64, n)
	for i := 0; i < n; {
		j := i
		for j < n && items[j].val == items[i].val {
			j++
		}
		avgRank := float64(i+j-1)/2.0 + 1 // 1-based ranks
		for k := i; k < j; k++ {
			ranks[items[k].idx] = avgRank
		}
		i = j
	}
	return ranks
}

// ChooseBinding determines whether a slot should rebind from currentToken to
// the best-ranked token. Implements hysteresis: switches only when challenger
// score exceeds current score by switchMarginPct, or current token dropped out,
// or slot is empty.
func ChooseBinding(ranking []RankEntry, currentToken string, switchMarginPct float64, tradeable map[string]bool, locked bool) (string, float64, string) {
	if locked {
		return currentToken, 0, "locked"
	}

	if len(ranking) == 0 {
		return currentToken, 0, "empty ranking"
	}

	// Find the best tradeable token from the ranking
	var best *RankEntry
	for i := range ranking {
		if tradeable == nil || tradeable[ranking[i].Symbol] {
			best = &ranking[i]
			break
		}
	}
	if best == nil {
		return currentToken, 0, "no tradeable tokens"
	}

	// Empty slot → bind immediately
	if currentToken == "" {
		return best.Symbol, best.Score, fmt.Sprintf("initial bind to %s", best.Symbol)
	}

	// Current token dropped out → switch
	inRanking := false
	var currentScore float64
	for _, r := range ranking {
		if r.Symbol == currentToken {
			inRanking = true
			currentScore = r.Score
			break
		}
	}
	if !inRanking {
		return best.Symbol, best.Score, fmt.Sprintf("current %s dropped from ranking, switching to %s", currentToken, best.Symbol)
	}

	// Check if current is the best
	if best.Symbol == currentToken {
		return currentToken, best.Score, "already on best"
	}

	// Hysteresis: only switch if challenger beats current by margin
	if best.Score > currentScore+(switchMarginPct/100)*math.Abs(currentScore) {
		return best.Symbol, best.Score, fmt.Sprintf("switching from %s (%.4f) to %s (%.4f)", currentToken, currentScore, best.Symbol, best.Score)
	}

	return currentToken, currentScore, fmt.Sprintf("holding %s (%.4f), %s (%.4f) insufficient margin", currentToken, currentScore, best.Symbol, best.Score)
}
