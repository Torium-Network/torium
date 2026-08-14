package localnet

import (
	"encoding/json"
	"sync"
	"testing"
	"time"

	"github.com/cometbft/cometbft/abci/types"
	cmtproto "github.com/cometbft/cometbft/proto/tendermint/types"

	"cosmossdk.io/core/comet"
	cosmosmath "cosmossdk.io/math"
	"github.com/cosmos/cosmos-sdk/baseapp"
	sdk "github.com/cosmos/cosmos-sdk/types"
	distrtypes "github.com/cosmos/cosmos-sdk/x/distribution/types"
	evidencetypes "github.com/cosmos/cosmos-sdk/x/evidence/types"
	genutiltypes "github.com/cosmos/cosmos-sdk/x/genutil/types"
	stakingkeeper "github.com/cosmos/cosmos-sdk/x/staking/keeper"
	stakingtypes "github.com/cosmos/cosmos-sdk/x/staking/types"
	torium "github.com/torium-network/torium-chain"
	toriumconfig "github.com/torium-network/torium-chain/config"
)

type validatorLifecycleHarness struct {
	app       *torium.ToriumApp
	ctx       sdk.Context
	genesis   genutiltypes.AppGenesis
	materials []accountMaterial
}

var (
	localnetInitOnce      sync.Once
	localnetInitResponse  *types.ResponseInitChain
	localnetInitGenesis   genutiltypes.AppGenesis
	localnetInitMaterials []accountMaterial
	localnetInitError     error
)

func newValidatorLifecycleHarness(t *testing.T) validatorLifecycleHarness {
	t.Helper()
	app := localnetTestApp
	initializeLocalnetApplication()
	if localnetInitError != nil {
		t.Fatal(localnetInitError)
	}
	consensusParams := localnetInitGenesis.Consensus.Params.ToProto()
	ctx := app.NewContextLegacy(false, cmtproto.Header{
		ChainID: localnetInitGenesis.ChainID,
		Height:  localnetInitGenesis.InitialHeight,
		Time:    localnetInitGenesis.GenesisTime,
	}).WithConsensusParams(consensusParams)
	return validatorLifecycleHarness{
		app:       app,
		ctx:       ctx,
		genesis:   localnetInitGenesis,
		materials: localnetInitMaterials,
	}
}

func initializeLocalnetApplication() {
	localnetInitOnce.Do(func() {
		app := localnetTestApp
		artifact, err := (Generator{
			Codec:        app.AppCodec(),
			TxConfig:     app.TxConfig(),
			BasicModules: app.BasicModuleManager,
		}).Generate()
		if err != nil {
			localnetInitError = err
			return
		}
		fixture, err := LoadFixture()
		if err != nil {
			localnetInitError = err
			return
		}
		materials, err := deriveAccountMaterials(fixture)
		if err != nil {
			localnetInitError = err
			return
		}
		var genesis genutiltypes.AppGenesis
		if err := json.Unmarshal(artifact.Genesis, &genesis); err != nil {
			localnetInitError = err
			return
		}
		consensusParams := genesis.Consensus.Params.ToProto()
		response, err := app.InitChain(&types.RequestInitChain{
			Time:            genesis.GenesisTime,
			ChainId:         genesis.ChainID,
			InitialHeight:   genesis.InitialHeight,
			ConsensusParams: &consensusParams,
			AppStateBytes:   genesis.AppState,
		})
		if err != nil {
			localnetInitError = err
			return
		}
		localnetInitResponse = response
		localnetInitGenesis = genesis
		localnetInitMaterials = materials
	})
}

