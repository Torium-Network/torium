package archivegateway

import (
	"encoding/json"
	"os"
	"slices"
	"testing"
	"time"
)

type reviewedNodeRoles struct {
	RuntimePolicies map[string]struct {
		Status                          string   `json:"status"`
		EnforcementLayer                string   `json:"enforcementLayer"`
		NativePerMethodAllowlistSupport bool     `json:"nativePerMethodAllowlistSupported"`
		CandidateMethodContract         []string `json:"candidateMethodContract"`
		Limits                          struct {
			HTTPBodyBytes                    int64 `json:"httpBodyBytes"`
			BatchRequests                    int   `json:"batchRequests"`
			BatchResponseBytes               int64 `json:"batchResponseBytes"`
			MaxOpenConnections               int   `json:"maxOpenConnections"`
			HTTPReadWriteTimeoutMilliseconds int64 `json:"httpReadWriteTimeoutMilliseconds"`
			HTTPIdleTimeoutMilliseconds      int64 `json:"httpIdleTimeoutMilliseconds"`
		} `json:"limits"`
		WebSocket struct {
			AllowedOrigins        []string `json:"allowedOrigins"`
			WildcardOriginAllowed bool     `json:"wildcardOriginAllowed"`
			Subscriptions         []string `json:"subscriptions"`
		} `json:"webSocket"`
	} `json:"runtimePolicies"`
	ConsumerGateways map[string]struct {
		GatewayIdentity       string `json:"gatewayIdentity"`
		RuntimePolicyRef      string `json:"runtimePolicyRef"`
		EnforcedContractField string `json:"enforcedContractField"`
		RawArchiveRole        string `json:"rawArchiveRole"`
		Listeners             struct {
			EVMHTTP struct {
				ContainerBind string `json:"containerBind"`
				Upstream      string `json:"upstream"`
			} `json:"evmHttp"`
			EVMWebSocket struct {
				ContainerBind string `json:"containerBind"`
				Upstream      string `json:"upstream"`
			} `json:"evmWebSocket"`
		} `json:"listeners"`
	} `json:"consumerGateways"`
}

func loadReviewedNodeRoles(t *testing.T) reviewedNodeRoles {
	t.Helper()
	contents, err := os.ReadFile("../../profiles/node-roles-v0.json")
	if err != nil {
		t.Fatalf("read reviewed node-role profile: %v", err)
	}
	var reviewed reviewedNodeRoles
	if err := json.Unmarshal(contents, &reviewed); err != nil {
		t.Fatalf("decode reviewed node-role profile: %v", err)
	}
	return reviewed
}

