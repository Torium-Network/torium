#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import Ajv2020 from "ajv/dist/2020.js";
import { getAddress, getContractAddress, isAddress, keccak256 } from "viem";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../.."
);
const files = {
  registry: "contracts/deployments/localnet.json",
  schema: "contracts/deployments/deployment-registry-v1.schema.json",
  checksums: "contracts/deployments/SHA256SUMS",
  components: "contracts/config/components-v1.json",
  componentsSchema: "contracts/config/components-v1.schema.json",
  identifiers: "chain/config/identifiers.json",
  genesis: "chain/genesis/localnet/genesis.json",
  genesisManifest: "chain/genesis/localnet/manifest.json",
  toolchain: "chain/toolchain.json",
};

const [
  registry,
  schema,
  components,
  componentsSchema,
  identifiers,
  genesis,
  genesisManifest,
  toolchain,
] = await Promise.all([
  readJson(files.registry),
  readJson(files.schema),
  readJson(files.components),
  readJson(files.componentsSchema),
  readJson(files.identifiers),
  readJson(files.genesis),
  readJson(files.genesisManifest),
  readJson(files.toolchain),
]);

const ajv = new Ajv2020({ allErrors: true, strict: true });
const validateSchema = ajv.compile(schema);
assert.equal(
  validateSchema(registry),
  true,
  `registry JSON Schema validation failed: ${JSON.stringify(validateSchema.errors)}`
);
const validateComponentsSchema = ajv.compile(componentsSchema);
assert.equal(
  validateComponentsSchema(components),
  true,
  `component JSON Schema validation failed: ${JSON.stringify(validateComponentsSchema.errors)}`
);
assertExactKeys(registry, schema.required, "registry");
assert.equal(schema.additionalProperties, false);
assert.equal(registry.$schema, "./deployment-registry-v1.schema.json");
assert.equal(registry.schemaVersion, 1);
assert.equal(registry.registryVersion, "0.1.0");
assert.equal(registry.generatedBy, "contracts/scripts/generate-artifacts.mjs");
assert.equal(registry.environment, "localnet");
assert.equal(registry.releaseStatus, "local-only-valueless");
assert.deepEqual(components.genesisPredeployPolicy, {
  toriumAuthoredSolidityPredeploys: [],
  futureAdditionRequiresAdr: true,
  requiredEvidence: [
    "deterministic-state-allocation",
    "bytecode-and-storage-hash-fixtures",
    "upgrade-and-migration-rules",
    "evm-conformance-coverage",
  ],
});

assert.deepEqual(
  components.components.map((value) => value.id),
  [
    "upstream-evm-precompiles",
    "cosmos-evm-precompiles",
    "torium-native",
    "torium-create2-factory",
    "reward-distributor",
    "attestation-registry",
  ],
  "component decision must retain the exact reviewed v1 component order"
);
for (const id of [
  "torium-create2-factory",
  "reward-distributor",
  "attestation-registry",
]) {
  assert.deepEqual(
    component(id),
    {
      id,
      classification: "post-genesis-deterministic",
      status: "planned",
      ownerIssue:
        id === "torium-create2-factory"
          ? 108
          : id === "reward-distributor"
            ? 109
            : 110,
      upgradeModel: "immutable-versioned-redeployment",
      genesisRequired: false,
    },
    `${id} must remain a planned post-genesis component`
  );
}

assertExactKeys(
  registry.chain,
  ["cosmosChainId", "evmChainId", "genesisSha256"],
  "registry.chain"
);
const canonicalLocalnet = identifiers.networks.find(
  (network) => network.environment === "localnet"
);
assert.ok(canonicalLocalnet, "canonical localnet identifiers are missing");
assert.equal(registry.chain.cosmosChainId, canonicalLocalnet.cosmos.chainId);
assert.equal(registry.chain.evmChainId, canonicalLocalnet.evm.chainId);
assert.equal(genesisManifest.cosmos_chain_id, registry.chain.cosmosChainId);
assert.equal(genesisManifest.evm_chain_id, registry.chain.evmChainId);
assertHash(registry.chain.genesisSha256, false, "chain genesis SHA-256");
assert.equal(
  registry.chain.genesisSha256,
  sha256(await readFile(absolute(files.genesis))),
  "registry genesis checksum differs from canonical localnet genesis"
);
assert.equal(genesis.chain_id, registry.chain.cosmosChainId);

