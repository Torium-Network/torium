#!/bin/sh
set -eu

suite_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo_root=$(CDPATH= cd -- "$suite_dir/../../.." && pwd)
baseline="$repo_root/chain/poc/upstream-baseline"
localnet="$repo_root/chain/localnet/torium-localnet"
manifest="$repo_root/chain/genesis/localnet/manifest.json"
artifacts="$suite_dir/.artifacts"

: "${TORIUM_DEV_MNEMONIC:?Supply a fresh disposable local-only mnemonic through the environment}"

cleanup() {
  status=$?
  trap - EXIT INT TERM HUP
  "$localnet" stop --backend container >/dev/null 2>&1 || true
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT TERM HUP

mkdir -p "$artifacts"
"$localnet" reset --backend container --yes >/dev/null
"$localnet" start --backend container --timeout 120 --json >/dev/null
(cd "$baseline" && npm ci --no-audit --no-fund)
"$baseline/scripts/download-metamask.sh"

evm_chain_id=$(jq -er '.evm_chain_id' "$manifest")
recipient=$(jq -er '.development_accounts[] | select(.name == "sdk-user") | .evm_address' "$manifest")

EVM_CHAIN_ID="$evm_chain_id" \
RPC_URL=http://127.0.0.1:8545 \
FAUCET_URL=http://127.0.0.1:8080/v1/fund \
TORIUM_NETWORK_NAME="Torium Localnet" \
NATIVE_CURRENCY_NAME="Valueless Torium" \
NATIVE_CURRENCY_SYMBOL=tTOR \
RPC_DISPLAY_NAME="Torium loopback RPC" \
PROBE_RECIPIENT="$recipient" \
METAMASK_EXTENSION_PATH="$baseline/.work/metamask-chrome-13.39.2" \
METAMASK_VERSION=13.39.2 \
REPORT_PATH="$artifacts/metamask.json" \
SCREENSHOT_PATH="$artifacts/metamask-custom-network.png" \
node "$baseline/metamask-probe.mjs"
