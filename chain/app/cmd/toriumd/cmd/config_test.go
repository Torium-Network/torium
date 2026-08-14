package cmd

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/cosmos/cosmos-sdk/client/flags"
	toriumconfig "github.com/torium-network/torium-chain/config"
)

func TestInitCometConfigMatchesEVMMempool(t *testing.T) {
	cfg := initCometConfig()
	if cfg.Mempool.Type != "app" {
		t.Fatalf("CometBFT mempool type is %q, expected app", cfg.Mempool.Type)
	}
	if cfg.Consensus.TimeoutPropose != toriumconfig.LocalTimeoutPropose ||
		cfg.Consensus.TimeoutProposeDelta != toriumconfig.LocalTimeoutProposeDelta ||
		cfg.Consensus.TimeoutPrevote != toriumconfig.LocalTimeoutPrevote ||
		cfg.Consensus.TimeoutPrevoteDelta != toriumconfig.LocalTimeoutPrevoteDelta ||
		cfg.Consensus.TimeoutPrecommit != toriumconfig.LocalTimeoutPrecommit ||
		cfg.Consensus.TimeoutPrecommitDelta != toriumconfig.LocalTimeoutPrecommitDelta ||
		cfg.Consensus.TimeoutCommit != toriumconfig.LocalTimeoutCommit {
		t.Fatalf("local consensus timeouts differ from the deterministic profile: %+v", cfg.Consensus)
	}
}

func TestGetChainIDFallsBackToGenesis(t *testing.T) {
	home := t.TempDir()
	configDir := filepath.Join(home, "config")
	if err := os.MkdirAll(configDir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(configDir, "genesis.json"), []byte(`{"chain_id":"torium-localnet-1"}`), 0o600); err != nil {
		t.Fatal(err)
	}

	chainID, err := getChainIDFromOpts(mapOptions{flags.FlagHome: home})
	if err != nil {
		t.Fatal(err)
	}
	if chainID != "torium-localnet-1" {
		t.Fatalf("resolved chain ID %q", chainID)
	}
}

func TestGetChainIDRejectsEmptyGenesisIdentity(t *testing.T) {
	home := t.TempDir()
	configDir := filepath.Join(home, "config")
	if err := os.MkdirAll(configDir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(configDir, "genesis.json"), []byte(`{"chain_id":""}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := getChainIDFromOpts(mapOptions{flags.FlagHome: home}); err == nil {
		t.Fatal("empty genesis chain ID was accepted")
	}
}

func TestRootExposesSelectedModuleCLICommands(t *testing.T) {
	root := NewRootCmd()
	for _, path := range [][]string{
		{"tx", "bank", "send"},
		{"tx", "evm", "raw"},
		{"tx", "staking", "create-validator"},
		{"tx", "staking", "delegate"},
		{"tx", "staking", "redelegate"},
		{"tx", "staking", "unbond"},
		{"tx", "distribution", "withdraw-rewards"},
		{"tx", "distribution", "withdraw-validator-commission"},
		{"tx", "slashing", "unjail"},
		{"tx", "gov", "vote"},
		{"query", "bank", "balance"},
		{"query", "staking", "delegations"},
		{"query", "staking", "validators"},
		{"query", "distribution", "rewards"},
		{"query", "distribution", "commission"},
		{"query", "slashing", "signing-infos"},
		{"query", "gov", "proposals"},
	} {
		command, remaining, err := root.Find(path)
		if err != nil {
			t.Fatalf("find %v: %v", path, err)
		}
		if command == nil || command.Name() != path[len(path)-1] || len(remaining) != 0 {
			t.Fatalf("command %v is not registered: command=%v remaining=%v", path, command, remaining)
		}
	}
}

type mapOptions map[string]any

func (options mapOptions) Get(key string) any { return options[key] }
