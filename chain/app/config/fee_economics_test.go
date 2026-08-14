package config

import (
	"testing"
	"time"

	cmtcfg "github.com/cometbft/cometbft/config"
	cosmosevmserverconfig "github.com/cosmos/evm/server/config"
)

func TestLocalFeeAndResourcePolicyIsInternallyConsistent(t *testing.T) {
	policy := LocalFeeAndResourcePolicy()
	if err := policy.Validate(); err != nil {
		t.Fatal(err)
	}
	if policy.BlockTargetGas != 15_000_000 ||
		policy.MinimumBaseFeeBaseUnitsPerGas != 1_000_000_000 ||
		policy.MempoolMinimumPriorityFee != 1 ||
		policy.MempoolPriceBumpPercent != 10 ||
		policy.MaxEVMTransactionBytes != 128*1024 ||
		policy.MaxCosmosTransactionBytes != 256*1024 ||
		policy.CosmosMempoolMaxTransactions != 1_000 {
		t.Fatalf("unexpected local fee/resource policy: %+v", policy)
	}
}

func TestFeeAndResourcePolicyRejectsInvalidBoundaries(t *testing.T) {
	tests := []struct {
		name   string
		mutate func(*FeeAndResourcePolicy)
	}{
		{"public activation", func(policy *FeeAndResourcePolicy) { policy.PublicEndpointsAllowed = true }},
		{"zero block gas", func(policy *FeeAndResourcePolicy) { policy.BlockMaxGas = 0 }},
		{"wrong target gas", func(policy *FeeAndResourcePolicy) { policy.BlockTargetGas++ }},
		{"EVM tx above Cosmos tx", func(policy *FeeAndResourcePolicy) {
			policy.MaxEVMTransactionBytes = policy.MaxCosmosTransactionBytes + 1
		}},
		{"tx above block gas", func(policy *FeeAndResourcePolicy) { policy.MaxTxGasWanted = uint64(policy.BlockMaxGas) + 1 }},
		{"RPC above block gas", func(policy *FeeAndResourcePolicy) { policy.JSONRPCCallGasCap = uint64(policy.BlockMaxGas) + 1 }},
		{"zero minimum base fee", func(policy *FeeAndResourcePolicy) { policy.MinimumBaseFeeBaseUnitsPerGas = 0 }},
		{"initial fee below floor", func(policy *FeeAndResourcePolicy) { policy.InitialBaseFeeBaseUnitsPerGas-- }},
		{"zero denominator", func(policy *FeeAndResourcePolicy) { policy.BaseFeeChangeDenominator = 0 }},
		{"wrong gas multiplier", func(policy *FeeAndResourcePolicy) { policy.MinimumGasMultiplier = "0" }},
		{"wrong validator denom", func(policy *FeeAndResourcePolicy) { policy.ValidatorMinimumGasPrice = "0stake" }},
		{"zero minimum tip", func(policy *FeeAndResourcePolicy) { policy.MempoolMinimumPriorityFee = 0 }},
		{"tip and price mismatch", func(policy *FeeAndResourcePolicy) { policy.MempoolPriceLimit++ }},
		{"zero price bump", func(policy *FeeAndResourcePolicy) { policy.MempoolPriceBumpPercent = 0 }},
		{"account slots above global", func(policy *FeeAndResourcePolicy) {
			policy.MempoolAccountExecutableSlots = policy.MempoolGlobalExecutableSlots + 1
		}},
		{"account queue above global", func(policy *FeeAndResourcePolicy) {
			policy.MempoolAccountQueuedSlots = policy.MempoolGlobalQueuedSlots + 1
		}},
		{"zero queued lifetime", func(policy *FeeAndResourcePolicy) { policy.MempoolQueuedLifetime = 0 }},
		{"zero nonce cache", func(policy *FeeAndResourcePolicy) { policy.MempoolIncludedNonceCacheSize = 0 }},
		{"zero proposal timeout", func(policy *FeeAndResourcePolicy) { policy.MempoolPendingProposalTimeout = 0 }},
		{"zero check timeout", func(policy *FeeAndResourcePolicy) { policy.MempoolCheckTxTimeout = 0 }},
		{"zero insert queue", func(policy *FeeAndResourcePolicy) { policy.MempoolInsertQueueSize = 0 }},
		{"unbounded Cosmos pool", func(policy *FeeAndResourcePolicy) { policy.CosmosMempoolMaxTransactions = 0 }},
		{"transaction tracker", func(policy *FeeAndResourcePolicy) { policy.MempoolTransactionTrackerEnabled = true }},
		{"reap bytes below tx", func(policy *FeeAndResourcePolicy) {
			policy.CometReapMaxBytes = uint64(policy.MaxCosmosTransactionBytes - 1)
		}},
		{"reap bytes above block", func(policy *FeeAndResourcePolicy) { policy.CometReapMaxBytes = uint64(policy.BlockMaxBytes + 1) }},
		{"reap gas below block", func(policy *FeeAndResourcePolicy) { policy.CometReapMaxGas = uint64(policy.BlockMaxGas - 1) }},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			policy := LocalFeeAndResourcePolicy()
			test.mutate(&policy)
			if err := policy.Validate(); err == nil {
				t.Fatal("invalid fee/resource policy was accepted")
			}
		})
	}
}

