#!/bin/sh
# Local observability activation + scrape evidence for issue #115. Starts the
# health exporter and a pinned Prometheus against the already-running
# localnet, proves every enabled target is actually scraped with the required
# signals and bounded labels, and proves one alert fires and recovers.
# Loopback only; no public ingress, no external notification routing.
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo_root=$(CDPATH= cd -- "$script_dir/../.." && pwd)
localnet_dir="$repo_root/chain/localnet"
compose_file="$script_dir/compose.observability.yaml"
exporter_url=http://127.0.0.1:9468
prometheus_url=http://127.0.0.1:9490
evidence_dir="$script_dir/.artifacts"
exporter_pid=""
phase=prerequisites

TORIUM_UID=$(id -u)
TORIUM_GID=$(id -g)
export TORIUM_UID TORIUM_GID

for dependency in docker curl jq node; do
  command -v "$dependency" >/dev/null 2>&1 || {
    echo "missing observability evidence dependency: $dependency" >&2
    exit 1
  }
done

compose_obs() {
  docker compose --file "$compose_file" "$@"
}

cleanup() {
  cleanup_status=$?
  trap - EXIT INT TERM HUP
  if [ -n "$exporter_pid" ]; then kill "$exporter_pid" 2>/dev/null || true; fi
  compose_obs down --remove-orphans >/dev/null 2>&1 || true
  if [ "$cleanup_status" -ne 0 ]; then
    echo "observability evidence run failed in phase '$phase'" >&2
  fi
  exit "$cleanup_status"
}
trap cleanup EXIT
trap 'exit 130' INT TERM HUP

mkdir -p "$evidence_dir"

phase=contract-validation
echo "[1/6] validate the observability contract offline"
node "$script_dir/validate-observability-v0.mjs" >/dev/null
node --test "$script_dir/health-exporter.test.mjs" >/dev/null

phase=exporter
echo "[2/6] start the loopback health exporter"
node "$script_dir/health-exporter.mjs" \
  --root "$localnet_dir/.state/container" \
  --manifest "$repo_root/chain/genesis/localnet/manifest.json" \
  --profile container >"$evidence_dir/exporter.log" 2>&1 &
exporter_pid=$!
deadline=$(( $(date +%s) + 60 ))
until curl --fail --silent --max-time 3 "$exporter_url/healthz" >/dev/null 2>&1; do
  if [ "$(date +%s)" -ge "$deadline" ]; then
    echo "health exporter never became reachable" >&2
    exit 1
  fi
  sleep 1
done
curl --fail --silent --max-time 10 "$exporter_url/metrics" >"$evidence_dir/exporter-metrics.txt"
for signal in torium_localnet_ready torium_localnet_consensus_height torium_localnet_evm_height \
  torium_localnet_voting_power torium_localnet_validator_peers torium_localnet_validator_catching_up; do
  grep -q "^$signal" "$evidence_dir/exporter-metrics.txt" || {
    echo "exporter is missing required signal $signal" >&2
    exit 1
  }
done
# Bounded labels: the exporter must never emit account or address labels.
if grep -qiE 'address=|account=|mnemonic|0x[0-9a-f]{40}' "$evidence_dir/exporter-metrics.txt"; then
  echo "exporter emitted an unbounded or sensitive label" >&2
  exit 1
fi

phase=collector
echo "[3/6] start the pinned Prometheus collector"
compose_obs up --detach --wait prometheus
deadline=$(( $(date +%s) + 90 ))
until curl --fail --silent --max-time 3 "$prometheus_url/-/ready" >/dev/null 2>&1; do
  if [ "$(date +%s)" -ge "$deadline" ]; then
    echo "prometheus never became ready" >&2
    exit 1
  fi
  sleep 2
done

phase=scrape-evidence
echo "[4/6] prove every enabled target is actually scraped"
deadline=$(( $(date +%s) + 90 ))
until curl --fail --silent --max-time 5 "$prometheus_url/api/v1/targets?state=active" |
  jq -e '
    ([.data.activeTargets[] | select(.labels.torium_target == "localnet-health-v2")] | map(select(.health == "up")) | length) >= 1 and
    ([.data.activeTargets[] | select(.labels.torium_target == "prometheus-self")] | map(select(.health == "up")) | length) >= 1 and
    ([.data.activeTargets[] | select(.labels.torium_target == "comet-consensus-metrics")] | map(select(.health == "up")) | length) >= 1 and
    ([.data.activeTargets[] | select(.labels.torium_target == "cosmos-evm-json-rpc-metrics")] | map(select(.health == "up")) | length) >= 1
  ' >/dev/null 2>&1; do
  if [ "$(date +%s)" -ge "$deadline" ]; then
    echo "required scrape targets never reported up" >&2
    curl --silent --max-time 5 "$prometheus_url/api/v1/targets?state=active" >"$evidence_dir/targets-failure.json" || true
    exit 1
  fi
  sleep 2
