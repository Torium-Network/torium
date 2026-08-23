#!/usr/bin/env node

// Reviewed post-genesis deployment automation for the valueless public
// testnet. It consumes caller-provided RPC and signing configuration, requires
// an explicit environment and chain identity, deploys only the pinned
// generated artifacts, verifies runtime bytecode on chain, and emits a
// non-secret deployment record. It never contains, prints or stores a key.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  concatHex,
  createPublicClient,
  createWalletClient,
  encodeAbiParameters,
  getAddress,
  getContractAddress,
  getCreate2Address,
  http,
  keccak256,
  stringToHex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../.."
);

const { configPath, outputPath, broadcast } = parseArguments(
  process.argv.slice(2)
);
const rpcUrl = process.env.TORIUM_DEPLOY_RPC_URL;
assert.ok(rpcUrl, "TORIUM_DEPLOY_RPC_URL is required");

const config = JSON.parse(await readFile(configPath, "utf8"));
assert.equal(config.configVersion, "1.0.0");
assert.ok(
  typeof config.environment === "string" && config.environment.length >= 4,
  "config.environment is required"
);
assert.ok(
  Number.isSafeInteger(config.chain?.evmChainId),
  "config.chain.evmChainId is required"
);
assert.match(config.chain.genesisSha256, /^[0-9a-f]{64}$/u);
const deployerAddress = getAddress(config.authority.deployerAddress);

const registry = await readRepositoryJson("contracts/deployments/localnet.json");
const pinned = Object.fromEntries(
  registry.entries.map((entry) => [entry.id, entry])
);

const artifacts = {};
for (const id of [
  "torium-create2-factory",
  "attestation-registry",
  "reward-distributor",
]) {
  const entry = pinned[id];
  assert.ok(entry, `pinned registry entry ${id} is missing`);
  const artifactBytes = await readFile(
    path.join(repositoryRoot, entry.artifactPath)
  );
  assert.equal(
    sha256(artifactBytes),
    entry.artifactSha256,
    `${id} generated artifact differs from the pinned registry checksum`
  );
  const artifact = JSON.parse(artifactBytes.toString("utf8"));
  assert.equal(
    keccak256(artifact.bytecode.creation),
    entry.code.creationCodeKeccak256,
    `${id} creation code differs from the pinned registry hash`
  );
  artifacts[id] = { entry, artifact };
}

const transport = http(rpcUrl);
const publicClient = createPublicClient({ transport });
const observedChainId = await publicClient.getChainId();
assert.equal(
  observedChainId,
  config.chain.evmChainId,
  `RPC chain id ${observedChainId} does not match the configured environment`
);

let walletClient = null;
if (broadcast) {
  const keyFile = process.env.TORIUM_DEPLOY_KEY_FILE;
  assert.ok(keyFile, "TORIUM_DEPLOY_KEY_FILE is required with --broadcast");
  const keyText = (await readFile(keyFile, "utf8")).trim();
  assert.match(
    keyText,
    /^0x[0-9a-fA-F]{64}$/u,
    "the key file must contain a single 0x-prefixed 32-byte hex key"
  );
  const account = privateKeyToAccount(keyText);
  assert.equal(
    account.address,
    deployerAddress,
    "the signing key does not control the configured deployer address"
  );
  walletClient = createWalletClient({
    account,
    transport,
    chain: {
      id: config.chain.evmChainId,
      name: config.environment,
      nativeCurrency: { name: "Torium Test Token", symbol: "tTOR", decimals: 18 },
      rpcUrls: { default: { http: [rpcUrl] } },
    },
  });
}

const record = {
  environment: config.environment,
  chain: config.chain,
  deployerAddress,
  broadcast,
  contracts: {},
};

const factory = await deployFactory();
record.contracts["torium-create2-factory"] = factory;
record.contracts["attestation-registry"] = await deployViaFactory(
  "attestation-registry",
  factory.address
);
record.contracts["reward-distributor"] = await deployViaFactory(
  "reward-distributor",
  factory.address
);

const serialized = `${JSON.stringify(record, null, 2)}\n`;
if (outputPath) {
  await writeFile(outputPath, serialized);
}
process.stdout.write(serialized);

