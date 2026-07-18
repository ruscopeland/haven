// Package trading implements the trading engine: marker evaluation, swap execution,
// risk guards, and strategy running. It runs paper (dry) and live modes using the
// same code path — the only difference is whether transactions hit the chain.
package trading

import (
	"context"
	"fmt"
	"log/slog"
	"math"
	"math/big"
	"sync"
	"time"

	"github.com/ethereum/go-ethereum/common"
	"github.com/google/uuid"

	"github.com/ruscopeland/haven-desktop/internal/db"
)

// Mode is the trading mode.
type Mode string

const (
	ModeDry  Mode = "dry"
	ModeLive Mode = "live"
)

// Engine runs the trading loop: reads active markers, detects crosses,
// claims markers atomically, executes swaps through risk guards.
type Engine struct {
	store    *db.Store
	logger   *slog.Logger
	mode     Mode
	chain    *Chain // nil in dry mode

	mu       sync.Mutex
	settings EngineSettings
	running  bool
	stopCh   chan struct{}

	// Per-marker state
	sides         map[string]string    // marker id → "above" | "below"
	attempts      map[string]int       // marker id → failed attempts
	cooldownUntil map[string]time.Time  // marker id → earliest retry
	prices        map[string]float64    // symbol → latest price

	// Daily tracking
	tradesToday    int
	lastDayReset   string

	// Subscriptions / callbacks
	onTrade func(trade db.TradeRecord)
}

// EngineSettings are the configurable risk parameters.
type EngineSettings struct {
	Paused            bool    `json:"paused"`
	MaxTradesPerDay   int     `json:"max_trades_per_day"`
	MaxTradeUsd       float64 `json:"max_trade_usd"`
	MaxPriceImpactPct float64 `json:"max_price_impact_pct"`
	MaxRetryAttempts  int     `json:"max_retry_attempts"`
}

// Marker represents an active trading marker.
type Marker struct {
	ID             string  `json:"id"`
	StrategyID     string  `json:"strategy_id"`
	Symbol         string  `json:"symbol"`
	ConditionType  string  `json:"condition_type"`  // "price", "indicator"
	ConditionValue float64 `json:"condition_value"`
	Direction      string  `json:"direction"`       // "above", "below"
	State          string  `json:"state"`           // "active", "claimed", "done"
}

// NewEngine creates a trading engine.
// chain is nil for dry mode; pass a connected Chain for live trading.
func NewEngine(store *db.Store, logger *slog.Logger, mode Mode, chain *Chain) *Engine {
	return &Engine{
		store:  store,
		logger: logger,
		mode:   mode,
		chain:  chain,
		sides:         make(map[string]string),
		attempts:      make(map[string]int),
		cooldownUntil: make(map[string]time.Time),
		prices:        make(map[string]float64),
		settings: EngineSettings{
			MaxTradesPerDay:   20,
			MaxTradeUsd:       250,
			MaxPriceImpactPct: 3,
			MaxRetryAttempts:  3,
		},
	}
}

// SetOnTrade registers a callback for completed trades.
func (e *Engine) SetOnTrade(fn func(trade db.TradeRecord)) {
	e.onTrade = fn
}

// UpdateSettings refreshes engine settings (called from API or settings UI).
func (e *Engine) UpdateSettings(s EngineSettings) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.settings = s
}

// UpdatePrices refreshes the latest price map used for cross detection.
func (e *Engine) UpdatePrices(prices map[string]float64) {
	e.mu.Lock()
	defer e.mu.Unlock()
	for sym, price := range prices {
		e.prices[sym] = price
	}
}

// Start begins the trading loop.
func (e *Engine) Start(ctx context.Context, intervalSec int) {
	if e.running {
		return
	}
	e.running = true
	e.stopCh = make(chan struct{})

	if intervalSec < 5 {
		intervalSec = 5
	}

	go func() {
		ticker := time.NewTicker(time.Duration(intervalSec) * time.Second)
		defer ticker.Stop()

		// Immediate first tick
		e.tick(ctx)

		for {
			select {
			case <-ticker.C:
				e.tick(ctx)
			case <-e.stopCh:
				return
			}
		}
	}()

	e.logger.Info("trading engine started", "mode", e.mode, "interval_sec", intervalSec)
}

// Stop halts the trading loop.
func (e *Engine) Stop() {
	if !e.running {
		return
	}
	e.running = false
	close(e.stopCh)
	e.logger.Info("trading engine stopped")
}

