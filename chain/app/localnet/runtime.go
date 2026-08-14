package localnet

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	cmtcfg "github.com/cometbft/cometbft/config"
	cmted25519 "github.com/cometbft/cometbft/crypto/ed25519"
	"github.com/cometbft/cometbft/p2p"
	"github.com/cometbft/cometbft/privval"
	sdk "github.com/cosmos/cosmos-sdk/types"
	cosmosevmserverconfig "github.com/cosmos/evm/server/config"
	toriumconfig "github.com/torium-network/torium-chain/config"
)

const (
	topologyFileName = "topology.json"
	localWarning     = "VALUELESS LOCAL DEVELOPMENT ONLY — deterministic keys are public fixtures; never reuse them on a public or valuable network."
)

// PrepareOptions selects an ignored local runtime root. Reset is deliberately
// explicit because replacing priv_validator_state.json on a live chain can
// cause double-signing.
type PrepareOptions struct {
	Root    string
	Profile RuntimeProfile
	Reset   bool
}

// RuntimeGenerator binds runtime homes to the exact reviewed genesis bytes.
type RuntimeGenerator struct {
	Genesis Generator
}

// ResetNode replaces exactly one stopped validator home with its deterministic
// height-zero fixture while preserving the other validators and public
// topology. The caller owns process lifecycle and must not invoke this while
// the selected validator is running.
func (generator RuntimeGenerator) ResetNode(rootValue string, profile RuntimeProfile, name string) (Topology, error) {
	if profile != ProfileContainer && profile != ProfileRaw {
		return Topology{}, fmt.Errorf("invalid localnet runtime profile %q", profile)
	}
	if !validRecoveryNodeName(name) {
		return Topology{}, fmt.Errorf("invalid localnet validator %q", name)
	}
	root, err := safeRuntimeRoot(rootValue)
	if err != nil {
		return Topology{}, err
	}
	if err := validateResetTarget(root, profile); err != nil {
		return Topology{}, fmt.Errorf("refusing to reset node in unrecognized directory: %w", err)
	}
	if err := ensureRealDirectory(filepath.Join(root, name)); err != nil {
		return Topology{}, err
	}

	artifact, err := generator.Genesis.Generate()
	if err != nil {
		return Topology{}, err
	}
	fixture, err := LoadFixture()
	if err != nil {
		return Topology{}, err
	}
	materials, err := deriveRuntimeMaterials(fixture)
	if err != nil {
		return Topology{}, err
	}
	topology := buildTopology(profile, artifact.Genesis, materials)
	parent := filepath.Dir(root)
	staging, err := os.MkdirTemp(parent, ".torium-localnet-node-reset-*")
	if err != nil {
		return Topology{}, fmt.Errorf("create node-reset staging directory: %w", err)
	}
	defer func() { _ = os.RemoveAll(staging) }()
	if err := populateRuntime(staging, profile, artifact.Genesis, materials, topology); err != nil {
		return Topology{}, err
	}
	currentTopology, err := os.ReadFile(filepath.Join(root, topologyFileName))
	if err != nil {
		return Topology{}, err
	}
	expectedTopology, err := os.ReadFile(filepath.Join(staging, topologyFileName))
	if err != nil {
		return Topology{}, err
	}
	if !bytes.Equal(currentTopology, expectedTopology) {
		return Topology{}, fmt.Errorf("existing topology differs from the deterministic reset contract")
	}

	backup, err := os.MkdirTemp(parent, ".torium-localnet-node-backup-*")
	if err != nil {
		return Topology{}, fmt.Errorf("create node-reset rollback directory: %w", err)
	}
	defer func() { _ = os.RemoveAll(backup) }()
	target := filepath.Join(root, name)
	preserved := filepath.Join(backup, name)
	if err := os.Rename(target, preserved); err != nil {
		return Topology{}, fmt.Errorf("preserve %s before reset: %w", name, err)
	}
	if err := os.Rename(filepath.Join(staging, name), target); err != nil {
		_ = os.Rename(preserved, target)
		return Topology{}, fmt.Errorf("activate reset %s: %w", name, err)
	}
	return topology, nil
}

