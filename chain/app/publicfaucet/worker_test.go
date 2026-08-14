package publicfaucet

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"math/big"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/ethereum/go-ethereum"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/core/types"
	ethcrypto "github.com/ethereum/go-ethereum/crypto"
)

// fakeBackend simulates the chain: it can mine instantly, accept-and-drop,
// or reject broadcasts, so the worker's recovery paths are testable without
// a node.
type fakeBackend struct {
	mu             sync.Mutex
	chainID        *big.Int
	confirmedNonce uint64
	balance        *big.Int
	receipts       map[common.Hash]*types.Receipt
	dropNext       bool
	rejectNext     error
	minedTransfers []*types.Transaction
	blockNumber    uint64
}

func newFakeBackend(chainID *big.Int) *fakeBackend {
	return &fakeBackend{
		chainID:  new(big.Int).Set(chainID),
		balance:  big.NewInt(1_000_000_000_000_000),
		receipts: make(map[common.Hash]*types.Receipt),
	}
}

func (backend *fakeBackend) ChainID(context.Context) (*big.Int, error) {
	backend.mu.Lock()
	defer backend.mu.Unlock()
	return new(big.Int).Set(backend.chainID), nil
}

func (backend *fakeBackend) PendingNonceAt(context.Context, common.Address) (uint64, error) {
	backend.mu.Lock()
	defer backend.mu.Unlock()
	return backend.confirmedNonce, nil
}

func (backend *fakeBackend) NonceAt(context.Context, common.Address) (uint64, error) {
	backend.mu.Lock()
	defer backend.mu.Unlock()
	return backend.confirmedNonce, nil
}

func (backend *fakeBackend) BalanceAt(context.Context, common.Address) (*big.Int, error) {
	backend.mu.Lock()
	defer backend.mu.Unlock()
	return new(big.Int).Set(backend.balance), nil
}

func (backend *fakeBackend) HeadBaseFee(context.Context) (*big.Int, error) {
	return big.NewInt(1_000_000_000), nil
}

func (backend *fakeBackend) SuggestGasTipCap(context.Context) (*big.Int, error) {
	return big.NewInt(1_000_000_000), nil
}

func (backend *fakeBackend) SendTransaction(_ context.Context, tx *types.Transaction) error {
	backend.mu.Lock()
	defer backend.mu.Unlock()
	if backend.rejectNext != nil {
		err := backend.rejectNext
		backend.rejectNext = nil
		return err
	}
	if tx.Nonce() < backend.confirmedNonce {
		return fmt.Errorf("nonce too low")
	}
	if backend.dropNext {
		backend.dropNext = false
		return nil
	}
	backend.blockNumber++
	backend.receipts[tx.Hash()] = &types.Receipt{
		Status:      types.ReceiptStatusSuccessful,
		BlockNumber: new(big.Int).SetUint64(backend.blockNumber),
		BlockHash:   common.BigToHash(new(big.Int).SetUint64(backend.blockNumber)),
	}
	backend.confirmedNonce = tx.Nonce() + 1
	backend.minedTransfers = append(backend.minedTransfers, tx)
	return nil
}

func (backend *fakeBackend) TransactionReceipt(_ context.Context, hash common.Hash) (*types.Receipt, error) {
	backend.mu.Lock()
	defer backend.mu.Unlock()
	receipt, ok := backend.receipts[hash]
	if !ok {
		return nil, ethereum.NotFound
	}
	return receipt, nil
}

func (backend *fakeBackend) Close() {}

func (backend *fakeBackend) consumeNonceExternally() {
	backend.mu.Lock()
	defer backend.mu.Unlock()
	backend.confirmedNonce++
	backend.blockNumber++
}

func (backend *fakeBackend) minedCount() int {
	backend.mu.Lock()
	defer backend.mu.Unlock()
	return len(backend.minedTransfers)
}

