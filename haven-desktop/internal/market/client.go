// Package market provides Binance Alpha market data integration.
// It fetches token catalogues, candles, tickers, and streams real-time prices
// using the user's own Binance account (no API key needed for Alpha public endpoints).
package market

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"
)

const baseURL = "https://www.binance.com/bapi/defi/v1"

// Client handles HTTP requests to Binance Alpha's public API.
type Client struct {
	httpClient *http.Client
}

// NewClient creates a Binance Alpha client.
func NewClient() *Client {
	return &Client{
		httpClient: &http.Client{
			Timeout: 30 * time.Second,
		},
	}
}

// AlphaResponse wraps a decoded Binance Alpha API response.
type AlphaResponse struct {
	Data json.RawMessage `json:"data"`
	Code string          `json:"code"`
}

// TokenInfo represents a token from the Binance Alpha catalogue.
type TokenInfo struct {
	AlphaID         string  `json:"alphaId"`
	Symbol          string  `json:"symbol"`
	Name            string  `json:"name"`
	ChainID         string  `json:"chainId"`
	ContractAddress string  `json:"contractAddress"`
	Price           float64 `json:"price,string"`
	PriceChange24h  float64 `json:"priceChange24h,string"`
	Volume24h       float64 `json:"volume24h,string"`
	MarketCap       float64 `json:"marketCap,string"`
}

// TickerData holds current ticker information for a token.
type TickerData struct {
	Symbol             string  `json:"symbol"`
	Price              float64 `json:"price,string"`
	PriceChange        float64 `json:"priceChange,string"`
	PriceChangePercent float64 `json:"priceChangePercent,string"`
	High24h            float64 `json:"highPrice,string"`
	Low24h             float64 `json:"lowPrice,string"`
	Volume24h          float64 `json:"volume,string"`
	QuoteVolume24h     float64 `json:"quoteVolume,string"`
}

// KlineBar is a single OHLCV candle from Binance Alpha.
type KlineBar struct {
	OpenTime  int64   `json:"0"`
	Open      float64 `json:"1,string"`
	High      float64 `json:"2,string"`
	Low       float64 `json:"3,string"`
	Close     float64 `json:"4,string"`
	Volume    float64 `json:"5,string"`
	CloseTime int64   `json:"6"`
}

// doGet performs a GET request to the Binance Alpha API with retries.
func (c *Client) doGet(ctx context.Context, path string, params map[string]string) (json.RawMessage, error) {
	url := baseURL + path
	req, err := http.NewRequestWithContext(ctx, "GET", url, nil)
	if err != nil {
		return nil, fmt.Errorf("create request: %w", err)
	}
	req.Header.Set("User-Agent", "Haven-Desktop/1.0")
	req.Header.Set("Accept", "application/json")

	if len(params) > 0 {
		q := req.URL.Query()
		for k, v := range params {
			q.Add(k, v)
		}
		req.URL.RawQuery = q.Encode()
	}

	var lastErr error
	for attempt := 0; attempt < 3; attempt++ {
		if attempt > 0 {
			time.Sleep(time.Duration(500*(1<<attempt)) * time.Millisecond)
		}

		resp, err := c.httpClient.Do(req)
		if err != nil {
			lastErr = err
			continue
		}

		body, err := io.ReadAll(io.LimitReader(resp.Body, 10<<20)) // 10MB limit
		resp.Body.Close()
		if err != nil {
			lastErr = err
			continue
		}

		var alphaResp AlphaResponse
		if err := json.Unmarshal(body, &alphaResp); err != nil {
			lastErr = fmt.Errorf("decode: %w", err)
			continue
		}

		if alphaResp.Code == "000000" {
			return alphaResp.Data, nil
		}

		lastErr = fmt.Errorf("alpha api error: code=%s", alphaResp.Code)
		if resp.StatusCode < 500 && resp.StatusCode != 429 {
			break // don't retry client errors
		}
	}

	return nil, fmt.Errorf("binance alpha request failed after retries: %w", lastErr)
}

// FetchTokens retrieves the full token catalogue from Binance Alpha (BSC only).
func (c *Client) FetchTokens(ctx context.Context) ([]TokenInfo, error) {
	data, err := c.doGet(ctx, "/public/wallet-direct/buw/wallet/cex/alpha/all/token/list", nil)
	if err != nil {
		return nil, err
	}

	var raw []map[string]interface{}
	if err := json.Unmarshal(data, &raw); err != nil {
		return nil, fmt.Errorf("decode token list: %w", err)
	}

	var tokens []TokenInfo
	for _, row := range raw {
		chainID, _ := row["chainId"].(string)
		if chainID != "56" { // BSC only
			continue
		}
		addr, _ := row["contractAddress"].(string)
		if addr == "" || len(addr) < 10 {
			continue
		}

		t := TokenInfo{
			AlphaID:         strVal(row, "alphaId"),
			Symbol:          strVal(row, "symbol"),
			Name:            strVal(row, "name"),
			ChainID:         chainID,
			ContractAddress: addr,
		}
		if t.Symbol == "" {
			t.Symbol = t.AlphaID
		}
		tokens = append(tokens, t)
	}

	return tokens, nil
}

// FetchTicker retrieves the current ticker for a symbol.
func (c *Client) FetchTicker(ctx context.Context, symbol string) (*TickerData, error) {
	data, err := c.doGet(ctx, "/public/alpha-trade/ticker", map[string]string{"symbol": symbol})
	if err != nil {
		return nil, err
	}

	var ticker TickerData
	if err := json.Unmarshal(data, &ticker); err != nil {
		return nil, fmt.Errorf("decode ticker: %w", err)
	}
	return &ticker, nil
}

// FetchKlines retrieves historical candles for a symbol.
func (c *Client) FetchKlines(ctx context.Context, symbol, interval string, limit int) ([]KlineBar, error) {
	if limit < 1 {
		limit = 500
	}
	if limit > 1500 {
		limit = 1500
	}

	data, err := c.doGet(ctx, "/public/alpha-trade/klines", map[string]string{
		"symbol":   symbol,
		"interval": interval,
		"limit":    fmt.Sprintf("%d", limit),
	})
	if err != nil {
		return nil, err
	}

	// The API returns a JSON array of arrays
	var raw [][]interface{}
	if err := json.Unmarshal(data, &raw); err != nil {
		return nil, fmt.Errorf("decode klines: %w", err)
	}

	var klines []KlineBar
	for _, row := range raw {
		if len(row) < 7 {
			continue
		}
		klines = append(klines, KlineBar{
			OpenTime:  toInt64(row[0]),
			Open:      toFloat64(row[1]),
			High:      toFloat64(row[2]),
			Low:       toFloat64(row[3]),
			Close:     toFloat64(row[4]),
			Volume:    toFloat64(row[5]),
			CloseTime: toInt64(row[6]),
		})
	}

	return klines, nil
}

// --- helpers ---

func strVal(m map[string]interface{}, key string) string {
	if v, ok := m[key].(string); ok {
		return v
	}
	return ""
}

func toFloat64(v interface{}) float64 {
	switch val := v.(type) {
	case float64:
		return val
	case string:
		var f float64
		fmt.Sscanf(val, "%f", &f)
		return f
	case json.Number:
		f, _ := val.Float64()
		return f
	}
	return 0
}

func toInt64(v interface{}) int64 {
	switch val := v.(type) {
	case float64:
		return int64(val)
	case string:
		var i int64
		fmt.Sscanf(val, "%d", &i)
		return i
	case json.Number:
		i, _ := val.Int64()
		return i
	}
	return 0
}
