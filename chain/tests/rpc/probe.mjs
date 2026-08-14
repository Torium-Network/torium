#!/usr/bin/env node

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { connect } from "node:net";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const args = parseArgs(process.argv.slice(2));
const profile = JSON.parse(
  await readFile(join(args.root, "chain/config/rpc-profile-v1.json"), "utf8")
);
const manifest = JSON.parse(await readFile(args.manifest, "utf8"));
const rpcUrl = profile.ethereum.httpUrl;
const wsUrl = profile.ethereum.webSocketUrl;
const restUrl = profile.cosmos.rest.url;
const cometUrl = profile.comet.clientNodeUrl;
const controller = join(args.root, "chain/localnet/torium-localnet");
const reportPath = join(
  args.root,
  "chain/tests/rpc/.artifacts/latest-report.json"
);
const deployer = manifest.development_accounts.find(
  ({ name }) => name === "deployer"
);
assert.ok(deployer, "deployer fixture is missing");

const observedMethods = {};
for (const [method, params] of Object.entries({
  web3_clientVersion: [],
  net_version: [],
  net_listening: [],
  net_peerCount: [],
  eth_chainId: [],
  eth_blockNumber: [],
  eth_syncing: [],
  eth_gasPrice: [],
  eth_getBalance: [deployer.evm_address, "latest"],
  eth_getBlockByNumber: ["latest", false],
  eth_getLogs: [{ fromBlock: "latest", toBlock: "latest" }],
  eth_feeHistory: ["0x1", "latest", [50]],
})) {
  const result = await rpc(method, params);
  assert.notEqual(result, undefined, `${method} returned no result`);
  observedMethods[method] = summarizeResult(method, result);
}
assert.equal(
  Number(BigInt(observedMethods.eth_chainId)),
  profile.ethereum.chainId
);
assert.equal(Number(observedMethods.net_version), profile.ethereum.networkId);
assert.equal(observedMethods.net_listening, true);
assert.equal(observedMethods.eth_syncing, false);
assert.ok(Number(BigInt(observedMethods.eth_blockNumber)) > 0);

const blockTagEvidence = await exerciseBlockTags({
  contract: args.contract,
  deployer: deployer.evm_address,
});

const forbidden = {
  debug_traceTransaction: [`0x${"0".repeat(64)}`, {}],
  debug_traceBlockByNumber: ["latest", {}],
  debug_traceCall: [{ to: args.contract, data: "0x3fa4f245" }, "latest", {}],
  txpool_status: [],
  personal_listAccounts: [],
  miner_start: [],
};
const forbiddenEvidence = {};
for (const [method, params] of Object.entries(forbidden)) {
  const response = await rpcEnvelope(method, params);
  assert.equal(
    response.error?.code,
    -32601,
    `${method} was unexpectedly exposed`
  );
  forbiddenEvidence[method] = summarizeError(response);
}

const exactBatch = await rpcBatch(profile.ethereum.limits.batchRequests);
assert.equal(exactBatch.length, profile.ethereum.limits.batchRequests);
const exactBatchById = new Map(exactBatch.map((entry) => [entry.id, entry]));
for (let id = 1; id <= exactBatch.length; id += 1) {
  const entry = exactBatchById.get(id);
  assert.equal(entry?.jsonrpc, "2.0");
  assert.equal(entry?.result, profile.ethereum.chainIdHex);
}
const oversizedBatch = await rpcBatch(
  profile.ethereum.limits.batchRequests + 1
);
assert.ok(
  !Array.isArray(oversizedBatch) ||
    oversizedBatch.length !== profile.ethereum.limits.batchRequests + 1,
  "oversized JSON-RPC batch was accepted"
);
assert.ok(
  !Array.isArray(oversizedBatch)
    ? oversizedBatch.error
    : oversizedBatch.some(({ error }) => error),
  "oversized JSON-RPC batch produced no rejection error"
);
const batchBoundaryEvidence = {
  exact: {
    requests: profile.ethereum.limits.batchRequests,
    responses: exactBatch.length,
    everyIdAndResultMatched: true,
  },
  oversized: summarizeBatchRejection(
    oversizedBatch,
    profile.ethereum.limits.batchRequests + 1
  ),
};

