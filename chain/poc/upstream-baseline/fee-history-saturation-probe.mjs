import { writeFile } from "node:fs/promises";

import { createPublicClient, defineChain, http, parseGwei } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const rpcUrl = process.env.RPC_URL ?? "http://127.0.0.1:8545";
const reportPath = process.env.REPORT_PATH;
const chainId = Number(process.env.EVM_CHAIN_ID ?? "262144");
const expectedGasLimit = BigInt(process.env.EXPECTED_BLOCK_GAS ?? "42000");

// Public, deterministic account embedded in the upstream v0.7.0 testnet.
// It is a disposable fixture and must never be used on a public network.
const sender = privateKeyToAccount(
  process.env.PROBE_PRIVATE_KEY ??
    "0x88cbead91aee890d27bf06e003ade3d4e952427e88f88d31d61d3ef5e5d54305"
);
const recipient =
  process.env.PROBE_RECIPIENT ?? "0x963EBDf2e1f8DB8707D05FC75bfeFFBa1B5BaC17";

const chain = defineChain({
  id: chainId,
  name: "Cosmos EVM v0.7.0 bounded-gas probe",
  nativeCurrency: { name: "atest", symbol: "ATEST", decimals: 18 },
  rpcUrls: { default: { http: [rpcUrl] } },
});
const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });

async function waitForNextBlock() {
  const initial = await publicClient.getBlockNumber();
  for (let attempt = 0; attempt < 120; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    const current = await publicClient.getBlockNumber();
    if (current > initial) return current;
  }
  throw new Error("bounded-gas probe did not observe a fresh block");
}

async function sign(nonce, value) {
  return await sender.signTransaction({
    chainId,
    type: "eip1559",
    nonce,
    gas: 21_000n,
    to: recipient,
    value,
    maxFeePerGas: parseGwei("2"),
    maxPriorityFeePerGas: parseGwei("0.2"),
  });
}

const freshBlock = await waitForNextBlock();
const nonce = await publicClient.getTransactionCount({
  address: sender.address,
  blockTag: "pending",
});
const rawTransactions = await Promise.all([
  sign(nonce, 1n),
  sign(nonce + 1, 2n),
]);
const hashes = await Promise.all(
  rawTransactions.map((serializedTransaction) =>
    publicClient.sendRawTransaction({ serializedTransaction })
  )
);
const receipts = await Promise.all(
  hashes.map((hash) =>
    publicClient.waitForTransactionReceipt({ hash, timeout: 60_000 })
  )
);

const [firstReceipt, secondReceipt] = receipts;
if (!firstReceipt || !secondReceipt) {
  throw new Error("missing bounded-gas transaction receipt");
}
if (firstReceipt.status !== "success" || secondReceipt.status !== "success") {
  throw new Error("bounded-gas transactions did not both succeed");
}
if (firstReceipt.blockNumber !== secondReceipt.blockNumber) {
  throw new Error(
    `transactions landed in different blocks: ${firstReceipt.blockNumber} and ${secondReceipt.blockNumber}`
  );
}

const block = await publicClient.getBlock({
  blockNumber: firstReceipt.blockNumber,
});
const feeHistory = await publicClient.request({
  method: "eth_feeHistory",
  params: ["0x1", `0x${block.number.toString(16)}`, [50]],
});
const gasUsedRatio = feeHistory.gasUsedRatio[0];
if (block.gasLimit !== expectedGasLimit) {
  throw new Error(
    `block gas limit ${block.gasLimit} did not match ${expectedGasLimit}`
  );
}
if (block.gasUsed !== expectedGasLimit || gasUsedRatio !== 1) {
  throw new Error(
    `expected a saturated block, received gasUsed=${block.gasUsed} ratio=${gasUsedRatio}`
  );
}

const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  target: {
    rpcUrl,
    chainId,
    profile: "poc-bounded-block-gas",
    configuredMaxGas: expectedGasLimit.toString(),
  },
  checks: {
    freshBlock: freshBlock.toString(),
    transactionHashes: hashes,
    saturatedBlock: {
      number: block.number.toString(),
      gasLimit: block.gasLimit.toString(),
      gasUsed: block.gasUsed.toString(),
      transactionCount: block.transactions.length,
    },
    feeHistory: {
      oldestBlock: feeHistory.oldestBlock,
      gasUsedRatio,
      baseFeePerGas: feeHistory.baseFeePerGas,
      reward: feeHistory.reward,
    },
  },
};
const serialized = `${JSON.stringify(report, null, 2)}\n`;
if (reportPath) await writeFile(reportPath, serialized);
process.stdout.write(serialized);
