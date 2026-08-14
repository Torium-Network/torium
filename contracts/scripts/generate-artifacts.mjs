#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { getAddress, getContractAddress, keccak256 } from "viem";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../.."
);
const { checkOnly, artifactsRoot } = parseArguments(process.argv.slice(2));

const paths = {
  toolchain: "chain/toolchain.json",
  identifiers: "chain/config/identifiers.json",
  foundryConfig: "contracts/foundry.toml",
  genesis: "chain/genesis/localnet/genesis.json",
  genesisManifest: "chain/genesis/localnet/manifest.json",
  nativeSource: "contracts/src/interfaces/IToriumNative.sol",
  factorySource: "contracts/src/deployment/ToriumCreate2Factory.sol",
  rewardSource: "contracts/src/rewards/ToriumRewardDistributor.sol",
  attestationSource: "contracts/src/attestations/ToriumAttestationRegistry.sol",
  rewardFixture: "contracts/fixtures/rewards/example.fixture.json",
  attestationFixture: "contracts/fixtures/attestations/canonical-hash-v1.json",
  attestationGasSnapshot:
    "contracts/gas-snapshots/attestation-registry-v1.snapshot",
  nativeFoundryArtifact: `contracts/${artifactsRoot}/IToriumNative.sol/IToriumNative.json`,
  factoryFoundryArtifact: `contracts/${artifactsRoot}/ToriumCreate2Factory.sol/ToriumCreate2Factory.json`,
  rewardFoundryArtifact: `contracts/${artifactsRoot}/ToriumRewardDistributor.sol/ToriumRewardDistributor.json`,
  attestationFoundryArtifact: `contracts/${artifactsRoot}/ToriumAttestationRegistry.sol/ToriumAttestationRegistry.json`,
  nativeArtifact: "contracts/generated/abi/IToriumNative.json",
  factoryArtifact: "contracts/generated/abi/ToriumCreate2Factory.json",
  rewardArtifact: "contracts/generated/abi/ToriumRewardDistributor.json",
  attestationArtifact: "contracts/generated/abi/ToriumAttestationRegistry.json",
  registry: "contracts/deployments/localnet.json",
  checksums: "contracts/deployments/SHA256SUMS",
  sdkAbis: "packages/torium-sdk/src/generated/contracts/abis.ts",
  sdkDeployments: "packages/torium-sdk/src/generated/contracts/deployments.ts",
  sdkIndex: "packages/torium-sdk/src/generated/contracts/index.ts",
  docsManifest:
    "apps/developer-docs/content/generated/contracts-localnet-foundation.json",
};

