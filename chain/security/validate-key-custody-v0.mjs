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

const [custody, schema] = await Promise.all([
  readJson("chain/security/key-custody-v0.json"),
  readJson("chain/security/key-custody-v0.schema.json"),
]);
const validateSchema = new Ajv2020({ strict: true, allErrors: true }).compile(
  schema
);
assert.equal(
  validateSchema(custody),
  true,
  `key custody schema validation failed: ${JSON.stringify(validateSchema.errors)}`
);

assert.deepEqual(
  {
    identifiers: custody.sources.identifiers.path,
    trustModel: custody.sources.trustModel.path,
    threatModel: custody.sources.threatModel.path,
    nodeRoles: custody.sources.nodeRoles.path,
    governance: custody.sources.governance.path,
    secretPolicy: custody.sources.secretPolicy.path,
    recoveryPolicy: custody.sources.recoveryPolicy.path,
    filePvGoMod: custody.sources.filePvFormat.goModPath,
    localRecoveryGuide: custody.sources.localRecoveryGuide,
    localRuntimeSource: custody.sources.localRuntimeSource,
    localAccountsGuide: custody.sources.localAccountsGuide,
    validatorLifecycleGuide: custody.sources.validatorLifecycleGuide,
    signerStateGuard: custody.sources.signerStateGuard,
    signerStateGuardTest: custody.sources.signerStateGuardTest,
    compromiseRunbook: custody.sources.compromiseRunbook,
  },
  {
    identifiers: "chain/config/identifiers.json",
    trustModel: "chain/config/trust-model-v1.json",
    threatModel: "chain/security/threat-model-v1.json",
    nodeRoles: "chain/profiles/node-roles-v0.json",
    governance: "chain/config/governance-v1.json",
    secretPolicy: "chain/security/secret-policy.json",
    recoveryPolicy: "chain/recovery/recovery-v0.json",
    filePvGoMod: "chain/app/go.mod",
    localRecoveryGuide: "chain/localnet/RECOVERY.md",
    localRuntimeSource: "chain/app/localnet/runtime.go",
    localAccountsGuide: "chain/localnet/ACCOUNTS.md",
    validatorLifecycleGuide: "chain/operator/VALIDATOR_LIFECYCLE.md",
    signerStateGuard: "chain/operator/signer-state-guard.mjs",
    signerStateGuardTest: "chain/operator/signer-state-guard.test.mjs",
    compromiseRunbook: "docs/operations/torium-validator-signer-lifecycle.md",
  }
);

const [
  identifiers,
  trustModel,
  threatModel,
  nodeRoles,
  governance,
  secretPolicy,
  recoveryPolicy,
  filePvGoMod,
  localRecoveryGuide,
  localRuntimeSource,
  localAccountsGuide,
  validatorLifecycleGuide,
  signerStateGuardSource,
  signerStateGuardTestSource,
  compromiseRunbook,
] = await Promise.all([
  readJson(custody.sources.identifiers.path),
  readJson(custody.sources.trustModel.path),
  readJson(custody.sources.threatModel.path),
  readJson(custody.sources.nodeRoles.path),
  readJson(custody.sources.governance.path),
  readJson(custody.sources.secretPolicy.path),
  readJson(custody.sources.recoveryPolicy.path),
  readText(custody.sources.filePvFormat.goModPath),
  readText(custody.sources.localRecoveryGuide),
  readText(custody.sources.localRuntimeSource),
  readText(custody.sources.localAccountsGuide),
  readText(custody.sources.validatorLifecycleGuide),
  readText(custody.sources.signerStateGuard),
  readText(custody.sources.signerStateGuardTest),
  readText(custody.sources.compromiseRunbook),
]);

