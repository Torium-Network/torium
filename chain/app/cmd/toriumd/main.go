package main

import (
	"fmt"
	"os"

	svrcmd "github.com/cosmos/cosmos-sdk/server/cmd"
	sdk "github.com/cosmos/cosmos-sdk/types"
	sdkversion "github.com/cosmos/cosmos-sdk/version"
	"github.com/torium-network/torium-chain/cmd/toriumd/cmd"
	"github.com/torium-network/torium-chain/config"
	toriumversion "github.com/torium-network/torium-chain/internal/version"
)

func main() {
	setupSDKConfig()
	setupVersion()

	rootCmd := cmd.NewRootCmd()
	if err := svrcmd.Execute(rootCmd, "toriumd", config.MustGetDefaultNodeHome()); err != nil {
		_, _ = fmt.Fprintln(rootCmd.OutOrStderr(), err)
		os.Exit(1)
	}
}

func setupVersion() {
	sdkversion.Name = "Torium"
	sdkversion.AppName = config.ApplicationName
	sdkversion.Version = toriumversion.Version
	sdkversion.Commit = toriumversion.Commit
}

func setupSDKConfig() {
	cfg := sdk.GetConfig()
	config.SetBech32Prefixes(cfg)
	config.SetBip44CoinType(cfg)
	cfg.Seal()
}
