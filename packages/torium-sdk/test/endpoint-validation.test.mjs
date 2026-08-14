import assert from "node:assert/strict";
import test from "node:test";

import {
  ToriumEndpointValidationError,
  toriumLocalnet,
  toriumTestnet,
  validateToriumEndpoint,
} from "../dist/esm/chains.js";

const fingerprint = `0x${"ab".repeat(32)}`;

test("validates a ready local EIP-1193 endpoint without wallet mutations", async () => {
  const methods = [];
  const result = await validateToriumEndpoint(mockRequester({}, methods), {
    chain: toriumLocalnet,
  });
  assert.deepEqual(result, {
    status: "ready",
    environment: "localnet",
    manifestVersion: "0.2.0",
    expectedChainId: 1414484556,
    observedChainId: 1414484556,
    expectedNetworkId: 1414484556,
    observedNetworkId: 1414484556,
    blockNumber: 42n,
    syncing: false,
    fingerprintStatus: "unavailable-local",
    compatibilityStatus: "not-requested",
    compatibilityChecks: 0,
  });
  assert.deepEqual(methods, [
    "eth_chainId",
    "net_version",
    "eth_syncing",
    "eth_blockNumber",
  ]);
  assert.equal(methods.includes("wallet_switchEthereumChain"), false);
  assert.equal(methods.includes("wallet_addEthereumChain"), false);
});

test("fails before RPC when a configured viem client selects another chain", async () => {
  let requested = false;
  const requester = {
    chain: toriumTestnet,
    async request() {
      requested = true;
    },
  };
  await assert.rejects(
    validateToriumEndpoint(requester, { chain: toriumLocalnet }),
    hasCode("TORIUM_CHAIN_ID_MISMATCH")
  );
  assert.equal(requested, false);
});

test("reports chain and network mismatches explicitly", async () => {
  await assert.rejects(
    validateToriumEndpoint(mockRequester({ eth_chainId: "0x544f5254" }), {
      chain: toriumLocalnet,
    }),
    hasCode("TORIUM_CHAIN_ID_MISMATCH")
  );
  await assert.rejects(
    validateToriumEndpoint(mockRequester({ net_version: "1" }), {
      chain: toriumLocalnet,
    }),
    hasCode("TORIUM_NETWORK_ID_MISMATCH")
  );
});

test("rejects malformed RPC identity and height responses", async () => {
  for (const [method, value] of [
    ["eth_chainId", "1414484556"],
    ["net_version", "0x544f524c"],
    ["eth_syncing", "false"],
    ["eth_blockNumber", "42"],
  ]) {
    await assert.rejects(
      validateToriumEndpoint(mockRequester({ [method]: value }), {
        chain: toriumLocalnet,
      }),
      hasCode("TORIUM_RPC_RESPONSE_INVALID")
    );
  }
});

test("distinguishes syncing and booting from a ready endpoint", async () => {
  await assert.rejects(
    validateToriumEndpoint(
      mockRequester({ eth_syncing: { currentBlock: "0x1" } }),
      {
        chain: toriumLocalnet,
      }
    ),
    hasCode("TORIUM_RPC_SYNCING")
  );
  assert.equal(
    (
      await validateToriumEndpoint(
        mockRequester({ eth_syncing: { currentBlock: "0x1" } }),
        { chain: toriumLocalnet, requireReady: false }
      )
    ).status,
    "syncing"
  );

  await assert.rejects(
    validateToriumEndpoint(mockRequester({ eth_blockNumber: "0x0" }), {
      chain: toriumLocalnet,
    }),
    hasCode("TORIUM_RPC_NOT_READY")
  );
  assert.equal(
    (
      await validateToriumEndpoint(mockRequester({ eth_blockNumber: "0x0" }), {
        chain: toriumLocalnet,
        requireReady: false,
      })
    ).status,
    "booting"
  );
});

