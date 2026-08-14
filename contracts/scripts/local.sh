#!/bin/sh
set -eu
umask 077

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
CONTRACTS_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
REPO_ROOT=$(CDPATH= cd -- "$CONTRACTS_DIR/.." && pwd)
RUN="$SCRIPT_DIR/run-in-toolchain.sh"
MANIFEST="$REPO_ROOT/chain/toolchain.json"
IDENTIFIERS="$REPO_ROOT/chain/config/identifiers.json"
GENESIS_MANIFEST="$REPO_ROOT/chain/genesis/localnet/manifest.json"

FIXTURE_VALUE=42
SALT_LABEL=torium.contract-fixture.v1
ARTIFACT_DIR="$CONTRACTS_DIR/.artifacts/local-acceptance"
FACTORY_ARTIFACT=.work/out/ToriumCreate2Factory.sol/ToriumCreate2Factory.json
FIXTURE_ARTIFACT=.work/out/DeploymentFixture.sol/DeploymentFixture.json

manifest_value() {
  node -e '
    const manifest = require(process.argv[1]);
    const value = process.argv[2].split(".").reduce((current, key) => current?.[key], manifest);
    if (value === undefined || value === null || value === "") process.exit(1);
    process.stdout.write(String(value));
  ' "$MANIFEST" "$1"
}

localnet_chain_id() {
  node -e '
    const identifiers = require(process.argv[1]);
    const localnet = identifiers.networks.find(({ environment }) => environment === "localnet");
    if (!Number.isSafeInteger(localnet?.evm?.chainId)) process.exit(1);
    process.stdout.write(String(localnet.evm.chainId));
  ' "$IDENTIFIERS"
}

localnet_deployer() {
  node -e '
    const manifest = require(process.argv[1]);
    const deployer = manifest.development_accounts?.find(({ name }) => name === "deployer");
    if (!/^0x[0-9a-fA-F]{40}$/.test(deployer?.evm_address ?? "")) process.exit(1);
    process.stdout.write(deployer.evm_address);
  ' "$GENESIS_MANIFEST"
}

artifact_field() {
  "$RUN" node -e '
    const artifact = require(`/workspace/contracts/${process.argv[1]}`);
    const value = process.argv[2].split(".").reduce((current, key) => current?.[key], artifact);
    if (typeof value !== "string" || !value.startsWith("0x")) process.exit(1);
    process.stdout.write(value);
  ' "$1" "$2"
}

receipt_field() {
  "$RUN" node -e '
    const receipt = require(`/workspace/contracts/${process.argv[1]}`);
    const value = receipt[process.argv[2]];
    if (value === undefined || value === null || value === "") process.exit(1);
    process.stdout.write(String(value));
  ' "$1" "$2"
}

lower() {
  printf '%s' "$1" | tr '[:upper:]' '[:lower:]'
}

assert_equal() {
  actual=$1
  expected=$2
  label=$3
  if [ "$(lower "$actual")" != "$(lower "$expected")" ]; then
    echo "$label mismatch: expected $expected, got $actual" >&2
    exit 1
  fi
}

resolve_factory_plan() {
  code=$("$RUN" foundry cast code --rpc-url "$RPC_URL" "$factory_expected")
  if [ "$code" != "0x" ]; then
    actual_hash=$("$RUN" foundry cast keccak "$code")
    assert_equal "$actual_hash" "$factory_runtime_hash" "existing factory runtime hash"
    printf 'resolved'
    return
  fi

  nonce=$("$RUN" foundry cast nonce --rpc-url "$RPC_URL" "$DEPLOYER")
  assert_equal "$nonce" 0 "fixture deployer nonce before factory bootstrap"
  printf 'ready-to-deploy'
}

FOUNDRY_IMAGE=$(manifest_value contracts.foundry.image)
SOLC_VERSION=$(manifest_value contracts.solidity.version)
EXPECTED_CHAIN_ID=$(localnet_chain_id)
# Only the canonical fixture account's public address is reused. The ephemeral
# node owns no accounts and auto-impersonates this sender without signing data.
DEPLOYER=$(localnet_deployer)
NETWORK="torium-contract-acceptance-$$"
ANVIL_CONTAINER="torium-contract-anvil-$$"
RPC_URL="http://$ANVIL_CONTAINER:8545"
TORIUM_DOCKER_NETWORK=$NETWORK
export TORIUM_DOCKER_NETWORK

