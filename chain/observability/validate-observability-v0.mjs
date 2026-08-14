#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { formatPrometheus } from "./health-exporter.mjs";

const directory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(directory, "../..");
const rootRequire = createRequire(path.join(repositoryRoot, "package.json"));
const Ajv2020 = rootRequire("ajv/dist/2020").default;

const [
  observability,
  schema,
  identifiers,
  protocol,
  rpcProfile,
  nodeRoles,
  explorerStack,
  composeText,
  healthSource,
  dashboard,
  runbookText,
] = await Promise.all([
  readJson("chain/observability/observability-v0.json"),
  readJson("chain/observability/observability-v0.schema.json"),
  readJson("chain/config/identifiers.json"),
  readJson("chain/config/protocol-v1.json"),
  readJson("chain/config/rpc-profile-v1.json"),
  readJson("chain/profiles/node-roles-v0.json"),
  readJson("chain/explorer/stack-v0.json"),
  readText("chain/localnet/compose.yaml"),
  readText("chain/localnet/scripts/health.mjs"),
  readJson("chain/observability/grafana/torium-localnet-overview-v0.json"),
  readText("docs/operations/torium-chain-observability-runbook.md"),
]);
const runtimeConfigSource = await readText(
  "chain/app/localnet/runtime_config.go"
);
// Sources for the #115 archive-gateway-metrics derivation. The target may only
// claim activation when the gateway it observes is itself activated (#114), the
// gateway exports every required signal, and the collector actually scrapes it.
const [archiveGatewaySource, archiveComposeText, prometheusScrapeText] =
  await Promise.all([
    readText("chain/app/archivegateway/server.go"),
    readText("chain/profiles/compose.archive-gateway.yaml"),
    readText("chain/observability/prometheus/prometheus.yml"),
  ]);

assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
assert.equal(schema.additionalProperties, false);
const validateSchema = new Ajv2020({ strict: true, allErrors: true }).compile(
  schema
);
assert.equal(
  validateSchema(observability),
  true,
  `observability schema validation failed: ${JSON.stringify(
    validateSchema.errors
  )}`
);

assertExactKeys(observability, [
  "$schema",
  "schemaVersion",
  "observabilityVersion",
  "status",
  "ownerIssue",
  "sources",
  "constraints",
  "healthContract",
  "telemetryNetwork",
  "labelPolicy",
  "metricTargets",
  "logging",
  "alerts",
  "dashboards",
  "tracing",
  "holds",
]);
assert.equal(observability.$schema, "./observability-v0.schema.json");
assert.equal(observability.schemaVersion, 1);
assert.match(
  observability.observabilityVersion,
  /^0\.1\.0-local\.[1-9][0-9]*$/u
);
assert.ok(
  ["inactive-local-only-hold", "partially-activated-local-only"].includes(
    observability.status
  ),
  "observability status must stay local-only"
);
assert.equal(observability.ownerIssue, 115);

assert.deepEqual(observability.sources, {
  identifiers: {
    path: "chain/config/identifiers.json",
    manifestVersion: identifiers.manifestVersion,
  },
  protocol: {
    path: "chain/config/protocol-v1.json",
    protocolVersion: protocol.protocolVersion,
  },
  rpcProfile: {
    path: "chain/config/rpc-profile-v1.json",
    profileVersion: rpcProfile.profileVersion,
    healthSchemaVersion: 2,
  },
  nodeRoles: {
    path: "chain/profiles/node-roles-v0.json",
    profileVersion: nodeRoles.profileVersion,
    ownerIssue: nodeRoles.ownerIssue,
  },
  explorerStack: {
    path: "chain/explorer/stack-v0.json",
    stackVersion: explorerStack.stackVersion,
    ownerIssue: explorerStack.ownerIssue,
  },
});
const localIdentifiers = identifiers.networks.find(
  ({ environment }) => environment === "localnet"
);
assert.ok(localIdentifiers);
assert.equal(localIdentifiers.evm.chainId, 1414484556);
assert.equal(localIdentifiers.cosmos.chainId, "torium-localnet-1");
assert.match(healthSource, /schemaVersion:\s*2/u);

