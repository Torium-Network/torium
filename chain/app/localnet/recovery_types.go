package localnet

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"time"

	toriumversion "github.com/torium-network/torium-chain/internal/version"
)

const (
	RecoverySchemaVersion = 1
	RecoveryFormat        = "torium-localnet-recovery-v1"
	SnapshotScopeNetwork  = "network"
	SnapshotScopeNode     = "node"
	FixtureCustom         = "custom"
	FixtureEmpty          = "empty"
	FixtureFunded         = "funded"
	FixtureContracts      = "contracts-deployed"
	FixturePostUpgrade    = "post-upgrade"
	recoveryWarning       = "VALUELESS LOCAL DEVELOPMENT RECOVERY ARTIFACT — contains public deterministic fixture keys and must never be used as a production backup."
)

var recoveryFixtureKinds = map[string]struct{}{
	FixtureCustom:      {},
	FixtureEmpty:       {},
	FixtureFunded:      {},
	FixtureContracts:   {},
	FixturePostUpgrade: {},
}

// RecoveryManifest is the portable trust and integrity envelope shared with
// later operator recovery work. Its local runtime payload is deliberately not
// a production backup and may contain public deterministic fixture keys.
type RecoveryManifest struct {
	SchemaVersion int                `json:"schemaVersion"`
	Format        string             `json:"format"`
	Warning       string             `json:"warning"`
	CreatedAt     string             `json:"createdAt"`
	Scope         string             `json:"scope"`
	Node          string             `json:"node,omitempty"`
	Fixture       string             `json:"fixture"`
	Profile       RuntimeProfile     `json:"profile"`
	Chain         RecoveryChain      `json:"chain"`
	Binary        toriumversion.Info `json:"binary"`
	Nodes         []RecoveryNode     `json:"nodes"`
	Files         []RecoveryFile     `json:"files"`
}

type RecoveryChain struct {
	CosmosChainID string `json:"cosmosChainId"`
	EVMChainID    uint64 `json:"evmChainId"`
	GenesisSHA256 string `json:"genesisSha256"`
	Height        int64  `json:"height"`
	BlockHash     string `json:"blockHash"`
	AppHash       string `json:"appHash"`
}

type RecoveryNode struct {
	Name         string `json:"name"`
	LatestHeight int64  `json:"latestHeight"`
	BlockHash    string `json:"blockHash"`
	AppHash      string `json:"appHash"`
	DataBytes    int64  `json:"dataBytes"`
}

type RecoveryFile struct {
	Path   string `json:"path"`
	Size   int64  `json:"size"`
	Mode   uint32 `json:"mode"`
	SHA256 string `json:"sha256"`
}

type CreateRecoveryOptions struct {
	Root      string
	Profile   RuntimeProfile
	Node      string
	Fixture   string
	Output    string
	CreatedAt time.Time
	Binary    toriumversion.Info
}

type RestoreRecoveryOptions struct {
	Root          string
	Profile       RuntimeProfile
	Archive       string
	CurrentBinary toriumversion.Info
}

