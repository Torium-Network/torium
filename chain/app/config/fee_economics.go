package config

import (
	"fmt"
	"time"

	cmtcfg "github.com/cometbft/cometbft/config"
	cosmosevmserverconfig "github.com/cosmos/evm/server/config"
)

const localFeeProfile = "local-development-only"

// FeeAndResourcePolicy is the single runtime source for Torium protocol-v1
// fee-market, transaction, proposal, and application-mempool bounds. The local
// profile is deliberately not a public-network capacity recommendation.
type FeeAndResourcePolicy struct {
	Profile                          string
	PublicEndpointsAllowed           bool
	BlockMaxBytes                    int64
	BlockMaxGas                      int64
	BlockTargetGas                   int64
	MaxEVMTransactionBytes           int
	MaxCosmosTransactionBytes        int
	MaxTxGasWanted                   uint64
	InitialBaseFeeBaseUnitsPerGas    uint64
	MinimumBaseFeeBaseUnitsPerGas    uint64
	BaseFeeChangeDenominator         uint32
	ElasticityMultiplier             uint32
	MinimumGasMultiplier             string
	ValidatorMinimumGasPrice         string
	MempoolMinimumPriorityFee        uint64
	MempoolPriceLimit                uint64
	MempoolPriceBumpPercent          uint64
	MempoolAccountExecutableSlots    uint64
	MempoolGlobalExecutableSlots     uint64
	MempoolAccountQueuedSlots        uint64
	MempoolGlobalQueuedSlots         uint64
	MempoolQueuedLifetime            time.Duration
	MempoolIncludedNonceCacheSize    int
	MempoolPendingProposalTimeout    time.Duration
	MempoolCheckTxTimeout            time.Duration
	MempoolInsertQueueSize           int
	MempoolTransactionTrackerEnabled bool
	CosmosMempoolMaxTransactions     int
	CometReapMaxBytes                uint64
	CometReapMaxGas                  uint64
	JSONRPCCallGasCap                uint64
}

// LocalFeeAndResourcePolicy returns a value copy so callers cannot mutate a
// process-global configuration contract.
func LocalFeeAndResourcePolicy() FeeAndResourcePolicy {
	return FeeAndResourcePolicy{
		Profile:                          localFeeProfile,
		PublicEndpointsAllowed:           false,
		BlockMaxBytes:                    5_242_880,
		BlockMaxGas:                      30_000_000,
		BlockTargetGas:                   15_000_000,
		MaxEVMTransactionBytes:           128 * 1024,
		MaxCosmosTransactionBytes:        256 * 1024,
		MaxTxGasWanted:                   25_000_000,
		InitialBaseFeeBaseUnitsPerGas:    1_000_000_000,
		MinimumBaseFeeBaseUnitsPerGas:    1_000_000_000,
		BaseFeeChangeDenominator:         8,
		ElasticityMultiplier:             2,
		MinimumGasMultiplier:             "0.5",
		ValidatorMinimumGasPrice:         "0" + BaseDenom,
		MempoolMinimumPriorityFee:        1,
		MempoolPriceLimit:                1,
		MempoolPriceBumpPercent:          10,
		MempoolAccountExecutableSlots:    16,
		MempoolGlobalExecutableSlots:     5_120,
		MempoolAccountQueuedSlots:        64,
		MempoolGlobalQueuedSlots:         1_024,
		MempoolQueuedLifetime:            3 * time.Hour,
		MempoolIncludedNonceCacheSize:    4_096,
		MempoolPendingProposalTimeout:    250 * time.Millisecond,
		MempoolCheckTxTimeout:            5 * time.Second,
		MempoolInsertQueueSize:           5_000,
		MempoolTransactionTrackerEnabled: false,
		CosmosMempoolMaxTransactions:     1_000,
		CometReapMaxBytes:                5_242_880,
		CometReapMaxGas:                  30_000_000,
		JSONRPCCallGasCap:                25_000_000,
	}
}

