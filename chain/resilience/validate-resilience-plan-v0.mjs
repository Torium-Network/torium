#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, readFile, readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const directory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(directory, "../..");
const rootRequire = createRequire(path.join(repositoryRoot, "package.json"));
const Ajv2020 = rootRequire("ajv/dist/2020").default;

const [
  plan,
  planSchema,
  resultSchema,
  identifiers,
  protocol,
  trustModel,
  recovery,
  observability,
  keyCustody,
  explorerStack,
  governance,
] = await Promise.all([
  readJson("chain/resilience/resilience-plan-v0.json"),
  readJson("chain/resilience/resilience-plan-v0.schema.json"),
  readJson("chain/resilience/resilience-result-v0.schema.json"),
  readJson("chain/config/identifiers.json"),
  readJson("chain/config/protocol-v1.json"),
  readJson("chain/config/trust-model-v1.json"),
  readJson("chain/recovery/recovery-v0.json"),
  readJson("chain/observability/observability-v0.json"),
  readJson("chain/security/key-custody-v0.json"),
  readJson("chain/explorer/stack-v0.json"),
  readJson("chain/config/governance-v1.json"),
]);

const ajv = new Ajv2020({
  strict: true,
  allErrors: true,
  formats: { "date-time": { type: "string", validate: isCanonicalDateTime } },
});
assertValid(ajv.compile(planSchema), plan, "resilience plan");
const validateResult = ajv.compile(resultSchema);

assert.deepEqual(plan.sources, {
  identifiers: {
    path: "chain/config/identifiers.json",
    version: identifiers.manifestVersion,
  },
  protocol: {
    path: "chain/config/protocol-v1.json",
    version: protocol.protocolVersion,
  },
  trustModel: {
    path: "chain/config/trust-model-v1.json",
    version: trustModel.modelVersion,
  },
  recovery: {
    path: "chain/recovery/recovery-v0.json",
    version: recovery.recoveryVersion,
  },
  observability: {
    path: "chain/observability/observability-v0.json",
    version: observability.observabilityVersion,
  },
  keyCustody: {
    path: "chain/security/key-custody-v0.json",
    version: keyCustody.custodyVersion,
  },
  explorerStack: {
    path: "chain/explorer/stack-v0.json",
    version: explorerStack.stackVersion,
  },
  governance: {
    path: "chain/config/governance-v1.json",
    version: governance.contractVersion,
  },
});

const localnet = identifiers.networks.find(
  ({ environment }) => environment === "localnet"
);
assert.ok(localnet);
assert.equal(localnet.public, false);
assert.equal(localnet.cosmos.chainId, "torium-localnet-1");
assert.equal(localnet.evm.chainId, 1414484556);
assert.equal(
  plan.finalityContract.commitMeaning,
  trustModel.finalityContract.commitMeaning
);
assert.equal(
  plan.finalityContract.sameHeightConflictingCommitExpectedUnderAssumptions,
  trustModel.finalityContract
    .sameHeightConflictingCommitExpectedUnderAssumptions
);
assert.equal(
  plan.finalityContract.ethereumBeaconFinalityClaimAllowed,
  trustModel.finalityContract.ethereumBeaconFinalityClaimAllowed
);
assert.equal(
  protocol.consensus.finality.ethereumBeaconFinalityEquivalent,
  false
);

const executedScenarios = plan.canonicalScenarios.filter(({ executed }) => executed);

// Committed reports are the only source for pass/unsafe accounting; the plan
// may never assert an outcome its reports do not carry.
const committedReports = new Map();
for (const scenario of executedScenarios) {
  const reportPath = path.join(
    repositoryRoot,
    `chain/resilience/results/${scenario.id}.result.json`
  );
  committedReports.set(
    scenario.id,
    JSON.parse(await readFile(reportPath, "utf8"))
  );
}
const passedReports = [...committedReports.values()].filter(
  ({ status }) => status === "pass"
);
// An unsafe outcome is "unresolved" unless its own report documents the
// out-of-envelope experiment that produced it (byzantinePower above the
// trust-model tolerance) and keeps release readiness blocked.
const byzantineToleranceExclusivePercent = Math.floor(100 / 3);
const unresolvedUnsafeReports = [...committedReports.entries()].filter(
  ([scenarioId, report]) => {
    if (report.status !== "unsafe") return false;
    const scenario = plan.canonicalScenarios.find(({ id }) => id === scenarioId);
    const outsideEnvelope =
      scenario.byzantinePower > byzantineToleranceExclusivePercent;
    return !(outsideEnvelope && report.releaseBlocked === true);
  }
);

