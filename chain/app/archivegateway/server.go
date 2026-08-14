package archivegateway

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"strings"
	"sync/atomic"
	"time"

	"github.com/gorilla/websocket"
)

// JSON-RPC error codes reused verbatim from the specification: a refused
// method is reported as "method not found" so a consumer cannot distinguish a
// method the archive node lacks from one the gateway refuses. Anything else
// would turn the gateway into a capability oracle.
const (
	codeMethodNotFound  = -32601
	codeInvalidRequest  = -32600
	codeParseError      = -32700
	codeInternalError   = -32603
	refusalMessage      = "method not found"
	batchRefusalMessage = "batch contains a method that is not found"
)

// Server enforces the archive gateway policy in front of the raw archive
// JSON-RPC listener. It is the only process joined to both the raw upstream
// network and the consumer network.
type Server struct {
	policy   Policy
	upstream *url.URL
	client   *http.Client
	logger   *slog.Logger

	forwarded atomic.Uint64
	refused   atomic.Uint64
	failed    atomic.Uint64
	// upstreamNanoseconds accumulates forwarded-call latency so /metrics can
	// publish a Prometheus summary (sum + count) without a client library.
	upstreamNanoseconds atomic.Uint64
	// stream is the WebSocket half's live view, registered by AttachStream so
	// one scrape covers every required #115 signal.
	stream *WebSocketServer
}

// AttachStream lets the single /metrics endpoint report the stream transport's
// counters too. The observability contract names one target for the gateway, so
// one endpoint must cover all of its required signals.
func (server *Server) AttachStream(stream *WebSocketServer) {
	server.stream = stream
}

// NewServer builds an HTTP enforcement handler for one raw upstream.
func NewServer(policy Policy, upstreamURL string, logger *slog.Logger) (*Server, error) {
	if err := policy.Validate(); err != nil {
		return nil, err
	}
	upstream, err := url.Parse(upstreamURL)
	if err != nil {
		return nil, fmt.Errorf("parse archive upstream URL: %w", err)
	}
	if upstream.Scheme != "http" || upstream.Host == "" {
		return nil, fmt.Errorf("archive upstream must be a plain http URL inside the private network, got %q", upstreamURL)
	}
	if logger == nil {
		logger = slog.New(slog.NewJSONHandler(io.Discard, nil))
	}
	return &Server{
		policy:   policy,
		upstream: upstream,
		client: &http.Client{
			Timeout: policy.ReadWriteTimeout,
			Transport: &http.Transport{
				MaxIdleConns:        policy.MaximumOpenConnections,
				MaxIdleConnsPerHost: policy.MaximumOpenConnections,
				IdleConnTimeout:     policy.IdleTimeout,
			},
		},
		logger: logger,
	}, nil
}

// Counters exposes the enforcement tallies for the gateway's own metrics
// endpoint.
func (server *Server) Counters() (forwarded, refused, failed uint64) {
	return server.forwarded.Load(), server.refused.Load(), server.failed.Load()
}