assert.deepEqual(registry.toolchain, {
  foundryVersion: toolchain.contracts.foundry.version,
  foundryImage: toolchain.contracts.foundry.image,
  solidityVersion: toolchain.contracts.solidity.version,
  solidityLongVersion: toolchain.contracts.solidity.longVersion,
  solidityImage: toolchain.contracts.solidity.image,
  evmVersion: "prague",
  optimizerEnabled: true,
  optimizerRuns: 200,
  viaIr: false,
  bytecodeHash: "none",
  cborMetadata: false,
  openZeppelinVersion: toolchain.contracts.openZeppelin.version,
});

assert.deepEqual(
  registry.entries.map((entry) => entry.id),
  [
    "torium-native",
    "torium-create2-factory",
    "reward-distributor",
    "attestation-registry",
  ],
  "registry must contain the active native precompile and reviewed post-genesis plans"
);
const assignedAddresses = registry.entries
  .map((entry) => entry.address)
  .filter((address) => address !== null);
assert.equal(
  new Set(assignedAddresses.map((address) => address.toLowerCase())).size,
  assignedAddresses.length,
  "registry addresses must be unique"
);
const native = entry("torium-native");
const factory = entry("torium-create2-factory");
const reward = entry("reward-distributor");
const attestation = entry("attestation-registry");
validateCommonEntry(native);
validateCommonEntry(factory);
validateCommonEntry(reward, { allowNullAddress: true });
validateCommonEntry(attestation, { allowNullAddress: true });

const nativeComponent = component("torium-native");
assert.equal(nativeComponent.classification, "protocol-precompile");
assert.equal(nativeComponent.status, "active");
assert.equal(native.classification, "protocol-precompile");
assert.equal(native.status, "active");
assert.equal(native.implementationVersion, "protocol-v1");
assert.equal(native.upgradeModel, "protocol-upgrade");
assert.equal(native.contractName, "IToriumNative");
assert.equal(native.deployment, null);
assert.deepEqual(native.roles, []);
assert.deepEqual(native.code, {
  kind: "protocol-precompile",
  interfaceSourceSha256: native.code.interfaceSourceSha256,
});
assertHash(native.code.interfaceSourceSha256, false, "native source hash");
assert.deepEqual(native.configuration, {
  module: "erc20",
  denom: "atorium",
  decimals: 18,
  genesisStatePath: "app_state.erc20.native_precompiles",
});
assert.deepEqual(native.verification, {
  kind: "genesis-and-call-conformance",
  observedInGenesis: true,
  evidencePath: "chain/tests/e2e/run.sh",
});

const canonicalNativeAddress = getAddress(
  genesisManifest.native_asset.solidity_precompile_address
);
assert.equal(native.address, canonicalNativeAddress);
assert.equal(
  genesis.app_state.erc20.native_precompiles.includes(native.address),
  true,
  "native precompile is absent from canonical genesis"
);
assert.equal(
  genesis.app_state.evm.preinstalls.length,
  0,
  "Torium-authored Solidity genesis predeploys are forbidden in v0"
);

