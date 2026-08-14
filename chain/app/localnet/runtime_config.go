package localnet

import (
	"fmt"
	"slices"
	"strings"
	"time"

	cmtcfg "github.com/cometbft/cometbft/config"
	sdkserverconfig "github.com/cosmos/cosmos-sdk/server/config"
	cosmosevmserverconfig "github.com/cosmos/evm/server/config"
	toriumconfig "github.com/torium-network/torium-chain/config"
)

const (
	cometP2PPort     = 26656
	cometRPCPort     = 26657
	cometMetricsPort = 26660
	apiPort          = 1317
	grpcPort         = 9090
	evmHTTPPort      = 8545
	evmWSPort        = 8546
	gethMetricsPort  = 8100
	rpcMetricsPort   = 6065

	localJSONRPCMaxOpenConnections = 256
	localRESTMaxOpenConnections    = 256
	localGRPCMaxReceiveBytes       = 10 * 1024 * 1024
	localGRPCMaxSendBytes          = 32 * 1024 * 1024
	localRESTMaxBodyBytes          = 1_000_000
	localJSONRPCMaxBodyBytes       = 5 * 1024 * 1024
	localJSONRPCBatchRequests      = 100
	localJSONRPCBatchResponseBytes = 25_000_000

	// The JSON-RPC timeout envelope from chain/config/rpc-profile-v1.json,
	// shared by every role that serves the EVM surface.
	jsonRPCEVMTimeout      = 5 * time.Second
	jsonRPCHTTPTimeout     = 30 * time.Second
	jsonRPCHTTPIdleTimeout = 120 * time.Second
)

var (
	localJSONRPCNamespaces = []string{"eth", "net", "web3"}
	localWebSocketOrigins  = []string{"127.0.0.1", "localhost"}
)

// RuntimeProfile selects addresses that work either between Compose services
// or between four native processes on the same workstation.
type RuntimeProfile string

const (
	ProfileContainer RuntimeProfile = "container"
	ProfileRaw       RuntimeProfile = "raw"
)

// ParseRuntimeProfile rejects invented address profiles.
func ParseRuntimeProfile(value string) (RuntimeProfile, error) {
	profile := RuntimeProfile(strings.ToLower(strings.TrimSpace(value)))
	switch profile {
	case ProfileContainer, ProfileRaw:
		return profile, nil
	default:
		return "", fmt.Errorf("unsupported localnet profile %q (expected container or raw)", value)
	}
}

func nodePorts(profile RuntimeProfile, index int) Ports {
	offset := 0
	if profile == ProfileRaw {
		offset = index * toriumconfig.LocalPortOffset
	}
	return Ports{
		CometP2P: cometP2PPort + offset,
		CometRPC: cometRPCPort + offset,
		API:      apiPort + offset,
		GRPC:     grpcPort + offset,
		EVMHTTP:  evmHTTPPort + offset,
		EVMWS:    evmWSPort + offset,
	}
}

func listenerHost(profile RuntimeProfile) string {
	if profile == ProfileRaw {
		return "127.0.0.1"
	}
	return "0.0.0.0"
}

