#!/bin/sh
# Chain-start rehearsal consuming the network artifact bundle (#123): proves
# chain/releases/network-artifacts-v0.json is actually consumable by (1)
# verifying the bundle and its pinned genesis bytes, (2) booting the
# canonical localnet, (3) asserting the state genesis each validator loaded
# is byte-identical to the bundle-pinned genesis, and (4) asserting the live
# chain matches every bundle identifier and wallet-add value over RPC/REST.
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo_root=$(CDPATH= cd -- "$script_dir/../.." && pwd)
localnet="$repo_root/chain/localnet/torium-localnet"
bundle="$script_dir/network-artifacts-v0.json"
rpc_url=http://127.0.0.1:8545
rest_url=http://127.0.0.1:1317
keep_running=false

[ "${1:-}" = "--keep-running" ] && keep_running=true

for dependency in jq node curl docker; do
  command -v "$dependency" >/dev/null 2>&1 || {
    echo "missing rehearsal dependency: $dependency" >&2
    exit 1
  }
done

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

assert_equal() {
  if [ "$1" != "$2" ]; then
    echo "$3: expected '$2', received '$1'" >&2
    exit 1
  fi
}

echo "[1/4] verify the bundle and its pinned genesis bytes"
node "$script_dir/generate-network-artifacts-v0.mjs" --check >/dev/null
genesis_path=$(jq -er '.environments.localnet.genesis.path' "$bundle")
genesis_sha=$(jq -er '.environments.localnet.genesis.sha256' "$bundle")
assert_equal "$(sha256_file "$repo_root/$genesis_path")" "$genesis_sha" "bundle-pinned genesis bytes"

echo "[2/4] boot the canonical localnet from a clean reset"
"$localnet" reset --backend container --yes >/dev/null
readiness=$("$localnet" start --backend container --timeout 180 --json)
printf '%s' "$readiness" | jq -e '.ready == true and .allValidatorsReady == true' >/dev/null

cleanup() {
  cleanup_status=$?
  if [ "$keep_running" != true ]; then
    "$localnet" stop --backend container >/dev/null 2>&1 || true
  fi
  exit "$cleanup_status"
}
trap cleanup EXIT

echo "[3/4] assert every validator loaded exactly the bundle-pinned genesis"
for validator in validator-0 validator-1 validator-2 validator-3; do
  state_genesis="$repo_root/chain/localnet/.state/container/$validator/config/genesis.json"
  assert_equal "$(sha256_file "$state_genesis")" "$genesis_sha" "$validator state genesis"
done

echo "[4/4] assert the live chain matches the bundle identifiers and wallet metadata"
expected_evm_hex=$(jq -er '.environments.localnet.identifiers.evmChainIdHex' "$bundle")
expected_cosmos=$(jq -er '.environments.localnet.identifiers.cosmosChainId' "$bundle")
expected_decimals=$(jq -er '.environments.localnet.nativeCurrency.decimals' "$bundle")
expected_denom=$(jq -er '.environments.localnet.nativeCurrency.baseDenom' "$bundle")
wallet_chain_id=$(jq -er '.environments.localnet.wallet.eip3085.chainId' "$bundle")
wallet_rpc=$(jq -er '.environments.localnet.wallet.eip3085.rpcUrls[0]' "$bundle")

rpc_chain_id=$(curl --fail --silent --max-time 5 -H 'content-type: application/json' \
  --data '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' "$wallet_rpc" | jq -er '.result')
assert_equal "$rpc_chain_id" "$expected_evm_hex" "eth_chainId over the bundle rpcUrl"
assert_equal "$wallet_chain_id" "$expected_evm_hex" "wallet chainId consistency"

net_version=$(curl --fail --silent --max-time 5 -H 'content-type: application/json' \
  --data '{"jsonrpc":"2.0","id":1,"method":"net_version","params":[]}' "$rpc_url" | jq -er '.result')
assert_equal "$net_version" "$(jq -er '.environments.localnet.identifiers.networkId' "$bundle")" "net_version"

node_chain_id=$(curl --fail --silent --max-time 5 "http://127.0.0.1:26657/status" |
  jq -er '.result.node_info.network')
assert_equal "$node_chain_id" "$expected_cosmos" "CometBFT network id"

denom_metadata=$(curl --fail --silent --max-time 5 \
  "$rest_url/cosmos/bank/v1beta1/denoms_metadata/$expected_denom")
printf '%s' "$denom_metadata" | jq -e --arg denom "$expected_denom" --argjson decimals "$expected_decimals" '
  .metadata.base == $denom and
  ([.metadata.denom_units[] | select(.denom == "tTOR") | .exponent] | first) == $decimals
' >/dev/null

jq -n \
  --arg genesisSha "$genesis_sha" \
  --arg cosmosChainId "$expected_cosmos" \
  --arg evmChainIdHex "$expected_evm_hex" \
  '{
    schemaVersion: 1,
    rehearsal: "chain-start-from-network-artifacts-v0",
    result: "passed",
    genesisSha256: $genesisSha,
    cosmosChainId: $cosmosChainId,
    evmChainIdHex: $evmChainIdHex,
    surfaces: ["bundle-check", "state-genesis-bytes", "eth_chainId", "net_version", "comet-status", "bank-denom-metadata"]
  }'
