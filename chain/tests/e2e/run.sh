#!/bin/sh
set -eu

suite_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo_root=$(CDPATH= cd -- "$suite_dir/../../.." && pwd)
localnet_dir="$repo_root/chain/localnet"
localnet="$localnet_dir/torium-localnet"
manifest="$repo_root/chain/genesis/localnet/manifest.json"
toolchain="$repo_root/chain/toolchain.json"
fixture="$suite_dir/fixtures/CompatibilityProbe.json"
fixture_source="$suite_dir/contracts/CompatibilityProbe.sol"
rpc_url=http://127.0.0.1:8545
foundry_image=""
diagnostics_dir=""
phase="prerequisites"

for dependency in docker curl jq make; do
  command -v "$dependency" >/dev/null 2>&1 || {
    echo "missing Torium E2E dependency: $dependency" >&2
    exit 1
  }
done
if ! command -v shasum >/dev/null 2>&1 && ! command -v sha256sum >/dev/null 2>&1; then
  echo "missing Torium E2E dependency: shasum or sha256sum" >&2
  exit 1
fi
foundry_image=$(jq -er '.testTool.image' "$fixture")

compose() {
  docker compose --file "$localnet_dir/compose.yaml" "$@"
}

cast_cmd() {
  docker run --rm --network host --entrypoint cast "$foundry_image" "$@"
}

sha256_file() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    sha256sum "$1" | awk '{print $1}'
  fi
}

sha256_stdin() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 | awk '{print $1}'
  else
    sha256sum | awk '{print $1}'
  fi
}

lowercase() {
  printf '%s' "$1" | tr '[:upper:]' '[:lower:]'
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

assert_hash() {
  value=$1
  label=$2
  case "$value" in
    0x[0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F]*)
      [ "${#value}" -eq 66 ] || {
        echo "$label is not a 32-byte hash: $value" >&2
        return 1
      }
      ;;
    *)
      echo "$label is not a 0x-prefixed hash: $value" >&2
      return 1
      ;;
  esac
}

hex_to_decimal() {
  cast_cmd to-dec "$1"
}

rpc_response() {
  rpc_method=$1
  rpc_params=$2
  rpc_payload=$(jq -cn \
    --arg method "$rpc_method" \
    --argjson params "$rpc_params" \
    '{jsonrpc:"2.0",id:1,method:$method,params:$params}')
  curl --fail --silent --show-error --max-time 5 \
    -H 'content-type: application/json' \
    --data "$rpc_payload" \
    "$rpc_url"
}

wait_for_receipt() {
  receipt_hash=$1
  receipt_attempt=0
  while [ "$receipt_attempt" -lt 45 ]; do
    receipt_response=$(rpc_response eth_getTransactionReceipt "[\"$receipt_hash\"]" 2>/dev/null || true)
    if [ -n "$receipt_response" ]; then
      receipt_error=$(printf '%s' "$receipt_response" | jq -r '.error.message // empty' 2>/dev/null || true)
      if [ -n "$receipt_error" ]; then
        echo "receipt lookup for $receipt_hash failed: $receipt_error" >&2
        return 1
      fi
      receipt_result=$(printf '%s' "$receipt_response" | jq -cer '.result // empty' 2>/dev/null || true)
      if [ -n "$receipt_result" ]; then
        printf '%s\n' "$receipt_result"
        return
      fi
    fi
    receipt_attempt=$((receipt_attempt + 1))
    sleep 1
  done
  echo "transaction $receipt_hash did not receive a receipt within 45 seconds" >&2
  return 1
}

wait_for_finalized() {
  finalized_target=$1
  finalized_attempt=0
  while [ "$finalized_attempt" -lt 30 ]; do
    finalized_response=$(rpc_response eth_getBlockByNumber '["finalized",false]' 2>/dev/null || true)
    finalized_hex=$(printf '%s' "$finalized_response" | jq -er '.result.number // empty' 2>/dev/null || true)
    if [ -n "$finalized_hex" ]; then
      finalized_height=$(hex_to_decimal "$finalized_hex")
      if [ "$finalized_height" -ge "$finalized_target" ]; then
        printf '%s\n' "$finalized_height"
        return
      fi
    fi
    finalized_attempt=$((finalized_attempt + 1))
    sleep 1
  done
  echo "finalized block tag did not reach height $finalized_target within 30 seconds" >&2
  return 1
}

wait_for_contract_value() {
  state_address=$1
  state_expected=$2
  state_attempt=0
  state_observed=""
  while [ "$state_attempt" -lt 30 ]; do
    state_observed=$(cast_cmd call "$state_address" 'value()(uint256)' --rpc-url "$rpc_url" 2>/dev/null || true)
    if [ "$state_observed" = "$state_expected" ]; then
      printf '%s\n' "$state_observed"
      return
    fi
    state_attempt=$((state_attempt + 1))
    sleep 1
  done
  echo "contract $state_address did not expose persisted value $state_expected within 30 seconds; last value: ${state_observed:-unavailable}" >&2
  return 1
}

comet_height() {
  curl --fail --silent --show-error --max-time 3 "http://127.0.0.1:$1/status" |
    jq -er '.result.sync_info.latest_block_height | tonumber'
}

wait_for_comet_height() {
  comet_port=$1
  comet_target=$2
  comet_attempt=0
  while [ "$comet_attempt" -lt 30 ]; do
    comet_current=$(comet_height "$comet_port" 2>/dev/null || echo 0)
    if [ "$comet_current" -ge "$comet_target" ]; then return; fi
    comet_attempt=$((comet_attempt + 1))
    sleep 1
  done
  echo "CometBFT RPC $comet_port did not reach height $comet_target within 30 seconds" >&2
  return 1
}

