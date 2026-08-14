#!/usr/bin/env node

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { sampleHealth } from "../localnet/scripts/health.mjs";

const defaultHost = "127.0.0.1";
const defaultPort = 9468;
const canonicalEnvironment = "localnet";
const canonicalCosmosChainID = "torium-localnet-1";
const canonicalEvmChainID = 1414484556;
const canonicalNodeNames = [
  "validator-0",
  "validator-1",
  "validator-2",
  "validator-3",
];
const allowedStates = ["booting", "syncing", "ready", "degraded", "unhealthy"];

export function parseExporterArgs(argv) {
  const config = {
    root: null,
    manifestPath: null,
    profile: null,
    environment: canonicalEnvironment,
    host: defaultHost,
    port: defaultPort,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    const next = () => {
      const value = argv[++index];
      if (!value || value.startsWith("--")) {
        throw new Error(`${option} requires a value`);
      }
      return value;
    };
    switch (option) {
      case "--root":
        config.root = next();
        break;
      case "--manifest":
        config.manifestPath = next();
        break;
      case "--profile":
        config.profile = next();
        break;
      case "--environment":
        config.environment = next();
        break;
      case "--host":
        config.host = next();
        break;
      case "--port":
        config.port = Number(next());
        break;
      default:
        throw new Error(`unknown exporter option ${option}`);
    }
  }
  validateConfig(config);
  return config;
}

export async function loadExporterInputs({ root, manifestPath, profile }) {
  const [topologyText, manifestText] = await Promise.all([
    readFile(resolve(root, "topology.json"), "utf8"),
    readFile(resolve(manifestPath), "utf8"),
  ]);
  let topology;
  let manifest;
  try {
    topology = JSON.parse(topologyText);
    manifest = JSON.parse(manifestText);
  } catch {
    throw new Error("exporter topology and manifest must be valid JSON");
  }
  validateExporterInputs({ topology, manifest, profile });
  return { topology, manifest, profile };
}

export function validateExporterInputs({ topology, manifest, profile }) {
  if (!["container", "raw"].includes(profile)) {
    throw new Error("exporter profile must be container or raw");
  }
  if (!topology || typeof topology !== "object" || Array.isArray(topology)) {
    throw new Error("exporter topology must be an object");
  }
  if (
    !Array.isArray(topology.nodes) ||
    topology.nodes.length !== canonicalNodeNames.length
  ) {
    throw new Error("exporter topology must contain the canonical four nodes");
  }
  if (!Array.isArray(manifest?.development_accounts)) {
    throw new Error("exporter manifest development_accounts must be an array");
  }
  requireText(topology.cosmos_chain_id, "topology cosmos_chain_id");
  requireInteger(topology.evm_chain_id, "topology evm_chain_id", 1);
  if (
    topology.cosmos_chain_id !== canonicalCosmosChainID ||
    topology.evm_chain_id !== canonicalEvmChainID
  ) {
    throw new Error("exporter topology must use the canonical localnet IDs");
  }
  requireInteger(topology.total_voting_power, "topology total_voting_power", 1);
  requireInteger(
    topology.commit_quorum_power,
    "topology commit_quorum_power",
    1
  );
  if (topology.commit_quorum_power > topology.total_voting_power) {
    throw new Error("topology commit quorum exceeds total voting power");
  }
  const names = new Set();
  for (const node of topology.nodes) {
    if (!node || typeof node !== "object") {
      throw new Error("topology node must be an object");
    }
    requireLabel(node.name, "topology node name");
    if (names.has(node.name))
      throw new Error(`duplicate topology node ${node.name}`);
    names.add(node.name);
    requireText(node.node_id, `topology node_id for ${node.name}`);
    requireInteger(
      node.voting_power,
      `topology voting_power for ${node.name}`,
      0
    );
    requirePort(node.ports?.comet_rpc, `Comet RPC port for ${node.name}`);
    if (node.client_traffic) {
      for (const field of [
        "cosmos_rest",
        "cosmos_grpc",
        "evm_http",
        "evm_ws",
      ]) {
        requirePort(node.ports?.[field], `${field} port for ${node.name}`);
      }
    }
  }
  const votingPower = topology.nodes.reduce(
    (sum, node) => sum + node.voting_power,
    0
  );
  if (votingPower !== topology.total_voting_power) {
    throw new Error(
      "topology node voting power does not equal total voting power"
    );
  }
  assertLabelSet(names, canonicalNodeNames, "topology node names");
  requireLabel(topology.client_node, "topology client_node");
  const clients = topology.nodes.filter(({ client_traffic }) => client_traffic);
  if (clients.length !== 1 || clients[0].name !== topology.client_node) {
    throw new Error("topology must define exactly one matching client node");
  }
}

