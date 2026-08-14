package torium

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	goruntime "runtime"

	"github.com/ethereum/go-ethereum/common"
	ethvm "github.com/ethereum/go-ethereum/core/vm"
	"github.com/spf13/cast"

	// Force-load the tracer engines to trigger registration due to Go-Ethereum v1.10.15 changes
	_ "github.com/ethereum/go-ethereum/eth/tracers/js"
	_ "github.com/ethereum/go-ethereum/eth/tracers/native"

	abci "github.com/cometbft/cometbft/abci/types"
	cmtproto "github.com/cometbft/cometbft/proto/tendermint/types"

	dbm "github.com/cosmos/cosmos-db"
	evmante "github.com/cosmos/evm/ante"
	antetypes "github.com/cosmos/evm/ante/types"
	evmencoding "github.com/cosmos/evm/encoding"
	evmaddress "github.com/cosmos/evm/encoding/address"
	evmmempool "github.com/cosmos/evm/mempool"
	precompiletypes "github.com/cosmos/evm/precompiles/types"
	cosmosevmserver "github.com/cosmos/evm/server"
	srvflags "github.com/cosmos/evm/server/flags"
	"github.com/cosmos/evm/utils"
	"github.com/cosmos/evm/x/erc20"
	erc20keeper "github.com/cosmos/evm/x/erc20/keeper"
	erc20types "github.com/cosmos/evm/x/erc20/types"
	"github.com/cosmos/evm/x/feemarket"
	feemarketkeeper "github.com/cosmos/evm/x/feemarket/keeper"
	feemarkettypes "github.com/cosmos/evm/x/feemarket/types"
	"github.com/cosmos/evm/x/vm"
	evmkeeper "github.com/cosmos/evm/x/vm/keeper"
	vmrunner "github.com/cosmos/evm/x/vm/runner"
	evmtypes "github.com/cosmos/evm/x/vm/types"
	"github.com/cosmos/gogoproto/proto"
	evmconfig "github.com/torium-network/torium-chain/config"
	toriumversion "github.com/torium-network/torium-chain/internal/version"

	autocliv1 "cosmossdk.io/api/cosmos/autocli/v1"
	reflectionv1 "cosmossdk.io/api/cosmos/reflection/v1"
	"cosmossdk.io/client/v2/autocli"
	"cosmossdk.io/core/appmodule"
	"cosmossdk.io/log/v2"

	"github.com/cosmos/cosmos-sdk/baseapp"
	"github.com/cosmos/cosmos-sdk/baseapp/txnrunner"
	"github.com/cosmos/cosmos-sdk/client"
	"github.com/cosmos/cosmos-sdk/client/flags"
	"github.com/cosmos/cosmos-sdk/client/grpc/cmtservice"
	"github.com/cosmos/cosmos-sdk/client/grpc/node"
	"github.com/cosmos/cosmos-sdk/codec"
	"github.com/cosmos/cosmos-sdk/codec/types"
	"github.com/cosmos/cosmos-sdk/runtime"
	runtimeservices "github.com/cosmos/cosmos-sdk/runtime/services"
	sdkserver "github.com/cosmos/cosmos-sdk/server"
	"github.com/cosmos/cosmos-sdk/server/api"
	"github.com/cosmos/cosmos-sdk/server/config"
	servertypes "github.com/cosmos/cosmos-sdk/server/types"
	storetypes "github.com/cosmos/cosmos-sdk/store/v2/types"
	sdk "github.com/cosmos/cosmos-sdk/types"
	sdkmempool "github.com/cosmos/cosmos-sdk/types/mempool"
	"github.com/cosmos/cosmos-sdk/types/module"
	"github.com/cosmos/cosmos-sdk/types/msgservice"
	signingtypes "github.com/cosmos/cosmos-sdk/types/tx/signing"
	"github.com/cosmos/cosmos-sdk/x/auth"
	authkeeper "github.com/cosmos/cosmos-sdk/x/auth/keeper"
	"github.com/cosmos/cosmos-sdk/x/auth/posthandler"
	authsims "github.com/cosmos/cosmos-sdk/x/auth/simulation"
	authtx "github.com/cosmos/cosmos-sdk/x/auth/tx"
	txmodule "github.com/cosmos/cosmos-sdk/x/auth/tx/config"
	authtypes "github.com/cosmos/cosmos-sdk/x/auth/types"
	"github.com/cosmos/cosmos-sdk/x/bank"
	bankkeeper "github.com/cosmos/cosmos-sdk/x/bank/keeper"
	banktypes "github.com/cosmos/cosmos-sdk/x/bank/types"
	consensusparamkeeper "github.com/cosmos/cosmos-sdk/x/consensus/keeper"
	consensusparamtypes "github.com/cosmos/cosmos-sdk/x/consensus/types"
	distr "github.com/cosmos/cosmos-sdk/x/distribution"
	distrkeeper "github.com/cosmos/cosmos-sdk/x/distribution/keeper"
	distrtypes "github.com/cosmos/cosmos-sdk/x/distribution/types"
	"github.com/cosmos/cosmos-sdk/x/evidence"
	evidencekeeper "github.com/cosmos/cosmos-sdk/x/evidence/keeper"
	evidencetypes "github.com/cosmos/cosmos-sdk/x/evidence/types"
	"github.com/cosmos/cosmos-sdk/x/genutil"
	genutiltypes "github.com/cosmos/cosmos-sdk/x/genutil/types"
	"github.com/cosmos/cosmos-sdk/x/gov"
	govkeeper "github.com/cosmos/cosmos-sdk/x/gov/keeper"
	govtypes "github.com/cosmos/cosmos-sdk/x/gov/types"
	"github.com/cosmos/cosmos-sdk/x/slashing"
	slashingkeeper "github.com/cosmos/cosmos-sdk/x/slashing/keeper"
	slashingtypes "github.com/cosmos/cosmos-sdk/x/slashing/types"
	"github.com/cosmos/cosmos-sdk/x/staking"
	stakingkeeper "github.com/cosmos/cosmos-sdk/x/staking/keeper"
	stakingtypes "github.com/cosmos/cosmos-sdk/x/staking/types"
	upgradekeeper "github.com/cosmos/cosmos-sdk/x/upgrade/keeper"
	upgradetypes "github.com/cosmos/cosmos-sdk/x/upgrade/types"
)

