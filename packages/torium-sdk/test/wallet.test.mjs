import assert from "node:assert/strict";
import test from "node:test";
import { WaitForTransactionReceiptTimeoutError } from "viem";

import {
  toriumDevnet,
  toriumLocalnet,
  toriumMainnet,
  toriumTestnet,
} from "../dist/esm/chains.js";
import { ToriumSdkError } from "../dist/esm/errors.js";
import {
  createToriumWalletClient,
  normalizeToriumTransactionRequest,
  preflightToriumTransaction,
  sendToriumTransactionOnce,
  toriumMaxEncodedTransactionBytes,
  toriumMaxTransactionGas,
  toriumTransactionCapabilities,
  waitForToriumTransaction,
} from "../dist/esm/wallet.js";

const account = "0x0000000000000000000000000000000000000001";
const recipient = "0x0000000000000000000000000000000000000002";
const hash = `0x${"12".repeat(32)}`;

test("transaction capabilities are frozen and disable replacement detection", () => {
  assert.equal(Object.isFrozen(toriumTransactionCapabilities), true);
  assert.equal(
    Object.isFrozen(
      toriumTransactionCapabilities.replacement.activeLocalProfile
    ),
    true
  );
  assert.equal(
    toriumTransactionCapabilities.replacement.activeLocalProfile
      .minimumFeeCapBumpPercent,
    10
  );
  assert.equal(
    toriumTransactionCapabilities.submission.automaticWriteRetry,
    false
  );
  for (const chain of [
    toriumLocalnet,
    toriumDevnet,
    toriumTestnet,
    toriumMainnet,
  ]) {
    assert.equal(chain.supportsTransactionReplacementDetection, false);
  }
});

test("stable transaction normalization preserves standard EIP-1559 fields", () => {
  const normalized = normalizeToriumTransactionRequest({
    account,
    to: recipient,
    data: "0xAABB",
    value: 1n,
    gas: 21_000n,
    nonce: 0,
    maxFeePerGas: 2_000_000_000n,
    maxPriorityFeePerGas: 1n,
    type: "eip1559",
  });
  assert.equal(normalized.account, account);
  assert.equal(normalized.to, recipient);
  assert.equal(normalized.data, "0xaabb");

  const localAccount = { address: account, type: "local" };
  assert.equal(
    normalizeToriumTransactionRequest({ account: localAccount, to: recipient })
      .account,
    localAccount
  );

  const storageKey = `0x${"AB".repeat(32)}`;
  const accessList = normalizeToriumTransactionRequest({
    account,
    to: recipient,
    accessList: [{ address: recipient, storageKeys: [storageKey] }],
  }).accessList;
  assert.equal(accessList[0].storageKeys[0], storageKey.toLowerCase());
});

test("stable transaction normalization rejects unsupported and invalid fields", () => {
  for (const request of [
    { account, to: "0x1234" },
    { account, to: recipient, value: -1n },
    { account, to: recipient, gas: toriumMaxTransactionGas + 1n },
    { account, to: recipient, nonce: -1 },
    { account, to: recipient, nonce: Number.MAX_SAFE_INTEGER + 1 },
    { account, to: recipient, maxFeePerGas: 1n, maxPriorityFeePerGas: 2n },
    { account, to: recipient, maxFeePerGas: 1_000_000_000n },
    {
      account,
      to: recipient,
      maxFeePerGas: 2_000_000_000n,
      maxPriorityFeePerGas: 0n,
    },
    { account, to: recipient, type: "legacy" },
    { account, data: "0x" },
    { account, to: recipient, gasPrice: 1n },
    { account, to: recipient, blobs: ["0x00"] },
    { account, to: recipient, authorizationList: [] },
    { account, to: recipient, assertChainId: false },
    { account, to: recipient, chain: toriumLocalnet },
    {
      account,
      to: recipient,
      accessList: [{ address: recipient, storageKeys: ["0x12"] }],
    },
  ]) {
    assert.throws(() => normalizeToriumTransactionRequest(request));
  }
  assert.throws(
    () =>
      normalizeToriumTransactionRequest({
        account,
        data: `0x${"00".repeat(toriumMaxEncodedTransactionBytes)}`,
      }),
    { name: "RangeError" }
  );
});

