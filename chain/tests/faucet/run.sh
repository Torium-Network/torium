#!/bin/sh
set -eu

suite_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo_root=$(CDPATH= cd -- "$suite_dir/../../.." && pwd)
localnet_dir="$repo_root/chain/localnet"
localnet="$localnet_dir/torium-localnet"
manifest="$repo_root/chain/genesis/localnet/manifest.json"
policy="$repo_root/chain/config/faucet-policy-v1.json"
toolchain="$repo_root/chain/toolchain.json"
rpc_url=http://127.0.0.1:8545
rest_url=http://127.0.0.1:1317
faucet_url=http://127.0.0.1:8080
foundry_image=$(jq -er '.contracts.foundry.image' "$toolchain")
phase=prerequisites
diagnostics_dir=""
last_response=""

for dependency in docker curl jq make; do
  command -v "$dependency" >/dev/null 2>&1 || {
    echo "missing Torium faucet acceptance dependency: $dependency" >&2
    exit 1
  }
done
if ! command -v shasum >/dev/null 2>&1 && ! command -v sha256sum >/dev/null 2>&1; then
  echo "missing Torium faucet acceptance dependency: shasum or sha256sum" >&2
  exit 1
fi

compose() {
  docker compose --file "$localnet_dir/compose.yaml" "$@"
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

request_funds() {
  request_body=$1
  request_output=$2
  curl --silent --show-error --max-time 50 \
    --output "$request_output" \
    --write-out '%{http_code}' \
    -H 'content-type: application/json' \
    --data "$request_body" \
    "$faucet_url/v1/fund"
}

cosmos_balance() {
  cosmos_address=$1
  curl --fail --silent --show-error --max-time 5 \
    "$rest_url/cosmos/bank/v1beta1/balances/$cosmos_address/by_denom?denom=atorium" |
    jq -er '.balance.amount // "0"'
}

cli_balance() {
  cli_address=$1
  compose exec -T validator-0 toriumd query bank balance "$cli_address" atorium \
    --grpc-addr validator-0:9090 \
    --grpc-insecure \
    --output json |
    jq -er '.balance.amount // "0"'
}

capture_diagnostics() {
  diagnostics_dir="$suite_dir/.artifacts/$(date -u +%Y%m%dT%H%M%SZ)-$$"
  mkdir -p "$diagnostics_dir"
  date -u +%Y-%m-%dT%H:%M:%SZ >"$diagnostics_dir/captured-at.txt"
  printf '%s\n' "$phase" >"$diagnostics_dir/phase.txt"
  git -C "$repo_root" rev-parse HEAD >"$diagnostics_dir/git-head.txt" 2>&1 || true
  compose ps -a >"$diagnostics_dir/compose-ps.txt" 2>&1 || true
  compose logs --no-color --tail=500 faucet >"$diagnostics_dir/faucet.log" 2>&1 || true
  "$localnet" status --backend container --json >"$diagnostics_dir/health.json" 2>&1 || true
  curl --silent --show-error --max-time 3 "$faucet_url/healthz" >"$diagnostics_dir/faucet-health.json" 2>&1 || true
  if [ -n "$last_response" ] && [ -f "$last_response" ]; then
    cp "$last_response" "$diagnostics_dir/last-response.json"
  fi
}

cleanup() {
  cleanup_status=$?
  trap - EXIT INT TERM HUP
  if [ "$cleanup_status" -ne 0 ]; then
    capture_diagnostics || true
  fi
  if [ -n "$last_response" ]; then rm -f "$last_response"; fi
  "$localnet" stop --backend container >/dev/null 2>&1 || compose down --remove-orphans >/dev/null 2>&1 || true
  if [ "$cleanup_status" -ne 0 ]; then
    echo "Torium faucet acceptance failed; diagnostics: ${diagnostics_dir:-unavailable}" >&2
  fi
  exit "$cleanup_status"
}

trap cleanup EXIT
trap 'exit 130' INT TERM HUP

mkdir -p "$suite_dir/.artifacts"
response_file=$(mktemp "$suite_dir/.artifacts/response.XXXXXX")
last_response=$response_file

phase=policy-and-topology
echo "[1/7] validate the local-only policy and hardened Compose exposure"
node "$repo_root/chain/config/validate-faucet-policy-v1.mjs" >/dev/null
compose config --format json | jq -e '
  .services.faucet.read_only == true and
  .services.faucet.restart == "no" and
  (.services.faucet.cap_drop | index("ALL")) != null and
  (.services.faucet.security_opt | index("no-new-privileges:true")) != null and
  (.services.faucet.volumes // [] | length) == 0 and
  (.services.faucet.tmpfs | index("/var/lib/torium:rw,noexec,nosuid,size=1m")) != null and
  .services.faucet.ports[0].host_ip == "127.0.0.1" and
  .services.faucet.ports[0].published == "8080"
' >/dev/null

phase=localnet-boot
echo "[2/7] reset and boot the canonical chain plus loopback faucet"
"$localnet" reset --backend container --yes >/dev/null
readiness=$("$localnet" start --backend container --timeout 120 --json)
printf '%s' "$readiness" | jq -e '.ready == true and .allValidatorsReady == true and .chain.evmChainID == 1414484556' >/dev/null
faucet_health=$(curl --fail --silent --show-error --max-time 5 "$faucet_url/healthz")
docker inspect "$(compose ps -q faucet)" | jq -e '
  .[0] |
  ([.Mounts[].Type] | all(. != "volume" and . != "bind")) and
  (.HostConfig.Tmpfs["/var/lib/torium"] != null)
' >/dev/null
printf '%s' "$faucet_health" | jq -e --arg warning "$(jq -r '.warning' "$policy")" '
  .status == "ready" and
  .warning == $warning and
  .network == "torium-localnet-1" and
  .evmChainId == "1414484556" and
  .baseDenom == "atorium" and
  .displayDenom == "tTOR" and
  .publicUseAllowed == false and
  .defaultAmountBaseUnits == "10000000000000000000"
' >/dev/null
faucet_signer=$(printf '%s' "$faucet_health" | jq -er '.signerAddress')
expected_signer=$(jq -er '.development_accounts[] | select(.name == "faucet") | .evm_address' "$manifest")
assert_equal "$(lowercase "$faucet_signer")" "$(lowercase "$expected_signer")" "faucet signer address"

phase=keyring-flows
echo "[3/7] prove disposable automation keyring creation, listing, export, and offline signing"
automation_key=$(printf '%s' 'torium/localnet/valueless-fixture/v1/account/faucet-acceptance-automation' | sha256_stdin)
keyring_home=/tmp/torium-faucet-acceptance-keyring
compose exec -T validator-0 rm -rf "$keyring_home"
printf '%s\n' 'valueless-localnet' | compose exec -T validator-0 toriumd keys unsafe-import-eth-key automation "$automation_key" \
  --keyring-backend test --home "$keyring_home" >/dev/null
automation_address=$(compose exec -T validator-0 toriumd keys show automation -a \
  --keyring-backend test --home "$keyring_home")
compose exec -T validator-0 toriumd keys list --keyring-backend test --home "$keyring_home" --output json |
  jq -e --arg address "$automation_address" 'length == 1 and .[0].address == $address' >/dev/null
exported_key=$(printf '%s\n' 'valueless-localnet' | compose exec -T validator-0 toriumd keys unsafe-export-eth-key automation \
  --keyring-backend test --home "$keyring_home")
assert_equal "$(lowercase "$exported_key")" "$(lowercase "$automation_key")" "disposable keyring export"
unsigned_tx=$(compose exec -T validator-0 toriumd tx bank send automation "$automation_address" 1atorium \
  --generate-only --chain-id torium-localnet-1 \
  --keyring-backend test --home "$keyring_home" --output json)
signed_tx=$(printf '%s' "$unsigned_tx" | compose exec -T validator-0 sh -c 'cat >/tmp/torium-faucet-unsigned-tx.json && toriumd tx sign /tmp/torium-faucet-unsigned-tx.json --from automation --offline --account-number 0 --sequence 0 --chain-id torium-localnet-1 --keyring-backend test --home /tmp/torium-faucet-acceptance-keyring --output json')
printf '%s' "$signed_tx" | jq -e '(.signatures | length) == 1 and .signatures[0] != null' >/dev/null
compose exec -T validator-0 rm -rf "$keyring_home" /tmp/torium-faucet-unsigned-tx.json

phase=random-account-funding
echo "[4/7] fund a random manual-test wallet with a canonical EIP-1559 transaction"
random_address=$(cast_cmd wallet new --json | jq -er '.[0].address')
random_bech32=$(compose exec -T validator-0 toriumd keys parse "${random_address#0x}" --output json | jq -er '.formats[0]')
assert_equal "$(cast_cmd balance "$random_address" --rpc-url "$rpc_url")" "0" "random wallet initial EVM balance"
assert_equal "$(cosmos_balance "$random_bech32")" "0" "random wallet initial Cosmos REST balance"
request_body=$(jq -cn --arg address "$random_address" '{address:$address}')
status=$(request_funds "$request_body" "$response_file")
assert_equal "$status" "201" "faucet funding HTTP status"
funding=$(cat "$response_file")
printf '%s' "$funding" | jq -e --arg warning "$(jq -r '.warning' "$policy")" --arg recipient "$(lowercase "$random_address")" '
  .status == "confirmed" and
  .warning == $warning and
  (.recipient | ascii_downcase) == $recipient and
  .amountBaseUnits == "10000000000000000000" and
  .receiptStatus == 1 and
  .transactionType == 2 and
  (.transactionHash | test("^0x[0-9a-fA-F]{64}$")) and
  (.blockHash | test("^0x[0-9a-fA-F]{64}$")) and
  .privateKey == null and
  .mnemonic == null and
  .rawTransaction == null
' >/dev/null
transaction_hash=$(printf '%s' "$funding" | jq -er '.transactionHash')
receipt_block=$(printf '%s' "$funding" | jq -er '.blockNumber')
transaction=$(cast_cmd tx "$transaction_hash" --rpc-url "$rpc_url" --json)
assert_equal "$(printf '%s' "$transaction" | jq -er '.chainId')" "0x544f524c" "faucet transaction replay domain"
assert_equal "$(printf '%s' "$transaction" | jq -er '.type')" "0x2" "faucet transaction type"
assert_equal "$(lowercase "$(printf '%s' "$transaction" | jq -er '.from')")" "$(lowercase "$expected_signer")" "faucet transaction sender"
assert_equal "$(lowercase "$(printf '%s' "$transaction" | jq -er '.to')")" "$(lowercase "$random_address")" "faucet transaction recipient"
assert_equal "$(cast_cmd to-dec "$(printf '%s' "$transaction" | jq -er '.value')")" "10000000000000000000" "faucet transaction value"

phase=canonical-balance
echo "[5/7] match EVM RPC, Cosmos REST, and toriumd CLI balances"
evm_balance=$(cast_cmd balance "$random_address" --rpc-url "$rpc_url")
rest_balance=$(cosmos_balance "$random_bech32")
command_balance=$(cli_balance "$random_bech32")
assert_equal "$evm_balance" "10000000000000000000" "funded EVM balance"
assert_equal "$rest_balance" "$evm_balance" "Cosmos REST versus EVM balance"
assert_equal "$command_balance" "$evm_balance" "toriumd CLI versus EVM balance"
expected_fingerprint=""
for port in 26657 26757 26857 26957; do
  fingerprint=$(curl --fail --silent --show-error --max-time 5 "http://127.0.0.1:$port/block?height=$receipt_block" | jq -cer '.result.block.header | {height,app_hash,validators_hash,next_validators_hash}')
  if [ -z "$expected_fingerprint" ]; then
    expected_fingerprint=$fingerprint
  else
    assert_equal "$fingerprint" "$expected_fingerprint" "validator block fingerprint at faucet receipt height"
  fi
done

phase=limits-and-input
echo "[6/7] enforce cooldown, amount bounds, and strict secret-free inputs"
status=$(request_funds "$request_body" "$response_file")
assert_equal "$status" "429" "same-address cooldown HTTP status"
printf '%s' "$(cat "$response_file")" | jq -e '.error == "address is in faucet cooldown" and .retryAfterSeconds >= 1' >/dev/null
invalid_body='{"address":"0x1234"}'
status=$(request_funds "$invalid_body" "$response_file")
assert_equal "$status" "400" "invalid address HTTP status"
secret_marker='faucet-acceptance-secret-must-never-be-reflected'
secret_body=$(jq -cn --arg address "$random_address" --arg mnemonic "$secret_marker" '{address:$address,mnemonic:$mnemonic}')
status=$(request_funds "$secret_body" "$response_file")
assert_equal "$status" "400" "secret-shaped unknown field HTTP status"
if grep -F "$secret_marker" "$response_file" >/dev/null; then
  echo "secret-shaped request data was reflected by the faucet" >&2
  exit 1
fi
if compose logs --no-color faucet | grep -F "$secret_marker" >/dev/null; then
  echo "secret-shaped request data was logged by the faucet" >&2
  exit 1
fi
too_large=$(jq -cn --arg address "$random_address" '{address:$address,amountBaseUnits:"25000000000000000001"}')
status=$(request_funds "$too_large" "$response_file")
assert_equal "$status" "400" "per-request maximum HTTP status"

phase=proof
echo "[7/7] emit the reproducible local faucet proof"
jq -n \
  --arg result passed \
  --arg warning "$(jq -r '.warning' "$policy")" \
  --arg recipient "$random_address" \
  --arg bech32Recipient "$random_bech32" \
  --arg transactionHash "$transaction_hash" \
  --arg amountBaseUnits "$evm_balance" \
  --argjson blockNumber "$receipt_block" \
  '{
    schemaVersion: 1,
    result: $result,
    warning: $warning,
    network: "torium-localnet-1",
    evmChainId: 1414484556,
    recipient: $recipient,
    bech32Recipient: $bech32Recipient,
    amountBaseUnits: $amountBaseUnits,
    transactionHash: $transactionHash,
    blockNumber: $blockNumber,
    balanceSurfaces: ["ethereum-json-rpc", "cosmos-rest", "toriumd-cli"],
    publicUseAllowed: false
  }'
