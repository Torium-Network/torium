// Package publicfaucet implements the #172 public faucet service. It is an
// independent service from the loopback developer faucet: it has its own
// signer, configuration contract, persistence, abuse controls, and lifecycle.
// Public deployment stays fail-closed until #127 approves it; the binary only
// binds loopback or isolated-container addresses.
package publicfaucet

import (
	"encoding/json"
	"fmt"
	"math/big"
	"net/netip"
	"os"
	"time"
)

// Notice is attached to every response: tTOR carries no value or entitlement.
const Notice = "tTOR is valueless test currency with no monetary value and no entitlement."

// ChallengeMode selects how funding requests prove liveness.
type ChallengeMode string

const (
	// ChallengeTurnstile verifies tokens against Cloudflare Turnstile.
	ChallengeTurnstile ChallengeMode = "turnstile"
	// ChallengeStaticLocal accepts one static rehearsal token. It is only
	// legal in a local-rehearsal profile on a loopback/container bind.
	ChallengeStaticLocal ChallengeMode = "static-local"
)

// Profile is one named, reviewed service configuration.
type Profile struct {
	Name                string
	LocalRehearsal      bool
	CosmosChainID       string
	EVMChainID          *big.Int
	AmountPerRequest    *big.Int
	CooldownPerAddress  time.Duration
	PerAddressDailyCap  int
	GlobalDailyBudget   *big.Int
	HotBalanceCap       *big.Int
	RefillBelow         *big.Int
	AlertBelow          *big.Int
	HaltBelow           *big.Int
	QueueCapacity       int
	MaximumBodyBytes    int64
	TransactionTimeout  time.Duration
	ChallengeMode       ChallengeMode
	AllowedOrigin       string
	PerIPBurst          int
	PerIPRefillSeconds  int
	SubnetBurst         int
	SubnetRefillSeconds int
	DenylistCIDRs       []netip.Prefix
	AllowlistCIDRs      []netip.Prefix
	ErrorRateWindow     int
	ErrorRateTripCount  int
	RPCProbeInterval    time.Duration
	RPCTripAfter        int
}

type profileDocument struct {
	Name                string   `json:"name"`
	LocalRehearsal      bool     `json:"localRehearsal"`
	CosmosChainID       string   `json:"cosmosChainId"`
	EVMChainID          uint64   `json:"evmChainId"`
	AmountPerRequest    string   `json:"amountPerRequestBaseUnits"`
	CooldownSeconds     int64    `json:"cooldownPerAddressSeconds"`
	PerAddressDailyCap  int      `json:"perAddressDailyCap"`
	GlobalDailyBudget   string   `json:"globalDailyBudgetBaseUnits"`
	HotBalanceCap       string   `json:"hotBalanceCapBaseUnits"`
	RefillBelow         string   `json:"refillBelowBaseUnits"`
	AlertBelow          string   `json:"alertBelowBaseUnits"`
	HaltBelow           string   `json:"haltBelowBaseUnits"`
	QueueCapacity       int      `json:"queueCapacity"`
	MaximumBodyBytes    int64    `json:"maximumRequestBodyBytes"`
	TransactionTimeout  int64    `json:"transactionTimeoutSeconds"`
	ChallengeMode       string   `json:"challengeMode"`
	AllowedOrigin       string   `json:"allowedOrigin"`
	PerIPBurst          int      `json:"perIpBurst"`
	PerIPRefillSeconds  int      `json:"perIpRefillSeconds"`
	SubnetBurst         int      `json:"perSubnetBurst"`
	SubnetRefillSeconds int      `json:"perSubnetRefillSeconds"`
	DenylistCIDRs       []string `json:"denylistCidrs"`
	AllowlistCIDRs      []string `json:"allowlistCidrs"`
	ErrorRateWindow     int      `json:"errorRateWindow"`
	ErrorRateTripCount  int      `json:"errorRateTripCount"`
	RPCProbeSeconds     int64    `json:"rpcProbeIntervalSeconds"`
	RPCTripAfter        int      `json:"rpcTripAfterFailures"`
}

