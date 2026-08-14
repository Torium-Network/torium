import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const packageDirectory = join(dirname(fileURLToPath(import.meta.url)), "..");
const root = join(packageDirectory, "../..");

async function json(path) {
  return JSON.parse(await readFile(join(root, path), "utf8"));
}

const [matrix, trustModel, rpcProfile, sdkPolicy, runtime] = await Promise.all([
  json("chain/poc/upstream-baseline/support-matrix.json"),
  json("chain/config/trust-model-v1.json"),
  json("chain/config/rpc-profile-v1.json"),
  json("chain/config/sdk-policy-v0.json"),
  import(
    pathToFileURL(join(packageDirectory, "dist/esm/clients.js")).toString()
  ),
]);

const capabilities = runtime.toriumReadCapabilities;
const matrixCapabilities = new Map(
  matrix.capabilities.map((capability) => [capability.id, capability])
);
const matrixState = (id) => matrixCapabilities.get(id)?.state;

assert.equal(capabilities.schemaVersion, matrix.schemaVersion);
assert.equal(capabilities.baseline.cosmosEvm, matrix.baseline.cosmosEvmRelease);
assert.equal(capabilities.baseline.viem, sdkPolicy.baseline.viem.testedVersion);
assert.equal(
  capabilities.blockTags.latest.block,
  matrixState("rpc.block-tag-latest")
);
assert.equal(
  capabilities.blockTags.latest.state,
  matrixState("rpc.block-tag-latest")
);
assert.equal(
  capabilities.blockTags.pending.block,
  matrixState("rpc.block-tag-pending")
);
assert.equal(
  capabilities.blockTags.pending.state,
  matrixState("rpc.block-tag-pending")
);
assert.equal(
  capabilities.blockTags.safe.block,
  matrixState("rpc.block-tag-safe")
);
assert.equal(capabilities.blockTags.safe.state, "unsupported");
assert.equal(
  capabilities.blockTags.safe.state,
  trustModel.finalityContract.jsonRpcSafeStateQueries.startsWith("unsupported")
    ? "unsupported"
    : "partial"
);
assert.equal(
  capabilities.blockTags.finalized.block,
  matrixState("rpc.block-tag-finalized")
);
assert.equal(
  capabilities.blockTags.finalized.state,
  matrixState("rpc.block-tag-finalized")
);
assert.equal(
  capabilities.blockTags.finalized.meaning,
  trustModel.finalityContract.jsonRpcFinalizedTag
);
assert.equal(
  capabilities.finality.finalizedTagMeaning,
  trustModel.finalityContract.jsonRpcFinalizedTag
);
assert.equal(
  capabilities.finality.finalizedTagMeaning,
  capabilities.blockTags.finalized.meaning
);
assert.equal(
  capabilities.finality.defaultConfirmationBlocks,
  trustModel.finalityContract.sdkDefaultConfirmationBlocks
);
assert.equal(
  capabilities.finality.label,
  trustModel.finalityContract.explorerLabel
);
assert.equal(
  capabilities.finality.beaconChainSemantics,
  trustModel.finalityContract.ethereumBeaconFinalityClaimAllowed
);
assert.equal(
  capabilities.finality.probabilisticConfirmation,
  trustModel.finalityContract.probabilisticConfirmationClaimAllowed
);
assert.equal(
  capabilities.finality.boundedInclusionClaim,
  trustModel.finalityContract.boundedTransactionInclusionClaimAllowed
);
assert.equal(
  capabilities.finality.replacementGenesisIsDiscontinuity,
  trustModel.finalityContract.clientTrustRequirements.some((requirement) =>
    requirement.includes("replacement genesis")
  )
);
assert.equal(
  capabilities.subscriptions.newHeads.baseline,
  matrixState("rpc.websocket-subscriptions")
);
assert.equal(
  capabilities.subscriptions.logs.baseline,
  matrixState("rpc.websocket-subscriptions")
);
assert.equal(
  capabilities.subscriptions.pendingTransactions.baseline,
  matrixState("rpc.websocket-subscriptions")
);
assert.equal(
  capabilities.subscriptions.newHeads.activeLocalProfile,
  rpcProfile.ethereum.webSocket.subscriptions.includes("newHeads")
    ? "supported"
    : "unsupported"
);
assert.equal(
  capabilities.subscriptions.logs.activeLocalProfile,
  rpcProfile.ethereum.webSocket.subscriptions.includes("logs")
    ? "supported"
    : "unsupported"
);
assert.equal(
  capabilities.subscriptions.pendingTransactions.activeLocalProfile,
  rpcProfile.ethereum.webSocket.subscriptions.includes("newPendingTransactions")
    ? "supported"
    : "unsupported"
);
assert.equal(
  capabilities.subscriptions.browserWebSocket,
  matrixState("rpc.websocket-browser-origin")
);
assert.equal(
  capabilities.subscriptions.serverReplay,
  rpcProfile.ethereum.webSocket.serverReplaysMissedMessages
);
assert.equal(
  capabilities.subscriptions.httpBackfillRequired,
  rpcProfile.ethereum.webSocket.httpBackfillRequired
);
assert.equal(
  capabilities.subscriptions.reconnectOwner,
  rpcProfile.ethereum.webSocket.clientReconnectRequired ? "client" : "server"
);
assert.deepEqual(capabilities.limits, {
  feeHistoryBlocks: rpcProfile.ethereum.limits.feeHistoryBlocks,
  logBlockRange: rpcProfile.ethereum.limits.getLogsBlockRange,
  logResults: rpcProfile.ethereum.limits.getLogsResults,
  ethCallGas: rpcProfile.ethereum.limits.ethCallGas,
  ethCallTimeoutMilliseconds:
    rpcProfile.ethereum.limits.ethCallTimeoutMilliseconds,
});
assert.equal(
  capabilities.cosmosExtension.status,
  matrixState("torium.cosmos-rest-grpc-extension-contract")
);
assert.equal(capabilities.cosmosExtension.usable, false);

for (const method of [
  "eth_chainId",
  "net_version",
  "eth_syncing",
  "eth_blockNumber",
  "web3_clientVersion",
  "net_listening",
  "net_peerCount",
]) {
  assert.ok(
    rpcProfile.ethereum.requiredSmokeMethods.includes(method),
    `${method} is missing from the active RPC profile smoke contract`
  );
}

console.log("Validated Torium SDK read capabilities against canonical inputs.");
