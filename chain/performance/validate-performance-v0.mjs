#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { summarizeCaseSamples } from "./summarize-samples.mjs";

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
  rpcProfile,
  runtimeConfig,
  nodeRoles,
  observability,
  recovery,
  explorerSelection,
  explorerStack,
] = await Promise.all([
  readJson("chain/performance/performance-v0.json"),
  readJson("chain/performance/performance-v0.schema.json"),
  readJson("chain/performance/capacity-result-v0.schema.json"),
  readJson("chain/config/identifiers.json"),
  readJson("chain/config/protocol-v1.json"),
  readJson("chain/config/rpc-profile-v1.json"),
  readText("chain/app/localnet/runtime_config.go"),
  readJson("chain/profiles/node-roles-v0.json"),
  readJson("chain/observability/observability-v0.json"),
  readJson("chain/recovery/recovery-v0.json"),
  readJson("chain/explorer/selection-v1.json"),
  readJson("chain/explorer/stack-v0.json"),
]);

const ajv = new Ajv2020({
  strict: true,
  allErrors: true,
  formats: { "date-time": { type: "string", validate: isCanonicalDateTime } },
});
assertValid(ajv.compile(planSchema), plan, "performance plan");
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
  rpcProfile: {
    path: "chain/config/rpc-profile-v1.json",
    version: rpcProfile.profileVersion,
  },
  runtimeConfig: {
    path: "chain/app/localnet/runtime_config.go",
    version: "canonical-go-runtime-config",
  },
  nodeRoles: {
    path: "chain/profiles/node-roles-v0.json",
    version: nodeRoles.profileVersion,
  },
  observability: {
    path: "chain/observability/observability-v0.json",
    version: observability.observabilityVersion,
  },
  recovery: {
    path: "chain/recovery/recovery-v0.json",
    version: recovery.recoveryVersion,
  },
  explorerSelection: {
    path: "chain/explorer/selection-v1.json",
    version: explorerSelection.selectionVersion,
  },
  explorerStack: {
    path: "chain/explorer/stack-v0.json",
    version: explorerStack.stackVersion,
  },
  toolchain: {
    path: "chain/toolchain.json",
    version: "pinned-by-content-hash",
  },
});

const localnet = identifiers.networks.find(
  ({ environment }) => environment === "localnet"
);
assert.ok(localnet);
assert.equal(localnet.public, false);
assert.equal(localnet.cosmos.chainId, "torium-localnet-1");
assert.equal(localnet.evm.chainId, 1414484556);

const rpcLimits = rpcProfile.ethereum.limits;
assert.deepEqual(plan.knownProtocolLimits, {
  maximumBlockBytes: protocol.consensus.block.maxBytes,
  maximumBlockGas: protocol.consensus.block.maxGas,
  targetBlockGas: protocol.consensus.block.targetGas,
  accountExecutableSlots: protocol.mempool.accountExecutableSlots,
  maximumEvmTransactionBytes: protocol.mempool.maximumEvmTransactionBytes,
  rpcBatchRequests: rpcLimits.batchRequests,
  rpcMaximumOpenConnections: rpcLimits.maxOpenConnections,
  rpcBatchResponseBytes: rpcLimits.batchResponseBytes,
  status: "configured-functional-limits-not-capacity-evidence",
});

const evmPublic = nodeRoles.runtimePolicies["evm-public-v0"];
assert.equal(evmPublic.effectiveConformanceProven, false);
assert.equal(evmPublic.limits.batchRequests, rpcLimits.batchRequests);
assert.equal(evmPublic.limits.maxOpenConnections, rpcLimits.maxOpenConnections);
assert.equal(evmPublic.limits.batchResponseBytes, rpcLimits.batchResponseBytes);
assert.equal(
  readGoDecimalConstant(runtimeConfig, "localJSONRPCMaxOpenConnections"),
  rpcLimits.maxOpenConnections
);
assert.equal(
  readGoDecimalConstant(runtimeConfig, "localJSONRPCBatchRequests"),
  rpcLimits.batchRequests
);
assert.equal(
  readGoDecimalConstant(runtimeConfig, "localJSONRPCBatchResponseBytes"),
  rpcLimits.batchResponseBytes
);
assert.match(
  runtimeConfig,
  /cfg\.JSONRPC\.MaxOpenConnections\s*=\s*localJSONRPCMaxOpenConnections/u
);
assert.match(
  runtimeConfig,
  /cfg\.JSONRPC\.BatchRequestLimit\s*=\s*localJSONRPCBatchRequests/u
);
assert.match(
  runtimeConfig,
  /cfg\.JSONRPC\.BatchResponseMaxSize\s*=\s*localJSONRPCBatchResponseBytes/u
);