const errorEnvelopeEvidence = await exerciseErrorEnvelopes();

const oversizedBody = JSON.stringify({
  jsonrpc: "2.0",
  id: "oversized-body",
  method: "web3_sha3",
  params: [`0x${"0".repeat(profile.ethereum.limits.httpBodyBytes + 1)}`],
});
const bodyResponse = await fetch(rpcUrl, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: oversizedBody,
});
const bodyText = await bodyResponse.text();
assert.ok(
  bodyResponse.status === 413 || /too large|limit|size/iu.test(bodyText),
  `oversized body was not rejected: HTTP ${bodyResponse.status} ${bodyText.slice(0, 200)}`
);

const corsResponse = await fetch(rpcUrl, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    origin: "https://untrusted.invalid",
  },
  body: JSON.stringify(rpcRequest("cors", "eth_chainId")),
});
assert.equal(
  corsResponse.headers.get("access-control-allow-origin"),
  "*",
  "upstream HTTP CORS behavior changed; reassess the loopback-only boundary"
);
assert.equal(profile.exposure.httpCors.publicUseAllowed, false);
assert.equal(profile.exposure.hostPublishing, "loopback-only");

const webSocketOriginEvidence = {
  scope: "loopback-local-development-profile",
  publicBrowserWebSocketClaimed: false,
  browserOriginSupportedByLocalProfile:
    profile.ethereum.webSocket.browserOriginSupportedByLocalProfile,
  serverClientWithoutOriginAccepted: true,
  localhost: await webSocketHandshake(wsUrl, "http://localhost:3000"),
  loopback: await webSocketHandshake(wsUrl, "http://127.0.0.1:3000"),
  untrusted: await webSocketHandshake(wsUrl, "https://untrusted.invalid"),
};
const expectedLocalBrowserOriginStatus = profile.ethereum.webSocket
  .browserOriginSupportedByLocalProfile
  ? 101
  : 403;
assert.equal(
  webSocketOriginEvidence.localhost.status,
  expectedLocalBrowserOriginStatus
);
assert.equal(
  webSocketOriginEvidence.loopback.status,
  expectedLocalBrowserOriginStatus
);
assert.equal(webSocketOriginEvidence.untrusted.status, 403);

const restResponse = await fetch(
  `${restUrl}/cosmos/base/tendermint/v1beta1/node_info`,
  { signal: AbortSignal.timeout(5_000) }
);
assert.equal(restResponse.status, 200);
assert.equal(restResponse.headers.get("access-control-allow-origin"), null);
const nodeInfo = await restResponse.json();
assert.equal(nodeInfo.default_node_info.network, "torium-localnet-1");
assert.equal(nodeInfo.application_version.name, "Torium");
assert.ok(nodeInfo.application_version.version.length > 0);
await assertTCP("127.0.0.1", 9090);

const cometStatus = await fetchJSON(`${cometUrl}/status`);
const cometPeers = await fetchJSON(`${cometUrl}/net_info`);
assert.equal(cometStatus.result.node_info.network, "torium-localnet-1");
assert.equal(Number(cometPeers.result.n_peers), 3);
const unsafeHTTPResponse = await fetch(`${cometUrl}/unsafe_flush_mempool`, {
  signal: AbortSignal.timeout(5_000),
});
const unsafeBody = await unsafeHTTPResponse.text();
let unsafeEnvelope = null;
try {
  unsafeEnvelope = JSON.parse(unsafeBody);
} catch {
  // Disabled CometBFT routes normally return a plain HTTP 404.
}
assert.ok(
  unsafeHTTPResponse.status === 404 || unsafeEnvelope?.error,
  "unsafe CometBFT method was exposed"
);

