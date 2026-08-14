import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const directory = dirname(fileURLToPath(import.meta.url));
const chainDirectory = join(directory, "..");
const [profile, protocol, identifiers, compose] = await Promise.all([
  readJSON("rpc-profile-v1.json"),
  readJSON("protocol-v1.json"),
  readJSON("identifiers.json"),
  readFile(join(chainDirectory, "localnet", "compose.yaml"), "utf8"),
]);

assert.equal(profile.schemaVersion, 1);
assert.equal(profile.status, "active-local-only");
assert.equal(profile.environment, "localnet");
assert.equal(profile.ownerIssue, 96);
assert.equal(profile.clientNode, "validator-0");
assert.equal(profile.nodes.length, 4);
assert.deepEqual(
  profile.nodes.map(({ name }) => name),
  ["validator-0", "validator-1", "validator-2", "validator-3"]
);
assert.equal(profile.nodes[0].role, "consensus-and-client");
for (const node of profile.nodes.slice(1)) {
  assert.equal(node.role, "consensus-only");
  assert.deepEqual(node.clientServices, ["comet-rpc-diagnostic"]);
}

const localnet = identifiers.networks.find(
  ({ environment }) => environment === "localnet"
);
assert.ok(localnet, "canonical localnet identifier row is missing");
assert.equal(profile.ethereum.chainId, localnet.evm.chainId);
assert.equal(profile.ethereum.chainIdHex, localnet.evm.chainIdHex);
assert.equal(profile.ethereum.networkId, localnet.evm.networkId);
assert.deepEqual(
  [profile.ethereum.httpUrl],
  identifiers.walletMetadata.localnetDefaults.rpcUrls
);
assert.deepEqual(
  [profile.ethereum.webSocketUrl],
  identifiers.walletMetadata.localnetDefaults.webSocketUrls
);
assert.equal(profile.wallet.chainName, localnet.displayName);
assert.equal(
  profile.wallet.nativeCurrencySymbol,
  localnet.nativeCurrencySymbol
);
assert.equal(
  profile.wallet.nativeCurrencyDecimals,
  identifiers.currency.decimals
);
assert.equal(profile.wallet.publishable, false);

assert.deepEqual(
  profile.ethereum.namespaces.enabled,
  protocol.rpc.defaultNamespaces
);
assert.deepEqual(
  profile.ethereum.namespaces.operatorOnlyNotEnabled,
  protocol.rpc.operatorOnlyNamespaces
);
assert.deepEqual(
  profile.ethereum.namespaces.disabled,
  protocol.rpc.disabledNamespaces
);
assert.deepEqual(profile.ethereum.limits, {
  ethCallGas: protocol.rpc.limits.ethCallGasCap,
  ethCallTimeoutMilliseconds: protocol.rpc.limits.ethCallTimeoutMs,
  feeHistoryBlocks: protocol.rpc.limits.feeHistoryBlockCap,
  getLogsResults: protocol.rpc.limits.getLogsResultCap,
  getLogsBlockRange: protocol.rpc.limits.getLogsBlockRangeCap,
  httpBodyBytes: protocol.rpc.limits.httpBodyBytes,
  batchRequests: protocol.rpc.limits.httpBatchRequests,
  batchResponseBytes: protocol.rpc.limits.httpBatchResponseBytes,
  maxOpenConnections: 256,
  httpReadWriteTimeoutMilliseconds: 30_000,
  httpIdleTimeoutMilliseconds: 120_000,
});
assert.equal(profile.ethereum.safety.allowInsecureUnlock, false);
assert.equal(profile.ethereum.webSocket.wildcardOriginAllowed, false);
assert.ok(!profile.ethereum.webSocket.allowedOrigins.includes("*"));
assert.equal(
  profile.ethereum.webSocket.browserOriginSupportedByLocalProfile,
  false
);
assert.deepEqual(profile.ethereum.webSocket.subscriptions, [
  "newHeads",
  "logs",
  "newPendingTransactions",
]);
assert.equal(profile.exposure.publicEndpointsAllowed, false);
assert.equal(profile.exposure.hostPublishing, "loopback-only");
assert.equal(profile.exposure.httpCors.publicUseAllowed, false);
assert.equal(profile.exposure.httpCors.publicPolicyOwnerIssue, 114);
assert.equal(profile.exposure.rateLimit.publicBoundaryRequired, true);
assert.equal(profile.exposure.rateLimit.publicPolicyOwnerIssue, 114);

const publishedPorts = [...compose.matchAll(/^\s+- "([^"]+)"$/gmu)].map(
  (match) => match[1]
);
assert.ok(publishedPorts.length > 0, "Compose publishes no local ports");
for (const mapping of publishedPorts) {
  assert.match(
    mapping,
    /^127\.0\.0\.1:/u,
    `non-loopback host port: ${mapping}`
  );
}
for (const required of [
  "127.0.0.1:1317:1317",
  "127.0.0.1:8545:8545",
  "127.0.0.1:8546:8546",
  "127.0.0.1:9090:9090",
  "127.0.0.1:26657:26657",
]) {
  assert.ok(
    publishedPorts.includes(required),
    `missing Compose mapping ${required}`
  );
}

assert.deepEqual(profile.health.states, [
  "booting",
  "syncing",
  "ready",
  "degraded",
  "unhealthy",
]);
assert.equal(profile.health.schemaVersion, 2);
assert.equal(profile.cosmos.extensionContractOwnerIssue, 131);
assert.equal(profile.comet.unsafeMethods, false);
assert.deepEqual(profile.comet.corsOrigins, []);
assert.equal(profile.comet.pprofAddress, "");

process.stdout.write(
  `${JSON.stringify(
    {
      valid: true,
      profileVersion: profile.profileVersion,
      environment: profile.environment,
      clientNode: profile.clientNode,
      hostPublishing: profile.exposure.hostPublishing,
      enabledNamespaces: profile.ethereum.namespaces.enabled,
      healthStates: profile.health.states,
    },
    null,
    2
  )}\n`
);

async function readJSON(name) {
  return JSON.parse(await readFile(join(directory, name), "utf8"));
}
