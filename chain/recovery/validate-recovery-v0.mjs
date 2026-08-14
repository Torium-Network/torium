#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const directory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(directory, "../..");
const rootRequire = createRequire(path.join(repositoryRoot, "package.json"));
const Ajv2020 = rootRequire("ajv/dist/2020").default;

const [recovery, schema] = await Promise.all([
  readJson("chain/recovery/recovery-v0.json"),
  readJson("chain/recovery/recovery-v0.schema.json"),
]);

const validateSchema = new Ajv2020({ strict: true, allErrors: true }).compile(
  schema
);
assert.equal(
  validateSchema(recovery),
  true,
  `recovery schema validation failed: ${JSON.stringify(validateSchema.errors)}`
);

assert.deepEqual(
  {
    identifiers: recovery.sources.identifiers.path,
    trustModel: recovery.sources.trustModel.path,
    threatModel: recovery.sources.threatModel.path,
    nodeRoles: recovery.sources.nodeRoles.path,
    localRecoveryTypes: recovery.sources.developerRecovery.typesPath,
    localRecoveryState: recovery.sources.developerRecovery.statePath,
    localVersion: recovery.sources.developerRecovery.versionPath,
    localRecoveryGuide: recovery.sources.developerRecovery.guidePath,
    validatorLifecycle: recovery.sources.keyLifecycle.guidePath,
  },
  {
    identifiers: "chain/config/identifiers.json",
    trustModel: "chain/config/trust-model-v1.json",
    threatModel: "chain/security/threat-model-v1.json",
    nodeRoles: "chain/profiles/node-roles-v0.json",
    localRecoveryTypes: "chain/app/localnet/recovery_types.go",
    localRecoveryState: "chain/app/localnet/recovery_state.go",
    localVersion: "chain/app/internal/version/version.go",
    localRecoveryGuide: "chain/localnet/RECOVERY.md",
    validatorLifecycle: "chain/operator/VALIDATOR_LIFECYCLE.md",
  }
);

const [
  identifiers,
  trustModel,
  threatModel,
  nodeRoles,
  localRecoveryTypes,
  localRecoveryState,
  localVersion,
  localRecoveryGuide,
  validatorLifecycle,
] = await Promise.all([
  readJson(recovery.sources.identifiers.path),
  readJson(recovery.sources.trustModel.path),
  readJson(recovery.sources.threatModel.path),
  readJson(recovery.sources.nodeRoles.path),
  readText(recovery.sources.developerRecovery.typesPath),
  readText(recovery.sources.developerRecovery.statePath),
  readText(recovery.sources.developerRecovery.versionPath),
  readText(recovery.sources.developerRecovery.guidePath),
  readText(recovery.sources.keyLifecycle.guidePath),
]);

assert.equal(recovery.schemaVersion, 1);
assert.equal(recovery.ownerIssue, 116);
assert.equal(
  recovery.status,
  "defined-production-shape-local-only-not-activated"
);
assert.equal(recovery.publicLaunchAllowed, false);
assert.deepEqual(recovery.scope, {
  environment: "local-development-only",
  liveDeployment: false,
  toriumBackendIntegration: false,
  toriumBackendTrustAuthority: false,
  bridge: false,
  layer2: false,
});

assert.equal(
  recovery.sources.identifiers.manifestVersion,
  identifiers.manifestVersion
);
assert.equal(recovery.sources.trustModel.modelVersion, trustModel.modelVersion);
assert.equal(
  recovery.sources.threatModel.modelVersion,
  threatModel.modelVersion
);
assert.equal(
  recovery.sources.nodeRoles.profileVersion,
  nodeRoles.profileVersion
);
assert.equal(recovery.sources.nodeRoles.ownerIssue, nodeRoles.ownerIssue);
assert.equal(recovery.sources.developerRecovery.ownerIssue, 98);
assert.equal(recovery.sources.keyLifecycle.ownerIssue, 117);

const localIdentifiers = identifiers.networks.find(
  ({ environment }) => environment === "localnet"
);
assert.ok(localIdentifiers);
assert.equal(localIdentifiers.cosmos.chainId, "torium-localnet-1");
assert.equal(localIdentifiers.evm.chainId, 1414484556);