comet_fingerprint() {
  curl --fail --silent --show-error --max-time 3 \
    "http://127.0.0.1:$1/block?height=$2" |
    jq -cer '.result.block.header | {height,app_hash,validators_hash,next_validators_hash,consensus_hash}'
}

assert_committed_on_all_validators() {
  commit_height=$1
  commit_expected=""
  for commit_port in 26657 26757 26857 26957; do
    wait_for_comet_height "$commit_port" "$commit_height"
    commit_observed=$(comet_fingerprint "$commit_port" "$commit_height")
    if [ -z "$commit_expected" ]; then
      commit_expected=$commit_observed
    else
      assert_equal "$commit_observed" "$commit_expected" "validator block fingerprint at height $commit_height"
    fi
  done
}

verify_receipt() {
  verify_receipt_json=$1
  verify_hash=$2
  verify_status=$3
  verify_label=$4
  assert_equal "$(printf '%s' "$verify_receipt_json" | jq -er '.transactionHash')" "$verify_hash" "$verify_label transaction hash"
  assert_equal "$(printf '%s' "$verify_receipt_json" | jq -er '.status')" "$verify_status" "$verify_label receipt status"
  assert_hash "$(printf '%s' "$verify_receipt_json" | jq -er '.blockHash')" "$verify_label block hash"
  verify_gas=$(hex_to_decimal "$(printf '%s' "$verify_receipt_json" | jq -er '.gasUsed')")
  verify_price=$(hex_to_decimal "$(printf '%s' "$verify_receipt_json" | jq -er '.effectiveGasPrice')")
  [ "$verify_gas" -gt 0 ] || { echo "$verify_label used no gas" >&2; return 1; }
  [ "$verify_price" -gt 0 ] || { echo "$verify_label has no effective gas price" >&2; return 1; }
}

verify_transaction_and_block() {
  verify_tx_json=$1
  verify_block_json=$2
  verify_receipt_json=$3
  verify_label=$4
  verify_receipt_block_hash=$(printf '%s' "$verify_receipt_json" | jq -er '.blockHash')
  verify_receipt_block_number=$(printf '%s' "$verify_receipt_json" | jq -er '.blockNumber')
  assert_equal "$(printf '%s' "$verify_tx_json" | jq -er '.blockHash')" "$verify_receipt_block_hash" "$verify_label transaction block hash"
  assert_equal "$(printf '%s' "$verify_tx_json" | jq -er '.blockNumber')" "$verify_receipt_block_number" "$verify_label transaction block number"
  assert_equal "$(printf '%s' "$verify_block_json" | jq -er '.hash')" "$verify_receipt_block_hash" "$verify_label fetched block hash"
  verify_hash=$(printf '%s' "$verify_tx_json" | jq -er '.hash')
  printf '%s' "$verify_block_json" | jq -e --arg hash "$verify_hash" '.transactions | index($hash) != null' >/dev/null || {
    echo "$verify_label transaction is absent from its reported block" >&2
    return 1
  }

  verify_gas=$(hex_to_decimal "$(printf '%s' "$verify_receipt_json" | jq -er '.gasUsed')")
  verify_effective=$(hex_to_decimal "$(printf '%s' "$verify_receipt_json" | jq -er '.effectiveGasPrice')")
  verify_limit=$(hex_to_decimal "$(printf '%s' "$verify_tx_json" | jq -er '.gas')")
  verify_max_fee=$(hex_to_decimal "$(printf '%s' "$verify_tx_json" | jq -er '.maxFeePerGas')")
  verify_base_fee=$(hex_to_decimal "$(printf '%s' "$verify_block_json" | jq -er '.baseFeePerGas')")
  assert_equal "$(printf '%s' "$verify_tx_json" | jq -er '.gasPrice')" "$(printf '%s' "$verify_receipt_json" | jq -er '.effectiveGasPrice')" "$verify_label gas price"
  [ "$verify_gas" -le "$verify_limit" ] || { echo "$verify_label gas used exceeds its limit" >&2; return 1; }
  [ "$verify_effective" -ge "$verify_base_fee" ] || { echo "$verify_label effective fee is below block base fee" >&2; return 1; }
  [ "$verify_effective" -le "$verify_max_fee" ] || { echo "$verify_label effective fee exceeds max fee" >&2; return 1; }
  verify_charged_fee=$((verify_gas * verify_effective))
  [ "$verify_charged_fee" -gt 0 ] || { echo "$verify_label charged fee is not positive" >&2; return 1; }

  verify_height=$(hex_to_decimal "$verify_receipt_block_number")
  wait_for_finalized "$verify_height" >/dev/null
  assert_committed_on_all_validators "$verify_height"
}

