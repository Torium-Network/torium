import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { custom } from "viem";

import { toriumLocalnet } from "../dist/esm/chains.js";
import { createToriumPublicClient } from "../dist/esm/clients.js";
import { isToriumSdkError } from "../dist/esm/errors.js";
import * as esm from "../dist/esm/index.js";
import { createToriumWalletClient } from "../dist/esm/wallet.js";

const require = createRequire(import.meta.url);
const cjs = require("../dist/cjs/index.js");

test("ESM and CommonJS expose the same stable root", () => {
  assert.deepEqual(Object.keys(esm).sort(), [
    "toriumSdkPolicyVersion",
    "toriumSdkVersion",
  ]);
  assert.deepEqual(Object.keys(cjs).sort(), Object.keys(esm).sort());
  assert.equal(esm.toriumSdkVersion, "0.1.0");
  assert.equal(cjs.toriumSdkPolicyVersion, "0.1.0");
});

test("every reserved ESM and CommonJS subpath resolves", async () => {
  const expectedExports = {
    chains: [
      "ToriumEndpointValidationError",
      "getToriumChain",
      "toriumChains",
      "toriumDevnet",
      "toriumLocalnet",
      "toriumMainnet",
      "toriumTestnet",
      "validateToriumEndpoint",
      "withToriumRpcUrls",
    ],
    clients: [
      "assertToriumFeeHistoryBlockCount",
      "createToriumLogRanges",
      "createToriumPublicClient",
      "getToriumStateQueryCapability",
      "toriumPublicActions",
      "toriumReadCapabilities",
    ],
    wallet: [
      "createToriumWalletClient",
      "normalizeToriumTransactionRequest",
      "preflightToriumTransaction",
      "sendToriumTransactionOnce",
      "toriumMaxEncodedTransactionBytes",
      "toriumMaxTransactionGas",
      "toriumMinimumBaseFeePerGas",
      "toriumMinimumPriorityFeePerGas",
      "toriumTransactionCapabilities",
      "waitForToriumTransaction",
    ],
    contracts: [
      "ToriumContractError",
      "computeToriumAttestationCommitment",
      "computeToriumAttestationId",
      "computeToriumAttestationReplayKey",
      "decodeToriumContractRevert",
      "extractToriumRevertData",
      "getToriumAttestation",
      "getToriumAttestationStatus",
      "getToriumRewardDistributorState",
      "getToriumRewardEpoch",
      "hashToriumAttestationUtf8",
      "hashToriumRewardLeaf",
      "hashToriumRewardNode",
      "isToriumAttestationActive",
      "isToriumRewardClaimed",
      "preflightToriumAttestation",
      "preflightToriumAttestationRevocation",
      "preflightToriumRewardClaim",
      "prepareToriumAttestation",
      "prepareToriumAttestationRevocation",
      "prepareToriumRewardClaim",
      "prepareToriumRewardClawback",
      "prepareToriumRewardEpochPublication",
      "processToriumRewardProof",
      "resolveToriumContractDeployment",
      "simulateToriumContractRequest",
      "toriumAttestationRegistryAbi",
      "toriumAttestationStatuses",
      "toriumContractAbis",
      "toriumContractNames",
      "toriumContractRegistryChainId",
      "toriumCreate2FactoryAbi",
      "toriumLocalnetContractRegistry",
      "toriumNativeAbi",
      "toriumRewardDistributorAbi",
      "toriumRewardDistributorRoles",
      "validateToriumAttestationPayload",
      "verifyToriumAttestation",
      "verifyToriumContractDeployment",
    ],
    errors: [
      "ToriumEndpointValidationError",
      "ToriumSdkError",
      "isToriumSdkError",
      "normalizeToriumError",
      "toriumErrorCategories",
    ],
    utils: [
      "assertToriumChainId",
      "assertToriumUint256",
      "atoriumPerDisplayUnit",
      "formatToriumAmount",
      "formatToriumBaseUnits",
      "getToriumChainById",
      "getToriumNativeCurrency",
      "isToriumAccountAddress",
      "isToriumChainId",
      "isToriumEvmAddress",
      "isToriumHash",
      "isToriumHexData",
      "normalizeToriumBlockReference",
      "normalizeToriumEvmAddress",
      "normalizeToriumHash",
      "normalizeToriumHexData",
      "parseToriumAmount",
      "parseToriumBaseUnits",
      "parseToriumJson",
      "stringifyToriumJson",
      "toriumBaseDenom",
      "toriumBech32AddressToEvm",
      "toriumEvmAddressToBech32",
      "toriumMaxUint256",
      "toriumNativeCurrencies",
      "toriumNativeDecimals",
    ],
    experimental: [],
  };
  for (const subpath of [
    "chains",
    "clients",
    "wallet",
    "contracts",
    "errors",
    "utils",
    "experimental",
  ]) {
    assert.deepEqual(
      Object.keys(await import(`../dist/esm/${subpath}.js`)).sort(),
      expectedExports[subpath].toSorted()
    );
    assert.deepEqual(
      Object.keys(require(`../dist/cjs/${subpath}.js`)).sort(),
      expectedExports[subpath].toSorted()
    );
  }
});

test("Torium clients preserve caller-owned viem transports", async () => {
  const calls = [];
  const provider = {
    async request({ method }) {
      calls.push(method);
      if (method === "eth_blockNumber") return "0x2a";
      if (method === "eth_accounts") {
        return ["0x0000000000000000000000000000000000000001"];
      }
      throw new Error(`Unexpected method: ${method}`);
    },
  };

  const publicClient = createToriumPublicClient({
    chain: toriumLocalnet,
    transport: custom(provider),
  });
  const walletClient = createToriumWalletClient({
    chain: toriumLocalnet,
    transport: custom(provider),
  });

  assert.equal(await publicClient.getBlockNumber(), 42n);
  assert.deepEqual(await walletClient.getAddresses(), [
    "0x0000000000000000000000000000000000000001",
  ]);
  assert.deepEqual(calls, ["eth_blockNumber", "eth_accounts"]);
});

test("direct viem action failures are not wrapped as Torium SDK errors", async () => {
  const publicClient = createToriumPublicClient({
    chain: toriumLocalnet,
    transport: custom(
      {
        async request() {
          throw new Error("caller-owned transport failure");
        },
      },
      { retryCount: 0 }
    ),
  });

  await assert.rejects(
    publicClient.getBalance({
      address: "0x0000000000000000000000000000000000000001",
    }),
    (error) => {
      assert.equal(isToriumSdkError(error), false);
      return true;
    }
  );
});