func (e *Engine) tick(ctx context.Context) {
	e.mu.Lock()
	settings := e.settings
	e.mu.Unlock()

	if settings.Paused {
		return
	}

	// Reset daily counter
	today := time.Now().UTC().Format("2006-01-02")
	e.mu.Lock()
	if e.lastDayReset != today {
		e.tradesToday = 0
		e.lastDayReset = today
	}
	e.mu.Unlock()

	// Fetch active markers from DB
	markers, err := e.loadActiveMarkers()
	if err != nil {
		e.logger.Error("failed to load markers", "error", err)
		return
	}

	for _, marker := range markers {
		if e.isInCooldown(marker.ID) {
			continue
		}

		price, ok := e.prices[marker.Symbol]
		if !ok || price <= 0 {
			continue
		}

		// Detect cross
		if !e.detectCross(marker, price) {
			continue
		}

		// Check daily cap
		e.mu.Lock()
		if e.tradesToday >= settings.MaxTradesPerDay {
			e.mu.Unlock()
			continue
		}
		e.mu.Unlock()

		// Claim the marker atomically
		claimed := e.claimMarker(marker)
		if !claimed {
			continue
		}

		// Execute the trade
		e.executeTrade(ctx, marker, price, settings)
	}

	// Clean up stale marker state
	activeIDs := make(map[string]bool)
	for _, m := range markers {
		activeIDs[m.ID] = true
	}
	e.mu.Lock()
	for id := range e.sides {
		if !activeIDs[id] {
			delete(e.sides, id)
			delete(e.attempts, id)
			delete(e.cooldownUntil, id)
		}
	}
	e.mu.Unlock()
}

func (e *Engine) detectCross(marker Marker, price float64) bool {
	e.mu.Lock()
	prevSide, had := e.sides[marker.ID]
	e.mu.Unlock()

	var currentSide string
	if price > marker.ConditionValue {
		currentSide = "above"
	} else {
		currentSide = "below"
	}

	e.mu.Lock()
	e.sides[marker.ID] = currentSide
	e.mu.Unlock()

	if !had {
		return false // need at least one previous observation
	}

	// Cross detected when side changes to match the marker's direction
	if marker.Direction == "above" && prevSide == "below" && currentSide == "above" {
		return true
	}
	if marker.Direction == "below" && prevSide == "above" && currentSide == "below" {
		return true
	}

	return false
}

func (e *Engine) isInCooldown(markerID string) bool {
	e.mu.Lock()
	defer e.mu.Unlock()
	until, ok := e.cooldownUntil[markerID]
	return ok && time.Now().Before(until)
}

func (e *Engine) claimMarker(marker Marker) bool {
	// Atomic claim: update marker state to "claimed" only if currently "active"
	// This uses SQLite's serialized write access (single connection) for atomicity.
	claimID := uuid.New().String()
	err := e.claimInDB(marker.ID, claimID)
	if err != nil {
		return false
	}
	e.logger.Info("marker claimed", "id", marker.ID, "symbol", marker.Symbol, "claim_id", claimID)
	return true
}

func (e *Engine) claimInDB(markerID, claimID string) error {
	ok, err := e.store.ClaimMarker(markerID, claimID)
	if err != nil {
		return err
	}
	if !ok {
		return fmt.Errorf("marker %s already claimed", markerID)
	}
	return nil
}