func init() {
	// Align staking voting power with Torium's 18-decimal base denomination.
	sdk.DefaultPowerReduction = utils.AttoPowerReduction
}

const appName = "toriumd"

var (
	_ runtime.AppI                = (*ToriumApp)(nil)
	_ cosmosevmserver.Application = (*ToriumApp)(nil)
)

// ToriumApp extends an ABCI application, but with most of its parameters exported.
type ToriumApp struct {
	*baseapp.BaseApp

	legacyAmino       *codec.LegacyAmino
	appCodec          codec.Codec
	interfaceRegistry types.InterfaceRegistry
	txConfig          client.TxConfig

	pendingTxListeners []evmante.PendingTxListener

	// keys to access the substores
	keys  map[string]*storetypes.KVStoreKey
	oKeys map[string]*storetypes.ObjectStoreKey

	// keepers
	AccountKeeper         authkeeper.AccountKeeper
	BankKeeper            bankkeeper.Keeper
	StakingKeeper         *stakingkeeper.Keeper
	SlashingKeeper        slashingkeeper.Keeper
	DistrKeeper           distrkeeper.Keeper
	GovKeeper             govkeeper.Keeper
	UpgradeKeeper         *upgradekeeper.Keeper
	EvidenceKeeper        evidencekeeper.Keeper
	ConsensusParamsKeeper consensusparamkeeper.Keeper

	// Cosmos EVM keepers
	FeeMarketKeeper feemarketkeeper.Keeper
	EVMKeeper       *evmkeeper.Keeper
	Erc20Keeper     erc20keeper.Keeper
	EVMMempool      sdkmempool.ExtMempool

	// the module manager
	ModuleManager      *module.Manager
	BasicModuleManager module.BasicManager

	// simulation manager
	sm *module.SimulationManager

	// module configurator
	configurator module.Configurator
}

