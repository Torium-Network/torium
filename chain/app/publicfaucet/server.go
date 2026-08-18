package publicfaucet

import (
	"crypto/ecdsa"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"math/big"
	"net/http"
	"net/netip"
	"os"
	"strings"
	"time"

	"github.com/ethereum/go-ethereum/common"
	ethcrypto "github.com/ethereum/go-ethereum/crypto"
)

// Service composes the public faucet: store, limits, breakers, worker,
// challenge verification, and the two HTTP surfaces.
type Service struct {
	profile  Profile
	store    *Store
	breakers *Breakers
	worker   *Worker
	limiter  *RateLimiter
	verifier ChallengeVerifier
	signer   *Signer
	metrics  *Metrics
	logger   *slog.Logger
	now      func() time.Time
	// trustedProxies lists the reverse-proxy source ranges whose
	// X-Forwarded-For header identifies the real client. Empty means the
	// direct peer address is the client (the default, fail-closed posture).
	trustedProxies []netip.Prefix
}

// NewService wires one service instance from prepared components.
func NewService(profile Profile, store *Store, breakers *Breakers, worker *Worker, limiter *RateLimiter, verifier ChallengeVerifier, signer *Signer, metrics *Metrics, logger *slog.Logger) *Service {
	if logger == nil {
		logger = slog.New(slog.NewTextHandler(io.Discard, nil))
	}
	return &Service{
		profile:  profile,
		store:    store,
		breakers: breakers,
		worker:   worker,
		limiter:  limiter,
		verifier: verifier,
		signer:   signer,
		metrics:  metrics,
		logger:   logger,
		now:      time.Now,
	}
}

// SetTrustedProxies configures the reverse-proxy ranges allowed to assert
// the client address via X-Forwarded-For. Call before serving traffic.
func (service *Service) SetTrustedProxies(prefixes []netip.Prefix) {
	service.trustedProxies = append([]netip.Prefix(nil), prefixes...)
}

// ParseTrustedProxies parses a comma-separated list of CIDR ranges (a bare
// IP is accepted as a single-address range).
func ParseTrustedProxies(list string) ([]netip.Prefix, error) {
	var prefixes []netip.Prefix
	for _, entry := range strings.Split(list, ",") {
		entry = strings.TrimSpace(entry)
		if entry == "" {
			continue
		}
		if prefix, err := netip.ParsePrefix(entry); err == nil {
			prefixes = append(prefixes, prefix.Masked())
			continue
		}
		address, err := netip.ParseAddr(entry)
		if err != nil {
			return nil, fmt.Errorf("trusted proxy %q is neither a CIDR nor an IP address", entry)
		}
		prefixes = append(prefixes, netip.PrefixFrom(address, address.BitLen()))
	}
	return prefixes, nil
}

// PublicHandler serves the internet-facing API surface.
func (service *Service) PublicHandler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", service.handleHealth)
	mux.HandleFunc("/v1/fund", service.handleFund)
	mux.HandleFunc("/v1/requests/", service.handleRequestStatus)
	return service.harden(mux)
}

// AdminHandler serves the operator-only surface; the caller must bind it to
// a loopback or isolated-container address.
func (service *Service) AdminHandler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/admin/pause", service.handlePause)
	mux.HandleFunc("/admin/resume", service.handleResume)
	mux.HandleFunc("/admin/rotate", service.handleRotate)
	mux.HandleFunc("/admin/drain", service.handleDrain)
	mux.HandleFunc("/metrics", service.handleMetrics)
	return service.harden(mux)
}

func (service *Service) harden(next http.Handler) http.Handler {
	return http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		writer.Header().Set("Cache-Control", "no-store")
		writer.Header().Set("X-Content-Type-Options", "nosniff")
		writer.Header().Set("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'")
		if service.profile.AllowedOrigin != "" {
			writer.Header().Set("Access-Control-Allow-Origin", service.profile.AllowedOrigin)
			writer.Header().Set("Vary", "Origin")
		}
		if request.Method == http.MethodOptions {
			writer.Header().Set("Access-Control-Allow-Methods", "GET, POST")
			writer.Header().Set("Access-Control-Allow-Headers", "content-type")
			writer.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(writer, request)
	})
}

type fundInput struct {
	Address        string `json:"address"`
	IdempotencyKey string `json:"idempotencyKey"`
	ChallengeToken string `json:"challengeToken"`
}