cleanup() {
  docker rm -f "$ANVIL_CONTAINER" >/dev/null 2>&1 || true
  docker network rm "$NETWORK" >/dev/null 2>&1 || true
}
trap cleanup EXIT HUP INT TERM

rm -rf "$ARTIFACT_DIR"
mkdir -p "$ARTIFACT_DIR"

docker network create "$NETWORK" >/dev/null
# Exactly one silent, ephemeral node is started for this acceptance. The fixed
# sender is auto-impersonated; no signing secret is created, read, or logged.
docker run --detach --rm --init --platform linux/amd64 \
  --name "$ANVIL_CONTAINER" \
  --network "$NETWORK" \
  --entrypoint anvil \
  "$FOUNDRY_IMAGE" \
  --host 0.0.0.0 \
  --port 8545 \
  --chain-id "$EXPECTED_CHAIN_ID" \
  --accounts 0 \
  --auto-impersonate \
  --silent >/dev/null

ready=false
attempt=0
while [ "$attempt" -lt 30 ]; do
  if "$RUN" foundry cast block-number --rpc-url "$RPC_URL" >/dev/null 2>&1; then
    ready=true
    break
  fi
  attempt=$((attempt + 1))
  sleep 1
done
[ "$ready" = true ] || {
  echo "Ephemeral Anvil did not become ready" >&2
  exit 1
}

chain_id=$("$RUN" foundry cast chain-id --rpc-url "$RPC_URL")
assert_equal "$chain_id" "$EXPECTED_CHAIN_ID" "chain id"
"$RUN" foundry cast rpc --rpc-url "$RPC_URL" anvil_setBalance "$DEPLOYER" 0x56BC75E2D63100000 >/dev/null

factory_creation=$(artifact_field "$FACTORY_ARTIFACT" bytecode.object)
factory_runtime=$(artifact_field "$FACTORY_ARTIFACT" deployedBytecode.object)
factory_runtime_hash=$("$RUN" foundry cast keccak "$factory_runtime")
factory_expected=$("$RUN" foundry cast compute-address "$DEPLOYER" --nonce 0 | awk '{ print $NF }')
factory_state_before=$(resolve_factory_plan)
assert_equal "$factory_state_before" "ready-to-deploy" "factory bootstrap state"

"$RUN" foundry cast send \
  --rpc-url "$RPC_URL" \
  --from "$DEPLOYER" \
  --unlocked \
  --json \
  --create "$factory_creation" >"$ARTIFACT_DIR/factory-receipt.json"

factory_address=$(receipt_field .artifacts/local-acceptance/factory-receipt.json contractAddress)
factory_transaction=$(receipt_field .artifacts/local-acceptance/factory-receipt.json transactionHash)
assert_equal "$factory_address" "$factory_expected" "factory deterministic address"
factory_code=$("$RUN" foundry cast code --rpc-url "$RPC_URL" "$factory_address")
factory_actual_hash=$("$RUN" foundry cast keccak "$factory_code")
assert_equal "$factory_actual_hash" "$factory_runtime_hash" "factory runtime hash"
factory_state_after=$(resolve_factory_plan)
assert_equal "$factory_state_after" "resolved" "factory resolution state"

fixture_creation=$(artifact_field "$FIXTURE_ARTIFACT" bytecode.object)
fixture_runtime=$(artifact_field "$FIXTURE_ARTIFACT" deployedBytecode.object)
fixture_runtime_hash=$("$RUN" foundry cast keccak "$fixture_runtime")
constructor_args=$("$RUN" foundry cast abi-encode 'f(address,uint256)' "$DEPLOYER" "$FIXTURE_VALUE")
configuration_hash=$("$RUN" foundry cast keccak "$constructor_args")
init_code="${fixture_creation}${constructor_args#0x}"
init_code_hash=$("$RUN" foundry cast keccak "$init_code")
salt=$("$RUN" foundry cast keccak "$SALT_LABEL")
predicted=$("$RUN" foundry cast call \
  --rpc-url "$RPC_URL" \
  "$factory_address" \
  'computeAddress(bytes32,bytes32)(address)' \
  "$salt" "$init_code_hash")

