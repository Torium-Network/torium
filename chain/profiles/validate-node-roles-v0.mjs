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
const [manifest, schema, identifiers, protocol, localRpc, explorer] =
  await Promise.all([
    readJson("chain/profiles/node-roles-v0.json"),
    readJson("chain/profiles/node-roles-v0.schema.json"),
    readJson("chain/config/identifiers.json"),
    readJson("chain/config/protocol-v1.json"),
    readJson("chain/config/rpc-profile-v1.json"),
    readJson("chain/explorer/selection-v1.json"),
  ]);

// The #114 archive lane's activation is DERIVED from the sources that would
// have to exist for it to be true, never asserted as a constant. Each source is
// read once here so the archive assertions below can compute the rule rather
// than restate a decision.
const archiveSources = await readArchiveSources();
const archiveLaneImplemented =
  // (a) the generator instantiates the 5th, non-validator node,
  archiveSources.generator.includes(`ArchiveNodeName = "private-archive-indexer"`) &&
  /cfg\.Pruning = archivePruningStrategy/u.test(archiveSources.generator) &&
  /cfg\.RPC\.ListenAddress = ""/u.test(archiveSources.generator) &&
  archiveSources.localnetCommand.includes(`flag.Bool("archive"`) &&
  // (b) the sidecar enforces the reviewed contract field in front of it, with a
  //     whole-batch refusal and a loopback/container-bind guard,
  archiveSources.gatewayPolicy.includes("AllowsHTTPMethod") &&
  archiveSources.gatewayServer.includes("batchRefusalMessage") &&
  archiveSources.gatewayServer.includes("func ValidateContainerBind") &&
  archiveSources.gatewayCommand.includes("archivegateway.ValidateContainerBind") &&
  // (c) two separate Docker networks put the gateway alone on the boundary,
  archiveSources.compose.includes("archive-raw-rpc") &&
  archiveSources.compose.includes("archive-indexer-consumer") &&
  archiveSources.compose.includes("internal: true") &&
  // (d) and an executable evidence lane proves the fail-closed behaviour.
  archiveSources.evidenceRunner.includes("archive-gateway-activation-v0") &&
  archiveSources.streamProbe.includes("archive-gateway-stream-transport-v0");

assertExactKeys(manifest, [
  "$schema",
  "schemaVersion",
  "profileVersion",
  "status",
  "ownerIssue",
  "publicLaunchAllowed",
  "publicClientScope",
  "publicCosmosApiDelegatedIssue",
  "sources",
  "localNetwork",
  "tracePolicy",
  "runtimePolicies",
  "storagePolicies",
  "consumerGateways",
  "roles",
]);
assert.equal(manifest.$schema, "./node-roles-v0.schema.json");
assert.equal(manifest.schemaVersion, 1);
assert.match(manifest.profileVersion, /^0\.1\.0-local\.[1-9][0-9]*$/u);
assert.equal(manifest.status, "defined-local-v0-not-activated-publicly");
assert.equal(manifest.ownerIssue, 114);
assert.equal(manifest.publicLaunchAllowed, false);
assert.equal(manifest.publicClientScope, "evm-only-v0");
assert.equal(manifest.publicCosmosApiDelegatedIssue, 131);
assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
assert.equal(schema.additionalProperties, false);
assert.deepEqual(new Set(schema.required), new Set(Object.keys(manifest)));
const validateSchema = new Ajv2020({ strict: true, allErrors: true }).compile(
  schema
);
assert.equal(
  validateSchema(manifest),
  true,
  `node-role schema validation failed: ${JSON.stringify(validateSchema.errors)}`
);

assert.deepEqual(manifest.sources, {
  identifiers: {
    path: "chain/config/identifiers.json",
    manifestVersion: identifiers.manifestVersion,
  },
  protocol: {
    path: "chain/config/protocol-v1.json",
    protocolVersion: protocol.protocolVersion,
  },
  currentLocalRpcProfile: {
    path: "chain/config/rpc-profile-v1.json",
    profileVersion: localRpc.profileVersion,
  },
  explorerSelection: {
    path: "chain/explorer/selection-v1.json",
    selectionVersion: explorer.selectionVersion,
    ownerIssue: 112,
  },
});