func cometConfig(home, moniker string, profile RuntimeProfile, index int, peers string) (*cmtcfg.Config, error) {
	policy := toriumconfig.MustLocalFeeAndResourcePolicy()
	ports := nodePorts(profile, index)
	listenHost := listenerHost(profile)

	cfg := cmtcfg.DefaultConfig().SetRoot(home)
	cfg.Moniker = moniker
	cfg.LogFormat = cmtcfg.LogFormatJSON
	cfg.RPC.ListenAddress = fmt.Sprintf("tcp://%s:%d", listenHost, ports.CometRPC)
	cfg.RPC.CORSAllowedOrigins = []string{}
	cfg.RPC.GRPCListenAddress = ""
	cfg.RPC.Unsafe = false
	cfg.RPC.PprofListenAddress = ""
	cfg.P2P.ListenAddress = fmt.Sprintf("tcp://%s:%d", listenHost, ports.CometP2P)
	cfg.P2P.ExternalAddress = ""
	cfg.P2P.Seeds = ""
	cfg.P2P.PersistentPeers = peers
	cfg.P2P.AddrBookStrict = false
	cfg.P2P.AllowDuplicateIP = true
	cfg.P2P.PexReactor = false
	if err := toriumconfig.ApplyCometMempoolPolicy(cfg, policy); err != nil {
		return nil, fmt.Errorf("apply Torium mempool policy for %s: %w", moniker, err)
	}
	cfg.Consensus.TimeoutPropose = toriumconfig.LocalTimeoutPropose
	cfg.Consensus.TimeoutProposeDelta = toriumconfig.LocalTimeoutProposeDelta
	cfg.Consensus.TimeoutPrevote = toriumconfig.LocalTimeoutPrevote
	cfg.Consensus.TimeoutPrevoteDelta = toriumconfig.LocalTimeoutPrevoteDelta
	cfg.Consensus.TimeoutPrecommit = toriumconfig.LocalTimeoutPrecommit
	cfg.Consensus.TimeoutPrecommitDelta = toriumconfig.LocalTimeoutPrecommitDelta
	cfg.Consensus.TimeoutCommit = toriumconfig.LocalTimeoutCommit
	// Prometheus consensus metrics for the #115 observability collector. The
	// listener binds the service interface inside the isolated Compose
	// network (container) or host loopback (raw); host exposure stays
	// loopback-published only, via chain/localnet/compose.yaml.
	cfg.Instrumentation.Prometheus = true
	cfg.Instrumentation.PrometheusListenAddr = fmt.Sprintf(
		"%s:%d", listenerHost(profile), cometMetricsPort+metricsPortOffset(profile, index),
	)

	if err := cfg.ValidateBasic(); err != nil {
		return nil, fmt.Errorf("validate CometBFT config for %s: %w", moniker, err)
	}
	if err := validateLocalCometEndpoints(profile, index, cfg); err != nil {
		return nil, fmt.Errorf("validate local CometBFT endpoints for %s: %w", moniker, err)
	}
	return cfg, nil
}