func (service *Service) handleFund(writer http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodPost {
		service.methodNotAllowed(writer, http.MethodPost)
		return
	}
	request.Body = http.MaxBytesReader(writer, request.Body, service.profile.MaximumBodyBytes)
	decoder := json.NewDecoder(request.Body)
	decoder.DisallowUnknownFields()
	var input fundInput
	if err := decoder.Decode(&input); err != nil {
		service.deny(writer, http.StatusBadRequest, "request body must be one valid JSON object within the size limit")
		return
	}
	if err := ensureEOF(decoder); err != nil {
		service.deny(writer, http.StatusBadRequest, "request body must contain exactly one JSON object")
		return
	}
	recipient, err := parseAddress(input.Address)
	if err != nil {
		service.deny(writer, http.StatusBadRequest, err.Error())
		return
	}
	if err := validateIdempotencyKey(input.IdempotencyKey); err != nil {
		service.deny(writer, http.StatusBadRequest, err.Error())
		return
	}
	source, err := service.clientAddress(request)
	if err != nil {
		service.deny(writer, http.StatusBadRequest, "client address is unreadable")
		return
	}
	if reason := service.limiter.Admit(source); reason != "" {
		if strings.Contains(reason, "denylisted") {
			service.metrics.IncrementDenylistHit()
		}
		service.metrics.IncrementDenial(reason)
		service.metrics.IncrementRequest("rate-limited")
		service.deny(writer, http.StatusTooManyRequests, reason)
		return
	}
	if input.ChallengeToken == "" {
		service.metrics.IncrementChallengeFailure()
		service.metrics.IncrementRequest("challenge-failed")
		service.deny(writer, http.StatusForbidden, "challenge token is required")
		return
	}
	passed, err := service.verifier.Verify(request.Context(), input.ChallengeToken)
	if err != nil {
		service.metrics.IncrementRequest("challenge-error")
		service.deny(writer, http.StatusServiceUnavailable, "challenge verification is unavailable")
		return
	}
	if !passed {
		service.metrics.IncrementChallengeFailure()
		service.metrics.IncrementRequest("challenge-failed")
		service.deny(writer, http.StatusForbidden, "challenge verification failed")
		return
	}
	now := service.now().UTC()
	// Replays are status reads and must keep working while breakers are
	// open or the service is paused.
	if existing, ok := service.store.FindReplay(input.IdempotencyKey, recipient, now); ok {
		service.metrics.IncrementRequest("replayed")
		service.respond(writer, http.StatusOK, service.requestPayload(*existing, true))
		return
	}
	state := service.breakers.Evaluate(service.store.SpentToday(now))
	service.publishBreakerMetrics(state)
	if state.OpenReason != "" {
		service.metrics.IncrementDenial(state.OpenReason)
		service.metrics.IncrementRequest("breaker-open")
		service.deny(writer, http.StatusServiceUnavailable, state.OpenReason)
		return
	}
	requestID, err := newRequestID()
	if err != nil {
		service.deny(writer, http.StatusInternalServerError, "request identifier generation failed")
		return
	}
	accepted, replayed, err := service.store.Accept(input.IdempotencyKey, recipient, now, requestID)
	if err != nil {
		var denial *DenialError
		if errors.As(err, &denial) {
			service.metrics.IncrementDenial(denial.Reason)
			service.metrics.IncrementRequest("denied")
			if denial.RetryAfterSeconds > 0 {
				writer.Header().Set("Retry-After", fmt.Sprintf("%d", denial.RetryAfterSeconds))
			}
			service.deny(writer, http.StatusTooManyRequests, denial.Reason)
			return
		}
		service.logger.ErrorContext(request.Context(), "public faucet accept failed", "error", err.Error())
		service.deny(writer, http.StatusInternalServerError, "request could not be recorded")
		return
	}
	if replayed {
		service.metrics.IncrementRequest("replayed")
		service.respond(writer, http.StatusOK, service.requestPayload(*accepted, true))
		return
	}
	if !service.worker.TryEnqueue(accepted.ID) {
		_ = service.store.RecordFailed(accepted.ID, "queue is full", now)
		service.metrics.IncrementDenial("queue is full")
		service.metrics.IncrementRequest("queue-full")
		service.deny(writer, http.StatusServiceUnavailable, "funding queue is full; retry later")
		return
	}
	service.metrics.IncrementRequest("accepted")
	service.respond(writer, http.StatusAccepted, service.requestPayload(*accepted, false))
}

