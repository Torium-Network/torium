package localnet

import (
	"encoding/hex"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	dbm "github.com/cometbft/cometbft-db"
	cmtstate "github.com/cometbft/cometbft/state"
	cmtstore "github.com/cometbft/cometbft/store"
)

type inspectedRecoveryNode struct {
	RecoveryNode
	anchorBlockHash string
	anchorAppHash   string
}

// InspectRuntimeState reads committed consensus and application anchors from a
// stopped localnet runtime without editing database files. Passing an empty
// node inspects all four validators and requires them to agree at their common
// height.
func InspectRuntimeState(root, node string) ([]RecoveryNode, RecoveryChain, error) {
	root, err := safeRuntimeRoot(root)
	if err != nil {
		return nil, RecoveryChain{}, err
	}
	names, err := recoveryNodeNames(node)
	if err != nil {
		return nil, RecoveryChain{}, err
	}
	return inspectRecoveryNodes(root, names)
}

func inspectRecoveryNodes(root string, names []string) ([]RecoveryNode, RecoveryChain, error) {
	inspected := make([]inspectedRecoveryNode, 0, len(names))
	anchorHeight := int64(0)
	for _, name := range names {
		node, err := inspectRecoveryNode(root, name)
		if err != nil {
			return nil, RecoveryChain{}, err
		}
		if anchorHeight == 0 || node.LatestHeight < anchorHeight {
			anchorHeight = node.LatestHeight
		}
		inspected = append(inspected, inspectedRecoveryNode{RecoveryNode: node})
	}
	if anchorHeight <= 0 {
		return nil, RecoveryChain{}, fmt.Errorf("recovery requires committed localnet state")
	}
	for index := range inspected {
		blockHash, appHash, err := inspectRecoveryAnchor(root, inspected[index].Name, anchorHeight, inspected[index].LatestHeight)
		if err != nil {
			return nil, RecoveryChain{}, err
		}
		inspected[index].anchorBlockHash = blockHash
		inspected[index].anchorAppHash = appHash
	}
	blockHash := inspected[0].anchorBlockHash
	appHash := inspected[0].anchorAppHash
	for _, node := range inspected[1:] {
		if !strings.EqualFold(node.anchorBlockHash, blockHash) || !strings.EqualFold(node.anchorAppHash, appHash) {
			return nil, RecoveryChain{}, fmt.Errorf("validator states disagree at recovery anchor height %d", anchorHeight)
		}
	}
	topology, err := ReadTopology(root)
	if err != nil {
		return nil, RecoveryChain{}, err
	}
	for _, name := range names {
		genesisDigest, err := sha256File(filepath.Join(root, name, "config", genesisFileName))
		if err != nil {
			return nil, RecoveryChain{}, fmt.Errorf("hash %s genesis: %w", name, err)
		}
		if !strings.EqualFold(genesisDigest, topology.GenesisSHA256) {
			return nil, RecoveryChain{}, fmt.Errorf("%s genesis differs from topology trust anchor", name)
		}
	}
	nodes := make([]RecoveryNode, len(inspected))
	for index := range inspected {
		nodes[index] = inspected[index].RecoveryNode
	}
	return nodes, RecoveryChain{
		CosmosChainID: topology.CosmosChainID,
		EVMChainID:    topology.EVMChainID,
		GenesisSHA256: topology.GenesisSHA256,
		Height:        anchorHeight,
		BlockHash:     blockHash,
		AppHash:       appHash,
	}, nil
}

func inspectRecoveryNode(root, name string) (RecoveryNode, error) {
	if !validRecoveryNodeName(name) {
		return RecoveryNode{}, fmt.Errorf("invalid recovery node %q", name)
	}
	dataDirectory := filepath.Join(root, name, "data")
	stateDatabase, cleanup, err := openRecoveryDatabaseCopy(dataDirectory, "state")
	if err != nil {
		return RecoveryNode{}, fmt.Errorf("open %s state database (node must be stopped): %w", name, err)
	}
	defer cleanup()
	stateStore := cmtstate.NewStore(stateDatabase, cmtstate.StoreOptions{})
	state, err := stateStore.Load()
	closeErr := stateStore.Close()
	if err != nil {
		return RecoveryNode{}, fmt.Errorf("load %s consensus state: %w", name, err)
	}
	if closeErr != nil {
		return RecoveryNode{}, fmt.Errorf("close %s state database: %w", name, closeErr)
	}
	if state.LastBlockHeight <= 0 || len(state.AppHash) != 32 || len(state.LastBlockID.Hash) != 32 {
		return RecoveryNode{}, fmt.Errorf("%s has no valid committed state", name)
	}
	topology, err := ReadTopology(root)
	if err != nil {
		return RecoveryNode{}, err
	}
	if state.ChainID != topology.CosmosChainID {
		return RecoveryNode{}, fmt.Errorf("%s state chain ID %q differs from topology %q", name, state.ChainID, topology.CosmosChainID)
	}
	dataBytes, err := directoryRegularFileBytes(filepath.Join(root, name))
	if err != nil {
		return RecoveryNode{}, err
	}
	return RecoveryNode{
		Name:         name,
		LatestHeight: state.LastBlockHeight,
		BlockHash:    strings.ToUpper(hex.EncodeToString(state.LastBlockID.Hash)),
		AppHash:      strings.ToUpper(hex.EncodeToString(state.AppHash)),
		DataBytes:    dataBytes,
	}, nil
}

