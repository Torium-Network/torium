package localnet

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	cmtcfg "github.com/cometbft/cometbft/config"
	cmted25519 "github.com/cometbft/cometbft/crypto/ed25519"
	"github.com/cometbft/cometbft/p2p"
	"github.com/cometbft/cometbft/privval"
	cosmosevmserverconfig "github.com/cosmos/evm/server/config"
	toriumconfig "github.com/torium-network/torium-chain/config"
)

// The private archive indexer is the local equivalent of the
// `private-archive-indexer` role in chain/profiles/node-roles-v0.json: a
// non-validator toriumd instance that retains all history from genesis and
// serves EVM JSON-RPC to exactly one consumer, the archive gateway.
//
// It is generated into the same runtime root as the validators but into its own
// topology file, so the four-validator `topology.json` contract — and every
// piece of evidence that hashes or reads it — is byte-for-byte unchanged
// whether or not the archive lane exists.
const (
	// ArchiveNodeName matches the reviewed role id and the Compose service
	// name the gateway dials.
	ArchiveNodeName = "private-archive-indexer"

	archiveTopologyFileName = "archive-topology.json"

	// archiveNodeIndex places the raw-profile port offset after the four
	// validators. In the container profile the archive node has its own
	// network namespace and needs no offset at all.
	archiveNodeIndex = toriumconfig.LocalValidatorCount

	// archivePruningStrategy is `storagePolicies.archive-indexer-v0`'s
	// pruningStrategy. Anything else would discard the history that makes the
	// node an archive.
	archivePruningStrategy = "nothing"

	// archiveTxIndexer is that policy's txIndex value.
	archiveTxIndexer = "kv"
)

// ArchiveTopology is the public, non-secret inventory for the archive node. It
// is deliberately separate from Topology: the archive node holds no voting
// power, serves no CometBFT RPC, and must never be counted as a validator.
type ArchiveTopology struct {
	SchemaVersion int            `json:"schema_version"`
	Warning       string         `json:"warning"`
	Profile       RuntimeProfile `json:"profile"`
	CosmosChainID string         `json:"cosmos_chain_id"`
	EVMChainID    uint64         `json:"evm_chain_id"`
	GenesisSHA256 string         `json:"genesis_sha256"`
	Role          string         `json:"role"`
	Name          string         `json:"name"`
	Home          string         `json:"home"`
	NodeID        string         `json:"node_id"`
	// ConsensusAddressHex is recorded so the reviewer can confirm it is not a
	// registered validator address, which is the contract's
	// filePvPubkeyMustNotMatchRegisteredValidatorSet requirement.
	ConsensusAddressHex   string       `json:"consensus_address_hex"`
	RegisteredValidator   bool         `json:"registered_validator"`
	VotingPower           int64        `json:"voting_power"`
	PersistentPeers       string       `json:"persistent_peers"`
	PrivatePeerIDs        string       `json:"private_peer_ids"`
	PruningStrategy       string       `json:"pruning_strategy"`
	TransactionIndexer    string       `json:"transaction_indexer"`
	CometRPCEnabled       bool         `json:"comet_rpc_enabled"`
	CosmosRESTEnabled     bool         `json:"cosmos_rest_enabled"`
	CosmosGRPCEnabled     bool         `json:"cosmos_grpc_enabled"`
	EVMJSONRPCEnabled     bool         `json:"evm_json_rpc_enabled"`
	HostPublishedListener bool         `json:"host_published_listener"`
	Ports                 ArchivePorts `json:"ports"`
}

// ArchivePorts lists only the listeners the archive role enables.
type ArchivePorts struct {
	CometP2P int `json:"comet_p2p"`
	EVMHTTP  int `json:"evm_http"`
	EVMWS    int `json:"evm_ws"`
}

type archiveMaterial struct {
	consensusKey cmted25519.PrivKey
	nodeKey      *p2p.NodeKey
}

