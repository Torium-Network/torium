#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const requestTimeoutMs = 2_000;

export function hostCometRPCPort(profile, node, index) {
  return profile === "container" ? 26657 + index * 100 : node.ports.comet_rpc;
}

export async function sampleHealth({
  topology,
  manifest,
  profile,
  fetchImpl = fetch,
}) {
  const validators = await Promise.all(
    topology.nodes.map(async (node, index) => {
      const rpcPort = hostCometRPCPort(profile, node, index);
      const rpcUrl = `http://127.0.0.1:${rpcPort}`;
      try {
        const payload = await requestJSON(`${rpcUrl}/status`, {}, fetchImpl);
        const status = payload?.result;
        const height = Number(status?.sync_info?.latest_block_height ?? 0);
        const catchingUp = status?.sync_info?.catching_up !== false;
        const observedNodeID = status?.node_info?.id ?? null;
        const identityMatches = observedNodeID === node.node_id;
        const observedNetwork = status?.node_info?.network ?? null;
        const networkMatches = observedNetwork === topology.cosmos_chain_id;
        const cometVersion = status?.node_info?.version ?? null;
        let peerCount = null;
        let peerError = null;
        try {
          const netInfo = await requestJSON(
            `${rpcUrl}/net_info`,
            {},
            fetchImpl
          );
          peerCount = Number(netInfo?.result?.n_peers ?? 0);
        } catch (error) {
          peerError = errorMessage(error);
        }
        const ready =
          height > 0 &&
          !catchingUp &&
          identityMatches &&
          networkMatches &&
          typeof cometVersion === "string" &&
          cometVersion.length > 0;
        const mismatchError = !identityMatches
          ? "CometBFT node ID differs from topology"
          : !networkMatches
            ? "Cosmos chain ID differs from topology"
            : null;
        return {
          name: node.name,
          rpcUrl,
          votingPower: node.voting_power,
          status: ready
            ? "ready"
            : !identityMatches
              ? "identity-mismatch"
              : !networkMatches
                ? "network-mismatch"
                : catchingUp
                  ? "catching-up"
                  : height === 0
                    ? "booting"
                    : "not-ready",
          reachable: true,
          ready,
          height,
          catchingUp,
          peerCount,
          peerError,
          cometVersion,
          expectedNetwork: topology.cosmos_chain_id,
          observedNetwork,
          networkMatches,
          expectedNodeID: node.node_id,
          observedNodeID,
          identityMatches,
          error: mismatchError,
        };
      } catch (error) {
        return {
          name: node.name,
          rpcUrl,
          votingPower: node.voting_power,
          status: "unreachable",
          reachable: false,
          ready: false,
          height: 0,
          catchingUp: null,
          peerCount: null,
          peerError: null,
          cometVersion: null,
          expectedNetwork: topology.cosmos_chain_id,
          observedNetwork: null,
          networkMatches: null,
          expectedNodeID: node.node_id,
          observedNodeID: null,
          identityMatches: null,
          error: errorMessage(error),
        };
      }
    })
  );

  const clientNode = topology.nodes.find((node) => node.client_traffic);
  if (!clientNode) throw new Error("topology does not define a client node");
  const evmUrl = `http://127.0.0.1:${clientNode.ports.evm_http}`;
  let evm;
  try {
    const payloads = await requestJSON(
      evmUrl,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify([
          rpcRequest("chain-id", "eth_chainId"),
          rpcRequest("height", "eth_blockNumber"),
          rpcRequest("sync", "eth_syncing"),
          rpcRequest("peers", "net_peerCount"),
          rpcRequest("version", "web3_clientVersion"),
        ]),
      },
      fetchImpl
    );
    if (!Array.isArray(payloads)) {
      throw new Error("JSON-RPC health batch returned a non-array response");
    }
    const observedChainID = Number(BigInt(rpcResult(payloads, "chain-id")));
    const height = Number(BigInt(rpcResult(payloads, "height")));
    const syncing = rpcResult(payloads, "sync");
    const peerCount = Number(BigInt(rpcResult(payloads, "peers")));
    const clientVersion = rpcResult(payloads, "version");
    const chainMatches = observedChainID === topology.evm_chain_id;
    const ready =
      chainMatches &&
      height > 0 &&
      syncing === false &&
      typeof clientVersion === "string" &&
      clientVersion.length > 0;
    evm = {
      url: evmUrl,
      reachable: true,
      ready,
      expectedChainID: topology.evm_chain_id,
      observedChainID,
      chainMatches,
      height,
      syncing,
      peerCount,
      clientVersion,
      error: !chainMatches
        ? "EVM chain ID mismatch"
        : height === 0
          ? "EVM has not committed a block"
          : syncing !== false
            ? "EVM reports syncing"
            : null,
    };
  } catch (error) {
    evm = {
      url: evmUrl,
      reachable: false,
      ready: false,
      expectedChainID: topology.evm_chain_id,
      observedChainID: null,
      chainMatches: null,
      height: 0,
      syncing: null,
      peerCount: null,
      clientVersion: null,
      error: errorMessage(error),
    };
  }

  const restUrl = `http://127.0.0.1:${clientNode.ports.cosmos_rest}`;
  let rest;
  try {
    const payload = await requestJSON(
      `${restUrl}/cosmos/base/tendermint/v1beta1/node_info`,
      {},
      fetchImpl
    );
    const observedNetwork = payload?.default_node_info?.network ?? null;
    const applicationVersion = payload?.application_version?.version ?? null;
    const ready =
      observedNetwork === topology.cosmos_chain_id &&
      typeof applicationVersion === "string" &&
      applicationVersion.length > 0;
    rest = {
      url: restUrl,
      reachable: true,
      ready,
      expectedNetwork: topology.cosmos_chain_id,
      observedNetwork,
      applicationName: payload?.application_version?.name ?? null,
      applicationVersion,
      cosmosSDKVersion:
        payload?.application_version?.cosmos_sdk_version ?? null,
      error: ready ? null : "REST node identity or version is unavailable",
    };
  } catch (error) {
    rest = {
      url: restUrl,
      reachable: false,
      ready: false,
      expectedNetwork: topology.cosmos_chain_id,
      observedNetwork: null,
      applicationName: null,
      applicationVersion: null,
      cosmosSDKVersion: null,
      error: errorMessage(error),
    };
  }

  const availableVotingPower = validators
    .filter((validator) => validator.ready)
    .reduce((sum, validator) => sum + validator.votingPower, 0);
  const highestHeight = Math.max(0, ...validators.map(({ height }) => height));
  const consensusReady = availableVotingPower >= topology.commit_quorum_power;
  const allValidatorsReady = validators.every(({ ready }) => ready);
  const identityMismatch = validators.some(
    ({ reachable, identityMatches, networkMatches }) =>
      reachable && (identityMatches === false || networkMatches === false)
  );
  const syncing =
    validators.some(({ catchingUp }) => catchingUp === true) ||
    (evm.reachable && evm.syncing !== false && evm.syncing !== null);
  const fullyReady = consensusReady && evm.ready && rest.ready;
  const state = identityMismatch
    ? "unhealthy"
    : syncing
      ? "syncing"
      : fullyReady
        ? allValidatorsReady
          ? "ready"
          : "degraded"
        : highestHeight === 0 &&
            (validators.some(({ reachable }) => reachable) ||
              evm.reachable ||
              rest.reachable)
          ? "booting"
          : "unhealthy";

  return {
    schemaVersion: 2,
    generatedAt: new Date().toISOString(),
    warning: topology.warning,
    backend: profile,
    state,
    ready: fullyReady,
    allValidatorsReady,
    chain: {
      cosmosChainID: topology.cosmos_chain_id,
      evmChainID: topology.evm_chain_id,
      evmChainIDHex: `0x${topology.evm_chain_id.toString(16)}`,
      genesisSHA256: topology.genesis_sha256,
      highestHeight,
      evmHeight: evm.height,
    },
    consensus: {
      ready: consensusReady,
      availableVotingPower,
      totalVotingPower: topology.total_voting_power,
      commitQuorumPower: topology.commit_quorum_power,
    },
    evm,
    rest,
    endpoints: {
      evmHTTP: evmUrl,
      evmWebSocket: `ws://127.0.0.1:${clientNode.ports.evm_ws}`,
      cosmosREST: restUrl,
      cosmosGRPC: `127.0.0.1:${clientNode.ports.cosmos_grpc}`,
      cometRPC:
        validators.find(({ name }) => name === topology.client_node)?.rpcUrl ??
        null,
    },
    validators,
    fundedAccounts: manifest.development_accounts.map((account) => ({
      name: account.name,
      bech32Address: account.bech32_address,
      evmAddress: account.evm_address,
      allocationBaseUnits: account.allocation_base_units,
    })),
  };
}

