package torium

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"sort"
	"testing"
	"time"

	"github.com/ethereum/go-ethereum/common"

	"cosmossdk.io/log/v2"
	"cosmossdk.io/math"
	"github.com/cosmos/cosmos-db"
	"github.com/cosmos/cosmos-sdk/baseapp"
	servertypes "github.com/cosmos/cosmos-sdk/server/types"
	sdk "github.com/cosmos/cosmos-sdk/types"
	authtypes "github.com/cosmos/cosmos-sdk/x/auth/types"
	banktypes "github.com/cosmos/cosmos-sdk/x/bank/types"
	distrtypes "github.com/cosmos/cosmos-sdk/x/distribution/types"
	govtypes "github.com/cosmos/cosmos-sdk/x/gov/types"
	govv1 "github.com/cosmos/cosmos-sdk/x/gov/types/v1"
	slashingtypes "github.com/cosmos/cosmos-sdk/x/slashing/types"
	stakingtypes "github.com/cosmos/cosmos-sdk/x/staking/types"
	erc20types "github.com/cosmos/evm/x/erc20/types"
	feemarkettypes "github.com/cosmos/evm/x/feemarket/types"
	evmtypes "github.com/cosmos/evm/x/vm/types"

	toriumconfig "github.com/torium-network/torium-chain/config"
	toriumversion "github.com/torium-network/torium-chain/internal/version"
)

