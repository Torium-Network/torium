#!/bin/sh
# Torium public faucet (#172) acceptance: executes the held test plan from
# the reviewed public faucet service contract against a real localnet —
# finalized funding, concurrency/replay bypass attempts, RPC-outage and
# restart drills, and pause/rotation/refill/drain rehearsals.
set -eu

suite_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo_root=$(CDPATH= cd -- "$suite_dir/../../.." && pwd)
localnet_dir="$repo_root/chain/localnet"
localnet="$localnet_dir/torium-localnet"
toolchain="$repo_root/chain/toolchain.json"
manifest="$repo_root/chain/genesis/localnet/manifest.json"
rpc_url=http://127.0.0.1:8545
dev_faucet_url=http://127.0.0.1:8080
pf_url=http://127.0.0.1:8090
pf_admin_url=http://127.0.0.1:8091
one_ttor=1000000000000000000
foundry_image=$(jq -er '.contracts.foundry.image' "$toolchain")
phase=prerequisites
diagnostics_dir=""

for dependency in docker curl jq make node; do
  command -v "$dependency" >/dev/null 2>&1 || {
    echo "missing Torium public faucet acceptance dependency: $dependency" >&2
    exit 1
  }
done

export PF_SUITE_DIR="$suite_dir"
export PF_CHALLENGE_TOKEN="rehearsal-$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n')"
export PF_STATE=a
export PF_KEY_FILE=signer.key
export TORIUM_UID=$(id -u)
export TORIUM_GID=$(id -g)

compose_pf() {
  docker compose --file "$localnet_dir/compose.yaml" --file "$suite_dir/compose.override.yaml" "$@"
}

compose_base() {
  docker compose --file "$localnet_dir/compose.yaml" "$@"
}

cast_cmd() {
  docker run --rm --network host --entrypoint cast "$foundry_image" "$@"
}

lowercase() {
  printf '%s' "$1" | tr '[:upper:]' '[:lower:]'
}

assert_equal() {
  if [ "$1" != "$2" ]; then
    echo "$3: expected '$2', received '$1'" >&2
    return 1
  fi
}

# post_fund <address> <idempotency-key> <output-file> [challenge-token]
post_fund() {
  curl --silent --show-error --max-time 20 \
    --output "$3" \
    --write-out '%{http_code}' \
    -H 'content-type: application/json' \
    --data "$(jq -cn --arg address "$1" --arg key "$2" --arg token "${4:-$PF_CHALLENGE_TOKEN}" \
      '{address:$address,idempotencyKey:$key,challengeToken:$token}')" \
    "$pf_url/v1/fund"
}

# poll_terminal <request-id> <timeout-seconds>
poll_terminal() {
  poll_deadline=$(( $(date +%s) + $2 ))
  while :; do
    poll_body=$(curl --fail --silent --max-time 5 "$pf_url/v1/requests/$1")
    poll_status=$(printf '%s' "$poll_body" | jq -er '.status')
    case "$poll_status" in
      confirmed|failed|denied)
        printf '%s' "$poll_body"
        return 0
        ;;
    esac
    if [ "$(date +%s)" -ge "$poll_deadline" ]; then
      echo "request $1 did not reach a terminal state; last: $poll_body" >&2
      return 1
    fi
    sleep 1
  done
}

# dev_faucet_fund <address> <amount-base-units> — retries through the dev
# faucet's 30s cooldown so refill rehearsals are deterministic.
dev_faucet_fund() {
  fund_deadline=$(( $(date +%s) + 120 ))
  while :; do
    fund_status=$(curl --silent --show-error --max-time 50 \
      --output "$work_dir/dev-faucet-response.json" \
      --write-out '%{http_code}' \
      -H 'content-type: application/json' \
      --data "$(jq -cn --arg address "$1" --arg amount "$2" '{address:$address,amountBaseUnits:$amount}')" \
      "$dev_faucet_url/v1/fund")
    if [ "$fund_status" = "201" ]; then
      return 0
    fi
    if [ "$(date +%s)" -ge "$fund_deadline" ]; then
      echo "dev faucet refill failed with status $fund_status: $(cat "$work_dir/dev-faucet-response.json")" >&2
      return 1
    fi
    sleep 5
  done
}