func validateRecoveryManifest(manifest RecoveryManifest) error {
	if manifest.SchemaVersion != RecoverySchemaVersion || manifest.Format != RecoveryFormat {
		return fmt.Errorf("unsupported recovery format %q schema %d", manifest.Format, manifest.SchemaVersion)
	}
	if manifest.Warning != recoveryWarning {
		return fmt.Errorf("recovery warning contract differs")
	}
	if _, err := time.Parse(time.RFC3339, manifest.CreatedAt); err != nil {
		return fmt.Errorf("invalid recovery creation time: %w", err)
	}
	if manifest.Profile != ProfileContainer && manifest.Profile != ProfileRaw {
		return fmt.Errorf("invalid recovery profile %q", manifest.Profile)
	}
	if _, ok := recoveryFixtureKinds[manifest.Fixture]; !ok {
		return fmt.Errorf("invalid recovery fixture %q", manifest.Fixture)
	}
	switch manifest.Scope {
	case SnapshotScopeNetwork:
		if manifest.Node != "" || len(manifest.Nodes) != 4 {
			return fmt.Errorf("network recovery must contain exactly four nodes and no node selector")
		}
		for index, node := range manifest.Nodes {
			if node.Name != fmt.Sprintf("validator-%d", index) {
				return fmt.Errorf("network recovery nodes must use canonical validator order")
			}
		}
	case SnapshotScopeNode:
		if !validRecoveryNodeName(manifest.Node) || len(manifest.Nodes) != 1 || manifest.Nodes[0].Name != manifest.Node {
			return fmt.Errorf("node recovery has an invalid node selector")
		}
	default:
		return fmt.Errorf("invalid recovery scope %q", manifest.Scope)
	}
	if strings.TrimSpace(manifest.Chain.CosmosChainID) == "" || manifest.Chain.EVMChainID == 0 || manifest.Chain.Height <= 0 {
		return fmt.Errorf("recovery chain identity and height are required")
	}
	for label, value := range map[string]string{
		"genesis SHA-256": manifest.Chain.GenesisSHA256,
		"block hash":      manifest.Chain.BlockHash,
		"app hash":        manifest.Chain.AppHash,
	} {
		if !validHexDigest(value) {
			return fmt.Errorf("invalid %s", label)
		}
	}
	if err := validateRecoveryBinaryInfo(manifest.Binary); err != nil {
		return err
	}
	nodeNames := make(map[string]struct{}, len(manifest.Nodes))
	for _, node := range manifest.Nodes {
		if !validRecoveryNodeName(node.Name) || node.LatestHeight < manifest.Chain.Height ||
			!validHexDigest(node.BlockHash) || !validHexDigest(node.AppHash) || node.DataBytes < 0 {
			return fmt.Errorf("invalid recovery state for node %q", node.Name)
		}
		if _, exists := nodeNames[node.Name]; exists {
			return fmt.Errorf("recovery repeats node %q", node.Name)
		}
		nodeNames[node.Name] = struct{}{}
	}
	if len(manifest.Files) == 0 {
		return fmt.Errorf("recovery contains no payload files")
	}
	previous := ""
	hasTopology := false
	nodeFiles := make(map[string]bool, len(manifest.Nodes))
	for _, file := range manifest.Files {
		if !validRecoveryPath(file.Path) || !validManifestFileForScope(manifest, file.Path) ||
			file.Size < 0 || file.Mode > 0o777 || !validHexDigest(file.SHA256) {
			return fmt.Errorf("invalid recovery file entry %q", file.Path)
		}
		if previous != "" && file.Path <= previous {
			return fmt.Errorf("recovery file entries must be unique and sorted")
		}
		if file.Path == "runtime/"+topologyFileName {
			hasTopology = true
		}
		for _, node := range manifest.Nodes {
			if strings.HasPrefix(file.Path, "runtime/"+node.Name+"/") {
				nodeFiles[node.Name] = true
			}
		}
		previous = file.Path
	}
	if !hasTopology {
		return fmt.Errorf("recovery is missing the topology contract")
	}
	for _, node := range manifest.Nodes {
		if !nodeFiles[node.Name] {
			return fmt.Errorf("recovery has no payload files for node %q", node.Name)
		}
	}
	return nil
}

func validateRecoveryCompatibility(manifest RecoveryManifest, root string, profile RuntimeProfile, current toriumversion.Info) error {
	if err := validateRecoveryManifest(manifest); err != nil {
		return err
	}
	topology, err := ReadTopology(root)
	if err != nil {
		return fmt.Errorf("validate recovery target: %w", err)
	}
	if profile != topology.Profile || manifest.Profile != topology.Profile {
		return fmt.Errorf("recovery profile %s is incompatible with target profile %s", manifest.Profile, topology.Profile)
	}
	if manifest.Chain.CosmosChainID != topology.CosmosChainID || manifest.Chain.EVMChainID != topology.EVMChainID {
		return fmt.Errorf("recovery chain IDs are incompatible with the target replay domain")
	}
	if !strings.EqualFold(manifest.Chain.GenesisSHA256, topology.GenesisSHA256) {
		return fmt.Errorf("recovery genesis checksum is incompatible with the target")
	}
	if current.Name == "" {
		return fmt.Errorf("current toriumd binary metadata is required")
	}
	if err := validateRecoveryBinaryInfo(current); err != nil {
		return fmt.Errorf("current toriumd binary metadata: %w", err)
	}
	if !recoveryBinaryCompatible(manifest.Binary, current) {
		return fmt.Errorf("recovery binary or compiled dependency versions are incompatible with the current binary")
	}
	return nil
}

