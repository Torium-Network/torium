// Package archivegateway implements the private archive RPC gateway for issue
// #114. The archive node's own JSON-RPC surface has no native per-method
// allowlist (`nativePerMethodAllowlistSupported: false`), so the reviewed
// contract sets `enforcementLayer: "required-policy-gateway"`: the allowlist is
// enforced here, in a sidecar that is the only member of both the raw upstream
// network and the consumer network.
//
// The matching machine-readable contract lives at
// chain/profiles/node-roles-v0.json under
// runtimePolicies["evm-archive-blockscout-candidate-v0"], and
// consumerGateways["archive-indexer-v0"] names this process as the enforcement
// point. policy_test.go asserts the in-process contract equals the reviewed
// JSON, so the two cannot silently fork.
package archivegateway

import (
	"fmt"
	"slices"
	"strings"
	"time"
)

const (
	// Warning marks every gateway response stream as valueless local material.
	Warning = "VALUELESS LOCAL DEVELOPMENT ONLY — the Torium archive gateway fronts a local archive node and is never a public endpoint."

	// DefaultHTTPListenAddress and DefaultWebSocketListenAddress mirror the
	// gateway listener contract's containerBind values.
	DefaultHTTPListenAddress      = "0.0.0.0:8545"
	DefaultWebSocketListenAddress = "0.0.0.0:8546"

	// DefaultHTTPUpstream and DefaultWebSocketUpstream mirror the contract's
	// listener upstreams. The raw archive RPC is reachable only from this
	// process, over the archive-raw-rpc network.
	DefaultHTTPUpstream      = "http://private-archive-indexer:8545"
	DefaultWebSocketUpstream = "ws://private-archive-indexer:8546"

	// PolicyVersion, RuntimePolicyID and EnforcedContractField identify WHICH
	// reviewed contract this process enforces. They are published as a
	// Prometheus info metric so a scrape records the policy in force rather
	// than only its effects; policy_test.go ties them to the reviewed JSON.
	PolicyVersion         = "evm-archive-blockscout-candidate-v0/candidateMethodContract"
	RuntimePolicyID       = "evm-archive-blockscout-candidate-v0"
	EnforcedContractField = "candidateMethodContract"

	// SubscribeMethod and UnsubscribeMethod are the WebSocket transport
	// control pair. They are deliberately absent from the HTTP allowlist:
	// the contract's `webSocket.subscriptions` list only has meaning on a
	// stream transport, and a subscription cannot be established over
	// request/response HTTP.
	SubscribeMethod   = "eth_subscribe"
	UnsubscribeMethod = "eth_unsubscribe"
)

// Policy is the in-process enforcement contract. Every field is derived from
// the reviewed archive runtime policy; nothing here may be widened without
// changing that contract first.
type Policy struct {
	// AllowedMethods is the exact `candidateMethodContract` list. Anything
	// outside it is refused, including methods the upstream node happens to
	// serve.
	AllowedMethods []string
	// WebSocketSubscriptions is the exact `webSocket.subscriptions` list.
	// eth_subscribe is accepted only for these streams.
	WebSocketSubscriptions []string
	// WebSocketOrigins is the exact `webSocket.allowedOrigins` list.
	WebSocketOrigins []string
	// WildcardOriginAllowed mirrors `webSocket.wildcardOriginAllowed`; a true
	// value is rejected by Validate because the gateway has no legitimate
	// wildcard mode.
	WildcardOriginAllowed bool

	MaximumBodyBytes       int64
	MaximumBatchRequests   int
	MaximumResponseBytes   int64
	MaximumOpenConnections int
	ReadWriteTimeout       time.Duration
	IdleTimeout            time.Duration
}

// DefaultPolicy returns an independent copy of the reviewed archive gateway
// policy.
func DefaultPolicy() Policy {
	return Policy{
		AllowedMethods: []string{
			"web3_clientVersion",
			"net_version",
			"net_listening",
			"net_peerCount",
			"eth_chainId",
			"eth_blockNumber",
			"eth_syncing",
			"eth_gasPrice",
			"eth_getBalance",
			"eth_getBlockByNumber",
			"eth_getBlockByHash",
			"eth_getTransactionByHash",
			"eth_getTransactionReceipt",
			"eth_getLogs",
			"eth_call",
			"eth_getCode",
			"eth_getStorageAt",
			"eth_estimateGas",
			"eth_feeHistory",
			"eth_getTransactionCount",
		},
		WebSocketSubscriptions: []string{"newHeads", "logs"},
		WebSocketOrigins:       []string{"127.0.0.1", "localhost"},
		WildcardOriginAllowed:  false,
		MaximumBodyBytes:       5 * 1024 * 1024,
		MaximumBatchRequests:   100,
		MaximumResponseBytes:   25_000_000,
		MaximumOpenConnections: 256,
		ReadWriteTimeout:       30 * time.Second,
		IdleTimeout:            120 * time.Second,
	}
}

