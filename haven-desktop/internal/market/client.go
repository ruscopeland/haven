// Package market provides Binance Alpha market data integration.
// Token catalogue comes from the BAPI endpoint. Ticker and klines use the
// official SAPI endpoints with alpha_{number} symbol format.
//
// Docs: https://developers.binance.com/en/docs/catalog/advanced-trading-alpha-trading/api/rest-api/market-data
package market

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

const bapiBase = "https://www.binance.com/bapi/defi/v1"

// Client handles HTTP requests to Binance Alpha's API.
type Client struct {
	httpClient *http.Client
}

// NewClient creates a Binance Alpha client.
func NewClient() *Client {
	return &Client{
		httpClient: &http.Client{Timeout: 30 * time.Second},
	}
}

// TokenInfo represents a token from the Binance Alpha catalogue.
type TokenInfo struct {
	AlphaID         string  `json:"alpha_id"`
	Symbol          string  `json:"symbol"`
	Name            string  `json:"name"`
	ChainID         string  `json:"chain_id"`
	ContractAddress string  `json:"contract_address"`
	Price           float64 `json:"price"`
	PriceChange24h  float64 `json:"price_change_24h"`
	Volume24h       float64 `json:"volume_24h"`
	MarketCap       float64 `json:"market_cap"`
}

// TickerData holds current ticker information from the BAPI endpoint.
type TickerData struct {
	Symbol             string `json:"symbol"`
	PriceChange        string `json:"priceChange"`
	PriceChangePercent string `json:"priceChangePercent"`
	LastPrice          string `json:"lastPrice"`
	HighPrice          string `json:"highPrice"`
	LowPrice           string `json:"lowPrice"`
	Volume             string `json:"volume"`
	QuoteVolume        string `json:"quoteVolume"`
}

// KlineBar is a single OHLCV candle.
// Response format: [openTime, open, high, low, close, volume, closeTime, quoteVol, trades, takerBuyBase, takerBuyQuote, ignore]
type KlineBar struct {
	OpenTime  int64
	Open      float64
	High      float64
	Low       float64
	Close     float64
	Volume    float64
	CloseTime int64
}

// --- BAPI helpers (token list, ticker, klines all use the BAPI endpoint) ---

type bapiResponse struct {
	Data json.RawMessage `json:"data"`
	Code string          `json:"code"`
}

func (c *Client) bapiGet(ctx context.Context, path string) (json.RawMessage, error) {
	url := bapiBase + path
	return c.doRequest(ctx, url)
}

// --- Generic HTTP ---

func (c *Client) doRequest(ctx context.Context, url string) (json.RawMessage, error) {
	var lastErr error
	for attempt := 0; attempt < 3; attempt++ {
		if attempt > 0 {
			time.Sleep(time.Duration(500*(1<<attempt)) * time.Millisecond)
		}

		req, err := http.NewRequestWithContext(ctx, "GET", url, nil)
		if err != nil {
			return nil, err
		}
		req.Header.Set("User-Agent", "Haven-Desktop/1.0")
		req.Header.Set("Accept", "application/json")

		resp, err := c.httpClient.Do(req)
		if err != nil {
			lastErr = err
			continue
		}

		body, err := io.ReadAll(io.LimitReader(resp.Body, 10<<20))
		resp.Body.Close()
		if err != nil {
			lastErr = err
			continue
		}

		var bapiResp bapiResponse
		if err := json.Unmarshal(body, &bapiResp); err != nil {
			lastErr = fmt.Errorf("decode: %w", err)
			continue
		}
		if bapiResp.Code == "000000" {
			return bapiResp.Data, nil
		}
		lastErr = fmt.Errorf("bapi error: code=%s", bapiResp.Code)

		if resp.StatusCode < 500 && resp.StatusCode != 429 {
			break
		}
	}
	return nil, fmt.Errorf("request failed: %w", lastErr)
}

// --- Public API ---

// FetchTokens retrieves the token catalogue (BAPI endpoint).
func (c *Client) FetchTokens(ctx context.Context) ([]TokenInfo, error) {
	data, err := c.bapiGet(ctx, "/public/wallet-direct/buw/wallet/cex/alpha/all/token/list")
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
		if chainID != "56" {
			continue
		}
		addr, _ := row["contractAddress"].(string)
		if addr == "" || len(addr) < 10 {
			continue
		}

		alphaID := strVal(row, "alphaId")
		t := TokenInfo{
			AlphaID:         alphaID,
			Symbol:          strVal(row, "symbol"),
			Name:            strVal(row, "name"),
			ChainID:         chainID,
			ContractAddress: addr,
		}
		if t.Symbol == "" {
			t.Symbol = alphaID
		}
		tokens = append(tokens, t)
	}
	return tokens, nil
}

// FetchTicker retrieves the 24hr ticker using {alphaId}USDT format (BAPI).
func (c *Client) FetchTicker(ctx context.Context, alphaID string) (*TickerData, error) {
	symbol := alphaID + "USDT"
	path := fmt.Sprintf("/public/alpha-trade/ticker?symbol=%s", symbol)

	body, err := c.bapiGet(ctx, path)
	if err != nil {
		return nil, err
	}

	var ticker TickerData
	if err := json.Unmarshal(body, &ticker); err != nil {
		return nil, fmt.Errorf("decode ticker: %w", err)
	}
	return &ticker, nil
}

// FetchKlines retrieves historical candles using {alphaId}USDT format (BAPI).
func (c *Client) FetchKlines(ctx context.Context, alphaID, interval string, limit int) ([]KlineBar, error) {
	if limit < 1 {
		limit = 500
	}
	if limit > 1500 {
		limit = 1500
	}

	symbol := alphaID + "USDT"
	path := fmt.Sprintf("/public/alpha-trade/klines?symbol=%s&interval=%s&limit=%d",
		symbol, interval, limit)

	body, err := c.bapiGet(ctx, path)
	if err != nil {
		return nil, err
	}

	// Response is [[openTime, open, high, low, close, volume, closeTime, ...], ...]
	var raw [][]interface{}
	if err := json.Unmarshal(body, &raw); err != nil {
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
		return strings.TrimSpace(v)
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