// NewToriumApp returns a reference to an initialized ToriumApp.
func NewToriumApp(
	logger log.Logger,
	db dbm.DB,
	loadLatest bool,
	appOpts servertypes.AppOptions,
	baseAppOptions ...func(*baseapp.BaseApp),
) *ToriumApp {
	evmChainID := cast.ToUint64(appOpts.Get(srvflags.EVMChainID))
	if evmChainID == 0 {
		evmChainID = LocalEVMChainID
	}
	if err := evmconfig.ValidateEVMChainID(evmChainID); err != nil {
		panic(err)
	}
	encodingConfig := evmencoding.MakeConfig(evmChainID)

	appCodec := encodingConfig.Codec
	legacyAmino := encodingConfig.Amino
	interfaceRegistry := encodingConfig.InterfaceRegistry
	txConfig := encodingConfig.TxConfig
	txDecoder := encodingConfig.TxConfig.TxDecoder()

	// enable optimistic execution
	baseAppOptions = append(
		baseAppOptions,
		baseapp.SetOptimisticExecution(),
	)

	bApp := baseapp.NewBaseApp(
		appName,
		logger,
		db,
		// use transaction decoder to support the sdk.Tx interface instead of sdk.StdTx
		txDecoder,
		baseAppOptions...,
	)
	bApp.SetVersion(toriumversion.Version)
	bApp.SetInterfaceRegistry(interfaceRegistry)
	bApp.SetTxEncoder(txConfig.TxEncoder())
	if bApp.ChainID() != "" {
		if err := evmconfig.ValidateNetworkPair(bApp.ChainID(), evmChainID); err != nil {
			panic(err)
		}
	}

	storeKeyNames := []string{
		authtypes.StoreKey, banktypes.StoreKey, stakingtypes.StoreKey,
		distrtypes.StoreKey, slashingtypes.StoreKey,
		govtypes.StoreKey, consensusparamtypes.StoreKey,
		upgradetypes.StoreKey, evidencetypes.StoreKey,
		// Cosmos EVM store keys
		evmtypes.StoreKey, feemarkettypes.StoreKey, erc20types.StoreKey,
	}
	if toriumversion.UpgradeProfile != toriumUpgradeProfilePre {
		storeKeyNames = append(storeKeyNames, toriumUpgradeStoreKey)
	}
	keys := storetypes.NewKVStoreKeys(storeKeyNames...)
	oKeys := storetypes.NewObjectStoreKeys(banktypes.ObjectStoreKey, evmtypes.ObjectKey)

	var nonTransientKeys []storetypes.StoreKey
	for _, k := range keys {
		nonTransientKeys = append(nonTransientKeys, k)
	}
	for _, k := range oKeys {
		nonTransientKeys = append(nonTransientKeys, k)
	}

	// disable block gas meter
	bApp.SetDisableBlockGasMeter(true)

	// load state streaming if enabled
	if err := bApp.RegisterStreamingServices(appOpts, keys); err != nil {
		fmt.Printf("failed to load state streaming: %s", err)
		os.Exit(1)
	}

	// wire up the versiondb's `StreamingService` and `MultiStore`.
	if cast.ToBool(appOpts.Get("versiondb.enable")) {
		panic("version db is not supported by Torium protocol v1")
	}

	app := &ToriumApp{
		BaseApp:           bApp,
		legacyAmino:       legacyAmino,
		appCodec:          appCodec,
		txConfig:          txConfig,
		interfaceRegistry: interfaceRegistry,
		keys:              keys,
		oKeys:             oKeys,
	}

	// removed x/params: no ParamsKeeper initialization

	// get authority address
	authAddr := authtypes.NewModuleAddress(govtypes.ModuleName).String()

	// set the BaseApp's parameter store
	app.ConsensusParamsKeeper = consensusparamkeeper.NewKeeper(
		appCodec,
		runtime.NewKVStoreService(keys[consensusparamtypes.StoreKey]),
		authAddr,
		runtime.EventService{},
	)
	bApp.SetParamStore(app.ConsensusParamsKeeper.ParamsStore)

	// add keepers
	app.AccountKeeper = authkeeper.NewAccountKeeper(
		appCodec, runtime.NewKVStoreService(keys[authtypes.StoreKey]),
		authtypes.ProtoBaseAccount, evmconfig.GetMaccPerms(),
		evmaddress.NewEvmCodec(sdk.GetConfig().GetBech32AccountAddrPrefix()),
		sdk.GetConfig().GetBech32AccountAddrPrefix(),
		authAddr,
	)

	app.BankKeeper = bankkeeper.NewBaseKeeper(
		appCodec,
		runtime.NewKVStoreService(keys[banktypes.StoreKey]),
		app.AccountKeeper,
		evmconfig.BlockedAddresses(),
		authAddr,
		logger,
	)
	app.BankKeeper = app.BankKeeper.
		WithObjStoreKey(oKeys[banktypes.ObjectStoreKey]).
		WithMintCoinsRestriction(evmconfig.NativeAssetMintingRestriction)

	// optional: enable sign mode textual by overwriting the default tx config (after setting the bank keeper)
	enabledSignModes := append(authtx.DefaultSignModes, signingtypes.SignMode_SIGN_MODE_TEXTUAL) //nolint:gocritic
	txConfigOpts := authtx.ConfigOptions{
		EnabledSignModes:           enabledSignModes,
		TextualCoinMetadataQueryFn: txmodule.NewBankKeeperCoinMetadataQueryFn(app.BankKeeper),
	}
	txConfig, err := authtx.NewTxConfigWithOptions(
		appCodec,
		txConfigOpts,
	)
	if err != nil {
		panic(err)
	}
	app.txConfig = txConfig

	app.StakingKeeper = stakingkeeper.NewKeeper(
		appCodec,
		runtime.NewKVStoreService(keys[stakingtypes.StoreKey]),
		app.AccountKeeper,
		app.BankKeeper,
		authAddr,
		evmaddress.NewEvmCodec(sdk.GetConfig().GetBech32ValidatorAddrPrefix()),
		evmaddress.NewEvmCodec(sdk.GetConfig().GetBech32ConsensusAddrPrefix()),
	)

	app.DistrKeeper = distrkeeper.NewKeeper(
		appCodec,
		runtime.NewKVStoreService(keys[distrtypes.StoreKey]),
		app.AccountKeeper,
		app.BankKeeper,
		app.StakingKeeper,
		authtypes.FeeCollectorName,
		authAddr,
	)

	app.SlashingKeeper = slashingkeeper.NewKeeper(
		appCodec,
		app.LegacyAmino(),
		runtime.NewKVStoreService(keys[slashingtypes.StoreKey]),
		app.StakingKeeper,
		authAddr,
	)

	// register the staking hooks
	// NOTE: stakingKeeper above is passed by reference, so that it will contain these hooks
	app.StakingKeeper.SetHooks(
		stakingtypes.NewMultiStakingHooks(
			validatorPolicyHooks{keeper: app.StakingKeeper},
			app.DistrKeeper.Hooks(),
			app.SlashingKeeper.Hooks(),
		),
	)

	// Torium's standard profiles never bypass an approved plan height. A failed
	// migration is remediated with reviewed fix-forward or whole-localnet
	// recovery, not by silently skipping the state transition.
	if requested := cast.ToIntSlice(appOpts.Get(sdkserver.FlagUnsafeSkipUpgrades)); len(requested) != 0 {
		panic("unsafe skip-upgrade heights are unsupported by Torium")
	}
	skipUpgradeHeights := map[int64]bool{}
	homePath := cast.ToString(appOpts.Get(flags.FlagHome))
	// set the governance module account as the authority for conducting upgrades
	app.UpgradeKeeper = upgradekeeper.NewKeeper(
		skipUpgradeHeights,
		runtime.NewKVStoreService(keys[upgradetypes.StoreKey]),
		appCodec,
		homePath,
		app.BaseApp,
		authAddr,
	)

	govConfig := govtypes.DefaultConfig()
	/*
		Example of setting gov params:
		govConfig.MaxMetadataLen = 10000
	*/
	govKeeper := govkeeper.NewKeeper(
		appCodec,
		runtime.NewKVStoreService(keys[govtypes.StoreKey]),
		app.AccountKeeper,
		app.BankKeeper,
		app.DistrKeeper,
		app.MsgServiceRouter(),
		govConfig,
		authAddr,
		govkeeper.NewDefaultCalculateVoteResultsAndVotingPower(app.StakingKeeper),
	)

	app.GovKeeper = *govKeeper.SetHooks(
		govtypes.NewMultiGovHooks(
		// register the governance hooks
		),
	)

	// create evidence keeper with router
	evidenceKeeper := evidencekeeper.NewKeeper(
		appCodec,
		runtime.NewKVStoreService(keys[evidencetypes.StoreKey]),
		app.StakingKeeper,
		app.SlashingKeeper,
		app.AccountKeeper.AddressCodec(),
		runtime.ProvideCometInfoService(),
	)
	// If evidence needs to be handled for the app, set routes in router here and seal
	app.EvidenceKeeper = *evidenceKeeper

	// Cosmos EVM keepers
	app.FeeMarketKeeper = feemarketkeeper.NewKeeper(
		appCodec, authtypes.NewModuleAddress(govtypes.ModuleName),
		keys[feemarkettypes.StoreKey],
	)

	// Set up EVM keeper
	tracer := cast.ToString(appOpts.Get(srvflags.EVMTracer))

	// NOTE: it's required to set up the EVM keeper before the ERC-20 keeper, because it is used in its instantiation.
	app.EVMKeeper = evmkeeper.NewKeeper(
		// Cosmos EVM v0.7.0 still requires its legacy store-key keeper API.
		appCodec, keys[evmtypes.StoreKey], oKeys[evmtypes.ObjectKey], nonTransientKeys,
		authtypes.NewModuleAddress(govtypes.ModuleName),
		app.AccountKeeper,
		app.BankKeeper,
		app.StakingKeeper,
		app.FeeMarketKeeper,
		&app.ConsensusParamsKeeper,
		&app.Erc20Keeper,
		evmChainID,
		tracer,
	).WithStaticPrecompiles(
		map[common.Address]ethvm.PrecompiledContract(
			precompiletypes.NewStaticPrecompiles().
				WithPraguePrecompiles().
				WithP256Precompile().
				WithBech32Precompile().
				WithStakingPrecompile(*app.StakingKeeper, app.BankKeeper).
				WithDistributionPrecompile(app.DistrKeeper, *app.StakingKeeper, app.BankKeeper).
				WithBankPrecompile(app.BankKeeper, &app.Erc20Keeper).
				WithGovPrecompile(app.GovKeeper, app.BankKeeper, appCodec).
				WithSlashingPrecompile(app.SlashingKeeper, app.BankKeeper),
		),
	)

	// enable virtual fee collection
	app.EVMKeeper.EnableVirtualFeeCollection()

	app.Erc20Keeper = erc20keeper.NewKeeper(
		keys[erc20types.StoreKey],
		appCodec,
		authtypes.NewModuleAddress(govtypes.ModuleName),
		app.AccountKeeper,
		app.BankKeeper,
		app.EVMKeeper,
		app.StakingKeeper,
		nil,
	)

	vmModule := vm.NewAppModule(app.EVMKeeper, app.AccountKeeper, app.BankKeeper, app.AccountKeeper.AddressCodec())

	/****  Module Options ****/

	// NOTE: Any module instantiated in the module manager that is later modified
	// must be passed by reference here.
	app.ModuleManager = module.NewManager(
		genutil.NewAppModule(
			app.AccountKeeper, app.StakingKeeper,
			app, app.txConfig,
		),
		auth.NewAppModule(appCodec, app.AccountKeeper, authsims.RandomGenesisAccounts, nil),
		bank.NewAppModule(appCodec, app.BankKeeper, app.AccountKeeper, nil),
		gov.NewAppModule(appCodec, &app.GovKeeper, app.AccountKeeper, app.BankKeeper, nil),
		slashing.NewAppModule(appCodec, app.SlashingKeeper, app.AccountKeeper, app.BankKeeper, app.StakingKeeper, nil, app.interfaceRegistry),
		distr.NewAppModule(appCodec, app.DistrKeeper, app.AccountKeeper, app.BankKeeper, app.StakingKeeper, nil),
		staking.NewAppModule(appCodec, app.StakingKeeper, app.AccountKeeper, app.BankKeeper, nil),
		newToriumUpgradeAppModule(app.UpgradeKeeper, app.AccountKeeper.AddressCodec(), authAddr),
		evidence.NewAppModule(app.EvidenceKeeper),
		newToriumConsensusAppModule(appCodec, app.ConsensusParamsKeeper, authAddr),
		// Cosmos EVM modules
		vmModule,
		feemarket.NewAppModule(app.FeeMarketKeeper),
		erc20.NewAppModule(app.Erc20Keeper, app.AccountKeeper),
	)

	// BasicModuleManager defines the module BasicManager which is in charge of setting up basic,
	// non-dependant module elements, such as codec registration and genesis verification.
	// By default, it is composed of all the modules from the module manager.
	// Additionally, app module basics can be overwritten by passing them as an argument.
	app.BasicModuleManager = module.NewBasicManagerFromManager(
		app.ModuleManager,
		map[string]module.AppModuleBasic{
			genutiltypes.ModuleName: genutil.NewAppModuleBasic(genutiltypes.DefaultMessageValidator),
			banktypes.ModuleName:    toriumBankAppModuleBasic{AppModuleBasic: bank.AppModuleBasic{}},
			distrtypes.ModuleName:   toriumDistributionAppModuleBasic{AppModuleBasic: distr.AppModuleBasic{}},
			slashingtypes.ModuleName: toriumSlashingAppModuleBasic{
				AppModuleBasic: slashing.AppModuleBasic{},
			},
			stakingtypes.ModuleName: toriumStakingAppModuleBasic{AppModuleBasic: staking.AppModuleBasic{}},
			govtypes.ModuleName:     toriumGovAppModuleBasic{AppModuleBasic: gov.NewAppModuleBasic(nil)},
			evmtypes.ModuleName:     toriumEVMAppModuleBasic{AppModuleBasic: vmModule.AppModuleBasic},
			erc20types.ModuleName:   toriumErc20AppModuleBasic{AppModuleBasic: erc20.AppModuleBasic{}},
			feemarkettypes.ModuleName: toriumFeeMarketAppModuleBasic{
				AppModuleBasic: feemarket.AppModuleBasic{},
			},
		},
	)
	app.BasicModuleManager.RegisterLegacyAminoCodec(legacyAmino)
	app.BasicModuleManager.RegisterInterfaces(interfaceRegistry)

	// NOTE: upgrade module is required to be prioritized
	app.ModuleManager.SetOrderPreBlockers(
		upgradetypes.ModuleName,
		authtypes.ModuleName,
		evmtypes.ModuleName,
	)

	// During begin block slashing happens after distr.BeginBlocker so that
	// there is nothing left over in the validator fee pool, so as to keep the
	// CanWithdrawInvariant invariant.
	//
	// NOTE: staking module is required if HistoricalEntries param > 0
	app.ModuleManager.SetOrderBeginBlockers(
		// Cosmos EVM BeginBlockers
		erc20types.ModuleName, feemarkettypes.ModuleName,
		evmtypes.ModuleName, // NOTE: EVM BeginBlocker must come after FeeMarket BeginBlocker

		// Keep the complete module order explicit; several entries are no-ops in
		// v0.7.0 but their position is part of deterministic app composition.
		distrtypes.ModuleName, slashingtypes.ModuleName,
		evidencetypes.ModuleName, stakingtypes.ModuleName,
		authtypes.ModuleName, banktypes.ModuleName, govtypes.ModuleName, genutiltypes.ModuleName,
		consensusparamtypes.ModuleName,
	)

	// NOTE: the feemarket module should go last in order of end blockers that are actually doing something,
	// to get the full block gas used.
	app.ModuleManager.SetOrderEndBlockers(
		banktypes.ModuleName,
		govtypes.ModuleName,
		stakingtypes.ModuleName,
		authtypes.ModuleName,

		// Cosmos EVM EndBlockers
		evmtypes.ModuleName, erc20types.ModuleName, feemarkettypes.ModuleName,

		// no-ops
		distrtypes.ModuleName,
		slashingtypes.ModuleName,
		genutiltypes.ModuleName, evidencetypes.ModuleName,
		upgradetypes.ModuleName, consensusparamtypes.ModuleName,
	)

	// NOTE: The genutils module must occur after staking so that pools are
	// properly initialized with tokens from genesis accounts.
	// NOTE: The genutils module must also occur after auth so that it can access the params from auth.
	genesisModuleOrder := []string{
		authtypes.ModuleName, banktypes.ModuleName,
		distrtypes.ModuleName, stakingtypes.ModuleName, slashingtypes.ModuleName, govtypes.ModuleName,

		// Cosmos EVM modules
		//
		// NOTE: feemarket module needs to be initialized before genutil module:
		// gentx transactions use MinGasPriceDecorator.AnteHandle
		evmtypes.ModuleName,
		feemarkettypes.ModuleName,
		erc20types.ModuleName,

		genutiltypes.ModuleName, evidencetypes.ModuleName,
		upgradetypes.ModuleName, consensusparamtypes.ModuleName,
	}
	app.ModuleManager.SetOrderInitGenesis(genesisModuleOrder...)
	app.ModuleManager.SetOrderExportGenesis(genesisModuleOrder...)

	// Uncomment if you want to set a custom migration order here.
	// app.ModuleManager.SetOrderMigrations(custom order)

	app.configurator = module.NewConfigurator(app.appCodec, app.MsgServiceRouter(), app.GRPCQueryRouter())
	if err = app.ModuleManager.RegisterServices(app.configurator); err != nil {
		panic(fmt.Sprintf("failed to register services in module manager: %s", err.Error()))
	}

	// RegisterUpgradeHandlers is used for registering any on-chain upgrades.
	// Make sure it's called after `app.ModuleManager` and `app.configurator` are set.
	app.RegisterUpgradeHandlers()

	autocliv1.RegisterQueryServer(app.GRPCQueryRouter(), runtimeservices.NewAutoCLIQueryService(app.ModuleManager.Modules))

	reflectionSvc, err := runtimeservices.NewReflectionService()
	if err != nil {
		panic(err)
	}
	reflectionv1.RegisterReflectionServiceServer(app.GRPCQueryRouter(), reflectionSvc)

	// create the simulation manager and define the order of the modules for deterministic simulations
	//
	// NOTE: this is not required apps that don't use the simulator for fuzz testing
	// transactions
	overrideModules := map[string]module.AppModuleSimulation{
		authtypes.ModuleName: auth.NewAppModule(app.appCodec, app.AccountKeeper, authsims.RandomGenesisAccounts, nil),
	}
	app.sm = module.NewSimulationManagerFromAppModules(app.ModuleManager.Modules, overrideModules)

	app.sm.RegisterStoreDecoders()

	// initialize stores
	app.MountKVStores(keys)
	app.MountObjectStores(oKeys)

	maxGasWanted := cast.ToUint64(appOpts.Get(srvflags.EVMMaxTxGasWanted))

	// initialize BaseApp
	app.SetInitChainer(app.InitChainer)
	app.SetPreBlocker(app.PreBlocker)
	app.SetBeginBlocker(app.BeginBlocker)
	app.SetEndBlocker(app.EndBlocker)

	app.setAnteHandler(app.txConfig, maxGasWanted)

	// set the EVM priority nonce mempool
	// if you wish to use the noop mempool, remove this codeblock
	if err := app.configureEVMMempool(appOpts, logger); err != nil {
		panic(fmt.Sprintf("failed to configure EVM mempool: %s", err.Error()))
	}

	// In v0.46, the SDK introduces _postHandlers_. PostHandlers are like
	// antehandlers, but are run _after_ the `runMsgs` execution. They are also
	// defined as a chain, and have the same signature as antehandlers.
	//
	// In baseapp, postHandlers are run in the same store branch as `runMsgs`,
	// meaning that both `runMsgs` and `postHandler` state will be committed if
	// both are successful, and both will be reverted if any of the two fails.
	//
	// The SDK exposes a default postHandlers chain, which comprises of only
	// one decorator: the Transaction Tips decorator. However, some chains do
	// not need it by default, so feel free to comment the next line if you do
	// not need tips.
	// To read more about tips:
	// https://docs.cosmos.network/main/core/tips.html
	//
	// Please note that changing any of the anteHandler or postHandler chain is
	// likely to be a state-machine breaking change, which needs a coordinated
	// upgrade.
	app.setPostHandler()

	// At startup, after all modules have been registered, check that all prot
	// annotations are correct.
	protoFiles, err := proto.MergedRegistry()
	if err != nil {
		panic(err)
	}
	err = msgservice.ValidateProtoAnnotations(protoFiles)
	if err != nil {
		// Cosmos SDK still reports legacy annotation gaps for upstream modules;
		// keep the upstream warning behavior until protoreflect ante handling.
		fmt.Fprintln(os.Stderr, err.Error())
	}

	if loadLatest {
		if err := app.LoadLatestVersion(); err != nil {
			logger.Error("error on loading last version", "err", err)
			os.Exit(1)
		}

		ctx := app.NewContextLegacy(true, cmtproto.Header{
			Height:  app.LastBlockHeight(),
			ChainID: app.ChainID(),
		})

		// set global evm variables from KV store
		vmModule.HydrateGlobals(ctx)
	}

	vmrunner.SetRunner(bApp, txnrunner.NewSTMRunner(
		txDecoder,
		nonTransientKeys,
		min(goruntime.GOMAXPROCS(0), goruntime.NumCPU()),
		true,
		func(ms storetypes.MultiStore) string {
			return app.EVMKeeper.GetParams(sdk.NewContext(ms, cmtproto.Header{}, false, log.NewNopLogger())).EvmDenom
		},
	))

	return app
}

