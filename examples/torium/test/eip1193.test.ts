import assert from "node:assert/strict";
import test from "node:test";

import { toriumLocalnet } from "@torium-network/sdk/chains";
import { createToriumWalletClient } from "@torium-network/sdk/wallet";
import { custom, type EIP1193Provider, type Hash } from "viem";

const account = "0x1111111111111111111111111111111111111111" as const;
const recipient = "0x2222222222222222222222222222222222222222" as const;
const transactionHash = `0x${"ab".repeat(32)}` as Hash;

test("caller-owned EIP-1193 provider receives one standard transaction request", async () => {
  const calls: Array<{ method: string; params?: unknown }> = [];
  const provider = {
    async request(request: { method: string; params?: unknown }) {
      calls.push(request);
      if (request.method === "eth_chainId") return "0x544f524c";
      if (request.method === "eth_sendTransaction") return transactionHash;
      throw new Error(`Unexpected provider method: ${request.method}`);
    },
  } as unknown as EIP1193Provider;
  const wallet = createToriumWalletClient({
    account,
    chain: toriumLocalnet,
    transport: custom(provider),
  });

  const hash = await wallet.sendTransaction({
    account,
    chain: toriumLocalnet,
    gas: 21_000n,
    maxFeePerGas: 2_000_000_000n,
    maxPriorityFeePerGas: 1n,
    nonce: 0,
    to: recipient,
    type: "eip1559",
    value: 1n,
  });

  assert.equal(hash, transactionHash);
  assert.deepEqual(
    calls.map(({ method }) => method),
    ["eth_chainId", "eth_sendTransaction"]
  );
  assert.equal(
    calls.some(({ method }) =>
      ["wallet_addEthereumChain", "wallet_switchEthereumChain"].includes(method)
    ),
    false
  );
  assert.deepEqual(calls[1]?.params, [
    {
      from: account,
      gas: "0x5208",
      maxFeePerGas: "0x77359400",
      maxPriorityFeePerGas: "0x1",
      nonce: "0x0",
      to: recipient,
      type: "0x2",
      value: "0x1",
    },
  ]);
});

test("injected provider chain mismatch fails before transaction submission", async () => {
  const methods: string[] = [];
  const provider = {
    async request(request: { method: string }) {
      methods.push(request.method);
      if (request.method === "eth_chainId") return "0x1";
      throw new Error(`Unexpected provider method: ${request.method}`);
    },
  } as unknown as EIP1193Provider;
  const wallet = createToriumWalletClient({
    account,
    chain: toriumLocalnet,
    transport: custom(provider),
  });

  await assert.rejects(
    wallet.sendTransaction({
      account,
      chain: toriumLocalnet,
      gas: 21_000n,
      maxFeePerGas: 2_000_000_000n,
      maxPriorityFeePerGas: 1n,
      nonce: 0,
      to: recipient,
      type: "eip1559",
      value: 1n,
    }),
    /does not match the target chain/u
  );
  assert.deepEqual(methods, ["eth_chainId"]);
});