// ServeHTTP implements the request/response transport. Only a JSON-RPC POST
// whose every member method is allowlisted reaches the upstream.
func (server *Server) ServeHTTP(writer http.ResponseWriter, request *http.Request) {
	switch request.URL.Path {
	case "/healthz":
		server.serveHealth(writer, request)
		return
	case "/metrics":
		server.serveMetrics(writer, request)
		return
	case "", "/":
	default:
		// An unknown path is refused rather than forwarded: the upstream
		// serves JSON-RPC at the root only, and path-based routing is not
		// part of the contract.
		server.refuse(writer, http.StatusNotFound, nil, codeInvalidRequest, "not found")
		return
	}
	if request.Method != http.MethodPost {
		writer.Header().Set("allow", http.MethodPost)
		server.refuse(writer, http.StatusMethodNotAllowed, nil, codeInvalidRequest, "only JSON-RPC POST is accepted")
		return
	}

	body, err := io.ReadAll(http.MaxBytesReader(writer, request.Body, server.policy.MaximumBodyBytes))
	if err != nil {
		server.refuse(writer, http.StatusRequestEntityTooLarge, nil, codeInvalidRequest, "request body exceeds the archive gateway limit")
		return
	}
	requestID, methods, err := inspect(body, server.policy.MaximumBatchRequests)
	if err != nil {
		server.refuse(writer, http.StatusBadRequest, requestID, codeParseError, err.Error())
		return
	}
	for _, method := range methods {
		if server.policy.AllowsHTTPMethod(method) {
			continue
		}
		server.refused.Add(1)
		server.logger.Warn(
			"archive gateway refused a method",
			"transport", "http",
			"method", method,
			"batch", len(methods) > 1,
		)
		message := refusalMessage
		if len(methods) > 1 {
			message = batchRefusalMessage
		}
		// A batch is refused whole. Partially forwarding it would let a
		// consumer smuggle a refused call behind an allowed one.
		server.refuse(writer, http.StatusForbidden, requestID, codeMethodNotFound, message)
		return
	}

	upstreamRequest, err := http.NewRequestWithContext(
		request.Context(), http.MethodPost, server.upstream.String(), bytes.NewReader(body),
	)
	if err != nil {
		server.failed.Add(1)
		server.refuse(writer, http.StatusBadGateway, requestID, codeInternalError, "archive upstream request could not be built")
		return
	}
	upstreamRequest.Header.Set("content-type", "application/json")
	upstreamRequest.Header.Set("accept", "application/json")
	startedAt := time.Now()
	response, err := server.client.Do(upstreamRequest)
	if err != nil {
		server.failed.Add(1)
		server.logger.Error("archive upstream call failed", "error", err.Error())
		server.refuse(writer, http.StatusBadGateway, requestID, codeInternalError, "archive upstream is unavailable")
		return
	}
	server.upstreamNanoseconds.Add(uint64(time.Since(startedAt)))
	defer func() { _ = response.Body.Close() }()
	writer.Header().Set("content-type", "application/json")
	writer.Header().Set("x-torium-archive-gateway", "enforced")
	writer.WriteHeader(response.StatusCode)
	if _, err := io.Copy(writer, io.LimitReader(response.Body, server.policy.MaximumResponseBytes)); err != nil {
		server.failed.Add(1)
		server.logger.Error("archive upstream response truncated", "error", err.Error())
		return
	}
	server.forwarded.Add(1)
}

func (server *Server) serveHealth(writer http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodGet {
		writer.Header().Set("allow", http.MethodGet)
		server.refuse(writer, http.StatusMethodNotAllowed, nil, codeInvalidRequest, "only GET is accepted")
		return
	}
	writer.Header().Set("content-type", "application/json")
	writer.WriteHeader(http.StatusOK)
	_ = json.NewEncoder(writer).Encode(map[string]any{
		"status":                 "ok",
		"warning":                Warning,
		"enforcedMethods":        len(server.policy.AllowedMethods),
		"enforcedSubscriptions":  server.policy.WebSocketSubscriptions,
		"rawUpstreamHost":        server.upstream.Host,
		"publicOperationAllowed": false,
	})
}