assert.equal(plan.canonicalScenarios.length, trustModel.faultScenarios.length);
assert.equal(plan.canonicalScenarios.length, 11);
assertUnique(
  plan.canonicalScenarios.map(({ id }) => id),
  "canonical scenario IDs"
);
assertUnique(
  plan.canonicalScenarios.map(({ testId }) => testId),
  "canonical test IDs"
);
for (const sourceScenario of trustModel.faultScenarios) {
  const scenario = plan.canonicalScenarios.find(
    ({ id }) => id === sourceScenario.id
  );
  assert.ok(scenario, `missing trust-model scenario ${sourceScenario.id}`);
  assert.deepEqual(
    {
      id: scenario.id,
      testId: scenario.testId,
      availablePower: scenario.availablePower,
      byzantinePower: scenario.byzantinePower,
      expectedLiveness: scenario.expectedLiveness,
      expectedSafety: scenario.expectedSafety,
    },
    {
      id: sourceScenario.id,
      testId: sourceScenario.testId,
      availablePower: sourceScenario.availablePower,
      byzantinePower: sourceScenario.byzantinePower,
      expectedLiveness: sourceScenario.expectedLiveness,
      expectedSafety: sourceScenario.expectedSafety,
    }
  );
  assert.deepEqual(
    {
      expectedFinality: scenario.expectedFinality,
      expectedRecovery: scenario.expectedRecovery,
    },
    expectedExtensionsFor(sourceScenario.id)
  );
  // Executed scenarios must point at a committed report; unexecuted ones
  // must stay explicitly held with no report.
  if (scenario.executed) {
    assert.match(scenario.executionStatus, /^executed-/u);
    assert.equal(
      scenario.reportPath,
      `chain/resilience/results/${scenario.id}.result.json`,
      `${scenario.id} must reference its committed report`
    );
    await access(path.join(repositoryRoot, scenario.reportPath));
  } else {
    assert.match(scenario.executionStatus, /^HOLD-/u);
    assert.equal(scenario.reportPath, null);
  }
  for (const evidencePath of scenario.existingEvidence.paths) {
    await access(path.join(repositoryRoot, evidencePath));
  }
  if (scenario.existingEvidence.level === "none") {
    assert.deepEqual(scenario.existingEvidence.paths, []);
  } else {
    assert.equal(scenario.existingEvidence.paths.length > 0, true);
  }
}

assertUnique(
  plan.extensionScenarios.map(({ id }) => id),
  "extension scenario IDs"
);
assert.deepEqual(
  new Set(plan.extensionScenarios.map(({ id }) => id)),
  new Set([
    "local-disk-full",
    "local-database-corruption",
    "local-rpc-capacity-exceeded",
    "local-snapshot-restore",
    "local-upgrade-interruption",
    "local-restart-ordering",
    "local-catch-up",
    "local-explorer-outage",
    "local-indexer-outage",
    "local-metrics-outage",
    "local-validator-crash-restart",
    "local-state-sync",
  ])
);
assert.equal(
  plan.extensionScenarios.every(
    ({ status }) => status === "HOLD-not-executed-v0"
  ),
  true
);
// Passing reports are accepted only while a scenario runner exists; the
// remaining gates stay fail-closed.
assert.equal(
  plan.reportContract.passingReportsAccepted,
  executedScenarios.length > 0,
  "passing reports are accepted only once a scenario runner has executed scenarios"
);
if (plan.reportContract.passingReportsAccepted) {
  await access(path.join(repositoryRoot, "chain/resilience/run-scenario-v0.mjs"));
}
assert.deepEqual(
  {
    extensionReportsAccepted: plan.reportContract.extensionReportsAccepted,
    contradictoryCommitForcesUnsafeReleaseBlocked:
      plan.reportContract.contradictoryCommitForcesUnsafeReleaseBlocked,
    manualStateEditFailsValidation:
      plan.reportContract.manualStateEditFailsValidation,
  },
  {
    extensionReportsAccepted: false,
    contradictoryCommitForcesUnsafeReleaseBlocked: true,
    manualStateEditFailsValidation: true,
  }
);

