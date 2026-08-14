#!/usr/bin/env node

import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const directory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(directory, "../..");
const rootRequire = createRequire(path.join(repositoryRoot, "package.json"));
const Ajv2020 = rootRequire("ajv/dist/2020").default;

const [stack, schema, selection, nodeRoles] = await Promise.all([
  readJson("chain/explorer/stack-v0.json"),
  readJson("chain/explorer/stack-v0.schema.json"),
  readJson("chain/explorer/selection-v1.json"),
  readJson("chain/profiles/node-roles-v0.json"),
]);

assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
assert.equal(schema.additionalProperties, false);
const validateSchema = new Ajv2020({ strict: true, allErrors: true }).compile(
  schema
);
assert.equal(
  validateSchema(stack),
  true,
  `explorer stack schema validation failed: ${JSON.stringify(
    validateSchema.errors
  )}`
);

assertExactKeys(stack, [
  "$schema",
  "schemaVersion",
  "stackVersion",
  "status",
  "ownerIssue",
  "sources",
  "constraints",
  "selectionContract",
  "archiveGatewayContract",
  "network",
  "components",
  "startupPlan",
  "readiness",
  "operations",
  "sourceVerification",
  "holds",
]);
assert.equal(stack.$schema, "./stack-v0.schema.json");
assert.equal(stack.schemaVersion, 1);
assert.match(stack.stackVersion, /^0\.1\.0-local\.[1-9][0-9]*$/u);
assert.ok(
  ["inactive-local-only-hold", "activated-local-only-hold"].includes(stack.status),
  "the explorer stack stays local-only whether or not it is activated"
);
assert.equal(stack.ownerIssue, 113);
assert.deepEqual(stack.sources, {
  selection: {
    path: "chain/explorer/selection-v1.json",
    ownerIssue: selection.ownerIssue,
    selectionVersion: selection.selectionVersion,
  },
  nodeRoles: {
    path: "chain/profiles/node-roles-v0.json",
    ownerIssue: nodeRoles.ownerIssue,
    profileVersion: nodeRoles.profileVersion,
  },
});

assert.deepEqual(stack.constraints, {
  environment: "local-development-only",
  activated: false,
  composeOrRuntimeConfigIncluded: false,
  liveDeploymentAllowed: false,
  publicOperationAllowed: false,
  publicEndpointsAllowed: false,
  loopbackHostPublishingOnly: true,
  toriumBackendIntegrationInScope: false,
  toriumBackendAuthorityAllowed: false,
  chainRpcAuthority: "authoritative",
  explorerDatabaseAuthority: "derived-rebuildable-index",
});
assert.equal(selection.constraints.liveDeploymentAllowed, false);
assert.equal(selection.constraints.publicOperationAllowed, false);
assert.equal(selection.constraints.backendIntegrationInScope, false);
assert.equal(selection.sourceOfTruth.toriumBackendTablesAllowed, false);
assert.equal(
  selection.sourceOfTruth.chainRpc,
  stack.constraints.chainRpcAuthority
);
assert.equal(
  selection.sourceOfTruth.explorerPostgres,
  stack.constraints.explorerDatabaseAuthority
);

assert.deepEqual(stack.selectionContract, {
  name: selection.selected.name,
  repository: selection.selected.repository,
  release: selection.selected.release,
  commit: selection.selected.commit,
  distribution: selection.selected.distribution,
  prebuiltImageAccepted: selection.selected.prebuiltImageAccepted,
  localImageTag: selection.selected.localImageTag,
  localImageTagIsSecurityIdentity:
    selection.selected.localImageTagIsSecurityIdentity,
  license: selection.selected.license,
  internalTransactionsEnabled: false,
  requiredTraceMethods: selection.rpcDependency.requiredTraceMethods,
});
assert.equal(selection.features.internalTransactions.requiredValue, "true");
assert.equal(
  selection.features.internalTransactions.userFacingSupportClaimAllowed,
  false
);
assert.deepEqual(stack.selectionContract.requiredTraceMethods, []);

