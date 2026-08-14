package cmd

import (
	"encoding/json"

	"github.com/spf13/cobra"

	toriumversion "github.com/torium-network/torium-chain/internal/version"
)

func replaceVersionCommand(rootCmd *cobra.Command) {
	for _, child := range rootCmd.Commands() {
		if child.Name() == "version" {
			rootCmd.RemoveCommand(child)
			break
		}
	}
	rootCmd.AddCommand(newVersionCommand())
}

func newVersionCommand() *cobra.Command {
	return &cobra.Command{
		Use:   "version",
		Short: "Print Torium and compiled upstream component versions",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			info, err := toriumversion.Current()
			if err != nil {
				return err
			}
			encoder := json.NewEncoder(cmd.OutOrStdout())
			encoder.SetIndent("", "  ")
			return encoder.Encode(info)
		},
	}
}
