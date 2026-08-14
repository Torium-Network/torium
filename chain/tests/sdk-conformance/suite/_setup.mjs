/**
 * Shared fixtures for the Torium SDK localnet conformance suite.
 *
 * Everything here targets the disposable, valueless localnet only. Account
 * keys are re-derived from the public fixture formula documented in
 * chain/localnet/ACCOUNTS.md; they must never be used on a public network.
 */
import { createHash } from "node:crypto";
import { appendFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { http, webSocket } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { toriumLocalnet, withToriumRpcUrls } from "@torium-network/sdk/chains";
import { createToriumPublicClient } from "@torium-network/sdk/clients";
import {
  createToriumWalletClient,
  preflightToriumTransaction,
  sendToriumTransactionOnce,
  waitForToriumTransaction,
} from "@torium-network/sdk/wallet";

export const evmRpcUrl =
  process.env.TORIUM_CONFORMANCE_EVM_RPC ?? "http://127.0.0.1:8545";
export const evmWsUrl =
  process.env.TORIUM_CONFORMANCE_EVM_WS ?? "ws://127.0.0.1:8546";
const resultsPath =
  process.env.TORIUM_CONFORMANCE_RESULTS ?? "conformance-results.jsonl";

export const chain = withToriumRpcUrls(toriumLocalnet, {
  http: [evmRpcUrl],
  webSocket: [evmWsUrl],
});

const fixtureDomain = "torium/localnet/valueless-fixture/v1";

/** Re-derives a public disposable localnet fixture key by context name. */
export function fixtureAccount(context) {
  const digest = createHash("sha256")
    .update(`${fixtureDomain}/account/${context}`)
    .digest("hex");
  return privateKeyToAccount(`0x${digest}`);
}

export const deployer = fixtureAccount("deployer");
export const sdkUser = fixtureAccount("sdk-user");
export const testUser = fixtureAccount("test-user");

export function publicClient() {
  return createToriumPublicClient({ chain, transport: http(evmRpcUrl) });
}

export function webSocketClient() {
  return createToriumPublicClient({
    chain,
    transport: webSocket(evmWsUrl, { retryCount: 0 }),
  });
}

export function walletClient(account) {
  return createToriumWalletClient({
    chain,
    account,
    transport: http(evmRpcUrl),
  });
}

/**
 * Full SDK write lifecycle: preflight, authorize, submit once, and wait for
 * one CometBFT commit. Returns the committed receipt or throws.
 */
export async function submitAndCommit(account, request, options = {}) {
  const reads = publicClient();
  const wallet = walletClient(account);
  const preflight = await preflightToriumTransaction(reads, {
    account,
    ...request,
  });
  if (!preflight.canSubmit) {
    throw new Error(
      `preflight blocked: ${preflight.blockers.join(", ") || "unknown"}`
    );
  }
  const acknowledgement = await sendToriumTransactionOnce(
    wallet,
    reads,
    { account, ...request },
    { authorize: () => true }
  );
  const lifecycle = await waitForToriumTransaction(reads, {
    hash: acknowledgement.hash,
    timeout: options.timeout ?? 60_000,
  });
  if (lifecycle.status !== (options.expect ?? "committed")) {
    throw new Error(
      `transaction ${acknowledgement.hash} ended ${lifecycle.status}, expected ${options.expect ?? "committed"}`
    );
  }
  return lifecycle;
}

/** Polls the latest block until its timestamp reaches `target` seconds. */
export async function waitForBlockTimestamp(target, timeoutMs = 90_000) {
  const reads = publicClient();
  const startedAt = Date.now();
  for (;;) {
    const block = await reads.getBlock({ blockTag: "latest" });
    if (block.timestamp >= target) return block.timestamp;
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(
        `block timestamp ${block.timestamp} did not reach ${target} in time`
      );
    }
    await sleep(500);
  }
}

/** Records one compatibility-matrix capability outcome. */
export async function recordCapability(id, method, status = "pass") {
  await appendFile(
    resultsPath,
    `${JSON.stringify({ id, method, status })}\n`,
    "utf8"
  );
}