wait_pf_health() {
  health_deadline=$(( $(date +%s) + 60 ))
  while :; do
    if health_body=$(curl --silent --max-time 3 "$pf_url/healthz") &&
      printf '%s' "$health_body" | jq -e --arg status "$1" '.status == $status' >/dev/null 2>&1; then
      printf '%s' "$health_body"
      return 0
    fi
    if [ "$(date +%s)" -ge "$health_deadline" ]; then
      echo "public faucet never reported status '$1'; last: ${health_body:-unreachable}" >&2
      return 1
    fi
    sleep 1
  done
}

verify_journal() {
  compose_pf exec -T public-faucet torium-public-faucet verify-journal --data-dir /var/lib/torium-public-faucet
}

capture_diagnostics() {
  diagnostics_dir="$suite_dir/.artifacts/diag-$(date -u +%Y%m%dT%H%M%SZ)-$$"
  mkdir -p "$diagnostics_dir"
  printf '%s\n' "$phase" >"$diagnostics_dir/phase.txt"
  compose_pf ps -a >"$diagnostics_dir/compose-ps.txt" 2>&1 || true
  compose_pf logs --no-color --tail=300 public-faucet >"$diagnostics_dir/public-faucet.log" 2>&1 || true
  curl --silent --max-time 3 "$pf_url/healthz" >"$diagnostics_dir/healthz.json" 2>&1 || true
  curl --silent --max-time 3 "$pf_admin_url/metrics" >"$diagnostics_dir/metrics.txt" 2>&1 || true
  cp -R "$suite_dir/.artifacts/state" "$diagnostics_dir/state" 2>/dev/null || true
}

cleanup() {
  cleanup_status=$?
  trap - EXIT INT TERM HUP
  if [ "$cleanup_status" -ne 0 ]; then
    capture_diagnostics || true
  fi
  compose_pf down --remove-orphans >/dev/null 2>&1 || true
  "$localnet" stop --backend container >/dev/null 2>&1 || true
  rm -rf "$work_dir" 2>/dev/null || true
  if [ "$cleanup_status" -ne 0 ]; then
    echo "Torium public faucet acceptance failed in phase '$phase'; diagnostics: ${diagnostics_dir:-unavailable}" >&2
  fi
  exit "$cleanup_status"
}

trap cleanup EXIT
trap 'exit 130' INT TERM HUP

mkdir -p "$suite_dir/.artifacts"
work_dir=$(mktemp -d "$suite_dir/.artifacts/work.XXXXXX")
rm -rf "$suite_dir/.artifacts/keys" "$suite_dir/.artifacts/state"
mkdir -p "$suite_dir/.artifacts/keys" \
  "$suite_dir/.artifacts/state/a" "$suite_dir/.artifacts/state/b" "$suite_dir/.artifacts/state/c"

phase=contract-validation
echo "[1/8] validate the reviewed service contract"
node "$repo_root/chain/config/validate-public-faucet-service-v0.mjs" >/dev/null
compose_pf config --quiet

phase=localnet-boot
echo "[2/8] reset and boot the canonical localnet"
"$localnet" reset --backend container --yes >/dev/null
readiness=$("$localnet" start --backend container --timeout 180 --json)
printf '%s' "$readiness" | jq -e '.ready == true and .chain.evmChainID == 1414484556' >/dev/null

phase=signer-provision
echo "[3/8] provision the dedicated signer and start the public faucet"
wallet=$(cast_cmd wallet new --json)
signer_address=$(printf '%s' "$wallet" | jq -er '.[0].address')
printf '%s\n' "$(printf '%s' "$wallet" | jq -er '.[0].private_key')" >"$suite_dir/.artifacts/keys/signer.key"
chmod 600 "$suite_dir/.artifacts/keys/signer.key"
dev_faucet_fund "$signer_address" "4000000000000000000"
assert_equal "$(cast_cmd balance "$signer_address" --rpc-url "$rpc_url")" "4000000000000000000" "provisioned signer balance"
compose_pf up --detach --wait public-faucet
health=$(wait_pf_health ready)
printf '%s' "$health" | jq -e --arg signer "$(lowercase "$signer_address")" '
  (.signerAddress | ascii_downcase) == $signer and
  .network == "torium-localnet-1" and
  .evmChainId == "1414484556" and
  .challengeMode == "static-local" and
  .publicDeploymentAllowed == false and
  (.notice | test("valueless"; "i")) and
  .amountPerRequestBaseUnits == "1000000000000000000" and
  .perAddressDailyCap == 1
