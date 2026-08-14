import assert from "node:assert/strict";
import test from "node:test";
import { custom } from "viem";

import { toriumLocalnet } from "../dist/esm/chains.js";
import {
  createToriumPublicClient,
  toriumPublicActions,
} from "../dist/esm/clients.js";

const statusResponses = {
  eth_chainId: "0x544f524c",
  net_version: "1414484556",
  eth_syncing: false,
  eth_blockNumber: "0x2a",
  web3_clientVersion: "torium-test/v0",
  net_listening: true,
  net_peerCount: "0x20000000000001",
};

test("the extended client preserves standard viem reads and raw request", async () => {
  const calls = [];
  const provider = {
    async request({ method }) {
      calls.push(method);
      if (method === "eth_blockNumber") return "0x2a";
      if (method === "eth_getBalance") return "0xde0b6b3a7640000";
      if (method === "web3_clientVersion") return "torium-test/v0";
      throw new Error(`Unexpected method: ${method}`);
    },
  };
  const client = createToriumPublicClient({
    chain: toriumLocalnet,
    transport: custom(provider),
  });

  assert.equal(client.chain.id, 1414484556);
  assert.equal(await client.getBlockNumber(), 42n);
  assert.equal(
    await client.getBalance({
      address: "0x0000000000000000000000000000000000000001",
    }),
    1_000_000_000_000_000_000n
  );
  assert.equal(
    await client.request({ method: "web3_clientVersion" }),
    "torium-test/v0"
  );
  assert.equal(typeof client.getBlock, "function");
  assert.equal(typeof client.getTransactionReceipt, "function");
  assert.equal(typeof client.readContract, "function");
  assert.deepEqual(calls, [
    "eth_blockNumber",
    "eth_getBalance",
    "web3_clientVersion",
  ]);
});

test("network status is read-only, bigint-safe, and forwards AbortSignal", async () => {
  const calls = [];
  const signal = AbortSignal.timeout(5_000);
  const fakeClient = {
    chain: toriumLocalnet,
    async request({ method }, options) {
      calls.push({ method, signal: options?.signal });
      if (!(method in statusResponses)) {
        throw new Error(`Unexpected method: ${method}`);
      }
      return statusResponses[method];
    },
  };

  const status = await toriumPublicActions(fakeClient).getToriumNetworkStatus({
    signal,
    minimumBlockNumber: 42n,
  });

  assert.equal(status.blockNumber, 42n);
  assert.equal(status.peerCount, 9_007_199_254_740_993n);
  assert.equal(status.clientVersion, "torium-test/v0");
  assert.equal(status.listening, true);
  assert.equal(status.finality.label, "CometBFT committed");
  assert.equal(status.finality.beaconChainSemantics, false);
  assert.deepEqual(
    calls.map(({ method }) => method),
    [
      "eth_chainId",
      "net_version",
      "eth_syncing",
      "eth_blockNumber",
      "web3_clientVersion",
      "net_listening",
      "net_peerCount",
    ]
  );
  assert.ok(calls.every((call) => call.signal === signal));
  assert.equal(
    calls.some((call) => /account|sign|send/iu.test(call.method)),
    false
  );
});

test("network status redacts transport errors", async () => {
  const fakeClient = {
    chain: toriumLocalnet,
    async request() {
      throw new Error("credential-sentinel");
    },
  };

  await assert.rejects(
    toriumPublicActions(fakeClient).getToriumNetworkStatus(),
    (error) => {
      assert.equal(error.code, "TORIUM_RPC_REQUEST_FAILED");
      assert.equal(error.message.includes("credential-sentinel"), false);
      return true;
    }
  );
});

test("network status returns a typed cancellation without leaking signal reasons", async () => {
  const controller = new AbortController();
  const fakeClient = {
    chain: toriumLocalnet,
    async request(_parameters, options) {
      controller.abort("credential-sentinel");
      options.signal.throwIfAborted();
    },
  };

  await assert.rejects(
    toriumPublicActions(fakeClient).getToriumNetworkStatus({
      signal: controller.signal,
    }),
    (error) => {
      assert.equal(error.code, "TORIUM_RPC_ABORTED");
      assert.equal(error.message.includes("credential-sentinel"), false);
      return true;
    }
  );
});
