package main

import (
	"bytes"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"
	"time"

	toriumversion "github.com/torium-network/torium-chain/internal/version"
	"github.com/torium-network/torium-chain/localnet"
)

type createResult struct {
	Archive       string                    `json:"archive"`
	ArchiveSHA256 string                    `json:"archiveSha256"`
	Manifest      localnet.RecoveryManifest `json:"manifest"`
}

type stateResult struct {
	Chain localnet.RecoveryChain  `json:"chain"`
	Nodes []localnet.RecoveryNode `json:"nodes"`
}

const binaryInfoMaxBytes = 1 << 20

func main() {
	if len(os.Args) < 2 {
		usage()
		os.Exit(64)
	}
	var err error
	switch os.Args[1] {
	case "create":
		err = create(os.Args[2:])
	case "inspect":
		err = inspect(os.Args[2:])
	case "restore":
		err = restore(os.Args[2:])
	case "state":
		err = state(os.Args[2:])
	case "help", "-h", "--help":
		usage()
		return
	default:
		err = fmt.Errorf("unknown command %q", os.Args[1])
	}
	if err != nil {
		_, _ = fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func create(arguments []string) error {
	flags := flag.NewFlagSet("create", flag.ContinueOnError)
	flags.SetOutput(os.Stderr)
	root := flags.String("root", "", "stopped localnet runtime root")
	profileValue := flags.String("profile", string(localnet.ProfileContainer), "runtime profile: container or raw")
	node := flags.String("node", "", "optional validator-0 through validator-3")
	fixture := flags.String("fixture", localnet.FixtureCustom, "fixture recipe name")
	output := flags.String("output", "", "output .tar.gz outside the runtime root")
	createdAt := flags.String("created-at", "", "optional RFC3339 time for deterministic tests")
	binaryInfo := flags.String("binary-info", "", "required toriumd version JSON file")
	if err := flags.Parse(arguments); err != nil {
		return err
	}
	if flags.NArg() != 0 {
		return fmt.Errorf("create accepts flags only")
	}
	profile, err := localnet.ParseRuntimeProfile(*profileValue)
	if err != nil {
		return err
	}
	var timestamp time.Time
	if *createdAt != "" {
		timestamp, err = time.Parse(time.RFC3339, *createdAt)
		if err != nil {
			return fmt.Errorf("parse --created-at: %w", err)
		}
	}
	binary, err := readBinaryInfo(*binaryInfo)
	if err != nil {
		return err
	}
	manifest, digest, err := localnet.CreateRecoveryArchive(localnet.CreateRecoveryOptions{
		Root: *root, Profile: profile, Node: *node, Fixture: *fixture, Output: *output, CreatedAt: timestamp,
		Binary: binary,
	})
	if err != nil {
		return err
	}
	return printJSON(createResult{Archive: *output, ArchiveSHA256: digest, Manifest: manifest})
}

func inspect(arguments []string) error {
	flags := flag.NewFlagSet("inspect", flag.ContinueOnError)
	flags.SetOutput(os.Stderr)
	archive := flags.String("archive", "", "recovery .tar.gz")
	if err := flags.Parse(arguments); err != nil {
		return err
	}
	if flags.NArg() != 0 {
		return fmt.Errorf("inspect accepts flags only")
	}
	manifest, digest, err := localnet.InspectRecoveryArchive(*archive)
	if err != nil {
		return err
	}
	return printJSON(createResult{Archive: *archive, ArchiveSHA256: digest, Manifest: manifest})
}

func restore(arguments []string) error {
	flags := flag.NewFlagSet("restore", flag.ContinueOnError)
	flags.SetOutput(os.Stderr)
	root := flags.String("root", "", "stopped localnet runtime root")
	profileValue := flags.String("profile", string(localnet.ProfileContainer), "runtime profile: container or raw")
	archive := flags.String("archive", "", "recovery .tar.gz")
	binaryInfo := flags.String("binary-info", "", "required current toriumd version JSON file")
	if err := flags.Parse(arguments); err != nil {
		return err
	}
	if flags.NArg() != 0 {
		return fmt.Errorf("restore accepts flags only")
	}
	profile, err := localnet.ParseRuntimeProfile(*profileValue)
	if err != nil {
		return err
	}
	binary, err := readBinaryInfo(*binaryInfo)
	if err != nil {
		return err
	}
	manifest, err := localnet.RestoreRecoveryArchive(localnet.RestoreRecoveryOptions{
		Root: *root, Profile: profile, Archive: *archive, CurrentBinary: binary,
	})
	if err != nil {
		return err
	}
	return printJSON(manifest)
}

func state(arguments []string) error {
	flags := flag.NewFlagSet("state", flag.ContinueOnError)
	flags.SetOutput(os.Stderr)
	root := flags.String("root", "", "stopped localnet runtime root")
	node := flags.String("node", "", "optional validator-0 through validator-3")
	if err := flags.Parse(arguments); err != nil {
		return err
	}
	if flags.NArg() != 0 {
		return fmt.Errorf("state accepts flags only")
	}
	nodes, chain, err := localnet.InspectRuntimeState(*root, *node)
	if err != nil {
		return err
	}
	return printJSON(stateResult{Chain: chain, Nodes: nodes})
}

func printJSON(value any) error {
	encoder := json.NewEncoder(os.Stdout)
	encoder.SetIndent("", "  ")
	return encoder.Encode(value)
}

func readBinaryInfo(path string) (toriumversion.Info, error) {
	if path == "" {
		return toriumversion.Info{}, fmt.Errorf("--binary-info is required")
	}
	metadata, err := os.Stat(path)
	if err != nil {
		return toriumversion.Info{}, fmt.Errorf("inspect toriumd binary metadata: %w", err)
	}
	if metadata.Size() > binaryInfoMaxBytes {
		return toriumversion.Info{}, fmt.Errorf("toriumd binary metadata exceeds %d bytes", binaryInfoMaxBytes)
	}
	if !metadata.Mode().IsRegular() {
		return toriumversion.Info{}, fmt.Errorf("toriumd binary metadata must be a regular file")
	}
	file, err := os.Open(path)
	if err != nil {
		return toriumversion.Info{}, fmt.Errorf("open toriumd binary metadata: %w", err)
	}
	defer func() { _ = file.Close() }()
	contents, err := io.ReadAll(io.LimitReader(file, binaryInfoMaxBytes+1))
	if err != nil {
		return toriumversion.Info{}, fmt.Errorf("read toriumd binary metadata: %w", err)
	}
	if len(contents) > binaryInfoMaxBytes {
		return toriumversion.Info{}, fmt.Errorf("toriumd binary metadata exceeds %d bytes", binaryInfoMaxBytes)
	}
	decoder := json.NewDecoder(bytes.NewReader(contents))
	decoder.DisallowUnknownFields()
	var info toriumversion.Info
	if err := decoder.Decode(&info); err != nil {
		return toriumversion.Info{}, fmt.Errorf("decode toriumd binary metadata: %w", err)
	}
	var trailing any
	if err := decoder.Decode(&trailing); err != io.EOF {
		return toriumversion.Info{}, fmt.Errorf("toriumd binary metadata has trailing JSON")
	}
	return info, nil
}

func usage() {
	_, _ = fmt.Fprintln(os.Stderr, `Torium valueless localnet recovery helper

Usage:
  torium-localnet-state create  --root PATH --profile container|raw --output FILE.tar.gz --binary-info toriumd-version.json [--node validator-N] [--fixture NAME]
  torium-localnet-state inspect --archive FILE.tar.gz
  torium-localnet-state restore --root PATH --profile container|raw --archive FILE.tar.gz --binary-info toriumd-version.json
  torium-localnet-state state   --root PATH [--node validator-N]

create, restore, and state require the selected validator processes to be stopped.`)
}