' >/dev/null

phase=finalized-funding
echo "[4/8] prove one real finalized funding transaction with full receipts"
recipient=$(cast_cmd wallet new --json | jq -er '.[0].address')
status=$(post_fund "$recipient" "acceptance-fund-0001" "$work_dir/fund.json")
assert_equal "$status" "202" "public faucet accept HTTP status"
request_id=$(jq -er '.id' "$work_dir/fund.json")
jq -e '.status == "queued" and (.notice | test("valueless"; "i"))' "$work_dir/fund.json" >/dev/null
terminal=$(poll_terminal "$request_id" 60)
printf '%s' "$terminal" | jq -e '.status == "confirmed"' >/dev/null
transaction_hash=$(printf '%s' "$terminal" | jq -er '.transactionHash')
transaction=$(cast_cmd tx "$transaction_hash" --rpc-url "$rpc_url" --json)
assert_equal "$(printf '%s' "$transaction" | jq -er '.chainId')" "0x544f524c" "funding replay domain"
assert_equal "$(lowercase "$(printf '%s' "$transaction" | jq -er '.from')")" "$(lowercase "$signer_address")" "funding sender"
assert_equal "$(lowercase "$(printf '%s' "$transaction" | jq -er '.to')")" "$(lowercase "$recipient")" "funding recipient"
assert_equal "$(cast_cmd to-dec "$(printf '%s' "$transaction" | jq -er '.value')")" "$one_ttor" "funding value"
assert_equal "$(cast_cmd balance "$recipient" --rpc-url "$rpc_url")" "$one_ttor" "funded recipient balance"
verify_journal >/dev/null
challenge_status=$(post_fund "$recipient" "acceptance-fund-0002" "$work_dir/bad-challenge.json" "wrong-token")
assert_equal "$challenge_status" "403" "wrong challenge HTTP status"
not_found=$(curl --silent --output /dev/null --write-out '%{http_code}' "$pf_url/v1/requests/does-not-exist")
assert_equal "$not_found" "404" "unknown request HTTP status"
cors_origin=$(curl --silent --output /dev/null --dump-header - "$pf_url/healthz" |
  tr -d '\r' | awk -F': ' 'tolower($1) == "access-control-allow-origin" { print $2 }')
assert_equal "$cors_origin" "http://127.0.0.1:8090" "CORS allowed origin"

phase=concurrency-and-replay
echo "[5/8] prove budget and idempotency cannot be bypassed by races or replays"
replay_target=$(cast_cmd wallet new --json | jq -er '.[0].address')
for index in 1 2 3 4 5 6; do
  post_fund "$replay_target" "race-key-0001" "$work_dir/race-$index.json" >"$work_dir/race-$index.code" &
done
wait
unique_ids=$(cat "$work_dir"/race-[1-6].json | jq -rs '[.[].id] | unique | length')
assert_equal "$unique_ids" "1" "concurrent replays collapse to one request"
race_id=$(jq -er '.id' "$work_dir/race-1.json")
poll_terminal "$race_id" 60 | jq -e '.status == "confirmed"' >/dev/null
nonce_after_race=$(cast_cmd nonce "$signer_address" --rpc-url "$rpc_url")
assert_equal "$nonce_after_race" "2" "signer nonce after replay race (exactly two funding transactions)"
assert_equal "$(cast_cmd balance "$replay_target" --rpc-url "$rpc_url")" "$one_ttor" "replay target funded exactly once"

cooldown_status=$(post_fund "$replay_target" "race-key-0002" "$work_dir/cooldown.json")
assert_equal "$cooldown_status" "429" "cooldown HTTP status"
jq -e '.error == "address is in cooldown"' "$work_dir/cooldown.json" >/dev/null