func (app *ToriumApp) setAnteHandler(txConfig client.TxConfig, maxGasWanted uint64) {
	feePolicy := evmconfig.MustLocalFeeAndResourcePolicy()
	options := toriumAnteOptions{
		Cdc:                    app.appCodec,
		AccountKeeper:          app.AccountKeeper,
		BankKeeper:             app.BankKeeper,
		ExtensionOptionChecker: antetypes.HasDynamicFeeExtensionOption,
		EvmKeeper:              app.EVMKeeper,
		FeeMarketKeeper:        app.FeeMarketKeeper,
		SignModeHandler:        txConfig.SignModeHandler(),
		SigGasConsumer:         evmante.SigVerificationGasConsumer,
		MaxTxGasWanted:         maxGasWanted,
		MaxEVMTransactionBytes: feePolicy.MaxEVMTransactionBytes,
		DynamicFeeChecker:      true,
		PendingTxListener:      app.onPendingTx,
	}
	if err := options.validate(); err != nil {
		panic(err)
	}

	app.SetAnteHandler(newToriumAnteHandler(options))
}

func (app *ToriumApp) onPendingTx(hash common.Hash) {
	for _, listener := range app.pendingTxListeners {
		listener(hash)
	}
}

// RegisterPendingTxListener is used by json-rpc server to listen to pending transactions callback.
func (app *ToriumApp) RegisterPendingTxListener(listener func(common.Hash)) {
	app.pendingTxListeners = append(app.pendingTxListeners, listener)
}

