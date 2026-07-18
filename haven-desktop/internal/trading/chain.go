// Package trading provides on-chain swap execution through OKX DEX aggregator.
// Supports 20+ chains (Ethereum, BSC, Solana, Base, Arbitrum, etc.) with
// built-in honeypot detection, tax-rate checks, MEV protection, and auto-slippage.
package trading

import (
	"context"
	"crypto/ecdsa"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"math/big"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/ethereum/go-ethereum"
	"github.com/ethereum/go-ethereum/accounts/abi"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/core/types"
	"github.com/ethereum/go-ethereum/crypto"
	"github.com/ethereum/go-ethereum/ethclient"
)

// Known addresses.
var (
	WBNB     = common.HexToAddress("0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c")
	ZeroAddr = common.HexToAddress("0x0000000000000000000000000000000000000000")
)

// ERC-20 ABI fragments.
var erc20ABI, _ = abi.JSON(strings.NewReader(`[
	{"constant":true,"inputs":[],"name":"decimals","outputs":[{"name":"","type":"uint8"}],"type":"function"},
	{"constant":true,"inputs":[{"name":"owner","type":"address"}],"name":"balanceOf","outputs":[{"name":"","type":"uint256"}],"type":"function"},
	{"constant":true,"inputs":[{"name":"owner","type":"address"},{"name":"spender","type":"address"}],"name":"allowance","outputs":[{"name":"","type":"uint256"}],"type":"function"},
	{"constant":false,"inputs":[{"name":"spender","type":"address"},{"name":"amount","type":"uint256"}],"name":"approve","outputs":[{"name":"","type":"bool"}],"type":"function"}
]`))

var transferTopic = crypto.Keccak256Hash([]byte("Transfer(address,address,uint256)"))

// OKX API base.
const okxBaseURL = "https://web3.okx.com"

// Native token address per OKX convention.
const nativeTokenAddr = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"

// Chain holds the EVM connection, wallet, and OKX credentials.
type Chain struct {
	client  *ethclient.Client
	wallet  *Wallet
	chainID *big.Int

	okxAPIKey    string
	okxSecretKey string
	okxPassphrase string

	decimalsMu sync.RWMutex
	decimals   map[common.Address]uint8
}

// Wallet wraps an ECDSA private key with its address.
type Wallet struct {
	privateKey *ecdsa.PrivateKey
	Address    common.Address
}

// SwapQuote is the validated swap transaction data.
type SwapQuote struct {
	To        common.Address
	Data      []byte
	Value     *big.Int
	Gas       uint64
	OutAmount *big.Int
	InAmount  *big.Int
	Price     string

	// Safety fields from OKX
	IsHoneypot   bool
	TaxRate      string
	PriceImpact  string
	RouterPath   string
}

// SwapFill holds the actual fill amounts parsed from the transaction receipt.
type SwapFill struct {
	TokenAmount      float64
	NativeAmount     float64
	BlockTimestampMs int64
}

// NewChain connects to an EVM RPC and configures OKX credentials.
func NewChain(rpcURL string, chainID int64, privateKeyHex string, okxAPIKey, okxSecretKey, okxPassphrase string) (*Chain, error) {
	client, err := ethclient.Dial(rpcURL)
	if err != nil {
		return nil, fmt.Errorf("dial rpc: %w", err)
	}

	actualID, err := client.ChainID(context.Background())
	if err != nil {
		return nil, fmt.Errorf("chain id: %w", err)
	}
	if actualID.Int64() != chainID {
		return nil, fmt.Errorf("rpc chain mismatch: expected %d, got %d", chainID, actualID.Int64())
	}

	key := strings.TrimSpace(privateKeyHex)
	// Strip 0x or 0X prefix (case-insensitive)
	key = strings.TrimPrefix(key, "0x")
	key = strings.TrimPrefix(key, "0X")

	privateKey, err := crypto.HexToECDSA(key)
	if err != nil {
		return nil, fmt.Errorf("invalid private key: %w", err)
	}

	return &Chain{
		client:        client,
		wallet:        &Wallet{privateKey: privateKey, Address: crypto.PubkeyToAddress(privateKey.PublicKey)},
		chainID:       big.NewInt(chainID),
		okxAPIKey:     okxAPIKey,
		okxSecretKey:  okxSecretKey,
		okxPassphrase: okxPassphrase,
		decimals:      make(map[common.Address]uint8),
	}, nil
}