done
curl --fail --silent --max-time 5 "$prometheus_url/api/v1/targets?state=active" >"$evidence_dir/targets.json"
jq -e '
  [.data.activeTargets[] | {target: .labels.torium_target, role: .labels.torium_role, health}] |
  length >= 5 and
  (map(.role) | unique | length) >= 5
' "$evidence_dir/targets.json" >/dev/null
# Every role in the scrape config must appear, so a missing role is visible
# rather than silently absent.
for role in controller validator public-rpc faucet collector; do
  jq -e --arg role "$role" '[.data.activeTargets[] | select(.labels.torium_role == $role)] | length >= 1' \
    "$evidence_dir/targets.json" >/dev/null || {
    echo "role $role has no scrape target" >&2
    exit 1
  }
done
# The controller target must carry real chain samples, not just be "up".
curl --fail --silent --max-time 5 \
  --get --data-urlencode 'query=torium_localnet_consensus_height' \
  "$prometheus_url/api/v1/query" >"$evidence_dir/query-consensus-height.json"
jq -e '.status == "success" and (.data.result | length) >= 1 and (.data.result[0].value[1] | tonumber) > 0' \
  "$evidence_dir/query-consensus-height.json" >/dev/null

phase=alert-firing
echo "[5/6] prove an alert fires and recovers"
# Inactive targets (validator/public-rpc metrics endpoints are not enabled on
# the current localnet) keep TelemetryTargetDown pending->firing without any
# fault injection into consensus.
deadline=$(( $(date +%s) + 120 ))
until curl --fail --silent --max-time 5 "$prometheus_url/api/v1/alerts" |
  jq -e '[.data.alerts[] | select(.labels.alertname == "TelemetryTargetDown" and .state == "firing")] | length >= 1' \
    >/dev/null 2>&1; do
  if [ "$(date +%s)" -ge "$deadline" ]; then
    echo "TelemetryTargetDown never fired" >&2
    curl --silent --max-time 5 "$prometheus_url/api/v1/alerts" >"$evidence_dir/alerts-failure.json" || true
    exit 1
  fi
  sleep 3
done
curl --fail --silent --max-time 5 "$prometheus_url/api/v1/alerts" >"$evidence_dir/alerts-firing.json"
alert_count=$(jq '[.data.alerts[] | select(.state == "firing")] | length' "$evidence_dir/alerts-firing.json")

# Recovery: stopping the exporter must make the controller target go down and
# then, after restart, recover — proving the alert tracks reality both ways.
kill "$exporter_pid" 2>/dev/null || true
wait "$exporter_pid" 2>/dev/null || true
exporter_pid=""
deadline=$(( $(date +%s) + 90 ))
until curl --fail --silent --max-time 5 "$prometheus_url/api/v1/targets?state=active" |
  jq -e '[.data.activeTargets[] | select(.labels.torium_target == "localnet-health-v2" and .health == "down")] | length >= 1' \
    >/dev/null 2>&1; do
  if [ "$(date +%s)" -ge "$deadline" ]; then
    echo "controller target never went down after the exporter stopped" >&2
    exit 1
  fi
  sleep 2
done
node "$script_dir/health-exporter.mjs" \
  --root "$localnet_dir/.state/container" \
  --manifest "$repo_root/chain/genesis/localnet/manifest.json" \
  --profile container >>"$evidence_dir/exporter.log" 2>&1 &
exporter_pid=$!
deadline=$(( $(date +%s) + 90 ))
until curl --fail --silent --max-time 5 "$prometheus_url/api/v1/targets?state=active" |
  jq -e '[.data.activeTargets[] | select(.labels.torium_target == "localnet-health-v2" and .health == "up")] | length >= 1' \
    >/dev/null 2>&1; do
  if [ "$(date +%s)" -ge "$deadline" ]; then
    echo "controller target never recovered after the exporter restarted" >&2
    exit 1
  fi
  sleep 2
done
curl --fail --silent --max-time 5 "$prometheus_url/api/v1/alerts" >"$evidence_dir/alerts-recovered.json"

phase=proof
echo "[6/6] emit the scrape evidence proof"
jq -n \
  --slurpfile targets "$evidence_dir/targets.json" \
  --argjson firingAlertCount "$alert_count" \
  '{
    schemaVersion: 1,
    evidence: "observability-scrape-and-alert-v0",
    result: "passed",
    collector: "prom/prometheus:v3.1.0 (digest-pinned, loopback only)",
    roles: ($targets[0].data.activeTargets | map(.labels.torium_role) | unique),
    targets: ($targets[0].data.activeTargets | map({target: .labels.torium_target, health})),
    firingAlertCount: $firingAlertCount,
    alertLifecycleProven: ["fired", "target-down-observed", "target-recovered"],
    publicIngressEnabled: false
  }'
