package publicfaucet

import (
	"math/big"
	"sync"
)

// Breakers are the global circuit breakers from the design contract:
// budget-spent, error-rate, balance-floor, and RPC-down. Any open breaker
// stops accepting and signing new funding work while status reads continue.
type Breakers struct {
	mu               sync.Mutex
	profile          Profile
	outcomes         []bool
	rpcFailures      int
	rpcDown          bool
	balanceBaseUnits *big.Int
}

// NewBreakers builds the breaker set for one profile.
func NewBreakers(profile Profile) *Breakers {
	return &Breakers{profile: profile}
}

// RecordOutcome feeds the sliding error-rate window with one transaction
// outcome.
func (breakers *Breakers) RecordOutcome(success bool) {
	breakers.mu.Lock()
	defer breakers.mu.Unlock()
	breakers.outcomes = append(breakers.outcomes, success)
	if len(breakers.outcomes) > breakers.profile.ErrorRateWindow {
		breakers.outcomes = breakers.outcomes[len(breakers.outcomes)-breakers.profile.ErrorRateWindow:]
	}
}

// RecordRPCProbe feeds the RPC health breaker with one probe result.
func (breakers *Breakers) RecordRPCProbe(healthy bool) {
	breakers.mu.Lock()
	defer breakers.mu.Unlock()
	if healthy {
		breakers.rpcFailures = 0
		breakers.rpcDown = false
		return
	}
	breakers.rpcFailures++
	if breakers.rpcFailures >= breakers.profile.RPCTripAfter {
		breakers.rpcDown = true
	}
}

// RecordBalance updates the latest observed hot-signer balance.
func (breakers *Breakers) RecordBalance(balanceBaseUnits *big.Int) {
	breakers.mu.Lock()
	defer breakers.mu.Unlock()
	breakers.balanceBaseUnits = new(big.Int).Set(balanceBaseUnits)
}

// State reports every breaker; an empty openReason means all are closed.
type BreakerState struct {
	OpenReason       string
	RPCDown          bool
	ErrorRateTripped bool
	BalanceFloor     bool
	BudgetSpent      bool
}

// Evaluate computes the breaker state for the current spent budget.
func (breakers *Breakers) Evaluate(spentToday *big.Int) BreakerState {
	breakers.mu.Lock()
	defer breakers.mu.Unlock()
	state := BreakerState{}
	failures := 0
	for _, success := range breakers.outcomes {
		if !success {
			failures++
		}
	}
	if len(breakers.outcomes) == breakers.profile.ErrorRateWindow && failures >= breakers.profile.ErrorRateTripCount {
		state.ErrorRateTripped = true
		state.OpenReason = "error-rate breaker is open"
	}
	if breakers.rpcDown {
		state.RPCDown = true
		state.OpenReason = "RPC breaker is open"
	}
	if breakers.balanceBaseUnits != nil && breakers.balanceBaseUnits.Cmp(breakers.profile.HaltBelow) < 0 {
		state.BalanceFloor = true
		state.OpenReason = "hot balance is below the halt floor"
	}
	projected := new(big.Int).Add(spentToday, breakers.profile.AmountPerRequest)
	if projected.Cmp(breakers.profile.GlobalDailyBudget) > 0 {
		state.BudgetSpent = true
		state.OpenReason = "global daily budget is exhausted"
	}
	return state
}

// ResetErrorWindow clears the outcome window after operator intervention
// (resume/rotation), so a fixed fault does not keep the breaker open.
func (breakers *Breakers) ResetErrorWindow() {
	breakers.mu.Lock()
	defer breakers.mu.Unlock()
	breakers.outcomes = nil
}

// Balance returns the last observed hot balance, or nil before the first
// probe.
func (breakers *Breakers) Balance() *big.Int {
	breakers.mu.Lock()
	defer breakers.mu.Unlock()
	if breakers.balanceBaseUnits == nil {
		return nil
	}
	return new(big.Int).Set(breakers.balanceBaseUnits)
}
