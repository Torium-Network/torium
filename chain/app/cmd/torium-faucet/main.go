package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"math/big"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/torium-network/torium-chain/config"
	"github.com/torium-network/torium-chain/faucet"
	"github.com/torium-network/torium-chain/localnet"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintf(os.Stderr, "Torium local faucet: %v\n", err)
		os.Exit(1)
	}
}

func run() error {
	listenAddress := flag.String("listen-address", faucet.DefaultListenAddress, "HTTP listen address; loopback only unless --allow-container-bind is set")
	rpcURL := flag.String("rpc-url", faucet.DefaultRPCURL, "Torium local EVM RPC URL")
	allowContainerBind := flag.Bool("allow-container-bind", false, "allow 0.0.0.0 only inside the isolated localnet Compose network")
	flag.Parse()
	if err := validateLocalExposure(*listenAddress, *rpcURL, *allowContainerBind); err != nil {
		return err
	}

	policy := faucet.DefaultPolicy()
	privateKey, signerAddress, err := localnet.DeriveDisposableDevelopmentAccount(faucet.DefaultFixtureAccount)
	if err != nil {
		return err
	}
	startupContext, startupCancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer startupCancel()
	funder, err := faucet.NewEthereumFunder(
		startupContext,
		*rpcURL,
		privateKey,
		signerAddress,
		new(big.Int).SetUint64(config.LocalEVMChainID),
		policy.TransactionTimeout,
	)
	if err != nil {
		return err
	}
	defer funder.Close()

	logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo}))
	handler, err := faucet.NewServer(funder, policy, logger)
	if err != nil {
		return err
	}
	server := &http.Server{
		Addr:              *listenAddress,
		Handler:           handler,
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       10 * time.Second,
		WriteTimeout:      55 * time.Second,
		IdleTimeout:       60 * time.Second,
		MaxHeaderBytes:    8 * 1024,
	}
	listener, err := net.Listen("tcp", server.Addr)
	if err != nil {
		return fmt.Errorf("listen on %s: %w", server.Addr, err)
	}
	logger.Info("Torium valueless local faucet ready", "listenAddress", server.Addr, "rpcURL", *rpcURL, "signerAddress", signerAddress.Hex(), "warning", faucet.Warning, "publicUseAllowed", false)

	shutdownContext, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	serveError := make(chan error, 1)
	go func() {
		serveError <- server.Serve(listener)
	}()
	select {
	case <-shutdownContext.Done():
		graceContext, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		return server.Shutdown(graceContext)
	case err := <-serveError:
		if errors.Is(err, http.ErrServerClosed) {
			return nil
		}
		return err
	}
}

func validateLocalExposure(listenAddress, rpcURL string, allowContainerBind bool) error {
	host, port, err := net.SplitHostPort(listenAddress)
	if err != nil {
		return fmt.Errorf("invalid listen address: %w", err)
	}
	if port != "8080" {
		return fmt.Errorf("local faucet must listen on port 8080")
	}
	if allowContainerBind {
		if host != "0.0.0.0" {
			return fmt.Errorf("container bind must use exactly 0.0.0.0:8080")
		}
	} else if ip := net.ParseIP(host); ip == nil || !ip.IsLoopback() {
		return fmt.Errorf("local faucet listen address must be loopback")
	}
	parsedRPC, err := url.Parse(rpcURL)
	if err != nil || parsedRPC.Scheme != "http" || parsedRPC.Port() != "8545" {
		return fmt.Errorf("local faucet RPC URL must be HTTP on port 8545")
	}
	if parsedRPC.User != nil || parsedRPC.RawQuery != "" || parsedRPC.Fragment != "" || (parsedRPC.Path != "" && parsedRPC.Path != "/") {
		return fmt.Errorf("local faucet RPC URL must not contain credentials, a custom path, query, or fragment")
	}
	if allowContainerBind {
		if parsedRPC.Hostname() != "validator-0" {
			return fmt.Errorf("container faucet RPC host must be validator-0")
		}
	} else if ip := net.ParseIP(parsedRPC.Hostname()); ip == nil || !ip.IsLoopback() {
		return fmt.Errorf("local faucet RPC host must be loopback")
	}
	return nil
}