type protocolContract struct {
	ProtocolVersion string `json:"protocolVersion"`
	NativeAsset     struct {
		BaseDenom        string   `json:"baseDenom"`
		DisplayDenom     string   `json:"displayDenom"`
		LocalDenom       string   `json:"localDisplayDenom"`
		Decimals         uint32   `json:"decimals"`
		PowerReduction   string   `json:"powerReduction"`
		CanonicalLedger  string   `json:"canonicalLedger"`
		ConsumerSurfaces []string `json:"consumerSurfaces"`
		Issuance         struct {
			Model                           string `json:"model"`
			MintModuleIncluded              bool   `json:"mintModuleIncluded"`
			InflationPerYear                string `json:"inflationPerYear"`
			PostGenesisNativeMintingAllowed bool   `json:"postGenesisNativeMintingAllowed"`
			ApplicationRestriction          string `json:"applicationRestriction"`
		} `json:"issuance"`
		SolidityInterface struct {
			Kind                       string `json:"kind"`
			Address                    string `json:"address"`
			ContractOwner              string `json:"contractOwner"`
			DuplicateWrappedSupply     bool   `json:"duplicateWrappedSupply"`
			NativeConversionAllowed    bool   `json:"nativeConversionAllowed"`
			PermissionlessRegistration bool   `json:"permissionlessRegistration"`
		} `json:"solidityInterface"`
	} `json:"nativeAsset"`
	NetworkProfiles []struct {
		Environment   string `json:"environment"`
		CosmosChainID string `json:"cosmosChainId"`
		EVMChainID    uint64 `json:"evmChainId"`
	} `json:"networkProfiles"`
	Consensus struct {
		Block struct {
			MaxBytes  int64 `json:"maxBytes"`
			MaxGas    int64 `json:"maxGas"`
			TargetGas int64 `json:"targetGas"`
		} `json:"block"`
		Transaction struct {
			MaxEVMEncodedBytes    int    `json:"maxEvmEncodedBytes"`
			MaxCosmosEncodedBytes int    `json:"maxCosmosEncodedBytes"`
			MaxGasWanted          uint64 `json:"maxGasWanted"`
		} `json:"transaction"`
	} `json:"consensus"`
	Modules struct {
		Included    []string `json:"included"`
		Excluded    []string `json:"excluded"`
		Erc20Policy struct {
			EnableErc20                        bool   `json:"enableErc20"`
			PermissionlessRegistration         bool   `json:"permissionlessRegistration"`
			NativeTokenPairAtGenesis           bool   `json:"nativeTokenPairAtGenesis"`
			NativePrecompileAddress            string `json:"nativePrecompileAddress"`
			NativePairContractOwner            string `json:"nativePairContractOwner"`
			NativeRepresentation               string `json:"nativeRepresentation"`
			NativeConversionAllowed            bool   `json:"nativeConversionAllowed"`
			UpstreamExamplePairsAllowed        bool   `json:"upstreamExamplePairsAllowed"`
			DynamicPrecompilesAtGenesisAllowed bool   `json:"dynamicPrecompilesAtGenesisAllowed"`
		} `json:"erc20Policy"`
	} `json:"modules"`
	EVM struct {
		ActiveCustomPrecompiles []struct {
			Address string `json:"address"`
		} `json:"activeCustomPrecompiles"`
		ExplicitlyInactivePrecompiles []struct {
			Address string `json:"address"`
		} `json:"explicitlyInactivePrecompiles"`
	} `json:"evm"`
	Fees struct {
		Profile                         string `json:"profile"`
		EnabledAtHeight                 int64  `json:"enabledAtHeight"`
		InitialBaseFee                  string `json:"initialBaseFeeBaseUnitsPerGas"`
		MinimumBaseFee                  string `json:"minimumBaseFeeBaseUnitsPerGas"`
		BaseFeeChangeDenominator        uint32 `json:"baseFeeChangeDenominator"`
		ElasticityMultiplier            uint32 `json:"elasticityMultiplier"`
		MinimumGasMultiplier            string `json:"minimumGasMultiplier"`
		MinimumPriorityFeeBaseUnits     string `json:"minimumPriorityFeeBaseUnitsPerGas"`
		ValidatorMinimumGasPrice        string `json:"validatorMinimumGasPrice"`
		FeeCollectorDisposition         string `json:"feeCollectorDisposition"`
		BaseFeeBurned                   bool   `json:"baseFeeBurned"`
		EthereumBurnSemanticsClaimed    bool   `json:"ethereumBurnSemanticsClaimed"`
		UnusedGasRefunded               bool   `json:"unusedGasRefunded"`
		NativeSupplyChangedByCollection bool   `json:"nativeSupplyChangedByFeeCollection"`
		ParameterChangeControl          struct {
			ConsensusAuthority          string `json:"consensusAuthority"`
			OwnerIssue                  int    `json:"ownerIssue"`
			DirectOperatorMutationAllow bool   `json:"directOperatorMutationAllowed"`
		} `json:"parameterChangeControl"`
		PublicProfile struct {
			Status            string `json:"status"`
			ActivationAllowed bool   `json:"activationAllowed"`
			GateIssue         int    `json:"gateIssue"`
		} `json:"publicProfile"`
	} `json:"fees"`
	Mempool struct {
		Profile                       string `json:"profile"`
		CometBFTType                  string `json:"cometBftType"`
		MinimumPriorityFee            uint64 `json:"minimumPriorityFeeBaseUnitsPerGas"`
		PriceLimit                    uint64 `json:"priceLimitBaseUnitsPerGas"`
		PriceBumpPercent              uint64 `json:"priceBumpPercent"`
		AccountExecutableSlots        uint64 `json:"accountExecutableSlots"`
		GlobalExecutableSlots         uint64 `json:"globalExecutableSlots"`
		AccountQueuedSlots            uint64 `json:"accountQueuedSlots"`
		GlobalQueuedSlots             uint64 `json:"globalQueuedSlots"`
		QueuedLifetimeSeconds         int64  `json:"queuedLifetimeSeconds"`
		IncludedNonceCacheSize        int    `json:"includedNonceCacheSize"`
		PendingProposalTimeoutMS      int64  `json:"pendingProposalTimeoutMs"`
		CheckTxTimeoutMS              int64  `json:"checkTxTimeoutMs"`
		InsertQueueSize               int    `json:"insertQueueSize"`
		TransactionTrackerEnabled     bool   `json:"transactionTrackerEnabled"`
		CosmosPoolMaxTransactions     int    `json:"cosmosPoolMaxTransactions"`
		MaximumEVMTransactionBytes    int    `json:"maximumEvmTransactionBytes"`
		MaximumCosmosTransactionBytes int    `json:"maximumCosmosTransactionBytes"`
		CometReapMaxBytes             uint64 `json:"cometReapMaxBytes"`
		CometReapMaxGas               uint64 `json:"cometReapMaxGas"`
		NetworkWideReplacement        bool   `json:"networkWideReplacementGuaranteed"`
		AbuseModel                    struct {
			StateGrowthGasLowerBound int64 `json:"stateGrowthGasLowerBoundPerNewSlot"`
			TargetSlots              int64 `json:"theoreticalNewSlotsAtTargetGas"`
			BlockSlots               int64 `json:"theoreticalNewSlotsAtBlockGasLimit"`
			SustainedGrowthBounded   bool  `json:"sustainedStateGrowthBounded"`
			PublicCapacityClaimed    bool  `json:"publicCapacityClaimed"`
		} `json:"abuseModel"`
	} `json:"mempool"`
	ValidatorEconomics struct {
		Status           string `json:"status"`
		PublicActivation struct {
			Allowed                    bool `json:"allowed"`
			GateIssue                  int  `json:"gateIssue"`
			RequiresFreshGenesisReview bool `json:"requiresFreshGenesisReview"`
		} `json:"publicActivation"`
		Staking struct {
			BondDenom                      string `json:"bondDenom"`
			PowerReduction                 string `json:"powerReduction"`
			MinimumSelfDelegationBaseUnits string `json:"minimumSelfDelegationBaseUnits"`
			MaximumActiveValidators        uint32 `json:"maximumActiveValidators"`
			MaximumEntries                 uint32 `json:"maximumEntries"`
			HistoricalEntries              uint32 `json:"historicalEntries"`
			UnbondingTimeSeconds           int64  `json:"unbondingTimeSeconds"`
		} `json:"staking"`
		Commission struct {
			MinimumRate            string `json:"minimumRate"`
			MaximumRate            string `json:"maximumRate"`
			MaximumDailyChangeRate string `json:"maximumDailyChangeRate"`
		} `json:"commission"`
		Distribution struct {
			Funding                string `json:"funding"`
			CommunityTax           string `json:"communityTax"`
			WithdrawAddressEnabled bool   `json:"withdrawAddressEnabled"`
			NativeMintingAllowed   bool   `json:"nativeMintingAllowed"`
		} `json:"distribution"`
		Slashing struct {
			SignedBlocksWindow          int64  `json:"signedBlocksWindow"`
			MinimumSignedPerWindow      string `json:"minimumSignedPerWindow"`
			DowntimeJailDurationSeconds int64  `json:"downtimeJailDurationSeconds"`
			DowntimeSlashFraction       string `json:"downtimeSlashFraction"`
			DoubleSignSlashFraction     string `json:"doubleSignSlashFraction"`
			DoubleSignJail              string `json:"doubleSignJail"`
		} `json:"slashing"`
		Evidence struct {
			AcceptedMisbehavior       []string `json:"acceptedMisbehavior"`
			MaximumAgeBlocks          int64    `json:"maximumAgeBlocks"`
			MaximumAgeDurationSeconds int64    `json:"maximumAgeDurationSeconds"`
			MaximumBytesPerBlock      int64    `json:"maximumBytesPerBlock"`
		} `json:"evidence"`
		Lifecycle struct {
			SupportedOperations          []string `json:"supportedOperations"`
			QuerySurfaces                []string `json:"querySurfaces"`
			PrivilegedNativeMintRequired bool     `json:"privilegedNativeMintRequired"`
		} `json:"lifecycle"`
	} `json:"validatorEconomics"`
}

