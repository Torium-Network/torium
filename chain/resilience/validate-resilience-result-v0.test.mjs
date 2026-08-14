import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { assertResultSemantics } from "./validate-resilience-plan-v0.mjs";

const plan = JSON.parse(
  await readFile(new URL("./resilience-plan-v0.json", import.meta.url), "utf8")
);
const scenario = plan.canonicalScenarios[0];
const blockHash = "A".repeat(64);
const appHash = "B".repeat(64);
const validatorsHash = "C".repeat(64);
const sha256 = "d".repeat(64);

test("accepts a complete release-blocked executed result", () => {
  assert.doesNotThrow(() => assertResultSemantics(executedResult()));
});

test("derives contradictory commits instead of trusting the report flag", () => {
  const result = executedResult();
  result.observations.committedStates[1].blockHash = "D".repeat(64);
  result.observations.committedStates[1].appHash = "E".repeat(64);

  assert.throws(
    () => assertResultSemantics(result),
    /Expected values to be strictly deep-equal/u
  );
});

test("rejects a passing report whose assertions did not all pass", () => {
  const result = executedResult();
  result.status = "pass";
  result.releaseBlocked = false;
  for (const assertion_ of Object.values(result.assertions)) {
    assertion_.passed = true;
  }
  result.assertions.recovery.passed = false;

  assert.throws(() => assertResultSemantics(result));
});

test("rejects a passing report that still claims release-blocked", () => {
  const result = executedResult();
  result.status = "pass";
  for (const assertion_ of Object.values(result.assertions)) {
    assertion_.passed = true;
  }
  result.releaseBlocked = true;

  assert.throws(() => assertResultSemantics(result));
});

test("rejects fabricated run metadata from an unexecuted result", () => {
  const result = executedResult();
  result.executed = false;
  result.status = "HOLD-not-executed";
  result.releaseBlocked = true;

  assert.throws(() => assertResultSemantics(result));
});

test("rejects placeholder provenance from an executed result", () => {
  const result = executedResult();
  result.provenance.gitCommit = "0".repeat(40);

  assert.throws(() => assertResultSemantics(result));
});

test("requires a content-matched patch artifact for a dirty run", () => {
  const result = executedResult();
  result.provenance.dirtyWorktree = true;
  result.provenance.patchSha256 = sha256;

  assert.throws(
    () => assertResultSemantics(result),
    /matching worktree-patch artifact/u
  );
});

test("keeps canonical recovery height inside the run", () => {
  const result = executedResult();
  result.recovery.canonicalHeight = 13;

  assert.throws(
    () => assertResultSemantics(result),
    /canonical recovery height/u
  );
});

function executedResult() {
  const nodeIds = ["validator-0", "validator-1", "validator-2", "validator-3"];

  return {
    schemaVersion: 1,
    resultVersion: "0.1.0",
    status: "fail",
    ownerIssue: 119,
    planVersion: plan.planVersion,
    scenarioId: scenario.id,
    testId: scenario.testId,
    executed: true,
    provenance: {
      gitCommit: "f".repeat(40),
      dirtyWorktree: false,
      patchSha256: null,
      toolchainSha256: sha256,
      binaryIdentity: "test-binary",
      binarySha256: sha256,
      genesisSha256: sha256,
      effectiveConfigSha256: sha256,
      hostIdentity: "test-host",
      runnerIdentity: "semantic-unit-test",
      seed: 1,
    },
    run: {
      startedAt: "2026-07-16T00:00:00.000Z",
      endedAt: "2026-07-16T00:00:00.500Z",
      cosmosChainId: "torium-localnet-1",
      evmChainId: 1414484556,
      startHeight: 10,
      endHeight: 12,
      baselineBlockHash: blockHash,
      baselineAppHash: appHash,
    },
    timeline: [
      timelineEvent("baseline", "2026-07-16T00:00:00.000Z", 10),
      timelineEvent("change-applied", "2026-07-16T00:00:00.100Z", 10),
      timelineEvent(
        "expected-behavior-observed",
        "2026-07-16T00:00:00.200Z",
        11
      ),
      timelineEvent("recovery-started", "2026-07-16T00:00:00.300Z", 11),
      timelineEvent("recovery-complete", "2026-07-16T00:00:00.400Z", 12),
    ],
    observations: {
      nodes: nodeIds.map((nodeId) => ({
        nodeId,
        reachable: true,
        height: 12,
        blockHash,
        appHash,
        validatorsHash,
      })),
      committedStates: [10, 11, 12].flatMap((height) =>
        nodeIds.map((nodeId) => ({
          height,
          nodeId,
          blockHash,
          appHash,
          commitVotingPower: 100,
        }))
      ),
    },
    assertions: Object.fromEntries(
      ["liveness", "safety", "finality", "recovery"].map((kind) => [
        kind,
        {
          expected:
            scenario[`expected${kind[0].toUpperCase()}${kind.slice(1)}`],
          observed: "observed-as-expected",
          passed: kind !== "liveness",
        },
      ])
    ),
    recovery: {
      manualStateEdits: false,
      startedAt: "2026-07-16T00:00:00.300Z",
      completedAt: "2026-07-16T00:00:00.400Z",
      durationMilliseconds: 100,
      canonicalHeight: 12,
      canonicalAppHash: appHash,
    },
    contradictoryCommitAudit: {
      overlappingHeightsChecked: 3,
      contradictionObserved: false,
      contradictoryHeights: [],
      evidenceComplete: true,
    },
    operatorDecisions: [
      {
        at: "2026-07-16T00:00:00.450Z",
        decision: "retain-release-block",
        reason: "the liveness assertion failed",
      },
    ],
    artifacts: [
      artifact("timeline", "timeline.json"),
      artifact("node-observations", "nodes.json"),
      artifact("commit-audit", "commits.json"),
      artifact("operator-decisions", "decisions.json"),
    ],
    releaseBlocked: true,
    limitations: ["semantic unit-test fixture only"],
  };
}

function timelineEvent(kind, at, height) {
  return { kind, at, height, note: `${kind} test event` };
}

function artifact(kind, name) {
  return {
    kind,
    relativePath: `chain/resilience/test-artifacts/${name}`,
    sha256,
    containsSecrets: false,
  };
}
