#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const directory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(directory, "../..");
const selection = await readStrictJson(
  path.join(directory, "selection-v1.json")
);
const schema = await readStrictJson(
  path.join(directory, "selection-v1.schema.json")
);
// The archive/indexer RPC target belongs to #114's node-role profile. Reading
// it here lets every rpcDependency claim below be DERIVED from that profile's
// own activation state instead of duplicating the decision.
const targetProfile = await readStrictJson(
  path.join(repositoryRoot, "chain/profiles/node-roles-v0.json")
);
const archiveTargetRole = targetProfile.roles.find(
  ({ id }) => id === "private-archive-indexer"
);
assert.ok(archiveTargetRole, "#114 archive/indexer target role is missing");
const archiveTargetActivated =
  archiveTargetRole.activation === "active-local-gateway-fronted";

assertExactKeys(selection, [
  "$schema",
  "schemaVersion",
  "selectionVersion",
  "status",
  "ownerIssue",
  "constraints",
  "selected",
  "runtime",
  "rpcDependency",
  "features",
  "sourceOfTruth",
  "operations",
  "legalGate",
  "evidence",
  "alternatives",
  "releaseGates",
]);
assert.equal(selection.$schema, "./selection-v1.schema.json");
assert.equal(selection.schemaVersion, 1);
assert.match(selection.selectionVersion, /^1\.0\.0-local\.[1-9][0-9]*$/u);
assert.equal(selection.status, "conditional-local-candidate");
assert.equal(selection.ownerIssue, 112);

assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
assert.equal(schema.additionalProperties, false);
assert.deepEqual(new Set(schema.required), new Set(Object.keys(selection)));
assert.equal(schema.properties.selected.properties.release.const, "v11.2.2");
assert.equal(
  schema.properties.selected.properties.commit.const,
  "731015d88d7e73623f2a3c097e241bc82b04ea7a"
);
assert.equal(schema.properties.legalGate.properties.required.const, true);
assert.equal(schema.properties.legalGate.properties.status.const, "pending");

assert.deepEqual(selection.constraints, {
  environment: "local-development-only",
  standaloneL1Only: true,
  liveDeploymentAllowed: false,
  publicOperationAllowed: false,
  distributionAllowed: false,
  backendIntegrationInScope: false,
  bridgeOrL2InScope: false,
});
assert.deepEqual(selection.selected, {
  name: "Blockscout",
  componentType: "evm-indexer-and-explorer-api",
  repository: "https://github.com/blockscout/blockscout",
  release: "v11.2.2",
  commit: "731015d88d7e73623f2a3c097e241bc82b04ea7a",
  distribution: "exact-commit-source-build",
  prebuiltImageAccepted: false,
  localImageTag: "torium/blockscout-poc:v11.2.2",
  localImageTagIsSecurityIdentity: false,
  license: "LicenseRef-Blockscout-1.0",
});

assertExactKeys(selection.runtime, [
  "database",
  "cache",
  "fullUpstreamStack",
  "network",
]);
assert.deepEqual(selection.runtime.database, {
  engine: "PostgreSQL",
  image:
    "postgres:17-alpine@sha256:dc17045ccfd343b49600570ea734b9c4991cf1c3f3302e67df51e3b402dd55c4",
  role: "derived-rebuildable-index",
  hostBinding: "none-internal-compose-network-only",
});
assert.deepEqual(selection.runtime.cache, {
  proofMinimalBackendRedisEnabled: false,
  proofScope:
    "The reused #89 compose proves only a minimal backend/API indexer without Redis.",
  fullUpstreamStackRedisRequired: true,
  approvedRedisImage: null,
  approvedRuntimeRedisEnabled: false,
  reason:
    "The exact-commit upstream full-stack compose depends on Redis, but no digest-pinned Redis image or full-stack local proof is approved yet.",
});
assert.deepEqual(selection.runtime.fullUpstreamStack, {
  status: "not-approved-runtime",
  componentBoundary: {
    approvedLocalProof: ["backend-indexer-api", "postgresql"],
    requiredByFullUpstreamButUnapproved: ["redis"],
    notSelected: [
      "frontend",
      "stats",
      "smart-contract-verifier",
      "visualizer",
      "signature-provider",
      "user-operations-indexer",
    ],
  },
  resourceEnvelope: "upstream-guidance-only-not-torium-measured",
  releaseCadence: {
    status: "upstream-reviewed",
    releaseLine: "v11",
    observedReleases: 10,
    windowStart: "2026-05-01",
    windowEnd: "2026-07-03",
  },
  upgradePath: "not-exercised",
});
assert.deepEqual(selection.runtime.network, {
  apiHostBinding: "127.0.0.1:44000",
  databasePublishedToHost: false,
  publicEndpointsAllowed: false,
  proofComposeIsApprovedRuntimeConfig: false,
  proofComposeKnownBinding: "0.0.0.0:44000",
  requiredRuntimeBindingChange:
    "Replace the proof-only 44000:4000 mapping with 127.0.0.1:44000:4000 before reuse.",
});