// The gateway's in-process allowlist must be exactly the reviewed contract's
// candidateMethodContract. A drift in either direction is a contract fork.
func TestDefaultPolicyMatchesReviewedArchiveContract(t *testing.T) {
	t.Parallel()

	reviewed := loadReviewedNodeRoles(t)
	gateway, ok := reviewed.ConsumerGateways["archive-indexer-v0"]
	if !ok {
		t.Fatal("reviewed profile has no archive-indexer-v0 consumer gateway")
	}
	policyContract, ok := reviewed.RuntimePolicies[gateway.RuntimePolicyRef]
	if !ok {
		t.Fatalf("reviewed profile has no runtime policy %q", gateway.RuntimePolicyRef)
	}
	if gateway.EnforcedContractField != "candidateMethodContract" {
		t.Fatalf("enforced contract field changed to %q; this test decodes candidateMethodContract", gateway.EnforcedContractField)
	}
	// The gateway only has a reason to exist while the node cannot enforce the
	// allowlist itself.
	if policyContract.NativePerMethodAllowlistSupport {
		t.Fatal("reviewed policy claims native per-method allowlisting; the sidecar contract no longer applies")
	}
	if policyContract.EnforcementLayer != "required-policy-gateway" {
		t.Fatalf("reviewed enforcement layer is %q, expected required-policy-gateway", policyContract.EnforcementLayer)
	}

	policy := DefaultPolicy()
	if err := policy.Validate(); err != nil {
		t.Fatalf("default archive gateway policy is invalid: %v", err)
	}
	if !slices.Equal(policy.AllowedMethods, policyContract.CandidateMethodContract) {
		t.Fatalf(
			"gateway allowlist %v differs from the reviewed candidateMethodContract %v",
			policy.AllowedMethods, policyContract.CandidateMethodContract,
		)
	}
	if !slices.Equal(policy.WebSocketSubscriptions, policyContract.WebSocket.Subscriptions) {
		t.Fatalf(
			"gateway subscription allowlist %v differs from the reviewed contract %v",
			policy.WebSocketSubscriptions, policyContract.WebSocket.Subscriptions,
		)
	}
	if !slices.Equal(policy.WebSocketOrigins, policyContract.WebSocket.AllowedOrigins) {
		t.Fatalf(
			"gateway origin allowlist %v differs from the reviewed contract %v",
			policy.WebSocketOrigins, policyContract.WebSocket.AllowedOrigins,
		)
	}
	assertEqual(t, "wildcard origin", policy.WildcardOriginAllowed, policyContract.WebSocket.WildcardOriginAllowed)
	assertEqual(t, "body limit", policy.MaximumBodyBytes, policyContract.Limits.HTTPBodyBytes)
	assertEqual(t, "batch limit", policy.MaximumBatchRequests, policyContract.Limits.BatchRequests)
	assertEqual(t, "response limit", policy.MaximumResponseBytes, policyContract.Limits.BatchResponseBytes)
	assertEqual(t, "open connections", policy.MaximumOpenConnections, policyContract.Limits.MaxOpenConnections)
	assertEqual(
		t, "read/write timeout",
		int64(policy.ReadWriteTimeout/time.Millisecond),
		policyContract.Limits.HTTPReadWriteTimeoutMilliseconds,
	)
	assertEqual(
		t, "idle timeout",
		int64(policy.IdleTimeout/time.Millisecond),
		policyContract.Limits.HTTPIdleTimeoutMilliseconds,
	)
}

// The gateway defaults must address exactly the listeners and upstreams the
// reviewed contract reserves; a typo here would silently front the wrong node.
func TestGatewayDefaultsMatchReviewedListeners(t *testing.T) {
	t.Parallel()

	reviewed := loadReviewedNodeRoles(t)
	gateway := reviewed.ConsumerGateways["archive-indexer-v0"]
	assertEqual(t, "http bind", DefaultHTTPListenAddress, gateway.Listeners.EVMHTTP.ContainerBind)
	assertEqual(t, "websocket bind", DefaultWebSocketListenAddress, gateway.Listeners.EVMWebSocket.ContainerBind)
	assertEqual(t, "http upstream", DefaultHTTPUpstream, gateway.Listeners.EVMHTTP.Upstream)
	assertEqual(t, "websocket upstream", DefaultWebSocketUpstream, gateway.Listeners.EVMWebSocket.Upstream)
	assertEqual(t, "raw archive role", "private-archive-indexer", gateway.RawArchiveRole)
	assertEqual(t, "gateway identity", "archive-rpc-gateway", gateway.GatewayIdentity)
}

// The policy identity published on /metrics must name the reviewed contract it
// enforces, so an observability scrape records WHICH policy was in force.
func TestPublishedPolicyIdentityMatchesReviewedContract(t *testing.T) {
	t.Parallel()

	reviewed := loadReviewedNodeRoles(t)
	gateway := reviewed.ConsumerGateways["archive-indexer-v0"]
	assertEqual(t, "runtime policy id", RuntimePolicyID, gateway.RuntimePolicyRef)
	assertEqual(t, "enforced contract field", EnforcedContractField, gateway.EnforcedContractField)
	assertEqual(
		t, "policy version",
		PolicyVersion,
		gateway.RuntimePolicyRef+"/"+gateway.EnforcedContractField,
	)
}