const factoryComponent = component("torium-create2-factory");
assert.equal(factoryComponent.classification, "post-genesis-deterministic");
assert.equal(factoryComponent.status, "planned");
assert.equal(factory.classification, "post-genesis-create");
assert.equal(factory.status, "planned");
assert.equal(factory.implementationVersion, "1.0.0");
assert.equal(factory.upgradeModel, "immutable-versioned-redeployment");
assert.equal(factory.contractName, "ToriumCreate2Factory");
assert.deepEqual(factory.roles, []);
assertExactKeys(
  factory.code,
  ["kind", "creationCodeKeccak256", "runtimeCodeKeccak256"],
  "factory.code"
);
assert.equal(factory.code.kind, "evm-bytecode");
assertHash(
  factory.code.creationCodeKeccak256,
  true,
  "factory creation-code hash"
);
assertHash(
  factory.code.runtimeCodeKeccak256,
  true,
  "factory runtime-code hash"
);
assert.deepEqual(factory.configuration, {
  constructorArguments: [],
  constructorArgumentsAbi: "0x",
});
assert.deepEqual(factory.verification, {
  kind: "planned-runtime-code-hash",
  observedOnChain: false,
});
assertExactKeys(
  factory.deployment,
  [
    "strategy",
    "deployerAddress",
    "deployerNonce",
    "expectedAddress",
    "transactionHash",
    "broadcast",
  ],
  "factory.deployment"
);
assert.deepEqual(
  {
    strategy: factory.deployment.strategy,
    deployerNonce: factory.deployment.deployerNonce,
    transactionHash: factory.deployment.transactionHash,
    broadcast: factory.deployment.broadcast,
  },
  {
    strategy: "fixture-deployer-create-v1",
    deployerNonce: "0",
    transactionHash: null,
    broadcast: false,
  },
  "factory must remain an unbroadcast nonce-0 post-genesis plan"
);
assertChecksummedAddress(
  factory.deployment.deployerAddress,
  "factory deployer"
);
assertChecksummedAddress(
  factory.deployment.expectedAddress,
  "factory expected address"
);
const fixtureDeployer = genesisManifest.development_accounts.find(
  (account) => account.name === "deployer"
);
assert.ok(fixtureDeployer, "canonical localnet deployer fixture is missing");
assert.equal(
  factory.deployment.deployerAddress,
  getAddress(fixtureDeployer.evm_address)
);
const expectedFactoryAddress = getContractAddress({
  from: factory.deployment.deployerAddress,
  nonce: 0n,
});
assert.equal(factory.address, expectedFactoryAddress);
assert.equal(factory.deployment.expectedAddress, expectedFactoryAddress);

const rewardComponent = component("reward-distributor");
assert.equal(rewardComponent.classification, "post-genesis-deterministic");
assert.equal(rewardComponent.status, "planned");
assert.equal(reward.contractName, "ToriumRewardDistributor");
assert.equal(reward.address, null);
assert.equal(reward.classification, "post-genesis-deterministic");
assert.equal(reward.status, "planned");
assert.equal(reward.implementationVersion, "1.0.0");
assert.equal(reward.upgradeModel, "immutable-versioned-redeployment");
assert.equal(reward.deployment, null);
assert.deepEqual(reward.configuration, {
  constructorArguments: null,
  constructorArgumentsAbi: null,
  constructorSchema: [
    { name: "defaultAdminDelay_", type: "uint48" },
    { name: "initialAdmin_", type: "address" },
    { name: "initialPublisher_", type: "address" },
    { name: "initialPauser_", type: "address" },
    { name: "initialClawbackOperator_", type: "address" },
    { name: "treasury_", type: "address" },
    { name: "publicationDelay_", type: "uint64" },
    { name: "clawbackDelay_", type: "uint64" },
  ],
  fundingModel: "exact-native-value-equals-merkle-sum-root",
  publisherAllocationTrust: "trusted-off-chain-dataset",
  treasuryModel: "fixed-constructor-address-delayed-expiry-clawback",
});
assert.deepEqual(reward.roles, [
  {
    role: "DEFAULT_ADMIN_ROLE",
    assignment: "unassigned",
    authority: "delayed-admin-transfer",
  },
  {
    role: "EPOCH_PUBLISHER_ROLE",
    assignment: "unassigned",
    authority: "default-admin-managed",
  },
  {
    role: "PAUSER_ROLE",
    assignment: "unassigned",
    authority: "default-admin-managed",
  },
  {
    role: "CLAWBACK_ROLE",
    assignment: "unassigned",
    authority: "default-admin-managed",
  },
]);
assert.deepEqual(reward.verification, {
  kind: "artifact-and-static-tests-only",
  observedOnChain: false,
  deploymentEvidence: null,
});
assertExactKeys(
  reward.code,
  ["kind", "creationCodeKeccak256", "runtimeCodeKeccak256"],
  "reward.code"
);
assert.equal(reward.code.kind, "evm-bytecode");
assertHash(
  reward.code.creationCodeKeccak256,
  true,
  "reward creation-code hash"
);
assertHash(reward.code.runtimeCodeKeccak256, true, "reward runtime-code hash");

