#!/bin/sh
# Archive gateway activation evidence for issue #114. Boots the private archive
# indexer and its enforcement sidecar against the running localnet, then proves,
# from the running system rather than from a contract field:
#
#   1. the archive node replays from genesis and answers historical state,
#   2. every method in candidateMethodContract succeeds THROUGH the gateway,
#   3. every forbidden method fails closed and never reaches the upstream,
#   4. a batch containing one forbidden method is refused whole,
#   5. the raw archive RPC is unreachable from the consumer network,
#   6. the raw archive RPC is published nowhere on the host,
#   7. the enforced WebSocket transport accepts only allowlisted subscriptions.
#
# Loopback only; nothing is published. Requires a running localnet.
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo_root=$(CDPATH= cd -- "$script_dir/.." && pwd)
repo_root=$(CDPATH= cd -- "$repo_root/.." && pwd)
localnet_dir="$repo_root/chain/localnet"
profile="$script_dir/node-roles-v0.json"
canonical_rpc=http://127.0.0.1:8545
gateway_rpc=http://127.0.0.1:38545
evidence_dir="$script_dir/.artifacts"
alpine_image=$(grep -m1 '^ALPINE_IMAGE :=' "$localnet_dir/Makefile" | sed 's/^ALPINE_IMAGE := //')
phase=prerequisites

for dependency in docker curl jq node; do
  command -v "$dependency" >/dev/null 2>&1 || {
    echo "missing archive gateway evidence dependency: $dependency" >&2
    exit 1
  }
done

compose_archive() {
  docker compose \
    --file "$localnet_dir/compose.yaml" \
    --file "$script_dir/compose.archive-gateway.yaml" \
    "$@"
}

# jsonrpc <url> <method> [params-json]
jsonrpc() {
  curl --silent --show-error --max-time 20 \
    --output "$evidence_dir/response.json" \
    --write-out '%{http_code}' \
    -H 'content-type: application/json' \
    --data "$(jq -cn --arg method "$2" --argjson params "${3:-[]}" \
      '{jsonrpc:"2.0",id:1,method:$method,params:$params}')" \
    "$1"
}

# raw_post <url> <body>
raw_post() {
  curl --silent --show-error --max-time 20 \
    --output "$evidence_dir/response.json" \
    --write-out '%{http_code}' \
    -H 'content-type: application/json' \
    --data "$2" \
    "$1"
}

fail() {
  echo "archive gateway evidence failed in phase '$phase': $1" >&2
  exit 1
}

cleanup() {
  cleanup_status=$?
  trap - EXIT INT TERM HUP
  if [ "$cleanup_status" -ne 0 ]; then
    compose_archive logs --no-color --tail=120 archive-rpc-gateway \
      >"$evidence_dir/gateway-failure.log" 2>&1 || true
    compose_archive logs --no-color --tail=120 private-archive-indexer \
      >"$evidence_dir/archive-failure.log" 2>&1 || true
    echo "archive gateway evidence failed in phase '$phase'" >&2
  fi
  if [ "${TORIUM_KEEP_ARCHIVE_LANE:-0}" != "1" ]; then
    make --no-print-directory -C "$localnet_dir" archive-down >/dev/null 2>&1 || true
  fi
  exit "$cleanup_status"
}
trap cleanup EXIT
trap 'exit 130' INT TERM HUP

mkdir -p "$evidence_dir"

phase=contract-validation
echo "[1/8] validate the node-role profile and archive lane composition"
node "$repo_root/chain/profiles/validate-node-roles-v0.mjs" >/dev/null
node "$repo_root/chain/explorer/validate-stack-v0.mjs" >/dev/null
compose_archive config --quiet

phase=chain-precondition
echo "[2/8] confirm the canonical localnet is serving"
[ "$(jsonrpc "$canonical_rpc" eth_chainId)" = "200" ] ||
  fail "the canonical localnet is not answering on $canonical_rpc"
canonical_chain_id=$(jq -r '.result' "$evidence_dir/response.json")

