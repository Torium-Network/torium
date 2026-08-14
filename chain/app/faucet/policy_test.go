package faucet

import (
	"encoding/json"
	"os"
	"testing"
	"time"
)

func TestDefaultPolicyMatchesReviewedConfiguration(t *testing.T) {
	t.Parallel()

	contents, err := os.ReadFile("../../config/faucet-policy-v1.json")
	if err != nil {
		t.Fatalf("read reviewed faucet policy: %v", err)
	}
	var reviewed struct {
		Funding struct {
			DefaultAmountBaseUnits                 string `json:"defaultAmountBaseUnits"`
			MinimumAmountBaseUnits                 string `json:"minimumAmountBaseUnits"`
			MaximumAmountPerRequestBaseUnits       string `json:"maximumAmountPerRequestBaseUnits"`
			MaximumAmountPerAddressWindowBaseUnits string `json:"maximumAmountPerAddressWindowBaseUnits"`
			AddressWindowSeconds                   int64  `json:"addressWindowSeconds"`
			CooldownSeconds                        int64  `json:"cooldownSeconds"`
			TransactionTimeoutSeconds              int64  `json:"transactionTimeoutSeconds"`
		} `json:"funding"`
		HTTP struct {
			MaximumRequestBodyBytes int64 `json:"maximumRequestBodyBytes"`
		} `json:"http"`
	}
	if err := json.Unmarshal(contents, &reviewed); err != nil {
		t.Fatalf("decode reviewed faucet policy: %v", err)
	}
	policy := DefaultPolicy()
	if err := policy.Validate(); err != nil {
		t.Fatalf("default policy is invalid: %v", err)
	}
	assertPolicyValue(t, "default amount", policy.DefaultAmount.String(), reviewed.Funding.DefaultAmountBaseUnits)
	assertPolicyValue(t, "minimum amount", policy.MinimumAmount.String(), reviewed.Funding.MinimumAmountBaseUnits)
	assertPolicyValue(t, "per-request maximum", policy.MaximumAmountPerRequest.String(), reviewed.Funding.MaximumAmountPerRequestBaseUnits)
	assertPolicyValue(t, "per-window maximum", policy.MaximumAmountPerWindow.String(), reviewed.Funding.MaximumAmountPerAddressWindowBaseUnits)
	assertPolicyValue(t, "address window", int64(policy.AddressWindow/time.Second), reviewed.Funding.AddressWindowSeconds)
	assertPolicyValue(t, "cooldown", int64(policy.Cooldown/time.Second), reviewed.Funding.CooldownSeconds)
	assertPolicyValue(t, "transaction timeout", int64(policy.TransactionTimeout/time.Second), reviewed.Funding.TransactionTimeoutSeconds)
	assertPolicyValue(t, "maximum body bytes", policy.MaximumBodyBytes, reviewed.HTTP.MaximumRequestBodyBytes)
}

func assertPolicyValue[T comparable](t *testing.T, name string, actual, expected T) {
	t.Helper()
	if actual != expected {
		t.Fatalf("%s drift: got %v, want %v", name, actual, expected)
	}
}