function parseArguments(arguments_) {
  let check = false;
  let root = ".work/out";
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--check") {
      check = true;
      continue;
    }
    if (argument === "--artifacts") {
      const value = arguments_[index + 1];
      if (!value)
        throw new Error("--artifacts requires a contracts-relative path.");
      root = value;
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }
  const normalized = path.posix.normalize(root.replaceAll("\\", "/"));
  if (
    path.posix.isAbsolute(normalized) ||
    normalized === ".." ||
    normalized.startsWith("../")
  ) {
    throw new Error("--artifacts must stay below the contracts directory.");
  }
  return { checkOnly: check, artifactsRoot: normalized.replace(/^\.\//u, "") };
}

const [
  toolchain,
  identifiers,
  foundryConfig,
  genesisManifest,
  genesisBytes,
  nativeInput,
  factoryInput,
  rewardInput,
  rewardFixture,
  rewardFixtureBytes,
  attestationInput,
  attestationFixture,
  attestationFixtureBytes,
  attestationGasSnapshotBytes,
] = await Promise.all([
  readJson(paths.toolchain),
  readJson(paths.identifiers),
  readText(paths.foundryConfig),
  readJson(paths.genesisManifest),
  readBytes(paths.genesis),
  readFoundryArtifact(paths.nativeFoundryArtifact, "IToriumNative"),
  readFoundryArtifact(paths.factoryFoundryArtifact, "ToriumCreate2Factory"),
  readFoundryArtifact(paths.rewardFoundryArtifact, "ToriumRewardDistributor"),
  readJson(paths.rewardFixture),
  readBytes(paths.rewardFixture),
  readFoundryArtifact(
    paths.attestationFoundryArtifact,
    "ToriumAttestationRegistry"
  ),
  readJson(paths.attestationFixture),
  readBytes(paths.attestationFixture),
  readBytes(paths.attestationGasSnapshot),
]);

const localnet = identifiers.networks?.find(
  (network) => network.environment === "localnet"
);
if (
  !localnet ||
  !Number.isSafeInteger(localnet.evm?.chainId) ||
  typeof localnet.cosmos?.chainId !== "string"
) {
  throw new Error("Canonical localnet identifiers are incomplete.");
}
if (
  genesisManifest.evm_chain_id !== localnet.evm.chainId ||
  genesisManifest.cosmos_chain_id !== localnet.cosmos.chainId
) {
  throw new Error(
    "Canonical identifiers and localnet genesis manifest disagree."
  );
}

const compiler = buildCompiler(toolchain, foundryConfig);
const nativeArtifact = await normalizeArtifact({
  input: nativeInput,
  contractName: "IToriumNative",
  sourceName: paths.nativeSource,
  compiler,
});
const factoryArtifact = await normalizeArtifact({
  input: factoryInput,
  contractName: "ToriumCreate2Factory",
  sourceName: paths.factorySource,
  compiler,
});
const rewardArtifact = await normalizeArtifact({
  input: rewardInput,
  contractName: "ToriumRewardDistributor",
  sourceName: paths.rewardSource,
  compiler,
});
const attestationArtifact = await normalizeArtifact({
  input: attestationInput,
  contractName: "ToriumAttestationRegistry",
  sourceName: paths.attestationSource,
  compiler,
});

if (
  nativeArtifact.bytecode.creation !== "0x" ||
  nativeArtifact.bytecode.runtime !== "0x"
) {
  throw new Error("IToriumNative must remain an interface-only artifact.");
}
if (
  factoryArtifact.bytecode.creation === "0x" ||
  factoryArtifact.bytecode.runtime === "0x"
) {
  throw new Error("ToriumCreate2Factory must contain deployable bytecode.");
}
if (
  rewardArtifact.bytecode.creation === "0x" ||
  rewardArtifact.bytecode.runtime === "0x"
) {
  throw new Error("ToriumRewardDistributor must contain deployable bytecode.");
}
if (
  attestationArtifact.bytecode.creation === "0x" ||
  attestationArtifact.bytecode.runtime === "0x"
) {
  throw new Error(
    "ToriumAttestationRegistry must contain deployable bytecode."
  );
}
validateRewardFixture(rewardFixture);
validateAttestationFixture(attestationFixture);

const nativeArtifactText = jsonText(nativeArtifact);
const factoryArtifactText = jsonText(factoryArtifact);
const rewardArtifactText = jsonText(rewardArtifact);
const attestationArtifactText = jsonText(attestationArtifact);
const deployer = genesisManifest.development_accounts?.find(
  (account) => account.name === "deployer"
);
if (!deployer) throw new Error("Localnet deployer fixture is missing.");

const nativeAddress = getAddress(
  genesisManifest.native_asset?.solidity_precompile_address ?? ""
);
const deployerAddress = getAddress(deployer.evm_address);
const factoryAddress = getContractAddress({
  from: deployerAddress,
  nonce: 0n,
});

const registry = stableValue({
  $schema: "./deployment-registry-v1.schema.json",
  schemaVersion: 1,
  registryVersion: "0.1.0",
  generatedBy: "contracts/scripts/generate-artifacts.mjs",
  environment: "localnet",
  releaseStatus: "local-only-valueless",
  chain: {
    cosmosChainId: localnet.cosmos.chainId,
    evmChainId: localnet.evm.chainId,
    genesisSha256: sha256(genesisBytes),
  },
  toolchain: {
    foundryVersion: toolchain.contracts.foundry.version,
    foundryImage: toolchain.contracts.foundry.image,
    solidityVersion: toolchain.contracts.solidity.version,
    solidityLongVersion: toolchain.contracts.solidity.longVersion,
    solidityImage: toolchain.contracts.solidity.image,
    evmVersion: compiler.evmVersion,
    optimizerEnabled: compiler.optimizer.enabled,
    optimizerRuns: compiler.optimizer.runs,
    viaIr: compiler.viaIr,
    bytecodeHash: compiler.bytecodeHash,
    cborMetadata: compiler.cborMetadata,
    openZeppelinVersion: toolchain.contracts.openZeppelin.version,
  },
  entries: [
    {
      id: "torium-native",
      contractName: "IToriumNative",
      address: nativeAddress,
      classification: "protocol-precompile",
      status: "active",
      implementationVersion: "protocol-v1",
      upgradeModel: "protocol-upgrade",
      artifactPath: paths.nativeArtifact,
      artifactSha256: sha256(nativeArtifactText),
      abiSha256: abiSha256(nativeArtifact.abi),
      code: {
        kind: "protocol-precompile",
        interfaceSourceSha256: nativeArtifact.sourceSha256,
      },
      deployment: null,
      configuration: {
        module: "erc20",
        denom: "atorium",
        decimals: 18,
        genesisStatePath: "app_state.erc20.native_precompiles",
      },
      roles: [],
      verification: {
        kind: "genesis-and-call-conformance",
        observedInGenesis: true,
        evidencePath: "chain/tests/e2e/run.sh",
      },
    },
    {
      id: "torium-create2-factory",
      contractName: "ToriumCreate2Factory",
      address: factoryAddress,
      classification: "post-genesis-create",
      status: "planned",
      implementationVersion: "1.0.0",
      upgradeModel: "immutable-versioned-redeployment",
      artifactPath: paths.factoryArtifact,
      artifactSha256: sha256(factoryArtifactText),
      abiSha256: abiSha256(factoryArtifact.abi),
      code: {
        kind: "evm-bytecode",
        creationCodeKeccak256: factoryArtifact.bytecode.creationCodeKeccak256,
        runtimeCodeKeccak256: factoryArtifact.bytecode.runtimeCodeKeccak256,
      },
      deployment: {
        strategy: "fixture-deployer-create-v1",
        deployerAddress,
        deployerNonce: "0",
        expectedAddress: factoryAddress,
        transactionHash: null,
        broadcast: false,
      },
      configuration: {
        constructorArguments: [],
        constructorArgumentsAbi: "0x",
      },
      roles: [],
      verification: {
        kind: "planned-runtime-code-hash",
        observedOnChain: false,
      },
    },
    {
      id: "reward-distributor",
      contractName: "ToriumRewardDistributor",
      address: null,
      classification: "post-genesis-deterministic",
      status: "planned",
      implementationVersion: "1.0.0",
      upgradeModel: "immutable-versioned-redeployment",
      artifactPath: paths.rewardArtifact,
      artifactSha256: sha256(rewardArtifactText),
      abiSha256: abiSha256(rewardArtifact.abi),
      code: {
        kind: "evm-bytecode",
        creationCodeKeccak256: rewardArtifact.bytecode.creationCodeKeccak256,
        runtimeCodeKeccak256: rewardArtifact.bytecode.runtimeCodeKeccak256,
      },
      deployment: null,
      configuration: {
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
      },
      roles: [
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
      ],
      verification: {
        kind: "artifact-and-static-tests-only",
        observedOnChain: false,
        deploymentEvidence: null,
      },
    },
    {
      id: "attestation-registry",
      contractName: "ToriumAttestationRegistry",
      address: null,
      classification: "post-genesis-deterministic",
      status: "planned",
      implementationVersion: "1.0.0",
      upgradeModel: "immutable-versioned-redeployment",
      artifactPath: paths.attestationArtifact,
      artifactSha256: sha256(attestationArtifactText),
      abiSha256: abiSha256(attestationArtifact.abi),
      code: {
        kind: "evm-bytecode",
        creationCodeKeccak256:
          attestationArtifact.bytecode.creationCodeKeccak256,
        runtimeCodeKeccak256: attestationArtifact.bytecode.runtimeCodeKeccak256,
      },
      deployment: null,
      configuration: {
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
        replayProtection:
          "issuer-scoped-payload-excluding-supersedes-permanent",
        supersessionConstraint: "same-issuer-schema-id-and-subject",
        storageModel: "hashes-and-minimal-identifiers-only",
        benchmarkPlan: {
          status: "committed-pinned-snapshot",
          command: "make -C contracts gas-snapshot-check",
          stableCases: [
            "testGasAttest()",
            "testGasSupersede()",
            "testGasRevoke()",
          ],
          evidencePath: paths.attestationGasSnapshot,
          evidenceSha256: sha256(attestationGasSnapshotBytes),
        },
      },
      roles: [],
      verification: {
        kind: "artifact-and-static-tests-only",
        observedOnChain: false,
        deploymentEvidence: null,
        benchmarkEvidence: {
          kind: "foundry-gas-snapshot",
          path: paths.attestationGasSnapshot,
          sha256: sha256(attestationGasSnapshotBytes),
          checkCommand: "make -C contracts gas-snapshot-check",
        },
      },
    },
  ],
});

const registryText = jsonText(registry);
const sdkAbisText = await formatTypeScript(
  renderSdkAbis(
    nativeArtifact.abi,
    factoryArtifact.abi,
    rewardArtifact.abi,
    attestationArtifact.abi
  ),
  toolchain
);
const sdkDeploymentsText = await formatTypeScript(
  renderSdkDeployments(registry),
  toolchain
);
const sdkIndexText = await formatTypeScript(
  `${generatedHeader("contracts/scripts/generate-artifacts.mjs")}export * from "./abis.js";\nexport * from "./deployments.js";\n`,
  toolchain
);
const docsManifestText = jsonText({
  notice:
    "DO NOT EDIT: generated contract foundation; predicted addresses are not deployments.",
  schemaVersion: 1,
  generatedBy: "contracts/scripts/generate-artifacts.mjs",
  source: paths.registry,
  environment: registry.environment,
  releaseStatus: registry.releaseStatus,
  publicDeployment: false,
  referenceFixtures: [
    {
      kind: "offline-reference-vector",
      path: paths.rewardFixture,
      sha256: sha256(rewardFixtureBytes),
      treeFormat: rewardFixture.treeFormat.id,
      epochId: rewardFixture.epochId,
      merkleRoot: rewardFixture.merkleRoot,
      rootSum: rewardFixture.rootSum,
      claimCount: rewardFixture.claimCount,
      outputPayloadSha256: rewardFixture.integrity.outputPayloadSha256,
    },
    {
      kind: "offline-canonical-hash-vector-set",
      path: paths.attestationFixture,
      sha256: sha256(attestationFixtureBytes),
      vectorSet: attestationFixture.vectorSet,
      algorithm: attestationFixture.algorithm.id,
      vectorCount: attestationFixture.vectors.length,
      verifiedBy: attestationFixture.verifiedBy,
      nonClaims: attestationFixture.nonClaims,
    },
  ],
  benchmarkEvidence: [
    {
      kind: "foundry-gas-snapshot",
      path: paths.attestationGasSnapshot,
      sha256: sha256(attestationGasSnapshotBytes),
      checkCommand: "make -C contracts gas-snapshot-check",
      ciGate: "deferred-to-issue-126",
    },
  ],
  components: registry.entries.map((entry) => ({
    id: entry.id,
    status: entry.status,
    classification: entry.classification,
    address: entry.address,
    addressEvidence:
      entry.status === "active"
        ? "canonical-genesis"
        : entry.address === null
          ? "not-assigned-or-deployed"
          : "predicted-not-deployed",
    implementationVersion: entry.implementationVersion,
    artifactPath: entry.artifactPath,
    artifactSha256: entry.artifactSha256,
    abiSha256: entry.abiSha256,
    transactionHash: entry.deployment?.transactionHash ?? null,
    trustBoundary:
      entry.id === "reward-distributor"
        ? {
            funding: entry.configuration.fundingModel,
            publisherAllocation: entry.configuration.publisherAllocationTrust,
            treasury: entry.configuration.treasuryModel,
          }
        : entry.id === "attestation-registry"
          ? {
              canonicalHashing: entry.configuration.canonicalHashAlgorithm,
              privacy: "hashes-are-not-anonymization-or-confidentiality",
              issuerAuthenticity: "transaction-sender-address-only",
              truth: "not-asserted",
              legalTimestamp: "not-asserted",
            }
          : undefined,
  })),
});

const generated = new Map([
  [paths.nativeArtifact, nativeArtifactText],
  [paths.factoryArtifact, factoryArtifactText],
  [paths.rewardArtifact, rewardArtifactText],
  [paths.attestationArtifact, attestationArtifactText],
  [paths.registry, registryText],
  [paths.sdkAbis, sdkAbisText],
  [paths.sdkDeployments, sdkDeploymentsText],
  [paths.sdkIndex, sdkIndexText],
  [paths.docsManifest, docsManifestText],
]);
const checksumsText = [...generated.entries()]
  .sort(([left], [right]) => left.localeCompare(right))
  .map(([relativePath, contents]) => `${sha256(contents)}  ${relativePath}`)
  .join("\n")
  .concat("\n");
generated.set(paths.checksums, checksumsText);

for (const [relativePath, contents] of generated) {
  rejectUnsafeGeneratedText(relativePath, contents);
}

if (checkOnly) {
  const drift = [];
  for (const [relativePath, expected] of generated) {
    const actual = await readOptional(relativePath);
    if (actual !== expected) drift.push(relativePath);
  }
  if (drift.length > 0) {
    throw new Error(
      `Generated contract artifacts drifted: ${drift.join(", ")}. Run the generator and review the result.`
    );
  }
  console.log(`Verified ${generated.size} generated contract files.`);
} else {
  for (const [relativePath, contents] of generated) {
    await atomicWrite(relativePath, contents);
  }
  console.log(`Generated ${generated.size} deterministic contract files.`);
}

function buildCompiler(manifest, foundryConfiguration) {
  const contracts = manifest.contracts;
  if (
    !contracts?.solidity?.version ||
    !contracts.solidity.longVersion ||
    !contracts?.foundry?.version
  ) {
    throw new Error("Contract compiler toolchain is incomplete.");
  }
  const requiredConfiguration = [
    `solc_version = "${contracts.solidity.version}"`,
    "auto_detect_solc = false",
    'evm_version = "prague"',
    "optimizer = true",
    "optimizer_runs = 200",
    "via_ir = false",
    'bytecode_hash = "none"',
    "cbor_metadata = false",
    "ffi = false",
  ];
  for (const setting of requiredConfiguration) {
    if (!foundryConfiguration.split(/\r?\n/u).includes(setting)) {
      throw new Error(`foundry.toml is missing pinned setting: ${setting}`);
    }
  }
  return {
    name: "solc",
    version: contracts.solidity.version,
    longVersion: contracts.solidity.longVersion,
    image: contracts.solidity.image,
    evmVersion: "prague",
    optimizer: { enabled: true, runs: 200 },
    viaIr: false,
    bytecodeHash: "none",
    cborMetadata: false,
  };
}

async function normalizeArtifact({
  input,
  contractName,
  sourceName,
  compiler,
}) {
  const sourceBytes = await readBytes(sourceName);
  validateCompilerMetadata(
    input,
    contractName,
    sourceName,
    sourceBytes,
    compiler
  );
  const creation = normalizeHex(
    input.bytecode?.object,
    `${contractName} creation bytecode`
  );
  const runtime = normalizeHex(
    input.deployedBytecode?.object,
    `${contractName} runtime bytecode`
  );
  assertNoLinkReferences(input, contractName);
  return stableValue({
    notice:
      "DO NOT EDIT: generated from canonical Solidity source and pinned Foundry output.",
    schemaVersion: 1,
    generatedBy: "contracts/scripts/generate-artifacts.mjs",
    contractName,
    sourceName,
    sourceSha256: sha256(sourceBytes),
    compiler,
    abi: input.abi,
    bytecode: {
      creation,
      runtime,
      creationCodeKeccak256: keccak256(creation),
      runtimeCodeKeccak256: keccak256(runtime),
    },
  });
}

function validateCompilerMetadata(
  input,
  contractName,
  sourceName,
  sourceBytes,
  compiler
) {
  const metadata = input.metadata;
  const settings = metadata?.settings;
  const foundrySourceName = path.posix.relative("contracts", sourceName);
  if (metadata?.compiler?.version !== compiler.longVersion) {
    throw new Error(
      `${contractName} compiler metadata differs from ${compiler.longVersion}.`
    );
  }
  if (
    settings?.evmVersion !== compiler.evmVersion ||
    settings?.optimizer?.enabled !== compiler.optimizer.enabled ||
    settings?.optimizer?.runs !== compiler.optimizer.runs ||
    (settings?.viaIR ?? false) !== compiler.viaIr ||
    settings?.metadata?.bytecodeHash !== compiler.bytecodeHash ||
    settings?.metadata?.appendCBOR !== compiler.cborMetadata
  ) {
    throw new Error(`${contractName} Foundry compiler settings are ambiguous.`);
  }
  if (settings?.compilationTarget?.[foundrySourceName] !== contractName) {
    throw new Error(`${contractName} compilation target metadata is invalid.`);
  }
  if (
    metadata?.sources?.[foundrySourceName]?.keccak256 !== keccak256(sourceBytes)
  ) {
    throw new Error(
      `${contractName} Foundry artifact was not compiled from the current canonical source.`
    );
  }
}

function assertNoLinkReferences(input, contractName) {
  for (const [label, references] of [
    ["creation", input.bytecode?.linkReferences],
    ["runtime", input.deployedBytecode?.linkReferences],
  ]) {
    if (references && Object.keys(references).length > 0) {
      throw new Error(
        `${contractName} ${label} bytecode contains unresolved link references.`
      );
    }
  }
}

function validateRewardFixture(fixture) {
  if (
    fixture?.schemaVersion !== 1 ||
    fixture.generatedBy !== "contracts/scripts/generate-reward-fixture.mjs" ||
    fixture.treeFormat?.id !== "torium-merkle-sum-v1" ||
    fixture.treeFormat?.leafHash !==
      "keccak256(abi.encode(uint256 epochId,uint256 index,address account,uint256 amount))" ||
    fixture.treeFormat?.parentHash !==
      "keccak256(abi.encode(bytes32 leftHash,uint256 leftSum,bytes32 rightHash,uint256 rightSum))" ||
    !/^[1-9][0-9]*$/u.test(fixture.epochId ?? "") ||
    !/^0x[0-9a-f]{64}$/u.test(fixture.merkleRoot ?? "") ||
    !/^[1-9][0-9]*$/u.test(fixture.rootSum ?? "") ||
    !Number.isSafeInteger(fixture.claimCount) ||
    fixture.claimCount <= 0 ||
    fixture.claimCount !== fixture.claims?.length ||
    fixture.integrity?.algorithm !== "sha256" ||
    !/^[0-9a-f]{64}$/u.test(fixture.integrity?.outputPayloadSha256 ?? "")
  ) {
    throw new Error(
      "Reward reference fixture format or integrity metadata is invalid."
    );
  }
}

function validateAttestationFixture(fixture) {
  const expectedAlgorithm = {
    id: "torium-attestation-canonical-bytes-v1",
    digest: "keccak256",
    textEncoding: "UTF-8",
    byteDerivation: "exact-decoded-string-to-utf8-without-transformation",
    jsonCanonicalization: "none",
    unicodeNormalization: "none-caller-responsibility",
    uriCanonicalization: "none-exact-utf8",
    commitmentEncoding:
      "abi.encode(bytes32 schemaId,uint32 schemaVersion,bytes32 subject,bytes32 referenceHash,bytes32 contentHash,bytes32 metadataHash,bytes32 metadataUriHash,bytes32 supersedes)",
    attestationIdEncoding:
      "abi.encode(uint256 chainId,address registry,address issuer,uint256 issuerNonce,bytes32 commitment)",
  };
  const expectedNonClaims = [
    "no-rfc8785-jcs-json-canonicalization",
    "no-unicode-normalization",
    "no-uri-normalization",
    "hashes-do-not-prove-authenticity-truth-or-availability",
    "hashes-do-not-provide-confidentiality",
    "low-entropy-inputs-are-dictionary-attackable",
    "do-not-place-sensitive-large-or-personal-payloads-on-chain",
  ];
  const vectorNames = fixture?.vectors?.map((vector) => vector.name);

  if (
    fixture?.schemaVersion !== 1 ||
    fixture.vectorSet !== "torium-attestation-canonical-hash-v1" ||
    fixture.verifiedBy !==
      "contracts/scripts/validate-attestation-vectors.mjs" ||
    JSON.stringify(stableValue(fixture.algorithm)) !==
      JSON.stringify(stableValue(expectedAlgorithm)) ||
    JSON.stringify(fixture.nonClaims) !== JSON.stringify(expectedNonClaims) ||
    JSON.stringify(vectorNames) !==
      JSON.stringify([
        "json-key-order-ab",
        "json-key-order-ba",
        "unicode-nfc",
        "unicode-nfd",
      ]) ||
    fixture.vectors.some(
      (vector) =>
        !/^0x[0-9a-f]{64}$/u.test(vector.expected?.contentHash ?? "") ||
        !/^0x[0-9a-f]{64}$/u.test(vector.expected?.metadataHash ?? "") ||
        !/^0x[0-9a-f]{64}$/u.test(vector.expected?.metadataUriHash ?? "") ||
        !/^0x[0-9a-f]{64}$/u.test(vector.expected?.commitment ?? "") ||
        !/^0x[0-9a-f]{64}$/u.test(vector.expected?.attestationId ?? "")
    )
  ) {
    throw new Error(
      "Attestation canonical-hash fixture format or non-claims are invalid."
    );
  }
}

function normalizeHex(value, label) {
  if (typeof value !== "string") throw new Error(`${label} is missing.`);
  const normalized = value.startsWith("0x") ? value : `0x${value}`;
  if (!/^0x(?:[0-9a-f]{2})*$/iu.test(normalized)) {
    throw new Error(`${label} is not byte-aligned hex.`);
  }
  return normalized.toLowerCase();
}

function renderSdkAbis(nativeAbi, factoryAbi, rewardAbi, attestationAbi) {
  return `${generatedHeader("contracts/scripts/generate-artifacts.mjs")}import type { Abi } from "viem";\n\nexport const toriumNativeAbi = ${JSON.stringify(stableValue(nativeAbi), null, 2)} as const satisfies Abi;\n\nexport const toriumCreate2FactoryAbi = ${JSON.stringify(stableValue(factoryAbi), null, 2)} as const satisfies Abi;\n\nexport const toriumRewardDistributorAbi = ${JSON.stringify(stableValue(rewardAbi), null, 2)} as const satisfies Abi;\n\nexport const toriumAttestationRegistryAbi = ${JSON.stringify(stableValue(attestationAbi), null, 2)} as const satisfies Abi;\n`;
}

function renderSdkDeployments(registryValue) {
  const native = registryValue.entries.find(
    (entry) => entry.id === "torium-native"
  );
  const factory = registryValue.entries.find(
    (entry) => entry.id === "torium-create2-factory"
  );
  const reward = registryValue.entries.find(
    (entry) => entry.id === "reward-distributor"
  );
  const attestation = registryValue.entries.find(
    (entry) => entry.id === "attestation-registry"
  );
  const value = stableValue({
    schemaVersion: registryValue.schemaVersion,
    registryVersion: registryValue.registryVersion,
    environment: registryValue.environment,
    releaseStatus: registryValue.releaseStatus,
    chain: registryValue.chain,
    contracts: {
      toriumNative: {
        address: native.address,
        status: native.status,
        implementationVersion: native.implementationVersion,
        abiSha256: native.abiSha256,
      },
      toriumCreate2Factory: {
        address: factory.address,
        status: factory.status,
        implementationVersion: factory.implementationVersion,
        abiSha256: factory.abiSha256,
        runtimeCodeKeccak256: factory.code.runtimeCodeKeccak256,
        broadcast: false,
        transactionHash: null,
      },
      toriumRewardDistributor: {
        address: null,
        status: reward.status,
        implementationVersion: reward.implementationVersion,
        abiSha256: reward.abiSha256,
        runtimeCodeKeccak256: reward.code.runtimeCodeKeccak256,
        broadcast: false,
        transactionHash: null,
        roleAssignments: "unassigned",
      },
      toriumAttestationRegistry: {
        address: null,
        status: attestation.status,
        implementationVersion: attestation.implementationVersion,
        abiSha256: attestation.abiSha256,
        runtimeCodeKeccak256: attestation.code.runtimeCodeKeccak256,
        broadcast: false,
        transactionHash: null,
        roleAssignments: "none",
        issuerAuthorization: attestation.configuration.issuerAuthorization,
      },
    },
  });
  return `${generatedHeader("contracts/scripts/generate-artifacts.mjs")}export const toriumLocalnetContractRegistry = ${JSON.stringify(value, null, 2)} as const;\n\nexport type ToriumLocalnetContractRegistry = typeof toriumLocalnetContractRegistry;\n`;
}

function generatedHeader(generator) {
  return `/** DO NOT EDIT: generated by ${generator}. */\n`;
}

async function formatTypeScript(source, manifest) {
  const requireFromContracts = createRequire(
    path.join(repositoryRoot, "contracts/package.json")
  );
  const prettierPackagePath = requireFromContracts.resolve(
    "prettier/package.json"
  );
  const prettierPackage = JSON.parse(
    await readFile(prettierPackagePath, "utf8")
  );
  if (prettierPackage.version !== manifest.quality.prettier.version) {
    throw new Error(
      `Prettier ${prettierPackage.version} differs from pinned ${manifest.quality.prettier.version}.`
    );
  }
  const prettierPath = requireFromContracts.resolve("prettier");
  const prettierModule = await import(pathToFileURL(prettierPath));
  const prettier = prettierModule.default ?? prettierModule;
  return prettier.format(source, { parser: "typescript" });
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

function jsonText(value) {
  return `${JSON.stringify(stableValue(value), null, 2)}\n`;
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
    if (contents.toUpperCase().includes(value.toUpperCase())) {
      throw new Error(
        `${relativePath} contains forbidden generated text: ${value}`
      );
    }
  }
  if (/^(?:authorization|cookie)\s*:/imu.test(contents)) {
    throw new Error(
      `${relativePath} contains a forbidden HTTP credential header.`
    );
  }
  if (/"(?:generatedAt|createdAt|updatedAt|timestamp)"\s*:/u.test(contents)) {
    throw new Error(
      `${relativePath} contains a nondeterministic timestamp field.`
    );
  }
}

async function atomicWrite(relativePath, contents) {
  const destination = absolute(relativePath);
  await mkdir(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.tmp-${process.pid}`;
  try {
    await writeFile(temporary, contents, { encoding: "utf8", mode: 0o644 });
    await rename(temporary, destination);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function readFoundryArtifact(relativePath, contractName) {
  try {
    return await readJson(relativePath);
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      throw new Error(
        `Missing Foundry artifact for ${contractName}: ${relativePath}. Run the pinned contract build first.`
      );
    }
    throw error;
  }
}

async function readJson(relativePath) {
  return JSON.parse(await readFile(absolute(relativePath), "utf8"));
}

async function readBytes(relativePath) {
  return readFile(absolute(relativePath));
}

async function readText(relativePath) {
  return readFile(absolute(relativePath), "utf8");
}

async function readOptional(relativePath) {
  try {
    return await readFile(absolute(relativePath), "utf8");
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

function absolute(relativePath) {
  if (path.isAbsolute(relativePath) || relativePath.includes("..")) {
    throw new Error(
      `Generated path must be repository-relative: ${relativePath}`
    );
  }
  return path.join(repositoryRoot, relativePath);
}