assert.deepEqual(observability.constraints, {
  environment: "local-development-only",
  activated: false,
  collectorOrDashboardRuntimeConfigIncluded: false,
  healthExporterArtifactIncluded: true,
  localContainerLogRotationConfigured: true,
  liveDeploymentAllowed: false,
  publicOperationAllowed: false,
  publicTelemetryAllowed: false,
  telemetryIsReadinessAuthority: false,
  chainRpcAuthority: "authoritative",
  explorerDatabaseAuthority: "derived-rebuildable-index",
  toriumBackendIntegrationInScope: false,
  toriumBackendAuthorityAllowed: false,
  numericCapacityOrSloClaimAllowed: false,
});
assert.equal(explorerStack.constraints.chainRpcAuthority, "authoritative");
assert.equal(
  explorerStack.constraints.explorerDatabaseAuthority,
  "derived-rebuildable-index"
);
assert.equal(explorerStack.constraints.toriumBackendAuthorityAllowed, false);

assert.equal(observability.healthContract.schemaVersion, 2);
assert.deepEqual(observability.healthContract.states, [
  "booting",
  "syncing",
  "ready",
  "degraded",
  "unhealthy",
]);
assert.equal(
  observability.healthContract.currentImplementation,
  "chain/localnet/scripts/health.mjs"
);
assert.equal(observability.healthContract.exporterActivated, false);
assert.equal(observability.healthContract.readyFromOpenPortAllowed, false);
assert.equal(observability.healthContract.roleSeparatedEvidence, false);

const telemetry = observability.telemetryNetwork;
assert.equal(telemetry.status, "defined-inactive-target");
assert.equal(telemetry.collectorActivated, false);
assert.equal(telemetry.scrapeInitiator, "collector-only");
assert.equal(telemetry.targetsMayInitiateConnections, false);
assert.equal(telemetry.hostPublish, null);
assert.equal(telemetry.publicIngressConfigured, false);
assert.equal(telemetry.networkIsolationProven, false);
for (const role of nodeRoles.roles.map(({ id }) => id)) {
  assert.equal(telemetry.members.includes(role), true);
}
for (const component of [
  "archive-rpc-gateway",
  "blockscout-backend-api",
  "blockscout-indexer",
  "postgresql",
  "redis",
]) {
  assert.equal(telemetry.members.includes(component), true);
}

const labelPolicy = observability.labelPolicy;
assert.deepEqual(
  new Set(labelPolicy.allowedLabels),
  new Set(Object.keys(labelPolicy.boundedValueSources))
);
assert.equal(
  labelPolicy.allowedLabels.some((label) =>
    labelPolicy.forbiddenLabels.includes(label)
  ),
  false
);
assert.equal(labelPolicy.unboundedUserControlledLabelAllowed, false);
assert.equal(labelPolicy.rawRpcMethodLabelAllowed, false);
assert.equal(labelPolicy.seriesBudget, null);
assert.equal(labelPolicy.seriesBudgetStatus, "HOLD-not-measured");
assert.deepEqual(labelPolicy.boundedValueSources.profile, ["container", "raw"]);
assert.deepEqual(labelPolicy.boundedValueSources.node, [
  "validator-0",
  "validator-1",
  "validator-2",
  "validator-3",
]);
assert.deepEqual(
  labelPolicy.boundedValueSources.state,
  observability.healthContract.states
);
assert.deepEqual(labelPolicy.boundedValueSources.kind, [
  "available",
  "required",
  "total",
]);
for (const forbiddenLabel of [
  "account_address",
  "transaction_hash",
  "node_id",
  "peer_id",
  "rpc_url",
  "request_id",
  "raw_error",
  "error_message",
]) {
  assert.equal(labelPolicy.forbiddenLabels.includes(forbiddenLabel), true);
}