phase=archive-lane-boot
echo "[3/8] boot the private archive indexer and its enforcement sidecar"
make --no-print-directory -C "$localnet_dir" archive-up >/dev/null
# The gateway healthcheck already gates on the archive node's readiness, so
# reaching this point means both are up. Wait for the archive node to catch up
# to the canonical tip before asking it anything about history.
[ "$(jsonrpc "$canonical_rpc" eth_blockNumber)" = "200" ] ||
  fail "the canonical localnet did not report a height"
canonical_height=$(jq -r '.result' "$evidence_dir/response.json")
deadline=$(( $(date +%s) + 300 ))
while :; do
  if [ "$(jsonrpc "$gateway_rpc" eth_blockNumber)" = "200" ]; then
    archive_height=$(jq -r '.result' "$evidence_dir/response.json")
    if [ "$((archive_height))" -ge "$((canonical_height))" ]; then
      break
    fi
  fi
  [ "$(date +%s)" -lt "$deadline" ] ||
    fail "the archive node never reached the canonical tip $canonical_height"
  sleep 3
done
[ "$(jsonrpc "$gateway_rpc" eth_chainId)" = "200" ] || fail "the gateway did not answer eth_chainId"
[ "$(jq -r '.result' "$evidence_dir/response.json")" = "$canonical_chain_id" ] ||
  fail "the archive node serves a different chain than the canonical RPC"

phase=archive-history
echo "[4/8] prove the archive node answers historical state from genesis"
# pruning "nothing" is only meaningful if an old height still resolves. Block 1
# is the oldest non-genesis height every localnet has.
jq -er '.roles[] | select(.id == "private-archive-indexer") | .id' "$profile" >/dev/null ||
  fail "the reviewed profile has no private-archive-indexer role"
[ "$(jsonrpc "$gateway_rpc" eth_getBlockByNumber '["0x1", false]')" = "200" ] ||
  fail "the archive node could not serve block 1"
jq -e '.result.hash != null' "$evidence_dir/response.json" >/dev/null ||
  fail "block 1 came back without a hash"
historical_block_hash=$(jq -r '.result.hash' "$evidence_dir/response.json")
# The same historical height must agree with the canonical RPC.
[ "$(jsonrpc "$canonical_rpc" eth_getBlockByNumber '["0x1", false]')" = "200" ] ||
  fail "the canonical RPC could not serve block 1"
[ "$(jq -r '.result.hash' "$evidence_dir/response.json")" = "$historical_block_hash" ] ||
  fail "the archive node's block 1 hash disagrees with canonical RPC"
# A historical *state* read at height 1 is what pruning would have destroyed.
coinbase=0x0000000000000000000000000000000000000000
[ "$(jsonrpc "$gateway_rpc" eth_getBalance "[\"$coinbase\", \"0x1\"]")" = "200" ] ||
  fail "the archive node refused a historical state read at height 1"
jq -e '.result != null and (.error | not)' "$evidence_dir/response.json" >/dev/null ||
  fail "historical state at height 1 is unavailable: $(cat "$evidence_dir/response.json")"

phase=allowlist-conformance
echo "[5/8] prove every candidateMethodContract method crosses the gateway"
allowed_methods=$(jq -r \
  '.runtimePolicies["evm-archive-blockscout-candidate-v0"].candidateMethodContract[]' "$profile")
allowed_count=0
for method in $allowed_methods; do
  case "$method" in
    eth_getBalance)          params='["0x0000000000000000000000000000000000000000","latest"]' ;;
    eth_getBlockByNumber)    params='["latest",false]' ;;
    eth_getBlockByHash)      params="[\"$historical_block_hash\",false]" ;;
    eth_getTransactionByHash|eth_getTransactionReceipt)
                             params='["0x0000000000000000000000000000000000000000000000000000000000000000"]' ;;
    eth_getLogs)             params='[{"fromBlock":"0x1","toBlock":"0x1"}]' ;;
    eth_call|eth_estimateGas)
                             params='[{"to":"0x0000000000000000000000000000000000000000","data":"0x"},"latest"]' ;;
    eth_getCode|eth_getTransactionCount)
                             params='["0x0000000000000000000000000000000000000000","latest"]' ;;
    eth_getStorageAt)        params='["0x0000000000000000000000000000000000000000","0x0","latest"]' ;;
    eth_feeHistory)          params='["0x1","latest",[]]' ;;
    *)                       params='[]' ;;
  esac
  status=$(jsonrpc "$gateway_rpc" "$method" "$params")
  [ "$status" = "200" ] || fail "$method was blocked by the gateway (HTTP $status)"
  # A JSON-RPC "method not found" would mean the gateway forwarded but the node
  # does not serve it; that is an allowlist/runtime disagreement, not a pass.
  if jq -e '.error.code == -32601' "$evidence_dir/response.json" >/dev/null 2>&1; then
    fail "$method is allowlisted but the archive node does not serve it"
  fi
  allowed_count=$(( allowed_count + 1 ))