func TestValidatorLifecycleAndEighteenDecimalAccounting(t *testing.T) {
	harness := newValidatorLifecycleHarness(t)
	app, ctx := harness.app, harness.ctx
	initialSupply := app.BankKeeper.GetSupply(ctx, toriumconfig.BaseDenom).Amount
	msgServer := stakingkeeper.NewMsgServerImpl(app.StakingKeeper)
	candidate := materialNamed(t, harness.materials, "test-user")
	delegator := materialNamed(t, harness.materials, "sdk-user")
	faucet := materialNamed(t, harness.materials, "faucet")
	candidateConsensusKey := deriveConsensusKey("validator-lifecycle-candidate")
	minimumStake := toriumconfig.MinimumValidatorSelfDelegation

	// Call x/staking's MsgServer directly, just as the staking EVM precompile
	// does. The keeper-level hook must reject policy violations even when no
	// outer Cosmos ante handler is involved; the cache proves rollback semantics.
	invalidContext, _ := ctx.CacheContext()
	invalidMessage, err := stakingtypes.NewMsgCreateValidator(
		candidate.operator.String(),
		candidateConsensusKey.PubKey(),
		sdk.NewCoin(toriumconfig.BaseDenom, minimumStake),
		stakingtypes.Description{Moniker: "invalid-lifecycle-candidate"},
		stakingtypes.NewCommissionRates(
			toriumconfig.MinimumValidatorCommissionRate,
			cosmosmath.LegacyMustNewDecFromStr("0.21"),
			toriumconfig.MaximumCommissionChangeRate,
		),
		minimumStake,
	)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := msgServer.CreateValidator(invalidContext, invalidMessage); err == nil {
		t.Fatal("direct staking MsgServer caller bypassed the validator commission cap")
	}

	createMessage, err := stakingtypes.NewMsgCreateValidator(
		candidate.operator.String(),
		candidateConsensusKey.PubKey(),
		sdk.NewCoin(toriumconfig.BaseDenom, minimumStake),
		stakingtypes.Description{Moniker: "lifecycle-candidate"},
		stakingtypes.NewCommissionRates(
			toriumconfig.MinimumValidatorCommissionRate,
			toriumconfig.MaximumValidatorCommissionRate,
			toriumconfig.MaximumCommissionChangeRate,
		),
		minimumStake,
	)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := msgServer.CreateValidator(ctx, createMessage); err != nil {
		t.Fatalf("create fifth validator: %v", err)
	}
	updates, err := app.StakingKeeper.ApplyAndReturnValidatorSetUpdates(ctx)
	if err != nil {
		t.Fatal(err)
	}
	assertValidatorPowerUpdate(t, updates, 1)
	assertValidatorState(t, app, ctx, candidate.operator, stakingtypes.Bonded, 1, false)

	if _, err := msgServer.Delegate(ctx, &stakingtypes.MsgDelegate{
		DelegatorAddress: delegator.account.String(),
		ValidatorAddress: candidate.operator.String(),
		Amount:           sdk.NewCoin(toriumconfig.BaseDenom, minimumStake),
	}); err != nil {
		t.Fatalf("delegate one exact voting-power unit: %v", err)
	}
	assertValidatorState(t, app, ctx, candidate.operator, stakingtypes.Bonded, 2, false)

	commissionRate := cosmosmath.LegacyMustNewDecFromStr("0.06")
	editCtx := ctx.WithBlockTime(ctx.BlockTime().Add(24 * time.Hour))
	if _, err := msgServer.EditValidator(editCtx, &stakingtypes.MsgEditValidator{
		Description:      stakingtypes.Description{Moniker: "lifecycle-candidate"},
		ValidatorAddress: candidate.operator.String(),
		CommissionRate:   &commissionRate,
	}); err != nil {
		t.Fatalf("edit validator commission inside the ratified envelope: %v", err)
	}
	ctx = editCtx

	rewardAmount := cosmosmath.NewIntWithDecimal(100, 18)
	rewardCoin := sdk.NewCoin(toriumconfig.BaseDenom, rewardAmount)
	if err := app.BankKeeper.SendCoinsFromAccountToModule(
		ctx,
		faucet.account,
		distrtypes.ModuleName,
		sdk.NewCoins(rewardCoin),
	); err != nil {
		t.Fatalf("fund fee-backed validator rewards: %v", err)
	}
	validator, err := app.StakingKeeper.GetValidator(ctx, candidate.operator)
	if err != nil {
		t.Fatal(err)
	}
	if err := app.DistrKeeper.AllocateTokensToValidator(
		ctx,
		validator,
		sdk.NewDecCoins(sdk.NewDecCoinFromCoin(rewardCoin)),
	); err != nil {
		t.Fatalf("allocate existing TOR to validator: %v", err)
	}
	ctx = ctx.WithBlockHeight(ctx.BlockHeight() + 1).WithBlockTime(ctx.BlockTime().Add(time.Second))
	selfRewards, err := app.DistrKeeper.WithdrawDelegationRewards(ctx, candidate.account, candidate.operator)
	if err != nil {
		t.Fatalf("withdraw self-delegation rewards: %v", err)
	}
	externalRewards, err := app.DistrKeeper.WithdrawDelegationRewards(ctx, delegator.account, candidate.operator)
	if err != nil {
		t.Fatalf("withdraw external delegation rewards: %v", err)
	}
	commission, err := app.DistrKeeper.WithdrawValidatorCommission(ctx, candidate.operator)
	if err != nil {
		t.Fatalf("withdraw validator commission: %v", err)
	}
	withdrawn := selfRewards.AmountOf(toriumconfig.BaseDenom).
		Add(externalRewards.AmountOf(toriumconfig.BaseDenom)).
		Add(commission.AmountOf(toriumconfig.BaseDenom))
	if !withdrawn.Equal(rewardAmount) {
		t.Fatalf("reward accounting lost precision: rewards+commission=%s expected=%s", withdrawn, rewardAmount)
	}
	assertNativeSupplyReconcilesForApp(t, app, ctx, initialSupply)

	// Exercise the exact 18-decimal boundaries that historically fail when an
	// SDK chain keeps the upstream 10^6 power reduction while using an 18-decimal
	// native asset. Every amount must remain stakeable without supply drift.
	powerUnit := sdk.DefaultPowerReduction
	boundaryAmounts := []cosmosmath.Int{
		cosmosmath.OneInt(),
		powerUnit.SubRaw(1),
		powerUnit,
		powerUnit.AddRaw(1),
		powerUnit.MulRaw(1_000_000),
	}
	for _, amount := range boundaryAmounts {
		if _, err := msgServer.Delegate(ctx, &stakingtypes.MsgDelegate{
			DelegatorAddress: delegator.account.String(),
			ValidatorAddress: candidate.operator.String(),
			Amount:           sdk.NewCoin(toriumconfig.BaseDenom, amount),
		}); err != nil {
			t.Fatalf("delegate 18-decimal boundary %s: %v", amount, err)
		}
	}
	if _, err := msgServer.BeginRedelegate(ctx, &stakingtypes.MsgBeginRedelegate{
		DelegatorAddress:    delegator.account.String(),
		ValidatorSrcAddress: candidate.operator.String(),
		ValidatorDstAddress: materialNamed(t, harness.materials, "validator-0").operator.String(),
		Amount:              sdk.NewCoin(toriumconfig.BaseDenom, powerUnit.AddRaw(1)),
	}); err != nil {
		t.Fatalf("redelegate across the voting-power boundary: %v", err)
	}
	if _, err := msgServer.Undelegate(ctx, &stakingtypes.MsgUndelegate{
		DelegatorAddress: delegator.account.String(),
		ValidatorAddress: candidate.operator.String(),
		Amount:           sdk.NewCoin(toriumconfig.BaseDenom, powerUnit.SubRaw(1)),
	}); err != nil {
		t.Fatalf("begin precision-sensitive unbonding: %v", err)
	}
	assertDelegationShareDustBound(t, app, ctx, candidate.operator)
	assertStakingPoolsReconcile(t, app, ctx)

	// Remove every remaining delegation through ordinary on-chain messages.
	// There is no administrator-only validator deletion path.
	delegation, err := app.StakingKeeper.GetDelegation(ctx, delegator.account, candidate.operator)
	if err != nil {
		t.Fatal(err)
	}
	validator, err = app.StakingKeeper.GetValidator(ctx, candidate.operator)
	if err != nil {
		t.Fatal(err)
	}
	externalTokens := validator.TokensFromShares(delegation.Shares).TruncateInt()
	if _, err := msgServer.Undelegate(ctx, &stakingtypes.MsgUndelegate{
		DelegatorAddress: delegator.account.String(),
		ValidatorAddress: candidate.operator.String(),
		Amount:           sdk.NewCoin(toriumconfig.BaseDenom, externalTokens),
	}); err != nil {
		t.Fatalf("remove remaining external delegation: %v", err)
	}
	if _, err := msgServer.Undelegate(ctx, &stakingtypes.MsgUndelegate{
		DelegatorAddress: candidate.account.String(),
		ValidatorAddress: candidate.operator.String(),
		Amount:           sdk.NewCoin(toriumconfig.BaseDenom, minimumStake),
	}); err != nil {
		t.Fatalf("remove validator self-delegation: %v", err)
	}
	updates, err = app.StakingKeeper.ApplyAndReturnValidatorSetUpdates(ctx)
	if err != nil {
		t.Fatal(err)
	}
	assertValidatorPowerUpdate(t, updates, 0)
	// Falling below minimum self-delegation deterministically jails the operator
	// while the ordinary unbonding queue removes it from the active set.
	assertValidatorState(t, app, ctx, candidate.operator, stakingtypes.Unbonding, 0, true)
	assertEventTypes(t, ctx, "create_validator", "delegate", "redelegate", "unbond", "commission", "rewards")

	matureCtx := ctx.WithBlockTime(ctx.BlockTime().Add(toriumconfig.ValidatorUnbondingTime + time.Second))
	if _, err := app.StakingKeeper.CompleteUnbonding(matureCtx, delegator.account, candidate.operator); err != nil {
		t.Fatalf("complete delegator unbonding: %v", err)
	}
	if _, err := app.StakingKeeper.CompleteUnbonding(matureCtx, candidate.account, candidate.operator); err != nil {
		t.Fatalf("complete self unbonding: %v", err)
	}
	if err := app.StakingKeeper.UnbondAllMatureValidators(matureCtx); err != nil {
		t.Fatalf("remove fully unbonded validator: %v", err)
	}
	if _, err := app.StakingKeeper.GetValidator(matureCtx, candidate.operator); err == nil {
		t.Fatal("fully unbonded validator remained in the validator store")
	}
	assertStakingPoolsReconcile(t, app, matureCtx)
	assertNativeSupplyReconcilesForApp(t, app, matureCtx, initialSupply)
}