async function exerciseBlockTags({ contract, deployer }) {
  const tags = ["latest", "pending", "safe", "finalized"];
  const evidence = {
    semantics: {
      pending: "accepted but not a distinct geth-equivalent pending-state view",
      safe: "method-specific: block lookup accepts it while state queries reject it",
      finalized:
        "latest committed CometBFT state, not Ethereum beacon finality",
    },
    methods: {},
  };

  evidence.methods.eth_getBlockByNumber = {};
  for (const tag of tags) {
    const block = await rpc("eth_getBlockByNumber", [tag, false]);
    assert.ok(block?.number && block?.hash, `${tag} block was not returned`);
    const explicit = await rpc("eth_getBlockByNumber", [block.number, false]);
    assert.equal(
      explicit?.hash,
      block.hash,
      `${tag} did not resolve to its explicit committed block`
    );
    evidence.methods.eth_getBlockByNumber[tag] = {
      number: block.number,
      hash: block.hash,
      explicitNumberHashMatched: true,
    };
  }

  const scalarMethods = {
    eth_getBalance: (tag) => [deployer, tag],
    eth_getTransactionCount: (tag) => [deployer, tag],
    eth_call: (tag) => [{ to: contract, data: "0x3fa4f245" }, tag],
  };
  for (const [method, paramsForTag] of Object.entries(scalarMethods)) {
    const outcomes = {};
    for (const tag of tags) {
      const response = await rpcEnvelope(method, paramsForTag(tag));
      outcomes[tag] = response.error
        ? { ok: false, error: summarizeError(response) }
        : { ok: true, value: response.result };
    }
    assert.equal(outcomes.latest.ok, true, `${method} latest failed`);
    assert.equal(outcomes.pending.ok, true, `${method} pending failed`);
    assert.equal(
      outcomes.safe.ok,
      false,
      `${method} safe unexpectedly succeeded`
    );
    assert.equal(
      outcomes.safe.error.code,
      -32602,
      `${method} safe error changed`
    );
    assert.equal(outcomes.finalized.ok, true, `${method} finalized failed`);
    for (const tag of ["pending", "finalized"]) {
      assert.deepEqual(
        outcomes[tag].value,
        outcomes.latest.value,
        `${method} ${tag} differed from stable latest state`
      );
    }
    evidence.methods[method] = outcomes;
  }
  return evidence;
}

async function exerciseErrorEnvelopes() {
  const methodNotFound = await rawRPC(
    JSON.stringify(rpcRequest("method-not-found", "torium_methodDoesNotExist"))
  );
  const invalidParams = await rawRPC(
    JSON.stringify(rpcRequest("invalid-params", "eth_getBalance", []))
  );
  const invalidRequest = await rawRPC(
    JSON.stringify({ jsonrpc: "2.0", id: "invalid-request" })
  );
  const parseError = await rawRPC('{"jsonrpc":"2.0",');
  const mixedBatch = await rawRPC(
    JSON.stringify([
      rpcRequest("batch-success", "eth_chainId"),
      rpcRequest("batch-method", "torium_methodDoesNotExist"),
      rpcRequest("batch-params", "eth_getBalance", []),
    ])
  );

  for (const response of [
    methodNotFound,
    invalidParams,
    invalidRequest,
    parseError,
    mixedBatch,
  ]) {
    assert.equal(response.status, 200, "JSON-RPC error changed from HTTP 200");
  }
  assert.equal(methodNotFound.body.error?.code, -32601);
  assert.equal(methodNotFound.body.id, "method-not-found");
  assert.equal(invalidParams.body.error?.code, -32602);
  assert.equal(invalidParams.body.id, "invalid-params");
  assert.equal(invalidRequest.body.error?.code, -32600);
  assert.equal(parseError.body.error?.code, -32700);
  assert.ok(
    Array.isArray(mixedBatch.body),
    "mixed batch did not return an array"
  );
  const mixedById = Object.fromEntries(
    mixedBatch.body.map((entry) => [entry.id, entry])
  );
  assert.equal(mixedById["batch-success"]?.result, profile.ethereum.chainIdHex);
  assert.equal(mixedById["batch-method"]?.error?.code, -32601);
  assert.equal(mixedById["batch-params"]?.error?.code, -32602);

  return {
    methodNotFound: summarizeError(methodNotFound.body),
    invalidParams: summarizeError(invalidParams.body),
    invalidRequest: summarizeError(invalidRequest.body),
    parseError: summarizeError(parseError.body),
    mixedBatch: mixedBatch.body.map((entry) =>
      entry.error
        ? summarizeError(entry)
        : { jsonrpc: entry.jsonrpc, id: entry.id, result: entry.result }
    ),
  };
}