const attestationComponent = component("attestation-registry");
assert.equal(attestationComponent.classification, "post-genesis-deterministic");
assert.equal(attestationComponent.status, "planned");
assert.equal(attestation.contractName, "ToriumAttestationRegistry");
assert.equal(attestation.address, null);
assert.equal(attestation.classification, "post-genesis-deterministic");
assert.equal(attestation.status, "planned");
assert.equal(attestation.implementationVersion, "1.0.0");
assert.equal(attestation.upgradeModel, "immutable-versioned-redeployment");
assert.equal(attestation.deployment, null);
assert.deepEqual(attestation.roles, []);
assert.deepEqual(attestation.configuration, {
  constructorArguments: [],
  constructorArgumentsAbi: "0x",
  issuerAuthorization: "permissionless-msg-sender",
  canonicalHashAlgorithm: "torium-attestation-canonical-bytes-v1",
  commitmentFieldOrder: [
    "schemaId",
    "schemaVersion:uint32",
    "subject",
    "referenceHash",
    "contentHash",
    "metadataHash",
    "metadataUriHash",
    "supersedes",
  ],
  identifierDomain: "chain-id-registry-address-issuer-nonce-commitment",
  replayProtection: "issuer-scoped-payload-excluding-supersedes-permanent",
  supersessionConstraint: "same-issuer-schema-id-and-subject",
  storageModel: "hashes-and-minimal-identifiers-only",
  benchmarkPlan: {
    status: "committed-pinned-snapshot",
    command: "make -C contracts gas-snapshot-check",
    stableCases: ["testGasAttest()", "testGasSupersede()", "testGasRevoke()"],
    evidencePath: "contracts/gas-snapshots/attestation-registry-v1.snapshot",
    evidenceSha256:
      "6ab8387de23d8fafa0e38169911a7a4feb38dbf682254479022acfa770ea512e",
  },
});
assert.deepEqual(attestation.verification, {
  kind: "artifact-and-static-tests-only",
  observedOnChain: false,
  deploymentEvidence: null,
  benchmarkEvidence: {
    kind: "foundry-gas-snapshot",
    path: "contracts/gas-snapshots/attestation-registry-v1.snapshot",
    sha256: "6ab8387de23d8fafa0e38169911a7a4feb38dbf682254479022acfa770ea512e",
    checkCommand: "make -C contracts gas-snapshot-check",
  },
});
assert.equal(
  sha256(
    await readFile(
      absolute("contracts/gas-snapshots/attestation-registry-v1.snapshot")
    )
  ),
  attestation.configuration.benchmarkPlan.evidenceSha256,
  "attestation gas snapshot checksum differs"
);
assertExactKeys(
  attestation.code,
  ["kind", "creationCodeKeccak256", "runtimeCodeKeccak256"],
  "attestation.code"
);
assert.equal(attestation.code.kind, "evm-bytecode");
assertHash(
  attestation.code.creationCodeKeccak256,
  true,
  "attestation creation-code hash"
);
assertHash(
  attestation.code.runtimeCodeKeccak256,
  true,
  "attestation runtime-code hash"
);

