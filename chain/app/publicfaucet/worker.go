package publicfaucet

import (
	"context"
	"crypto/ecdsa"
	"errors"
	"fmt"
	"log/slog"
	"math/big"
	"strings"
	"sync"
	"time"

	"github.com/ethereum/go-ethereum"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/core/types"
	ethcrypto "github.com/ethereum/go-ethereum/crypto"
	"github.com/ethereum/go-ethereum/ethclient"
)

const transferGas = uint64(21_000)

// Backend is the narrow chain boundary used by the worker and its tests.
type Backend interface {
	ChainID(ctx context.Context) (*big.Int, error)
	PendingNonceAt(ctx context.Context, account common.Address) (uint64, error)
	NonceAt(ctx context.Context, account common.Address) (uint64, error)
	BalanceAt(ctx context.Context, account common.Address) (*big.Int, error)
	HeadBaseFee(ctx context.Context) (*big.Int, error)
	SuggestGasTipCap(ctx context.Context) (*big.Int, error)
	SendTransaction(ctx context.Context, tx *types.Transaction) error
	TransactionReceipt(ctx context.Context, hash common.Hash) (*types.Receipt, error)
	Close()
}

// EthereumBackend adapts ethclient to the Backend boundary.
type EthereumBackend struct {
	client *ethclient.Client
}

// DialBackend connects to the configured EVM JSON-RPC endpoint.
func DialBackend(ctx context.Context, rpcURL string) (*EthereumBackend, error) {
	client, err := ethclient.DialContext(ctx, rpcURL)
	if err != nil {
		return nil, fmt.Errorf("connect to EVM RPC: %w", err)
	}
	return &EthereumBackend{client: client}, nil
}

// ChainID reads the EVM chain identifier.
func (backend *EthereumBackend) ChainID(ctx context.Context) (*big.Int, error) {
	return backend.client.ChainID(ctx)
}

// PendingNonceAt reads the pending account nonce.
func (backend *EthereumBackend) PendingNonceAt(ctx context.Context, account common.Address) (uint64, error) {
	return backend.client.PendingNonceAt(ctx, account)
}

// NonceAt reads the latest confirmed account nonce.
func (backend *EthereumBackend) NonceAt(ctx context.Context, account common.Address) (uint64, error) {
	return backend.client.NonceAt(ctx, account, nil)
}

// BalanceAt reads the latest account balance.
func (backend *EthereumBackend) BalanceAt(ctx context.Context, account common.Address) (*big.Int, error) {
	return backend.client.BalanceAt(ctx, account, nil)
}

// HeadBaseFee reads the latest EIP-1559 base fee.
func (backend *EthereumBackend) HeadBaseFee(ctx context.Context) (*big.Int, error) {
	header, err := backend.client.HeaderByNumber(ctx, nil)
	if err != nil {
		return nil, err
	}
	if header.BaseFee == nil {
		return nil, fmt.Errorf("latest header has no EIP-1559 base fee")
	}
	return new(big.Int).Set(header.BaseFee), nil
}

// SuggestGasTipCap reads the suggested priority fee.
func (backend *EthereumBackend) SuggestGasTipCap(ctx context.Context) (*big.Int, error) {
	return backend.client.SuggestGasTipCap(ctx)
}

// SendTransaction broadcasts one signed transaction.
func (backend *EthereumBackend) SendTransaction(ctx context.Context, tx *types.Transaction) error {
	return backend.client.SendTransaction(ctx, tx)
}

// TransactionReceipt reads one receipt by hash.
func (backend *EthereumBackend) TransactionReceipt(ctx context.Context, hash common.Hash) (*types.Receipt, error) {
	return backend.client.TransactionReceipt(ctx, hash)
}

// Close releases the RPC connection.
func (backend *EthereumBackend) Close() { backend.client.Close() }

// Signer is the swappable, role-isolated hot key.
type Signer struct {
	mu         sync.Mutex
	privateKey *ecdsa.PrivateKey
	address    common.Address
}

// NewSigner wraps one private key with its derived address.
func NewSigner(privateKey *ecdsa.PrivateKey) *Signer {
	return &Signer{
		privateKey: privateKey,
		address:    ethcrypto.PubkeyToAddress(privateKey.PublicKey),
	}
}

// Address returns the current signer address.
func (signer *Signer) Address() common.Address {
	signer.mu.Lock()
	defer signer.mu.Unlock()
	return signer.address
}