async function rawRPC(body) {
  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
    signal: AbortSignal.timeout(10_000),
  });
  const text = await response.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(
      `JSON-RPC returned a non-JSON envelope: ${text.slice(0, 200)}`
    );
  }
  return { status: response.status, body: parsed };
}

function summarizeError(envelope) {
  return {
    jsonrpc: envelope.jsonrpc,
    id: envelope.id ?? null,
    code: envelope.error?.code,
    message: envelope.error?.message,
  };
}

function summarizeBatchRejection(envelope, requests) {
  if (!Array.isArray(envelope)) {
    return {
      requests,
      shape: "single-error",
      error: summarizeError(envelope),
    };
  }
  const errors = envelope.filter((entry) => entry.error);
  return {
    requests,
    shape: "response-array",
    responses: envelope.length,
    errors: errors.length,
    errorCodes: [...new Set(errors.map((entry) => entry.error.code))],
    firstError: errors[0] ? summarizeError(errors[0]) : null,
  };
}

function webSocketHandshake(url, origin) {
  const target = new URL(url);
  const port = Number(target.port || 80);
  return new Promise((resolvePromise, reject) => {
    const socket = connect({ host: target.hostname, port });
    let response = "";
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`WebSocket Origin handshake timed out for ${origin}`));
    }, 10_000);
    socket.once("connect", () => {
      const key = randomBytes(16).toString("base64");
      const path = `${target.pathname || "/"}${target.search}`;
      socket.write(
        [
          `GET ${path} HTTP/1.1`,
          `Host: ${target.host}`,
          "Upgrade: websocket",
          "Connection: Upgrade",
          `Sec-WebSocket-Key: ${key}`,
          "Sec-WebSocket-Version: 13",
          `Origin: ${origin}`,
          "",
          "",
        ].join("\r\n")
      );
    });
    socket.on("data", (chunk) => {
      response += chunk.toString("utf8");
      if (!response.includes("\r\n\r\n")) return;
      clearTimeout(timer);
      socket.destroy();
      const statusLine = response.split("\r\n", 1)[0];
      const match = /^HTTP\/1\.1 (\d{3})/u.exec(statusLine);
      if (!match) {
        reject(
          new Error(`invalid WebSocket handshake response: ${statusLine}`)
        );
        return;
      }
      resolvePromise({ origin, status: Number(match[1]), statusLine });
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function exerciseSubscriptions({
  rpcUrl,
  wsUrl,
  contract,
  rawTransaction,
}) {
  const client = await RPCWebSocket.connect(wsUrl);
  try {
    const heads = await client.subscribe("newHeads");
    const logs = await client.subscribe("logs", { address: contract });
    const pendingTransactions = await client.subscribe(
      "newPendingTransactions"
    );
    const preMutationHeight = await rpc("eth_blockNumber");
    const historicalValueBefore = await rpc("eth_call", [
      { to: contract, data: "0x3fa4f245" },
      preMutationHeight,
    ]);
    assert.equal(historicalValueBefore, toUint256(0));
    const transactionHash = await rpc("eth_sendRawTransaction", [
      rawTransaction,
    ]);
    const receipt = await waitForReceipt(transactionHash);
    const receiptHeight = Number(BigInt(receipt.blockNumber));
    assert.ok(
      receiptHeight > Number(BigInt(preMutationHeight)),
      "state mutation did not commit after the historical reference block"
    );
    const [latestValueAfter, historicalValueAfter] = await Promise.all([
      rpc("eth_call", [{ to: contract, data: "0x3fa4f245" }, "latest"]),
      rpc("eth_call", [
        { to: contract, data: "0x3fa4f245" },
        preMutationHeight,
      ]),
    ]);
    assert.equal(latestValueAfter, toUint256(96));
    assert.equal(
      historicalValueAfter,
      historicalValueBefore,
      "historical eth_call changed after the later state mutation"
    );
    const [head, log, pendingTransactionHash] = await Promise.all([
      client.next(
        heads,
        ({ number }) => Number(BigInt(number)) >= receiptHeight
      ),
      client.next(
        logs,
        ({ transactionHash: observed }) =>
          observed.toLowerCase() === transactionHash.toLowerCase()
      ),
      client.next(
        pendingTransactions,
        (observed) => observed.toLowerCase() === transactionHash.toLowerCase()
      ),
    ]);
    assert.equal(log.address.toLowerCase(), contract.toLowerCase());
    assert.equal(log.removed, false);
    await client.unsubscribe(heads);
    await client.unsubscribe(logs);
    await client.unsubscribe(pendingTransactions);
    return {
      transactionHash,
      receiptHeight,
      newHeadHeight: Number(BigInt(head.number)),
      logTransactionHash: log.transactionHash,
      pendingTransactionHash,
      historicalState: {
        referenceBlock: preMutationHeight,
        valueAtReferenceBeforeMutation: historicalValueBefore,
        valueAtReferenceAfterMutation: historicalValueAfter,
        latestValueAfterMutation: latestValueAfter,
        explicitHistoricalCallPreserved: true,
      },
    };
  } finally {
    client.close();
  }
}

async function exerciseReconnect({ rpcUrl, wsUrl, controller, root }) {
  const beforeHeight = Number(BigInt(await rpc("eth_blockNumber")));
  const first = await RPCWebSocket.connect(wsUrl);
  const firstHeads = await first.subscribe("newHeads");
  const lastObservedHead = await first.next(
    firstHeads,
    ({ number }) => Number(BigInt(number)) > beforeHeight
  );
  const lastObservedHeight = Number(BigInt(lastObservedHead.number));
  const disconnected = first.closed(45_000);
  const restart = collectProcess(
    spawn(
      controller,
      [
        "restart",
        "--backend",
        "container",
        "--node",
        "validator-0",
        "--timeout",
        "120",
        "--json",
      ],
      { cwd: root, stdio: ["ignore", "pipe", "pipe"] }
    )
  );
  const [, restartOutput] = await Promise.all([disconnected, restart]);
  first.close();
  const restartReport = JSON.parse(restartOutput.stdout);
  assert.equal(restartReport.ready, true);
  assert.equal(restartReport.state, "ready");

  const backfillTip = Number(BigInt(await rpc("eth_blockNumber")));
  assert.ok(
    backfillTip > lastObservedHeight,
    "restart produced no HTTP backfill range"
  );
  const backfilled = [];
  for (
    let height = lastObservedHeight + 1;
    height <= backfillTip;
    height += 1
  ) {
    const block = await rpc("eth_getBlockByNumber", [
      toQuantity(height),
      false,
    ]);
    assert.equal(Number(BigInt(block.number)), height);
    backfilled.push(height);
  }

  const second = await RPCWebSocket.connect(wsUrl);
  try {
    const secondHeads = await second.subscribe("newHeads");
    const resumed = await second.next(
      secondHeads,
      ({ number }) => Number(BigInt(number)) > backfillTip
    );
    await second.unsubscribe(secondHeads);
    return {
      socketClosedOnRestart: true,
      lastObservedHeadHeight: lastObservedHeight,
      backfilledFrom: backfilled[0],
      backfilledTo: backfilled.at(-1),
      backfilledBlocks: backfilled.length,
      resumedHeadHeight: Number(BigInt(resumed.number)),
    };
  } finally {
    second.close();
  }
}

class RPCWebSocket {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    this.queues = new Map();
    this.waiters = new Map();
    socket.addEventListener("message", ({ data }) =>
      this.onMessage(String(data))
    );
  }

  static async connect(url) {
    const socket = new WebSocket(url);
    await new Promise((resolvePromise, reject) => {
      const timer = setTimeout(
        () => reject(new Error("WebSocket open timed out")),
        10_000
      );
      socket.addEventListener(
        "open",
        () => {
          clearTimeout(timer);
          resolvePromise();
        },
        { once: true }
      );
      socket.addEventListener(
        "error",
        () => {
          clearTimeout(timer);
          reject(new Error("WebSocket open failed"));
        },
        { once: true }
      );
    });
    return new RPCWebSocket(socket);
  }

  request(method, params = []) {
    const id = this.nextId++;
    this.socket.send(JSON.stringify(rpcRequest(id, method, params)));
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`WebSocket ${method} timed out`));
      }, 15_000);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolvePromise(value);
        },
        reject,
      });
    });
  }

  async subscribe(kind, filter) {
    const params = filter === undefined ? [kind] : [kind, filter];
    const id = await this.request("eth_subscribe", params);
    if (!this.queues.has(id)) this.queues.set(id, []);
    if (!this.waiters.has(id)) this.waiters.set(id, []);
    return id;
  }

  async unsubscribe(id) {
    assert.equal(await this.request("eth_unsubscribe", [id]), true);
  }

  next(id, predicate = () => true, timeoutMilliseconds = 20_000) {
    const queue = this.queues.get(id) ?? [];
    const matchIndex = queue.findIndex(predicate);
    if (matchIndex >= 0) return Promise.resolve(queue.splice(matchIndex, 1)[0]);
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`subscription ${id} notification timed out`)),
        timeoutMilliseconds
      );
      const waiters = this.waiters.get(id) ?? [];
      waiters.push({
        predicate,
        resolve: (value) => {
          clearTimeout(timer);
          resolvePromise(value);
        },
      });
      this.waiters.set(id, waiters);
    });
  }

  closed(timeoutMilliseconds) {
    if (this.socket.readyState === WebSocket.CLOSED) return Promise.resolve();
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(
        () => reject(new Error("WebSocket did not close during restart")),
        timeoutMilliseconds
      );
      this.socket.addEventListener(
        "close",
        () => {
          clearTimeout(timer);
          resolvePromise();
        },
        { once: true }
      );
    });
  }

  close() {
    if (
      this.socket.readyState === WebSocket.OPEN ||
      this.socket.readyState === WebSocket.CONNECTING
    ) {
      this.socket.close();
    }
  }

  onMessage(raw) {
    const message = JSON.parse(raw);
    if (message.id !== undefined) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
      return;
    }
    if (message.method !== "eth_subscription") return;
    const id = message.params.subscription;
    const result = message.params.result;
    const waiters = this.waiters.get(id) ?? [];
    const matchIndex = waiters.findIndex(({ predicate }) => predicate(result));
    if (matchIndex >= 0) {
      const [{ resolve }] = waiters.splice(matchIndex, 1);
      resolve(result);
      return;
    }
    const queue = this.queues.get(id) ?? [];
    queue.push(result);
    this.queues.set(id, queue);
  }
}