capture_diagnostics() {
  diagnostics_dir="$suite_dir/.artifacts/$(date -u +%Y%m%dT%H%M%SZ)-$$"
  mkdir -p "$diagnostics_dir/configs"
  date -u +%Y-%m-%dT%H:%M:%SZ >"$diagnostics_dir/captured-at.txt"
  git -C "$repo_root" rev-parse HEAD >"$diagnostics_dir/git-head.txt" 2>&1 || true
  docker version >"$diagnostics_dir/docker-version.txt" 2>&1 || true
  docker compose version >"$diagnostics_dir/compose-version.txt" 2>&1 || true
  cast_cmd --version >"$diagnostics_dir/foundry-version.txt" 2>&1 || true
  compose ps -a >"$diagnostics_dir/compose-ps.txt" 2>&1 || true
  compose logs --no-color --tail=500 >"$diagnostics_dir/validator-logs.txt" 2>&1 || true
  compose logs --no-color --tail=200 faucet >"$diagnostics_dir/faucet-logs.txt" 2>&1 || true
  compose exec -T validator-0 toriumd version >"$diagnostics_dir/toriumd-version.txt" 2>&1 || true
  "$localnet" status --backend container --json >"$diagnostics_dir/health.json" 2>&1 || true
  cp "$localnet_dir/.state/container/topology.json" "$diagnostics_dir/topology.json" 2>/dev/null || true
  for diagnostics_node in validator-0 validator-1 validator-2 validator-3; do
    mkdir -p "$diagnostics_dir/configs/$diagnostics_node"
    for diagnostics_file in app.toml client.toml config.toml genesis.json; do
      cp "$localnet_dir/.state/container/$diagnostics_node/config/$diagnostics_file" \
        "$diagnostics_dir/configs/$diagnostics_node/$diagnostics_file" 2>/dev/null || true
    done
  done
  for diagnostics_port in 26657 26757 26857 26957; do
    curl --silent --show-error --max-time 3 "http://127.0.0.1:$diagnostics_port/status" \
      >"$diagnostics_dir/status-$diagnostics_port.json" 2>&1 || true
    curl --silent --show-error --max-time 3 "http://127.0.0.1:$diagnostics_port/net_info" \
      >"$diagnostics_dir/peers-$diagnostics_port.json" 2>&1 || true
  done
  jq -n \
    --arg phase "${phase:-unknown}" \
    --arg foundryImage "$foundry_image" \
    --arg genesisSha256 "$(jq -r '.genesis_sha256' "$manifest")" \
    --arg fixtureSha256 "$(sha256_file "$fixture")" \
    --arg sourceSha256 "$(sha256_file "$fixture_source")" \
    --arg contractAddress "${contract_address:-}" \
    --arg transferHash "${transfer_hash:-}" \
    --arg nativeFacadeHash "${native_facade_hash:-}" \
    --arg deployHash "${deploy_hash:-}" \
    --arg callHash "${set_hash:-}" \
    --arg revertHash "${revert_hash:-}" \
    --arg postRestartHash "${post_restart_hash:-}" \
    '{
      schemaVersion: 1,
      phase: $phase,
      foundryImage: $foundryImage,
      genesisSha256: $genesisSha256,
      fixtureSha256: $fixtureSha256,
      sourceSha256: $sourceSha256,
      contractAddress: $contractAddress,
      transactions: {
        nativeTransfer: $transferHash,
        nativeFacadeTransfer: $nativeFacadeHash,
        contractDeployment: $deployHash,
        contractCall: $callHash,
        expectedRevert: $revertHash,
        postRestartCall: $postRestartHash
      }
    }' \
    >"$diagnostics_dir/reproduction.json" 2>/dev/null || true
}

cleanup() {
  cleanup_status=$?
  trap - EXIT INT TERM HUP
  if [ "$cleanup_status" -ne 0 ]; then
    capture_diagnostics || true
  fi
  "$localnet" stop --backend container >/dev/null 2>&1 || compose down --remove-orphans >/dev/null 2>&1 || true
  if [ "$cleanup_status" -ne 0 ]; then
    echo "Torium E2E failed; diagnostics: ${diagnostics_dir:-unavailable}" >&2
  fi
  exit "$cleanup_status"
}

trap cleanup EXIT
trap 'exit 130' INT TERM HUP

phase="tooling-and-fixture"
echo "[1/11] validate pinned tooling and the test-only Solidity fixture"
assert_equal "$(sha256_file "$fixture_source")" "$(jq -er '.sourceSha256' "$fixture")" "Solidity source checksum"
assert_equal "$(jq -er '.compiler.version' "$fixture")" "$(jq -er '.contracts.solidity.version' "$toolchain")" "Solidity compiler pin"
assert_equal "$(jq -er '.testTool.version' "$fixture")" "$(jq -er '.contracts.foundry.version' "$toolchain")" "Foundry version pin"
assert_equal "$(jq -er '.testTool.image' "$fixture")" "$(jq -er '.contracts.foundry.image' "$toolchain")" "Foundry image pin"
cast_version=$(cast_cmd --version)
case "$cast_version" in *"cast Version: 1.7.1"*) ;; *) echo "unexpected cast version: $cast_version" >&2; exit 1 ;; esac

phase="localnet-boot"
echo "[2/11] reset and boot the canonical four-validator Torium localnet"
"$localnet" reset --backend container --yes >/dev/null
readiness=$("$localnet" start --backend container --timeout 90 --json)
printf '%s' "$readiness" | jq -e '
  .ready == true and
  .allValidatorsReady == true and
  .progressObserved == true and
  .chain.cosmosChainID == "torium-localnet-1" and
  .chain.evmChainID == 1414484556 and
  .consensus.availableVotingPower == 100 and
  (.validators | length) == 4
' >/dev/null
expected_chain_id=$(jq -er '.evm_chain_id' "$manifest")
expected_chain_hex=$(printf '0x%x' "$expected_chain_id")
assert_equal "$(cast_cmd chain-id --rpc-url "$rpc_url")" "$expected_chain_id" "EVM chain ID"
compose exec -T validator-0 toriumd version >/dev/null