assert.match(
  localRecoveryTypes,
  /RecoveryFormat\s*=\s*"torium-localnet-recovery-v1"/u
);
assert.equal(
  recovery.sources.developerRecovery.format,
  "torium-localnet-recovery-v1"
);
for (const tag of [
  "cosmosChainId",
  "evmChainId",
  "genesisSha256",
  "height",
  "blockHash",
  "appHash",
  "name",
  "latestHeight",
  "dataBytes",
  "path",
  "size",
  "mode",
  "sha256",
]) {
  assert.match(
    localRecoveryTypes,
    new RegExp(`json:"${tag}(?:,omitempty)?"`, "u"),
    `developer recovery source no longer contains shared field ${tag}`
  );
}
assert.match(localRecoveryState, /LoadBlockMeta\(height \+ 1\)/u);
assert.match(
  localRecoveryState,
  /if height == latestHeight \{[\s\S]*?return blockHash, node\.AppHash, nil/u
);
assert.deepEqual(
  recovery.snapshots.operatorApplicationSnapshot.heightAppHashSemantics,
  {
    latestAnchor:
      "at the latest committed height, use consensus state LastBlockHeight and AppHash",
    historicalAnchor:
      "for an older height H, verify the post-commit app hash from the canonical H+1 header",
  }
);
assert.match(localRecoveryGuide, /not a public-network backup/u);
assert.match(
  localRecoveryGuide,
  /owns production node recovery, state sync,/u
);
assert.match(
  localRecoveryGuide,
  /owns validator signer custody and escrow/u
);
assert.equal(
  recovery.developerEnvelopeCompatibility.productionPayloadReuseAllowed,
  false
);
assert.equal(
  recovery.developerEnvelopeCompatibility.productionTrustReuseAllowed,
  false
);
assert.deepEqual(recovery.developerEnvelopeCompatibility.reusableFields, {
  chain: [
    "cosmosChainId",
    "evmChainId",
    "genesisSha256",
    "height",
    "blockHash",
    "appHash",
  ],
  binary: [
    "version",
    "commit",
    "protocolVersion",
    "go",
    "cosmosEVM",
    "cosmosSDK",
    "cometBFT",
    "goEthereum",
  ],
  node: ["name", "latestHeight", "blockHash", "appHash", "dataBytes"],
  file: ["path", "size", "mode", "sha256"],
});
for (const tag of recovery.developerEnvelopeCompatibility.reusableFields
  .binary) {
  assert.match(
    localVersion,
    new RegExp(`json:"${tag}(?:,omitempty)?"`, "u"),
    `version source no longer contains shared binary field ${tag}`
  );
}
assert.equal(
  recovery.snapshots.developerRuntimeEnvelope.operatorRestoreAllowed,
  false
);

for (const riskId of recovery.sources.threatModel.riskIds) {
  assert.ok(threatModel.risks.some(({ id }) => id === riskId));
}
for (const invariantId of recovery.sources.threatModel.invariantIds) {
  assert.ok(threatModel.invariants.some(({ id }) => id === invariantId));
}
for (const gateId of recovery.sources.threatModel.releaseGateIds) {
  assert.ok(threatModel.releaseGates.some(({ id }) => id === gateId));
}

const trustingPeriod = trustModel.validatorLifecycle.parameterOwners.find(
  ({ parameter }) => parameter === "light_client.trusting_period"
);
assert.ok(trustingPeriod);
assert.equal(trustingPeriod.status, "unratified");
assert.equal(recovery.stateSync.trustPeriodParameterStatus, "unratified");
assert.equal(recovery.stateSync.enabled, false);
assert.deepEqual(recovery.stateSync.rpcServers, []);
assert.deepEqual(recovery.stateSync.snapshotServers, []);
assert.equal(recovery.stateSync.minimumIndependentProviders, 2);
for (const field of [
  "trustHeight",
  "trustHash",
  "expectedAppHash",
  "trustPeriodSeconds",
  "trustLevel",
  "metadataPublisher",
]) {
  assert.equal(recovery.stateSync[field], null);
}
assert.equal(
  recovery.stateSync.mustBeLessThanUnbondingSeconds,
  Number.parseInt(
    trustModel.validatorLifecycle.parameterOwners.find(
      ({ parameter }) => parameter === "staking.unbonding_time"
    ).localValue,
    10
  )
);

const roleIds = nodeRoles.roles.map(({ id }) => id);
assert.deepEqual(
  recovery.roleStoragePolicies.map(({ role }) => role),
  roleIds
);
for (const policy of recovery.roleStoragePolicies) {
  const sourceRole = nodeRoles.roles.find(({ id }) => id === policy.role);
  assert.ok(sourceRole);
  assert.equal(policy.storagePolicyRef, sourceRole.storagePolicyRef);
  const sourcePolicy = nodeRoles.storagePolicies[policy.storagePolicyRef];
  assert.ok(sourcePolicy);
  assert.deepEqual(policy, {
    role: sourceRole.id,
    storagePolicyRef: sourceRole.storagePolicyRef,
    pruningStrategy: sourcePolicy.pruningStrategy,
    keepRecent: sourcePolicy.keepRecent,
    interval: sourcePolicy.interval,
    minRetainBlocks: sourcePolicy.minRetainBlocks,
    txIndex: sourcePolicy.txIndex,
    indexEvents: sourcePolicy.indexEvents,
    targetFromGenesis: sourcePolicy.targetFromGenesis,
    queryWindowBlocks: sourcePolicy.queryWindowBlocks,
    queryWindowStatus: sourcePolicy.queryWindowStatus,
    snapshotInterval: sourcePolicy.snapshotInterval,
    snapshotKeepRecent: sourcePolicy.snapshotKeepRecent,
    discardAbciResponses: sourcePolicy.discardAbciResponses,
    activated: sourcePolicy.activated,
    evidenceComplete: sourcePolicy.evidenceComplete,
    // Runtime activation and a measured recovery objective are separate
    // facts. A storage target may be applied by a real node (#114's archive
    // role) while its RPO/RTO is still unmeasured (#116/#118), so the status
    // is derived from activation and never claims a supported objective.
    status: sourcePolicy.activated
      ? "runtime-activated-recovery-objective-unmeasured"
      : "hold-unmeasured-not-runtime-activated",
  });
  assert.equal(policy.evidenceComplete, sourcePolicy.activated);
}
// No storage target may claim a measured recovery objective yet, whatever its
// runtime activation state.
for (const value of Object.values(recovery.pruningAcceptance)) {
  assert.equal(value, false);
}

assert.deepEqual(recovery.securityInvariants, {
  chainIsAuthority: true,
  explorerDatabaseAuthority: "derived-rebuildable-index",
  checksumProvidesAuthenticity: false,
  singleProviderMayDefineTrustAnchor: false,
  hotMultiDatabaseCopyAllowed: false,
  genericRestoreMayOverwriteSignerState: false,
  staleOrClonedSignerMustFailClosed: true,
  unknownMeansZero: false,
  stateSyncImpliesArchiveHistory: false,
});

const requiredSnapshotMetadata = new Set(
  recovery.snapshots.operatorApplicationSnapshot.requiredMetadata
);
for (const field of [
  "cosmosChainId",
  "evmChainId",
  "genesisSha256",
  "height",
  "blockHash",
  "appHash",
  "binaryVersion",
  "sourceCommit",
  "dependencyIdentity",
  "createdAt",
  "providerId",
  "payloadSha256",
  "signatureAlgorithm",
  "signatureKeyId",
  "signature",
]) {
  assert.equal(requiredSnapshotMetadata.has(field), true);
}
const operatorSnapshot = recovery.snapshots.operatorApplicationSnapshot;
assert.equal(operatorSnapshot.enabled, false);
assert.equal(operatorSnapshot.captureMode, null);
assert.deepEqual(operatorSnapshot.providerIds, []);
assert.deepEqual(operatorSnapshot.publicationEndpoints, []);
assert.equal(operatorSnapshot.signatureAlgorithm, null);
assert.equal(operatorSnapshot.signatureKeyId, null);
assert.equal(operatorSnapshot.signerKeyOrStatePayloadAllowed, false);
assert.equal(operatorSnapshot.restoreProven, false);
assert.equal(operatorSnapshot.publicationProven, false);

const backupIds = [
  "validator-node-state",
  "full-rpc-node-state",
  "archive-history",
  "explorer-database",
  "node-configuration",
  "validator-signer-state",
];
assert.deepEqual(
  recovery.backupScopes.map(({ id }) => id),
  backupIds
);
assert.deepEqual(recovery.backupScopes, [
  {
    id: "validator-node-state",
    ownerIssue: 116,
    sourceIdentities: ["validator"],
    authority: "rebuildable-chain-copy",
    includes: ["application state", "CometBFT block and consensus data"],
    excludes: ["consensus private key", "priv_validator_state.json"],
    rebuildAllowed: true,
    schedule: null,
    destination: null,
    verification: "cold-consistent anchor and payload verification",
    status: "hold-no-operator-storage-selected",
  },
  {
    id: "full-rpc-node-state",
    ownerIssue: 116,
    sourceIdentities: ["full", "public-rpc"],
    authority: "rebuildable-chain-copy",
    includes: ["application state", "query index", "CometBFT data"],
    excludes: ["operator keys", "RPC credentials"],
    rebuildAllowed: true,
    schedule: null,
    destination: null,
    verification: "query-window and anchor verification",
    status: "hold-no-operator-storage-selected",
  },
  {
    id: "archive-history",
    ownerIssue: 116,
    sourceIdentities: ["private-archive-indexer"],
    authority: "rebuildable-chain-copy",
    includes: ["from-genesis application and transaction history"],
    excludes: ["consumer credentials", "signer state"],
    rebuildAllowed: true,
    schedule: null,
    destination: null,
    verification: "from-genesis boundary and anchor verification",
    status: "hold-no-operator-storage-selected",
  },
  {
    id: "explorer-database",
    ownerIssue: 116,
    sourceIdentities: ["blockscout-postgresql"],
    authority: "derived-rebuildable-index",
    includes: ["Blockscout PostgreSQL derived index"],
    excludes: ["L1 trust authority", "chain signer material"],
    rebuildAllowed: true,
    schedule: null,
    destination: null,
    verification: "canonical reindex comparison",
    status: "hold-explorer-inactive",
  },
  {
    id: "node-configuration",
    ownerIssue: 116,
    sourceIdentities: ["operator-configuration"],
    authority: "reviewed-configuration-copy",
    includes: ["genesis", "role profile", "secret-free configuration"],
    excludes: ["private keys", "credentials", "environment secrets"],
    rebuildAllowed: false,
    schedule: null,
    destination: null,
    verification: "version, checksum, and secret-scan verification",
    status: "hold-no-operator-storage-selected",
  },
  {
    id: "validator-signer-state",
    ownerIssue: 117,
    sourceIdentities: ["validator"],
    authority: "double-sign-safety-state",
    includes: ["monotonic last-sign state under #117 custody"],
    excludes: ["generic node-state snapshot", "cloned live signer"],
    rebuildAllowed: false,
    schedule: null,
    destination: null,
    verification: "monotonicity and no-concurrent-signer gate",
    status: "hold-owned-by-issue-117",
  },
]);
for (const backup of recovery.backupScopes) {
  assert.equal(backup.schedule, null);
  assert.equal(backup.destination, null);
  assert.match(backup.status, /^hold-/u);
}
const validatorBackup = backupScope("validator-node-state");
assert.deepEqual(validatorBackup.sourceIdentities, ["validator"]);
assert.equal(validatorBackup.excludes.includes("consensus private key"), true);
assert.equal(
  validatorBackup.excludes.includes("priv_validator_state.json"),
  true
);
const signerBackup = backupScope("validator-signer-state");
assert.equal(signerBackup.ownerIssue, 117);
assert.equal(signerBackup.rebuildAllowed, false);
assert.match(signerBackup.verification, /monotonicity/u);
assert.match(validatorLifecycle, /priv_validator_state\.json/u);
assert.match(validatorLifecycle, /double-sign/u);
const explorerBackup = backupScope("explorer-database");
assert.equal(explorerBackup.authority, "derived-rebuildable-index");
assert.equal(explorerBackup.rebuildAllowed, true);
assert.deepEqual(backupScope("full-rpc-node-state").sourceIdentities, [
  "full",
  "public-rpc",
]);

assert.equal(recovery.retention.automaticDeletionEnabled, false);
assert.equal(
  recovery.retention.localSnapshotKeepRecentIsProductionPolicy,
  false
);
for (const field of [
  "retentionCount",
  "retentionDays",
  "immutabilityDays",
  "deletionMode",
]) {
  assert.equal(recovery.retention[field], null);
}
assert.equal(recovery.accessControl.publicRead, false);
assert.equal(recovery.accessControl.publicWrite, false);
assert.deepEqual(recovery.accessControl.principals, []);
assert.equal(recovery.encryption.atRestRequired, true);
assert.equal(recovery.encryption.inTransitRequired, true);
assert.equal(recovery.encryption.clientSideBeforeUploadRequired, true);
for (const field of [
  "algorithm",
  "keyProvider",
  "keyId",
  "rotationDays",
  "recoveryShares",
]) {
  assert.equal(recovery.encryption[field], null);
}

assert.equal(recovery.restoreVerification.operatorDrillsExecuted, false);
assert.equal(recovery.restoreVerification.localDeveloperEvidenceOnly, true);
assert.equal(recovery.recoveryObjectives.measurementOwners.includes(118), true);
assert.equal(recovery.recoveryObjectives.measurementOwners.includes(119), true);
for (const field of [
  "rpoSeconds",
  "rtoSeconds",
  "restoreThroughputBytesPerSecond",
  "storageGrowthBytesPerDay",
  "lastDrillAt",
  "evidencePath",
]) {
  assert.equal(recovery.recoveryObjectives[field], null);
}

const expectedHolds = [
  {
    id: "role-storage-runtime-inactive",
    ownerIssue: 114,
    evidenceIssues: [116, 118],
    requirement:
      "Activate and prove effective pruning, indexing, snapshot, and query-window configuration for every node role.",
  },
  {
    id: "state-sync-trust-unratified",
    ownerIssue: 116,
    evidenceIssues: [123],
    requirement:
      "Select independent providers and ratify trust height, hash, period, level, expiry, and mismatch behavior.",
  },
  {
    id: "snapshot-envelope-and-publication-unproven",
    ownerIssue: 116,
    evidenceIssues: [117, 119],
    requirement:
      "Define and prove the signed operator snapshot envelope, publisher identity, safe publication, and restore verification.",
  },
  {
    id: "snapshot-signing-custody-unselected",
    ownerIssue: 117,
    evidenceIssues: [116],
    requirement:
      "Select detached-signature keys, custody, algorithm, rotation, revocation, recovery, and compromise response.",
  },
  {
    id: "backup-storage-and-access-unselected",
    ownerIssue: 116,
    evidenceIssues: [],
    requirement:
      "Select backup destination, schedule, access identities, audit sink, offsite replicas, and restore source policy.",
  },
  {
    id: "encryption-custody-unselected",
    ownerIssue: 117,
    evidenceIssues: [116],
    requirement:
      "Select encryption envelope, key provider, key identity, rotation, revocation, and recovery-share custody under #117.",
  },
  {
    id: "retention-policy-unmeasured",
    ownerIssue: 116,
    evidenceIssues: [118],
    requirement:
      "Ratify retention, immutability, deletion, offsite replica, and accountability evidence windows from measured capacity.",
  },
  {
    id: "signer-recovery-unproven",
    ownerIssue: 117,
    evidenceIssues: [116, 119],
    requirement:
      "Prove monotonic signer-state recovery and reject stale or concurrently active validator signer clones.",
  },
  {
    id: "rpo-rto-and-growth-unmeasured",
    ownerIssue: 116,
    evidenceIssues: [118, 119],
    requirement:
      "Measure snapshot duration, storage growth, restore throughput, RPO, and RTO under declared hardware and workloads.",
  },
  {
    id: "operator-recovery-drills-unproven",
    ownerIssue: 116,
    evidenceIssues: [119],
    requirement:
      "Snapshot creation, corrupt-archive rejection, and atomic restore-to-consensus are exercised by chain/recovery/run-restore-drill-v0.sh (2026-07-29); clean state sync, role restore or rebuild, explorer reindex, and local-envelope migration remain unexercised.",
  },
  {
    id: "chaos-recovery-drills-unproven",
    ownerIssue: 119,
    evidenceIssues: [116],
    requirement:
      "Inject corruption, truncation, provider loss, disk pressure, partitions, and restart faults into recovery workflows.",
  },
  {
    id: "explorer-recovery-inactive",
    ownerIssue: 113,
    evidenceIssues: [116],
    requirement:
      "Activate the explorer stack before proving PostgreSQL restore, canonical reindex, and index-lag recovery behavior.",
  },
  {
    id: "archive-recovery-inactive",
    ownerIssue: 114,
    evidenceIssues: [116],
    requirement:
      "Activate the private archive role before proving from-genesis rebuild, restore, retention, and query boundaries.",
  },
  {
    id: "public-operation-deferred",
    ownerIssue: 127,
    evidenceIssues: [116],
    requirement:
      "Keep publication endpoints, public credentials, infrastructure purchases, and live operation outside this local-only v0.",
  },
];
assert.deepEqual(recovery.holds, expectedHolds);
const holdIds = expectedHolds.map(({ id }) => id);
assert.equal(new Set(holdIds).size, holdIds.length);

process.stdout.write(
  `${JSON.stringify(
    {
      valid: true,
      recoveryVersion: recovery.recoveryVersion,
      status: recovery.status,
      roles: roleIds,
      backupScopes: backupIds,
      stateSyncEnabled: recovery.stateSync.enabled,
      operatorSnapshotEnabled: operatorSnapshot.enabled,
      operatorDrillsExecuted:
        recovery.restoreVerification.operatorDrillsExecuted,
      holdIds,
      publicLaunchAllowed: recovery.publicLaunchAllowed,
    },
    null,
    2
  )}\n`
);

function backupScope(id) {
  const scope = recovery.backupScopes.find((candidate) => candidate.id === id);
  assert.ok(scope, `missing backup scope ${id}`);
  return scope;
}

async function readJson(relativePath) {
  return JSON.parse(await readText(relativePath));
}

async function readText(relativePath) {
  return readFile(path.join(repositoryRoot, relativePath), "utf8");
}