type mapAppOptions map[string]any

func (options mapAppOptions) Get(key string) any { return options[key] }

var contractTestApp *ToriumApp

func TestMain(m *testing.M) {
	cfg := sdk.GetConfig()
	toriumconfig.SetBech32Prefixes(cfg)
	toriumconfig.SetBip44CoinType(cfg)
	cfg.Seal()
	contractTestApp = NewToriumApp(log.NewNopLogger(), db.NewMemDB(), false, mapAppOptions{})
	os.Exit(m.Run())
}

func TestProtocolContractMatchesRuntimeComposition(t *testing.T) {
	contract := loadProtocolContract(t)
	app := contractTestApp

	actualModules := make([]string, 0, len(app.ModuleManager.Modules))
	for name := range app.ModuleManager.Modules {
		actualModules = append(actualModules, name)
	}
	sort.Strings(actualModules)
	expectedModules := append([]string(nil), contract.Modules.Included...)
	sort.Strings(expectedModules)
	if !slices.Equal(actualModules, expectedModules) {
		t.Fatalf("runtime modules differ from protocol contract\nactual:   %v\nexpected: %v", actualModules, expectedModules)
	}

	genesis := app.DefaultGenesis()
	basicGenesis := app.BasicModuleManager.DefaultGenesis(app.appCodec)
	for _, excluded := range contract.Modules.Excluded {
		if _, present := app.ModuleManager.Modules[excluded]; present {
			t.Errorf("excluded module %q is wired into the runtime", excluded)
		}
		if _, present := genesis[excluded]; present {
			t.Errorf("excluded module %q has a genesis section", excluded)
		}
	}

	evmGenesis := NewEVMGenesisState()
	var basicEVMGenesis evmtypes.GenesisState
	app.appCodec.MustUnmarshalJSON(basicGenesis[evmtypes.ModuleName], &basicEVMGenesis)
	if !slices.Equal(basicEVMGenesis.Params.ActiveStaticPrecompiles, evmGenesis.Params.ActiveStaticPrecompiles) ||
		basicEVMGenesis.Params.EvmDenom != BaseDenom {
		t.Fatal("CLI init EVM genesis does not use Torium defaults")
	}
	actualPrecompiles := append([]string(nil), evmGenesis.Params.ActiveStaticPrecompiles...)
	expectedPrecompiles := make([]string, 0, len(contract.EVM.ActiveCustomPrecompiles))
	for _, precompile := range contract.EVM.ActiveCustomPrecompiles {
		expectedPrecompiles = append(expectedPrecompiles, precompile.Address)
		address := common.HexToAddress(precompile.Address)
		if _, active, err := app.EVMKeeper.GetStaticPrecompileInstance(&evmGenesis.Params, address); err != nil {
			t.Fatalf("resolve active precompile %s: %v", precompile.Address, err)
		} else if !active {
			t.Errorf("protocol precompile %s is not available at runtime", precompile.Address)
		}
	}
	if !slices.Equal(actualPrecompiles, expectedPrecompiles) {
		t.Fatalf("active custom precompiles differ from protocol contract\nactual:   %v\nexpected: %v", actualPrecompiles, expectedPrecompiles)
	}
	for _, precompile := range contract.EVM.ExplicitlyInactivePrecompiles {
		address := common.HexToAddress(precompile.Address)
		if _, active, err := app.EVMKeeper.GetStaticPrecompileInstance(&evmGenesis.Params, address); err != nil {
			t.Fatalf("resolve inactive precompile %s: %v", precompile.Address, err)
		} else if active {
			t.Errorf("explicitly inactive precompile %s is available", precompile.Address)
		}
	}

	erc20Genesis := NewErc20GenesisState()
	var basicErc20Genesis erc20types.GenesisState
	app.appCodec.MustUnmarshalJSON(basicGenesis[erc20types.ModuleName], &basicErc20Genesis)
	if len(basicErc20Genesis.TokenPairs) != 1 ||
		len(basicErc20Genesis.NativePrecompiles) != 1 ||
		basicErc20Genesis.TokenPairs[0].Erc20Address != erc20Genesis.TokenPairs[0].Erc20Address ||
		basicErc20Genesis.TokenPairs[0].Denom != erc20Genesis.TokenPairs[0].Denom ||
		basicErc20Genesis.Params != erc20Genesis.Params {
		t.Fatalf("CLI init ERC-20 genesis does not use Torium native facade defaults: %+v", basicErc20Genesis)
	}
	if !erc20Genesis.Params.EnableErc20 || erc20Genesis.Params.PermissionlessRegistration {
		t.Fatalf("ERC-20 params do not enforce the native facade policy: %+v", erc20Genesis.Params)
	}
	if len(erc20Genesis.TokenPairs) != 1 || len(erc20Genesis.NativePrecompiles) != 1 {
		t.Fatalf("ERC-20 genesis must contain exactly one native pair/precompile: %+v", erc20Genesis)
	}
	nativePair := erc20Genesis.TokenPairs[0]
	if nativePair.Denom != BaseDenom ||
		!nativePair.Enabled ||
		nativePair.ContractOwner != erc20types.OWNER_MODULE ||
		nativePair.Erc20Address != toriumconfig.NativeTORPrecompileAddress {
		t.Fatalf("canonical native token pair differs from protocol: %+v", nativePair)
	}
	if erc20Genesis.NativePrecompiles[0] != toriumconfig.NativeTORPrecompileAddress ||
		len(erc20Genesis.DynamicPrecompiles) != 0 ||
		len(erc20Genesis.Allowances) != 0 {
		t.Fatalf("ERC-20 genesis inherited an unauthorized representation: %+v", erc20Genesis)
	}
	policy := contract.Modules.Erc20Policy
	if !policy.EnableErc20 || policy.PermissionlessRegistration || !policy.NativeTokenPairAtGenesis ||
		policy.NativePrecompileAddress != nativePair.Erc20Address ||
		policy.NativePairContractOwner != "module" ||
		policy.NativeRepresentation != "bank-backed-facade-no-duplicate-supply" ||
		policy.NativeConversionAllowed || policy.UpstreamExamplePairsAllowed || policy.DynamicPrecompilesAtGenesisAllowed {
		t.Fatalf("runtime ERC-20 genesis differs from protocol policy: %+v", policy)
	}
	if len(evmGenesis.Preinstalls) != 0 || len(evmGenesis.Params.EVMChannels) != 0 {
		t.Fatal("EVM genesis must not inherit preinstalls or IBC channels")
	}

	var basicFeeMarketGenesis feemarkettypes.GenesisState
	app.appCodec.MustUnmarshalJSON(basicGenesis[feemarkettypes.ModuleName], &basicFeeMarketGenesis)
	if basicFeeMarketGenesis.Params.EnableHeight != contract.Fees.EnabledAtHeight {
		t.Fatalf("CLI init fee market height is %d, expected %d", basicFeeMarketGenesis.Params.EnableHeight, contract.Fees.EnabledAtHeight)
	}
	var basicStakingGenesis stakingtypes.GenesisState
	app.appCodec.MustUnmarshalJSON(basicGenesis[stakingtypes.ModuleName], &basicStakingGenesis)
	if basicStakingGenesis.Params.BondDenom != BaseDenom {
		t.Fatalf("CLI init staking denom is %q, expected %q", basicStakingGenesis.Params.BondDenom, BaseDenom)
	}
	var basicBankGenesis banktypes.GenesisState
	app.appCodec.MustUnmarshalJSON(basicGenesis[banktypes.ModuleName], &basicBankGenesis)
	if len(basicBankGenesis.DenomMetadata) != 1 {
		t.Fatalf("CLI init bank metadata count is %d, expected 1", len(basicBankGenesis.DenomMetadata))
	}
	metadata := basicBankGenesis.DenomMetadata[0]
	if metadata.Base != BaseDenom || metadata.Display != contract.NativeAsset.LocalDenom || len(metadata.DenomUnits) != 2 {
		t.Fatalf("CLI init bank metadata differs from native asset contract: %+v", metadata)
	}
	if metadata.DenomUnits[0].Exponent != 0 || metadata.DenomUnits[1].Exponent != contract.NativeAsset.Decimals {
		t.Fatalf("CLI init bank denom exponents differ from native asset contract: %+v", metadata.DenomUnits)
	}
	var basicGovGenesis govv1.GenesisState
	app.appCodec.MustUnmarshalJSON(basicGenesis[govtypes.ModuleName], &basicGovGenesis)
	if basicGovGenesis.Params == nil {
		t.Fatal("CLI init governance params are missing")
	}
	params := basicGovGenesis.Params
	if len(params.MinDeposit) != 1 || params.MinDeposit[0].Denom != BaseDenom ||
		params.MinDeposit[0].Amount.String() != toriumconfig.LocalGovernanceMinDepositBaseUnits ||
		len(params.ExpeditedMinDeposit) != 1 || params.ExpeditedMinDeposit[0].Denom != BaseDenom ||
		params.ExpeditedMinDeposit[0].Amount.String() != toriumconfig.LocalGovernanceExpeditedMinDepositBaseUnits ||
		params.MaxDepositPeriod == nil || *params.MaxDepositPeriod != toriumconfig.LocalGovernanceMaxDepositPeriod ||
		params.VotingPeriod == nil || *params.VotingPeriod != toriumconfig.LocalGovernanceVotingPeriod ||
		params.ExpeditedVotingPeriod == nil || *params.ExpeditedVotingPeriod != toriumconfig.LocalGovernanceExpeditedVotingPeriod ||
		params.Quorum != toriumconfig.LocalGovernanceQuorum ||
		params.Threshold != toriumconfig.LocalGovernanceThreshold ||
		params.ExpeditedThreshold != toriumconfig.LocalGovernanceExpeditedThreshold ||
		params.VetoThreshold != toriumconfig.LocalGovernanceVetoThreshold ||
		params.MinInitialDepositRatio != toriumconfig.LocalGovernanceMinInitialDepositRatio ||
		params.MinDepositRatio != toriumconfig.LocalGovernanceMinDepositRatio ||
		params.ProposalCancelRatio != toriumconfig.LocalGovernanceProposalCancelRatio ||
		params.ProposalCancelDest != "" || !params.BurnProposalDepositPrevote || !params.BurnVoteQuorum || !params.BurnVoteVeto {
		t.Fatalf("CLI init governance parameters differ from the ratified local contract: %+v", params)
	}
}

