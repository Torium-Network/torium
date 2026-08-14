package main

import (
	"bytes"
	"crypto/sha1" // #nosec G505 -- Git object identity is defined as SHA-1.
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"math/big"
	"os"
	"path/filepath"
	"runtime/debug"
	"sort"
	"strings"

	"github.com/ethereum/go-ethereum/core/rawdb"
	"github.com/ethereum/go-ethereum/core/vm"
	gethtests "github.com/ethereum/go-ethereum/tests"

	evmtypes "github.com/cosmos/evm/x/vm/types"
	torium "github.com/torium-network/torium-chain"
)

type sourceFile struct {
	SPDX         string `json:"spdx"`
	UpstreamPath string `json:"upstreamPath"`
	LocalPath    string `json:"localPath"`
	GitBlobSHA1  string `json:"gitBlobSha1"`
	SHA256       string `json:"sha256"`
	Bytes        int64  `json:"bytes"`
}

type upstreamSource struct {
	Repository string     `json:"repository"`
	Tag        string     `json:"tag"`
	Commit     string     `json:"commit"`
	License    sourceFile `json:"license"`
}

type engineContract struct {
	ImportPath         string `json:"importPath"`
	ReplacementPath    string `json:"replacementPath"`
	ReplacementVersion string `json:"replacementVersion"`
	CosmosEVMPath      string `json:"cosmosEVMPath"`
	CosmosEVMVersion   string `json:"cosmosEVMVersion"`
	DatabaseScheme     string `json:"databaseScheme"`
	Snapshotter        bool   `json:"snapshotter"`
	ToriumEVMChainID   uint64 `json:"toriumEVMChainId"`
	ToriumNativeDenom  string `json:"toriumNativeDenom"`
	ToriumRequiredFork string `json:"toriumRequiredFork"`
}

type fixture struct {
	ID               string   `json:"id"`
	LocalPath        string   `json:"localPath"`
	UpstreamPath     string   `json:"upstreamPath"`
	GitBlobSHA1      string   `json:"gitBlobSha1"`
	SHA256           string   `json:"sha256"`
	Bytes            int64    `json:"bytes"`
	ExpectedTests    int      `json:"expectedTests"`
	ExpectedSubtests int      `json:"expectedSubtests"`
	Categories       []string `json:"categories"`
}

type manifest struct {
	Schema             string         `json:"$schema"`
	SchemaVersion      int            `json:"schemaVersion"`
	Suite              string         `json:"suite"`
	FixtureBudgetBytes int64          `json:"fixtureBudgetBytes"`
	RequiredForks      []string       `json:"requiredForks"`
	Upstream           upstreamSource `json:"upstream"`
	Engine             engineContract `json:"engine"`
	SkipRegistry       string         `json:"skipRegistry"`
	Fixtures           []fixture      `json:"fixtures"`
}

type skipEntry struct {
	ID            string `json:"id"`
	FixtureID     string `json:"fixtureId"`
	Test          string `json:"test"`
	Fork          string `json:"fork"`
	Index         int    `json:"index"`
	Rationale     string `json:"rationale"`
	Risk          string `json:"risk"`
	Owner         string `json:"owner"`
	Documentation string `json:"documentation"`
}

type skipRegistry struct {
	Schema        string      `json:"$schema"`
	SchemaVersion int         `json:"schemaVersion"`
	Entries       []skipEntry `json:"entries"`
}

type fixtureEnvelope struct {
	Post map[string][]json.RawMessage `json:"post"`
}

type stateCase struct {
	FixtureID string
	TestName  string
	Fork      string
	Index     int
	Test      gethtests.StateTest
}

func (c stateCase) key() string {
	return fmt.Sprintf("%s/%s/%s/%d", c.FixtureID, c.TestName, c.Fork, c.Index)
}

