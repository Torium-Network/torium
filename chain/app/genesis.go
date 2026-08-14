package torium

import (
	"encoding/json"
	"strconv"

	"github.com/ethereum/go-ethereum/common"

	"cosmossdk.io/math"

	"github.com/cosmos/cosmos-sdk/codec"
	sdk "github.com/cosmos/cosmos-sdk/types"
	"github.com/cosmos/cosmos-sdk/types/module"
	"github.com/cosmos/cosmos-sdk/x/auth"
	"github.com/cosmos/cosmos-sdk/x/bank"
	banktypes "github.com/cosmos/cosmos-sdk/x/bank/types"
	"github.com/cosmos/cosmos-sdk/x/consensus"
	"github.com/cosmos/cosmos-sdk/x/distribution"
	distrtypes "github.com/cosmos/cosmos-sdk/x/distribution/types"
	"github.com/cosmos/cosmos-sdk/x/evidence"
	"github.com/cosmos/cosmos-sdk/x/genutil"
	genutiltypes "github.com/cosmos/cosmos-sdk/x/genutil/types"
	"github.com/cosmos/cosmos-sdk/x/gov"
	govv1 "github.com/cosmos/cosmos-sdk/x/gov/types/v1"
	"github.com/cosmos/cosmos-sdk/x/slashing"
	slashingtypes "github.com/cosmos/cosmos-sdk/x/slashing/types"
	"github.com/cosmos/cosmos-sdk/x/staking"
	stakingtypes "github.com/cosmos/cosmos-sdk/x/staking/types"
	"github.com/cosmos/cosmos-sdk/x/upgrade"
	"github.com/cosmos/evm/x/erc20"
	erc20types "github.com/cosmos/evm/x/erc20/types"
	"github.com/cosmos/evm/x/feemarket"
	feemarkettypes "github.com/cosmos/evm/x/feemarket/types"
	"github.com/cosmos/evm/x/vm"
	evmtypes "github.com/cosmos/evm/x/vm/types"
	toriumconfig "github.com/torium-network/torium-chain/config"
)

// GenesisState maps module names to their deterministic JSON genesis state.
type GenesisState map[string]json.RawMessage

// NewBasicModuleManager builds the keeper-free CLI and genesis surface. It is
// intentionally separate from NewToriumApp so a command process creates the
// state machine exactly once.
func NewBasicModuleManager() module.BasicManager {
	return module.NewBasicManager(
		genutil.NewAppModuleBasic(genutiltypes.DefaultMessageValidator),
		auth.AppModuleBasic{},
		toriumBankAppModuleBasic{AppModuleBasic: bank.AppModuleBasic{}},
		toriumGovAppModuleBasic{AppModuleBasic: gov.NewAppModuleBasic(nil)},
		toriumDistributionAppModuleBasic{AppModuleBasic: distribution.AppModuleBasic{}},
		toriumSlashingAppModuleBasic{AppModuleBasic: slashing.AppModuleBasic{}},
		toriumStakingAppModuleBasic{AppModuleBasic: staking.AppModuleBasic{}},
		upgrade.AppModuleBasic{},
		evidence.AppModuleBasic{},
		consensus.AppModuleBasic{},
		toriumEVMAppModuleBasic{AppModuleBasic: vm.AppModuleBasic{}},
		toriumFeeMarketAppModuleBasic{AppModuleBasic: feemarket.AppModuleBasic{}},
		toriumErc20AppModuleBasic{AppModuleBasic: erc20.AppModuleBasic{}},
	)
}

// ActiveStaticPrecompiles is the complete Torium protocol v1 custom precompile set.
var ActiveStaticPrecompiles = append([]string(nil), toriumconfig.CustomPrecompileAddresses...)

// NewEVMGenesisState returns the protocol-v1 EVM genesis state.
func NewEVMGenesisState() *evmtypes.GenesisState {
	state := evmtypes.DefaultGenesisState()
	state.Params.EvmDenom = BaseDenom
	state.Params.ExtendedDenomOptions = &evmtypes.ExtendedDenomOptions{
		ExtendedDenom: BaseDenom,
	}
	state.Params.ActiveStaticPrecompiles = append([]string(nil), ActiveStaticPrecompiles...)
	state.Params.EVMChannels = []string{}
	state.Preinstalls = nil
	return state
}

