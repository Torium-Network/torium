# Torium chain observability v0 runbook

Status: local-only; the health-exporter target and the executable alert rules
are activated and evidenced (2026-07-29), while validator/EVM/gateway/explorer
targets, numeric thresholds, and any external delivery stay on HOLD.

The machine contract is
[`chain/observability/observability-v0.json`](../../chain/observability/observability-v0.json).
The local exporter transforms the existing health schema into bounded
Prometheus text without including funded accounts, addresses or allocation
data.

## Offline validation

From the repository root:

```bash
node chain/observability/validate-observability-v0.mjs
node --test chain/observability/health-exporter.test.mjs
```

These checks do not start Prometheus, Grafana, a chain, an explorer or a public
listener. The exporter binds loopback by default when an operator starts it
explicitly; it is not part of the active localnet Compose profile yet.

## Activate the collectors locally

With the canonical localnet already running:

```bash
./chain/observability/run-scrape-evidence-v0.sh
```

It starts the loopback health exporter and a digest-pinned Prometheus
(`chain/observability/compose.observability.yaml`), proves every required
signal is exported with bounded labels, proves the activated targets are
scraped with real chain samples, and proves `TelemetryTargetDown` fires,
tracks a target going down, and recovers. Nothing is published: Prometheus is
loopback-only and there is no alert receiver.

Activated native targets: CometBFT consensus metrics
(`Instrumentation.Prometheus` in the localnet runtime config, host-published
at `127.0.0.1:26660` from validator-0) and the EVM JSON-RPC metrics server
(started by the `--metrics` flag in the localnet start command, host-published
at `127.0.0.1:6065`; the go-ethereum exporter serves Prometheus text at
`/debug/metrics/prometheus`). Both are scraped by the pinned collector and
required to be `up` by the evidence script. Gateway and explorer targets stay
inactive until the endpoint-profile and explorer tracks activate their
sources.

## Readiness and liveness

Liveness means the process responds. Readiness additionally requires the
expected Cosmos/EVM chain identity, sufficient voting power, a committed
height, no active sync and the required RPC/query surface. Telemetry readiness
must never be folded into chain readiness: a collector outage degrades
visibility but cannot stop block production.

A future observability stack is ready only when all required targets are
scraped, dashboard queries resolve and alert-rule fixtures pass. An absent
inactive explorer target is `HOLD`, not green.

## Structured-log contract

Each owned component should emit one JSON object per line with an RFC 3339 UTC
timestamp, level, message, environment, component, role, node and profile or
artifact version. Optional correlation fields must have a named owner and a
bounded format.

Never log keys, mnemonics, seed phrases, signing payload secrets, authorization
headers, cookies or unredacted runtime environment values. Do not put full
signed transactions into routine logs. Support bundles and copied logs must
pass the chain secret scanner before sharing.

Container logs use bounded `json-file` rotation in the localnet. Raw-process
logs remain under ignored per-validator state and need a separately proven
rotation policy before the observability track can close.

## Alert response

The thresholds below are development fixtures. Preserve diagnostics first; do
not reset, roll back, delete a database or rotate a consensus key in response
to an alert without the owning recovery runbook.

### Validator down

Confirm the node identity, health endpoint and available voting power. With
three healthy 25-power validators the localnet remains live at 75/100; with two
unavailable it must stop below the 67-power commit quorum. Restart only the
expected local fixture process and verify catch-up. Broader fault proof belongs
to the recovery track.

### Height stalled

Compare a common recent height and block hash across reachable validators, then
inspect catching-up state, round progress and quorum. Distinguish a legitimate
quorum halt from a collector failure. Never edit chain state to clear the
alert.

### Peer loss

Compare expected persistent peers with `/net_info` on each loopback diagnostic
RPC. Check node ID drift before changing topology. The four-validator localnet
is one authority domain; local peer count is not public peer-diversity evidence.

### Disk pressure

Identify whether the pressure belongs to chain state, snapshots, ignored
runtime logs, explorer-derived data or Docker Desktop storage. Do not delete
validator state. Apply only the owning retention/recovery procedure; resource
threshold ratification belongs to the capacity-baseline track.

### RPC errors

Check chain identity, EVM height/sync, HTTP readiness and the bounded client
profile. Do not enable debug namespaces, wildcard origins or raw archive bypass
to make a probe pass. A public rate/error SLO is not defined in v0.

### Index lag

Compare the explorer indexed height and canonical block hash with the private
archive gateway. If the explorer stack is inactive, keep the alert target on
HOLD. Do not repair Blockscout from external tables or widen validator/public
RPC.

## Metrics privacy and cardinality

Allowed dimensions are fixed environment/component/role/node/state values.
Never label by account, address, transaction/block hash, request ID, peer ID/IP,
RPC arguments, URL path, error message or arbitrary user input. Prefer counters
and histograms with a closed operation/result vocabulary.

## Activation evidence

The observability activation track stays open until one reviewed local stack
proves:

- all four validators, client RPC and active explorer/indexer targets appear on
  the dashboard;
- stopped validator, stalled height, peer loss, disk pressure, RPC failure and
  index lag fixtures fire and recover with their runbook links;
- logs pass field, rotation and prohibited-secret checks;
- every metrics listener is internal or loopback-only and profiling stays off;
- collector failure does not affect consensus; and
- the capacity-baseline track records CPU, memory, disk and latency overhead.

Do not repeat an unchanged full E2E or MetaMask scenario for the inactive
contract. Run the consolidated observability fault exercise only after the
collector/listener configuration changes enough to produce new evidence.