const profileGateway = nodeRoles.consumerGateways["archive-indexer-v0"];
const archiveRole = nodeRoles.roles.find(
  ({ id }) => id === "private-archive-indexer"
);
assert.ok(profileGateway && archiveRole);
// The archive gateway contract is a MIRROR of the node-role profile, which
// derives its own activation from the generator, compose overlay, enforcement
// source, and evidence lane. Mirroring it here means the explorer cannot claim
// an activation the profile has not earned.
assert.deepEqual(stack.archiveGatewayContract, {
  gatewayId: profileGateway.id,
  status: profileGateway.status,
  consumerIdentity: "blockscout",
  consumerNetwork: profileGateway.consumerNetwork.id,
  rawUpstreamNetwork: profileGateway.rawUpstreamNetwork.id,
  rawRpcReachableFromConsumer: profileGateway.rawRpcReachableFromConsumers,
  runtimePolicyRef: profileGateway.runtimePolicyRef,
  enforcedContractField: profileGateway.enforcedContractField,
  httpEndpoint: "http://archive-rpc-gateway:8545",
  webSocketEndpoint: "ws://archive-rpc-gateway:8546",
  loopbackHttpReservation: profileGateway.listeners.evmHttp.hostPublish,
  loopbackWebSocketReservation:
    profileGateway.listeners.evmWebSocket.hostPublish,
  activated: profileGateway.activated,
  effectiveConformanceProven: profileGateway.effectiveConformanceProven,
});
assert.equal(profileGateway.consumers.includes("blockscout"), true);
assert.equal(
  profileGateway.consumerNetwork.members.includes("blockscout"),
  true
);
assert.equal(
  profileGateway.rawUpstreamNetwork.members.includes("blockscout"),
  false
);
assert.notEqual(
  stack.archiveGatewayContract.consumerNetwork,
  stack.archiveGatewayContract.rawUpstreamNetwork
);
assert.equal(stack.archiveGatewayContract.rawRpcReachableFromConsumer, false);
// An activated gateway must have the two artifacts that make it real: the
// compose overlay that separates the networks and the evidence runner that
// proves the allowlist fails closed.
if (stack.archiveGatewayContract.activated) {
  assert.equal(stack.archiveGatewayContract.effectiveConformanceProven, true);
  await access(
    path.join(repositoryRoot, "chain/profiles/compose.archive-gateway.yaml")
  );
  await access(
    path.join(repositoryRoot, "chain/profiles/run-archive-gateway-evidence-v0.sh")
  );
} else {
  assert.equal(stack.archiveGatewayContract.effectiveConformanceProven, false);
}
assert.equal(
  selection.rpcDependency.targetProfileActivated,
  stack.archiveGatewayContract.activated
);
// Activating the archive target does NOT make the current local RPC profile
// (validator-0's public surface) acceptable to the indexer, and never permits
// widening a validator or public profile to stand in for it.
assert.equal(
  selection.rpcDependency.currentLocalProfileSatisfiesRequirement,
  false
);
assert.equal(
  selection.rpcDependency.validatorOrPublicProfileWideningAllowed,
  false
);
assert.equal(
  archiveRole.runtimePolicyRefs.evm,
  profileGateway.runtimePolicyRef
);
assert.equal(archiveRole.services.evmHttp.hostPublish, null);
assert.equal(archiveRole.services.evmWebSocket.hostPublish, null);
assert.equal(archiveRole.services.evmHttp.exposure, "gateway-upstream-only");
assert.equal(
  archiveRole.services.evmWebSocket.exposure,
  "gateway-upstream-only"
);
const archiveStorage = nodeRoles.storagePolicies[archiveRole.storagePolicyRef];
assert.equal(archiveStorage.targetFromGenesis, true);
// Storage activation, gateway activation, and the runtime policy's enforcement
// claim are one fact seen from three contracts; they must never disagree.
assert.equal(archiveStorage.activated, stack.archiveGatewayContract.activated);
assert.equal(
  archiveStorage.evidenceComplete,
  stack.archiveGatewayContract.effectiveConformanceProven
);
const archivePolicy =
  nodeRoles.runtimePolicies[profileGateway.runtimePolicyRef];