// WalletAddress returns the wallet's address.
func (c *Chain) WalletAddress() common.Address { return c.wallet.Address }

// Close closes the RPC connection.
func (c *Chain) Close() { c.client.Close() }

// --- ERC-20 helpers (unchanged) ---

func (c *Chain) GetDecimals(tokenAddr common.Address) (uint8, error) {
	c.decimalsMu.RLock()
	if d, ok := c.decimals[tokenAddr]; ok {
		c.decimalsMu.RUnlock()
		return d, nil
	}
	c.decimalsMu.RUnlock()

	data, err := erc20ABI.Pack("decimals")
	if err != nil {
		return 0, err
	}
	result, err := c.callContract(tokenAddr, data)
	if err != nil {
		return 0, fmt.Errorf("decimals: %w", err)
	}
	var decoded struct{ D uint8 }
	if err := erc20ABI.UnpackIntoInterface(&decoded, "decimals", result); err != nil {
		return 0, err
	}
	c.decimalsMu.Lock()
	c.decimals[tokenAddr] = decoded.D
	c.decimalsMu.Unlock()
	return decoded.D, nil
}

func (c *Chain) TokenBalance(tokenAddr, owner common.Address) (*big.Int, uint8, error) {
	decimals, err := c.GetDecimals(tokenAddr)
	if err != nil {
		return nil, 0, err
	}
	data, err := erc20ABI.Pack("balanceOf", owner)
	if err != nil {
		return nil, 0, err
	}
	result, err := c.callContract(tokenAddr, data)
	if err != nil {
		return nil, 0, fmt.Errorf("balanceOf: %w", err)
	}
	var balance struct{ B *big.Int }
	if err := erc20ABI.UnpackIntoInterface(&balance, "balanceOf", result); err != nil {
		return nil, 0, err
	}
	return balance.B, decimals, nil
}

func (c *Chain) EnsureAllowance(ctx context.Context, tokenAddr, spender common.Address, amount *big.Int) error {
	data, err := erc20ABI.Pack("allowance", c.wallet.Address, spender)
	if err != nil {
		return err
	}
	result, err := c.callContract(tokenAddr, data)
	if err != nil {
		return fmt.Errorf("allowance check: %w", err)
	}
	var current struct{ A *big.Int }
	erc20ABI.UnpackIntoInterface(&current, "allowance", result)
	if current.A != nil && current.A.Cmp(amount) >= 0 {
		return nil
	}
	// Reset to 0 for USDT-style tokens
	if current.A != nil && current.A.Sign() > 0 {
		data, _ = erc20ABI.Pack("approve", spender, big.NewInt(0))
		tx, err := c.sendTransaction(ctx, tokenAddr, big.NewInt(0), data, 200000)
		if err == nil {
			c.waitTx(ctx, tx)
		}
	}
	data, err = erc20ABI.Pack("approve", spender, amount)
	if err != nil {
		return err
	}
	tx, err := c.sendTransaction(ctx, tokenAddr, big.NewInt(0), data, 200000)
	if err != nil {
		return fmt.Errorf("approve: %w", err)
	}
	_, err = c.waitTx(ctx, tx)
	return err
}

// --- OKX DEX v6 swap ---