// Rotate atomically swaps the hot key and returns the previous address.
func (signer *Signer) Rotate(privateKey *ecdsa.PrivateKey) common.Address {
	signer.mu.Lock()
	defer signer.mu.Unlock()
	previous := signer.address
	signer.privateKey = privateKey
	signer.address = ethcrypto.PubkeyToAddress(privateKey.PublicKey)
	return previous
}

func (signer *Signer) sign(tx *types.Transaction, chainID *big.Int) (*types.Transaction, common.Address, error) {
	signer.mu.Lock()
	defer signer.mu.Unlock()
	signed, err := types.SignTx(tx, types.LatestSignerForChainID(chainID), signer.privateKey)
	return signed, signer.address, err
}

// settleOutcome classifies an in-flight submission after the fact.
type settleOutcome int

const (
	// settleUnknown: no receipt yet and the nonce has not advanced past the
	// submission — the transaction may still land, keep waiting.
	settleUnknown settleOutcome = iota
	// settleConfirmed: the submitted hash landed successfully.
	settleConfirmed
	// settleReverted: the submitted hash landed but reverted.
	settleReverted
	// settleGone: the account nonce advanced past the submission without the
	// hash landing. Under CometBFT finality that transaction can never land,
	// so re-signing with a fresh nonce cannot double-fund.
	settleGone
)

// Worker drains the bounded queue with a single goroutine so the signer
// nonce is naturally serialized, and reconciles interrupted work on start.
type Worker struct {
	backend  Backend
	store    *Store
	breakers *Breakers
	signer   *Signer
	profile  Profile
	metrics  *Metrics
	logger   *slog.Logger
	queue    chan string
	now      func() time.Time
	wg       sync.WaitGroup

	lastProbedSigner  common.Address
	lastProbedBalance *big.Int
}

// NewWorker wires the submission pipeline.
func NewWorker(backend Backend, store *Store, breakers *Breakers, signer *Signer, profile Profile, metrics *Metrics, logger *slog.Logger) *Worker {
	if logger == nil {
		logger = slog.Default()
	}
	return &Worker{
		backend:  backend,
		store:    store,
		breakers: breakers,
		signer:   signer,
		profile:  profile,
		metrics:  metrics,
		logger:   logger,
		queue:    make(chan string, profile.QueueCapacity),
		now:      time.Now,
	}
}

// TryEnqueue applies queue backpressure: it never blocks the accept path.
func (worker *Worker) TryEnqueue(requestID string) bool {
	select {
	case worker.queue <- requestID:
		worker.metrics.SetQueueDepth(len(worker.queue))
		return true
	default:
		return false
	}
}

// QueueDepth reports the current queue occupancy.
func (worker *Worker) QueueDepth() int { return len(worker.queue) }

// Start reconciles interrupted requests and launches the worker loops.
func (worker *Worker) Start(ctx context.Context) error {
	if err := worker.reconcile(ctx); err != nil {
		return err
	}
	worker.wg.Add(2)
	go func() {
		defer worker.wg.Done()
		worker.probeLoop(ctx)
	}()
	go func() {
		defer worker.wg.Done()
		worker.loop(ctx)
	}()
	return nil
}

// Wait blocks until the worker loops exit.
func (worker *Worker) Wait() { worker.wg.Wait() }

// reconcile re-enqueues interrupted requests after a restart. Submitted
// requests are settled inside the normal processing loop so restart recovery
// and live retries share one code path. No new funding is signed before the
// backlog is queued.
func (worker *Worker) reconcile(ctx context.Context) error {
	_ = ctx
	for _, request := range worker.store.PendingRequests() {
		if !worker.TryEnqueue(request.ID) {
			if err := worker.store.RecordFailed(request.ID, "queue capacity exceeded during restart recovery", worker.now()); err != nil {
				return err
			}
		}
	}
	return nil
}

func (worker *Worker) probeLoop(ctx context.Context) {
	ticker := time.NewTicker(worker.profile.RPCProbeInterval)
	defer ticker.Stop()
	worker.probeOnce(ctx)
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			worker.probeOnce(ctx)
		}
	}
}

