import assert from "node:assert/strict";
import test from "node:test";
import { custom, fallback, http, webSocket } from "viem";

import { toriumLocalnet, withToriumRpcUrls } from "../dist/esm/chains.js";
import { createToriumPublicClient } from "../dist/esm/clients.js";

test("standard viem transports preserve local defaults and caller overrides", () => {
  const localHttp = http()({ chain: toriumLocalnet, retryCount: 0 });
  const localWebSocket = webSocket()({ chain: toriumLocalnet, retryCount: 0 });
  assert.equal(localHttp.value?.url, "http://127.0.0.1:8545");
  assert.equal(localWebSocket.config.type, "webSocket");

  const callerChain = withToriumRpcUrls(toriumLocalnet, {
    http: ["https://rpc.caller.example"],
    webSocket: ["wss://rpc.caller.example"],
  });
  const callerHttp = http()({ chain: callerChain, retryCount: 0 });
  assert.equal(callerHttp.value?.url, "https://rpc.caller.example");
});

test("custom EIP-1193 providers remain caller-owned", async () => {
  let request;
  const provider = {
    async request(parameters) {
      request = parameters;
      return "0x2a";
    },
  };
  const client = createToriumPublicClient({
    chain: toriumLocalnet,
    transport: custom(provider),
    pollingInterval: 1234,
  });
  assert.equal(client.pollingInterval, 1234);
  assert.equal(await client.getBlockNumber(), 42n);
  assert.deepEqual(request, { method: "eth_blockNumber" });
});

test("standard viem fallback works with multiple caller-supplied transports", async () => {
  const calls = [];
  const failed = custom({
    async request({ method }) {
      calls.push(`failed:${method}`);
      throw new Error("offline");
    },
  });
  const ready = custom({
    async request({ method }) {
      calls.push(`ready:${method}`);
      return "0x2a";
    },
  });
  const client = createToriumPublicClient({
    chain: toriumLocalnet,
    transport: fallback([failed, ready], { retryCount: 0 }),
  });
  assert.equal(await client.getBlockNumber(), 42n);
  assert.deepEqual(calls, ["failed:eth_blockNumber", "ready:eth_blockNumber"]);
});