assert.equal(
  archivePolicy.status,
  stack.archiveGatewayContract.activated
    ? "candidate-gateway-enforced-local"
    : "candidate-not-activated"
);
assert.equal(
  archivePolicy.gatewayActivated,
  stack.archiveGatewayContract.activated
);
assert.equal(
  archivePolicy.effectiveConformanceProven,
  stack.archiveGatewayContract.effectiveConformanceProven
);
assert.deepEqual(
  archivePolicy[profileGateway.enforcedContractField],
  selection.rpcDependency.candidateStandardMethods
);
assert.equal(
  archivePolicy[profileGateway.enforcedContractField].some((method) =>
    method.startsWith("eth_send")
  ),
  false
);

assertExactKeys(stack.network, [
  "networks",
  "hostReservations",
  "postgresPublishedToHost",
  "redisPublishedToHost",
  "rawArchiveRpcPublishedToHost",
  "publicIngressConfigured",
]);
assert.deepEqual(
  stack.network.networks.map(({ id }) => id),
  ["explorer-data", "archive-indexer-consumer", "explorer-ui"]
);
assert.deepEqual(network("archive-indexer-consumer").members, [
  "archive-rpc-gateway",
  "blockscout-indexer",
]);
for (const networkContract of stack.network.networks) {
  assert.equal(networkContract.consumerPublishedToHost, false);
}
for (const field of [
  "postgresPublishedToHost",
  "redisPublishedToHost",
  "rawArchiveRpcPublishedToHost",
  "publicIngressConfigured",
]) {
  assert.equal(stack.network[field], false);
}
const reservedBindings = new Set();
for (const reservation of stack.network.hostReservations) {
  assert.match(reservation.binding, /^127\.0\.0\.1:[1-9][0-9]*$/u);
  assert.equal(reservedBindings.has(reservation.binding), false);
  reservedBindings.add(reservation.binding);
}
assert.deepEqual(
  stack.network.hostReservations.map(({ owner, binding }) => [owner, binding]),
  [
    ["blockscout-backend-api", "127.0.0.1:44000"],
    ["blockscout-frontend", "127.0.0.1:44001"],
    ["archive-rpc-gateway-http", "127.0.0.1:38545"],
    ["archive-rpc-gateway-websocket", "127.0.0.1:38546"],
  ]
);

const expectedComponentIds = [
  "postgresql",
  "redis",
  "blockscout-migrations",
  "blockscout-backend-api",
  "blockscout-indexer",
  "blockscout-frontend",
  "smart-contract-verifier",
  "visualizer",
  "signature-provider",
  "stats",
  "user-operations-indexer",
];
assert.deepEqual(
  stack.components.map(({ id }) => id),
  expectedComponentIds
);
assert.equal(new Set(expectedComponentIds).size, stack.components.length);
const componentIds = new Set(expectedComponentIds);
const networkIds = new Set(stack.network.networks.map(({ id }) => id));
const allowedExternalNetworkMembers = new Set(["archive-rpc-gateway"]);
for (const networkContract of stack.network.networks) {
  for (const member of networkContract.members) {
    assert.equal(
      componentIds.has(member) || allowedExternalNetworkMembers.has(member),
      true,
      `unknown member ${member} in network ${networkContract.id}`
    );
  }
}
for (const component of stack.components) {
  assertExactKeys(component, [
    "id",
    "kind",
    "requirement",
    "targetEnabled",
    "activated",
    "artifact",
    "dependsOn",
    "networkMembership",
    "hostPublish",
    "readiness",
    "authority",
  ]);
  // An activated component must carry an immutable digest pin; a component
  // without one can never claim activation.
  if (component.activated) {
    assert.match(
      component.artifact.immutablePinStatus,
      /-approved$/u,
      `${component.id} claims activation without an approved digest pin`
    );
    assert.match(
      component.artifact.imageWithDigest ?? "",
      /@sha256:[0-9a-f]{64}$/u,
      `${component.id} claims activation without a digest-pinned image`
    );
  }
  assert.equal(component.authority.includes("torium-backend-authority"), false);
  for (const dependency of component.dependsOn) {
    assert.ok(
      componentIds.has(dependency) ||
        dependency === "external:archive-rpc-gateway"
    );
  }
  for (const membership of component.networkMembership) {
    assert.equal(networkIds.has(membership), true);
    assert.equal(network(membership).members.includes(component.id), true);
  }
  if (component.hostPublish !== null) {
    assert.match(component.hostPublish, /^127\.0\.0\.1:[1-9][0-9]*$/u);
    assert.equal(reservedBindings.has(component.hostPublish), true);
  }
}

