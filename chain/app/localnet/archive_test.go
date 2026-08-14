package localnet

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	toriumconfig "github.com/torium-network/torium-chain/config"
)

func prepareArchiveFixture(t *testing.T) (RuntimeGenerator, string, ArchiveTopology) {
	t.Helper()
	generator := RuntimeGenerator{Genesis: testGenerator()}
	root := filepath.Join(t.TempDir(), "container")
	if _, err := generator.Prepare(PrepareOptions{Root: root, Profile: ProfileContainer}); err != nil {
		t.Fatalf("prepare validator runtime: %v", err)
	}
	topology, err := generator.PrepareArchive(root, ProfileContainer, false)
	if err != nil {
		t.Fatalf("prepare archive runtime: %v", err)
	}
	return generator, root, topology
}

// The archive node must not change the four-validator topology contract. Every
// piece of committed evidence reads or hashes that file, so adding the archive
// lane may not perturb a single byte of it.
func TestPrepareArchiveLeavesTheValidatorTopologyUntouched(t *testing.T) {
	t.Parallel()

	generator := RuntimeGenerator{Genesis: testGenerator()}
	root := filepath.Join(t.TempDir(), "container")
	if _, err := generator.Prepare(PrepareOptions{Root: root, Profile: ProfileContainer}); err != nil {
		t.Fatalf("prepare validator runtime: %v", err)
	}
	before, err := os.ReadFile(filepath.Join(root, topologyFileName))
	if err != nil {
		t.Fatalf("read validator topology: %v", err)
	}
	if _, err := generator.PrepareArchive(root, ProfileContainer, false); err != nil {
		t.Fatalf("prepare archive runtime: %v", err)
	}
	after, err := os.ReadFile(filepath.Join(root, topologyFileName))
	if err != nil {
		t.Fatalf("re-read validator topology: %v", err)
	}
	if string(before) != string(after) {
		t.Fatal("preparing the archive node rewrote the validator topology")
	}
	// The validator runtime must still verify against its own contract.
	if _, err := generator.Prepare(PrepareOptions{Root: root, Profile: ProfileContainer}); err != nil {
		t.Fatalf("validator runtime no longer verifies after archive preparation: %v", err)
	}
}

func TestArchiveTopologyHonoursTheRoleBoundary(t *testing.T) {
	t.Parallel()

	_, root, topology := prepareArchiveFixture(t)
	if topology.Role != ArchiveNodeName || topology.Name != ArchiveNodeName {
		t.Fatalf("archive topology names the role %q/%q", topology.Role, topology.Name)
	}
	if topology.RegisteredValidator || topology.VotingPower != 0 {
		t.Fatal("the archive node must hold no voting power and no registered identity")
	}
	if topology.CometRPCEnabled || topology.CosmosRESTEnabled || topology.CosmosGRPCEnabled {
		t.Fatal("the archive node must serve neither CometBFT RPC nor the Cosmos surfaces")
	}
	if !topology.EVMJSONRPCEnabled {
		t.Fatal("the archive node must serve the EVM JSON-RPC surface the gateway fronts")
	}
	if topology.HostPublishedListener {
		t.Fatal("the archive node must publish nothing to the host")
	}
	if topology.PruningStrategy != "nothing" || topology.TransactionIndexer != "kv" {
		t.Fatalf("archive storage policy is %q/%q", topology.PruningStrategy, topology.TransactionIndexer)
	}
	if topology.Ports.EVMHTTP != 8545 || topology.Ports.EVMWS != 8546 || topology.Ports.CometP2P != 26656 {
		t.Fatalf("archive container ports are %+v", topology.Ports)
	}
	recorded, err := ReadArchiveTopology(root)
	if err != nil {
		t.Fatalf("read archive topology: %v", err)
	}
	if recorded != topology {
		t.Fatal("recorded archive topology differs from the returned one")
	}
}