func TestDowntimeSlashJailAndUnjailLifecycle(t *testing.T) {
	harness := newValidatorLifecycleHarness(t)
	app, ctx := harness.app, harness.ctx
	target := materialNamed(t, harness.materials, "validator-3")
	consensusKeyAddress := target.consensusKey.PubKey().Address()
	supplyBefore := app.BankKeeper.GetSupply(ctx, toriumconfig.BaseDenom).Amount

	for height := int64(2); height <= toriumconfig.SignedBlocksWindow+2; height++ {
		ctx = ctx.WithBlockHeight(height).WithBlockTime(harness.genesis.GenesisTime.Add(time.Duration(height) * time.Second))
		if err := app.SlashingKeeper.HandleValidatorSignature(
			ctx,
			consensusKeyAddress,
			25,
			comet.BlockIDFlagAbsent,
		); err != nil {
			t.Fatalf("record missed signature at height %d: %v", height, err)
		}
	}
	assertValidatorState(t, app, ctx, target.operator, stakingtypes.Bonded, 24, true)
	expectedBurn := sdk.DefaultPowerReduction.MulRaw(25).ToLegacyDec().
		Mul(toriumconfig.SlashFractionDowntime).TruncateInt()
	supplyAfter := app.BankKeeper.GetSupply(ctx, toriumconfig.BaseDenom).Amount
	if !supplyBefore.Sub(supplyAfter).Equal(expectedBurn) {
		t.Fatalf("downtime burn=%s expected=%s", supplyBefore.Sub(supplyAfter), expectedBurn)
	}
	updates, err := app.StakingKeeper.ApplyAndReturnValidatorSetUpdates(ctx)
	if err != nil {
		t.Fatal(err)
	}
	assertValidatorPowerUpdate(t, updates, 0)
	assertEventTypes(t, ctx, "slash")
	if err := app.SlashingKeeper.Unjail(ctx, target.operator); err == nil {
		t.Fatal("validator unjailed before the ratified downtime jail duration")
	}

	ctx = ctx.WithBlockTime(ctx.BlockTime().Add(toriumconfig.DowntimeJailDuration + time.Second))
	if err := app.SlashingKeeper.Unjail(ctx, target.operator); err != nil {
		t.Fatalf("unjail validator after downtime jail duration: %v", err)
	}
	updates, err = app.StakingKeeper.ApplyAndReturnValidatorSetUpdates(ctx)
	if err != nil {
		t.Fatal(err)
	}
	assertValidatorPowerUpdate(t, updates, 24)
	assertValidatorState(t, app, ctx, target.operator, stakingtypes.Bonded, 24, false)
	assertStakingPoolsReconcile(t, app, ctx)
	assertNativeSupplyReconcilesForApp(t, app, ctx, supplyAfter)
}

