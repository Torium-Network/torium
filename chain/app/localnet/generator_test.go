package localnet

import (
	"bytes"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"

	"github.com/cometbft/cometbft/proto/tendermint/types"
	"github.com/ethereum/go-ethereum/common"

	"cosmossdk.io/log/v2"
	cosmosmath "cosmossdk.io/math"
	"github.com/cosmos/cosmos-db"
	"github.com/cosmos/cosmos-sdk/baseapp"
	sdk "github.com/cosmos/cosmos-sdk/types"
	sdkerrors "github.com/cosmos/cosmos-sdk/types/errors"
	authtypes "github.com/cosmos/cosmos-sdk/x/auth/types"
	banktypes "github.com/cosmos/cosmos-sdk/x/bank/types"
	distrtypes "github.com/cosmos/cosmos-sdk/x/distribution/types"
	genutiltypes "github.com/cosmos/cosmos-sdk/x/genutil/types"
	govtypes "github.com/cosmos/cosmos-sdk/x/gov/types"
	slashingtypes "github.com/cosmos/cosmos-sdk/x/slashing/types"
	stakingtypes "github.com/cosmos/cosmos-sdk/x/staking/types"
	erc20types "github.com/cosmos/evm/x/erc20/types"
	vmtypes "github.com/cosmos/evm/x/vm/types"
	torium "github.com/torium-network/torium-chain"
	toriumconfig "github.com/torium-network/torium-chain/config"
)

type testAppOptions map[string]any

func (options testAppOptions) Get(key string) any { return options[key] }

var localnetTestApp *torium.ToriumApp

func TestMain(m *testing.M) {
	config := sdk.GetConfig()
	toriumconfig.SetBech32Prefixes(config)
	toriumconfig.SetBip44CoinType(config)
	config.Seal()
	localnetTestApp = torium.NewToriumApp(
		log.NewNopLogger(),
		db.NewMemDB(),
		true,
		testAppOptions{},
		baseapp.SetChainID(toriumconfig.LocalCosmosChainID),
	)
	os.Exit(m.Run())
}

func TestConsensusPowerBoundaries(t *testing.T) {
	below := sdk.DefaultPowerReduction.SubRaw(1)
	power, remainder, err := ConsensusPower(below)
	if !errors.Is(err, ErrZeroConsensusPower) || power != 0 || !remainder.Equal(below) {
		t.Fatalf("below-boundary conversion = power %d remainder %s error %v", power, remainder, err)
	}

	power, remainder, err = ConsensusPower(sdk.DefaultPowerReduction)
	if err != nil || power != 1 || !remainder.IsZero() {
		t.Fatalf("exact-boundary conversion = power %d remainder %s error %v", power, remainder, err)
	}

	power, remainder, err = ConsensusPower(sdk.DefaultPowerReduction.AddRaw(1))
	if err != nil || power != 1 || !remainder.Equal(cosmosmath.OneInt()) {
		t.Fatalf("above-boundary conversion = power %d remainder %s error %v", power, remainder, err)
	}
}

func FuzzEighteenDecimalPowerConservation(f *testing.F) {
	for _, seed := range [][2]uint64{
		{0, 1},
		{0, 999_999_999_999_999_999},
		{1, 0},
		{1, 1},
		{1_000_000, 999_999_999_999_999_999},
	} {
		f.Add(seed[0], seed[1])
	}
	f.Fuzz(func(t *testing.T, wholePower, rawRemainder uint64) {
		wholePower %= 10_000_000
		rawRemainder %= 1_000_000_000_000_000_000
		amount := sdk.DefaultPowerReduction.MulRaw(int64(wholePower)).
			Add(cosmosmath.NewIntFromUint64(rawRemainder))
		power, remainder, err := ConsensusPower(amount)
		if amount.IsZero() {
			if !errors.Is(err, ErrZeroConsensusPower) || power != 0 || !remainder.IsZero() {
				t.Fatalf("zero amount conversion=%d/%s/%v", power, remainder, err)
			}
			return
		}
		if wholePower == 0 {
			if !errors.Is(err, ErrZeroConsensusPower) || power != 0 || !remainder.Equal(amount) {
				t.Fatalf("sub-power amount conversion=%d/%s/%v", power, remainder, err)
			}
			return
		}
		if err != nil || power != int64(wholePower) || !remainder.Equal(cosmosmath.NewIntFromUint64(rawRemainder)) {
			t.Fatalf("18-decimal conversion=%d/%s/%v expected=%d/%d", power, remainder, err, wholePower, rawRemainder)
		}
		reconstructed := sdk.DefaultPowerReduction.MulRaw(power).Add(remainder)
		if !reconstructed.Equal(amount) {
			t.Fatalf("power conversion lost atorium: reconstructed=%s amount=%s", reconstructed, amount)
		}
	})
}