// PrepareArchive adds the private archive indexer to an already prepared
// runtime root. The validators must exist first and must match their
// deterministic contract: an archive node that joins a different chain than
// the one it indexes is worse than no archive node.
func (generator RuntimeGenerator) PrepareArchive(rootValue string, profile RuntimeProfile, reset bool) (ArchiveTopology, error) {
	if profile != ProfileContainer && profile != ProfileRaw {
		return ArchiveTopology{}, fmt.Errorf("invalid localnet runtime profile %q", profile)
	}
	root, err := safeRuntimeRoot(rootValue)
	if err != nil {
		return ArchiveTopology{}, err
	}
	// The archive node is an addition to a prepared localnet, never a way to
	// create one: requiring the validator topology keeps the genesis identity
	// single-sourced.
	validatorTopology, err := ReadTopology(root)
	if err != nil {
		return ArchiveTopology{}, fmt.Errorf("archive preparation requires a prepared validator runtime: %w", err)
	}
	if validatorTopology.Profile != profile {
		return ArchiveTopology{}, fmt.Errorf(
			"prepared runtime uses the %s profile, archive preparation requested %s",
			validatorTopology.Profile, profile,
		)
	}

	artifact, err := generator.Genesis.Generate()
	if err != nil {
		return ArchiveTopology{}, err
	}
	digest := sha256.Sum256(artifact.Genesis)
	if hex.EncodeToString(digest[:]) != validatorTopology.GenesisSHA256 {
		return ArchiveTopology{}, fmt.Errorf("prepared runtime genesis differs from the reviewed genesis contract")
	}
	fixture, err := LoadFixture()
	if err != nil {
		return ArchiveTopology{}, err
	}
	validators, err := deriveRuntimeMaterials(fixture)
	if err != nil {
		return ArchiveTopology{}, err
	}
	material, err := deriveArchiveMaterial(validators)
	if err != nil {
		return ArchiveTopology{}, err
	}
	topology := buildArchiveTopology(profile, artifact.Genesis, material, validators)

	home := filepath.Join(root, ArchiveNodeName)
	_, statErr := os.Stat(home)
	switch {
	case statErr == nil && !reset:
		if err := verifyExistingArchive(root, profile, topology, artifact.Genesis, material, validators); err != nil {
			return ArchiveTopology{}, fmt.Errorf(
				"existing archive runtime differs from the deterministic contract; inspect it or rerun with --reset-archive: %w", err,
			)
		}
		return topology, nil
	case statErr != nil && !os.IsNotExist(statErr):
		return ArchiveTopology{}, fmt.Errorf("inspect archive runtime: %w", statErr)
	}

	parent := filepath.Dir(root)
	staging, err := os.MkdirTemp(parent, ".torium-localnet-archive-*")
	if err != nil {
		return ArchiveTopology{}, fmt.Errorf("create archive staging directory: %w", err)
	}
	defer func() { _ = os.RemoveAll(staging) }()
	if err := populateArchiveRuntime(staging, profile, artifact.Genesis, material, validators); err != nil {
		return ArchiveTopology{}, err
	}

	if statErr == nil {
		backup, backupErr := os.MkdirTemp(parent, ".torium-localnet-archive-backup-*")
		if backupErr != nil {
			return ArchiveTopology{}, fmt.Errorf("create archive rollback directory: %w", backupErr)
		}
		defer func() { _ = os.RemoveAll(backup) }()
		preserved := filepath.Join(backup, ArchiveNodeName)
		if err := os.Rename(home, preserved); err != nil {
			return ArchiveTopology{}, fmt.Errorf("preserve the existing archive home before reset: %w", err)
		}
		if err := os.Rename(filepath.Join(staging, ArchiveNodeName), home); err != nil {
			_ = os.Rename(preserved, home)
			return ArchiveTopology{}, fmt.Errorf("activate the reset archive home: %w", err)
		}
	} else if err := os.Rename(filepath.Join(staging, ArchiveNodeName), home); err != nil {
		return ArchiveTopology{}, fmt.Errorf("activate the prepared archive home: %w", err)
	}
	topologyJSON, err := marshalCanonical(topology)
	if err != nil {
		return ArchiveTopology{}, fmt.Errorf("marshal archive topology: %w", err)
	}
	if err := os.WriteFile(filepath.Join(root, archiveTopologyFileName), topologyJSON, 0o644); err != nil {
		return ArchiveTopology{}, fmt.Errorf("write archive topology: %w", err)
	}
	return topology, nil
}

// ReadArchiveTopology validates and decodes the archive node's public
// inventory.
func ReadArchiveTopology(root string) (ArchiveTopology, error) {
	contents, err := os.ReadFile(filepath.Join(root, archiveTopologyFileName))
	if err != nil {
		return ArchiveTopology{}, fmt.Errorf("read archive topology: %w", err)
	}
	var topology ArchiveTopology
	if err := json.Unmarshal(contents, &topology); err != nil {
		return ArchiveTopology{}, fmt.Errorf("decode archive topology: %w", err)
	}
	if err := validateArchiveTopology(topology); err != nil {
		return ArchiveTopology{}, err
	}
	return topology, nil
}