type summary struct {
	SchemaVersion          int            `json:"schemaVersion"`
	Suite                  string         `json:"suite"`
	Mode                   string         `json:"mode"`
	Status                 string         `json:"status"`
	UpstreamCommit         string         `json:"upstreamCommit"`
	Engine                 string         `json:"engine"`
	DatabaseScheme         string         `json:"databaseScheme"`
	ManifestSHA256         string         `json:"manifestSha256"`
	SkipRegistrySHA256     string         `json:"skipRegistrySha256"`
	FixtureCount           int            `json:"fixtureCount"`
	FixtureBytes           int64          `json:"fixtureBytes"`
	TestCount              int            `json:"testCount"`
	SubtestsSelected       int            `json:"subtestsSelected"`
	SubtestsRun            int            `json:"subtestsRun"`
	SubtestsSkipped        int            `json:"subtestsSkipped"`
	SubtestsByFork         map[string]int `json:"subtestsByFork"`
	FixtureCountByCategory map[string]int `json:"fixtureCountByCategory"`
}

func main() {
	root := flag.String("root", ".", "state-conformance suite directory")
	verifyOnly := flag.Bool("verify-only", false, "verify provenance and selection without executing state transitions")
	flag.Parse()

	result, err := run(filepath.Clean(*root), *verifyOnly)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Torium state conformance failed: %v\n", err)
		os.Exit(1)
	}
	encoded, err := json.MarshalIndent(result, "", "  ")
	if err != nil {
		fmt.Fprintf(os.Stderr, "encode state conformance summary: %v\n", err)
		os.Exit(1)
	}
	fmt.Printf("%s\n", encoded)
}