// The archive workload may only be ACTIVE while the archive role it reads is
// itself activated (#114). If the role goes back to inactive, the workload has
// no endpoint and must return to the deferred list.
const archiveRoleActive =
  nodeRoles.roles.find(({ id }) => id === "private-archive-indexer")
    ?.activation === "active-local-gateway-fronted";
assert.deepEqual(
  plan.activeWorkloads.map(({ id }) => id),
  [
    "native-transfer-closed-loop",
    "native-transfer-bounded-burst",
    "rpc-recent-read-mix",
    ...(archiveRoleActive ? ["archive-historical-read-mix"] : []),
  ]
);
const [closedLoop, burst, rpcMix, archiveMix] = plan.activeWorkloads;
assert.equal(closedLoop.operationCount, 8);
assert.equal(burst.operationCount, 16);
assert.equal(
  burst.concurrency <= protocol.mempool.accountExecutableSlots,
  true
);
assert.equal(rpcMix.exactBatchSize, rpcLimits.batchRequests);
assert.equal(rpcMix.batchCount, 1);
assert.equal(rpcMix.httpRequestCount, 6);
assert.equal(rpcMix.jsonRpcCallCount, 105);
assert.equal(
  rpcMix.jsonRpcCallCount,
  rpcMix.httpRequestCount -
    rpcMix.batchCount +
    rpcMix.batchCount * rpcMix.exactBatchSize
);
if (archiveRoleActive) {
  // The archive workload reads ONLY through the gateway; reading the raw
  // archive RPC is exactly what the node-role contract forbids.
  assert.equal(archiveMix.endpoint, "archive-rpc-gateway");
  assert.equal(archiveMix.scenario, "archive-historical-local-smoke");
  assert.equal(archiveMix.exactBatchSize, rpcLimits.batchRequests);
  assert.equal(
    archiveMix.jsonRpcCallCount,
    archiveMix.httpRequestCount -
      archiveMix.batchCount +
      archiveMix.batchCount * archiveMix.exactBatchSize
  );
  // Every method it exercises must be inside the gateway's enforced allowlist,
  // or the workload would be measuring refusals rather than archive reads.
  const enforced =
    nodeRoles.runtimePolicies["evm-archive-blockscout-candidate-v0"]
      .candidateMethodContract;
  for (const method of archiveMix.methods) {
    assert.ok(
      enforced.includes(method),
      `${method} is outside the archive gateway's enforced allowlist`
    );
  }
  // Depth 0 is genesis-adjacent history and depth 1 is the tip: without both,
  // "latency by history depth" would not be a depth measurement at all.
  assert.equal(archiveMix.historicalDepthFractions.includes(0), true);
  assert.equal(archiveMix.historicalDepthFractions.includes(1), true);
  assert.equal(
    archiveMix.measures.includes("latency-by-history-depth"),
    true
  );
  // The archive storage policy must actually retain the history being read.
  const archiveStorage = nodeRoles.storagePolicies["archive-indexer-v0"];
  assert.equal(archiveStorage.pruningStrategy, "nothing");
  assert.equal(archiveStorage.targetFromGenesis, true);
  assert.equal(archiveStorage.activated, true);
  assert.equal(
    plan.deferredWorkloads.some(
      ({ id }) => id === "historical-and-archive-queries"
    ),
    false,
    "the archive query workload cannot be both active and deferred"
  );
} else {
  assert.equal(archiveMix, undefined);
  assert.equal(
    plan.deferredWorkloads.some(
      ({ id }) => id === "historical-and-archive-queries"
    ),
    true
  );
}
assert.equal(
  new Set(plan.deferredWorkloads.map(({ id }) => id)).size,
  plan.deferredWorkloads.length
);
assert.equal(
  plan.deferredWorkloads.every(
    ({ status }) => status === "HOLD-not-measured-v0"
  ),
  true
);