test("wallet factory and preflight reject non-Torium chain identity", async () => {
  assert.throws(
    () =>
      createToriumWalletClient({
        chain: { id: 1 },
        transport: () => ({ config: {}, request: async () => undefined }),
      }),
    { name: "RangeError" }
  );
  assert.throws(
    () =>
      createToriumWalletClient({
        chain: {
          ...toriumLocalnet,
          torium: { ...toriumLocalnet.torium, environment: "testnet" },
        },
        transport: () => ({ config: {}, request: async () => undefined }),
      }),
    { name: "TypeError" }
  );
  await assert.rejects(
    preflightToriumTransaction(createPreflightClient([], { chainId: 1 }), {
      account,
      to: recipient,
    }),
    { code: "TORIUM_WRONG_CHAIN", category: "wrong-chain" }
  );
});

test("preflight simulates and calculates exact maximum EIP-1559 cost", async () => {
  const calls = [];
  const client = createPreflightClient(calls);
  const result = await preflightToriumTransaction(client, {
    account,
    to: recipient,
    value: 1_000n,
  });
  assert.deepEqual(calls, [
    "getChainId",
    "call",
    "estimateGas",
    "estimateFeesPerGas",
    "getBalance",
    "getTransactionCount",
  ]);
  assert.equal(result.gasEstimate, 21_000n);
  assert.equal(result.maxFeePerGas, 2_000_000_000n);
  assert.equal(result.maximumCost, 42_000_000_001_000n);
  assert.equal(result.type, "eip1559");
  assert.ok(result.encodedTransactionBytes < toriumMaxEncodedTransactionBytes);
  assert.equal(result.canSubmit, true);
  assert.deepEqual(result.blockers, []);
});

test("preflight reports gas, balance and nonce blockers without signing", async () => {
  const observedRequests = [];
  const localAccount = {
    address: account,
    type: "local",
    secretSentinel: "must-not-cross-preflight-boundary",
  };
  const result = await preflightToriumTransaction(
    createPreflightClient([], {
      balance: 1n,
      pendingNonce: 4,
      gasEstimate: 21_000n,
      observedRequests,
    }),
    {
      account: localAccount,
      to: recipient,
      gas: 20_000n,
      nonce: 3,
    }
  );
  assert.equal(result.canSubmit, false);
  assert.deepEqual(result.blockers, [
    "gas-below-estimate",
    "insufficient-funds",
    "nonce-mismatch",
  ]);
  assert.equal(observedRequests.length, 2);
  for (const request of observedRequests) {
    assert.equal(request.account, account);
    assert.equal("gas" in request, false);
    assert.equal(
      JSON.stringify(request).includes(localAccount.secretSentinel),
      false
    );
  }
});

test("preflight rejects a fully serialized transaction above the protocol limit", async () => {
  const storageKey = `0x${"ab".repeat(32)}`;
  await assert.rejects(
    preflightToriumTransaction(createPreflightClient([]), {
      account,
      to: recipient,
      accessList: [
        {
          address: recipient,
          storageKeys: Array.from({ length: 5_000 }, () => storageKey),
        },
      ],
    }),
    { code: "TORIUM_CONFIG_INVALID", category: "configuration" }
  );
});

test("submission runs fresh preflight then sends exactly once", async () => {
  let submissions = 0;
  let authorizedPreflight;
  const sender = {
    chain: toriumLocalnet,
    async sendTransaction(request) {
      submissions += 1;
      assert.equal(request.chain, toriumLocalnet);
      assert.equal(request.to, recipient);
      assert.equal(request.type, "eip1559");
      assert.equal(request.gas, 21_000n);
      assert.equal(request.nonce, 0);
      assert.equal(request.maxFeePerGas, 2_000_000_000n);
      return hash;
    },
  };
  const acknowledgement = await sendToriumTransactionOnce(
    sender,
    createPreflightClient([]),
    { account, to: recipient },
    {
      authorize(preflight) {
        authorizedPreflight = preflight;
        return true;
      },
    }
  );
  assert.equal(submissions, 1);
  assert.equal(authorizedPreflight.maximumCost, 42_000_000_000_000n);
  assert.deepEqual(acknowledgement, {
    hash,
    status: "acknowledged",
    retentionGuaranteed: false,
    inclusionGuaranteed: false,
  });

  await assert.rejects(
    sendToriumTransactionOnce(
      sender,
      createPreflightClient([], { balance: 0n }),
      { account, to: recipient },
      { authorize: async () => true }
    ),
    (error) => {
      assert.equal(error.code, "TORIUM_FUNDS_INSUFFICIENT");
      assert.equal(error.category, "funds");
      assert.deepEqual(error.issues, ["insufficient-funds"]);
      return true;
    }
  );
  assert.equal(submissions, 1);

  await assert.rejects(
    sendToriumTransactionOnce(
      sender,
      createPreflightClient([]),
      { account, to: recipient },
      { authorize: async () => false }
    )
  );
  assert.equal(submissions, 1);

  await assert.rejects(
    sendToriumTransactionOnce(
      sender,
      createPreflightClient([]),
      { account, to: recipient },
      { authorize: async () => 1 }
    )
  );
  assert.equal(submissions, 1);
});

