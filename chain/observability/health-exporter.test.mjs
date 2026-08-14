import assert from "node:assert/strict";
import test from "node:test";

import {
  createExporterHandler,
  formatPrometheus,
  parseExporterArgs,
  validateExporterInputs,
} from "./health-exporter.mjs";

const topology = {
  cosmos_chain_id: "torium-localnet-1",
  evm_chain_id: 1414484556,
  total_voting_power: 100,
  commit_quorum_power: 67,
  client_node: "validator-0",
  nodes: Array.from({ length: 4 }, (_, index) => ({
    name: `validator-${index}`,
    node_id: `sensitive-node-id-${index}`,
    voting_power: 25,
    client_traffic: index === 0,
    ports: {
      comet_rpc: 26657,
      cosmos_rest: 1317,
      cosmos_grpc: 9090,
      evm_http: 8545,
      evm_ws: 8546,
    },
  })),
};

const manifest = {
  development_accounts: [
    {
      name: "deployer",
      bech32_address: "torium1mustnotleak",
      evm_address: "0x0000000000000000000000000000000000000001",
      allocation_base_units: "1000000000000000000",
    },
  ],
};

const report = {
  schemaVersion: 2,
  backend: "container",
  state: "degraded",
  ready: true,
  chain: { highestHeight: 42, evmHeight: 41 },
  consensus: {
    ready: true,
    availableVotingPower: 75,
    totalVotingPower: 100,
    commitQuorumPower: 67,
  },
  evm: { reachable: true, ready: true, error: "Bearer secret-must-not-leak" },
  rest: { reachable: true, ready: true },
  validators: topology.nodes.map((node, index) => ({
    name: node.name,
    reachable: index !== 3,
    ready: index !== 3,
    height: index === 3 ? 0 : 42,
    peerCount: index === 3 ? null : 3,
    catchingUp: index === 3 ? null : false,
    votingPower: 25,
    expectedNodeID: node.node_id,
    rpcUrl: `http://127.0.0.1:${26657 + index * 100}`,
  })),
  fundedAccounts: manifest.development_accounts,
};

test("CLI defaults to loopback and rejects public or incomplete configuration", () => {
  assert.deepEqual(
    parseExporterArgs([
      "--root",
      "/tmp/state",
      "--manifest",
      "/tmp/manifest.json",
      "--profile",
      "container",
    ]),
    {
      root: "/tmp/state",
      manifestPath: "/tmp/manifest.json",
      profile: "container",
      environment: "localnet",
      host: "127.0.0.1",
      port: 9468,
    }
  );
  assert.throws(
    () =>
      parseExporterArgs([
        "--root",
        "/tmp/state",
        "--manifest",
        "/tmp/m",
        "--profile",
        "raw",
        "--host",
        "0.0.0.0",
      ]),
    /numeric loopback/u
  );
  assert.throws(
    () => parseExporterArgs(["--root", "/tmp/state"]),
    /manifest|profile/u
  );
  assert.throws(
    () =>
      parseExporterArgs([
        "--root",
        "/tmp/state",
        "--manifest",
        "/tmp/m",
        "--profile",
        "raw",
        "--port",
        "0",
      ]),
    /integer/u
  );
  assert.throws(
    () =>
      parseExporterArgs([
        "--root",
        "/tmp/state",
        "--manifest",
        "/tmp/m",
        "--profile",
        "raw",
        "--environment",
        "arbitrary",
      ]),
    /localnet/u
  );
});

test("input validation rejects ambiguous or high-cardinality topology labels", () => {
  validateExporterInputs({ topology, manifest, profile: "container" });
  assert.throws(
    () =>
      validateExporterInputs({
        topology: {
          ...topology,
          nodes: topology.nodes.map((node) => ({
            ...node,
            client_traffic: true,
          })),
        },
        manifest,
        profile: "container",
      }),
    /exactly one matching client node/u
  );
  assert.throws(
    () =>
      validateExporterInputs({
        topology: {
          ...topology,
          nodes: topology.nodes.map((node, index) => ({
            ...node,
            name: index === 0 ? "validator/address/0" : node.name,
          })),
        },
        manifest,
        profile: "container",
      }),
    /low-cardinality label/u
  );
  assert.throws(
    () =>
      validateExporterInputs({
        topology: {
          ...topology,
          nodes: topology.nodes.map((node, index) => ({
            ...node,
            name: index === 3 ? "validator-new" : node.name,
          })),
        },
        manifest,
        profile: "container",
      }),
    /canonical v0 allowlist/u
  );
});

test("Prometheus output is bounded and excludes account, address, URL, node ID, and errors", () => {
  const output = formatPrometheus(report);
  assert.match(output, /^# HELP torium_localnet_ready/mu);
  assert.match(
    output,
    /torium_localnet_state\{environment="localnet",profile="container",state="degraded"\} 1/u
  );
  assert.match(
    output,
    /torium_localnet_validator_ready\{environment="localnet",node="validator-3",profile="container"\} 0/u
  );
  assert.match(
    output,
    /torium_localnet_voting_power\{environment="localnet",kind="required",profile="container"\} 67/u
  );
  for (const forbidden of [
    "torium1mustnotleak",
    "0x0000000000000000000000000000000000000001",
    "sensitive-node-id",
    "Bearer",
    "secret-must-not-leak",
    "http://",
  ]) {
    assert.doesNotMatch(output, new RegExp(forbidden, "u"));
  }
  assert.equal((output.match(/node="/gu) ?? []).length, 22);
});

test("HTTP handler exposes liveness and metrics without stale fallback", async () => {
  const handler = createExporterHandler({
    topology,
    manifest,
    profile: "container",
    sampleHealthImpl: async () => report,
  });
  const health = await invoke(handler, "/healthz");
  assert.equal(health.status, 200);
  assert.equal(health.body, "ok\n");
  const metrics = await invoke(handler, "/metrics");
  assert.equal(metrics.status, 200);
  assert.match(metrics.headers["content-type"], /version=0\.0\.4/u);
  assert.match(metrics.body, /torium_localnet_consensus_height/u);
  const missing = await invoke(handler, "/unknown");
  assert.equal(missing.status, 404);
});

test("sampling and report-validation failures return a generic 503", async () => {
  for (const sampleHealthImpl of [
    async () => {
      throw new Error("authorization: Bearer secret-value");
    },
    async () => ({ ...report, schemaVersion: 99 }),
    async () => report,
    async () => ({
      ...report,
      backend: "raw",
      chain: { ...report.chain, highestHeight: -1 },
    }),
    async () => ({
      ...report,
      backend: "raw",
      consensus: { ...report.consensus, availableVotingPower: 100 },
    }),
  ]) {
    const handler = createExporterHandler({
      topology,
      manifest,
      profile: "raw",
      sampleHealthImpl,
    });
    const result = await invoke(handler, "/metrics");
    assert.equal(result.status, 503);
    assert.equal(result.body, "health sample unavailable\n");
    assert.doesNotMatch(result.body, /secret|authorization|Bearer/iu);
  }
});

async function invoke(handler, url, method = "GET") {
  const result = { status: null, headers: {}, body: "" };
  const response = {
    setHeader(name, value) {
      result.headers[name.toLowerCase()] = value;
    },
    writeHead(status, headers = {}) {
      result.status = status;
      for (const [name, value] of Object.entries(headers)) {
        result.headers[name.toLowerCase()] = value;
      }
    },
    end(body = "") {
      result.body += body;
    },
  };
  await handler({ method, url }, response);
  return result;
}