async function rpc(method, params = []) {
  const response = await rpcEnvelope(method, params);
  if (response.error) throw new Error(`${method}: ${response.error.message}`);
  assert.ok("result" in response, `${method} response omitted result`);
  return response.result;
}

async function rpcEnvelope(method, params = []) {
  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(rpcRequest(method, method, params)),
    signal: AbortSignal.timeout(10_000),
  });
  assert.equal(
    response.status,
    200,
    `${method} returned HTTP ${response.status}`
  );
  return response.json();
}

async function rpcBatch(size) {
  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(
      Array.from({ length: size }, (_, index) =>
        rpcRequest(index + 1, "eth_chainId")
      )
    ),
    signal: AbortSignal.timeout(10_000),
  });
  assert.equal(
    response.status,
    200,
    `batch ${size} returned HTTP ${response.status}`
  );
  return response.json();
}

async function waitForReceipt(transactionHash) {
  for (let attempt = 0; attempt < 45; attempt += 1) {
    const receipt = await rpc("eth_getTransactionReceipt", [transactionHash]);
    if (receipt) return receipt;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_000));
  }
  throw new Error(`transaction ${transactionHash} received no receipt`);
}

async function fetchJSON(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
  return response.json();
}

function assertTCP(host, port) {
  return new Promise((resolvePromise, reject) => {
    const socket = connect({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`${host}:${port} did not accept a TCP connection`));
    }, 5_000);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.end();
      resolvePromise();
    });
    socket.once("error", reject);
  });
}