// Topology is the public, non-secret inventory for one prepared runtime.
type Topology struct {
	SchemaVersion     int            `json:"schema_version"`
	Warning           string         `json:"warning"`
	Profile           RuntimeProfile `json:"profile"`
	CosmosChainID     string         `json:"cosmos_chain_id"`
	EVMChainID        uint64         `json:"evm_chain_id"`
	GenesisSHA256     string         `json:"genesis_sha256"`
	ValidatorCount    int            `json:"validator_count"`
	PowerPerValidator int64          `json:"power_per_validator"`
	TotalVotingPower  int64          `json:"total_voting_power"`
	CommitQuorumPower int64          `json:"commit_quorum_power"`
	ClientNode        string         `json:"client_node"`
	Nodes             []Node         `json:"nodes"`
}

// Node describes one validator's public identities, peers, and listeners.
type Node struct {
	Name                   string `json:"name"`
	Home                   string `json:"home"`
	NodeID                 string `json:"node_id"`
	ConsensusAddressHex    string `json:"consensus_address_hex"`
	ConsensusAddressBech32 string `json:"consensus_address_bech32"`
	VotingPower            int64  `json:"voting_power"`
	PersistentPeers        string `json:"persistent_peers"`
	ClientTraffic          bool   `json:"client_traffic"`
	Ports                  Ports  `json:"ports"`
}

// Ports lists the internal or host-loopback ports assigned to a node profile.
type Ports struct {
	CometP2P int `json:"comet_p2p"`
	CometRPC int `json:"comet_rpc"`
	API      int `json:"cosmos_rest"`
	GRPC     int `json:"cosmos_grpc"`
	EVMHTTP  int `json:"evm_http"`
	EVMWS    int `json:"evm_ws"`
}

type runtimeMaterial struct {
	name            string
	consensusKey    cmted25519.PrivKey
	nodeKey         *p2p.NodeKey
	consensusBech32 string
	power           int64
}

// Prepare creates deterministic, isolated validator homes. Re-running without
// Reset verifies static identity/configuration and preserves databases plus
// signer state. A mismatch fails closed and requires an explicit reset.
func (generator RuntimeGenerator) Prepare(options PrepareOptions) (Topology, error) {
	if options.Profile != ProfileContainer && options.Profile != ProfileRaw {
		return Topology{}, fmt.Errorf("invalid localnet runtime profile %q", options.Profile)
	}
	root, err := safeRuntimeRoot(options.Root)
	if err != nil {
		return Topology{}, err
	}
	artifact, err := generator.Genesis.Generate()
	if err != nil {
		return Topology{}, err
	}
	fixture, err := LoadFixture()
	if err != nil {
		return Topology{}, err
	}
	materials, err := deriveRuntimeMaterials(fixture)
	if err != nil {
		return Topology{}, err
	}
	topology := buildTopology(options.Profile, artifact.Genesis, materials)

	parent := filepath.Dir(root)
	if err := os.MkdirAll(parent, 0o755); err != nil {
		return Topology{}, fmt.Errorf("create runtime parent: %w", err)
	}
	staging, err := os.MkdirTemp(parent, ".torium-localnet-prepare-*")
	if err != nil {
		return Topology{}, fmt.Errorf("create runtime staging directory: %w", err)
	}
	defer func() { _ = os.RemoveAll(staging) }()
	if err := populateRuntime(staging, options.Profile, artifact.Genesis, materials, topology); err != nil {
		return Topology{}, err
	}

	_, statErr := os.Stat(root)
	switch {
	case statErr == nil && !options.Reset:
		if err := verifyExistingRuntime(root, staging); err != nil {
			return Topology{}, fmt.Errorf("existing runtime differs from the deterministic contract; inspect it or rerun with --reset: %w", err)
		}
		return topology, nil
	case statErr != nil && !os.IsNotExist(statErr):
		return Topology{}, fmt.Errorf("inspect runtime root: %w", statErr)
	case statErr == nil && options.Reset:
		if err := validateResetTarget(root, options.Profile); err != nil {
			return Topology{}, fmt.Errorf("refusing to reset unrecognized directory: %w", err)
		}
		if err := os.RemoveAll(root); err != nil {
			return Topology{}, fmt.Errorf("remove reset runtime: %w", err)
		}
	}
	if err := os.Rename(staging, root); err != nil {
		return Topology{}, fmt.Errorf("activate prepared runtime: %w", err)
	}
	return topology, nil
}

func safeRuntimeRoot(value string) (string, error) {
	if strings.TrimSpace(value) == "" {
		return "", fmt.Errorf("runtime root is required")
	}
	root, err := filepath.Abs(filepath.Clean(value))
	if err != nil {
		return "", fmt.Errorf("resolve runtime root: %w", err)
	}
	volume := filepath.VolumeName(root)
	if root == string(filepath.Separator) || root == volume+string(filepath.Separator) {
		return "", fmt.Errorf("refusing to use filesystem root as localnet runtime")
	}
	return root, nil
}