async function deployFactory() {
  const { entry, artifact } = artifacts["torium-create2-factory"];
  const predicted = getContractAddress({ from: deployerAddress, nonce: 0n });
  const existing = await publicClient.getCode({ address: predicted });
  if (existing && existing !== "0x") {
    assert.equal(
      keccak256(existing),
      entry.code.runtimeCodeKeccak256,
      "existing factory runtime code differs from the pinned hash"
    );
    return finished(predicted, entry, null, "reused-existing-runtime-code");
  }
  const nonce = await publicClient.getTransactionCount({
    address: deployerAddress,
  });
  assert.equal(
    nonce,
    0,
    "the factory address is empty but the deployer nonce is not zero; a new reviewed deployment plan is required"
  );
  if (!broadcast) {
    return planned(predicted, entry, "planned-deployer-create-nonce-0");
  }
  const hash = await walletClient.sendTransaction({
    data: artifact.bytecode.creation,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  assert.equal(receipt.status, "success", "factory deployment reverted");
  assert.equal(getAddress(receipt.contractAddress), predicted);
  await assertRuntimeCode(predicted, entry);
  return finished(predicted, entry, receipt, "deployed");
}

async function deployViaFactory(id, factoryAddress) {
  const { entry, artifact } = artifacts[id];
  const plan = config.deployments[id];
  assert.ok(plan, `deployment plan ${id} is missing from the configuration`);
  assert.equal(plan.strategy, "factory-create2");
  const salt = keccak256(stringToHex(plan.saltPreimage));
  const initCode = concatHex([
    artifact.bytecode.creation,
    encodeConstructorArguments(id, artifact, plan.constructorArguments),
  ]);
  const initCodeHash = keccak256(initCode);
  const predicted = getCreate2Address({
    from: factoryAddress,
    salt,
    bytecodeHash: initCodeHash,
  });
  const base = {
    salt,
    saltPreimage: plan.saltPreimage,
    initCodeHash,
    constructorArguments: plan.constructorArguments,
  };
  const existing = await publicClient.getCode({ address: predicted });
  if (existing && existing !== "0x") {
    assert.equal(
      keccak256(existing),
      entry.code.runtimeCodeKeccak256,
      `existing ${id} runtime code differs from the pinned hash`
    );
    return {
      ...finished(predicted, entry, null, "reused-existing-runtime-code"),
      ...base,
    };
  }
  if (!broadcast) {
    return { ...planned(predicted, entry, "planned-factory-create2"), ...base };
  }
  const { request } = await publicClient.simulateContract({
    account: walletClient.account,
    address: factoryAddress,
    abi: artifacts["torium-create2-factory"].artifact.abi,
    functionName: "deploy",
    args: [salt, initCode, entry.code.runtimeCodeKeccak256],
  });
  const hash = await walletClient.writeContract(request);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  assert.equal(receipt.status, "success", `${id} deployment reverted`);
  await assertRuntimeCode(predicted, entry);
  return { ...finished(predicted, entry, receipt, "deployed"), ...base };
}

function encodeConstructorArguments(id, artifact, configured) {
  const constructor = artifact.abi.find((item) => item.type === "constructor");
  const inputs = constructor?.inputs ?? [];
  if (inputs.length === 0) {
    assert.deepEqual(
      configured,
      [],
      `${id} takes no constructor arguments but the configuration provides some`
    );
    return "0x";
  }
  assert.ok(
    configured && typeof configured === "object" && !Array.isArray(configured),
    `${id} constructor arguments must be a name-keyed object`
  );
  assert.deepEqual(
    Object.keys(configured).sort(),
    inputs.map((input) => input.name).sort(),
    `${id} constructor argument names differ from the generated ABI`
  );
  const values = inputs.map((input) => {
    const value = configured[input.name];
    if (input.type === "address") {
      return getAddress(value);
    }
    assert.ok(
      Number.isSafeInteger(value) && value > 0,
      `${id} constructor argument ${input.name} must be a positive integer`
    );
    return BigInt(value);
  });
  return encodeAbiParameters(inputs, values);
}

async function assertRuntimeCode(address, entry) {
  const code = await publicClient.getCode({ address });
  assert.ok(code && code !== "0x", `no runtime code observed at ${address}`);
  assert.equal(
    keccak256(code),
    entry.code.runtimeCodeKeccak256,
    `observed runtime code at ${address} differs from the pinned hash`
  );
}

function finished(address, entry, receipt, status) {
  return {
    status,
    address,
    runtimeCodeKeccak256: entry.code.runtimeCodeKeccak256,
    creationCodeKeccak256: entry.code.creationCodeKeccak256,
    transactionHash: receipt ? receipt.transactionHash : null,
    blockNumber: receipt ? Number(receipt.blockNumber) : null,
  };
}

function planned(address, entry, status) {
  return {
    status,
    address,
    runtimeCodeKeccak256: entry.code.runtimeCodeKeccak256,
    creationCodeKeccak256: entry.code.creationCodeKeccak256,
    transactionHash: null,
    blockNumber: null,
  };
}

async function readRepositoryJson(relativePath) {
  return JSON.parse(
    await readFile(path.join(repositoryRoot, relativePath), "utf8")
  );
}

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

function parseArguments(argumentList) {
  let configPath = null;
  let outputPath = null;
  let broadcast = false;
  for (let index = 0; index < argumentList.length; index += 1) {
    const argument = argumentList[index];
    if (argument === "--config") {
      configPath = argumentList[index + 1];
      index += 1;
      continue;
    }
    if (argument === "--output") {
      outputPath = argumentList[index + 1];
      index += 1;
      continue;
    }
    if (argument === "--broadcast") {
      broadcast = true;
      continue;
    }
    throw new Error(`unsupported option ${argument}`);
  }
  if (!configPath) {
    throw new Error("--config <path> is required");
  }
  return { configPath, outputPath, broadcast };
}