func (app *ToriumApp) setPostHandler() {
	postHandler, err := posthandler.NewPostHandler(
		posthandler.HandlerOptions{},
	)
	if err != nil {
		panic(err)
	}

	app.SetPostHandler(postHandler)
}

// Name returns the name of the App
func (app *ToriumApp) Name() string { return app.BaseApp.Name() }

// BeginBlocker application updates every begin block
func (app *ToriumApp) BeginBlocker(ctx sdk.Context) (sdk.BeginBlock, error) {
	return app.ModuleManager.BeginBlock(ctx)
}

// EndBlocker application updates every end block
func (app *ToriumApp) EndBlocker(ctx sdk.Context) (sdk.EndBlock, error) {
	return app.ModuleManager.EndBlock(ctx)
}

func (app *ToriumApp) FinalizeBlock(req *abci.RequestFinalizeBlock) (res *abci.ResponseFinalizeBlock, err error) {
	return app.BaseApp.FinalizeBlock(req)
}

func (app *ToriumApp) Configurator() module.Configurator {
	return app.configurator
}

// InitChainer application update at chain initialization
func (app *ToriumApp) InitChainer(ctx sdk.Context, req *abci.RequestInitChain) (*abci.ResponseInitChain, error) {
	var genesisState GenesisState
	if err := json.Unmarshal(req.AppStateBytes, &genesisState); err != nil {
		panic(err)
	}

	if err := app.UpgradeKeeper.SetModuleVersionMap(ctx, app.ModuleManager.GetVersionMap()); err != nil {
		panic(err)
	}

	return app.ModuleManager.InitGenesis(ctx, app.appCodec, genesisState)
}

