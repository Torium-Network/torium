package publicfaucet

import (
	"fmt"
	"math/big"
	"sort"
	"strings"
	"sync"
	"time"
)

// Metrics is a dependency-free Prometheus text exposition registry covering
// the design contract's metric list: requests, denials by reason, latency,
// transaction outcomes, confirmation lag, hot balance, budget remaining,
// queue depth, abuse signals, and RPC/signer health.
type Metrics struct {
	mu                  sync.Mutex
	requestsByOutcome   map[string]uint64
	denialsByReason     map[string]uint64
	txByOutcome         map[string]uint64
	challengeFailures   uint64
	denylistHits        uint64
	rpcErrors           uint64
	queueDepth          int
	hotBalanceBaseUnits *big.Int
	budgetRemaining     *big.Int
	confirmationLagSum  float64
	confirmationLagN    uint64
	breakerOpen         map[string]bool
}

// NewMetrics builds an empty registry.
func NewMetrics() *Metrics {
	return &Metrics{
		requestsByOutcome: make(map[string]uint64),
		denialsByReason:   make(map[string]uint64),
		txByOutcome:       make(map[string]uint64),
		breakerOpen:       make(map[string]bool),
	}
}

// IncrementRequest counts one API request by outcome label.
func (metrics *Metrics) IncrementRequest(outcome string) {
	metrics.mu.Lock()
	defer metrics.mu.Unlock()
	metrics.requestsByOutcome[outcome]++
}

// IncrementDenial counts one denial by normalized reason.
func (metrics *Metrics) IncrementDenial(reason string) {
	metrics.mu.Lock()
	defer metrics.mu.Unlock()
	metrics.denialsByReason[normalizeLabel(reason)]++
}

// IncrementTxOutcome counts one funding transaction outcome.
func (metrics *Metrics) IncrementTxOutcome(outcome string) {
	metrics.mu.Lock()
	defer metrics.mu.Unlock()
	metrics.txByOutcome[outcome]++
}

// IncrementChallengeFailure counts one failed liveness challenge.
func (metrics *Metrics) IncrementChallengeFailure() {
	metrics.mu.Lock()
	defer metrics.mu.Unlock()
	metrics.challengeFailures++
}

// IncrementDenylistHit counts one denylisted source.
func (metrics *Metrics) IncrementDenylistHit() {
	metrics.mu.Lock()
	defer metrics.mu.Unlock()
	metrics.denylistHits++
}

// IncrementRPCError counts one RPC failure.
func (metrics *Metrics) IncrementRPCError() {
	metrics.mu.Lock()
	defer metrics.mu.Unlock()
	metrics.rpcErrors++
}

// SetQueueDepth records the current queue occupancy.
func (metrics *Metrics) SetQueueDepth(depth int) {
	metrics.mu.Lock()
	defer metrics.mu.Unlock()
	metrics.queueDepth = depth
}

// SetHotBalance records the observed signer balance.
func (metrics *Metrics) SetHotBalance(balance *big.Int) {
	metrics.mu.Lock()
	defer metrics.mu.Unlock()
	metrics.hotBalanceBaseUnits = new(big.Int).Set(balance)
}

// SetBudgetRemaining records the remaining daily budget.
func (metrics *Metrics) SetBudgetRemaining(remaining *big.Int) {
	metrics.mu.Lock()
	defer metrics.mu.Unlock()
	metrics.budgetRemaining = new(big.Int).Set(remaining)
}

// ObserveConfirmationLag records accept-to-confirm latency.
func (metrics *Metrics) ObserveConfirmationLag(lag time.Duration) {
	metrics.mu.Lock()
	defer metrics.mu.Unlock()
	metrics.confirmationLagSum += lag.Seconds()
	metrics.confirmationLagN++
}

// SetBreaker records one breaker's open state.
func (metrics *Metrics) SetBreaker(name string, open bool) {
	metrics.mu.Lock()
	defer metrics.mu.Unlock()
	metrics.breakerOpen[name] = open
}

// Render emits the Prometheus text exposition format.
func (metrics *Metrics) Render() string {
	metrics.mu.Lock()
	defer metrics.mu.Unlock()
	var builder strings.Builder
	writeCounterFamily(&builder, "torium_public_faucet_requests_total", "Funding API requests by outcome.", "outcome", metrics.requestsByOutcome)
	writeCounterFamily(&builder, "torium_public_faucet_denials_total", "Denied funding requests by reason.", "reason", metrics.denialsByReason)
	writeCounterFamily(&builder, "torium_public_faucet_transactions_total", "Funding transaction outcomes.", "outcome", metrics.txByOutcome)
	writeScalar(&builder, "torium_public_faucet_challenge_failures_total", "Failed liveness challenges.", "counter", float64(metrics.challengeFailures))
	writeScalar(&builder, "torium_public_faucet_denylist_hits_total", "Requests from denylisted sources.", "counter", float64(metrics.denylistHits))
	writeScalar(&builder, "torium_public_faucet_rpc_errors_total", "Chain RPC failures.", "counter", float64(metrics.rpcErrors))
	writeScalar(&builder, "torium_public_faucet_queue_depth", "Bounded funding queue occupancy.", "gauge", float64(metrics.queueDepth))
	if metrics.hotBalanceBaseUnits != nil {
		writeScalar(&builder, "torium_public_faucet_hot_balance_base_units", "Observed hot signer balance.", "gauge", bigToFloat(metrics.hotBalanceBaseUnits))
	}
	if metrics.budgetRemaining != nil {
		writeScalar(&builder, "torium_public_faucet_budget_remaining_base_units", "Remaining global daily budget.", "gauge", bigToFloat(metrics.budgetRemaining))
	}
	writeScalar(&builder, "torium_public_faucet_confirmation_lag_seconds_sum", "Accept-to-confirm latency sum.", "counter", metrics.confirmationLagSum)
	writeScalar(&builder, "torium_public_faucet_confirmation_lag_seconds_count", "Accept-to-confirm latency count.", "counter", float64(metrics.confirmationLagN))
	if len(metrics.breakerOpen) > 0 {
		fmt.Fprintf(&builder, "# HELP torium_public_faucet_breaker_open Circuit breaker state (1=open).\n")
		fmt.Fprintf(&builder, "# TYPE torium_public_faucet_breaker_open gauge\n")
		for _, name := range sortedKeys(metrics.breakerOpen) {
			value := 0
			if metrics.breakerOpen[name] {
				value = 1
			}
			fmt.Fprintf(&builder, "torium_public_faucet_breaker_open{breaker=%q} %d\n", name, value)
		}
	}
	return builder.String()
}

func writeCounterFamily(builder *strings.Builder, name, help, label string, values map[string]uint64) {
	fmt.Fprintf(builder, "# HELP %s %s\n# TYPE %s counter\n", name, help, name)
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, key := range keys {
		fmt.Fprintf(builder, "%s{%s=%q} %d\n", name, label, key, values[key])
	}
}

func writeScalar(builder *strings.Builder, name, help, metricType string, value float64) {
	fmt.Fprintf(builder, "# HELP %s %s\n# TYPE %s %s\n%s %g\n", name, help, name, metricType, name, value)
}

func sortedKeys(values map[string]bool) []string {
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}

func bigToFloat(value *big.Int) float64 {
	result, _ := new(big.Float).SetInt(value).Float64()
	return result
}

func normalizeLabel(reason string) string {
	normalized := strings.ToLower(reason)
	normalized = strings.ReplaceAll(normalized, " ", "-")
	if len(normalized) > 64 {
		normalized = normalized[:64]
	}
	return normalized
}