func applicationConfig(profile RuntimeProfile, index int) (toriumconfig.EVMAppConfig, error) {
	policy := toriumconfig.MustLocalFeeAndResourcePolicy()
	_, raw := toriumconfig.InitAppConfig()
	cfg, ok := raw.(toriumconfig.EVMAppConfig)
	if !ok {
		return toriumconfig.EVMAppConfig{}, fmt.Errorf("torium application config has unexpected type %T", raw)
	}
	ports := nodePorts(profile, index)
	listenHost := listenerHost(profile)
	clientNode := index == 0

	cfg.Mempool.MaxTxs = policy.CosmosMempoolMaxTransactions
	cfg.API.Enable = clientNode
	cfg.API.Swagger = false
	cfg.API.EnableUnsafeCORS = false
	cfg.API.Address = fmt.Sprintf("tcp://%s:%d", listenHost, ports.API)
	cfg.API.MaxOpenConnections = localRESTMaxOpenConnections
	cfg.API.RPCReadTimeout = 10
	cfg.API.RPCWriteTimeout = 10
	cfg.API.RPCMaxBodyBytes = localRESTMaxBodyBytes
	cfg.GRPC.Enable = clientNode
	cfg.GRPC.Address = fmt.Sprintf("%s:%d", listenHost, ports.GRPC)
	cfg.GRPC.MaxRecvMsgSize = localGRPCMaxReceiveBytes
	cfg.GRPC.MaxSendMsgSize = localGRPCMaxSendBytes
	cfg.GRPC.SkipCheckHeader = false
	cfg.GRPCWeb.Enable = false
	cfg.JSONRPC.Enable = clientNode
	cfg.JSONRPC.API = slices.Clone(localJSONRPCNamespaces)
	cfg.JSONRPC.Address = fmt.Sprintf("%s:%d", listenHost, ports.EVMHTTP)
	cfg.JSONRPC.WsAddress = fmt.Sprintf("%s:%d", listenHost, ports.EVMWS)
	cfg.JSONRPC.GasCap = policy.JSONRPCCallGasCap
	cfg.JSONRPC.EVMTimeout = jsonRPCEVMTimeout
	cfg.JSONRPC.FeeHistoryCap = 100
	cfg.JSONRPC.LogsCap = 10_000
	cfg.JSONRPC.BlockRangeCap = 10_000
	cfg.JSONRPC.HTTPTimeout = jsonRPCHTTPTimeout
	cfg.JSONRPC.HTTPIdleTimeout = jsonRPCHTTPIdleTimeout
	cfg.JSONRPC.HTTPBodyLimit = localJSONRPCMaxBodyBytes
	cfg.JSONRPC.BatchRequestLimit = localJSONRPCBatchRequests
	cfg.JSONRPC.BatchResponseMaxSize = localJSONRPCBatchResponseBytes
	cfg.JSONRPC.MaxOpenConnections = localJSONRPCMaxOpenConnections
	cfg.JSONRPC.AllowInsecureUnlock = false
	cfg.JSONRPC.AllowUnprotectedTxs = false
	cfg.JSONRPC.EnableProfiling = false
	cfg.JSONRPC.EnableIndexer = false
	cfg.JSONRPC.WSOrigins = slices.Clone(localWebSocketOrigins)
	// The JSON-RPC metrics server (started only with the --metrics CLI flag,
	// and only where JSON-RPC itself is enabled) binds like the JSON-RPC
	// listener: service interface in the Compose network, loopback in raw.
	cfg.JSONRPC.MetricsAddress = fmt.Sprintf("%s:%d", listenerHost(profile), rpcMetricsPort+metricsPortOffset(profile, index))
	cfg.EVM.EVMChainID = toriumconfig.LocalEVMChainID
	if err := toriumconfig.ApplyEVMFeeAndMempoolPolicy(&cfg.EVM, policy); err != nil {
		return toriumconfig.EVMAppConfig{}, fmt.Errorf("apply Torium EVM fee policy: %w", err)
	}
	cfg.EVM.Tracer = ""
	cfg.EVM.EnablePreimageRecording = false
	cfg.EVM.GethMetricsAddress = fmt.Sprintf("127.0.0.1:%d", gethMetricsPort+metricsPortOffset(profile, index))

	evmConfig := cosmosevmserverconfig.Config{
		Config:  cfg.Config,
		EVM:     cfg.EVM,
		JSONRPC: cfg.JSONRPC,
		TLS:     cfg.TLS,
	}
	if err := evmConfig.ValidateBasic(); err != nil {
		return toriumconfig.EVMAppConfig{}, fmt.Errorf("validate application config: %w", err)
	}
	if err := validateLocalApplicationEndpoints(profile, index, cfg); err != nil {
		return toriumconfig.EVMAppConfig{}, fmt.Errorf("validate local application endpoints: %w", err)
	}
	return cfg, nil
}

func metricsPortOffset(profile RuntimeProfile, index int) int {
	if profile == ProfileRaw {
		return index * toriumconfig.LocalPortOffset
	}
	return 0
}

