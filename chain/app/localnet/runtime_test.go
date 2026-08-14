package localnet

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"

	cmtcfg "github.com/cometbft/cometbft/config"
	"github.com/cometbft/cometbft/p2p"
	"github.com/cometbft/cometbft/privval"
	toriumconfig "github.com/torium-network/torium-chain/config"
)

func TestPrepareRawRuntimeIsDeterministicIsolatedAndRestartSafe(t *testing.T) {
	root := filepath.Join(t.TempDir(), "raw")
	generator := RuntimeGenerator{Genesis: testGenerator()}
	topology, err := generator.Prepare(PrepareOptions{Root: root, Profile: ProfileRaw})
	if err != nil {
		t.Fatal(err)
	}
	if topology.ValidatorCount != 4 || topology.TotalVotingPower != 100 || topology.CommitQuorumPower != 67 {
		t.Fatalf("unexpected topology authority contract: %+v", topology)
	}
	if topology.ClientNode != "validator-0" || !topology.Nodes[0].ClientTraffic {
		t.Fatalf("client traffic is not isolated to validator-0: %+v", topology.Nodes)
	}

	nodeIDs := make(map[string]struct{}, 4)
	consensusKeys := make(map[string]struct{}, 4)
	for index, node := range topology.Nodes {
		expectedPorts := nodePorts(ProfileRaw, index)
		if node.Ports != expectedPorts {
			t.Fatalf("%s ports = %+v, expected %+v", node.Name, node.Ports, expectedPorts)
		}
		if index > 0 && node.ClientTraffic {
			t.Fatalf("%s unexpectedly accepts client traffic", node.Name)
		}
		home := filepath.Join(root, node.Name)
		nodeKey, err := p2p.LoadNodeKey(filepath.Join(home, "config", "node_key.json"))
		if err != nil {
			t.Fatal(err)
		}
		if string(nodeKey.ID()) != node.NodeID {
			t.Fatalf("%s topology node ID differs from key", node.Name)
		}
		nodeIDs[node.NodeID] = struct{}{}
		pv := privval.LoadFilePV(
			filepath.Join(home, "config", "priv_validator_key.json"),
			filepath.Join(home, "data", "priv_validator_state.json"),
		)
		publicKey := string(pv.Key.PubKey.Bytes())
		consensusKeys[publicKey] = struct{}{}
		if got := strings.ToUpper(node.ConsensusAddressHex); got != strings.ToUpper(pv.Key.PubKey.Address().String()) {
			t.Fatalf("%s topology consensus address %s differs from key %s", node.Name, got, pv.Key.PubKey.Address())
		}

		configContents := mustRead(t, filepath.Join(home, "config", "config.toml"))
		for _, required := range []string{
			`laddr = "tcp://127.0.0.1:`,
			`unsafe = false`,
			`addr_book_strict = false`,
			`allow_duplicate_ip = true`,
			`pex = false`,
			`type = "app"`,
			`timeout_propose = "1s"`,
			`timeout_commit = "2s"`,
		} {
			if !strings.Contains(string(configContents), required) {
				t.Fatalf("%s config lacks %q", node.Name, required)
			}
		}
		appContents := string(mustRead(t, filepath.Join(home, "config", "app.toml")))
		if strings.Contains(appContents, "allow-insecure-unlock = true") || strings.Contains(appContents, "enabled-unsafe-cors = true") {
			t.Fatalf("%s app config enables an unsafe local surface", node.Name)
		}
	}
	if len(nodeIDs) != 4 || len(consensusKeys) != 4 {
		t.Fatalf("runtime shares identity material: node IDs=%d consensus keys=%d", len(nodeIDs), len(consensusKeys))
	}

	statePath := filepath.Join(root, "validator-2", "data", "priv_validator_state.json")
	state := []byte("{\"height\":\"7\",\"round\":0,\"step\":0}\n")
	if err := os.WriteFile(statePath, state, 0o600); err != nil {
		t.Fatal(err)
	}
	databaseSentinel := filepath.Join(root, "validator-2", "data", "application.db")
	if err := os.WriteFile(databaseSentinel, []byte("preserve me"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := generator.Prepare(PrepareOptions{Root: root, Profile: ProfileRaw}); err != nil {
		t.Fatal(err)
	}
	if got := mustRead(t, statePath); !bytes.Equal(got, state) {
		t.Fatalf("prepare rewrote signer state: %s", got)
	}
	if got := mustRead(t, databaseSentinel); string(got) != "preserve me" {
		t.Fatal("prepare rewrote application data")
	}

	configPath := filepath.Join(root, "validator-1", "config", "config.toml")
	if err := os.WriteFile(configPath, []byte("drift\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := generator.Prepare(PrepareOptions{Root: root, Profile: ProfileRaw}); err == nil || !strings.Contains(err.Error(), "--reset") {
		t.Fatalf("static drift did not fail closed: %v", err)
	}
	if _, err := generator.Prepare(PrepareOptions{Root: root, Profile: ProfileRaw, Reset: true}); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(databaseSentinel); !os.IsNotExist(err) {
		t.Fatalf("explicit reset preserved old database: %v", err)
	}
}

func TestContainerRuntimeUsesServiceDNSAndInternalPorts(t *testing.T) {
	root := filepath.Join(t.TempDir(), "container")
	topology, err := (RuntimeGenerator{Genesis: testGenerator()}).Prepare(PrepareOptions{
		Root: root, Profile: ProfileContainer,
	})
	if err != nil {
		t.Fatal(err)
	}
	for index, node := range topology.Nodes {
		if node.Ports != nodePorts(ProfileContainer, index) {
			t.Fatalf("container ports should be identical internal ports: %+v", node.Ports)
		}
		if strings.Contains(node.PersistentPeers, "127.0.0.1") || !strings.Contains(node.PersistentPeers, "validator-") {
			t.Fatalf("%s peers do not use service DNS: %s", node.Name, node.PersistentPeers)
		}
		config := string(mustRead(t, filepath.Join(root, node.Name, "config", "config.toml")))
		if !strings.Contains(config, `laddr = "tcp://0.0.0.0:26657"`) || !strings.Contains(config, node.PersistentPeers) {
			t.Fatalf("%s container config lacks internal listeners/peers", node.Name)
		}
	}
	read, err := ReadTopology(root)
	if err != nil || read.GenesisSHA256 != topology.GenesisSHA256 {
		t.Fatalf("read topology = %+v, %v", read, err)
	}
}

func TestResetNodeReplacesOnlyDeclaredValidatorHome(t *testing.T) {
	root := filepath.Join(t.TempDir(), "raw")
	generator := RuntimeGenerator{Genesis: testGenerator()}
	if _, err := generator.Prepare(PrepareOptions{Root: root, Profile: ProfileRaw}); err != nil {
		t.Fatal(err)
	}
	selectedSentinel := filepath.Join(root, "validator-2", "data", "application.db")
	otherSentinel := filepath.Join(root, "validator-1", "data", "preserve.db")
	if err := os.WriteFile(selectedSentinel, []byte("delete"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(otherSentinel, []byte("preserve"), 0o600); err != nil {
		t.Fatal(err)
	}
	outside := filepath.Join(filepath.Dir(root), "outside.txt")
	if err := os.WriteFile(outside, []byte("outside"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := generator.ResetNode(root, ProfileRaw, "validator-2"); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(selectedSentinel); !os.IsNotExist(err) {
		t.Fatalf("selected validator data survived node reset: %v", err)
	}
	if got := mustRead(t, otherSentinel); string(got) != "preserve" {
		t.Fatalf("other validator data changed: %q", got)
	}
	if got := mustRead(t, outside); string(got) != "outside" {
		t.Fatalf("reset escaped runtime root: %q", got)
	}
	if _, err := generator.ResetNode(root, ProfileRaw, "../outside"); err == nil {
		t.Fatal("path-like node selector was accepted")
	}
}

func TestLocalEndpointProfilePinsClientSurfaceAndResourceLimits(t *testing.T) {
	client, err := applicationConfig(ProfileRaw, 0)
	if err != nil {
		t.Fatal(err)
	}
	if !client.API.Enable || !client.GRPC.Enable || !client.JSONRPC.Enable {
		t.Fatal("validator-0 does not expose the local client surface")
	}
	if client.API.Address != "tcp://127.0.0.1:1317" ||
		client.GRPC.Address != "127.0.0.1:9090" ||
		client.JSONRPC.Address != "127.0.0.1:8545" ||
		client.JSONRPC.WsAddress != "127.0.0.1:8546" {
		t.Fatalf("unexpected raw client addresses: REST=%s gRPC=%s HTTP=%s WS=%s", client.API.Address, client.GRPC.Address, client.JSONRPC.Address, client.JSONRPC.WsAddress)
	}
	if !slicesEqual(client.JSONRPC.API, []string{"eth", "net", "web3"}) {
		t.Fatalf("unexpected namespaces: %v", client.JSONRPC.API)
	}
	if client.JSONRPC.BatchRequestLimit != 100 ||
		client.JSONRPC.HTTPBodyLimit != 5*1024*1024 ||
		client.JSONRPC.MaxOpenConnections != 256 {
		t.Fatalf("unexpected JSON-RPC limits: %+v", client.JSONRPC)
	}

	consensusOnly, err := applicationConfig(ProfileRaw, 1)
	if err != nil {
		t.Fatal(err)
	}
	if consensusOnly.API.Enable || consensusOnly.GRPC.Enable || consensusOnly.JSONRPC.Enable {
		t.Fatal("non-client validator exposes REST, gRPC or JSON-RPC")
	}
	if consensusOnly.JSONRPC.Address != "127.0.0.1:8645" || consensusOnly.JSONRPC.WsAddress != "127.0.0.1:8646" {
		t.Fatalf("non-client raw ports are not isolated: %+v", consensusOnly.JSONRPC)
	}
}

func TestLocalEndpointValidationRejectsUnsafeApplicationConfiguration(t *testing.T) {
	tests := []struct {
		name   string
		index  int
		mutate func(*toriumconfig.EVMAppConfig)
	}{
		{
			name: "wildcard WebSocket origin",
			mutate: func(cfg *toriumconfig.EVMAppConfig) {
				cfg.JSONRPC.WSOrigins = []string{"*"}
			},
		},
		{
			name: "debug namespace",
			mutate: func(cfg *toriumconfig.EVMAppConfig) {
				cfg.JSONRPC.API = append(cfg.JSONRPC.API, "debug")
			},
		},
		{
			name: "public raw bind",
			mutate: func(cfg *toriumconfig.EVMAppConfig) {
				cfg.JSONRPC.Address = "0.0.0.0:8545"
			},
		},
		{
			name: "unsafe REST CORS",
			mutate: func(cfg *toriumconfig.EVMAppConfig) {
				cfg.API.EnableUnsafeCORS = true
			},
		},
		{
			name: "unbounded JSON-RPC connections",
			mutate: func(cfg *toriumconfig.EVMAppConfig) {
				cfg.JSONRPC.MaxOpenConnections = 0
			},
		},
		{
			name: "unbounded REST write timeout",
			mutate: func(cfg *toriumconfig.EVMAppConfig) {
				cfg.API.RPCWriteTimeout = 0
			},
		},
		{
			name: "public metrics bind",
			mutate: func(cfg *toriumconfig.EVMAppConfig) {
				cfg.JSONRPC.MetricsAddress = "0.0.0.0:6065"
			},
		},
		{
			name:  "client service on consensus-only validator",
			index: 1,
			mutate: func(cfg *toriumconfig.EVMAppConfig) {
				cfg.JSONRPC.Enable = true
			},
		},
		{
			name: "insecure unlock",
			mutate: func(cfg *toriumconfig.EVMAppConfig) {
				cfg.JSONRPC.AllowInsecureUnlock = true
			},
		},
		{
			name: "tracing",
			mutate: func(cfg *toriumconfig.EVMAppConfig) {
				cfg.EVM.Tracer = "json"
			},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			cfg, err := applicationConfig(ProfileRaw, tt.index)
			if err != nil {
				t.Fatal(err)
			}
			tt.mutate(&cfg)
			if err := validateLocalApplicationEndpoints(ProfileRaw, tt.index, cfg); err == nil {
				t.Fatal("unsafe endpoint configuration was accepted")
			}
		})
	}
}

func TestLocalEndpointValidationRejectsUnsafeCometConfiguration(t *testing.T) {
	tests := []struct {
		name   string
		mutate func(*cmtcfg.Config)
	}{
		{
			name: "unsafe methods",
			mutate: func(cfg *cmtcfg.Config) {
				cfg.RPC.Unsafe = true
			},
		},
		{
			name: "CORS origin",
			mutate: func(cfg *cmtcfg.Config) {
				cfg.RPC.CORSAllowedOrigins = []string{"*"}
			},
		},
		{
			name: "pprof listener",
			mutate: func(cfg *cmtcfg.Config) {
				cfg.RPC.PprofListenAddress = "127.0.0.1:6060"
			},
		},
		{
			name: "public raw bind",
			mutate: func(cfg *cmtcfg.Config) {
				cfg.RPC.ListenAddress = "tcp://0.0.0.0:26657"
			},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			cfg, err := cometConfig(t.TempDir(), "validator-0", ProfileRaw, 0, "")
			if err != nil {
				t.Fatal(err)
			}
			tt.mutate(cfg)
			if err := validateLocalCometEndpoints(ProfileRaw, 0, cfg); err == nil {
				t.Fatal("unsafe CometBFT endpoint configuration was accepted")
			}
		})
	}
}

func TestPrepareRejectsInvalidProfileAndFilesystemRoot(t *testing.T) {
	generator := RuntimeGenerator{Genesis: testGenerator()}
	if _, err := generator.Prepare(PrepareOptions{Root: t.TempDir(), Profile: "unknown"}); err == nil {
		t.Fatal("unknown runtime profile was accepted")
	}
	if _, err := generator.Prepare(PrepareOptions{Root: string(filepath.Separator), Profile: ProfileRaw}); err == nil {
		t.Fatal("filesystem root was accepted as runtime root")
	}
	unrelated := t.TempDir()
	precious := filepath.Join(unrelated, "keep.txt")
	if err := os.WriteFile(precious, []byte("do not delete"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := generator.Prepare(PrepareOptions{Root: unrelated, Profile: ProfileRaw, Reset: true}); err == nil || !strings.Contains(err.Error(), "refusing to reset") {
		t.Fatalf("unrecognized reset target was accepted: %v", err)
	}
	if got := mustRead(t, precious); string(got) != "do not delete" {
		t.Fatal("unrecognized reset target was modified")
	}
	if toriumconfig.LocalValidatorCount != 4 {
		t.Fatal("runtime tests must follow the canonical four-validator authority contract")
	}
}

func mustRead(t *testing.T, path string) []byte {
	t.Helper()
	contents, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return contents
}

func slicesEqual(left, right []string) bool {
	if len(left) != len(right) {
		return false
	}
	for index := range left {
		if left[index] != right[index] {
			return false
		}
	}
	return true
}
