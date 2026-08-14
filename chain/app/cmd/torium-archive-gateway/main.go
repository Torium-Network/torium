// Command torium-archive-gateway is the private archive RPC gateway for issue
// #114. It is the only process joined to both the archive-raw-rpc network (its
// upstream) and the archive-indexer-consumer network (its consumers), and it
// enforces the reviewed candidateMethodContract allowlist in both directions.
//
// Nothing about this process is public: it binds all interfaces only inside the
// isolated local Compose networks, and only when --allow-container-bind says
// so.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/torium-network/torium-chain/archivegateway"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintf(os.Stderr, "Torium archive gateway: %v\n", err)
		os.Exit(1)
	}
}

func run() error {
	httpListen := flag.String("http-listen-address", archivegateway.DefaultHTTPListenAddress, "JSON-RPC listen address for consumers")
	webSocketListen := flag.String("websocket-listen-address", archivegateway.DefaultWebSocketListenAddress, "JSON-RPC WebSocket listen address for consumers")
	httpUpstream := flag.String("http-upstream", archivegateway.DefaultHTTPUpstream, "raw archive JSON-RPC upstream")
	webSocketUpstream := flag.String("websocket-upstream", archivegateway.DefaultWebSocketUpstream, "raw archive JSON-RPC WebSocket upstream")
	allowContainerBind := flag.Bool("allow-container-bind", false, "allow 0.0.0.0 only inside the isolated local Compose networks")
	flag.Parse()

	if err := archivegateway.ValidateContainerBind(*httpListen, *allowContainerBind); err != nil {
		return err
	}
	if err := archivegateway.ValidateContainerBind(*webSocketListen, *allowContainerBind); err != nil {
		return err
	}

	policy := archivegateway.DefaultPolicy()
	logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo}))
	httpHandler, err := archivegateway.NewServer(policy, *httpUpstream, logger)
	if err != nil {
		return err
	}
	webSocketHandler, err := archivegateway.NewWebSocketServer(policy, *webSocketUpstream, logger)
	if err != nil {
		return err
	}
	// The observability contract names ONE target for the gateway, so its
	// single /metrics endpoint must cover both transports.
	httpHandler.AttachStream(webSocketHandler)

	httpServer := &http.Server{
		Addr:              *httpListen,
		Handler:           httpHandler,
		ReadHeaderTimeout: policy.ReadWriteTimeout,
		ReadTimeout:       policy.ReadWriteTimeout,
		WriteTimeout:      policy.ReadWriteTimeout,
		IdleTimeout:       policy.IdleTimeout,
	}
	// The stream listener deliberately has no read/write deadline: a
	// subscription is long-lived by definition.
	webSocketServer := &http.Server{
		Addr:              *webSocketListen,
		Handler:           webSocketHandler,
		ReadHeaderTimeout: policy.ReadWriteTimeout,
		IdleTimeout:       policy.IdleTimeout,
	}

	logger.Info(
		"archive gateway starting",
		"warning", archivegateway.Warning,
		"httpListen", *httpListen,
		"webSocketListen", *webSocketListen,
		"httpUpstream", *httpUpstream,
		"webSocketUpstream", *webSocketUpstream,
		"enforcedMethods", len(policy.AllowedMethods),
		"enforcedSubscriptions", policy.WebSocketSubscriptions,
	)

	signalContext, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	failures := make(chan error, 2)
	go func() { failures <- listen(httpServer) }()
	go func() { failures <- listen(webSocketServer) }()

	var runError error
	select {
	case <-signalContext.Done():
	case runError = <-failures:
	}
	shutdownContext, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_ = httpServer.Shutdown(shutdownContext)
	_ = webSocketServer.Shutdown(shutdownContext)
	return runError
}

func listen(server *http.Server) error {
	if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		return fmt.Errorf("archive gateway listener %s: %w", server.Addr, err)
	}
	return nil
}
