import assert from "node:assert/strict";
import test from "node:test";

import { preflightToriumTransaction } from "@torium-network/sdk/wallet";
import { parseToriumAmount } from "@torium-network/sdk/utils";

import {
  publicClient,
  recordCapability,
  sdkUser,
  submitAndCommit,
  testUser,
} from "./_setup.mjs";

test("a native transfer passes preflight, submits once, and commits", async () => {
  const reads = publicClient();
  const amount = parseToriumAmount("0.01");
  const before = await reads.getBalance({ address: testUser.address });

  const preflight = await preflightToriumTransaction(reads, {
    account: sdkUser,
    to: testUser.address,
    value: amount,
  });
  assert.equal(preflight.canSubmit, true);
  assert.equal(preflight.type, "eip1559");
  assert.ok(preflight.gasEstimate >= 21_000n);
  assert.ok(preflight.maximumCost > amount);

  const lifecycle = await submitAndCommit(sdkUser, {
    to: testUser.address,
    value: amount,
  });
  assert.equal(lifecycle.finality, "CometBFT committed");
  assert.equal(lifecycle.receipt.status, "success");

  const rawReceipt = await reads.request({
    method: "eth_getTransactionReceipt",
    params: [lifecycle.hash],
  });
  assert.equal(BigInt(rawReceipt.blockNumber), lifecycle.receipt.blockNumber);
  assert.equal(rawReceipt.status, "0x1");

  const after = await reads.getBalance({ address: testUser.address });
  assert.equal(after - before, amount);
  await recordCapability(
    "torium.transactions.transfer-lifecycle",
    "eth_sendRawTransaction"
  );
});

test("preflight surfaces impossible transfers as structured blockers", async () => {
  const reads = publicClient();
  const balance = await reads.getBalance({ address: testUser.address });
  const preflight = await preflightToriumTransaction(reads, {
    account: testUser,
    to: sdkUser.address,
    value: balance,
  });
  assert.equal(preflight.canSubmit, false);
  assert.ok(preflight.blockers.includes("insufficient-funds"));
  await recordCapability(
    "torium.transactions.preflight-blockers",
    "eth_call"
  );
});