func (worker *Worker) probeOnce(ctx context.Context) {
	probeContext, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	chainID, err := worker.backend.ChainID(probeContext)
	if err != nil || chainID.Cmp(worker.profile.EVMChainID) != 0 {
		worker.breakers.RecordRPCProbe(false)
		worker.metrics.IncrementRPCError()
		return
	}
	balance, err := worker.backend.BalanceAt(probeContext, worker.signer.Address())
	if err != nil {
		worker.breakers.RecordRPCProbe(false)
		worker.metrics.IncrementRPCError()
		return
	}
	worker.breakers.RecordRPCProbe(true)
	worker.breakers.RecordBalance(balance)
	worker.metrics.SetHotBalance(balance)
	worker.observeRefill(balance)
}

// observeRefill journals significant hot-balance increases so manual refills
// leave an auditable trail. A signer change resets the baseline silently.
func (worker *Worker) observeRefill(balance *big.Int) {
	signerAddress := worker.signer.Address()
	if worker.lastProbedSigner != signerAddress || worker.lastProbedBalance == nil {
		worker.lastProbedSigner = signerAddress
		worker.lastProbedBalance = new(big.Int).Set(balance)
		return
	}
	increase := new(big.Int).Sub(balance, worker.lastProbedBalance)
	if increase.Cmp(worker.profile.AmountPerRequest) >= 0 {
		if err := worker.store.RecordRefill("balance-increase-observed", increase.String(), worker.now()); err != nil {
			worker.logger.Warn("public faucet could not journal an observed refill", "error", err.Error())
		}
	}
	worker.lastProbedBalance.Set(balance)
}

func (worker *Worker) loop(ctx context.Context) {
	for {
		select {
		case <-ctx.Done():
			return
		case requestID := <-worker.queue:
			worker.metrics.SetQueueDepth(len(worker.queue))
			worker.process(ctx, requestID)
		}
	}
}

// process drives one request to a terminal state. Transient chain faults
// keep the request owned by the loop with backoff; in-flight submissions are
// settled from chain evidence before any re-sign, so a retry can never
// double-fund a request.
func (worker *Worker) process(ctx context.Context, requestID string) {
	attempts := 0
	replacementBumps := int64(0)
	var unknownSince time.Time
	for {
		if ctx.Err() != nil {
			return
		}
		request, ok := worker.store.Get(requestID)
		if !ok {
			return
		}
		switch request.Status {
		case StatusConfirmed, StatusFailed, StatusDenied:
			return
		}
		if paused, _ := worker.store.Paused(); paused {
			if !worker.sleep(ctx, time.Second) {
				return
			}
			continue
		}
		state := worker.breakers.Evaluate(new(big.Int))
		if state.RPCDown || state.BalanceFloor {
			if !worker.sleep(ctx, time.Second) {
				return
			}
			continue
		}
		if request.Status == StatusSubmitted && request.TransactionHash != "" {
			outcome, err := worker.settleSubmission(ctx, request)
			if err != nil {
				worker.recordTransient(ctx, requestID, &attempts, err)
				if !worker.sleep(ctx, time.Second) {
					return
				}
				continue
			}
			switch outcome {
			case settleConfirmed:
				worker.breakers.RecordOutcome(true)
				worker.metrics.IncrementTxOutcome("confirmed")
				return
			case settleReverted:
				worker.breakers.RecordOutcome(false)
				worker.metrics.IncrementTxOutcome("failed")
				_ = worker.store.RecordFailed(requestID, "funding transaction reverted", worker.now())
				return
			case settleGone:
				// The old transaction can never land; re-signing with a
				// fresh nonce cannot double-fund.
				unknownSince = time.Time{}
			case settleUnknown:
				now := worker.now()
				if unknownSince.IsZero() {
					unknownSince = now
				}
				if now.Sub(unknownSince) > worker.profile.TransactionTimeout {
					// The submission has been unobservable for a full
					// timeout. Replace it at the SAME nonce with bumped
					// fees: at most one of the two transactions can ever
					// land, so this cannot double-fund.
					replacementBumps++
					if err := worker.replaceSubmission(ctx, request, replacementBumps); err != nil {
						worker.recordTransient(ctx, requestID, &attempts, err)
					}
					unknownSince = time.Time{}
				}
				if !worker.sleep(ctx, 500*time.Millisecond) {
					return
				}
				continue
			}
		}
		if worker.store.SignerFenced(worker.signer.Address()) {
			if !worker.sleep(ctx, time.Second) {
				return
			}
			continue
		}
		err := worker.fundOnce(ctx, requestID)
		if err == nil {
			worker.breakers.RecordOutcome(true)
			worker.metrics.IncrementTxOutcome("confirmed")
			return
		}
		if errors.Is(err, context.Canceled) {
			return
		}
		if isTerminalFundingError(err) {
			worker.breakers.RecordOutcome(false)
			worker.metrics.IncrementTxOutcome("failed")
			_ = worker.store.RecordFailed(requestID, err.Error(), worker.now())
			return
		}
		worker.recordTransient(ctx, requestID, &attempts, err)
		if !worker.sleep(ctx, time.Second) {
			return
		}
	}
}