// NewErc20GenesisState registers the one canonical Solidity facade for native
// TOR. The WERC20 precompile reads and writes x/bank directly; the token pair
// does not create a wrapped balance or a second supply.
func NewErc20GenesisState() *erc20types.GenesisState {
	state := erc20types.DefaultGenesisState()
	state.Params = erc20types.NewParams(true, false)
	state.TokenPairs = []erc20types.TokenPair{
		erc20types.NewTokenPair(
			common.HexToAddress(toriumconfig.NativeTORPrecompileAddress),
			BaseDenom,
			erc20types.OWNER_MODULE,
		),
	}
	state.Allowances = nil
	state.NativePrecompiles = []string{toriumconfig.NativeTORPrecompileAddress}
	state.DynamicPrecompiles = nil
	return state
}

// NewFeeMarketGenesisState enables protocol-v1 EIP-1559-style pricing at height 1.
func NewFeeMarketGenesisState() *feemarkettypes.GenesisState {
	policy := toriumconfig.MustLocalFeeAndResourcePolicy()
	state := feemarkettypes.DefaultGenesisState()
	state.Params.NoBaseFee = false
	state.Params.EnableHeight = 1
	state.Params.BaseFee = math.LegacyMustNewDecFromStr(strconv.FormatUint(policy.InitialBaseFeeBaseUnitsPerGas, 10))
	state.Params.MinGasPrice = math.LegacyMustNewDecFromStr(strconv.FormatUint(policy.MinimumBaseFeeBaseUnitsPerGas, 10))
	state.Params.MinGasMultiplier = math.LegacyMustNewDecFromStr(policy.MinimumGasMultiplier)
	state.Params.BaseFeeChangeDenominator = policy.BaseFeeChangeDenominator
	state.Params.ElasticityMultiplier = policy.ElasticityMultiplier
	return state
}

// NewStakingGenesisState pins the Torium validator lifecycle and 18-decimal
// power contract instead of inheriting mutable upstream defaults.
func NewStakingGenesisState() *stakingtypes.GenesisState {
	state := stakingtypes.DefaultGenesisState()
	state.Params = stakingtypes.NewParams(
		toriumconfig.ValidatorUnbondingTime,
		toriumconfig.ValidatorMaxActive,
		toriumconfig.ValidatorMaxEntries,
		toriumconfig.ValidatorHistory,
		BaseDenom,
		toriumconfig.MinimumValidatorCommissionRate,
	)
	return state
}

// NewSlashingGenesisState makes downtime and equivocation consequences part of
// the Torium protocol contract rather than accidental SDK defaults.
func NewSlashingGenesisState() *slashingtypes.GenesisState {
	state := slashingtypes.DefaultGenesisState()
	state.Params = slashingtypes.NewParams(
		toriumconfig.SignedBlocksWindow,
		toriumconfig.MinimumSignedPerWindow,
		toriumconfig.DowntimeJailDuration,
		toriumconfig.SlashFractionDoubleSign,
		toriumconfig.SlashFractionDowntime,
	)
	return state
}

// NewDistributionGenesisState ratifies fee-funded validator rewards. The mint
// module remains absent, so this module redistributes existing native TOR only.
func NewDistributionGenesisState() *distrtypes.GenesisState {
	state := distrtypes.DefaultGenesisState()
	state.Params.CommunityTax = toriumconfig.DistributionCommunityTax
	state.Params.WithdrawAddrEnabled = true
	return state
}