func validateArchiveTopology(topology ArchiveTopology) error {
	if topology.Profile != ProfileContainer && topology.Profile != ProfileRaw {
		return fmt.Errorf("archive topology has invalid profile %q", topology.Profile)
	}
	digest, err := hex.DecodeString(topology.GenesisSHA256)
	if err != nil || len(digest) != sha256.Size {
		return fmt.Errorf("archive topology has invalid genesis checksum")
	}
	if topology.SchemaVersion != 1 ||
		topology.Warning != localWarning ||
		topology.Role != ArchiveNodeName ||
		topology.Name != ArchiveNodeName ||
		topology.Home != ArchiveNodeName ||
		topology.CosmosChainID != toriumconfig.LocalCosmosChainID ||
		topology.EVMChainID != toriumconfig.LocalEVMChainID ||
		strings.TrimSpace(topology.NodeID) == "" ||
		strings.TrimSpace(topology.ConsensusAddressHex) == "" ||
		strings.TrimSpace(topology.PersistentPeers) == "" ||
		strings.TrimSpace(topology.PrivatePeerIDs) == "" {
		return fmt.Errorf("archive topology violates schema v1")
	}
	// The archive node's authority boundary is the whole point of the role:
	// no voting power, no registered consensus identity, no CometBFT RPC, no
	// Cosmos service surface, and no host-published listener.
	if topology.RegisteredValidator || topology.VotingPower != 0 ||
		topology.CometRPCEnabled || topology.CosmosRESTEnabled ||
		topology.CosmosGRPCEnabled || topology.HostPublishedListener {
		return fmt.Errorf("archive topology claims authority or exposure the role forbids")
	}
	if !topology.EVMJSONRPCEnabled {
		return fmt.Errorf("archive topology must enable the EVM JSON-RPC surface the gateway fronts")
	}
	if topology.PruningStrategy != archivePruningStrategy || topology.TransactionIndexer != archiveTxIndexer {
		return fmt.Errorf("archive topology storage policy differs from archive-indexer-v0")
	}
	if topology.Ports != archivePorts(topology.Profile) {
		return fmt.Errorf("archive topology listener ports differ from the %s profile", topology.Profile)
	}
	return nil
}

func deriveArchiveMaterial(validators []runtimeMaterial) (archiveMaterial, error) {
	consensusKey := cmted25519.GenPrivKeyFromSecret([]byte(fixtureDomain + "/archive-consensus/" + ArchiveNodeName))
	// A CometBFT node key is Ed25519 seed‖public, not arbitrary bytes; deriving
	// it the same way as the validators' keeps the p2p handshake valid.
	nodeKey := &p2p.NodeKey{PrivKey: cmted25519.GenPrivKeyFromSecret([]byte(fixtureDomain + "/archive-node/" + ArchiveNodeName))}
	for _, validator := range validators {
		if bytes.Equal(consensusKey.PubKey().Bytes(), validator.consensusKey.PubKey().Bytes()) {
			return archiveMaterial{}, fmt.Errorf(
				"archive consensus key collides with registered validator %s", validator.name,
			)
		}
		if nodeKey.ID() == validator.nodeKey.ID() {
			return archiveMaterial{}, fmt.Errorf("archive node ID collides with validator %s", validator.name)
		}
	}
	return archiveMaterial{consensusKey: consensusKey, nodeKey: nodeKey}, nil
}

func buildArchiveTopology(
	profile RuntimeProfile, genesis []byte, material archiveMaterial, validators []runtimeMaterial,
) ArchiveTopology {
	digest := sha256.Sum256(genesis)
	return ArchiveTopology{
		SchemaVersion:         1,
		Warning:               localWarning,
		Profile:               profile,
		CosmosChainID:         toriumconfig.LocalCosmosChainID,
		EVMChainID:            toriumconfig.LocalEVMChainID,
		GenesisSHA256:         hex.EncodeToString(digest[:]),
		Role:                  ArchiveNodeName,
		Name:                  ArchiveNodeName,
		Home:                  ArchiveNodeName,
		NodeID:                string(material.nodeKey.ID()),
		ConsensusAddressHex:   strings.ToUpper(hex.EncodeToString(material.consensusKey.PubKey().Address())),
		RegisteredValidator:   false,
		VotingPower:           0,
		PersistentPeers:       archivePersistentPeers(profile, validators),
		PrivatePeerIDs:        archivePrivatePeerIDs(validators),
		PruningStrategy:       archivePruningStrategy,
		TransactionIndexer:    archiveTxIndexer,
		CometRPCEnabled:       false,
		CosmosRESTEnabled:     false,
		CosmosGRPCEnabled:     false,
		EVMJSONRPCEnabled:     true,
		HostPublishedListener: false,
		Ports:                 archivePorts(profile),
	}
}