test("requires and verifies a non-local network fingerprint", async () => {
  await assert.rejects(
    validateToriumEndpoint(
      mockRequester({
        eth_chainId: "0x544f5254",
        net_version: "1414484564",
      }),
      { chain: toriumTestnet }
    ),
    hasCode("TORIUM_NETWORK_FINGERPRINT_REQUIRED")
  );

  const matching = await validateToriumEndpoint(
    mockRequester({
      eth_chainId: "0x544f5254",
      net_version: "1414484564",
      eth_getBlockByNumber: { hash: fingerprint },
    }),
    { chain: toriumTestnet, expectedNetworkFingerprint: fingerprint }
  );
  assert.equal(matching.fingerprintStatus, "verified");

  await assert.rejects(
    validateToriumEndpoint(
      mockRequester({
        eth_chainId: "0x544f5254",
        net_version: "1414484564",
        eth_getBlockByNumber: { hash: `0x${"cd".repeat(32)}` },
      }),
      { chain: toriumTestnet, expectedNetworkFingerprint: fingerprint }
    ),
    hasCode("TORIUM_NETWORK_FINGERPRINT_MISMATCH")
  );
});

test("rejects an invalid expected fingerprint without reflecting its value", async () => {
  const sentinel = "secret-fingerprint-value";
  await assert.rejects(
    validateToriumEndpoint(mockRequester(), {
      chain: toriumLocalnet,
      expectedNetworkFingerprint: sentinel,
    }),
    (error) =>
      error instanceof ToriumEndpointValidationError &&
      error.code === "TORIUM_ENDPOINT_CONFIG_INVALID" &&
      error.expected === undefined &&
      !error.message.includes(sentinel)
  );
});

test("enforces caller minimum height and typed compatibility checks", async () => {
  await assert.rejects(
    validateToriumEndpoint(mockRequester(), {
      chain: toriumLocalnet,
      minimumBlockNumber: 43n,
    }),
    hasCode("TORIUM_RPC_STALE")
  );
  await assert.rejects(
    validateToriumEndpoint(mockRequester(), {
      chain: toriumLocalnet,
      requireCompatibility: true,
    }),
    hasCode("TORIUM_ENDPOINT_CONFIG_INVALID")
  );
  await assert.rejects(
    validateToriumEndpoint(mockRequester(), {
      chain: toriumLocalnet,
      requireCompatibility: true,
      compatibilityChecks: [
        {
          kind: "protocol",
          async check() {
            return false;
          },
        },
      ],
    }),
    hasCode("TORIUM_ENDPOINT_INCOMPATIBLE")
  );

  const result = await validateToriumEndpoint(mockRequester(), {
    chain: toriumLocalnet,
    requireCompatibility: true,
    compatibilityChecks: [
      {
        kind: "protocol",
        async check() {
          return true;
        },
      },
      {
        kind: "contract",
        async check() {
          return true;
        },
      },
    ],
  });
  assert.equal(result.compatibilityStatus, "verified");
  assert.equal(result.compatibilityChecks, 2);
});

test("does not retain secret-bearing provider failures", async () => {
  const sentinel = "secret-header-value";
  const providerError = new Error(sentinel);
  await assert.rejects(
    validateToriumEndpoint(
      {
        async request() {
          throw providerError;
        },
      },
      { chain: toriumLocalnet }
    ),
    (error) =>
      error instanceof ToriumEndpointValidationError &&
      error.code === "TORIUM_RPC_REQUEST_FAILED" &&
      error.cause?.name === "Error" &&
      !JSON.stringify(error).includes(sentinel) &&
      !error.message.includes(sentinel)
  );
});

function mockRequester(overrides = {}, methods = []) {
  const responses = {
    eth_chainId: "0x544f524c",
    net_version: "1414484556",
    eth_syncing: false,
    eth_blockNumber: "0x2a",
    eth_getBlockByNumber: { hash: fingerprint },
    ...overrides,
  };
  return {
    async request({ method }) {
      methods.push(method);
      if (!(method in responses))
        throw new Error(`Unexpected method: ${method}`);
      return responses[method];
    },
  };
}

function hasCode(code) {
  return (error) =>
    error instanceof ToriumEndpointValidationError && error.code === code;
}