func run(root string, verifyOnly bool) (summary, error) {
	manifestPath := filepath.Join(root, "manifest.json")
	manifestBytes, err := os.ReadFile(manifestPath)
	if err != nil {
		return summary{}, fmt.Errorf("read manifest: %w", err)
	}
	var contract manifest
	if err := decodeStrict(manifestBytes, &contract); err != nil {
		return summary{}, fmt.Errorf("decode manifest: %w", err)
	}
	if err := validateManifest(contract); err != nil {
		return summary{}, err
	}
	if err := verifyToriumEngine(contract.Engine); err != nil {
		return summary{}, err
	}

	if _, err := verifyFile(root, contract.Upstream.License); err != nil {
		return summary{}, fmt.Errorf("license provenance: %w", err)
	}
	skipPath, err := safeJoin(root, contract.SkipRegistry)
	if err != nil {
		return summary{}, fmt.Errorf("skip registry path: %w", err)
	}
	skipBytes, err := os.ReadFile(skipPath)
	if err != nil {
		return summary{}, fmt.Errorf("read skip registry: %w", err)
	}
	var skips skipRegistry
	if err := decodeStrict(skipBytes, &skips); err != nil {
		return summary{}, fmt.Errorf("decode skip registry: %w", err)
	}
	if skips.SchemaVersion != 1 {
		return summary{}, fmt.Errorf("skip registry schemaVersion is %d, want 1", skips.SchemaVersion)
	}

	allCases := make([]stateCase, 0)
	fixtureIDs := make(map[string]struct{}, len(contract.Fixtures))
	seenForks := make(map[string]struct{})
	categoryCounts := make(map[string]int)
	var fixtureBytes int64
	var testCount int
	for _, item := range contract.Fixtures {
		if _, duplicate := fixtureIDs[item.ID]; duplicate {
			return summary{}, fmt.Errorf("duplicate fixture id %q", item.ID)
		}
		fixtureIDs[item.ID] = struct{}{}
		contents, err := verifyFile(root, sourceFile{
			LocalPath: item.LocalPath, GitBlobSHA1: item.GitBlobSHA1,
			SHA256: item.SHA256, Bytes: item.Bytes,
		})
		if err != nil {
			return summary{}, fmt.Errorf("fixture %s provenance: %w", item.ID, err)
		}
		fixtureBytes += int64(len(contents))
		for _, category := range item.Categories {
			categoryCounts[category]++
		}

		var envelope map[string]fixtureEnvelope
		if err := json.Unmarshal(contents, &envelope); err != nil {
			return summary{}, fmt.Errorf("decode fixture envelope %s: %w", item.ID, err)
		}
		if len(envelope) != item.ExpectedTests {
			return summary{}, fmt.Errorf("fixture %s contains %d tests, want %d", item.ID, len(envelope), item.ExpectedTests)
		}
		var stateTests map[string]gethtests.StateTest
		if err := json.Unmarshal(contents, &stateTests); err != nil {
			return summary{}, fmt.Errorf("decode upstream state tests %s: %w", item.ID, err)
		}
		testNames := make([]string, 0, len(stateTests))
		for name := range stateTests {
			testNames = append(testNames, name)
		}
		sort.Strings(testNames)
		fixtureSubtests := 0
		for _, name := range testNames {
			testCount++
			test := stateTests[name]
			subtests := test.Subtests()
			sort.Slice(subtests, func(i, j int) bool {
				if subtests[i].Fork == subtests[j].Fork {
					return subtests[i].Index < subtests[j].Index
				}
				return subtests[i].Fork < subtests[j].Fork
			})
			for _, subtest := range subtests {
				fixtureSubtests++
				seenForks[subtest.Fork] = struct{}{}
				allCases = append(allCases, stateCase{
					FixtureID: item.ID,
					TestName:  name,
					Fork:      subtest.Fork,
					Index:     subtest.Index,
					Test:      test,
				})
			}
		}
		if fixtureSubtests != item.ExpectedSubtests {
			return summary{}, fmt.Errorf("fixture %s contains %d subtests, want %d", item.ID, fixtureSubtests, item.ExpectedSubtests)
		}
	}
	if fixtureBytes > contract.FixtureBudgetBytes {
		return summary{}, fmt.Errorf("fixture subset is %d bytes, exceeds %d-byte budget", fixtureBytes, contract.FixtureBudgetBytes)
	}
	if err := validateForks(contract.RequiredForks, seenForks); err != nil {
		return summary{}, err
	}

	skipByCase, err := validateSkips(skips.Entries, allCases, fixtureIDs)
	if err != nil {
		return summary{}, err
	}
	byFork := make(map[string]int)
	skipped := 0
	runCount := 0
	if !verifyOnly {
		for i := range allCases {
			candidate := &allCases[i]
			if _, skip := skipByCase[candidate.key()]; skip {
				skipped++
				continue
			}
			subtest := gethtests.StateSubtest{Fork: candidate.Fork, Index: candidate.Index}
			if err := candidate.Test.Run(subtest, vm.Config{}, false, rawdb.HashScheme, func(error, *gethtests.StateTestState) {}); err != nil {
				return summary{}, fmt.Errorf("%s: %w", candidate.key(), err)
			}
			runCount++
			byFork[candidate.Fork]++
		}
	} else {
		for _, candidate := range allCases {
			if _, skip := skipByCase[candidate.key()]; skip {
				skipped++
				continue
			}
			byFork[candidate.Fork]++
		}
	}

	mode := "execute"
	if verifyOnly {
		mode = "verify"
	}
	return summary{
		SchemaVersion:          1,
		Suite:                  contract.Suite,
		Mode:                   mode,
		Status:                 "pass",
		UpstreamCommit:         contract.Upstream.Commit,
		Engine:                 contract.Engine.ReplacementPath + "@" + contract.Engine.ReplacementVersion,
		DatabaseScheme:         contract.Engine.DatabaseScheme,
		ManifestSHA256:         sha256Hex(manifestBytes),
		SkipRegistrySHA256:     sha256Hex(skipBytes),
		FixtureCount:           len(contract.Fixtures),
		FixtureBytes:           fixtureBytes,
		TestCount:              testCount,
		SubtestsSelected:       len(allCases),
		SubtestsRun:            runCount,
		SubtestsSkipped:        skipped,
		SubtestsByFork:         byFork,
		FixtureCountByCategory: categoryCounts,
	}, nil
}