func newWorkerFixture(t *testing.T, backend Backend, profile Profile) (*Worker, *Store) {
	t.Helper()
	journal, entries, err := OpenJournal(t.TempDir())
	if err != nil {
		t.Fatalf("open journal: %v", err)
	}
	t.Cleanup(func() { _ = journal.Close() })
	store, err := NewStore(journal, entries, profile)
	if err != nil {
		t.Fatalf("build store: %v", err)
	}
	key, err := ethcrypto.GenerateKey()
	if err != nil {
		t.Fatalf("generate key: %v", err)
	}
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	worker := NewWorker(backend, store, NewBreakers(profile), NewSigner(key), profile, NewMetrics(), logger)
	return worker, store
}

func TestWorkerFundsAndConfirms(t *testing.T) {
	profile := testProfile(t)
	backend := newFakeBackend(profile.EVMChainID)
	worker, store := newWorkerFixture(t, backend, profile)
	address := common.HexToAddress("0x7777777777777777777777777777777777777777")
	request, _, err := store.Accept("fund-key-000", address, time.Now(), "request-1")
	if err != nil {
		t.Fatalf("accept: %v", err)
	}
	worker.process(context.Background(), request.ID)
	final, _ := store.Get(request.ID)
	if final.Status != StatusConfirmed {
		t.Fatalf("request status = %s (%s)", final.Status, final.Reason)
	}
	if backend.minedCount() != 1 {
		t.Fatalf("expected exactly one mined transfer, got %d", backend.minedCount())
	}
}

func TestWorkerRecoversDroppedTransactionWithoutDoubleFunding(t *testing.T) {
	profile := testProfile(t)
	profile.TransactionTimeout = 300 * time.Millisecond
	backend := newFakeBackend(profile.EVMChainID)
	backend.dropNext = true
	worker, store := newWorkerFixture(t, backend, profile)
	address := common.HexToAddress("0x8888888888888888888888888888888888888888")
	request, _, err := store.Accept("drop-key-000", address, time.Now(), "request-1")
	if err != nil {
		t.Fatalf("accept: %v", err)
	}
	done := make(chan struct{})
	go func() {
		worker.process(context.Background(), request.ID)
		close(done)
	}()
	// Let the first broadcast get dropped, then consume its nonce externally
	// so the dropped transaction can never land.
	time.Sleep(600 * time.Millisecond)
	backend.consumeNonceExternally()
	select {
	case <-done:
	case <-time.After(10 * time.Second):
		t.Fatalf("worker did not recover from the dropped transaction")
	}
	final, _ := store.Get(request.ID)
	if final.Status != StatusConfirmed {
		t.Fatalf("request status = %s (%s)", final.Status, final.Reason)
	}
	if backend.minedCount() != 1 {
		t.Fatalf("recovery must fund exactly once, got %d transfers", backend.minedCount())
	}
}

func TestWorkerRetriesBroadcastRejection(t *testing.T) {
	profile := testProfile(t)
	profile.TransactionTimeout = 300 * time.Millisecond
	backend := newFakeBackend(profile.EVMChainID)
	backend.rejectNext = fmt.Errorf("invalid nonce; got 3, expected 4")
	worker, store := newWorkerFixture(t, backend, profile)
	address := common.HexToAddress("0x9999999999999999999999999999999999999999")
	request, _, err := store.Accept("reject-key-00", address, time.Now(), "request-1")
	if err != nil {
		t.Fatalf("accept: %v", err)
	}
	done := make(chan struct{})
	go func() {
		worker.process(context.Background(), request.ID)
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(10 * time.Second):
		t.Fatalf("worker did not retry after a broadcast rejection")
	}
	final, _ := store.Get(request.ID)
	if final.Status != StatusConfirmed {
		t.Fatalf("request status = %s (%s)", final.Status, final.Reason)
	}
}

