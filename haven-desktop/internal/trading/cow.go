package trading

import (
	"bytes"
	"context"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/ethereum/go-ethereum/common/math"
	"github.com/ethereum/go-ethereum/signer/core/apitypes"
)

const CowDomainName = "Gnosis Protocol"
const CowDomainVersion = "v2"
const CowVerifyingContract = "0x9008D19f58AAbD9eD0D60971565AA8510560ab41"
const CowVaultRelayer = "0xC92E8bdf79f0507f65a392b0ab4667716BFE0110"
const AppDataHash = "0x0000000000000000000000000000000000000000000000000000000000000000" // minimal empty appData for simplicity

var cowOrderTypes = apitypes.Types{
	"EIP712Domain": []apitypes.Type{
		{Name: "name", Type: "string"},
		{Name: "version", Type: "string"},
		{Name: "chainId", Type: "uint256"},
		{Name: "verifyingContract", Type: "address"},
	},
	"Order": []apitypes.Type{
		{Name: "sellToken", Type: "address"},
		{Name: "buyToken", Type: "address"},
		{Name: "receiver", Type: "address"},
		{Name: "sellAmount", Type: "uint256"},
		{Name: "buyAmount", Type: "uint256"},
		{Name: "validTo", Type: "uint32"},
		{Name: "appData", Type: "bytes32"},
		{Name: "feeAmount", Type: "uint256"},
		{Name: "kind", Type: "string"},
		{Name: "partiallyFillable", Type: "bool"},
		{Name: "sellTokenBalance", Type: "string"},
		{Name: "buyTokenBalance", Type: "string"},
	},
}

type CowClient struct {
	BaseURL    string
	HTTPClient *http.Client
}

func NewCowClient(chainID int64) *CowClient {
	var baseUrl string
	switch chainID {
	case 1:
		baseUrl = "https://api.cow.fi/mainnet/api/v1"
	case 56:
		baseUrl = "https://api.cow.fi/bnb/api/v1"
	case 100:
		baseUrl = "https://api.cow.fi/xdai/api/v1"
	case 8453:
		baseUrl = "https://api.cow.fi/base/api/v1"
	case 42161:
		baseUrl = "https://api.cow.fi/arbitrum_one/api/v1"
	default:
		baseUrl = "https://api.cow.fi/mainnet/api/v1"
	}
	return &CowClient{
		BaseURL: baseUrl,
		HTTPClient: &http.Client{
			Timeout: 10 * time.Second,
			Transport: &http.Transport{
				// Disable HTTP/2 to prevent Cloudflare/WAF from blocking the Go HTTP/2 fingerprint
				TLSNextProto: make(map[string]func(authority string, c *tls.Conn) http.RoundTripper),
			},
		},
	}
}

type CowQuoteRequest struct {
	Kind                string `json:"kind"`
	SellToken           string `json:"sellToken"`
	BuyToken            string `json:"buyToken"`
	SellAmountBeforeFee string `json:"sellAmountBeforeFee,omitempty"`
	BuyAmountAfterFee   string `json:"buyAmountAfterFee,omitempty"`
	From                string `json:"from"`
	Receiver            string `json:"receiver"`
	ValidFor            uint32 `json:"validFor"`
}

type CowQuoteResponse struct {
	Quote struct {
		SellAmount string `json:"sellAmount"`
		BuyAmount  string `json:"buyAmount"`
		FeeAmount  string `json:"feeAmount"`
		Kind       string `json:"kind"`
	} `json:"quote"`
	ProtocolFeeBps string `json:"protocolFeeBps,omitempty"`
}