func (service *Service) handleRequestStatus(writer http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodGet {
		service.methodNotAllowed(writer, http.MethodGet)
		return
	}
	requestID := strings.TrimPrefix(request.URL.Path, "/v1/requests/")
	if requestID == "" || strings.Contains(requestID, "/") {
		service.deny(writer, http.StatusBadRequest, "request identifier is required")
		return
	}
	found, ok := service.store.Get(requestID)
	if !ok {
		service.deny(writer, http.StatusNotFound, "unknown request identifier")
		return
	}
	service.respond(writer, http.StatusOK, service.requestPayload(found, false))
}

func (service *Service) handleHealth(writer http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodGet {
		service.methodNotAllowed(writer, http.MethodGet)
		return
	}
	now := service.now().UTC()
	spent := service.store.SpentToday(now)
	state := service.breakers.Evaluate(spent)
	service.publishBreakerMetrics(state)
	paused, pauseReason := service.store.Paused()
	remaining := new(big.Int).Sub(service.profile.GlobalDailyBudget, spent)
	if remaining.Sign() < 0 {
		remaining.SetInt64(0)
	}
	service.metrics.SetBudgetRemaining(remaining)
	status := "ready"
	if state.OpenReason != "" {
		status = "degraded"
	}
	if paused {
		status = "paused"
	}
	balance := service.breakers.Balance()
	payload := map[string]any{
		"status":                       status,
		"notice":                       Notice,
		"network":                      service.profile.CosmosChainID,
		"evmChainId":                   service.profile.EVMChainID.String(),
		"challengeMode":                string(service.verifier.Mode()),
		"signerAddress":                service.signer.Address().Hex(),
		"amountPerRequestBaseUnits":    service.profile.AmountPerRequest.String(),
		"cooldownPerAddressSeconds":    int64(service.profile.CooldownPerAddress / time.Second),
		"perAddressDailyCap":           service.profile.PerAddressDailyCap,
		"globalDailyBudgetBaseUnits":   service.profile.GlobalDailyBudget.String(),
		"budgetRemainingBaseUnits":     remaining.String(),
		"queueDepth":                   service.worker.QueueDepth(),
		"paused":                       paused,
		"breakerOpenReason":            state.OpenReason,
		"publicDeploymentAllowed":      false,
		"balanceBelowRefillThreshold":  balance != nil && balance.Cmp(service.profile.RefillBelow) < 0,
		"balanceBelowAlertThreshold":   balance != nil && balance.Cmp(service.profile.AlertBelow) < 0,
		"balanceBelowHaltThreshold":    balance != nil && balance.Cmp(service.profile.HaltBelow) < 0,
	}
	if pauseReason != "" {
		payload["pauseReason"] = pauseReason
	}
	if balance != nil {
		payload["hotBalanceBaseUnits"] = balance.String()
	}
	code := http.StatusOK
	if status != "ready" {
		code = http.StatusServiceUnavailable
	}
	service.respond(writer, code, payload)
}

func (service *Service) handlePause(writer http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodPost {
		service.methodNotAllowed(writer, http.MethodPost)
		return
	}
	var input struct {
		Reason string `json:"reason"`
	}
	if err := decodeAdminBody(writer, request, &input); err != nil {
		service.deny(writer, http.StatusBadRequest, err.Error())
		return
	}
	if input.Reason == "" {
		input.Reason = "operator pause"
	}
	if err := service.store.Pause(input.Reason, service.now()); err != nil {
		service.deny(writer, http.StatusInternalServerError, err.Error())
		return
	}
	service.respond(writer, http.StatusOK, map[string]any{"paused": true, "reason": input.Reason, "notice": Notice})
}

func (service *Service) handleResume(writer http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodPost {
		service.methodNotAllowed(writer, http.MethodPost)
		return
	}
	if err := service.store.Resume(service.now()); err != nil {
		service.deny(writer, http.StatusInternalServerError, err.Error())
		return
	}
	service.breakers.ResetErrorWindow()
	service.respond(writer, http.StatusOK, map[string]any{"paused": false, "notice": Notice})
}

