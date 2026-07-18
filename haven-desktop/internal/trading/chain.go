// Package trading provides on-chain swap execution for BSC.
// Ported from marker-engine/chain.js — same OpenOcean v4 flow, same safety invariants.
package trading

import (
	"context"
	"crypto/ecdsa"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"math/big"
	"net/http"
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

// Chain holds the BSC connection and wallet.
type Chain struct {
	client   *ethclient.Client
	wallet   *Wallet
	chainID  *big.Int

	decimalsMu sync.RWMutex
	decimals   map[common.Address]uint8

	ooLastRequest time.Time
	ooMu          sync.Mutex
}

// Wallet wraps an ECDSA private key with its address.
type Wallet struct {
	privateKey *ecdsa.PrivateKey
	Address    common.Address
}

// SwapQuote is the validated swap transaction data from OpenOcean.
type SwapQuote struct {
	To        common.Address
	Data      []byte
	Value     *big.Int
	Gas       uint64
	OutAmount *big.Int
	InAmount  *big.Int
	Price     string
}

// SwapFill holds the actual fill amounts parsed from the transaction receipt.
type SwapFill struct {
	TokenAmount     float64
	BNBAmount       float64
	BlockTimestampMs int64
}

// NewChain connects to BSC and loads the wallet.
func NewChain(rpcURL, privateKeyHex string) (*Chain, error) {
	client, err := ethclient.Dial(rpcURL)
	if err != nil {
		return nil, fmt.Errorf("dial rpc: %w", err)
	}

	chainID, err := client.ChainID(context.Background())
	if err != nil {
		return nil, fmt.Errorf("chain id: %w", err)
	}

	// Ensure we're on BSC
	if chainID.Int64() != 56 {
		return nil, fmt.Errorf("wrong chain: expected BSC (56), got %d", chainID.Int64())
	}

	key := strings.TrimSpace(privateKeyHex)
	if !strings.HasPrefix(key, "0x") && len(key) == 64 {
		key = "0x" + key
	}

	privateKey, err := crypto.HexToECDSA(strings.TrimPrefix(key, "0x"))
	if err != nil {
		return nil, fmt.Errorf("invalid private key: %w", err)
	}

	wallet := &Wallet{
		privateKey: privateKey,
		Address:    crypto.PubkeyToAddress(privateKey.PublicKey),
	}

	return &Chain{
		client:   client,
		wallet:   wallet,
		chainID:  chainID,
		decimals: make(map[common.Address]uint8),
	}, nil
}

// WalletAddress returns the wallet's address.
func (c *Chain) WalletAddress() common.Address {
	return c.wallet.Address
}

// Close closes the RPC connection.
func (c *Chain) Close() {
	c.client.Close()
}

// --- ERC-20 helpers ---

// GetDecimals returns the decimals for a token address (cached).
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

// TokenBalance returns the token balance for an address.
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

// EnsureAllowance approves the spender for at least the given amount.
// Never uses MaxUint256 — approves only the exact trade amount.
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
		return nil // already sufficient
	}

	// Reset to 0 first if needed (USDT-style tokens)
	if current.A != nil && current.A.Sign() > 0 {
		data, _ = erc20ABI.Pack("approve", spender, big.NewInt(0))
		tx, err := c.sendTransaction(ctx, tokenAddr, big.NewInt(0), data, 200000)
		if err == nil {
			c.waitTx(ctx, tx)
		}
	}

	// Approve exact amount
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

// --- OpenOcean v4 swap quote ---

// OONative is the OpenOcean native token placeholder.
const OONative = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE"

// GetSwapQuote fetches a swap quote from OpenOcean v4.
func (c *Chain) GetSwapQuote(ctx context.Context, fromToken, toToken common.Address, amount *big.Int, decimals uint8, slippagePct float64, gasPriceGwei float64) (*SwapQuote, error) {
	// Rate limit: 1 req/sec
	c.ooMu.Lock()
	wait := time.Until(c.ooLastRequest.Add(1600 * time.Millisecond))
	if wait > 0 {
		c.ooMu.Unlock()
		time.Sleep(wait)
		c.ooMu.Lock()
	}
	c.ooLastRequest = time.Now()
	c.ooMu.Unlock()

	fromStr := strings.ToLower(fromToken.Hex())
	if fromToken == ZeroAddr {
		fromStr = OONative
	}
	toStr := strings.ToLower(toToken.Hex())
	if toToken == ZeroAddr {
		toStr = OONative
	}

	amountStr := amount.String()
	url := fmt.Sprintf(
		"https://open-api.openocean.finance/v4/bsc/swap?inTokenAddress=%s&outTokenAddress=%s&amount=%s&gasPrice=%.0f&slippage=%.1f&account=%s",
		fromStr, toStr, amountStr, gasPriceGwei, slippagePct, c.wallet.Address.Hex(),
	)

	var resp struct {
		Code int `json:"code"`
		Data struct {
			To           string `json:"to"`
			Data         string `json:"data"`
			Value        string `json:"value"`
			EstimatedGas int64  `json:"estimatedGas"`
			Gas          int64  `json:"gas"`
			OutAmount    string `json:"outAmount"`
			InAmount     string `json:"inAmount"`
			Price        string `json:"price"`
		} `json:"data"`
	}

	// HTTP GET with retry on 429
	if err := httpGetJSON(ctx, url, &resp); err != nil {
		return nil, err
	}
	if resp.Data.To == "" || resp.Data.Data == "" {
		return nil, fmt.Errorf("openocean returned no swap data (code %d)", resp.Code)
	}

	to := common.HexToAddress(resp.Data.To)
	swapData, _ := hex.DecodeString(strings.TrimPrefix(resp.Data.Data, "0x"))
	value, _ := new(big.Int).SetString(resp.Data.Value, 10)
	outAmount, _ := new(big.Int).SetString(resp.Data.OutAmount, 10)
	inAmount, _ := new(big.Int).SetString(resp.Data.InAmount, 10)
	gas := uint64(resp.Data.EstimatedGas)
	if gas == 0 {
		gas = uint64(resp.Data.Gas)
	}

	return &SwapQuote{
		To:        to,
		Data:      swapData,
		Value:     value,
		Gas:       gas,
		OutAmount: outAmount,
		InAmount:  inAmount,
		Price:     resp.Data.Price,
	}, nil
}