staking_params=$(curl --fail --silent --show-error --max-time 5 \
  http://127.0.0.1:1317/cosmos/staking/v1beta1/params)
printf '%s' "$staking_params" | jq -e '
  .params.bond_denom == "atorium" and
  .params.unbonding_time == "1814400s" and
  .params.max_validators == 100 and
  .params.max_entries == 7 and
  .params.historical_entries == 10000 and
  .params.min_commission_rate == "0.050000000000000000"
' >/dev/null
distribution_params=$(curl --fail --silent --show-error --max-time 5 \
  http://127.0.0.1:1317/cosmos/distribution/v1beta1/params)
printf '%s' "$distribution_params" | jq -e '
  .params.community_tax == "0.020000000000000000" and
  .params.base_proposer_reward == "0.000000000000000000" and
  .params.bonus_proposer_reward == "0.000000000000000000" and
  .params.withdraw_addr_enabled == true
' >/dev/null
slashing_params=$(curl --fail --silent --show-error --max-time 5 \
  http://127.0.0.1:1317/cosmos/slashing/v1beta1/params)
printf '%s' "$slashing_params" | jq -e '
  .params.signed_blocks_window == "100" and
  .params.min_signed_per_window == "0.500000000000000000" and
  .params.downtime_jail_duration == "600s" and
  .params.slash_fraction_downtime == "0.010000000000000000" and
  .params.slash_fraction_double_sign == "0.050000000000000000"
' >/dev/null
cli_staking_params=$(compose exec -T validator-0 toriumd query staking params \
  --home /var/lib/torium --node tcp://127.0.0.1:26657 --output json)
assert_equal \
  "$(printf '%s' "$cli_staking_params" | jq -er '.params.unbonding_time')" \
  "504h0m0s" \
  "staking CLI unbonding duration"
assert_equal \
  "$(printf '%s' "$cli_staking_params" | jq -cS '.params | del(.unbonding_time)')" \
  "$(printf '%s' "$staking_params" | jq -cS '.params | del(.unbonding_time)')" \
  "staking CLI/REST parameters"
cli_validator_count=$(compose exec -T validator-0 toriumd query staking validators \
  --home /var/lib/torium --node tcp://127.0.0.1:26657 --output json | \
  jq -er '.validators | length')
assert_equal "$cli_validator_count" "4" "staking CLI validator count"

phase="native-transfer"
echo "[3/11] derive the disposable signer and finalize a native EVM transfer"
fixture_signer=$(printf '%s' 'torium/localnet/valueless-fixture/v1/account/deployer' | sha256_stdin)
deployer_address=$(jq -er '.development_accounts[] | select(.name == "deployer") | .evm_address' "$manifest")
recipient_address=$(jq -er '.development_accounts[] | select(.name == "sdk-user") | .evm_address' "$manifest")
recipient_allocation=$(jq -er '.development_accounts[] | select(.name == "sdk-user") | .allocation_base_units' "$manifest")
assert_equal "$(lowercase "$(cast_cmd wallet address --private-key "$fixture_signer")")" "$(lowercase "$deployer_address")" "derived deployer address"
assert_equal "$(cast_cmd balance "$recipient_address" --rpc-url "$rpc_url")" "$recipient_allocation" "recipient genesis balance"
assert_equal "$(cast_cmd nonce "$deployer_address" --rpc-url "$rpc_url")" "0" "deployer genesis nonce"

transfer_hash=$(cast_cmd send "$recipient_address" --value 1wei --gas-limit 21000 --private-key "$fixture_signer" --rpc-url "$rpc_url" --async)
assert_hash "$transfer_hash" "native transfer hash"
transfer_receipt=$(wait_for_receipt "$transfer_hash")
verify_receipt "$transfer_receipt" "$transfer_hash" "0x1" "native transfer"
assert_equal "$(lowercase "$(printf '%s' "$transfer_receipt" | jq -er '.from')")" "$(lowercase "$deployer_address")" "native transfer sender"
assert_equal "$(lowercase "$(printf '%s' "$transfer_receipt" | jq -er '.to')")" "$(lowercase "$recipient_address")" "native transfer recipient"
assert_equal "$(printf '%s' "$transfer_receipt" | jq -er '.type')" "0x2" "native transfer type"
assert_equal "$(printf '%s' "$transfer_receipt" | jq -r '.contractAddress')" "null" "native transfer contract address"
assert_equal "$(printf '%s' "$transfer_receipt" | jq -er '.logs | length')" "0" "native transfer log count"
transfer_tx=$(cast_cmd tx "$transfer_hash" --rpc-url "$rpc_url" --json)
transfer_block=$(cast_cmd block "$(printf '%s' "$transfer_receipt" | jq -er '.blockHash')" --rpc-url "$rpc_url" --json)
assert_equal "$(printf '%s' "$transfer_tx" | jq -er '.chainId')" "$expected_chain_hex" "native transfer replay domain"
assert_equal "$(hex_to_decimal "$(printf '%s' "$transfer_tx" | jq -er '.nonce')")" "0" "native transfer nonce"
assert_equal "$(printf '%s' "$transfer_tx" | jq -er '.value')" "0x1" "native transfer value"
verify_transaction_and_block "$transfer_tx" "$transfer_block" "$transfer_receipt" "native transfer"
expected_recipient_after="${recipient_allocation%0}1"
assert_equal "$(cast_cmd balance "$recipient_address" --rpc-url "$rpc_url")" "$expected_recipient_after" "recipient post-transfer balance"
assert_equal "$(cast_cmd nonce "$deployer_address" --rpc-url "$rpc_url")" "1" "deployer nonce after transfer"

phase="native-solidity-facade"
echo "[4/11] prove the Solidity facade shares native balances and total supply"
native_precompile=$(jq -er '.native_asset.solidity_precompile_address' "$manifest")
assert_equal "$native_precompile" "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE" "canonical native precompile"
assert_equal "$(jq -er '.app_state.erc20.native_precompiles[0]' "$repo_root/chain/genesis/localnet/genesis.json")" "$native_precompile" "manifest/genesis native precompile"
assert_equal "$(cast_cmd call "$native_precompile" 'name()(string)' --rpc-url "$rpc_url")" '"Torium Local Token"' "native facade name"
assert_equal "$(cast_cmd call "$native_precompile" 'symbol()(string)' --rpc-url "$rpc_url")" '"tTOR"' "native facade symbol"
assert_equal "$(cast_cmd call "$native_precompile" 'decimals()(uint8)' --rpc-url "$rpc_url")" "18" "native facade decimals"

native_supply=$(jq -er '.native_asset.total_supply_base_units' "$manifest")
facade_supply=$(cast_cmd call "$native_precompile" 'totalSupply()(uint256)' --rpc-url "$rpc_url" | awk '{print $1}')
assert_equal "$facade_supply" "$native_supply" "native facade genesis total supply"

native_facade_signer=$(printf '%s' 'torium/localnet/valueless-fixture/v1/account/test-user' | sha256_stdin)
native_facade_sender=$(jq -er '.development_accounts[] | select(.name == "test-user") | .evm_address' "$manifest")
native_facade_recipient=$(jq -er '.development_accounts[] | select(.name == "faucet") | .evm_address' "$manifest")
assert_equal "$(lowercase "$(cast_cmd wallet address --private-key "$native_facade_signer")")" "$(lowercase "$native_facade_sender")" "derived native facade signer"
native_facade_sender_before=$(cast_cmd balance "$native_facade_sender" --rpc-url "$rpc_url")
native_facade_recipient_before=$(cast_cmd balance "$native_facade_recipient" --rpc-url "$rpc_url")
facade_sender_before=$(cast_cmd call "$native_precompile" 'balanceOf(address)(uint256)' "$native_facade_sender" --rpc-url "$rpc_url" | awk '{print $1}')
assert_equal "$facade_sender_before" "$native_facade_sender_before" "facade/native sender balance before transfer"

native_facade_hash=$(cast_cmd send "$native_precompile" 'transfer(address,uint256)' "$native_facade_recipient" 1 --gas-limit 200000 --private-key "$native_facade_signer" --rpc-url "$rpc_url" --async)
assert_hash "$native_facade_hash" "native facade transfer hash"
native_facade_receipt=$(wait_for_receipt "$native_facade_hash")
verify_receipt "$native_facade_receipt" "$native_facade_hash" "0x1" "native facade transfer"
native_facade_tx=$(cast_cmd tx "$native_facade_hash" --rpc-url "$rpc_url" --json)
native_facade_block=$(cast_cmd block "$(printf '%s' "$native_facade_receipt" | jq -er '.blockHash')" --rpc-url "$rpc_url" --json)
verify_transaction_and_block "$native_facade_tx" "$native_facade_block" "$native_facade_receipt" "native facade transfer"
assert_equal "$(lowercase "$(printf '%s' "$native_facade_receipt" | jq -er '.to')")" "$(lowercase "$native_precompile")" "native facade transfer recipient"
assert_equal "$(printf '%s' "$native_facade_tx" | jq -er '.value')" "0x0" "native facade transfer EVM value"
assert_equal "$(printf '%s' "$native_facade_receipt" | jq -er '.logs | length')" "1" "native facade Transfer log count"
assert_equal "$(lowercase "$(printf '%s' "$native_facade_receipt" | jq -er '.logs[0].address')")" "$(lowercase "$native_precompile")" "native facade Transfer emitter"
assert_equal "$(printf '%s' "$native_facade_receipt" | jq -er '.logs[0].topics[0]')" "$(cast_cmd keccak 'Transfer(address,address,uint256)')" "native facade Transfer topic"
assert_equal "$(lowercase "$(printf '%s' "$native_facade_receipt" | jq -er '.logs[0].topics[1]')")" "$(lowercase "$(cast_cmd to-uint256 "$native_facade_sender")")" "native facade Transfer sender topic"
assert_equal "$(lowercase "$(printf '%s' "$native_facade_receipt" | jq -er '.logs[0].topics[2]')")" "$(lowercase "$(cast_cmd to-uint256 "$native_facade_recipient")")" "native facade Transfer recipient topic"
assert_equal "$(printf '%s' "$native_facade_receipt" | jq -er '.logs[0].data')" "$(cast_cmd to-uint256 1)" "native facade Transfer amount"

native_facade_sender_after=$(cast_cmd balance "$native_facade_sender" --rpc-url "$rpc_url")
native_facade_recipient_after=$(cast_cmd balance "$native_facade_recipient" --rpc-url "$rpc_url")
facade_sender_after=$(cast_cmd call "$native_precompile" 'balanceOf(address)(uint256)' "$native_facade_sender" --rpc-url "$rpc_url" | awk '{print $1}')
facade_recipient_after=$(cast_cmd call "$native_precompile" 'balanceOf(address)(uint256)' "$native_facade_recipient" --rpc-url "$rpc_url" | awk '{print $1}')
assert_equal "$facade_sender_after" "$native_facade_sender_after" "facade/native sender balance after transfer"
assert_equal "$facade_recipient_after" "$native_facade_recipient_after" "facade/native recipient balance after transfer"
assert_equal "$native_facade_recipient_after" "${native_facade_recipient_before%0}1" "native facade recipient increment"
assert_equal "$(cast_cmd nonce "$native_facade_sender" --rpc-url "$rpc_url")" "1" "native facade sender nonce"
assert_equal "$(cast_cmd call "$native_precompile" 'totalSupply()(uint256)' --rpc-url "$rpc_url" | awk '{print $1}')" "$native_supply" "native facade total supply after transfer"

phase="contract-deployment"
echo "[5/11] deploy the minimal Solidity fixture and verify persisted bytecode"
creation_bytecode=$(jq -er '.creationBytecode' "$fixture")
expected_runtime=$(jq -er '.deployedBytecode' "$fixture")
deploy_hash=$(cast_cmd send --gas-limit 500000 --private-key "$fixture_signer" --rpc-url "$rpc_url" --async --create "$creation_bytecode")
assert_hash "$deploy_hash" "contract deployment hash"
deploy_receipt=$(wait_for_receipt "$deploy_hash")
verify_receipt "$deploy_receipt" "$deploy_hash" "0x1" "contract deployment"
contract_address=$(printf '%s' "$deploy_receipt" | jq -er '.contractAddress')
case "$contract_address" in 0x[0-9a-fA-F][0-9a-fA-F]*) ;; *) echo "invalid deployed contract address: $contract_address" >&2; exit 1 ;; esac
[ "${#contract_address}" -eq 42 ] || { echo "deployed contract address is not 20 bytes: $contract_address" >&2; exit 1; }
deploy_tx=$(cast_cmd tx "$deploy_hash" --rpc-url "$rpc_url" --json)
deploy_block=$(cast_cmd block "$(printf '%s' "$deploy_receipt" | jq -er '.blockHash')" --rpc-url "$rpc_url" --json)
assert_equal "$(printf '%s' "$deploy_tx" | jq -r '.to')" "null" "deployment transaction recipient"
assert_equal "$(hex_to_decimal "$(printf '%s' "$deploy_tx" | jq -er '.nonce')")" "1" "deployment nonce"
verify_transaction_and_block "$deploy_tx" "$deploy_block" "$deploy_receipt" "contract deployment"
assert_equal "$(cast_cmd code "$contract_address" --rpc-url "$rpc_url")" "$expected_runtime" "deployed runtime bytecode"
assert_equal "$(cast_cmd call "$contract_address" 'value()(uint256)' --rpc-url "$rpc_url")" "0" "initial contract state"
assert_equal "$(cast_cmd nonce "$deployer_address" --rpc-url "$rpc_url")" "2" "deployer nonce after deployment"

phase="contract-call"
echo "[6/11] call the contract and verify receipt, event, block, fee, nonce, and state"
set_hash=$(cast_cmd send "$contract_address" 'setValue(uint256)' 42 --gas-limit 200000 --private-key "$fixture_signer" --rpc-url "$rpc_url" --async)
assert_hash "$set_hash" "contract call hash"
set_receipt=$(wait_for_receipt "$set_hash")
verify_receipt "$set_receipt" "$set_hash" "0x1" "contract call"
set_tx=$(cast_cmd tx "$set_hash" --rpc-url "$rpc_url" --json)
set_block=$(cast_cmd block "$(printf '%s' "$set_receipt" | jq -er '.blockHash')" --rpc-url "$rpc_url" --json)
assert_equal "$(hex_to_decimal "$(printf '%s' "$set_tx" | jq -er '.nonce')")" "2" "contract call nonce"
case "$(printf '%s' "$set_tx" | jq -er '.input')" in "$(jq -er '.selectors["setValue(uint256)"]' "$fixture")"*) ;; *) echo "contract call input has the wrong selector" >&2; exit 1 ;; esac
verify_transaction_and_block "$set_tx" "$set_block" "$set_receipt" "contract call"
assert_equal "$(printf '%s' "$set_receipt" | jq -er '.logs | length')" "1" "ValueChanged log count"
assert_equal "$(lowercase "$(printf '%s' "$set_receipt" | jq -er '.logs[0].address')")" "$(lowercase "$contract_address")" "ValueChanged emitter"
assert_equal "$(printf '%s' "$set_receipt" | jq -er '.logs[0].topics[0]')" "$(jq -er '.selectors["ValueChanged(uint256,uint256)"]' "$fixture")" "ValueChanged signature topic"
assert_equal "$(printf '%s' "$set_receipt" | jq -er '.logs[0].topics[1]')" "$(cast_cmd to-uint256 0)" "ValueChanged previous-value topic"
assert_equal "$(printf '%s' "$set_receipt" | jq -er '.logs[0].topics[2]')" "$(cast_cmd to-uint256 42)" "ValueChanged new-value topic"
assert_equal "$(printf '%s' "$set_receipt" | jq -er '.logs[0].data')" "0x" "ValueChanged data"
assert_equal "$(printf '%s' "$set_receipt" | jq -r '.logs[0].removed')" "false" "ValueChanged removal state"
assert_equal "$(cast_cmd call "$contract_address" 'value()(uint256)' --rpc-url "$rpc_url")" "42" "updated contract state"
assert_equal "$(cast_cmd nonce "$deployer_address" --rpc-url "$rpc_url")" "3" "deployer nonce after contract call"