func (service *Service) handleRotate(writer http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodPost {
		service.methodNotAllowed(writer, http.MethodPost)
		return
	}
	var input struct {
		KeyFile string `json:"keyFile"`
	}
	if err := decodeAdminBody(writer, request, &input); err != nil {
		service.deny(writer, http.StatusBadRequest, err.Error())
		return
	}
	privateKey, err := LoadSignerKeyFile(input.KeyFile)
	if err != nil {
		service.deny(writer, http.StatusBadRequest, err.Error())
		return
	}
	newAddress := ethcrypto.PubkeyToAddress(privateKey.PublicKey)
	if service.store.SignerFenced(newAddress) {
		service.deny(writer, http.StatusConflict, "replacement key was previously fenced and can never sign again")
		return
	}
	if newAddress == service.signer.Address() {
		service.deny(writer, http.StatusConflict, "replacement key matches the active signer")
		return
	}
	oldAddress := service.signer.Rotate(privateKey)
	if err := service.store.RecordRotation(oldAddress, newAddress, service.now()); err != nil {
		service.deny(writer, http.StatusInternalServerError, err.Error())
		return
	}
	service.breakers.ResetErrorWindow()
	service.respond(writer, http.StatusOK, map[string]any{
		"rotated":   true,
		"oldSigner": oldAddress.Hex(),
		"newSigner": newAddress.Hex(),
		"notice":    Notice,
	})
}

func (service *Service) handleDrain(writer http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodPost {
		service.methodNotAllowed(writer, http.MethodPost)
		return
	}
	var input struct {
		ReserveAddress string `json:"reserveAddress"`
	}
	if err := decodeAdminBody(writer, request, &input); err != nil {
		service.deny(writer, http.StatusBadRequest, err.Error())
		return
	}
	reserve, err := parseAddress(input.ReserveAddress)
	if err != nil {
		service.deny(writer, http.StatusBadRequest, err.Error())
		return
	}
	hash, value, err := service.worker.Drain(request.Context(), reserve)
	if err != nil {
		service.deny(writer, http.StatusConflict, err.Error())
		return
	}
	service.respond(writer, http.StatusOK, map[string]any{
		"drained":         true,
		"transactionHash": hash.Hex(),
		"amountBaseUnits": value.String(),
		"reserveAddress":  reserve.Hex(),
		"notice":          Notice,
	})
}

