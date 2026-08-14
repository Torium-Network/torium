#!/usr/bin/env node

import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const directory = dirname(fileURLToPath(import.meta.url));
const threat = JSON.parse(
  await readFile(join(directory, "threat-model-v1.json"), "utf8")
);
const secret = JSON.parse(
  await readFile(join(directory, "secret-policy.json"), "utf8")
);
const protocol = JSON.parse(
  await readFile(join(directory, "../config/protocol-v1.json"), "utf8")
);
const trust = JSON.parse(
  await readFile(join(directory, "../config/trust-model-v1.json"), "utf8")
);
const governance = JSON.parse(
  await readFile(join(directory, "../config/governance-v1.json"), "utf8")
);
const supportMatrix = JSON.parse(
  await readFile(
    join(directory, "../poc/upstream-baseline/support-matrix.json"),
    "utf8"
  )
);

function uniqueIds(collection, pattern, label) {
  const ids = collection.map(({ id }) => id);
  assert.equal(new Set(ids).size, ids.length, `${label} IDs must be unique`);
  for (const id of ids) assert.match(id, pattern, `invalid ${label} ID ${id}`);
  return new Set(ids);
}

function severityFor(score) {
  for (const severity of ["critical", "high", "medium", "low"]) {
    const threshold = threat.methodology.severityThresholds[severity];
    if (score >= threshold.minimum && score <= threshold.maximum)
      return severity;
  }
  throw new Error(`no severity threshold for score ${score}`);
}

assert.equal(threat.$schema, "./threat-model-v1.schema.json");
assert.equal(threat.schemaVersion, 1);
assert.match(threat.modelVersion, /^1\.0\.0-local\.[1-9][0-9]*$/u);
assert.equal(threat.status, "local-development-security-contract");
assert.equal(threat.scope.publicDeploymentAuthorized, false);
assert.ok(
  threat.scope.excluded.includes(
    "Torium product backend and mobile integration"
  )
);
assert.ok(
  threat.scope.excluded.includes(
    "bridges, IBC runtime, Ethereum L2, and rollup settlement"
  )
);

assert.equal(threat.sources.protocol.path, "../config/protocol-v1.json");
assert.equal(threat.sources.protocol.version, protocol.protocolVersion);
assert.equal(threat.sources.trustModel.path, "../config/trust-model-v1.json");
assert.equal(threat.sources.trustModel.version, trust.modelVersion);
assert.equal(governance.protocol.version, threat.sources.protocol.version);
assert.equal(governance.scope.publicActivationAllowed, false);
assert.equal(threat.sources.secretPolicy.path, "./secret-policy.json");
assert.equal(threat.sources.secretPolicy.version, secret.policyVersion);
assert.equal(
  threat.sources.secretPolicy.scanner,
  "../scripts/scan-prohibited-secrets.mjs"
);
await access(join(directory, threat.sources.secretPolicy.scanner));
assert.equal(
  threat.sources.upstreamSupport,
  "../poc/upstream-baseline/support-matrix.json"
);
assert.ok(supportMatrix.downstreamContracts.includes(90));
assert.ok(supportMatrix.extensions.some(({ issue }) => issue === 90));

assert.equal(threat.methodology.riskScore, "likelihood-times-impact");
assert.deepEqual(threat.methodology.severityThresholds, {
  critical: { minimum: 20, maximum: 25 },
  high: { minimum: 12, maximum: 19 },
  medium: { minimum: 6, maximum: 11 },
  low: { minimum: 1, maximum: 5 },
});
assert.deepEqual(Object.keys(threat.methodology.likelihoodScale), [
  "1",
  "2",
  "3",
  "4",
  "5",
]);
assert.deepEqual(Object.keys(threat.methodology.impactScale), [
  "1",
  "2",
  "3",
  "4",
  "5",
]);

const assetIds = uniqueIds(threat.assets, /^A[0-9]{2}$/u, "asset");
const actorIds = uniqueIds(threat.actors, /^ACT[0-9]{2}$/u, "actor");
const boundaryIds = uniqueIds(threat.boundaries, /^B[0-9]{2}$/u, "boundary");
const riskIds = uniqueIds(threat.risks, /^T[0-9]{3}$/u, "risk");
const invariantIds = uniqueIds(
  threat.invariants,
  /^INV[0-9]{3}$/u,
  "invariant"
);
const gateIds = uniqueIds(threat.releaseGates, /^G[0-9]{2}$/u, "gate");
assert.ok(assetIds.size >= 10);
assert.ok(actorIds.size >= 8);
assert.ok(boundaryIds.size >= 8);
assert.ok(riskIds.size >= 20);
assert.ok(invariantIds.size >= 15);
assert.ok(gateIds.size >= 8);