const exporterOutput = formatPrometheus(exporterFixture(), {
  environment: "localnet",
});
const emittedLabels = collectPrometheusLabels(exporterOutput);
for (const label of emittedLabels) {
  assert.equal(
    labelPolicy.allowedLabels.includes(label),
    true,
    `exporter label ${label} is not allowed by the observability contract`
  );
}
for (const forbiddenValue of [
  "torium1forbidden",
  "0x0000000000000000000000000000000000000001",
  "secret-node-id",
  "authorization",
  "http://",
]) {
  assert.equal(exporterOutput.includes(forbiddenValue), false);
}

const targetIds = [
  "localnet-health-v2",
  "comet-consensus-metrics",
  "cosmos-evm-json-rpc-metrics",
  "cosmos-evm-geth-metrics",
  "role-process-resource-metrics",
  "archive-gateway-metrics",
  "explorer-indexer-metrics",
];
assert.deepEqual(
  observability.metricTargets.map(({ id }) => id),
  targetIds
);
// A target may only claim activation together with complete runtime
// evidence, and only when its local source is verifiably enabled. The rule
// is derived from the sources themselves, not asserted as a constant:
// CometBFT consensus metrics require Prometheus instrumentation in the
// runtime config; the EVM JSON-RPC metrics server additionally requires the
// --metrics CLI flag in the localnet start command and a host-loopback
// publish for the collector.
const activatedTargetSourceDerivations = new Map([
  ["localnet-health-v2", () => /schemaVersion:\s*2/u.test(healthSource)],
  [
    "comet-consensus-metrics",
    () =>
      /Instrumentation\.Prometheus = true/u.test(runtimeConfigSource) &&
      /Instrumentation\.PrometheusListenAddr/u.test(runtimeConfigSource) &&
      composeText.includes(`"127.0.0.1:${protocol.ports.defaults.cometMetrics}:${protocol.ports.defaults.cometMetrics}"`),
  ],
  [
    "cosmos-evm-json-rpc-metrics",
    () =>
      /^\s+- --metrics$/mu.test(composeText) &&
      composeText.includes(`"127.0.0.1:${protocol.ports.defaults.jsonRpcMetrics}:${protocol.ports.defaults.jsonRpcMetrics}"`),
  ],
  [
    "archive-gateway-metrics",
    () => {
      const target = metricTarget("archive-gateway-metrics");
      const gateway =
        nodeRoles.consumerGateways["archive-indexer-v0"];
      return (
        // (a) the observed gateway is activated and proven by #114,
        gateway.activated === true &&
        gateway.effectiveConformanceProven === true &&
        // (b) the gateway publishes its enforced surface on the port this
        //     target scrapes, and nothing publishes the raw archive RPC,
        archiveComposeText.includes(`"127.0.0.1:${target.port}:8545"`) &&
        !archiveComposeText.includes("private-archive-indexer:\n    ports:") &&
        // (c) the gateway actually serves the metrics path, and
        archiveGatewaySource.includes(`case "${target.path}":`) &&
        // (d) the collector scrapes it.
        prometheusScrapeText.includes(
          `torium_target: archive-gateway-metrics`
        ) &&
        prometheusScrapeText.includes(`host.docker.internal:${target.port}`)
      );
    },
  ],
]);
for (const target of observability.metricTargets) {
  if (target.activated) {
    assert.equal(
      target.runtimeEvidenceComplete,
      true,
      `${target.id} claims activation without complete runtime evidence`
    );
    const derivation = activatedTargetSourceDerivations.get(target.id);
    assert.ok(
      derivation !== undefined && derivation() === true,
      `${target.id} has no activated local source`
    );
  } else {
    assert.equal(target.runtimeEvidenceComplete, false);
    if (target.id === "comet-consensus-metrics") {
      assert.equal(
        /Instrumentation\.Prometheus = true/u.test(runtimeConfigSource),
        false,
        "comet metrics are enabled in the runtime config but the target still claims inactivity"
      );
    }
  }
}
if (observability.metricTargets.some(({ activated }) => activated)) {
  await access(
    path.join(repositoryRoot, "chain/observability/compose.observability.yaml")
  );
  await access(
    path.join(repositoryRoot, "chain/observability/run-scrape-evidence-v0.sh")
  );
}
assert.deepEqual(metricTarget("localnet-health-v2"), {
  id: "localnet-health-v2",
  owner: "torium-localnet-controller",
  targetKinds: ["active-localnet"],
  source: "health-exporter-over-poll-contract",
  protocol: "prometheus",
  port: 9468,
  path: "/metrics",
  currentStatus: "activated-local-loopback-scrape-proven",
  activated: true,
  runtimeEvidenceComplete: true,
  requiredSignals: [
    "chain-identity",
    "node-identity",
    "quorum-power",
    "sync-state",
    "consensus-height",
    "evm-height",
    "peer-count",
    "block-progress",
  ],
});
// An activated gateway target claims specific signals; each one must map to a
// metric family the gateway source actually emits, or the activation is nominal.
const archiveGatewaySignalFamilies = new Map([
  ["allowed-request-rate", 'torium_archive_gateway_requests_total{transport="http",outcome="forwarded"}'],
  ["denied-request-rate", 'torium_archive_gateway_requests_total{transport="http",outcome="refused"}'],
  ["upstream-errors", 'torium_archive_gateway_requests_total{transport="http",outcome="upstream_failed"}'],
  ["upstream-latency", "torium_archive_gateway_upstream_latency_seconds_sum"],
  ["active-websockets", "torium_archive_gateway_active_websockets"],
  ["policy-version", "torium_archive_gateway_policy_info"],
]);
const archiveGatewayTarget = metricTarget("archive-gateway-metrics");
if (archiveGatewayTarget.activated) {
  assert.deepEqual(
    archiveGatewayTarget.requiredSignals,
    [...archiveGatewaySignalFamilies.keys()],
    "the archive gateway signal map must cover exactly the required signals"
  );
  for (const [signal, family] of archiveGatewaySignalFamilies) {
    assert.ok(
      archiveGatewaySource.includes(family),
      `archive gateway does not emit a family for the required ${signal} signal (${family})`
    );
  }
}