func (app *ToriumApp) PreBlocker(ctx sdk.Context, _ *abci.RequestFinalizeBlock) (*sdk.ResponsePreBlock, error) {
	return app.ModuleManager.PreBlock(ctx)
}

// LoadHeight loads a particular height
func (app *ToriumApp) LoadHeight(height int64) error {
	return app.LoadVersion(height)
}

// LegacyAmino returns ToriumApp's amino codec.
//
// NOTE: This is solely to be used for testing purposes as it may be desirable
// for modules to register their own custom testing types.
func (app *ToriumApp) LegacyAmino() *codec.LegacyAmino {
	return app.legacyAmino
}

// AppCodec returns ToriumApp's app codec.
//
// NOTE: This is solely to be used for testing purposes as it may be desirable
// for modules to register their own custom testing types.
func (app *ToriumApp) AppCodec() codec.Codec {
	return app.appCodec
}

// InterfaceRegistry returns ToriumApp's InterfaceRegistry
func (app *ToriumApp) InterfaceRegistry() types.InterfaceRegistry {
	return app.interfaceRegistry
}

// TxConfig returns ToriumApp's TxConfig
func (app *ToriumApp) TxConfig() client.TxConfig {
	return app.txConfig
}

// DefaultGenesis returns a default genesis from the registered AppModuleBasic's.
func (app *ToriumApp) DefaultGenesis() map[string]json.RawMessage {
	genesis := app.BasicModuleManager.DefaultGenesis(app.appCodec)

	evmGenState := NewEVMGenesisState()
	genesis[evmtypes.ModuleName] = app.appCodec.MustMarshalJSON(evmGenState)

	erc20GenState := NewErc20GenesisState()
	genesis[erc20types.ModuleName] = app.appCodec.MustMarshalJSON(erc20GenState)

	feeMarketGenState := NewFeeMarketGenesisState()
	genesis[feemarkettypes.ModuleName] = app.appCodec.MustMarshalJSON(feeMarketGenState)

	stakingGenState := NewStakingGenesisState()
	genesis[stakingtypes.ModuleName] = app.appCodec.MustMarshalJSON(stakingGenState)

	govGenState := NewGovGenesisState()
	genesis[govtypes.ModuleName] = app.appCodec.MustMarshalJSON(govGenState)

	bankGenState := NewBankGenesisState()
	genesis[banktypes.ModuleName] = app.appCodec.MustMarshalJSON(bankGenState)

	return genesis
}