const postgres = component("postgresql");
assert.equal(
  postgres.artifact.imageWithDigest,
  selection.runtime.database.image
);
assert.equal(
  postgres.artifact.immutablePinStatus,
  "exact-image-digest-approved"
);
assert.equal(postgres.hostPublish, null);
assert.equal(
  selection.runtime.database.hostBinding,
  "none-internal-compose-network-only"
);
const redis = component("redis");
assert.equal(selection.runtime.cache.fullUpstreamStackRedisRequired, true);
assert.equal(selection.runtime.cache.approvedRedisImage, null);
// Redis may be unpinned (HOLD) or pinned by exact digest, never a floating
// tag.
if (redis.artifact.immutablePinStatus === "exact-image-digest-approved") {
  assert.match(redis.artifact.imageWithDigest, /@sha256:[0-9a-f]{64}$/u);
} else {
  assert.equal(redis.artifact.imageWithDigest, null);
  assert.equal(
    redis.artifact.immutablePinStatus,
    "HOLD-missing-exact-image-digest"
  );
}

for (const id of [
  "blockscout-migrations",
  "blockscout-backend-api",
  "blockscout-indexer",
]) {
  const value = component(id);
  assert.equal(value.artifact.sourceRepository, selection.selected.repository);
  assert.equal(value.artifact.sourceRelease, selection.selected.release);
  assert.equal(value.artifact.sourceCommit, selection.selected.commit);
  assert.equal(value.artifact.localImageTag, selection.selected.localImageTag);
  // The runtime image is either unpinned (HOLD) or pinned to the exact
  // locally built digest; every pinned component must share one digest so
  // migrations, API, and indexer can never diverge.
  if (
    value.artifact.immutablePinStatus === "exact-local-build-digest-approved"
  ) {
    assert.match(value.artifact.imageWithDigest, /@sha256:[0-9a-f]{64}$/u);
    assert.equal(
      value.artifact.imageWithDigest,
      component("blockscout-migrations").artifact.imageWithDigest,
      `${id} runtime digest diverges from the migrations image`
    );
  } else {
    assert.equal(value.artifact.imageWithDigest, null);
    assert.equal(
      value.artifact.immutablePinStatus,
      "HOLD-exact-source-runtime-image-digest-missing"
    );
  }
}
assert.equal(
  component("blockscout-backend-api").hostPublish,
  "127.0.0.1:44000"
);
assert.deepEqual(component("blockscout-indexer").dependsOn, [
  "postgresql",
  "redis",
  "blockscout-migrations",
  "external:archive-rpc-gateway",
]);
assert.equal(
  component("blockscout-indexer").networkMembership.includes(
    "archive-indexer-consumer"
  ),
  true
);

