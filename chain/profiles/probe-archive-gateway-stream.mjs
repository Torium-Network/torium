#!/usr/bin/env node
// Stream-transport probe for the #114 archive gateway. The HTTP allowlist is
// proven with curl in run-archive-gateway-evidence-v0.sh; the WebSocket
// transport needs a real client, because its rules are frame-scoped: the same
// method allowlist, plus eth_subscribe restricted to the contract's
// `webSocket.subscriptions`.
//
// The allowlist is READ FROM the reviewed profile, never restated here, so a
// contract change is a probe change automatically.

import { readFile } from "node:fs/promises";
import process from "node:process";

const options = parseArguments(process.argv.slice(2));
const profile = JSON.parse(await readFile(options.profile, "utf8"));
const gateway = profile.consumerGateways?.["archive-indexer-v0"];
const policy = profile.runtimePolicies?.[gateway?.runtimePolicyRef];
if (!gateway || !policy) {
  fail("the reviewed profile has no archive gateway runtime policy");
}
const allowedMethods = policy[gateway.enforcedContractField];
const allowedSubscriptions = policy.webSocket.subscriptions;
if (!Array.isArray(allowedMethods) || allowedMethods.length === 0) {
  fail("the reviewed archive method allowlist is empty");
}
if (!Array.isArray(allowedSubscriptions) || allowedSubscriptions.length === 0) {
  fail("the reviewed archive subscription allowlist is empty");
}

const REFUSAL_CODE = -32601;
const results = {
  schemaVersion: 1,
  evidence: "archive-gateway-stream-transport-v0",
  result: "failed",
  url: options.url,
  allowedSubscriptionsProven: [],
  refusedSubscriptions: [],
  refusedMethods: [],
  allowedMethodsProven: [],
};

const socket = await connect(options.url);
try {
  // 1. A representative allowlisted method must answer over the stream too.
  for (const method of ["eth_chainId", "eth_blockNumber"]) {
    if (!allowedMethods.includes(method)) continue;
    const response = await call(socket, method, []);
    if (response.error) {
      fail(`allowlisted ${method} was refused over the stream: ${JSON.stringify(response.error)}`);
    }
    results.allowedMethodsProven.push(method);
  }

  // 2. Every contract-allowed subscription must be accepted and produce a
  //    subscription id; an accepted-but-unusable subscription is not proof.
  for (const stream of allowedSubscriptions) {
    const parameters = stream === "logs" ? [stream, {}] : [stream];
    const response = await call(socket, "eth_subscribe", parameters);
    if (response.error || typeof response.result !== "string") {
      fail(`allowlisted subscription ${stream} was refused: ${JSON.stringify(response.error ?? response)}`);
    }
    const teardown = await call(socket, "eth_unsubscribe", [response.result]);
    if (teardown.error) {
      fail(`unsubscribing from ${stream} was refused: ${JSON.stringify(teardown.error)}`);
    }
    results.allowedSubscriptionsProven.push(stream);
  }

  // 3. Any stream outside the contract must be refused with the same opaque
  //    "method not found" the HTTP transport uses.
  for (const stream of ["newPendingTransactions", "syncing", "pendingTransactions"]) {
    if (allowedSubscriptions.includes(stream)) continue;
    const response = await call(socket, "eth_subscribe", [stream]);
    if (response.error?.code !== REFUSAL_CODE) {
      fail(`subscription ${stream} was not refused: ${JSON.stringify(response)}`);
    }
    results.refusedSubscriptions.push(stream);
  }

  // 4. The method allowlist applies on the stream transport as well.
  for (const method of [
    "eth_sendRawTransaction",
    "debug_traceTransaction",
    "admin_nodeInfo",
    "personal_listAccounts",
    "txpool_content",
  ]) {
    if (allowedMethods.includes(method)) {
      fail(`the reviewed allowlist unexpectedly contains ${method}`);
    }
    const response = await call(socket, method, []);
    if (response.error?.code !== REFUSAL_CODE) {
      fail(`stream method ${method} was not refused: ${JSON.stringify(response)}`);
    }
    results.refusedMethods.push(method);
  }

  // 5. A refusal must not close the connection: fail-closed means refuse the
  //    frame, not drop the consumer.
  const survivor = await call(socket, "eth_chainId", []);
  if (survivor.error) {
    fail("the connection stopped serving allowlisted calls after a refusal");
  }
} finally {
  socket.close();
}

results.result = "passed";
process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);

function parseArguments(argv) {
  const parsed = { url: null, profile: null };
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === "--url") parsed.url = value;
    else if (flag === "--profile") parsed.profile = value;
    else fail(`unknown argument ${flag}`);
  }
  if (!parsed.url || !parsed.profile) {
    fail("usage: probe-archive-gateway-stream.mjs --url <ws-url> --profile <node-roles-v0.json>");
  }
  return parsed;
}

async function connect(url) {
  const socket = new WebSocket(url);
  const pending = new Map();
  let nextId = 1;
  socket.addEventListener("message", (event) => {
    let frame;
    try {
      frame = JSON.parse(typeof event.data === "string" ? event.data : "");
    } catch {
      return;
    }
    // Subscription notifications carry no id; only replies resolve a call.
    if (frame?.id === undefined || frame.id === null) return;
    const resolve = pending.get(frame.id);
    if (resolve) {
      pending.delete(frame.id);
      resolve(frame);
    }
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`WebSocket handshake to ${url} timed out`)), 20_000);
    socket.addEventListener("open", () => {
      clearTimeout(timer);
      resolve();
    });
    socket.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error(`WebSocket connection to ${url} failed`));
    });
  });
  socket.call = (method, params) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`${method} received no reply within 20s`));
      }, 20_000);
      pending.set(id, (frame) => {
        clearTimeout(timer);
        resolve(frame);
      });
      socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    });
  return socket;
}

function call(socket, method, params) {
  return socket.call(method, params);
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}
