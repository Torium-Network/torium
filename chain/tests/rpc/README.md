# Torium local endpoint acceptance

This suite verifies the active, valueless local endpoint profile owned by
the RPC acceptance suite. It starts a clean four-validator Torium localnet and proves the interfaces
that wallets, SDKs and developer tools may use today:

- required `eth`, `net` and `web3` HTTP methods;
- method-specific behavior for `latest`, `pending`, `safe` and `finalized`
  across block, balance, nonce and call methods;
- the exact JSON-RPC envelopes for method-not-found, invalid-params,
  invalid-request and parse errors, including mixed success/error batches;
- rejection of the disabled `debug` trace surface and the `txpool`, `personal`
  and `miner` namespaces;
- the exact 100-request batch boundary, rejection at 101 requests and the
  5 MiB body limit;
- Cosmos REST identity/version, gRPC reachability and safe Comet RPC;
- WebSocket Origin behavior for no-Origin clients, `localhost`, `127.0.0.1`
  and an untrusted browser origin;
- `newHeads`, `newPendingTransactions` and address-filtered `logs`
  subscriptions driven by a real signed contract transaction;
- socket closure during a validator-0 restart, explicit WebSocket reconnect and
  HTTP block backfill before subscriptions resume.

Run it from a machine with Docker, Node.js, `curl` and `jq`:

```bash
make -C chain/tests/rpc test
```

The suite resets and stops the localnet. It uses only deterministic, public,
valueless development keys. A successful run writes a structured proof to
`.artifacts/latest-report.json`; failures write timestamped diagnostics in the
same ignored directory.

## Compatibility decisions and limits

This is EVM L1 compatibility acceptance. `pending` is accepted but is not a
proven geth-equivalent synthetic pending-state view. `finalized` names current
CometBFT committed state rather than Ethereum beacon finality. `safe` is
method-specific: block lookup accepts it while balance, nonce and call state
queries return JSON-RPC `-32602`. The report records those distinctions per
method so the SDK and documentation do not promise behavior the node does not
provide.

Historical-state coverage records an explicit block before a contract write,
commits the write, then proves `eth_call` at the old block still returns the
pre-write value while `latest` returns the new value. A successful historical
block lookup alone is not treated as proof of historical state execution.

`debug_traceTransaction`, `debug_traceBlockByNumber` and `debug_traceCall` are
tested as deliberately unavailable in the default wallet/SDK profile. Explorer
trace RPC belongs to a separate future operator profile; this suite does not
claim that Blockscout trace ingestion works against the default endpoint.

## Security boundary

Cosmos EVM v0.7.0 applies an all-origin HTTP CORS default even while its
`enabled-unsafe-cors` flag is false. The suite records that behavior instead of
pretending it is an origin allowlist. This profile is safe only because raw
listeners and every Compose host port are loopback-only. It must never be
published. A follow-up workstream owns the reverse-proxy, TLS, rate-limit, browser-origin
and operator/debug profiles required before any public endpoint exists.

Non-browser WebSocket clients may connect without an Origin header. URL-form
browser Origins, including `localhost` and `127.0.0.1`, remain unsupported in
this local profile and return HTTP 403; wildcard WS origins are also rejected
by config validation. Subscriptions do not replay missed messages, so clients
must reconnect and backfill over HTTP as this suite demonstrates.
