#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const suiteDirectory = dirname(fileURLToPath(import.meta.url));
const root = resolve(suiteDirectory, "../../..");
const packageJSON = JSON.parse(
  await readFile(resolve(suiteDirectory, "package.json"), "utf8")
);
const packageLock = JSON.parse(
  await readFile(resolve(suiteDirectory, "package-lock.json"), "utf8")
);
const toolchain = JSON.parse(
  await readFile(resolve(root, "chain/toolchain.json"), "utf8")
);
const manifest = JSON.parse(
  await readFile(resolve(root, "chain/genesis/localnet/manifest.json"), "utf8")
);
const identifiers = JSON.parse(
  await readFile(resolve(root, "chain/config/identifiers.json"), "utf8")
);
const contract = await readFile(
  resolve(suiteDirectory, "contracts/ToolingConformance.sol"),
  "utf8"
);
const metamaskProbe = await readFile(
  resolve(root, "chain/poc/upstream-baseline/metamask-probe.mjs"),
  "utf8"
);

for (const [name, version] of Object.entries({
  ethers: "6.17.0",
  viem: "2.55.2",
  hardhat: toolchain.contracts.hardhat.version,
  solc: toolchain.contracts.solidity.version,
  "@openzeppelin/contracts": "5.4.0",
})) {
  assert.equal(
    packageJSON.dependencies?.[name] ?? packageJSON.devDependencies?.[name],
    version,
    `${name} must remain exactly pinned`
  );
  assert.equal(
    packageLock.packages[""].dependencies?.[name] ??
      packageLock.packages[""].devDependencies?.[name],
    version,
    `${name} package-lock pin differs`
  );
}

const localnet = identifiers.networks.find(
  ({ environment }) => environment === "localnet"
);
assert.ok(localnet, "canonical localnet identifier is missing");
assert.equal(manifest.evm_chain_id, localnet.evm.chainId);
assert.equal(localnet.cosmos.chainId, "torium-localnet-1");
assert.match(contract, /pragma solidity 0\.8\.30;/u);
assert.match(contract, /@openzeppelin\/contracts\/token\/ERC20/u);
assert.match(contract, /@openzeppelin\/contracts\/token\/ERC721/u);
assert.match(contract, /TORIUM_EXPECTED_REVERT/u);
for (const configuration of [
  "EVM_CHAIN_ID",
  "TORIUM_NETWORK_NAME",
  "NATIVE_CURRENCY_NAME",
  "NATIVE_CURRENCY_SYMBOL",
  "RPC_DISPLAY_NAME",
  "FAUCET_URL",
]) {
  assert.match(
    metamaskProbe,
    new RegExp(`process\\.env\\.${configuration}`, "u"),
    `MetaMask probe must consume ${configuration}`
  );
}

console.log(
  `tooling pins valid: viem ${packageJSON.dependencies.viem}, ethers ${packageJSON.dependencies.ethers}, Hardhat ${packageJSON.devDependencies.hardhat}, OpenZeppelin ${packageJSON.dependencies["@openzeppelin/contracts"]}`
);
