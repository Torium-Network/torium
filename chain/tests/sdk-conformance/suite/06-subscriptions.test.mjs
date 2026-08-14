import assert from "node:assert/strict";
import test from "node:test";

import { toriumAttestationRegistryAbi } from "@torium-network/sdk/contracts";

import {
  publicClient,
  recordCapability,
  webSocketClient,
} from "./_setup.mjs";
import { state } from "./_state.mjs";

test("WebSocket newHeads subscriptions deliver consecutive blocks", async () => {
  const client = webSocketClient();
  const blocks = [];
  await new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(
      () => rejectPromise(new Error("no newHeads events within 30s")),
      30_000
    );
    const unwatch = client.watchBlocks({
      onBlock(block) {
        blocks.push(block.number);
        if (blocks.length >= 2) {
          clearTimeout(timer);
          unwatch();
          resolvePromise();
        }
      },
      onError(error) {
        clearTimeout(timer);
        unwatch();
        rejectPromise(error);
      },
    });
  });
  assert.ok(blocks[1] > blocks[0], "block heights must advance");
  await recordCapability(
    "torium.subscriptions.new-heads",
    "eth_subscribe"
  );
});

test("HTTP backfill returns the contract events emitted by this run", async () => {
  const reads = publicClient();
  const logs = await reads.getContractEvents({
    address: state.attestationRegistry,
    abi: toriumAttestationRegistryAbi,
    eventName: "AttestationIssued",
    fromBlock: 1n,
    toBlock: "latest",
  });
  assert.ok(logs.length >= 2, "expected the two issued attestations");
  const revocations = await reads.getContractEvents({
    address: state.attestationRegistry,
    abi: toriumAttestationRegistryAbi,
    eventName: "AttestationRevoked",
    fromBlock: 1n,
    toBlock: "latest",
  });
  assert.equal(revocations.length, 1);
  await recordCapability(
    "torium.subscriptions.http-log-backfill",
    "eth_getLogs"
  );
});
