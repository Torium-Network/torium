import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const exampleRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
const repositoryRoot = path.resolve(exampleRoot, "../..");
const packageJson = await readJson(path.join(exampleRoot, "package.json"));
const compatibility = await readJson(
  path.join(exampleRoot, "compatibility.json")
);
const runtimeMatrix = await readJson(
  path.join(exampleRoot, "runtime-matrix.json")
);
const sdkPackage = await readJson(
  path.join(repositoryRoot, "packages/torium-sdk/package.json")
);
const exampleRequire = createRequire(path.join(exampleRoot, "package.json"));
const nativeRequire = exampleRequire;
const expoMetroRequire = createRequire(
  nativeRequire.resolve("expo/metro-config")
);
const vitePackage = await readJson(exampleRequire.resolve("vite/package.json"));
const expoPackage = await readJson(nativeRequire.resolve("expo/package.json"));
const reactNativePackage = await readJson(
  nativeRequire.resolve("react-native/package.json")
);
const metroPackage = await readJson(
  expoMetroRequire.resolve("metro/package.json")
);
const toolchain = await readJson(
  path.join(repositoryRoot, "chain/toolchain.json")
);
const identifiers = await readJson(
  path.join(repositoryRoot, "chain/config/identifiers.json")
);
const sdkPolicy = await readJson(
  path.join(repositoryRoot, "chain/config/sdk-policy-v0.json")
);

assert.equal(
  packageJson.dependencies["@torium-network/sdk"],
  `workspace:${sdkPackage.version}`
);
assert.equal(sdkPackage.version, compatibility.sdk.version);
assert.equal(packageJson.version, compatibility.sdk.version);
assert.equal(packageJson.dependencies.viem, sdkPackage.devDependencies.viem);
assert.equal(packageJson.dependencies.viem, compatibility.tooling.viem);
assert.equal(
  packageJson.devDependencies.hardhat,
  toolchain.contracts.hardhat.version
);
assert.equal(
  packageJson.devDependencies.hardhat,
  compatibility.tooling.hardhat
);
assert.equal(
  toolchain.contracts.foundry.version,
  compatibility.tooling.foundry
);
assert.equal(
  toolchain.contracts.solidity.version,
  compatibility.tooling.solidity
);
assert.equal(sdkPolicy.package.name, compatibility.sdk.package);
assert.equal(sdkPolicy.policyVersion, compatibility.sdk.policyVersion);
assert.equal(
  sdkPolicy.runtimes.node.canonicalTestVersion,
  compatibility.tooling.node
);
const localnet = identifiers.networks.find(
  (network) => network.environment === compatibility.chain.environment
);
assert.ok(localnet, "canonical localnet identifiers are missing");
assert.equal(identifiers.manifestVersion, compatibility.chain.manifestVersion);
assert.equal(localnet.cosmos.chainId, compatibility.chain.cosmosChainId);
assert.equal(localnet.evm.chainId, compatibility.chain.evmChainId);
assert.equal(runtimeMatrix.sdkVersion, sdkPackage.version);
assert.equal(runtimeMatrix.node.supportedRange, sdkPolicy.runtimes.node.range);
assert.equal(runtimeMatrix.browser.builder, `vite@${vitePackage.version}`);
assert.equal(compatibility.tooling.vite, vitePackage.version);
assert.equal(runtimeMatrix.reactNative.expoVersion, expoPackage.version);
assert.equal(compatibility.tooling.expo, expoPackage.version);
assert.equal(
  runtimeMatrix.reactNative.reactNativeVersion,
  reactNativePackage.version
);
assert.equal(compatibility.tooling.reactNative, reactNativePackage.version);
assert.equal(runtimeMatrix.reactNative.metroVersion, metroPackage.version);
assert.equal(compatibility.tooling.metro, metroPackage.version);
assert.equal(
  runtimeMatrix.reactNative.bytecodeVersion,
  compatibility.tooling.hermesBytecodeVersion
);
assert.equal(
  runtimeMatrix.browser.maximumJavaScriptBytes,
  sdkPolicy.budgets.browserExampleJavaScriptBytes
);
assert.equal(
  runtimeMatrix.browser.maximumGzipBytes,
  sdkPolicy.budgets.browserExampleGzipBytes
);
assert.equal(
  runtimeMatrix.reactNative.maximumBytecodeBytes,
  sdkPolicy.budgets.reactNativeHermesBytecodeBytes
);
assert.equal(
  runtimeMatrix.reactNative.maximumSourceModules,
  sdkPolicy.budgets.reactNativeSourceModules
);

