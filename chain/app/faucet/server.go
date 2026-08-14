package faucet

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"math/big"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/ethereum/go-ethereum/common"
)

const (
	contentTypeJSON = "application/json"
	baseDenom       = "atorium"
	displayDenom    = "tTOR"
)

var (
	errCooldown = errors.New("address is in faucet cooldown")
	errQuota    = errors.New("address funding window limit exceeded")
)

type fundingRequest struct {
	Address         string `json:"address"`
	AmountBaseUnits string `json:"amountBaseUnits,omitempty"`
}

type fundingRecord struct {
	at     time.Time
	amount *big.Int
}

type addressLimiter struct {
	mu      sync.Mutex
	records map[common.Address][]fundingRecord
}

// Server exposes the two-method local faucet HTTP API.
type Server struct {
	funder  Funder
	policy  Policy
	logger  *slog.Logger
	now     func() time.Time
	limiter addressLimiter
	mux     *http.ServeMux
}

// NewServer constructs a strict local faucet handler.
func NewServer(funder Funder, policy Policy, logger *slog.Logger) (*Server, error) {
	if funder == nil {
		return nil, fmt.Errorf("faucet funder is required")
	}
	if err := policy.Validate(); err != nil {
		return nil, err
	}
	if logger == nil {
		logger = slog.New(slog.NewTextHandler(io.Discard, nil))
	}
	server := &Server{
		funder: funder,
		policy: policy,
		logger: logger,
		now:    time.Now,
		limiter: addressLimiter{
			records: make(map[common.Address][]fundingRecord),
		},
		mux: http.NewServeMux(),
	}
	server.mux.HandleFunc("/healthz", server.handleHealth)
	server.mux.HandleFunc("/v1/fund", server.handleFund)
	return server, nil
}

// ServeHTTP applies response hardening before routing the request.
func (server *Server) ServeHTTP(writer http.ResponseWriter, request *http.Request) {
	writer.Header().Set("Cache-Control", "no-store")
	writer.Header().Set("X-Content-Type-Options", "nosniff")
	writer.Header().Set("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'")
	server.mux.ServeHTTP(writer, request)
}

func (server *Server) handleHealth(writer http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodGet {
		methodNotAllowed(writer, http.MethodGet)
		return
	}
	health, err := server.funder.Health(request.Context())
	if err != nil {
		server.logger.WarnContext(request.Context(), "local faucet health check failed", "error", err.Error())
		writeJSON(writer, http.StatusServiceUnavailable, map[string]any{
			"status":  "unavailable",
			"warning": Warning,
		})
		return
	}
	writeJSON(writer, http.StatusOK, map[string]any{
		"status":                     "ready",
		"warning":                    Warning,
		"network":                    "torium-localnet-1",
		"evmChainId":                 health.ChainID.String(),
		"blockNumber":                health.BlockNumber,
		"signerAddress":              health.SignerAddress.Hex(),
		"signerBalanceBaseUnits":     health.SignerBalanceBaseUnits.String(),
		"baseDenom":                  baseDenom,
		"displayDenom":               displayDenom,
		"defaultAmountBaseUnits":     server.policy.DefaultAmount.String(),
		"minimumAmountBaseUnits":     server.policy.MinimumAmount.String(),
		"maximumAmountBaseUnits":     server.policy.MaximumAmountPerRequest.String(),
		"cooldownSeconds":            int64(server.policy.Cooldown / time.Second),
		"addressWindowSeconds":       int64(server.policy.AddressWindow / time.Second),
		"maximumAddressWindowAmount": server.policy.MaximumAmountPerWindow.String(),
		"publicUseAllowed":           false,
	})
}

func (server *Server) handleFund(writer http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodPost {
		methodNotAllowed(writer, http.MethodPost)
		return
	}
	request.Body = http.MaxBytesReader(writer, request.Body, server.policy.MaximumBodyBytes)
	decoder := json.NewDecoder(request.Body)
	decoder.DisallowUnknownFields()
	var input fundingRequest
	if err := decoder.Decode(&input); err != nil {
		writeInputError(writer, "request body must be one valid JSON object within the local faucet size limit")
		return
	}
	if err := ensureJSONEOF(decoder); err != nil {
		writeInputError(writer, "request body must contain exactly one JSON object")
		return
	}
	recipient, err := parseRecipient(input.Address)
	if err != nil {
		writeInputError(writer, err.Error())
		return
	}
	amount, err := server.parseAmount(input.AmountBaseUnits)
	if err != nil {
		writeInputError(writer, err.Error())
		return
	}

	now := server.now().UTC()
	server.limiter.mu.Lock()
	retryAfter, limitErr := server.limiter.checkLocked(recipient, amount, now, server.policy)
	if limitErr != nil {
		server.limiter.mu.Unlock()
		retrySeconds := max(1, int64((retryAfter+time.Second-1)/time.Second))
		writer.Header().Set("Retry-After", strconv.FormatInt(retrySeconds, 10))
		writeJSON(writer, http.StatusTooManyRequests, map[string]any{
			"error":             limitErr.Error(),
			"retryAfterSeconds": retrySeconds,
			"warning":           Warning,
		})
		return
	}
	funding, err := server.funder.Fund(request.Context(), recipient, amount)
	if err != nil {
		server.limiter.mu.Unlock()
		server.logger.ErrorContext(request.Context(), "local faucet transaction failed", "recipient", recipient.Hex(), "amountBaseUnits", amount.String(), "error", err.Error())
		writeJSON(writer, http.StatusServiceUnavailable, map[string]any{
			"error":   "local faucet could not confirm a funding transaction",
			"warning": Warning,
		})
		return
	}
	server.limiter.recordLocked(recipient, amount, now)
	server.limiter.mu.Unlock()

	server.logger.InfoContext(request.Context(), "local faucet transaction confirmed", "recipient", recipient.Hex(), "amountBaseUnits", amount.String(), "transactionHash", funding.TransactionHash.Hex(), "blockNumber", funding.BlockNumber)
	writeJSON(writer, http.StatusCreated, map[string]any{
		"status":          "confirmed",
		"warning":         Warning,
		"network":         "torium-localnet-1",
		"evmChainId":      "1414484556",
		"baseDenom":       baseDenom,
		"displayDenom":    displayDenom,
		"recipient":       funding.To.Hex(),
		"from":            funding.From.Hex(),
		"amountBaseUnits": funding.Amount.String(),
		"transactionHash": funding.TransactionHash.Hex(),
		"blockHash":       funding.BlockHash.Hex(),
		"blockNumber":     funding.BlockNumber,
		"receiptStatus":   funding.ReceiptStatus,
		"transactionType": funding.TransactionType,
		"nonce":           funding.Nonce,
	})
}

