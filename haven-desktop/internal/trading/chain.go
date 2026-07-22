// Package trading provides EVM chain connectivity, wallet management,
// ERC-20 token helpers, and transaction execution.
package trading

import (
	"context"
	"crypto/ecdsa"
	"fmt"
	"math/big"
	"strings"
	"sync"
	"time"

	"github.com/ethereum/go-ethereum"
	"github.com/ethereum/go-ethereum/accounts/abi"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/core/types"
	"github.com/ethereum/go-ethereum/crypto"
	"github.com/ethereum/go-ethereum/ethclient"
	"github.com/ethereum/go-ethereum/signer/core/apitypes"
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

// Chain holds the EVM connection and wallet.
type Chain struct {
	client  *ethclient.Client
	wallet  *Wallet
	chainID *big.Int

	decimalsMu sync.RWMutex
	decimals   map[common.Address]uint8
}

// Wallet wraps an ECDSA private key with its address.
type Wallet struct {
	privateKey *ecdsa.PrivateKey
	Address    common.Address
}

// SwapFill holds the actual fill amounts parsed from the transaction receipt.
type SwapFill struct {
	TokenAmount      float64
	NativeAmount     float64
	BlockTimestampMs int64
}

// NewChain connects to an EVM RPC and loads the wallet from a private key.
func NewChain(rpcURL string, chainID int64, privateKeyHex string) (*Chain, error) {
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
	key = strings.TrimPrefix(key, "0x")
	key = strings.TrimPrefix(key, "0X")

	privateKey, err := crypto.HexToECDSA(key)
	if err != nil {
		return nil, fmt.Errorf("invalid private key: %w", err)
	}

	return &Chain{
		client:   client,
		wallet:   &Wallet{privateKey: privateKey, Address: crypto.PubkeyToAddress(privateKey.PublicKey)},
		chainID:  big.NewInt(chainID),
		decimals: make(map[common.Address]uint8),
	}, nil
}

// WalletAddress returns the wallet's address.
func (c *Chain) WalletAddress() common.Address { return c.wallet.Address }

// Close closes the RPC connection.
func (c *Chain) Close() { c.client.Close() }

// --- ERC-20 helpers ---

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

// --- Transaction helpers ---

// SendRawTransaction signs and broadcasts a raw EVM transaction.
func (c *Chain) SendRawTransaction(ctx context.Context, to common.Address, value *big.Int, data []byte, gasLimit uint64, gasPriceGwei float64) (*types.Transaction, error) {
	gasPrice := new(big.Int).Mul(big.NewInt(int64(gasPriceGwei*1e9)), big.NewInt(1))
	if gasPrice.Sign() == 0 {
		var err error
		gasPrice, err = c.client.SuggestGasPrice(ctx)
		if err != nil {
			return nil, fmt.Errorf("gas price: %w", err)
		}
	}
	nonce, err := c.client.PendingNonceAt(ctx, c.wallet.Address)
	if err != nil {
		return nil, fmt.Errorf("nonce: %w", err)
	}
	if gasLimit < 100000 {
		gasLimit = 200000
	}

	tx := types.NewTransaction(nonce, to, value, gasLimit, gasPrice, data)
	signedTx, err := types.SignTx(tx, types.NewEIP155Signer(c.chainID), c.wallet.privateKey)
	if err != nil {
		return nil, fmt.Errorf("sign: %w", err)
	}
	if err := c.client.SendTransaction(ctx, signedTx); err != nil {
		return nil, fmt.Errorf("broadcast: %w", err)
	}
	return signedTx, nil
}

func (c *Chain) SignEIP712Order(typedData apitypes.TypedData) (string, error) {
	hash, _, err := apitypes.TypedDataAndHash(typedData)
	if err != nil {
		return "", err
	}
	signature, err := crypto.Sign(hash, c.wallet.privateKey)
	if err != nil {
		return "", err
	}
	signature[64] += 27
	return fmt.Sprintf("0x%x", signature), nil
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
