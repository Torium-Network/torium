#!/bin/sh
set -eu

suite_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo_root=$(CDPATH= cd -- "$suite_dir/../../.." && pwd)
app_dir="$repo_root/chain/app"
localnet_dir="$repo_root/chain/localnet"
localnet="$localnet_dir/torium-localnet"
base_compose="$localnet_dir/compose.yaml"
override_compose="$suite_dir/compose.override.yaml"
contract="$repo_root/chain/config/governance-v1.json"
fixture="$repo_root/chain/app/localnet/fixture.json"
manifest="$repo_root/chain/genesis/localnet/manifest.json"
solidity_fixture="$repo_root/chain/tests/e2e/fixtures/CompatibilityProbe.json"
artifacts="$suite_dir/.artifacts"
rpc_url=http://127.0.0.1:8545
rest_url=http://127.0.0.1:1317
pre_image=toriumd:upgrade-pre
post_image=toriumd:upgrade-post
failed_image=toriumd:upgrade-failed
image0=$pre_image
image1=$pre_image
image2=$pre_image
image3=$pre_image
phase=prerequisites

for dependency in docker curl jq make node; do
  command -v "$dependency" >/dev/null 2>&1 || {
    echo "missing governance-upgrade dependency: $dependency" >&2
    exit 1
  }
done
if ! command -v shasum >/dev/null 2>&1 && ! command -v sha256sum >/dev/null 2>&1; then
  echo "missing shasum or sha256sum" >&2
  exit 1
fi