const requiredFiles = [
  "README.md",
  "browser/README.md",
  "browser/index.html",
  "browser/main.ts",
  "compatibility.json",
  "node/README.md",
  "node/cli.ts",
  "node/confirm.ts",
  "react-native/README.md",
  "react-native/compatibility.ts",
  "react-native/metro.runtime.config.cjs",
  "react-native/runtime-entry.ts",
  "runtime-matrix.json",
  "scripts/validate-browser-runtime.mjs",
  "scripts/verify-hermes-runtime.mjs",
  "shared/config.ts",
  "solidity/README.md",
  "solidity/contracts/Counter.sol",
  "solidity/foundry/foundry.toml",
  "solidity/foundry/run-localnet.sh",
  "solidity/hardhat/deploy-and-call.ts",
  "solidity/hardhat/hardhat.config.ts",
];
const sourceFiles = await walk(exampleRoot);
for (const relativeFile of requiredFiles) {
  assert.ok(sourceFiles.includes(relativeFile), `missing ${relativeFile}`);
}

for (const relativeFile of sourceFiles) {
  const contents = await readFile(path.join(exampleRoot, relativeFile), "utf8");
  assert.doesNotMatch(
    contents,
    /(?:from|import\()\s*["'][^"']*(?:packages\/torium-sdk|chain\/)/u,
    `${relativeFile} imports a monorepo-internal runtime path`
  );
  assert.doesNotMatch(
    contents,
    /https?:\/\/(?:rpc\.|api\.)?torium\.network/iu,
    `${relativeFile} includes an unpublished Torium production endpoint`
  );
  if (!relativeFile.endsWith("validate-examples.mjs")) {
    assert.doesNotMatch(
      contents,
      /0x[0-9a-f]{64}/iu,
      `${relativeFile} includes key-shaped literal data`
    );
  }
}

const nodeSource = await readFile(
  path.join(exampleRoot, "node/cli.ts"),
  "utf8"
);
for (const command of ["status", "balance", "transfer", "receipt"]) {
  assert.match(nodeSource, new RegExp(`case ["']${command}["']`, "u"));
}
assert.match(nodeSource, /assertToriumExampleChain\(publicClient\)/u);
assert.match(nodeSource, /sendToriumTransactionOnce/u);
assert.match(nodeSource, /waitForToriumTransaction/u);
assert.match(nodeSource, /confirmToriumPreflight/u);

const browserSource = await readFile(
  path.join(exampleRoot, "browser/main.ts"),
  "utf8"
);
assert.match(browserSource, /EIP1193Provider/u);
assert.match(browserSource, /assertToriumExampleChain\(publicClient\)/u);
assert.doesNotMatch(browserSource, /wallet_(?:add|switch)EthereumChain/u);

const foundrySource = await readFile(
  path.join(exampleRoot, "solidity/foundry/run-localnet.sh"),
  "utf8"
);
assert.match(foundrySource, /expected_chain_id=1414484556/u);
assert.match(foundrySource, /cast chain-id/u);
assert.match(foundrySource, /actual_chain_id.*expected_chain_id/u);

console.log(
  `Validated ${sourceFiles.length} Torium example files against SDK ${sdkPackage.version}.`
);

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

async function walk(directory, prefix = "") {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (
      ["artifacts", "cache", "dist", "node_modules", "out"].includes(entry.name)
    ) {
      continue;
    }
    const relative = path.join(prefix, entry.name);
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(absolute, relative)));
    else files.push(relative);
  }
  return files.sort();
}