assert.equal(custody.schemaVersion, 1);
assert.equal(custody.ownerIssue, 117);
assert.equal(custody.publicLaunchAllowed, false);
assert.equal(custody.scope.productionSecretMaterialPresent, false);
assert.equal(custody.scope.toriumBackendIntegration, false);
assert.equal(custody.scope.toriumBackendKeyAuthority, false);
assert.equal(
  custody.sources.identifiers.manifestVersion,
  identifiers.manifestVersion
);
assert.equal(custody.sources.trustModel.modelVersion, trustModel.modelVersion);
assert.equal(
  custody.sources.threatModel.modelVersion,
  threatModel.modelVersion
);
assert.equal(
  custody.sources.nodeRoles.profileVersion,
  nodeRoles.profileVersion
);
assert.equal(
  custody.sources.governance.contractVersion,
  governance.contractVersion
);
assert.equal(
  custody.sources.secretPolicy.policyVersion,
  secretPolicy.policyVersion
);
assert.equal(
  custody.sources.recoveryPolicy.recoveryVersion,
  recoveryPolicy.recoveryVersion
);
assert.deepEqual(custody.sources.filePvFormat, {
  goModPath: "chain/app/go.mod",
  module: "github.com/cometbft/cometbft",
  version: "v0.39.3",
  replacementAllowed: false,
  signatureEncoding: "canonical-base64-ed25519-64-bytes",
  signBytesEncoding: "canonical-uppercase-hex",
  heightType: "non-negative-int64",
  roundType: "non-negative-int32",
  stepValues: [0, 1, 2, 3],
});
assert.match(
  filePvGoMod,
  /^\s*github\.com\/cometbft\/cometbft\s+v0\.39\.3\s*$/mu
);
assert.doesNotMatch(
  filePvGoMod,
  /^\s*(?:replace\s+)?github\.com\/cometbft\/cometbft(?:\s+v\S+)?\s+=>/mu
);

for (const riskId of custody.sources.threatModel.riskIds) {
  assert.ok(threatModel.risks.some(({ id }) => id === riskId));
}
for (const invariantId of custody.sources.threatModel.invariantIds) {
  assert.ok(threatModel.invariants.some(({ id }) => id === invariantId));
}
for (const gateId of custody.sources.threatModel.releaseGateIds) {
  assert.ok(threatModel.releaseGates.some(({ id }) => id === gateId));
}

assert.deepEqual(custody.securityInvariants, {
  contractContainsPrivateMaterial: false,
  contractContainsMnemonic: false,
  contractContainsRecoveryShare: false,
  publicIdentifiersOnly: true,
  singleActiveConsensusSignerRequired: true,
  clonedConsensusSignerAllowed: false,
  availabilityMayOverrideDoubleSignSafety: false,
  operatorNodeBackupMayContainConsensusKeyOrSignerState: false,
  secretMayEnterRepository: false,
  secretMayEnterContainerLayer: false,
  secretMayEnterProcessArguments: false,
  secretMayEnterLogs: false,
  secretMayEnterSupportBundle: false,
  publicDeterministicFixtureIsProductionSecret: false,
  publicDeterministicFixtureProductionReuseAllowed: false,
});
assert.deepEqual(custody.localDeveloperRecoveryArchive, {
  ownerIssue: 98,
  scope: "disposable-local-debugging-only",
  containsPublicDeterministicConsensusSignerFixture: true,
  containsSignerState: true,
  authenticatedPublisher: false,
  encrypted: false,
  productionPromotionAllowed: false,
});
assert.match(localRecoveryGuide, /public deterministic local validator keys/u);
assert.match(localRecoveryGuide, /complete local runtime image/u);
assert.match(localRecoveryGuide, /not a public-network backup/u);
assert.equal(secretPolicy.findingOutput.includeMatchedValue, false);
assert.equal(
  secretPolicy.environmentFilePolicy.forbidRuntimeEnvironmentFiles,
  true
);
for (const name of [
  "priv_validator_key.json",
  "priv_validator_state.json",
  "node_key.json",
  "keystore.json",
]) {
  assert.equal(secretPolicy.forbiddenFileNames.includes(name), true);
}
for (const surface of [
  "tracked-source",
  "logs",
  "binary-images-and-metadata",
  "support-bundle-staging",
  "fixtures",
  "examples",
]) {
  assert.equal(secretPolicy.requiredSurfaces.includes(surface), true);
}