type serviceDocument struct {
	SchemaVersion           int               `json:"schemaVersion"`
	OwnerIssue              int               `json:"ownerIssue"`
	PublicDeploymentAllowed bool              `json:"publicDeploymentAllowed"`
	Profiles                []profileDocument `json:"profiles"`
}

// LoadProfile reads one named profile from the reviewed service contract.
// The contract must keep public deployment fail-closed.
func LoadProfile(contractPath, name string) (Profile, error) {
	raw, err := os.ReadFile(contractPath)
	if err != nil {
		return Profile{}, fmt.Errorf("read public faucet contract: %w", err)
	}
	var document serviceDocument
	if err := json.Unmarshal(raw, &document); err != nil {
		return Profile{}, fmt.Errorf("parse public faucet contract: %w", err)
	}
	if document.SchemaVersion != 1 || document.OwnerIssue != 172 {
		return Profile{}, fmt.Errorf("public faucet contract has an unexpected schema or owner issue")
	}
	if document.PublicDeploymentAllowed {
		return Profile{}, fmt.Errorf("public faucet contract must keep publicDeploymentAllowed=false until #127 approves launch")
	}
	for _, candidate := range document.Profiles {
		if candidate.Name != name {
			continue
		}
		profile, err := candidate.toProfile()
		if err != nil {
			return Profile{}, fmt.Errorf("profile %q: %w", name, err)
		}
		return profile, nil
	}
	return Profile{}, fmt.Errorf("unknown public faucet profile %q", name)
}

func (document profileDocument) toProfile() (Profile, error) {
	profile := Profile{
		Name:                document.Name,
		LocalRehearsal:      document.LocalRehearsal,
		CosmosChainID:       document.CosmosChainID,
		EVMChainID:          new(big.Int).SetUint64(document.EVMChainID),
		CooldownPerAddress:  time.Duration(document.CooldownSeconds) * time.Second,
		PerAddressDailyCap:  document.PerAddressDailyCap,
		QueueCapacity:       document.QueueCapacity,
		MaximumBodyBytes:    document.MaximumBodyBytes,
		TransactionTimeout:  time.Duration(document.TransactionTimeout) * time.Second,
		ChallengeMode:       ChallengeMode(document.ChallengeMode),
		AllowedOrigin:       document.AllowedOrigin,
		PerIPBurst:          document.PerIPBurst,
		PerIPRefillSeconds:  document.PerIPRefillSeconds,
		SubnetBurst:         document.SubnetBurst,
		SubnetRefillSeconds: document.SubnetRefillSeconds,
		ErrorRateWindow:     document.ErrorRateWindow,
		ErrorRateTripCount:  document.ErrorRateTripCount,
		RPCProbeInterval:    time.Duration(document.RPCProbeSeconds) * time.Second,
		RPCTripAfter:        document.RPCTripAfter,
	}
	amounts := map[string]struct {
		value  string
		target **big.Int
	}{
		"amountPerRequestBaseUnits":  {document.AmountPerRequest, &profile.AmountPerRequest},
		"globalDailyBudgetBaseUnits": {document.GlobalDailyBudget, &profile.GlobalDailyBudget},
		"hotBalanceCapBaseUnits":     {document.HotBalanceCap, &profile.HotBalanceCap},
		"refillBelowBaseUnits":       {document.RefillBelow, &profile.RefillBelow},
		"alertBelowBaseUnits":        {document.AlertBelow, &profile.AlertBelow},
		"haltBelowBaseUnits":         {document.HaltBelow, &profile.HaltBelow},
	}
	for name, amount := range amounts {
		parsed, ok := new(big.Int).SetString(amount.value, 10)
		if !ok || parsed.Sign() <= 0 {
			return Profile{}, fmt.Errorf("%s must be a positive base-10 integer", name)
		}
		*amount.target = parsed
	}
	for _, cidr := range document.DenylistCIDRs {
		prefix, err := netip.ParsePrefix(cidr)
		if err != nil {
			return Profile{}, fmt.Errorf("invalid denylist CIDR %q: %w", cidr, err)
		}
		profile.DenylistCIDRs = append(profile.DenylistCIDRs, prefix)
	}
	for _, cidr := range document.AllowlistCIDRs {
		prefix, err := netip.ParsePrefix(cidr)
		if err != nil {
			return Profile{}, fmt.Errorf("invalid allowlist CIDR %q: %w", cidr, err)
		}
		profile.AllowlistCIDRs = append(profile.AllowlistCIDRs, prefix)
	}
	return profile, profile.Validate()
}

