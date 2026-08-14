#!/bin/sh
# Operator restore drill for issue #116: exercises a real snapshot, a
# corrupt-archive rejection, and an atomic restore-to-consensus on the
# canonical four-validator localnet, proving pre-snapshot state survives,
# post-snapshot state is rolled back, and the restored network reaches
# consensus and keeps committing. Local-only; never touches public systems.
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo_root=$(CDPATH= cd -- "$script_dir/../.." && pwd)
localnet="$repo_root/chain/localnet/torium-localnet"
dev_faucet_url=http://127.0.0.1:8080
rpc_url=http://127.0.0.1:8545
toolchain="$repo_root/chain/toolchain.json"
foundry_image=$(jq -er '.contracts.foundry.image' "$toolchain")
work_dir="$repo_root/chain/localnet/.artifacts"
archive="$work_dir/restore-drill.tar.gz"
phase=prerequisites

for dependency in docker curl jq; do
  command -v "$dependency" >/dev/null 2>&1 || {
    echo "missing restore drill dependency: $dependency" >&2
    exit 1
  }
done

cast_cmd() {
  docker run --rm --network host --entrypoint cast "$foundry_image" "$@"
}

fund() {
  curl --fail --silent --show-error --max-time 50 \
    -H 'content-type: application/json' \
    --data "$(jq -cn --arg address "$1" --arg amount "$2" '{address:$address,amountBaseUnits:$amount}')" \
    "$dev_faucet_url/v1/fund"
}

# start_localnet boots the network, then reads readiness from the dedicated
# status command: `start` interleaves Compose/build progress with its JSON,
# while `status --json` emits the readiness document alone.
start_localnet() {
  "$localnet" start --backend container --timeout 180 >/dev/null
  "$localnet" status --backend container --json
}

assert_equal() {
  if [ "$1" != "$2" ]; then
    echo "$3: expected '$2', received '$1'" >&2
    exit 1
  fi
}

cleanup() {
  cleanup_status=$?
  trap - EXIT INT TERM HUP
  rm -f "$archive" "$archive.sha256" "$work_dir/restore-drill-corrupt.tar.gz" 2>/dev/null || true
  if [ "$cleanup_status" -ne 0 ]; then
    echo "restore drill failed in phase '$phase'" >&2
  fi
  exit "$cleanup_status"
}
trap cleanup EXIT
trap 'exit 130' INT TERM HUP

mkdir -p "$work_dir"

phase=boot
echo "[1/6] reset and boot the canonical localnet"
"$localnet" reset --backend container --yes >/dev/null
start_localnet | jq -e '.ready == true' >/dev/null

phase=pre-snapshot-state
echo "[2/6] create pre-snapshot state (funded wallet A)"
wallet_a=$(cast_cmd wallet new --json | jq -er '.[0].address')
fund "$wallet_a" "2000000000000000000" >/dev/null
assert_equal "$(cast_cmd balance "$wallet_a" --rpc-url "$rpc_url")" "2000000000000000000" "wallet A funded balance"

phase=snapshot
echo "[3/6] take a checksummed full-network snapshot"
"$localnet" snapshot --backend container --output "$archive" >/dev/null
"$localnet" inspect --archive "$archive" >/dev/null
start_localnet | jq -e '.ready == true' >/dev/null

phase=post-snapshot-state
echo "[4/6] advance past the snapshot (funded wallet B)"
wallet_b=$(cast_cmd wallet new --json | jq -er '.[0].address')
fund "$wallet_b" "1000000000000000000" >/dev/null
assert_equal "$(cast_cmd balance "$wallet_b" --rpc-url "$rpc_url")" "1000000000000000000" "wallet B funded balance"

phase=corrupt-archive-rejection
echo "[5/6] prove a corrupted archive is rejected and leaves state untouched"
corrupt="$work_dir/restore-drill-corrupt.tar.gz"
cp "$archive" "$corrupt"
# Flip one byte in the middle of the archive.
size=$(wc -c <"$corrupt")
offset=$((size / 2))
byte=$(dd if="$corrupt" bs=1 skip="$offset" count=1 2>/dev/null | od -An -tu1 | tr -d ' ')
printf "$(printf '\\%03o' $(( (byte + 1) % 256 )))" |
  dd of="$corrupt" bs=1 seek="$offset" count=1 conv=notrunc 2>/dev/null
if "$localnet" inspect --archive "$corrupt" >/dev/null 2>&1; then
  echo "corrupted archive passed inspection" >&2
  exit 1
fi
if "$localnet" restore --archive "$corrupt" >/dev/null 2>&1; then
  echo "corrupted archive was restored" >&2
  exit 1
fi
start_localnet | jq -e '.ready == true' >/dev/null
assert_equal "$(cast_cmd balance "$wallet_b" --rpc-url "$rpc_url")" "1000000000000000000" "wallet B intact after rejected restore"

phase=restore
echo "[6/6] restore the valid snapshot and prove rollback plus fresh consensus"
"$localnet" restore --archive "$archive" >/dev/null
start_localnet | jq -e '.ready == true and .allValidatorsReady == true' >/dev/null
assert_equal "$(cast_cmd balance "$wallet_a" --rpc-url "$rpc_url")" "2000000000000000000" "wallet A present after restore"
assert_equal "$(cast_cmd balance "$wallet_b" --rpc-url "$rpc_url")" "0" "wallet B rolled back to the snapshot anchor"
height_after_restore=$(curl --fail --silent --max-time 5 http://127.0.0.1:26657/status | jq -er '.result.sync_info.latest_block_height')
sleep 6
height_later=$(curl --fail --silent --max-time 5 http://127.0.0.1:26657/status | jq -er '.result.sync_info.latest_block_height')
if [ "$height_later" -le "$height_after_restore" ]; then
  echo "restored network is not committing new heights" >&2
  exit 1
fi
genesis_block=$(curl --fail --silent --max-time 5 "http://127.0.0.1:26657/block?height=1" | jq -er '.result.block.header.height')
assert_equal "$genesis_block" "1" "query window reaches height 1 after restore"

jq -n \
  --arg walletA "$wallet_a" \
  --arg walletB "$wallet_b" \
  --argjson heightAfterRestore "$height_after_restore" \
  --argjson heightLater "$height_later" \
  '{
    schemaVersion: 1,
    drill: "operator-snapshot-restore-v0",
    result: "passed",
    surfaces: [
      "snapshot-create",
      "archive-inspect",
      "corrupt-archive-rejected-without-mutation",
      "atomic-restore",
      "pre-snapshot-state-preserved",
      "post-snapshot-state-rolled-back",
      "post-restore-consensus-liveness",
      "height-1-query-window"
    ],
    preSnapshotWallet: $walletA,
    postSnapshotWallet: $walletB,
    heightAfterRestore: $heightAfterRestore,
    heightAfterLiveness: $heightLater
  }'
