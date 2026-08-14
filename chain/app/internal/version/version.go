package version

import (
	"fmt"
	"runtime"
	"runtime/debug"
)

const (
	CosmosEVMVersion = "v0.7.0"
	CosmosEVMCommit  = "f4ab9a3e3fbe353468327d5cacda94b33b41ed11"
	CosmosSDKVersion = "v0.54.3"
	CometBFTVersion  = "v0.39.3"
	ProtocolVersion  = "1.0.0-local.5"
)

// Build metadata can be replaced by deterministic release ldflags.
var (
	Version        = "0.1.0-local.1"
	Commit         = "development"
	BuildTime      = "unknown"
	UpgradeProfile = "pre"
)

// Info is the machine-readable version contract emitted by toriumd.
type Info struct {
	Name            string    `json:"name"`
	Binary          string    `json:"binary"`
	Version         string    `json:"version"`
	Commit          string    `json:"commit"`
	BuildTime       string    `json:"buildTime"`
	UpgradeProfile  string    `json:"upgradeProfile"`
	ProtocolVersion string    `json:"protocolVersion"`
	Go              string    `json:"go"`
	CosmosEVM       Component `json:"cosmosEVM"`
	CosmosSDK       Component `json:"cosmosSDK"`
	CometBFT        Component `json:"cometBFT"`
	GoEthereum      Component `json:"goEthereum"`
}

// Component identifies the compiled dependency version and optional replacement.
type Component struct {
	Module      string `json:"module"`
	Version     string `json:"version"`
	Replacement string `json:"replacement,omitempty"`
	Commit      string `json:"commit,omitempty"`
}

// Current returns build metadata from the executable rather than marketing claims.
func Current() (Info, error) {
	build, ok := debug.ReadBuildInfo()
	if !ok {
		return Info{}, fmt.Errorf("go build information is unavailable")
	}
	cosmosEVM, err := dependency(build, "github.com/cosmos/evm")
	if err != nil {
		return Info{}, err
	}
	cosmosSDK, err := dependency(build, "github.com/cosmos/cosmos-sdk")
	if err != nil {
		return Info{}, err
	}
	cometBFT, err := dependency(build, "github.com/cometbft/cometbft")
	if err != nil {
		return Info{}, err
	}
	goEthereum, err := dependency(build, "github.com/ethereum/go-ethereum")
	if err != nil {
		return Info{}, err
	}
	for _, expected := range []struct {
		component Component
		version   string
	}{
		{cosmosEVM, CosmosEVMVersion},
		{cosmosSDK, CosmosSDKVersion},
		{cometBFT, CometBFTVersion},
	} {
		if expected.component.Version != expected.version {
			return Info{}, fmt.Errorf(
				"compiled %s version %s does not match required %s",
				expected.component.Module,
				expected.component.Version,
				expected.version,
			)
		}
	}
	cosmosEVM.Commit = CosmosEVMCommit
	return Info{
		Name:            "Torium",
		Binary:          "toriumd",
		Version:         Version,
		Commit:          Commit,
		BuildTime:       BuildTime,
		UpgradeProfile:  UpgradeProfile,
		ProtocolVersion: ProtocolVersion,
		Go:              runtime.Version(),
		CosmosEVM:       cosmosEVM,
		CosmosSDK:       cosmosSDK,
		CometBFT:        cometBFT,
		GoEthereum:      goEthereum,
	}, nil
}

func dependency(build *debug.BuildInfo, module string) (Component, error) {
	for _, dep := range build.Deps {
		if dep.Path != module {
			continue
		}
		component := Component{Module: dep.Path, Version: dep.Version}
		if dep.Replace != nil {
			component.Replacement = dep.Replace.Path + "@" + dep.Replace.Version
		}
		return component, nil
	}
	return Component{}, fmt.Errorf("required build dependency %s is missing", module)
}