mkdir -p "$artifacts"
rm -f "$artifacts"/*

compose() {
  TORIUM_UID=$(id -u) TORIUM_GID=$(id -g) \
  TORIUM_VALIDATOR_0_IMAGE=$image0 \
  TORIUM_VALIDATOR_1_IMAGE=$image1 \
  TORIUM_VALIDATOR_2_IMAGE=$image2 \
  TORIUM_VALIDATOR_3_IMAGE=$image3 \
    docker compose --file "$base_compose" --file "$override_compose" "$@"
}

cleanup() {
  status=$?
  if [ "$status" -ne 0 ]; then
    {
      echo "phase=$phase"
      compose ps --all || true
    } >"$artifacts/failure-status.txt" 2>&1
    compose logs --no-color --tail=500 >"$artifacts/failure-logs.txt" 2>&1 || true
  fi
  compose down --remove-orphans >/dev/null 2>&1 || true
  return "$status"
}
trap cleanup EXIT
trap 'exit 130' INT TERM HUP

sha256_stdin() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 | awk '{print $1}'
  else
    sha256sum | awk '{print $1}'
  fi
}

assert_equal() {
  actual=$1
  expected=$2
  label=$3
  if [ "$actual" != "$expected" ]; then
    echo "$label: expected '$expected', received '$actual'" >&2
    return 1
  fi
}

height() {
  port=${1:-26657}
  curl --fail --silent --show-error --max-time 3 "http://127.0.0.1:$port/status" |
    jq -er '.result.sync_info.latest_block_height | tonumber'
}

wait_height() {
  port=$1
  target=$2
  attempts=${3:-90}
  attempt=0
  while [ "$attempt" -lt "$attempts" ]; do
    current=$(height "$port" 2>/dev/null || echo 0)
    if [ "$current" -ge "$target" ]; then return; fi
    attempt=$((attempt + 1))
    sleep 1
  done
  echo "Comet RPC $port did not reach height $target" >&2
  return 1
}

wait_tx() {
  hash=$1
  attempt=0
  while [ "$attempt" -lt 45 ]; do
    response=$(curl --silent --show-error --max-time 3 \
      "http://127.0.0.1:26657/tx?hash=0x$hash&prove=false" 2>/dev/null || true)
    tx_height=$(printf '%s' "$response" | jq -er '.result.height // empty' 2>/dev/null || true)
    if [ -n "$tx_height" ]; then
      code=$(printf '%s' "$response" | jq -er '.result.tx_result.code // 0')
      [ "$code" -eq 0 ] || {
        echo "transaction $hash failed: $(printf '%s' "$response" | jq -r '.result.tx_result.log')" >&2
        return 1
      }
      printf '%s\n' "$tx_height"
      return
    fi
    attempt=$((attempt + 1))
    sleep 1
  done
  echo "transaction $hash was not committed" >&2
  return 1
}

wait_tx_failure() {
  hash=$1
  expected_log=$2
  attempt=0
  while [ "$attempt" -lt 45 ]; do
    response=$(curl --silent --show-error --max-time 3 \
      "http://127.0.0.1:26657/tx?hash=0x$hash&prove=false" 2>/dev/null || true)
    tx_height=$(printf '%s' "$response" | jq -er '.result.height // empty' 2>/dev/null || true)
    if [ -n "$tx_height" ]; then
      code=$(printf '%s' "$response" | jq -er '.result.tx_result.code // 0')
      log=$(printf '%s' "$response" | jq -r '.result.tx_result.log')
      [ "$code" -ne 0 ] || {
        echo "transaction $hash unexpectedly succeeded" >&2
        return 1
      }
      printf '%s' "$log" | grep -F "$expected_log" >/dev/null || {
        echo "transaction $hash failed for an unexpected reason: $log" >&2
        return 1
      }
      printf '%s\n' "$tx_height"
      return
    fi
    attempt=$((attempt + 1))
    sleep 1
  done
  echo "transaction $hash was not committed" >&2
  return 1
}

cli() {
  compose exec -T validator-0 toriumd "$@"
}

submit_proposal() {
  title=$1
  shift
  set -- tx gov submit-proposal "$@" \
    --title "$title" \
    --summary "$title local acceptance" \
    --metadata ipfs://torium-localnet-governance-rehearsal \
    --initial-deposit 10000000000000000000atorium \
    --from validator-0 \
    --home /tmp/torium-governance-keyring \
    --keyring-backend test \
    --chain-id torium-localnet-1 \
    --node tcp://127.0.0.1:26657 \
    --gas 1000000 \
    --fees 1000000000000000atorium \
    --broadcast-mode sync \
    --yes \
    --output json
  output=$(cli "$@")
  code=$(printf '%s' "$output" | jq -er '.code // 0')
  [ "$code" -eq 0 ] || {
    echo "proposal CheckTx failed: $(printf '%s' "$output" | jq -r '.raw_log')" >&2
    return 1
  }
  wait_tx "$(printf '%s' "$output" | jq -er '.txhash')" >/dev/null
  cli query gov proposals --node tcp://127.0.0.1:26657 --output json |
    jq -er '.proposals | max_by(.id | tonumber) | .id'
}

vote() {
  proposal=$1
  voter=$2
  output=$(cli tx gov vote "$proposal" yes \
    --from "$voter" \
    --home /tmp/torium-governance-keyring \
    --keyring-backend test \
    --chain-id torium-localnet-1 \
    --node tcp://127.0.0.1:26657 \
    --gas 300000 \
    --fees 300000000000000atorium \
    --broadcast-mode sync \
    --yes \
    --output json)
  code=$(printf '%s' "$output" | jq -er '.code // 0')
  [ "$code" -eq 0 ] || {
    echo "vote by $voter failed: $(printf '%s' "$output" | jq -r '.raw_log')" >&2
    return 1
  }
  wait_tx "$(printf '%s' "$output" | jq -er '.txhash')" >/dev/null
}

wait_proposal_status() {
  proposal=$1
  expected=$2
  attempt=0
  while [ "$attempt" -lt 60 ]; do
    proposal_json=$(cli query gov proposal "$proposal" --node tcp://127.0.0.1:26657 --output json 2>/dev/null || true)
    status=$(printf '%s' "$proposal_json" | jq -r '.proposal.status // empty' 2>/dev/null || true)
    if [ "$status" = "$expected" ]; then return; fi
    case "$status" in
      PROPOSAL_STATUS_PASSED|PROPOSAL_STATUS_REJECTED|PROPOSAL_STATUS_FAILED)
        echo "proposal $proposal reached $status, expected $expected" >&2
        return 1
        ;;
    esac
    attempt=$((attempt + 1))
    sleep 1
  done
  echo "proposal $proposal did not reach $expected" >&2
  return 1
}

wait_validators_halted() {
  expected_log=$1
  shift
  attempt=0
  while [ "$attempt" -lt 90 ]; do
    all_halted=true
    for validator in "$@"; do
      validator_log="$artifacts/$phase-$validator.log"
      if ! compose logs --no-color "$validator" >"$validator_log" 2>&1 ||
        ! grep -F "$expected_log" "$validator_log" >/dev/null; then
        all_halted=false
        break
      fi
    done
    if [ "$all_halted" = true ]; then
      # CometBFT deliberately keeps the RPC/process alive after the consensus
      # goroutine panics. Stop it only after every validator proves the same
      # deterministic halt reason; persisted state is checked by the caller.
      compose stop "$@" >/dev/null
      return
    fi
    attempt=$((attempt + 1))
    sleep 1
  done
  echo "validators did not halt with $expected_log" >&2
  for validator in "$@"; do
    validator_log="$artifacts/$phase-$validator.log"
    if ! grep -F "$expected_log" "$validator_log" >/dev/null 2>&1; then
      echo "$validator did not emit the expected halt reason" >&2
    fi
  done
  return 1
}

wait_cast_receipt() {
  hash=$1
  attempt=0
  while [ "$attempt" -lt 45 ]; do
    receipt=$(cast_cmd receipt "$hash" --rpc-url "$rpc_url" --json 2>/dev/null || true)
    if printf '%s' "$receipt" | jq -e '.status == "0x1"' >/dev/null 2>&1; then
      printf '%s\n' "$receipt"
      return
    fi
    attempt=$((attempt + 1))
    sleep 1
  done
  echo "EVM transaction $hash did not succeed" >&2
  return 1
}

foundry_image=$(jq -er '.testTool.image' "$solidity_fixture")
cast_cmd() {
  docker run --rm --network host --entrypoint cast "$foundry_image" "$@"
}

phase=contracts
echo "[1/10] validate contracts and build pre/post/failed immutable binary profiles"
node "$repo_root/chain/config/validate-governance-v1.mjs" >/dev/null
build_commit=$(git -C "$repo_root" rev-parse --short=12 HEAD)
make --no-print-directory -C "$app_dir" container-upgrade-pre COMMIT="$build_commit" BUILD_TIME=1970-01-01T00:00:00Z
make --no-print-directory -C "$app_dir" container-upgrade-post COMMIT="$build_commit" BUILD_TIME=1970-01-01T00:00:00Z
make --no-print-directory -C "$app_dir" container-upgrade-failed COMMIT="$build_commit" BUILD_TIME=1970-01-01T00:00:00Z
for profile in pre post failed-rehearsal; do
  case "$profile" in
    pre) image=$pre_image; expected_version=0.1.0-local.1 ;;
    post) image=$post_image; expected_version=0.2.0-local.1 ;;
    failed-rehearsal) image=$failed_image; expected_version=0.2.0-local.1 ;;
  esac
  metadata=$(docker run --rm --entrypoint toriumd "$image" version)
  printf '%s' "$metadata" | jq -e --arg profile "$profile" --arg version "$expected_version" \
    '.upgradeProfile == $profile and .version == $version' >/dev/null
  printf '%s\n' "$metadata" >"$artifacts/$profile-version.json"
done
post_sha=$(docker run --rm --entrypoint sha256sum "$post_image" /usr/local/bin/toriumd | awk '{print $1}')
failed_sha=$(docker run --rm --entrypoint sha256sum "$failed_image" /usr/local/bin/toriumd | awk '{print $1}')
[ "$post_sha" != "$failed_sha" ] || { echo "post and failed binaries unexpectedly share a checksum" >&2; exit 1; }

phase=boot
echo "[2/10] reset and boot four pre-upgrade validators"
compose down --remove-orphans >/dev/null 2>&1 || true
make --no-print-directory -C "$localnet_dir" reset >/dev/null
compose up --detach --remove-orphans validator-0 validator-1 validator-2 validator-3 >/dev/null
wait_height 26657 3
for port in 26757 26857 26957; do wait_height "$port" 3; done

keyring_home=/tmp/torium-governance-keyring
compose exec -T validator-0 rm -rf "$keyring_home"
for voter in validator-0 validator-1 validator-2 validator-3; do
  context=$(jq -er --arg name "$voter" '.accounts[] | select(.name == $name) | .derivation_context' "$fixture")
  private_key=$(printf '%s' "torium/localnet/valueless-fixture/v1/account/$context" | sha256_stdin)
  printf '%s\n' valueless-localnet | cli keys unsafe-import-eth-key "$voter" "$private_key" \
    --home "$keyring_home" --keyring-backend test >/dev/null
done
unset private_key

gov_authority=$(cli query upgrade authority --node tcp://127.0.0.1:26657 --output json | jq -er '.address')
assert_equal "$gov_authority" "torium10d07y265gmmuvt4z0w9aw880jnsr700jjk4usp" "governance authority"
initial_consensus_params=$(curl --fail --silent --show-error \
  "$rest_url/cosmos/consensus/v1/params" | jq -c '.params')
assert_equal "$(printf '%s' "$initial_consensus_params" | jq -er '.authority.authority')" \
  "$gov_authority" "consensus AuthorityParams authority"
initial_params=$(cli query gov params --node tcp://127.0.0.1:26657 --output json | jq -c '.params')
printf '%s' "$initial_params" | jq -e '
  .max_deposit_period == "30s" and .voting_period == "20s" and
  .expedited_voting_period == "10s" and .quorum == "0.667000000000000000" and
  .min_initial_deposit_ratio == "1.000000000000000000" and
  .min_deposit[0].amount == "10000000000000000000"
' >/dev/null

safe_params=$(printf '%s' "$initial_params" | jq -c '.proposal_cancel_ratio = "0.400000000000000000"')
safe_message=$(jq -cn --arg authority "$gov_authority" --argjson params "$safe_params" \
  '{"@type":"/cosmos.gov.v1.MsgUpdateParams",authority:$authority,params:$params}')

phase=unauthorized-and-no-quorum
echo "[3/10] reject direct privilege, authority transfer, short lead, and two-validator quorum"
unauthorized_message=$(jq -cn --arg authority "$(cli keys show validator-0 -a --home "$keyring_home" --keyring-backend test)" --argjson params "$safe_params" \
  '{"@type":"/cosmos.gov.v1.MsgUpdateParams",authority:$authority,params:$params}')
proposal_count_before=$(cli query gov proposals --node tcp://127.0.0.1:26657 --output json | jq -er '.proposals | length')
unauthorized_output=$(cli tx gov submit-proposal \
  --messages "$unauthorized_message" \
  --title "Unauthorized authority rejection" \
  --summary "Unauthorized authority rejection local acceptance" \
  --metadata ipfs://torium-localnet-governance-rehearsal \
  --initial-deposit 10000000000000000000atorium \
  --from validator-0 \
  --home "$keyring_home" \
  --keyring-backend test \
  --chain-id torium-localnet-1 \
  --node tcp://127.0.0.1:26657 \
  --gas 1000000 \
  --fees 1000000000000000atorium \
  --broadcast-mode sync \
  --yes \
  --output json)
assert_equal "$(printf '%s' "$unauthorized_output" | jq -er '.code // 0')" "0" "unauthorized proposal CheckTx"
wait_tx_failure "$(printf '%s' "$unauthorized_output" | jq -er '.txhash')" \
  "expected gov account as only signer for proposal message" >/dev/null
proposal_count_after=$(cli query gov proposals --node tcp://127.0.0.1:26657 --output json | jq -er '.proposals | length')
assert_equal "$proposal_count_after" "$proposal_count_before" "unauthorized proposal persistence"
assert_equal "$(cli query gov params --node tcp://127.0.0.1:26657 --output json | jq -er '.params.proposal_cancel_ratio')" \
  "0.500000000000000000" "unauthorized authority parameter"

rogue_authority=$(cli keys show validator-0 -a --home "$keyring_home" --keyring-backend test)
account_json=$(curl --fail --silent --show-error "$rest_url/cosmos/auth/v1beta1/accounts/$rogue_authority")
account_number=$(printf '%s' "$account_json" | jq -er '[.. | objects | .account_number? | select(. != null)][0]')
account_sequence=$(printf '%s' "$account_json" | jq -er '[.. | objects | .sequence? | select(. != null)][0]')
authority_raw_tx=$(cd "$app_dir" && ./scripts/run-in-toolchain.sh go run \
  ../tests/governance-upgrade/authority_tx.go \
  --account-number "$account_number" \
  --sequence "$account_sequence" \
  --governance-authority "$gov_authority" \
  --rogue-authority "$rogue_authority")
authority_broadcast=$(curl --fail --silent --show-error --get \
  "http://127.0.0.1:26657/broadcast_tx_sync" --data-urlencode "tx=$authority_raw_tx")
assert_equal "$(printf '%s' "$authority_broadcast" | jq -er '.result.code // 0')" "0" \
  "consensus authority proposal CheckTx"
wait_tx "$(printf '%s' "$authority_broadcast" | jq -er '.result.hash')" >/dev/null
authority_transfer_id=$(cli query gov proposals --node tcp://127.0.0.1:26657 --output json |
  jq -er '.proposals | max_by(.id | tonumber) | .id')
wait_proposal_status "$authority_transfer_id" PROPOSAL_STATUS_VOTING_PERIOD
vote "$authority_transfer_id" validator-0
vote "$authority_transfer_id" validator-1
vote "$authority_transfer_id" validator-2
wait_proposal_status "$authority_transfer_id" PROPOSAL_STATUS_FAILED
authority_failure_reason=$(cli query gov proposal "$authority_transfer_id" \
  --node tcp://127.0.0.1:26657 --output json | jq -er '.proposal.failed_reason')
printf '%s' "$authority_failure_reason" |
  grep -F 'Torium consensus AuthorityParams cannot change' >/dev/null
after_transfer_consensus_params=$(curl --fail --silent --show-error \
  "$rest_url/cosmos/consensus/v1/params" | jq -c '.params')
assert_equal "$after_transfer_consensus_params" "$initial_consensus_params" "rejected consensus authority transfer"

short_lead_height=$(( $(height 26657) + 5 ))
short_lead_message=$(jq -cn --arg authority "$gov_authority" --arg height "$short_lead_height" '
  {
    "@type":"/cosmos.upgrade.v1beta1.MsgSoftwareUpgrade",
    authority:$authority,
    plan:{name:"torium-local-v1",height:$height,info:"{}"}
  }')
short_lead_id=$(submit_proposal "Short upgrade lead rejection" --messages "$short_lead_message")
wait_proposal_status "$short_lead_id" PROPOSAL_STATUS_VOTING_PERIOD
vote "$short_lead_id" validator-0
vote "$short_lead_id" validator-1
vote "$short_lead_id" validator-2
wait_proposal_status "$short_lead_id" PROPOSAL_STATUS_FAILED
short_lead_failure_reason=$(cli query gov proposal "$short_lead_id" \
  --node tcp://127.0.0.1:26657 --output json | jq -er '.proposal.failed_reason')
printf '%s' "$short_lead_failure_reason" |
  grep -F 'must be at least 10 blocks after execution height' >/dev/null
if cli query upgrade plan --node tcp://127.0.0.1:26657 --output json 2>/dev/null |
  jq -e '.plan != null' >/dev/null; then
  echo "short-lead upgrade unexpectedly scheduled a plan" >&2
  exit 1
fi

rejected_id=$(submit_proposal "Two-validator quorum rejection" --messages "$safe_message")
wait_proposal_status "$rejected_id" PROPOSAL_STATUS_VOTING_PERIOD
vote "$rejected_id" validator-0
vote "$rejected_id" validator-1
wait_proposal_status "$rejected_id" PROPOSAL_STATUS_REJECTED
assert_equal "$(cli query gov params --node tcp://127.0.0.1:26657 --output json | jq -er '.params.proposal_cancel_ratio')" \
  "0.500000000000000000" "rejected proposal parameter"

phase=proposal
echo "[4/10] pass three-validator parameter and named upgrade proposal"
current_height=$(height 26657)
plan_height=$((current_height + 50))
migration_sha=$(printf '%s' 'torium-local-v1:add-marker-store;run-module-migrations;write-marker-v1;preserve-native-supply' | sha256_stdin)
plan_info=$(jq -cn \
  --arg planName torium-local-v1 \
  --arg targetVersion 0.2.0-local.1 \
  --arg binarySha256 "$post_sha" \
  --arg protocolVersion 1.0.0-local.5 \
  --arg migrationSha256 "$migration_sha" \
  '{schemaVersion:1,planName:$planName,targetVersion:$targetVersion,binarySha256:$binarySha256,protocolVersion:$protocolVersion,migrationSha256:$migrationSha256}')
printf '%s\n' "$plan_info" >"$artifacts/plan-info.json"
node "$repo_root/chain/operator/verify-upgrade-binary.mjs" \
  --plan-info "$artifacts/plan-info.json" --docker-image "$post_image" \
  >"$artifacts/post-binary-preflight.json"
if node "$repo_root/chain/operator/verify-upgrade-binary.mjs" \
  --plan-info "$artifacts/plan-info.json" --docker-image "$failed_image" \
  >"$artifacts/wrong-binary-preflight.txt" 2>&1; then
  echo "wrong-checksum binary unexpectedly passed operator preflight" >&2
  exit 1
fi
grep -F 'does not match plan' "$artifacts/wrong-binary-preflight.txt" >/dev/null
upgrade_message=$(jq -cn --arg authority "$gov_authority" --arg name torium-local-v1 \
  --arg height "$plan_height" --arg info "$plan_info" \
  '{"@type":"/cosmos.upgrade.v1beta1.MsgSoftwareUpgrade",authority:$authority,plan:{name:$name,height:$height,info:$info}}')
upgrade_id=$(submit_proposal "Torium local v1 upgrade" --messages "$safe_message" --messages "$upgrade_message")
wait_proposal_status "$upgrade_id" PROPOSAL_STATUS_VOTING_PERIOD
vote "$upgrade_id" validator-0
vote "$upgrade_id" validator-1
vote "$upgrade_id" validator-2
wait_proposal_status "$upgrade_id" PROPOSAL_STATUS_PASSED
proposal_execution_height=$(height 26657)
if [ $((plan_height - proposal_execution_height)) -lt 10 ]; then
  echo "passed upgrade did not preserve the enforced ten-block scheduling lead" >&2
  exit 1
fi
assert_equal "$(cli query gov params --node tcp://127.0.0.1:26657 --output json | jq -er '.params.proposal_cancel_ratio')" \
  "0.400000000000000000" "passed proposal parameter"
scheduled=$(cli query upgrade plan --node tcp://127.0.0.1:26657 --output json)
printf '%s' "$scheduled" | jq -e --arg height "$plan_height" --arg info "$plan_info" \
  '.plan.name == "torium-local-v1" and .plan.height == $height and .plan.info == $info' >/dev/null

phase=state-before
echo "[5/10] capture accounts, supply, staking, module versions, and contract state"
deployer_key=$(printf '%s' 'torium/localnet/valueless-fixture/v1/account/deployer' | sha256_stdin)
creation_bytecode=$(jq -er '.creationBytecode' "$solidity_fixture")
deploy_hash=$(cast_cmd send --gas-limit 500000 --private-key "$deployer_key" --rpc-url "$rpc_url" --async --create "$creation_bytecode")
deploy_receipt=$(wait_cast_receipt "$deploy_hash")
contract_address=$(printf '%s' "$deploy_receipt" | jq -er '.contractAddress')
set_hash=$(cast_cmd send "$contract_address" 'setValue(uint256)' 106 --gas-limit 200000 --private-key "$deployer_key" --rpc-url "$rpc_url" --async)
wait_cast_receipt "$set_hash" >/dev/null
assert_equal "$(cast_cmd call "$contract_address" 'value()(uint256)' --rpc-url "$rpc_url")" "106" "pre-upgrade contract state"

sample_account=$(jq -er '.development_accounts[] | select(.name == "sdk-user") | .bech32_address' "$manifest")
before_supply=$(curl --fail --silent --show-error "$rest_url/cosmos/bank/v1beta1/supply/by_denom?denom=atorium" | jq -cS '.amount')
before_balance=$(curl --fail --silent --show-error "$rest_url/cosmos/bank/v1beta1/balances/$sample_account/by_denom?denom=atorium" | jq -cS '.balance')
before_validators=$(cli query staking validators --node tcp://127.0.0.1:26657 --output json | jq -cS '[.validators[] | {operator_address,status,tokens,delegator_shares}]')
before_modules=$(cli query upgrade module-versions --node tcp://127.0.0.1:26657 --output json | jq -cS '.module_versions')

phase=premature
echo "[6/10] reject post-upgrade binary before the scheduled height"
image3=$post_image
compose stop validator-3 >/dev/null
compose rm --force --stop validator-3 >/dev/null
compose up --detach --no-deps validator-3 >/dev/null
attempt=0
while [ "$attempt" -lt 20 ]; do
  if compose ps --status exited -q validator-3 | grep . >/dev/null; then break; fi
  attempt=$((attempt + 1))
  sleep 1
done
compose logs --no-color validator-3 | grep -F 'BINARY UPDATED BEFORE TRIGGER' >/dev/null
image3=$pre_image
compose rm --force --stop validator-3 >/dev/null
compose up --detach --no-deps validator-3 >/dev/null
wait_height 26957 "$(height 26657)"

phase=old-halt
echo "[7/10] halt every old binary exactly at the named plan height"
wait_height 26657 $((plan_height - 1)) 120
wait_validators_halted 'UPGRADE \"torium-local-v1\" NEEDED' validator-0 validator-1 validator-2 validator-3
pre_state=$(cd "$app_dir" && ./scripts/run-in-toolchain.sh go run ./cmd/torium-localnet-state state \
  --root ../localnet/.state/container)
printf '%s' "$pre_state" | jq -e --arg height "$((plan_height - 1))" \
  '.chain.height == ($height | tonumber)' >/dev/null
pre_upgrade_app_hash=$(printf '%s' "$pre_state" | jq -er '.chain.appHash')
for validator in validator-0 validator-1 validator-2 validator-3; do
  jq -e --arg height "$plan_height" --arg info "$plan_info" \
    '.name == "torium-local-v1" and .height == ($height | tonumber) and .info == $info' \
    "$localnet_dir/.state/container/$validator/data/upgrade-info.json" >/dev/null
done

phase=failed-migration
echo "[8/10] prove failed migration commits nothing, then prove two upgraded validators cannot progress"
image0=$failed_image
image1=$failed_image
image2=$failed_image
compose rm --force --stop validator-0 validator-1 validator-2 >/dev/null
compose up --detach --no-deps validator-0 validator-1 validator-2 >/dev/null
wait_validators_halted 'intentional Torium failed-migration rehearsal' validator-0 validator-1 validator-2
failed_state=$(cd "$app_dir" && ./scripts/run-in-toolchain.sh go run ./cmd/torium-localnet-state state \
  --root ../localnet/.state/container)
printf '%s' "$failed_state" | jq -e --arg height "$((plan_height - 1))" --arg appHash "$pre_upgrade_app_hash" '
  .chain.height == ($height | tonumber) and (.chain.appHash | ascii_downcase) == ($appHash | ascii_downcase)
' >/dev/null

image0=$post_image
image1=$post_image
image2=$post_image
image3=$post_image
compose rm --force --stop validator-0 validator-1 >/dev/null
compose up --detach --no-deps validator-0 validator-1 >/dev/null
wait_height 26657 $((plan_height - 1))
two_validator_height=$(height 26657)
sleep 8
assert_equal "$(height 26657)" "$two_validator_height" "two-validator upgraded quorum halt"

phase=partial-upgrade
echo "[9/10] resume with three validators, catch up the fourth, and verify state preservation"
compose rm --force --stop validator-2 >/dev/null
compose up --detach --no-deps validator-2 >/dev/null
wait_height 26657 $((plan_height + 2)) 120
for port in 26757 26857; do wait_height "$port" $((plan_height + 2)) 120; done
block_results=$(curl --fail --silent --show-error "http://127.0.0.1:26657/block_results?height=$plan_height")
printf '%s' "$block_results" | jq -e --arg migration "$migration_sha" '
  [.. | objects | select(.type? == "torium_upgrade_applied")][0].attributes |
  any(.key == "migration_sha256" and .value == $migration)
' >/dev/null

marker_json=""
for port in 26657 26757 26857; do
  marker_response=$(curl --fail --silent --show-error --get "http://127.0.0.1:$port/abci_query" \
    --data-urlencode 'path="/store/toriumupgrade/key"' \
    --data-urlencode 'data=0x01' \
    --data-urlencode 'prove=false')
  validator_marker=$(printf '%s' "$marker_response" | jq -er '.result.response.value | @base64d')
  if [ -z "$marker_json" ]; then marker_json=$validator_marker; fi
  assert_equal "$validator_marker" "$marker_json" "committed upgrade marker at RPC $port"
done
printf '%s\n' "$marker_json" >"$artifacts/upgrade-marker.json"
printf '%s' "$marker_json" | jq -e \
  --arg height "$plan_height" \
  --arg migration "$migration_sha" \
  --arg supply "$(printf '%s' "$before_supply" | jq -er '.amount')" '
  .schemaVersion == 1 and
  .planName == "torium-local-v1" and
  .height == ($height | tonumber) and
  .targetVersion == "0.2.0-local.1" and
  .protocolVersion == "1.0.0-local.5" and
  .migrationSha256 == $migration and
  .nativeSupplyBaseUnits == $supply and
  (.fromModuleVersionsSha256 | test("^[0-9a-f]{64}$")) and
  (.toModuleVersionsSha256 | test("^[0-9a-f]{64}$"))
' >/dev/null

compose rm --force --stop validator-3 >/dev/null
compose up --detach --no-deps validator-3 >/dev/null
catchup_height=$(height 26657)
wait_height 26957 "$catchup_height" 120
for port in 26657 26757 26857 26957; do
  wait_height "$port" "$catchup_height" 120
  app_hash=$(curl --fail --silent --show-error "http://127.0.0.1:$port/block?height=$catchup_height" | jq -er '.result.block.header.app_hash')
  if [ -z "${common_app_hash:-}" ]; then common_app_hash=$app_hash; fi
  assert_equal "$app_hash" "$common_app_hash" "post-upgrade app hash at $port"
done
marker_response=$(curl --fail --silent --show-error --get "http://127.0.0.1:26957/abci_query" \
  --data-urlencode 'path="/store/toriumupgrade/key"' \
  --data-urlencode 'data=0x01' \
  --data-urlencode 'prove=false')
validator_marker=$(printf '%s' "$marker_response" | jq -er '.result.response.value | @base64d')
assert_equal "$validator_marker" "$marker_json" "caught-up validator committed upgrade marker"

applied=$(cli query upgrade applied torium-local-v1 --node tcp://127.0.0.1:26657 --output json)
assert_equal "$(printf '%s' "$applied" | jq -er '.height')" "$plan_height" "applied upgrade height"
after_modules=$(cli query upgrade module-versions --node tcp://127.0.0.1:26657 --output json | jq -cS '.module_versions')
assert_equal "$after_modules" "$before_modules" "module version map"
after_supply=$(curl --fail --silent --show-error "$rest_url/cosmos/bank/v1beta1/supply/by_denom?denom=atorium" | jq -cS '.amount')
after_balance=$(curl --fail --silent --show-error "$rest_url/cosmos/bank/v1beta1/balances/$sample_account/by_denom?denom=atorium" | jq -cS '.balance')
after_validators=$(cli query staking validators --node tcp://127.0.0.1:26657 --output json | jq -cS '[.validators[] | {operator_address,status,tokens,delegator_shares}]')
assert_equal "$after_supply" "$before_supply" "native total supply"
assert_equal "$after_balance" "$before_balance" "sample account balance"
assert_equal "$after_validators" "$before_validators" "staking validator set"
assert_equal "$(cast_cmd call "$contract_address" 'value()(uint256)' --rpc-url "$rpc_url")" "106" "post-upgrade contract state"
for validator in validator-0 validator-1 validator-2 validator-3; do
  profile=$(compose exec -T "$validator" toriumd version | jq -er '.upgradeProfile')
  assert_equal "$profile" post "$validator post-upgrade profile"
done

phase=recovery
echo "[10/10] materialize and inspect a post-upgrade recovery fixture"
archive="$artifacts/post-upgrade.tar.gz"
TORIUM_IMAGE=$post_image "$localnet" snapshot --backend container --fixture post-upgrade --output "$archive" >/dev/null
inspection=$($localnet inspect --backend container --archive "$archive")
printf '%s' "$inspection" | jq -e --arg height "$plan_height" '
  .manifest.fixture == "post-upgrade" and
  .manifest.binary.upgradeProfile == "post" and
  .manifest.chain.height > ($height | tonumber) and
  (.archiveSha256 | test("^[0-9a-f]{64}$"))
' >/dev/null

cat >"$artifacts/summary.json" <<EOF
{
  "plan": "torium-local-v1",
  "planHeight": $plan_height,
  "preUpgradeAppHash": "$pre_upgrade_app_hash",
  "postUpgradeAppHash": "$common_app_hash",
  "postBinarySha256": "$post_sha",
  "failedBinarySha256": "$failed_sha",
  "migrationSha256": "$migration_sha",
  "proposalExecutionHeight": $proposal_execution_height,
  "contractAddress": "$contract_address",
  "authorityTransferProposalId": "$authority_transfer_id",
  "shortLeadProposalId": "$short_lead_id",
  "rejectedProposalId": "$rejected_id",
  "passedProposalId": "$upgrade_id",
  "postUpgradeRecovery": "post-upgrade"
}
EOF

echo "Torium governance and four-validator upgrade acceptance passed at height $plan_height."