func (worker *Worker) recordTransient(ctx context.Context, requestID string, attempts *int, err error) {
	*attempts++
	worker.metrics.IncrementRPCError()
	worker.logger.WarnContext(ctx, "public faucet funding attempt deferred",
		"requestId", requestID, "attempt", *attempts, "error", err.Error())
}

// settleSubmission classifies an in-flight submitted transaction using only
// chain evidence and records terminal outcomes.
func (worker *Worker) settleSubmission(ctx context.Context, request Request) (settleOutcome, error) {
	settleContext, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	hash := common.HexToHash(request.TransactionHash)
	receipt, err := worker.backend.TransactionReceipt(settleContext, hash)
	if err == nil {
		if receipt.Status == types.ReceiptStatusSuccessful {
			if err := worker.store.RecordConfirmed(request.ID, hash, receipt.BlockNumber.Uint64(), worker.now()); err != nil {
				return settleUnknown, err
			}
			return settleConfirmed, nil
		}
		return settleReverted, nil
	}
	if !errors.Is(err, ethereum.NotFound) {
		return settleUnknown, err
	}
	confirmedNonce, err := worker.backend.NonceAt(settleContext, common.HexToAddress(request.SignerAddress))
	if err != nil {
		return settleUnknown, err
	}
	if confirmedNonce > request.Nonce {
		return settleGone, nil
	}
	return settleUnknown, nil
}

// replaceSubmission re-signs a stuck submission at its ORIGINAL nonce with
// bumped fees. Because both transactions share one nonce, at most one can
// land — the safe way to unstick a submission whose fate is unobservable.
func (worker *Worker) replaceSubmission(ctx context.Context, request Request, bump int64) error {
	amount, ok := new(big.Int).SetString(request.AmountBaseUnits, 10)
	if !ok {
		return fmt.Errorf("terminal: request amount is unreadable")
	}
	recipient := common.HexToAddress(request.Address)
	attemptContext, cancel := context.WithTimeout(ctx, worker.profile.TransactionTimeout)
	defer cancel()
	chainID, err := worker.backend.ChainID(attemptContext)
	if err != nil {
		return fmt.Errorf("read chain ID: %w", err)
	}
	if chainID.Cmp(worker.profile.EVMChainID) != 0 {
		return fmt.Errorf("terminal: EVM chain ID mismatch: got %s, want %s", chainID, worker.profile.EVMChainID)
	}
	if request.SignerAddress != worker.signer.Address().Hex() {
		// The signer rotated while this submission was in flight; the old
		// key is fenced and cannot replace its own transaction. Settle will
		// resolve it from chain evidence once the nonce advances.
		return fmt.Errorf("submission belongs to a rotated signer; waiting for chain evidence")
	}
	baseFee, err := worker.backend.HeadBaseFee(attemptContext)
	if err != nil {
		return fmt.Errorf("read base fee: %w", err)
	}
	tip, err := worker.backend.SuggestGasTipCap(attemptContext)
	if err != nil || tip.Sign() <= 0 {
		tip = big.NewInt(1_000_000_000)
	}
	multiplier := big.NewInt(1 + bump)
	bumpedTip := new(big.Int).Mul(tip, multiplier)
	feeCap := new(big.Int).Add(new(big.Int).Mul(baseFee, big.NewInt(2)), bumpedTip)
	feeCap.Mul(feeCap, multiplier)
	unsigned := types.NewTx(&types.DynamicFeeTx{
		ChainID:   new(big.Int).Set(chainID),
		Nonce:     request.Nonce,
		GasTipCap: bumpedTip,
		GasFeeCap: feeCap,
		Gas:       transferGas,
		To:        &recipient,
		Value:     new(big.Int).Set(amount),
	})
	signed, _, err := worker.signer.sign(unsigned, chainID)
	if err != nil {
		return fmt.Errorf("terminal: sign replacement transaction: %w", err)
	}
	if err := worker.store.RecordSubmitted(request.ID, signed.Hash(), request.Nonce, common.HexToAddress(request.SignerAddress), worker.now()); err != nil {
		return fmt.Errorf("terminal: journal replacement transaction: %w", err)
	}
	if err := worker.backend.SendTransaction(attemptContext, signed); err != nil {
		return fmt.Errorf("broadcast replacement transaction: %w", err)
	}
	return nil
}

