package main

import "testing"

func TestValidateLocalExposure(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name           string
		listenAddress  string
		rpcURL         string
		allowContainer bool
		wantError      bool
	}{
		{name: "loopback IPv4", listenAddress: "127.0.0.1:8080", rpcURL: "http://127.0.0.1:8545"},
		{name: "loopback IPv6", listenAddress: "[::1]:8080", rpcURL: "http://[::1]:8545"},
		{name: "compose internal", listenAddress: "0.0.0.0:8080", rpcURL: "http://validator-0:8545", allowContainer: true},
		{name: "wildcard host forbidden", listenAddress: "0.0.0.0:8080", rpcURL: "http://127.0.0.1:8545", wantError: true},
		{name: "external host forbidden", listenAddress: "192.0.2.10:8080", rpcURL: "http://127.0.0.1:8545", wantError: true},
		{name: "external RPC forbidden", listenAddress: "127.0.0.1:8080", rpcURL: "https://rpc.example:8545", wantError: true},
		{name: "RPC credentials forbidden", listenAddress: "127.0.0.1:8080", rpcURL: "http://user:password@127.0.0.1:8545", wantError: true},
		{name: "RPC custom path forbidden", listenAddress: "127.0.0.1:8080", rpcURL: "http://127.0.0.1:8545/custom", wantError: true},
		{name: "wrong port forbidden", listenAddress: "127.0.0.1:8081", rpcURL: "http://127.0.0.1:8545", wantError: true},
		{name: "compose DNS outside mode forbidden", listenAddress: "127.0.0.1:8080", rpcURL: "http://validator-0:8545", wantError: true},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			err := validateLocalExposure(test.listenAddress, test.rpcURL, test.allowContainer)
			if test.wantError && err == nil {
				t.Fatal("expected exposure validation error")
			}
			if !test.wantError && err != nil {
				t.Fatalf("unexpected exposure validation error: %v", err)
			}
		})
	}
}