func (service *Service) handleMetrics(writer http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodGet {
		service.methodNotAllowed(writer, http.MethodGet)
		return
	}
	now := service.now().UTC()
	spent := service.store.SpentToday(now)
	remaining := new(big.Int).Sub(service.profile.GlobalDailyBudget, spent)
	if remaining.Sign() < 0 {
		remaining.SetInt64(0)
	}
	service.metrics.SetBudgetRemaining(remaining)
	service.metrics.SetQueueDepth(service.worker.QueueDepth())
	service.publishBreakerMetrics(service.breakers.Evaluate(spent))
	writer.Header().Set("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
	writer.WriteHeader(http.StatusOK)
	_, _ = io.WriteString(writer, service.metrics.Render())
}

func (service *Service) publishBreakerMetrics(state BreakerState) {
	service.metrics.SetBreaker("rpc-down", state.RPCDown)
	service.metrics.SetBreaker("error-rate", state.ErrorRateTripped)
	service.metrics.SetBreaker("balance-floor", state.BalanceFloor)
	service.metrics.SetBreaker("budget-spent", state.BudgetSpent)
}

func (service *Service) requestPayload(request Request, replayed bool) map[string]any {
	payload := map[string]any{
		"id":              request.ID,
		"status":          request.Status,
		"address":         request.Address,
		"amountBaseUnits": request.AmountBaseUnits,
		"createdAt":       request.CreatedAt.Format(time.RFC3339),
		"updatedAt":       request.UpdatedAt.Format(time.RFC3339),
		"network":         service.profile.CosmosChainID,
		"evmChainId":      service.profile.EVMChainID.String(),
		"notice":          Notice,
	}
	if replayed {
		payload["replayed"] = true
	}
	if request.Reason != "" {
		payload["reason"] = request.Reason
	}
	if request.TransactionHash != "" {
		payload["transactionHash"] = request.TransactionHash
	}
	if request.BlockNumber > 0 {
		payload["blockNumber"] = request.BlockNumber
	}
	return payload
}

func (service *Service) deny(writer http.ResponseWriter, status int, message string) {
	service.respond(writer, status, map[string]any{"error": message, "notice": Notice})
}

func (service *Service) respond(writer http.ResponseWriter, status int, payload any) {
	writer.Header().Set("Content-Type", "application/json")
	writer.WriteHeader(status)
	_ = json.NewEncoder(writer).Encode(payload)
}

func (service *Service) methodNotAllowed(writer http.ResponseWriter, allowed string) {
	writer.Header().Set("Allow", allowed)
	service.deny(writer, http.StatusMethodNotAllowed, "method not allowed")
}

func decodeAdminBody(writer http.ResponseWriter, request *http.Request, target any) error {
	request.Body = http.MaxBytesReader(writer, request.Body, 4096)
	decoder := json.NewDecoder(request.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		if errors.Is(err, io.EOF) {
			return nil
		}
		return fmt.Errorf("request body must be one valid JSON object")
	}
	return ensureEOF(decoder)
}

func ensureEOF(decoder *json.Decoder) error {
	var extra any
	err := decoder.Decode(&extra)
	if errors.Is(err, io.EOF) {
		return nil
	}
	if err == nil {
		return fmt.Errorf("request body must contain exactly one JSON object")
	}
	return err
}

func parseAddress(value string) (common.Address, error) {
	if len(value) != 42 || !strings.HasPrefix(value, "0x") || !common.IsHexAddress(value) {
		return common.Address{}, fmt.Errorf("address must be an exact 20-byte 0x-prefixed EVM address")
	}
	address := common.HexToAddress(value)
	if address == (common.Address{}) {
		return common.Address{}, fmt.Errorf("the zero address cannot receive funds")
	}
	return address, nil
}

func validateIdempotencyKey(key string) error {
	if len(key) < 8 || len(key) > 128 {
		return fmt.Errorf("idempotencyKey must be between 8 and 128 characters")
	}
	for _, character := range key {
		if character >= 'a' && character <= 'z' || character >= 'A' && character <= 'Z' ||
			character >= '0' && character <= '9' || character == '-' || character == '_' {
			continue
		}
		return fmt.Errorf("idempotencyKey may only contain letters, digits, dashes, and underscores")
	}
	return nil
}

func (service *Service) clientAddress(request *http.Request) (netip.Addr, error) {
	addrPort, err := netip.ParseAddrPort(request.RemoteAddr)
	if err != nil {
		return netip.Addr{}, err
	}
	peer := addrPort.Addr().Unmap()
	trusted := false
	for _, prefix := range service.trustedProxies {
		if prefix.Contains(peer) {
			trusted = true
			break
		}
	}
	if !trusted {
		// Only the direct peer address is trusted by default; a client
		// cannot spoof it and any X-Forwarded-For it sends is ignored.
		return peer, nil
	}
	// The peer is one of the operator-declared reverse proxies. The proxy
	// APPENDS the address it observed, so the RIGHTMOST X-Forwarded-For
	// entry is proxy-written and client-forgery-proof; earlier entries are
	// untrusted client input and are ignored. A trusted proxy that sends no
	// header is a misconfiguration and fails closed.
	header := request.Header.Get("X-Forwarded-For")
	entries := strings.Split(header, ",")
	last := strings.TrimSpace(entries[len(entries)-1])
	if last == "" {
		return netip.Addr{}, fmt.Errorf("trusted proxy %s sent no X-Forwarded-For entry", peer)
	}
	if address, err := netip.ParseAddr(last); err == nil {
		return address.Unmap(), nil
	}
	forwarded, err := netip.ParseAddrPort(last)
	if err != nil {
		return netip.Addr{}, fmt.Errorf("trusted proxy %s sent an unparseable client address", peer)
	}
	return forwarded.Addr().Unmap(), nil
}

func newRequestID() (string, error) {
	buffer := make([]byte, 16)
	if _, err := rand.Read(buffer); err != nil {
		return "", err
	}
	return hex.EncodeToString(buffer), nil
}

// LoadSignerKeyFile reads a 0x-prefixed 32-byte hex key from a file that
// must not be group or world readable.
func LoadSignerKeyFile(path string) (*ecdsa.PrivateKey, error) {
	if path == "" {
		return nil, fmt.Errorf("signer key file path is required")
	}
	info, err := os.Stat(path)
	if err != nil {
		return nil, fmt.Errorf("read signer key file: %w", err)
	}
	if info.Mode().Perm()&0o077 != 0 {
		return nil, fmt.Errorf("signer key file must not be group or world accessible")
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read signer key file: %w", err)
	}
	encoded := strings.TrimSpace(string(raw))
	encoded = strings.TrimPrefix(encoded, "0x")
	if len(encoded) != 64 {
		return nil, fmt.Errorf("signer key file must contain one 32-byte hex private key")
	}
	key, err := ethcrypto.HexToECDSA(encoded)
	if err != nil {
		return nil, fmt.Errorf("signer key file is not a valid secp256k1 key")
	}
	return key, nil
}