func validateRecoveryBinaryInfo(info toriumversion.Info) error {
	if info.Name != "Torium" || info.Binary != "toriumd" ||
		strings.TrimSpace(info.Version) == "" || strings.TrimSpace(info.Commit) == "" || strings.TrimSpace(info.Go) == "" ||
		info.ProtocolVersion != toriumversion.ProtocolVersion ||
		(info.UpgradeProfile != "pre" && info.UpgradeProfile != "post" && info.UpgradeProfile != "failed-rehearsal") ||
		info.CosmosEVM.Module != "github.com/cosmos/evm" || info.CosmosEVM.Version != toriumversion.CosmosEVMVersion ||
		info.CosmosEVM.Commit != toriumversion.CosmosEVMCommit ||
		info.CosmosSDK.Module != "github.com/cosmos/cosmos-sdk" || info.CosmosSDK.Version != toriumversion.CosmosSDKVersion ||
		info.CometBFT.Module != "github.com/cometbft/cometbft" || info.CometBFT.Version != toriumversion.CometBFTVersion ||
		info.GoEthereum.Module != "github.com/ethereum/go-ethereum" || strings.TrimSpace(info.GoEthereum.Version) == "" {
		return fmt.Errorf("recovery binary identity or compiled dependency metadata is incomplete")
	}
	return nil
}

func recoveryBinaryCompatible(snapshot, current toriumversion.Info) bool {
	// Build timestamps and the helper executable name are not state-compatibility
	// inputs. Protocol version, source commit, Go ABI, and compiled dependencies are.
	snapshot.BuildTime = ""
	current.BuildTime = ""
	snapshot.Binary = "toriumd"
	current.Binary = "toriumd"
	return reflect.DeepEqual(snapshot, current)
}

func marshalRecoveryManifest(manifest RecoveryManifest) ([]byte, error) {
	contents, err := json.MarshalIndent(manifest, "", "  ")
	if err != nil {
		return nil, err
	}
	return append(contents, '\n'), nil
}

func recoveryManifestDigest(manifest RecoveryManifest) (string, error) {
	contents, err := marshalRecoveryManifest(manifest)
	if err != nil {
		return "", err
	}
	digest := sha256.Sum256(contents)
	return hex.EncodeToString(digest[:]), nil
}

func validRecoveryNodeName(value string) bool {
	switch value {
	case "validator-0", "validator-1", "validator-2", "validator-3":
		return true
	default:
		return false
	}
}

func recoveryNodeNames(node string) ([]string, error) {
	if node != "" {
		if !validRecoveryNodeName(node) {
			return nil, fmt.Errorf("invalid recovery node %q", node)
		}
		return []string{node}, nil
	}
	return []string{"validator-0", "validator-1", "validator-2", "validator-3"}, nil
}

func validHexDigest(value string) bool {
	decoded, err := hex.DecodeString(value)
	return err == nil && len(decoded) == sha256.Size
}

func validRecoveryPath(value string) bool {
	if value == "" || filepath.IsAbs(value) || strings.Contains(value, "\\") {
		return false
	}
	cleaned := filepath.ToSlash(filepath.Clean(value))
	return cleaned == value && strings.HasPrefix(value, "runtime/") && !strings.Contains(value, "../")
}

func sortRecoveryFiles(files []RecoveryFile) {
	sort.Slice(files, func(i, j int) bool { return files[i].Path < files[j].Path })
}