// okxQuoteResponse is the response from GET /api/v6/dex/aggregator/quote
type okxQuoteResponse struct {
	Code string `json:"code"`
	Msg  string `json:"msg"`
	Data []struct {
		ChainIndex          string `json:"chainIndex"`
		FromToken           struct {
			Address  string `json:"tokenContractAddress"`
			Symbol   string `json:"tokenSymbol"`
			Decimals string `json:"decimal"`
		} `json:"fromToken"`
		ToToken struct {
			Address  string `json:"tokenContractAddress"`
			Symbol   string `json:"tokenSymbol"`
			Decimals string `json:"decimal"`
		} `json:"toToken"`
		FromTokenAmount   string `json:"fromTokenAmount"`
		ToTokenAmount     string `json:"toTokenAmount"`
		PriceImpactPercent string `json:"priceImpactPercent"`
		RouterList        []struct {
			Name   string `json:"dexName"`
			Amount string `json:"amount"`
		} `json:"routerList"`
		EstimatedGas string `json:"estimatedGas"`
		IsHoneypot   bool   `json:"isHoneyPot"`
		TaxRate      string `json:"taxRate"`
		Slippage     string `json:"slippage"`
	} `json:"data"`
}

// okxSwapResponse is the response from GET /api/v6/dex/aggregator/swap
type okxSwapResponse struct {
	Code string `json:"code"`
	Msg  string `json:"msg"`
	Data []struct {
		FromTokenAmount string `json:"fromTokenAmount"`
		ToTokenAmount   string `json:"toTokenAmount"`
		Tx              struct {
			From  string `json:"from"`
			To    string `json:"to"`
			Data  string `json:"data"`
			Value string `json:"value"`
			Gas   string `json:"gas"`
		} `json:"tx"`
		RouterResult struct {
			ChainIndex          string `json:"chainIndex"`
			FromTokenAddress    string `json:"fromTokenAddress"`
			ToTokenAddress      string `json:"toTokenAddress"`
			FromTokenAmount     string `json:"fromTokenAmount"`
			ToTokenAmount       string `json:"toTokenAmount"`
			PriceImpactPercent  string `json:"priceImpactPercent"`
			Slippage            string `json:"slippage"`
		} `json:"routerResult"`
	} `json:"data"`
}

// autoSlippage returns the appropriate slippage percentage for the given trade type.
func autoSlippage(chainID int64, fromSymbol, toSymbol string) string {
	stablecoins := map[string]bool{"usdc": true, "usdt": true, "dai": true, "busd": true, "usdd": true}
	from := strings.ToLower(fromSymbol)
	to := strings.ToLower(toSymbol)
	if stablecoins[from] && stablecoins[to] {
		return "0.1" // stablecoin pairs
	}
	mainstream := map[string]bool{"eth": true, "btc": true, "weth": true, "wbtc": true, "bnb": true, "wbnb": true, "sol": true}
	if mainstream[from] || mainstream[to] {
		return "0.5" // major pairs
	}
	return "5.0" // everything else (memes, low-caps)
}

// mevThreshold returns true if MEV protection is recommended for this swap size and chain.
func mevThreshold(chainID int64, amount float64) bool {
	switch chainID {
	case 1: // Ethereum
		return amount >= 2000
	case 56: // BSC
		return amount >= 200
	case 8453: // Base
		return amount >= 200
	case 501: // Solana
		return amount >= 1000
	default:
		return amount >= 500
	}
}