func TestDoubleSignEvidenceSlashesJailsAndTombstones(t *testing.T) {
	harness := newValidatorLifecycleHarness(t)
	app := harness.app
	target := materialNamed(t, harness.materials, "validator-2")
	consensusAddress := sdk.ConsAddress(target.consensusKey.PubKey().Address())
	supplyBefore := app.BankKeeper.GetSupply(harness.ctx, toriumconfig.BaseDenom).Amount
	misbehavior := types.Misbehavior{
		Type: types.MisbehaviorType_DUPLICATE_VOTE,
		Validator: types.Validator{
			Address: consensusAddress,
			Power:   25,
		},
		Height:           1,
		Time:             harness.genesis.GenesisTime,
		TotalVotingPower: 100,
	}
	ctx := harness.ctx.
		WithBlockHeight(2).
		WithBlockTime(harness.genesis.GenesisTime.Add(time.Second)).
		WithCometInfo(baseapp.NewBlockInfo(
			[]types.Misbehavior{misbehavior},
			nil,
			nil,
			types.CommitInfo{},
		))
	if err := app.EvidenceKeeper.BeginBlocker(ctx); err != nil {
		t.Fatalf("process CometBFT duplicate-vote evidence: %v", err)
	}

	assertValidatorState(t, app, ctx, target.operator, stakingtypes.Bonded, 23, true)
	expectedBurn := sdk.DefaultPowerReduction.MulRaw(25).ToLegacyDec().
		Mul(toriumconfig.SlashFractionDoubleSign).TruncateInt()
	supplyAfter := app.BankKeeper.GetSupply(ctx, toriumconfig.BaseDenom).Amount
	if !supplyBefore.Sub(supplyAfter).Equal(expectedBurn) {
		t.Fatalf("double-sign burn=%s expected=%s", supplyBefore.Sub(supplyAfter), expectedBurn)
	}
	if !app.SlashingKeeper.IsTombstoned(ctx, consensusAddress) {
		t.Fatal("duplicate-vote evidence did not tombstone the validator")
	}
	expectedEvidence := &evidencetypes.Equivocation{
		Height:           misbehavior.Height,
		Time:             misbehavior.Time,
		Power:            misbehavior.Validator.Power,
		ConsensusAddress: consensusAddress.String(),
	}
	if _, err := app.EvidenceKeeper.Evidences.Get(ctx, expectedEvidence.Hash()); err != nil {
		t.Fatalf("handled evidence was not persisted: %v", err)
	}
	updates, err := app.StakingKeeper.ApplyAndReturnValidatorSetUpdates(ctx)
	if err != nil {
		t.Fatal(err)
	}
	assertValidatorPowerUpdate(t, updates, 0)
	assertEventTypes(t, ctx, "slash", "burn")
	farFuture := ctx.WithBlockTime(ctx.BlockTime().Add(100 * 365 * 24 * time.Hour))
	if err := app.SlashingKeeper.Unjail(farFuture, target.operator); err == nil {
		t.Fatal("tombstoned validator was able to unjail")
	}
	assertStakingPoolsReconcile(t, app, ctx)
	assertNativeSupplyReconcilesForApp(t, app, ctx, supplyAfter)
}

