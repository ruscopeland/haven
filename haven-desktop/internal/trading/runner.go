package trading

import (
	"context"
	"fmt"
	"log/slog"
	"sync"
	"time"

	"github.com/google/uuid"

	"github.com/ruscopeland/haven-desktop/engine/runtime"
	"github.com/ruscopeland/haven-desktop/internal/db"
	"github.com/ruscopeland/haven-desktop/internal/market"
)

// RunnerState tracks a single running strategy instance.
type RunnerState struct {
	Strategy   db.Strategy
	LastBar    int64      // timestamp of the last processed bar
	Loaded     *runtime.Strategy
	Params     map[string]float64
	Portfolio  bool       // true if strategy has a finder bound
	FinderID   string
}

// StrategyRunner executes saved strategies on closed bars.
// It reuses the Go strategy engine (goja VM) for executing user JavaScript.
type StrategyRunner struct {
	store       *db.Store
	market      *market.Service
	logger      *slog.Logger
	mode        Mode

	mu          sync.Mutex
	runners     map[string]*RunnerState // strategy ID → runner state
	lastListFetch time.Time
	running     bool
	stopCh      chan struct{}

	// Callback when a strategy emits a signal
	onSignal func(signal Signal)
}

// Signal is emitted by a strategy when it wants to trade.
type Signal struct {
	StrategyID string  `json:"strategy_id"`
	Symbol     string  `json:"symbol"`
	Side       string  `json:"side"` // "buy" or "sell"
	Usd        float64 `json:"usd"`
	Qty        float64 `json:"qty"`
	Tp         float64 `json:"tp"`
	Sl         float64 `json:"sl"`
}

// NewStrategyRunner creates a strategy runner.
func NewStrategyRunner(store *db.Store, market *market.Service, logger *slog.Logger, mode Mode) *StrategyRunner {
	return &StrategyRunner{
		store:   store,
		market:  market,
		logger:  logger,
		mode:    mode,
		runners: make(map[string]*RunnerState),
	}
}

// SetOnSignal registers a callback for strategy signals.
func (r *StrategyRunner) SetOnSignal(fn func(signal Signal)) {
	r.onSignal = fn
}

// Start begins the strategy execution loop.
func (r *StrategyRunner) Start(ctx context.Context, tickSec int) {
	if r.running {
		return
	}
	r.running = true
	r.stopCh = make(chan struct{})

	if tickSec < 5 {
		tickSec = 5
	}

	go func() {
		ticker := time.NewTicker(time.Duration(tickSec) * time.Second)
		defer ticker.Stop()

		for {
			select {
			case <-ticker.C:
				r.tick(ctx)
			case <-r.stopCh:
				return
			}
		}
	}()

	r.logger.Info("strategy runner started", "mode", r.mode, "tick_sec", tickSec)
}

// Stop halts the strategy runner.
func (r *StrategyRunner) Stop() {
	if !r.running {
		return
	}
	r.running = false
	close(r.stopCh)
	r.logger.Info("strategy runner stopped")
}

func (r *StrategyRunner) tick(ctx context.Context) {
	// Refresh strategy list periodically
	if time.Since(r.lastListFetch) > 15*time.Second {
		r.lastListFetch = time.Now()
		r.reconcileStrategies(ctx)
	}

	// Process each running strategy
	r.mu.Lock()
	runners := make([]*RunnerState, 0, len(r.runners))
	for _, rs := range r.runners {
		runners = append(runners, rs)
	}
	r.mu.Unlock()

	for _, rs := range runners {
		r.processStrategy(ctx, rs)
	}
}

