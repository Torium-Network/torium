#!/bin/sh
# Local explorer stack activation evidence for issue #113: boots the
# digest-pinned Blockscout stack against the running localnet, proves the
# indexer reaches the chain tip, proves a real transaction is indexed and
# matches canonical RPC, proves account balances and native tTOR metadata
# reconcile, proves a rollback of derived state heals itself (Blockscout's own
# reorg path), proves the derived database can be discarded and rebuilt (reindex
# lifecycle), and — when the #114 archive lane is running — proves the indexer
# reconciles while consuming ONLY the private archive gateway. Loopback only;
# nothing is published.
#
# Set TORIUM_SKIP_ARCHIVE_RECONCILIATION=1 to skip the archive phase when the
# archive lane is deliberately not running.
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo_root=$(CDPATH= cd -- "$script_dir/../.." && pwd)
compose_file="$script_dir/compose.explorer.yaml"
rpc_url=http://127.0.0.1:8545
dev_faucet_url=http://127.0.0.1:8080
explorer_url=http://127.0.0.1:44000
toolchain="$repo_root/chain/toolchain.json"
foundry_image=$(jq -er '.contracts.foundry.image' "$toolchain")
archive_overlay="$script_dir/compose.archive-consumer.yaml"
archive_gateway_rpc=http://127.0.0.1:38545
archive_consumer_network=torium-localnet_archive-indexer-consumer
evidence_dir="$script_dir/.artifacts"
phase=prerequisites

for dependency in docker curl jq; do
  command -v "$dependency" >/dev/null 2>&1 || {
    echo "missing explorer evidence dependency: $dependency" >&2
    exit 1
  }
done

compose_explorer() {
  docker compose --file "$compose_file" "$@"
}

# The archive-consumer overlay routes the indexer through the #114 gateway. It
# is a separate invocation so the default stack keeps reading validator-0.
compose_archive_consumer() {
  docker compose --file "$compose_file" --file "$archive_overlay" "$@"
}

cast_cmd() {
  docker run --rm --network host --entrypoint cast "$foundry_image" "$@"
}

lowercase() {
  printf '%s' "$1" | tr '[:upper:]' '[:lower:]'
}

# wait_indexed <tx-hash> <timeout-seconds>
wait_indexed() {
  wait_deadline=$(( $(date +%s) + $2 ))
  while :; do
    if curl --fail --silent --max-time 5 \
      "$explorer_url/api?module=transaction&action=gettxinfo&txhash=$1" \
      >"$evidence_dir/tx-info.json" 2>/dev/null &&
      jq -e '.status == "1" and (.result.hash // "" | length) > 0' "$evidence_dir/tx-info.json" >/dev/null 2>&1; then
      return 0
    fi
    if [ "$(date +%s)" -ge "$wait_deadline" ]; then
      echo "transaction $1 was never indexed" >&2
      return 1
    fi
    sleep 3
  done
}

# wait_backend <timeout-seconds>
wait_backend() {
  backend_deadline=$(( $(date +%s) + $1 ))
  while :; do
    if curl --fail --silent --max-time 5 "$explorer_url/api?module=block&action=eth_block_number" \
      >/dev/null 2>&1; then
      return 0
    fi
    if [ "$(date +%s)" -ge "$backend_deadline" ]; then
      echo "explorer backend never answered" >&2
      return 1
    fi
    sleep 3
  done
}

cleanup() {
  cleanup_status=$?
  trap - EXIT INT TERM HUP
  if [ "$cleanup_status" -ne 0 ]; then
    compose_explorer logs --no-color --tail=200 backend >"$evidence_dir/backend-failure.log" 2>&1 || true
  fi
  compose_explorer down --volumes --remove-orphans >/dev/null 2>&1 || true
  if [ "$cleanup_status" -ne 0 ]; then
    echo "explorer stack evidence failed in phase '$phase'" >&2
  fi
  exit "$cleanup_status"
}
trap cleanup EXIT
trap 'exit 130' INT TERM HUP

mkdir -p "$evidence_dir"