func assertValidatorPowerUpdate(t *testing.T, updates []types.ValidatorUpdate, expected int64) {
	t.Helper()
	for _, update := range updates {
		if update.Power == expected {
			return
		}
	}
	t.Fatalf("validator updates %+v do not contain power %d", updates, expected)
}

func assertValidatorState(
	t *testing.T,
	app *torium.ToriumApp,
	ctx sdk.Context,
	operator sdk.ValAddress,
	status stakingtypes.BondStatus,
	power int64,
	jailed bool,
) {
	t.Helper()
	validator, err := app.StakingKeeper.GetValidator(ctx, operator)
	if err != nil {
		t.Fatal(err)
	}
	if validator.Status != status || validator.ConsensusPower(sdk.DefaultPowerReduction) != power || validator.Jailed != jailed {
		t.Fatalf("validator state status/power/jailed=%s/%d/%v expected=%s/%d/%v", validator.Status, validator.ConsensusPower(sdk.DefaultPowerReduction), validator.Jailed, status, power, jailed)
	}
}

func assertDelegationShareDustBound(t *testing.T, app *torium.ToriumApp, ctx sdk.Context, operator sdk.ValAddress) {
	t.Helper()
	validator, err := app.StakingKeeper.GetValidator(ctx, operator)
	if err != nil {
		t.Fatal(err)
	}
	delegations, err := app.StakingKeeper.GetValidatorDelegations(ctx, operator)
	if err != nil {
		t.Fatal(err)
	}
	shares := cosmosmath.LegacyZeroDec()
	delegatedTokens := cosmosmath.ZeroInt()
	for _, delegation := range delegations {
		shares = shares.Add(delegation.Shares)
		delegatedTokens = delegatedTokens.Add(validator.TokensFromShares(delegation.Shares).TruncateInt())
	}
	if !shares.Equal(validator.DelegatorShares) {
		t.Fatalf("delegation shares=%s validator shares=%s", shares, validator.DelegatorShares)
	}
	dust := validator.Tokens.Sub(delegatedTokens)
	if dust.IsNegative() || dust.GT(cosmosmath.NewInt(int64(len(delegations)))) {
		t.Fatalf("18-decimal share-conversion dust=%s exceeds %d base units", dust, len(delegations))
	}
}