func validateManifest(contract manifest) error {
	if contract.SchemaVersion != 1 || contract.Suite != "torium-state-conformance" {
		return fmt.Errorf("unexpected state-conformance manifest identity")
	}
	if contract.FixtureBudgetBytes <= 0 || contract.FixtureBudgetBytes > 250_000 || len(contract.Fixtures) == 0 || len(contract.RequiredForks) == 0 {
		return fmt.Errorf("manifest must define a positive budget, fixtures, and required forks")
	}
	commit, err := hex.DecodeString(contract.Upstream.Commit)
	if err != nil || len(commit) != 20 || contract.Upstream.Repository != "https://github.com/ethereum/tests" || contract.Upstream.Tag == "" {
		return fmt.Errorf("upstream repository and full commit must be pinned")
	}
	if contract.Upstream.License.SPDX != "MIT" || contract.Upstream.License.UpstreamPath != "LICENSE" || contract.Upstream.License.LocalPath == "" {
		return fmt.Errorf("upstream MIT license provenance is incomplete")
	}
	if contract.Engine.DatabaseScheme != rawdb.HashScheme || contract.Engine.Snapshotter {
		return fmt.Errorf("runner supports only the pinned hash/trie, snapshot-free execution mode")
	}
	for _, item := range contract.Fixtures {
		if item.ID == "" || item.UpstreamPath == "" || item.ExpectedTests <= 0 || item.ExpectedSubtests <= 0 || len(item.Categories) == 0 {
			return fmt.Errorf("fixture %q has incomplete selection metadata", item.ID)
		}
	}
	return nil
}

func verifyToriumEngine(engine engineContract) error {
	build, ok := debug.ReadBuildInfo()
	if !ok {
		return errors.New("Go build information is unavailable")
	}
	if err := requireReplacement(build, engine.ImportPath, engine.ReplacementPath, engine.ReplacementVersion); err != nil {
		return err
	}
	if err := requireDependency(build, engine.CosmosEVMPath, engine.CosmosEVMVersion); err != nil {
		return err
	}
	if engine.ToriumEVMChainID != torium.LocalEVMChainID || engine.ToriumNativeDenom != torium.BaseDenom {
		return fmt.Errorf("manifest Torium identity differs from app constants")
	}
	genesis := torium.NewEVMGenesisState()
	if genesis.Params.EvmDenom != engine.ToriumNativeDenom || genesis.Params.ExtendedDenomOptions == nil || genesis.Params.ExtendedDenomOptions.ExtendedDenom != engine.ToriumNativeDenom {
		return fmt.Errorf("Torium EVM genesis does not use native denom %q", engine.ToriumNativeDenom)
	}
	chainConfig := evmtypes.DefaultChainConfig(engine.ToriumEVMChainID).EthereumConfig(nil)
	if chainConfig.ChainID.Uint64() != engine.ToriumEVMChainID {
		return fmt.Errorf("Torium EVM chain ID is %d, want %d", chainConfig.ChainID.Uint64(), engine.ToriumEVMChainID)
	}
	if engine.ToriumRequiredFork != "Prague" || !chainConfig.IsPrague(big.NewInt(1), 1) {
		return fmt.Errorf("Torium default EVM chain config must activate Prague at genesis")
	}
	return nil
}

func requireReplacement(build *debug.BuildInfo, importPath, replacementPath, replacementVersion string) error {
	for _, dependency := range build.Deps {
		if dependency.Path != importPath {
			continue
		}
		if dependency.Replace == nil {
			return fmt.Errorf("%s is not replaced by the Torium-pinned Cosmos execution engine", importPath)
		}
		if dependency.Replace.Path != replacementPath || dependency.Replace.Version != replacementVersion {
			return fmt.Errorf("execution engine is %s@%s, want %s@%s", dependency.Replace.Path, dependency.Replace.Version, replacementPath, replacementVersion)
		}
		return nil
	}
	return fmt.Errorf("execution dependency %s is absent from build information", importPath)
}

func requireDependency(build *debug.BuildInfo, path, version string) error {
	for _, dependency := range build.Deps {
		if dependency.Path == path {
			if dependency.Version != version {
				return fmt.Errorf("dependency %s is %s, want %s", path, dependency.Version, version)
			}
			return nil
		}
	}
	return fmt.Errorf("dependency %s is absent from build information", path)
}