phase=contract-validation
echo "[1/8] validate the explorer selection and stack contracts"
node "$repo_root/chain/explorer/validate-selection-v1.mjs" >/dev/null
node "$repo_root/chain/explorer/validate-stack-v0.mjs" >/dev/null
compose_explorer config --quiet
# Every image must be digest-pinned; a floating tag is a launch blocker.
compose_explorer config --format json |
  jq -e '[.services[].image] | all(test("@sha256:[0-9a-f]{64}$"))' >/dev/null

phase=chain-precondition
echo "[2/8] confirm the canonical localnet is serving"
cast_cmd chain-id --rpc-url "$rpc_url" >/dev/null

phase=stack-boot
echo "[3/8] boot the digest-pinned stack and reach the chain tip"
compose_explorer up --detach --wait database redis
compose_explorer up --detach backend
wait_backend 420
chain_tip=$(cast_cmd block-number --rpc-url "$rpc_url")
deadline=$(( $(date +%s) + 420 ))
while :; do
  indexed_hex=$(curl --fail --silent --max-time 5 \
    "$explorer_url/api?module=block&action=eth_block_number" | jq -r '.result // "0x0"')
  indexed=$(cast_cmd to-dec "$indexed_hex" 2>/dev/null || echo 0)
  if [ "$indexed" -ge "$chain_tip" ]; then
    break
  fi
  if [ "$(date +%s)" -ge "$deadline" ]; then
    echo "indexer never reached the chain tip (indexed $indexed, tip $chain_tip)" >&2
    exit 1
  fi
  sleep 5
done

phase=transaction-reconciliation
echo "[4/8] index a real transaction and reconcile it against canonical RPC"
recipient=$(cast_cmd wallet new --json | jq -er '.[0].address')
funding=$(curl --fail --silent --show-error --max-time 50 \
  -H 'content-type: application/json' \
  --data "$(jq -cn --arg address "$recipient" '{address:$address,amountBaseUnits:"1000000000000000000"}')" \
  "$dev_faucet_url/v1/fund")
transaction_hash=$(printf '%s' "$funding" | jq -er '.transactionHash')
wait_indexed "$transaction_hash" 300
canonical=$(cast_cmd tx "$transaction_hash" --rpc-url "$rpc_url" --json)
indexed_from=$(jq -r '.result.from' "$evidence_dir/tx-info.json")
indexed_to=$(jq -r '.result.to' "$evidence_dir/tx-info.json")
indexed_value=$(jq -r '.result.value' "$evidence_dir/tx-info.json")
if [ "$(lowercase "$indexed_from")" != "$(lowercase "$(printf '%s' "$canonical" | jq -r '.from')")" ]; then
  echo "indexed sender disagrees with canonical RPC" >&2
  exit 1
fi
if [ "$(lowercase "$indexed_to")" != "$(lowercase "$(printf '%s' "$canonical" | jq -r '.to')")" ]; then
  echo "indexed recipient disagrees with canonical RPC" >&2
  exit 1
fi
if [ "$indexed_value" != "$(cast_cmd to-dec "$(printf '%s' "$canonical" | jq -r '.value')")" ]; then
  echo "indexed value disagrees with canonical RPC" >&2
  exit 1
fi

phase=balance-and-asset-reconciliation
echo "[5/8] reconcile account balances and native tTOR metadata"
# The indexer's balance view must agree with canonical RPC for the address it
# just funded. Blockscout reports balances in base units, like eth_getBalance.
canonical_balance=$(cast_cmd balance "$recipient" --rpc-url "$rpc_url")
balance_deadline=$(( $(date +%s) + 300 ))
while :; do
  curl --fail --silent --max-time 5 \
    "$explorer_url/api?module=account&action=balance&address=$recipient" \
    >"$evidence_dir/balance.json" 2>/dev/null || true
  indexed_balance=$(jq -r '.result // ""' "$evidence_dir/balance.json" 2>/dev/null || echo "")
  if [ -n "$indexed_balance" ] && [ "$indexed_balance" = "$canonical_balance" ]; then
    break
  fi
  if [ "$(date +%s)" -ge "$balance_deadline" ]; then
    echo "indexed balance '${indexed_balance:-none}' never matched canonical $canonical_balance" >&2
    exit 1
  fi
  sleep 3