assert.equal(recovery.publicLaunchAllowed, false);
assert.equal(recovery.stateSync.enabled, false);
assert.equal(recovery.recoveryObjectives.rtoSeconds, null);
assert.equal(
  observability.constraints.collectorOrDashboardRuntimeConfigIncluded,
  false
);
assert.equal(observability.constraints.numericCapacityOrSloClaimAllowed, false);
assert.ok(
  ["inactive-local-only-hold", "activated-local-only-hold"].includes(
    explorerStack.status
  ),
  "the explorer stack must stay local-only"
);
assert.equal(keyCustody.publicLaunchAllowed, false);
// Release readiness is derived from the committed reports and the remaining
// holds, never asserted by hand.
assert.equal(plan.releaseReadiness.requiredCanonicalScenarioCount, 11);
assert.equal(
  plan.releaseReadiness.executedCanonicalScenarioCount,
  executedScenarios.length,
  "executed count must match the scenarios marked executed"
);
assert.equal(
  plan.releaseReadiness.passedCanonicalScenarioCount,
  passedReports.length,
  "passed count must match the committed reports that actually passed"
);
assert.equal(
  plan.releaseReadiness.unresolvedUnsafeOutcomeCount,
  executedScenarios.length === 0 ? null : unresolvedUnsafeReports.length,
  "any unsafe outcome must be recorded before the plan can claim zero"
);
// Canonical coverage alone cannot make the plan ready: the extension
// scenarios are all still held, and the explorer/observability dependency
// recovery holds are owned elsewhere. Readiness therefore stays HOLD, and the
// reason has to be the strongest remaining blocker rather than a stale string.
const canonicalCoverageComplete =
  plan.releaseReadiness.executedCanonicalScenarioCount ===
  plan.releaseReadiness.requiredCanonicalScenarioCount;
const extensionCoverageComplete = plan.extensionScenarios.every(
  ({ status }) => !status.startsWith("HOLD-")
);
assert.equal(
  plan.releaseReadiness.ready,
  false,
  "release readiness stays HOLD while any blocker remains"
);
assert.equal(
  canonicalCoverageComplete && extensionCoverageComplete,
  false,
  "with canonical and extension coverage both complete the release gate must be re-reviewed by hand"
);
if (unresolvedUnsafeReports.length > 0) {
  assert.match(
    plan.releaseReadiness.status,
    /^HOLD-unresolved-unsafe/u,
    "an unresolved unsafe outcome must be the stated readiness blocker"
  );
} else if (!canonicalCoverageComplete) {
  assert.match(
    plan.releaseReadiness.status,
    /^HOLD-.*canonical/u,
    "while canonical scenarios remain unexecuted the status must say so"
  );
} else {
  assert.match(
    plan.releaseReadiness.status,
    /^HOLD-extension/u,
    "with canonical coverage complete the extension scenarios are the blocker"
  );
}

const zeroHash = "0".repeat(64);
const firstScenario = plan.canonicalScenarios[0];
const syntheticHold = {
  schemaVersion: 1,
  resultVersion: "0.1.0",
  status: "HOLD-not-executed",
  ownerIssue: 119,
  planVersion: plan.planVersion,
  scenarioId: firstScenario.id,
  testId: firstScenario.testId,
  executed: false,
  provenance: {
    gitCommit: "0".repeat(40),
    dirtyWorktree: true,
    patchSha256: zeroHash,
    toolchainSha256: zeroHash,
    binaryIdentity: "synthetic-not-executed",
    binarySha256: zeroHash,
    genesisSha256: zeroHash,
    effectiveConfigSha256: zeroHash,
    hostIdentity: "synthetic-not-executed",
    runnerIdentity: "not-implemented",
    seed: 0,
  },
  run: {
    startedAt: null,
    endedAt: null,
    cosmosChainId: "torium-localnet-1",
    evmChainId: 1414484556,
    startHeight: null,
    endHeight: null,
    baselineBlockHash: null,
    baselineAppHash: null,
  },
  timeline: [],
  observations: { nodes: [], committedStates: [] },
  assertions: {
    liveness: {
      expected: firstScenario.expectedLiveness,
      observed: null,
      passed: null,
    },
    safety: {
      expected: firstScenario.expectedSafety,
      observed: null,
      passed: null,
    },
    finality: {
      expected: firstScenario.expectedFinality,
      observed: null,
      passed: null,
    },
    recovery: {
      expected: firstScenario.expectedRecovery,
      observed: null,
      passed: null,
    },
  },
  recovery: {
    manualStateEdits: false,
    startedAt: null,
    completedAt: null,
    durationMilliseconds: null,
    canonicalHeight: null,
    canonicalAppHash: null,
  },
  contradictoryCommitAudit: {
    overlappingHeightsChecked: 0,
    contradictionObserved: null,
    contradictoryHeights: [],
    evidenceComplete: false,
  },
  operatorDecisions: [],
  artifacts: [],
  releaseBlocked: true,
  limitations: ["synthetic schema validation only; scenario was not executed"],
};
assertValid(validateResult, syntheticHold, "synthetic HOLD result");
assertResultSemantics(syntheticHold);

