import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { encodeDeployData } from "viem";

import {
  resolveToriumContractDeployment,
  toriumAttestationRegistryAbi,
  toriumLocalnetContractRegistry,
  toriumRewardDistributorAbi,
  verifyToriumContractDeployment,
} from "@torium-network/sdk/contracts";

import {
  deployer,
  publicClient,
  recordCapability,
  submitAndCommit,
  testUser,
} from "./_setup.mjs";
import { state } from "./_state.mjs";

const repoRoot = process.env.TORIUM_CONFORMANCE_REPO_ROOT;
assert.ok(repoRoot, "TORIUM_CONFORMANCE_REPO_ROOT must point at the checkout");

async function creationBytecode(contractName) {
  const artifact = JSON.parse(
    await readFile(
      path.join(repoRoot, `contracts/generated/abi/${contractName}.json`),
      "utf8"
    )
  );
  return artifact.bytecode.creation;
}

test("the attestation registry deploys from generated creation bytecode", async () => {
  const lifecycle = await submitAndCommit(deployer, {
    to: null,
    data: await creationBytecode("ToriumAttestationRegistry"),
  });
  const address = lifecycle.receipt.contractAddress;
  assert.ok(address, "deployment receipt must carry a contract address");
  state.attestationRegistry = address;
  await recordCapability("torium.contracts.deploy", "eth_sendRawTransaction");
});

test("the reward distributor deploys with constructor arguments", async () => {
  const data = encodeDeployData({
    abi: toriumRewardDistributorAbi,
    bytecode: await creationBytecode("ToriumRewardDistributor"),
    args: [
      3600,
      deployer.address,
      deployer.address,
      deployer.address,
      deployer.address,
      testUser.address,
      1n,
      1n,
    ],
  });
  const lifecycle = await submitAndCommit(deployer, { to: null, data });
  const address = lifecycle.receipt.contractAddress;
  assert.ok(address, "deployment receipt must carry a contract address");
  state.rewardDistributor = address;
  await recordCapability(
    "torium.contracts.deploy-with-constructor",
    "eth_sendRawTransaction"
  );
});

test("deployed runtime bytecode matches the pinned registry hashes", async () => {
  const reads = publicClient();
  for (const [contractName, address] of [
    ["toriumAttestationRegistry", state.attestationRegistry],
    ["toriumRewardDistributor", state.rewardDistributor],
  ]) {
    const deployment = resolveToriumContractDeployment(contractName, {
      deployment: { address },
    });
    assert.equal(
      deployment.runtimeCodeKeccak256,
      toriumLocalnetContractRegistry.contracts[contractName]
        .runtimeCodeKeccak256
    );
    const verified = await verifyToriumContractDeployment(reads, deployment);
    assert.equal(verified.runtimeCodeKeccak256, deployment.runtimeCodeKeccak256);
  }
  await recordCapability(
    "torium.contracts.bytecode-verification",
    "eth_getCode"
  );
});

test("wrong deployments fail closed against the live chain", async () => {
  const reads = publicClient();
  const wrongTarget = resolveToriumContractDeployment(
    "toriumRewardDistributor",
    { deployment: { address: state.attestationRegistry } }
  );
  await assert.rejects(
    verifyToriumContractDeployment(reads, wrongTarget),
    (error) => error.code === "TORIUM_CONTRACT_CODE_MISMATCH"
  );
  const emptyTarget = resolveToriumContractDeployment(
    "toriumRewardDistributor",
    { deployment: { address: "0x00000000000000000000000000000000000000ff" } }
  );
  await assert.rejects(
    verifyToriumContractDeployment(reads, emptyTarget),
    (error) => error.code === "TORIUM_CONTRACT_CODE_MISSING"
  );
  await recordCapability(
    "torium.contracts.wrong-deployment-guard",
    "eth_getCode"
  );
});

test("typed contract reads work through the packed ABI exports", async () => {
  const reads = publicClient();
  const count = await reads.readContract({
    address: state.attestationRegistry,
    abi: toriumAttestationRegistryAbi,
    functionName: "attestationCount",
  });
  assert.equal(count, 0n);
  await recordCapability("torium.contracts.typed-read", "eth_call");
});
