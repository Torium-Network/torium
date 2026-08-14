#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageDirectory = join(dirname(fileURLToPath(import.meta.url)), "..");
const root = join(packageDirectory, "../..");
const [identifiers, rpcProfile, chains] = await Promise.all([
  json(join(root, "chain/config/identifiers.json")),
  json(join(root, "chain/config/rpc-profile-v1.json")),
  import("../dist/esm/chains.js"),
]);

const expectedEnvironments = ["localnet", "devnet", "testnet", "mainnet"];
assert.deepEqual(Object.keys(chains.toriumChains), expectedEnvironments);
assert.equal(identifiers.manifestVersion, "0.2.0");
assert.equal(rpcProfile.profileVersion, "1.0.1");

for (const environment of expectedEnvironments) {
  const network = identifiers.networks.find(
    (candidate) => candidate.environment === environment
  );
  assert.ok(network, `missing canonical ${environment} network`);
  const chain = chains.toriumChains[environment];
  assert.equal(chain, chains.getToriumChain(environment));
  assert.equal(chain.id, network.evm.chainId);
  assert.equal(chain.name, network.displayName);
  assert.equal(chain.nativeCurrency.decimals, identifiers.currency.decimals);
  assert.equal(chain.nativeCurrency.symbol, network.nativeCurrencySymbol);
  assert.equal(
    chain.nativeCurrency.name,
    environment === "mainnet"
      ? identifiers.currency.mainnet.name
      : identifiers.currency.nonValueNetworks.name
  );
  assert.equal(chain.torium.environment, environment);
  assert.equal(chain.torium.manifestVersion, identifiers.manifestVersion);
  assert.equal(chain.torium.public, network.public);
  assert.equal(chain.torium.cosmosChainId, network.cosmos.chainId);
  assert.equal(chain.torium.chainIdHex, network.evm.chainIdHex);
  assert.equal(chain.torium.networkId, network.evm.networkId);
  assert.equal(chain.torium.caip2, network.evm.caip2);
  assert.equal(chain.torium.baseDenom, identifiers.currency.baseDenom);
  assert.equal(chain.blockExplorers, undefined);
  assert.equal(chain.contracts, undefined);
  assert.equal(chain.id === 262144, false);

  if (environment === "localnet") {
    assert.deepEqual(
      chain.rpcUrls.default.http,
      identifiers.walletMetadata.localnetDefaults.rpcUrls
    );
    assert.deepEqual(
      chain.rpcUrls.default.webSocket,
      identifiers.walletMetadata.localnetDefaults.webSocketUrls
    );
    assert.equal(chain.torium.endpointStatus, "local-loopback");
    assert.equal(
      chain.torium.rpcProfile.profileVersion,
      rpcProfile.profileVersion
    );
    assert.equal(
      chain.torium.rpcProfile.maxBatchRequests,
      rpcProfile.ethereum.limits.batchRequests
    );
    assert.deepEqual(
      chain.torium.rpcProfile.subscriptions,
      rpcProfile.ethereum.webSocket.subscriptions
    );
    assert.equal(
      chain.torium.rpcProfile.serverReplaysMissedMessages,
      rpcProfile.ethereum.webSocket.serverReplaysMissedMessages
    );
    assert.equal(
      chain.torium.rpcProfile.clientReconnectRequired,
      rpcProfile.ethereum.webSocket.clientReconnectRequired
    );
    assert.equal(
      chain.torium.rpcProfile.httpBackfillRequired,
      rpcProfile.ethereum.webSocket.httpBackfillRequired
    );
  } else {
    assert.deepEqual(chain.rpcUrls.default.http, []);
    assert.equal(chain.rpcUrls.default.webSocket, undefined);
    assert.equal(chain.torium.endpointStatus, "deferred-unpublished");
    assert.equal(chain.torium.rpcProfile, undefined);
  }
}

assert.equal(chains.toriumLocalnet.testnet, true);
assert.equal(chains.toriumDevnet.testnet, true);
assert.equal(chains.toriumTestnet.testnet, true);
assert.equal(chains.toriumMainnet.testnet, false);
assert.equal(rpcProfile.clientNode, "validator-0");
assert.equal(
  rpcProfile.nodes.filter((node) =>
    node.clientServices.includes("ethereum-json-rpc-http")
  ).length,
  1
);
assert.equal(rpcProfile.ethereum.httpUrl, "http://127.0.0.1:8545");
assert.equal(rpcProfile.ethereum.webSocketUrl, "ws://127.0.0.1:8546");

console.log("Validated four canonical Torium chain definitions.");

async function json(path) {
  return JSON.parse(await readFile(path, "utf8"));
}
