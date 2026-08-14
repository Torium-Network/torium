// Command torium-public-faucet runs the #172 public faucet service against
// one reviewed profile. Public deployment stays fail-closed: the process
// only binds loopback addresses unless --allow-container-bind places it in
// the isolated localnet Compose network.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	ethcrypto "github.com/ethereum/go-ethereum/crypto"

	"github.com/torium-network/torium-chain/publicfaucet"
)

func main() {
	if len(os.Args) > 1 && os.Args[1] == "verify-journal" {
		if err := runVerifyJournal(os.Args[2:]); err != nil {
			fmt.Fprintf(os.Stderr, "torium-public-faucet verify-journal: %v\n", err)
			os.Exit(1)
		}
		return
	}
	if err := run(os.Args[1:]); err != nil {
		fmt.Fprintf(os.Stderr, "torium-public-faucet: %v\n", err)
		os.Exit(1)
	}
}

func runVerifyJournal(args []string) error {
	flags := flag.NewFlagSet("verify-journal", flag.ContinueOnError)
	dataDir := flags.String("data-dir", "", "public faucet data directory")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if *dataDir == "" {
		return fmt.Errorf("--data-dir is required")
	}
	entries, err := publicfaucet.ReadJournal(filepath.Join(*dataDir, "journal.jsonl"))
	if err != nil {
		return err
	}
	counts := map[string]int{}
	for _, entry := range entries {
		counts[entry.Type]++
	}
	fmt.Printf("journal verified: %d entries, hash chain intact\n", len(entries))
	for entryType, count := range counts {
		fmt.Printf("  %s: %d\n", entryType, count)
	}
	return nil
}