const localIdentifier = identifiers.networks.find(
  ({ environment }) => environment === "localnet"
);
const localProtocol = protocol.networkProfiles.find(
  ({ environment }) => environment === "localnet"
);
assert.ok(localIdentifier && localProtocol);
assert.deepEqual(manifest.localNetwork, {
  environment: "localnet",
  cosmosChainId: localIdentifier.cosmos.chainId,
  evmChainId: localIdentifier.evm.chainId,
  evmChainIdHex: localIdentifier.evm.chainIdHex,
  public: false,
});
assert.equal(localProtocol.cosmosChainId, manifest.localNetwork.cosmosChainId);
assert.equal(localProtocol.evmChainId, manifest.localNetwork.evmChainId);
assert.equal(localProtocol.publicEndpointsAllowed, false);
assert.equal(localRpc.status, "active-local-only");
assert.equal(localRpc.exposure.hostPublishing, "loopback-only");
assert.equal(localRpc.exposure.publicEndpointsAllowed, false);

assert.deepEqual(manifest.tracePolicy.requiredMethods, []);
assert.deepEqual(
  manifest.tracePolicy.requiredMethods,
  explorer.rpcDependency.requiredTraceMethods
);
assert.deepEqual(
  manifest.tracePolicy.provenButDisabledMethods,
  explorer.rpcDependency.provenButNotEnabledTraceMethods
);
assert.equal(explorer.rpcDependency.ownerIssue, 114);
assert.equal(
  explorer.rpcDependency.requiredProfile,
  "private-non-validator-archive-indexer-rpc"
);
assert.equal(
  explorer.rpcDependency.validatorOrPublicProfileWideningAllowed,
  false
);
assert.equal(manifest.tracePolicy.operatorNamespaceEnabledOnAnyRole, false);
assert.equal(
  manifest.tracePolicy.activationRequiresNewProfileVersionAndConformance,
  true
);

assert.deepEqual(Object.keys(manifest.runtimePolicies), [
  "disabled",
  "comet-diagnostic-v0",
  "cosmos-query-v0",
  "evm-public-v0",
  "evm-archive-blockscout-candidate-v0",
]);
assert.deepEqual(manifest.runtimePolicies.disabled, {
  id: "disabled",
  enabled: false,
});
assert.deepEqual(manifest.runtimePolicies["comet-diagnostic-v0"], {
  id: "comet-diagnostic-v0",
  enabled: true,
  unsafe: false,
  corsOrigins: [],
  pprofAddress: "",
  deprecatedGrpcAddress: "",
  nativePerMethodAllowlistSupported: false,
  enforcementLayer: "required-policy-gateway",
  gatewayActivated: false,
  effectiveConformanceProven: false,
  limits: {
    maxOpenConnections: 256,
    subscriptionBufferSize: 200,
    webSocketWriteBufferSize: 200,
    maxSubscriptionClients: 100,
    maxSubscriptionsPerClient: 5,
    maxRequestBodyBytes: 1000000,
    maxRequestHeaderBytes: 1048576,
    maxBatchRequests: 20,
  },
  consumerMethodContract: [
    "health",
    "status",
    "net_info",
    "blockchain",
    "block",
    "block_results",
    "commit",
    "validators",
  ],
});
assert.deepEqual(manifest.runtimePolicies["cosmos-query-v0"], {
  id: "cosmos-query-v0",
  enabled: true,
  rest: {
    maxOpenConnections: 256,
    maxRequestBodyBytes: 1000000,
    readTimeoutSeconds: 10,
    writeTimeoutSeconds: 10,
    unsafeCors: false,
    swagger: false,
  },
  grpc: {
    maxReceiveBytes: 10485760,
    maxSendBytes: 33554432,
    skipCheckHeader: false,
    grpcWebEnabled: false,
  },
});
const publicEvmPolicy = manifest.runtimePolicies["evm-public-v0"];
const archiveEvmPolicy =
  manifest.runtimePolicies["evm-archive-blockscout-candidate-v0"];