const nativeArtifact = await validateArtifact(native);
const factoryArtifact = await validateArtifact(factory);
const rewardArtifact = await validateArtifact(reward);
const attestationArtifact = await validateArtifact(attestation);
assert.equal(nativeArtifact.bytecode.creation, "0x");
assert.equal(nativeArtifact.bytecode.runtime, "0x");
assert.equal(nativeArtifact.sourceSha256, native.code.interfaceSourceSha256);
assert.equal(factoryArtifact.bytecode.creation === "0x", false);
assert.equal(factoryArtifact.bytecode.runtime === "0x", false);
assert.equal(rewardArtifact.bytecode.creation === "0x", false);
assert.equal(rewardArtifact.bytecode.runtime === "0x", false);
assert.equal(attestationArtifact.bytecode.creation === "0x", false);
assert.equal(attestationArtifact.bytecode.runtime === "0x", false);
assert.equal(
  factoryArtifact.bytecode.creationCodeKeccak256,
  keccak256(factoryArtifact.bytecode.creation)
);
assert.equal(
  factoryArtifact.bytecode.runtimeCodeKeccak256,
  keccak256(factoryArtifact.bytecode.runtime)
);
assert.equal(
  factory.code.creationCodeKeccak256,
  factoryArtifact.bytecode.creationCodeKeccak256
);
assert.equal(
  factory.code.runtimeCodeKeccak256,
  factoryArtifact.bytecode.runtimeCodeKeccak256
);
assert.equal(
  reward.code.creationCodeKeccak256,
  rewardArtifact.bytecode.creationCodeKeccak256
);
assert.equal(
  reward.code.runtimeCodeKeccak256,
  rewardArtifact.bytecode.runtimeCodeKeccak256
);
assert.equal(
  attestation.code.creationCodeKeccak256,
  attestationArtifact.bytecode.creationCodeKeccak256
);
assert.equal(
  attestation.code.runtimeCodeKeccak256,
  attestationArtifact.bytecode.runtimeCodeKeccak256
);
const rewardConstructor = rewardArtifact.abi.find(
  (item) => item.type === "constructor"
);
assert.ok(rewardConstructor, "reward ABI constructor is missing");
assert.deepEqual(
  rewardConstructor.inputs.map(({ name, type }) => ({ name, type })),
  reward.configuration.constructorSchema,
  "reward constructor schema differs from the generated ABI"
);
const attestationConstructor = attestationArtifact.abi.find(
  (item) => item.type === "constructor"
);
assert.equal(
  attestationConstructor?.inputs?.length ?? 0,
  0,
  "attestation registry must not require constructor authority or configuration"
);
const attestationFunctionNames = new Set(
  attestationArtifact.abi
    .filter((item) => item.type === "function")
    .map((item) => item.name)
);
for (const forbiddenFunction of [
  "owner",
  "transferOwnership",
  "grantRole",
  "revokeRole",
  "renounceRole",
  "pause",
  "unpause",
]) {
  assert.equal(
    attestationFunctionNames.has(forbiddenFunction),
    false,
    `attestation ABI unexpectedly exposes privileged function: ${forbiddenFunction}`
  );
}
for (const [name, inputs, outputs] of [
  [
    "attest",
    [
      ["schemaId", "bytes32"],
      ["schemaVersion", "uint32"],
      ["subject", "bytes32"],
      ["referenceHash", "bytes32"],
      ["contentHash", "bytes32"],
      ["metadataHash", "bytes32"],
      ["metadataUriHash", "bytes32"],
      ["supersedes", "bytes32"],
    ],
    [["attestationId", "bytes32"]],
  ],
  [
    "computeCommitment",
    [
      ["schemaId", "bytes32"],
      ["schemaVersion", "uint32"],
      ["subject", "bytes32"],
      ["referenceHash", "bytes32"],
      ["contentHash", "bytes32"],
      ["metadataHash", "bytes32"],
      ["metadataUriHash", "bytes32"],
      ["supersedes", "bytes32"],
    ],
    [["", "bytes32"]],
  ],
  [
    "computeAttestationId",
    [
      ["issuer", "address"],
      ["issuerNonce", "uint256"],
      ["commitment", "bytes32"],
    ],
    [["", "bytes32"]],
  ],
  [
    "revoke",
    [
      ["attestationId", "bytes32"],
      ["revocationReasonHash", "bytes32"],
    ],
    [],
  ],
  [
    "verify",
    [
      ["attestationId", "bytes32"],
      ["expectedIssuer", "address"],
      ["expectedCommitment", "bytes32"],
    ],
    [["", "bool"]],
  ],
]) {
  assertAbiFunction(attestationArtifact.abi, name, inputs, outputs);
}

await validateChecksums();
for (const relativePath of [
  files.registry,
  native.artifactPath,
  factory.artifactPath,
  reward.artifactPath,
  attestation.artifactPath,
  "packages/torium-sdk/src/generated/contracts/abis.ts",
  "packages/torium-sdk/src/generated/contracts/deployments.ts",
  "packages/torium-sdk/src/generated/contracts/index.ts",
  "apps/developer-docs/content/generated/contracts-localnet-foundation.json",
]) {
  rejectUnsafeGeneratedText(
    relativePath,
    await readFile(absolute(relativePath), "utf8")
  );
}

console.log(
  "Validated deterministic localnet registry: active native precompile, unbroadcast factory plan, and addressless reward/attestation plans."
);

function entry(id) {
  const value = registry.entries.find((candidate) => candidate.id === id);
  assert.ok(value, `missing registry entry: ${id}`);
  return value;
}

function component(id) {
  const value = components.components.find((candidate) => candidate.id === id);
  assert.ok(value, `missing component decision: ${id}`);
  return value;
}