const frontend = component("blockscout-frontend");
assert.equal(frontend.requirement, "required-ui");
assert.equal(frontend.targetEnabled, true);
// The UI pin is claimable only with the overlay that runs it and the evidence
// runner that verifies it — upstream declares no compatible frontend version for
// this backend release, so the compatibility claim is entirely local and must
// have a local proof.
if (frontend.artifact.immutablePinStatus === "exact-image-digest-approved") {
  assert.match(frontend.artifact.imageWithDigest, /@sha256:[0-9a-f]{64}$/u);
  assert.equal(
    frontend.artifact.sourceRepository,
    "https://github.com/blockscout/frontend"
  );
  assert.match(frontend.artifact.sourceCommit, /^[0-9a-f]{40}$/u);
  assert.match(frontend.artifact.sourceRelease, /^v[0-9]+\.[0-9]+\.[0-9]+$/u);
  await access(path.join(repositoryRoot, "chain/explorer/compose.frontend.yaml"));
  await access(
    path.join(repositoryRoot, "chain/explorer/run-frontend-evidence-v0.sh")
  );
  const frontendOverlay = await readFile(
    path.join(repositoryRoot, "chain/explorer/compose.frontend.yaml"),
    "utf8"
  );
  // The overlay must run exactly the pinned digest, never a tag.
  assert.ok(
    frontendOverlay.includes(frontend.artifact.imageWithDigest),
    "the frontend overlay does not run the pinned digest"
  );
  const frontendEvidence = await readFile(
    path.join(repositoryRoot, "chain/explorer/run-frontend-evidence-v0.sh"),
    "utf8"
  );
  // The runner must prove the RUNNING image is that source revision; a digest
  // pin alone says nothing about what the container reports itself to be.
  assert.ok(
    frontendEvidence.includes(
      "running-image-revision-matches-the-recorded-source-commit"
    ),
    "the frontend evidence runner does not verify the running image's revision"
  );
  assert.notEqual(frontend.readiness.status, "HOLD-not-exercised");
} else {
  assert.equal(
    frontend.artifact.immutablePinStatus,
    "HOLD-missing-exact-source-and-image-pin"
  );
  assert.equal(frontend.artifact.imageWithDigest, null);
  assert.equal(frontend.activated, false);
}
// The frontend remains outside the APPROVED upstream stack boundary either way:
// selecting an image locally is not an upstream compatibility statement.
assert.equal(
  selection.runtime.fullUpstreamStack.componentBoundary.notSelected.includes(
    "frontend"
  ),
  true
);
const verifier = component("smart-contract-verifier");
assert.equal(verifier.requirement, "required-for-issue-closure");
assert.equal(verifier.targetEnabled, false);
assert.equal(
  selection.runtime.fullUpstreamStack.componentBoundary.notSelected.includes(
    "smart-contract-verifier"
  ),
  true
);
for (const id of [
  "visualizer",
  "signature-provider",
  "stats",
  "user-operations-indexer",
]) {
  const value = component(id);
  assert.equal(value.requirement, "optional-off");
  assert.equal(value.targetEnabled, false);
  assert.equal(value.networkMembership.length, 0);
  assert.equal(value.hostPublish, null);
  assert.equal(value.readiness.status, "disabled");
}

assert.deepEqual(
  stack.startupPlan.map(({ order, id }) => [order, id]),
  [
    [0, "hold-gate"],
    [1, "data-services"],
    [2, "database-migrations"],
    [3, "api-and-indexers"],
    [4, "frontend"],
    [5, "reconciliation"],
  ]
);
assert.equal(stack.startupPlan[0].readiness, "HOLD");
assert.deepEqual(stack.startupPlan[5].requires, [
  "indexed-height-and-block-hash",
  "transaction-receipts-and-logs",
  "account-balances",
  "address-indexing-and-native-ttor-metadata",
  "contract-and-token-presentation",
]);
// The stack cannot claim readiness while ANY required check is outstanding, and
// it may not claim a passed check the evidence lane does not prove. The mapping
// below ties each claimable check to the surface the runner emits for it, so the
// passed list is derived from the runner's source rather than declared here.
// Two sources: the runner asserts the runtime behaviour, and the compose file
// carries the migration step whose success the runner's health wait depends on.
const [stackEvidenceRunner, stackComposeFile, frontendEvidenceRunner] =
  await Promise.all([
    readFile(
      path.join(repositoryRoot, "chain/explorer/run-stack-evidence-v0.sh"),
      "utf8"
    ),
    readFile(
      path.join(repositoryRoot, "chain/explorer/compose.explorer.yaml"),
      "utf8"
    ),
    // Absent is a legitimate state: without the UI evidence runner the frontend
    // health check simply cannot be claimed.
    readFile(
      path.join(repositoryRoot, "chain/explorer/run-frontend-evidence-v0.sh"),
      "utf8"
    ).catch(() => ""),
  ]);
