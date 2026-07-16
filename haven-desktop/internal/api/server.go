// Package api provides the local HTTP API server that the React frontend connects to.
// It replaces the cloud-hosted FastAPI backend with a local Go implementation
// backed by SQLite and the user's own Binance Alpha credentials.
package api

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log/slog"
	"math"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/ruscopeland/haven-desktop/internal/db"
)

// Server is the local HTTP API server.
type Server struct {
	store         *db.Store
	logger        *slog.Logger
	mux           *http.ServeMux
	marketService MarketProvider
}

// MarketProvider is the interface for market data operations.
type MarketProvider interface {
	GetTokens() []TokenEntry
	FetchAndCacheCandles(ctx context.Context, symbol, interval string, limit int) ([]db.Candle, error)
}

// TokenEntry is a lightweight token reference for the API.
type TokenEntry struct {
	AlphaID         string  `json:"alpha_id"`
	Symbol          string  `json:"symbol"`
	Name            string  `json:"name"`
	ContractAddress string  `json:"contract_address"`
	Price           float64 `json:"price"`
	PriceChange24h  float64 `json:"price_change_24h"`
	Volume24h       float64 `json:"volume_24h"`
}

// NewServer creates a new API server with the given store.
func NewServer(store *db.Store, logger *slog.Logger, market MarketProvider) *Server {
	s := &Server{
		store:         store,
		logger:        logger,
		mux:           http.NewServeMux(),
		marketService: market,
	}
	s.registerRoutes()
	return s
}

// Handler returns the HTTP handler for use with http.Server or Wails.
func (s *Server) Handler() http.Handler {
	return withCORS(withLogging(s.logger, s.mux))
}

func (s *Server) registerRoutes() {
	// Health
	s.mux.HandleFunc("GET /health", s.handleHealth)

	// Strategies
	s.mux.HandleFunc("GET /strategies", s.handleListStrategies)
	s.mux.HandleFunc("POST /strategies", s.handleCreateStrategy)
	s.mux.HandleFunc("GET /strategies/{id}", s.handleGetStrategy)
	s.mux.HandleFunc("PUT /strategies/{id}", s.handleUpdateStrategy)
	s.mux.HandleFunc("DELETE /strategies/{id}", s.handleDeleteStrategy)

	// Finders
	s.mux.HandleFunc("GET /finders", s.handleListFinders)
	s.mux.HandleFunc("POST /finders", s.handleCreateFinder)
	s.mux.HandleFunc("DELETE /finders/{id}", s.handleDeleteFinder)

	// Trades
	s.mux.HandleFunc("GET /trades", s.handleListTrades)

	// Engine keys (connection keys for engine → cloud bridge)
	s.mux.HandleFunc("GET /engine/keys", s.handleListEngineKeys)
	s.mux.HandleFunc("POST /engine/keys", s.handleCreateEngineKey)
	s.mux.HandleFunc("DELETE /engine/keys/{id}", s.handleDeleteEngineKey)

	// Settings
	s.mux.HandleFunc("GET /settings/{key}", s.handleGetSetting)
	s.mux.HandleFunc("PUT /settings/{key}", s.handleSetSetting)

	// Subscription
	s.mux.HandleFunc("GET /subscription/status", s.handleSubscriptionStatus)
	s.mux.HandleFunc("POST /subscription/verify", s.handleSubscriptionVerify)

	// Market data
	s.mux.HandleFunc("GET /candles", s.handleGetCandles)
	s.mux.HandleFunc("GET /klines/{symbol}", s.handleGetKlines)
	s.mux.HandleFunc("GET /universe", s.handleGetUniverse)
	s.mux.HandleFunc("GET /tokens", s.handleListTokens)
	s.mux.HandleFunc("GET /tokens/{symbol}", s.handleGetToken)
	s.mux.HandleFunc("GET /tokens/search", s.handleTokenSearch)
	s.mux.HandleFunc("POST /tokens/ensure", s.handleTokenEnsure)
	s.mux.HandleFunc("GET /market/prices", s.handleGetPrices)
	s.mux.HandleFunc("GET /signals", s.handleGetSignals)
	s.mux.HandleFunc("GET /chains", s.handleGetChains)
}