export function requirementsSatisfied(
  report,
  { requireAll = false, requireNode = null } = {}
) {
  if (!report.ready) return false;
  if (requireAll && !report.allValidatorsReady) return false;
  if (requireNode) {
    return report.validators.some(
      ({ name, ready }) => name === requireNode && ready
    );
  }
  return true;
}

export async function waitForReadiness({
  topology,
  manifest,
  profile,
  timeoutSeconds,
  requireAll = false,
  requireNode = null,
  fetchImpl = fetch,
  sleepImpl = sleep,
}) {
  const startedAt = Date.now();
  const initial = await sampleHealth({
    topology,
    manifest,
    profile,
    fetchImpl,
  });
  const initialHeight = initial.chain.highestHeight;
  let report = initial;

  while (Date.now() - startedAt < timeoutSeconds * 1_000) {
    if (
      requirementsSatisfied(report, { requireAll, requireNode }) &&
      report.chain.highestHeight > initialHeight
    ) {
      return { ...report, progressObserved: true, initialHeight };
    }
    await sleepImpl(1_000);
    report = await sampleHealth({ topology, manifest, profile, fetchImpl });
  }

  const error = new Error(
    `localnet did not become ready within ${timeoutSeconds} seconds`
  );
  error.report = { ...report, progressObserved: false, initialHeight };
  throw error;
}