test("submission signs the immutable snapshot reviewed by authorization", async () => {
  const originalStorageKey = `0x${"ab".repeat(32)}`;
  const mutatedStorageKey = `0x${"cd".repeat(32)}`;
  const mutableRequest = {
    account,
    to: recipient,
    value: 1n,
    accessList: [{ address: recipient, storageKeys: [originalStorageKey] }],
  };
  let submissions = 0;
  await sendToriumTransactionOnce(
    {
      chain: toriumLocalnet,
      async sendTransaction(request) {
        submissions += 1;
        assert.equal(request.to, recipient);
        assert.equal(request.value, 1n);
        assert.equal(request.accessList[0].storageKeys[0], originalStorageKey);
        return hash;
      },
    },
    createPreflightClient([]),
    mutableRequest,
    {
      authorize(preflight) {
        assert.equal(Object.isFrozen(preflight), true);
        assert.equal(Object.isFrozen(preflight.accessList), true);
        mutableRequest.to = account;
        mutableRequest.value = 999n;
        mutableRequest.accessList[0].storageKeys[0] = mutatedStorageKey;
        return true;
      },
    }
  );
  assert.equal(submissions, 1);
});

test("submission rejects a local signer address changed after authorization", async () => {
  const localAccount = { address: account, type: "local" };
  let submissions = 0;
  await assert.rejects(
    sendToriumTransactionOnce(
      {
        chain: toriumLocalnet,
        async sendTransaction() {
          submissions += 1;
          return hash;
        },
      },
      createPreflightClient([]),
      { account: localAccount, to: recipient },
      {
        authorize() {
          localAccount.address = recipient;
          return true;
        },
      }
    )
  );
  assert.equal(submissions, 0);
});

test("a submission transport failure is never retried", async () => {
  let submissions = 0;
  const failure = new Error("transport unavailable");
  await assert.rejects(
    sendToriumTransactionOnce(
      {
        chain: toriumLocalnet,
        async sendTransaction() {
          submissions += 1;
          throw failure;
        },
      },
      createPreflightClient([]),
      { account, to: recipient },
      { authorize: async () => true }
    ),
    (error) => {
      assert.equal(error.code, "TORIUM_TRANSPORT_FAILED");
      assert.equal(error.category, "transport");
      assert.equal(error.retryable, true);
      assert.equal(error.safeToRetry, false);
      assert.equal(error.cause?.name, "Error");
      return true;
    }
  );
  assert.equal(submissions, 1);
});

test("a broadcast timeout remains non-retryable and invokes the sender once", async () => {
  let submissions = 0;
  await assert.rejects(
    sendToriumTransactionOnce(
      {
        chain: toriumLocalnet,
        async sendTransaction() {
          submissions += 1;
          return new Promise(() => {});
        },
      },
      createPreflightClient([]),
      { account, to: recipient },
      { authorize: async () => true, timeoutMs: 5 }
    ),
    {
      code: "TORIUM_TIMEOUT",
      category: "timeout",
      safeToRetry: false,
    }
  );
  assert.equal(submissions, 1);
});

test("a pre-normalized transient broadcast failure is still unsafe to retry", async () => {
  let submissions = 0;
  await assert.rejects(
    sendToriumTransactionOnce(
      {
        chain: toriumLocalnet,
        async sendTransaction() {
          submissions += 1;
          throw new ToriumSdkError({
            code: "TORIUM_TRANSPORT_FAILED",
            category: "transport",
            operation: "callerTransport",
            kind: "read",
            retryable: true,
            safeToRetry: true,
          });
        },
      },
      createPreflightClient([]),
      { account, to: recipient },
      { authorize: async () => true }
    ),
    {
      code: "TORIUM_TRANSPORT_FAILED",
      category: "transport",
      retryable: true,
      safeToRetry: false,
      kind: "broadcast",
    }
  );
  assert.equal(submissions, 1);
});