assert.deepEqual(selection.rpcDependency, {
  ownerIssue: 114,
  targetProfileManifest: "chain/profiles/node-roles-v0.json",
  targetProfileId: "private-archive-indexer",
  targetProfileActivated: archiveTargetActivated,
  requiredProfile: "private-non-validator-archive-indexer-rpc",
  status: archiveTargetActivated
    ? "target-activated-gateway-enforced-local"
    : "target-defined-runtime-conformance-blocking",
  currentLocalProfile: "chain/config/rpc-profile-v1.json",
  currentLocalProfileSatisfiesRequirement: false,
  validatorOrPublicProfileWideningAllowed: false,
  privateAllowlistedTransportRequired: true,
  archiveHistoricalStateRequired: true,
  fullGenesisHistoryRequiredForRebuild: true,
  standardMethodContractStatus: archiveTargetActivated
    ? "candidate-reconciled-against-activated-gateway"
    : "candidate-not-reconciled",
  requiredStandardMethods: [],
  candidateStandardMethods: [
    "web3_clientVersion",
    "net_version",
    "net_listening",
    "net_peerCount",
    "eth_chainId",
    "eth_blockNumber",
    "eth_syncing",
    "eth_gasPrice",
    "eth_getBalance",
    "eth_getBlockByNumber",
    "eth_getBlockByHash",
    "eth_getTransactionByHash",
    "eth_getTransactionReceipt",
    "eth_getLogs",
    "eth_call",
    "eth_getCode",
    "eth_getStorageAt",
    "eth_estimateGas",
    "eth_feeHistory",
    "eth_getTransactionCount",
  ],
  traceRequirementStatus: "none-in-v0-internal-transactions-disabled",
  requiredTraceMethods: [],
  provenButNotEnabledTraceMethods: [
    "debug_traceTransaction",
    "debug_traceCall",
    "debug_traceBlockByNumber",
    "debug_traceBlockByHash",
  ],
});

assert.equal(
  selection.features.baseBlocksAndTransactions,
  "supported-by-reused-local-proof"
);
// Receipt, log and balance reconciliation is claimable only while the evidence
// runner actually asserts each one against canonical RPC. The claim is derived
// from the runner's source, not from this contract's own say-so.
const stackEvidenceRunner = await readFile(
  path.join(repositoryRoot, "chain/explorer/run-stack-evidence-v0.sh"),
  "utf8"
);
const reconciliationSurfaces = [
  "sender-recipient-value-reconciled-against-rpc",
  "account-balance-reconciled-against-rpc",
  "address-indexed-with-its-transaction",
  "native-ttor-metadata-matches-identifiers",
];
assert.equal(
  selection.features.receiptsLogsAndBalances,
  reconciliationSurfaces.every((surface) => stackEvidenceRunner.includes(surface))
    ? "reconciled-against-canonical-rpc"
    : "not-reconciled"
);
assert.equal(
  selection.features.contractAndTokenPresentation,
  "explorer-native-not-torium-source-of-truth"
);
assert.equal(selection.features.contractVerification, "not-proven");
assert.deepEqual(selection.features.internalTransactions, {
  status: "disabled-known-incompatibility",
  environmentVariable: "INDEXER_DISABLE_INTERNAL_TRANSACTIONS_FETCHER",
  requiredValue: "true",
  cosmosEvmTraceEntryKeys: ["result"],
  blockscoutRequiredTraceEntryKeys: ["result", "txHash"],
  adapterOrForkSelected: false,
  userFacingSupportClaimAllowed: false,
});