// --- Health ---

func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{
		"status": "ok",
		"mode":   "local",
	})
}

// --- Strategies ---

func (s *Server) handleListStrategies(w http.ResponseWriter, r *http.Request) {
	strategies, err := s.store.ListStrategies()
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if strategies == nil {
		strategies = []db.Strategy{}
	}
	writeJSON(w, http.StatusOK, strategies)
}

func (s *Server) handleCreateStrategy(w http.ResponseWriter, r *http.Request) {
	var st db.Strategy
	if err := json.NewDecoder(r.Body).Decode(&st); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON")
		return
	}
	if st.ID == "" {
		st.ID = uuid.New().String()
	}
	if err := s.store.CreateStrategy(&st); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusCreated, st)
}

func (s *Server) handleGetStrategy(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	st, err := s.store.GetStrategy(id)
	if err != nil {
		writeError(w, http.StatusNotFound, "strategy not found")
		return
	}
	writeJSON(w, http.StatusOK, st)
}

func (s *Server) handleUpdateStrategy(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	var st db.Strategy
	if err := json.NewDecoder(r.Body).Decode(&st); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON")
		return
	}
	st.ID = id
	if err := s.store.UpdateStrategy(&st); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, st)
}

func (s *Server) handleDeleteStrategy(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if err := s.store.DeleteStrategy(id); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "deleted"})
}

// --- Finders ---

func (s *Server) handleListFinders(w http.ResponseWriter, r *http.Request) {
	finders, err := s.store.ListFinders()
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if finders == nil {
		finders = []db.Finder{}
	}
	writeJSON(w, http.StatusOK, finders)
}

func (s *Server) handleCreateFinder(w http.ResponseWriter, r *http.Request) {
	var f db.Finder
	if err := json.NewDecoder(r.Body).Decode(&f); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON")
		return
	}
	if f.ID == "" {
		f.ID = uuid.New().String()
	}
	if err := s.store.CreateFinder(&f); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusCreated, f)
}

func (s *Server) handleDeleteFinder(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if err := s.store.DeleteFinder(id); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "deleted"})
}

// --- Trades ---

func (s *Server) handleListTrades(w http.ResponseWriter, r *http.Request) {
	strategyID := r.URL.Query().Get("strategy_id")
	limit := 200
	trades, err := s.store.ListTrades(strategyID, limit)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if trades == nil {
		trades = []db.TradeRecord{}
	}
	writeJSON(w, http.StatusOK, trades)
}

// --- Engine keys ---

func (s *Server) handleListEngineKeys(w http.ResponseWriter, r *http.Request) {
	// For the local app, engine keys are stored in settings
	keysJSON, _ := s.store.GetSetting("engine_keys")
	if keysJSON == "" {
		writeJSON(w, http.StatusOK, []interface{}{})
		return
	}
	var keys []map[string]interface{}
	json.Unmarshal([]byte(keysJSON), &keys)
	writeJSON(w, http.StatusOK, keys)
}

func (s *Server) handleCreateEngineKey(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Name string `json:"name"`
	}
	json.NewDecoder(r.Body).Decode(&req)

	rawKey := uuid.New().String() + "-" + uuid.New().String()
	hash := sha256.Sum256([]byte(rawKey))
	keyHash := hex.EncodeToString(hash[:])

	newKey := map[string]interface{}{
		"id":         uuid.New().String(),
		"key_hash":   keyHash,
		"name":       req.Name,
		"active":     true,
		"created_at": time.Now().UTC().Format(time.RFC3339),
		"raw_key":    rawKey, // shown once
	}

	keysJSON, _ := s.store.GetSetting("engine_keys")
	var keys []map[string]interface{}
	if keysJSON != "" {
		json.Unmarshal([]byte(keysJSON), &keys)
	}
	keys = append(keys, newKey)
	data, _ := json.Marshal(keys)
	s.store.SetSetting("engine_keys", string(data))

	writeJSON(w, http.StatusCreated, newKey)
}