func TestRuntimeKeeperAuthoritiesUseOnlyGovernanceModuleAccount(t *testing.T) {
	expected := authtypes.NewModuleAddress(govtypes.ModuleName).String()
	authorities := map[string]string{
		"auth":         contractTestApp.AccountKeeper.GetAuthority(),
		"bank":         contractTestApp.BankKeeper.GetAuthority(),
		"consensus":    contractTestApp.ConsensusParamsKeeper.GetAuthority(),
		"distribution": contractTestApp.DistrKeeper.GetAuthority(),
		"governance":   contractTestApp.GovKeeper.GetAuthority(),
		"slashing":     contractTestApp.SlashingKeeper.GetAuthority(),
		"staking":      contractTestApp.StakingKeeper.GetAuthority(),
		"evm":          contractTestApp.EVMKeeper.GetAuthority().String(),
	}
	for module, authority := range authorities {
		if authority != expected {
			t.Errorf("%s authority is %q, expected governance module account %q", module, authority, expected)
		}
	}
}

func TestProtocolContractMatchesIdentityAndEconomics(t *testing.T) {
	contract := loadProtocolContract(t)
	if BaseDenom != contract.NativeAsset.BaseDenom {
		t.Fatalf("base denom %q does not match protocol %q", BaseDenom, contract.NativeAsset.BaseDenom)
	}
	if toriumconfig.LocalDisplayDenom != contract.NativeAsset.LocalDenom {
		t.Fatalf("local display denom %q does not match protocol %q", toriumconfig.LocalDisplayDenom, contract.NativeAsset.LocalDenom)
	}
	if toriumconfig.Decimals != contract.NativeAsset.Decimals {
		t.Fatalf("decimals %d do not match protocol %d", toriumconfig.Decimals, contract.NativeAsset.Decimals)
	}
	if sdk.DefaultPowerReduction.String() != contract.NativeAsset.PowerReduction {
		t.Fatalf("staking power reduction %s does not match protocol %s", sdk.DefaultPowerReduction, contract.NativeAsset.PowerReduction)
	}
	if toriumconfig.DisplayDenom != contract.NativeAsset.DisplayDenom ||
		toriumconfig.NativeTORPrecompileAddress != contract.NativeAsset.SolidityInterface.Address {
		t.Fatalf("native asset display/precompile constants differ from protocol: %s/%s", toriumconfig.DisplayDenom, toriumconfig.NativeTORPrecompileAddress)
	}
	if contract.NativeAsset.CanonicalLedger != "cosmos-bank-balance-exposed-to-evm" ||
		contract.NativeAsset.Issuance.Model != "genesis-capped-non-inflationary" ||
		contract.NativeAsset.Issuance.MintModuleIncluded ||
		contract.NativeAsset.Issuance.InflationPerYear != "0" ||
		contract.NativeAsset.Issuance.PostGenesisNativeMintingAllowed ||
		contract.NativeAsset.SolidityInterface.DuplicateWrappedSupply ||
		contract.NativeAsset.SolidityInterface.NativeConversionAllowed ||
		contract.NativeAsset.SolidityInterface.PermissionlessRegistration {
		t.Fatalf("native asset monetary policy is unsafe or incomplete: %+v", contract.NativeAsset)
	}

	knownNetworks := map[string]struct {
		cosmos string
		evm    uint64
	}{
		"localnet": {toriumconfig.LocalCosmosChainID, toriumconfig.LocalEVMChainID},
		"devnet":   {toriumconfig.DevCosmosChainID, toriumconfig.DevEVMChainID},
		"testnet":  {toriumconfig.TestCosmosChainID, toriumconfig.TestEVMChainID},
		"mainnet":  {toriumconfig.MainCosmosChainID, toriumconfig.MainEVMChainID},
	}
	for _, profile := range contract.NetworkProfiles {
		expected, ok := knownNetworks[profile.Environment]
		if !ok {
			t.Fatalf("unknown protocol network profile %q", profile.Environment)
		}
		if profile.CosmosChainID != expected.cosmos || profile.EVMChainID != expected.evm {
			t.Errorf("%s constants differ: got %s/%d, expected %s/%d", profile.Environment, expected.cosmos, expected.evm, profile.CosmosChainID, profile.EVMChainID)
		}
		if err := toriumconfig.ValidateNetworkPair(profile.CosmosChainID, profile.EVMChainID); err != nil {
			t.Errorf("canonical %s pair was rejected: %v", profile.Environment, err)
		}
	}
	if err := toriumconfig.ValidateNetworkPair(toriumconfig.LocalCosmosChainID, toriumconfig.DevEVMChainID); err == nil {
		t.Fatal("mismatched Cosmos/EVM replay domains were accepted")
	}

	initialBaseFee := math.LegacyMustNewDecFromStr(contract.Fees.InitialBaseFee)
	minimumBaseFee := math.LegacyMustNewDecFromStr(contract.Fees.MinimumBaseFee)
	minimumGasMultiplier := math.LegacyMustNewDecFromStr(contract.Fees.MinimumGasMultiplier)
	minimumPriorityFee, ok := math.NewIntFromString(contract.Fees.MinimumPriorityFeeBaseUnits)
	if !ok || !minimumPriorityFee.IsUint64() {
		t.Fatalf("invalid minimum priority fee %q", contract.Fees.MinimumPriorityFeeBaseUnits)
	}
	fees := NewFeeMarketGenesisState().Params
	if fees.EnableHeight != contract.Fees.EnabledAtHeight ||
		!fees.BaseFee.Equal(initialBaseFee) ||
		fees.BaseFeeChangeDenominator != contract.Fees.BaseFeeChangeDenominator ||
		fees.ElasticityMultiplier != contract.Fees.ElasticityMultiplier ||
		!fees.MinGasMultiplier.Equal(minimumGasMultiplier) ||
		!fees.MinGasPrice.Equal(minimumBaseFee) {
		t.Fatalf("fee market genesis differs from protocol contract: %+v", fees)
	}
	policy := toriumconfig.MustLocalFeeAndResourcePolicy()
	_, rawAppConfig := toriumconfig.InitAppConfig()
	appConfig, ok := rawAppConfig.(toriumconfig.EVMAppConfig)
	if !ok {
		t.Fatalf("unexpected app config type %T", rawAppConfig)
	}
	if contract.Fees.Profile != policy.Profile || contract.Fees.ValidatorMinimumGasPrice != policy.ValidatorMinimumGasPrice ||
		contract.Fees.FeeCollectorDisposition != "cosmos-fee-collector-then-distribution" ||
		contract.Fees.BaseFeeBurned || contract.Fees.EthereumBurnSemanticsClaimed ||
		!contract.Fees.UnusedGasRefunded || contract.Fees.NativeSupplyChangedByCollection ||
		contract.Fees.ParameterChangeControl.ConsensusAuthority != "cosmos-governance-module-account" ||
		contract.Fees.ParameterChangeControl.OwnerIssue != 106 ||
		contract.Fees.ParameterChangeControl.DirectOperatorMutationAllow ||
		contract.Fees.PublicProfile.Status != "not-defined-not-activatable" ||
		contract.Fees.PublicProfile.ActivationAllowed || contract.Fees.PublicProfile.GateIssue != 127 ||
		appConfig.EVM.MinTip != minimumPriorityFee.Uint64() {
		t.Fatalf("fee policy activation or accounting contract is unsafe: %+v", contract.Fees)
	}
	if contract.Consensus.Block.MaxBytes != policy.BlockMaxBytes ||
		contract.Consensus.Block.MaxGas != policy.BlockMaxGas ||
		contract.Consensus.Block.TargetGas != policy.BlockTargetGas ||
		contract.Consensus.Transaction.MaxEVMEncodedBytes != policy.MaxEVMTransactionBytes ||
		contract.Consensus.Transaction.MaxCosmosEncodedBytes != policy.MaxCosmosTransactionBytes ||
		contract.Consensus.Transaction.MaxGasWanted != policy.MaxTxGasWanted ||
		contract.Mempool.Profile != policy.Profile || contract.Mempool.CometBFTType != "app" ||
		contract.Mempool.MinimumPriorityFee != policy.MempoolMinimumPriorityFee ||
		contract.Mempool.PriceLimit != policy.MempoolPriceLimit ||
		contract.Mempool.PriceBumpPercent != policy.MempoolPriceBumpPercent ||
		contract.Mempool.AccountExecutableSlots != policy.MempoolAccountExecutableSlots ||
		contract.Mempool.GlobalExecutableSlots != policy.MempoolGlobalExecutableSlots ||
		contract.Mempool.AccountQueuedSlots != policy.MempoolAccountQueuedSlots ||
		contract.Mempool.GlobalQueuedSlots != policy.MempoolGlobalQueuedSlots ||
		time.Duration(contract.Mempool.QueuedLifetimeSeconds)*time.Second != policy.MempoolQueuedLifetime ||
		contract.Mempool.IncludedNonceCacheSize != policy.MempoolIncludedNonceCacheSize ||
		time.Duration(contract.Mempool.PendingProposalTimeoutMS)*time.Millisecond != policy.MempoolPendingProposalTimeout ||
		time.Duration(contract.Mempool.CheckTxTimeoutMS)*time.Millisecond != policy.MempoolCheckTxTimeout ||
		contract.Mempool.InsertQueueSize != policy.MempoolInsertQueueSize ||
		contract.Mempool.TransactionTrackerEnabled != policy.MempoolTransactionTrackerEnabled ||
		contract.Mempool.CosmosPoolMaxTransactions != policy.CosmosMempoolMaxTransactions ||
		contract.Mempool.MaximumEVMTransactionBytes != policy.MaxEVMTransactionBytes ||
		contract.Mempool.MaximumCosmosTransactionBytes != policy.MaxCosmosTransactionBytes ||
		contract.Mempool.CometReapMaxBytes != policy.CometReapMaxBytes ||
		contract.Mempool.CometReapMaxGas != policy.CometReapMaxGas ||
		contract.Mempool.NetworkWideReplacement ||
		contract.Mempool.AbuseModel.StateGrowthGasLowerBound*contract.Mempool.AbuseModel.TargetSlots != policy.BlockTargetGas ||
		contract.Mempool.AbuseModel.StateGrowthGasLowerBound*contract.Mempool.AbuseModel.BlockSlots != policy.BlockMaxGas ||
		contract.Mempool.AbuseModel.SustainedGrowthBounded || contract.Mempool.AbuseModel.PublicCapacityClaimed {
		t.Fatalf("resource and mempool policy differs from runtime: %+v", contract.Mempool)
	}
}