set_block_number=$(printf '%s' "$set_receipt" | jq -er '.blockNumber')
set_topic=$(jq -er '.selectors["ValueChanged(uint256,uint256)"]' "$fixture")
logs_filter=$(jq -cn --arg block "$set_block_number" --arg address "$contract_address" --arg topic "$set_topic" '[{fromBlock:$block,toBlock:$block,address:$address,topics:[$topic]}]')
logs_response=$(rpc_response eth_getLogs "$logs_filter")
printf '%s' "$logs_response" | jq -e --arg hash "$set_hash" '
  .error == null and
  (.result | length) == 1 and
  .result[0].transactionHash == $hash and
  .result[0].removed == false
' >/dev/null

phase="expected-revert"
echo "[7/11] broadcast an explicit reverting transaction and verify unchanged state"
set +e
revert_call=$(cast_cmd call "$contract_address" --data 0xdeadbeef --rpc-url "$rpc_url" 2>&1)
revert_call_status=$?
set -e
[ "$revert_call_status" -ne 0 ] || { echo "unknown selector unexpectedly succeeded in eth_call" >&2; exit 1; }
case "$revert_call" in *"execution reverted"*) ;; *) echo "eth_call failure did not report a revert: $revert_call" >&2; exit 1 ;; esac
revert_hash=$(cast_cmd send "$contract_address" --data 0xdeadbeef --gas-limit 50000 --private-key "$fixture_signer" --rpc-url "$rpc_url" --async)
assert_hash "$revert_hash" "reverting transaction hash"
revert_receipt=$(wait_for_receipt "$revert_hash")
verify_receipt "$revert_receipt" "$revert_hash" "0x0" "reverting transaction"
revert_tx=$(cast_cmd tx "$revert_hash" --rpc-url "$rpc_url" --json)
revert_block=$(cast_cmd block "$(printf '%s' "$revert_receipt" | jq -er '.blockHash')" --rpc-url "$rpc_url" --json)
assert_equal "$(hex_to_decimal "$(printf '%s' "$revert_tx" | jq -er '.nonce')")" "3" "reverting transaction nonce"
assert_equal "$(printf '%s' "$revert_tx" | jq -er '.input')" "0xdeadbeef" "reverting transaction input"
assert_equal "$(printf '%s' "$revert_receipt" | jq -er '.logs | length')" "0" "reverting transaction log count"
verify_transaction_and_block "$revert_tx" "$revert_block" "$revert_receipt" "reverting transaction"
assert_equal "$(cast_cmd call "$contract_address" 'value()(uint256)' --rpc-url "$rpc_url")" "42" "state after revert"
assert_equal "$(cast_cmd nonce "$deployer_address" --rpc-url "$rpc_url")" "4" "deployer nonce after revert"

