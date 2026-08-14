# Torium local observability v0

This directory is the local-only starting point for the observability workstream. It does not
deploy or activate Prometheus, Grafana, alert delivery, tracing or a public
telemetry endpoint.

## Validate the contract

```bash
node chain/observability/validate-observability-v0.mjs
node --test chain/observability/health-exporter.test.mjs
```

The validator cross-checks canonical identifiers, ports, node roles, the
inactive explorer, exporter labels, log rotation, dashboard queries, runbook
anchors and every HOLD gate. Docker Compose v2 is required only to render and
inspect the effective Compose model; the validator does not start containers.

## Run the health exporter manually

After the four-validator localnet is already running:

```bash
node chain/observability/health-exporter.mjs \
  --root chain/localnet/.state/container \
  --manifest chain/genesis/localnet/manifest.json \
  --profile container
```

It listens on `127.0.0.1:9468` by default:

- `/healthz` reports exporter-process liveness;
- `/metrics` samples the existing health contract and returns Prometheus text;
- invalid inputs or a failed sample return a generic failure without leaking
  topology, URLs, errors, accounts or addresses.

Only numeric loopback hosts are accepted. The exporter is not started by
Compose and is not chain readiness authority.

The Grafana file under `grafana/` is an unprovisioned dashboard fixture whose
queries are restricted to exact localnet metric selectors and checked against
emitted metric families. Complex PromQL and executable alert rules require a
reviewed, pinned `promtool`; collector image pins and the remaining dashboard
suite stay on HOLD.

See the
[operator runbook](../../docs/operations/torium-chain-observability-runbook.md)
for alert response and the
recorded observability design
for the activation boundary.

## Remaining metric targets (measured 2026-07-30)

### archive-gateway-metrics — ACTIVATED

`torium-archive-gateway` serves Prometheus text at `/metrics` on its enforced
listener (`127.0.0.1:38545`), and `prometheus.yml` scrapes it. All six required
signals map to real families:

| Required signal | Family |
| --- | --- |
| allowed-request-rate | `torium_archive_gateway_requests_total{transport="http",outcome="forwarded"}` |
| denied-request-rate | `…{transport="http",outcome="refused"}` |
| upstream-errors | `…{transport="http",outcome="upstream_failed"}` |
| upstream-latency | `torium_archive_gateway_upstream_latency_seconds_sum` / `_count` |
| active-websockets | `torium_archive_gateway_active_websockets` |
| policy-version | `torium_archive_gateway_policy_info{policy_version=…}` |

The validator asserts each mapping against the gateway source, so a signal the
contract claims but the gateway does not emit fails validation.

The archive lane must be running (`make -C chain/localnet archive-up`) for this
target to be up; otherwise it reports down, which is what `TelemetryTargetDown`
is for.

### explorer-indexer-metrics — still HOLD, with the gap now precise

Blockscout v11.2.2 **does** ship a Prometheus exporter: the image contains
`prometheus_ex`, `prometheus_ecto`, `prometheus_plugs` and
`prometheus_process_collector`, and both `/metrics` and `/public-metrics` answer
`200` on the backend port with **126 metric families** — no environment switch
was needed.

Measured coverage of the eight required signals:

| Required signal | Native family | Covered |
| --- | --- | --- |
| indexed-height | `latest_block_number` | yes |
| index-lag | `blocks_realtime_indexing_delay_seconds`, `delay_from_last_node_block` | yes |
| queue-depth | `*_queue_count`, `event_handler_queue_*` | yes |
| canonical-height | derivable from `latest_block_number` + `delay_from_last_node_block` | partial |
| missing-receipts-or-logs | `missing_blocks_count`, `missing_internal_transactions_count` (gaps, not receipts/logs) | partial |
| canonical-hash-mismatch | none | **no** |
| database-size-and-growth | none | **no** |
| database-connections | `ecto_*` durations only; no pool gauge | **no** |

So the blocker is no longer "the stack is inactive". What remains is:

1. a digest-pinned PostgreSQL exporter for database size, growth and
   connections; and
2. a **Torium-side reconciliation signal** — nothing in Blockscout can report a
   canonical-hash mismatch against Torium's RPC, because Blockscout is the
   derived index and would be comparing itself.

The contract's `currentStatus` now names that gap, and the validator asserts the
full eight-signal requirement is still listed so narrowing the status cannot
quietly narrow the requirement.

### role-process-resource-metrics — still HOLD

Needs a per-container exporter pin. `gcr.io/cadvisor/cadvisor:v0.52.1` resolves
to `sha256:f40e65878e25c2e78ea037f73a449527a0fb994e303dc3e34cb6b187b4b91435`
and is the natural candidate, but two of the eight required signals
(`iops-and-io-latency`, `open-files`/`open-connections`) are not reliably
available from cAdvisor on Docker Desktop, so pinning it alone would not
activate the target. Verify the signal coverage on a Linux host before pinning.