assert.equal(
  metricTarget("comet-consensus-metrics").port,
  protocol.ports.defaults.cometMetrics
);
assert.equal(
  metricTarget("cosmos-evm-json-rpc-metrics").port,
  protocol.ports.defaults.jsonRpcMetrics
);
assert.equal(
  metricTarget("cosmos-evm-geth-metrics").port,
  protocol.ports.defaults.gethMetrics
);
// The explorer's own runtime is activated (#113), so the remaining blocker is no
// longer "the stack is inactive": it is that Blockscout's native exporter covers
// the indexing signals and nothing sources the database or reconciliation ones.
// The status must name the real gap, and the target must stay inactive while any
// required signal is unsourced.
const explorerIndexerTarget = metricTarget("explorer-indexer-metrics");
assert.equal(
  explorerIndexerTarget.currentStatus,
  "HOLD-native-exporter-covers-indexing-signals-only-database-and-reconciliation-signals-unsourced"
);
assert.equal(explorerIndexerTarget.activated, false);
assert.equal(explorerIndexerTarget.runtimeEvidenceComplete, false);
// Every signal it will eventually need is still listed, so narrowing the status
// cannot quietly narrow the requirement.
assert.deepEqual(explorerIndexerTarget.requiredSignals, [
  "canonical-height",
  "indexed-height",
  "index-lag",
  "canonical-hash-mismatch",
  "missing-receipts-or-logs",
  "database-size-and-growth",
  "database-connections",
  "queue-depth",
]);