func deriveRuntimeMaterials(fixture Fixture) ([]runtimeMaterial, error) {
	accountMaterials, err := deriveAccountMaterials(fixture)
	if err != nil {
		return nil, err
	}
	result := make([]runtimeMaterial, 0, toriumconfig.LocalValidatorCount)
	nodeIDs := make(map[string]string, toriumconfig.LocalValidatorCount)
	for _, material := range accountMaterials {
		if material.fixture.Role != "validator" {
			continue
		}
		consensusKey := cmted25519.GenPrivKeyFromSecret([]byte(fixtureDomain + "/consensus/" + material.fixture.DerivationContext))
		if !bytes.Equal(consensusKey.PubKey().Bytes(), material.consensusKey.PubKey().Bytes()) {
			return nil, fmt.Errorf("CometBFT and genesis consensus derivation differ for %s", material.fixture.Name)
		}
		nodeKey := &p2p.NodeKey{PrivKey: cmted25519.GenPrivKeyFromSecret([]byte(fixtureDomain + "/node/" + material.fixture.DerivationContext))}
		nodeID := string(nodeKey.ID())
		if prior, duplicate := nodeIDs[nodeID]; duplicate {
			return nil, fmt.Errorf("validators %s and %s derive duplicate node IDs", prior, material.fixture.Name)
		}
		nodeIDs[nodeID] = material.fixture.Name
		result = append(result, runtimeMaterial{
			name:            material.fixture.Name,
			consensusKey:    consensusKey,
			nodeKey:         nodeKey,
			consensusBech32: sdk.ConsAddress(material.consensusKey.PubKey().Address()).String(),
			power:           material.fixture.ExpectedVotingPower,
		})
	}
	sort.Slice(result, func(i, j int) bool { return result[i].name < result[j].name })
	if len(result) != toriumconfig.LocalValidatorCount {
		return nil, fmt.Errorf("runtime requires %d validators, got %d", toriumconfig.LocalValidatorCount, len(result))
	}
	return result, nil
}

func buildTopology(profile RuntimeProfile, genesis []byte, materials []runtimeMaterial) Topology {
	digest := sha256.Sum256(genesis)
	topology := Topology{
		SchemaVersion:     1,
		Warning:           localWarning,
		Profile:           profile,
		CosmosChainID:     toriumconfig.LocalCosmosChainID,
		EVMChainID:        toriumconfig.LocalEVMChainID,
		GenesisSHA256:     hex.EncodeToString(digest[:]),
		ValidatorCount:    toriumconfig.LocalValidatorCount,
		PowerPerValidator: toriumconfig.LocalValidatorPower,
		TotalVotingPower:  toriumconfig.LocalTotalVotingPower,
		CommitQuorumPower: toriumconfig.LocalCommitQuorumPower,
		ClientNode:        "validator-0",
		Nodes:             make([]Node, 0, len(materials)),
	}
	for index, material := range materials {
		topology.Nodes = append(topology.Nodes, Node{
			Name:                   material.name,
			Home:                   material.name,
			NodeID:                 string(material.nodeKey.ID()),
			ConsensusAddressHex:    strings.ToUpper(hex.EncodeToString(material.consensusKey.PubKey().Address())),
			ConsensusAddressBech32: material.consensusBech32,
			VotingPower:            material.power,
			PersistentPeers:        persistentPeers(profile, index, materials),
			ClientTraffic:          index == 0,
			Ports:                  nodePorts(profile, index),
		})
	}
	return topology
}

func persistentPeers(profile RuntimeProfile, self int, materials []runtimeMaterial) string {
	peers := make([]string, 0, len(materials)-1)
	for index, material := range materials {
		if index == self {
			continue
		}
		host := material.name
		port := cometP2PPort
		if profile == ProfileRaw {
			host = "127.0.0.1"
			port += index * toriumconfig.LocalPortOffset
		}
		peers = append(peers, fmt.Sprintf("%s@%s:%d", material.nodeKey.ID(), host, port))
	}
	return strings.Join(peers, ",")
}

