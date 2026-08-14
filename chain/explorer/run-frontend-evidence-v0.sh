#!/bin/sh
# Explorer UI compatibility evidence for issue #113's frontend pin.
#
# Upstream does NOT declare a compatible frontend version for backend v11.2.2:
# blockscout/blockscout's docker-compose pins
# `ghcr.io/blockscout/frontend:${FRONTEND_DOCKER_TAG:-latest}` and its
# common-frontend.env carries no version variable. The compatibility ceiling
# therefore has to be established locally, which is what this script does:
#
#   1. the pinned image is addressed by immutable digest, never a tag,
#   2. the RUNNING image's own source revision matches the revision recorded
#      for that digest (so the pin and the artifact cannot drift apart),
#   3. the UI's effective configuration matches chain/config/identifiers.json
#      and the canonical chain id — not an upstream default,
#   4. its health endpoint and its real routes answer,
#   5. it reaches the pinned backend and nothing third-party.
#
# Loopback only; nothing is published. Requires the explorer backend stack.
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo_root=$(CDPATH= cd -- "$script_dir/../.." && pwd)
compose_file="$script_dir/compose.explorer.yaml"
frontend_overlay="$script_dir/compose.frontend.yaml"
identifiers="$repo_root/chain/config/identifiers.json"
stack="$script_dir/stack-v0.json"
rpc_url=http://127.0.0.1:8545
backend_url=http://127.0.0.1:44000
frontend_url=http://127.0.0.1:44001
evidence_dir="$script_dir/.artifacts"
phase=prerequisites

for dependency in docker curl jq; do
  command -v "$dependency" >/dev/null 2>&1 || {
    echo "missing frontend evidence dependency: $dependency" >&2
    exit 1
  }
done

compose_ui() {
  docker compose --file "$compose_file" --file "$frontend_overlay" "$@"
}

fail() {
  echo "frontend evidence failed in phase '$phase': $1" >&2
  exit 1
}

# http_code <path>
http_code() {
  curl --silent --output /dev/null --write-out '%{http_code}' --max-time 30 "$frontend_url$1"
}

cleanup() {
  cleanup_status=$?
  trap - EXIT INT TERM HUP
  if [ "$cleanup_status" -ne 0 ]; then
    compose_ui logs --no-color --tail=120 frontend >"$evidence_dir/frontend-failure.log" 2>&1 || true
    echo "frontend evidence failed in phase '$phase'" >&2
  fi
  if [ "${TORIUM_KEEP_EXPLORER_UI:-0}" != "1" ]; then
    compose_ui rm --force --stop frontend >/dev/null 2>&1 || true
  fi
  exit "$cleanup_status"
}
trap cleanup EXIT
trap 'exit 130' INT TERM HUP

mkdir -p "$evidence_dir"

phase=contract-validation
echo "[1/6] validate the explorer contracts and the digest pin"
node "$repo_root/chain/explorer/validate-selection-v1.mjs" >/dev/null
node "$repo_root/chain/explorer/validate-stack-v0.mjs" >/dev/null
compose_ui config --quiet
# A tag is not a security identity: the overlay must address the image by
# digest, and that digest must be the one the stack contract records.
pinned_image=$(compose_ui config --format json | jq -er '.services.frontend.image')
case "$pinned_image" in
  *@sha256:*) ;;
  *) fail "the frontend image $pinned_image is not digest-pinned" ;;
esac
contract_image=$(jq -er \
  '.components[] | select(.id == "blockscout-frontend") | .artifact.imageWithDigest' "$stack")
[ "$pinned_image" = "$contract_image" ] ||
  fail "the overlay runs $pinned_image but the stack contract pins $contract_image"
contract_revision=$(jq -er \
  '.components[] | select(.id == "blockscout-frontend") | .artifact.sourceCommit' "$stack")

phase=backend-precondition
echo "[2/6] confirm the pinned backend is serving"
curl --fail --silent --max-time 10 "$backend_url/api?module=block&action=eth_block_number" \
  >/dev/null || fail "the explorer backend is not serving on $backend_url"
canonical_chain_id=$(curl --fail --silent --max-time 10 \
  -H 'content-type: application/json' \
  --data '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' "$rpc_url" |
  jq -er '.result')
expected_chain_id=$((canonical_chain_id))

phase=frontend-boot
echo "[3/6] boot the pinned UI"
compose_ui up --detach --force-recreate frontend >/dev/null
boot_deadline=$(( $(date +%s) + 300 ))
while :; do
  if [ "$(http_code /api/healthz)" = "200" ]; then
    break
  fi
  if [ "$(date +%s)" -ge "$boot_deadline" ]; then
    fail "the UI health endpoint never answered"
  fi
  sleep 5
done

phase=running-image-identity
echo "[4/6] prove the RUNNING image is the pinned source revision"
curl --fail --silent --max-time 20 "$frontend_url/node-api/config" \
  >"$evidence_dir/frontend-config.json" ||
  fail "the UI did not expose its effective configuration"