// GetKey returns the KVStoreKey for the provided store key.
//
// NOTE: This is solely to be used for testing purposes.
func (app *ToriumApp) GetKey(storeKey string) *storetypes.KVStoreKey {
	return app.keys[storeKey]
}

// SimulationManager implements the SimulationApp interface
func (app *ToriumApp) SimulationManager() *module.SimulationManager {
	return app.sm
}

// RegisterAPIRoutes registers all application module routes with the provided
// API server.
func (app *ToriumApp) RegisterAPIRoutes(apiSvr *api.Server, apiConfig config.APIConfig) {
	clientCtx := apiSvr.ClientCtx
	// Register new tx routes from grpc-gateway.
	authtx.RegisterGRPCGatewayRoutes(clientCtx, apiSvr.GRPCGatewayRouter)

	// Register new cometbft queries routes from grpc-gateway.
	cmtservice.RegisterGRPCGatewayRoutes(clientCtx, apiSvr.GRPCGatewayRouter)

	// Register node gRPC service for grpc-gateway.
	node.RegisterGRPCGatewayRoutes(clientCtx, apiSvr.GRPCGatewayRouter)

	// Register grpc-gateway routes for all modules.
	app.BasicModuleManager.RegisterGRPCGatewayRoutes(clientCtx, apiSvr.GRPCGatewayRouter)

	// register swagger API from root so that other applications can override easily
	if err := sdkserver.RegisterSwaggerAPI(apiSvr.ClientCtx, apiSvr.Router, apiConfig.Swagger); err != nil {
		panic(err)
	}
}