func populateRuntime(root string, profile RuntimeProfile, genesis []byte, materials []runtimeMaterial, topology Topology) error {
	for index, material := range materials {
		home := filepath.Join(root, material.name)
		configDirectory := filepath.Join(home, "config")
		dataDirectory := filepath.Join(home, "data")
		if err := os.MkdirAll(configDirectory, 0o700); err != nil {
			return fmt.Errorf("create %s config directory: %w", material.name, err)
		}
		if err := os.MkdirAll(dataDirectory, 0o700); err != nil {
			return fmt.Errorf("create %s data directory: %w", material.name, err)
		}
		if err := os.WriteFile(filepath.Join(configDirectory, genesisFileName), genesis, 0o644); err != nil {
			return fmt.Errorf("write %s genesis: %w", material.name, err)
		}
		if err := writeNodeFiles(home, profile, index, material, materials); err != nil {
			return err
		}
	}
	topologyJSON, err := marshalCanonical(topology)
	if err != nil {
		return fmt.Errorf("marshal localnet topology: %w", err)
	}
	if err := os.WriteFile(filepath.Join(root, topologyFileName), topologyJSON, 0o644); err != nil {
		return fmt.Errorf("write localnet topology: %w", err)
	}
	return nil
}

func writeNodeFiles(home string, profile RuntimeProfile, index int, material runtimeMaterial, materials []runtimeMaterial) (err error) {
	defer func() {
		if recovered := recover(); recovered != nil {
			err = fmt.Errorf("write %s runtime files: %v", material.name, recovered)
		}
	}()
	keyPath := filepath.Join(home, "config", "priv_validator_key.json")
	statePath := filepath.Join(home, "data", "priv_validator_state.json")
	pv := privval.NewFilePV(material.consensusKey, keyPath, statePath)
	pv.Save()
	if err := material.nodeKey.SaveAs(filepath.Join(home, "config", "node_key.json")); err != nil {
		return fmt.Errorf("write %s node key: %w", material.name, err)
	}
	comet, err := cometConfig(home, material.name, profile, index, persistentPeers(profile, index, materials))
	if err != nil {
		return err
	}
	app, err := applicationConfig(profile, index)
	if err != nil {
		return fmt.Errorf("configure %s application: %w", material.name, err)
	}
	converted := &cosmosevmserverconfig.Config{
		Config:  app.Config,
		EVM:     app.EVM,
		JSONRPC: app.JSONRPC,
		TLS:     app.TLS,
	}
	if err := cosmosevmserverconfig.ValidateCrossConfig(comet, converted); err != nil {
		return fmt.Errorf("validate %s cross-config: %w", material.name, err)
	}
	cmtcfg.WriteConfigFile(filepath.Join(home, "config", "config.toml"), comet)
	writeApplicationConfig(filepath.Join(home, "config", "app.toml"), app)
	return nil
}

func verifyExistingRuntime(existing, expected string) error {
	for index := 0; index < toriumconfig.LocalValidatorCount; index++ {
		name := fmt.Sprintf("validator-%d", index)
		for _, relative := range []string{name, filepath.Join(name, "config"), filepath.Join(name, "data")} {
			info, err := os.Lstat(filepath.Join(existing, relative))
			if err != nil {
				return fmt.Errorf("inspect runtime directory %s: %w", relative, err)
			}
			if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
				return fmt.Errorf("runtime path %s must be a real directory", relative)
			}
			if info.Mode().Perm() != 0o700 {
				return fmt.Errorf("directory %s mode is %04o, expected 0700", relative, info.Mode().Perm())
			}
		}
	}
	staticFiles := []string{topologyFileName}
	for index := 0; index < toriumconfig.LocalValidatorCount; index++ {
		name := fmt.Sprintf("validator-%d", index)
		staticFiles = append(staticFiles, []string{
			filepath.Join(name, "config", genesisFileName),
			filepath.Join(name, "config", "priv_validator_key.json"),
			filepath.Join(name, "config", "node_key.json"),
			filepath.Join(name, "config", "config.toml"),
			filepath.Join(name, "config", "app.toml"),
		}...)
	}
	for _, relative := range staticFiles {
		want, err := os.ReadFile(filepath.Join(expected, relative))
		if err != nil {
			return fmt.Errorf("read expected %s: %w", relative, err)
		}
		got, err := os.ReadFile(filepath.Join(existing, relative))
		if err != nil {
			return fmt.Errorf("read existing %s: %w", relative, err)
		}
		if !bytes.Equal(got, want) {
			return fmt.Errorf("static file %s differs", relative)
		}
		info, err := os.Stat(filepath.Join(existing, relative))
		if err != nil {
			return fmt.Errorf("stat existing %s: %w", relative, err)
		}
		expectedMode := os.FileMode(0o644)
		if strings.HasSuffix(relative, "_key.json") || strings.HasSuffix(relative, "node_key.json") {
			expectedMode = 0o600
		}
		if info.Mode().Perm() != expectedMode {
			return fmt.Errorf("file %s mode is %04o, expected %04o", relative, info.Mode().Perm(), expectedMode)
		}
	}
	for index := 0; index < toriumconfig.LocalValidatorCount; index++ {
		state := filepath.Join(existing, fmt.Sprintf("validator-%d", index), "data", "priv_validator_state.json")
		info, err := os.Stat(state)
		if err != nil {
			return fmt.Errorf("stat signer state %s: %w", state, err)
		}
		if info.Mode().Perm() != 0o600 {
			return fmt.Errorf("signer state %s mode is %04o, expected 0600", state, info.Mode().Perm())
		}
	}
	return nil
}

