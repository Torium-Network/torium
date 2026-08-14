package archivegateway

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// recordingUpstream stands in for the raw archive JSON-RPC listener and
// records every payload that actually reached it. A refused method must leave
// this recorder empty: refusing after forwarding is not fail-closed.
type recordingUpstream struct {
	server   *httptest.Server
	received []string
}

func newRecordingUpstream(t *testing.T) *recordingUpstream {
	t.Helper()
	upstream := &recordingUpstream{}
	upstream.server = httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		body, _ := io.ReadAll(request.Body)
		upstream.received = append(upstream.received, string(body))
		writer.Header().Set("content-type", "application/json")
		_, _ = writer.Write([]byte(`{"jsonrpc":"2.0","id":1,"result":"0x1"}`))
	}))
	t.Cleanup(upstream.server.Close)
	return upstream
}

func newTestGateway(t *testing.T, upstream *recordingUpstream) *Server {
	t.Helper()
	server, err := NewServer(DefaultPolicy(), upstream.server.URL, nil)
	if err != nil {
		t.Fatalf("build archive gateway: %v", err)
	}
	return server
}

func post(t *testing.T, server *Server, body string) *httptest.ResponseRecorder {
	t.Helper()
	request := httptest.NewRequest(http.MethodPost, "/", strings.NewReader(body))
	recorder := httptest.NewRecorder()
	server.ServeHTTP(recorder, request)
	return recorder
}

func TestAllowlistedMethodsReachTheUpstream(t *testing.T) {
	t.Parallel()

	upstream := newRecordingUpstream(t)
	server := newTestGateway(t, upstream)
	policy := DefaultPolicy()
	for index, method := range policy.AllowedMethods {
		body := fmt.Sprintf(`{"jsonrpc":"2.0","id":%d,"method":%q,"params":[]}`, index, method)
		recorder := post(t, server, body)
		if recorder.Code != http.StatusOK {
			t.Fatalf("allowlisted %s returned %d", method, recorder.Code)
		}
	}
	if len(upstream.received) != len(policy.AllowedMethods) {
		t.Fatalf("upstream saw %d calls, expected %d", len(upstream.received), len(policy.AllowedMethods))
	}
	forwarded, refused, failed := server.Counters()
	if forwarded != uint64(len(policy.AllowedMethods)) || refused != 0 || failed != 0 {
		t.Fatalf("counters are forwarded=%d refused=%d failed=%d", forwarded, refused, failed)
	}
}

// The exact byte payload must reach the upstream: a gateway that re-encodes
// the request could change a parameter's meaning.
func TestForwardedPayloadIsByteIdentical(t *testing.T) {
	t.Parallel()

	upstream := newRecordingUpstream(t)
	server := newTestGateway(t, upstream)
	body := `{"jsonrpc":"2.0","id":"a","method":"eth_getBalance","params":["0x0000000000000000000000000000000000000001","0x1"]}`
	if recorder := post(t, server, body); recorder.Code != http.StatusOK {
		t.Fatalf("allowlisted call returned %d", recorder.Code)
	}
	if len(upstream.received) != 1 || upstream.received[0] != body {
		t.Fatalf("upstream received %q, expected the exact request bytes", upstream.received)
	}
}

func TestForbiddenMethodsFailClosed(t *testing.T) {
	t.Parallel()

	forbidden := []string{
		"eth_sendRawTransaction",
		"eth_sendTransaction",
		"eth_accounts",
		"eth_sign",
		"debug_traceTransaction",
		"debug_traceCall",
		"debug_traceBlockByNumber",
		"debug_traceBlockByHash",
		"admin_nodeInfo",
		"admin_addPeer",
		"personal_unlockAccount",
		"txpool_content",
		"miner_setEtherbase",
		"eth_subscribe",
		"eth_unsubscribe",
		"eth_newFilter",
		"eth_coinbase",
	}
	for _, method := range forbidden {
		t.Run(method, func(t *testing.T) {
			t.Parallel()
			upstream := newRecordingUpstream(t)
			server := newTestGateway(t, upstream)
			recorder := post(t, server, fmt.Sprintf(`{"jsonrpc":"2.0","id":7,"method":%q,"params":[]}`, method))
			if recorder.Code != http.StatusForbidden {
				t.Fatalf("%s returned %d, expected 403", method, recorder.Code)
			}
			if len(upstream.received) != 0 {
				t.Fatalf("%s reached the upstream: %q", method, upstream.received)
			}
			var envelope struct {
				Error struct {
					Code    int    `json:"code"`
					Message string `json:"message"`
				} `json:"error"`
				Result json.RawMessage `json:"result"`
			}
			if err := json.Unmarshal(recorder.Body.Bytes(), &envelope); err != nil {
				t.Fatalf("refusal body is not JSON-RPC: %v", err)
			}
			if envelope.Error.Code != codeMethodNotFound || envelope.Error.Message != refusalMessage {
				t.Fatalf("refusal reported %d/%q", envelope.Error.Code, envelope.Error.Message)
			}
			if len(envelope.Result) != 0 {
				t.Fatal("a refusal must not carry a result")
			}
		})
	}
}