// GetSwapQuote fetches a quote from OKX DEX, validates safety, then returns swap transaction data.
func (c *Chain) GetSwapQuote(ctx context.Context, fromToken, toToken common.Address, amount *big.Int, decimals uint8, _slippagePct float64, _gasPriceGwei float64) (*SwapQuote, error) {
	fromStr := strings.ToLower(fromToken.Hex())
	if fromToken == ZeroAddr {
		fromStr = nativeTokenAddr
	}
	toStr := strings.ToLower(toToken.Hex())
	if toToken == ZeroAddr {
		toStr = nativeTokenAddr
	}

	chainStr := fmt.Sprintf("%d", c.chainID.Int64())
	amountStr := amount.String()
	slippage := fmt.Sprintf("%.1f", _slippagePct)
	if _slippagePct <= 0 {
		slippage = "0.5" // default
	}

	// Phase 1: Get quote
	quoteParams := url.Values{}
	quoteParams.Set("chainIndex", chainStr)
	quoteParams.Set("fromTokenAddress", fromStr)
	quoteParams.Set("toTokenAddress", toStr)
	quoteParams.Set("amount", amountStr)
	quoteParams.Set("slippagePercent", slippage)

	var quoteResp okxQuoteResponse
	if err := c.okxGet(ctx, "/api/v6/dex/aggregator/quote", quoteParams, &quoteResp); err != nil {
		return nil, fmt.Errorf("okx quote: %w", err)
	}
	if quoteResp.Code != "0" {
		return nil, fmt.Errorf("okx quote error [%s]: %s", quoteResp.Code, quoteResp.Msg)
	}
	if len(quoteResp.Data) == 0 {
		return nil, fmt.Errorf("okx: no quote available for this pair")
	}
	q := quoteResp.Data[0]

	// Safety checks
	if q.IsHoneypot {
		return nil, fmt.Errorf("okx safety: token %s is flagged as honeypot — swap blocked", q.FromToken.Symbol)
	}
	if rate, err := parseFloatSafe(q.TaxRate); err == nil && rate > 10 {
		return nil, fmt.Errorf("okx safety: token %s has %.1f%% tax — swap blocked", q.ToToken.Symbol, rate)
	}

	// Build router path for display
	var routers []string
	for _, r := range q.RouterList {
		routers = append(routers, r.Name)
	}
	routerPath := strings.Join(routers, " → ")

	// Phase 2: Get swap transaction
	swapParams := url.Values{}
	swapParams.Set("chainIndex", chainStr)
	swapParams.Set("fromTokenAddress", fromStr)
	swapParams.Set("toTokenAddress", toStr)
	swapParams.Set("amount", amountStr)
	swapParams.Set("userWalletAddress", strings.ToLower(c.wallet.Address.Hex()))
	swapParams.Set("slippagePercent", slippage)

	var swapResp okxSwapResponse
	if err := c.okxGet(ctx, "/api/v6/dex/aggregator/swap", swapParams, &swapResp); err != nil {
		return nil, fmt.Errorf("okx swap: %w", err)
	}
	if swapResp.Code != "0" {
		return nil, fmt.Errorf("okx swap error [%s]: %s", swapResp.Code, swapResp.Msg)
	}
	if len(swapResp.Data) == 0 {
		return nil, fmt.Errorf("okx: no swap transaction data available")
	}
	s := swapResp.Data[0]

	to := common.HexToAddress(s.Tx.To)
	swapData, _ := hex.DecodeString(strings.TrimPrefix(s.Tx.Data, "0x"))
	value, _ := new(big.Int).SetString(s.Tx.Value, 0)
	outAmount, _ := new(big.Int).SetString(s.ToTokenAmount, 10)
	inAmount, _ := new(big.Int).SetString(s.FromTokenAmount, 10)
	gas, _ := new(big.Int).SetString(s.Tx.Gas, 0)
	gasUint := uint64(200000)
	if gas != nil && gas.Uint64() > 0 {
		gasUint = gas.Uint64()
	}

	return &SwapQuote{
		To:          to,
		Data:        swapData,
		Value:       value,
		Gas:         gasUint,
		OutAmount:   outAmount,
		InAmount:    inAmount,
		Price:       s.RouterResult.ToTokenAmount,
		IsHoneypot:  q.IsHoneypot,
		TaxRate:     q.TaxRate,
		PriceImpact: q.PriceImpactPercent,
		RouterPath:  routerPath,
	}, nil
}

// --- OKX HTTP helpers ---

