package faucet

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"math/big"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/ethereum/go-ethereum/common"
)

var (
	testRecipient = common.HexToAddress("0x1111111111111111111111111111111111111111")
	testSigner    = common.HexToAddress("0x05ae789955fa1804334e70C74893639592C4fB4f")
)

type fakeFunder struct {
	mu      sync.Mutex
	calls   int
	fail    bool
	amounts []*big.Int
}

func (funder *fakeFunder) Health(context.Context) (Health, error) {
	if funder.fail {
		return Health{}, errors.New("RPC unavailable")
	}
	return Health{
		ChainID:                big.NewInt(1414484556),
		BlockNumber:            12,
		SignerAddress:          testSigner,
		SignerBalanceBaseUnits: mustAmount("900000000000000000000000000"),
	}, nil
}

func (funder *fakeFunder) Fund(_ context.Context, recipient common.Address, amount *big.Int) (Funding, error) {
	funder.mu.Lock()
	defer funder.mu.Unlock()
	funder.calls++
	if funder.fail {
		return Funding{}, errors.New("broadcast failed")
	}
	funder.amounts = append(funder.amounts, new(big.Int).Set(amount))
	return Funding{
		TransactionHash: common.HexToHash("0x1234"),
		BlockHash:       common.HexToHash("0xabcd"),
		BlockNumber:     13,
		ReceiptStatus:   1,
		TransactionType: 2,
		Nonce:           uint64(funder.calls - 1),
		From:            testSigner,
		To:              recipient,
		Amount:          new(big.Int).Set(amount),
	}, nil
}

func TestHealthReportsOnlyPublicChainState(t *testing.T) {
	t.Parallel()

	server := newTestServer(t, &fakeFunder{}, nil)
	response := performRequest(server, http.MethodGet, "/healthz", "")
	if response.Code != http.StatusOK {
		t.Fatalf("health status: got %d, want %d: %s", response.Code, http.StatusOK, response.Body.String())
	}
	var payload map[string]any
	decodeResponse(t, response, &payload)
	if payload["status"] != "ready" || payload["publicUseAllowed"] != false {
		t.Fatalf("unexpected health payload: %#v", payload)
	}
	if payload["signerAddress"] != testSigner.Hex() {
		t.Fatalf("unexpected signer address: %#v", payload["signerAddress"])
	}
	assertNoSecretFields(t, payload)
}

func TestFundingUsesDefaultAndReturnsCanonicalReceiptEvidence(t *testing.T) {
	t.Parallel()

	funder := &fakeFunder{}
	server := newTestServer(t, funder, nil)
	response := performRequest(server, http.MethodPost, "/v1/fund", `{"address":"`+testRecipient.Hex()+`"}`)
	if response.Code != http.StatusCreated {
		t.Fatalf("fund status: got %d, want %d: %s", response.Code, http.StatusCreated, response.Body.String())
	}
	var payload map[string]any
	decodeResponse(t, response, &payload)
	if payload["status"] != "confirmed" || payload["receiptStatus"] != float64(1) || payload["transactionType"] != float64(2) {
		t.Fatalf("unexpected funding payload: %#v", payload)
	}
	if payload["amountBaseUnits"] != DefaultPolicy().DefaultAmount.String() {
		t.Fatalf("default funding amount drift: %#v", payload["amountBaseUnits"])
	}
	assertNoSecretFields(t, payload)
}

func TestCooldownAndPerAddressWindowAreEnforced(t *testing.T) {
	t.Parallel()

	policy := DefaultPolicy()
	policy.DefaultAmount = big.NewInt(10)
	policy.MinimumAmount = big.NewInt(1)
	policy.MaximumAmountPerRequest = big.NewInt(10)
	policy.MaximumAmountPerWindow = big.NewInt(20)
	policy.Cooldown = time.Second
	policy.AddressWindow = time.Hour
	funder := &fakeFunder{}
	server := newTestServer(t, funder, &policy)
	now := time.Date(2026, 7, 14, 12, 0, 0, 0, time.UTC)
	server.now = func() time.Time { return now }
	body := `{"address":"` + testRecipient.Hex() + `","amountBaseUnits":"10"}`

	if response := performRequest(server, http.MethodPost, "/v1/fund", body); response.Code != http.StatusCreated {
		t.Fatalf("initial funding failed: %d %s", response.Code, response.Body.String())
	}
	if response := performRequest(server, http.MethodPost, "/v1/fund", body); response.Code != http.StatusTooManyRequests {
		t.Fatalf("cooldown status: got %d, want %d", response.Code, http.StatusTooManyRequests)
	}
	now = now.Add(2 * time.Second)
	if response := performRequest(server, http.MethodPost, "/v1/fund", body); response.Code != http.StatusCreated {
		t.Fatalf("second funding failed: %d %s", response.Code, response.Body.String())
	}
	now = now.Add(2 * time.Second)
	response := performRequest(server, http.MethodPost, "/v1/fund", body)
	if response.Code != http.StatusTooManyRequests || !strings.Contains(response.Body.String(), errQuota.Error()) {
		t.Fatalf("window quota was not enforced: %d %s", response.Code, response.Body.String())
	}
	if funder.calls != 2 {
		t.Fatalf("limiter allowed %d funding calls, want 2", funder.calls)
	}
}

