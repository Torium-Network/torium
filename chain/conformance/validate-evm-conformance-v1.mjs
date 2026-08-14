#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const directory = dirname(fileURLToPath(import.meta.url));
const registryPath = resolve(directory, "evm-conformance-v1.json");
const schemaPath = resolve(directory, "evm-conformance-v1.schema.json");
const registry = readJSON(registryPath);
const schema = readJSON(schemaPath);
const baselinePath = resolve(directory, registry.baseline.path);
const baseline = readJSON(baselinePath);
const immutableBaseline = readJSON(
  resolve(directory, "upstream-baseline-lock-v1.json")
);
const issue107CapabilityLock = readJSON(
  resolve(directory, "issue-107-capability-lock-v1.json")
);
const assuranceCoverage = readJSON(
  resolve(directory, "assurance-coverage-v1.json")
);
const threatModel = readJSON(resolve(directory, assuranceCoverage.source));
const canonicalManifest = readJSON(
  resolve(directory, "../genesis/localnet/manifest.json")
);
const rpcProfile = readJSON(
  resolve(directory, "../config/rpc-profile-v1.json")
);

const expectedStates = ["supported", "partial", "stub", "unsupported"];
const expectedMaturity = ["unsupported", "stub", "partial", "supported"];
const validLanes = new Set([
  "required-live",
  "required-static",
  "preserved-downstream",
  "scope-exclusion",
]);
const validSDKBehaviors = new Set([
  "standard",
  "capability-detect",
  "reject",
  "not-applicable",
]);

assert.equal(registry.schemaVersion, 1, "registry schemaVersion must be 1");
assert.equal(registry.ownerIssue, 107, "registry owner must remain issue #107");
assert.equal(
  registry.status,
  "local-development-contract",
  "registry status must remain local development only"
);
assert.equal(baseline.schemaVersion, registry.baseline.schemaVersion);
assert.equal(
  baseline.baseline.cosmosEvmRelease,
  registry.baseline.cosmosEvmRelease,
  "Cosmos EVM release pin differs from the support matrix"
);
assert.equal(
  baseline.baseline.cosmosEvmCommit,
  registry.baseline.cosmosEvmCommit,
  "Cosmos EVM commit pin differs from the support matrix"
);
assert.deepEqual(
  baseline.allowedStates,
  expectedStates,
  "support matrix introduced an unknown capability state"
);
assert.deepEqual(
  registry.baseline.allowedStates,
  baseline.allowedStates,
  "registry allowed states differ from the support matrix"
);
assert.deepEqual(
  schema.$defs.state.enum,
  baseline.allowedStates,
  "JSON Schema state enum differs from the support matrix"
);
assert.deepEqual(
  registry.statePolicy.maturityOrder,
  expectedMaturity,
  "state maturity order changed without a registry version change"
);
assert.equal(immutableBaseline.schemaVersion, 1);
assert.equal(immutableBaseline.sourceIssue, 89);
assert.equal(
  immutableBaseline.sourceCommit,
  "e6d6918e5f0315ce9307980d65a7cb6a3a31c591",
  "#89 baseline lock source commit changed"
);
assert.equal(
  immutableBaseline.sourceMatrixSha256,
  "09c0756fd7333a052d44386c517542af4cbeefc0ce4a39ea09ba271b4c671af8",
  "#89 baseline lock source digest changed"
);
assert.equal(registry.statePolicy.unknownState, "reject");
assert.equal(registry.statePolicy.regression, "reject");
assert.equal(registry.statePolicy.upgrade, "require-state-change-evidence");

const evidence = uniqueMap(registry.evidenceCatalog, "evidence");
for (const item of evidence.values()) {
  requireString(item.kind, `${item.id}.kind`);
  requireString(item.path, `${item.id}.path`);
  requireString(item.description, `${item.id}.description`);
  requireOwners(item.ownerIssues, `${item.id}.ownerIssues`);
  assert.ok(
    existsSync(resolve(directory, item.path)),
    `${item.id} evidence path does not exist: ${item.path}`
  );
  validateCanonicalProof(item.id, resolve(directory, item.path));
}
validateAssuranceCoverage(assuranceCoverage, threatModel, evidence);

