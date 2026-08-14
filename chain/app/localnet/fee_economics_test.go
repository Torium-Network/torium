package localnet

import (
	"testing"

	"github.com/ethereum/go-ethereum/common"

	cosmosmath "cosmossdk.io/math"
	sdk "github.com/cosmos/cosmos-sdk/types"
	authtypes "github.com/cosmos/cosmos-sdk/x/auth/types"
	govtypes "github.com/cosmos/cosmos-sdk/x/gov/types"
	feemarkettypes "github.com/cosmos/evm/x/feemarket/types"
	toriumconfig "github.com/torium-network/torium-chain/config"
)

func TestEIP1559BaseFeeRespondsToGasAndRespectsFloor(t *testing.T) {
	harness := newValidatorLifecycleHarness(t)
	policy := toriumconfig.MustLocalFeeAndResourcePolicy()
	tests := []struct {
		name        string
		parentFee   string
		gasWanted   uint64
		expectedFee string
	}{
		{"empty block at floor", "1000000000", 0, "1000000000.000000000000000000"},
		{"empty block above floor", "2000000000", 0, "1750000000.000000000000000000"},
		{"target block", "2000000000", uint64(policy.BlockTargetGas), "2000000000.000000000000000000"},
		{"full block", "2000000000", uint64(policy.BlockMaxGas), "2250000000.000000000000000000"},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			ctx, _ := harness.ctx.CacheContext()
			ctx = ctx.WithBlockHeight(2)
			params := harness.app.FeeMarketKeeper.GetParams(ctx)
			params.BaseFee = cosmosmath.LegacyMustNewDecFromStr(test.parentFee)
			if err := harness.app.FeeMarketKeeper.SetParams(ctx, params); err != nil {
				t.Fatal(err)
			}
			harness.app.FeeMarketKeeper.SetBlockGasWanted(ctx, test.gasWanted)
			actual := harness.app.FeeMarketKeeper.CalculateBaseFee(ctx)
			if actual.String() != test.expectedFee {
				t.Fatalf("base fee = %s, expected %s", actual, test.expectedFee)
			}
		})
	}
}

func TestEVMFeeCollectionConservesSupplyAndCreditsFeeCollector(t *testing.T) {
	harness := newValidatorLifecycleHarness(t)
	ctx, _ := harness.ctx.CacheContext()
	sender := materialNamed(t, harness.materials, "deployer")
	senderEVMAddress := common.BytesToAddress(sender.account)
	collectorAddress := authtypes.NewModuleAddress(authtypes.FeeCollectorName)
	feeAmount := cosmosmath.NewInt(123_456_789_012_345)
	fees := sdk.NewCoins(sdk.NewCoin(toriumconfig.BaseDenom, feeAmount))

	senderBefore := harness.app.BankKeeper.GetBalance(ctx, sender.account, toriumconfig.BaseDenom).Amount
	collectorBefore := harness.app.BankKeeper.GetBalance(ctx, collectorAddress, toriumconfig.BaseDenom).Amount
	supplyBefore := harness.app.BankKeeper.GetSupply(ctx, toriumconfig.BaseDenom).Amount
	if err := harness.app.EVMKeeper.DeductTxCostsFromUserBalance(ctx, fees, senderEVMAddress); err != nil {
		t.Fatal(err)
	}
	// EVM fees are accumulated in per-transaction virtual balances so refunds
	// can occur before the bank end-block hook credits the real module account.
	if err := harness.app.BankKeeper.CreditVirtualAccounts(ctx); err != nil {
		t.Fatal(err)
	}
	senderAfter := harness.app.BankKeeper.GetBalance(ctx, sender.account, toriumconfig.BaseDenom).Amount
	collectorAfter := harness.app.BankKeeper.GetBalance(ctx, collectorAddress, toriumconfig.BaseDenom).Amount
	supplyAfter := harness.app.BankKeeper.GetSupply(ctx, toriumconfig.BaseDenom).Amount

	if !senderBefore.Sub(senderAfter).Equal(feeAmount) {
		t.Fatalf("sender debit = %s, expected %s", senderBefore.Sub(senderAfter), feeAmount)
	}
	if !collectorAfter.Sub(collectorBefore).Equal(feeAmount) {
		t.Fatalf("fee collector credit = %s, expected %s", collectorAfter.Sub(collectorBefore), feeAmount)
	}
	if !supplyAfter.Equal(supplyBefore) {
		t.Fatalf("fee collection changed native supply from %s to %s", supplyBefore, supplyAfter)
	}
}

func TestFeeMarketParameterUpdatesRequireGovernanceAuthority(t *testing.T) {
	harness := newValidatorLifecycleHarness(t)
	ctx, _ := harness.ctx.CacheContext()
	params := harness.app.FeeMarketKeeper.GetParams(ctx)
	params.BaseFee = cosmosmath.LegacyMustNewDecFromStr("1100000000")
	unauthorized := materialNamed(t, harness.materials, "deployer").account.String()

	if _, err := harness.app.FeeMarketKeeper.UpdateParams(
		ctx,
		&feemarkettypes.MsgUpdateParams{Authority: unauthorized, Params: params},
	); err == nil {
		t.Fatal("non-governance authority changed fee market parameters")
	}
	if _, err := harness.app.FeeMarketKeeper.UpdateParams(
		ctx,
		&feemarkettypes.MsgUpdateParams{
			Authority: authtypes.NewModuleAddress(govtypes.ModuleName).String(),
			Params:    params,
		},
	); err != nil {
		t.Fatalf("governance authority could not change fee market parameters: %v", err)
	}
	if actual := harness.app.FeeMarketKeeper.GetParams(ctx).BaseFee; !actual.Equal(params.BaseFee) {
		t.Fatalf("authorized base fee update stored %s, expected %s", actual, params.BaseFee)
	}
}