func TestValidatorEconomicsGenesisContract(t *testing.T) {
	contract := loadProtocolContract(t)
	economics := contract.ValidatorEconomics
	if contract.ProtocolVersion != toriumversion.ProtocolVersion || economics.Status != "ratified-local-only" ||
		economics.PublicActivation.Allowed || economics.PublicActivation.GateIssue != 127 ||
		!economics.PublicActivation.RequiresFreshGenesisReview {
		t.Fatalf("validator economics activation boundary is unsafe: %+v", economics.PublicActivation)
	}
	minimumCommission := math.LegacyMustNewDecFromStr(economics.Commission.MinimumRate)
	maximumCommission := math.LegacyMustNewDecFromStr(economics.Commission.MaximumRate)
	maximumCommissionChange := math.LegacyMustNewDecFromStr(economics.Commission.MaximumDailyChangeRate)
	minimumSigned := math.LegacyMustNewDecFromStr(economics.Slashing.MinimumSignedPerWindow)
	downtimeSlash := math.LegacyMustNewDecFromStr(economics.Slashing.DowntimeSlashFraction)
	doubleSignSlash := math.LegacyMustNewDecFromStr(economics.Slashing.DoubleSignSlashFraction)
	communityTax := math.LegacyMustNewDecFromStr(economics.Distribution.CommunityTax)
	if economics.Staking.BondDenom != BaseDenom ||
		economics.Staking.PowerReduction != sdk.DefaultPowerReduction.String() ||
		economics.Staking.MinimumSelfDelegationBaseUnits != toriumconfig.MinimumValidatorSelfDelegation.String() ||
		economics.Staking.MaximumActiveValidators != toriumconfig.ValidatorMaxActive ||
		economics.Staking.MaximumEntries != toriumconfig.ValidatorMaxEntries ||
		economics.Staking.HistoricalEntries != toriumconfig.ValidatorHistory ||
		time.Duration(economics.Staking.UnbondingTimeSeconds)*time.Second != toriumconfig.ValidatorUnbondingTime ||
		!minimumCommission.Equal(toriumconfig.MinimumValidatorCommissionRate) ||
		!maximumCommission.Equal(toriumconfig.MaximumValidatorCommissionRate) ||
		!maximumCommissionChange.Equal(toriumconfig.MaximumCommissionChangeRate) ||
		economics.Slashing.SignedBlocksWindow != toriumconfig.SignedBlocksWindow ||
		!minimumSigned.Equal(toriumconfig.MinimumSignedPerWindow) ||
		time.Duration(economics.Slashing.DowntimeJailDurationSeconds)*time.Second != toriumconfig.DowntimeJailDuration ||
		!downtimeSlash.Equal(toriumconfig.SlashFractionDowntime) ||
		!doubleSignSlash.Equal(toriumconfig.SlashFractionDoubleSign) ||
		!communityTax.Equal(toriumconfig.DistributionCommunityTax) {
		t.Fatalf("machine-readable validator economics differ from runtime constants: %+v", economics)
	}
	if economics.Distribution.Funding != "transaction-fees-and-existing-bank-balances-only" ||
		economics.Distribution.NativeMintingAllowed ||
		!economics.Distribution.WithdrawAddressEnabled ||
		economics.Slashing.DoubleSignJail != "permanent-tombstone" ||
		!slices.Equal(economics.Evidence.AcceptedMisbehavior, []string{"duplicate-vote", "light-client-attack"}) ||
		economics.Evidence.MaximumAgeBlocks != toriumconfig.EvidenceMaxAgeBlocks ||
		time.Duration(economics.Evidence.MaximumAgeDurationSeconds)*time.Second != toriumconfig.EvidenceMaxAge ||
		economics.Evidence.MaximumBytesPerBlock != toriumconfig.EvidenceMaximumBytes ||
		economics.Lifecycle.PrivilegedNativeMintRequired ||
		len(economics.Lifecycle.SupportedOperations) != 8 || len(economics.Lifecycle.QuerySurfaces) != 5 {
		t.Fatalf("validator lifecycle/evidence contract is incomplete: %+v", economics)
	}

	stakingGenesis := NewStakingGenesisState()
	if stakingGenesis.Params.BondDenom != BaseDenom ||
		stakingGenesis.Params.UnbondingTime != toriumconfig.ValidatorUnbondingTime ||
		stakingGenesis.Params.MaxValidators != toriumconfig.ValidatorMaxActive ||
		stakingGenesis.Params.MaxEntries != toriumconfig.ValidatorMaxEntries ||
		stakingGenesis.Params.HistoricalEntries != toriumconfig.ValidatorHistory ||
		!stakingGenesis.Params.MinCommissionRate.Equal(toriumconfig.MinimumValidatorCommissionRate) {
		t.Fatalf("staking genesis differs from validator economics contract: %+v", stakingGenesis.Params)
	}

	slashingGenesis := NewSlashingGenesisState()
	if slashingGenesis.Params.SignedBlocksWindow != toriumconfig.SignedBlocksWindow ||
		!slashingGenesis.Params.MinSignedPerWindow.Equal(toriumconfig.MinimumSignedPerWindow) ||
		slashingGenesis.Params.DowntimeJailDuration != toriumconfig.DowntimeJailDuration ||
		!slashingGenesis.Params.SlashFractionDowntime.Equal(toriumconfig.SlashFractionDowntime) ||
		!slashingGenesis.Params.SlashFractionDoubleSign.Equal(toriumconfig.SlashFractionDoubleSign) {
		t.Fatalf("slashing genesis differs from validator economics contract: %+v", slashingGenesis.Params)
	}

	distributionGenesis := NewDistributionGenesisState()
	if !distributionGenesis.Params.CommunityTax.Equal(toriumconfig.DistributionCommunityTax) ||
		!distributionGenesis.Params.WithdrawAddrEnabled {
		t.Fatalf("distribution genesis differs from validator economics contract: %+v", distributionGenesis.Params)
	}

	app := contractTestApp
	hooks, ok := app.StakingKeeper.Hooks().(stakingtypes.MultiStakingHooks)
	if !ok || len(hooks) != 3 {
		t.Fatalf("staking creation policy/distribution/slashing hooks are incomplete: %T/%d", app.StakingKeeper.Hooks(), len(hooks))
	}
	if _, ok := hooks[0].(validatorPolicyHooks); !ok {
		t.Fatalf("keeper-level validator policy is not first in the hook chain: %T", hooks[0])
	}
	basicGenesis := app.BasicModuleManager.DefaultGenesis(app.appCodec)
	var basicStaking stakingtypes.GenesisState
	var basicSlashing slashingtypes.GenesisState
	var basicDistribution distrtypes.GenesisState
	app.appCodec.MustUnmarshalJSON(basicGenesis[stakingtypes.ModuleName], &basicStaking)
	app.appCodec.MustUnmarshalJSON(basicGenesis[slashingtypes.ModuleName], &basicSlashing)
	app.appCodec.MustUnmarshalJSON(basicGenesis[distrtypes.ModuleName], &basicDistribution)
	if !reflect.DeepEqual(basicStaking.Params, stakingGenesis.Params) ||
		!reflect.DeepEqual(basicSlashing.Params, slashingGenesis.Params) ||
		!reflect.DeepEqual(basicDistribution.Params, distributionGenesis.Params) {
		t.Fatal("CLI/default genesis does not use the canonical validator economics states")
	}
}