for index in 1 2 3 4 5 6; do
  budget_address=$(cast_cmd wallet new --json | jq -er '.[0].address')
  printf '%s\n' "$budget_address" >>"$work_dir/budget-addresses.txt"
  post_fund "$budget_address" "budget-key-000$index" "$work_dir/budget-$index.json" >"$work_dir/budget-$index.code" &
done
wait
accepted=0
denied=0
for index in 1 2 3 4 5 6; do
  code=$(cat "$work_dir/budget-$index.code")
  if [ "$code" = "202" ]; then
    accepted=$((accepted + 1))
    poll_terminal "$(jq -er '.id' "$work_dir/budget-$index.json")" 60 | jq -e '.status == "confirmed"' >/dev/null
  else
    # Losing racers are refused either by the atomic limiter (429) or by the
    # budget breaker pre-check (503); both are terminal denials, and the
    # nonce assertion below proves none of them produced a transaction.
    case "$code" in
      429|503) denied=$((denied + 1)) ;;
      *) assert_equal "$code" "429-or-503" "over-budget request HTTP status" ;;
    esac
  fi
done
assert_equal "$accepted" "1" "remaining daily budget admits exactly one more request"
assert_equal "$denied" "5" "requests beyond the budget are denied"
assert_equal "$(cast_cmd nonce "$signer_address" --rpc-url "$rpc_url")" "3" "signer nonce equals total confirmed requests"
replay_again=$(post_fund "$replay_target" "race-key-0001" "$work_dir/replay-final.json")
assert_equal "$replay_again" "200" "replay after confirmation HTTP status"
jq -e '.replayed == true and .status == "confirmed"' "$work_dir/replay-final.json" >/dev/null
assert_equal "$(cast_cmd nonce "$signer_address" --rpc-url "$rpc_url")" "3" "replay does not create a new transaction"
degraded=$(wait_pf_health degraded)
printf '%s' "$degraded" | jq -e '.breakerOpenReason == "global daily budget is exhausted"' >/dev/null

phase=rpc-outage-and-restart
echo "[6/8] drill an RPC outage with a hard service restart in the middle"
compose_pf kill public-faucet >/dev/null 2>&1
compose_pf rm --force --stop public-faucet >/dev/null 2>&1
dev_faucet_fund "$signer_address" "4000000000000000000"
export PF_STATE=b
compose_pf up --detach --wait public-faucet
wait_pf_health ready >/dev/null
compose_base kill validator-0
outage_recipient=$(cast_cmd wallet new --json | jq -er '.[0].address')
outage_status=$(post_fund "$outage_recipient" "outage-key-0001" "$work_dir/outage.json")
assert_equal "$outage_status" "202" "request accepted inside the outage window"
outage_id=$(jq -er '.id' "$work_dir/outage.json")
degraded=$(wait_pf_health degraded)
printf '%s' "$degraded" | jq -e '.breakerOpenReason == "RPC breaker is open"' >/dev/null
blocked_status=$(post_fund "$outage_recipient" "outage-key-0002" "$work_dir/outage-blocked.json")
assert_equal "$blocked_status" "503" "breaker-open requests are refused"
pending=$(curl --fail --silent --max-time 5 "$pf_url/v1/requests/$outage_id" | jq -er '.status')
case "$pending" in
  queued|submitted) : ;;
  *) echo "outage request should be wedged, found status '$pending'" >&2; exit 1 ;;
esac
compose_pf kill public-faucet
compose_pf up --detach public-faucet
status_after_restart=$(curl --fail --silent --max-time 10 --retry 10 --retry-delay 1 --retry-connrefused "$pf_url/v1/requests/$outage_id" | jq -er '.status')
case "$status_after_restart" in
  queued|submitted) : ;;
  *) echo "journal must preserve the wedged request across a hard restart, found '$status_after_restart'" >&2; exit 1 ;;