const invokedDirectly =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  for (const argument of process.argv.slice(2)) {
    if (argument === "--committed-results") {
      for (const resultPath of await committedResultPaths())
        await validateExternalResult(resultPath);
    } else if (argument.startsWith("--")) {
      throw new Error(`unsupported option ${argument}`);
    } else {
      await validateExternalResult(path.resolve(argument));
    }
  }
  console.log("resilience plan v0 contract validated");
}

async function readJson(relativePath) {
  return JSON.parse(
    await readFile(path.join(repositoryRoot, relativePath), "utf8")
  );
}

function assertValid(validate, value, label) {
  assert.equal(
    validate(value),
    true,
    `${label} validation failed: ${JSON.stringify(validate.errors)}`
  );
}

export function assertResultSemantics(result) {
  assert.equal(result.planVersion, plan.planVersion);
  const scenario = plan.canonicalScenarios.find(
    ({ id }) => id === result.scenarioId
  );
  assert.ok(scenario, "result scenario must exist in the canonical plan");
  assert.equal(result.testId, scenario.testId);
  if (result.status === "pass") {
    assert.equal(
      plan.reportContract.passingReportsAccepted,
      true,
      "passing reports stay disabled until a scenario-specific runner and coverage contract are implemented"
    );
  }
  assert.deepEqual(
    {
      liveness: result.assertions.liveness.expected,
      safety: result.assertions.safety.expected,
      finality: result.assertions.finality.expected,
      recovery: result.assertions.recovery.expected,
    },
    {
      liveness: scenario.expectedLiveness,
      safety: scenario.expectedSafety,
      finality: scenario.expectedFinality,
      recovery: scenario.expectedRecovery,
    }
  );
  assert.equal(
    result.provenance.dirtyWorktree,
    result.provenance.patchSha256 !== null
  );
  assert.equal(
    result.recovery.manualStateEdits,
    false,
    "manual state edits invalidate recovery evidence"
  );
  assertUnique(
    result.artifacts.map(({ relativePath }) => relativePath),
    "artifact paths"
  );

  if (!result.executed) {
    assert.equal(result.status, "HOLD-not-executed");
    assert.equal(result.releaseBlocked, true);
    assert.deepEqual(result.run, {
      startedAt: null,
      endedAt: null,
      cosmosChainId: "torium-localnet-1",
      evmChainId: 1414484556,
      startHeight: null,
      endHeight: null,
      baselineBlockHash: null,
      baselineAppHash: null,
    });
    assert.deepEqual(result.timeline, []);
    assert.deepEqual(result.observations, { nodes: [], committedStates: [] });
    assert.deepEqual(result.recovery, {
      manualStateEdits: false,
      startedAt: null,
      completedAt: null,
      durationMilliseconds: null,
      canonicalHeight: null,
      canonicalAppHash: null,
    });
    assert.deepEqual(result.operatorDecisions, []);
    assert.deepEqual(result.artifacts, []);
    for (const assertion_ of Object.values(result.assertions)) {
      assert.equal(assertion_.observed, null);
      assert.equal(assertion_.passed, null);
    }
    assert.deepEqual(result.contradictoryCommitAudit, {
      overlappingHeightsChecked: 0,
      contradictionObserved: null,
      contradictoryHeights: [],
      evidenceComplete: false,
    });
    return;
  }

  assert.notEqual(result.status, "HOLD-not-executed");
  assert.notEqual(result.provenance.gitCommit, "0".repeat(40));
  for (const [label, digest] of Object.entries({
    toolchainSha256: result.provenance.toolchainSha256,
    binarySha256: result.provenance.binarySha256,
    genesisSha256: result.provenance.genesisSha256,
    effectiveConfigSha256: result.provenance.effectiveConfigSha256,
  })) {
    assert.notEqual(digest, zeroHash, `${label} must not be a placeholder`);
  }
  assert.notEqual(result.provenance.binaryIdentity, "synthetic-not-executed");
  assert.notEqual(result.provenance.hostIdentity, "synthetic-not-executed");
  assert.notEqual(result.provenance.runnerIdentity, "not-implemented");
  assert.equal(isCanonicalDateTime(result.run.startedAt), true);
  assert.equal(isCanonicalDateTime(result.run.endedAt), true);
  assert.equal(
    new Date(result.run.endedAt) > new Date(result.run.startedAt),
    true
  );
  assert.equal(typeof result.run.startHeight, "number");
  assert.equal(typeof result.run.endHeight, "number");
  assert.equal(result.run.endHeight >= result.run.startHeight, true);
  assert.equal(typeof result.run.baselineBlockHash, "string");
  assert.equal(typeof result.run.baselineAppHash, "string");
  assert.equal(
    result.timeline.every(
      ({ at }, index, timeline) =>
        index === 0 ||
        new Date(at).getTime() >= new Date(timeline[index - 1].at).getTime()
    ),
    true,
    "timeline events must be chronological"
  );
  assert.equal(
    result.timeline.every(
      ({ at }) =>
        new Date(at) >= new Date(result.run.startedAt) &&
        new Date(at) <= new Date(result.run.endedAt)
    ),
    true,
    "timeline events must stay inside the run window"
  );
  let previousRequiredEventIndex = -1;
  for (const requiredEvent of plan.reportContract.requiredTimelineEvents) {
    const eventIndex = result.timeline.findIndex(
      ({ kind }, index) =>
        kind === requiredEvent && index > previousRequiredEventIndex
    );
    assert.notEqual(
      eventIndex,
      -1,
      `missing or out-of-order timeline event ${requiredEvent}`
    );
    assert.equal(typeof result.timeline[eventIndex].height, "number");
    assert.equal(
      result.timeline[eventIndex].height >= result.run.startHeight &&
        result.timeline[eventIndex].height <= result.run.endHeight,
      true,
      `timeline event ${requiredEvent} height must stay inside the run interval`
    );
    previousRequiredEventIndex = eventIndex;
  }
  assert.equal(result.observations.nodes.length, 4);
  assertUnique(
    result.observations.nodes.map(({ nodeId }) => nodeId),
    "node observation IDs"
  );
  assertUnique(
    result.observations.committedStates.map(
      ({ nodeId, height }) => `${nodeId}:${height}`
    ),
    "committed node-height observations"
  );
  const observedHeightCount = result.run.endHeight - result.run.startHeight + 1;
  assert.equal(
    observedHeightCount <= 10_000,
    true,
    "result height span exceeds the bounded local evidence contract"
  );
  assert.equal(
    result.observations.committedStates.length,
    observedHeightCount * 4,
    "commit audit must cover every validator at every committed run height"
  );
  assert.equal(
    result.observations.committedStates.every(
      ({ commitVotingPower, height }) =>
        commitVotingPower > 66 &&
        height >= result.run.startHeight &&
        height <= result.run.endHeight
    ),
    true,
    "committed states require strict quorum and an in-window height"
  );

  const commitsByHeight = new Map();
  for (const committedState of result.observations.committedStates) {
    const commits = commitsByHeight.get(committedState.height) ?? [];
    commits.push(committedState);
    commitsByHeight.set(committedState.height, commits);
  }
  const overlappingCommits = [...commitsByHeight.entries()].filter(
    ([, commits]) => new Set(commits.map(({ nodeId }) => nodeId)).size > 1
  );
  assert.deepEqual(
    [...commitsByHeight.keys()].sort((left, right) => left - right),
    Array.from(
      { length: observedHeightCount },
      (_, index) => result.run.startHeight + index
    ),
    "commit audit height coverage must be contiguous and complete"
  );
  for (const commits of commitsByHeight.values()) {
    assert.equal(new Set(commits.map(({ nodeId }) => nodeId)).size, 4);
  }
  const contradictoryHeights = overlappingCommits
    .filter(
      ([, commits]) =>
        new Set(
          commits.map(({ blockHash, appHash }) => `${blockHash}:${appHash}`)
        ).size > 1
    )
    .map(([height]) => height)
    .sort((left, right) => left - right);

  assert.equal(result.contradictoryCommitAudit.evidenceComplete, true);
  assert.equal(
    result.contradictoryCommitAudit.overlappingHeightsChecked,
    overlappingCommits.length
  );
  assert.equal(overlappingCommits.length > 0, true);
  assert.deepEqual(
    result.contradictoryCommitAudit.contradictoryHeights,
    contradictoryHeights
  );
  assert.equal(
    result.contradictoryCommitAudit.contradictionObserved,
    contradictoryHeights.length > 0
  );
  for (const assertion_ of Object.values(result.assertions)) {
    assert.equal(typeof assertion_.observed, "string");
    assert.equal(typeof assertion_.passed, "boolean");
  }
  assert.equal(result.operatorDecisions.length > 0, true);
  assert.equal(
    result.operatorDecisions.every(
      ({ at }) =>
        new Date(at) >= new Date(result.run.startedAt) &&
        new Date(at) <= new Date(result.run.endedAt)
    ),
    true,
    "operator decisions must stay inside the run window"
  );
  const artifactKinds = new Set(result.artifacts.map(({ kind }) => kind));
  for (const requiredKind of [
    "timeline",
    "node-observations",
    "commit-audit",
    "operator-decisions",
  ]) {
    assert.equal(
      artifactKinds.has(requiredKind),
      true,
      `missing required artifact kind ${requiredKind}`
    );
  }
  if (result.provenance.dirtyWorktree) {
    assert.equal(
      result.artifacts.some(
        ({ kind, sha256: artifactSha256 }) =>
          kind === "worktree-patch" &&
          artifactSha256 === result.provenance.patchSha256
      ),
      true,
      "dirty executed results require a matching worktree-patch artifact"
    );
  }
  assert.equal(isCanonicalDateTime(result.recovery.startedAt), true);
  assert.equal(isCanonicalDateTime(result.recovery.completedAt), true);
  assert.equal(
    new Date(result.recovery.completedAt) >=
      new Date(result.recovery.startedAt),
    true
  );
  assert.equal(
    new Date(result.recovery.startedAt) >= new Date(result.run.startedAt) &&
      new Date(result.recovery.completedAt) <= new Date(result.run.endedAt),
    true,
    "recovery must stay inside the run window"
  );
  assert.equal(
    result.recovery.durationMilliseconds,
    new Date(result.recovery.completedAt).getTime() -
      new Date(result.recovery.startedAt).getTime()
  );
  assert.equal(typeof result.recovery.canonicalHeight, "number");
  assert.equal(typeof result.recovery.canonicalAppHash, "string");
  assert.equal(
    result.recovery.canonicalHeight >= result.run.startHeight &&
      result.recovery.canonicalHeight <= result.run.endHeight,
    true,
    "canonical recovery height must stay inside the run height interval"
  );

  if (contradictoryHeights.length > 0) {
    assert.equal(result.status, "unsafe");
    assert.equal(result.releaseBlocked, true);
  }
  if (scenario.id === "local-unsafe-byzantine-threshold") {
    assert.equal(result.releaseBlocked, true);
    assert.notEqual(result.status, "pass");
  }
  if (result.status === "fail") {
    assert.equal(
      Object.values(result.assertions).some(({ passed }) => passed === false),
      true,
      "failed results require at least one failed assertion"
    );
  }
  if (result.status === "pass") {
    assert.equal(
      Object.values(result.assertions).every(({ passed }) => passed === true),
      true
    );
    assert.equal(result.contradictoryCommitAudit.contradictionObserved, false);
    assert.equal(result.releaseBlocked, false);
    const finalBlockHashes = new Set(
      result.observations.nodes.map(({ blockHash }) => blockHash)
    );
    const finalValidatorHashes = new Set(
      result.observations.nodes.map(({ validatorsHash }) => validatorsHash)
    );
    assert.equal(
      result.observations.nodes.every(
        ({ reachable, height, blockHash, appHash, validatorsHash }) =>
          reachable &&
          height === result.recovery.canonicalHeight &&
          typeof blockHash === "string" &&
          appHash === result.recovery.canonicalAppHash &&
          typeof validatorsHash === "string"
      ),
      true
    );
    assert.equal(finalBlockHashes.size, 1);
    assert.equal(finalValidatorHashes.size, 1);
    assert.equal(
      result.observations.nodes.every(({ nodeId, blockHash, appHash }) =>
        result.observations.committedStates.some(
          (committedState) =>
            committedState.nodeId === nodeId &&
            committedState.height === result.recovery.canonicalHeight &&
            committedState.blockHash === blockHash &&
            committedState.appHash === appHash
        )
      ),
      true,
      "every final node observation needs a matching committed-state record"
    );
  } else {
    assert.equal(result.releaseBlocked, true);
  }
}

