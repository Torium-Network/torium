#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageDirectory = join(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = join(packageDirectory, "../..");
const [protocol, wallet, chains] = await Promise.all([
  json("chain/config/protocol-v1.json"),
  import("../dist/esm/wallet.js"),
  import("../dist/esm/chains.js"),
]);

const capabilities = wallet.toriumTransactionCapabilities;
assert.equal(capabilities.baseline.cosmosEvm, "v0.7.0");
assert.equal(capabilities.baseline.viem, "2.55.2");
assert.equal(
  capabilities.replacement.activeLocalProfile.minimumFeeCapBumpPercent,
  protocol.mempool.priceBumpPercent
);
assert.equal(
  capabilities.replacement.activeLocalProfile.minimumTipCapBumpPercent,
  protocol.mempool.priceBumpPercent
);
assert.equal(
  protocol.mempool.replacementRule,
  "both-fee-cap-and-tip-cap-must-increase-by-at-least-price-bump"
);
assert.equal(
  capabilities.replacement.networkPropagationGuaranteed,
  protocol.mempool.networkWideReplacementGuaranteed
);
assert.equal(
  capabilities.submission.retentionGuaranteed,
  protocol.mempool.rpcAcceptanceGuaranteesRetention
);
assert.equal(
  wallet.toriumMaxTransactionGas,
  BigInt(protocol.consensus.transaction.maxGasWanted)
);
assert.equal(
  wallet.toriumMaxEncodedTransactionBytes,
  protocol.mempool.maximumEvmTransactionBytes
);
assert.equal(
  wallet.toriumMinimumBaseFeePerGas,
  BigInt(protocol.fees.minimumBaseFeeBaseUnitsPerGas)
);
assert.equal(
  wallet.toriumMinimumPriorityFeePerGas,
  BigInt(protocol.fees.minimumPriorityFeeBaseUnitsPerGas)
);

for (const chain of Object.values(chains.toriumChains)) {
  assert.equal(chain.supportsTransactionReplacementDetection, false);
}

console.log("Validated Torium wallet capabilities against protocol v1.");

async function json(relativePath) {
  return JSON.parse(await readFile(join(repositoryRoot, relativePath), "utf8"));
}