// serveMetrics publishes every signal the #115 archive-gateway-metrics target
// requires, in the Prometheus text format. A client library would be the only
// other way to get a histogram; a summary's sum and count are enough to derive
// mean upstream latency, and the contract asks for latency, not quantiles.
func (server *Server) serveMetrics(writer http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodGet {
		writer.Header().Set("allow", http.MethodGet)
		server.refuse(writer, http.StatusMethodNotAllowed, nil, codeInvalidRequest, "only GET is accepted")
		return
	}
	forwarded, refused, failed := server.Counters()
	streamRefused := uint64(0)
	activeStreams := int64(0)
	if server.stream != nil {
		streamRefused = server.stream.RefusedCount()
		activeStreams = server.stream.ActiveConnections()
	}
	upstreamSeconds := float64(server.upstreamNanoseconds.Load()) / float64(time.Second)
	writer.Header().Set("content-type", "text/plain; version=0.0.4; charset=utf-8")
	writer.WriteHeader(http.StatusOK)
	_, _ = fmt.Fprintf(writer, `# HELP torium_archive_gateway_requests_total JSON-RPC requests by enforcement outcome.
# TYPE torium_archive_gateway_requests_total counter
torium_archive_gateway_requests_total{transport="http",outcome="forwarded"} %d
torium_archive_gateway_requests_total{transport="http",outcome="refused"} %d
torium_archive_gateway_requests_total{transport="http",outcome="upstream_failed"} %d
torium_archive_gateway_requests_total{transport="websocket",outcome="refused"} %d
# HELP torium_archive_gateway_upstream_latency_seconds Time spent awaiting the raw archive upstream for forwarded calls.
# TYPE torium_archive_gateway_upstream_latency_seconds summary
torium_archive_gateway_upstream_latency_seconds_sum %g
torium_archive_gateway_upstream_latency_seconds_count %d
# HELP torium_archive_gateway_active_websockets Consumer WebSocket connections currently proxied.
# TYPE torium_archive_gateway_active_websockets gauge
torium_archive_gateway_active_websockets %d
# HELP torium_archive_gateway_allowed_methods Size of the enforced method allowlist.
# TYPE torium_archive_gateway_allowed_methods gauge
torium_archive_gateway_allowed_methods %d
# HELP torium_archive_gateway_policy_info The enforced policy identity, so a scrape records WHICH contract was in force.
# TYPE torium_archive_gateway_policy_info gauge
torium_archive_gateway_policy_info{policy_version="%s",enforced_contract_field="%s",runtime_policy="%s",subscriptions="%s"} 1
`,
		forwarded, refused, failed, streamRefused,
		upstreamSeconds, forwarded,
		activeStreams,
		len(server.policy.AllowedMethods),
		PolicyVersion, EnforcedContractField, RuntimePolicyID,
		strings.Join(server.policy.WebSocketSubscriptions, ","),
	)
}

func (server *Server) refuse(
	writer http.ResponseWriter, status int, id json.RawMessage, code int, message string,
) {
	writer.Header().Set("content-type", "application/json")
	writer.Header().Set("x-torium-archive-gateway", "enforced")
	writer.WriteHeader(status)
	_ = json.NewEncoder(writer).Encode(errorEnvelope(id, code, message))
}

func errorEnvelope(id json.RawMessage, code int, message string) map[string]any {
	envelope := map[string]any{
		"jsonrpc": "2.0",
		"id":      nil,
		"error":   map[string]any{"code": code, "message": message},
	}
	if len(id) > 0 {
		envelope["id"] = id
	}
	return envelope
}

// inspect decodes just enough of a JSON-RPC payload to enumerate its methods.
// It never rewrites the payload: the exact reviewed bytes are what reaches the
// upstream.
func inspect(body []byte, maximumBatch int) (json.RawMessage, []string, error) {
	trimmed := bytes.TrimSpace(body)
	if len(trimmed) == 0 {
		return nil, nil, errors.New("empty JSON-RPC request")
	}
	type call struct {
		Method string          `json:"method"`
		ID     json.RawMessage `json:"id"`
	}
	if trimmed[0] == '[' {
		var batch []call
		if err := json.Unmarshal(trimmed, &batch); err != nil {
			return nil, nil, errors.New("malformed JSON-RPC batch")
		}
		if len(batch) == 0 {
			return nil, nil, errors.New("empty JSON-RPC batch")
		}
		if len(batch) > maximumBatch {
			return nil, nil, fmt.Errorf("JSON-RPC batch of %d exceeds the archive gateway limit of %d", len(batch), maximumBatch)
		}
		methods := make([]string, 0, len(batch))
		for _, member := range batch {
			if strings.TrimSpace(member.Method) == "" {
				return nil, nil, errors.New("JSON-RPC batch member has no method")
			}
			methods = append(methods, member.Method)
		}
		return nil, methods, nil
	}
	var single call
	if err := json.Unmarshal(trimmed, &single); err != nil {
		return nil, nil, errors.New("malformed JSON-RPC request")
	}
	if strings.TrimSpace(single.Method) == "" {
		return single.ID, nil, errors.New("JSON-RPC request has no method")
	}
	return single.ID, []string{single.Method}, nil
}