function validateCommonEntry(value, { allowNullAddress = false } = {}) {
  assertExactKeys(
    value,
    schema.$defs.entry.required,
    `registry entry ${value.id}`
  );
  if (allowNullAddress) {
    assert.equal(
      value.address,
      null,
      `${value.id} address must remain unassigned`
    );
  } else {
    assertChecksummedAddress(value.address, `${value.id} address`);
  }
  assert.match(value.implementationVersion, /^[a-z0-9][a-z0-9.-]*$/u);
  assert.match(value.artifactPath, /^contracts\/generated\/abi\/.+\.json$/u);
  assert.equal(path.isAbsolute(value.artifactPath), false);
  assertHash(value.artifactSha256, false, `${value.id} artifact SHA-256`);
  assertHash(value.abiSha256, false, `${value.id} ABI SHA-256`);
}

async function validateArtifact(registryEntry) {
  const text = await readFile(absolute(registryEntry.artifactPath), "utf8");
  assert.equal(sha256(text), registryEntry.artifactSha256);
  const artifact = JSON.parse(text);
  assertExactKeys(
    artifact,
    [
      "notice",
      "schemaVersion",
      "generatedBy",
      "contractName",
      "sourceName",
      "sourceSha256",
      "compiler",
      "abi",
      "bytecode",
    ],
    `${registryEntry.id} artifact`
  );
  assert.equal(
    artifact.notice,
    "DO NOT EDIT: generated from canonical Solidity source and pinned Foundry output."
  );
  assert.equal(artifact.schemaVersion, 1);
  assert.equal(
    artifact.generatedBy,
    "contracts/scripts/generate-artifacts.mjs"
  );
  assert.equal(artifact.contractName, registryEntry.contractName);
  assertExactKeys(
    artifact.compiler,
    [
      "name",
      "version",
      "longVersion",
      "image",
      "evmVersion",
      "optimizer",
      "viaIr",
      "bytecodeHash",
      "cborMetadata",
    ],
    `${registryEntry.id} compiler`
  );
  assert.equal(artifact.compiler.name, "solc");
  assert.equal(artifact.compiler.version, registry.toolchain.solidityVersion);
  assert.equal(
    artifact.compiler.longVersion,
    registry.toolchain.solidityLongVersion
  );
  assert.equal(artifact.compiler.image, registry.toolchain.solidityImage);
  assert.equal(artifact.compiler.evmVersion, registry.toolchain.evmVersion);
  assert.deepEqual(artifact.compiler.optimizer, {
    enabled: registry.toolchain.optimizerEnabled,
    runs: registry.toolchain.optimizerRuns,
  });
  assert.equal(artifact.compiler.viaIr, registry.toolchain.viaIr);
  assert.equal(artifact.compiler.bytecodeHash, registry.toolchain.bytecodeHash);
  assert.equal(artifact.compiler.cborMetadata, registry.toolchain.cborMetadata);
  assert.equal(
    abiSha256(artifact.abi),
    registryEntry.abiSha256,
    `${registryEntry.id} ABI checksum differs`
  );
  assert.ok(
    Array.isArray(artifact.abi),
    `${registryEntry.id} ABI must be an array`
  );
  assertExactKeys(
    artifact.bytecode,
    ["creation", "runtime", "creationCodeKeccak256", "runtimeCodeKeccak256"],
    `${registryEntry.id} bytecode`
  );
  assert.match(artifact.bytecode.creation, /^0x(?:[0-9a-f]{2})*$/u);
  assert.match(artifact.bytecode.runtime, /^0x(?:[0-9a-f]{2})*$/u);
  assert.equal(
    artifact.bytecode.creationCodeKeccak256,
    keccak256(artifact.bytecode.creation)
  );
  assert.equal(
    artifact.bytecode.runtimeCodeKeccak256,
    keccak256(artifact.bytecode.runtime)
  );
  assertHash(artifact.sourceSha256, false, `${registryEntry.id} source hash`);
  const sourceText = await readFile(absolute(artifact.sourceName));
  assert.equal(artifact.sourceSha256, sha256(sourceText));
  rejectUnsafeGeneratedText(registryEntry.artifactPath, text);
  return artifact;
}

