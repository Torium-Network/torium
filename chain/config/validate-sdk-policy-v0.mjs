#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const directory = dirname(fileURLToPath(import.meta.url));
const root = join(directory, "../..");
const [policy, schema, identifiers, toolchain, repositoryMap] =
  await Promise.all([
    json(join(directory, "sdk-policy-v0.json")),
    json(join(directory, "sdk-policy-v0.schema.json")),
    json(join(directory, "identifiers.json")),
    json(join(root, "chain/toolchain.json")),
    readFile(join(root, "chain/REPOSITORY_MAP.md"), "utf8"),
  ]);

assert.deepEqual(Object.keys(policy).sort(), schema.required.toSorted());
assert.equal(schema.additionalProperties, false);
for (const property of [
  "package",
  "baseline",
  "runtimes",
  "modules",
  "publicApi",
  "accounts",
  "failures",
  "compatibility",
  "budgets",
]) {
  assert.equal(
    schema.properties[property].additionalProperties,
    false,
    `${property} schema must reject unknown fields`
  );
}

assert.equal(policy.$schema, "./sdk-policy-v0.schema.json");
assert.equal(policy.schemaVersion, 1);
assert.equal(policy.policyVersion, "0.1.0");
assert.equal(policy.status, "v0-published");
assert.deepEqual(policy.package, {
  name: identifiers.namespaces.npm.primaryPackage,
  sourcePath: "packages/torium-sdk",
  publishAccess: "public",
  reservationStatus: identifiers.namespaces.npm.reservationStatus,
  privateUntilApproved: false,
});

assert.deepEqual(policy.baseline, {
  viem: {
    testedVersion: "2.55.2",
    peerRange: ">=2.55.2 <3",
    checkedAt: "2026-07-15",
  },
  typescript: {
    buildVersion: toolchain.quality.typescript.version,
    consumerRange: ">=5.7 <7",
  },
});
assert.deepEqual(policy.runtimes.node, {
  range: ">=22.23.1 <23 || >=24 <25",
  canonicalTestVersion: toolchain.runtimes.node.version,
  candidateLtsMajors: [22, 24],
  supportStatus: "ci-esm-cjs-verified-issue-136",
});
assert.deepEqual(policy.runtimes.browser, {
  requirements: ["ES2022", "BigInt", "fetch", "EIP-1193-when-wallet-signing"],
  candidateTestEngines: ["chromium", "firefox", "webkit"],
  resolvedVersionsRecordedByIssue: 136,
  supportStatus: "vite-bundle-and-eip1193-mock-verified-issue-136",
});
assert.deepEqual(policy.runtimes.reactNative, {
  minimumVersion: "0.81.0",
  engine: "Hermes",
  nodePolyfillsAllowed: false,
  supportStatus: "metro-hermes-bytecode-verified-issue-136",
});

assert.deepEqual(policy.modules, {
  format: "dual-esm-cjs",
  types: "declarations",
  sideEffects: false,
  treeShakingRequired: true,
  exports: [
    ".",
    "./chains",
    "./clients",
    "./wallet",
    "./contracts",
    "./errors",
    "./utils",
    "./experimental",
  ],
  experimentalExport: "./experimental",
  generatedPath: "src/generated",
  generatedFilesEditable: false,
});
assert.equal(
  new Set(policy.modules.exports).size,
  policy.modules.exports.length
);
assert.ok(policy.modules.exports.includes(policy.modules.experimentalExport));

assert.deepEqual(policy.publicApi, {
  transportPolicy: "accept-standard-viem-and-eip1193",
  proprietaryTransportAllowed: false,
  defaultPublicRpcAllowed: false,
  localLoopbackDefaultsAllowed: true,
  clientFactories: ["createToriumPublicClient", "createToriumWalletClient"],
  boundaries: [
    "chains",
    "clients",
    "wallet",
    "contracts",
    "errors",
    "amount-and-address-utils",
  ],
});
assert.deepEqual(policy.accounts, {
  accepted: [
    "viem-Account",
    "EIP-1193-provider",
    "caller-supplied-wallet-client",
  ],
  rawSecretMaterialAcceptedAtAnyApiLevel: false,
  rawSecretMaterial: [
    "private-key",
    "mnemonic",
    "seed",
    "keystore",
    "key-bytes",
  ],
  keyGenerationAllowed: false,
  keyPersistenceAllowed: false,
  secretLoggingAllowed: false,
  signingOwner: "caller-wallet-or-explicit-viem-account",
});
assert.deepEqual(policy.failures, {
  taxonomyVersion: 1,
  normalizedBoundaries: [
    "endpoint-validation",
    "torium-client-actions",
    "torium-wallet-actions",
  ],
  directViemActions: "preserve-viem-errors",
  defaultAttempts: 1,
  maximumIdempotentReadAttempts: 3,
  automaticRetryOperations: ["idempotent-read-explicit-opt-in"],
  safeBroadcastRetryConditions: [],
  broadcastMaxAttempts: 1,
  globalTimeoutOwner: "caller-viem-transport",
  sdkActionsSupportAbortSignal: true,
  sdkActionsSupportPerActionTimeout: true,
  diagnostics: "opt-in-allowlist",
  diagnosticCauseIncluded: false,
});