func (worker *Worker) sleep(ctx context.Context, duration time.Duration) bool {
	select {
	case <-ctx.Done():
		return false
	case <-time.After(duration):
		return true
	}
}

// fundOnce performs one sign/broadcast/confirm attempt. The submitted hash
// is journaled before broadcast so a crash cannot lose an in-flight
// transaction.
func (worker *Worker) fundOnce(ctx context.Context, requestID string) error {
	request, ok := worker.store.Get(requestID)
	if !ok {
		return fmt.Errorf("terminal: request %s disappeared", requestID)
	}
	amount, ok := new(big.Int).SetString(request.AmountBaseUnits, 10)
	if !ok {
		return fmt.Errorf("terminal: request amount is unreadable")
	}
	recipient := common.HexToAddress(request.Address)
	attemptContext, cancel := context.WithTimeout(ctx, worker.profile.TransactionTimeout)
	defer cancel()
	chainID, err := worker.backend.ChainID(attemptContext)
	if err != nil {
		return fmt.Errorf("read chain ID: %w", err)
	}
	if chainID.Cmp(worker.profile.EVMChainID) != 0 {
		return fmt.Errorf("terminal: EVM chain ID mismatch: got %s, want %s", chainID, worker.profile.EVMChainID)
	}
	signerAddress := worker.signer.Address()
	nonce, err := worker.backend.PendingNonceAt(attemptContext, signerAddress)
	if err != nil {
		return fmt.Errorf("read pending nonce: %w", err)
	}
	baseFee, err := worker.backend.HeadBaseFee(attemptContext)
	if err != nil {
		return fmt.Errorf("read base fee: %w", err)
	}
	tip, err := worker.backend.SuggestGasTipCap(attemptContext)
	if err != nil || tip.Sign() <= 0 {
		tip = big.NewInt(1_000_000_000)
	}
	feeCap := new(big.Int).Add(new(big.Int).Mul(baseFee, big.NewInt(2)), tip)
	unsigned := types.NewTx(&types.DynamicFeeTx{
		ChainID:   new(big.Int).Set(chainID),
		Nonce:     nonce,
		GasTipCap: new(big.Int).Set(tip),
		GasFeeCap: feeCap,
		Gas:       transferGas,
		To:        &recipient,
		Value:     new(big.Int).Set(amount),
	})
	signed, signedBy, err := worker.signer.sign(unsigned, chainID)
	if err != nil {
		return fmt.Errorf("terminal: sign funding transaction: %w", err)
	}
	if signedBy != signerAddress {
		return fmt.Errorf("signer rotated mid-attempt")
	}
	if err := worker.store.RecordSubmitted(requestID, signed.Hash(), nonce, signerAddress, worker.now()); err != nil {
		return fmt.Errorf("terminal: journal submitted transaction: %w", err)
	}
	if err := worker.backend.SendTransaction(attemptContext, signed); err != nil {
		if isBroadcastRejection(err) {
			// The node rejected the transaction outright, so it is not in
			// any mempool; the settle path re-checks and re-signs safely.
			return fmt.Errorf("broadcast rejected: %w", err)
		}
		// Ambiguous failure: the transaction may have reached the node. The
		// settle path resolves it from chain evidence.
		return fmt.Errorf("broadcast funding transaction: %w", err)
	}
	receipt, err := worker.waitForReceipt(attemptContext, signed.Hash())
	if err != nil {
		return err
	}
	if receipt.Status != types.ReceiptStatusSuccessful {
		return fmt.Errorf("terminal: funding transaction %s reverted", signed.Hash())
	}
	worker.metrics.ObserveConfirmationLag(worker.now().UTC().Sub(request.CreatedAt))
	return worker.store.RecordConfirmed(requestID, signed.Hash(), receipt.BlockNumber.Uint64(), worker.now())
}