// Validate rejects unsafe or internally inconsistent policy combinations.
func (policy FeeAndResourcePolicy) Validate() error {
	if policy.Profile != localFeeProfile || policy.PublicEndpointsAllowed {
		return fmt.Errorf("fee policy must remain the non-public %q profile", localFeeProfile)
	}
	if policy.BlockMaxBytes <= 0 || policy.BlockMaxGas <= 0 || policy.BlockTargetGas <= 0 {
		return fmt.Errorf("block byte, gas, and target gas limits must be positive")
	}
	if policy.ElasticityMultiplier < 1 ||
		policy.BlockTargetGas != policy.BlockMaxGas/int64(policy.ElasticityMultiplier) {
		return fmt.Errorf("target gas must equal max gas divided by the elasticity multiplier")
	}
	if policy.MaxEVMTransactionBytes <= 0 ||
		policy.MaxCosmosTransactionBytes < policy.MaxEVMTransactionBytes ||
		int64(policy.MaxCosmosTransactionBytes) > policy.BlockMaxBytes {
		return fmt.Errorf("transaction byte limits must satisfy EVM <= Cosmos <= block")
	}
	if policy.MaxTxGasWanted == 0 || policy.MaxTxGasWanted > uint64(policy.BlockMaxGas) {
		return fmt.Errorf("maximum transaction gas wanted must be within the block gas limit")
	}
	if policy.JSONRPCCallGasCap == 0 || policy.JSONRPCCallGasCap > uint64(policy.BlockMaxGas) {
		return fmt.Errorf("JSON-RPC call gas cap must be within the block gas limit")
	}
	if policy.InitialBaseFeeBaseUnitsPerGas < policy.MinimumBaseFeeBaseUnitsPerGas ||
		policy.MinimumBaseFeeBaseUnitsPerGas == 0 {
		return fmt.Errorf("initial base fee must be at or above a positive minimum base fee")
	}
	if policy.BaseFeeChangeDenominator < 1 {
		return fmt.Errorf("base fee change denominator must be positive")
	}
	if policy.MinimumGasMultiplier != "0.5" {
		return fmt.Errorf("minimum gas multiplier must remain the validated protocol-v1 value 0.5")
	}
	if policy.ValidatorMinimumGasPrice != "0"+BaseDenom {
		return fmt.Errorf("validator-local minimum gas price must be expressed as zero %s", BaseDenom)
	}
	if policy.MempoolMinimumPriorityFee < 1 ||
		policy.MempoolPriceLimit < 1 ||
		policy.MempoolMinimumPriorityFee != policy.MempoolPriceLimit {
		return fmt.Errorf("mempool minimum priority fee and price limit must match and be positive")
	}
	if policy.MempoolPriceBumpPercent < 1 ||
		policy.MempoolAccountExecutableSlots < 1 ||
		policy.MempoolGlobalExecutableSlots < policy.MempoolAccountExecutableSlots ||
		policy.MempoolAccountQueuedSlots < 1 ||
		policy.MempoolGlobalQueuedSlots < policy.MempoolAccountQueuedSlots {
		return fmt.Errorf("mempool replacement, executable-slot, and queue bounds are invalid")
	}
	if policy.MempoolQueuedLifetime <= 0 ||
		policy.MempoolIncludedNonceCacheSize < 1 ||
		policy.MempoolPendingProposalTimeout <= 0 ||
		policy.MempoolCheckTxTimeout <= 0 ||
		policy.MempoolInsertQueueSize < 1 ||
		policy.CosmosMempoolMaxTransactions < 1 {
		return fmt.Errorf("mempool lifetimes, caches, timeouts, and queue caps must be positive")
	}
	if policy.MempoolTransactionTrackerEnabled {
		return fmt.Errorf("transaction lifecycle tracking is not approved in the local validator profile")
	}
	if policy.CometReapMaxBytes < uint64(policy.MaxCosmosTransactionBytes) ||
		policy.CometReapMaxBytes > uint64(policy.BlockMaxBytes) {
		return fmt.Errorf("CometBFT reap bytes must admit one Cosmos transaction without exceeding the block limit")
	}
	if policy.CometReapMaxGas < uint64(policy.BlockMaxGas) {
		return fmt.Errorf("CometBFT reap gas must admit the consensus block gas limit")
	}
	return nil
}

// MustLocalFeeAndResourcePolicy returns the validated local policy.
func MustLocalFeeAndResourcePolicy() FeeAndResourcePolicy {
	policy := LocalFeeAndResourcePolicy()
	if err := policy.Validate(); err != nil {
		panic(err)
	}
	return policy
}

// ApplyEVMFeeAndMempoolPolicy pins all upstream defaults that are part of the
// Torium local protocol contract.
func ApplyEVMFeeAndMempoolPolicy(cfg *cosmosevmserverconfig.EVMConfig, policy FeeAndResourcePolicy) error {
	if cfg == nil {
		return fmt.Errorf("EVM config is required")
	}
	if err := policy.Validate(); err != nil {
		return err
	}
	cfg.MaxTxGasWanted = policy.MaxTxGasWanted
	cfg.MinTip = policy.MempoolMinimumPriorityFee
	cfg.Mempool.PriceLimit = policy.MempoolPriceLimit
	cfg.Mempool.PriceBump = policy.MempoolPriceBumpPercent
	cfg.Mempool.AccountSlots = policy.MempoolAccountExecutableSlots
	cfg.Mempool.GlobalSlots = policy.MempoolGlobalExecutableSlots
	cfg.Mempool.AccountQueue = policy.MempoolAccountQueuedSlots
	cfg.Mempool.GlobalQueue = policy.MempoolGlobalQueuedSlots
	cfg.Mempool.Lifetime = policy.MempoolQueuedLifetime
	cfg.Mempool.IncludedNonceCacheSize = policy.MempoolIncludedNonceCacheSize
	cfg.Mempool.PendingTxProposalTimeout = policy.MempoolPendingProposalTimeout
	cfg.Mempool.CheckTxTimeout = policy.MempoolCheckTxTimeout
	cfg.Mempool.InsertQueueSize = policy.MempoolInsertQueueSize
	cfg.Mempool.EnableTxTracker = policy.MempoolTransactionTrackerEnabled
	return nil
}

// ApplyCometMempoolPolicy keeps admission and proposal reap bounds mutually
// consistent for the app-side Cosmos EVM mempool.
func ApplyCometMempoolPolicy(cfg *cmtcfg.Config, policy FeeAndResourcePolicy) error {
	if cfg == nil {
		return fmt.Errorf("CometBFT config is required")
	}
	if err := policy.Validate(); err != nil {
		return err
	}
	cfg.Mempool.Type = cmtcfg.MempoolTypeApp
	cfg.Mempool.MaxTxBytes = policy.MaxCosmosTransactionBytes
	cfg.Mempool.ReapMaxBytes = policy.CometReapMaxBytes
	cfg.Mempool.ReapMaxGas = policy.CometReapMaxGas
	return nil
}