func TestGenerationIsByteIdenticalAndMatchesCheckedInArtifact(t *testing.T) {
	generator := testGenerator()
	first, err := generator.Generate()
	if err != nil {
		t.Fatal(err)
	}
	second, err := generator.Generate()
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(first.Genesis, second.Genesis) ||
		!bytes.Equal(first.Manifest, second.Manifest) ||
		!bytes.Equal(first.Checksums, second.Checksums) {
		t.Fatal("same fixture did not produce byte-identical localnet artifacts")
	}
	for name, contents := range first.Files() {
		lower := strings.ToLower(string(contents))
		if strings.Contains(lower, "private_key") || strings.Contains(lower, "mnemonic") {
			t.Fatalf("public artifact %s contains secret-shaped material", name)
		}
	}
	canonicalDirectory := filepath.Join("..", "..", "genesis", "localnet")
	if err := first.Verify(canonicalDirectory); err != nil {
		t.Fatal(err)
	}
}

func TestArtifactWriterVerifiesAndDetectsDrift(t *testing.T) {
	artifact, err := testGenerator().Generate()
	if err != nil {
		t.Fatal(err)
	}
	directory := t.TempDir()
	if err := artifact.Write(directory); err != nil {
		t.Fatal(err)
	}
	if err := artifact.Verify(directory); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(directory, manifestFileName), []byte("drift\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := artifact.Verify(directory); err == nil || !strings.Contains(err.Error(), "clean regeneration") {
		t.Fatalf("artifact drift was not detected: %v", err)
	}
}

