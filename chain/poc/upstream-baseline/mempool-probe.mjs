import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";

import { createPublicClient, defineChain, http, parseGwei } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const rpcUrl = process.env.RPC_URL ?? "http://127.0.0.1:8545";
const peerRpcUrl = process.env.PEER_RPC_URL ?? "http://127.0.0.1:8555";
const chainId = Number(process.env.EVM_CHAIN_ID ?? "262144");
const stoppedValidators = (process.env.STOP_VALIDATORS ?? "evmdnode2,evmdnode3")
  .split(",")
  .filter(Boolean);
const reportPath = process.env.REPORT_PATH;

// Public, deterministic accounts embedded in the upstream v0.7.0 testnet.
// They are disposable fixtures and must never be used on a public network.
const sender = privateKeyToAccount(
  "0x88cbead91aee890d27bf06e003ade3d4e952427e88f88d31d61d3ef5e5d54305"
);
const queueAccount = privateKeyToAccount(
  "0x741de4f8988ea941d3ff0287911ca4074e62b7d45c991a51186455366f10b544"
);
const recipient = "0x40a0cb1C63e026A81B55EE1308586E21eec1eFa9";
const chain = defineChain({
  id: chainId,
  name: "Cosmos EVM v0.7.0 mempool probe",
  nativeCurrency: { name: "atest", symbol: "ATEST", decimals: 18 },
  rpcUrls: { default: { http: [rpcUrl] } },
});
const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });

async function rpc(url, method, params = []) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const payload = await response.json();
  if (payload.error) return { ok: false, error: payload.error };
  return { ok: true, result: payload.result };
}

async function sign(
  account,
  { nonce, value, maxFeePerGas, maxPriorityFeePerGas }
) {
  return await account.signTransaction({
    chainId,
    type: "eip1559",
    nonce,
    gas: 21_000n,
    to: recipient,
    value,
    maxFeePerGas,
    maxPriorityFeePerGas,
  });
}

async function sendRaw(raw) {
  return await rpc(rpcUrl, "eth_sendRawTransaction", [raw]);
}

async function waitReceipt(hash) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const result = await rpc(rpcUrl, "eth_getTransactionReceipt", [hash]);
    if (result.ok && result.result) return result.result;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(`receipt timeout: ${hash}`);
}

async function waitForNextBlock() {
  const initial = await publicClient.getBlockNumber();
  for (let attempt = 0; attempt < 30; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    const current = await publicClient.getBlockNumber();
    if (current > initial) return { initial, current };
  }
  throw new Error("mempool probe preflight did not observe a fresh block");
}

function collectTransactions(node, output = []) {
  if (!node || typeof node !== "object") return output;
  if ("nonce" in node && ("hash" in node || "from" in node)) {
    output.push(node);
    return output;
  }
  for (const value of Object.values(node)) collectTransactions(value, output);
  return output;
}

