package api

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"time"
)

const okxDexBase = "https://web3.okx.com"

// okxDexClient makes authenticated requests to the OKX DEX aggregator API.
type okxDexClient struct {
	apiKey     string
	secretKey  string
	passphrase string
	httpClient *http.Client
}

func newOKXDexClient(apiKey, secretKey, passphrase string) *okxDexClient {
	return &okxDexClient{
		apiKey:     apiKey,
		secretKey:  secretKey,
		passphrase: passphrase,
		httpClient: &http.Client{Timeout: 15 * time.Second},
	}
}

func (c *okxDexClient) sign(method, path, queryString string) (string, string) {
	timestamp := time.Now().UTC().Format("2006-01-02T15:04:05.000") + "Z"
	prehash := timestamp + method + path + queryString
	mac := hmac.New(sha256.New, []byte(c.secretKey))
	mac.Write([]byte(prehash))
	return timestamp, base64.StdEncoding.EncodeToString(mac.Sum(nil))
}

// quote requests a swap quote from token→USDC via the OKX DEX aggregator.
// Returns the USD price per whole token.
func (c *okxDexClient) quote(ctx context.Context, chainID, tokenAddr, usdcAddr string) (float64, error) {
	path := "/api/v5/dex/aggregator/quote"
	params := url.Values{}
	params.Set("chainId", chainID)
	params.Set("fromTokenAddress", tokenAddr)
	params.Set("toTokenAddress", usdcAddr)
	params.Set("amount", "1000000000000000000") // 1 token in wei
	params.Set("slippage", "0.01")

	queryString := "?" + params.Encode()
	timestamp, signature := c.sign("GET", path, queryString)

	fullURL := okxDexBase + path + queryString
	req, err := http.NewRequestWithContext(ctx, "GET", fullURL, nil)
	if err != nil {
		return 0, err
	}
	req.Header.Set("OK-ACCESS-KEY", c.apiKey)
	req.Header.Set("OK-ACCESS-SIGN", signature)
	req.Header.Set("OK-ACCESS-TIMESTAMP", timestamp)
	req.Header.Set("OK-ACCESS-PASSPHRASE", c.passphrase)
	req.Header.Set("Accept", "application/json")

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()

	if resp.StatusCode >= 400 {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 1000))
		return 0, fmt.Errorf("okx dex http %d: %s", resp.StatusCode, string(body))
	}

	var result struct {
		Code string `json:"code"`
		Data []struct {
			ToTokenAmount string `json:"toTokenAmount"`
			ToToken       struct {
				Decimals string `json:"tokenDecimal"`
			} `json:"toToken"`
		} `json:"data"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return 0, err
	}
	if result.Code != "0" || len(result.Data) == 0 {
		return 0, fmt.Errorf("okx dex no quote")
	}

	return parseFloat(result.Data[0].ToTokenAmount) / 1e6, nil // USDC has 6 decimals → USD
}

// USDC addresses per chain (used as quote currency for price discovery).
var usdcAddrs = map[string]string{
	"1":     "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", // Ethereum
	"56":    "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d", // BSC
	"8453":  "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", // Base
	"42161": "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", // Arbitrum
	"137":   "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359", // Polygon
	"10":    "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85", // Optimism
	"43114": "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E", // Avalanche
}

// numericChain maps our chain names to OKX numeric chain IDs.
var numericChain = map[string]string{
	"ethereum": "1", "bsc": "56", "base": "8453",
	"arbitrum": "42161", "polygon": "137",
	"optimism": "10", "avalanche": "43114",
}

func parseFloat(s string) float64 {
	var f float64
	fmt.Sscanf(s, "%f", &f)
	return f
}
