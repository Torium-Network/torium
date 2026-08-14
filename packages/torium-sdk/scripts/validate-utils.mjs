#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageDirectory = join(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = join(packageDirectory, "../..");
const [identifiers, protocol, utilities] = await Promise.all([
  json("chain/config/identifiers.json"),
  json("chain/config/protocol-v1.json"),
  import("../dist/esm/utils.js"),
]);

assert.equal(utilities.toriumNativeDecimals, identifiers.currency.decimals);
assert.equal(utilities.toriumNativeDecimals, protocol.nativeAsset.decimals);
assert.equal(utilities.toriumBaseDenom, identifiers.currency.baseDenom);
assert.equal(utilities.toriumBaseDenom, protocol.nativeAsset.baseDenom);
assert.equal(
  utilities.atoriumPerDisplayUnit.toString(),
  protocol.nativeAsset.oneDisplayUnitInBaseUnits
);

for (const network of identifiers.networks) {
  const metadata = utilities.getToriumNativeCurrency(network.environment);
  assert.equal(metadata.environment, network.environment);
  assert.equal(metadata.symbol, network.nativeCurrencySymbol);
  assert.equal(metadata.decimals, identifiers.currency.decimals);
  assert.equal(metadata.baseDenom, identifiers.currency.baseDenom);
  assert.equal(
    utilities.assertToriumChainId(network.evm.chainId),
    network.evm.chainId
  );
  assert.equal(
    utilities.getToriumChainById(network.evm.chainId).torium.environment,
    network.environment
  );
  assert.equal(
    metadata.valueStatus,
    network.environment === "mainnet"
      ? "inactive-prelaunch-no-value-claim"
      : "valueless-test-token"
  );
}

for (const vector of protocol.accounts.testVectors) {
  assert.equal(utilities.normalizeToriumEvmAddress(vector.hex), vector.hex);
  assert.equal(
    utilities.toriumEvmAddressToBech32(vector.hex),
    vector.bech32Account
  );
  assert.equal(
    utilities.toriumBech32AddressToEvm(vector.bech32Account),
    vector.hex
  );
}

assert.equal(utilities.isToriumChainId(262144), false);
assert.equal(utilities.parseToriumAmount("1"), utilities.atoriumPerDisplayUnit);
assert.equal(
  utilities.formatToriumAmount(utilities.atoriumPerDisplayUnit),
  "1"
);

console.log(
  "Validated Torium SDK utilities against canonical protocol inputs."
);

async function json(relativePath) {
  return JSON.parse(await readFile(join(repositoryRoot, relativePath), "utf8"));
}