// --- WebSocket transport ---------------------------------------------------

// WebSocketServer enforces the same allowlist on the stream transport, plus
// the contract's subscription allowlist.
type WebSocketServer struct {
	policy   Policy
	upstream string
	logger   *slog.Logger
	dialer   *websocket.Dialer
	upgrader websocket.Upgrader

	refused atomic.Uint64
	active  atomic.Int64
}

// NewWebSocketServer builds the stream-transport enforcement handler.
func NewWebSocketServer(policy Policy, upstreamURL string, logger *slog.Logger) (*WebSocketServer, error) {
	if err := policy.Validate(); err != nil {
		return nil, err
	}
	upstream, err := url.Parse(upstreamURL)
	if err != nil {
		return nil, fmt.Errorf("parse archive WebSocket upstream URL: %w", err)
	}
	if upstream.Scheme != "ws" || upstream.Host == "" {
		return nil, fmt.Errorf("archive WebSocket upstream must be a plain ws URL inside the private network, got %q", upstreamURL)
	}
	if logger == nil {
		logger = slog.New(slog.NewJSONHandler(io.Discard, nil))
	}
	server := &WebSocketServer{
		policy: policy,
		// The upstream serves JSON-RPC over WebSocket at the root only. The
		// gateway normalizes any accepted client path to it, which is what
		// lets an indexer configured with a /websocket suffix work unchanged.
		upstream: (&url.URL{Scheme: "ws", Host: upstream.Host, Path: "/"}).String(),
		logger:   logger,
		dialer: &websocket.Dialer{
			HandshakeTimeout: policy.ReadWriteTimeout,
			ReadBufferSize:   1024,
			WriteBufferSize:  1024,
		},
	}
	server.upgrader = websocket.Upgrader{
		HandshakeTimeout: policy.ReadWriteTimeout,
		CheckOrigin: func(request *http.Request) bool {
			origin := request.Header.Get("Origin")
			if origin == "" {
				return true
			}
			parsed, err := url.Parse(origin)
			if err != nil {
				return false
			}
			return policy.AllowsOrigin(parsed.Hostname())
		},
	}
	return server, nil
}

// RefusedCount reports how many stream frames were refused.
func (server *WebSocketServer) RefusedCount() uint64 { return server.refused.Load() }

// ActiveConnections reports how many consumer WebSocket connections are
// currently proxied.
func (server *WebSocketServer) ActiveConnections() int64 { return server.active.Load() }

