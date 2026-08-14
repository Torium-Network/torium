import { writeFile } from "node:fs/promises";

import { JsonRpcProvider, Wallet } from "ethers";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import WebSocket from "ws";

const rpcUrl = process.env.RPC_URL ?? "http://127.0.0.1:8545";
const wsUrl = process.env.WS_URL ?? "ws://127.0.0.1:8546";
const reportPath = process.env.REPORT_PATH;
const expectedChainId = Number(process.env.EVM_CHAIN_ID ?? "262144");

// Public upstream dev key from cosmos/evm v0.7.0 local_node.sh.
// It is deterministic, disposable, and must never be used on a public network.
const senderKey =
  process.env.PROBE_PRIVATE_KEY ??
  "0x88cbead91aee890d27bf06e003ade3d4e952427e88f88d31d61d3ef5e5d54305";
const recipient =
  process.env.PROBE_RECIPIENT ?? "0x963EBDf2e1f8DB8707D05FC75bfeFFBa1B5BaC17";

const account = privateKeyToAccount(senderKey);
const chain = defineChain({
  id: expectedChainId,
  name: "Cosmos EVM v0.7.0 probe",
  nativeCurrency: { name: "atest", symbol: "ATEST", decimals: 18 },
  rpcUrls: { default: { http: [rpcUrl], webSocket: [wsUrl] } },
});
const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
const walletClient = createWalletClient({
  account,
  chain,
  transport: http(rpcUrl),
});
const ethersProvider = new JsonRpcProvider(rpcUrl, expectedChainId, {
  staticNetwork: true,
});
const ethersWallet = new Wallet(senderKey, ethersProvider);

const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  target: { rpcUrl, wsUrl, expectedChainId },
  account: { sender: account.address, recipient },
  checks: {},
};

async function rpc(method, params = []) {
  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const payload = await response.json();
  if (payload.error) return { ok: false, error: payload.error };
  return { ok: true, result: payload.result };
}

function summarize(result) {
  if (!result.ok) return result;
  if (Array.isArray(result.result)) {
    return { ok: true, shape: "array", length: result.result.length };
  }
  if (result.result && typeof result.result === "object") {
    return {
      ok: true,
      shape: "object",
      keys: Object.keys(result.result).sort(),
    };
  }
  return { ok: true, shape: typeof result.result, value: result.result };
}

function summarizeFeeHistory(result) {
  if (!result.ok) return result;
  return {
    ok: true,
    oldestBlock: result.result.oldestBlock,
    blockCount: result.result.gasUsedRatio?.length ?? null,
    baseFeeCount: result.result.baseFeePerGas?.length ?? null,
    rewardCount: result.result.reward?.length ?? null,
  };
}

async function waitForBlock() {
  for (let attempt = 0; attempt < 45; attempt += 1) {
    try {
      const blockNumber = await publicClient.getBlockNumber();
      if (blockNumber > 0n) return blockNumber;
    } catch {
      // The RPC opens before the first block; retry until consensus is ready.
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error("RPC did not produce a block within 45 seconds");
}

async function probeBlockTags(contractAddress) {
  const methods = {
    eth_getBlockByNumber: (tag) => [tag, false],
    eth_getBalance: (tag) => [account.address, tag],
    eth_getTransactionCount: (tag) => [account.address, tag],
    eth_call: (tag) => [{ to: contractAddress, data: "0x" }, tag],
  };
  const tags = ["latest", "pending", "safe", "finalized"];
  const results = {};
  for (const [method, paramsFor] of Object.entries(methods)) {
    results[method] = {};
    for (const tag of tags) {
      results[method][tag] = summarize(await rpc(method, paramsFor(tag)));
    }
  }
  return results;
}

async function probeSubscriptions(contractAddress) {
  const subscriptions = {
    newHeads: { params: ["newHeads"], received: false },
    logs: { params: ["logs", { address: contractAddress }], received: false },
    newPendingTransactions: {
      params: ["newPendingTransactions"],
      received: false,
    },
  };

  // Non-browser clients commonly omit Origin. Browser-origin policy is probed
  // separately because the upstream default list rejects URL-form origins.
  const socket = new WebSocket(wsUrl);
  const ids = new Map();
  let nextId = 1;

  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });

  const finished = new Promise((resolve) => {
    const timeout = setTimeout(() => resolve(), 25_000);
    socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.id && message.result) {
        const name = ids.get(message.id);
        if (name) subscriptions[name].subscriptionId = message.result;
      }
      if (message.method === "eth_subscription") {
        for (const entry of Object.values(subscriptions)) {
          if (entry.subscriptionId === message.params?.subscription) {
            entry.received = true;
            entry.sampleType = Array.isArray(message.params.result)
              ? "array"
              : typeof message.params.result;
          }
        }
        if (Object.values(subscriptions).every((entry) => entry.received)) {
          clearTimeout(timeout);
          resolve();
        }
      }
    });
  });

  for (const [name, entry] of Object.entries(subscriptions)) {
    const id = nextId++;
    ids.set(id, name);
    socket.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id,
        method: "eth_subscribe",
        params: entry.params,
      })
    );
  }

  // Give subscription acknowledgements time to arrive before emitting a log.
  await new Promise((resolve) => setTimeout(resolve, 500));
  const triggerHash = await walletClient.sendTransaction({
    account,
    to: contractAddress,
    data: "0x",
    value: 0n,
    // eth_estimateGas returns the intrinsic 21k for this tiny handcrafted
    // runtime, so provide headroom for LOG0 and assert the receipt below.
    gas: 100_000n,
  });
  const triggerReceipt = await publicClient.waitForTransactionReceipt({
    hash: triggerHash,
  });
  await finished;
  socket.close();

  if (triggerReceipt.status !== "success" || triggerReceipt.logs.length !== 1) {
    throw new Error(
      "WebSocket trigger transaction did not emit the expected log"
    );
  }

  return {
    triggerHash,
    triggerStatus: triggerReceipt.status,
    emittedLogs: triggerReceipt.logs.length,
    subscriptions: Object.fromEntries(
      Object.entries(subscriptions).map(([name, entry]) => [
        name,
        {
          acknowledged: Boolean(entry.subscriptionId),
          received: entry.received,
          sampleType: entry.sampleType ?? null,
        },
      ])
    ),
  };
}