const stackEvidenceSources = `${stackEvidenceRunner}\n${stackComposeFile}\n${frontendEvidenceRunner}`;
const checkEvidenceSurfaces = new Map([
  ["postgresql-ready", ["up --detach --wait database redis"]],
  ["redis-ready", ["up --detach --wait database redis"]],
  ["migrations-complete", ["ReleaseTasks.create_and_migrate", "wait_backend 420"]],
  ["backend-health-contract-passes", ["wait_backend 420"]],
  [
    "archive-gateway-activated-and-conformant",
    [
      "indexer-reconciled-through-archive-gateway-only",
      "raw-archive-rpc-unreachable-from-the-indexer",
      "historical-state-served-through-the-gateway",
    ],
  ],
  ["indexer-at-chain-head", ["indexer-reached-chain-tip"]],
  [
    "indexed-height-and-block-hash",
    ["derived-state-rollback-healed-and-reconciled-against-rpc"],
  ],
  [
    "transaction-receipts-and-logs",
    ["sender-recipient-value-reconciled-against-rpc"],
  ],
  ["account-balances", ["account-balance-reconciled-against-rpc"]],
  [
    "address-indexing-and-native-ttor-metadata",
    ["address-indexed-with-its-transaction", "native-ttor-metadata-matches-identifiers"],
  ],
  // Derived from the components themselves rather than a surface string: every
  // component whose requirement is not "optional-off" must carry an approved
  // immutable pin. A reproducible REBUILD of a pinned image is a separate
  // property, tracked by blockscout-runtime-digest-missing.
  [
    "all-required-component-pins-approved",
    [],
  ],
  [
    "frontend-health-contract-passes",
    [
      "running-image-revision-matches-the-recorded-source-commit",
      "effective-identity-matches-reviewed-identifiers-and-canonical-chain-id",
      "ui-routes-render",
    ],
  ],
]);
// all-required-component-pins-approved has no evidence-surface string: it is a
// property of the component list, so it is computed here and spliced into the
// same both-directions check as everything else.
const requiredPinsApproved = stack.components
  .filter(({ requirement }) => requirement !== "optional-off")
  .every(({ artifact }) => /-approved$/u.test(artifact.immutablePinStatus));