// NewBankGenesisState defines the denomination metadata required for Cosmos
// bank balances and EVM values to represent the same 18-decimal native asset.
func NewBankGenesisState() *banktypes.GenesisState {
	state := banktypes.DefaultGenesisState()
	state.DenomMetadata = []banktypes.Metadata{
		{
			Description: "Valueless Torium local development native asset",
			DenomUnits: []*banktypes.DenomUnit{
				{Denom: BaseDenom, Exponent: 0},
				{Denom: toriumconfig.LocalDisplayDenom, Exponent: toriumconfig.Decimals},
			},
			Base:    BaseDenom,
			Display: toriumconfig.LocalDisplayDenom,
			Name:    "Torium Local Token",
			Symbol:  toriumconfig.LocalDisplayDenom,
		},
	}
	return state
}

// NewGovGenesisState ratifies a short, valueless local governance lifecycle.
// These parameters are not approved for a public network; #127 requires a
// fresh genesis and security review before any public activation.
func NewGovGenesisState() *govv1.GenesisState {
	state := govv1.DefaultGenesisState()
	params := govv1.NewParams(
		sdk.NewCoins(sdk.NewCoin(BaseDenom, toriumconfig.LocalGovernanceMinDeposit)),
		sdk.NewCoins(sdk.NewCoin(BaseDenom, toriumconfig.LocalGovernanceExpeditedMinDeposit)),
		toriumconfig.LocalGovernanceMaxDepositPeriod,
		toriumconfig.LocalGovernanceVotingPeriod,
		toriumconfig.LocalGovernanceExpeditedVotingPeriod,
		toriumconfig.LocalGovernanceQuorum,
		toriumconfig.LocalGovernanceThreshold,
		toriumconfig.LocalGovernanceExpeditedThreshold,
		toriumconfig.LocalGovernanceVetoThreshold,
		toriumconfig.LocalGovernanceMinInitialDepositRatio,
		toriumconfig.LocalGovernanceProposalCancelRatio,
		"",
		true,
		true,
		true,
		toriumconfig.LocalGovernanceMinDepositRatio,
	)
	state.Params = &params
	return state
}

type toriumEVMAppModuleBasic struct{ vm.AppModuleBasic }

func (toriumEVMAppModuleBasic) DefaultGenesis(cdc codec.JSONCodec) json.RawMessage {
	return cdc.MustMarshalJSON(NewEVMGenesisState())
}

type toriumErc20AppModuleBasic struct{ erc20.AppModuleBasic }

func (toriumErc20AppModuleBasic) DefaultGenesis(cdc codec.JSONCodec) json.RawMessage {
	return cdc.MustMarshalJSON(NewErc20GenesisState())
}

type toriumFeeMarketAppModuleBasic struct{ feemarket.AppModuleBasic }

func (toriumFeeMarketAppModuleBasic) DefaultGenesis(cdc codec.JSONCodec) json.RawMessage {
	return cdc.MustMarshalJSON(NewFeeMarketGenesisState())
}

type toriumStakingAppModuleBasic struct{ staking.AppModuleBasic }

func (toriumStakingAppModuleBasic) DefaultGenesis(cdc codec.JSONCodec) json.RawMessage {
	return cdc.MustMarshalJSON(NewStakingGenesisState())
}

type toriumSlashingAppModuleBasic struct{ slashing.AppModuleBasic }

func (toriumSlashingAppModuleBasic) DefaultGenesis(cdc codec.JSONCodec) json.RawMessage {
	return cdc.MustMarshalJSON(NewSlashingGenesisState())
}

type toriumDistributionAppModuleBasic struct{ distribution.AppModuleBasic }

func (toriumDistributionAppModuleBasic) DefaultGenesis(cdc codec.JSONCodec) json.RawMessage {
	return cdc.MustMarshalJSON(NewDistributionGenesisState())
}

type toriumBankAppModuleBasic struct{ bank.AppModuleBasic }

func (toriumBankAppModuleBasic) DefaultGenesis(cdc codec.JSONCodec) json.RawMessage {
	return cdc.MustMarshalJSON(NewBankGenesisState())
}

type toriumGovAppModuleBasic struct{ gov.AppModuleBasic }

func (toriumGovAppModuleBasic) DefaultGenesis(cdc codec.JSONCodec) json.RawMessage {
	return cdc.MustMarshalJSON(NewGovGenesisState())
}
