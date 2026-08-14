#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { ContractFactory, JsonRpcProvider, Wallet } from "ethers";
import { network } from "hardhat";
import solc from "solc";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  getAddress,
  http,
  parseAbi,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

const suiteDirectory = dirname(fileURLToPath(import.meta.url));
const root = resolve(suiteDirectory, "../../..");
const rpcURL = process.env.RPC_URL ?? "http://127.0.0.1:8545";
const manifest = JSON.parse(
  await readFile(resolve(root, "chain/genesis/localnet/manifest.json"), "utf8")
);
const sourcePath = resolve(suiteDirectory, "contracts/ToolingConformance.sol");
const source = await readFile(sourcePath, "utf8");
const artifactsDirectory = resolve(suiteDirectory, ".artifacts");
const reportPath =
  process.env.REPORT_PATH ?? resolve(artifactsDirectory, "latest-report.json");

const fixtureKey = `0x${createHash("sha256")
  .update("torium/localnet/valueless-fixture/v1/account/deployer")
  .digest("hex")}`;
const account = privateKeyToAccount(fixtureKey);
const deployer = manifest.development_accounts.find(
  ({ name }) => name === "deployer"
);
const recipient = manifest.development_accounts.find(
  ({ name }) => name === "sdk-user"
);
assert.ok(deployer && recipient, "canonical development fixtures are missing");
assert.equal(account.address.toLowerCase(), deployer.evm_address.toLowerCase());

const chain = defineChain({
  id: manifest.evm_chain_id,
  name: "Torium Localnet",
  nativeCurrency: { name: "Valueless Torium", symbol: "tTOR", decimals: 18 },
  rpcUrls: { default: { http: [rpcURL] } },
});
const publicClient = createPublicClient({ chain, transport: http(rpcURL) });
const walletClient = createWalletClient({
  account,
  chain,
  transport: http(rpcURL),
});
const ethersProvider = new JsonRpcProvider(rpcURL, manifest.evm_chain_id, {
  staticNetwork: true,
});
const ethersWallet = new Wallet(fixtureKey, ethersProvider);

function findImport(importPath) {
  try {
    return {
      contents: requireRead(
        resolve(suiteDirectory, "node_modules", importPath)
      ),
    };
  } catch (error) {
    return { error: `${importPath}: ${error.message}` };
  }
}

function requireRead(path) {
  return readFileSync(path, "utf8");
}

function compileContracts() {
  const input = {
    language: "Solidity",
    sources: {
      "contracts/ToolingConformance.sol": { content: source },
    },
    settings: {
      optimizer: { enabled: true, runs: 200 },
      outputSelection: {
        "*": {
          "*": ["abi", "evm.bytecode.object", "evm.deployedBytecode.object"],
        },
      },
    },
  };
  const output = JSON.parse(
    solc.compile(JSON.stringify(input), { import: findImport })
  );
  const errors = (output.errors ?? []).filter(
    ({ severity }) => severity === "error"
  );
  assert.deepEqual(
    errors,
    [],
    `Solidity compilation failed: ${JSON.stringify(errors)}`
  );
  return output.contracts["contracts/ToolingConformance.sol"];
}

const compiled = compileContracts();
const erc20 = compiled.ToriumERC20Probe;
const erc721 = compiled.ToriumERC721Probe;
const erc20Bytecode = `0x${erc20.evm.bytecode.object}`;
const erc721Bytecode = `0x${erc721.evm.bytecode.object}`;

assert.equal(await publicClient.getChainId(), manifest.evm_chain_id);
const ethersNetwork = await ethersProvider.getNetwork();
assert.equal(ethersNetwork.chainId, BigInt(manifest.evm_chain_id));

const erc20Hash = await walletClient.deployContract({
  account,
  abi: erc20.abi,
  bytecode: erc20Bytecode,
});
const erc20Receipt = await publicClient.waitForTransactionReceipt({
  hash: erc20Hash,
});
assert.equal(erc20Receipt.status, "success");
assert.ok(erc20Receipt.contractAddress);
const erc20Address = erc20Receipt.contractAddress;
assert.notEqual(
  await publicClient.getBytecode({ address: erc20Address }),
  "0x"
);