async function validateExternalResult(resultPath) {
  const result = JSON.parse(await readFile(resultPath, "utf8"));
  assertValid(validateResult, result, `resilience result ${resultPath}`);
  assertResultSemantics(result);
  for (const artifact of result.artifacts) {
    const artifactPath = path.resolve(repositoryRoot, artifact.relativePath);
    assert.equal(artifactPath.startsWith(`${repositoryRoot}${path.sep}`), true);
    assert.equal(
      sha256(await readFile(artifactPath)),
      artifact.sha256,
      `${artifact.relativePath} SHA-256 mismatch`
    );
  }
}

async function committedResultPaths() {
  const resultsDirectory = path.join(directory, "results");
  let entries;
  try {
    entries = await readdir(resultsDirectory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".result.json"))
    .map((entry) => path.join(resultsDirectory, entry.name))
    .sort();
}

function assertUnique(values, label) {
  assert.equal(new Set(values).size, values.length, `${label} must be unique`);
}

function isCanonicalDateTime(value) {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)
  )
    return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

function expectedExtensionsFor(id) {
  return {
    "local-one-validator-offline": {
      expectedFinality: "committed-heights-remain-single-canonical-history",
      expectedRecovery:
        "restarted-validator-catches-up-from-canonical-peers-without-state-edit",
    },
    "local-two-validators-offline": {
      expectedFinality:
        "no-new-cometbft-committed-height-without-strict-quorum",
      expectedRecovery: "commits-resume-only-after-strict-quorum-returns",
    },
    "local-three-one-partition": {
      expectedFinality:
        "only-75-power-side-may-produce-cometbft-committed-heights",
      expectedRecovery:
        "heal-partition-and-lagging-validator-catches-up-without-state-edit",
    },
    "local-two-two-partition": {
      expectedFinality:
        "neither-50-power-side-may-produce-cometbft-committed-height",
      expectedRecovery:
        "heal-partition-and-resume-only-after-strict-quorum-returns",
    },
    "local-single-equivocation": {
      expectedFinality: "committed-heights-remain-single-canonical-history",
      expectedRecovery:
        "quarantine-signer-preserve-evidence-slash-and-tombstone",
    },
    "local-unsafe-byzantine-threshold": {
      expectedFinality: "no-finality-guarantee-outside-trust-envelope",
      expectedRecovery:
        "stop-experiment-preserve-evidence-and-block-release-readiness",
    },
    "local-all-validator-restart": {
      expectedFinality: "post-restart-commits-extend-same-canonical-history",
      expectedRecovery:
        "restart-persisted-state-with-same-genesis-and-application-hash-without-state-edit",
    },
    "local-rpc-explorer-outage": {
      expectedFinality: "consensus-finality-independent-of-query-dependencies",
      expectedRecovery:
        "restart-dependencies-and-backfill-from-canonical-chain",
    },
    "local-validator-set-change": {
      expectedFinality: "commits-use-effective-historical-validator-set",
      expectedRecovery:
        "continue-from-committed-validator-updates-without-state-edit",
    },
    "local-clock-and-network-delay": {
      expectedFinality: "committed-heights-remain-single-canonical-history",
      expectedRecovery:
        "remove-fault-and-recover-through-increasing-round-timeouts",
    },
    "local-proposer-censorship": {
      expectedFinality:
        "block-finality-continues-transaction-inclusion-remains-unbounded",
      expectedRecovery:
        "preserve-transaction-lifecycle-observability-without-inclusion-promise",
    },
  }[id];
}