// The reviewed role forbids the archive node from carrying a registered
// validator consensus key; a collision would let it double-sign.
func TestArchiveIdentityIsDistinctFromEveryValidator(t *testing.T) {
	t.Parallel()

	_, root, archive := prepareArchiveFixture(t)
	validators, err := ReadTopology(root)
	if err != nil {
		t.Fatalf("read validator topology: %v", err)
	}
	for _, node := range validators.Nodes {
		if node.NodeID == archive.NodeID {
			t.Fatalf("archive node ID collides with %s", node.Name)
		}
		if node.ConsensusAddressHex == archive.ConsensusAddressHex {
			t.Fatalf("archive consensus address collides with %s", node.Name)
		}
	}
	// It must nonetheless dial every validator, and treat each as private.
	for _, node := range validators.Nodes {
		if !strings.Contains(archive.PersistentPeers, node.NodeID) {
			t.Fatalf("archive node does not dial %s", node.Name)
		}
		if !strings.Contains(archive.PrivatePeerIDs, node.NodeID) {
			t.Fatalf("archive node does not treat %s as a private peer", node.Name)
		}
	}
}

func TestArchiveRuntimeConfigurationMatchesTheStoragePolicy(t *testing.T) {
	t.Parallel()

	_, root, _ := prepareArchiveFixture(t)
	appConfig, err := os.ReadFile(filepath.Join(root, ArchiveNodeName, "config", "app.toml"))
	if err != nil {
		t.Fatalf("read archive app.toml: %v", err)
	}
	cometConfig, err := os.ReadFile(filepath.Join(root, ArchiveNodeName, "config", "config.toml"))
	if err != nil {
		t.Fatalf("read archive config.toml: %v", err)
	}
	for _, expected := range []string{
		`pruning = "nothing"`,
		`min-retain-blocks = 0`,
	} {
		if !strings.Contains(string(appConfig), expected) {
			t.Fatalf("archive app.toml is missing %q", expected)
		}
	}
	// An empty CometBFT RPC address starts no listener at all.
	if !strings.Contains(string(cometConfig), `laddr = ""`) {
		t.Fatal("archive config.toml does not disable the CometBFT RPC listener")
	}
	if !strings.Contains(string(cometConfig), `indexer = "kv"`) {
		t.Fatal("archive config.toml does not enable the kv transaction indexer")
	}
	if !strings.Contains(string(cometConfig), "pex = false") {
		t.Fatal("archive config.toml does not disable peer exchange")
	}
	if !strings.Contains(string(cometConfig), "prometheus = true") {
		t.Fatal("archive config.toml does not enable Prometheus instrumentation")
	}
	// The genesis the archive node replays must be the reviewed one.
	archiveGenesis, err := os.ReadFile(filepath.Join(root, ArchiveNodeName, "config", genesisFileName))
	if err != nil {
		t.Fatalf("read archive genesis: %v", err)
	}
	validatorGenesis, err := os.ReadFile(filepath.Join(root, "validator-0", "config", genesisFileName))
	if err != nil {
		t.Fatalf("read validator genesis: %v", err)
	}
	if string(archiveGenesis) != string(validatorGenesis) {
		t.Fatal("archive genesis differs from the validator genesis")
	}
}

func TestPrepareArchiveIsIdempotentAndFailsClosedOnDrift(t *testing.T) {
	t.Parallel()

	generator, root, topology := prepareArchiveFixture(t)
	again, err := generator.PrepareArchive(root, ProfileContainer, false)
	if err != nil {
		t.Fatalf("re-preparing the archive node failed: %v", err)
	}
	if again != topology {
		t.Fatal("re-preparation produced a different archive topology")
	}

	// A tampered static file must be refused rather than silently accepted.
	appPath := filepath.Join(root, ArchiveNodeName, "config", "app.toml")
	original, err := os.ReadFile(appPath)
	if err != nil {
		t.Fatalf("read archive app.toml: %v", err)
	}
	if err := os.WriteFile(appPath, append(original, []byte("\n# drift\n")...), 0o644); err != nil {
		t.Fatalf("tamper with archive app.toml: %v", err)
	}
	if _, err := generator.PrepareArchive(root, ProfileContainer, false); err == nil {
		t.Fatal("a drifted archive runtime was accepted")
	}
	// An explicit reset restores the deterministic contract.
	if _, err := generator.PrepareArchive(root, ProfileContainer, true); err != nil {
		t.Fatalf("resetting the archive runtime failed: %v", err)
	}
	restored, err := os.ReadFile(appPath)
	if err != nil {
		t.Fatalf("re-read archive app.toml: %v", err)
	}
	if string(restored) != string(original) {
		t.Fatal("reset did not restore the deterministic archive configuration")
	}
}