// evm-public-v0 fronts the public-rpc role, which the localnet never
// instantiates and for which no gateway exists, so its enforcement can never be
// activated here. The archive policy's status is derived from the lane.
assertEvmPolicy(publicEvmPolicy, {
  id: "evm-public-v0",
  status: "defined-local-loopback-only",
  contractField: "consumerMethodContract",
  gatewayImplemented: false,
});
assertEvmPolicy(archiveEvmPolicy, {
  id: "evm-archive-blockscout-candidate-v0",
  status: archiveLaneImplemented
    ? "candidate-gateway-enforced-local"
    : "candidate-not-activated",
  contractField: "candidateMethodContract",
  gatewayImplemented: archiveLaneImplemented,
});
assert.equal(
  publicEvmPolicy.consumerMethodContract.includes("eth_sendRawTransaction"),
  true
);
assert.deepEqual(
  archiveEvmPolicy.candidateMethodContract,
  publicEvmPolicy.consumerMethodContract.filter(
    (method) => method !== "eth_sendRawTransaction"
  )
);
for (const method of archiveEvmPolicy.candidateMethodContract) {
  assert.doesNotMatch(method, /^eth_send/u);
}
assert.deepEqual(manifest.tracePolicy.requiredMethods, []);

// A storage policy claims activation only when a runtime actually applies it.
// The localnet's validators still run the default SDK pruning, so the two
// validator/query targets stay inactive; the archive target is applied by the
// generated archive home, which the derivation above proves exists.
const expectedStorage = {
  "consensus-minimal-v0": {
    pruningStrategy: "default",
    txIndex: "null",
    targetFromGenesis: false,
    activated: false,
  },
  "query-v0": {
    pruningStrategy: "default",
    txIndex: "kv",
    targetFromGenesis: false,
    activated: false,
  },
  "archive-indexer-v0": {
    pruningStrategy: "nothing",
    txIndex: "kv",
    targetFromGenesis: true,
    activated: archiveLaneImplemented,
  },
};
assert.deepEqual(
  Object.keys(manifest.storagePolicies),
  Object.keys(expectedStorage)
);
for (const [id, policy] of Object.entries(manifest.storagePolicies)) {
  assertExactKeys(policy, [
    "id",
    "pruningStrategy",
    "keepRecent",
    "interval",
    "minRetainBlocks",
    "txIndex",
    "indexEvents",
    "snapshotInterval",
    "snapshotKeepRecent",
    "discardAbciResponses",
    "queryWindowBlocks",
    "queryWindowStatus",
    "targetFromGenesis",
    "activated",
    "evidenceComplete",
  ]);
  assert.equal(policy.id, id);
  assert.equal(policy.pruningStrategy, expectedStorage[id].pruningStrategy);
  assert.equal(policy.txIndex, expectedStorage[id].txIndex);
  assert.equal(policy.targetFromGenesis, expectedStorage[id].targetFromGenesis);
  assert.equal(policy.activated, expectedStorage[id].activated);
  assert.equal(policy.keepRecent, 0);
  assert.equal(policy.interval, 0);
  assert.equal(policy.minRetainBlocks, 0);
  assert.deepEqual(policy.indexEvents, []);
  assert.equal(policy.snapshotInterval, 0);
  assert.equal(policy.snapshotKeepRecent, 2);
  assert.equal(policy.discardAbciResponses, false);
  assert.equal(policy.queryWindowBlocks, null);
  // Activation and evidence move together: an activated policy has been
  // exercised, an inactive one has not.
  assert.equal(policy.evidenceComplete, expectedStorage[id].activated);
  // A full history window may only be claimed by a policy that keeps every
  // height. Anything that prunes cannot answer a genesis-height query.
  if (policy.queryWindowStatus === "proven-full-history-from-genesis") {
    assert.equal(policy.pruningStrategy, "nothing");
    assert.equal(policy.targetFromGenesis, true);
    assert.equal(policy.activated, true);
  } else {
    assert.equal(policy.queryWindowStatus, "unproven");
  }
}
assert.equal(
  manifest.storagePolicies["consensus-minimal-v0"].activated,
  false,
  "the validator storage target must not claim activation against the current default-pruning runtime"
);
assert.equal(
  manifest.storagePolicies["query-v0"].activated,
  false,
  "the query storage target has no instantiated local role"
);