// A batch is the obvious smuggling route: one allowed call in front of a
// refused one. The whole batch must be refused, and nothing may be forwarded.
func TestBatchWithOneForbiddenMemberIsRefusedWhole(t *testing.T) {
	t.Parallel()

	upstream := newRecordingUpstream(t)
	server := newTestGateway(t, upstream)
	recorder := post(t, server, `[
		{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]},
		{"jsonrpc":"2.0","id":2,"method":"eth_blockNumber","params":[]},
		{"jsonrpc":"2.0","id":3,"method":"debug_traceTransaction","params":["0x0"]}
	]`)
	if recorder.Code != http.StatusForbidden {
		t.Fatalf("mixed batch returned %d, expected 403", recorder.Code)
	}
	if len(upstream.received) != 0 {
		t.Fatalf("a refused batch was partially forwarded: %q", upstream.received)
	}
	if !strings.Contains(recorder.Body.String(), batchRefusalMessage) {
		t.Fatalf("refusal body %q does not report a batch refusal", recorder.Body.String())
	}
}

func TestAllowedBatchIsForwardedOnce(t *testing.T) {
	t.Parallel()

	upstream := newRecordingUpstream(t)
	server := newTestGateway(t, upstream)
	recorder := post(t, server, `[
		{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]},
		{"jsonrpc":"2.0","id":2,"method":"eth_blockNumber","params":[]}
	]`)
	if recorder.Code != http.StatusOK {
		t.Fatalf("allowed batch returned %d", recorder.Code)
	}
	if len(upstream.received) != 1 {
		t.Fatalf("upstream saw %d requests, expected one batch", len(upstream.received))
	}
}

func TestOversizedBatchIsRefused(t *testing.T) {
	t.Parallel()

	upstream := newRecordingUpstream(t)
	server := newTestGateway(t, upstream)
	members := make([]string, 0, DefaultPolicy().MaximumBatchRequests+1)
	for index := 0; index <= DefaultPolicy().MaximumBatchRequests; index++ {
		members = append(members, fmt.Sprintf(`{"jsonrpc":"2.0","id":%d,"method":"eth_chainId","params":[]}`, index))
	}
	recorder := post(t, server, "["+strings.Join(members, ",")+"]")
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("oversized batch returned %d, expected 400", recorder.Code)
	}
	if len(upstream.received) != 0 {
		t.Fatalf("an oversized batch was forwarded: %q", upstream.received)
	}
}

func TestMalformedAndEmptyPayloadsAreRefused(t *testing.T) {
	t.Parallel()

	for name, body := range map[string]string{
		"empty":           "",
		"whitespace":      "   ",
		"not json":        "{",
		"empty batch":     "[]",
		"no method":       `{"jsonrpc":"2.0","id":1,"params":[]}`,
		"blank method":    `{"jsonrpc":"2.0","id":1,"method":"   "}`,
		"batch no method": `[{"jsonrpc":"2.0","id":1,"params":[]}]`,
	} {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			upstream := newRecordingUpstream(t)
			server := newTestGateway(t, upstream)
			recorder := post(t, server, body)
			if recorder.Code != http.StatusBadRequest {
				t.Fatalf("%s payload returned %d, expected 400", name, recorder.Code)
			}
			if len(upstream.received) != 0 {
				t.Fatalf("%s payload was forwarded: %q", name, upstream.received)
			}
		})
	}
}