test("submission rejects wallet and preflight chain mismatch before RPC", async () => {
  let submissions = 0;
  await assert.rejects(
    sendToriumTransactionOnce(
      {
        chain: toriumLocalnet,
        async sendTransaction() {
          submissions += 1;
          return hash;
        },
      },
      createPreflightClient([], { chain: toriumTestnet }),
      { account, to: recipient },
      { authorize: async () => true }
    ),
    { code: "TORIUM_WRONG_CHAIN", category: "wrong-chain" }
  );
  assert.equal(submissions, 0);
});

test("simulation failure prevents signing and submission", async () => {
  let submissions = 0;
  const revert = new Error("execution reverted");
  await assert.rejects(
    sendToriumTransactionOnce(
      {
        chain: toriumLocalnet,
        async sendTransaction() {
          submissions += 1;
          return hash;
        },
      },
      createPreflightClient([], { callError: revert }),
      { account, to: recipient },
      { authorize: async () => true }
    ),
    (error) => {
      assert.equal(error.code, "TORIUM_REVERTED");
      assert.equal(error.category, "revert");
      assert.equal(error.safeToRetry, false);
      return true;
    }
  );
  assert.equal(submissions, 0);
});

test("receipt lifecycle distinguishes committed, reverted, timeout and RPC failure", async () => {
  const parameters = [];
  const committed = await waitForToriumTransaction(
    {
      async waitForTransactionReceipt(input) {
        parameters.push(input);
        return { status: "success", transactionHash: hash };
      },
    },
    { hash }
  );
  assert.equal(committed.status, "committed");
  assert.deepEqual(parameters, [
    {
      hash,
      confirmations: 1,
      timeout: 180_000,
      checkReplacement: false,
    },
  ]);

  const reverted = await waitForToriumTransaction(
    {
      async waitForTransactionReceipt() {
        return { status: "reverted", transactionHash: hash };
      },
    },
    { hash, timeout: 1 }
  );
  assert.equal(reverted.status, "reverted");

  const unknown = await waitForToriumTransaction(
    {
      async waitForTransactionReceipt() {
        throw new WaitForTransactionReceiptTimeoutError({ hash });
      },
    },
    { hash }
  );
  assert.deepEqual(unknown, {
    status: "unknown",
    hash,
    reason: "timeout",
    safeToAutomaticallyResubmit: false,
  });

  const rpcFailure = new Error("rpc unavailable");
  await assert.rejects(
    waitForToriumTransaction(
      {
        async waitForTransactionReceipt() {
          throw rpcFailure;
        },
      },
      { hash }
    ),
    (error) => {
      assert.equal(error.code, "TORIUM_RPC_FAILED");
      assert.equal(error.category, "rpc");
      return true;
    }
  );

  await assert.rejects(
    waitForToriumTransaction(
      {
        async waitForTransactionReceipt() {
          return { status: "success", transactionHash: `0x${"34".repeat(32)}` };
        },
      },
      { hash }
    ),
    { code: "TORIUM_CONFIG_INVALID", category: "configuration" }
  );
});

function createPreflightClient(calls, overrides = {}) {
  return {
    chain: overrides.chain ?? toriumLocalnet,
    async getChainId() {
      calls.push("getChainId");
      return overrides.chainId ?? toriumLocalnet.id;
    },
    async call(request) {
      calls.push("call");
      overrides.observedRequests?.push(request);
      if (overrides.callError) throw overrides.callError;
      return { data: "0x" };
    },
    async estimateGas(request) {
      calls.push("estimateGas");
      overrides.observedRequests?.push(request);
      return overrides.gasEstimate ?? 21_000n;
    },
    async estimateFeesPerGas() {
      calls.push("estimateFeesPerGas");
      return {
        maxFeePerGas: overrides.maxFeePerGas ?? 2_000_000_000n,
        maxPriorityFeePerGas: overrides.maxPriorityFeePerGas ?? 1n,
      };
    },
    async getBalance() {
      calls.push("getBalance");
      return overrides.balance ?? 10n ** 18n;
    },
    async getTransactionCount() {
      calls.push("getTransactionCount");
      return overrides.pendingNonce ?? 0;
    },
  };
}
