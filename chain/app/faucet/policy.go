// Package faucet implements the valueless, loopback-only Torium localnet
// faucet. It is intentionally not a public-faucet implementation.
package faucet

import (
	"fmt"
	"math/big"
	"time"
)

const (
	Warning                 = "VALUELESS LOCAL DEVELOPMENT ONLY — tTOR dispensed by this faucet has no monetary value."
	DefaultListenAddress    = "127.0.0.1:8080"
	DefaultRPCURL           = "http://127.0.0.1:8545"
	DefaultFixtureAccount   = "faucet"
	DefaultMaximumBodyBytes = int64(4096)
)

// Policy is the in-process enforcement contract. The matching reviewed,
// machine-readable policy lives at chain/config/faucet-policy-v1.json.
type Policy struct {
	DefaultAmount           *big.Int
	MinimumAmount           *big.Int
	MaximumAmountPerRequest *big.Int
	MaximumAmountPerWindow  *big.Int
	AddressWindow           time.Duration
	Cooldown                time.Duration
	TransactionTimeout      time.Duration
	MaximumBodyBytes        int64
}

// DefaultPolicy returns an independent copy of the canonical local policy.
func DefaultPolicy() Policy {
	return Policy{
		DefaultAmount:           mustAmount("10000000000000000000"),
		MinimumAmount:           mustAmount("1000000000000000000"),
		MaximumAmountPerRequest: mustAmount("25000000000000000000"),
		MaximumAmountPerWindow:  mustAmount("100000000000000000000"),
		AddressWindow:           time.Hour,
		Cooldown:                30 * time.Second,
		TransactionTimeout:      45 * time.Second,
		MaximumBodyBytes:        DefaultMaximumBodyBytes,
	}
}

// Validate rejects an incomplete or internally inconsistent policy.
func (policy Policy) Validate() error {
	amounts := map[string]*big.Int{
		"default amount":             policy.DefaultAmount,
		"minimum amount":             policy.MinimumAmount,
		"maximum amount per request": policy.MaximumAmountPerRequest,
		"maximum amount per window":  policy.MaximumAmountPerWindow,
	}
	for name, amount := range amounts {
		if amount == nil || amount.Sign() <= 0 {
			return fmt.Errorf("%s must be positive", name)
		}
	}
	if policy.MinimumAmount.Cmp(policy.DefaultAmount) > 0 {
		return fmt.Errorf("minimum amount exceeds default amount")
	}
	if policy.DefaultAmount.Cmp(policy.MaximumAmountPerRequest) > 0 {
		return fmt.Errorf("default amount exceeds per-request maximum")
	}
	if policy.MaximumAmountPerRequest.Cmp(policy.MaximumAmountPerWindow) > 0 {
		return fmt.Errorf("per-request maximum exceeds per-window maximum")
	}
	if policy.Cooldown <= 0 || policy.AddressWindow <= policy.Cooldown {
		return fmt.Errorf("address window must exceed a positive cooldown")
	}
	if policy.TransactionTimeout <= 0 {
		return fmt.Errorf("transaction timeout must be positive")
	}
	if policy.MaximumBodyBytes <= 0 {
		return fmt.Errorf("maximum body bytes must be positive")
	}
	return nil
}

func mustAmount(value string) *big.Int {
	amount, ok := new(big.Int).SetString(value, 10)
	if !ok {
		panic("invalid built-in faucet amount " + value)
	}
	return amount
}