func (c *CowClient) GetQuote(ctx context.Context, req CowQuoteRequest) (*CowQuoteResponse, error) {
	body, err := json.Marshal(req)
	if err != nil {
		return nil, err
	}
	httpReq, err := http.NewRequestWithContext(ctx, "POST", c.BaseURL+"/quote", bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")

	var resp *http.Response
	var respBody []byte
	var lastErr error

	for attempt := 0; attempt < 3; attempt++ {
		// Need to reset the body reader for each attempt
		httpReq.Body = io.NopCloser(bytes.NewReader(body))
		
		resp, err = c.HTTPClient.Do(httpReq)
		if err != nil {
			lastErr = err
			time.Sleep(time.Duration(attempt+1) * 2 * time.Second)
			continue
		}

		respBody, _ = io.ReadAll(resp.Body)
		resp.Body.Close()

		if resp.StatusCode == 429 {
			lastErr = fmt.Errorf("quote failed: 429 - %s", string(respBody))
			time.Sleep(time.Duration(attempt+1) * 2 * time.Second)
			continue
		}

		if resp.StatusCode != 200 {
			return nil, fmt.Errorf("quote failed: %d - %s", resp.StatusCode, string(respBody))
		}

		var parsed CowQuoteResponse
		if err := json.Unmarshal(respBody, &parsed); err != nil {
			return nil, err
		}
		return &parsed, nil
	}

	return nil, lastErr
}

type CowOrderRequest struct {
	SellToken         string `json:"sellToken"`
	BuyToken          string `json:"buyToken"`
	Receiver          string `json:"receiver"`
	SellAmount        string `json:"sellAmount"`
	BuyAmount         string `json:"buyAmount"`
	ValidTo           uint32 `json:"validTo"`
	AppData           string `json:"appData"`
	FeeAmount         string `json:"feeAmount"`
	Kind              string `json:"kind"`
	PartiallyFillable bool   `json:"partiallyFillable"`
	SellTokenBalance  string `json:"sellTokenBalance"`
	BuyTokenBalance   string `json:"buyTokenBalance"`
	SigningScheme     string `json:"signingScheme"`
	Signature         string `json:"signature"`
	From              string `json:"from"`
}

func (c *CowClient) SubmitOrder(ctx context.Context, order CowOrderRequest) (string, error) {
	body, err := json.Marshal(order)
	if err != nil {
		return "", err
	}
	httpReq, err := http.NewRequestWithContext(ctx, "POST", c.BaseURL+"/orders", bytes.NewReader(body))
	if err != nil {
		return "", err
	}
	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")

	var resp *http.Response
	var respBody []byte
	var lastErr error

	for attempt := 0; attempt < 3; attempt++ {
		httpReq.Body = io.NopCloser(bytes.NewReader(body))
		
		resp, err = c.HTTPClient.Do(httpReq)
		if err != nil {
			lastErr = err
			time.Sleep(time.Duration(attempt+1) * 2 * time.Second)
			continue
		}

		respBody, _ = io.ReadAll(resp.Body)
		resp.Body.Close()

		if resp.StatusCode == 429 {
			lastErr = fmt.Errorf("order submission failed: 429 - %s", string(respBody))
			time.Sleep(time.Duration(attempt+1) * 2 * time.Second)
			continue
		}

		if resp.StatusCode != 201 && resp.StatusCode != 200 {
			return "", fmt.Errorf("order submission failed: %d - %s", resp.StatusCode, string(respBody))
		}

		var parsed string
		if err := json.Unmarshal(respBody, &parsed); err != nil {
			return strings.Trim(string(respBody), "\""), nil
		}
		return parsed, nil
	}

	return "", lastErr
}

// GenerateEIP712Data constructs the typed data for an order.
func GenerateEIP712Data(chainID int64, order CowOrderRequest) apitypes.TypedData {
	message := map[string]interface{}{
		"sellToken":         order.SellToken,
		"buyToken":          order.BuyToken,
		"receiver":          order.Receiver,
		"sellAmount":        math.MustParseBig256(order.SellAmount),
		"buyAmount":         math.MustParseBig256(order.BuyAmount),
		"validTo":           math.NewHexOrDecimal256(int64(order.ValidTo)),
		"appData":           []byte(commonHexToBytes(order.AppData)),
		"feeAmount":         math.MustParseBig256(order.FeeAmount),
		"kind":              order.Kind,
		"partiallyFillable": order.PartiallyFillable,
		"sellTokenBalance":  order.SellTokenBalance,
		"buyTokenBalance":   order.BuyTokenBalance,
	}

	return apitypes.TypedData{
		Types:       cowOrderTypes,
		PrimaryType: "Order",
		Domain: apitypes.TypedDataDomain{
			Name:              CowDomainName,
			Version:           CowDomainVersion,
			ChainId:           math.NewHexOrDecimal256(chainID),
			VerifyingContract: CowVerifyingContract,
		},
		Message: message,
	}
}

func commonHexToBytes(s string) []byte {
	s = strings.TrimPrefix(s, "0x")
	b := make([]byte, len(s)/2)
	for i := 0; i < len(s); i += 2 {
		fmt.Sscanf(s[i:i+2], "%x", &b[i/2])
	}
	return b
}