assertExactKeys(manifest.consumerGateways, ["archive-indexer-v0"]);
const archiveGateway = manifest.consumerGateways["archive-indexer-v0"];
assert.deepEqual(archiveGateway, {
  id: "archive-indexer-v0",
  status: archiveLaneImplemented
    ? "activated-local-private-sidecar"
    : "inactive-private-sidecar-target",
  gatewayIdentity: "archive-rpc-gateway",
  consumers: ["blockscout", "operator"],
  consumerNetwork: {
    id: "archive-indexer-consumer",
    members: ["archive-rpc-gateway", "blockscout", "operator"],
  },
  rawUpstreamNetwork: {
    id: "archive-raw-rpc",
    members: ["archive-rpc-gateway", "private-archive-indexer"],
  },
  rawArchiveRole: "private-archive-indexer",
  rawRpcReachableFromConsumers: false,
  runtimePolicyRef: "evm-archive-blockscout-candidate-v0",
  enforcedContractField: "candidateMethodContract",
  activated: archiveLaneImplemented,
  effectiveConformanceProven: archiveLaneImplemented,
  listeners: {
    evmHttp: {
      containerBind: "0.0.0.0:8545",
      hostPublish: "127.0.0.1:38545",
      upstream: "http://private-archive-indexer:8545",
    },
    evmWebSocket: {
      containerBind: "0.0.0.0:8546",
      hostPublish: "127.0.0.1:38546",
      upstream: "ws://private-archive-indexer:8546",
    },
  },
});
assert.notEqual(
  archiveGateway.consumerNetwork.id,
  archiveGateway.rawUpstreamNetwork.id
);
assert.deepEqual(
  archiveGateway.consumerNetwork.members.filter((member) =>
    archiveGateway.rawUpstreamNetwork.members.includes(member)
  ),
  [archiveGateway.gatewayIdentity]
);
for (const consumer of archiveGateway.consumers) {
  assert.equal(archiveGateway.consumerNetwork.members.includes(consumer), true);
  assert.equal(
    archiveGateway.rawUpstreamNetwork.members.includes(consumer),
    false
  );
}
assert.equal(
  archiveGateway.rawUpstreamNetwork.members.includes(
    archiveGateway.rawArchiveRole
  ),
  true
);
assert.equal(
  archiveGateway.consumerNetwork.members.includes(
    archiveGateway.rawArchiveRole
  ),
  false
);
assert.equal(
  Object.hasOwn(
    manifest.runtimePolicies[archiveGateway.runtimePolicyRef],
    archiveGateway.enforcedContractField
  ),
  true
);
// The gateway's whole purpose is that consumers never reach the raw RPC. That
// stays false whether or not the lane is activated; activation only means the
// enforcement point now exists.
assert.equal(archiveGateway.rawRpcReachableFromConsumers, false);
assert.equal(archiveGateway.activated, archiveLaneImplemented);
assert.equal(
  archiveGateway.effectiveConformanceProven,
  archiveLaneImplemented,
  "the gateway may only claim proven conformance while its enforcement lane exists"
);
// An activated gateway must enforce the same allowlist its runtime policy
// names. The Go contract test (chain/app/archivegateway/policy_test.go) proves
// the equality against the reviewed JSON; this asserts the test exists, so the
// two can never drift silently.
if (archiveGateway.activated) {
  assert.ok(
    archiveSources.gatewayPolicyTest.includes(
      "TestDefaultPolicyMatchesReviewedArchiveContract"
    ),
    "an activated gateway needs the contract-equality test that keeps its allowlist honest"
  );
  assert.ok(
    archiveSources.gatewayPolicyTest.includes(archiveGateway.enforcedContractField),
    "the gateway contract test must read the enforced contract field"
  );
}

const expectedRoleIds = [
  "validator",
  "sentry",
  "full",
  "public-rpc",
  "private-archive-indexer",
];
assert.deepEqual(
  manifest.roles.map(({ id }) => id),
  expectedRoleIds
);
assert.equal(new Set(expectedRoleIds).size, manifest.roles.length);

const roleIds = new Set(expectedRoleIds);
const expectedServicePorts = {
  cometRpc: protocol.ports.defaults.cometRpc,
  evmHttp: protocol.ports.defaults.jsonRpcHttp,
  evmWebSocket: protocol.ports.defaults.jsonRpcWebSocket,
  cosmosRest: protocol.ports.defaults.rest,
  cosmosGrpc: protocol.ports.defaults.grpc,
  pprof: protocol.ports.defaults.pprof,
};
const publishedHostPorts = new Map();