if (requiredPinsApproved) {
  assert.ok(
    stack.readiness.passedChecks.includes("all-required-component-pins-approved"),
    "every required component carries an approved pin but the check is still held"
  );
} else {
  assert.ok(
    stack.readiness.failedOrHeldChecks.includes(
      "all-required-component-pins-approved"
    ),
    "a required component lacks an approved pin but the check claims to pass"
  );
}
for (const check of stack.readiness.passedChecks) {
  if (check === "all-required-component-pins-approved") continue;
  const surfaces = checkEvidenceSurfaces.get(check);
  assert.ok(
    surfaces !== undefined,
    `${check} claims to pass but has no mapped evidence surface`
  );
  for (const surface of surfaces) {
    assert.ok(
      stackEvidenceSources.includes(surface),
      `${check} claims to pass but the evidence runner does not assert ${surface}`
    );
  }
}
// A check whose evidence exists must not be left in the held list: that would
// under-report the state as badly as over-reporting it.
for (const [check, surfaces] of checkEvidenceSurfaces) {
  if (check === "all-required-component-pins-approved") continue;
  if (surfaces.every((surface) => stackEvidenceSources.includes(surface))) {
    assert.ok(
      stack.readiness.passedChecks.includes(check),
      `${check} is proven by the evidence runner but is still listed as held`
    );
  }
}
// Anything the mapping cannot claim must remain held; the explorer's own
// readiness claim stays false while a single check is outstanding.
for (const check of stack.readiness.failedOrHeldChecks) {
  if (check === "all-required-component-pins-approved") continue;
  assert.equal(
    checkEvidenceSurfaces.has(check) &&
      checkEvidenceSurfaces
        .get(check)
        .every((surface) => stackEvidenceSources.includes(surface)),
    false,
    `${check} is held but the evidence runner proves it`
  );
}
assert.equal(
  stack.readiness.stackReady,
  stack.readiness.failedOrHeldChecks.length === 0
);
assert.equal(
  stack.readiness.readinessClaimAllowed,
  stack.readiness.failedOrHeldChecks.length === 0
);
assert.equal(
  new Set(stack.readiness.requiredChecks).size,
  stack.readiness.requiredChecks.length
);
assert.equal(
  new Set(stack.readiness.failedOrHeldChecks).size,
  stack.readiness.failedOrHeldChecks.length
);
assert.deepEqual(
  new Set([
    ...stack.readiness.passedChecks,
    ...stack.readiness.failedOrHeldChecks,
  ]),
  new Set(stack.readiness.requiredChecks)
);
assert.equal(
  stack.readiness.passedChecks.some((check) =>
    stack.readiness.failedOrHeldChecks.includes(check)
  ),
  false
);
for (const heldCheck of stack.readiness.failedOrHeldChecks) {
  assert.equal(stack.readiness.requiredChecks.includes(heldCheck), true);
}
for (const requiredReconciliation of selection.sourceOfTruth
  .reconciliationRequiredBeforeReady) {
  assert.equal(
    stack.readiness.requiredChecks.includes(requiredReconciliation),
    true
  );
}

assert.equal(stack.operations.restartPreservingIndex.activated, false);
assert.equal(stack.operations.resetExplorerIndex.activated, false);
assert.equal(
  stack.operations.resetExplorerIndex.requiresExplicitOperatorConfirmation,
  true
);
assert.deepEqual(stack.operations.resetExplorerIndex.mustNotDelete, [
  "chain-state",
  "validator-state",
  "torium-backend-data",
]);
assert.equal(stack.operations.fullReindex.activated, false);
assert.equal(stack.operations.fullReindex.status, "HOLD-not-proven");
assert.equal(stack.operations.rollbackOrReorgRecovery.activated, false);
assert.equal(
  stack.operations.rollbackOrReorgRecovery.status,
  "HOLD-not-proven"
);
assert.equal(selection.operations.fullDestructiveReindex, "not-proven");
assert.equal(selection.operations.rollbackAndReorgRecovery, "not-proven");

// Pinning the verifier and its compiler is necessary but NOT sufficient: the
// verifier fetches its compiler list over the network by default, and network
// download is forbidden here, so verification stays disabled and unclaimable
// until offline provisioning of the pinned compiler is built and proven.
assert.equal(stack.sourceVerification.enabled, false);
assert.equal(stack.sourceVerification.status, "HOLD-not-proven");
assert.equal(stack.sourceVerification.verifierComponent, "smart-contract-verifier");
assert.equal(stack.sourceVerification.compilerNetworkDownloadAllowed, false);
assert.equal(stack.sourceVerification.verificationClaimAllowed, false);
// The verifier's pin claim must match its component's actual pin status.
assert.equal(
  stack.sourceVerification.verifierExactPinApproved,
  verifier.artifact.immutablePinStatus === "exact-image-digest-approved"
);
// An allowlisted compiler must be digest-pinned and must name the reviewed
// source it came from, so the allowlist cannot drift from chain/toolchain.json.
const toolchain = JSON.parse(
  await readFile(path.join(repositoryRoot, "chain/toolchain.json"), "utf8")
);
for (const compiler of stack.sourceVerification.approvedCompilerArtifacts) {
  assert.match(compiler.image, /@sha256:[0-9a-f]{64}$/u);
  assert.equal(compiler.compiler, "solc");
  assert.equal(compiler.image, toolchain.contracts.solidity.image);
  assert.equal(compiler.version, toolchain.contracts.solidity.version);
  assert.equal(compiler.longVersion, toolchain.contracts.solidity.longVersion);
  assert.equal(compiler.binaryPath, toolchain.contracts.solidity.binaryPath);
}
assert.equal(
  stack.sourceVerification.compilerPinStatus,
  stack.sourceVerification.approvedCompilerArtifacts.length > 0
    ? "exact-compiler-image-digest-approved-offline-provisioning-unproven"
    : "HOLD-no-compiler-version-digest-allowlist"
);
assert.equal(selection.features.contractVerification, "not-proven");