func TestPolicyValidateRejectsWidenedContracts(t *testing.T) {
	t.Parallel()

	cases := map[string]func(*Policy){
		"transaction submission": func(policy *Policy) {
			policy.AllowedMethods = append(policy.AllowedMethods, "eth_sendRawTransaction")
		},
		"trace namespace": func(policy *Policy) {
			policy.AllowedMethods = append(policy.AllowedMethods, "debug_traceTransaction")
		},
		"operator namespace": func(policy *Policy) {
			policy.AllowedMethods = append(policy.AllowedMethods, "admin_peers")
		},
		"mempool namespace": func(policy *Policy) {
			policy.AllowedMethods = append(policy.AllowedMethods, "txpool_content")
		},
		"subscription in http allowlist": func(policy *Policy) {
			policy.AllowedMethods = append(policy.AllowedMethods, SubscribeMethod)
		},
		"wildcard origin flag": func(policy *Policy) { policy.WildcardOriginAllowed = true },
		"wildcard origin entry": func(policy *Policy) {
			policy.WebSocketOrigins = append(policy.WebSocketOrigins, "*")
		},
		"duplicate method": func(policy *Policy) {
			policy.AllowedMethods = append(policy.AllowedMethods, "eth_chainId")
		},
		"empty allowlist":     func(policy *Policy) { policy.AllowedMethods = nil },
		"empty subscriptions": func(policy *Policy) { policy.WebSocketSubscriptions = nil },
		"zero body limit":     func(policy *Policy) { policy.MaximumBodyBytes = 0 },
		"zero batch limit":    func(policy *Policy) { policy.MaximumBatchRequests = 0 },
		"zero timeout":        func(policy *Policy) { policy.ReadWriteTimeout = 0 },
	}
	for name, mutate := range cases {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			policy := DefaultPolicy()
			mutate(&policy)
			if err := policy.Validate(); err == nil {
				t.Fatalf("widened policy (%s) was accepted", name)
			}
		})
	}
}

func TestPolicyDecisions(t *testing.T) {
	t.Parallel()

	policy := DefaultPolicy()
	for _, method := range policy.AllowedMethods {
		if !policy.AllowsHTTPMethod(method) {
			t.Fatalf("allowlisted method %s was refused", method)
		}
	}
	for _, method := range []string{
		"eth_sendRawTransaction", "eth_sendTransaction", "eth_accounts",
		"debug_traceTransaction", "debug_traceBlockByNumber", "admin_nodeInfo",
		"personal_unlockAccount", "txpool_status", "miner_start",
		SubscribeMethod, UnsubscribeMethod, "eth_newFilter", "",
	} {
		if policy.AllowsHTTPMethod(method) {
			t.Fatalf("method %q crossed the HTTP allowlist", method)
		}
	}
	for _, stream := range policy.WebSocketSubscriptions {
		if !policy.AllowsSubscription(stream) {
			t.Fatalf("allowlisted subscription %s was refused", stream)
		}
	}
	for _, stream := range []string{"newPendingTransactions", "syncing", "", "*"} {
		if policy.AllowsSubscription(stream) {
			t.Fatalf("subscription %q crossed the allowlist", stream)
		}
	}
	if !policy.AllowsOrigin("") || !policy.AllowsOrigin("127.0.0.1") || !policy.AllowsOrigin("localhost") {
		t.Fatal("an allowlisted or absent origin was refused")
	}
	for _, origin := range []string{"evil.example", "*", "127.0.0.2"} {
		if policy.AllowsOrigin(origin) {
			t.Fatalf("origin %q crossed the allowlist", origin)
		}
	}
}

func TestValidateContainerBind(t *testing.T) {
	t.Parallel()

	if err := ValidateContainerBind("127.0.0.1:38545", false); err != nil {
		t.Fatalf("loopback bind rejected: %v", err)
	}
	if err := ValidateContainerBind("0.0.0.0:8545", true); err != nil {
		t.Fatalf("permitted container bind rejected: %v", err)
	}
	for _, address := range []string{"0.0.0.0:8545", "192.168.1.10:8545", "8545", "0.0.0.0:"} {
		if err := ValidateContainerBind(address, false); err == nil {
			t.Fatalf("address %q was accepted without an explicit container bind", address)
		}
	}
}

func assertEqual[T comparable](t *testing.T, name string, actual, expected T) {
	t.Helper()
	if actual != expected {
		t.Fatalf("%s is %v, reviewed contract says %v", name, actual, expected)
	}
}