func (s *Server) handleDeleteEngineKey(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	keysJSON, _ := s.store.GetSetting("engine_keys")
	var keys []map[string]interface{}
	if keysJSON != "" {
		json.Unmarshal([]byte(keysJSON), &keys)
	}
	var filtered []map[string]interface{}
	for _, k := range keys {
		if k["id"] != id {
			filtered = append(filtered, k)
		}
	}
	data, _ := json.Marshal(filtered)
	s.store.SetSetting("engine_keys", string(data))
	writeJSON(w, http.StatusOK, map[string]string{"status": "revoked"})
}

// --- Settings ---

func (s *Server) handleGetSetting(w http.ResponseWriter, r *http.Request) {
	key := r.PathValue("key")
	value, err := s.store.GetSetting(key)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"key": key, "value": value})
}

func (s *Server) handleSetSetting(w http.ResponseWriter, r *http.Request) {
	key := r.PathValue("key")
	var req struct {
		Value string `json:"value"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON")
		return
	}
	if err := s.store.SetSetting(key, req.Value); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "saved"})
}

// --- Subscription ---

func (s *Server) handleSubscriptionStatus(w http.ResponseWriter, r *http.Request) {
	// Check locally cached subscription state
	data, _ := s.store.GetSetting("subscription_status")
	if data == "" {
		// No cached status — app needs to verify with cloud
		writeJSON(w, http.StatusOK, map[string]interface{}{
			"app_access":   true,
			"tier":         "unverified",
			"needs_verify": true,
		})
		return
	}
	var status map[string]interface{}
	json.Unmarshal([]byte(data), &status)
	writeJSON(w, http.StatusOK, status)
}

func (s *Server) handleSubscriptionVerify(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ClerkToken string `json:"clerk_token"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON")
		return
	}

	// TODO: Call cloud service to verify subscription
	// For now, accept any token and return active trial
	entitlement := map[string]interface{}{
		"app_access":      true,
		"tier":            "starter",
		"trial_end":       "",
		"max_strategies":  5,
		"max_finders":     2,
		"max_bots":        1,
		"universe_tokens": 20,
		"live_trading":    false,
		"finder_enabled":  false,
		"engine_access":   true,
		"data_refresh_sec": 30,
	}

	data, _ := json.Marshal(entitlement)
	s.store.SetSetting("subscription_status", string(data))
	writeJSON(w, http.StatusOK, entitlement)
}

// --- Market data ---

func (s *Server) handleGetCandles(w http.ResponseWriter, r *http.Request) {
	symbol := r.URL.Query().Get("symbol")
	interval := r.URL.Query().Get("interval")
	if symbol == "" || interval == "" {
		writeError(w, http.StatusBadRequest, "symbol and interval required")
		return
	}

	limit := 500
	if l := r.URL.Query().Get("limit"); l != "" {
		if n, err := strconv.Atoi(l); err == nil && n > 0 && n <= 1500 {
			limit = n
		}
	}

	// Use market service if available (fetches from Binance Alpha, caches in DB)
	if s.marketService != nil {
		candles, err := s.marketService.FetchAndCacheCandles(r.Context(), symbol, interval, limit)
		if err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		if candles == nil {
			candles = []db.Candle{}
		}
		writeJSON(w, http.StatusOK, candles)
		return
	}

	// Fallback: just return cached data
	candles, err := s.store.GetCandles(symbol, interval, limit)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if candles == nil {
		candles = []db.Candle{}
	}
	writeJSON(w, http.StatusOK, candles)
}