done
# The funded address must also be indexed as an address, not merely appear in a
# transaction: an address listing is what an explorer user actually reads.
curl --fail --silent --max-time 10 \
  "$explorer_url/api?module=account&action=txlist&address=$recipient" \
  >"$evidence_dir/address-txlist.json"
jq -e --arg hash "$transaction_hash" \
  '.status == "1" and ([.result[].hash] | index($hash) != null)' \
  "$evidence_dir/address-txlist.json" >/dev/null || {
  echo "the funded address was not indexed with its funding transaction" >&2
  exit 1
}
# Native asset metadata must match the reviewed identifiers, not a default.
# The localnet is a non-value network, so the reviewed symbol is the
# nonValueNetworks one (tTOR), never the mainnet ticker.
expected_symbol=$(jq -er '.currency.nonValueNetworks.symbol' "$repo_root/chain/config/identifiers.json")
compose_explorer config --format json |
  jq -e --arg symbol "$expected_symbol" \
    '.services.backend.environment.COIN == $symbol and .services.backend.environment.COIN_NAME == $symbol' \
  >/dev/null || {
  echo "the explorer native asset symbol differs from chain/config/identifiers.json ($expected_symbol)" >&2
  exit 1
}
expected_chain_id=$(cast_cmd chain-id --rpc-url "$rpc_url")
compose_explorer config --format json |
  jq -e --arg chainId "$expected_chain_id" '.services.backend.environment.CHAIN_ID == $chainId' \
  >/dev/null || {
  echo "the explorer CHAIN_ID differs from the canonical chain id $expected_chain_id" >&2
  exit 1
}

phase=rollback-recovery
echo "[6/8] roll back derived state and prove the indexer heals it"
# A CometBFT chain with single-slot finality cannot reorg, so the injectable
# failure is a rollback of DERIVED state: mark the top blocks non-consensus,
# which is exactly how Blockscout models a reorg, and require the indexer to
# re-derive canonical blocks for those heights.
rollback_from=$(( chain_tip > 5 ? chain_tip - 5 : 1 ))
psql_explorer() {
  compose_explorer exec -T database \
    psql --username blockscout --dbname blockscout --no-align --tuples-only --command "$1"
}
consensus_before=$(psql_explorer \
  "SELECT count(*) FROM blocks WHERE consensus = true AND number > $rollback_from;" | tr -d '[:space:]')
if [ "${consensus_before:-0}" -lt 1 ]; then
  echo "no consensus blocks above $rollback_from to roll back" >&2
  exit 1
fi
psql_explorer \
  "UPDATE blocks SET consensus = false WHERE number > $rollback_from;" >/dev/null
# Wait on the exact healed heights, not just a count: a restored count can be
# satisfied by other heights while the audited one is still missing.
rollback_check_height=$(( rollback_from + 1 ))
canonical_block_hash=$(cast_cmd block "$rollback_check_height" --rpc-url "$rpc_url" --json | jq -r '.hash')
rollback_deadline=$(( $(date +%s) + 420 ))
while :; do
  indexed_block_hash=$(psql_explorer \
    "SELECT '0x' || encode(hash, 'hex') FROM blocks WHERE number = $rollback_check_height AND consensus = true;" \
    | tr -d '[:space:]')
  healed=$(psql_explorer \
    "SELECT count(*) FROM blocks WHERE consensus = true AND number > $rollback_from;" | tr -d '[:space:]')
  if [ -n "$indexed_block_hash" ] &&
    [ "$(lowercase "$indexed_block_hash")" = "$(lowercase "$canonical_block_hash")" ] &&
    [ "${healed:-0}" -ge "$consensus_before" ]; then
    break
  fi
  if [ "$(date +%s)" -ge "$rollback_deadline" ]; then
    echo "derived state never healed after the rollback (healed ${healed:-0} of $consensus_before, block $rollback_check_height indexed as '${indexed_block_hash:-none}' vs canonical $canonical_block_hash)" >&2
    exit 1
  fi
  sleep 5
