import assert from "node:assert/strict";
import test from "node:test";

import {
  ToriumEndpointValidationError as ChainEndpointError,
  toriumLocalnet,
} from "../dist/esm/chains.js";
import { toriumPublicActions } from "../dist/esm/clients.js";
import {
  isToriumSdkError,
  normalizeToriumError,
  ToriumEndpointValidationError,
  ToriumSdkError,
  toriumErrorCategories,
} from "../dist/esm/errors.js";

const statusResponses = {
  eth_chainId: "0x544f524c",
  net_version: "1414484556",
  eth_syncing: false,
  eth_blockNumber: "0x2a",
  web3_clientVersion: "torium-test/v0",
  net_listening: true,
  net_peerCount: "0x2",
};

test("chains and errors expose one endpoint constructor", () => {
  assert.equal(ChainEndpointError, ToriumEndpointValidationError);
  const error = new ChainEndpointError(
    "TORIUM_CHAIN_ID_MISMATCH",
    "Wrong chain.",
    { expected: 2, actual: 1 }
  );
  assert.equal(error instanceof ToriumEndpointValidationError, true);
  assert.equal(error instanceof ToriumSdkError, true);
  assert.equal(error.category, "wrong-chain");
  assert.equal(error.expected, 2);
  assert.equal(error.actual, 1);
  assert.equal(toriumErrorCategories.length, 16);
});

test("normalizer covers the stable failure categories", () => {
  const cases = [
    [namedError("TypeError"), "configuration", "TORIUM_CONFIG_INVALID"],
    [namedError("ChainMismatchError"), "wrong-chain", "TORIUM_WRONG_CHAIN"],
    [
      namedError("HttpRequestError", { status: 503 }),
      "transport",
      "TORIUM_TRANSPORT_FAILED",
    ],
    [
      namedError("LimitExceededRpcError", { code: -32005 }),
      "rate-limit",
      "TORIUM_RATE_LIMITED",
    ],
    [namedError("TimeoutError"), "timeout", "TORIUM_TIMEOUT"],
    [
      namedError("UserRejectedRequestError", { code: 4001 }),
      "cancellation",
      "TORIUM_CANCELLED",
    ],
    [
      namedError("InvalidParamsRpcError", { code: -32602 }),
      "rpc",
      "TORIUM_RPC_FAILED",
    ],
    [
      namedError("CallExecutionError"),
      "simulation",
      "TORIUM_SIMULATION_FAILED",
    ],
    [namedError("ExecutionRevertedError"), "revert", "TORIUM_REVERTED"],
    [namedError("NonceTooLowError"), "nonce", "TORIUM_NONCE_INVALID"],
    [namedError("FeeCapTooLowError"), "fee", "TORIUM_FEE_INVALID"],
    [
      namedError("InsufficientFundsError"),
      "funds",
      "TORIUM_FUNDS_INSUFFICIENT",
    ],
    [
      new Error("replacement transaction underpriced"),
      "replacement",
      "TORIUM_REPLACEMENT_FAILED",
    ],
    [
      namedError("UnknownDeploymentVersion", {}, "deployment incompatible"),
      "compatibility",
      "TORIUM_COMPATIBILITY_FAILED",
    ],
    [
      namedError("ContractFunctionZeroDataError"),
      "contract",
      "TORIUM_CONTRACT_FAILED",
    ],
  ];

  for (const [input, category, code] of cases) {
    const error = normalizeToriumError(input, {
      operation: "testOperation",
      kind: "read",
      clientKind: "public",
      fallbackCategory:
        category === "compatibility" ? "compatibility" : undefined,
    });
    assert.equal(error.category, category);
    assert.equal(error.code, code);
    assert.equal(isToriumSdkError(error), true);
    assert.equal(
      error.safeToRetry,
      ["transport", "rate-limit", "timeout"].includes(category)
    );
  }
});

test("nested viem execution wrappers preserve transport remediation", () => {
  const error = normalizeToriumError(
    namedError("CallExecutionError", {
      cause: namedError("HttpRequestError", { status: 503 }),
    }),
    {
      operation: "ethCall",
      kind: "read",
      clientKind: "public",
      method: "eth_call",
    }
  );

  assert.equal(error.code, "TORIUM_TRANSPORT_FAILED");
  assert.equal(error.category, "transport");
  assert.equal(error.httpStatus, 503);
  assert.equal(error.safeToRetry, true);
});

test("RPC and revert details remain programmatic while causes stay redacted", () => {
  const sentinel = "credential-sentinel";
  const revertData = "0x08c379a0";
  const cause = namedError(
    "ContractFunctionRevertedError",
    {
      code: 3,
      raw: revertData,
      reason: "NotAllowed",
      url: `https://user:${sentinel}@rpc.example/path?token=${sentinel}`,
      headers: { authorization: `Bearer ${sentinel}` },
      data: { secret: sentinel },
    },
    `execution reverted via https://rpc.example/?key=${sentinel}`
  );
  const error = normalizeToriumError(cause, {
    operation: "readContract",
    kind: "read",
    clientKind: "contract",
    method: "eth_call",
    chainId: toriumLocalnet.id,
    requestId: "request-1",
  });

  assert.equal(error.category, "revert");
  assert.equal(error.rpcCode, 3);
  assert.equal(error.revertData, revertData);
  assert.equal(error.revertReason, "NotAllowed");
  assert.equal(error.cause?.name, "ContractFunctionRevertedError");
  assert.equal(JSON.stringify(error).includes(sentinel), false);
  assert.equal(JSON.stringify(error).includes("authorization"), false);
  assert.equal(JSON.stringify(error).includes("rpc.example"), false);
});