func (s *Server) handleListTokens(w http.ResponseWriter, r *http.Request) {
	if s.marketService == nil {
		writeJSON(w, http.StatusOK, []TokenEntry{})
		return
	}

	// Support pagination params the wallet scanner uses
	skip := 0
	limit := 500
	if s := r.URL.Query().Get("skip"); s != "" {
		if n, err := strconv.Atoi(s); err == nil && n >= 0 {
			skip = n
		}
	}
	if l := r.URL.Query().Get("limit"); l != "" {
		if n, err := strconv.Atoi(l); err == nil && n > 0 && n <= 500 {
			limit = n
		}
	}

	tokens := s.marketService.GetTokens()
	if tokens == nil {
		tokens = []TokenEntry{}
	}

	// Build enriched token list with contract_address, chain_id, status
	type enrichedToken struct {
		Symbol          string  `json:"symbol"`
		Name            string  `json:"name"`
		DisplaySymbol   string  `json:"display_symbol"`
		ContractAddress string  `json:"contract_address"`
		ChainID         string  `json:"chain_id"`
		AlphaID         string  `json:"alpha_id"`
		Status          string  `json:"status"`
		Price           float64 `json:"price"`
		PriceChange24h  float64 `json:"price_change_24h"`
		Volume24h       float64 `json:"volume_24h"`
		Decimals        int     `json:"decimals"`
	}

	enriched := make([]enrichedToken, len(tokens))
	for i, t := range tokens {
		enriched[i] = enrichedToken{
			Symbol:          t.Symbol,
			Name:            t.Name,
			DisplaySymbol:   t.Symbol,
			ContractAddress: t.ContractAddress,
			ChainID:         "bsc",
			AlphaID:         t.AlphaID,
			Status:          "active",
			Price:           t.Price,
			PriceChange24h:  t.PriceChange24h,
			Volume24h:       t.Volume24h,
			Decimals:        18,
		}
	}

	// Apply pagination
	if skip >= len(enriched) {
		writeJSON(w, http.StatusOK, []enrichedToken{})
		return
	}
	end := skip + limit
	if end > len(enriched) {
		end = len(enriched)
	}

	writeJSON(w, http.StatusOK, enriched[skip:end])
}

func (s *Server) handleGetToken(w http.ResponseWriter, r *http.Request) {
	symbol := r.PathValue("symbol")
	if s.marketService == nil {
		writeError(w, http.StatusNotFound, "token not found")
		return
	}

	for _, t := range s.marketService.GetTokens() {
		if strings.EqualFold(t.Symbol, symbol) {
			writeJSON(w, http.StatusOK, map[string]interface{}{
				"symbol":           t.Symbol,
				"name":             t.Name,
				"display_symbol":   t.Symbol,
				"contract_address": t.ContractAddress,
				"chain_id":         "bsc",
				"alpha_id":         t.AlphaID,
				"status":           "active",
				"decimals":         18,
			})
			return
		}
	}
	writeError(w, http.StatusNotFound, "token not found")
}

func (s *Server) handleTokenSearch(w http.ResponseWriter, r *http.Request) {
	q := strings.ToLower(r.URL.Query().Get("q"))
	if q == "" {
		writeJSON(w, http.StatusOK, []interface{}{})
		return
	}
	if s.marketService == nil {
		writeJSON(w, http.StatusOK, []interface{}{})
		return
	}

	var results []map[string]interface{}
	for _, t := range s.marketService.GetTokens() {
		if strings.Contains(strings.ToLower(t.Symbol), q) ||
			strings.Contains(strings.ToLower(t.Name), q) {
			results = append(results, map[string]interface{}{
				"symbol":           t.Symbol,
				"name":             t.Name,
				"display":          t.Symbol,
				"contract_address": t.ContractAddress,
				"chain":            "bsc",
				"chain_id":         "56",
				"alpha_id":         t.AlphaID,
				"in_db":            true,
				"price":            t.Price,
				"volume_24h":       t.Volume24h,
				"price_change_24h": t.PriceChange24h,
			})
			if len(results) >= 12 {
				break
			}
		}
	}
	writeJSON(w, http.StatusOK, results)
}