assert.deepEqual(selection.sourceOfTruth, {
  chainRpc: "authoritative",
  explorerPostgres: "derived-rebuildable-index",
  toriumBackend: "prohibited-as-chain-source-of-truth",
  toriumBackendTablesAllowed: false,
  reconciliationRequiredBeforeReady: [
    "indexed-height-and-block-hash",
    "transaction-receipts-and-logs",
    "account-balances",
  ],
});

assertExactKeys(selection.operations, [
  "freshGenesisAutoFollow",
  "emptyDatabaseCatchupToExistingHeight",
  "restartPersistence",
  "controlledSingleBlockRefetch",
  "fullDestructiveReindex",
  "rollbackAndReorgRecovery",
  "assumptions",
]);
assert.equal(selection.operations.freshGenesisAutoFollow, "not-proven");
assert.equal(
  selection.operations.emptyDatabaseCatchupToExistingHeight,
  "reused-local-proof"
);
assert.equal(selection.operations.restartPersistence, "reused-local-proof");
assert.equal(
  selection.operations.controlledSingleBlockRefetch,
  "reused-local-proof"
);
for (const field of ["fullDestructiveReindex", "rollbackAndReorgRecovery"]) {
  assert.equal(selection.operations[field], "not-proven");
}
assertIdSet(selection.operations.assumptions, [
  "restart-preserves-postgres-volume",
  "reindex-requires-private-archive-history",
  "database-reset-is-explicit-and-destructive",
  "reorg-recovery-is-unproven",
]);
for (const assumption of selection.operations.assumptions) {
  assertExactKeys(assumption, ["id", "state", "requirement"]);
  assert.ok(assumption.state.length >= 8);
  assert.ok(assumption.requirement.length >= 40);
}

assert.deepEqual(selection.legalGate, {
  required: true,
  status: "pending",
  reviewAuthority: "qualified-legal-counsel",
  requiredBefore: ["public-operation", "distribution", "production-use"],
  approvalReference: null,
  publicOperationAllowed: false,
  distributionAllowed: false,
});

const expectedEvidence = [
  [
    "upstream-pins",
    "chain/poc/upstream-baseline/pins.json",
    "cc677553cd6e7890b895e4cec345d1a937de31c3a7fa253dec1eee7208ef3538",
    "version-license-and-postgres-pin",
  ],
  [
    "support-matrix",
    "chain/poc/upstream-baseline/support-matrix.json",
    "a177bf4d71e8d2054f0709e0774e84335997b470ddad9f2987224cef13d41842",
    "base-indexing-and-internal-transaction-support-status",
  ],
  [
    "blockscout-proof",
    "chain/poc/upstream-baseline/proof/blockscout.json",
    "e93f13768aded37d26427ec1d6d1fa853046b96892a02b35712e51a526961557",
    "empty-database-catchup-restart-marker-clear-and-trace-envelope-mismatch",
  ],
  [
    "rpc-compatibility-proof",
    "chain/poc/upstream-baseline/proof/rpc-compatibility.json",
    "f29fe6bbb509815dbb577088e7f83a56b3b72915c989e87f14c298a17ca7f7ee",
    "raw-rpc-support-context-only",
  ],
  [
    "proof-compose",
    "chain/poc/upstream-baseline/blockscout-compose.yml",
    "dbcede9173edb7f26802e5e57df68936d9b88c3177f31cd3877ad08427895bf5",
    "proof-reproduction-reference-not-approved-runtime-config",
  ],
  [
    "source-build-script",
    "chain/poc/upstream-baseline/scripts/build-blockscout.sh",
    "787e4b203ecaea928c1152e34f22033ba8a556b7647fa83a054a8b2a6acb18a6",
    "exact-tag-and-commit-source-build",
  ],
  [
    "proof-probe-script",
    "chain/poc/upstream-baseline/scripts/probe-blockscout.sh",
    "6bfde1073e7ba621c48d0a23fbe6e072476670606a747babb407aa9d9842cc92",
    "historical-proof-method-reference-only",
  ],
  [
    "current-local-rpc-profile",
    "chain/config/rpc-profile-v1.json",
    "865cc2af1bc787415542ade5a72506a036a448edda1de7b0719bc3c0e0dab22a",
    "combined-role-loopback-evidence-does-not-activate-114-target-profiles",
  ],
].map(([id, evidencePath, sha256, reuse]) => ({
  id,
  path: evidencePath,
  sha256,
  reuse,
}));
assert.deepEqual(selection.evidence, expectedEvidence);
for (const evidence of selection.evidence) {
  assertExactKeys(evidence, ["id", "path", "sha256", "reuse"]);
  assert.match(evidence.sha256, /^[0-9a-f]{64}$/u);
  const bytes = await readEvidence(evidence.path);
  assert.equal(
    createHash("sha256").update(bytes).digest("hex"),
    evidence.sha256,
    `evidence checksum drift: ${evidence.path}`
  );
}