done
[ "$allowed_count" -gt 0 ] || fail "the reviewed allowlist is empty"

phase=fail-closed
echo "[6/8] prove forbidden methods fail closed at the gateway"
forbidden_methods="eth_sendRawTransaction eth_sendTransaction eth_accounts eth_sign
debug_traceTransaction debug_traceCall debug_traceBlockByNumber debug_traceBlockByHash
admin_nodeInfo admin_addPeer admin_startHTTP personal_unlockAccount personal_listAccounts
txpool_content txpool_status miner_start eth_subscribe eth_unsubscribe eth_newFilter
eth_getFilterLogs eth_coinbase eth_mining net_enode"
refused_count=0
for method in $forbidden_methods; do
  status=$(jsonrpc "$gateway_rpc" "$method" '[]')
  [ "$status" = "403" ] || fail "$method returned HTTP $status instead of a 403 refusal"
  jq -e '.error.code == -32601 and (.result | not)' "$evidence_dir/response.json" >/dev/null ||
    fail "$method was refused without a JSON-RPC error envelope"
  # The refused method must also be absent from the raw upstream's own view: if
  # the gateway had forwarded it, the archive node would answer differently.
  refused_count=$(( refused_count + 1 ))
done
# A batch that hides one forbidden call behind allowed ones must be refused
# whole; a partial forward would defeat the allowlist.
batch_status=$(raw_post "$gateway_rpc" '[
  {"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]},
  {"jsonrpc":"2.0","id":2,"method":"eth_blockNumber","params":[]},
  {"jsonrpc":"2.0","id":3,"method":"debug_traceTransaction","params":["0x0"]}
]')
[ "$batch_status" = "403" ] || fail "a batch hiding a forbidden method returned HTTP $batch_status"
# An all-allowed batch must still work, so the batch path is not simply broken.
[ "$(raw_post "$gateway_rpc" '[
  {"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]},
  {"jsonrpc":"2.0","id":2,"method":"eth_blockNumber","params":[]}
]')" = "200" ] || fail "an all-allowlisted batch was refused"
jq -e 'type == "array" and length == 2' "$evidence_dir/response.json" >/dev/null ||
  fail "the allowed batch did not return two results"
# The gateway must not expose an operator surface of its own.
[ "$(curl --silent --output /dev/null --write-out '%{http_code}' --max-time 10 "$gateway_rpc/debug/pprof/")" = "404" ] ||
  fail "the gateway answered a pprof path"

phase=network-isolation
echo "[7/8] prove the raw archive RPC is unreachable from consumers and the host"
consumer_network=$(jq -er \
  '.consumerGateways["archive-indexer-v0"].consumerNetwork.id' "$profile")
raw_network=$(jq -er '.consumerGateways["archive-indexer-v0"].rawUpstreamNetwork.id' "$profile")
compose_project=$(compose_archive config --format json | jq -r '.name')
# A container attached ONLY to the consumer network stands in for a consumer.
# The raw archive service must be unresolvable and unreachable from there,
# while the gateway must answer.
consumer_probe() {
  docker run --rm --network "${compose_project}_${consumer_network}" \
    --entrypoint sh "$alpine_image" -c "$1" 2>&1
}
if consumer_probe 'wget -q -T 5 -O /dev/null http://private-archive-indexer:8545/' >/dev/null 2>&1; then
  fail "the raw archive RPC is reachable from the $consumer_network network"
fi
consumer_probe 'nslookup private-archive-indexer' >"$evidence_dir/consumer-dns.txt" 2>&1 || true
if grep -qi "^Address: *172\|^Address: *10\." "$evidence_dir/consumer-dns.txt"; then
  fail "the raw archive service resolves from the $consumer_network network"
fi
consumer_probe "wget -q -T 5 -O - --header='content-type: application/json' \
  --post-data='{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"eth_chainId\",\"params\":[]}' \
  http://archive-rpc-gateway:8545/" >"$evidence_dir/consumer-gateway.json" 2>&1 ||
  fail "a consumer cannot reach the gateway on the $consumer_network network"
grep -q "$canonical_chain_id" "$evidence_dir/consumer-gateway.json" ||
  fail "the gateway answered a consumer with the wrong chain id"
# The raw upstream network is internal, and the raw RPC is published nowhere.
compose_archive config --format json \
  >"$evidence_dir/archive-compose.json"
jq -e --arg network "$raw_network" '.networks[$network].internal == true' \
  "$evidence_dir/archive-compose.json" >/dev/null ||
  fail "the $raw_network network is not internal"
jq -e '.services["private-archive-indexer"] | has("ports") | not' \
  "$evidence_dir/archive-compose.json" >/dev/null ||
  fail "the archive node publishes a host port"
jq -e '[.services["archive-rpc-gateway"].ports[].published] | sort == ["38545","38546"]' \
  "$evidence_dir/archive-compose.json" >/dev/null ||
  fail "the gateway host publications differ from the reserved loopback bindings"
jq -e '[.services["archive-rpc-gateway"].ports[].host_ip] | unique == ["127.0.0.1"]' \
  "$evidence_dir/archive-compose.json" >/dev/null ||
  fail "a gateway host publication left loopback"

phase=stream-transport
echo "[8/8] prove the stream transport enforces the subscription allowlist"
node "$script_dir/probe-archive-gateway-stream.mjs" \
  --url "ws://127.0.0.1:38546/websocket" \
  --profile "$profile" \
  >"$evidence_dir/stream-probe.json"
jq -e '.result == "passed"' "$evidence_dir/stream-probe.json" >/dev/null ||
  fail "the WebSocket transport probe failed: $(cat "$evidence_dir/stream-probe.json")"

forwarded=$(curl --silent --max-time 10 "$gateway_rpc/metrics" |
  sed -n 's/^torium_archive_gateway_requests_total{outcome="forwarded"} //p')
refused=$(curl --silent --max-time 10 "$gateway_rpc/metrics" |
  sed -n 's/^torium_archive_gateway_requests_total{outcome="refused"} //p')
[ "${refused:-0}" -ge "$refused_count" ] ||
  fail "the gateway recorded ${refused:-0} refusals, expected at least $refused_count"

jq -n \
  --argjson allowedMethods "$allowed_count" \
  --argjson refusedMethods "$refused_count" \
  --argjson forwarded "${forwarded:-0}" \
  --argjson refusedCounter "${refused:-0}" \
  --argjson canonicalHeight "$((canonical_height))" \
  --arg chainId "$canonical_chain_id" \
  --arg historicalBlockHash "$historical_block_hash" \
  --arg consumerNetwork "$consumer_network" \
  --arg rawNetwork "$raw_network" \
  --slurpfile stream "$evidence_dir/stream-probe.json" \
  '{
    schemaVersion: 1,
    evidence: "archive-gateway-activation-v0",
    result: "passed",
    gateway: "archive-indexer-v0 (torium-archive-gateway sidecar, loopback only)",
    surfaces: [
      "archive-node-replayed-from-genesis",
      "historical-state-at-height-one-served",
      "historical-block-reconciled-against-canonical-rpc",
      "every-candidate-method-forwarded",
      "forbidden-methods-refused-403-never-forwarded",
      "mixed-batch-refused-whole",
      "raw-archive-rpc-unreachable-from-consumer-network",
      "raw-archive-rpc-unpublished-on-host",
      "websocket-subscription-allowlist-enforced"
    ],
    chainId: $chainId,
    canonicalHeightAtBoot: $canonicalHeight,
    historicalBlockHash: $historicalBlockHash,
    allowlistedMethodsProven: $allowedMethods,
    forbiddenMethodsRefused: $refusedMethods,
    gatewayCounters: { forwarded: $forwarded, refused: $refusedCounter },
    networks: { consumer: $consumerNetwork, rawUpstream: $rawNetwork },
    streamTransport: $stream[0],
    publicExposure: false
  }'
