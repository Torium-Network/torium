#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
CONTRACTS_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
REPO_ROOT=$(CDPATH= cd -- "$CONTRACTS_DIR/.." && pwd)
MANIFEST="$REPO_ROOT/chain/toolchain.json"
ARTIFACTS_DIR="$CONTRACTS_DIR/.artifacts"
CONTAINER_SOLC=/opt/torium-solc

manifest_value() {
  node -e '
    const manifest = require(process.argv[1]);
    const value = process.argv[2].split(".").reduce((current, key) => current?.[key], manifest);
    if (value === undefined || value === null || value === "") process.exit(1);
    process.stdout.write(String(value));
  ' "$MANIFEST" "$1"
}

require_digest_image() {
  case "$1" in
    *@sha256:????????????????????????????????????????????????????????????????) ;;
    *)
      echo "Tool image is not digest-pinned: $1" >&2
      exit 1
      ;;
  esac
}

NODE_VERSION=$(manifest_value runtimes.node.version)
NODE_IMAGE=$(manifest_value runtimes.node.image)
FOUNDRY_VERSION=$(manifest_value contracts.foundry.version)
FOUNDRY_IMAGE=$(manifest_value contracts.foundry.image)
SOLC_VERSION=$(manifest_value contracts.solidity.version)
SOLC_IMAGE=$(manifest_value contracts.solidity.image)
SOLC_IMAGE_PATH=$(manifest_value contracts.solidity.binaryPath)
SOLC_DIGEST=${SOLC_IMAGE##*@sha256:}
SOLC_FILE="$ARTIFACTS_DIR/toolchain/solc-$SOLC_VERSION-$SOLC_DIGEST"

require_digest_image "$NODE_IMAGE"
require_digest_image "$FOUNDRY_IMAGE"
require_digest_image "$SOLC_IMAGE"

mkdir -p "$ARTIFACTS_DIR/toolchain" "$ARTIFACTS_DIR/npm-cache"

ensure_solc() {
  if [ -x "$SOLC_FILE" ]; then
    return
  fi

  temporary="$SOLC_FILE.tmp.$$"
  container="torium-solc-extract-$$"
  rm -f "$temporary"
  cleanup_extract() {
    docker rm -f "$container" >/dev/null 2>&1 || true
    rm -f "$temporary"
  }
  trap cleanup_extract EXIT HUP INT TERM

  docker create --platform linux/amd64 --name "$container" "$SOLC_IMAGE" >/dev/null
  docker cp "$container:$SOLC_IMAGE_PATH" "$temporary"
  docker rm "$container" >/dev/null
  chmod 0755 "$temporary"
  mv "$temporary" "$SOLC_FILE"
  trap - EXIT HUP INT TERM
}

run_node_tool() {
  entrypoint=$1
  shift
  docker run --rm --init \
    --user "$(id -u):$(id -g)" \
    --volume "$REPO_ROOT:/workspace" \
    --workdir /workspace/contracts \
    --env HOME=/tmp \
    --env NPM_CONFIG_CACHE=/workspace/contracts/.artifacts/npm-cache \
    --env NPM_CONFIG_AUDIT=false \
    --env NPM_CONFIG_FUND=false \
    --env NPM_CONFIG_UPDATE_NOTIFIER=false \
    --entrypoint "$entrypoint" \
    "$NODE_IMAGE" "$@"
}

run_foundry_tool() {
  ensure_solc
  entrypoint=$1
  shift

  if [ -n "${TORIUM_DOCKER_NETWORK:-}" ]; then
    docker run --rm --init --platform linux/amd64 \
      --user "$(id -u):$(id -g)" \
      --network "$TORIUM_DOCKER_NETWORK" \
      --volume "$REPO_ROOT:/workspace" \
      --volume "$SOLC_FILE:$CONTAINER_SOLC:ro" \
      --workdir /workspace/contracts \
      --env HOME=/tmp \
      --entrypoint "$entrypoint" \
      "$FOUNDRY_IMAGE" "$@"
  else
    docker run --rm --init --platform linux/amd64 \
      --user "$(id -u):$(id -g)" \
      --volume "$REPO_ROOT:/workspace" \
      --volume "$SOLC_FILE:$CONTAINER_SOLC:ro" \
      --workdir /workspace/contracts \
      --env HOME=/tmp \
      --entrypoint "$entrypoint" \
      "$FOUNDRY_IMAGE" "$@"
  fi
}

verify_toolchain() {
  ensure_solc

  node_report=$(run_node_tool node --version)
  [ "$node_report" = "v$NODE_VERSION" ] || {
    echo "Expected Node $NODE_VERSION, got $node_report" >&2
    exit 1
  }

  foundry_report=$(run_foundry_tool forge --version)
  case "$foundry_report" in
    *"$FOUNDRY_VERSION"*) ;;
    *)
      echo "Expected Foundry $FOUNDRY_VERSION, got: $foundry_report" >&2
      exit 1
      ;;
  esac

  solc_report=$(run_foundry_tool "$CONTAINER_SOLC" --version)
  case "$solc_report" in
    *"Version: $SOLC_VERSION"*) ;;
    *)
      echo "Expected solc $SOLC_VERSION, got: $solc_report" >&2
      exit 1
      ;;
  esac

  run_node_tool node -e '
    const manifest = require("/workspace/chain/toolchain.json");
    const lock = require("/workspace/contracts/package-lock.json");
    const root = lock.packages?.[""];
    const installed = lock.packages ?? {};
    const expectedOZ = manifest.contracts.openZeppelin.version;
    const expectedSolhint = manifest.contracts.solhint.version;
    const expectedPrettier = manifest.quality.prettier.version;
    const expectedAjv = manifest.contracts.schemaValidator.version;
    if (root?.dependencies?.["@openzeppelin/contracts"] !== expectedOZ ||
        installed["node_modules/@openzeppelin/contracts"]?.version !== expectedOZ) {
      throw new Error(`OpenZeppelin lock does not match ${expectedOZ}`);
    }
    if (root?.devDependencies?.solhint !== expectedSolhint ||
        installed["node_modules/solhint"]?.version !== expectedSolhint) {
      throw new Error(`Solhint lock does not match ${expectedSolhint}`);
    }
    if (root?.devDependencies?.prettier !== expectedPrettier ||
        installed["node_modules/prettier"]?.version !== expectedPrettier) {
      throw new Error(`Prettier lock does not match ${expectedPrettier}`);
    }
    if (root?.devDependencies?.ajv !== expectedAjv ||
        installed["node_modules/ajv"]?.version !== expectedAjv) {
      throw new Error(`Ajv lock does not match ${expectedAjv}`);
    }
  '
}

usage() {
  echo "Usage: $0 {verify|deps|node ARGS...|npm ARGS...|foundry TOOL ARGS...}" >&2
  exit 2
}

command=${1:-}
[ -n "$command" ] || usage
shift

case "$command" in
  verify)
    [ "$#" -eq 0 ] || usage
    verify_toolchain
    ;;
  deps)
    [ "$#" -eq 0 ] || usage
    [ -f "$CONTRACTS_DIR/package-lock.json" ] || {
      echo "contracts/package-lock.json is required for npm ci" >&2
      exit 1
    }
    run_node_tool npm ci --ignore-scripts --no-audit --no-fund
    ;;
  node)
    run_node_tool node "$@"
    ;;
  npm)
    run_node_tool npm "$@"
    ;;
  foundry)
    [ "$#" -gt 0 ] || usage
    tool=$1
    shift
    run_foundry_tool "$tool" "$@"
    ;;
  *)
    usage
    ;;
esac