for (const asset of threat.assets) {
  assert.ok(asset.name.length > 10);
  assert.ok(asset.properties.length >= 3);
}
for (const actor of threat.actors) {
  assert.ok(actor.name.length > 5);
  assert.ok(actor.trust.length > 15);
}
for (const boundary of threat.boundaries) {
  assert.ok(boundary.name.length > 8);
  assert.ok(boundary.controls.length >= 3);
  assert.ok(boundary.ownerIssues.length > 0);
  assert.ok(boundary.ownerIssues.every(Number.isInteger));
}

const requiredCategories = new Set([
  "keys-consensus",
  "consensus",
  "state-transition",
  "genesis-economics",
  "governance-upgrades",
  "supply-chain",
  "secrets",
  "recovery-state",
  "replay-identifiers",
  "rpc-dos",
  "p2p-network",
  "faucet",
  "transactions-mempool",
  "indexing",
  "contracts-precompiles",
  "contract-metadata",
  "fees-resources",
  "economic-precision",
  "key-recovery",
  "infrastructure",
  "dependencies",
  "client-rpc",
  "observability-privacy",
  "ci-governance",
  "application-contracts",
]);
assert.deepEqual(
  new Set(threat.risks.map(({ category }) => category)),
  requiredCategories
);

const criticalRisks = [];
const highRisks = [];
for (const risk of threat.risks) {
  assert.ok(risk.assetIds.length > 0);
  assert.ok(risk.actorIds.length > 0);
  assert.ok(risk.boundaryIds.length > 0);
  for (const id of risk.assetIds) assert.ok(assetIds.has(id));
  for (const id of risk.actorIds) assert.ok(actorIds.has(id));
  for (const id of risk.boundaryIds) assert.ok(boundaryIds.has(id));
  assert.ok(risk.likelihood >= 1 && risk.likelihood <= 5);
  assert.ok(risk.impact >= 1 && risk.impact <= 5);
  const score = risk.likelihood * risk.impact;
  assert.equal(risk.severity, severityFor(score), `${risk.id} severity drift`);
  assert.ok(["high", "critical"].includes(risk.severity));
  if (risk.severity === "critical") criticalRisks.push(risk.id);
  if (risk.severity === "high") highRisks.push(risk.id);
  assert.equal(risk.releaseGate, true);
  assert.ok(risk.scenario.length > 30);
  assert.ok(risk.prevention.length >= 3);
  assert.ok(risk.detection.length >= 2);
  assert.ok(risk.recovery.length >= 3);
  assert.ok(risk.ownerIssues.length > 0);
  assert.ok(risk.ownerIssues.every(Number.isInteger));
  assert.ok(risk.mitigationStatus.length > 10);
  assert.ok(risk.residualRisk.length > 30);
  assert.ok(risk.reviewTriggers.length >= 3);
}
assert.deepEqual(criticalRisks, [
  "T001",
  "T003",
  "T005",
  "T006",
  "T015",
  "T021",
]);
assert.equal(highRisks.length, 19);

const allowedTestTypes = new Set(["fuzz", "integration", "chaos", "runbook"]);
const usedTestTypes = new Set();
const coveredRisks = new Set();
const allTestIds = new Set();
for (const invariant of threat.invariants) {
  assert.ok(invariant.statement.length > 40);
  assert.ok(invariant.riskIds.length > 0);
  assert.ok(invariant.testTypes.length > 0);
  assert.ok(invariant.testIds.length > 0);
  assert.ok(invariant.ownerIssues.length > 0);
  for (const riskId of invariant.riskIds) {
    assert.ok(riskIds.has(riskId));
    coveredRisks.add(riskId);
  }
  for (const testType of invariant.testTypes) {
    assert.ok(allowedTestTypes.has(testType));
    usedTestTypes.add(testType);
  }
  const declaredTestTypes = new Set(invariant.testTypes);
  const referencedTestTypes = new Set(
    invariant.testIds.map((testId) => testId.split(".")[0])
  );
  assert.deepEqual(
    referencedTestTypes,
    declaredTestTypes,
    `${invariant.id} testTypes must exactly match its test ID prefixes`
  );
  for (const testId of invariant.testIds) {
    assert.match(testId, /^(?:integration|fuzz|chaos|runbook)\.[a-z0-9.-]+$/u);
    assert.ok(!allTestIds.has(testId), `duplicate test ID ${testId}`);
    allTestIds.add(testId);
  }
  assert.ok(invariant.ownerIssues.every(Number.isInteger));
}
assert.deepEqual(coveredRisks, riskIds);
assert.deepEqual(usedTestTypes, allowedTestTypes);
for (const fault of trust.faultScenarios) {
  assert.ok(
    allTestIds.has(fault.testId),
    `trust fault scenario ${fault.testId} is not mapped to a threat invariant`
  );
}