// RegisterTxService implements the Application.RegisterTxService method.
func (app *ToriumApp) RegisterTxService(clientCtx client.Context) {
	authtx.RegisterTxService(app.GRPCQueryRouter(), clientCtx, app.Simulate, app.interfaceRegistry)
}

// RegisterTendermintService implements the Application.RegisterTendermintService method.
func (app *ToriumApp) RegisterTendermintService(clientCtx client.Context) {
	cmtservice.RegisterTendermintService(
		clientCtx,
		app.GRPCQueryRouter(),
		app.interfaceRegistry,
		app.Query,
	)
}

func (app *ToriumApp) RegisterNodeService(clientCtx client.Context, cfg config.Config) {
	node.RegisterNodeService(clientCtx, app.GRPCQueryRouter(), cfg, func() int64 {
		return app.CommitMultiStore().EarliestVersion()
	})
}

// GetBaseApp exposes the BaseApp for deterministic integration tests.
func (app *ToriumApp) GetBaseApp() *baseapp.BaseApp {
	return app.BaseApp
}

func (app *ToriumApp) GetStakingKeeperSDK() stakingkeeper.Keeper {
	return *app.StakingKeeper
}

func (app *ToriumApp) GetEVMKeeper() *evmkeeper.Keeper {
	return app.EVMKeeper
}

func (app *ToriumApp) GetErc20Keeper() *erc20keeper.Keeper {
	return &app.Erc20Keeper
}

func (app *ToriumApp) SetErc20Keeper(erc20Keeper erc20keeper.Keeper) {
	app.Erc20Keeper = erc20Keeper
}

func (app *ToriumApp) GetGovKeeper() govkeeper.Keeper {
	return app.GovKeeper
}

func (app *ToriumApp) GetEvidenceKeeper() *evidencekeeper.Keeper {
	return &app.EvidenceKeeper
}

func (app *ToriumApp) GetSlashingKeeper() slashingkeeper.Keeper {
	return app.SlashingKeeper
}

func (app *ToriumApp) GetBankKeeper() bankkeeper.Keeper {
	return app.BankKeeper
}

func (app *ToriumApp) GetFeeMarketKeeper() *feemarketkeeper.Keeper {
	return &app.FeeMarketKeeper
}

func (app *ToriumApp) GetConsensusParamsKeeper() consensusparamkeeper.Keeper {
	return app.ConsensusParamsKeeper
}

func (app *ToriumApp) GetAccountKeeper() authkeeper.AccountKeeper {
	return app.AccountKeeper
}

func (app *ToriumApp) GetDistrKeeper() distrkeeper.Keeper {
	return app.DistrKeeper
}

func (app *ToriumApp) GetStakingKeeper() *stakingkeeper.Keeper {
	return app.StakingKeeper
}

func (app *ToriumApp) GetMempool() sdkmempool.ExtMempool {
	return app.EVMMempool
}

func (app *ToriumApp) GetAnteHandler() sdk.AnteHandler {
	return app.AnteHandler()
}

// GetTxConfig implements the TestingApp interface.
func (app *ToriumApp) GetTxConfig() client.TxConfig {
	return app.txConfig
}

// Close unsubscribes from the CometBFT event bus (if set) and closes the mempool and underlying BaseApp.
func (app *ToriumApp) Close() error {
	var err error
	if m, ok := app.EVMMempool.(*evmmempool.Mempool); ok && m != nil {
		app.Logger().Info("Shutting down mempool")
		err = m.Close()
	}

	msg := "Application gracefully shutdown"
	err = errors.Join(err, app.BaseApp.Close())
	if err == nil {
		app.Logger().Info(msg)
	} else {
		app.Logger().Error(msg, "error", err)
	}

	return err
}

// AutoCliOpts returns the autocli options for the app.
func (app *ToriumApp) AutoCliOpts() autocli.AppOptions {
	modules := make(map[string]appmodule.AppModule, 0)
	for _, m := range app.ModuleManager.Modules {
		if moduleWithName, ok := m.(module.HasName); ok {
			moduleName := moduleWithName.Name()
			if appModule, ok := moduleWithName.(appmodule.AppModule); ok {
				modules[moduleName] = appModule
			}
		}
	}

	return autocli.AppOptions{
		Modules:               modules,
		ModuleOptions:         runtimeservices.ExtractAutoCLIOptions(app.ModuleManager.Modules),
		AddressCodec:          evmaddress.NewEvmCodec(sdk.GetConfig().GetBech32AccountAddrPrefix()),
		ValidatorAddressCodec: evmaddress.NewEvmCodec(sdk.GetConfig().GetBech32ValidatorAddrPrefix()),
		ConsensusAddressCodec: evmaddress.NewEvmCodec(sdk.GetConfig().GetBech32ConsensusAddrPrefix()),
	}
}