const baselineCapabilities = uniqueMap(
  baseline.capabilities,
  "baseline capability"
);
const lockedCapabilities = uniqueMap(
  immutableBaseline.capabilities,
  "locked #89 capability"
);
assert.equal(
  lockedCapabilities.size,
  24,
  "#89 baseline lock must contain 24 capabilities"
);
for (const locked of lockedCapabilities.values()) {
  const current = baselineCapabilities.get(locked.id);
  assert.ok(
    current,
    `support matrix removed locked #89 capability ${locked.id}`
  );
  assert.ok(
    expectedMaturity.indexOf(current.state) >=
      expectedMaturity.indexOf(locked.state),
    `${locked.id} regressed below locked #89 state ${locked.state}`
  );
}
const capabilities = uniqueMap(registry.capabilities, "registry capability");
assert.equal(
  capabilities.size,
  baselineCapabilities.size,
  "registry must cover every support-matrix capability exactly once"
);
assert.deepEqual(
  [...capabilities.keys()].sort(),
  [...baselineCapabilities.keys()].sort(),
  "registry capability IDs differ from the support matrix"
);
assert.equal(issue107CapabilityLock.schemaVersion, 1);
assert.equal(issue107CapabilityLock.sourceIssue, 107);
assert.equal(
  issue107CapabilityLock.registryVersion,
  registry.registryVersion,
  "#107 capability lock targets a different registry version"
);
const issue107LockedCapabilities = uniqueMap(
  issue107CapabilityLock.capabilities,
  "locked #107 capability"
);
assert.equal(
  issue107LockedCapabilities.size,
  32,
  "#107 capability lock must contain 32 capabilities"
);
for (const locked of issue107LockedCapabilities.values()) {
  const matrixCapability = baselineCapabilities.get(locked.id);
  const registryCapability = capabilities.get(locked.id);
  assert.ok(
    matrixCapability,
    `support matrix removed locked #107 capability ${locked.id}`
  );
  assert.ok(
    registryCapability,
    `registry removed locked #107 capability ${locked.id}`
  );
  assert.ok(
    expectedMaturity.indexOf(matrixCapability.state) >=
      expectedMaturity.indexOf(locked.state),
    `${locked.id} support-matrix state regressed below locked #107 state ${locked.state}`
  );
  assert.ok(
    expectedMaturity.indexOf(registryCapability.targetState) >=
      expectedMaturity.indexOf(locked.state),
    `${locked.id} registry target regressed below locked #107 state ${locked.state}`
  );
}

const deviations = uniqueMap(registry.deviations, "deviation");
const skips = uniqueMap(registry.skips, "skip");
const maturity = new Map(
  registry.statePolicy.maturityOrder.map((state, index) => [state, index])
);

for (const item of capabilities.values()) {
  const source = baselineCapabilities.get(item.id);
  assert.ok(source, `unknown capability ${item.id}`);
  assert.ok(
    baseline.allowedStates.includes(item.baselineState),
    `${item.id} has unknown baseline state ${item.baselineState}`
  );
  assert.ok(
    baseline.allowedStates.includes(item.targetState),
    `${item.id} has unknown target state ${item.targetState}`
  );
  assert.equal(
    item.baselineState,
    source.state,
    `${item.id} baseline state differs from support-matrix evidence`
  );
  assert.ok(
    validLanes.has(item.lane),
    `${item.id} has unknown lane ${item.lane}`
  );
  assert.equal(
    item.constraintAcknowledged,
    typeof source.constraint === "string" && source.constraint.length > 0,
    `${item.id} constraint acknowledgement differs from the support matrix`
  );
  assert.deepEqual(
    item.downstreamIssues,
    source.consumerIssues,
    `${item.id} downstream issues differ from the support matrix`
  );
  requireString(item.downstreamImpact, `${item.id}.downstreamImpact`);
  assert.ok(
    validSDKBehaviors.has(item.sdkBehavior),
    `${item.id} has unknown SDK behavior ${item.sdkBehavior}`
  );
  requireUniqueStrings(item.deviationIds, `${item.id}.deviationIds`);
  requireUniqueStrings(item.skipIds, `${item.id}.skipIds`);
  requireEvidence(item.evidenceIds, evidence, `${item.id}.evidenceIds`);

  if (item.constraintAcknowledged) {
    assert.ok(
      item.deviationIds.length + item.skipIds.length > 0,
      `${item.id} has a source constraint without a deviation or skip`
    );
  }
  if (item.targetState !== "supported") {
    assert.ok(
      item.deviationIds.length > 0,
      `${item.id} is ${item.targetState} without an explicit deviation`
    );
    assert.notEqual(
      item.sdkBehavior,
      "standard",
      `${item.id} cannot use standard SDK behavior while ${item.targetState}`
    );
  }

  const baselineRank = maturity.get(item.baselineState);
  const targetRank = maturity.get(item.targetState);
  assert.notEqual(
    baselineRank,
    undefined,
    `${item.id} baseline rank is unknown`
  );
  assert.notEqual(targetRank, undefined, `${item.id} target rank is unknown`);
  assert.ok(
    targetRank >= baselineRank,
    `${item.id} regressed from ${item.baselineState} to ${item.targetState}`
  );
  if (item.targetState === item.baselineState) {
    assert.equal(
      item.stateChange,
      undefined,
      `${item.id} must not carry state-change evidence without a state change`
    );
  } else {
    assert.ok(
      item.stateChange,
      `${item.id} upgraded without state-change evidence`
    );
    requireString(
      item.stateChange.rationale,
      `${item.id}.stateChange.rationale`
    );
    requireOwners(
      item.stateChange.ownerIssues,
      `${item.id}.stateChange.ownerIssues`
    );
    requireEvidence(
      item.stateChange.evidenceIds,
      evidence,
      `${item.id}.stateChange.evidenceIds`
    );
  }

  for (const deviationId of item.deviationIds) {
    const deviation = deviations.get(deviationId);
    assert.ok(
      deviation,
      `${item.id} references missing deviation ${deviationId}`
    );
    assert.ok(
      deviation.capabilityIds.includes(item.id),
      `${deviationId} does not link back to ${item.id}`
    );
  }
  for (const skipId of item.skipIds) {
    const skip = skips.get(skipId);
    assert.ok(skip, `${item.id} references missing skip ${skipId}`);
    assert.ok(
      skip.capabilityIds.includes(item.id),
      `${skipId} does not link back to ${item.id}`
    );
  }
}

