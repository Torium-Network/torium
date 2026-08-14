import assert from "node:assert/strict";
import test from "node:test";
import { http } from "viem";

import { toriumDevnet, withToriumRpcUrls } from "@torium-network/sdk/chains";
import {
  assertToriumFeeHistoryBlockCount,
  createToriumPublicClient,
  toriumReadCapabilities,
} from "@torium-network/sdk/clients";
import { isToriumSdkError } from "@torium-network/sdk/errors";

import {
  chain,
  deployer,
  evmRpcUrl,
  publicClient,
  recordCapability,
} from "./_setup.mjs";

test("network status reports a ready localnet with CometBFT finality", async () => {
  const client = publicClient();
  const status = await client.getToriumNetworkStatus({ requireReady: true });
  assert.equal(status.status, "ready");
  assert.equal(status.observedChainId, chain.id);
  assert.equal(status.observedChainId, status.expectedChainId);
  assert.equal(status.listening, true);
  assert.equal(status.finality.label, "CometBFT committed");
  assert.ok(status.clientVersion.length > 0);
  await recordCapability("torium.network.status", "torium_networkStatus");
});

test("typed reads agree with raw JSON-RPC results", async () => {
  const client = publicClient();
  const [typedChainId, typedBlock, typedBalance] = await Promise.all([
    client.getChainId(),
    client.getBlock({ blockTag: "latest" }),
    client.getBalance({ address: deployer.address }),
  ]);
  const rawChainId = BigInt(await client.request({ method: "eth_chainId" }));
  const rawBalance = BigInt(
    await client.request({
      method: "eth_getBalance",
      params: [deployer.address, "latest"],
    })
  );
  assert.equal(BigInt(typedChainId), rawChainId);
  assert.equal(typedChainId, chain.id);
  assert.ok(typedBlock.number >= 1n);
  assert.equal(typedBalance, rawBalance);
  assert.ok(typedBalance > 0n, "deployer fixture must be funded");
  await recordCapability("torium.reads.raw-rpc-parity", "eth_call");
});

test("a wrong chain definition fails closed before use", async () => {
  const wrongChain = withToriumRpcUrls(toriumDevnet, { http: [evmRpcUrl] });
  const client = createToriumPublicClient({
    chain: wrongChain,
    transport: http(evmRpcUrl),
  });
  await assert.rejects(
    client.getToriumNetworkStatus(),
    (error) =>
      isToriumSdkError(error) &&
      (error.code === "TORIUM_CHAIN_ID_MISMATCH" ||
        error.category === "wrong-chain")
  );
  await recordCapability("torium.chain.wrong-chain-guard", "eth_chainId");
});

test("documented read limits hold against the live endpoint", async () => {
  const client = publicClient();
  assert.throws(() => assertToriumFeeHistoryBlockCount(101), RangeError);
  const feeHistory = await client.getFeeHistory({
    blockCount: 4,
    rewardPercentiles: [50],
  });
  assert.ok(feeHistory.baseFeePerGas.length > 0);
  assert.equal(toriumReadCapabilities.limits.feeHistoryBlocks, 100);
  await recordCapability("torium.reads.fee-history", "eth_feeHistory");
});
