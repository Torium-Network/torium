#!/usr/bin/env node

// Offline validation of the public-testnet deployment registry. It recomputes
// every deterministic value (nonce-zero CREATE address, CREATE2 salts,
// init-code hashes and addresses) from the pinned generated artifacts and the
// reviewed deployment configuration, and requires exact agreement with the
// localnet code identity. It never contacts a chain.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  concatHex,
  encodeAbiParameters,
  getAddress,
  getContractAddress,
  getCreate2Address,
  keccak256,
  stringToHex,
} from "viem";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../.."
);
const require = createRequire(import.meta.url);
const Ajv2020 = require("ajv/dist/2020").default;

const registry = await readJson("contracts/deployments/testnet.json");
const schema = await readJson(
  "contracts/deployments/deployment-registry-testnet-v1.schema.json"
);
const config = await readJson("contracts/config/testnet-deployment-v1.json");
const localnet = await readJson("contracts/deployments/localnet.json");
const identifiers = await readJson("chain/config/identifiers.json");
const genesisManifest = await readJson("chain/genesis/testnet/manifest.json");

const validate = new Ajv2020({ strict: true, allErrors: true }).compile(schema);
assert.equal(
  validate(registry),
  true,
  `testnet registry schema validation failed: ${JSON.stringify(validate.errors)}`
);

const testnetIdentity = identifiers.networks.find(
  (network) => network.environment === "testnet"
);
assert.ok(testnetIdentity, "canonical testnet identifiers are missing");
assert.equal(registry.chain.cosmosChainId, testnetIdentity.cosmos.chainId);
assert.equal(registry.chain.evmChainId, testnetIdentity.evm.chainId);
assert.equal(registry.chain.cosmosChainId, genesisManifest.cosmos_chain_id);
assert.equal(registry.chain.evmChainId, genesisManifest.evm_chain_id);
assert.equal(registry.chain.genesisSha256, genesisManifest.genesis_sha256);

assert.deepEqual(registry.authority, config.authority);
const deployerAddress = getAddress(registry.authority.deployerAddress);

const localnetById = new Map(localnet.entries.map((entry) => [entry.id, entry]));
const registryById = new Map(registry.entries.map((entry) => [entry.id, entry]));
assert.deepEqual(
  [...registryById.keys()].sort(),
  [
    "attestation-registry",
    "reward-distributor",
    "torium-create2-factory",
    "torium-native",
  ],
  "testnet registry entries differ from the expected component set"
);

const native = registryById.get("torium-native");
assert.equal(native.address, localnetById.get("torium-native").address);
assert.equal(native.codeIdentity, "protocol-precompile-no-evm-bytecode");
assert.equal(native.deployment, null);

const artifacts = new Map();
for (const id of [
  "torium-create2-factory",
  "attestation-registry",
  "reward-distributor",
]) {
  const entry = registryById.get(id);
  const pinned = localnetById.get(id);
  assert.ok(pinned, `localnet registry entry ${id} is missing`);
  assert.equal(entry.contractName, pinned.contractName);
  assert.equal(entry.codeIdentity.artifactPath, pinned.artifactPath);
  assert.equal(
    entry.codeIdentity.creationCodeKeccak256,
    pinned.code.creationCodeKeccak256,
    `${id} creation code hash differs from the localnet code identity`
  );
  assert.equal(
    entry.codeIdentity.runtimeCodeKeccak256,
    pinned.code.runtimeCodeKeccak256,
    `${id} runtime code hash differs from the localnet code identity`
  );
  const artifact = await readJson(entry.codeIdentity.artifactPath);
  assert.equal(
    keccak256(artifact.bytecode.creation),
    entry.codeIdentity.creationCodeKeccak256,
    `${id} generated artifact creation code differs from the recorded hash`
  );
  artifacts.set(id, artifact);
  assert.ok(
    entry.verification.explorerUrl.endsWith(`/address/${entry.address}`),
    `${id} explorer URL does not reference the recorded address`
  );
}