for (const item of deviations.values()) {
  assert.match(item.id, /^DEV-[0-9]{3}$/u, `invalid deviation ID ${item.id}`);
  validateException(item, capabilities, evidence, "deviation");
  requireString(item.summary, `${item.id}.summary`);
  requireString(item.sdkRule, `${item.id}.sdkRule`);
  for (const capabilityId of item.capabilityIds) {
    assert.ok(
      capabilities.get(capabilityId).deviationIds.includes(item.id),
      `${item.id} is not referenced by ${capabilityId}`
    );
  }
}

for (const item of skips.values()) {
  assert.match(item.id, /^SKIP-[0-9]{3}$/u, `invalid skip ID ${item.id}`);
  validateException(item, capabilities, evidence, "skip");
  requireString(item.scope, `${item.id}.scope`);
  requireString(item.exitCriteria, `${item.id}.exitCriteria`);
  for (const capabilityId of item.capabilityIds) {
    assert.ok(
      capabilities.get(capabilityId).skipIds.includes(item.id),
      `${item.id} is not referenced by ${capabilityId}`
    );
  }
}

assert.equal(
  registry.sdkContract.maskingForbidden,
  true,
  "SDK compatibility masking must remain forbidden"
);
assert.equal(registry.sdkContract.unknownCapabilityBehavior, "reject");
assert.equal(
  registry.sdkContract.nonSupportedStateBehavior,
  "surface-capability-or-reject-operation"
);
assert.equal(registry.sdkContract.evidenceRequiredForStateChange, true);
assert.deepEqual(registry.sdkContract.consumerIssues, [131, 132]);

process.stdout.write(
  `Torium EVM conformance registry valid: ${capabilities.size} capabilities, ` +
    `${deviations.size} deviations, ${skips.size} skips, ${evidence.size} evidence records.\n`
);