func (r *StrategyRunner) reconcileStrategies(ctx context.Context) {
	strategies, err := r.store.ListStrategies()
	if err != nil {
		r.logger.Warn("failed to list strategies", "error", err)
		return
	}

	r.mu.Lock()
	defer r.mu.Unlock()

	activeIDs := make(map[string]bool)
	for _, st := range strategies {
		activeIDs[st.ID] = true

		// Only run strategies that are in the right mode
		stratMode := Mode(st.Mode)
		if stratMode != r.mode && stratMode != ModeDry {
			continue
		}

		if _, exists := r.runners[st.ID]; exists {
			// Update code if changed
			existing := r.runners[st.ID]
			if existing.Strategy.Code != st.Code || existing.Strategy.Version != st.Version {
				r.logger.Info("reloading strategy", "id", st.ID, "name", st.Name)
				loaded, errStr := runtime.LoadStrategy(st.Code, nil)
				if errStr != "" {
					r.logger.Warn("strategy load failed", "id", st.ID, "error", errStr)
					continue
				}
				existing.Loaded = loaded
				existing.Strategy = st
			}
		} else {
			// Initialize new runner
			loaded, errStr := runtime.LoadStrategy(st.Code, nil)
			if errStr != "" {
				r.logger.Warn("strategy load failed", "id", st.ID, "name", st.Name, "error", errStr)
				continue
			}

			r.runners[st.ID] = &RunnerState{
				Strategy:  st,
				Loaded:    loaded,
				Portfolio: st.FinderID != "",
				FinderID:  st.FinderID,
			}
			r.logger.Info("strategy activated", "id", st.ID, "name", st.Name, "portfolio", st.FinderID != "")
		}
	}

	// Remove inactive strategies
	for id := range r.runners {
		if !activeIDs[id] {
			r.logger.Info("strategy deactivated", "id", id)
			delete(r.runners, id)
		}
	}
}

func (r *StrategyRunner) processStrategy(ctx context.Context, rs *RunnerState) {
	symbol := rs.Strategy.Symbol
	if symbol == "" {
		return
	}

	// Fetch latest candles
	candles, err := r.market.FetchAndCacheCandles(ctx, symbol, rs.Strategy.Interval, 500)
	if err != nil {
		return
	}
	if len(candles) < 2 {
		return
	}

	// Find the newest bar
	latestBar := candles[len(candles)-1]

	// Skip if we've already processed this bar
	if latestBar.Time <= rs.LastBar {
		return
	}

	// Convert candles to runtime format
	rtBars := make([]runtime.BarData, len(candles))
	for i, c := range candles {
		rtBars[i] = runtime.BarData{
			Time: c.Time, Open: c.Open, High: c.High,
			Low: c.Low, Close: c.Close, Volume: c.Volume,
		}
	}

	// Create a minimal backtest context just for the latest bar
	btCtx := runtime.NewBacktestCtx(rtBars, 10000, 0.001, 0.0005, nil)

	// Run onBar for the latest bar
	errStr := btCtx.RunOnBar(len(rtBars)-1, rs.Loaded)
	if errStr != "" {
		r.logger.Warn("strategy error", "id", rs.Strategy.ID, "error", errStr)
	}

	// Check for pending signals (emitted on this bar)
	pending := btCtx.PendingSignals()
	for _, ps := range pending {
		signal := Signal{
			StrategyID: rs.Strategy.ID,
			Symbol:     symbol,
			Side:       ps.Side,
			Usd:        ps.Usd,
			Qty:        ps.Qty,
			Tp:         ps.Tp,
			Sl:         ps.Sl,
		}

		// Create a marker for the engine to execute
		r.createMarkerFromSignal(signal, latestBar.Close)

		if r.onSignal != nil {
			r.onSignal(signal)
		}
	}

	rs.LastBar = latestBar.Time
}

func (r *StrategyRunner) createMarkerFromSignal(signal Signal, currentPrice float64) {
	direction := "above"
	if signal.Side == "sell" {
		direction = "below"
	}

	m := &db.Marker{
		ID:             uuid.New().String(),
		StrategyID:     signal.StrategyID,
		Symbol:         signal.Symbol,
		ConditionType:  "price",
		ConditionValue: currentPrice,
		Direction:      direction,
	}
	if err := r.store.CreateMarker(m); err != nil {
		r.logger.Error("failed to create marker", "error", err)
		return
	}

	r.logger.Info("marker created",
		"id", m.ID,
		"strategy_id", signal.StrategyID,
		"symbol", signal.Symbol,
		"direction", direction,
		"price", fmt.Sprintf("%.4f", currentPrice),
	)
}