for (const role of manifest.roles) {
  assertExactKeys(role, [
    "id",
    "activation",
    "localEquivalent",
    "publicLaunchAllowed",
    "consensusKey",
    "p2p",
    "services",
    "runtimePolicyRefs",
    "storagePolicyRef",
    "resources",
  ]);
  assert.equal(role.publicLaunchAllowed, false);
  assert.ok(role.localEquivalent.length >= 30);

  assertExactKeys(role.consensusKey, [
    "registeredValidatorSetKeyPermitted",
    "registeredValidatorSetMembershipRequired",
    "unregisteredLocalFilePvPermitted",
    "filePvKeyRelativePath",
    "filePvStateRelativePath",
    "stateMonotonicRequired",
    "filePvPubkeyMustNotMatchRegisteredValidatorSet",
  ]);
  assert.equal(
    role.consensusKey.filePvKeyRelativePath,
    "config/priv_validator_key.json"
  );
  assert.equal(
    role.consensusKey.filePvStateRelativePath,
    "data/priv_validator_state.json"
  );
  assert.equal(role.consensusKey.stateMonotonicRequired, true);
  if (role.id === "validator") {
    assert.equal(role.consensusKey.registeredValidatorSetKeyPermitted, true);
    assert.equal(
      role.consensusKey.registeredValidatorSetMembershipRequired,
      true
    );
    assert.equal(role.consensusKey.unregisteredLocalFilePvPermitted, false);
    assert.equal(
      role.consensusKey.filePvPubkeyMustNotMatchRegisteredValidatorSet,
      false
    );
  } else {
    assert.equal(role.consensusKey.registeredValidatorSetKeyPermitted, false);
    assert.equal(
      role.consensusKey.registeredValidatorSetMembershipRequired,
      false
    );
    assert.equal(role.consensusKey.unregisteredLocalFilePvPermitted, true);
    assert.equal(
      role.consensusKey.filePvPubkeyMustNotMatchRegisteredValidatorSet,
      true,
      `${role.id} FilePV pubkey must not match genesis/current validator set`
    );
  }

  assertExactKeys(role.p2p, [
    "mode",
    "listen",
    "hostPublish",
    "persistentPeerRoles",
    "unconditionalPeerRoles",
    "privatePeerRoles",
    "addressBookStrict",
    "allowDuplicateIp",
    "seedsAllowed",
    "seedRoles",
    "externalAddressAdvertised",
    "privatePeerIdsRequired",
    "maximumInboundPeers",
    "maximumOutboundPeers",
    "pexEnabled",
  ]);
  assert.equal(role.p2p.listen, `0.0.0.0:${protocol.ports.defaults.p2p}`);
  assertLoopback(role.p2p.hostPublish, `${role.id} P2P host publication`);
  registerHostPublication(role.p2p.hostPublish, `${role.id}.p2p`);
  assert.equal(role.p2p.privatePeerIdsRequired, true);
  assert.equal(role.p2p.addressBookStrict, false);
  assert.equal(role.p2p.allowDuplicateIp, true);
  assert.equal(role.p2p.seedsAllowed, false);
  assert.deepEqual(role.p2p.seedRoles, []);
  assert.equal(role.p2p.externalAddressAdvertised, false);
  assert.ok(Number.isInteger(role.p2p.maximumInboundPeers));
  assert.ok(Number.isInteger(role.p2p.maximumOutboundPeers));
  assert.ok(
    role.p2p.maximumInboundPeers > 0 && role.p2p.maximumOutboundPeers > 0
  );
  for (const peerRole of [
    ...role.p2p.persistentPeerRoles,
    ...role.p2p.unconditionalPeerRoles,
    ...role.p2p.privatePeerRoles,
  ]) {
    assert.ok(roleIds.has(peerRole));
  }

  assertExactKeys(role.services, [
    "cometRpc",
    "evmHttp",
    "evmWebSocket",
    "cosmosRest",
    "cosmosGrpc",
    "pprof",
  ]);
  for (const [serviceName, service] of Object.entries(role.services)) {
    assertExactKeys(service, [
      "enabled",
      "containerBind",
      "hostPublish",
      "exposure",
    ]);
    if (!service.enabled) {
      assert.equal(service.containerBind, null);
      assert.equal(service.hostPublish, null);
      assert.equal(service.exposure, "disabled");
    } else {
      assert.equal(
        service.containerBind,
        `0.0.0.0:${expectedServicePorts[serviceName]}`,
        `${role.id}.${serviceName} must bind the documented container port`
      );
      const isArchiveRawRpc =
        role.id === "private-archive-indexer" &&
        ["evmHttp", "evmWebSocket"].includes(serviceName);
      if (isArchiveRawRpc) {
        assert.equal(service.hostPublish, null);
        assert.equal(service.exposure, "gateway-upstream-only");
      } else {
        assertLoopback(
          service.hostPublish,
          `${role.id}.${serviceName} host publication`
        );
        registerHostPublication(
          service.hostPublish,
          `${role.id}.${serviceName}`
        );
        assert.notEqual(service.exposure, "public");
      }
    }
  }
  assert.equal(role.services.pprof.enabled, false);

  assertExactKeys(role.runtimePolicyRefs, ["comet", "cosmos", "evm"]);
  for (const policyId of Object.values(role.runtimePolicyRefs)) {
    assert.ok(
      Object.hasOwn(manifest.runtimePolicies, policyId),
      `${role.id} references unknown runtime policy ${policyId}`
    );
  }
  assert.equal(
    role.services.cometRpc.enabled,
    role.runtimePolicyRefs.comet !== "disabled"
  );
  assert.equal(
    role.services.cosmosRest.enabled,
    role.runtimePolicyRefs.cosmos !== "disabled"
  );
  assert.equal(
    role.services.cosmosGrpc.enabled,
    role.runtimePolicyRefs.cosmos !== "disabled"
  );
  assert.equal(
    role.services.evmHttp.enabled,
    role.runtimePolicyRefs.evm !== "disabled"
  );
  assert.equal(
    role.services.evmWebSocket.enabled,
    role.runtimePolicyRefs.evm !== "disabled"
  );
  assert.ok(
    Object.hasOwn(manifest.storagePolicies, role.storagePolicyRef),
    `${role.id} references unknown storage policy ${role.storagePolicyRef}`
  );

  assertExactKeys(role.resources, [
    "status",
    "cpuCores",
    "memoryGiB",
    "diskGiB",
    "sustainedIops",
    "publicCapacityClaimed",
    "scalingSignals",
  ]);
  assert.equal(role.resources.status, "planning-floor-not-benchmarked");
  for (const field of ["cpuCores", "memoryGiB", "diskGiB", "sustainedIops"]) {
    assert.ok(
      Number.isInteger(role.resources[field]) && role.resources[field] > 0
    );
  }
  assert.equal(role.resources.publicCapacityClaimed, false);
  assert.ok(role.resources.scalingSignals.length >= 4);
  assert.equal(
    new Set(role.resources.scalingSignals).size,
    role.resources.scalingSignals.length
  );
}