func TestGeneratedGenesisHasCanonicalSupplyIdentifiersAndModules(t *testing.T) {
	artifact, err := testGenerator().Generate()
	if err != nil {
		t.Fatal(err)
	}
	var genesis genutiltypes.AppGenesis
	if err := json.Unmarshal(artifact.Genesis, &genesis); err != nil {
		t.Fatal(err)
	}
	var generatedMetadata struct {
		GeneratedBy string `json:"generated_by"`
		DoNotEdit   bool   `json:"do_not_edit"`
	}
	if err := json.Unmarshal(artifact.Genesis, &generatedMetadata); err != nil {
		t.Fatal(err)
	}
	if generatedMetadata.GeneratedBy == "" || !generatedMetadata.DoNotEdit {
		t.Fatal("canonical genesis lacks generated-file ownership metadata")
	}
	if err := genesis.ValidateAndComplete(); err != nil {
		t.Fatal(err)
	}
	governanceAuthority := authtypes.NewModuleAddress(govtypes.ModuleName).String()
	if genesis.Consensus == nil || genesis.Consensus.Params == nil ||
		genesis.Consensus.Params.Authority.Authority != governanceAuthority {
		t.Fatalf("consensus authority is not pinned to governance account %s", governanceAuthority)
	}
	if genesis.ChainID != toriumconfig.LocalCosmosChainID || genesis.GenesisTime.Format("2006-01-02T15:04:05Z07:00") != "2026-07-14T00:00:00Z" {
		t.Fatalf("unexpected deterministic genesis identity: %s at %s", genesis.ChainID, genesis.GenesisTime)
	}
	feePolicy := toriumconfig.MustLocalFeeAndResourcePolicy()
	if genesis.Consensus.Params.Block.MaxBytes != feePolicy.BlockMaxBytes || genesis.Consensus.Params.Block.MaxGas != feePolicy.BlockMaxGas {
		t.Fatalf("unexpected consensus limits: %+v", genesis.Consensus.Params.Block)
	}
	if genesis.Consensus.Params.Evidence.MaxAgeNumBlocks != toriumconfig.EvidenceMaxAgeBlocks ||
		genesis.Consensus.Params.Evidence.MaxAgeDuration != toriumconfig.EvidenceMaxAge ||
		genesis.Consensus.Params.Evidence.MaxBytes != toriumconfig.EvidenceMaximumBytes {
		t.Fatalf("unexpected evidence limits: %+v", genesis.Consensus.Params.Evidence)
	}
	var manifest publicManifest
	if err := json.Unmarshal(artifact.Manifest, &manifest); err != nil {
		t.Fatal(err)
	}
	policy := manifest.ValidatorPolicy
	if policy.PowerReduction != sdk.DefaultPowerReduction.String() ||
		policy.MinimumSelfDelegationBaseUnits != toriumconfig.MinimumValidatorSelfDelegation.String() ||
		policy.MaximumActiveValidators != toriumconfig.ValidatorMaxActive ||
		policy.MaximumEntries != toriumconfig.ValidatorMaxEntries ||
		policy.HistoricalEntries != toriumconfig.ValidatorHistory ||
		policy.UnbondingTimeSeconds != int64(toriumconfig.ValidatorUnbondingTime.Seconds()) ||
		policy.MinimumCommissionRate != toriumconfig.MinimumValidatorCommissionRate.String() ||
		policy.MaximumCommissionRate != toriumconfig.MaximumValidatorCommissionRate.String() ||
		policy.MaximumCommissionChangeRate != toriumconfig.MaximumCommissionChangeRate.String() ||
		policy.SignedBlocksWindow != toriumconfig.SignedBlocksWindow ||
		policy.MinimumSignedPerWindow != toriumconfig.MinimumSignedPerWindow.String() ||
		policy.DowntimeJailDurationSeconds != int64(toriumconfig.DowntimeJailDuration.Seconds()) ||
		policy.SlashFractionDowntime != toriumconfig.SlashFractionDowntime.String() ||
		policy.SlashFractionDoubleSign != toriumconfig.SlashFractionDoubleSign.String() ||
		policy.DistributionCommunityTax != toriumconfig.DistributionCommunityTax.String() ||
		policy.RewardFunding != "transaction fees and existing bank balances only; no native mint" ||
		policy.EvidenceMaxAgeBlocks != toriumconfig.EvidenceMaxAgeBlocks ||
		policy.EvidenceMaxAgeDurationSeconds != int64(toriumconfig.EvidenceMaxAge.Seconds()) ||
		policy.EvidenceMaxBytesPerBlock != toriumconfig.EvidenceMaximumBytes {
		t.Fatalf("public manifest validator policy differs from runtime: %+v", policy)
	}

	var state map[string]json.RawMessage
	if err := json.Unmarshal(genesis.AppState, &state); err != nil {
		t.Fatal(err)
	}
	if err := localnetTestApp.BasicModuleManager.ValidateGenesis(localnetTestApp.AppCodec(), localnetTestApp.TxConfig(), state); err != nil {
		t.Fatalf("module genesis validation failed: %v", err)
	}
	for _, prohibited := range []string{"mint", "ibc", "transfer"} {
		if _, present := state[prohibited]; present {
			t.Fatalf("prohibited module %s has a genesis section", prohibited)
		}
	}
	var stakingGenesis stakingtypes.GenesisState
	var slashingGenesis slashingtypes.GenesisState
	var distributionGenesis distrtypes.GenesisState
	localnetTestApp.AppCodec().MustUnmarshalJSON(state[stakingtypes.ModuleName], &stakingGenesis)
	localnetTestApp.AppCodec().MustUnmarshalJSON(state[slashingtypes.ModuleName], &slashingGenesis)
	localnetTestApp.AppCodec().MustUnmarshalJSON(state[distrtypes.ModuleName], &distributionGenesis)
	if stakingGenesis.Params.UnbondingTime != toriumconfig.ValidatorUnbondingTime ||
		stakingGenesis.Params.MaxValidators != toriumconfig.ValidatorMaxActive ||
		stakingGenesis.Params.MaxEntries != toriumconfig.ValidatorMaxEntries ||
		stakingGenesis.Params.HistoricalEntries != toriumconfig.ValidatorHistory ||
		stakingGenesis.Params.BondDenom != toriumconfig.BaseDenom ||
		!stakingGenesis.Params.MinCommissionRate.Equal(toriumconfig.MinimumValidatorCommissionRate) {
		t.Fatalf("generated staking params differ from protocol: %+v", stakingGenesis.Params)
	}
	if slashingGenesis.Params.SignedBlocksWindow != toriumconfig.SignedBlocksWindow ||
		!slashingGenesis.Params.MinSignedPerWindow.Equal(toriumconfig.MinimumSignedPerWindow) ||
		slashingGenesis.Params.DowntimeJailDuration != toriumconfig.DowntimeJailDuration ||
		!slashingGenesis.Params.SlashFractionDowntime.Equal(toriumconfig.SlashFractionDowntime) ||
		!slashingGenesis.Params.SlashFractionDoubleSign.Equal(toriumconfig.SlashFractionDoubleSign) {
		t.Fatalf("generated slashing params differ from protocol: %+v", slashingGenesis.Params)
	}
	if !distributionGenesis.Params.CommunityTax.Equal(toriumconfig.DistributionCommunityTax) ||
		!distributionGenesis.Params.WithdrawAddrEnabled {
		t.Fatalf("generated distribution params differ from protocol: %+v", distributionGenesis.Params)
	}

	var authGenesis authtypes.GenesisState
	localnetTestApp.AppCodec().MustUnmarshalJSON(state[authtypes.ModuleName], &authGenesis)
	if len(authGenesis.Accounts) != 8 {
		t.Fatalf("genesis account count is %d, expected 8", len(authGenesis.Accounts))
	}
	var bankGenesis banktypes.GenesisState
	localnetTestApp.AppCodec().MustUnmarshalJSON(state[banktypes.ModuleName], &bankGenesis)
	expectedSupply := cosmosmath.NewIntWithDecimal(1_000_000_000, 18)
	if len(bankGenesis.Supply) != 1 || bankGenesis.Supply[0].Denom != toriumconfig.BaseDenom || !bankGenesis.Supply[0].Amount.Equal(expectedSupply) {
		t.Fatalf("unexpected genesis supply: %s", bankGenesis.Supply)
	}
	allocationSum := cosmosmath.ZeroInt()
	for _, balance := range bankGenesis.Balances {
		if len(balance.Coins) != 1 || balance.Coins[0].Denom != toriumconfig.BaseDenom {
			t.Fatalf("non-canonical genesis balance: %+v", balance)
		}
		allocationSum = allocationSum.Add(balance.Coins[0].Amount)
	}
	if !allocationSum.Equal(expectedSupply) {
		t.Fatalf("allocation sum %s differs from supply %s", allocationSum, expectedSupply)
	}

	var genutilGenesis genutiltypes.GenesisState
	localnetTestApp.AppCodec().MustUnmarshalJSON(state[genutiltypes.ModuleName], &genutilGenesis)
	if len(genutilGenesis.GenTxs) != 4 {
		t.Fatalf("genesis transaction count is %d, expected 4", len(genutilGenesis.GenTxs))
	}
	for index, transactionJSON := range genutilGenesis.GenTxs {
		transaction, decodeErr := localnetTestApp.TxConfig().TxJSONDecoder()(transactionJSON)
		if decodeErr != nil {
			t.Fatalf("decode genesis transaction %d: %v", index, decodeErr)
		}
		messages := transaction.GetMsgs()
		if len(messages) != 1 {
			t.Fatalf("genesis transaction %d has %d messages", index, len(messages))
		}
		message, ok := messages[0].(*stakingtypes.MsgCreateValidator)
		if !ok || message.Value.Denom != toriumconfig.BaseDenom {
			t.Fatalf("genesis transaction %d is not a canonical create-validator message", index)
		}
		power, remainder, powerErr := ConsensusPower(message.Value.Amount)
		if powerErr != nil || power != 25 || !remainder.IsZero() {
			t.Fatalf("genesis validator %d conversion = %d/%s/%v", index, power, remainder, powerErr)
		}
	}

}