assert.deepEqual(policy.compatibility.semverBefore1, {
  patch: "backward-compatible-fixes-only",
  minor: "stable-export-breaking-change-only-with-migration-note",
  experimental: "may-change-in-minor-with-changelog",
});
assert.deepEqual(policy.compatibility.semverAfter1, {
  breaking: "major-only",
  deprecationMinimumDays: 90,
  deprecationMinimumMinorReleases: 1,
});
assert.equal(policy.compatibility.v0SupportWindow, "latest-minor-only");
assert.equal(
  policy.compatibility.stableSupportWindow,
  "current-major-and-previous-major-for-six-months"
);
assert.equal(
  policy.compatibility.chainManifest,
  "exact-manifest-version-and-chain-id"
);
assert.equal(
  policy.compatibility.contractIdentity,
  "environment-address-version-runtime-hash"
);
assert.equal(policy.compatibility.unknownCompatibilityBehavior, "fail-closed");
assert.deepEqual(policy.compatibility.testGates, {
  chainSource: "chain/config/identifiers.json",
  contractRegistryPattern: "contracts/deployments/<environment>.json",
  apiSnapshotPattern: "packages/torium-sdk/api/<version>.api.md",
  implementationOwnerIssue: 129,
  runtimeMatrixOwnerIssue: 136,
  releaseComparisonOwnerIssue: 137,
});
assert.deepEqual(policy.budgets, {
  rootEntryGzipBytesExcludingViem: 15 * 1024,
  packedTarballBytes: 256 * 1024,
  browserExampleJavaScriptBytes: 360_000,
  browserExampleGzipBytes: 115_000,
  reactNativeHermesBytecodeBytes: 1_310_720,
  reactNativeSourceModules: 1_000,
  generatedAbiExcludedFromRootEntry: true,
});

assert.deepEqual(policy.forbiddenCoreDependencies, [
  "packages/backend",
  "Clerk",
  "PostgreSQL",
  "Redis",
  "BullMQ",
  "Torium-product-HTTP-API",
  "bridge",
  "IBC",
]);
assert.deepEqual(
  policy.consumerIssues,
  [129, 130, 131, 132, 133, 134, 135, 136, 137, 138, 141, 143]
);
assert.match(repositoryMap, /`packages\/torium-sdk\/`/u);

const publicNetworks = identifiers.networks.filter(
  ({ public: isPublic }) => isPublic
);
assert.ok(publicNetworks.length > 0);
assert.ok(
  publicNetworks.every(
    ({ environment }) => environment === "testnet" || environment === "mainnet"
  )
);
assert.equal(
  identifiers.walletMetadata.publicEndpointStatus,
  "deferred-unpublished"
);
assert.equal(policy.publicApi.defaultPublicRpcAllowed, false);

validateCriticalPolicy(policy);
for (const mutate of [
  (candidate) => {
    candidate.runtimes.node.range = ">=20";
  },
  (candidate) => {
    candidate.accounts.rawSecretMaterialAcceptedAtAnyApiLevel = true;
  },
  (candidate) => {
    candidate.compatibility.unknownCompatibilityBehavior = "best-effort";
  },
  (candidate) => {
    candidate.failures.broadcastMaxAttempts = 2;
  },
  (candidate) => {
    candidate.failures.directViemActions = "wrap-all-errors";
  },
]) {
  const invalid = structuredClone(policy);
  mutate(invalid);
  assert.throws(() => validateCriticalPolicy(invalid));
}

console.log(
  `SDK policy ${policy.policyVersion}: ${policy.package.name}, viem ${policy.baseline.viem.testedVersion}, ${policy.modules.exports.length} exports, published`
);

async function json(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

function validateCriticalPolicy(candidate) {
  assert.equal(candidate.runtimes.node.range, ">=22.23.1 <23 || >=24 <25");
  assert.equal(
    candidate.runtimes.node.supportStatus,
    "ci-esm-cjs-verified-issue-136"
  );
  assert.equal(
    candidate.accounts.rawSecretMaterialAcceptedAtAnyApiLevel,
    false
  );
  assert.deepEqual(candidate.accounts.rawSecretMaterial, [
    "private-key",
    "mnemonic",
    "seed",
    "keystore",
    "key-bytes",
  ]);
  assert.equal(
    candidate.compatibility.unknownCompatibilityBehavior,
    "fail-closed"
  );
  assert.equal(candidate.failures.defaultAttempts, 1);
  assert.equal(candidate.failures.maximumIdempotentReadAttempts, 3);
  assert.deepEqual(candidate.failures.safeBroadcastRetryConditions, []);
  assert.equal(candidate.failures.broadcastMaxAttempts, 1);
  assert.equal(candidate.failures.directViemActions, "preserve-viem-errors");
  assert.equal(candidate.failures.diagnosticCauseIncluded, false);
}