export function formatPrometheus(
  report,
  {
    environment = canonicalEnvironment,
    expectedProfile = report?.backend,
    expectedNodeNames = canonicalNodeNames,
  } = {}
) {
  requireCanonicalEnvironment(environment);
  validateReport(report, { expectedProfile, expectedNodeNames });
  const common = { environment, profile: report.backend };
  const lines = [];
  const family = (name, help, samples) => {
    lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} gauge`);
    for (const { labels = {}, value } of samples) {
      requireFinite(value, name);
      lines.push(`${name}${formatLabels({ ...common, ...labels })} ${value}`);
    }
  };

  family(
    "torium_localnet_ready",
    "Whether the localnet readiness contract passes.",
    [{ value: booleanNumber(report.ready) }]
  );
  family(
    "torium_localnet_state",
    "One-hot localnet lifecycle state.",
    allowedStates.map((state) => ({
      labels: { state },
      value: state === report.state ? 1 : 0,
    }))
  );
  family(
    "torium_localnet_consensus_height",
    "Highest observed CometBFT height.",
    [{ value: report.chain.highestHeight }]
  );
  family("torium_localnet_evm_height", "Observed EVM JSON-RPC height.", [
    { value: report.chain.evmHeight },
  ]);
  family("torium_localnet_consensus_ready", "Whether commit quorum is ready.", [
    { value: booleanNumber(report.consensus.ready) },
  ]);
  family(
    "torium_localnet_voting_power",
    "Observed localnet voting-power gauges.",
    [
      {
        labels: { kind: "available" },
        value: report.consensus.availableVotingPower,
      },
      {
        labels: { kind: "required" },
        value: report.consensus.commitQuorumPower,
      },
      { labels: { kind: "total" }, value: report.consensus.totalVotingPower },
    ]
  );
  family(
    "torium_localnet_evm_rpc_reachable",
    "Whether the EVM RPC health sample succeeded.",
    [{ value: booleanNumber(report.evm.reachable) }]
  );
  family(
    "torium_localnet_evm_rpc_ready",
    "Whether the EVM RPC readiness checks pass.",
    [{ value: booleanNumber(report.evm.ready) }]
  );
  family(
    "torium_localnet_rest_reachable",
    "Whether the Cosmos REST health sample succeeded.",
    [{ value: booleanNumber(report.rest.reachable) }]
  );
  family(
    "torium_localnet_rest_ready",
    "Whether the Cosmos REST readiness checks pass.",
    [{ value: booleanNumber(report.rest.ready) }]
  );
  family(
    "torium_localnet_validator_reachable",
    "Whether a validator CometBFT sample succeeded.",
    report.validators.map((validator) => ({
      labels: { node: validator.name },
      value: booleanNumber(validator.reachable),
    }))
  );
  family(
    "torium_localnet_validator_ready",
    "Whether a validator identity, sync, and height checks pass.",
    report.validators.map((validator) => ({
      labels: { node: validator.name },
      value: booleanNumber(validator.ready),
    }))
  );
  family(
    "torium_localnet_validator_height",
    "Observed validator CometBFT height.",
    report.validators.map((validator) => ({
      labels: { node: validator.name },
      value: validator.height,
    }))
  );
  family(
    "torium_localnet_validator_voting_power",
    "Configured local validator voting power.",
    report.validators.map((validator) => ({
      labels: { node: validator.name },
      value: validator.votingPower,
    }))
  );
  const peerSamples = report.validators
    .filter(({ peerCount }) => Number.isFinite(peerCount))
    .map((validator) => ({
      labels: { node: validator.name },
      value: validator.peerCount,
    }));
  family(
    "torium_localnet_validator_peers",
    "Observed validator peer count when available.",
    peerSamples
  );
  const syncSamples = report.validators
    .filter(({ catchingUp }) => typeof catchingUp === "boolean")
    .map((validator) => ({
      labels: { node: validator.name },
      value: booleanNumber(validator.catchingUp),
    }));
  family(
    "torium_localnet_validator_catching_up",
    "Whether a validator reports catching up.",
    syncSamples
  );

  return `${lines.join("\n")}\n`;
}

export function createExporterHandler({
  topology,
  manifest,
  profile,
  environment = "localnet",
  sampleHealthImpl = sampleHealth,
}) {
  validateExporterInputs({ topology, manifest, profile });
  requireCanonicalEnvironment(environment);
  if (typeof sampleHealthImpl !== "function") {
    throw new Error("sampleHealthImpl must be a function");
  }
  return async (request, response) => {
    const method = request.method ?? "GET";
    const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    response.setHeader("cache-control", "no-store");
    if (method === "GET" && path === "/healthz") {
      response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      response.end("ok\n");
      return;
    }
    if (method === "GET" && path === "/metrics") {
      try {
        const report = await sampleHealthImpl({ topology, manifest, profile });
        const body = formatPrometheus(report, {
          environment,
          expectedProfile: profile,
          expectedNodeNames: topology.nodes.map(({ name }) => name),
        });
        response.writeHead(200, {
          "content-type": "text/plain; version=0.0.4; charset=utf-8",
        });
        response.end(body);
      } catch {
        response.writeHead(503, {
          "content-type": "text/plain; charset=utf-8",
        });
        response.end("health sample unavailable\n");
      }
      return;
    }
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("not found\n");
  };
}

export async function startExporter({ host, port, ...handlerOptions }) {
  requireLoopback(host);
  requirePort(port, "exporter port");
  const server = createServer(createExporterHandler(handlerOptions));
  await new Promise((resolvePromise, rejectPromise) => {
    server.once("error", rejectPromise);
    server.listen(port, host, () => {
      server.off("error", rejectPromise);
      resolvePromise();
    });
  });
  return server;
}

function validateConfig(config) {
  requireText(config.root, "exporter --root");
  requireText(config.manifestPath, "exporter --manifest");
  if (!["container", "raw"].includes(config.profile)) {
    throw new Error("exporter --profile must be container or raw");
  }
  requireCanonicalEnvironment(config.environment);
  requireLoopback(config.host);
  requirePort(config.port, "exporter port");
}

function validateReport(report, { expectedProfile, expectedNodeNames }) {
  if (!report || report.schemaVersion !== 2) {
    throw new Error("health report schemaVersion must be 2");
  }
  if (!["container", "raw"].includes(report.backend)) {
    throw new Error("health report backend must be container or raw");
  }
  if (report.backend !== expectedProfile) {
    throw new Error("health report backend differs from exporter profile");
  }
  if (!allowedStates.includes(report.state))
    throw new Error("health report state is invalid");
  if (
    !Array.isArray(report.validators) ||
    report.validators.length !== expectedNodeNames.length ||
    !report.chain ||
    !report.consensus ||
    !report.evm ||
    !report.rest
  ) {
    throw new Error("health report is incomplete");
  }
  requireBoolean(report.ready, "health report ready");
  requireInteger(report.chain.highestHeight, "consensus height", 0);
  requireInteger(report.chain.evmHeight, "EVM height", 0);
  requireBoolean(report.consensus.ready, "consensus ready");
  requireInteger(
    report.consensus.availableVotingPower,
    "available voting power",
    0
  );
  requireInteger(report.consensus.totalVotingPower, "total voting power", 1);
  requireInteger(report.consensus.commitQuorumPower, "commit quorum power", 1);
  if (
    report.consensus.availableVotingPower > report.consensus.totalVotingPower ||
    report.consensus.commitQuorumPower > report.consensus.totalVotingPower
  ) {
    throw new Error("health report voting-power invariants are invalid");
  }
  requireBoolean(report.evm.reachable, "EVM reachable");
  requireBoolean(report.evm.ready, "EVM ready");
  requireBoolean(report.rest.reachable, "REST reachable");
  requireBoolean(report.rest.ready, "REST ready");
  const names = new Set();
  let readyVotingPower = 0;
  let totalVotingPower = 0;
  for (const validator of report.validators) {
    requireLabel(validator.name, "validator name");
    if (names.has(validator.name))
      throw new Error(`duplicate validator ${validator.name}`);
    names.add(validator.name);
    requireBoolean(validator.reachable, `${validator.name} reachable`);
    requireBoolean(validator.ready, `${validator.name} ready`);
    if (validator.ready && !validator.reachable) {
      throw new Error(`${validator.name} cannot be ready while unreachable`);
    }
    requireInteger(validator.height, `${validator.name} height`, 0);
    requireInteger(validator.votingPower, `${validator.name} voting power`, 0);
    requireNullableInteger(validator.peerCount, `${validator.name} peers`, 0);
    if (
      validator.catchingUp !== null &&
      typeof validator.catchingUp !== "boolean"
    ) {
      throw new Error(`${validator.name} catching-up state is invalid`);
    }
    totalVotingPower += validator.votingPower;
    if (validator.ready) readyVotingPower += validator.votingPower;
  }
  assertLabelSet(names, expectedNodeNames, "health report validator names");
  if (
    totalVotingPower !== report.consensus.totalVotingPower ||
    readyVotingPower !== report.consensus.availableVotingPower
  ) {
    throw new Error("health report validator power does not reconcile");
  }
  if (
    report.consensus.ready !==
    report.consensus.availableVotingPower >= report.consensus.commitQuorumPower
  ) {
    throw new Error("health report quorum readiness is inconsistent");
  }
  if (
    report.ready !==
    (report.consensus.ready && report.evm.ready && report.rest.ready)
  ) {
    throw new Error("health report aggregate readiness is inconsistent");
  }
}

function formatLabels(labels) {
  const entries = Object.entries(labels).sort(([left], [right]) =>
    left.localeCompare(right)
  );
  return `{${entries.map(([key, value]) => `${key}="${escapeLabel(value)}"`).join(",")}}`;
}

function escapeLabel(value) {
  return String(value)
    .replaceAll("\\", "\\\\")
    .replaceAll("\n", "\\n")
    .replaceAll('"', '\\"');
}

function booleanNumber(value) {
  if (typeof value !== "boolean")
    throw new Error("health report boolean is invalid");
  return value ? 1 : 0;
}

function requireBoolean(value, field) {
  if (typeof value !== "boolean") {
    throw new Error(`${field} must be a boolean`);
  }
}

function requireLoopback(host) {
  if (!["127.0.0.1", "::1"].includes(host)) {
    throw new Error("exporter host must be numeric loopback 127.0.0.1 or ::1");
  }
}

function requireLabel(value, field) {
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9_-]{0,63}$/u.test(value)) {
    throw new Error(`${field} must be a bounded low-cardinality label`);
  }
}

function requireCanonicalEnvironment(value) {
  if (value !== canonicalEnvironment) {
    throw new Error("exporter environment must be localnet in v0");
  }
}

function assertLabelSet(actual, expectedValues, field) {
  const expected = new Set(expectedValues);
  if (
    actual.size !== expected.size ||
    [...actual].some((value) => !expected.has(value))
  ) {
    throw new Error(`${field} must match the canonical v0 allowlist`);
  }
}

function requireText(value, field) {
  if (typeof value !== "string" || value.length < 1 || value.length > 512) {
    throw new Error(`${field} must be a non-empty bounded string`);
  }
}

function requireInteger(value, field, minimum) {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`${field} must be an integer >= ${minimum}`);
  }
}

function requireNullableInteger(value, field, minimum) {
  if (value === null) return;
  requireInteger(value, field, minimum);
}

function requirePort(value, field) {
  requireInteger(value, field, 1);
  if (value > 65_535) throw new Error(`${field} must be <= 65535`);
}

function requireFinite(value, field) {
  if (!Number.isFinite(value)) throw new Error(`${field} must be finite`);
}

async function main() {
  const config = parseExporterArgs(process.argv.slice(2));
  const inputs = await loadExporterInputs(config);
  const server = await startExporter({ ...config, ...inputs });
  process.stdout.write(
    `Torium health exporter listening on http://${config.host}:${config.port}\n`
  );
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, () => server.close());
  }
}

const invokedPath = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : null;
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(
      `Torium health exporter error: ${error instanceof Error ? error.message : String(error)}\n`
    );
    process.exitCode = 2;
  });
}
