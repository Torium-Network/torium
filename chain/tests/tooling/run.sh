#!/bin/sh
set -eu

suite_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo_root=$(CDPATH= cd -- "$suite_dir/../../.." && pwd)
localnet="$repo_root/chain/localnet/torium-localnet"
manifest="$repo_root/chain/genesis/localnet/manifest.json"
toolchain="$repo_root/chain/toolchain.json"
report="$suite_dir/.artifacts/latest-report.json"

for command in docker jq node npm; do
  command -v "$command" >/dev/null 2>&1 || {
    echo "missing required command: $command" >&2
    exit 1
  }
done

cleanup() {
  status=$?
  trap - EXIT INT TERM HUP
  "$localnet" stop --backend container >/dev/null 2>&1 || true
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT TERM HUP

echo "[1/5] install and validate exact tooling pins"
(cd "$suite_dir" && npm ci --no-audit --no-fund)
(cd "$suite_dir" && npm run check)

echo "[2/5] reset and start the canonical four-validator localnet"
"$localnet" reset --backend container --yes >/dev/null
"$localnet" start --backend container --timeout 120 --json >/dev/null

echo "[3/5] exercise viem, ethers, Hardhat, Solidity, and OpenZeppelin contracts"
(cd "$suite_dir" && npm run probe)

echo "[4/5] verify the digest-pinned Foundry client against the same chain"
foundry_image=$(jq -er '.contracts.foundry.image' "$toolchain")
expected_chain_id=$(jq -er '.evm_chain_id' "$manifest")
observed_chain_id=$(docker run --rm --network host --entrypoint cast \
  "$foundry_image" chain-id --rpc-url http://127.0.0.1:8545)
[ "$observed_chain_id" = "$expected_chain_id" ] || {
  echo "Foundry observed chain ID $observed_chain_id, expected $expected_chain_id" >&2
  exit 1
}
report_tmp="$report.tmp"
jq --arg foundryVersion "$(jq -er '.contracts.foundry.version' "$toolchain")" \
  --arg foundryChainId "$observed_chain_id" \
  '.clients.foundry = $foundryVersion | .checks.foundryChainId = $foundryChainId' \
  "$report" >"$report_tmp"
mv "$report_tmp" "$report"

echo "[5/5] tooling conformance passed on Torium localnet"