assert.equal(observability.logging.format, "json-lines");
assert.deepEqual(observability.logging.rotation, {
  container: {
    driver: "json-file",
    maxSize: "10m",
    maxFiles: 3,
    status: "configured-not-runtime-proven",
  },
  raw: {
    maxFileBytes: null,
    maxFiles: null,
    maxAgeHours: null,
    compression: null,
    status: "HOLD-not-defined-or-proven",
  },
});
assert.equal(countMatches(composeText, /^\s+driver: json-file$/gmu), 2);
assert.equal(countMatches(composeText, /^\s+max-size: 10m$/gmu), 2);
assert.equal(countMatches(composeText, /^\s+max-file: "3"$/gmu), 2);
const effectiveCompose = JSON.parse(
  execFileSync(
    "docker",
    [
      "compose",
      "-f",
      path.join(repositoryRoot, "chain/localnet/compose.yaml"),
      "config",
      "--format",
      "json",
    ],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }
  )
);
for (const serviceName of [
  "validator-0",
  "validator-1",
  "validator-2",
  "validator-3",
  "faucet",
]) {
  const service = effectiveCompose.services?.[serviceName];
  assert.ok(service, `effective Compose config is missing ${serviceName}`);
  assert.deepEqual(service.logging, {
    driver: "json-file",
    options: { "max-file": "3", "max-size": "10m" },
  });
  for (const port of service.ports ?? []) {
    assert.equal(
      port.host_ip,
      "127.0.0.1",
      `${serviceName} publishes ${port.target} outside numeric loopback`
    );
  }
}
assert.equal(observability.logging.redaction.rawPayloadLoggingAllowed, false);
assert.equal(
  observability.logging.redaction.hashingSensitiveValuesAllowed,
  false
);
assert.equal(observability.logging.redaction.secretScannerRequired, true);
assert.equal(
  observability.logging.redaction.runtimeRedactionEvidenceComplete,
  false
);
assert.equal(observability.logging.centralCollector.selected, false);
assert.equal(observability.logging.publicLogAccessAllowed, false);
assert.equal(observability.logging.toriumBackendLogSinkAllowed, false);
for (const field of [
  "private_key",
  "mnemonic",
  "seed_phrase",
  "authorization",
  "raw_transaction",
]) {
  assert.equal(
    observability.logging.redaction.prohibitedFields.includes(field),
    true
  );
}

const alertIds = [
  "telemetry-target-down",
  "chain-progress-stalled",
  "commit-quorum-unavailable",
  "node-identity-or-chain-mismatch",
  "peer-isolation-or-partition",
  "consensus-evm-height-divergence",
  "rpc-errors-latency-or-shedding",
  "disk-headroom-or-growth-risk",
  "archive-gateway-policy-or-bypass-failure",
  "explorer-lag-or-canonical-mismatch",
];
assert.deepEqual(
  observability.alerts.map(({ id }) => id),
  alertIds
);
const runbookAnchors = markdownAnchors(runbookText);
const alertRules = await readText(
  "chain/observability/prometheus/alert-rules.yml"
);
for (const alert of observability.alerts) {
  // An activated alert must have a real rule; complete runtime evidence
  // additionally requires a proven fire-and-recover lifecycle.
  if (alert.activated) {
    assert.match(
      alertRules,
      /- alert: /u,
      "activated alerts require executable rules"
    );
  } else {
    assert.equal(alert.runtimeEvidenceComplete, false);
  }
  assert.equal(alert.threshold, null);
  const [runbookPath, anchor] = alert.runbook.split("#");
  assert.equal(
    runbookPath,
    "docs/operations/torium-chain-observability-runbook.md"
  );
  assert.equal(
    runbookAnchors.has(anchor),
    true,
    `missing runbook anchor ${anchor}`
  );
}
assert.equal(
  observability.alerts
    .filter(({ severity }) => severity === "critical")
    .every(({ runbook }) => runbook.length > 0),
  true
);

