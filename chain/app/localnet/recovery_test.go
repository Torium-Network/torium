package localnet

import (
	"bytes"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	dbm "github.com/cometbft/cometbft-db"
	cmtcrypto "github.com/cometbft/cometbft/crypto"
	cmtstateproto "github.com/cometbft/cometbft/proto/tendermint/state"
	consensusversion "github.com/cometbft/cometbft/proto/tendermint/version"
	cmtstate "github.com/cometbft/cometbft/state"
	cmtstore "github.com/cometbft/cometbft/store"
	cmttypes "github.com/cometbft/cometbft/types"
	cmtversion "github.com/cometbft/cometbft/version"
	toriumversion "github.com/torium-network/torium-chain/internal/version"
)

func TestRecoveryArchiveRoundTripRestoresExactRuntimeState(t *testing.T) {
	parent := t.TempDir()
	root := filepath.Join(parent, "raw")
	generator := RuntimeGenerator{Genesis: testGenerator()}
	if _, err := generator.Prepare(PrepareOptions{Root: root, Profile: ProfileRaw}); err != nil {
		t.Fatal(err)
	}
	writeSyntheticCommittedState(t, root)
	sentinel := filepath.Join(root, "validator-0", "data", "application.db", "balance.txt")
	if err := os.MkdirAll(filepath.Dir(sentinel), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(sentinel, []byte("0x1234=5000000000000000000\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	archive := filepath.Join(parent, "funded.tar.gz")
	binary := testRecoveryBinary()
	created, digest, err := CreateRecoveryArchive(CreateRecoveryOptions{
		Root: root, Profile: ProfileRaw, Fixture: FixtureFunded, Output: archive,
		CreatedAt: time.Date(2026, 7, 14, 12, 0, 0, 0, time.UTC), Binary: binary,
	})
	if err != nil {
		t.Fatal(err)
	}
	if !validHexDigest(digest) || created.Chain.Height != 1 || len(created.Nodes) != 4 {
		t.Fatalf("unexpected recovery metadata: digest=%q manifest=%+v", digest, created)
	}
	if _, _, err := CreateRecoveryArchive(CreateRecoveryOptions{
		Root: root, Profile: ProfileRaw, Fixture: FixtureFunded, Output: archive, Binary: binary,
	}); err == nil || !strings.Contains(err.Error(), "refusing to overwrite") {
		t.Fatalf("existing recovery output was overwritten: %v", err)
	}
	inspected, inspectedDigest, err := InspectRecoveryArchive(archive)
	if err != nil {
		t.Fatal(err)
	}
	if inspectedDigest != digest || !recoveryManifestsEqual(created, inspected) {
		t.Fatal("inspection did not reproduce the created trust envelope")
	}

	if err := os.WriteFile(sentinel, []byte("mutated\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := RestoreRecoveryArchive(RestoreRecoveryOptions{Root: root, Profile: ProfileRaw, Archive: archive, CurrentBinary: binary}); err != nil {
		t.Fatal(err)
	}
	if got := mustRead(t, sentinel); string(got) != "0x1234=5000000000000000000\n" {
		t.Fatalf("restored application state = %q", got)
	}
	nodes, chain, err := InspectRuntimeState(root, "")
	if err != nil {
		t.Fatal(err)
	}
	if !recoveryChainEqual(chain, created.Chain) || !recoveryNodesEqual(nodes, created.Nodes) {
		t.Fatal("restored consensus/application anchors differ from manifest")
	}
}

func TestPerNodeRecoveryRestoresOnlySelectedValidator(t *testing.T) {
	parent := t.TempDir()
	root := filepath.Join(parent, "raw")
	if _, err := (RuntimeGenerator{Genesis: testGenerator()}).Prepare(PrepareOptions{Root: root, Profile: ProfileRaw}); err != nil {
		t.Fatal(err)
	}
	writeSyntheticCommittedState(t, root)
	selected := filepath.Join(root, "validator-2", "data", "selected.txt")
	other := filepath.Join(root, "validator-1", "data", "other.txt")
	if err := os.WriteFile(selected, []byte("captured"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(other, []byte("preserved"), 0o600); err != nil {
		t.Fatal(err)
	}
	binary := testRecoveryBinary()
	archive := filepath.Join(parent, "validator-2.tar.gz")
	manifest, _, err := CreateRecoveryArchive(CreateRecoveryOptions{
		Root: root, Profile: ProfileRaw, Node: "validator-2", Output: archive, Binary: binary,
	})
	if err != nil {
		t.Fatal(err)
	}
	if manifest.Scope != SnapshotScopeNode || manifest.Node != "validator-2" || len(manifest.Nodes) != 1 {
		t.Fatalf("unexpected node recovery manifest: %+v", manifest)
	}
	if err := os.WriteFile(selected, []byte("mutated"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(other, []byte("changed-after-snapshot"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := RestoreRecoveryArchive(RestoreRecoveryOptions{
		Root: root, Profile: ProfileRaw, Archive: archive, CurrentBinary: binary,
	}); err != nil {
		t.Fatal(err)
	}
	if got := mustRead(t, selected); string(got) != "captured" {
		t.Fatalf("selected node file = %q", got)
	}
	if got := mustRead(t, other); string(got) != "changed-after-snapshot" {
		t.Fatalf("per-node restore changed another validator: %q", got)
	}
}

func TestInspectUninitializedNodeDoesNotCreateDatabaseFiles(t *testing.T) {
	root := filepath.Join(t.TempDir(), "raw")
	if _, err := (RuntimeGenerator{Genesis: testGenerator()}).Prepare(PrepareOptions{Root: root, Profile: ProfileRaw}); err != nil {
		t.Fatal(err)
	}
	dataDirectory := filepath.Join(root, "validator-3", "data")
	before, err := recoveryTreeSnapshot(dataDirectory)
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := InspectRuntimeState(root, "validator-3"); err == nil || !strings.Contains(err.Error(), "does not exist") {
		t.Fatalf("uninitialized node inspection returned unexpected error: %v", err)
	}
	after, err := recoveryTreeSnapshot(dataDirectory)
	if err != nil {
		t.Fatal(err)
	}
	if !recoveryTreeSnapshotsEqual(before, after) {
		t.Fatalf("inspection mutated uninitialized node: before=%v after=%v", before, after)
	}
}

func TestInspectCommittedNodeDoesNotMutateDatabaseFiles(t *testing.T) {
	root := filepath.Join(t.TempDir(), "raw")
	if _, err := (RuntimeGenerator{Genesis: testGenerator()}).Prepare(PrepareOptions{Root: root, Profile: ProfileRaw}); err != nil {
		t.Fatal(err)
	}
	writeSyntheticCommittedState(t, root)
	dataDirectory := filepath.Join(root, "validator-2", "data")
	before, err := recoveryTreeSnapshot(dataDirectory)
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := InspectRuntimeState(root, "validator-2"); err != nil {
		t.Fatal(err)
	}
	after, err := recoveryTreeSnapshot(dataDirectory)
	if err != nil {
		t.Fatal(err)
	}
	if !recoveryTreeSnapshotsEqual(before, after) {
		t.Fatalf("inspection mutated committed node: before=%v after=%v", before, after)
	}
}

func TestRecoveryArchiveRejectsCorruptionBeforeMutation(t *testing.T) {
	parent := t.TempDir()
	root := filepath.Join(parent, "raw")
	generator := RuntimeGenerator{Genesis: testGenerator()}
	if _, err := generator.Prepare(PrepareOptions{Root: root, Profile: ProfileRaw}); err != nil {
		t.Fatal(err)
	}
	writeSyntheticCommittedState(t, root)
	archive := filepath.Join(parent, "state.tar.gz")
	binary := testRecoveryBinary()
	if _, _, err := CreateRecoveryArchive(CreateRecoveryOptions{Root: root, Profile: ProfileRaw, Output: archive, Binary: binary}); err != nil {
		t.Fatal(err)
	}
	before := mustRead(t, filepath.Join(root, "validator-0", "data", "priv_validator_state.json"))
	file, err := os.OpenFile(archive, os.O_WRONLY|os.O_APPEND, 0)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := file.Write([]byte("corruption")); err != nil {
		t.Fatal(err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := RestoreRecoveryArchive(RestoreRecoveryOptions{Root: root, Profile: ProfileRaw, Archive: archive, CurrentBinary: binary}); err == nil || !strings.Contains(err.Error(), "checksum mismatch") {
		t.Fatalf("corrupt archive was not rejected by outer checksum: %v", err)
	}
	after := mustRead(t, filepath.Join(root, "validator-0", "data", "priv_validator_state.json"))
	if !bytes.Equal(before, after) {
		t.Fatal("failed restore mutated target state")
	}
}

func TestRecoveryManifestRejectsFilesOutsideDeclaredScope(t *testing.T) {
	parent := t.TempDir()
	root := filepath.Join(parent, "raw")
	if _, err := (RuntimeGenerator{Genesis: testGenerator()}).Prepare(PrepareOptions{Root: root, Profile: ProfileRaw}); err != nil {
		t.Fatal(err)
	}
	writeSyntheticCommittedState(t, root)
	archive := filepath.Join(parent, "node.tar.gz")
	manifest, _, err := CreateRecoveryArchive(CreateRecoveryOptions{
		Root: root, Profile: ProfileRaw, Node: "validator-0", Output: archive, Binary: testRecoveryBinary(),
	})
	if err != nil {
		t.Fatal(err)
	}
	manifest.Files = append(manifest.Files, RecoveryFile{
		Path: "runtime/validator-1/data/poison.db", Size: 0, Mode: 0o600, SHA256: strings.Repeat("00", 32),
	})
	sortRecoveryFiles(manifest.Files)
	if err := validateRecoveryManifest(manifest); err == nil || !strings.Contains(err.Error(), "invalid recovery file entry") {
		t.Fatalf("out-of-scope manifest file was accepted: %v", err)
	}
}

func TestRecoveryCompatibilityRejectsWrongReplayDomainGenesisAndBinary(t *testing.T) {
	parent := t.TempDir()
	root := filepath.Join(parent, "raw")
	if _, err := (RuntimeGenerator{Genesis: testGenerator()}).Prepare(PrepareOptions{Root: root, Profile: ProfileRaw}); err != nil {
		t.Fatal(err)
	}
	writeSyntheticCommittedState(t, root)
	binary := testRecoveryBinary()
	archive := filepath.Join(parent, "state.tar.gz")
	manifest, _, err := CreateRecoveryArchive(CreateRecoveryOptions{
		Root: root, Profile: ProfileRaw, Output: archive, Binary: binary,
	})
	if err != nil {
		t.Fatal(err)
	}
	tests := []struct {
		name    string
		mutate  func(*RecoveryManifest, *toriumversion.Info)
		message string
	}{
		{
			name: "Cosmos chain ID", message: "chain IDs",
			mutate: func(manifest *RecoveryManifest, _ *toriumversion.Info) {
				manifest.Chain.CosmosChainID = "wrong-localnet"
			},
		},
		{
			name: "EVM chain ID", message: "chain IDs",
			mutate: func(manifest *RecoveryManifest, _ *toriumversion.Info) {
				manifest.Chain.EVMChainID++
			},
		},
		{
			name: "genesis", message: "genesis checksum",
			mutate: func(manifest *RecoveryManifest, _ *toriumversion.Info) {
				manifest.Chain.GenesisSHA256 = strings.Repeat("ab", 32)
			},
		},
		{
			name: "binary", message: "binary or compiled dependency",
			mutate: func(_ *RecoveryManifest, current *toriumversion.Info) {
				current.Commit = "different-source"
			},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			candidate := manifest
			current := binary
			test.mutate(&candidate, &current)
			if err := validateRecoveryCompatibility(candidate, root, ProfileRaw, current); err == nil || !strings.Contains(err.Error(), test.message) {
				t.Fatalf("incompatible recovery was not rejected: %v", err)
			}
		})
	}
}

func TestRecoveryCaptureRejectsGenesisDriftAndSymlinkedOutputInsideRuntime(t *testing.T) {
	parent := t.TempDir()
	root := filepath.Join(parent, "raw")
	if _, err := (RuntimeGenerator{Genesis: testGenerator()}).Prepare(PrepareOptions{Root: root, Profile: ProfileRaw}); err != nil {
		t.Fatal(err)
	}
	writeSyntheticCommittedState(t, root)
	linkedOutput := filepath.Join(parent, "linked-output")
	if err := os.Symlink(filepath.Join(root, "validator-0", "data"), linkedOutput); err != nil {
		t.Fatal(err)
	}
	if _, _, err := CreateRecoveryArchive(CreateRecoveryOptions{
		Root: root, Profile: ProfileRaw, Output: filepath.Join(linkedOutput, "state.tar.gz"), Binary: testRecoveryBinary(),
	}); err == nil || !strings.Contains(err.Error(), "outside the runtime root") {
		t.Fatalf("symlinked output inside runtime was accepted: %v", err)
	}
	if _, err := safeRecoveryInput(root, filepath.Join(root, "validator-1", "data", "state.tar.gz")); err == nil || !strings.Contains(err.Error(), "outside the runtime root") {
		t.Fatalf("recovery input inside runtime was accepted: %v", err)
	}

	genesis := filepath.Join(root, "validator-2", "config", genesisFileName)
	if err := os.WriteFile(genesis, []byte("{}\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, _, err := CreateRecoveryArchive(CreateRecoveryOptions{
		Root: root, Profile: ProfileRaw, Node: "validator-2", Output: filepath.Join(parent, "state.tar.gz"), Binary: testRecoveryBinary(),
	}); err == nil || !strings.Contains(err.Error(), "genesis differs from topology trust anchor") {
		t.Fatalf("genesis drift was captured: %v", err)
	}
}

func testRecoveryBinary() toriumversion.Info {
	return toriumversion.Info{
		Name: "Torium", Binary: "toriumd", Version: "0.1.0-test", Commit: "test", BuildTime: "unknown", UpgradeProfile: "pre", ProtocolVersion: toriumversion.ProtocolVersion, Go: runtime.Version(),
		CosmosEVM:  toriumversion.Component{Module: "github.com/cosmos/evm", Version: toriumversion.CosmosEVMVersion, Commit: toriumversion.CosmosEVMCommit},
		CosmosSDK:  toriumversion.Component{Module: "github.com/cosmos/cosmos-sdk", Version: toriumversion.CosmosSDKVersion},
		CometBFT:   toriumversion.Component{Module: "github.com/cometbft/cometbft", Version: toriumversion.CometBFTVersion},
		GoEthereum: toriumversion.Component{Module: "github.com/ethereum/go-ethereum", Version: "v1.16.8", Replacement: "github.com/cosmos/go-ethereum@v1.17.2-cosmos-0"},
	}
}

func writeSyntheticCommittedState(t *testing.T, root string) {
	t.Helper()
	appHash := bytes.Repeat([]byte{0xA5}, 32)
	validators, _ := cmttypes.RandValidatorSet(4, 10)
	params := cmttypes.DefaultConsensusParams()
	block := &cmttypes.Block{
		Header: cmttypes.Header{
			Version: consensusversion.Consensus{Block: cmtversion.BlockProtocol, App: 1},
			ChainID: "torium-localnet-1", Time: time.Unix(1_700_000_000, 0).UTC(), Height: 1,
			AppHash: appHash, LastCommitHash: bytes.Repeat([]byte{1}, 32),
			DataHash: bytes.Repeat([]byte{2}, 32), ValidatorsHash: validators.Hash(),
			NextValidatorsHash: validators.Hash(), ConsensusHash: params.Hash(),
			LastResultsHash: bytes.Repeat([]byte{3}, 32), EvidenceHash: bytes.Repeat([]byte{4}, 32),
			ProposerAddress: cmtcrypto.CRandBytes(cmtcrypto.AddressSize),
		},
		LastCommit: &cmttypes.Commit{Height: 0},
	}
	parts, err := block.MakePartSet(cmttypes.BlockPartSizeBytes)
	if err != nil {
		t.Fatal(err)
	}
	blockID := cmttypes.BlockID{Hash: block.Hash(), PartSetHeader: parts.Header()}
	state := cmtstate.State{
		Version: cmtstateproto.Version{Consensus: block.Version, Software: cmtversion.TMCoreSemVer},
		ChainID: block.ChainID, InitialHeight: 1, LastBlockHeight: 1, LastBlockID: blockID,
		LastBlockTime: block.Time, LastValidators: validators, Validators: validators,
		NextValidators: validators, LastHeightValidatorsChanged: 1,
		ConsensusParams: *params, LastHeightConsensusParamsChanged: 1,
		LastResultsHash: bytes.Repeat([]byte{3}, 32), AppHash: appHash,
	}
	for index := 0; index < 4; index++ {
		dataDirectory := filepath.Join(root, "validator-"+string(rune('0'+index)), "data")
		blockDB, err := dbm.NewDB("blockstore", dbm.GoLevelDBBackend, dataDirectory)
		if err != nil {
			t.Fatal(err)
		}
		cmtstore.NewBlockStore(blockDB).SaveBlock(block, parts, &cmttypes.Commit{Height: 1})
		if err := blockDB.Close(); err != nil {
			t.Fatal(err)
		}
		stateDB, err := dbm.NewDB("state", dbm.GoLevelDBBackend, dataDirectory)
		if err != nil {
			t.Fatal(err)
		}
		stateStore := cmtstate.NewStore(stateDB, cmtstate.StoreOptions{})
		if err := stateStore.Save(state); err != nil {
			t.Fatal(err)
		}
		if err := stateStore.Close(); err != nil {
			t.Fatal(err)
		}
	}
}

func recoveryTreeSnapshot(root string) (map[string]string, error) {
	snapshot := make(map[string]string)
	err := filepath.WalkDir(root, func(path string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		relative, err := filepath.Rel(root, path)
		if err != nil {
			return err
		}
		metadata, err := os.Lstat(path)
		if err != nil {
			return err
		}
		if metadata.IsDir() {
			snapshot[relative] = "directory:" + metadata.Mode().String()
			return nil
		}
		contents, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		snapshot[relative] = "file:" + metadata.Mode().String() + ":" + string(contents)
		return nil
	})
	return snapshot, err
}

func recoveryTreeSnapshotsEqual(left, right map[string]string) bool {
	if len(left) != len(right) {
		return false
	}
	for path, value := range left {
		if right[path] != value {
			return false
		}
	}
	return true
}