async function validateChecksums() {
  const text = await readFile(absolute(files.checksums), "utf8");
  assert.equal(text.endsWith("\n"), true);
  const lines = text.trimEnd().split("\n");
  const parsed = lines.map((line) => {
    const match = line.match(/^([0-9a-f]{64})  ([^\s]+)$/u);
    assert.ok(match, `invalid SHA256SUMS line: ${line}`);
    return { hash: match[1], relativePath: match[2] };
  });
  assert.deepEqual(
    parsed.map(({ relativePath }) => relativePath),
    parsed.map(({ relativePath }) => relativePath).toSorted(),
    "SHA256SUMS paths must be sorted"
  );
  assert.equal(
    new Set(parsed.map(({ relativePath }) => relativePath)).size,
    parsed.length,
    "SHA256SUMS contains duplicate paths"
  );
  assert.deepEqual(
    parsed.map(({ relativePath }) => relativePath),
    [
      "contracts/deployments/localnet.json",
      "contracts/generated/abi/IToriumNative.json",
      "contracts/generated/abi/ToriumCreate2Factory.json",
      "contracts/generated/abi/ToriumRewardDistributor.json",
      "contracts/generated/abi/ToriumAttestationRegistry.json",
      "packages/torium-sdk/src/generated/contracts/abis.ts",
      "packages/torium-sdk/src/generated/contracts/deployments.ts",
      "packages/torium-sdk/src/generated/contracts/index.ts",
      "apps/developer-docs/content/generated/contracts-localnet-foundation.json",
    ].toSorted(),
    "SHA256SUMS must cover every canonical generated consumer exactly once"
  );
  for (const item of parsed) {
    assert.equal(path.isAbsolute(item.relativePath), false);
    assert.equal(item.relativePath.includes(".."), false);
    assert.notEqual(item.relativePath, files.checksums);
    assert.equal(
      sha256(await readFile(absolute(item.relativePath))),
      item.hash,
      `checksum differs for ${item.relativePath}`
    );
  }
}

function assertExactKeys(value, expected, label) {
  assert.deepEqual(
    Object.keys(value).sort(),
    [...expected].sort(),
    `${label} has missing or unknown fields`
  );
}

function assertHash(value, prefixed, label) {
  assert.match(
    value,
    prefixed ? /^0x[0-9a-f]{64}$/u : /^[0-9a-f]{64}$/u,
    `${label} must be lowercase canonical hex`
  );
}

function assertChecksummedAddress(value, label) {
  assert.equal(isAddress(value, { strict: true }), true, `${label} is invalid`);
  assert.equal(value, getAddress(value), `${label} must be EIP-55 checksummed`);
}

function assertAbiFunction(abi, name, expectedInputs, expectedOutputs) {
  const matches = abi.filter(
    (item) => item.type === "function" && item.name === name
  );
  assert.equal(
    matches.length,
    1,
    `${name} must have one unambiguous ABI entry`
  );
  const entry = matches[0];
  const shape = (parameters) =>
    parameters.map(({ name: parameterName, type }) => [parameterName, type]);
  assert.deepEqual(
    shape(entry.inputs),
    expectedInputs,
    `${name} inputs differ`
  );
  assert.deepEqual(
    shape(entry.outputs),
    expectedOutputs,
    `${name} outputs differ`
  );
}

function abiSha256(abi) {
  return sha256(JSON.stringify(stableValue(abi)));
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, stableValue(item)])
    );
  }
  return value;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function rejectUnsafeGeneratedText(relativePath, contents) {
  const forbidden = [
    repositoryRoot,
    "/Users/",
    "/home/",
    "PRIVATE KEY",
    "PRIVATE_KEY",
    "MNEMONIC",
    "SEED_PHRASE",
  ];
  for (const value of forbidden) {
    assert.equal(
      contents.toUpperCase().includes(value.toUpperCase()),
      false,
      `${relativePath} contains forbidden generated text: ${value}`
    );
  }
  assert.doesNotMatch(
    contents,
    /^(?:authorization|cookie)\s*:/imu,
    `${relativePath} contains a forbidden HTTP credential header`
  );
  assert.doesNotMatch(
    contents,
    /"(?:generatedAt|createdAt|updatedAt|timestamp)"\s*:/u,
    `${relativePath} contains a nondeterministic timestamp field`
  );
}

async function readJson(relativePath) {
  return JSON.parse(await readFile(absolute(relativePath), "utf8"));
}

function absolute(relativePath) {
  assert.equal(path.isAbsolute(relativePath), false);
  assert.equal(relativePath.includes(".."), false);
  return path.join(repositoryRoot, relativePath);
}