// An archive node that indexes a different chain than the validators serve is
// worse than none, so preparation refuses a root without a prepared runtime.
func TestPrepareArchiveRequiresAPreparedValidatorRuntime(t *testing.T) {
	t.Parallel()

	generator := RuntimeGenerator{Genesis: testGenerator()}
	empty := filepath.Join(t.TempDir(), "container")
	if _, err := generator.PrepareArchive(empty, ProfileContainer, false); err == nil {
		t.Fatal("archive preparation succeeded without a prepared validator runtime")
	}

	root := filepath.Join(t.TempDir(), "raw")
	if _, err := generator.Prepare(PrepareOptions{Root: root, Profile: ProfileRaw}); err != nil {
		t.Fatalf("prepare raw validator runtime: %v", err)
	}
	if _, err := generator.PrepareArchive(root, ProfileContainer, false); err == nil {
		t.Fatal("archive preparation accepted a profile mismatch")
	}
	raw, err := generator.PrepareArchive(root, ProfileRaw, false)
	if err != nil {
		t.Fatalf("prepare raw archive runtime: %v", err)
	}
	// The raw profile offsets the archive listeners past the four validators.
	offset := toriumconfig.LocalValidatorCount * toriumconfig.LocalPortOffset
	if raw.Ports.EVMHTTP != 8545+offset || raw.Ports.CometP2P != 26656+offset {
		t.Fatalf("raw archive ports are %+v", raw.Ports)
	}
}

func TestReadArchiveTopologyRejectsWidenedClaims(t *testing.T) {
	t.Parallel()

	_, root, topology := prepareArchiveFixture(t)
	path := filepath.Join(root, archiveTopologyFileName)
	for name, mutate := range map[string]func(*ArchiveTopology){
		"registered validator": func(value *ArchiveTopology) { value.RegisteredValidator = true },
		"voting power":         func(value *ArchiveTopology) { value.VotingPower = 25 },
		"comet rpc":            func(value *ArchiveTopology) { value.CometRPCEnabled = true },
		"cosmos rest":          func(value *ArchiveTopology) { value.CosmosRESTEnabled = true },
		"cosmos grpc":          func(value *ArchiveTopology) { value.CosmosGRPCEnabled = true },
		"host publish":         func(value *ArchiveTopology) { value.HostPublishedListener = true },
		"json rpc disabled":    func(value *ArchiveTopology) { value.EVMJSONRPCEnabled = false },
		"pruning":              func(value *ArchiveTopology) { value.PruningStrategy = "default" },
		"tx index":             func(value *ArchiveTopology) { value.TransactionIndexer = "null" },
		"ports":                func(value *ArchiveTopology) { value.Ports.EVMHTTP = 18545 },
		"role":                 func(value *ArchiveTopology) { value.Role = "validator" },
	} {
		mutated := topology
		mutate(&mutated)
		contents, err := json.Marshal(mutated)
		if err != nil {
			t.Fatalf("marshal mutated archive topology: %v", err)
		}
		if err := os.WriteFile(path, contents, 0o644); err != nil {
			t.Fatalf("write mutated archive topology: %v", err)
		}
		if _, err := ReadArchiveTopology(root); err == nil {
			t.Fatalf("widened archive topology (%s) was accepted", name)
		}
	}
}