running_revision=$(jq -er '.envs.NEXT_PUBLIC_GIT_COMMIT_SHA' "$evidence_dir/frontend-config.json")
# The image publishes an abbreviated SHA; it must prefix the recorded commit.
case "$contract_revision" in
  "$running_revision"*) ;;
  *) fail "the running UI reports revision $running_revision but the contract records $contract_revision" ;;
esac
running_tag=$(jq -r '.envs.NEXT_PUBLIC_GIT_TAG // ""' "$evidence_dir/frontend-config.json")

phase=identity-reconciliation
echo "[5/6] reconcile the UI's effective identity against the reviewed sources"
expected_symbol=$(jq -er '.currency.nonValueNetworks.symbol' "$identifiers")
expected_name=$(jq -er '.currency.nonValueNetworks.name' "$identifiers")
expected_decimals=$(jq -er '.currency.decimals' "$identifiers")
jq -e \
  --arg symbol "$expected_symbol" \
  --arg name "$expected_name" \
  --arg decimals "$expected_decimals" \
  --arg chainId "$expected_chain_id" \
  '.envs.NEXT_PUBLIC_NETWORK_CURRENCY_SYMBOL == $symbol
   and .envs.NEXT_PUBLIC_NETWORK_CURRENCY_NAME == $name
   and .envs.NEXT_PUBLIC_NETWORK_CURRENCY_DECIMALS == $decimals
   and .envs.NEXT_PUBLIC_NETWORK_ID == $chainId
   and .envs.NEXT_PUBLIC_IS_TESTNET == "true"' \
  "$evidence_dir/frontend-config.json" >/dev/null ||
  fail "the UI identity differs from chain/config/identifiers.json or the canonical chain id"
# No third-party surface may be configured: this stack must not reach a market
# data provider, a metadata service, or a wallet relay.
jq -e '
  [
    .envs.NEXT_PUBLIC_STATS_API_HOST,
    .envs.NEXT_PUBLIC_VISUALIZE_API_HOST,
    .envs.NEXT_PUBLIC_CONTRACT_INFO_API_HOST,
    .envs.NEXT_PUBLIC_NAME_SERVICE_API_HOST,
    .envs.NEXT_PUBLIC_ADMIN_SERVICE_API_HOST
  ] | all(. == "" or . == null)' \
  "$evidence_dir/frontend-config.json" >/dev/null ||
  fail "the UI has a third-party service host configured"
# It must address the loopback backend the stack contract reserves.
jq -e '.envs.NEXT_PUBLIC_API_HOST == "127.0.0.1:44000"' \
  "$evidence_dir/frontend-config.json" >/dev/null ||
  fail "the UI does not address the reserved backend loopback publication"

phase=route-health
echo "[6/6] prove the UI routes render"
routes="/ /txs /blocks"
route_report="[]"
for route in $routes; do
  code=$(http_code "$route")
  [ "$code" = "200" ] || fail "route $route returned HTTP $code"
  route_report=$(printf '%s' "$route_report" |
    jq -c --arg route "$route" --argjson code "$code" '. + [{route: $route, status: $code}]')
done
# The UI must publish nothing beyond its reserved loopback binding.
compose_ui config --format json >"$evidence_dir/frontend-compose.json"
jq -e '[.services.frontend.ports[].host_ip] | unique == ["127.0.0.1"]' \
  "$evidence_dir/frontend-compose.json" >/dev/null ||
  fail "a UI host publication left loopback"
jq -e '[.services.frontend.ports[].published] == ["44001"]' \
  "$evidence_dir/frontend-compose.json" >/dev/null ||
  fail "the UI publishes a port the stack contract does not reserve"

jq -n \
  --arg image "$pinned_image" \
  --arg runningRevision "$running_revision" \
  --arg contractRevision "$contract_revision" \
  --arg runningTag "$running_tag" \
  --arg symbol "$expected_symbol" \
  --argjson chainId "$expected_chain_id" \
  --argjson routes "$route_report" \
  '{
    schemaVersion: 1,
    evidence: "explorer-frontend-compatibility-v0",
    result: "passed",
    image: $image,
    runningSourceRevision: $runningRevision,
    contractSourceCommit: $contractRevision,
    runningTag: $runningTag,
    surfaces: [
      "image-addressed-by-immutable-digest",
      "running-image-revision-matches-the-recorded-source-commit",
      "health-endpoint-answers",
      "effective-identity-matches-reviewed-identifiers-and-canonical-chain-id",
      "no-third-party-service-host-configured",
      "backend-addressed-through-the-reserved-loopback-publication",
      "ui-routes-render",
      "no-host-publication-beyond-the-reserved-binding"
    ],
    nativeAssetSymbol: $symbol,
    evmChainId: $chainId,
    routes: $routes,
    upstreamDeclaredCompatibility: "none-upstream-pins-frontend-latest-for-this-backend-release",
    publicExposure: false
  }'
