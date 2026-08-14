#!/bin/sh
set -eu

suite_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo_root=$(CDPATH= cd -- "$suite_dir/../../.." && pwd)
localnet="$repo_root/chain/localnet/torium-localnet"
manifest="$repo_root/chain/genesis/localnet/manifest.json"
fixture="$repo_root/chain/tests/e2e/fixtures/CompatibilityProbe.json"
rpc_url=http://127.0.0.1:8545
foundry_image=
phase=prerequisites
contract_address=
raw_transaction=
diagnostics_dir=

for dependency in docker curl jq make node; do
  command -v "$dependency" >/dev/null 2>&1 || {
    echo "missing Torium RPC acceptance dependency: $dependency" >&2
    exit 1
  }
done
if ! command -v shasum >/dev/null 2>&1 && ! command -v sha256sum >/dev/null 2>&1; then
  echo "missing Torium RPC acceptance dependency: shasum or sha256sum" >&2
  exit 1
fi
foundry_image=$(jq -er '.testTool.image' "$fixture")

compose() {
  docker compose --file "$repo_root/chain/localnet/compose.yaml" "$@"
}

cast_cmd() {
  docker run --rm --network host --entrypoint cast "$foundry_image" "$@"
}

sha256_stdin() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 | awk '{print $1}'
  else
    sha256sum | awk '{print $1}'
  fi
}

rpc() {
  method=$1
  params=$2
  jq -cn --arg method "$method" --argjson params "$params" \
    '{jsonrpc:"2.0",id:1,method:$method,params:$params}' |
    curl --fail --silent --show-error --max-time 5 \
      -H 'content-type: application/json' --data-binary @- "$rpc_url"
}

wait_for_receipt() {
  transaction_hash=$1
  attempt=0
  while [ "$attempt" -lt 45 ]; do
    receipt=$(rpc eth_getTransactionReceipt "[\"$transaction_hash\"]" 2>/dev/null || true)
    if printf '%s' "$receipt" | jq -e '.result != null' >/dev/null 2>&1; then
      printf '%s\n' "$receipt"
      return
    fi
    attempt=$((attempt + 1))
    sleep 1
  done
  echo "transaction $transaction_hash did not receive a receipt" >&2
  return 1
}

capture_diagnostics() {
  diagnostics_dir="$suite_dir/.artifacts/$(date -u +%Y%m%dT%H%M%SZ)-$$"
  mkdir -p "$diagnostics_dir/configs"
  printf '%s\n' "$phase" >"$diagnostics_dir/phase.txt"
  compose ps -a >"$diagnostics_dir/compose-ps.txt" 2>&1 || true
  compose logs --no-color --tail=500 >"$diagnostics_dir/validator-logs.txt" 2>&1 || true
  "$localnet" status --backend container --json >"$diagnostics_dir/health.json" 2>&1 || true
  for node in validator-0 validator-1 validator-2 validator-3; do
    mkdir -p "$diagnostics_dir/configs/$node"
    cp "$repo_root/chain/localnet/.state/container/$node/config/app.toml" \
      "$diagnostics_dir/configs/$node/app.toml" 2>/dev/null || true
    cp "$repo_root/chain/localnet/.state/container/$node/config/config.toml" \
      "$diagnostics_dir/configs/$node/config.toml" 2>/dev/null || true
  done
}

cleanup() {
  status=$?
  trap - EXIT INT TERM HUP
  if [ "$status" -ne 0 ]; then capture_diagnostics || true; fi
  "$localnet" stop --backend container >/dev/null 2>&1 || true
  if [ "$status" -ne 0 ]; then
    echo "Torium RPC acceptance failed; diagnostics: ${diagnostics_dir:-unavailable}" >&2
  fi
  exit "$status"
}

trap cleanup EXIT
trap 'exit 130' INT TERM HUP

phase=profile-validation
echo "[1/4] validate the fail-closed local endpoint profile"
node "$repo_root/chain/config/validate-rpc-profile-v1.mjs" >/dev/null

phase=localnet-boot
echo "[2/4] boot a clean four-validator localnet with the pinned client surface"
"$localnet" reset --backend container --yes >/dev/null
readiness=$("$localnet" start --backend container --timeout 120 --json)
printf '%s' "$readiness" | jq -e '
  .schemaVersion == 2 and
  .state == "ready" and
  .ready == true and
  .allValidatorsReady == true and
  .rest.ready == true and
  .evm.ready == true and
  .evm.height > 0 and
  (.validators | all(.ready and .peerCount == 3))
' >/dev/null

phase=event-fixture
echo "[3/4] deploy a disposable event fixture and sign a raw subscription trigger"
fixture_signer=$(printf '%s' 'torium/localnet/valueless-fixture/v1/account/deployer' | sha256_stdin)
creation_bytecode=$(jq -er '.creationBytecode' "$fixture")
deploy_hash=$(cast_cmd send --gas-limit 500000 --private-key "$fixture_signer" \
  --rpc-url "$rpc_url" --async --create "$creation_bytecode")
deploy_receipt=$(wait_for_receipt "$deploy_hash")
contract_address=$(printf '%s' "$deploy_receipt" | jq -er '.result.contractAddress')
raw_transaction=$(cast_cmd mktx "$contract_address" 'setValue(uint256)' 96 \
  --gas-limit 200000 --private-key "$fixture_signer" --rpc-url "$rpc_url")

phase=endpoint-acceptance
echo "[4/4] exercise HTTP, WS, REST, gRPC, safety limits, reconnect and backfill"
node "$suite_dir/probe.mjs" \
  --root "$repo_root" \
  --contract "$contract_address" \
  --raw-transaction "$raw_transaction" \
  --manifest "$manifest"