// ServeHTTP upgrades an allowlisted path and pumps frames in both directions,
// validating every client frame against the policy.
func (server *WebSocketServer) ServeHTTP(writer http.ResponseWriter, request *http.Request) {
	switch request.URL.Path {
	case "", "/", "/websocket":
	default:
		http.NotFound(writer, request)
		return
	}
	client, err := server.upgrader.Upgrade(writer, request, nil)
	if err != nil {
		server.logger.Debug("archive gateway WebSocket upgrade failed", "error", err.Error())
		return
	}
	defer func() { _ = client.Close() }()
	server.active.Add(1)
	defer server.active.Add(-1)
	client.SetReadLimit(server.policy.MaximumBodyBytes)

	upstream, _, err := server.dialer.DialContext(request.Context(), server.upstream, nil)
	if err != nil {
		server.logger.Error("archive gateway WebSocket upstream dial failed", "error", err.Error())
		_ = client.WriteJSON(errorEnvelope(nil, codeInternalError, "archive upstream is unavailable"))
		return
	}
	defer func() { _ = upstream.Close() }()
	upstream.SetReadLimit(server.policy.MaximumResponseBytes)

	done := make(chan struct{})
	// Upstream frames are relayed verbatim: they are answers to frames this
	// gateway already validated.
	go func() {
		defer close(done)
		for {
			messageType, payload, readErr := upstream.ReadMessage()
			if readErr != nil {
				return
			}
			if writeErr := client.WriteMessage(messageType, payload); writeErr != nil {
				return
			}
		}
	}()

	for {
		messageType, payload, readErr := client.ReadMessage()
		if readErr != nil {
			break
		}
		if messageType != websocket.TextMessage {
			// A binary frame cannot be inspected against the allowlist, so it
			// is refused instead of forwarded.
			server.refused.Add(1)
			_ = client.WriteJSON(errorEnvelope(nil, codeInvalidRequest, "only JSON text frames are accepted"))
			continue
		}
		if reason := server.reject(payload); reason != "" {
			server.refused.Add(1)
			server.logger.Warn("archive gateway refused a stream frame", "transport", "websocket", "reason", reason)
			_ = client.WriteJSON(errorEnvelope(frameID(payload), codeMethodNotFound, reason))
			continue
		}
		if writeErr := upstream.WriteMessage(websocket.TextMessage, payload); writeErr != nil {
			break
		}
	}
	_ = upstream.WriteMessage(websocket.CloseMessage, websocket.FormatCloseMessage(websocket.CloseNormalClosure, ""))
	select {
	case <-done:
	case <-time.After(time.Second):
	}
}

// reject returns a non-empty refusal reason for any frame the policy forbids.
func (server *WebSocketServer) reject(payload []byte) string {
	var frame struct {
		Method string            `json:"method"`
		Params []json.RawMessage `json:"params"`
	}
	if err := json.Unmarshal(bytes.TrimSpace(payload), &frame); err != nil {
		return "malformed JSON-RPC frame"
	}
	switch frame.Method {
	case "":
		return "JSON-RPC frame has no method"
	case SubscribeMethod:
		if len(frame.Params) == 0 {
			return "eth_subscribe requires a stream name"
		}
		var stream string
		if err := json.Unmarshal(frame.Params[0], &stream); err != nil {
			return "eth_subscribe stream name must be a string"
		}
		if !server.policy.AllowsSubscription(stream) {
			return refusalMessage
		}
		return ""
	case UnsubscribeMethod:
		// The teardown half of the allowed control pair; refusing it would
		// leave a consumer unable to release a subscription it was permitted
		// to create.
		return ""
	default:
		if server.policy.AllowsHTTPMethod(frame.Method) {
			return ""
		}
		return refusalMessage
	}
}

func frameID(payload []byte) json.RawMessage {
	var frame struct {
		ID json.RawMessage `json:"id"`
	}
	if err := json.Unmarshal(bytes.TrimSpace(payload), &frame); err != nil {
		return nil
	}
	return frame.ID
}

// ValidateContainerBind refuses a listener address that would leave the
// isolated local networks. The gateway binds all interfaces only because it is
// the sidecar inside two private Compose networks; running it on a host
// interface is out of contract.
func ValidateContainerBind(address string, allowContainerBind bool) error {
	host, port, err := net.SplitHostPort(address)
	if err != nil {
		return fmt.Errorf("invalid listen address %q: %w", address, err)
	}
	if strings.TrimSpace(port) == "" {
		return fmt.Errorf("listen address %q needs a port", address)
	}
	if host == "127.0.0.1" || host == "localhost" || host == "::1" {
		return nil
	}
	if (host == "0.0.0.0" || host == "" || host == "::") && allowContainerBind {
		return nil
	}
	return fmt.Errorf("listen address %q is neither loopback nor an allowed container bind", address)
}