assert.equal(observability.dashboards.length, 5);
const dashboardContract = observability.dashboards[0];
assert.deepEqual(dashboardContract, {
  id: "localnet-health-overview",
  owner: "torium-operations",
  status: "artifact-defined-not-provisioned",
  artifactPath: "chain/observability/grafana/torium-localnet-overview-v0.json",
  activated: false,
  datasource: "local-prometheus-target",
  panels: [
    "health-state",
    "chain-ids",
    "quorum-power",
    "consensus-and-evm-heights",
    "sync-state",
  ],
});
for (const contract of observability.dashboards.slice(1)) {
  assert.equal(contract.status, "defined-not-implemented");
  assert.equal(contract.artifactPath, null);
  assert.equal(contract.activated, false);
}
assert.equal(dashboard.uid, "torium-localnet-v0");
assert.equal(dashboard.title, "Torium Localnet Overview v0");
assert.equal(dashboard.schemaVersion, 41);
assert.equal(Array.isArray(dashboard.panels), true);
assert.ok(dashboard.panels.length >= 6);
const exportedFamilies = new Set(
  [...exporterOutput.matchAll(/^# TYPE ([a-z0-9_:]+) /gmu)].map(
    ([, family]) => family
  )
);
const dashboardExpressions = dashboard.panels
  .flatMap(({ targets = [] }) => targets.map(({ expr }) => expr))
  .filter((expr) => typeof expr === "string");
const dashboardFamilies = new Set(
  dashboardExpressions.map((expression) => {
    const match = /^(torium_[a-z0-9_:]+)\{environment="localnet"\}$/u.exec(
      expression
    );
    assert.ok(
      match,
      `dashboard expression is outside the restricted v0 selector grammar: ${expression}`
    );
    return match[1];
  })
);
assert.ok(dashboardFamilies.size >= 6);
for (const family of dashboardFamilies) {
  assert.equal(
    exportedFamilies.has(family),
    true,
    `dashboard references unknown exporter family ${family}`
  );
}

assert.deepEqual(observability.tracing.distributedTracing, {
  enabled: false,
  provider: null,
  collectorEndpoint: null,
  contextPropagationEnabled: false,
  samplingPolicy: null,
  status: "explicitly-disabled-v0-no-runtime-claim",
});
assert.equal(observability.tracing.evmDebugTracing.enabledOnAnyRole, false);
assert.deepEqual(observability.tracing.evmDebugTracing.requiredMethods, []);
assert.equal(observability.tracing.profiling.pprofEnabledOnAnyRole, false);
assert.equal(observability.tracing.profiling.evmProfilingEnabled, false);
assert.equal(observability.tracing.profiling.readinessDependency, false);
for (const role of nodeRoles.roles) {
  assert.equal(role.services.pprof.enabled, false);
}
assert.equal(nodeRoles.tracePolicy.operatorNamespaceEnabledOnAnyRole, false);

const holdOwnership = [
  { id: "five-role-runtime-inactive", ownerIssue: 115, evidenceIssues: [113, 114] },
  { id: "collector-and-target-pins-missing", ownerIssue: 115, evidenceIssues: [113, 114] },
  { id: "effective-scrape-conformance-missing", ownerIssue: 115, evidenceIssues: [113, 114] },
  { id: "metric-cardinality-and-slo-unmeasured", ownerIssue: 118, evidenceIssues: [115] },
  { id: "logging-redaction-and-rotation-unproven", ownerIssue: 115, evidenceIssues: [] },
  { id: "alert-rules-and-delivery-unproven", ownerIssue: 115, evidenceIssues: [] },
  { id: "failure-drills-unproven", ownerIssue: 119, evidenceIssues: [115] },
  { id: "archive-and-explorer-observability-inactive", ownerIssue: 115, evidenceIssues: [113, 114] },
  { id: "distributed-tracing-not-selected", ownerIssue: 115, evidenceIssues: [] },
  { id: "public-observability-deferred", ownerIssue: 115, evidenceIssues: [127] },
];
const holdIds = holdOwnership.map(({ id }) => id);
assert.deepEqual(
  observability.holds.map(({ id, ownerIssue, evidenceIssues }) => ({
    id,
    ownerIssue,
    evidenceIssues,
  })),
  holdOwnership
);
for (const hold of observability.holds) {
  assert.ok(["HOLD", "HOLD-if-enabled", "PARTIAL"].includes(hold.state));
  assert.ok(hold.requirement.length >= 40);
}
assert.ok(
  ["inactive-local-only-hold", "activated-local-only-hold"].includes(
    explorerStack.status
  ),
  "the explorer stack must stay local-only"
);
assert.equal(nodeRoles.publicLaunchAllowed, false);

process.stdout.write(
  `${JSON.stringify(
    {
      valid: true,
      observabilityVersion: observability.observabilityVersion,
      status: observability.status,
      metricTargets: targetIds,
      exporterFamilies: [...exportedFamilies],
      alerts: alertIds,
      dashboards: observability.dashboards.map(({ id, status }) => ({
        id,
        status,
      })),
      holdIds,
      activated: observability.constraints.activated,
    },
    null,
    2
  )}\n`
);

function metricTarget(id) {
  const target = observability.metricTargets.find(
    (candidate) => candidate.id === id
  );
  assert.ok(target, `missing metric target ${id}`);
  return target;
}

function exporterFixture() {
  const validators = Array.from({ length: 4 }, (_, index) => ({
    name: `validator-${index}`,
    reachable: index !== 3,
    ready: index !== 3,
    height: index === 3 ? 0 : 42,
    peerCount: index === 3 ? null : 3,
    catchingUp: index === 3 ? null : false,
    votingPower: 25,
    expectedNodeID: `secret-node-id-${index}`,
    rpcUrl: `http://127.0.0.1:${26657 + index * 100}`,
  }));
  return {
    schemaVersion: 2,
    backend: "container",
    state: "degraded",
    ready: true,
    chain: { highestHeight: 42, evmHeight: 42 },
    consensus: {
      ready: true,
      availableVotingPower: 75,
      totalVotingPower: 100,
      commitQuorumPower: 67,
    },
    evm: { reachable: true, ready: true, error: "authorization" },
    rest: { reachable: true, ready: true },
    validators,
    fundedAccounts: [
      {
        bech32Address: "torium1forbidden",
        evmAddress: "0x0000000000000000000000000000000000000001",
      },
    ],
  };
}

function collectPrometheusLabels(output) {
  const labels = new Set();
  for (const [, body] of output.matchAll(/^torium_[^{\n]+\{([^}]*)\}/gmu)) {
    for (const [, label] of body.matchAll(/(?:^|,)([a-z_][a-z0-9_]*)="/gu)) {
      labels.add(label);
    }
  }
  return labels;
}

function markdownAnchors(markdown) {
  return new Set(
    markdown
      .split("\n")
      .filter((line) => /^#{1,6}\s+/u.test(line))
      .map((line) =>
        line
          .replace(/^#{1,6}\s+/u, "")
          .trim()
          .toLowerCase()
          .replace(/[^a-z0-9\s-]/gu, "")
          .replace(/\s+/gu, "-")
          .replace(/-+/gu, "-")
      )
  );
}

function countMatches(text, pattern) {
  return [...text.matchAll(pattern)].length;
}

function assertExactKeys(value, keys) {
  assert.ok(
    value !== null && typeof value === "object" && !Array.isArray(value)
  );
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort());
}

async function readJson(repositoryPath) {
  return JSON.parse(await readText(repositoryPath));
}

async function readText(repositoryPath) {
  assert.match(repositoryPath, /^[a-zA-Z0-9._/-]+$/u);
  assert.equal(repositoryPath.split("/").includes(".."), false);
  const absolutePath = path.resolve(repositoryRoot, repositoryPath);
  assert.ok(absolutePath.startsWith(`${repositoryRoot}${path.sep}`));
  return readFile(absolutePath, "utf8");
}