for (const [serviceName, listener] of Object.entries(
  archiveGateway.listeners
)) {
  assertLoopback(
    listener.hostPublish,
    `consumer-gateway.${archiveGateway.id}.${serviceName} host publication`
  );
  registerHostPublication(
    listener.hostPublish,
    `consumer-gateway.${archiveGateway.id}.${serviceName}`
  );
}

assert.deepEqual(
  Object.fromEntries([...publishedHostPorts.entries()].sort()),
  Object.fromEntries(
    Object.entries({
      "127.0.0.1:26656": "validator.p2p",
      "127.0.0.1:26657": "validator.cometRpc",
      "127.0.0.1:27056": "sentry.p2p",
      "127.0.0.1:27156": "full.p2p",
      "127.0.0.1:27157": "full.cometRpc",
      "127.0.0.1:18545": "full.evmHttp",
      "127.0.0.1:18546": "full.evmWebSocket",
      "127.0.0.1:11317": "full.cosmosRest",
      "127.0.0.1:19090": "full.cosmosGrpc",
      "127.0.0.1:27256": "public-rpc.p2p",
      "127.0.0.1:28545": "public-rpc.evmHttp",
      "127.0.0.1:28546": "public-rpc.evmWebSocket",
      "127.0.0.1:27356": "private-archive-indexer.p2p",
      "127.0.0.1:38545": "consumer-gateway.archive-indexer-v0.evmHttp",
      "127.0.0.1:38546": "consumer-gateway.archive-indexer-v0.evmWebSocket",
    }).sort()
  )
);

const validator = role("validator");
assert.equal(
  validator.activation,
  "active-local-partial-topology-evidence-only"
);
assert.deepEqual(validator.p2p.persistentPeerRoles, ["sentry"]);
assert.deepEqual(validator.p2p.unconditionalPeerRoles, ["sentry"]);
assert.deepEqual(validator.p2p.privatePeerRoles, ["sentry"]);
assert.equal(validator.p2p.persistentPeerRoles.includes("validator"), false);
for (const service of [
  "evmHttp",
  "evmWebSocket",
  "cosmosRest",
  "cosmosGrpc",
  "pprof",
]) {
  assert.equal(
    validator.services[service].enabled,
    false,
    `validator leaks ${service}`
  );
}
assert.equal(validator.services.cometRpc.exposure, "loopback-diagnostic-only");
assert.deepEqual(validator.runtimePolicyRefs, {
  comet: "comet-diagnostic-v0",
  cosmos: "disabled",
  evm: "disabled",
});
assert.equal(validator.storagePolicyRef, "consensus-minimal-v0");