func TestApplicationRejectsMismatchedReplayDomains(t *testing.T) {
	defer func() {
		if recover() == nil {
			t.Fatal("application accepted a mismatched Cosmos/EVM chain ID pair")
		}
	}()
	NewToriumApp(
		log.NewNopLogger(),
		db.NewMemDB(),
		false,
		mapAppOptions{"evm.evm-chain-id": toriumconfig.LocalEVMChainID},
		baseapp.SetChainID(toriumconfig.DevCosmosChainID),
	)
}

func TestApplicationIdentityIsTorium(t *testing.T) {
	app := contractTestApp
	if app.Name() != toriumconfig.ApplicationName {
		t.Fatalf("application name is %q, expected %q", app.Name(), toriumconfig.ApplicationName)
	}
	if app.Version() != toriumversion.Version {
		t.Fatalf("application version is %q, expected %q", app.Version(), toriumversion.Version)
	}
}

func loadProtocolContract(t *testing.T) protocolContract {
	t.Helper()
	path := filepath.Join("..", "config", "protocol-v1.json")
	contents, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read protocol contract %s: %v", path, err)
	}
	var contract protocolContract
	if err := json.Unmarshal(contents, &contract); err != nil {
		t.Fatalf("decode protocol contract %s: %v", path, err)
	}
	return contract
}

var _ servertypes.AppOptions = mapAppOptions{}