"$RUN" foundry cast send \
  --rpc-url "$RPC_URL" \
  --from "$DEPLOYER" \
  --unlocked \
  --json \
  "$factory_address" \
  'deploy(bytes32,bytes,bytes32)(address)' \
  "$salt" "$init_code" "$fixture_runtime_hash" >"$ARTIFACT_DIR/fixture-first-receipt.json"

first_transaction=$(receipt_field .artifacts/local-acceptance/fixture-first-receipt.json transactionHash)
fixture_code=$("$RUN" foundry cast code --rpc-url "$RPC_URL" "$predicted")
fixture_actual_hash=$("$RUN" foundry cast keccak "$fixture_code")
assert_equal "$fixture_actual_hash" "$fixture_runtime_hash" "fixture runtime hash"

owner=$("$RUN" foundry cast call --rpc-url "$RPC_URL" "$predicted" 'owner()(address)')
value=$("$RUN" foundry cast call --rpc-url "$RPC_URL" "$predicted" 'value()(uint256)')
assert_equal "$owner" "$DEPLOYER" "fixture owner"
assert_equal "$value" "$FIXTURE_VALUE" "fixture value"

# The second call exercises the factory's idempotent resolution branch. It must
# preserve the predicted address and exact runtime hash instead of redeploying.
"$RUN" foundry cast send \
  --rpc-url "$RPC_URL" \
  --from "$DEPLOYER" \
  --unlocked \
  --json \
  "$factory_address" \
  'deploy(bytes32,bytes,bytes32)(address)' \
  "$salt" "$init_code" "$fixture_runtime_hash" >"$ARTIFACT_DIR/fixture-repeat-receipt.json"

repeat_transaction=$(receipt_field .artifacts/local-acceptance/fixture-repeat-receipt.json transactionHash)
repeat_code=$("$RUN" foundry cast code --rpc-url "$RPC_URL" "$predicted")
repeat_hash=$("$RUN" foundry cast keccak "$repeat_code")
assert_equal "$repeat_hash" "$fixture_runtime_hash" "repeat runtime hash"

evidence_tmp="$ARTIFACT_DIR/evidence.json.tmp"
printf '%s\n' \
  '{' \
  '  "schemaVersion": 1,' \
  '  "canonicalNetwork": false,' \
  '  "environment": "local-acceptance",' \
  '  "networkKind": "ephemeral-contract-fixture",' \
  "  \"evmChainId\": $EXPECTED_CHAIN_ID," \
  "  \"deployer\": \"$DEPLOYER\"," \
  "  \"factoryAddress\": \"$factory_address\"," \
  "  \"factoryBootstrapStateBefore\": \"$factory_state_before\"," \
  "  \"factoryBootstrapStateAfter\": \"$factory_state_after\"," \
  "  \"factoryRuntimeCodeHash\": \"$factory_runtime_hash\"," \
  "  \"factoryTransactionHash\": \"$factory_transaction\"," \
  "  \"fixtureAddress\": \"$predicted\"," \
  "  \"fixtureSalt\": \"$salt\"," \
  "  \"fixtureConfigurationHash\": \"$configuration_hash\"," \
  "  \"fixtureInitCodeHash\": \"$init_code_hash\"," \
  "  \"fixtureRuntimeCodeHash\": \"$fixture_runtime_hash\"," \
  "  \"firstDeploymentTransactionHash\": \"$first_transaction\"," \
  "  \"repeatResolutionTransactionHash\": \"$repeat_transaction\"," \
  "  \"solidityVersion\": \"$SOLC_VERSION\"," \
  "  \"foundryImage\": \"$FOUNDRY_IMAGE\"" \
  '}' >"$evidence_tmp"
mv "$evidence_tmp" "$ARTIFACT_DIR/evidence.json"

printf 'Ephemeral acceptance passed at %s (noncanonical evidence: %s)\n' \
  "$predicted" "$ARTIFACT_DIR/evidence.json"