export function formatReport(report, { onlyNode = null } = {}) {
  const lines = [
    report.warning,
    `Torium localnet: ${report.state.toUpperCase()} (${report.backend})`,
    `Chain: ${report.chain.cosmosChainID} | EVM ${report.chain.evmChainID} (${report.chain.evmChainIDHex})`,
    `Height: consensus=${report.chain.highestHeight} evm=${report.chain.evmHeight} | quorum ${report.consensus.availableVotingPower}/${report.consensus.totalVotingPower} (required ${report.consensus.commitQuorumPower})`,
    `Genesis SHA-256: ${report.chain.genesisSHA256}`,
    "Endpoints:",
    `  EVM HTTP       ${report.endpoints.evmHTTP}`,
    `  EVM WebSocket  ${report.endpoints.evmWebSocket}`,
    `  Cosmos REST    ${report.endpoints.cosmosREST}`,
    `  Cosmos gRPC    ${report.endpoints.cosmosGRPC}`,
    `  CometBFT RPC   ${report.endpoints.cometRPC}`,
    `EVM RPC: ${report.evm.ready ? "ready" : "not-ready"} chain=${report.evm.observedChainID ?? "unavailable"}/${report.evm.expectedChainID} height=${report.evm.height} peers=${report.evm.peerCount ?? "unavailable"} sync=${formatSync(report.evm.syncing)} version=${report.evm.clientVersion ?? "unavailable"}${report.evm.error ? ` (${report.evm.error})` : ""}`,
    `Cosmos REST: ${report.rest.ready ? "ready" : "not-ready"} network=${report.rest.observedNetwork ?? "unavailable"} app=${report.rest.applicationName ?? "unavailable"}@${report.rest.applicationVersion ?? "unavailable"}${report.rest.error ? ` (${report.rest.error})` : ""}`,
    "Validators:",
  ];
  const validators = onlyNode
    ? report.validators.filter(({ name }) => name === onlyNode)
    : report.validators;
  for (const validator of validators) {
    lines.push(
      `  [${validator.status}] ${validator.name} power=${validator.votingPower} height=${validator.height} peers=${validator.peerCount ?? "unavailable"} sync=${formatSync(validator.catchingUp)} comet=${validator.cometVersion ?? "unavailable"} rpc=${validator.rpcUrl}${validator.error ? ` (${validator.error})` : ""}${validator.peerError ? ` (peer check: ${validator.peerError})` : ""}`
    );
  }
  lines.push("Funded public fixtures:");
  for (const account of report.fundedAccounts) {
    lines.push(
      `  ${account.name.padEnd(9)} ${account.evmAddress} | ${account.bech32Address}`
    );
  }
  if (report.progressObserved === true) {
    lines.push(
      `Readiness observed block progress from ${report.initialHeight} to ${report.chain.highestHeight}.`
    );
  }
  return `${lines.join("\n")}\n`;
}