func TestInvalidFixtureReportsZeroPowerPrecisionAndSupplyFailures(t *testing.T) {
	fixture := mustLoadFixture(t)
	fixture.Accounts[0].SelfDelegationBaseUnits = sdk.DefaultPowerReduction.SubRaw(1).String()
	if err := ValidateFixture(fixture); !errors.Is(err, ErrZeroConsensusPower) || !strings.Contains(err.Error(), "validator validator-0") {
		t.Fatalf("zero-power allocation did not receive a targeted error: %v", err)
	}

	fixture = mustLoadFixture(t)
	fixture.Accounts[0].SelfDelegationBaseUnits = sdk.DefaultPowerReduction.MulRaw(25).AddRaw(1).String()
	if err := ValidateFixture(fixture); err == nil || !strings.Contains(err.Error(), "whole-power precision") {
		t.Fatalf("precision violation did not receive a targeted error: %v", err)
	}

	fixture = mustLoadFixture(t)
	allocation, ok := cosmosmath.NewIntFromString(fixture.Accounts[len(fixture.Accounts)-1].AllocationBaseUnits)
	if !ok {
		t.Fatal("embedded fixture has an invalid allocation")
	}
	fixture.Accounts[len(fixture.Accounts)-1].AllocationBaseUnits = allocation.SubRaw(1).String()
	if err := ValidateFixture(fixture); err == nil || !strings.Contains(err.Error(), "does not equal total supply") {
		t.Fatalf("supply mismatch did not receive a targeted error: %v", err)
	}
}

