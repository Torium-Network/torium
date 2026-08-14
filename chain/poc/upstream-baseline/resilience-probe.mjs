import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";

import WebSocket from "ws";

const rpcUrl = process.env.RPC_URL ?? "http://127.0.0.1:8545";
const wsUrl = process.env.WS_URL ?? "ws://127.0.0.1:8546";
const container = process.env.RESTART_CONTAINER ?? "evmdnode0";
const reportPath = process.env.REPORT_PATH;

async function rpc(method, params = []) {
  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const payload = await response.json();
  if (payload.error) throw new Error(`${method}: ${payload.error.message}`);
  return payload.result;
}

async function waitForRpc(minimumBlock = 0n) {
  for (let attempt = 0; attempt < 90; attempt += 1) {
    try {
      const block = BigInt(await rpc("eth_blockNumber"));
      if (block >= minimumBlock) return block;
    } catch {
      // Restart closes HTTP before the container is ready again.
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error("RPC did not recover within 90 seconds");
}

async function subscribeForHead({ restartAfterHead = false } = {}) {
  const socket = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  socket.send(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_subscribe",
      params: ["newHeads"],
    })
  );

  return await new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("newHeads timeout")),
      30_000
    );
    let head;
    let restarted = false;
    socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.method !== "eth_subscription") return;
      head = message.params.result;
      if (!restartAfterHead) {
        clearTimeout(timeout);
        socket.close();
        resolve({ head, disconnected: false });
        return;
      }
      if (!restarted) {
        restarted = true;
        const child = spawn("docker", ["restart", container], {
          stdio: ["ignore", "pipe", "pipe"],
        });
        child.once("error", reject);
      }
    });
    socket.once("close", () => {
      if (!restartAfterHead || !head) return;
      clearTimeout(timeout);
      resolve({ head, disconnected: true });
    });
    socket.once("error", (error) => {
      // A transport error followed by close is expected during restart.
      if (!restartAfterHead) reject(error);
    });
  });
}

async function main() {
  const before = await waitForRpc(1n);
  const first = await subscribeForHead({ restartAfterHead: true });
  if (!first.disconnected)
    throw new Error("node restart did not close the WS connection");

  const firstHeight = BigInt(first.head.number);
  const recoveredAt = await waitForRpc(firstHeight);
  const second = await subscribeForHead();
  const secondHeight = BigInt(second.head.number);

  const backfill = [];
  for (let height = firstHeight + 1n; height <= secondHeight; height += 1n) {
    const block = await rpc("eth_getBlockByNumber", [
      `0x${height.toString(16)}`,
      false,
    ]);
    backfill.push({ number: block.number, hash: block.hash });
  }

  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    target: { rpcUrl, wsUrl, container },
    beforeRestartBlock: before.toString(),
    lastPreRestartHead: firstHeight.toString(),
    connectionClosedOnRestart: first.disconnected,
    rpcRecoveredAtBlock: recoveredAt.toString(),
    firstPostRestartHead: secondHeight.toString(),
    httpBackfill: backfill,
  };
  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (reportPath) await writeFile(reportPath, json, "utf8");
  process.stdout.write(json);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
