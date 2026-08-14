#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
localnet_dir=$(CDPATH= cd -- "$script_dir/.." && pwd)
compose="docker compose --file $localnet_dir/compose.yaml"

for dependency in docker curl jq; do
  command -v "$dependency" >/dev/null 2>&1 || { echo "missing smoke-test dependency: $dependency" >&2; exit 1; }
done
if ! command -v shasum >/dev/null 2>&1 && ! command -v sha256sum >/dev/null 2>&1; then
  echo "missing smoke-test dependency: shasum or sha256sum" >&2
  exit 1
fi
expected_chain_id=$(jq -er '.evm_chain_id' "$localnet_dir/../genesis/localnet/manifest.json")

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

cleanup() {
  $compose down --remove-orphans >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

height() {
  curl --fail --silent --show-error --max-time 2 "http://127.0.0.1:$1/status" |
    jq -er '.result.sync_info.latest_block_height | tonumber'
}

wait_for_height() {
  port=$1
  minimum=$2
  attempts=0
  while [ "$attempts" -lt 90 ]; do
    current=$(height "$port" 2>/dev/null || echo 0)
    if [ "$current" -ge "$minimum" ]; then
      echo "$current"
      return
    fi
    attempts=$((attempts + 1))
    sleep 1
  done
  echo "RPC port $port did not reach height $minimum" >&2
  exit 1
}

minimum_height() {
  minimum=""
  for port in 26657 26757 26857 26957; do
    current=$(height "$port")
    if [ -z "$minimum" ] || [ "$current" -lt "$minimum" ]; then minimum=$current; fi
  done
  echo "$minimum"
}

block_fingerprint() {
  curl --fail --silent --show-error "http://127.0.0.1:$1/block?height=$2" |
    jq -cer '.result.block.header | {height,app_hash,validators_hash,next_validators_hash,consensus_hash}'
}

validator_fingerprint() {
  curl --fail --silent --show-error "http://127.0.0.1:$1/validators?height=$2&per_page=100" |
    jq -cer '[.result.validators[] | {address,voting_power,pub_key}] | sort_by(.address)'
}

assert_consistent_at() {
  target_height=$1
  expected_block=""
  expected_validators=""
  for port in 26657 26757 26857 26957; do
    block=$(block_fingerprint "$port" "$target_height")
    validators=$(validator_fingerprint "$port" "$target_height")
    if [ -z "$expected_block" ]; then
      expected_block=$block
      expected_validators=$validators
    elif [ "$block" != "$expected_block" ] || [ "$validators" != "$expected_validators" ]; then
      echo "validators disagree at height $target_height (RPC port $port)" >&2
      exit 1
    fi
  done
  count=$(echo "$expected_validators" | jq 'length')
  powers=$(echo "$expected_validators" | jq -r '[.[].voting_power | tonumber] | sort | join(",")')
  [ "$count" -eq 4 ] && [ "$powers" = "25,25,25,25" ] || {
    echo "unexpected validator set at height $target_height: $expected_validators" >&2
    exit 1
  }
}

wait_for_tx() {
  port=$1
  hash=$2
  attempts=0
  while [ "$attempts" -lt 45 ]; do
    response=$(curl --silent --max-time 2 "http://127.0.0.1:$port/tx?hash=0x$hash&prove=true" || true)
    tx_height=$(echo "$response" | jq -er '.result.height | tonumber' 2>/dev/null || true)
    if [ -n "$tx_height" ] && [ "$tx_height" -gt 0 ]; then
      echo "$tx_height"
      return
    fi
    attempts=$((attempts + 1))
    sleep 1
  done
  echo "transaction $hash was not indexed by RPC port $port" >&2
  exit 1
}

echo "[1/7] reset deterministic local state and start four validators"
make --no-print-directory -C "$localnet_dir" reset
identity_before=$(sha256_file "$localnet_dir/.state/container/topology.json")
make --no-print-directory -C "$localnet_dir" up

for port in 26657 26757 26857 26957; do wait_for_height "$port" 5 >/dev/null; done
chain_id_hex=$(curl --fail --silent --show-error http://127.0.0.1:8545 \
  -H 'content-type: application/json' \
  --data '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' |
  jq -er '.result')
expected_chain_hex=$(printf '0x%x' "$expected_chain_id")
[ "$chain_id_hex" = "$expected_chain_hex" ] || {
  echo "EVM chain ID is $chain_id_hex, expected $expected_chain_hex" >&2
  exit 1
}

echo "[2/7] compare block, app hash, and validator set at a common height"
common_height=$(minimum_height)
assert_consistent_at "$common_height"

echo "[3/7] submit a signed native transfer and observe the finalized tx on every node"
deployer_key=$(printf '%s' 'torium/localnet/valueless-fixture/v1/account/deployer' | sha256_stdin)
recipient=$(jq -er '.development_accounts[] | select(.name == "sdk-user") | .bech32_address' \
  "$localnet_dir/../genesis/localnet/manifest.json")
printf '%s\n' 'valueless-localnet' | $compose exec -T validator-0 toriumd keys unsafe-import-eth-key \
  smoke-deployer "$deployer_key" \
  --home /var/lib/torium --keyring-backend test >/dev/null
tx_json=$($compose exec -T validator-0 toriumd tx bank send smoke-deployer "$recipient" 1atorium \
  --home /var/lib/torium \
  --keyring-backend test \
  --chain-id torium-localnet-1 \
  --node tcp://127.0.0.1:26657 \
  --gas 200000 \
  --fees 200000000000000atorium \
  --broadcast-mode sync \
  --yes \
  --output json)
tx_code=$(echo "$tx_json" | jq -er '.code // 0')
[ "$tx_code" -eq 0 ] || {
  echo "transaction rejected during CheckTx: $(echo "$tx_json" | jq -r '.raw_log')" >&2
  exit 1
}
tx_hash=$(echo "$tx_json" | jq -er '.txhash')
tx_height=""
for port in 26657 26757 26857 26957; do
  observed=$(wait_for_tx "$port" "$tx_hash")
  if [ -z "$tx_height" ]; then tx_height=$observed; fi
  [ "$observed" = "$tx_height" ] || { echo "tx finalized at inconsistent heights" >&2; exit 1; }
done
assert_consistent_at "$tx_height"

echo "[4/7] stop one 25-power validator and prove 75-power liveness"
before_loss=$(height 26657)
$compose stop validator-3 >/dev/null
target=$((before_loss + 3))
for port in 26657 26757 26857; do wait_for_height "$port" "$target" >/dev/null; done

echo "[5/7] restart the validator and prove catch-up"
$compose start validator-3 >/dev/null
catchup_target=$(height 26657)
wait_for_height 26957 "$catchup_target" >/dev/null
for port in 26657 26757 26857 26957; do wait_for_height "$port" "$catchup_target" >/dev/null; done
assert_consistent_at "$catchup_target"

echo "[6/7] verify homes, node IDs, and consensus addresses are all distinct"
jq -e '
  (.nodes | map(.home) | unique | length) == 4 and
  (.nodes | map(.node_id) | unique | length) == 4 and
  (.nodes | map(.consensus_address_hex) | unique | length) == 4
' "$localnet_dir/.state/container/topology.json" >/dev/null

echo "[7/7] clean reset and verify deterministic identities"
$compose down --remove-orphans >/dev/null
make --no-print-directory -C "$localnet_dir" reset
identity_after=$(sha256_file "$localnet_dir/.state/container/topology.json")
[ "$identity_before" = "$identity_after" ] || {
  echo "clean reset changed deterministic topology identity" >&2
  exit 1
}

echo "Torium four-validator localnet smoke test passed at tx height $tx_height."