done
wait_indexed "$transaction_hash" 300

phase=reindex-lifecycle
echo "[7/8] discard the derived database and prove a full reindex"
compose_explorer down --volumes >/dev/null 2>&1
compose_explorer up --detach --wait database redis
compose_explorer up --detach backend
wait_backend 420
wait_indexed "$transaction_hash" 420


phase=archive-target-reconciliation
if [ "${TORIUM_SKIP_ARCHIVE_RECONCILIATION:-0}" = "1" ]; then
  echo "[8/8] SKIPPED archive-target reconciliation (TORIUM_SKIP_ARCHIVE_RECONCILIATION=1)"
  archive_reconciled=false
  archive_gateway_forwarded=0
  archive_gateway_refused=0
  archive_indexed_height=0
elif ! docker network inspect "$archive_consumer_network" >/dev/null 2>&1; then
  echo "[8/8] SKIPPED archive-target reconciliation: the #114 archive lane is not running" >&2
  echo "      start it with: make -C chain/localnet archive-up" >&2
  archive_reconciled=false
  archive_gateway_forwarded=0
  archive_gateway_refused=0
  archive_indexed_height=0
else
  echo "[8/8] reconcile through the private archive gateway only"
  # The overlay puts the backend on archive-indexer-consumer and points every
  # RPC URL at the gateway. It is NOT on archive-raw-rpc, so if the gateway
  # refuses something the indexer needs, the indexer cannot fall back — it will
  # simply fail to reach the tip, and this phase fails.
  gateway_before=$(curl --fail --silent --max-time 10 "$archive_gateway_rpc/metrics")
  archive_forwarded_before=$(printf '%s' "$gateway_before" |
    sed -n 's/^torium_archive_gateway_requests_total{transport="http",outcome="forwarded"} //p')
  archive_refused_before=$(printf '%s' "$gateway_before" |
    sed -n 's/^torium_archive_gateway_requests_total{transport="http",outcome="refused"} //p')

  # Prove the consumer really cannot see the raw archive RPC from where it runs.
  if compose_archive_consumer run --rm --no-deps --entrypoint sh backend \
    -c 'wget -q -T 5 -O /dev/null http://private-archive-indexer:8545/' >/dev/null 2>&1; then
    echo "the explorer backend can reach the raw archive RPC directly" >&2
    exit 1
  fi

  compose_archive_consumer up --detach --force-recreate backend
  wait_backend 420
  archive_tip=$(cast_cmd block-number --rpc-url "$rpc_url")
  archive_deadline=$(( $(date +%s) + 600 ))
  while :; do
    archive_hex=$(curl --fail --silent --max-time 5 \
      "$explorer_url/api?module=block&action=eth_block_number" | jq -r '.result // "0x0"')
    archive_indexed_height=$(cast_cmd to-dec "$archive_hex" 2>/dev/null || echo 0)
    if [ "$archive_indexed_height" -ge "$archive_tip" ]; then
      break
    fi
    if [ "$(date +%s)" -ge "$archive_deadline" ]; then
      compose_archive_consumer logs --no-color --tail=120 backend \
        >"$evidence_dir/archive-consumer-failure.log" 2>&1 || true
      docker logs --tail 200 "$(docker ps --filter name=archive-rpc-gateway --format '{{.Names}}' | head -1)" \
        >"$evidence_dir/archive-gateway-refusals.log" 2>&1 || true
      echo "the indexer never reached the tip through the gateway (indexed $archive_indexed_height, tip $archive_tip)" >&2
      exit 1
    fi
    sleep 5
  done
  # The transaction from phase 4 must still reconcile when the data path is the
  # gateway rather than validator-0.
  wait_indexed "$transaction_hash" 420
  archive_from=$(jq -r '.result.from' "$evidence_dir/tx-info.json")
  if [ "$(lowercase "$archive_from")" != "$(lowercase "$(printf '%s' "$canonical" | jq -r '.from')")" ]; then
    echo "the gateway-sourced sender disagrees with canonical RPC" >&2
    exit 1
  fi
  # Historical state through the gateway: the archive node retains every height,
  # so an old-height balance read must resolve. This is the archive property the
  # public RPC profile cannot provide.
  archive_history=$(curl --fail --silent --max-time 15 \
    -H 'content-type: application/json' \
    --data '{"jsonrpc":"2.0","id":1,"method":"eth_getBalance","params":["0x0000000000000000000000000000000000000000","0x1"]}' \
    "$archive_gateway_rpc")
  printf '%s' "$archive_history" | jq -e '.result != null and (.error | not)' >/dev/null || {
    echo "historical state at height 1 was unavailable through the gateway" >&2
    exit 1
  }
  gateway_after=$(curl --fail --silent --max-time 10 "$archive_gateway_rpc/metrics")
  archive_gateway_forwarded=$(( $(printf '%s' "$gateway_after" |
    sed -n 's/^torium_archive_gateway_requests_total{transport="http",outcome="forwarded"} //p') - ${archive_forwarded_before:-0} ))
  archive_gateway_refused=$(( $(printf '%s' "$gateway_after" |
    sed -n 's/^torium_archive_gateway_requests_total{transport="http",outcome="refused"} //p') - ${archive_refused_before:-0} ))
  if [ "$archive_gateway_forwarded" -le 0 ]; then
    echo "the gateway forwarded nothing, so the indexer did not consume it" >&2
    exit 1
  fi
  # Any refusal is recorded rather than treated as a failure: the indexer
  # probing an unsupported method is not a defect as long as it still reached
  # the tip and reconciled. The gateway log names each refused method.
  docker logs --tail 400 "$(docker ps --filter name=archive-rpc-gateway --format '{{.Names}}' | head -1)" \
    2>&1 | grep 'archive gateway refused a method' | tail -40 \
    >"$evidence_dir/archive-gateway-refusals.log" || true
  archive_reconciled=true
  # Restore the default data path so a later run starts from the documented
  # state rather than from this overlay.
  compose_explorer up --detach --force-recreate backend >/dev/null
  wait_backend 420