const factory = registryById.get("torium-create2-factory");
assert.equal(factory.deployment.strategy, "deployer-create-nonce-0");
assert.equal(getAddress(factory.deployment.deployerAddress), deployerAddress);
assert.equal(
  getAddress(factory.address),
  getContractAddress({ from: deployerAddress, nonce: 0n }),
  "factory address does not match the nonce-zero CREATE prediction"
);

for (const id of ["attestation-registry", "reward-distributor"]) {
  const entry = registryById.get(id);
  const plan = config.deployments[id];
  assert.ok(plan, `deployment plan ${id} is missing from the configuration`);
  assert.equal(entry.deployment.strategy, plan.strategy);
  assert.equal(entry.deployment.strategy, "factory-create2");
  assert.equal(
    getAddress(entry.deployment.factoryAddress),
    getAddress(factory.address)
  );
  assert.equal(entry.deployment.saltPreimage, plan.saltPreimage);
  assert.equal(
    entry.deployment.salt,
    keccak256(stringToHex(plan.saltPreimage)),
    `${id} salt does not match its recorded preimage`
  );
  assert.deepEqual(
    entry.deployment.constructorArguments,
    plan.constructorArguments,
    `${id} constructor arguments differ from the reviewed configuration`
  );
  const initCode = concatHex([
    artifacts.get(id).bytecode.creation,
    encodeConstructorArguments(
      id,
      artifacts.get(id),
      entry.deployment.constructorArguments
    ),
  ]);
  assert.equal(
    entry.deployment.initCodeHash,
    keccak256(initCode),
    `${id} init code hash does not match the pinned artifact and arguments`
  );
  assert.equal(
    getAddress(entry.address),
    getCreate2Address({
      from: getAddress(factory.address),
      salt: entry.deployment.salt,
      bytecodeHash: entry.deployment.initCodeHash,
    }),
    `${id} address does not match the CREATE2 prediction`
  );
}

const distributor = registryById.get("reward-distributor");
const constructorArguments = distributor.deployment.constructorArguments;
assert.notEqual(
  getAddress(constructorArguments.treasury_),
  getAddress(constructorArguments.initialAdmin_),
  "the testnet treasury must be distinct from the operations authority"
);
const expectedRoleAssignments = {
  DEFAULT_ADMIN_ROLE: constructorArguments.initialAdmin_,
  EPOCH_PUBLISHER_ROLE: constructorArguments.initialPublisher_,
  PAUSER_ROLE: constructorArguments.initialPauser_,
  CLAWBACK_ROLE: constructorArguments.initialClawbackOperator_,
};
assert.deepEqual(
  Object.fromEntries(
    distributor.roles.map((role) => [role.role, role.assignment])
  ),
  expectedRoleAssignments,
  "recorded role assignments differ from the constructor arguments"
);

console.log(
  "Validated testnet deployment registry: pinned code identity, recomputed CREATE/CREATE2 addresses, and reviewed configuration agree."
);

function encodeConstructorArguments(id, artifact, configured) {
  const constructor = artifact.abi.find((item) => item.type === "constructor");
  const inputs = constructor?.inputs ?? [];
  if (inputs.length === 0) {
    assert.deepEqual(
      configured,
      [],
      `${id} takes no constructor arguments but the registry records some`
    );
    return "0x";
  }
  assert.deepEqual(
    Object.keys(configured).sort(),
    inputs.map((input) => input.name).sort(),
    `${id} constructor argument names differ from the generated ABI`
  );
  const values = inputs.map((input) => {
    const value = configured[input.name];
    if (input.type === "address") {
      return getAddress(value);
    }
    assert.ok(
      Number.isSafeInteger(value) && value > 0,
      `${id} constructor argument ${input.name} must be a positive integer`
    );
    return BigInt(value);
  });
  return encodeAbiParameters(inputs, values);
}

async function readJson(relativePath) {
  return JSON.parse(
    await readFile(path.join(repositoryRoot, relativePath), "utf8")
  );
}