// ReadTopology validates and decodes the public runtime inventory.
func ReadTopology(root string) (Topology, error) {
	contents, err := os.ReadFile(filepath.Join(root, topologyFileName))
	if err != nil {
		return Topology{}, fmt.Errorf("read localnet topology: %w", err)
	}
	var topology Topology
	if err := json.Unmarshal(contents, &topology); err != nil {
		return Topology{}, fmt.Errorf("decode localnet topology: %w", err)
	}
	if err := validateTopology(topology); err != nil {
		return Topology{}, err
	}
	return topology, nil
}

func validateResetTarget(root string, profile RuntimeProfile) error {
	topology, err := ReadTopology(root)
	if err != nil {
		return err
	}
	if topology.Profile != profile {
		return fmt.Errorf("topology profile is %s, requested reset profile is %s", topology.Profile, profile)
	}
	return nil
}

func validateTopology(topology Topology) error {
	if topology.Profile != ProfileContainer && topology.Profile != ProfileRaw {
		return fmt.Errorf("localnet topology has invalid profile %q", topology.Profile)
	}
	digest, err := hex.DecodeString(topology.GenesisSHA256)
	if err != nil || len(digest) != sha256.Size {
		return fmt.Errorf("localnet topology has invalid genesis checksum")
	}
	if topology.SchemaVersion != 1 ||
		topology.Warning != localWarning ||
		topology.CosmosChainID != toriumconfig.LocalCosmosChainID ||
		topology.EVMChainID != toriumconfig.LocalEVMChainID ||
		topology.ValidatorCount != toriumconfig.LocalValidatorCount ||
		topology.PowerPerValidator != toriumconfig.LocalValidatorPower ||
		topology.TotalVotingPower != toriumconfig.LocalTotalVotingPower ||
		topology.CommitQuorumPower != toriumconfig.LocalCommitQuorumPower ||
		topology.ClientNode != "validator-0" ||
		len(topology.Nodes) != toriumconfig.LocalValidatorCount {
		return fmt.Errorf("localnet topology violates schema v1 authority contract")
	}
	nodeIDs := make(map[string]struct{}, toriumconfig.LocalValidatorCount)
	consensusAddresses := make(map[string]struct{}, toriumconfig.LocalValidatorCount)
	for index, node := range topology.Nodes {
		expectedName := fmt.Sprintf("validator-%d", index)
		if node.Name != expectedName || node.Home != expectedName ||
			strings.TrimSpace(node.NodeID) == "" || strings.TrimSpace(node.ConsensusAddressHex) == "" ||
			strings.TrimSpace(node.ConsensusAddressBech32) == "" || strings.TrimSpace(node.PersistentPeers) == "" ||
			node.VotingPower != toriumconfig.LocalValidatorPower || node.ClientTraffic != (index == 0) ||
			node.Ports != nodePorts(topology.Profile, index) {
			return fmt.Errorf("localnet topology node %d violates schema v1", index)
		}
		if _, duplicate := nodeIDs[node.NodeID]; duplicate {
			return fmt.Errorf("localnet topology repeats node ID %s", node.NodeID)
		}
		if _, duplicate := consensusAddresses[node.ConsensusAddressHex]; duplicate {
			return fmt.Errorf("localnet topology repeats consensus address %s", node.ConsensusAddressHex)
		}
		nodeIDs[node.NodeID] = struct{}{}
		consensusAddresses[node.ConsensusAddressHex] = struct{}{}
	}
	return nil
}