phase="restart-persistence"
echo "[8/11] restart all validators and prove persistence plus continued execution"
height_before_restart=$("$localnet" status --backend container --json | jq -er '.chain.highestHeight')
restart_report=$("$localnet" restart --backend container --timeout 90 --json)
printf '%s' "$restart_report" | jq -e --argjson previous "$height_before_restart" '
  .ready == true and
  .allValidatorsReady == true and
  .progressObserved == true and
  .chain.highestHeight > $previous
' >/dev/null
restart_ready_height=$(printf '%s' "$restart_report" | jq -er '.chain.highestHeight')
restart_barrier_height=$((restart_ready_height + 1))
assert_committed_on_all_validators "$restart_barrier_height"
wait_for_finalized "$restart_barrier_height" >/dev/null
wait_for_contract_value "$contract_address" 42 >/dev/null
assert_equal "$(cast_cmd code "$contract_address" --rpc-url "$rpc_url")" "$expected_runtime" "runtime bytecode after restart"
assert_equal "$(cast_cmd call "$contract_address" 'value()(uint256)' --rpc-url "$rpc_url")" "42" "contract state after restart"
assert_equal "$(cast_cmd balance "$recipient_address" --rpc-url "$rpc_url")" "$expected_recipient_after" "recipient balance after restart"
assert_equal "$(cast_cmd nonce "$deployer_address" --rpc-url "$rpc_url")" "4" "deployer nonce after restart"
assert_equal "$(cast_cmd balance "$native_facade_sender" --rpc-url "$rpc_url")" "$native_facade_sender_after" "native facade sender balance after restart"
assert_equal "$(cast_cmd call "$native_precompile" 'balanceOf(address)(uint256)' "$native_facade_sender" --rpc-url "$rpc_url" | awk '{print $1}')" "$native_facade_sender_after" "facade balance after restart"
assert_equal "$(cast_cmd call "$native_precompile" 'totalSupply()(uint256)' --rpc-url "$rpc_url" | awk '{print $1}')" "$native_supply" "native facade total supply after restart"

