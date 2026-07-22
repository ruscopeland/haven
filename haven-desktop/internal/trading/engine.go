// Package trading implements the trading engine: marker evaluation, swap execution,
// risk guards, and strategy running. It runs paper (dry) and live modes using the
// same code path — the only difference is whether transactions hit the chain.
package trading

import (
	"context"
	"encoding/json"
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
	MetadataJson   string  `json:"metadata_json"`
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

// UpdateChain safely updates the chain configuration and mode at runtime.
func (e *Engine) UpdateChain(mode Mode, chain *Chain) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.mode = mode
	e.chain = chain
	e.logger.Info("trading engine chain updated", "mode", mode, "has_chain", chain != nil)
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
			if marker.ConditionType == "manual" && marker.ConditionValue > 0 {
				price = marker.ConditionValue
			} else {
				continue
			}
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
	if marker.ConditionType == "manual" {
		return true
	}

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

	txHash := "paper-" + uuid.New().String()

	if e.mode == ModeLive && e.chain != nil {
		var contractAddr string
		decimals := 18

		if marker.MetadataJson != "" && marker.MetadataJson != "{}" {
			var meta struct {
				Contract string `json:"contract_address"`
				Decimals int    `json:"decimals"`
			}
			if err := json.Unmarshal([]byte(marker.MetadataJson), &meta); err == nil {
				if meta.Contract != "" {
					contractAddr = meta.Contract
					if meta.Decimals > 0 {
						decimals = meta.Decimals
					}
				}
			}
		}

		if contractAddr == "" {
			var found bool
			contractAddr, _, found = e.store.TokenBySymbol(marker.Symbol)
			if !found {
				e.logger.Error("token not found for symbol", "symbol", marker.Symbol)
				e.recordFailure(marker.ID)
				return
			}
		}

		isBuy := side == "buy"
		var sellToken, buyToken string
		var amtBeforeFee string

		nativeAddr := "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE"

		bnbPrice := 580.0
		e.mu.Lock()
		if p, ok := e.prices["BNB"]; ok && p > 0 {
			bnbPrice = p
		}
		e.mu.Unlock()

		if isBuy {
			sellToken = nativeAddr
			buyToken = contractAddr
			amtBeforeFee = fmt.Sprintf("%.0f", (usd/bnbPrice)*1e18)
		} else {
			sellToken = contractAddr
			buyToken = nativeAddr
			decMultiplier := math.Pow10(decimals)
			amtBeforeFee = fmt.Sprintf("%.0f", qty*decMultiplier)
		}

		cowClient := NewCowClient(e.chain.chainID.Int64())
		quoteReq := CowQuoteRequest{
			Kind:                side,
			SellToken:           sellToken,
			BuyToken:            buyToken,
			SellAmountBeforeFee: amtBeforeFee,
			From:                e.chain.WalletAddress().Hex(),
			Receiver:            e.chain.WalletAddress().Hex(),
			ValidFor:            1800,
		}

		reqJSON, _ := json.Marshal(quoteReq)
		e.logger.Info("cow quote request", "payload", string(reqJSON))

		quoteRes, err := cowClient.GetQuote(ctx, quoteReq)
		if err != nil {
			e.logger.Error("cow quote failed", "error", err)
			e.recordFailure(marker.ID)
			return
		}

		resJSON, _ := json.Marshal(quoteRes)
		e.logger.Info("cow quote response", "payload", string(resJSON))

		sellAmt, _ := new(big.Int).SetString(quoteRes.Quote.SellAmount, 10)
		feeAmt, _ := new(big.Int).SetString(quoteRes.Quote.FeeAmount, 10)
		buyAmt, _ := new(big.Int).SetString(quoteRes.Quote.BuyAmount, 10)

		var signSellAmt, signBuyAmt string
		if isBuy {
			maxSlippage := settings.MaxPriceImpactPct / 100.0
			slipFloat := new(big.Float).SetInt(sellAmt)
			slipFloat.Mul(slipFloat, big.NewFloat(1.0+maxSlippage))
			signSellAmtInt, _ := slipFloat.Int(nil)

			signSellAmt = signSellAmtInt.String()
			signBuyAmt = quoteRes.Quote.BuyAmount
		} else {
			totalSell := new(big.Int).Add(sellAmt, feeAmt)
			signSellAmt = totalSell.String()

			maxSlippage := settings.MaxPriceImpactPct / 100.0
			slipFloat := new(big.Float).SetInt(buyAmt)
			slipFloat.Mul(slipFloat, big.NewFloat(1.0-maxSlippage))
			signBuyAmtInt, _ := slipFloat.Int(nil)
			signBuyAmt = signBuyAmtInt.String()
		}

		orderReq := CowOrderRequest{
			SellToken:         sellToken,
			BuyToken:          buyToken,
			Receiver:          e.chain.WalletAddress().Hex(),
			SellAmount:        signSellAmt,
			BuyAmount:         signBuyAmt,
			ValidTo:           uint32(time.Now().Unix() + 1800),
			AppData:           AppDataHash,
			FeeAmount:         "0",
			Kind:              side,
			PartiallyFillable: false,
			SellTokenBalance:  "erc20",
			BuyTokenBalance:   "erc20",
			SigningScheme:     "eip712",
			From:              e.chain.WalletAddress().Hex(),
		}

		typedData := GenerateEIP712Data(e.chain.chainID.Int64(), orderReq)
		sig, err := e.chain.SignEIP712Order(typedData)
		if err != nil {
			e.logger.Error("sign order failed", "error", err)
			e.recordFailure(marker.ID)
			return
		}
		orderReq.Signature = sig

		if sellToken != nativeAddr {
			sellAmtInt, _ := new(big.Int).SetString(orderReq.SellAmount, 10)
			if sellAmtInt != nil {
				e.logger.Info("checking allowance for cow protocol vault relayer")
				err = e.chain.EnsureAllowance(ctx, common.HexToAddress(sellToken), common.HexToAddress(CowVaultRelayer), sellAmtInt)
				if err != nil {
					e.logger.Error("allowance check failed", "error", err)
					e.recordFailure(marker.ID)
					return
				}
			}
		}

		orderJSON, _ := json.Marshal(orderReq)
		e.logger.Info("cow submit order request", "payload", string(orderJSON))

		uid, err := cowClient.SubmitOrder(ctx, orderReq)
		if err != nil {
			e.logger.Error("submit order failed", "error", err)
			e.recordFailure(marker.ID)
			return
		}
		e.logger.Info("cow submit order success", "uid", uid)
		txHash = uid
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
		TxHash:     txHash,
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
	// If the marker has embedded metadata indicating manual trade size, use it
	if marker.MetadataJson != "" && marker.MetadataJson != "{}" {
		var meta struct {
			Usd float64 `json:"usd"`
		}
		if err := json.Unmarshal([]byte(marker.MetadataJson), &meta); err == nil && meta.Usd > 0 {
			return meta.Usd
		}
	}

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
			MetadataJson:   m.MetadataJson,
		}
	}
	return result, nil
}