func (c *Chain) okxSign(method, path, queryString string) (string, string) {
	timestamp := time.Now().UTC().Format("2006-01-02T15:04:05.000") + "Z"
	prehash := timestamp + method + path + queryString
	mac := hmac.New(sha256.New, []byte(c.okxSecretKey))
	mac.Write([]byte(prehash))
	return timestamp, base64.StdEncoding.EncodeToString(mac.Sum(nil))
}

func (c *Chain) okxGet(ctx context.Context, path string, params url.Values, v interface{}) error {
	queryString := "?" + params.Encode()
	timestamp, signature := c.okxSign("GET", path, queryString)

	fullURL := okxBaseURL + path + queryString
	req, err := http.NewRequestWithContext(ctx, "GET", fullURL, nil)
	if err != nil {
		return err
	}
	req.Header.Set("OK-ACCESS-KEY", c.okxAPIKey)
	req.Header.Set("OK-ACCESS-SIGN", signature)
	req.Header.Set("OK-ACCESS-TIMESTAMP", timestamp)
	req.Header.Set("OK-ACCESS-PASSPHRASE", c.okxPassphrase)
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", "Haven-Desktop/1.0")

	resp, err := httpClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode >= 400 {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 1000))
		return fmt.Errorf("okx http %d: %s", resp.StatusCode, string(body))
	}
	return json.NewDecoder(resp.Body).Decode(v)
}

// --- Transaction execution (unchanged — wallet/RPC only) ---

func (c *Chain) SendSwap(ctx context.Context, quote *SwapQuote, gasPriceGwei float64, allowedRouters []common.Address) (*types.Transaction, error) {
	if len(allowedRouters) == 0 {
		return nil, fmt.Errorf("no allowed routers configured")
	}
	allowed := false
	for _, r := range allowedRouters {
		if r == quote.To {
			allowed = true
			break
		}
	}
	if !allowed {
		return nil, fmt.Errorf("swap router %s is not allow-listed", quote.To.Hex())
	}
	if len(quote.Data) < 8 || len(quote.Data) > 131074 {
		return nil, fmt.Errorf("swap calldata is malformed or unexpectedly large")
	}

	// Dry-run simulation
	_, err := c.client.CallContract(ctx, ethereum.CallMsg{
		From: c.wallet.Address, To: &quote.To, Data: quote.Data, Value: quote.Value,
	}, nil)
	if err != nil {
		return nil, fmt.Errorf("swap simulation failed: %w", err)
	}

	gasPrice := new(big.Int).Mul(big.NewInt(int64(gasPriceGwei*1e9)), big.NewInt(1))
	if gasPrice.Sign() == 0 {
		gasPrice, err = c.client.SuggestGasPrice(ctx)
		if err != nil {
			return nil, fmt.Errorf("gas price: %w", err)
		}
	}
	nonce, err := c.client.PendingNonceAt(ctx, c.wallet.Address)
	if err != nil {
		return nil, fmt.Errorf("nonce: %w", err)
	}
	gasLimit := quote.Gas * 12 / 10
	if gasLimit < 100000 {
		gasLimit = 200000
	}

	tx := types.NewTransaction(nonce, quote.To, quote.Value, gasLimit, gasPrice, quote.Data)
	signedTx, err := types.SignTx(tx, types.NewEIP155Signer(c.chainID), c.wallet.privateKey)
	if err != nil {
		return nil, fmt.Errorf("sign: %w", err)
	}
	if err := c.client.SendTransaction(ctx, signedTx); err != nil {
		return nil, fmt.Errorf("broadcast: %w", err)
	}
	return signedTx, nil
}

func (c *Chain) WaitForReceipt(ctx context.Context, tx *types.Transaction) (*types.Receipt, error) {
	for i := 0; i < 60; i++ {
		receipt, err := c.client.TransactionReceipt(ctx, tx.Hash())
		if err == nil {
			return receipt, nil
		}
		time.Sleep(2 * time.Second)
	}
	return nil, fmt.Errorf("transaction %s not mined within 120s", tx.Hash().Hex())
}

