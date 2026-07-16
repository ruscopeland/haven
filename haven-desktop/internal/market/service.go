package market

import (
	"context"
	"log/slog"
	"sync"
	"time"

	"github.com/ruscopeland/haven-desktop/internal/db"
)

// Service manages the Binance Alpha data pipeline: periodic token catalogue refresh,
// candle fetching, and ticker updates. It stores everything in the SQLite database.
type Service struct {
	client     *Client
	store      *db.Store
	logger     *slog.Logger
	intervalMs map[string]int64

	mu         sync.RWMutex
	tokens     []TokenInfo
	lastFetch  time.Time
	running    bool
	stopCh     chan struct{}
}

// NewService creates a market data service.
func NewService(store *db.Store, logger *slog.Logger) *Service {
	return &Service{
		client: NewClient(),
		store:  store,
		logger: logger,
		intervalMs: map[string]int64{
			"1m":  60_000,
			"3m":  180_000,
			"5m":  300_000,
			"15m": 900_000,
			"30m": 1_800_000,
			"1h":  3_600_000,
			"4h":  14_400_000,
			"1d":  86_400_000,
		},
	}
}

// Start begins the background data refresh loop.
func (s *Service) Start(ctx context.Context, refreshSec int) {
	if s.running {
		return
	}
	s.running = true
	s.stopCh = make(chan struct{})

	if refreshSec < 15 {
		refreshSec = 15
	}

	// Initial fetch
	s.refreshCatalogue(ctx)
	s.refreshTickers(ctx)

	go func() {
		ticker := time.NewTicker(time.Duration(refreshSec) * time.Second)
		defer ticker.Stop()

		for {
			select {
			case <-ticker.C:
				s.refreshCatalogue(ctx)
				s.refreshTickers(ctx)
			case <-s.stopCh:
				return
			}
		}
	}()

	s.logger.Info("market data service started", "refresh_sec", refreshSec)
}

// Stop halts the background refresh loop.
func (s *Service) Stop() {
	if !s.running {
		return
	}
	s.running = false
	close(s.stopCh)
	s.logger.Info("market data service stopped")
}

// Tokens returns the cached token catalogue.
func (s *Service) Tokens() []TokenInfo {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.tokens
}

// FetchAndCacheCandles retrieves candles for a symbol+interval pair,
// caching the result in the database.
func (s *Service) FetchAndCacheCandles(ctx context.Context, symbol, interval string, limit int) ([]db.Candle, error) {
	// Check cache first
	cached, err := s.store.GetCandles(symbol, interval, limit)
	if err == nil && len(cached) >= limit {
		return cached, nil
	}

	klines, err := s.client.FetchKlines(ctx, symbol, interval, limit)
	if err != nil {
		// Return whatever we have cached
		if len(cached) > 0 {
			s.logger.Warn("binance alpha klines failed, using cached", "symbol", symbol, "interval", interval, "error", err)
			return cached, nil
		}
		return nil, err
	}

	// Convert and store
	var candles []db.Candle
	for _, k := range klines {
		candles = append(candles, db.Candle{
			Symbol:   symbol,
			Interval: interval,
			Time:     k.OpenTime,
			Open:     k.Open,
			High:     k.High,
			Low:      k.Low,
			Close:    k.Close,
			Volume:   k.Volume,
		})
	}

	if len(candles) > 0 {
		if err := s.store.SaveCandles(candles); err != nil {
			s.logger.Warn("failed to save candles", "symbol", symbol, "error", err)
		}
	}

	return candles, nil
}

func (s *Service) refreshCatalogue(ctx context.Context) {
	tokens, err := s.client.FetchTokens(ctx)
	if err != nil {
		s.logger.Warn("token catalogue refresh failed", "error", err)
		return
	}

	s.mu.Lock()
	s.tokens = tokens
	s.lastFetch = time.Now()
	s.mu.Unlock()

	s.logger.Debug("token catalogue refreshed", "count", len(tokens))
}

func (s *Service) refreshTickers(ctx context.Context) {
	tokens := s.Tokens()
	if len(tokens) == 0 {
		return
	}

	var wg sync.WaitGroup
	sem := make(chan struct{}, 10) // max 10 concurrent

	for i := range tokens {
		wg.Add(1)
		go func(t TokenInfo) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()

			ticker, err := s.client.FetchTicker(ctx, t.Symbol)
			if err != nil {
				return
			}

			// Store latest ticker in settings for the API
			s.mu.Lock()
			for idx := range s.tokens {
				if s.tokens[idx].AlphaID == t.AlphaID {
					s.tokens[idx].Price = ticker.Price
					s.tokens[idx].PriceChange24h = ticker.PriceChangePercent
					s.tokens[idx].Volume24h = ticker.QuoteVolume24h
					break
				}
			}
			s.mu.Unlock()
		}(tokens[i])
	}

	wg.Wait()
}