func archivePorts(profile RuntimeProfile) ArchivePorts {
	offset := 0
	if profile == ProfileRaw {
		offset = archiveNodeIndex * toriumconfig.LocalPortOffset
	}
	return ArchivePorts{
		CometP2P: cometP2PPort + offset,
		EVMHTTP:  evmHTTPPort + offset,
		EVMWS:    evmWSPort + offset,
	}
}

// archivePersistentPeers dials every validator. The reviewed role prefers
// sentry and full peers, but the localnet instantiates neither, so the
// validators are the only available private peers; the archive node still
// never advertises itself and never gossips (pex off).
func archivePersistentPeers(profile RuntimeProfile, validators []runtimeMaterial) string {
	peers := make([]string, 0, len(validators))
	for index, validator := range validators {
		host := validator.name
		port := cometP2PPort
		if profile == ProfileRaw {
			host = "127.0.0.1"
			port += index * toriumconfig.LocalPortOffset
		}
		peers = append(peers, fmt.Sprintf("%s@%s:%d", validator.nodeKey.ID(), host, port))
	}
	return strings.Join(peers, ",")
}

func archivePrivatePeerIDs(validators []runtimeMaterial) string {
	ids := make([]string, 0, len(validators))
	for _, validator := range validators {
		ids = append(ids, string(validator.nodeKey.ID()))
	}
	return strings.Join(ids, ",")
}

func populateArchiveRuntime(
	root string,
	profile RuntimeProfile,
	genesis []byte,
	material archiveMaterial,
	validators []runtimeMaterial,
) (err error) {
	defer func() {
		if recovered := recover(); recovered != nil {
			err = fmt.Errorf("write archive runtime files: %v", recovered)
		}
	}()
	home := filepath.Join(root, ArchiveNodeName)
	configDirectory := filepath.Join(home, "config")
	dataDirectory := filepath.Join(home, "data")
	if err := os.MkdirAll(configDirectory, 0o700); err != nil {
		return fmt.Errorf("create archive config directory: %w", err)
	}
	if err := os.MkdirAll(dataDirectory, 0o700); err != nil {
		return fmt.Errorf("create archive data directory: %w", err)
	}
	if err := os.WriteFile(filepath.Join(configDirectory, genesisFileName), genesis, 0o644); err != nil {
		return fmt.Errorf("write archive genesis: %w", err)
	}
	pv := privval.NewFilePV(
		material.consensusKey,
		filepath.Join(configDirectory, "priv_validator_key.json"),
		filepath.Join(dataDirectory, "priv_validator_state.json"),
	)
	pv.Save()
	if err := material.nodeKey.SaveAs(filepath.Join(configDirectory, "node_key.json")); err != nil {
		return fmt.Errorf("write archive node key: %w", err)
	}
	comet, err := archiveCometConfig(home, profile, validators)
	if err != nil {
		return err
	}
	app, err := archiveApplicationConfig(profile)
	if err != nil {
		return err
	}
	converted := &cosmosevmserverconfig.Config{
		Config:  app.Config,
		EVM:     app.EVM,
		JSONRPC: app.JSONRPC,
		TLS:     app.TLS,
	}
	if err := cosmosevmserverconfig.ValidateCrossConfig(comet, converted); err != nil {
		return fmt.Errorf("validate archive cross-config: %w", err)
	}
	cmtcfg.WriteConfigFile(filepath.Join(configDirectory, "config.toml"), comet)
	writeApplicationConfig(filepath.Join(configDirectory, "app.toml"), app)
	return nil
}

