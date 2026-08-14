package main

import (
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
	outputDirectory := flag.String("output-dir", "../genesis/localnet", "directory for canonical public genesis artifacts")
	check := flag.Bool("check", false, "verify checked-in artifacts without writing")
	flag.Parse()

	configureSDK()
	encoding := evmencoding.MakeConfig(toriumconfig.LocalEVMChainID)
	modules := torium.NewBasicModuleManager()
	modules.RegisterLegacyAminoCodec(encoding.Amino)
	modules.RegisterInterfaces(encoding.InterfaceRegistry)
	generator := localnet.Generator{
		Codec:        encoding.Codec,
		TxConfig:     encoding.TxConfig,
		BasicModules: modules,
	}
	artifact, err := generator.Generate()
	if err != nil {
		fatal(err)
	}
	if *check {
		err = artifact.Verify(*outputDirectory)
	} else {
		err = artifact.Write(*outputDirectory)
	}
	if err != nil {
		fatal(err)
	}
	action := "generated"
	if *check {
		action = "verified"
	}
	_, _ = fmt.Fprintf(os.Stdout, "%s valueless Torium localnet genesis in %s\n", action, *outputDirectory)
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
