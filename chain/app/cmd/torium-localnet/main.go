package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"os"

	sdk "github.com/cosmos/cosmos-sdk/types"
	evmencoding "github.com/cosmos/evm/encoding"
	torium "github.com/torium-network/torium-chain"
	toriumconfig "github.com/torium-network/torium-chain/config"
	"github.com/torium-network/torium-chain/localnet"
)

func main() {
	root := flag.String("root", "../localnet/.state/container", "ignored output root containing four validator homes")
	profileValue := flag.String("profile", string(localnet.ProfileContainer), "network profile: container or raw")
	reset := flag.Bool("reset", false, "replace all local chain data and signer state")
	resetNode := flag.String("reset-node", "", "replace exactly one stopped validator home with its height-zero fixture")
	printTopology := flag.Bool("print-topology", false, "print the public topology JSON after preparation")
	archive := flag.Bool("archive", false, "prepare or verify the private archive indexer alongside a prepared validator runtime")
	resetArchive := flag.Bool("reset-archive", false, "replace the stopped private archive indexer home with its height-zero fixture")
	flag.Parse()

	profile, err := localnet.ParseRuntimeProfile(*profileValue)
	if err != nil {
		fatal(err)
	}
	configureSDK()
	encoding := evmencoding.MakeConfig(toriumconfig.LocalEVMChainID)
	modules := torium.NewBasicModuleManager()
	modules.RegisterLegacyAminoCodec(encoding.Amino)
	modules.RegisterInterfaces(encoding.InterfaceRegistry)
	generator := localnet.RuntimeGenerator{Genesis: localnet.Generator{
		Codec:        encoding.Codec,
		TxConfig:     encoding.TxConfig,
		BasicModules: modules,
	}}
	if *reset && *resetNode != "" {
		fatal(fmt.Errorf("--reset and --reset-node are mutually exclusive"))
	}
	// The archive lane is additive: it never creates or resets the validator
	// runtime, so combining it with a validator reset would be ambiguous.
	if (*archive || *resetArchive) && (*reset || *resetNode != "") {
		fatal(fmt.Errorf("--archive/--reset-archive operate on a prepared runtime and cannot be combined with --reset or --reset-node"))
	}
	if *archive || *resetArchive {
		archiveTopology, archiveErr := generator.PrepareArchive(*root, profile, *resetArchive)
		if archiveErr != nil {
			fatal(archiveErr)
		}
		if *printTopology {
			contents, marshalErr := json.MarshalIndent(archiveTopology, "", "  ")
			if marshalErr != nil {
				fatal(marshalErr)
			}
			_, _ = fmt.Fprintf(os.Stdout, "%s\n", contents)
			return
		}
		_, _ = fmt.Fprintf(
			os.Stdout,
			"prepared the valueless %s archive node (%s, pruning %s) in %s\n",
			archiveTopology.Role,
			archiveTopology.Profile,
			archiveTopology.PruningStrategy,
			*root,
		)
		return
	}
	if *resetNode != "" {
		topology, resetErr := generator.ResetNode(*root, profile, *resetNode)
		if resetErr != nil {
			fatal(resetErr)
		}
		_, _ = fmt.Fprintf(os.Stdout, "reset %s to its valueless height-zero fixture (%s) in %s\n", *resetNode, topology.Profile, *root)
		return
	}
	topology, err := generator.Prepare(localnet.PrepareOptions{
		Root:    *root,
		Profile: profile,
		Reset:   *reset,
	})
	if err != nil {
		fatal(err)
	}
	if *printTopology {
		contents, marshalErr := json.MarshalIndent(topology, "", "  ")
		if marshalErr != nil {
			fatal(marshalErr)
		}
		_, _ = fmt.Fprintf(os.Stdout, "%s\n", contents)
		return
	}
	_, _ = fmt.Fprintf(
		os.Stdout,
		"prepared %d valueless Torium validators (%s) in %s; client node: %s\n",
		topology.ValidatorCount,
		topology.Profile,
		*root,
		topology.ClientNode,
	)
}

func configureSDK() {
	config := sdk.GetConfig()
	toriumconfig.SetBech32Prefixes(config)
	toriumconfig.SetBip44CoinType(config)
	config.Seal()
}

func fatal(err error) {
	_, _ = fmt.Fprintln(os.Stderr, err)
	os.Exit(1)
}