func archiveCometConfig(home string, profile RuntimeProfile, validators []runtimeMaterial) (*cmtcfg.Config, error) {
	policy := toriumconfig.MustLocalFeeAndResourcePolicy()
	ports := archivePorts(profile)
	listenHost := listenerHost(profile)

	cfg := cmtcfg.DefaultConfig().SetRoot(home)
	cfg.Moniker = ArchiveNodeName
	cfg.LogFormat = cmtcfg.LogFormatJSON
	// `services.cometRpc.enabled: false` — CometBFT starts no RPC listener at
	// all when the address is empty, which is stronger than binding loopback.
	cfg.RPC.ListenAddress = ""
	cfg.RPC.CORSAllowedOrigins = []string{}
	cfg.RPC.GRPCListenAddress = ""
	cfg.RPC.Unsafe = false
	cfg.RPC.PprofListenAddress = ""
	cfg.P2P.ListenAddress = fmt.Sprintf("tcp://%s:%d", listenHost, ports.CometP2P)
	cfg.P2P.ExternalAddress = ""
	cfg.P2P.Seeds = ""
	cfg.P2P.PersistentPeers = archivePersistentPeers(profile, validators)
	cfg.P2P.UnconditionalPeerIDs = ""
	cfg.P2P.PrivatePeerIDs = archivePrivatePeerIDs(validators)
	cfg.P2P.AddrBookStrict = false
	cfg.P2P.AllowDuplicateIP = true
	cfg.P2P.PexReactor = false
	cfg.P2P.MaxNumInboundPeers = 20
	cfg.P2P.MaxNumOutboundPeers = 10
	if err := toriumconfig.ApplyCometMempoolPolicy(cfg, policy); err != nil {
		return nil, fmt.Errorf("apply Torium mempool policy for the archive node: %w", err)
	}
	cfg.Consensus.TimeoutPropose = toriumconfig.LocalTimeoutPropose
	cfg.Consensus.TimeoutProposeDelta = toriumconfig.LocalTimeoutProposeDelta
	cfg.Consensus.TimeoutPrevote = toriumconfig.LocalTimeoutPrevote
	cfg.Consensus.TimeoutPrevoteDelta = toriumconfig.LocalTimeoutPrevoteDelta
	cfg.Consensus.TimeoutPrecommit = toriumconfig.LocalTimeoutPrecommit
	cfg.Consensus.TimeoutPrecommitDelta = toriumconfig.LocalTimeoutPrecommitDelta
	cfg.Consensus.TimeoutCommit = toriumconfig.LocalTimeoutCommit
	// `storagePolicies.archive-indexer-v0.txIndex: "kv"` — the explorer needs
	// transaction lookups by hash, so the indexer must stay on.
	cfg.TxIndex.Indexer = archiveTxIndexer
	cfg.Instrumentation.Prometheus = true
	cfg.Instrumentation.PrometheusListenAddr = fmt.Sprintf("%s:%d", listenHost, cometMetricsPort+archiveMetricsOffset(profile))

	if err := cfg.ValidateBasic(); err != nil {
		return nil, fmt.Errorf("validate archive CometBFT config: %w", err)
	}
	if err := validateArchiveCometEndpoints(profile, cfg); err != nil {
		return nil, err
	}
	return cfg, nil
}