assertIdSet(selection.alternatives, [
  "blockscout-v11-source-build",
  "blockscout-trace-adapter-or-fork",
  "torium-custom-indexer",
  "otterscan-v2-11-0-erigon",
  "routescan-managed-service",
  "existing-torscan-product-backend",
]);
assert.deepEqual(
  Object.fromEntries(
    selection.alternatives.map(({ id, decision }) => [id, decision])
  ),
  {
    "blockscout-v11-source-build": "conditional-local-selection",
    "blockscout-trace-adapter-or-fork": "deferred",
    "torium-custom-indexer": "rejected",
    "otterscan-v2-11-0-erigon": "rejected",
    "routescan-managed-service": "rejected-for-current-scope",
    "existing-torscan-product-backend": "rejected",
  }
);
for (const alternative of selection.alternatives) {
  assertExactKeys(alternative, ["id", "decision", "reason"]);
  assert.ok(alternative.reason.length >= 40);
}

assertIdSet(selection.releaseGates, [
  "private-archive-profile-114",
  "legal-approval",
  "runtime-local-bindings",
  "full-stack-dependencies",
  "reindex-reorg-contract",
  "internal-transactions",
]);
for (const gate of selection.releaseGates) {
  assertExactKeys(gate, ["id", "state", "requirement"]);
  assert.ok(["blocked", "accepted-local-limitation"].includes(gate.state));
  assert.ok(gate.requirement.length >= 40);
}
assert.equal(
  selection.releaseGates.find(({ id }) => id === "internal-transactions").state,
  "accepted-local-limitation"
);
assert.ok(
  selection.releaseGates
    .filter(({ id }) => id !== "internal-transactions")
    .every(({ state }) => state === "blocked")
);

const pins = await readEvidenceJson("chain/poc/upstream-baseline/pins.json");
assert.deepEqual(pins.compatibilityTools.blockscout, {
  repository: selection.selected.repository,
  release: selection.selected.release,
  commit: selection.selected.commit,
  tagSignature: "not-signed",
  license: selection.selected.license,
  databaseImage: selection.runtime.database.image,
});

const proof = await readEvidenceJson(
  "chain/poc/upstream-baseline/proof/blockscout.json"
);
assert.deepEqual(proof.blockscout, {
  release: selection.selected.release,
  commit: selection.selected.commit,
});
assert.equal(proof.profile.internalTransactionFetcherDisabled, true);
assert.ok(proof.freshIndex.databaseBlocks > 0);
assert.ok(proof.freshIndex.databaseTransactions > 0);
assert.equal(proof.restart.preserved, true);
assert.equal(proof.controlledReindex.markerCleared, true);
assert.equal(proof.internalTransactions.state, "unsupported");
assert.deepEqual(
  proof.internalTransactions.cosmosEvmTraceEntryKeys,
  selection.features.internalTransactions.cosmosEvmTraceEntryKeys
);
assert.deepEqual(
  proof.internalTransactions.blockscoutRequiredEntryKeys,
  selection.features.internalTransactions.blockscoutRequiredTraceEntryKeys
);

const support = await readEvidenceJson(
  "chain/poc/upstream-baseline/support-matrix.json"
);
const baseIndexing = support.capabilities.find(
  ({ id }) => id === "explorer.blockscout-base-indexing"
);
const internalTransactions = support.capabilities.find(
  ({ id }) => id === "explorer.blockscout-internal-transactions"
);
assert.equal(baseIndexing.state, "supported");
assert.ok(baseIndexing.consumerIssues.includes(112));
assert.equal(internalTransactions.state, "unsupported");
assert.ok(internalTransactions.consumerIssues.includes(112));
assert.match(
  internalTransactions.constraint,
  /INDEXER_DISABLE_INTERNAL_TRANSACTIONS_FETCHER=true/u
);