func inspectRecoveryAnchor(root, name string, height, latestHeight int64) (string, string, error) {
	dataDirectory := filepath.Join(root, name, "data")
	blockDatabase, cleanup, err := openRecoveryDatabaseCopy(dataDirectory, "blockstore")
	if err != nil {
		return "", "", fmt.Errorf("open %s block store: %w", name, err)
	}
	defer cleanup()
	defer func() { _ = blockDatabase.Close() }()
	blockStore := cmtstore.NewBlockStore(blockDatabase)
	blockMeta := blockStore.LoadBlockMeta(height)
	if blockMeta == nil || len(blockMeta.BlockID.Hash) != 32 {
		return "", "", fmt.Errorf("%s lacks block metadata at recovery anchor %d", name, height)
	}
	blockHash := strings.ToUpper(hex.EncodeToString(blockMeta.BlockID.Hash))
	if height == latestHeight {
		node, err := inspectRecoveryNode(root, name)
		if err != nil {
			return "", "", err
		}
		return blockHash, node.AppHash, nil
	}
	nextMeta := blockStore.LoadBlockMeta(height + 1)
	if nextMeta == nil || len(nextMeta.Header.AppHash) != 32 {
		return "", "", fmt.Errorf("%s lacks app-hash evidence after recovery anchor %d", name, height)
	}
	return blockHash, strings.ToUpper(hex.EncodeToString(nextMeta.Header.AppHash)), nil
}

// openRecoveryDatabaseCopy keeps inspection observational. GoLevelDB opens its
// LOCK and log files for writing even when callers only issue reads, so opening
// a runtime database in place can mutate a stopped node and can leave files
// owned by a toolchain container user. Inspect an isolated copy instead.
func openRecoveryDatabaseCopy(dataDirectory, name string) (dbm.DB, func(), error) {
	source := filepath.Join(dataDirectory, name+".db")
	metadata, err := os.Lstat(source)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil, fmt.Errorf("database %s does not exist", source)
		}
		return nil, nil, fmt.Errorf("inspect database %s: %w", source, err)
	}
	if metadata.Mode()&os.ModeSymlink != 0 || !metadata.IsDir() {
		return nil, nil, fmt.Errorf("database path must be a regular directory: %s", source)
	}
	temporaryDirectory, err := os.MkdirTemp("", "torium-recovery-db-")
	if err != nil {
		return nil, nil, fmt.Errorf("create temporary recovery database directory: %w", err)
	}
	cleanup := func() { _ = os.RemoveAll(temporaryDirectory) }
	if err := copyRecoveryDatabase(source, filepath.Join(temporaryDirectory, name+".db")); err != nil {
		cleanup()
		return nil, nil, err
	}
	database, err := dbm.NewDB(name, dbm.GoLevelDBBackend, temporaryDirectory)
	if err != nil {
		cleanup()
		return nil, nil, fmt.Errorf("open temporary %s database copy: %w", name, err)
	}
	return database, cleanup, nil
}

func copyRecoveryDatabase(source, destination string) error {
	return filepath.WalkDir(source, func(path string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		relative, err := filepath.Rel(source, path)
		if err != nil {
			return fmt.Errorf("resolve recovery database path %s: %w", path, err)
		}
		target := filepath.Join(destination, relative)
		metadata, err := os.Lstat(path)
		if err != nil {
			return fmt.Errorf("inspect recovery database path %s: %w", path, err)
		}
		if metadata.Mode()&os.ModeSymlink != 0 {
			return fmt.Errorf("recovery database path must not be a symlink: %s", path)
		}
		if metadata.IsDir() {
			if err := os.MkdirAll(target, 0o700); err != nil {
				return fmt.Errorf("create temporary recovery database directory %s: %w", target, err)
			}
			return nil
		}
		if !metadata.Mode().IsRegular() {
			return fmt.Errorf("recovery database path has unsupported file type: %s", path)
		}
		if err := copyRecoveryDatabaseFile(path, target); err != nil {
			return err
		}
		return nil
	})
}

func copyRecoveryDatabaseFile(source, destination string) error {
	input, err := os.Open(source)
	if err != nil {
		return fmt.Errorf("open recovery database file %s: %w", source, err)
	}
	defer func() { _ = input.Close() }()
	output, err := os.OpenFile(destination, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return fmt.Errorf("create temporary recovery database file %s: %w", destination, err)
	}
	if _, err := io.Copy(output, input); err != nil {
		_ = output.Close()
		return fmt.Errorf("copy recovery database file %s: %w", source, err)
	}
	if err := output.Close(); err != nil {
		return fmt.Errorf("close temporary recovery database file %s: %w", destination, err)
	}
	return nil
}

func directoryRegularFileBytes(root string) (int64, error) {
	var total int64
	err := filepath.WalkDir(root, func(path string, entry os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		if info.Mode()&os.ModeSymlink != 0 {
			return fmt.Errorf("recovery path must not be a symlink: %s", path)
		}
		if info.Mode().IsRegular() {
			total += info.Size()
		} else if !info.IsDir() {
			return fmt.Errorf("recovery path has unsupported file type: %s", path)
		}
		return nil
	})
	if err != nil {
		return 0, fmt.Errorf("inspect recovery files under %s: %w", root, err)
	}
	return total, nil
}