func archiveApplicationConfig(profile RuntimeProfile) (toriumconfig.EVMAppConfig, error) {
	policy := toriumconfig.MustLocalFeeAndResourcePolicy()
	_, raw := toriumconfig.InitAppConfig()
	cfg, ok := raw.(toriumconfig.EVMAppConfig)
	if !ok {
		return toriumconfig.EVMAppConfig{}, fmt.Errorf("torium application config has unexpected type %T", raw)
	}
	ports := archivePorts(profile)
	listenHost := listenerHost(profile)

	cfg.Mempool.MaxTxs = policy.CosmosMempoolMaxTransactions
	// `pruningStrategy: "nothing"` with `minRetainBlocks: 0` is what makes the
	// node an archive: no height is ever discarded, so a historical state
	// query at genesis height still resolves.
	cfg.Pruning = archivePruningStrategy
	cfg.PruningKeepRecent = "0"
	cfg.PruningInterval = "0"
	cfg.MinRetainBlocks = 0
	cfg.IndexEvents = []string{}
	cfg.StateSync.SnapshotInterval = 0
	cfg.StateSync.SnapshotKeepRecent = 2
	// `services.cosmosRest` / `services.cosmosGrpc`: disabled. The archive
	// node's only consumer surface is EVM JSON-RPC, behind the gateway.
	cfg.API.Enable = false
	cfg.API.Swagger = false
	cfg.API.EnableUnsafeCORS = false
	cfg.GRPC.Enable = false
	cfg.GRPCWeb.Enable = false
	cfg.JSONRPC.Enable = true
	cfg.JSONRPC.API = []string{"eth", "net", "web3"}
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
	cfg.JSONRPC.WSOrigins = []string{"127.0.0.1", "localhost"}
	cfg.JSONRPC.MetricsAddress = fmt.Sprintf("%s:%d", listenHost, rpcMetricsPort+archiveMetricsOffset(profile))
	cfg.EVM.EVMChainID = toriumconfig.LocalEVMChainID
	if err := toriumconfig.ApplyEVMFeeAndMempoolPolicy(&cfg.EVM, policy); err != nil {
		return toriumconfig.EVMAppConfig{}, fmt.Errorf("apply Torium EVM fee policy to the archive node: %w", err)
	}
	// `safety.tracer: ""` and `preimageRecording: false`: the archive node is
	// a candidate for the trace namespace, but the trace policy keeps those
	// methods disabled until a new profile version proves them.
	cfg.EVM.Tracer = ""
	cfg.EVM.EnablePreimageRecording = false
	cfg.EVM.GethMetricsAddress = fmt.Sprintf("127.0.0.1:%d", gethMetricsPort+archiveMetricsOffset(profile))

	evmConfig := cosmosevmserverconfig.Config{
		Config:  cfg.Config,
		EVM:     cfg.EVM,
		JSONRPC: cfg.JSONRPC,
		TLS:     cfg.TLS,
	}
	if err := evmConfig.ValidateBasic(); err != nil {
		return toriumconfig.EVMAppConfig{}, fmt.Errorf("validate archive application config: %w", err)
	}
	if err := validateArchiveApplicationEndpoints(profile, cfg); err != nil {
		return toriumconfig.EVMAppConfig{}, err
	}
	return cfg, nil
}

func archiveMetricsOffset(profile RuntimeProfile) int {
	if profile == ProfileRaw {
		return archiveNodeIndex * toriumconfig.LocalPortOffset
	}
	return 0
}

func validateArchiveCometEndpoints(profile RuntimeProfile, cfg *cmtcfg.Config) error {
	if cfg == nil {
		return fmt.Errorf("archive CometBFT config is required")
	}
	if cfg.RPC.ListenAddress != "" {
		return fmt.Errorf("archive CometBFT RPC must be disabled, got %q", cfg.RPC.ListenAddress)
	}
	if cfg.RPC.GRPCListenAddress != "" || cfg.RPC.PprofListenAddress != "" || cfg.RPC.Unsafe {
		return fmt.Errorf("archive CometBFT diagnostic surfaces must be disabled")
	}
	ports := archivePorts(profile)
	expectedP2P := fmt.Sprintf("tcp://%s:%d", listenerHost(profile), ports.CometP2P)
	if cfg.P2P.ListenAddress != expectedP2P {
		return fmt.Errorf("archive p2p address must be %q, got %q", expectedP2P, cfg.P2P.ListenAddress)
	}
	if cfg.P2P.PexReactor || cfg.P2P.Seeds != "" || cfg.P2P.ExternalAddress != "" {
		return fmt.Errorf("archive node must not gossip, seed, or advertise itself")
	}
	if strings.TrimSpace(cfg.P2P.PrivatePeerIDs) == "" {
		return fmt.Errorf("archive node requires private peer IDs")
	}
	if cfg.TxIndex.Indexer != archiveTxIndexer {
		return fmt.Errorf("archive transaction indexer must be %q, got %q", archiveTxIndexer, cfg.TxIndex.Indexer)
	}
	policy := toriumconfig.MustLocalFeeAndResourcePolicy()
	if cfg.Mempool.Type != cmtcfg.MempoolTypeApp ||
		cfg.Mempool.MaxTxBytes != policy.MaxCosmosTransactionBytes {
		return fmt.Errorf("archive mempool admission differs from the local fee policy")
	}
	expectedMetrics := fmt.Sprintf("%s:%d", listenerHost(profile), cometMetricsPort+archiveMetricsOffset(profile))
	if !cfg.Instrumentation.Prometheus || cfg.Instrumentation.PrometheusListenAddr != expectedMetrics {
		return fmt.Errorf("archive CometBFT Prometheus instrumentation must listen on %q", expectedMetrics)
	}
	return nil
}