func run(args []string) error {
	flags := flag.NewFlagSet("torium-public-faucet", flag.ContinueOnError)
	contractPath := flags.String("contract", "", "path to the reviewed public faucet service contract JSON")
	profileName := flags.String("profile", "", "profile name from the service contract")
	signerKeyFile := flags.String("signer-key-file", "", "file containing the dedicated hot signer key (0x hex)")
	dataDir := flags.String("data-dir", "", "directory for the journal and persistent state")
	listenAddress := flags.String("listen-address", "127.0.0.1:8090", "public API listen address")
	adminListenAddress := flags.String("admin-listen-address", "127.0.0.1:8091", "operator API listen address")
	rpcURL := flags.String("rpc-url", "http://127.0.0.1:8545", "EVM JSON-RPC endpoint")
	allowContainerBind := flags.Bool("allow-container-bind", false, "allow 0.0.0.0 binds inside the isolated localnet Compose network")
	if err := flags.Parse(args); err != nil {
		return err
	}
	for name, value := range map[string]string{
		"--contract":        *contractPath,
		"--profile":         *profileName,
		"--signer-key-file": *signerKeyFile,
		"--data-dir":        *dataDir,
	} {
		if value == "" {
			return fmt.Errorf("%s is required", name)
		}
	}
	if err := validateExposure(*listenAddress, *allowContainerBind); err != nil {
		return fmt.Errorf("public listen address: %w", err)
	}
	if err := validateExposure(*adminListenAddress, *allowContainerBind); err != nil {
		return fmt.Errorf("admin listen address: %w", err)
	}
	if err := validateRPCURL(*rpcURL); err != nil {
		return err
	}

	profile, err := publicfaucet.LoadProfile(*contractPath, *profileName)
	if err != nil {
		return err
	}
	logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo}))

	privateKey, err := publicfaucet.LoadSignerKeyFile(*signerKeyFile)
	if err != nil {
		return err
	}
	signerAddress := ethcrypto.PubkeyToAddress(privateKey.PublicKey)

	journal, entries, err := publicfaucet.OpenJournal(*dataDir)
	if err != nil {
		return err
	}
	defer journal.Close()
	store, err := publicfaucet.NewStore(journal, entries, profile)
	if err != nil {
		return err
	}
	if store.SignerFenced(signerAddress) {
		return fmt.Errorf("signer %s was rotated out and is fenced; it can never sign again", signerAddress)
	}

	var verifier publicfaucet.ChallengeVerifier
	switch profile.ChallengeMode {
	case publicfaucet.ChallengeTurnstile:
		verifier, err = publicfaucet.NewTurnstileVerifier(os.Getenv("TORIUM_FAUCET_TURNSTILE_SECRET"), os.Getenv("TORIUM_FAUCET_TURNSTILE_ENDPOINT"))
	case publicfaucet.ChallengeStaticLocal:
		verifier, err = publicfaucet.NewStaticVerifier(os.Getenv("TORIUM_FAUCET_STATIC_CHALLENGE_TOKEN"))
	default:
		err = fmt.Errorf("unsupported challenge mode %q", profile.ChallengeMode)
	}
	if err != nil {
		return err
	}

	startupContext, startupCancel := context.WithTimeout(context.Background(), 30*time.Second)
	backend, err := publicfaucet.DialBackend(startupContext, *rpcURL)
	startupCancel()
	if err != nil {
		return err
	}
	defer backend.Close()

	signer := publicfaucet.NewSigner(privateKey)
	breakers := publicfaucet.NewBreakers(profile)
	metrics := publicfaucet.NewMetrics()
	worker := publicfaucet.NewWorker(backend, store, breakers, signer, profile, metrics, logger)
	service := publicfaucet.NewService(profile, store, breakers, worker, publicfaucet.NewRateLimiter(profile, nil), verifier, signer, metrics, logger)

	runContext, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if err := worker.Start(runContext); err != nil {
		return fmt.Errorf("reconcile persisted state: %w", err)
	}

	publicServer := &http.Server{
		Addr:              *listenAddress,
		Handler:           service.PublicHandler(),
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       10 * time.Second,
		WriteTimeout:      15 * time.Second,
		IdleTimeout:       60 * time.Second,
		MaxHeaderBytes:    8 * 1024,
	}
	adminServer := &http.Server{
		Addr:              *adminListenAddress,
		Handler:           service.AdminHandler(),
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       10 * time.Second,
		WriteTimeout:      time.Duration(profile.TransactionTimeout) + 10*time.Second,
		IdleTimeout:       60 * time.Second,
		MaxHeaderBytes:    8 * 1024,
	}
	publicListener, err := net.Listen("tcp", publicServer.Addr)
	if err != nil {
		return fmt.Errorf("listen on %s: %w", publicServer.Addr, err)
	}
	adminListener, err := net.Listen("tcp", adminServer.Addr)
	if err != nil {
		return fmt.Errorf("listen on %s: %w", adminServer.Addr, err)
	}
	logger.Info("Torium public faucet ready",
		"profile", profile.Name,
		"network", profile.CosmosChainID,
		"signerAddress", signerAddress.Hex(),
		"listenAddress", publicServer.Addr,
		"adminListenAddress", adminServer.Addr,
		"challengeMode", string(profile.ChallengeMode),
		"publicDeploymentAllowed", false,
		"notice", publicfaucet.Notice,
	)

	serveError := make(chan error, 2)
	go func() { serveError <- publicServer.Serve(publicListener) }()
	go func() { serveError <- adminServer.Serve(adminListener) }()
	select {
	case <-runContext.Done():
		graceContext, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		publicShutdownError := publicServer.Shutdown(graceContext)
		adminShutdownError := adminServer.Shutdown(graceContext)
		return errors.Join(publicShutdownError, adminShutdownError)
	case err := <-serveError:
		if errors.Is(err, http.ErrServerClosed) {
			return nil
		}
		return err
	}
}

func validateExposure(listenAddress string, allowContainerBind bool) error {
	host, _, err := net.SplitHostPort(listenAddress)
	if err != nil {
		return fmt.Errorf("invalid listen address: %w", err)
	}
	if allowContainerBind && host == "0.0.0.0" {
		return nil
	}
	ip := net.ParseIP(host)
	if ip == nil || !ip.IsLoopback() {
		return fmt.Errorf("must be loopback until #127 authorizes public deployment")
	}
	return nil
}

func validateRPCURL(rpcURL string) error {
	parsed, err := url.Parse(rpcURL)
	if err != nil || parsed.Scheme != "http" && parsed.Scheme != "https" {
		return fmt.Errorf("RPC URL must be an http(s) endpoint")
	}
	if parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" {
		return fmt.Errorf("RPC URL must not contain credentials, a query, or a fragment")
	}
	return nil
}