func TestNonPostAndUnknownPathsAreRefused(t *testing.T) {
	t.Parallel()

	upstream := newRecordingUpstream(t)
	server := newTestGateway(t, upstream)
	for _, testCase := range []struct {
		method string
		path   string
		status int
	}{
		{http.MethodGet, "/", http.StatusMethodNotAllowed},
		{http.MethodPut, "/", http.StatusMethodNotAllowed},
		{http.MethodPost, "/admin", http.StatusNotFound},
		{http.MethodPost, "/debug/pprof/", http.StatusNotFound},
	} {
		request := httptest.NewRequest(testCase.method, testCase.path, strings.NewReader(`{"method":"eth_chainId"}`))
		recorder := httptest.NewRecorder()
		server.ServeHTTP(recorder, request)
		if recorder.Code != testCase.status {
			t.Fatalf("%s %s returned %d, expected %d", testCase.method, testCase.path, recorder.Code, testCase.status)
		}
	}
	if len(upstream.received) != 0 {
		t.Fatalf("a non-JSON-RPC request was forwarded: %q", upstream.received)
	}
}

func TestOversizedBodyIsRefused(t *testing.T) {
	t.Parallel()

	upstream := newRecordingUpstream(t)
	server := newTestGateway(t, upstream)
	padding := strings.Repeat("0", int(DefaultPolicy().MaximumBodyBytes)+16)
	recorder := post(t, server, fmt.Sprintf(`{"jsonrpc":"2.0","id":1,"method":"eth_call","params":["%s"]}`, padding))
	if recorder.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("oversized body returned %d, expected 413", recorder.Code)
	}
	if len(upstream.received) != 0 {
		t.Fatalf("an oversized body was forwarded: %q", upstream.received)
	}
}

func TestHealthAndMetricsEndpoints(t *testing.T) {
	t.Parallel()

	upstream := newRecordingUpstream(t)
	server := newTestGateway(t, upstream)
	health := httptest.NewRecorder()
	server.ServeHTTP(health, httptest.NewRequest(http.MethodGet, "/healthz", nil))
	if health.Code != http.StatusOK {
		t.Fatalf("health returned %d", health.Code)
	}
	var payload struct {
		Status                 string   `json:"status"`
		EnforcedMethods        int      `json:"enforcedMethods"`
		EnforcedSubscriptions  []string `json:"enforcedSubscriptions"`
		PublicOperationAllowed bool     `json:"publicOperationAllowed"`
	}
	if err := json.Unmarshal(health.Body.Bytes(), &payload); err != nil {
		t.Fatalf("health body is not JSON: %v", err)
	}
	if payload.Status != "ok" || payload.PublicOperationAllowed {
		t.Fatalf("unexpected health payload %+v", payload)
	}
	if payload.EnforcedMethods != len(DefaultPolicy().AllowedMethods) {
		t.Fatalf("health reports %d enforced methods", payload.EnforcedMethods)
	}

	// One refusal must be visible in the metrics counters.
	post(t, server, `{"jsonrpc":"2.0","id":1,"method":"debug_traceTransaction","params":[]}`)
	metrics := httptest.NewRecorder()
	server.ServeHTTP(metrics, httptest.NewRequest(http.MethodGet, "/metrics", nil))
	if metrics.Code != http.StatusOK {
		t.Fatalf("metrics returned %d", metrics.Code)
	}
	// Every signal the #115 archive-gateway-metrics target requires must be
	// present, not only the refusal counter.
	for _, expected := range []string{
		`torium_archive_gateway_requests_total{transport="http",outcome="forwarded"}`,
		`torium_archive_gateway_requests_total{transport="http",outcome="refused"} 1`,
		`torium_archive_gateway_requests_total{transport="http",outcome="upstream_failed"}`,
		`torium_archive_gateway_requests_total{transport="websocket",outcome="refused"}`,
		"torium_archive_gateway_upstream_latency_seconds_sum",
		"torium_archive_gateway_upstream_latency_seconds_count",
		"torium_archive_gateway_active_websockets",
		"torium_archive_gateway_allowed_methods 20",
		`policy_version="` + PolicyVersion + `"`,
		`enforced_contract_field="` + EnforcedContractField + `"`,
		`runtime_policy="` + RuntimePolicyID + `"`,
		`subscriptions="newHeads,logs"`,
	} {
		if !strings.Contains(metrics.Body.String(), expected) {
			t.Fatalf("metrics body is missing %q:\n%s", expected, metrics.Body.String())
		}
	}
}