func (worker *Worker) waitForReceipt(ctx context.Context, hash common.Hash) (*types.Receipt, error) {
	ticker := time.NewTicker(500 * time.Millisecond)
	defer ticker.Stop()
	for {
		receipt, err := worker.backend.TransactionReceipt(ctx, hash)
		if err == nil {
			return receipt, nil
		}
		if !errors.Is(err, ethereum.NotFound) {
			return nil, fmt.Errorf("read funding receipt %s: %w", hash, err)
		}
		select {
		case <-ctx.Done():
			return nil, fmt.Errorf("wait for funding receipt %s: %w", hash, ctx.Err())
		case <-ticker.C:
		}
	}
}

// Drain sends the remaining hot balance minus gas to the reserve address.
// It is only legal while the service is paused.
func (worker *Worker) Drain(ctx context.Context, reserve common.Address) (common.Hash, *big.Int, error) {
	if paused, _ := worker.store.Paused(); !paused {
		return common.Hash{}, nil, fmt.Errorf("drain requires the service to be paused")
	}
	drainContext, cancel := context.WithTimeout(ctx, worker.profile.TransactionTimeout)
	defer cancel()
	chainID, err := worker.backend.ChainID(drainContext)
	if err != nil {
		return common.Hash{}, nil, fmt.Errorf("read chain ID: %w", err)
	}
	if chainID.Cmp(worker.profile.EVMChainID) != 0 {
		return common.Hash{}, nil, fmt.Errorf("EVM chain ID mismatch: got %s, want %s", chainID, worker.profile.EVMChainID)
	}
	signerAddress := worker.signer.Address()
	balance, err := worker.backend.BalanceAt(drainContext, signerAddress)
	if err != nil {
		return common.Hash{}, nil, fmt.Errorf("read hot balance: %w", err)
	}
	nonce, err := worker.backend.PendingNonceAt(drainContext, signerAddress)
	if err != nil {
		return common.Hash{}, nil, fmt.Errorf("read pending nonce: %w", err)
	}
	baseFee, err := worker.backend.HeadBaseFee(drainContext)
	if err != nil {
		return common.Hash{}, nil, fmt.Errorf("read base fee: %w", err)
	}
	tip, err := worker.backend.SuggestGasTipCap(drainContext)
	if err != nil || tip.Sign() <= 0 {
		tip = big.NewInt(1_000_000_000)
	}
	feeCap := new(big.Int).Add(new(big.Int).Mul(baseFee, big.NewInt(2)), tip)
	gasBudget := new(big.Int).Mul(feeCap, new(big.Int).SetUint64(transferGas))
	value := new(big.Int).Sub(balance, gasBudget)
	if value.Sign() <= 0 {
		return common.Hash{}, nil, fmt.Errorf("hot balance %s cannot cover drain gas", balance)
	}
	unsigned := types.NewTx(&types.DynamicFeeTx{
		ChainID:   new(big.Int).Set(chainID),
		Nonce:     nonce,
		GasTipCap: new(big.Int).Set(tip),
		GasFeeCap: feeCap,
		Gas:       transferGas,
		To:        &reserve,
		Value:     value,
	})
	signed, _, err := worker.signer.sign(unsigned, chainID)
	if err != nil {
		return common.Hash{}, nil, fmt.Errorf("sign drain transaction: %w", err)
	}
	if err := worker.backend.SendTransaction(drainContext, signed); err != nil {
		return common.Hash{}, nil, fmt.Errorf("broadcast drain transaction: %w", err)
	}
	receipt, err := worker.waitForReceipt(drainContext, signed.Hash())
	if err != nil {
		return common.Hash{}, nil, err
	}
	if receipt.Status != types.ReceiptStatusSuccessful {
		return common.Hash{}, nil, fmt.Errorf("drain transaction %s reverted", signed.Hash())
	}
	return signed.Hash(), value, nil
}

// isBroadcastRejection matches node responses that prove the transaction was
// refused before entering any mempool.
func isBroadcastRejection(err error) bool {
	message := strings.ToLower(err.Error())
	return strings.Contains(message, "nonce too low") ||
		strings.Contains(message, "invalid nonce") ||
		strings.Contains(message, "replacement transaction underpriced") ||
		strings.Contains(message, "insufficient funds")
}

func isTerminalFundingError(err error) bool {
	return strings.Contains(err.Error(), "terminal:")
}