const compose = (
  await readEvidence("chain/poc/upstream-baseline/blockscout-compose.yml")
).toString("utf8");
assert.ok(compose.includes(`image: ${selection.runtime.database.image}`));
assert.ok(
  compose.includes(
    'INDEXER_DISABLE_INTERNAL_TRANSACTIONS_FETCHER: "${BLOCKSCOUT_DISABLE_INTERNAL_TRANSACTIONS_FETCHER:-true}"'
  )
);
assert.ok(compose.includes('- "44000:4000"'));
assert.equal(compose.includes('- "127.0.0.1:44000:4000"'), false);

const buildScript = (
  await readEvidence("chain/poc/upstream-baseline/scripts/build-blockscout.sh")
).toString("utf8");
assert.ok(buildScript.includes(`TAG="${selection.selected.release}"`));
assert.ok(buildScript.includes(`COMMIT="${selection.selected.commit}"`));
assert.ok(
  buildScript.includes(
    'REPOSITORY="https://github.com/blockscout/blockscout.git"'
  )
);

const rpcProfile = await readEvidenceJson(
  selection.rpcDependency.currentLocalProfile
);
assert.equal(rpcProfile.status, "active-local-only");
assert.equal(rpcProfile.exposure.publicEndpointsAllowed, false);
assert.ok(
  rpcProfile.ethereum.namespaces.operatorOnlyNotEnabled.includes("debug")
);
assert.ok(
  rpcProfile.deferred.includes(
    "private archive/indexer history runtime (#114); #112 requires zero debug trace methods in v0"
  )
);

const nodeRoles = await readEvidenceJson(
  selection.rpcDependency.targetProfileManifest
);
const archiveRole = nodeRoles.roles.find(
  ({ id }) => id === selection.rpcDependency.targetProfileId
);
assert.ok(archiveRole, "#114 archive/indexer target role is missing");
// The pinned manifest and the one read up front must be the same file.
assert.deepEqual(archiveRole, archiveTargetRole);
assert.ok(
  ["defined-inactive-local-equivalent", "active-local-gateway-fronted"].includes(
    archiveRole.activation
  )
);
const archiveEvmPolicy =
  nodeRoles.runtimePolicies[archiveRole.runtimePolicyRefs.evm];
assert.equal(archiveEvmPolicy.id, "evm-archive-blockscout-candidate-v0");
assert.equal(
  selection.rpcDependency.standardMethodContractStatus,
  archiveTargetActivated
    ? "candidate-reconciled-against-activated-gateway"
    : "candidate-not-reconciled"
);
assert.deepEqual(selection.rpcDependency.requiredStandardMethods, []);
assert.deepEqual(
  archiveEvmPolicy.candidateMethodContract,
  selection.rpcDependency.candidateStandardMethods
);
assert.equal(
  archiveEvmPolicy.candidateMethodContract.includes("eth_sendRawTransaction"),
  false
);
const publicRole = nodeRoles.roles.find(({ id }) => id === "public-rpc");
assert.ok(publicRole, "#114 public RPC target role is missing");
assert.notEqual(
  publicRole.runtimePolicyRefs.evm,
  archiveRole.runtimePolicyRefs.evm
);
const archiveGateway = nodeRoles.consumerGateways["archive-indexer-v0"];
assert.ok(archiveGateway, "#114 archive policy gateway target is missing");
assert.equal(
  archiveGateway.runtimePolicyRef,
  archiveRole.runtimePolicyRefs.evm
);
assert.equal(archiveGateway.enforcedContractField, "candidateMethodContract");
// Whatever the gateway's activation state, the consumer must never be able to
// reach the raw archive RPC, and the raw listeners must stay unpublished.
assert.equal(archiveGateway.rawRpcReachableFromConsumers, false);
assert.equal(archiveGateway.activated, archiveTargetActivated);
assert.equal(archiveGateway.effectiveConformanceProven, archiveTargetActivated);
assert.equal(archiveRole.services.evmHttp.hostPublish, null);
assert.equal(archiveRole.services.evmWebSocket.hostPublish, null);
assert.deepEqual(
  nodeRoles.tracePolicy.requiredMethods,
  selection.rpcDependency.requiredTraceMethods
);
assert.deepEqual(
  nodeRoles.tracePolicy.provenButDisabledMethods,
  selection.rpcDependency.provenButNotEnabledTraceMethods
);