func verifyFile(root string, expected sourceFile) ([]byte, error) {
	path, err := safeJoin(root, expected.LocalPath)
	if err != nil {
		return nil, err
	}
	info, err := os.Lstat(path)
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() {
		return nil, fmt.Errorf("%s is not a regular file", expected.LocalPath)
	}
	contents, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	if int64(len(contents)) != expected.Bytes {
		return nil, fmt.Errorf("%s has %d bytes, want %d", expected.LocalPath, len(contents), expected.Bytes)
	}
	if actual := sha256Hex(contents); actual != expected.SHA256 {
		return nil, fmt.Errorf("%s SHA-256 is %s, want %s", expected.LocalPath, actual, expected.SHA256)
	}
	if actual := gitBlobSHA1(contents); actual != expected.GitBlobSHA1 {
		return nil, fmt.Errorf("%s Git blob is %s, want upstream %s", expected.LocalPath, actual, expected.GitBlobSHA1)
	}
	return contents, nil
}

func validateForks(required []string, seen map[string]struct{}) error {
	requiredSet := make(map[string]struct{}, len(required))
	for _, fork := range required {
		if fork == "" {
			return errors.New("required fork cannot be empty")
		}
		requiredSet[fork] = struct{}{}
		if _, ok := seen[fork]; !ok {
			return fmt.Errorf("required fork %s is absent from selected fixtures", fork)
		}
	}
	for fork := range seen {
		if _, ok := requiredSet[fork]; !ok {
			return fmt.Errorf("fixture fork %s is neither required nor explicitly excluded", fork)
		}
	}
	return nil
}

func validateSkips(entries []skipEntry, cases []stateCase, fixtureIDs map[string]struct{}) (map[string]skipEntry, error) {
	available := make(map[string]struct{}, len(cases))
	for _, candidate := range cases {
		available[candidate.key()] = struct{}{}
	}
	result := make(map[string]skipEntry, len(entries))
	ids := make(map[string]struct{}, len(entries))
	for _, entry := range entries {
		if entry.ID == "" || entry.FixtureID == "" || entry.Test == "" || entry.Fork == "" || entry.Index < 0 || entry.Rationale == "" || entry.Risk == "" || entry.Owner == "" || entry.Documentation == "" {
			return nil, fmt.Errorf("skip %q must define an exact case, rationale, risk, owner, and documentation", entry.ID)
		}
		if entry.Risk != "low" && entry.Risk != "medium" && entry.Risk != "high" {
			return nil, fmt.Errorf("skip %s has unsupported risk %q", entry.ID, entry.Risk)
		}
		if _, ok := fixtureIDs[entry.FixtureID]; !ok {
			return nil, fmt.Errorf("skip %s names unknown fixture %s", entry.ID, entry.FixtureID)
		}
		if _, duplicate := ids[entry.ID]; duplicate {
			return nil, fmt.Errorf("duplicate skip id %s", entry.ID)
		}
		ids[entry.ID] = struct{}{}
		key := fmt.Sprintf("%s/%s/%s/%d", entry.FixtureID, entry.Test, entry.Fork, entry.Index)
		if _, ok := available[key]; !ok {
			return nil, fmt.Errorf("skip %s is stale: case %s does not exist", entry.ID, key)
		}
		if _, duplicate := result[key]; duplicate {
			return nil, fmt.Errorf("multiple skips target %s", key)
		}
		result[key] = entry
	}
	return result, nil
}

func decodeStrict(contents []byte, target any) error {
	decoder := json.NewDecoder(bytes.NewReader(contents))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return err
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		if err == nil {
			return errors.New("unexpected trailing JSON value")
		}
		return fmt.Errorf("decode trailing JSON: %w", err)
	}
	return nil
}

func safeJoin(root, relative string) (string, error) {
	clean := filepath.Clean(relative)
	if relative == "" || filepath.IsAbs(relative) || clean == ".." || strings.HasPrefix(clean, ".."+string(filepath.Separator)) {
		return "", fmt.Errorf("unsafe relative path %q", relative)
	}
	return filepath.Join(root, clean), nil
}

func sha256Hex(contents []byte) string {
	digest := sha256.Sum256(contents)
	return hex.EncodeToString(digest[:])
}

func gitBlobSHA1(contents []byte) string {
	hasher := sha1.New() // #nosec G401 -- Git blob provenance requires SHA-1.
	fmt.Fprintf(hasher, "blob %d%c", len(contents), byte(0))
	_, _ = hasher.Write(contents)
	return hex.EncodeToString(hasher.Sum(nil))
}