test("untrusted cause names and string codes cannot bypass redaction", () => {
  const sentinel = "AKIAABCDEFGHIJKLMNOP";
  const error = normalizeToriumError(
    namedError(
      sentinel,
      { code: sentinel },
      `https://rpc.example/?token=${sentinel}`
    ),
    { operation: "testOperation", kind: "read" }
  );

  assert.equal(JSON.stringify(error).includes(sentinel), false);
  assert.equal(error.cause?.name.includes("rpc.example"), false);
  assert.equal(error.cause?.name, "Error");
  assert.equal(error.cause?.code, undefined);
});

test("idempotent status reads retry only when explicitly enabled", async () => {
  let chainIdAttempts = 0;
  const events = [];
  const client = {
    chain: toriumLocalnet,
    async request({ method }) {
      if (method === "eth_chainId") {
        chainIdAttempts += 1;
        if (chainIdAttempts < 3) {
          throw namedError("LimitExceededRpcError", {
            code: -32005,
            retryAfterMs: 0,
          });
        }
      }
      return statusResponses[method];
    },
  };

  const status = await toriumPublicActions(client).getToriumNetworkStatus({
    retry: {
      maxAttempts: 3,
      baseDelayMs: 0,
      maximumDelayMs: 0,
      jitterRatio: 0,
    },
    diagnostics(event) {
      events.push(event);
      if (event.phase === "success") throw new Error("observer failure");
    },
    requestId: "retry-test",
  });

  assert.equal(status.blockNumber, 42n);
  assert.equal(chainIdAttempts, 3);
  assert.deepEqual(
    events.map(({ phase, attempt }) => [phase, attempt]),
    [
      ["start", 1],
      ["retry", 2],
      ["retry", 3],
      ["success", 3],
    ]
  );
  assert.equal(JSON.stringify(events).includes("url"), false);
  assert.equal(JSON.stringify(events).includes("cause"), false);
});

test("status timeout and cancellation are distinct and bounded", async () => {
  const pendingClient = {
    chain: toriumLocalnet,
    async request() {
      return new Promise(() => {});
    },
  };
  await assert.rejects(
    toriumPublicActions(pendingClient).getToriumNetworkStatus({ timeoutMs: 5 }),
    { code: "TORIUM_TIMEOUT", category: "timeout", safeToRetry: false }
  );

  const controller = new AbortController();
  controller.abort("must-not-escape");
  let calls = 0;
  await assert.rejects(
    toriumPublicActions({
      chain: toriumLocalnet,
      async request() {
        calls += 1;
      },
    }).getToriumNetworkStatus({ signal: controller.signal }),
    { code: "TORIUM_RPC_ABORTED", category: "cancellation" }
  );
  assert.equal(calls, 0);
});

test("in-flight cancellation settles even when the requester ignores its signal", async () => {
  const controller = new AbortController();
  let markStarted;
  const started = new Promise((resolve) => {
    markStarted = resolve;
  });
  const pending = toriumPublicActions({
    chain: toriumLocalnet,
    async request() {
      markStarted();
      return new Promise(() => {});
    },
  }).getToriumNetworkStatus({ signal: controller.signal });

  await started;
  controller.abort("must-not-escape");
  await assert.rejects(pending, (error) => {
    assert.equal(error.code, "TORIUM_RPC_ABORTED");
    assert.equal(error.category, "cancellation");
    assert.equal(JSON.stringify(error).includes("must-not-escape"), false);
    return true;
  });
});

test("a never-settling diagnostics hook cannot delay an action", async () => {
  const action = toriumPublicActions({
    chain: toriumLocalnet,
    async request({ method }) {
      return statusResponses[method];
    },
  }).getToriumNetworkStatus({ diagnostics: () => new Promise(() => {}) });

  const completed = await Promise.race([
    action.then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), 50)),
  ]);
  assert.equal(completed, true);
});

test("cancellation during read backoff prevents another attempt", async () => {
  const controller = new AbortController();
  let attempts = 0;
  const client = {
    chain: toriumLocalnet,
    async request() {
      attempts += 1;
      throw namedError("LimitExceededRpcError", { code: -32005 });
    },
  };

  await assert.rejects(
    toriumPublicActions(client).getToriumNetworkStatus({
      signal: controller.signal,
      retry: {
        maxAttempts: 3,
        baseDelayMs: 100,
        maximumDelayMs: 100,
        jitterRatio: 0,
      },
      diagnostics(event) {
        if (event.phase === "retry") controller.abort("must-not-escape");
      },
    }),
    (error) => {
      assert.equal(error.code, "TORIUM_RPC_ABORTED");
      assert.equal(error.operation, "getToriumNetworkStatus");
      assert.equal(JSON.stringify(error).includes("must-not-escape"), false);
      return true;
    }
  );
  assert.equal(attempts, 1);
});

test("invalid action controls fail as typed configuration errors", async () => {
  const client = {
    chain: toriumLocalnet,
    async request({ method }) {
      return statusResponses[method];
    },
  };

  for (const options of [
    { timeoutMs: 0 },
    { retry: { maxAttempts: 4 } },
    { requestId: "https://rpc.example/?token=must-not-escape" },
  ]) {
    await assert.rejects(
      toriumPublicActions(client).getToriumNetworkStatus(options),
      (error) => {
        assert.equal(error.code, "TORIUM_CONFIG_INVALID");
        assert.equal(error.category, "configuration");
        assert.equal(error.safeToRetry, false);
        assert.equal(JSON.stringify(error).includes("must-not-escape"), false);
        return true;
      }
    );
  }
});

function namedError(name, properties = {}, message = `${name} test failure`) {
  return Object.assign(new Error(message), { name, ...properties });
}