esac
compose_base start validator-0
poll_terminal "$outage_id" 120 | jq -e '.status == "confirmed"' >/dev/null
assert_equal "$(cast_cmd balance "$outage_recipient" --rpc-url "$rpc_url")" "$one_ttor" "outage recipient funded exactly once after recovery"
wait_pf_health ready >/dev/null
verify_journal >/dev/null

phase=nonce-contention
echo "[7/8] race an external transaction from the same signer against a funding request"
contention_recipient=$(cast_cmd wallet new --json | jq -er '.[0].address')
signer_key=$(cat "$suite_dir/.artifacts/keys/signer.key")
cast_cmd send "$signer_address" --value 1 --rpc-url "$rpc_url" --private-key "$signer_key" --async >/dev/null &
contention_status=$(post_fund "$contention_recipient" "contention-key-01" "$work_dir/contention.json")
wait
assert_equal "$contention_status" "202" "contention request accepted"
poll_terminal "$(jq -er '.id' "$work_dir/contention.json")" 120 | jq -e '.status == "confirmed"' >/dev/null
assert_equal "$(cast_cmd balance "$contention_recipient" --rpc-url "$rpc_url")" "$one_ttor" "contention recipient funded exactly once"
verify_journal >/dev/null

phase=pause-rotation-refill
echo "[8/8] rehearse pause, drain, refill, resume, and key rotation with fencing"
compose_pf kill public-faucet >/dev/null 2>&1
compose_pf rm --force --stop public-faucet >/dev/null 2>&1
export PF_STATE=c
compose_pf up --detach --wait public-faucet
wait_pf_health ready >/dev/null
drill_recipient=$(cast_cmd wallet new --json | jq -er '.[0].address')
drill_status=$(post_fund "$drill_recipient" "drill-key-00001" "$work_dir/drill.json")
assert_equal "$drill_status" "202" "pre-pause drill request accepted"
drill_id=$(jq -er '.id' "$work_dir/drill.json")
poll_terminal "$drill_id" 60 | jq -e '.status == "confirmed"' >/dev/null
curl --fail --silent --max-time 10 -X POST -H 'content-type: application/json' \
  --data '{"reason":"quarterly-drill"}' "$pf_admin_url/admin/pause" | jq -e '.paused == true' >/dev/null
paused=$(wait_pf_health paused)
printf '%s' "$paused" | jq -e '.pauseReason == "quarterly-drill"' >/dev/null
pause_reject=$(post_fund "$contention_recipient" "paused-key-0001" "$work_dir/paused.json")
assert_equal "$pause_reject" "429" "paused service refuses funding"
jq -e '.error == "service is paused"' "$work_dir/paused.json" >/dev/null
curl --fail --silent --max-time 5 "$pf_url/v1/requests/$drill_id" |
  jq -e '.status == "confirmed"' >/dev/null

reserve_address=$(jq -er '.development_accounts[] | select(.name == "faucet") | .evm_address' "$manifest")
drain=$(curl --fail --silent --max-time 60 -X POST -H 'content-type: application/json' \
  --data "$(jq -cn --arg to "$reserve_address" '{reserveAddress:$to}')" "$pf_admin_url/admin/drain")
printf '%s' "$drain" | jq -e '.drained == true' >/dev/null
drained_balance=$(cast_cmd balance "$signer_address" --rpc-url "$rpc_url")
if [ "$drained_balance" -ge 1000000000000000 ] 2>/dev/null; then
  echo "drain left an unexpected hot balance: $drained_balance" >&2
  exit 1
fi
floor_deadline=$(( $(date +%s) + 30 ))
until curl --silent --max-time 3 "$pf_url/healthz" |
  jq -e '.status == "paused" and .balanceBelowHaltThreshold == true and .breakerOpenReason == "hot balance is below the halt floor"' >/dev/null 2>&1; do
  if [ "$(date +%s)" -ge "$floor_deadline" ]; then
    echo "balance-floor breaker never opened after the drain" >&2
    exit 1
  fi
  sleep 1
done

dev_faucet_fund "$signer_address" "4000000000000000000"
refill_deadline=$(( $(date +%s) + 30 ))
until grep -q "refill-observed" "$suite_dir/.artifacts/state/c/journal.jsonl" 2>/dev/null; do
  if [ "$(date +%s)" -ge "$refill_deadline" ]; then
    echo "refill was never journaled as observed" >&2
    exit 1
  fi
  sleep 1