const inventoryIds = [
  "validator-consensus-signing",
  "p2p-node-identity",
  "validator-operator-account",
  "governance-multisig",
  "system-contract-deployer",
  "public-faucet-hot-signer",
  "ci-workload-identity",
  "operator-snapshot-publisher-signing",
  "release-artifact-signing",
  "backup-encryption-key",
];
assert.deepEqual(
  custody.keyInventory.map(({ id }) => id),
  inventoryIds
);
assert.equal(new Set(inventoryIds).size, inventoryIds.length);
for (const item of custody.keyInventory) {
  assert.match(item.publicMode, /^hold-/u);
  assert.ok(item.ownerIssues.length > 0);
}
assert.equal(keyClass("validator-consensus-signing").algorithm, "Ed25519");
assert.deepEqual(keyClass("validator-consensus-signing").allowedIdentities, [
  "matching-validator",
]);
assert.match(
  keyClass("validator-consensus-signing").rotation,
  /no in-place key edit/u
);
assert.equal(keyClass("validator-operator-account").algorithm, "secp256k1");
assert.equal(keyClass("system-contract-deployer").algorithm, "secp256k1");
assert.equal(keyClass("public-faucet-hot-signer").algorithm, "secp256k1");
for (const id of [
  "governance-multisig",
  "ci-workload-identity",
  "operator-snapshot-publisher-signing",
  "release-artifact-signing",
  "backup-encryption-key",
]) {
  assert.equal(keyClass(id).algorithm, null);
}
assert.equal(governance.governance.authority, "cosmos-gov-module-account");
assert.match(
  keyClass("governance-multisig").localMode,
  /no production multisig/u
);
assert.match(
  localAccountsGuide,
  /public deterministic genesis [`]faucet[`] fixture/u
);
assert.match(localAccountsGuide, /private-key\s+environment/u);
assert.match(validatorLifecycleGuide, /Keep `priv_validator_key\.json` and/u);
assert.match(validatorLifecycleGuide, /double-sign/u);

const validatorRole = nodeRoles.roles.find(({ id }) => id === "validator");
assert.ok(validatorRole);
assert.equal(
  validatorRole.consensusKey.registeredValidatorSetKeyPermitted,
  true
);
assert.equal(
  validatorRole.consensusKey.filePvKeyRelativePath,
  custody.signerRestoreGuard.keyPath
);
assert.equal(
  validatorRole.consensusKey.filePvStateRelativePath,
  custody.signerRestoreGuard.statePath
);
assert.equal(validatorRole.consensusKey.stateMonotonicRequired, true);
assert.match(
  localRuntimeSource,
  /filepath\.Join\(home, "config", "priv_validator_key\.json"\)/u
);
assert.match(
  localRuntimeSource,
  /filepath\.Join\(home, "data", "priv_validator_state\.json"\)/u
);
for (const role of nodeRoles.roles.filter(({ id }) => id !== "validator")) {
  assert.equal(role.consensusKey.registeredValidatorSetKeyPermitted, false);
  assert.equal(
    role.consensusKey.filePvPubkeyMustNotMatchRegisteredValidatorSet,
    true
  );
}
const recoveryValidatorBackup = recoveryPolicy.backupScopes.find(
  ({ id }) => id === "validator-node-state"
);
assert.ok(recoveryValidatorBackup);
assert.deepEqual(recoveryValidatorBackup.excludes, [
  "consensus private key",
  "priv_validator_state.json",
]);