for (const gate of threat.releaseGates) {
  assert.equal(gate.blocksPublicRelease, true);
  assert.ok(gate.rule.length > 40);
  assert.ok(gate.ownerIssues.length > 0);
  assert.ok(gate.ownerIssues.every(Number.isInteger));
}
assert.deepEqual(
  threat.releaseGates.find(({ id }) => id === "G10").ownerIssues,
  [127]
);
assert.equal(threat.riskAcceptance.automaticAcceptanceAllowed, false);
assert.equal(threat.riskAcceptance.acceptanceAuthorityOwnerIssue, 126);
assert.match(threat.riskAcceptance.localDevelopmentRule, /valueless/u);
assert.match(threat.riskAcceptance.publicRule, /public-release blockers/u);
assert.ok(threat.reviewTriggers.length >= 5);

assert.equal(secret.$schema, "./secret-policy.schema.json");
assert.equal(secret.schemaVersion, 1);
assert.equal(secret.policyVersion, "1.0.0");
assert.equal(secret.status, "active-local-chain-guard");
assert.deepEqual(secret.requiredSurfaces, [
  "tracked-source",
  "logs",
  "binary-images-and-metadata",
  "support-bundle-staging",
  "fixtures",
  "examples",
]);
assert.equal(secret.limits.oversizedFileBehavior, "fail-closed");
assert.equal(secret.limits.symlinkBehavior, "fail-closed");
assert.match(secret.limits.archiveBehavior, /scan-extracted-staging/u);
assert.equal(secret.findingOutput.includeMatchedValue, false);
assert.equal(secret.owners.policy, 90);
assert.equal(secret.owners.ciEnforcement, 121);
assert.equal(secret.owners.supportBundles, 120);
assert.equal(secret.owners.releaseGate, 126);
assert.ok(secret.rules.length >= 10);
assert.equal(
  new Set(secret.rules.map(({ id }) => id)).size,
  secret.rules.length
);
for (const rule of secret.rules) {
  assert.ok(["high", "critical"].includes(rule.severity));
  assert.doesNotThrow(() => new RegExp(rule.pattern, rule.flags));
  assert.ok(rule.flags.includes("g"));
  assert.ok(Number.isInteger(rule.captureGroup));
}
assert.ok(secret.scope.trackedRoots.includes("chain"));
assert.ok(secret.scope.trackedRoots.includes("contracts"));
assert.ok(secret.scope.trackedRoots.includes("packages/torium-sdk"));
assert.ok(secret.scope.trackedRoots.includes("apps/developer-docs"));
assert.ok(secret.scope.trackedRoots.includes("examples/torium"));
assert.deepEqual(secret.scope.outOfScopeLegacyProductPaths, []);
assert.deepEqual(secret.ignoredDirectoryNamesForExplicitPathMode, []);

process.stdout.write(
  `${JSON.stringify(
    {
      valid: true,
      modelVersion: threat.modelVersion,
      assets: threat.assets.length,
      actors: threat.actors.length,
      boundaries: threat.boundaries.length,
      risks: {
        total: threat.risks.length,
        critical: criticalRisks.length,
        high: highRisks.length,
      },
      invariants: threat.invariants.length,
      mappedTests: allTestIds.size,
      trustFaultScenariosMapped: trust.faultScenarios.length,
      publicReleaseGates: threat.releaseGates.length,
      secretRules: secret.rules.length,
      publicDeploymentAuthorized: false,
    },
    null,
    2
  )}\n`
);