// Validate rejects an incomplete or self-contradictory policy. A gateway that
// cannot state its own allowlist must not start.
func (policy Policy) Validate() error {
	if len(policy.AllowedMethods) == 0 {
		return fmt.Errorf("archive gateway allowlist must not be empty")
	}
	seen := make(map[string]struct{}, len(policy.AllowedMethods))
	for _, method := range policy.AllowedMethods {
		if strings.TrimSpace(method) == "" {
			return fmt.Errorf("archive gateway allowlist contains a blank method")
		}
		if _, duplicate := seen[method]; duplicate {
			return fmt.Errorf("archive gateway allowlist repeats %q", method)
		}
		seen[method] = struct{}{}
		// A read-only archive consumer never submits transactions and never
		// reaches into an operator namespace. These prefixes are refused
		// structurally so a future contract edit cannot smuggle them in.
		for _, forbidden := range []string{"eth_send", "debug_", "admin_", "personal_", "miner_", "txpool_", "les_", "clique_"} {
			if strings.HasPrefix(method, forbidden) {
				return fmt.Errorf("archive gateway allowlist must not contain %q", method)
			}
		}
	}
	if slices.Contains(policy.AllowedMethods, SubscribeMethod) ||
		slices.Contains(policy.AllowedMethods, UnsubscribeMethod) {
		return fmt.Errorf("subscription control belongs to the WebSocket transport, not the method allowlist")
	}
	if len(policy.WebSocketSubscriptions) == 0 {
		return fmt.Errorf("archive gateway WebSocket subscription allowlist must not be empty")
	}
	subscriptions := make(map[string]struct{}, len(policy.WebSocketSubscriptions))
	for _, subscription := range policy.WebSocketSubscriptions {
		if strings.TrimSpace(subscription) == "" {
			return fmt.Errorf("archive gateway subscription allowlist contains a blank stream")
		}
		if _, duplicate := subscriptions[subscription]; duplicate {
			return fmt.Errorf("archive gateway subscription allowlist repeats %q", subscription)
		}
		subscriptions[subscription] = struct{}{}
	}
	if len(policy.WebSocketOrigins) == 0 {
		return fmt.Errorf("archive gateway WebSocket origin allowlist must not be empty")
	}
	if policy.WildcardOriginAllowed {
		return fmt.Errorf("archive gateway must not allow a wildcard WebSocket origin")
	}
	for _, origin := range policy.WebSocketOrigins {
		if origin == "*" {
			return fmt.Errorf("archive gateway WebSocket origin allowlist must not contain a wildcard")
		}
	}
	if policy.MaximumBodyBytes <= 0 || policy.MaximumResponseBytes <= 0 {
		return fmt.Errorf("archive gateway body and response limits must be positive")
	}
	if policy.MaximumBatchRequests <= 0 || policy.MaximumOpenConnections <= 0 {
		return fmt.Errorf("archive gateway batch and connection limits must be positive")
	}
	if policy.ReadWriteTimeout <= 0 || policy.IdleTimeout <= 0 {
		return fmt.Errorf("archive gateway timeouts must be positive")
	}
	return nil
}

// AllowsHTTPMethod reports whether a JSON-RPC method may cross the gateway on
// the request/response transport.
func (policy Policy) AllowsHTTPMethod(method string) bool {
	return slices.Contains(policy.AllowedMethods, method)
}

// AllowsSubscription reports whether a stream name may be subscribed to.
func (policy Policy) AllowsSubscription(stream string) bool {
	return slices.Contains(policy.WebSocketSubscriptions, stream)
}

// AllowsOrigin reports whether a WebSocket upgrade origin host is permitted.
// An absent origin (a server-side client such as the explorer indexer) is
// permitted; a present origin must name an allowlisted host exactly.
func (policy Policy) AllowsOrigin(host string) bool {
	if host == "" {
		return true
	}
	return slices.Contains(policy.WebSocketOrigins, host)
}