post_restart_hash=$(cast_cmd send "$contract_address" 'setValue(uint256)' 7 --gas-limit 200000 --private-key "$fixture_signer" --rpc-url "$rpc_url" --async)
assert_hash "$post_restart_hash" "post-restart contract call hash"
post_restart_receipt=$(wait_for_receipt "$post_restart_hash")
verify_receipt "$post_restart_receipt" "$post_restart_hash" "0x1" "post-restart contract call"
post_restart_tx=$(cast_cmd tx "$post_restart_hash" --rpc-url "$rpc_url" --json)
post_restart_block=$(cast_cmd block "$(printf '%s' "$post_restart_receipt" | jq -er '.blockHash')" --rpc-url "$rpc_url" --json)
assert_equal "$(hex_to_decimal "$(printf '%s' "$post_restart_tx" | jq -er '.nonce')")" "4" "post-restart transaction nonce"
verify_transaction_and_block "$post_restart_tx" "$post_restart_block" "$post_restart_receipt" "post-restart contract call"
assert_equal "$(printf '%s' "$post_restart_receipt" | jq -er '.logs[0].topics[1]')" "$(cast_cmd to-uint256 42)" "post-restart previous-value topic"
assert_equal "$(printf '%s' "$post_restart_receipt" | jq -er '.logs[0].topics[2]')" "$(cast_cmd to-uint256 7)" "post-restart new-value topic"
assert_equal "$(cast_cmd call "$contract_address" 'value()(uint256)' --rpc-url "$rpc_url")" "7" "post-restart contract state"
assert_equal "$(cast_cmd nonce "$deployer_address" --rpc-url "$rpc_url")" "5" "final deployer nonce"

phase="local-recovery"
echo "[9/11] snapshot, export, mutate, restore, and verify balances plus contract state"
recovery_dir="$suite_dir/.artifacts/recovery-$$"
mkdir -p "$recovery_dir"
recovery_archive="$recovery_dir/contracts-deployed.tar.gz"
snapshot_result=$("$localnet" snapshot --backend container --fixture contracts-deployed --output "$recovery_archive")
printf '%s' "$snapshot_result" | jq -e '
  .manifest.format == "torium-localnet-recovery-v1" and
  .manifest.scope == "network" and
  .manifest.fixture == "contracts-deployed" and
  .manifest.chain.cosmosChainId == "torium-localnet-1" and
  .manifest.chain.evmChainId == 1414484556 and
  (.manifest.nodes | length) == 4 and
  (.manifest.files | length) > 20
' >/dev/null
inspect_result=$("$localnet" inspect --backend container --archive "$recovery_archive")
assert_equal "$(printf '%s' "$inspect_result" | jq -er '.archiveSha256')" \
  "$(printf '%s' "$snapshot_result" | jq -er '.archiveSha256')" "recovery archive checksum"

app_export="$recovery_dir/application-state.json"
"$localnet" export --backend container --node validator-0 --output "$app_export" >/dev/null
jq -e '
  .chain_id == "torium-localnet-1" and
  (.app_state.auth != null) and
  (.app_state.bank != null) and
  (.app_state.evm != null)
