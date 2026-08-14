#!/bin/sh
# Torium SDK localnet conformance runner (#137).
#
# Packs the real @torium-network/sdk tarball, installs it into a disposable
# consumer package (no workspace/source aliases), ensures the disposable
# valueless localnet is running, executes the conformance suite against it,
# and checks the committed compatibility matrix.
#
# Usage: chain/tests/sdk-conformance/run.sh [--write]
#   --write   update proof/sdk-conformance-matrix.json from this passing run
set -eu

suite_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo_root=$(CDPATH= cd -- "$suite_dir/../../.." && pwd)
sdk_dir="$repo_root/packages/torium-sdk"
localnet="$repo_root/chain/localnet/torium-localnet"
matrix_mode="--check"
[ "${1:-}" = "--write" ] && matrix_mode="--write"

for dependency in node npm pnpm docker; do
  command -v "$dependency" >/dev/null 2>&1 || {
    echo "missing SDK conformance dependency: $dependency" >&2
    exit 1
  }
done

viem_version=$(node -p 'JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).baseline.viem.testedVersion' "$repo_root/chain/config/sdk-policy-v0.json")

consumer=$(mktemp -d "${TMPDIR:-/tmp}/torium-sdk-conformance.XXXXXX")
started_localnet=0
cleanup() {
  status=$?
  if [ $status -ne 0 ]; then
    echo "--- conformance diagnostics (exit $status) ---" >&2
    "$localnet" status >&2 2>&1 || true
  fi
  if [ "$started_localnet" = 1 ] && [ "${TORIUM_CONFORMANCE_KEEP_LOCALNET:-0}" != 1 ]; then
    "$localnet" stop >/dev/null 2>&1 || true
  fi
  rm -rf "$consumer"
  exit $status
}
trap cleanup EXIT INT TERM

echo "==> building and packing the SDK"
pnpm --filter @torium-network/sdk run build >/dev/null
(cd "$sdk_dir" && npm pack --pack-destination "$consumer" >/dev/null)
tarball=$(ls "$consumer"/torium-network-sdk-*.tgz)

echo "==> installing the packed tarball into a disposable consumer"
cat > "$consumer/package.json" <<'JSON'
{
  "name": "torium-sdk-conformance-consumer",
  "private": true,
  "type": "module"
}
JSON
(cd "$consumer" && npm install --ignore-scripts --no-audit --no-fund \
  --package-lock=false --prefer-offline \
  "$tarball" "viem@$viem_version" >/dev/null)
cp -R "$suite_dir/suite" "$consumer/suite"

echo "==> ensuring the disposable localnet is ready"
if ! "$localnet" status >/dev/null 2>&1; then
  "$localnet" start
  started_localnet=1
fi

echo "==> running the conformance suite against the packed SDK"
results="$consumer/conformance-results.jsonl"
: > "$results"
(cd "$consumer" && \
  TORIUM_CONFORMANCE_REPO_ROOT="$repo_root" \
  TORIUM_CONFORMANCE_RESULTS="$results" \
  node --test --test-force-exit suite/run-suite.mjs)

echo "==> validating the compatibility matrix"
node "$suite_dir/scripts/assemble-matrix.mjs" "$results" "$matrix_mode"

# #145: execute the documentation snippets marked snippet=live against the
# same packed tarball, so a documented flow the shipped package cannot
# perform fails here rather than in a reader's terminal.
echo "==> executing live documentation snippets against the packed SDK"
node "$repo_root/apps/developer-docs/scripts/run-live-snippets.mjs" --consumer "$consumer"

echo "SDK localnet conformance: PASS"