function rpcRequest(id, method, params = []) {
  return { jsonrpc: "2.0", id, method, params };
}

function rpcResult(payloads, id) {
  const payload = payloads.find((candidate) => candidate?.id === id);
  if (!payload) throw new Error(`JSON-RPC health batch omitted ${id}`);
  if (payload.error) {
    throw new Error(
      payload.error.message ?? `JSON-RPC health method ${id} failed`
    );
  }
  if (!("result" in payload)) {
    throw new Error(`JSON-RPC health batch omitted the ${id} result`);
  }
  return payload.result;
}

function formatSync(value) {
  if (value === false) return "false";
  if (value === true) return "true";
  if (value === null || value === undefined) return "unavailable";
  return "syncing";
}

async function requestJSON(url, options, fetchImpl) {
  const response = await fetchImpl(url, {
    ...options,
    signal: AbortSignal.timeout(requestTimeoutMs),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function sleep(milliseconds) {
  return new Promise((resolvePromise) =>
    setTimeout(resolvePromise, milliseconds)
  );
}

function parseArgs(argv) {
  const args = {
    root: null,
    manifest: null,
    profile: null,
    wait: false,
    timeoutSeconds: 90,
    json: false,
    requireAll: false,
    requireNode: null,
    onlyNode: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    switch (value) {
      case "--root":
        args.root = argv[++index];
        break;
      case "--manifest":
        args.manifest = argv[++index];
        break;
      case "--profile":
        args.profile = argv[++index];
        break;
      case "--wait":
        args.wait = true;
        break;
      case "--timeout":
        args.timeoutSeconds = Number(argv[++index]);
        break;
      case "--json":
        args.json = true;
        break;
      case "--require-all":
        args.requireAll = true;
        break;
      case "--require-node":
        args.requireNode = argv[++index];
        break;
      case "--only-node":
        args.onlyNode = argv[++index];
        break;
      default:
        throw new Error(`unknown health option ${value}`);
    }
  }
  if (
    !args.root ||
    !args.manifest ||
    !["container", "raw"].includes(args.profile)
  ) {
    throw new Error(
      "health requires --root, --manifest, and --profile container|raw"
    );
  }
  if (!Number.isInteger(args.timeoutSeconds) || args.timeoutSeconds < 1) {
    throw new Error("health timeout must be a positive integer");
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const topology = JSON.parse(
    await readFile(resolve(args.root, "topology.json"), "utf8")
  );
  const manifest = JSON.parse(await readFile(resolve(args.manifest), "utf8"));
  let report;
  let success;
  try {
    report = args.wait
      ? await waitForReadiness({
          topology,
          manifest,
          profile: args.profile,
          timeoutSeconds: args.timeoutSeconds,
          requireAll: args.requireAll,
          requireNode: args.requireNode,
        })
      : await sampleHealth({ topology, manifest, profile: args.profile });
    const selectedNodeReady = args.onlyNode
      ? report.validators.some(
          ({ name, ready }) => name === args.onlyNode && ready
        )
      : null;
    success = args.onlyNode
      ? selectedNodeReady
      : requirementsSatisfied(report, args);
  } catch (error) {
    if (!error.report) throw error;
    report = error.report;
    success = false;
    report.error = errorMessage(error);
  }

  if (args.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(formatReport(report, { onlyNode: args.onlyNode }));
    if (report.error) process.stderr.write(`${report.error}\n`);
  }
  if (!success) process.exitCode = 1;
}

const invokedPath = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : null;
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(
      `Torium localnet health error: ${errorMessage(error)}\n`
    );
    process.exitCode = 2;
  });
}