function readJSON(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function validateCanonicalProof(id, path) {
  if (!id.startsWith("EVD-TORIUM-")) return;
  const proof = readJSON(path);
  switch (id) {
    case "EVD-TORIUM-TOOLING":
      assert.equal(proof.result, "passed", `${id} result is not passed`);
      assert.equal(
        proof.network.evmChainId,
        canonicalManifest.evm_chain_id,
        `${id} chain ID differs from the canonical manifest`
      );
      assert.equal(proof.checks.erc20.exactEstimateStatus, "reverted");
      assert.equal(proof.checks.erc20.explicitGasHeadroomApplied, true);
      assert.ok(proof.checks.erc20.transferLogs > 0);
      assert.ok(proof.checks.erc721.mintLogs > 0);
      break;
    case "EVD-TORIUM-STATE-SUBSET": {
      const stateManifestPath = resolve(
        directory,
        "../tests/state-conformance/manifest.json"
      );
      const skipRegistryPath = resolve(
        directory,
        "../tests/state-conformance/skips.json"
      );
      assert.equal(proof.status, "pass", `${id} status is not pass`);
      assert.equal(proof.subtestsSelected, 64);
      assert.equal(proof.subtestsRun, proof.subtestsSelected);
      assert.equal(proof.subtestsSkipped, 0);
      assert.equal(
        proof.manifestSha256,
        sha256File(stateManifestPath),
        `${id} manifest digest is stale`
      );
      assert.equal(
        proof.skipRegistrySha256,
        sha256File(skipRegistryPath),
        `${id} skip-registry digest is stale`
      );
      break;
    }
    case "EVD-TORIUM-RPC":
      assert.equal(proof.result, "passed", `${id} result is not passed`);
      assert.equal(proof.chainId, canonicalManifest.evm_chain_id);
      assert.equal(proof.ratifiedProfileVersion, rpcProfile.profileVersion);
      assert.deepEqual(
        proof.webSocket.subscriptions,
        rpcProfile.ethereum.webSocket.subscriptions
      );
      assert.equal(proof.historicalState.explicitHistoricalCallPreserved, true);
      break;
    case "EVD-TORIUM-FEES":
      assert.equal(proof.result, "passed", `${id} result is not passed`);
      assert.equal(proof.network.evmChainId, canonicalManifest.evm_chain_id);
      assert.equal(proof.checks.replayProtection.wrongChainRejected, true);
      assert.equal(proof.checks.replayProtection.unprotectedRejected, true);
      assert.equal(
        proof.checks.replayProtection.canonicalNonceAfterRejections,
        "3"
      );
      assert.deepEqual(proof.checks.transactionEnvelopes.receiptTypes, [
        "0x0",
        "0x1",
        "0x2",
      ]);
      assert.equal(proof.checks.unsupportedEnvelopes.blobType, 3);
      assert.equal(
        proof.checks.unsupportedEnvelopes.blobRetainedOrProposed,
        false
      );
      assert.equal(proof.checks.unsupportedEnvelopes.setCodeType, 4);
      assert.equal(
        proof.checks.unsupportedEnvelopes.setCodeRetainedOrProposed,
        false
      );
      assert.equal(proof.checks.feeHistory.blocksReturnedAtCap, 100);
      assert.equal(proof.checks.feeHistory.requestAboveCapRejected, true);
      break;
    default:
      throw new Error(`canonical proof ${id} has no semantic validator`);
  }
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function validateAssuranceCoverage(coverage, model, evidence) {
  assert.equal(coverage.schemaVersion, 1);
  assert.equal(coverage.ownerIssue, 107);
  assert.equal(coverage.source, "../security/threat-model-v1.json");
  const risks = uniqueMap(model.risks, "threat-model risk");
  const invariants = uniqueMap(model.invariants, "threat-model invariant");
  const bindings = uniqueMap(
    coverage.bindings.map((binding) => ({ ...binding, id: binding.riskId })),
    "assurance binding"
  );
  assert.deepEqual(
    [...bindings.keys()].sort(),
    ["T003", "T013", "T015", "T021"],
    "#107 threat-model risk bindings changed"
  );
  const expectedInvariants = new Set(["INV001", "INV012", "INV014", "INV020"]);
  for (const binding of bindings.values()) {
    const risk = risks.get(binding.riskId);
    const invariant = invariants.get(binding.invariantId);
    assert.ok(risk, `unknown assurance risk ${binding.riskId}`);
    assert.ok(invariant, `unknown assurance invariant ${binding.invariantId}`);
    assert.ok(
      expectedInvariants.delete(binding.invariantId),
      `duplicate or unexpected assurance invariant ${binding.invariantId}`
    );
    assert.ok(
      invariant.riskIds.includes(binding.riskId),
      `${binding.invariantId} does not cover ${binding.riskId}`
    );
    assert.equal(
      binding.status,
      "partial",
      `${binding.riskId} must not be claimed complete by #107`
    );
    requireEvidence(
      binding.evidenceIds,
      evidence,
      `${binding.riskId}.evidenceIds`
    );
    requireString(binding.coveredHere, `${binding.riskId}.coveredHere`);
    requireString(binding.remaining, `${binding.riskId}.remaining`);
    requireOwners(
      binding.remainingOwnerIssues,
      `${binding.riskId}.remainingOwnerIssues`
    );
  }
  assert.equal(
    expectedInvariants.size,
    0,
    "#107 assurance invariant binding is missing"
  );

  const gate = model.releaseGates.find(
    ({ id }) => id === coverage.releaseGate.id
  );
  assert.ok(gate, `unknown release gate ${coverage.releaseGate.id}`);
  assert.equal(coverage.releaseGate.id, "G03");
  assert.equal(coverage.releaseGate.status, "partial");
  assert.equal(coverage.releaseGate.blocksPublicRelease, true);
  assert.equal(
    coverage.releaseGate.blocksPublicRelease,
    gate.blocksPublicRelease
  );
  requireString(coverage.releaseGate.coveredHere, "G03.coveredHere");
  requireString(coverage.releaseGate.remaining, "G03.remaining");
  requireOwners(
    coverage.releaseGate.remainingOwnerIssues,
    "G03.remainingOwnerIssues"
  );
}

function uniqueMap(items, label) {
  assert.ok(Array.isArray(items), `${label} collection must be an array`);
  const result = new Map();
  for (const item of items) {
    requireString(item?.id, `${label}.id`);
    assert.ok(!result.has(item.id), `duplicate ${label} ID ${item.id}`);
    result.set(item.id, item);
  }
  return result;
}

function requireString(value, label) {
  assert.equal(typeof value, "string", `${label} must be a string`);
  assert.ok(value.trim().length > 0, `${label} must not be empty`);
}

function requireOwners(value, label) {
  assert.ok(
    Array.isArray(value) && value.length > 0,
    `${label} must not be empty`
  );
  assert.equal(new Set(value).size, value.length, `${label} must be unique`);
  for (const issue of value) {
    assert.ok(
      Number.isInteger(issue) && issue > 0,
      `${label} contains invalid issue`
    );
  }
}

function requireUniqueStrings(value, label) {
  assert.ok(Array.isArray(value), `${label} must be an array`);
  assert.equal(new Set(value).size, value.length, `${label} must be unique`);
  for (const item of value) requireString(item, label);
}

function requireEvidence(value, catalog, label) {
  requireUniqueStrings(value, label);
  assert.ok(value.length > 0, `${label} must not be empty`);
  for (const id of value) {
    assert.ok(catalog.has(id), `${label} references missing evidence ${id}`);
  }
}

function validateException(item, capabilityMap, evidenceMap, kind) {
  requireUniqueStrings(item.capabilityIds, `${item.id}.capabilityIds`);
  assert.ok(
    item.capabilityIds.length > 0,
    `${item.id} must cover a capability`
  );
  for (const capabilityId of item.capabilityIds) {
    assert.ok(
      capabilityMap.has(capabilityId),
      `${item.id} references unknown capability ${capabilityId}`
    );
  }
  requireString(item.rationale, `${item.id}.rationale`);
  requireString(item.risk, `${item.id}.risk`);
  requireOwners(item.ownerIssues, `${item.id}.ownerIssues`);
  requireEvidence(item.evidenceIds, evidenceMap, `${item.id}.evidenceIds`);
  requireUniqueStrings(
    item.documentationPaths,
    `${item.id}.documentationPaths`
  );
  assert.ok(
    item.documentationPaths.length > 0,
    `${item.id}.documentationPaths must not be empty`
  );
  for (const path of item.documentationPaths) {
    assert.ok(
      existsSync(resolve(directory, path)),
      `${item.id} documentation path does not exist: ${path}`
    );
  }
  assert.ok(
    item.downstreamImpact && typeof item.downstreamImpact === "object",
    `${item.id}.downstreamImpact must be an object`
  );
  const impacts = Object.entries(item.downstreamImpact);
  assert.ok(
    impacts.length > 0,
    `${item.id}.downstreamImpact must not be empty`
  );
  for (const [surface, impact] of impacts) {
    assert.ok(
      ["sdk", "wallet", "explorer", "operator", "protocol"].includes(surface),
      `${item.id} has unknown downstream ${surface}`
    );
    requireString(impact, `${item.id}.downstreamImpact.${surface}`);
  }
  assert.ok(
    kind === "deviation" || kind === "skip",
    `${item.id} has unknown exception kind ${kind}`
  );
}