assert.deepEqual(custody.signerRestoreGuard, {
  implementation: "chain/operator/signer-state-guard.mjs",
  status: "implemented-offline-local-guard-runtime-admission-not-wired",
  validatorStoppedEvidenceRequired: true,
  validatorStoppedEvidenceAutomated: false,
  keyPath: "config/priv_validator_key.json",
  statePath: "data/priv_validator_state.json",
  requiredFileMode: "0600",
  sameConsensusIdentityRequired: true,
  privateKeySeedMustDerivePublicKey: true,
  signatureOverSignBytesRequired: true,
  signBytesChainIdAndHrsVerified: false,
  trustedMaximumHeightRequired: true,
  trustedMaximumHeightEvidenceAutomated: false,
  positionOrder: ["height", "round", "step"],
  candidateMayBeBehind: false,
  samePositionSignBytesMustMatch: true,
  secretMaterialReturned: false,
  liveRestoreDrillPassed: false,
});
for (const pattern of [
  /validatorStopped !== true/u,
  /comparePosition\(candidate\.state, current\.state\)/u,
  /private-key seed does not derive the public key/u,
  /decodeCanonicalUpperHex/u,
  /verify\(null, signBytes/u,
  /maximumHeight = 9_223_372_036_854_775_807n/u,
  /trusted maximum signer height/u,
  /candidate signer state is behind/u,
  /same signer position has different sign bytes/u,
  /mode must be 0600/u,
  /secretMaterialReturned: false/u,
]) {
  assert.match(signerStateGuardSource, pattern);
}
for (const pattern of [
  /rejects rollback/u,
  /different consensus identity/u,
  /strict permissions/u,
  /invalid FilePV state/u,
  /secretMaterialReturned/u,
]) {
  assert.match(signerStateGuardTestSource, pattern);
}

for (const policy of Object.values(custody.lifecyclePolicies)) {
  assert.match(policy.status, /^hold-/u);
  assert.equal(policy.selectedMechanism, null);
}
assert.equal(custody.lifecyclePolicies.backup.shareThreshold, null);
assert.equal(custody.lifecyclePolicies.backup.totalShares, null);
assert.deepEqual(custody.lifecyclePolicies.backup.custodians, []);
assert.equal(custody.remoteSignerAndHsm.requiredForLocalDevelopment, false);
assert.equal(custody.remoteSignerAndHsm.publicValidatorDecision, null);
assert.deepEqual(custody.remoteSignerAndHsm.candidates, []);
assert.equal(custody.remoteSignerAndHsm.compatibilityTested, false);
assert.equal(
  custody.consensusRotationConstraint.inPlacePrivateKeyEditAllowed,
  false
);
assert.equal(
  custody.consensusRotationConstraint.localReplacementDrillPassed,
  false
);
assert.equal(
  custody.consensusRotationConstraint.publicReplacementDrillPassed,
  false
);
assert.equal(custody.twoPersonControls.minimumApprovals, null);
assert.deepEqual(custody.twoPersonControls.approvers, []);

const runbookAnchors = markdownAnchors(compromiseRunbook);
assert.deepEqual(
  custody.compromiseRunbooks.map(({ keyClass }) => keyClass),
  inventoryIds
);
for (const runbook of custody.compromiseRunbooks) {
  assert.equal(runbook.status, "authored-not-drilled");
  assert.equal(runbook.lastDrillAt, null);
  assert.equal(runbookAnchors.has(runbook.anchor), true);
}

const expectedHoldOwners = {
  "public-operator-roster-unselected": [117, [124]],
  "generation-and-storage-ceremonies-unproven": [117, [119, 126]],
  "backup-share-design-unselected": [117, [116, 126]],
  "signer-runtime-admission-unwired": [117, [116, 119]],
  "remote-signer-and-hsm-unselected": [117, [118, 119, 126]],
  "consensus-replacement-drill-unproven": [117, [100, 119, 126]],
  "governance-multisig-unconfigured": [106, [117, 126]],
  "public-faucet-signer-unimplemented": [172, [117, 120, 125]],
  "snapshot-and-backup-custody-unselected": [117, [116, 123, 126]],
  "ci-workload-identity-unimplemented": [121, [117, 122, 126]],
  "release-signing-unimplemented": [122, [117, 121, 126]],
  "compromise-drills-unproven": [117, [119, 120, 126]],
  "public-activation-deferred": [127, [117, 126]],
};
assert.deepEqual(
  custody.holds.map(({ id }) => id),
  Object.keys(expectedHoldOwners)
);
for (const hold of custody.holds) {
  assert.deepEqual(
    [hold.ownerIssue, hold.evidenceIssues],
    expectedHoldOwners[hold.id]
  );
}

process.stdout.write(
  `${JSON.stringify(
    {
      valid: true,
      custodyVersion: custody.custodyVersion,
      status: custody.status,
      keyClasses: inventoryIds,
      signerRestoreGuard: custody.signerRestoreGuard.status,
      compromiseRunbooks: custody.compromiseRunbooks.map(({ id, status }) => ({
        id,
        status,
      })),
      holdIds: custody.holds.map(({ id }) => id),
      publicLaunchAllowed: custody.publicLaunchAllowed,
    },
    null,
    2
  )}\n`
);

function keyClass(id) {
  const item = custody.keyInventory.find((candidate) => candidate.id === id);
  assert.ok(item, `missing key inventory class ${id}`);
  return item;
}

function markdownAnchors(markdown) {
  const result = new Set();
  for (const [, heading] of markdown.matchAll(/^#{1,6}\s+(.+)$/gmu)) {
    const anchor = heading
      .trim()
      .toLowerCase()
      .replaceAll(/[`_*]/gu, "")
      .replaceAll(/[^a-z0-9\s-]/gu, "")
      .trim()
      .replaceAll(/\s+/gu, "-")
      .replaceAll(/-+/gu, "-");
    if (anchor) result.add(anchor);
  }
  return result;
}

async function readJson(relativePath) {
  return JSON.parse(await readText(relativePath));
}

async function readText(relativePath) {
  return readFile(path.join(repositoryRoot, relativePath), "utf8");
}