function collectProcess(child) {
  return new Promise((resolvePromise, reject) => {
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolvePromise({ stdout, stderr });
      else reject(new Error(`restart exited ${code}: ${stderr || stdout}`));
    });
  });
}

function summarizeResult(method, result) {
  switch (method) {
    case "eth_getBlockByNumber":
      return { number: result.number, hash: result.hash };
    case "eth_feeHistory":
      return {
        oldestBlock: result.oldestBlock,
        blocks: result.gasUsedRatio.length,
      };
    case "eth_getLogs":
      return { count: result.length };
    case "eth_getBalance":
    case "eth_gasPrice":
      return result;
    default:
      return result;
  }
}

function rpcRequest(id, method, params = []) {
  return { jsonrpc: "2.0", id, method, params };
}

function toQuantity(value) {
  return `0x${value.toString(16)}`;
}

function toUint256(value) {
  return `0x${BigInt(value).toString(16).padStart(64, "0")}`;
}

function parseArgs(argv) {
  const parsed = {
    root: null,
    contract: null,
    rawTransaction: null,
    manifest: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    switch (value) {
      case "--root":
        parsed.root = argv[++index];
        break;
      case "--contract":
        parsed.contract = argv[++index];
        break;
      case "--raw-transaction":
        parsed.rawTransaction = argv[++index];
        break;
      case "--manifest":
        parsed.manifest = argv[++index];
        break;
      default:
        throw new Error(`unknown argument ${value}`);
    }
  }
  for (const [name, value] of Object.entries(parsed)) {
    if (!value)
      throw new Error(
        `--${name.replaceAll(/[A-Z]/gu, (c) => `-${c.toLowerCase()}`)} is required`
      );
  }
  return parsed;
}