async function probeBrowserOriginPolicy() {
  const origin = "http://localhost";
  const socket = new WebSocket(wsUrl, { origin });

  return await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.terminate();
      reject(new Error("browser-origin WebSocket probe timed out"));
    }, 10_000);

    socket.once("open", () => {
      clearTimeout(timeout);
      socket.close();
      resolve({ origin, accepted: true, httpStatus: 101 });
    });
    socket.once("unexpected-response", (_request, response) => {
      clearTimeout(timeout);
      socket.terminate();
      resolve({
        origin,
        accepted: false,
        httpStatus: response.statusCode,
        statusMessage: response.statusMessage,
      });
    });
    socket.once("error", (error) => {
      clearTimeout(timeout);
      resolve({ origin, accepted: false, error: error.message });
    });
  });
}

async function main() {
  report.checks.initialBlock = (await waitForBlock()).toString();
  report.checks.clientVersion = await rpc("web3_clientVersion");
  report.checks.chainId = await rpc("eth_chainId");
  report.checks.rpcModules = await rpc("rpc_modules");

  const viemChainId = await publicClient.getChainId();
  const ethersNetwork = await ethersProvider.getNetwork();
  report.checks.clients = {
    viem: { chainId: viemChainId, sender: account.address },
    ethers: {
      chainId: ethersNetwork.chainId.toString(),
      sender: ethersWallet.address,
    },
  };
  if (
    viemChainId !== expectedChainId ||
    ethersNetwork.chainId !== BigInt(expectedChainId)
  ) {
    throw new Error("client chain ID does not match the pinned localnet");
  }

  const recipientBefore = await publicClient.getBalance({ address: recipient });
  const transferHash = await walletClient.sendTransaction({
    account,
    to: recipient,
    value: 1n,
  });
  const transferReceipt = await publicClient.waitForTransactionReceipt({
    hash: transferHash,
  });
  const recipientAfter = await ethersProvider.getBalance(recipient);
  report.checks.signedTransfer = {
    hash: transferHash,
    status: transferReceipt.status,
    blockNumber: transferReceipt.blockNumber.toString(),
    recipientDeltaWei: (recipientAfter - recipientBefore).toString(),
  };
  if (
    transferReceipt.status !== "success" ||
    recipientAfter - recipientBefore !== 1n
  ) {
    throw new Error(
      "signed EVM transfer did not produce the expected balance delta"
    );
  }

  // Runtime: PUSH1 0, PUSH1 0, LOG0, STOP. The constructor returns it.
  const logEmitterInitCode = "0x6006600c60003960066000f360006000a000";
  const deployHash = await walletClient.sendTransaction({
    account,
    data: logEmitterInitCode,
  });
  const deployReceipt = await publicClient.waitForTransactionReceipt({
    hash: deployHash,
  });
  if (!deployReceipt.contractAddress)
    throw new Error("probe contract was not deployed");
  report.checks.contractDeployment = {
    hash: deployHash,
    address: deployReceipt.contractAddress,
    status: deployReceipt.status,
  };

  report.checks.feeHistory = {
    emptyBlock: await rpc("eth_feeHistory", ["0x1", "0x1", [10, 50, 90]]),
    recentBlocks: await rpc("eth_feeHistory", ["0x5", "latest", [10, 50, 90]]),
    configuredCap100: summarizeFeeHistory(
      await rpc("eth_feeHistory", ["0x64", "latest", [50]])
    ),
    overConfiguredCap101: summarizeFeeHistory(
      await rpc("eth_feeHistory", ["0x65", "latest", [50]])
    ),
  };
  report.checks.blockTags = await probeBlockTags(deployReceipt.contractAddress);

  const latestBlock = await publicClient.getBlock();
  report.checks.tracing = {
    traceTransactionDefault: summarize(
      await rpc("debug_traceTransaction", [transferHash, {}])
    ),
    traceTransactionCallTracer: summarize(
      await rpc("debug_traceTransaction", [
        transferHash,
        { tracer: "callTracer" },
      ])
    ),
    traceCall: summarize(
      await rpc("debug_traceCall", [
        {
          from: account.address,
          to: deployReceipt.contractAddress,
          data: "0x",
        },
        "latest",
        {},
      ])
    ),
    traceBlockByNumber: summarize(
      await rpc("debug_traceBlockByNumber", [
        `0x${transferReceipt.blockNumber.toString(16)}`,
        {},
      ])
    ),
    traceBlockByHash: summarize(
      await rpc("debug_traceBlockByHash", [latestBlock.hash, {}])
    ),
  };
  report.checks.webSocket = await probeSubscriptions(
    deployReceipt.contractAddress
  );
  report.checks.webSocketBrowserOrigin = await probeBrowserOriginPolicy();
  report.checks.finalBlock = (await publicClient.getBlockNumber()).toString();

  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (reportPath) await writeFile(reportPath, json, "utf8");
  process.stdout.write(json);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
