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
	"net/http"
	"strconv"
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
	s.mux.HandleFunc("GET /tokens", s.handleListTokens)
	s.mux.HandleFunc("GET /market/prices", s.handleGetPrices)
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
	tokens := s.marketService.GetTokens()
	if tokens == nil {
		tokens = []TokenEntry{}
	}
	writeJSON(w, http.StatusOK, tokens)
}

func (s *Server) handleGetPrices(w http.ResponseWriter, r *http.Request) {
	if s.marketService == nil {
		writeJSON(w, http.StatusOK, map[string]interface{}{})
		return
	}
	tokens := s.marketService.GetTokens()
	prices := make(map[string]float64, len(tokens))
	for _, t := range tokens {
		prices[t.Symbol] = t.Price
	}
	writeJSON(w, http.StatusOK, prices)
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