func (e *Engine) executeTrade(ctx context.Context, marker Marker, price float64, settings EngineSettings) {
	e.mu.Lock()
	attempts := e.attempts[marker.ID]
	e.mu.Unlock()

	// Check retry limit
	if attempts >= settings.MaxRetryAttempts {
		e.logger.Warn("marker exceeded retry limit", "id", marker.ID, "attempts", attempts)
		return
	}

	// Size the trade
	usd := e.sizeTrade(marker, price, settings)
	if usd <= 0 {
		e.logger.Info("trade skipped — zero size", "id", marker.ID)
		return
	}

	// Price impact check
	impact := e.priceImpactPct(marker.Symbol, usd)
	if impact > settings.MaxPriceImpactPct {
		e.logger.Warn("trade skipped — excessive price impact",
			"id", marker.ID, "impact_pct", fmt.Sprintf("%.2f", impact))
		e.recordFailure(marker.ID)
		return
	}

	// Execute
	qty := usd / price
	feeUsd := usd * 0.001 // 0.1% fee estimate
	side := "buy"
	if marker.Direction == "below" {
		side = "sell"
	}
	trade := db.TradeRecord{
		StrategyID: marker.StrategyID,
		Symbol:     marker.Symbol,
		Side:       side,
		Qty:        math.Round(qty*1e8) / 1e8,
		Price:      price,
		Usd:        usd,
		FeeUsd:     feeUsd,
		Time:       time.Now().UnixMilli(),
		Mode:       string(e.mode),
	}

	// In live mode, send actual swap via OKX DEX.
	// In dry mode, record a simulated trade.
	if e.mode == ModeLive && e.chain != nil {
		// Resolve token contract address from symbol
		tokenAddrStr, _, found := e.store.TokenBySymbol(marker.Symbol)
		if !found {
			e.logger.Error("cannot resolve token address", "symbol", marker.Symbol)
			e.recordFailure(marker.ID)
			return
		}
		tokenAddr := common.HexToAddress(tokenAddrStr)

		// Determine direction: markers always trigger buys in this iteration
		fromAddr := ZeroAddr
		toAddr := tokenAddr
		if marker.Direction == "below" {
			// Sell: swap token for native
			fromAddr = tokenAddr
			toAddr = ZeroAddr
		}

		// Get decimals for the from-token
		decimals := uint8(18)
		if fromAddr != ZeroAddr {
			if d, err := e.chain.GetDecimals(fromAddr); err == nil {
				decimals = d
			}
		}

		// Calculate amount in token base units
		amount := big.NewInt(int64(usd * 1e18 / price)) // approximate
		if price <= 0 {
			e.logger.Error("invalid price for swap", "symbol", marker.Symbol)
			e.recordFailure(marker.ID)
			return
		}

		// Get swap quote and execute
		swapCtx, swapCancel := context.WithTimeout(context.Background(), 60*time.Second)
		defer swapCancel()

		q, err := e.chain.GetSwapQuote(swapCtx, fromAddr, toAddr, amount, decimals, 0, 0)
		if err != nil {
			e.logger.Error("swap quote failed", "symbol", marker.Symbol, "error", err)
			e.recordFailure(marker.ID)
			return
		}

		e.logger.Info("swap quote received",
			"symbol", marker.Symbol,
			"router", q.RouterPath,
			"price_impact", q.PriceImpact+"%",
		)

		// Execute the swap
		tx, err := e.chain.SendSwap(swapCtx, q, 0, []common.Address{q.To})
		if err != nil {
			e.logger.Error("swap execution failed", "symbol", marker.Symbol, "error", err)
			e.recordFailure(marker.ID)
			return
		}

		trade.TxHash = tx.Hash().Hex()
		e.logger.Info("swap broadcast",
			"symbol", marker.Symbol,
			"tx_hash", trade.TxHash,
			"in_amount", q.InAmount.String(),
			"out_amount", q.OutAmount.String(),
		)

		// Wait for receipt and parse fill
		go func() {
			receipt, err := e.chain.WaitForReceipt(context.Background(), tx)
			if err != nil {
				e.logger.Error("swap receipt wait failed", "tx_hash", trade.TxHash, "error", err)
				return
			}
			fill := e.chain.ParseSwapFill(context.Background(), receipt, tokenAddr, decimals, marker.Direction != "below")
			e.logger.Info("swap confirmed",
				"tx_hash", trade.TxHash,
				"token_amount", fmt.Sprintf("%.4f", fill.TokenAmount),
				"native_amount", fmt.Sprintf("%.6f", fill.NativeAmount),
			)
		}()
	} else {
		trade.TxHash = "paper-" + uuid.New().String()
	}

	id, err := e.store.SaveTrade(&trade)
	if err != nil {
		e.logger.Error("failed to save trade", "error", err)
		e.recordFailure(marker.ID)
		return
	}

	e.logger.Info("trade executed",
		"id", id, "symbol", marker.Symbol, "side", trade.Side,
		"qty", fmt.Sprintf("%.4f", trade.Qty), "usd", fmt.Sprintf("%.2f", usd),
		"mode", e.mode,
	)

	e.mu.Lock()
	e.tradesToday++
	delete(e.attempts, marker.ID)
	delete(e.cooldownUntil, marker.ID)
	e.mu.Unlock()

	if e.onTrade != nil {
		e.onTrade(trade)
	}
}

func (e *Engine) sizeTrade(marker Marker, price float64, settings EngineSettings) float64 {
	if settings.MaxTradeUsd <= 0 {
		return 0
	}
	// For markers, use a fixed fraction of max trade size
	usd := settings.MaxTradeUsd * 0.5
	if usd < 10 {
		usd = 10
	}
	return usd
}

func (e *Engine) priceImpactPct(symbol string, usd float64) float64 {
	// Simplified: estimate impact based on 24h volume
	// In production, this would use on-chain liquidity data
	_ = symbol
	if usd < 100 {
		return 0.1
	}
	if usd < 1000 {
		return 0.5
	}
	return 1.0
}

func (e *Engine) recordFailure(markerID string) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.attempts[markerID]++
	e.cooldownUntil[markerID] = time.Now().Add(30 * time.Second)
}

func (e *Engine) loadActiveMarkers() ([]Marker, error) {
	markers, err := e.store.ListActiveMarkers()
	if err != nil {
		return nil, err
	}
	result := make([]Marker, len(markers))
	for i, m := range markers {
		result[i] = Marker{
			ID:             m.ID,
			StrategyID:     m.StrategyID,
			Symbol:         m.Symbol,
			ConditionType:  m.ConditionType,
			ConditionValue: m.ConditionValue,
			Direction:      m.Direction,
			State:          m.State,
		}
	}
	return result, nil
}