func TestInvalidInputsAndSecretShapedFieldsAreRejectedWithoutLoggingValues(t *testing.T) {
	t.Parallel()

	secret := "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about"
	privateKey := strings.Repeat("1", 64)
	var logs bytes.Buffer
	logger := slog.New(slog.NewJSONHandler(&logs, nil))
	server := newTestServer(t, &fakeFunder{}, nil)
	server.logger = logger
	mnemonicPayload, err := json.Marshal(map[string]string{"address": testRecipient.Hex(), "mnemonic": secret})
	if err != nil {
		t.Fatalf("encode mnemonic-shaped test request: %v", err)
	}
	privateKeyPayload, err := json.Marshal(map[string]string{"address": testRecipient.Hex(), "privateKey": privateKey})
	if err != nil {
		t.Fatalf("encode private-key-shaped test request: %v", err)
	}
	tests := []string{
		`{}`,
		`{"address":"0x1234"}`,
		`{"address":"0x0000000000000000000000000000000000000000"}`,
		`{"address":"` + testRecipient.Hex() + `","amountBaseUnits":"0"}`,
		`{"address":"` + testRecipient.Hex() + `","amountBaseUnits":"1000000000000000000000000"}`,
		string(mnemonicPayload),
		string(privateKeyPayload),
		`{"address":"` + testRecipient.Hex() + `"}{"address":"` + testRecipient.Hex() + `"}`,
	}
	for _, body := range tests {
		response := performRequest(server, http.MethodPost, "/v1/fund", body)
		if response.Code != http.StatusBadRequest {
			t.Fatalf("invalid body accepted (%s): %d %s", body, response.Code, response.Body.String())
		}
		if strings.Contains(response.Body.String(), secret) || strings.Contains(response.Body.String(), privateKey) {
			t.Fatal("secret-shaped request value was reflected in an error response")
		}
	}
	if strings.Contains(logs.String(), secret) || strings.Contains(logs.String(), privateKey) {
		t.Fatal("secret-shaped request value was written to logs")
	}
}

func TestFailedFundingDoesNotConsumeAddressQuota(t *testing.T) {
	t.Parallel()

	funder := &fakeFunder{fail: true}
	server := newTestServer(t, funder, nil)
	body := `{"address":"` + testRecipient.Hex() + `"}`
	if response := performRequest(server, http.MethodPost, "/v1/fund", body); response.Code != http.StatusServiceUnavailable {
		t.Fatalf("failed funding status: got %d, want %d", response.Code, http.StatusServiceUnavailable)
	}
	funder.fail = false
	if response := performRequest(server, http.MethodPost, "/v1/fund", body); response.Code != http.StatusCreated {
		t.Fatalf("retry after upstream failure was limited: %d %s", response.Code, response.Body.String())
	}
}

func newTestServer(t *testing.T, funder Funder, policy *Policy) *Server {
	t.Helper()
	selected := DefaultPolicy()
	if policy != nil {
		selected = *policy
	}
	server, err := NewServer(funder, selected, nil)
	if err != nil {
		t.Fatalf("construct test server: %v", err)
	}
	return server
}

func performRequest(handler http.Handler, method, target, body string) *httptest.ResponseRecorder {
	request := httptest.NewRequest(method, target, strings.NewReader(body))
	if body != "" {
		request.Header.Set("Content-Type", contentTypeJSON)
	}
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	return response
}

func decodeResponse(t *testing.T, response *httptest.ResponseRecorder, target any) {
	t.Helper()
	if err := json.Unmarshal(response.Body.Bytes(), target); err != nil {
		t.Fatalf("decode response: %v: %s", err, response.Body.String())
	}
}

func assertNoSecretFields(t *testing.T, payload map[string]any) {
	t.Helper()
	for _, forbidden := range []string{"privateKey", "mnemonic", "rawTransaction", "signedTransaction"} {
		if _, exists := payload[forbidden]; exists {
			t.Fatalf("response contains forbidden field %q", forbidden)
		}
	}
}