' "$app_export" >/dev/null
if command -v shasum >/dev/null 2>&1; then
  (cd "$recovery_dir" && shasum -a 256 -c application-state.json.sha256 >/dev/null)
else
  (cd "$recovery_dir" && sha256sum -c application-state.json.sha256 >/dev/null)
fi

"$localnet" start --backend container --timeout 90 >/dev/null
mutate_hash=$(cast_cmd send "$contract_address" 'setValue(uint256)' 99 --gas-limit 200000 --private-key "$fixture_signer" --rpc-url "$rpc_url" --async)
mutate_receipt=$(wait_for_receipt "$mutate_hash")
verify_receipt "$mutate_receipt" "$mutate_hash" "0x1" "pre-restore mutation"
assert_equal "$(cast_cmd call "$contract_address" 'value()(uint256)' --rpc-url "$rpc_url")" "99" "mutated contract state"
assert_equal "$(cast_cmd nonce "$deployer_address" --rpc-url "$rpc_url")" "6" "mutated deployer nonce"

"$localnet" restore --backend container --archive "$recovery_archive" >/dev/null
"$localnet" start --backend container --timeout 90 >/dev/null
assert_equal "$(cast_cmd call "$contract_address" 'value()(uint256)' --rpc-url "$rpc_url")" "7" "restored contract state"
assert_equal "$(cast_cmd balance "$recipient_address" --rpc-url "$rpc_url")" "$expected_recipient_after" "restored recipient balance"
assert_equal "$(cast_cmd nonce "$deployer_address" --rpc-url "$rpc_url")" "5" "restored deployer nonce"
assert_equal "$(cast_cmd balance "$native_facade_recipient" --rpc-url "$rpc_url")" "$native_facade_recipient_after" "restored native facade recipient balance"
assert_equal "$(cast_cmd call "$native_precompile" 'balanceOf(address)(uint256)' "$native_facade_recipient" --rpc-url "$rpc_url" | awk '{print $1}')" "$native_facade_recipient_after" "restored facade recipient balance"
assert_equal "$(cast_cmd call "$native_precompile" 'totalSupply()(uint256)' --rpc-url "$rpc_url" | awk '{print $1}')" "$native_supply" "restored native total supply"

phase="node-recovery-and-corruption"
echo "[10/11] reset one validator, prove catch-up, and reject corrupt recovery input safely"
catchup_target=$(($(comet_height 26657) + 2))
"$localnet" reset --backend container --node validator-3 --yes >/dev/null
if "$localnet" inspect --backend container --node validator-3 >/dev/null 2>&1; then
  echo "validator-3 reset unexpectedly retained committed state" >&2
  exit 1
fi
"$localnet" restart --backend container --node validator-3 --timeout 90 >/dev/null
wait_for_comet_height 26957 "$catchup_target"
assert_committed_on_all_validators "$catchup_target"
assert_equal "$(cast_cmd call "$contract_address" 'value()(uint256)' --rpc-url "$rpc_url")" "7" "state after validator catch-up"

corrupt_archive="$recovery_dir/corrupt.tar.gz"
cp "$recovery_archive" "$corrupt_archive"
archive_digest=$(awk '{print $1}' "$recovery_archive.sha256")
printf '%s  %s\n' "$archive_digest" "$(basename "$corrupt_archive")" >"$corrupt_archive.sha256"
printf 'corruption\n' >>"$corrupt_archive"
if "$localnet" restore --backend container --archive "$corrupt_archive" >/dev/null 2>&1; then
  echo "corrupted recovery archive was accepted" >&2
  exit 1
fi
"$localnet" start --backend container --timeout 90 >/dev/null
assert_equal "$(cast_cmd call "$contract_address" 'value()(uint256)' --rpc-url "$rpc_url")" "7" "state after rejected corrupt restore"
assert_equal "$(cast_cmd nonce "$deployer_address" --rpc-url "$rpc_url")" "5" "nonce after rejected corrupt restore"

phase="lifecycle-proof"
echo "[11/11] emit the reproducible lifecycle and recovery proof"
jq -n \
  --arg chainId "$expected_chain_hex" \
  --arg genesisSha256 "$(jq -r '.genesis_sha256' "$manifest")" \
  --arg transferHash "$transfer_hash" \
  --arg nativeFacadeHash "$native_facade_hash" \
  --arg nativePrecompile "$native_precompile" \
  --arg nativeSupply "$native_supply" \
  --arg deployHash "$deploy_hash" \
  --arg contractAddress "$contract_address" \
  --arg callHash "$set_hash" \
  --arg revertHash "$revert_hash" \
  --arg postRestartHash "$post_restart_hash" \
  --arg finalState "7" \
  --arg finalNonce "5" \
  --arg recoveryArchiveSha256 "$(printf '%s' "$snapshot_result" | jq -er '.archiveSha256')" \
  '{
    schemaVersion: 1,
    result: "passed",
    network: "canonical-four-validator-localnet",
    chainId: $chainId,
    genesisSha256: $genesisSha256,
    transactions: {
      nativeTransfer: $transferHash,
      nativeFacadeTransfer: $nativeFacadeHash,
      contractDeployment: $deployHash,
      contractCall: $callHash,
      expectedRevert: $revertHash,
      postRestartCall: $postRestartHash
    },
    contractAddress: $contractAddress,
    nativeAsset: {
      precompile: $nativePrecompile,
      totalSupply: $nativeSupply,
      bankAndFacadeBalancesMatched: true,
      transferSupplyDrift: false
    },
    finalState: $finalState,
    finalNonce: $finalNonce,
    recovery: {
      archiveSha256: $recoveryArchiveSha256,
      applicationExportVerified: true,
      restoredStateVerified: true,
      perNodeCatchupVerified: true,
      corruptionRejected: true
    }
  }'
