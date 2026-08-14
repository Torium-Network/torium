import { writeFile } from "node:fs/promises";

import { network } from "hardhat";

const expectedChainId = "0x40000";
const connection = await network.create({
  network: "cosmosEvm",
  chainType: "l1",
});

try {
  const chainId = await connection.provider.request({ method: "eth_chainId" });
  const blockNumber = await connection.provider.request({
    method: "eth_blockNumber",
  });
  const feeHistory = await connection.provider.request({
    method: "eth_feeHistory",
    params: ["0x2", "latest", [50]],
  });

  if (chainId !== expectedChainId) {
    throw new Error(
      `Hardhat connected to ${chainId}, expected ${expectedChainId}`
    );
  }

  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    hardhat: "3.9.1",
    network: connection.networkName,
    chainType: connection.chainType,
    chainId,
    blockNumber,
    feeHistoryOldestBlock: feeHistory.oldestBlock,
  };
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  if (process.env.REPORT_PATH) {
    await writeFile(process.env.REPORT_PATH, serialized);
  }
  process.stdout.write(serialized);
} finally {
  await connection.close();
}