// --- Transaction execution ---

// SendSwap sends a swap transaction from a validated quote.
func (c *Chain) SendSwap(ctx context.Context, quote *SwapQuote, gasPriceGwei float64, allowedRouters []common.Address) (*types.Transaction, error) {
	// Validate router
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

	// Validate calldata
	if len(quote.Data) < 8 || len(quote.Data) > 131074 {
		return nil, fmt.Errorf("swap calldata is malformed or unexpectedly large")
	}

	// Dry-run: simulate the transaction
	_, err := c.client.CallContract(ctx, ethereum.CallMsg{
		From: c.wallet.Address,
		To:   &quote.To,
		Data: quote.Data,
		Value: quote.Value,
	}, nil)
	if err != nil {
		return nil, fmt.Errorf("swap simulation failed: %w", err)
	}

	// Get gas price
	gasPrice := new(big.Int).Mul(big.NewInt(int64(gasPriceGwei*1e9)), big.NewInt(1))
	if gasPrice.Sign() == 0 {
		gasPrice, err = c.client.SuggestGasPrice(ctx)
		if err != nil {
			return nil, fmt.Errorf("gas price: %w", err)
		}
	}

	// Build and sign transaction
	nonce, err := c.client.PendingNonceAt(ctx, c.wallet.Address)
	if err != nil {
		return nil, fmt.Errorf("nonce: %w", err)
	}

	gasLimit := quote.Gas * 12 / 10 // +20% buffer
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

// WaitForReceipt waits for a transaction to be mined.
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

// ParseSwapFill extracts actual fill amounts from a receipt's Transfer logs.
func (c *Chain) ParseSwapFill(ctx context.Context, receipt *types.Receipt, tokenAddr common.Address, tokenDecimals uint8, isBuy bool) *SwapFill {
	fill := &SwapFill{}

	// Block timestamp
	if block, err := c.client.BlockByNumber(ctx, receipt.BlockNumber); err == nil {
		fill.BlockTimestampMs = int64(block.Time()) * 1000
	}

	// Parse Transfer logs for token amount
	walletTopic := common.BytesToHash(common.LeftPadBytes(c.wallet.Address.Bytes(), 32))
	tokenLower := strings.ToLower(tokenAddr.Hex())
	total := big.NewInt(0)

	for _, lg := range receipt.Logs {
		if strings.ToLower(lg.Address.Hex()) != tokenLower {
			continue
		}
		if len(lg.Topics) < 3 || lg.Topics[0] != transferTopic {
			continue
		}
		from := lg.Topics[1]
		to := lg.Topics[2]
		if (isBuy && to == walletTopic) || (!isBuy && from == walletTopic) {
			amount := new(big.Int).SetBytes(lg.Data)
			total.Add(total, amount)
		}
	}

	fill.TokenAmount = tokenToFloat(total, tokenDecimals)

	// For sells, compute BNB received from balance delta (net of gas)
	if !isBuy {
		before, err1 := c.client.BalanceAt(ctx, c.wallet.Address, new(big.Int).Sub(receipt.BlockNumber, big.NewInt(1)))
		after, err2 := c.client.BalanceAt(ctx, c.wallet.Address, receipt.BlockNumber)
		if err1 == nil && err2 == nil {
			gasCost := new(big.Int).Mul(new(big.Int).SetUint64(receipt.GasUsed), receipt.EffectiveGasPrice)
			delta := new(big.Int).Sub(after, before)
			delta.Add(delta, gasCost)
			fill.BNBAmount = weiToEther(delta)
		}
	}

	return fill
}

// --- Internal helpers ---

func (c *Chain) callContract(to common.Address, data []byte) ([]byte, error) {
	msg := ethereum.CallMsg{
		To:   &to,
		Data: data,
	}
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

func weiToEther(wei *big.Int) float64 {
	return tokenToFloat(wei, 18)
}

// Stub for the HTTP client — will be replaced with a proper implementation.
// In production, use the global HTTP client from the market package.
var httpClient = &http.Client{Timeout: 30 * time.Second}

func httpGetJSON(ctx context.Context, url string, v interface{}) error {
	req, err := http.NewRequestWithContext(ctx, "GET", url, nil)
	if err != nil {
		return err
	}
	req.Header.Set("User-Agent", "Haven-Desktop/1.0")
	req.Header.Set("Accept", "application/json")

	resp, err := httpClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode == 429 {
		time.Sleep(2500 * time.Millisecond)
		req, _ = http.NewRequestWithContext(ctx, "GET", url, nil)
		req.Header.Set("User-Agent", "Haven-Desktop/1.0")
		req.Header.Set("Accept", "application/json")
		resp, err = httpClient.Do(req)
		if err != nil {
			return err
		}
		defer resp.Body.Close()
	}

	if resp.StatusCode >= 400 {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 500))
		return fmt.Errorf("openocean http %d: %s", resp.StatusCode, string(body))
	}

	return json.NewDecoder(resp.Body).Decode(v)
}