process.stdout.write(
  `${JSON.stringify(
    {
      valid: true,
      selectionVersion: selection.selectionVersion,
      status: selection.status,
      explorer: `${selection.selected.name} ${selection.selected.release}`,
      commit: selection.selected.commit,
      internalTransactions: selection.features.internalTransactions.status,
      legalApproval: selection.legalGate.status,
      rpcDependencyIssue: selection.rpcDependency.ownerIssue,
      verifiedEvidence: selection.evidence.length,
    },
    null,
    2
  )}\n`
);

function assertExactKeys(value, keys) {
  assert.ok(
    value !== null && typeof value === "object" && !Array.isArray(value)
  );
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort());
}

function assertIdSet(values, expected) {
  assert.ok(Array.isArray(values));
  const ids = values.map(({ id }) => id);
  assert.equal(new Set(ids).size, ids.length, "IDs must be unique");
  assert.deepEqual(new Set(ids), new Set(expected));
}

async function readEvidence(repositoryPath) {
  assert.match(repositoryPath, /^chain\/[a-zA-Z0-9._/-]+$/u);
  assert.equal(repositoryPath.split("/").includes(".."), false);
  const absolutePath = path.resolve(repositoryRoot, repositoryPath);
  assert.ok(absolutePath.startsWith(`${repositoryRoot}${path.sep}`));
  const stats = await lstat(absolutePath);
  assert.ok(stats.isFile() && !stats.isSymbolicLink());
  return readFile(absolutePath);
}

async function readEvidenceJson(repositoryPath) {
  const bytes = await readEvidence(repositoryPath);
  assertNoDuplicateJsonKeys(bytes.toString("utf8"));
  return JSON.parse(bytes.toString("utf8"));
}

async function readStrictJson(absolutePath) {
  const source = await readFile(absolutePath, "utf8");
  assertNoDuplicateJsonKeys(source);
  return JSON.parse(source);
}

function assertNoDuplicateJsonKeys(text) {
  let offset = 0;
  parseValue();
  skipWhitespace();
  assert.equal(offset, text.length, `unexpected JSON token at byte ${offset}`);

  function parseValue() {
    skipWhitespace();
    const token = text[offset];
    if (token === "{") return parseObject();
    if (token === "[") return parseArray();
    if (token === '"') return parseString();
    if (token === "t") return consume("true");
    if (token === "f") return consume("false");
    if (token === "n") return consume("null");
    return parseNumber();
  }

  function parseObject() {
    offset += 1;
    skipWhitespace();
    const keys = new Set();
    if (text[offset] === "}") return void (offset += 1);
    while (offset < text.length) {
      skipWhitespace();
      const key = parseString();
      assert.equal(keys.has(key), false, `duplicate JSON object key: ${key}`);
      keys.add(key);
      skipWhitespace();
      expect(":");
      parseValue();
      skipWhitespace();
      if (text[offset] === "}") return void (offset += 1);
      expect(",");
    }
    throw new Error("unterminated JSON object");
  }

  function parseArray() {
    offset += 1;
    skipWhitespace();
    if (text[offset] === "]") return void (offset += 1);
    while (offset < text.length) {
      parseValue();
      skipWhitespace();
      if (text[offset] === "]") return void (offset += 1);
      expect(",");
    }
    throw new Error("unterminated JSON array");
  }

  function parseString() {
    const start = offset;
    expect('"');
    while (offset < text.length) {
      const character = text[offset];
      offset += 1;
      if (character === '"') return JSON.parse(text.slice(start, offset));
      if (character === "\\") offset += 1;
    }
    throw new Error("unterminated JSON string");
  }

  function parseNumber() {
    const match = text
      .slice(offset)
      .match(/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/u);
    assert.ok(match, `unexpected JSON token at byte ${offset}`);
    offset += match[0].length;
  }

  function consume(literal) {
    assert.equal(text.startsWith(literal, offset), true);
    offset += literal.length;
  }

  function expect(character) {
    assert.equal(
      text[offset],
      character,
      `expected ${character} at byte ${offset}`
    );
    offset += 1;
  }

  function skipWhitespace() {
    while (/\s/u.test(text[offset] ?? "")) offset += 1;
  }
}