func TestInitChainReconcilesSupplyPoolsSharesAndVotingPower(t *testing.T) {
	initializeLocalnetApplication()
	if localnetInitError != nil {
		t.Fatal(localnetInitError)
	}
	materials := localnetInitMaterials
	genesis := localnetInitGenesis
	response := localnetInitResponse
	if len(response.Validators) != 4 {
		t.Fatalf("InitChain returned %d validators, expected 4", len(response.Validators))
	}
	powers := make([]int64, 0, len(response.Validators))
	for _, update := range response.Validators {
		powers = append(powers, update.Power)
	}
	sort.Slice(powers, func(i, j int) bool { return powers[i] < powers[j] })
	if !equalInt64s(powers, []int64{25, 25, 25, 25}) {
		t.Fatalf("InitChain voting powers are %v", powers)
	}

	ctx := localnetTestApp.NewContextLegacy(false, types.Header{ChainID: genesis.ChainID, Time: genesis.GenesisTime})
	expectedSupply := cosmosmath.NewIntWithDecimal(1_000_000_000, 18)
	supply := localnetTestApp.BankKeeper.GetSupply(ctx, toriumconfig.BaseDenom)
	if !supply.Amount.Equal(expectedSupply) {
		t.Fatalf("post-InitChain supply is %s, expected %s", supply.Amount, expectedSupply)
	}
	expectedBonded := sdk.DefaultPowerReduction.MulRaw(100)
	bondedPool := localnetTestApp.StakingKeeper.GetBondedPool(ctx)
	bondedBalance := localnetTestApp.BankKeeper.GetBalance(ctx, bondedPool.GetAddress(), toriumconfig.BaseDenom)
	if !bondedBalance.Amount.Equal(expectedBonded) {
		t.Fatalf("bonded pool is %s, expected %s", bondedBalance.Amount, expectedBonded)
	}
	notBondedPool := localnetTestApp.StakingKeeper.GetNotBondedPool(ctx)
	notBondedBalance := localnetTestApp.BankKeeper.GetBalance(ctx, notBondedPool.GetAddress(), toriumconfig.BaseDenom)
	if !notBondedBalance.IsZero() {
		t.Fatalf("not-bonded pool unexpectedly contains %s", notBondedBalance)
	}
	genesisFee := genesisValidatorFeeAmount()
	feeCollectorBalance := localnetTestApp.BankKeeper.GetBalance(
		ctx,
		authtypes.NewModuleAddress(authtypes.FeeCollectorName),
		toriumconfig.BaseDenom,
	)
	expectedGenesisFees := genesisFee.MulRaw(int64(len(response.Validators)))
	if !feeCollectorBalance.Amount.Equal(expectedGenesisFees) {
		t.Fatalf("fee collector contains %s after gentxs, expected %s", feeCollectorBalance.Amount, expectedGenesisFees)
	}

	validators, err := localnetTestApp.StakingKeeper.GetAllValidators(ctx)
	if err != nil {
		t.Fatal(err)
	}
	delegations, err := localnetTestApp.StakingKeeper.GetAllDelegations(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(validators) != 4 || len(delegations) != 4 {
		t.Fatalf("validator/delegation counts are %d/%d, expected 4/4", len(validators), len(delegations))
	}
	for _, validator := range validators {
		if validator.Status != stakingtypes.Bonded || validator.ConsensusPower(sdk.DefaultPowerReduction) != 25 {
			t.Fatalf("validator is not bonded at power 25: %+v", validator)
		}
		expectedTokens := sdk.DefaultPowerReduction.MulRaw(25)
		if !validator.Tokens.Equal(expectedTokens) || !validator.DelegatorShares.Equal(cosmosmath.LegacyNewDecFromInt(expectedTokens)) {
			t.Fatalf("validator tokens/shares do not reconcile: %s/%s", validator.Tokens, validator.DelegatorShares)
		}
	}
	for _, delegation := range delegations {
		expectedShares := cosmosmath.LegacyNewDecFromInt(sdk.DefaultPowerReduction.MulRaw(25))
		if !delegation.Shares.Equal(expectedShares) {
			t.Fatalf("delegation shares are %s, expected %s", delegation.Shares, expectedShares)
		}
	}
	lastTotalPower, err := localnetTestApp.StakingKeeper.GetLastTotalPower(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if !lastTotalPower.Equal(cosmosmath.NewInt(100)) {
		t.Fatalf("last total consensus power is %s, expected 100", lastTotalPower)
	}

	for _, material := range materials {
		expected := material.allocation.Sub(material.delegation)
		if material.fixture.Role == "validator" {
			expected = expected.Sub(genesisFee)
		}
		assertBankAndEVMBalance(t, ctx, material, expected)
	}
	evmParams := localnetTestApp.EVMKeeper.GetParams(ctx)
	if evmParams.EvmDenom != toriumconfig.BaseDenom {
		t.Fatalf("EVM gas ledger denom is %s, bank denom is %s", evmParams.EvmDenom, toriumconfig.BaseDenom)
	}
	erc20Params := localnetTestApp.Erc20Keeper.GetParams(ctx)
	if !erc20Params.EnableErc20 || erc20Params.PermissionlessRegistration {
		t.Fatalf("runtime ERC-20 params differ from canonical native asset policy: %+v", erc20Params)
	}
	tokenPairs := localnetTestApp.Erc20Keeper.GetTokenPairs(ctx)
	if len(tokenPairs) != 1 || tokenPairs[0].Denom != toriumconfig.BaseDenom ||
		tokenPairs[0].Erc20Address != toriumconfig.NativeTORPrecompileAddress ||
		tokenPairs[0].ContractOwner != erc20types.OWNER_MODULE || !tokenPairs[0].Enabled {
		t.Fatalf("runtime native token pair differs from genesis contract: %+v", tokenPairs)
	}
	assertNativeSupplyReconciles(t, ctx, expectedSupply)

	deployer := materialNamed(t, materials, "deployer")
	sdkUser := materialNamed(t, materials, "sdk-user")
	transfer := sdk.NewCoins(sdk.NewCoin(toriumconfig.BaseDenom, cosmosmath.OneInt()))
	if err := localnetTestApp.BankKeeper.SendCoins(ctx, deployer.account, sdkUser.account, transfer); err != nil {
		t.Fatalf("canonical native transfer failed: %v", err)
	}
	assertBankAndEVMBalance(t, ctx, deployer, deployer.allocation.SubRaw(1))
	assertBankAndEVMBalance(t, ctx, sdkUser, sdkUser.allocation.AddRaw(1))
	assertNativeSupplyReconciles(t, ctx, expectedSupply)

	// Both upstream EVM modules retain generic minter permission, so this test
	// proves the application-level restriction is the control preventing native
	// TOR inflation rather than an accidental lack of module authority.
	for _, moduleName := range []string{vmtypes.ModuleName, erc20types.ModuleName} {
		moduleAddress := authtypes.NewModuleAddress(moduleName)
		moduleBalanceBefore := localnetTestApp.BankKeeper.GetBalance(ctx, moduleAddress, toriumconfig.BaseDenom)
		eventsBefore := len(ctx.EventManager().Events())
		err := localnetTestApp.BankKeeper.MintCoins(ctx, moduleName, transfer)
		if !errors.Is(err, sdkerrors.ErrUnauthorized) {
			t.Fatalf("%s native mint returned %v, expected unauthorized", moduleName, err)
		}
		moduleBalanceAfter := localnetTestApp.BankKeeper.GetBalance(ctx, moduleAddress, toriumconfig.BaseDenom)
		if !moduleBalanceAfter.Equal(moduleBalanceBefore) {
			t.Fatalf("denied %s mint changed module balance from %s to %s", moduleName, moduleBalanceBefore, moduleBalanceAfter)
		}
		if len(ctx.EventManager().Events()) != eventsBefore {
			t.Fatalf("denied %s mint emitted a supply mutation event", moduleName)
		}
		assertNativeSupplyReconciles(t, ctx, expectedSupply)
	}

	// Native burns remain an explicit, observable supply-reducing operation.
	// Fund a module account through an ordinary bank transfer so the test does
	// not bypass the post-genesis mint restriction it just proved.
	burnModule := govtypes.ModuleName
	burnModuleAddress := authtypes.NewModuleAddress(burnModule)
	if err := localnetTestApp.BankKeeper.SendCoinsFromAccountToModule(ctx, deployer.account, burnModule, transfer); err != nil {
		t.Fatalf("fund native burn module: %v", err)
	}
	eventsBeforeBurn := len(ctx.EventManager().Events())
	if err := localnetTestApp.BankKeeper.BurnCoins(ctx, burnModule, transfer); err != nil {
		t.Fatalf("authorized native burn failed: %v", err)
	}
	if balance := localnetTestApp.BankKeeper.GetBalance(ctx, burnModuleAddress, toriumconfig.BaseDenom); !balance.IsZero() {
		t.Fatalf("authorized native burn left module balance %s", balance)
	}
	burnObserved := false
	for _, event := range ctx.EventManager().Events()[eventsBeforeBurn:] {
		if event.Type == banktypes.EventTypeCoinBurn {
			burnObserved = true
			break
		}
	}
	if !burnObserved {
		t.Fatal("authorized native burn did not emit a bank burn event")
	}
	assertNativeSupplyReconciles(t, ctx, expectedSupply.SubRaw(1))
}

func testGenerator() Generator {
	return Generator{
		Codec:        localnetTestApp.AppCodec(),
		TxConfig:     localnetTestApp.TxConfig(),
		BasicModules: localnetTestApp.BasicModuleManager,
	}
}

func equalInt64s(left, right []int64) bool {
	if len(left) != len(right) {
		return false
	}
	for index := range left {
		if left[index] != right[index] {
			return false
		}
	}
	return true
}

func mustLoadFixture(t *testing.T) Fixture {
	t.Helper()
	fixture, err := LoadFixture()
	if err != nil {
		t.Fatal(err)
	}
	return fixture
}

func materialNamed(t *testing.T, materials []accountMaterial, name string) accountMaterial {
	t.Helper()
	for _, material := range materials {
		if material.fixture.Name == name {
			return material
		}
	}
	t.Fatalf("fixture material %s not found", name)
	return accountMaterial{}
}

func assertBankAndEVMBalance(t *testing.T, ctx sdk.Context, material accountMaterial, expected cosmosmath.Int) {
	t.Helper()
	bankBalance := localnetTestApp.BankKeeper.GetBalance(ctx, material.account, toriumconfig.BaseDenom)
	if !bankBalance.Amount.Equal(expected) {
		t.Fatalf("bank balance for %s is %s, expected %s", material.fixture.Name, bankBalance.Amount, expected)
	}
	evmBalance := localnetTestApp.EVMKeeper.GetBalance(ctx, common.BytesToAddress(material.account))
	if evmBalance.ToBig().Cmp(expected.BigInt()) != 0 {
		t.Fatalf("EVM balance for %s is %s, expected %s", material.fixture.Name, evmBalance, expected)
	}
}

func assertNativeSupplyReconciles(t *testing.T, ctx sdk.Context, expected cosmosmath.Int) {
	t.Helper()
	total := cosmosmath.ZeroInt()
	localnetTestApp.BankKeeper.IterateAllBalances(ctx, func(_ sdk.AccAddress, coin sdk.Coin) bool {
		if coin.Denom == toriumconfig.BaseDenom {
			total = total.Add(coin.Amount)
		}
		return false
	})
	supply := localnetTestApp.BankKeeper.GetSupply(ctx, toriumconfig.BaseDenom).Amount
	if !total.Equal(supply) || !supply.Equal(expected) {
		t.Fatalf("native supply does not reconcile: balances=%s supply=%s expected=%s", total, supply, expected)
	}
}