func validateLocalCometEndpoints(profile RuntimeProfile, index int, cfg *cmtcfg.Config) error {
	if cfg == nil {
		return fmt.Errorf("CometBFT config is required")
	}
	ports := nodePorts(profile, index)
	expectedRPC := fmt.Sprintf("tcp://%s:%d", listenerHost(profile), ports.CometRPC)
	if cfg.RPC.ListenAddress != expectedRPC {
		return fmt.Errorf("CometBFT RPC address must be %q, got %q", expectedRPC, cfg.RPC.ListenAddress)
	}
	if len(cfg.RPC.CORSAllowedOrigins) != 0 {
		return fmt.Errorf("CometBFT RPC CORS origins must be empty")
	}
	if cfg.RPC.Unsafe {
		return fmt.Errorf("CometBFT unsafe RPC methods must be disabled")
	}
	if cfg.RPC.PprofListenAddress != "" {
		return fmt.Errorf("CometBFT pprof must be disabled")
	}
	if cfg.RPC.GRPCListenAddress != "" {
		return fmt.Errorf("deprecated CometBFT gRPC listener must be disabled")
	}
	policy := toriumconfig.MustLocalFeeAndResourcePolicy()
	if cfg.Mempool.Type != cmtcfg.MempoolTypeApp ||
		cfg.Mempool.MaxTxBytes != policy.MaxCosmosTransactionBytes ||
		cfg.Mempool.ReapMaxBytes != policy.CometReapMaxBytes ||
		cfg.Mempool.ReapMaxGas != policy.CometReapMaxGas {
		return fmt.Errorf("CometBFT admission or reap bounds differ from the local fee policy")
	}
	expectedMetrics := fmt.Sprintf("%s:%d", listenerHost(profile), cometMetricsPort+metricsPortOffset(profile, index))
	if !cfg.Instrumentation.Prometheus || cfg.Instrumentation.PrometheusListenAddr != expectedMetrics {
		return fmt.Errorf("CometBFT Prometheus instrumentation must listen on %q for the %s profile", expectedMetrics, profile)
	}
	return nil
}