// Validate rejects incomplete or internally inconsistent profiles.
func (profile Profile) Validate() error {
	if profile.Name == "" {
		return fmt.Errorf("profile name is required")
	}
	if profile.CosmosChainID == "" || profile.EVMChainID == nil || profile.EVMChainID.Sign() <= 0 {
		return fmt.Errorf("profile chain identifiers are required")
	}
	for name, amount := range map[string]*big.Int{
		"amount per request":  profile.AmountPerRequest,
		"global daily budget": profile.GlobalDailyBudget,
		"hot balance cap":     profile.HotBalanceCap,
		"refill threshold":    profile.RefillBelow,
		"alert threshold":     profile.AlertBelow,
		"halt threshold":      profile.HaltBelow,
	} {
		if amount == nil || amount.Sign() <= 0 {
			return fmt.Errorf("%s must be positive", name)
		}
	}
	if profile.AmountPerRequest.Cmp(profile.GlobalDailyBudget) > 0 {
		return fmt.Errorf("amount per request exceeds the global daily budget")
	}
	if profile.HotBalanceCap.Cmp(profile.GlobalDailyBudget) < 0 {
		return fmt.Errorf("hot balance cap must cover at least one daily budget")
	}
	if profile.HaltBelow.Cmp(profile.AlertBelow) > 0 || profile.AlertBelow.Cmp(profile.RefillBelow) > 0 {
		return fmt.Errorf("balance thresholds must satisfy halt <= alert <= refill")
	}
	if profile.CooldownPerAddress <= 0 {
		return fmt.Errorf("address cooldown must be positive")
	}
	if profile.PerAddressDailyCap <= 0 {
		return fmt.Errorf("per-address daily cap must be positive")
	}
	if profile.QueueCapacity <= 0 {
		return fmt.Errorf("queue capacity must be positive")
	}
	if profile.MaximumBodyBytes <= 0 {
		return fmt.Errorf("maximum body bytes must be positive")
	}
	if profile.TransactionTimeout <= 0 {
		return fmt.Errorf("transaction timeout must be positive")
	}
	switch profile.ChallengeMode {
	case ChallengeTurnstile:
	case ChallengeStaticLocal:
		if !profile.LocalRehearsal {
			return fmt.Errorf("static challenge mode is only legal in a local-rehearsal profile")
		}
	default:
		return fmt.Errorf("unknown challenge mode %q", profile.ChallengeMode)
	}
	if profile.PerIPBurst <= 0 || profile.PerIPRefillSeconds <= 0 || profile.SubnetBurst <= 0 || profile.SubnetRefillSeconds <= 0 {
		return fmt.Errorf("token bucket parameters must be positive")
	}
	if profile.ErrorRateWindow <= 0 || profile.ErrorRateTripCount <= 0 || profile.ErrorRateTripCount > profile.ErrorRateWindow {
		return fmt.Errorf("error-rate breaker parameters are inconsistent")
	}
	if profile.RPCProbeInterval <= 0 || profile.RPCTripAfter <= 0 {
		return fmt.Errorf("RPC breaker parameters must be positive")
	}
	return nil
}

// BudgetDay returns the UTC day key used for daily budget accounting.
func BudgetDay(at time.Time) string {
	return at.UTC().Format("2006-01-02")
}