for (const role of nodeRoles.roles) {
  assert.equal(role.resources.status, "planning-floor-not-benchmarked");
  assert.equal(role.resources.publicCapacityClaimed, false);
}
assert.equal(nodeRoles.publicLaunchAllowed, false);
assert.equal(observability.constraints.numericCapacityOrSloClaimAllowed, false);
assert.equal(
  observability.constraints.collectorOrDashboardRuntimeConfigIncluded,
  false
);
assert.equal(recovery.publicLaunchAllowed, false);
for (const field of [
  "rpoSeconds",
  "rtoSeconds",
  "restoreThroughputBytesPerSecond",
  "storageGrowthBytesPerDay",
]) {
  assert.equal(recovery.recoveryObjectives[field], null);
}
assert.ok(
  ["inactive-local-only-hold", "activated-local-only-hold"].includes(
    explorerStack.status
  ),
  "the explorer stack must stay local-only"
);
assert.match(explorerSelection.status, /candidate/u);
assert.deepEqual(plan.capacityClaims, {
  safeTps: null,
  safeRpcRequestsPerSecond: null,
  validatorSizing: null,
  rpcSizing: null,
  archiveSizing: null,
  explorerSizing: null,
  billOfMaterialsReady: false,
});
assert.equal(plan.regressionPolicy.thresholds, null);
assert.equal(plan.regressionPolicy.blockingCiEnabled, false);
assert.equal(plan.regressionPolicy.scheduledBenchmarkEnabled, false);