func validateArchiveApplicationEndpoints(profile RuntimeProfile, cfg toriumconfig.EVMAppConfig) error {
	if cfg.API.Enable || cfg.GRPC.Enable || cfg.GRPCWeb.Enable {
		return fmt.Errorf("archive node must not serve the Cosmos REST or gRPC surfaces")
	}
	if !cfg.JSONRPC.Enable {
		return fmt.Errorf("archive node must serve EVM JSON-RPC for the gateway")
	}
	ports := archivePorts(profile)
	host := listenerHost(profile)
	if cfg.JSONRPC.Address != fmt.Sprintf("%s:%d", host, ports.EVMHTTP) ||
		cfg.JSONRPC.WsAddress != fmt.Sprintf("%s:%d", host, ports.EVMWS) {
		return fmt.Errorf("archive JSON-RPC listeners differ from the %s profile", profile)
	}
	if cfg.Pruning != archivePruningStrategy || cfg.MinRetainBlocks != 0 {
		return fmt.Errorf("archive pruning must retain every height from genesis")
	}
	if cfg.StateSync.SnapshotInterval != 0 {
		return fmt.Errorf("archive node must not produce state-sync snapshots")
	}
	if len(cfg.IndexEvents) != 0 {
		return fmt.Errorf("archive node must not index custom events")
	}
	if cfg.JSONRPC.AllowInsecureUnlock || cfg.JSONRPC.AllowUnprotectedTxs ||
		cfg.JSONRPC.EnableProfiling || cfg.JSONRPC.EnableIndexer {
		return fmt.Errorf("unsafe archive JSON-RPC flags must be disabled")
	}
	if cfg.EVM.Tracer != "" || cfg.EVM.EnablePreimageRecording {
		return fmt.Errorf("archive tracing and preimage recording must stay disabled until the trace policy activates them")
	}
	if cfg.EVM.EVMChainID != toriumconfig.LocalEVMChainID {
		return fmt.Errorf("archive EVM chain ID must be %d", toriumconfig.LocalEVMChainID)
	}
	return nil
}

func verifyExistingArchive(
	root string,
	profile RuntimeProfile,
	topology ArchiveTopology,
	genesis []byte,
	material archiveMaterial,
	validators []runtimeMaterial,
) error {
	recorded, err := ReadArchiveTopology(root)
	if err != nil {
		return err
	}
	expected, err := marshalCanonical(topology)
	if err != nil {
		return err
	}
	actual, err := marshalCanonical(recorded)
	if err != nil {
		return err
	}
	if !bytes.Equal(expected, actual) {
		return fmt.Errorf("recorded archive topology differs from the deterministic contract")
	}
	staging, err := os.MkdirTemp(filepath.Dir(root), ".torium-localnet-archive-verify-*")
	if err != nil {
		return fmt.Errorf("create archive verification directory: %w", err)
	}
	defer func() { _ = os.RemoveAll(staging) }()
	if err := populateArchiveRuntime(staging, profile, genesis, material, validators); err != nil {
		return err
	}
	home := filepath.Join(root, ArchiveNodeName)
	for _, relative := range []string{"", "config", "data"} {
		info, statErr := os.Lstat(filepath.Join(home, relative))
		if statErr != nil {
			return fmt.Errorf("inspect archive directory %q: %w", relative, statErr)
		}
		if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
			return fmt.Errorf("archive path %q must be a real directory", relative)
		}
		if info.Mode().Perm() != 0o700 {
			return fmt.Errorf("archive directory %q mode is %04o, expected 0700", relative, info.Mode().Perm())
		}
	}
	for _, relative := range []string{
		filepath.Join("config", genesisFileName),
		filepath.Join("config", "priv_validator_key.json"),
		filepath.Join("config", "node_key.json"),
		filepath.Join("config", "config.toml"),
		filepath.Join("config", "app.toml"),
	} {
		want, readErr := os.ReadFile(filepath.Join(staging, ArchiveNodeName, relative))
		if readErr != nil {
			return fmt.Errorf("read expected archive %s: %w", relative, readErr)
		}
		got, readErr := os.ReadFile(filepath.Join(home, relative))
		if readErr != nil {
			return fmt.Errorf("read existing archive %s: %w", relative, readErr)
		}
		if !bytes.Equal(got, want) {
			return fmt.Errorf("archive static file %s differs", relative)
		}
	}
	return nil
}