const sentry = role("sentry");
assert.ok(
  Object.values(sentry.services).every(({ enabled }) => enabled === false)
);
assert.equal(sentry.p2p.unconditionalPeerRoles.includes("validator"), true);
assert.deepEqual(sentry.runtimePolicyRefs, {
  comet: "disabled",
  cosmos: "disabled",
  evm: "disabled",
});
assert.equal(sentry.storagePolicyRef, "consensus-minimal-v0");

const publicRpc = role("public-rpc");
assert.equal(publicRpc.activation, "defined-inactive-local-equivalent");
assert.equal(publicRpc.services.cometRpc.enabled, false);
assert.equal(publicRpc.services.pprof.enabled, false);
assert.equal(publicRpc.services.cosmosRest.enabled, false);
assert.equal(publicRpc.services.cosmosGrpc.enabled, false);
assert.deepEqual(publicRpc.runtimePolicyRefs, {
  comet: "disabled",
  cosmos: "disabled",
  evm: "evm-public-v0",
});
assert.equal(publicRpc.storagePolicyRef, "query-v0");

const full = role("full");
assert.deepEqual(full.runtimePolicyRefs, {
  comet: "comet-diagnostic-v0",
  cosmos: "cosmos-query-v0",
  evm: "evm-public-v0",
});
assert.equal(full.storagePolicyRef, "query-v0");

const archive = role("private-archive-indexer");
assert.equal(
  archive.activation,
  archiveLaneImplemented
    ? "active-local-gateway-fronted"
    : "defined-inactive-local-equivalent"
);
// An activated role must name its instantiation, not merely say it is absent.
if (archiveLaneImplemented) {
  assert.match(archive.localEquivalent, /torium-localnet --archive/u);
  assert.match(archive.localEquivalent, /compose\.archive-gateway\.yaml/u);
}
assert.deepEqual(archive.runtimePolicyRefs, {
  comet: "disabled",
  cosmos: "disabled",
  evm: "evm-archive-blockscout-candidate-v0",
});
assert.equal(archive.runtimePolicyRefs.evm, archiveGateway.runtimePolicyRef);
for (const serviceName of ["evmHttp", "evmWebSocket"]) {
  assert.equal(archive.services[serviceName].hostPublish, null);
  assert.equal(archive.services[serviceName].exposure, "gateway-upstream-only");
}
assert.equal(archive.storagePolicyRef, "archive-indexer-v0");
assert.equal(
  manifest.storagePolicies[archive.storagePolicyRef].targetFromGenesis,
  true
);
assert.equal(
  manifest.storagePolicies[archive.storagePolicyRef].activated,
  archiveLaneImplemented
);
assert.equal(
  manifest.storagePolicies[archive.storagePolicyRef].evidenceComplete,
  archiveLaneImplemented
);
assert.deepEqual(manifest.tracePolicy.requiredMethods, []);
assert.ok(
  archiveEvmPolicy.candidateMethodContract.every(
    (method) => !method.startsWith("debug_")
  )
);

assert.deepEqual(
  localRpc.ethereum.namespaces.enabled,
  protocol.rpc.defaultNamespaces
);
assert.deepEqual(
  localRpc.ethereum.namespaces.operatorOnlyNotEnabled,
  protocol.rpc.operatorOnlyNamespaces
);
assert.equal(localRpc.ethereum.webSocket.wildcardOriginAllowed, false);

process.stdout.write(
  `${JSON.stringify(
    {
      valid: true,
      profileVersion: manifest.profileVersion,
      roles: expectedRoleIds,
      publicLaunchAllowed: manifest.publicLaunchAllowed,
      enabledTraceMethods: manifest.tracePolicy.requiredMethods,
      resourceStatus: "planning-floor-not-benchmarked",
    },
    null,
    2
  )}\n`
);