const expectedHoldOwnership = [
  { id: "archive-gateway-inactive", ownerIssue: 114, evidenceIssues: [113] },
  { id: "blockscout-runtime-digest-missing", ownerIssue: 113, evidenceIssues: [122] },
  { id: "redis-pin-missing", ownerIssue: 113, evidenceIssues: [] },
  { id: "frontend-pin-missing", ownerIssue: 113, evidenceIssues: [] },
  { id: "readiness-and-reindex-unproven", ownerIssue: 113, evidenceIssues: [114] },
  { id: "source-verification-pins-missing", ownerIssue: 113, evidenceIssues: [] },
  { id: "seed-contract-deployment-not-defined", ownerIssue: 113, evidenceIssues: [] },
  { id: "validator-presentation-source-undefined", ownerIssue: 113, evidenceIssues: [] },
  { id: "explorer-presentation-reconciliation-unproven", ownerIssue: 113, evidenceIssues: [] },
  { id: "legal-approval-pending", ownerIssue: 113, evidenceIssues: [] },
];
const expectedHoldIds = expectedHoldOwnership.map(({ id }) => id);
assert.deepEqual(
  stack.holds.map(({ id, ownerIssue, evidenceIssues }) => ({
    id,
    ownerIssue,
    evidenceIssues,
  })),
  expectedHoldOwnership
);
for (const hold of stack.holds) {
  assert.ok(["HOLD", "HOLD-if-enabled", "PARTIAL", "RESOLVED"].includes(hold.state));
  assert.ok(hold.requirement.length >= 40);
}
assert.equal(selection.legalGate.status, "pending");
assert.equal(selection.legalGate.publicOperationAllowed, false);

process.stdout.write(
  `${JSON.stringify(
    {
      valid: true,
      stackVersion: stack.stackVersion,
      status: stack.status,
      components: expectedComponentIds,
      holdIds: expectedHoldIds,
      activated: stack.constraints.activated,
      publicOperationAllowed: stack.constraints.publicOperationAllowed,
    },
    null,
    2
  )}\n`
);

function component(id) {
  const value = stack.components.find((candidate) => candidate.id === id);
  assert.ok(value, `missing component ${id}`);
  return value;
}

function network(id) {
  const value = stack.network.networks.find((candidate) => candidate.id === id);
  assert.ok(value, `missing network ${id}`);
  return value;
}

function assertExactKeys(value, keys) {
  assert.ok(
    value !== null && typeof value === "object" && !Array.isArray(value)
  );
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort());
}

async function readJson(repositoryPath) {
  assert.match(repositoryPath, /^chain\/[a-zA-Z0-9._/-]+\.json$/u);
  assert.equal(repositoryPath.split("/").includes(".."), false);
  const absolutePath = path.resolve(repositoryRoot, repositoryPath);
  assert.ok(absolutePath.startsWith(`${repositoryRoot}${path.sep}`));
  return JSON.parse(await readFile(absolutePath, "utf8"));
}