func assertStakingPoolsReconcile(t *testing.T, app *torium.ToriumApp, ctx sdk.Context) {
	t.Helper()
	validators, err := app.StakingKeeper.GetAllValidators(ctx)
	if err != nil {
		t.Fatal(err)
	}
	bondedTokens := cosmosmath.ZeroInt()
	notBondedTokens := cosmosmath.ZeroInt()
	for _, validator := range validators {
		if validator.Status == stakingtypes.Bonded {
			bondedTokens = bondedTokens.Add(validator.Tokens)
		} else {
			notBondedTokens = notBondedTokens.Add(validator.Tokens)
		}
	}
	unbondingDelegations, err := app.StakingKeeper.GetAllUnbondingDelegations(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, delegation := range unbondingDelegations {
		for _, entry := range delegation.Entries {
			notBondedTokens = notBondedTokens.Add(entry.Balance)
		}
	}
	bondedBalance := app.BankKeeper.GetBalance(ctx, app.StakingKeeper.GetBondedPool(ctx).GetAddress(), toriumconfig.BaseDenom).Amount
	notBondedBalance := app.BankKeeper.GetBalance(ctx, app.StakingKeeper.GetNotBondedPool(ctx).GetAddress(), toriumconfig.BaseDenom).Amount
	if !bondedBalance.Equal(bondedTokens) || !notBondedBalance.Equal(notBondedTokens) {
		t.Fatalf("staking pools do not reconcile: bonded=%s/%s not-bonded=%s/%s", bondedBalance, bondedTokens, notBondedBalance, notBondedTokens)
	}
}

func assertNativeSupplyReconcilesForApp(t *testing.T, app *torium.ToriumApp, ctx sdk.Context, expected cosmosmath.Int) {
	t.Helper()
	total := cosmosmath.ZeroInt()
	app.BankKeeper.IterateAllBalances(ctx, func(_ sdk.AccAddress, coin sdk.Coin) bool {
		if coin.Denom == toriumconfig.BaseDenom {
			total = total.Add(coin.Amount)
		}
		return false
	})
	supply := app.BankKeeper.GetSupply(ctx, toriumconfig.BaseDenom).Amount
	if !total.Equal(supply) || !supply.Equal(expected) {
		t.Fatalf("native supply does not reconcile: balances=%s supply=%s expected=%s", total, supply, expected)
	}
}

func assertEventTypes(t *testing.T, ctx sdk.Context, expected ...string) {
	t.Helper()
	observed := make(map[string]bool)
	for _, event := range ctx.EventManager().Events() {
		observed[event.Type] = true
	}
	for _, eventType := range expected {
		if !observed[eventType] {
			t.Fatalf("committed lifecycle events do not contain %q: %+v", eventType, observed)
		}
	}
}