// Forwarding must move the latency summary, or the #115 upstream-latency signal
// would always read zero.
func TestUpstreamLatencyIsRecorded(t *testing.T) {
	t.Parallel()

	upstream := newRecordingUpstream(t)
	server := newTestGateway(t, upstream)
	post(t, server, `{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}`)
	metrics := httptest.NewRecorder()
	server.ServeHTTP(metrics, httptest.NewRequest(http.MethodGet, "/metrics", nil))
	if !strings.Contains(metrics.Body.String(), "torium_archive_gateway_upstream_latency_seconds_count 1") {
		t.Fatalf("the latency summary did not count a forwarded call:\n%s", metrics.Body.String())
	}
	if strings.Contains(metrics.Body.String(), "torium_archive_gateway_upstream_latency_seconds_sum 0\n") {
		t.Fatalf("the latency summary recorded zero elapsed time:\n%s", metrics.Body.String())
	}
}

func TestServerRejectsNonPrivateUpstreams(t *testing.T) {
	t.Parallel()

	for _, upstream := range []string{
		"https://archive.example/",
		"ws://private-archive-indexer:8545",
		"private-archive-indexer:8545",
		"",
	} {
		if _, err := NewServer(DefaultPolicy(), upstream, nil); err == nil {
			t.Fatalf("upstream %q was accepted", upstream)
		}
	}
}

func TestWebSocketServerRejectsNonPrivateUpstreams(t *testing.T) {
	t.Parallel()

	for _, upstream := range []string{
		"wss://archive.example/",
		"http://private-archive-indexer:8546",
		"",
	} {
		if _, err := NewWebSocketServer(DefaultPolicy(), upstream, nil); err == nil {
			t.Fatalf("WebSocket upstream %q was accepted", upstream)
		}
	}
}

// The stream transport must apply the same allowlist, plus the contract's
// subscription list. reject() is the single decision point, so it is asserted
// directly rather than through a live socket.
func TestWebSocketFrameDecisions(t *testing.T) {
	t.Parallel()

	server, err := NewWebSocketServer(DefaultPolicy(), DefaultWebSocketUpstream, nil)
	if err != nil {
		t.Fatalf("build WebSocket gateway: %v", err)
	}
	allowed := []string{
		`{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}`,
		`{"jsonrpc":"2.0","id":2,"method":"eth_getLogs","params":[{}]}`,
		`{"jsonrpc":"2.0","id":3,"method":"eth_subscribe","params":["newHeads"]}`,
		`{"jsonrpc":"2.0","id":4,"method":"eth_subscribe","params":["logs",{}]}`,
		`{"jsonrpc":"2.0","id":5,"method":"eth_unsubscribe","params":["0x1"]}`,
	}
	for _, frame := range allowed {
		if reason := server.reject([]byte(frame)); reason != "" {
			t.Fatalf("frame %s was refused: %s", frame, reason)
		}
	}
	refused := []string{
		`{"jsonrpc":"2.0","id":6,"method":"eth_subscribe","params":["newPendingTransactions"]}`,
		`{"jsonrpc":"2.0","id":7,"method":"eth_subscribe","params":["syncing"]}`,
		`{"jsonrpc":"2.0","id":8,"method":"eth_subscribe","params":[]}`,
		`{"jsonrpc":"2.0","id":9,"method":"eth_subscribe","params":[42]}`,
		`{"jsonrpc":"2.0","id":10,"method":"eth_sendRawTransaction","params":["0x0"]}`,
		`{"jsonrpc":"2.0","id":11,"method":"debug_traceTransaction","params":["0x0"]}`,
		`{"jsonrpc":"2.0","id":12,"method":"admin_peers","params":[]}`,
		`{"jsonrpc":"2.0","id":13,"params":[]}`,
		`not json`,
	}
	for _, frame := range refused {
		if reason := server.reject([]byte(frame)); reason == "" {
			t.Fatalf("frame %s crossed the stream allowlist", frame)
		}
	}
}