done
curl --fail --silent --max-time 10 -X POST "$pf_admin_url/admin/resume" | jq -e '.paused == false' >/dev/null
wait_pf_health ready >/dev/null
resume_recipient=$(cast_cmd wallet new --json | jq -er '.[0].address')
resume_status=$(post_fund "$resume_recipient" "resume-key-0001" "$work_dir/resume.json")
assert_equal "$resume_status" "202" "resumed service accepts funding"
poll_terminal "$(jq -er '.id' "$work_dir/resume.json")" 60 | jq -e '.status == "confirmed"' >/dev/null

rotation_wallet=$(cast_cmd wallet new --json)
new_signer_address=$(printf '%s' "$rotation_wallet" | jq -er '.[0].address')
printf '%s\n' "$(printf '%s' "$rotation_wallet" | jq -er '.[0].private_key')" >"$suite_dir/.artifacts/keys/signer-2.key"
chmod 600 "$suite_dir/.artifacts/keys/signer-2.key"
rotate=$(curl --fail --silent --max-time 10 -X POST -H 'content-type: application/json' \
  --data '{"keyFile":"/keys/signer-2.key"}' "$pf_admin_url/admin/rotate")
printf '%s' "$rotate" | jq -e --arg new "$(lowercase "$new_signer_address")" \
  '.rotated == true and (.newSigner | ascii_downcase) == $new' >/dev/null
curl --fail --silent --max-time 5 "$pf_url/healthz" |
  jq -e --arg new "$(lowercase "$new_signer_address")" '(.signerAddress | ascii_downcase) == $new' >/dev/null

# Fencing: a restart with the rotated-out key must refuse to start.
compose_pf kill public-faucet
export PF_KEY_FILE=signer.key
compose_pf up --detach public-faucet
sleep 3
fence_state=$(compose_pf ps -a --format json public-faucet | jq -rs '.[0].State')
assert_equal "$fence_state" "exited" "fenced key must not boot the service"
compose_pf logs --no-color public-faucet | grep -q "fenced" || {
  echo "fenced startup refusal was not logged" >&2
  exit 1
}
compose_pf rm --force --stop public-faucet >/dev/null 2>&1
export PF_KEY_FILE=signer-2.key
compose_pf up --detach --wait public-faucet
dev_faucet_fund "$new_signer_address" "2000000000000000000"
wait_pf_health ready >/dev/null
rotated_recipient=$(cast_cmd wallet new --json | jq -er '.[0].address')
rotated_status=$(post_fund "$rotated_recipient" "rotated-key-0001" "$work_dir/rotated.json")
assert_equal "$rotated_status" "202" "rotated service accepts funding"
rotated_terminal=$(poll_terminal "$(jq -er '.id' "$work_dir/rotated.json")" 60)
printf '%s' "$rotated_terminal" | jq -e '.status == "confirmed"' >/dev/null
rotated_tx=$(cast_cmd tx "$(printf '%s' "$rotated_terminal" | jq -er '.transactionHash')" --rpc-url "$rpc_url" --json)
assert_equal "$(lowercase "$(printf '%s' "$rotated_tx" | jq -er '.from')")" "$(lowercase "$new_signer_address")" "post-rotation funding signer"
verify_journal >/dev/null

jq -n \
  --arg result passed \
  --arg firstTransaction "$transaction_hash" \
  --arg signer "$signer_address" \
  --arg rotatedSigner "$new_signer_address" \
  '{
    schemaVersion: 1,
    suite: "public-faucet-acceptance",
    result: $result,
    network: "torium-localnet-1",
    evmChainId: 1414484556,
    heldTestPlan: [
      "finalized-funding-transaction",
      "concurrency-replay-budget-bypass",
      "rpc-outage-nonce-restart-drills",
      "pause-rotation-refill-rehearsals"
    ],
    firstTransaction: $firstTransaction,
    initialSigner: $signer,
    rotatedSigner: $rotatedSigner,
    publicDeploymentAllowed: false
  }'
