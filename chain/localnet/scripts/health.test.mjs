import assert from "node:assert/strict";
import test from "node:test";

import {
  hostCometRPCPort,
  requirementsSatisfied,
  sampleHealth,
  waitForReadiness,
} from "./health.mjs";

const topology = {
  warning: "VALUELESS LOCAL DEVELOPMENT ONLY",
  profile: "container",
  cosmos_chain_id: "torium-localnet-1",
  evm_chain_id: 1414484556,
  genesis_sha256: "a".repeat(64),
  total_voting_power: 100,
  commit_quorum_power: 67,
  client_node: "validator-0",
  nodes: Array.from({ length: 4 }, (_, index) => ({
    name: `validator-${index}`,
    node_id: `node-${index}`,
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
      bech32_address: "torium1fixture",
      evm_address: "0x0000000000000000000000000000000000000001",
      allocation_base_units: "1",
    },
  ],
};

function mockFetch({
  unavailable = [],
  catchingUp = [],
  evmChainID = topology.evm_chain_id,
  evmHeight = 42,
  evmSyncing = false,
  consensusHeight = 42,
  restNetwork = topology.cosmos_chain_id,
} = {}) {
  return async (url, options = {}) => {
    if (options.method === "POST") {
      return response(
        rpcHealthBatch(JSON.parse(options.body), {
          evmChainID,
          evmHeight,
          evmSyncing,
        })
      );
    }
    const parsed = new URL(url);
    if (parsed.port === "1317") {
      return response(restNodeInfo({ network: restNetwork }));
    }
    const port = Number(new URL(url).port);
    const index = (port - 26657) / 100;
    if (unavailable.includes(index)) throw new Error("connection refused");
    if (parsed.pathname === "/net_info") {
      return response({ result: { n_peers: "3" } });
    }
    return response(
      cometStatus(index, {
        height: consensusHeight,
        catchingUp: catchingUp.includes(index),
      })
    );
  };
}

function response(payload) {
  return { ok: true, status: 200, json: async () => payload };
}

function rpcHealthBatch(
  requests,
  {
    evmChainID = topology.evm_chain_id,
    evmHeight = 42,
    evmSyncing = false,
  } = {}
) {
  const results = {
    "chain-id": `0x${evmChainID.toString(16)}`,
    height: `0x${evmHeight.toString(16)}`,
    sync: evmSyncing,
    peers: "0x3",
    version: "Torium/0.1.0-local.1",
  };
  return requests.map(({ id }) => ({
    jsonrpc: "2.0",
    id,
    result: results[id],
  }));
}

function cometStatus(
  index,
  {
    height = 42,
    catchingUp = false,
    nodeID = `node-${index}`,
    network = topology.cosmos_chain_id,
  } = {}
) {
  return {
    result: {
      node_info: {
        id: nodeID,
        network,
        version: "0.39.3",
      },
      sync_info: {
        latest_block_height: String(height),
        catching_up: catchingUp,
      },
    },
  };
}

function restNodeInfo({ network = topology.cosmos_chain_id } = {}) {
  return {
    default_node_info: { network },
    application_version: {
      name: "Torium",
      version: "0.1.0-local.1",
      cosmos_sdk_version: "v0.54.3",
    },
  };
}

test("container health maps four diagnostic RPC host ports", () => {
  assert.deepEqual(
    topology.nodes.map((node, index) =>
      hostCometRPCPort("container", node, index)
    ),
    [26657, 26757, 26857, 26957]
  );
});

test("three healthy validators satisfy the 67-power quorum but report degraded", async () => {
  const report = await sampleHealth({
    topology,
    manifest,
    profile: "container",
    fetchImpl: mockFetch({ unavailable: [3] }),
  });
  assert.equal(report.consensus.availableVotingPower, 75);
  assert.equal(report.ready, true);
  assert.equal(report.state, "degraded");
  assert.equal(report.schemaVersion, 2);
  assert.equal(report.evm.height, 42);
  assert.equal(report.evm.peerCount, 3);
  assert.equal(report.rest.applicationVersion, "0.1.0-local.1");
  assert.equal(requirementsSatisfied(report), true);
  assert.equal(requirementsSatisfied(report, { requireAll: true }), false);
  assert.equal(
    requirementsSatisfied(report, { requireNode: "validator-3" }),
    false
  );
});

test("two unavailable validators fail quorum readiness", async () => {
  const report = await sampleHealth({
    topology,
    manifest,
    profile: "container",
    fetchImpl: mockFetch({ unavailable: [2, 3] }),
  });
  assert.equal(report.consensus.availableVotingPower, 50);
  assert.equal(report.consensus.ready, false);
  assert.equal(report.ready, false);
  assert.equal(report.state, "unhealthy");
});

test("wrong EVM replay domain fails developer readiness", async () => {
  const report = await sampleHealth({
    topology,
    manifest,
    profile: "container",
    fetchImpl: mockFetch({ evmChainID: 1 }),
  });
  assert.equal(report.consensus.ready, true);
  assert.equal(report.evm.ready, false);
  assert.equal(report.ready, false);
  assert.equal(report.state, "unhealthy");
});

test("validator identity drift is excluded from available voting power", async () => {
  const fetchImpl = async (url, options = {}) => {
    if (options.method === "POST") {
      return response(rpcHealthBatch(JSON.parse(options.body)));
    }
    const parsed = new URL(url);
    if (parsed.port === "1317") return response(restNodeInfo());
    const port = Number(parsed.port);
    const index = (port - 26657) / 100;
    if (parsed.pathname === "/net_info") {
      return response({ result: { n_peers: "3" } });
    }
    return response(
      cometStatus(index, {
        nodeID: index === 3 ? "unexpected-node" : `node-${index}`,
      })
    );
  };
  const report = await sampleHealth({
    topology,
    manifest,
    profile: "container",
    fetchImpl,
  });

  assert.equal(report.validators[3].status, "identity-mismatch");
  assert.equal(report.consensus.availableVotingPower, 75);
  assert.equal(report.state, "unhealthy");
});

test("zero-height reachable services report booting", async () => {
  const report = await sampleHealth({
    topology,
    manifest,
    profile: "container",
    fetchImpl: mockFetch({ consensusHeight: 0, evmHeight: 0 }),
  });
  assert.equal(report.ready, false);
  assert.equal(report.state, "booting");
});

test("catching-up consensus or EVM reports syncing", async () => {
  const consensusReport = await sampleHealth({
    topology,
    manifest,
    profile: "container",
    fetchImpl: mockFetch({ catchingUp: [3] }),
  });
  assert.equal(consensusReport.state, "syncing");
  assert.equal(consensusReport.ready, true);

  const evmReport = await sampleHealth({
    topology,
    manifest,
    profile: "container",
    fetchImpl: mockFetch({ evmSyncing: { currentBlock: "0x1" } }),
  });
  assert.equal(evmReport.state, "syncing");
  assert.equal(evmReport.ready, false);
});

test("wrong Cosmos network is unhealthy and excluded from quorum", async () => {
  const fetchImpl = async (url, options = {}) => {
    if (options.method === "POST") {
      return response(rpcHealthBatch(JSON.parse(options.body)));
    }
    const parsed = new URL(url);
    if (parsed.port === "1317") return response(restNodeInfo());
    const index = (Number(parsed.port) - 26657) / 100;
    if (parsed.pathname === "/net_info") {
      return response({ result: { n_peers: "3" } });
    }
    return response(
      cometStatus(index, {
        network: index === 0 ? "wrong-chain-1" : topology.cosmos_chain_id,
      })
    );
  };
  const report = await sampleHealth({
    topology,
    manifest,
    profile: "container",
    fetchImpl,
  });
  assert.equal(report.state, "unhealthy");
  assert.equal(report.consensus.availableVotingPower, 75);
  assert.equal(report.validators[0].networkMatches, false);
});

test("readiness requires an observed increase in block height", async () => {
  let statusRequests = 0;
  const fetchImpl = async (url, options = {}) => {
    if (options.method === "POST") {
      return response(
        rpcHealthBatch(JSON.parse(options.body), { evmHeight: 43 })
      );
    }
    const parsed = new URL(url);
    if (parsed.port === "1317") return response(restNodeInfo());
    const port = Number(parsed.port);
    const index = (port - 26657) / 100;
    if (parsed.pathname === "/net_info") {
      return response({ result: { n_peers: "3" } });
    }
    const round = Math.floor(statusRequests / topology.nodes.length);
    statusRequests += 1;
    return response(cometStatus(index, { height: 42 + round }));
  };

  const report = await waitForReadiness({
    topology,
    manifest,
    profile: "container",
    timeoutSeconds: 1,
    requireAll: true,
    fetchImpl,
    sleepImpl: async () => {},
  });

  assert.equal(report.progressObserved, true);
  assert.equal(report.initialHeight, 42);
  assert.equal(report.chain.highestHeight, 43);
});