func (s *Server) handleTokenEnsure(w http.ResponseWriter, r *http.Request) {
	// In the desktop app, all Binance Alpha tokens are already available.
	// Just return the requested token if we have it.
	var req struct {
		AlphaID         string `json:"alpha_id"`
		Chain           string `json:"chain"`
		ContractAddress string `json:"contract_address"`
		Display         string `json:"display"`
		Name            string `json:"name"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON")
		return
	}

	// Try to find by alpha_id or contract address
	if s.marketService != nil {
		for _, t := range s.marketService.GetTokens() {
			if req.AlphaID != "" && strings.EqualFold(t.AlphaID, req.AlphaID) {
				writeJSON(w, http.StatusOK, map[string]interface{}{
					"symbol": t.Symbol, "name": t.Name, "display": t.Symbol,
					"chain": "bsc", "contract_address": t.ContractAddress,
					"status": "active",
				})
				return
			}
		}
	}
	// Token not found in our catalogue — still return success with what we know
	writeJSON(w, http.StatusOK, map[string]interface{}{
		"symbol": req.Display, "name": req.Name, "display": req.Display,
		"chain": req.Chain, "contract_address": req.ContractAddress,
		"status": "active",
	})
}

func (s *Server) handleGetPrices(w http.ResponseWriter, r *http.Request) {
	prices := make(map[string]interface{})
	if s.marketService != nil {
		for _, t := range s.marketService.GetTokens() {
			prices[t.Symbol] = map[string]interface{}{
				"price":        t.Price,
				"change_24h":   t.PriceChange24h,
				"volume_24h":   t.Volume24h,
				"updated_at":   time.Now().UnixMilli(),
			}
		}
	}
	// Always include BNB placeholder for wallet pricing
	if _, ok := prices["BNB"]; !ok {
		prices["BNB"] = map[string]interface{}{
			"price": 580.0, "change_24h": 0, "volume_24h": 0,
			"updated_at": time.Now().UnixMilli(),
		}
	}
	writeJSON(w, http.StatusOK, map[string]interface{}{
		"source": "binance_alpha",
		"prices": prices,
	})
}

// SignalResponse mirrors the old cloud API's /signals response format
// that the React screener expects.
type SignalResponse struct {
	Symbol         string  `json:"symbol"`
	Name           string  `json:"name"`
	DisplaySymbol  string  `json:"display_symbol"`
	Timestamp      int64   `json:"timestamp"`
	PriceChange24h float64 `json:"price_change_24h"`
	Volume24h      float64 `json:"volume_24h"`
	MarketCap      float64 `json:"market_cap"`
	AlphaRank      int     `json:"alpha_rank"`
	LastPrice      float64 `json:"last_price"`
}

func (s *Server) handleGetSignals(w http.ResponseWriter, r *http.Request) {
	if s.marketService == nil {
		writeJSON(w, http.StatusOK, []SignalResponse{})
		return
	}

	tokens := s.marketService.GetTokens()
	now := time.Now().UnixMilli()
	signals := make([]SignalResponse, 0, len(tokens))

	for i, t := range tokens {
		signals = append(signals, SignalResponse{
			Symbol:         t.Symbol,
			Name:           t.Name,
			DisplaySymbol:  t.Symbol,
			Timestamp:      now,
			PriceChange24h: t.PriceChange24h,
			Volume24h:      t.Volume24h,
			MarketCap:      0,
			AlphaRank:      i + 1,
			LastPrice:      t.Price,
		})
	}

	// Sort by volume (default)
	sortBy := r.URL.Query().Get("sort_by")
	if sortBy == "" {
		sortBy = "vol_24h"
	}

	sort.Slice(signals, func(i, j int) bool {
		switch sortBy {
		case "price_change", "price_change_24h":
			return signals[i].PriceChange24h > signals[j].PriceChange24h
		case "market_cap":
			return signals[i].MarketCap > signals[j].MarketCap
		case "mcap_vol":
			// Combined score: log(mcap) * vol for ranking
			si := math.Log10(max(signals[i].MarketCap, 1)) * signals[i].Volume24h
			sj := math.Log10(max(signals[j].MarketCap, 1)) * signals[j].Volume24h
			return si > sj
		default: // vol_24h
			return signals[i].Volume24h > signals[j].Volume24h
		}
	})

	limit := 400
	if l := r.URL.Query().Get("limit"); l != "" {
		if n, err := strconv.Atoi(l); err == nil && n > 0 && n <= 500 {
			limit = n
		}
	}
	if len(signals) > limit {
		signals = signals[:limit]
	}

	writeJSON(w, http.StatusOK, signals)
}

func (s *Server) handleGetChains(w http.ResponseWriter, r *http.Request) {
	chains := []map[string]interface{}{
		{
			"id":       "bsc",
			"chain_id": "56",
			"name":     "BNB Smart Chain",
			"native_symbol": "BNB",
			"rpc_url":  "https://bsc-dataseed.binance.org",
		},
	}
	writeJSON(w, http.StatusOK, chains)
}

// handleGetKlines returns candles in the array-of-arrays format that
// lightweight-charts expects: { data: [[time, open, high, low, close, volume, ...], ...] }
func (s *Server) handleGetKlines(w http.ResponseWriter, r *http.Request) {
	symbol := r.PathValue("symbol")
	interval := r.URL.Query().Get("interval")
	if interval == "" {
		interval = "1h"
	}

	limit := 500
	if l := r.URL.Query().Get("limit"); l != "" {
		if n, err := strconv.Atoi(l); err == nil && n > 0 && n <= 1500 {
			limit = n
		}
	}

	if s.marketService == nil {
		writeJSON(w, http.StatusOK, map[string]interface{}{"data": []interface{}{}})
		return
	}

	candles, err := s.marketService.FetchAndCacheCandles(r.Context(), symbol, interval, limit)
	if err != nil || len(candles) == 0 {
		writeJSON(w, http.StatusOK, map[string]interface{}{"data": []interface{}{}})
		return
	}

	// Convert to array-of-arrays format: [openTime, open, high, low, close, volume, closeTime, ...]
	data := make([][]interface{}, len(candles))
	for i, c := range candles {
		data[i] = []interface{}{
			c.Time,                       // 0: openTime
			fmtNum(c.Open),               // 1: open
			fmtNum(c.High),               // 2: high
			fmtNum(c.Low),                // 3: low
			fmtNum(c.Close),              // 4: close
			fmtNum(c.Volume),             // 5: volume
			c.Time + 3600000,             // 6: closeTime (approximate for 1h)
			fmtNum(c.Close * c.Volume),   // 7: quoteVolume
			0,                            // 8: trades
			fmtNum(c.Volume),             // 9: takerBuyBaseVolume
			fmtNum(c.Close * c.Volume),   // 10: takerBuyQuoteVolume
			0,                            // 11: ignore
		}
	}

	writeJSON(w, http.StatusOK, map[string]interface{}{"data": data})
}

func fmtNum(v float64) string {
	return strconv.FormatFloat(v, 'f', -1, 64)
}

// handleGetUniverse returns aligned OHLCV arrays for the top tokens by volume.
// The finder workbench uses this to rank tokens across a common timeline.
func (s *Server) handleGetUniverse(w http.ResponseWriter, r *http.Request) {
	interval := r.URL.Query().Get("interval")
	if interval == "" {
		interval = "15m"
	}

	now := time.Now().UnixMilli()
	startMs := now - 3*86400000 // default: 3 days
	if s := r.URL.Query().Get("start_ms"); s != "" {
		if n, err := strconv.ParseInt(s, 10, 64); err == nil {
			startMs = n
		}
	}

	minVol := 0.0 // default: no filter — tickers load async, they may not be ready yet
	if v := r.URL.Query().Get("min_vol_24h"); v != "" {
		if n, err := strconv.ParseFloat(v, 64); err == nil {
			minVol = n
		}
	}

	maxTokens := 20
	if s.marketService == nil {
		writeJSON(w, http.StatusOK, map[string]interface{}{
			"interval": interval, "times": []int64{}, "tokens": []interface{}{}, "source": "binance_alpha",
		})
		return
	}

	// Get top tokens by volume
	allTokens := s.marketService.GetTokens()
	sort.Slice(allTokens, func(i, j int) bool {
		return allTokens[i].Volume24h > allTokens[j].Volume24h
	})

	var selected []TokenEntry
	for _, t := range allTokens {
		if t.Volume24h >= minVol && t.AlphaID != "" {
			selected = append(selected, t)
			if len(selected) >= maxTokens {
				break
			}
		}
	}

	if len(selected) == 0 {
		writeJSON(w, http.StatusOK, map[string]interface{}{
			"interval": interval, "times": []int64{}, "tokens": []interface{}{}, "source": "binance_alpha",
		})
		return
	}

	// Compute time range
	intervalMs := intervalMs(interval)
	if intervalMs == 0 {
		intervalMs = 900000 // default 15m
	}
	startMs = startMs - (startMs % intervalMs)
	now = now - (now % intervalMs)
	if startMs >= now {
		startMs = now - 86400000
	}

	endMs := now
	totalBars := int((endMs - startMs) / intervalMs)
	if totalBars > 2880 { // cap at ~30 days of 15m bars
		startMs = endMs - int64(2880)*intervalMs
		totalBars = 2880
	}

	times := make([]int64, totalBars)
	for i := 0; i < totalBars; i++ {
		times[i] = startMs + int64(i)*intervalMs
	}

	// Fetch candles for each token and align
	type tokenData struct {
		Symbol         string    `json:"symbol"`
		Name           string    `json:"name"`
		Chain          string    `json:"chain"`
		Volume24h      float64   `json:"volume24h"`
		PriceChange24h float64   `json:"priceChange24h"`
		O              []*float64 `json:"o"`
		H              []*float64 `json:"h"`
		L              []*float64 `json:"l"`
		C              []*float64 `json:"c"`
		Volume         []*float64 `json:"volume"`
	}

	var result []tokenData
	for _, tok := range selected {
		candles, err := s.marketService.FetchAndCacheCandles(r.Context(), tok.Symbol, interval, totalBars+10)
		if err != nil || len(candles) == 0 {
			continue
		}

		idx := make(map[int64]int, len(candles))
		for _, c := range candles {
			idx[c.Time] = 1 // mark presence
		}

		td := tokenData{
			Symbol:         tok.Symbol,
			Name:           tok.Name,
			Chain:          "bsc",
			Volume24h:      tok.Volume24h,
			PriceChange24h: tok.PriceChange24h,
			O:              make([]*float64, totalBars),
			H:              make([]*float64, totalBars),
			L:              make([]*float64, totalBars),
			C:              make([]*float64, totalBars),
			Volume:         make([]*float64, totalBars),
		}

		ci := 0
		for ti, t := range times {
			for ci < len(candles) && candles[ci].Time < t {
				ci++
			}
			if ci < len(candles) && candles[ci].Time == t {
				v := candles[ci]
				td.O[ti] = fptr(v.Open)
				td.H[ti] = fptr(v.High)
				td.L[ti] = fptr(v.Low)
				td.C[ti] = fptr(v.Close)
				td.Volume[ti] = fptr(v.Volume)
			}
		}

		// Only include if we have at least some data
		hasData := false
		for _, c := range td.C {
			if c != nil {
				hasData = true
				break
			}
		}
		if hasData {
			result = append(result, td)
		}
		_ = idx
	}

	writeJSON(w, http.StatusOK, map[string]interface{}{
		"interval": interval,
		"times":    times,
		"tokens":   result,
		"source":   "binance_alpha",
	})
}

func fptr(v float64) *float64 { return &v }

func intervalMs(interval string) int64 {
	switch interval {
	case "1m": return 60000
	case "3m": return 180000
	case "5m": return 300000
	case "15m": return 900000
	case "30m": return 1800000
	case "1h": return 3600000
	case "4h": return 14400000
	case "1d": return 86400000
	}
	return 0
}

// --- Helpers ---

func writeJSON(w http.ResponseWriter, status int, v interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, status int, message string) {
	writeJSON(w, status, map[string]string{"error": message})
}

func withLogging(logger *slog.Logger, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		next.ServeHTTP(w, r)
		logger.Debug("api request",
			"method", r.Method,
			"path", r.URL.Path,
			"duration_ms", time.Since(start).Milliseconds(),
		)
	})
}

func withCORS(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type")
		if r.Method == "OPTIONS" {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// Ensure uuid import is used
var _ = uuid.New
var _ = fmt.Sprintf