const subscriptionEvidence = await exerciseSubscriptions({
  rpcUrl,
  wsUrl,
  contract: args.contract,
  rawTransaction: args.rawTransaction,
});
const reconnectEvidence = await exerciseReconnect({
  rpcUrl,
  wsUrl,
  controller,
  root: args.root,
});

const proof = {
  schemaVersion: 1,
  result: "passed",
  network: "canonical-four-validator-localnet",
  profileVersion: profile.profileVersion,
  chainId: profile.ethereum.chainId,
  methods: observedMethods,
  blockTags: blockTagEvidence,
  errorEnvelopes: errorEnvelopeEvidence,
  debugTrace: {
    defaultProfileStatus: "disabled",
    explorerOperatorProfileStatus: "not-covered-by-this-suite",
    envelopes: Object.fromEntries(
      Object.entries(forbiddenEvidence).filter(([method]) =>
        method.startsWith("debug_")
      )
    ),
  },
  otherDisabledMethodEnvelopes: Object.fromEntries(
    Object.entries(forbiddenEvidence).filter(
      ([method]) => !method.startsWith("debug_")
    )
  ),
  limits: {
    batch: batchBoundaryEvidence,
    oversizedBodyRejected: true,
    maxOpenConnections: profile.ethereum.limits.maxOpenConnections,
  },
  services: {
    restNetwork: nodeInfo.default_node_info.network,
    applicationVersion: nodeInfo.application_version.version,
    grpcReachable: true,
    cometPeers: Number(cometPeers.result.n_peers),
    unsafeCometMethodRejected: true,
  },
  webSocketOrigins: webSocketOriginEvidence,
  subscriptions: subscriptionEvidence,
  historicalState: subscriptionEvidence.historicalState,
  reconnect: reconnectEvidence,
  httpCorsBoundary: profile.exposure.httpCors.implementation,
};
await mkdir(join(args.root, "chain/tests/rpc/.artifacts"), { recursive: true });
await writeFile(reportPath, `${JSON.stringify(proof, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(proof, null, 2)}\n`);
