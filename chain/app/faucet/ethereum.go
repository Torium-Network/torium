package faucet

import (
	"context"
	"crypto/ecdsa"
	"errors"
	"fmt"
	"math/big"
	"sync"
	"time"

	"github.com/ethereum/go-ethereum"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/core/types"
	ethcrypto "github.com/ethereum/go-ethereum/crypto"
	"github.com/ethereum/go-ethereum/ethclient"
)

const nativeTransferGas = uint64(21_000)

// Health is public chain evidence returned by the faucet readiness endpoint.
type Health struct {
	ChainID                *big.Int
	BlockNumber            uint64
	SignerAddress          common.Address
	SignerBalanceBaseUnits *big.Int
}

// Funding is the canonical transaction/receipt evidence for a completed
// faucet transfer. It never contains a raw signed transaction.
type Funding struct {
	TransactionHash common.Hash
	BlockHash       common.Hash
	BlockNumber     uint64
	ReceiptStatus   uint64
	TransactionType uint8
	Nonce           uint64
	From            common.Address
	To              common.Address
	Amount          *big.Int
}

// Funder is the small chain boundary used by the HTTP service and its tests.
type Funder interface {
	Health(context.Context) (Health, error)
	Fund(context.Context, common.Address, *big.Int) (Funding, error)
}

// EthereumFunder signs real EIP-1559 native transfers and waits for their
// canonical receipts. The signer remains only in this process.
type EthereumFunder struct {
	client             *ethclient.Client
	privateKey         *ecdsa.PrivateKey
	signerAddress      common.Address
	expectedChainID    *big.Int
	transactionTimeout time.Duration
	mu                 sync.Mutex
}

// NewEthereumFunder verifies the RPC replay domain before accepting requests.
func NewEthereumFunder(
	ctx context.Context,
	rpcURL string,
	privateKey *ecdsa.PrivateKey,
	signerAddress common.Address,
	expectedChainID *big.Int,
	transactionTimeout time.Duration,
) (*EthereumFunder, error) {
	if privateKey == nil {
		return nil, fmt.Errorf("faucet private key is required")
	}
	derivedSigner := ethcrypto.PubkeyToAddress(privateKey.PublicKey)
	if derivedSigner != signerAddress {
		return nil, fmt.Errorf("faucet signer address mismatch: derived %s, configured %s", derivedSigner, signerAddress)
	}
	if expectedChainID == nil || expectedChainID.Sign() <= 0 {
		return nil, fmt.Errorf("expected EVM chain ID must be positive")
	}
	if transactionTimeout <= 0 {
		return nil, fmt.Errorf("transaction timeout must be positive")
	}
	client, err := ethclient.DialContext(ctx, rpcURL)
	if err != nil {
		return nil, fmt.Errorf("connect to local EVM RPC: %w", err)
	}
	funder := &EthereumFunder{
		client:             client,
		privateKey:         privateKey,
		signerAddress:      signerAddress,
		expectedChainID:    new(big.Int).Set(expectedChainID),
		transactionTimeout: transactionTimeout,
	}
	if _, err := funder.Health(ctx); err != nil {
		client.Close()
		return nil, err
	}
	return funder, nil
}

// Close releases the underlying RPC connection.
func (funder *EthereumFunder) Close() {
	funder.client.Close()
}

// Health verifies the chain ID and returns current public signer state.
func (funder *EthereumFunder) Health(ctx context.Context) (Health, error) {
	chainID, err := funder.client.ChainID(ctx)
	if err != nil {
		return Health{}, fmt.Errorf("read EVM chain ID: %w", err)
	}
	if chainID.Cmp(funder.expectedChainID) != 0 {
		return Health{}, fmt.Errorf("EVM chain ID mismatch: got %s, want %s", chainID, funder.expectedChainID)
	}
	header, err := funder.client.HeaderByNumber(ctx, nil)
	if err != nil {
		return Health{}, fmt.Errorf("read latest EVM header: %w", err)
	}
	balance, err := funder.client.BalanceAt(ctx, funder.signerAddress, nil)
	if err != nil {
		return Health{}, fmt.Errorf("read faucet balance: %w", err)
	}
	return Health{
		ChainID:                new(big.Int).Set(chainID),
		BlockNumber:            header.Number.Uint64(),
		SignerAddress:          funder.signerAddress,
		SignerBalanceBaseUnits: new(big.Int).Set(balance),
	}, nil
}