async function main() {
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    target: { rpcUrl, peerRpcUrl, chainId, stoppedValidators },
    checks: {},
  };
  let validatorsStopped = false;

  try {
    const preflight = await waitForNextBlock();
    report.checks.preflight = {
      initialBlock: preflight.initial.toString(),
      freshBlock: preflight.current.toString(),
    };
    execFileSync("docker", ["stop", ...stoppedValidators], { stdio: "pipe" });
    validatorsStopped = true;
    const haltedAt = await publicClient.getBlockNumber();
    await new Promise((resolve) => setTimeout(resolve, 6_000));
    const haltedAfterWait = await publicClient.getBlockNumber();
    report.checks.consensusHalt = {
      before: haltedAt.toString(),
      afterSixSeconds: haltedAfterWait.toString(),
      halted: haltedAt === haltedAfterWait,
    };
    if (haltedAt !== haltedAfterWait)
      throw new Error("two validators did not halt quorum");

    const nonce = await publicClient.getTransactionCount({
      address: sender.address,
      blockTag: "pending",
    });
    const low = await sign(sender, {
      nonce,
      value: 1n,
      maxFeePerGas: parseGwei("1"),
      maxPriorityFeePerGas: parseGwei("0.1"),
    });
    const underpriced = await sign(sender, {
      nonce,
      value: 2n,
      maxFeePerGas: parseGwei("1.05"),
      maxPriorityFeePerGas: parseGwei("0.105"),
    });
    const replacement = await sign(sender, {
      nonce,
      value: 3n,
      maxFeePerGas: parseGwei("2"),
      maxPriorityFeePerGas: parseGwei("0.2"),
    });

    const lowResult = await sendRaw(low);
    const underpricedResult = await sendRaw(underpriced);
    const replacementResult = await sendRaw(replacement);
    report.checks.replacement = {
      nonce,
      initial: lowResult,
      underpriced: underpricedResult,
      higherFee: replacementResult,
    };
    if (!lowResult.ok || underpricedResult.ok || !replacementResult.ok) {
      throw new Error(
        `same-nonce replacement semantics did not match the configured 10% bump: ${JSON.stringify(report.checks.replacement)}`
      );
    }

    const gapTwo = await sign(sender, {
      nonce: nonce + 2,
      value: 5n,
      maxFeePerGas: parseGwei("2"),
      maxPriorityFeePerGas: parseGwei("0.2"),
    });
    const gapOne = await sign(sender, {
      nonce: nonce + 1,
      value: 4n,
      maxFeePerGas: parseGwei("2"),
      maxPriorityFeePerGas: parseGwei("0.2"),
    });
    const gapTwoResult = await sendRaw(gapTwo);
    const beforeFill = await rpc(rpcUrl, "txpool_content");
    const gapOneResult = await sendRaw(gapOne);
    const afterFill = await rpc(rpcUrl, "txpool_content");
    report.checks.nonceGap = {
      gapAccepted: gapTwoResult.ok,
      parentAccepted: gapOneResult.ok,
      queuedBeforeParent: beforeFill.ok,
      poolReadableAfterParent: afterFill.ok,
    };
    if (!gapTwoResult.ok || !gapOneResult.ok) {
      throw new Error("nonce-gap queue/promotion transaction was rejected");
    }

    let peerPool = { ok: false, error: { message: "not queried" } };
    let peerNonceEntry;
    let peerSenderTransactions = [];
    let replacementSeenOnPeer = false;
    for (let attempt = 0; attempt < 15; attempt += 1) {
      peerPool = await rpc(peerRpcUrl, "txpool_content");
      const peerPendingAccount = peerPool.ok
        ? Object.entries(peerPool.result.pending ?? {}).find(
            ([address]) =>
              address.toLowerCase() === sender.address.toLowerCase()
          )?.[1]
        : undefined;
      const peerQueuedAccount = peerPool.ok
        ? Object.entries(peerPool.result.queued ?? {}).find(
            ([address]) =>
              address.toLowerCase() === sender.address.toLowerCase()
          )?.[1]
        : undefined;
      peerSenderTransactions = collectTransactions({
        pending: peerPendingAccount,
        queued: peerQueuedAccount,
      });
      peerNonceEntry = peerSenderTransactions.find(
        (transaction) => Number(BigInt(transaction.nonce)) === nonce
      );
      replacementSeenOnPeer = Boolean(
        peerNonceEntry &&
        (peerNonceEntry.hash?.toLowerCase() ===
          replacementResult.result.toLowerCase() ||
          (BigInt(peerNonceEntry.value ?? "0x0") === 3n &&
            BigInt(peerNonceEntry.maxFeePerGas ?? "0x0") === parseGwei("2")))
      );
      if (replacementSeenOnPeer) break;
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    const peerPoolText = peerPool.ok
      ? JSON.stringify(peerPool.result).toLowerCase()
      : "";
    report.checks.propagation = {
      status: replacementSeenOnPeer ? "supported" : "partial",
      peerPoolReadable: peerPool.ok,
      replacementSeenOnPeer,
      senderSeenOnPeer: peerPoolText.includes(
        sender.address.slice(2).toLowerCase()
      ),
      peerTransactionAtNonce: peerNonceEntry
        ? {
            hash: peerNonceEntry.hash ?? null,
            nonce: peerNonceEntry.nonce ?? null,
            value: peerNonceEntry.value ?? null,
            maxFeePerGas: peerNonceEntry.maxFeePerGas ?? null,
            maxPriorityFeePerGas: peerNonceEntry.maxPriorityFeePerGas ?? null,
          }
        : null,
      peerSenderTransactions: peerSenderTransactions.map((transaction) => ({
        hash: transaction.hash ?? null,
        nonce: transaction.nonce ?? null,
        value: transaction.value ?? null,
        maxFeePerGas: transaction.maxFeePerGas ?? null,
        maxPriorityFeePerGas: transaction.maxPriorityFeePerGas ?? null,
      })),
    };

    const queueNonce = await publicClient.getTransactionCount({
      address: queueAccount.address,
      blockTag: "pending",
    });
    let accepted = 0;
    const rejected = [];
    for (let offset = 100; offset < 170; offset += 1) {
      const raw = await sign(queueAccount, {
        nonce: queueNonce + offset,
        value: 1n,
        maxFeePerGas: parseGwei("2"),
        maxPriorityFeePerGas: parseGwei("0.2"),
      });
      const result = await sendRaw(raw);
      if (result.ok) accepted += 1;
      else rejected.push({ offset, error: result.error });
    }
    const queuePool = await rpc(rpcUrl, "txpool_content");
    const queueEntries = queuePool.ok
      ? Object.entries(queuePool.result.queued ?? {}).find(
          ([address]) =>
            address.toLowerCase() === queueAccount.address.toLowerCase()
        )?.[1]
      : undefined;
    const retained = queueEntries ? Object.keys(queueEntries).length : 0;
    const evicted = accepted - retained;
    report.checks.accountQueueLimit = {
      attempted: 70,
      accepted,
      rejected: rejected.length,
      retained,
      evicted,
      firstRejection: rejected[0] ?? null,
    };
    if (rejected.length + evicted === 0 || retained > 64) {
      throw new Error(
        "account queue limit did not cap 70 future transactions at 64"
      );
    }

    execFileSync("docker", ["start", ...stoppedValidators], { stdio: "pipe" });
    validatorsStopped = false;
    const replacementReceipt = await waitReceipt(replacementResult.result);
    const gapOneReceipt = await waitReceipt(gapOneResult.result);
    const gapTwoReceipt = await waitReceipt(gapTwoResult.result);
    const originalReceipt = await rpc(rpcUrl, "eth_getTransactionReceipt", [
      lowResult.result,
    ]);
    report.checks.inclusion = {
      replacementStatus: replacementReceipt.status,
      firstGapStatus: gapOneReceipt.status,
      secondGapStatus: gapTwoReceipt.status,
      originalAbsent: originalReceipt.ok && originalReceipt.result === null,
    };
    if (
      replacementReceipt.status !== "0x1" ||
      gapOneReceipt.status !== "0x1" ||
      gapTwoReceipt.status !== "0x1" ||
      !report.checks.inclusion.originalAbsent
    ) {
      throw new Error(
        "replacement/gap transactions did not finalize as expected"
      );
    }
  } finally {
    if (validatorsStopped) {
      execFileSync("docker", ["start", ...stoppedValidators], {
        stdio: "pipe",
      });
    }
  }

  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (reportPath) await writeFile(reportPath, json, "utf8");
  process.stdout.write(json);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