const erc20ReadABI = parseAbi([
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address,uint256) returns (bool)",
  "function alwaysReverts() pure",
]);
assert.equal(
  await publicClient.readContract({
    address: erc20Address,
    abi: erc20ReadABI,
    functionName: "name",
  }),
  "Torium Conformance Token"
);
assert.equal(
  await publicClient.readContract({
    address: erc20Address,
    abi: erc20ReadABI,
    functionName: "symbol",
  }),
  "TCT"
);
const deployerTokenBalance = await publicClient.readContract({
  address: erc20Address,
  abi: erc20ReadABI,
  functionName: "balanceOf",
  args: [account.address],
});
assert.equal(deployerTokenBalance, 1_000_000n * 10n ** 18n);
const { request: transferRequest } = await publicClient.simulateContract({
  account,
  address: erc20Address,
  abi: erc20ReadABI,
  functionName: "transfer",
  args: [getAddress(recipient.evm_address), 1n],
});
const estimatedTransferGas = await publicClient.estimateContractGas({
  account,
  address: erc20Address,
  abi: erc20ReadABI,
  functionName: "transfer",
  args: [getAddress(recipient.evm_address), 1n],
});
const estimatedTransferHash = await walletClient.writeContract({
  ...transferRequest,
  gas: estimatedTransferGas,
});
const estimatedTransferReceipt = await publicClient.waitForTransactionReceipt({
  hash: estimatedTransferHash,
});
const transferUsedHeadroom = estimatedTransferReceipt.status === "reverted";
const transferGasLimit = transferUsedHeadroom
  ? estimatedTransferGas * 2n > 250_000n
    ? estimatedTransferGas * 2n
    : 250_000n
  : estimatedTransferGas;
const transferHash = transferUsedHeadroom
  ? await walletClient.writeContract({
      ...transferRequest,
      gas: transferGasLimit,
    })
  : estimatedTransferHash;
const transferReceipt = transferUsedHeadroom
  ? await publicClient.waitForTransactionReceipt({ hash: transferHash })
  : estimatedTransferReceipt;
assert.equal(
  transferReceipt.status,
  "success",
  "ERC-20 transfer failed even with explicit gas headroom"
);
assert.ok(transferReceipt.logs.length > 0, "ERC-20 transfer emitted no log");
assert.equal(
  await publicClient.readContract({
    address: erc20Address,
    abi: erc20ReadABI,
    functionName: "balanceOf",
    args: [getAddress(recipient.evm_address)],
  }),
  1n
);

let revertObserved = false;
try {
  await publicClient.simulateContract({
    account,
    address: erc20Address,
    abi: erc20ReadABI,
    functionName: "alwaysReverts",
  });
} catch (error) {
  revertObserved = /TORIUM_EXPECTED_REVERT/u.test(
    error instanceof Error ? error.message : String(error)
  );
}
assert.equal(
  revertObserved,
  true,
  "expected Solidity revert reason was not returned"
);

const erc721Factory = new ContractFactory(
  erc721.abi,
  erc721Bytecode,
  ethersWallet
);
const erc721Contract = await erc721Factory.deploy({ gasLimit: 3_000_000 });
await erc721Contract.waitForDeployment();
const erc721Address = await erc721Contract.getAddress();
const mintTransaction = await erc721Contract.mint(recipient.evm_address, {
  gasLimit: 500_000,
});
const mintReceipt = await mintTransaction.wait();
assert.equal(mintReceipt.status, 1);
assert.ok(mintReceipt.logs.length > 0, "ERC-721 mint emitted no log");
assert.equal(
  getAddress(await erc721Contract.ownerOf(0n)),
  getAddress(recipient.evm_address)
);

const hardhat = await network.create({
  network: "toriumLocalnet",
  chainType: "l1",
});
let hardhatChainID;
try {
  hardhatChainID = await hardhat.provider.request({ method: "eth_chainId" });
  assert.equal(Number(BigInt(hardhatChainID)), manifest.evm_chain_id);
} finally {
  await hardhat.close();
}

const report = {
  schemaVersion: 1,
  result: "passed",
  generatedAt: new Date().toISOString(),
  network: {
    cosmosChainId: manifest.cosmos_chain_id,
    evmChainId: manifest.evm_chain_id,
    rpcURL,
  },
  clients: {
    viem: "2.55.2",
    ethers: "6.17.0",
    hardhat: "3.9.1",
    openZeppelinContracts: "5.4.0",
    solc: solc.version(),
  },
  checks: {
    viemChainId: manifest.evm_chain_id,
    ethersChainId: ethersNetwork.chainId.toString(),
    hardhatChainId: hardhatChainID,
    erc20: {
      address: erc20Address,
      deploymentHash: erc20Hash,
      transferHash,
      transferLogs: transferReceipt.logs.length,
      estimatedTransferGas: estimatedTransferGas.toString(),
      exactEstimateStatus: estimatedTransferReceipt.status,
      explicitGasHeadroomApplied: transferUsedHeadroom,
      submittedTransferGas: transferGasLimit.toString(),
      transferGasUsed: transferReceipt.gasUsed.toString(),
      revertReasonObserved: revertObserved,
    },
    erc721: {
      address: erc721Address,
      deploymentHash: erc721Contract.deploymentTransaction().hash,
      mintHash: mintTransaction.hash,
      mintLogs: mintReceipt.logs.length,
      token0Owner: getAddress(recipient.evm_address),
    },
  },
};

await mkdir(dirname(reportPath), { recursive: true });
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(JSON.stringify(report, null, 2));