func (server *Server) parseAmount(value string) (*big.Int, error) {
	if value == "" {
		return new(big.Int).Set(server.policy.DefaultAmount), nil
	}
	if strings.TrimSpace(value) != value || value == "" {
		return nil, fmt.Errorf("amountBaseUnits must be an unsigned base-10 integer string")
	}
	for _, character := range value {
		if character < '0' || character > '9' {
			return nil, fmt.Errorf("amountBaseUnits must be an unsigned base-10 integer string")
		}
	}
	amount, ok := new(big.Int).SetString(value, 10)
	if !ok || amount.Sign() <= 0 {
		return nil, fmt.Errorf("amountBaseUnits must be positive")
	}
	if amount.Cmp(server.policy.MinimumAmount) < 0 {
		return nil, fmt.Errorf("amountBaseUnits is below the local faucet minimum of %s", server.policy.MinimumAmount)
	}
	if amount.Cmp(server.policy.MaximumAmountPerRequest) > 0 {
		return nil, fmt.Errorf("amountBaseUnits exceeds the local faucet per-request maximum of %s", server.policy.MaximumAmountPerRequest)
	}
	return amount, nil
}

func (limiter *addressLimiter) checkLocked(recipient common.Address, amount *big.Int, now time.Time, policy Policy) (time.Duration, error) {
	records := limiter.records[recipient]
	windowStart := now.Add(-policy.AddressWindow)
	kept := records[:0]
	total := new(big.Int)
	for _, record := range records {
		if record.at.After(windowStart) {
			kept = append(kept, record)
			total.Add(total, record.amount)
		}
	}
	limiter.records[recipient] = kept
	if len(kept) > 0 {
		last := kept[len(kept)-1]
		cooldownEnds := last.at.Add(policy.Cooldown)
		if now.Before(cooldownEnds) {
			return cooldownEnds.Sub(now), errCooldown
		}
	}
	if new(big.Int).Add(total, amount).Cmp(policy.MaximumAmountPerWindow) > 0 {
		return kept[0].at.Add(policy.AddressWindow).Sub(now), errQuota
	}
	return 0, nil
}

func (limiter *addressLimiter) recordLocked(recipient common.Address, amount *big.Int, now time.Time) {
	limiter.records[recipient] = append(limiter.records[recipient], fundingRecord{
		at:     now,
		amount: new(big.Int).Set(amount),
	})
}

func parseRecipient(value string) (common.Address, error) {
	if len(value) != 42 || !strings.HasPrefix(value, "0x") || !common.IsHexAddress(value) {
		return common.Address{}, fmt.Errorf("address must be an exact 20-byte 0x-prefixed EVM address")
	}
	address := common.HexToAddress(value)
	if address == (common.Address{}) {
		return common.Address{}, fmt.Errorf("zero address cannot receive local faucet funds")
	}
	return address, nil
}

func ensureJSONEOF(decoder *json.Decoder) error {
	var extra any
	err := decoder.Decode(&extra)
	if errors.Is(err, io.EOF) {
		return nil
	}
	if err == nil {
		return fmt.Errorf("additional JSON value")
	}
	return err
}

func methodNotAllowed(writer http.ResponseWriter, allowed string) {
	writer.Header().Set("Allow", allowed)
	writeJSON(writer, http.StatusMethodNotAllowed, map[string]any{
		"error":   "method not allowed",
		"warning": Warning,
	})
}

func writeInputError(writer http.ResponseWriter, message string) {
	writeJSON(writer, http.StatusBadRequest, map[string]any{
		"error":   message,
		"warning": Warning,
	})
}

func writeJSON(writer http.ResponseWriter, status int, payload any) {
	writer.Header().Set("Content-Type", contentTypeJSON)
	writer.WriteHeader(status)
	_ = json.NewEncoder(writer).Encode(payload)
}