const syntheticCase = summarizeCaseSamples({
  caseId: "schema-proof",
  workloadId: "native-transfer-closed-loop",
  startedAtMilliseconds: 0,
  endedAtMilliseconds: 1000,
  samples: [
    {
      outcome: "success",
      included: true,
      acknowledgementLatencyMilliseconds: 10,
      inclusionLatencyMilliseconds: 100,
      receiptLatencyMilliseconds: 110,
      gasUsed: 21000,
    },
  ],
});
const zeroHash = "0".repeat(64);
const emptySummary = {
  sampleCount: 0,
  minimum: null,
  p50: null,
  p95: null,
  maximum: null,
  mean: null,
};
const syntheticResult = {
  schemaVersion: 1,
  resultVersion: "0.1.0",
  status: "synthetic-validation",
  planVersion: plan.performanceVersion,
  provenance: {
    gitCommit: "0".repeat(40),
    dirtyWorktree: true,
    patchSha256: zeroHash,
    os: "synthetic",
    architecture: "synthetic",
    cpuModel: "synthetic",
    logicalCores: 1,
    memoryBytes: 1,
    containerRuntime: null,
    composeVersion: null,
    executionBackend: "raw",
    virtualization: "synthetic",
    vmAllocation: null,
    filesystem: "synthetic",
    statePath: "synthetic",
    toolchainSha256: zeroHash,
    runnerVersion: "synthetic",
    runnerSha256: zeroHash,
    binaryIdentity: "synthetic",
    binarySha256: zeroHash,
    genesisSha256: zeroHash,
    effectiveConfigSha256: zeroHash,
    datasetSha256: zeroHash,
    workload: {
      id: "native-transfer-closed-loop",
      version: 1,
      definitionSha256: hashJson(closedLoop),
      seed: 0,
      operationCount: closedLoop.operationCount,
      concurrency: 1,
      warmupCount: 0,
      repetition: 1,
    },
  },
  run: {
    startedAt: "2026-01-01T00:00:00.000Z",
    endedAt: "2026-01-01T00:00:01.000Z",
    startHeight: 1,
    endHeight: 1,
    cosmosChainId: "torium-localnet-1",
    evmChainId: 1414484556,
    topology: "canonical-four-validator-combined-localnet",
  },
  cases: [syntheticCase],
  chainMetrics: {
    blockSampleCount: 0,
    averageBlockGasUsed: null,
    maximumBlockGasUsed: null,
    targetGasUtilization: null,
    limitGasUtilization: null,
    commitIntervalMilliseconds: emptySummary,
    blockRangeContiguous: false,
    finalityModel: "cometbft-committed-block",
    jsonRpcFinalizedTag: protocol.consensus.finality.jsonRpcFinalizedTag,
    jsonRpcSafeStateQueries:
      protocol.consensus.finality.jsonRpcSafeStateQueries,
    rpcAcceptanceGuaranteesRetention:
      protocol.mempool.rpcAcceptanceGuaranteesRetention,
  },
  rpcMetrics: {
    httpRequestCount: 0,
    httpSuccessCount: 0,
    httpErrorCount: 0,
    httpTimeoutCount: 0,
    jsonRpcCallCount: 0,
    callSuccessCount: 0,
    callErrorCount: 0,
    callTimeoutCount: 0,
    batchCount: 0,
    perMethodCounts: [],
    responseBytes: 0,
    latencyMilliseconds: emptySummary,
  },
  resourceDeltas: [],
  stateGrowth: {
    nodeHomeBytesDelta: null,
    databaseBytesDelta: null,
    storageGrowthBytesPerDay: null,
    indexerLagBlocks: null,
    diskIops: null,
    diskIoLatencyMilliseconds: null,
  },
  observations: {
    bottlenecks: [],
    failureCliffs: [],
    regressionEvaluation: null,
  },
  artifacts: [],
  capacityClaims: {
    public: false,
    safeTps: null,
    safeRpcRequestsPerSecond: null,
    billOfMaterialsReady: false,
  },
  limitations: ["synthetic schema validation only"],
};
assertValid(validateResult, syntheticResult, "capacity result");
assertResultSemantics(syntheticResult);
const fakeCompleteResult = structuredClone(syntheticResult);
fakeCompleteResult.status = "complete-local";
assert.throws(
  () => assertResultSemantics(fakeCompleteResult),
  /resource deltas/u
);
const inflatedTpsResult = structuredClone(syntheticResult);
inflatedTpsResult.cases[0].includedCommittedTps = 999;
assert.throws(() => assertResultSemantics(inflatedTpsResult), /included TPS/u);
const invalidTimeResult = structuredClone(syntheticResult);
invalidTimeResult.run.startedAt = "not-a-date";
assert.equal(
  validateResult(invalidTimeResult),
  false,
  "non-canonical dates must fail schema validation"
);

for (const argument of process.argv.slice(2)) {
  if (argument === "--committed-results") {
    for (const resultPath of await committedResultPaths()) {
      await validateExternalResult(resultPath);
    }
  } else if (argument.startsWith("--")) {
    throw new Error(`unsupported option ${argument}`);
  } else {
    await validateExternalResult(path.resolve(argument));
  }
}

console.log("performance v0 contract validated");

async function readJson(relativePath) {
  return JSON.parse(await readText(relativePath));
}

async function readText(relativePath) {
  return readFile(path.join(repositoryRoot, relativePath), "utf8");
}