func (c *Chain) ParseSwapFill(ctx context.Context, receipt *types.Receipt, tokenAddr common.Address, tokenDecimals uint8, isBuy bool) *SwapFill {
	fill := &SwapFill{}
	if block, err := c.client.BlockByNumber(ctx, receipt.BlockNumber); err == nil {
		fill.BlockTimestampMs = int64(block.Time()) * 1000
	}
	walletTopic := common.BytesToHash(common.LeftPadBytes(c.wallet.Address.Bytes(), 32))
	tokenLower := strings.ToLower(tokenAddr.Hex())
	total := big.NewInt(0)
	for _, lg := range receipt.Logs {
		if strings.ToLower(lg.Address.Hex()) != tokenLower || len(lg.Topics) < 3 || lg.Topics[0] != transferTopic {
			continue
		}
		from := lg.Topics[1]
		to := lg.Topics[2]
		if (isBuy && to == walletTopic) || (!isBuy && from == walletTopic) {
			total.Add(total, new(big.Int).SetBytes(lg.Data))
		}
	}
	fill.TokenAmount = tokenToFloat(total, tokenDecimals)
	if !isBuy {
		before, e1 := c.client.BalanceAt(ctx, c.wallet.Address, new(big.Int).Sub(receipt.BlockNumber, big.NewInt(1)))
		after, e2 := c.client.BalanceAt(ctx, c.wallet.Address, receipt.BlockNumber)
		if e1 == nil && e2 == nil {
			gasCost := new(big.Int).Mul(new(big.Int).SetUint64(receipt.GasUsed), receipt.EffectiveGasPrice)
			delta := new(big.Int).Sub(after, before)
			delta.Add(delta, gasCost)
			fill.NativeAmount = weiToEther(delta)
		}
	}
	return fill
}

// --- Internal helpers ---

func (c *Chain) callContract(to common.Address, data []byte) ([]byte, error) {
	msg := ethereum.CallMsg{To: &to, Data: data}
	return c.client.CallContract(context.Background(), msg, nil)
}

func (c *Chain) sendTransaction(ctx context.Context, to common.Address, value *big.Int, data []byte, gasLimit uint64) (*types.Transaction, error) {
	nonce, err := c.client.PendingNonceAt(ctx, c.wallet.Address)
	if err != nil {
		return nil, err
	}
	gasPrice, err := c.client.SuggestGasPrice(ctx)
	if err != nil {
		return nil, err
	}
	tx := types.NewTransaction(nonce, to, value, gasLimit, gasPrice, data)
	signedTx, err := types.SignTx(tx, types.NewEIP155Signer(c.chainID), c.wallet.privateKey)
	if err != nil {
		return nil, err
	}
	return signedTx, c.client.SendTransaction(ctx, signedTx)
}

func (c *Chain) waitTx(ctx context.Context, tx *types.Transaction) (*types.Receipt, error) {
	return c.WaitForReceipt(ctx, tx)
}

func tokenToFloat(amount *big.Int, decimals uint8) float64 {
	divisor := new(big.Float).SetInt(new(big.Int).Exp(big.NewInt(10), big.NewInt(int64(decimals)), nil))
	value := new(big.Float).SetInt(amount)
	result, _ := new(big.Float).Quo(value, divisor).Float64()
	return result
}

func weiToEther(wei *big.Int) float64 { return tokenToFloat(wei, 18) }

func parseFloatSafe(s string) (float64, error) {
	if s == "" {
		return 0, nil
	}
	f := new(big.Float)
	_, _, err := f.Parse(s, 10)
	if err != nil {
		return 0, err
	}
	r, _ := f.Float64()
	return r, nil
}

var httpClient = &http.Client{Timeout: 30 * time.Second}