fi

jq -n \
  --arg transactionHash "$transaction_hash" \
  --arg recipient "$recipient" \
  --argjson chainTip "$chain_tip" \
  --argjson rollbackFrom "$rollback_from" \
  --argjson rollbackHealed "$consensus_before" \
  --argjson archiveReconciled "$archive_reconciled" \
  --argjson archiveIndexedHeight "$archive_indexed_height" \
  --argjson archiveGatewayForwarded "$archive_gateway_forwarded" \
  --argjson archiveGatewayRefused "$archive_gateway_refused" \
  '{
    schemaVersion: 1,
    evidence: "explorer-stack-activation-v0",
    result: "passed",
    stack: "blockscout v11.2.2 (digest-pinned) + postgres 17 + redis 7.4, loopback only",
    surfaces: ([
      "digest-pinned-compose",
      "indexer-reached-chain-tip",
      "transaction-indexed",
      "sender-recipient-value-reconciled-against-rpc",
      "account-balance-reconciled-against-rpc",
      "address-indexed-with-its-transaction",
      "native-ttor-metadata-matches-identifiers",
      "derived-state-rollback-healed-and-reconciled-against-rpc",
      "derived-database-discarded-and-rebuilt"
    ] + (if $archiveReconciled then [
      "indexer-reconciled-through-archive-gateway-only",
      "raw-archive-rpc-unreachable-from-the-indexer",
      "historical-state-served-through-the-gateway"
    ] else [] end)),
    archiveTargetReconciliation: {
      reconciled: $archiveReconciled,
      indexedHeightThroughGateway: $archiveIndexedHeight,
      gatewayForwardedDuringPhase: $archiveGatewayForwarded,
      gatewayRefusedDuringPhase: $archiveGatewayRefused
    },
    rollbackFromHeight: $rollbackFrom,
    rollbackHealedBlocks: $rollbackHealed,
    chainTipAtBoot: $chainTip,
    reconciledTransaction: $transactionHash,
    fundedRecipient: $recipient,
    publicExposure: false
  }'