function role(id) {
  const value = manifest.roles.find((candidate) => candidate.id === id);
  assert.ok(value, `missing role ${id}`);
  return value;
}

function assertLoopback(value, label) {
  assert.equal(typeof value, "string", `${label} must be published`);
  assert.match(
    value,
    /^127\.0\.0\.1:[1-9][0-9]*$/u,
    `${label} is not loopback-only`
  );
}

function registerHostPublication(hostPublish, owner) {
  const existingOwner = publishedHostPorts.get(hostPublish);
  assert.equal(
    existingOwner,
    undefined,
    `${owner} collides with ${existingOwner} at ${hostPublish}`
  );
  publishedHostPorts.set(hostPublish, owner);
}

function assertEvmPolicy(
  policy,
  { id, status, contractField, gatewayImplemented }
) {
  assertExactKeys(policy, [
    "id",
    "status",
    "enabled",
    "nativePerMethodAllowlistSupported",
    "enforcementLayer",
    "gatewayActivated",
    "effectiveConformanceProven",
    "namespaces",
    contractField,
    "limits",
    "safety",
    "webSocket",
  ]);
  assert.equal(policy.id, id);
  assert.equal(policy.status, status);
  assert.equal(policy.enabled, true);
  assert.equal(policy.nativePerMethodAllowlistSupported, false);
  assert.equal(policy.enforcementLayer, "required-policy-gateway");
  // A policy whose enforcement layer is a gateway may only claim activation
  // when that gateway actually exists in this repository. Without one, the
  // allowlist is a plan, and a `true` here would be a false claim.
  assert.equal(
    policy.gatewayActivated,
    gatewayImplemented,
    `${id} gatewayActivated must equal whether its enforcement gateway is implemented`
  );
  assert.equal(
    policy.effectiveConformanceProven,
    gatewayImplemented,
    `${id} effectiveConformanceProven must equal whether its enforcement gateway is implemented`
  );
  assert.deepEqual(policy.namespaces, protocol.rpc.defaultNamespaces);
  assert.deepEqual(policy.limits, localRpc.ethereum.limits);
  assert.deepEqual(policy.safety, localRpc.ethereum.safety);
  assert.deepEqual(policy.webSocket, {
    allowedOrigins: ["127.0.0.1", "localhost"],
    wildcardOriginAllowed: false,
    subscriptions: ["newHeads", "logs"],
  });
  for (const method of policy[contractField]) {
    assert.doesNotMatch(method, /^(?:debug|admin|personal|miner)_/u);
  }
}

function assertExactKeys(value, keys) {
  assert.ok(
    value !== null && typeof value === "object" && !Array.isArray(value)
  );
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort());
}

// Every source the archive-lane derivation depends on. Reading them here keeps
// the rule computed from the repository rather than declared in the contract.
async function readArchiveSources() {
  const paths = {
    generator: "chain/app/localnet/archive.go",
    localnetCommand: "chain/app/cmd/torium-localnet/main.go",
    gatewayPolicy: "chain/app/archivegateway/policy.go",
    gatewayPolicyTest: "chain/app/archivegateway/policy_test.go",
    gatewayServer: "chain/app/archivegateway/server.go",
    gatewayCommand: "chain/app/cmd/torium-archive-gateway/main.go",
    compose: "chain/profiles/compose.archive-gateway.yaml",
    evidenceRunner: "chain/profiles/run-archive-gateway-evidence-v0.sh",
    streamProbe: "chain/profiles/probe-archive-gateway-stream.mjs",
  };
  const entries = await Promise.all(
    Object.entries(paths).map(async ([key, relative]) => {
      const absolute = path.resolve(repositoryRoot, relative);
      assert.ok(absolute.startsWith(`${repositoryRoot}${path.sep}`));
      // A missing source means the lane is not implemented, which is a
      // legitimate state, not a validation error.
      const contents = await readFile(absolute, "utf8").catch(() => "");
      return [key, contents];
    })
  );
  return Object.fromEntries(entries);
}

async function readJson(repositoryPath) {
  assert.match(repositoryPath, /^chain\/[a-zA-Z0-9._/-]+\.json$/u);
  assert.equal(repositoryPath.split("/").includes(".."), false);
  const absolutePath = path.resolve(repositoryRoot, repositoryPath);
  assert.ok(absolutePath.startsWith(`${repositoryRoot}${path.sep}`));
  return JSON.parse(await readFile(absolutePath, "utf8"));
}