func validateLocalApplicationEndpoints(profile RuntimeProfile, index int, cfg toriumconfig.EVMAppConfig) error {
	policy := toriumconfig.MustLocalFeeAndResourcePolicy()
	ports := nodePorts(profile, index)
	host := listenerHost(profile)
	clientNode := index == 0
	if cfg.API.Enable != clientNode || cfg.GRPC.Enable != clientNode || cfg.JSONRPC.Enable != clientNode {
		return fmt.Errorf("REST, gRPC and JSON-RPC must be enabled only on validator-0")
	}
	if cfg.API.Address != fmt.Sprintf("tcp://%s:%d", host, ports.API) ||
		cfg.GRPC.Address != fmt.Sprintf("%s:%d", host, ports.GRPC) ||
		cfg.JSONRPC.Address != fmt.Sprintf("%s:%d", host, ports.EVMHTTP) ||
		cfg.JSONRPC.WsAddress != fmt.Sprintf("%s:%d", host, ports.EVMWS) {
		return fmt.Errorf("application listener address differs from the %s local profile", profile)
	}
	if cfg.API.EnableUnsafeCORS || cfg.API.Swagger || cfg.GRPCWeb.Enable {
		return fmt.Errorf("unsafe REST CORS, Swagger and gRPC-Web must be disabled")
	}
	if cfg.API.MaxOpenConnections != localRESTMaxOpenConnections ||
		cfg.API.RPCMaxBodyBytes != localRESTMaxBodyBytes ||
		cfg.API.RPCReadTimeout != 10 || cfg.API.RPCWriteTimeout != 10 ||
		cfg.GRPC.MaxRecvMsgSize != localGRPCMaxReceiveBytes ||
		cfg.GRPC.MaxSendMsgSize != localGRPCMaxSendBytes {
		return fmt.Errorf("REST or gRPC resource limits differ from the local endpoint contract")
	}
	if !slices.Equal(cfg.JSONRPC.API, localJSONRPCNamespaces) {
		return fmt.Errorf("JSON-RPC namespaces must be exactly %v", localJSONRPCNamespaces)
	}
	if !slices.Equal(cfg.JSONRPC.WSOrigins, localWebSocketOrigins) || slices.Contains(cfg.JSONRPC.WSOrigins, "*") {
		return fmt.Errorf("WebSocket origins must be exactly %v", localWebSocketOrigins)
	}
	if cfg.JSONRPC.GasCap != policy.JSONRPCCallGasCap || cfg.JSONRPC.EVMTimeout != jsonRPCEVMTimeout ||
		cfg.JSONRPC.FeeHistoryCap != 100 || cfg.JSONRPC.LogsCap != 10_000 ||
		cfg.JSONRPC.BlockRangeCap != 10_000 || cfg.JSONRPC.HTTPBodyLimit != localJSONRPCMaxBodyBytes ||
		cfg.JSONRPC.BatchRequestLimit != localJSONRPCBatchRequests ||
		cfg.JSONRPC.BatchResponseMaxSize != localJSONRPCBatchResponseBytes ||
		cfg.JSONRPC.MaxOpenConnections != localJSONRPCMaxOpenConnections ||
		cfg.JSONRPC.HTTPTimeout != jsonRPCHTTPTimeout || cfg.JSONRPC.HTTPIdleTimeout != jsonRPCHTTPIdleTimeout {
		return fmt.Errorf("JSON-RPC resource limits differ from the local endpoint contract")
	}
	if cfg.JSONRPC.AllowInsecureUnlock || cfg.JSONRPC.AllowUnprotectedTxs ||
		cfg.JSONRPC.EnableProfiling || cfg.JSONRPC.EnableIndexer {
		return fmt.Errorf("unsafe JSON-RPC unlock, unprotected transaction, profiling and indexer flags must be disabled")
	}
	if cfg.EVM.Tracer != "" || cfg.EVM.EnablePreimageRecording {
		return fmt.Errorf("EVM tracing and preimage recording must be disabled")
	}
	expectedMetricsOffset := metricsPortOffset(profile, index)
	if cfg.JSONRPC.MetricsAddress != fmt.Sprintf("%s:%d", listenerHost(profile), rpcMetricsPort+expectedMetricsOffset) {
		return fmt.Errorf("JSON-RPC metrics listener differs from the %s local profile", profile)
	}
	if cfg.EVM.GethMetricsAddress != fmt.Sprintf("127.0.0.1:%d", gethMetricsPort+expectedMetricsOffset) {
		return fmt.Errorf("geth metrics listener must remain loopback-only")
	}
	if cfg.EVM.EVMChainID != toriumconfig.LocalEVMChainID {
		return fmt.Errorf("EVM chain ID must be %d", toriumconfig.LocalEVMChainID)
	}
	if cfg.Mempool.MaxTxs != policy.CosmosMempoolMaxTransactions ||
		cfg.EVM.MaxTxGasWanted != policy.MaxTxGasWanted ||
		cfg.EVM.MinTip != policy.MempoolMinimumPriorityFee ||
		cfg.EVM.Mempool.PriceLimit != policy.MempoolPriceLimit ||
		cfg.EVM.Mempool.PriceBump != policy.MempoolPriceBumpPercent ||
		cfg.EVM.Mempool.AccountSlots != policy.MempoolAccountExecutableSlots ||
		cfg.EVM.Mempool.GlobalSlots != policy.MempoolGlobalExecutableSlots ||
		cfg.EVM.Mempool.AccountQueue != policy.MempoolAccountQueuedSlots ||
		cfg.EVM.Mempool.GlobalQueue != policy.MempoolGlobalQueuedSlots ||
		cfg.EVM.Mempool.Lifetime != policy.MempoolQueuedLifetime ||
		cfg.EVM.Mempool.IncludedNonceCacheSize != policy.MempoolIncludedNonceCacheSize ||
		cfg.EVM.Mempool.PendingTxProposalTimeout != policy.MempoolPendingProposalTimeout ||
		cfg.EVM.Mempool.CheckTxTimeout != policy.MempoolCheckTxTimeout ||
		cfg.EVM.Mempool.InsertQueueSize != policy.MempoolInsertQueueSize ||
		cfg.EVM.Mempool.EnableTxTracker != policy.MempoolTransactionTrackerEnabled {
		return fmt.Errorf("application mempool limits differ from the local fee policy")
	}
	return nil
}

func writeApplicationConfig(path string, cfg toriumconfig.EVMAppConfig) {
	sdkserverconfig.SetConfigTemplate(toriumconfig.EVMAppTemplate)
	sdkserverconfig.WriteConfigFile(path, cfg)
}