// Fund serializes nonce allocation, submits a dynamic-fee transaction, and
// returns only after a successful receipt is available.
func (funder *EthereumFunder) Fund(ctx context.Context, recipient common.Address, amount *big.Int) (Funding, error) {
	if amount == nil || amount.Sign() <= 0 {
		return Funding{}, fmt.Errorf("funding amount must be positive")
	}
	funder.mu.Lock()
	defer funder.mu.Unlock()

	txContext, cancel := context.WithTimeout(ctx, funder.transactionTimeout)
	defer cancel()

	chainID, err := funder.client.ChainID(txContext)
	if err != nil {
		return Funding{}, fmt.Errorf("read EVM chain ID: %w", err)
	}
	if chainID.Cmp(funder.expectedChainID) != 0 {
		return Funding{}, fmt.Errorf("EVM chain ID mismatch: got %s, want %s", chainID, funder.expectedChainID)
	}
	nonce, err := funder.client.PendingNonceAt(txContext, funder.signerAddress)
	if err != nil {
		return Funding{}, fmt.Errorf("read faucet pending nonce: %w", err)
	}
	header, err := funder.client.HeaderByNumber(txContext, nil)
	if err != nil {
		return Funding{}, fmt.Errorf("read latest EVM header: %w", err)
	}
	if header.BaseFee == nil {
		return Funding{}, fmt.Errorf("latest EVM header has no EIP-1559 base fee")
	}
	tip, err := funder.client.SuggestGasTipCap(txContext)
	if err != nil || tip.Sign() <= 0 {
		tip = big.NewInt(1_000_000_000)
	}
	feeCap := new(big.Int).Add(
		new(big.Int).Mul(header.BaseFee, big.NewInt(2)),
		tip,
	)
	transaction := types.NewTx(&types.DynamicFeeTx{
		ChainID:   new(big.Int).Set(chainID),
		Nonce:     nonce,
		GasTipCap: new(big.Int).Set(tip),
		GasFeeCap: feeCap,
		Gas:       nativeTransferGas,
		To:        &recipient,
		Value:     new(big.Int).Set(amount),
	})
	signed, err := types.SignTx(transaction, types.LatestSignerForChainID(chainID), funder.privateKey)
	if err != nil {
		return Funding{}, fmt.Errorf("sign local faucet transaction: %w", err)
	}
	if err := funder.client.SendTransaction(txContext, signed); err != nil {
		return Funding{}, fmt.Errorf("broadcast local faucet transaction: %w", err)
	}
	receipt, err := funder.waitForReceipt(txContext, signed.Hash())
	if err != nil {
		return Funding{}, err
	}
	if receipt.Status != types.ReceiptStatusSuccessful {
		return Funding{}, fmt.Errorf("local faucet transaction %s failed with receipt status %d", signed.Hash(), receipt.Status)
	}
	return Funding{
		TransactionHash: signed.Hash(),
		BlockHash:       receipt.BlockHash,
		BlockNumber:     receipt.BlockNumber.Uint64(),
		ReceiptStatus:   receipt.Status,
		TransactionType: signed.Type(),
		Nonce:           signed.Nonce(),
		From:            funder.signerAddress,
		To:              recipient,
		Amount:          new(big.Int).Set(amount),
	}, nil
}

func (funder *EthereumFunder) waitForReceipt(ctx context.Context, hash common.Hash) (*types.Receipt, error) {
	ticker := time.NewTicker(500 * time.Millisecond)
	defer ticker.Stop()
	for {
		receipt, err := funder.client.TransactionReceipt(ctx, hash)
		if err == nil {
			return receipt, nil
		}
		if !errors.Is(err, ethereum.NotFound) {
			return nil, fmt.Errorf("read local faucet receipt %s: %w", hash, err)
		}
		select {
		case <-ctx.Done():
			return nil, fmt.Errorf("wait for local faucet receipt %s: %w", hash, ctx.Err())
		case <-ticker.C:
		}
	}
}