func TestFeePolicyAppliesEveryRuntimeMempoolBound(t *testing.T) {
	policy := MustLocalFeeAndResourcePolicy()
	evm := cosmosevmserverconfig.DefaultEVMConfig()
	if err := ApplyEVMFeeAndMempoolPolicy(evm, policy); err != nil {
		t.Fatal(err)
	}
	if evm.MaxTxGasWanted != policy.MaxTxGasWanted ||
		evm.MinTip != policy.MempoolMinimumPriorityFee ||
		evm.Mempool.PriceLimit != policy.MempoolPriceLimit ||
		evm.Mempool.PriceBump != policy.MempoolPriceBumpPercent ||
		evm.Mempool.AccountSlots != policy.MempoolAccountExecutableSlots ||
		evm.Mempool.GlobalSlots != policy.MempoolGlobalExecutableSlots ||
		evm.Mempool.AccountQueue != policy.MempoolAccountQueuedSlots ||
		evm.Mempool.GlobalQueue != policy.MempoolGlobalQueuedSlots ||
		evm.Mempool.Lifetime != 3*time.Hour ||
		evm.Mempool.IncludedNonceCacheSize != policy.MempoolIncludedNonceCacheSize ||
		evm.Mempool.PendingTxProposalTimeout != policy.MempoolPendingProposalTimeout ||
		evm.Mempool.CheckTxTimeout != policy.MempoolCheckTxTimeout ||
		evm.Mempool.InsertQueueSize != policy.MempoolInsertQueueSize ||
		evm.Mempool.EnableTxTracker {
		t.Fatalf("EVM config differs from policy: %+v", evm)
	}

	comet := cmtcfg.DefaultConfig()
	if err := ApplyCometMempoolPolicy(comet, policy); err != nil {
		t.Fatal(err)
	}
	if comet.Mempool.Type != cmtcfg.MempoolTypeApp ||
		comet.Mempool.MaxTxBytes != policy.MaxCosmosTransactionBytes ||
		comet.Mempool.ReapMaxBytes != policy.CometReapMaxBytes ||
		comet.Mempool.ReapMaxGas != policy.CometReapMaxGas {
		t.Fatalf("CometBFT config differs from policy: %+v", comet.Mempool)
	}
}

func TestFeePolicyApplicationRejectsNilTargets(t *testing.T) {
	policy := MustLocalFeeAndResourcePolicy()
	if err := ApplyEVMFeeAndMempoolPolicy(nil, policy); err == nil {
		t.Fatal("nil EVM config was accepted")
	}
	if err := ApplyCometMempoolPolicy(nil, policy); err == nil {
		t.Fatal("nil CometBFT config was accepted")
	}
}