func newServiceFixture(t *testing.T, profile Profile) (*Service, *fakeBackend, context.CancelFunc) {
	t.Helper()
	backend := newFakeBackend(profile.EVMChainID)
	worker, store := newWorkerFixture(t, backend, profile)
	verifier, err := NewStaticVerifier("example-only")
	if err != nil {
		t.Fatalf("build verifier: %v", err)
	}
	key, err := ethcrypto.GenerateKey()
	if err != nil {
		t.Fatalf("generate key: %v", err)
	}
	service := NewService(profile, store, worker.breakers, worker, NewRateLimiter(profile, nil), verifier, NewSigner(key), worker.metrics, nil)
	ctx, cancel := context.WithCancel(context.Background())
	if err := worker.Start(ctx); err != nil {
		cancel()
		t.Fatalf("start worker: %v", err)
	}
	t.Cleanup(cancel)
	return service, backend, cancel
}

func postFund(t *testing.T, server *httptest.Server, body string) (int, map[string]any) {
	t.Helper()
	response, err := http.Post(server.URL+"/v1/fund", "application/json", strings.NewReader(body))
	if err != nil {
		t.Fatalf("post fund: %v", err)
	}
	defer response.Body.Close()
	var payload map[string]any
	if err := json.NewDecoder(response.Body).Decode(&payload); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	return response.StatusCode, payload
}

func TestServiceEndToEndFundReplayAndChallenge(t *testing.T) {
	profile := testProfile(t)
	profile.PerIPBurst = 100
	profile.SubnetBurst = 100
	service, _, _ := newServiceFixture(t, profile)
	server := httptest.NewServer(service.PublicHandler())
	defer server.Close()

	address := "0xAAAAAAaaaaAAAAaaaaAaAaaaaAAAAAaaaaaaaaa1"
	body := fmt.Sprintf(`{"address":%q,"idempotencyKey":"e2e-key-0001","challengeToken":"example-only"}`, address)
	status, payload := postFund(t, server, body)
	if status != http.StatusAccepted {
		t.Fatalf("fund status = %d (%v)", status, payload)
	}
	requestID, _ := payload["id"].(string)
	if requestID == "" {
		t.Fatalf("fund response missing request id: %v", payload)
	}
	deadline := time.Now().Add(5 * time.Second)
	for {
		response, err := http.Get(server.URL + "/v1/requests/" + requestID)
		if err != nil {
			t.Fatalf("poll request: %v", err)
		}
		var polled map[string]any
		if err := json.NewDecoder(response.Body).Decode(&polled); err != nil {
			t.Fatalf("decode poll: %v", err)
		}
		response.Body.Close()
		if polled["status"] == StatusConfirmed {
			if polled["transactionHash"] == "" {
				t.Fatalf("confirmed request must expose its transaction hash")
			}
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("request never confirmed: %v", polled)
		}
		time.Sleep(50 * time.Millisecond)
	}

	replayStatus, replayPayload := postFund(t, server, body)
	if replayStatus != http.StatusOK {
		t.Fatalf("replay status = %d (%v)", replayStatus, replayPayload)
	}
	if replayPayload["id"] != requestID || replayPayload["replayed"] != true {
		t.Fatalf("replay must return the original request: %v", replayPayload)
	}

	badChallenge := fmt.Sprintf(`{"address":%q,"idempotencyKey":"e2e-key-0002","challengeToken":"wrong"}`, address)
	challengeStatus, _ := postFund(t, server, badChallenge)
	if challengeStatus != http.StatusForbidden {
		t.Fatalf("bad challenge status = %d", challengeStatus)
	}

	cooldown := fmt.Sprintf(`{"address":%q,"idempotencyKey":"e2e-key-0003","challengeToken":"example-only"}`, address)
	cooldownStatus, cooldownPayload := postFund(t, server, cooldown)
	if cooldownStatus != http.StatusTooManyRequests {
		t.Fatalf("cooldown status = %d (%v)", cooldownStatus, cooldownPayload)
	}

	metricsRender := service.metrics.Render()
	if !strings.Contains(metricsRender, "torium_public_faucet_requests_total") {
		t.Fatalf("metrics render is missing request counters")
	}
}