async function validateExternalResult(resultPath) {
  const externalResult = JSON.parse(await readFile(resultPath, "utf8"));
  assertValid(validateResult, externalResult, `capacity result ${resultPath}`);
  assertResultSemantics(externalResult);
  for (const artifact of externalResult.artifacts) {
    const artifactPath = path.resolve(repositoryRoot, artifact.relativePath);
    assert.equal(
      artifactPath.startsWith(`${repositoryRoot}${path.sep}`),
      true,
      `${artifact.relativePath} must stay inside the repository`
    );
    const content = await readFile(artifactPath);
    assert.equal(
      sha256(content),
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

function assertValid(validate, value, label) {
  assert.equal(
    validate(value),
    true,
    `${label} validation failed: ${JSON.stringify(validate.errors)}`
  );
}

function assertResultSemantics(result) {
  assert.equal(
    result.planVersion,
    plan.performanceVersion,
    "result plan version must match the active plan"
  );
  assert.equal(
    new Date(result.run.endedAt) > new Date(result.run.startedAt),
    true,
    "run time must increase"
  );
  assert.equal(
    result.run.endHeight >= result.run.startHeight,
    true,
    "run height must be monotonic"
  );
  assertUnique(
    result.cases.map(({ caseId }) => caseId),
    "case IDs"
  );
  assertUnique(
    result.resourceDeltas.map(({ component }) => component),
    "resource components"
  );
  assertUnique(
    result.artifacts.map(({ relativePath }) => relativePath),
    "artifact paths"
  );
  assertUnique(
    result.rpcMetrics.perMethodCounts.map(({ method }) => method),
    "RPC method counts"
  );
  const workload = plan.activeWorkloads.find(
    ({ id }) => id === result.provenance.workload.id
  );
  assert.ok(workload, "result workload must exist in the active plan");
  assert.equal(
    result.provenance.workload.version,
    workload.version,
    "workload version must match the active plan"
  );
  assert.equal(
    result.provenance.workload.definitionSha256,
    hashJson(workload),
    "workload definition hash must match the active plan"
  );
  assert.equal(
    result.provenance.workload.operationCount,
    workload.operationCount ?? workload.jsonRpcCallCount,
    "workload operation count must match the active plan"
  );
  assert.equal(
    result.provenance.workload.concurrency,
    workload.concurrency,
    "workload concurrency must match the active plan"
  );
  assert.equal(
    result.cases.every(({ workloadId }) => workloadId === workload.id),
    true,
    "all cases must match the provenance workload"
  );

  for (const resultCase of result.cases) {
    if (resultCase.caseType === "rpc") {
      assertApprox(
        resultCase.httpRequestsPerSecond,
        resultCase.httpRequestCount / (resultCase.elapsedMilliseconds / 1000),
        `${resultCase.caseId} HTTP rate`
      );
      assertApprox(
        resultCase.jsonRpcCallsPerSecond,
        resultCase.jsonRpcCallCount / (resultCase.elapsedMilliseconds / 1000),
        `${resultCase.caseId} JSON-RPC rate`
      );
      assertSummary(
        resultCase.latencyMilliseconds,
        resultCase.httpRequestCount,
        `${resultCase.caseId} HTTP latency`
      );
      continue;
    }
    const { counts } = resultCase;
    const outcomeTotal =
      counts.committedSuccess +
      counts.committedRevert +
      counts.unexpectedRevert +
      counts.submissionFailed +
      counts.dropped;
    assert.equal(
      outcomeTotal,
      counts.sample,
      `${resultCase.caseId} outcome counts must reconcile`
    );
    assert.equal(
      counts.includedCommitted,
      counts.committedSuccess +
        counts.committedRevert +
        counts.unexpectedRevert,
      `${resultCase.caseId} included counts must reconcile`
    );
    assertApprox(
      resultCase.includedCommittedTps,
      counts.includedCommitted / (resultCase.elapsedMilliseconds / 1000),
      `${resultCase.caseId} included TPS`
    );
    assertApprox(
      resultCase.successfulTps,
      counts.committedSuccess / (resultCase.elapsedMilliseconds / 1000),
      `${resultCase.caseId} successful TPS`
    );
    assertSummary(
      resultCase.latencyMilliseconds.acknowledgement,
      counts.sample,
      `${resultCase.caseId} acknowledgement latency`
    );
    assertSummary(
      resultCase.latencyMilliseconds.inclusion,
      counts.includedCommitted,
      `${resultCase.caseId} inclusion latency`
    );
    assertSummary(
      resultCase.latencyMilliseconds.receipt,
      counts.includedCommitted,
      `${resultCase.caseId} receipt latency`
    );
    assert.equal(
      resultCase.gasUsed.sampleCount <= counts.includedCommitted,
      true,
      `${resultCase.caseId} gas count exceeds included transactions`
    );
    if (resultCase.gasUsed.sampleCount === 0) {
      assert.equal(resultCase.gasUsed.total, 0);
      assert.equal(resultCase.gasUsed.mean, null);
    } else {
      assertApprox(
        resultCase.gasUsed.mean,
        resultCase.gasUsed.total / resultCase.gasUsed.sampleCount,
        `${resultCase.caseId} gas mean`
      );
    }
  }

  const rpc = result.rpcMetrics;
  assert.equal(
    rpc.httpSuccessCount + rpc.httpErrorCount + rpc.httpTimeoutCount,
    rpc.httpRequestCount,
    "HTTP outcome counts must reconcile"
  );
  assert.equal(
    rpc.callSuccessCount + rpc.callErrorCount + rpc.callTimeoutCount,
    rpc.jsonRpcCallCount,
    "JSON-RPC call outcomes must reconcile"
  );
  assert.equal(
    rpc.perMethodCounts.reduce((sum, { count }) => sum + count, 0),
    rpc.jsonRpcCallCount,
    "per-method call counts must reconcile"
  );
  assert.equal(
    rpc.batchCount <= rpc.httpRequestCount,
    true,
    "batch count exceeds HTTP requests"
  );
  assertSummary(rpc.latencyMilliseconds, rpc.httpRequestCount, "HTTP latency");
  const rpcCases = result.cases.filter(({ caseType }) => caseType === "rpc");
  assert.equal(
    rpcCases.reduce((sum, item) => sum + item.httpRequestCount, 0),
    rpc.httpRequestCount,
    "RPC cases must reconcile HTTP requests"
  );
  assert.equal(
    rpcCases.reduce((sum, item) => sum + item.jsonRpcCallCount, 0),
    rpc.jsonRpcCallCount,
    "RPC cases must reconcile JSON-RPC calls"
  );

  const blockMetrics = result.chainMetrics;
  assertSummary(
    blockMetrics.commitIntervalMilliseconds,
    Math.max(0, blockMetrics.blockSampleCount - 1),
    "commit interval"
  );
  if (blockMetrics.blockSampleCount === 0) {
    for (const value of [
      blockMetrics.averageBlockGasUsed,
      blockMetrics.maximumBlockGasUsed,
      blockMetrics.targetGasUtilization,
      blockMetrics.limitGasUtilization,
    ]) {
      assert.equal(value, null, "empty block metrics must remain null");
    }
  } else {
    for (const value of [
      blockMetrics.averageBlockGasUsed,
      blockMetrics.maximumBlockGasUsed,
      blockMetrics.targetGasUtilization,
      blockMetrics.limitGasUtilization,
    ]) {
      assert.equal(
        Number.isFinite(value),
        true,
        "measured block metrics must be finite"
      );
    }
    assert.equal(
      blockMetrics.averageBlockGasUsed <= blockMetrics.maximumBlockGasUsed,
      true,
      "average block gas exceeds maximum"
    );
    assert.equal(
      blockMetrics.maximumBlockGasUsed <= protocol.consensus.block.maxGas,
      true,
      "measured block gas exceeds protocol limit"
    );
    assertApprox(
      blockMetrics.targetGasUtilization,
      blockMetrics.averageBlockGasUsed / protocol.consensus.block.targetGas,
      "target gas utilization"
    );
    assertApprox(
      blockMetrics.limitGasUtilization,
      blockMetrics.averageBlockGasUsed / protocol.consensus.block.maxGas,
      "limit gas utilization"
    );
  }

  assert.equal(
    result.provenance.dirtyWorktree,
    result.provenance.patchSha256 !== null,
    "dirty runs require a patch hash; clean runs require null"
  );
  if (
    result.provenance.executionBackend === "container" &&
    result.provenance.virtualization !== "none"
  ) {
    assert.notEqual(
      result.provenance.vmAllocation,
      null,
      "virtualized container runs require VM allocation provenance"
    );
  }
  if (result.status === "complete-local") {
    assert.equal(
      result.resourceDeltas.length > 0,
      true,
      "complete results require resource deltas"
    );
    assert.equal(
      result.artifacts.length > 0,
      true,
      "complete results require content-hashed raw artifacts"
    );
    assert.equal(
      result.resourceDeltas.every((resource) =>
        [
          resource.cpuPercentage,
          resource.rssBytes,
          resource.networkRxBytes,
          resource.networkTxBytes,
          resource.blockReadBytes,
          resource.blockWriteBytes,
          resource.nodeHomeBytes,
        ].some((value) => value !== null)
      ),
      true,
      "complete resource deltas require at least one measured signal per component"
    );
    if (result.provenance.workload.id.startsWith("native-transfer-")) {
      assert.equal(
        result.cases.every(({ caseType }) => caseType === "transaction"),
        true,
        "transfer results require transaction cases"
      );
      assert.equal(
        result.cases.every(({ counts }) => counts.sample > 0),
        true,
        "complete transfer results require measured cases"
      );
      assert.equal(
        result.cases.reduce((sum, item) => sum + item.counts.sample, 0),
        workload.operationCount,
        "complete transfer result count must match the plan"
      );
      assert.equal(
        result.cases.every(
          (item) =>
            item.latencyMilliseconds.acknowledgement.sampleCount >=
            item.counts.includedCommitted
        ),
        true,
        "complete transfer results require acknowledgement latency for every included transaction"
      );
      assert.equal(
        result.cases.every(
          (item) =>
            item.latencyMilliseconds.inclusion.sampleCount ===
            item.counts.includedCommitted
        ),
        true,
        "complete transfer results require inclusion latency for every included transaction"
      );
      assert.equal(
        result.cases.every(
          (item) =>
            item.latencyMilliseconds.receipt.sampleCount ===
            item.counts.includedCommitted
        ),
        true,
        "complete transfer results require receipt latency for every included transaction"
      );
      assert.equal(
        result.cases.every(
          (item) => item.gasUsed.sampleCount === item.counts.includedCommitted
        ),
        true,
        "complete transfer results require gas for every included transaction"
      );
      assert.equal(
        blockMetrics.blockSampleCount >= 2,
        true,
        "complete transfer results require at least two block samples"
      );
      assert.equal(
        blockMetrics.blockRangeContiguous,
        true,
        "complete transfer results require a contiguous block range"
      );
      assert.equal(
        blockMetrics.blockSampleCount,
        result.run.endHeight - result.run.startHeight + 1,
        "complete transfer block samples must match the run height range"
      );
      assert.equal(
        blockMetrics.commitIntervalMilliseconds.sampleCount,
        blockMetrics.blockSampleCount - 1,
        "complete transfer results require every commit interval"
      );
      assert.equal(
        rpc.httpRequestCount,
        0,
        "transfer results cannot contain RPC workload metrics"
      );
    }
    if (result.provenance.workload.id === "rpc-recent-read-mix") {
      assert.equal(
        result.cases.every(({ caseType }) => caseType === "rpc"),
        true,
        "RPC results require RPC cases"
      );
      assert.equal(
        rpc.httpRequestCount,
        workload.httpRequestCount,
        "complete RPC result HTTP count must match the plan"
      );
      assert.equal(
        rpc.jsonRpcCallCount,
        workload.jsonRpcCallCount,
        "complete RPC result call count must match the plan"
      );
      assert.equal(
        rpc.batchCount,
        workload.batchCount,
        "complete RPC result batch count must match the plan"
      );
      assert.equal(
        rpc.latencyMilliseconds.sampleCount,
        rpc.httpRequestCount,
        "complete RPC results require latency for every HTTP request"
      );
      assert.equal(
        result.cases.every(
          (item) =>
            item.latencyMilliseconds.sampleCount === item.httpRequestCount
        ),
        true,
        "complete RPC cases require latency for every HTTP request"
      );
      assert.equal(
        rpc.responseBytes > 0,
        true,
        "complete RPC results require response-byte evidence"
      );
      assert.equal(
        new Set(rpc.perMethodCounts.map(({ method }) => method)).size,
        workload.methods.length,
        "complete RPC result must cover every planned method"
      );
      assert.equal(
        rpc.perMethodCounts.every(({ method }) =>
          workload.methods.includes(method)
        ),
        true,
        "complete RPC result contains an unplanned method"
      );
    }
    const requiredRawKind = result.provenance.workload.id.startsWith(
      "native-transfer-"
    )
      ? "raw-transaction-samples"
      : "raw-rpc-samples";
    assert.equal(
      result.artifacts.some(({ kind }) => kind === requiredRawKind),
      true,
      `complete results require a ${requiredRawKind} artifact`
    );
    assert.equal(
      result.artifacts.some(({ kind }) => kind === "resource-samples"),
      true,
      "complete results require a resource-samples artifact"
    );
    for (const value of [
      result.provenance.os,
      result.provenance.cpuModel,
      result.provenance.runnerVersion,
      result.provenance.binaryIdentity,
    ].filter((value) => value !== null)) {
      assert.equal(
        value.toLowerCase().includes("synthetic"),
        false,
        "complete results cannot use synthetic provenance"
      );
    }
    for (const hash of [
      result.provenance.toolchainSha256,
      result.provenance.runnerSha256,
      result.provenance.binarySha256,
      result.provenance.genesisSha256,
      result.provenance.effectiveConfigSha256,
      result.provenance.datasetSha256,
      result.provenance.workload.definitionSha256,
      ...(result.provenance.patchSha256 === null
        ? []
        : [result.provenance.patchSha256]),
      ...result.artifacts.map(({ sha256 }) => sha256),
    ]) {
      assert.notEqual(
        hash,
        zeroHash,
        "complete results cannot use placeholder hashes"
      );
    }
    assert.notEqual(
      result.provenance.gitCommit,
      "0".repeat(40),
      "complete results cannot use a placeholder commit"
    );
    if (result.provenance.dirtyWorktree) {
      assert.equal(
        result.artifacts.some(
          ({ kind, sha256: artifactHash }) =>
            kind === "worktree-patch" &&
            artifactHash === result.provenance.patchSha256
        ),
        true,
        "dirty complete results require a content-hashed worktree-patch artifact"
      );
    }
  }
}

function assertSummary(summary, maximumSamples, label) {
  assert.equal(
    summary.sampleCount <= maximumSamples,
    true,
    `${label} sample count exceeds source count`
  );
  const values = [
    summary.minimum,
    summary.p50,
    summary.p95,
    summary.maximum,
    summary.mean,
  ];
  if (summary.sampleCount === 0) {
    assert.equal(
      values.every((value) => value === null),
      true,
      `${label} empty summary must be null`
    );
    return;
  }
  assert.equal(
    values.every(Number.isFinite),
    true,
    `${label} must contain finite values`
  );
  assert.equal(
    summary.minimum <= summary.p50 &&
      summary.p50 <= summary.p95 &&
      summary.p95 <= summary.maximum,
    true,
    `${label} percentiles must be ordered`
  );
  assert.equal(
    summary.mean >= summary.minimum && summary.mean <= summary.maximum,
    true,
    `${label} mean must be inside range`
  );
}

function assertApprox(actual, expected, label) {
  assert.equal(
    Math.abs(actual - expected) <= 0.000001,
    true,
    `${label} does not reconcile`
  );
}

function assertUnique(values, label) {
  assert.equal(new Set(values).size, values.length, `${label} must be unique`);
}

function isCanonicalDateTime(value) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value))
    return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function readGoDecimalConstant(source, name) {
  const expression = new RegExp(
    `^\\s*${name}\\s*=\\s*([0-9][0-9_]*)\\s*$`,
    "gmu"
  );
  const matches = [...source.matchAll(expression)];
  assert.equal(
    matches.length,
    1,
    `${name} must have exactly one decimal constant declaration`
  );
  return Number(matches[0][1].replaceAll("_", ""));
}

function hashJson(value) {
  return sha256(Buffer.from(canonicalJson(value)));
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}
