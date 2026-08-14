#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
POC_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
REPORT_PATH="${REPORT_PATH:-${POC_DIR}/proof/blockscout.json}"
PROJECT="torium-blockscout-baseline"
COMPOSE_FILE="${POC_DIR}/blockscout-compose.yml"
COMPOSE=(docker compose --project-name "${PROJECT}" --file "${COMPOSE_FILE}")

for command in docker curl jq; do
  command -v "${command}" >/dev/null || {
    echo "Missing required command: ${command}" >&2
    exit 1
  }
done

rpc() {
  curl --silent --show-error \
    --header 'content-type: application/json' \
    --data "$1" \
    http://127.0.0.1:8545
}

stats() {
  curl --fail --silent --show-error http://127.0.0.1:44000/api/v2/stats
}

sql() {
  "${COMPOSE[@]}" exec --no-TTY database \
    psql --tuples-only --no-align --username blockscout --dbname blockscout \
    --command "$1"
}

wait_for_index() {
  local minimum_height="$1"
  for attempt in $(seq 1 180); do
    local current_stats
    current_stats="$(stats 2>/dev/null || true)"
    local indexed_height
    indexed_height="$(sql 'select coalesce(max(number), 0) from blocks;' 2>/dev/null || true)"
    local api_height
    api_height="$(printf '%s' "${current_stats}" | jq -r '.total_blocks // "0"' 2>/dev/null || echo 0)"
    if [[
      -n "${current_stats}" &&
      "${indexed_height:-0}" -ge "${minimum_height}" &&
      "${api_height:-0}" -ge "${minimum_height}"
    ]]; then
      printf '%s' "${current_stats}"
      return 0
    fi
    sleep 2
  done
  "${COMPOSE[@]}" logs --tail 300 backend >&2
  echo "Blockscout did not catch up to height ${minimum_height}" >&2
  return 1
}

# Remove only earlier containers from this named PoC and then create a new
# Compose project and database volume. No production or unrelated container is
# addressed by this script.
docker rm --force torium-blockscout-backend torium-blockscout-db >/dev/null 2>&1 || true
"${COMPOSE[@]}" down --volumes --remove-orphans >/dev/null 2>&1 || true
"${COMPOSE[@]}" up --detach

tip_hex="$(rpc '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}' | jq -r '.result')"
tip_decimal="$((16#${tip_hex#0x}))"
minimum_height="$((tip_decimal > 2 ? tip_decimal - 2 : tip_decimal))"
fresh_stats="$(wait_for_index "${minimum_height}")"
fresh_blocks="$(sql 'select count(*) from blocks;')"
fresh_transactions="$(sql 'select count(*) from transactions;')"

"${COMPOSE[@]}" restart backend >/dev/null
restart_stats="$(wait_for_index "${minimum_height}")"
restart_blocks="$(sql 'select count(*) from blocks;')"
restart_transactions="$(sql 'select count(*) from transactions;')"

target_block="$(sql 'select greatest(max(number) - 5, 1) from blocks;')"
before_updated_at="$(sql "select updated_at from blocks where number = ${target_block};")"
sql "update blocks set refetch_needed = true where number = ${target_block};" >/dev/null

reindex_cleared="false"
after_updated_at="${before_updated_at}"
for attempt in $(seq 1 120); do
  marker="$(sql "select refetch_needed from blocks where number = ${target_block};" 2>/dev/null || true)"
  after_updated_at="$(sql "select updated_at from blocks where number = ${target_block};" 2>/dev/null || true)"
  if [[ "${marker}" == "f" && "${after_updated_at}" != "${before_updated_at}" ]]; then
    reindex_cleared="true"
    break
  fi
  sleep 2
done

trace_block="$(sql 'select block_number from transactions order by block_number desc limit 1;')"
trace_block_hex="$(printf '0x%x' "${trace_block}")"
trace_response="$(rpc "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"debug_traceBlockByNumber\",\"params\":[\"${trace_block_hex}\",{\"tracer\":\"callTracer\"}]}")"
trace_entry_keys="$(printf '%s' "${trace_response}" | jq -c '.result[0] | keys')"

jq --null-input \
  --arg generatedAt "$(date -u +'%Y-%m-%dT%H:%M:%SZ')" \
  --arg release "v11.2.2" \
  --arg commit "731015d88d7e73623f2a3c097e241bc82b04ea7a" \
  --argjson freshStats "${fresh_stats}" \
  --arg freshBlocks "${fresh_blocks}" \
  --arg freshTransactions "${fresh_transactions}" \
  --argjson restartStats "${restart_stats}" \
  --arg restartBlocks "${restart_blocks}" \
  --arg restartTransactions "${restart_transactions}" \
  --arg targetBlock "${target_block}" \
  --arg beforeUpdatedAt "${before_updated_at}" \
  --arg afterUpdatedAt "${after_updated_at}" \
  --argjson reindexCleared "${reindex_cleared}" \
  --arg traceBlock "${trace_block}" \
  --argjson traceEntryKeys "${trace_entry_keys}" \
  '{
    schemaVersion: 1,
    generatedAt: $generatedAt,
    blockscout: { release: $release, commit: $commit },
    profile: { internalTransactionFetcherDisabled: true },
    freshIndex: {
      apiStats: $freshStats,
      databaseBlocks: ($freshBlocks | tonumber),
      databaseTransactions: ($freshTransactions | tonumber)
    },
    restart: {
      apiStats: $restartStats,
      databaseBlocks: ($restartBlocks | tonumber),
      databaseTransactions: ($restartTransactions | tonumber),
      preserved: (($restartBlocks | tonumber) >= ($freshBlocks | tonumber) and ($restartTransactions | tonumber) >= ($freshTransactions | tonumber))
    },
    controlledReindex: {
      block: ($targetBlock | tonumber),
      markerCleared: $reindexCleared,
      beforeUpdatedAt: $beforeUpdatedAt,
      afterUpdatedAt: $afterUpdatedAt
    },
    internalTransactions: {
      state: "unsupported",
      traceBlock: ($traceBlock | tonumber),
      cosmosEvmTraceEntryKeys: $traceEntryKeys,
      blockscoutRequiredEntryKeys: ["result", "txHash"],
      reason: "Cosmos EVM v0.7.0 trace-by-block entries omit txHash; Blockscout v11.2.2 raises FunctionClauseError in its geth trace extractor."
    }
  }' >"${REPORT_PATH}"

if [[ "${reindex_cleared}" != "true" ]]; then
  cat "${REPORT_PATH}"
  echo "Controlled Blockscout reindex marker was not cleared" >&2
  exit 1
fi

cat "${REPORT_PATH}"
