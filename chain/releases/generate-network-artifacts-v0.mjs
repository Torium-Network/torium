#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const directory = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(directory, "../..");
const rootRequire = createRequire(path.join(root, "package.json"));
const Ajv2020 = rootRequire("ajv/dist/2020").default;
const outputPath = path.join(directory, "network-artifacts-v0.json");
const checksumsPath = path.join(directory, "SHA256SUMS");
const generatorPath = fileURLToPath(import.meta.url);
const readmePath = path.join(directory, "README.md");
const schemaPath = path.join(directory, "network-artifacts-v0.schema.json");

const sourcePaths = {
  identifiers: "chain/config/identifiers.json",
  identifierAvailability: "chain/config/identifier-availability.json",
  protocol: "chain/config/protocol-v1.json",
  genesis: "chain/genesis/localnet/genesis.json",
  genesisManifest: "chain/genesis/localnet/manifest.json",
  testnetGenesisManifest: "chain/genesis/testnet/manifest.json",
  recovery: "chain/recovery/recovery-v0.json",
  governance: "chain/config/governance-v1.json",
  nodeRoles: "chain/profiles/node-roles-v0.json",
  sdk: "packages/torium-sdk/package.json",
  contracts: "contracts/deployments/localnet.json",
  explorerSelection: "chain/explorer/selection-v1.json",
  explorerStack: "chain/explorer/stack-v0.json",
};

const entries = Object.fromEntries(
  await Promise.all(
    Object.entries(sourcePaths).map(async ([id, relativePath]) => {
      const bytes = await readFile(path.join(root, relativePath));
      return [id, { relativePath, bytes, value: JSON.parse(bytes) }];
    })
  )
);
const schemaBytes = await readFile(schemaPath);
const schema = JSON.parse(schemaBytes);
const artifact = buildArtifact();
const serialized = `${JSON.stringify(artifact, null, 2)}\n`;
const checksumFiles = [
  ["README.md", await readFile(readmePath)],
  ["generate-network-artifacts-v0.mjs", await readFile(generatorPath)],
  ["network-artifacts-v0.json", serialized],
  ["network-artifacts-v0.schema.json", schemaBytes],
];
const checksums = checksumFiles
  .map(([name, bytes]) => `${sha256(bytes)}  ${name}`)
  .join("\n")
  .concat("\n");

const validate = new Ajv2020({ strict: true, allErrors: true }).compile(schema);
assert.equal(
  validate(artifact),
  true,
  `network artifact schema validation failed: ${JSON.stringify(validate.errors)}`
);
assertSemantics(artifact);

const [argument = "--check", ...extraArguments] = process.argv.slice(2);
assert.deepEqual(extraArguments, [], "only one option is supported");
if (argument === "--write") {
  await writeFile(outputPath, serialized);
  await writeFile(checksumsPath, checksums);
  console.log("network artifacts v0 generated");
} else if (argument === "--check") {
  assert.equal(await readFile(outputPath, "utf8"), serialized);
  assert.equal(await readFile(checksumsPath, "utf8"), checksums);
  console.log("network artifacts v0 are current");
} else {
  throw new Error(`unsupported option ${argument}`);
}

function buildArtifact() {
  const identifiers = entries.identifiers.value;
  const genesisManifest = entries.genesisManifest.value;
  const recovery = entries.recovery.value;
  const governance = entries.governance.value;
  const nodeRoles = entries.nodeRoles.value;
  const sdk = entries.sdk.value;
  const contracts = entries.contracts.value;
  const explorerSelection = entries.explorerSelection.value;
  const explorerStack = entries.explorerStack.value;
  const protocol = entries.protocol.value;
  const localnet = network("localnet");
  const testnetManifest = entries.testnetGenesisManifest.value;
  const testnet = network("testnet");

  assert.equal(sha256(entries.genesis.bytes), genesisManifest.genesis_sha256);
  assert.equal(contracts.chain.genesisSha256, genesisManifest.genesis_sha256);
  assert.equal(testnetManifest.cosmos_chain_id, testnet.cosmos.chainId);
  assert.equal(testnetManifest.evm_chain_id, testnet.evm.chainId);

  return {
    $schema: "./network-artifacts-v0.schema.json",
    schemaVersion: 1,
    bundleVersion: "0.2.0-testnet.1",
    status: "generated-localnet-bundle-and-live-testnet-record",
    ownerIssue: 123,
    generatedBy:
      "node chain/releases/generate-network-artifacts-v0.mjs --write",
    scope: {
      environment: "local-development-and-valueless-public-testnet",
      valueStatus: "valueless",
      publicPublicationAllowed: true,
      liveDeploymentAllowed: true,
      backendIntegrationInScope: false,
      bridgeInScope: false,
      l2InScope: false,
    },
    sources: Object.fromEntries(
      Object.entries(entries).map(([id, entry]) => [
        id,
        {
          path: entry.relativePath,
          version: sourceVersion(id, entry.value),
          sha256: sha256(entry.bytes),
        },
      ])
    ),
    environments: {
      localnet: {
        status: "active-valueless-local-development",
        public: false,
        identifiers: networkIdentifiers(localnet),
        nativeCurrency: nativeCurrency(localnet),
        genesis: {
          path: sourcePaths.genesis,
          sha256: genesisManifest.genesis_sha256,
          canonicalHashAlgorithm: "sha256",
          signature: {
            status: "HOLD-unsigned-local-only",
            algorithm: null,
            keyId: null,
            value: null,
            requiredForPublicArtifact: true,
          },
        },
        endpoints: {
          ...identifiers.walletMetadata.localnetDefaults,
          publishable: false,
        },
        wallet: {
          eip3085: {
            chainId: localnet.evm.chainIdHex,
            chainName: localnet.displayName,
            nativeCurrency: {
              name: identifiers.currency.nonValueNetworks.name,
              symbol: localnet.nativeCurrencySymbol,
              decimals: identifiers.currency.decimals,
            },
            rpcUrls: identifiers.walletMetadata.localnetDefaults.rpcUrls,
            blockExplorerUrls:
              identifiers.walletMetadata.localnetDefaults.blockExplorerUrls,
          },
          iconAsset: null,
          iconStatus: "HOLD-not-selected",
        },
        peerDiscovery: emptyPeerDiscovery(),
        stateSync: {
          status: "HOLD-unconfigured-untrusted",
          enabled: false,
          rpcServers: [],
          snapshotServers: [],
          trustHeight: null,
          trustHash: null,
          trustPeriodSeconds: null,
          mustBeLessThanUnbondingSeconds:
            recovery.stateSync.mustBeLessThanUnbondingSeconds,
        },
        snapshot: {
          format: recovery.snapshots.developerRuntimeEnvelope.format,
          status: recovery.snapshots.developerRuntimeEnvelope.status,
          signed: recovery.snapshots.developerRuntimeEnvelope.signed,
          publicPublicationAllowed:
            recovery.snapshots.developerRuntimeEnvelope
              .publicPublicationAllowed,
          operatorRestoreAllowed:
            recovery.snapshots.developerRuntimeEnvelope.operatorRestoreAllowed,
        },
      },
      devnet: reservedEnvironment(network("devnet")),
      testnet: liveTestnetEnvironment(testnet, testnetManifest),
      mainnet: reservedEnvironment(network("mainnet")),
    },
    compatibility: {
      minimumNodeVersion: null,
      minimumNodeVersionStatus: "HOLD-not-ratified",
      protocolVersion: protocol.protocolVersion,
      sdk: { version: sdk.version, status: "published-to-npm-with-provenance" },
      contracts: {
        version: contracts.registryVersion,
        status: contracts.releaseStatus,
      },
      explorer: {
        version: `${explorerSelection.selectionVersion}/${explorerStack.stackVersion}`,
        status: `${explorerSelection.status}/${explorerStack.status}`,
      },
      nodeRoles: {
        version: nodeRoles.profileVersion,
        status: nodeRoles.status,
      },
      recovery: {
        version: recovery.recoveryVersion,
        status: recovery.status,
      },
      upgrade: {
        governanceContractVersion: governance.contractVersion,
        planName: governance.upgrade.planName,
        preUpgradeVersion: governance.upgrade.preUpgradeVersion,
        postUpgradeVersion: governance.upgrade.postUpgradeVersion,
        operatorChecksumPreflightRequired:
          governance.authorizationRules
            .normalOperatorProcedureRequiresChecksumPreflight,
      },
      localnetFormatRehearsal: {
        status: "metadata-generated-chain-start-HOLD",
        bundleGenerated: true,
        bundleValidated: true,
        chainStartRehearsedFromBundle: false,
      },
    },
    changePolicy: {
      currentBundle: {
        requiresRestart: false,
        requiresMigration: false,
        networkDiscontinuity: false,
        note: "records the live torium-testnet-1 identity and endpoints; canonical localnet inputs are unchanged",
      },
      publicGenesisReplacement: {
        requiresNewCosmosChainId: true,
        requiresNewEvmChainId: true,
        requiresBundleVersionIncrement: true,
        networkDiscontinuityRequired: true,
      },
      identifierAvailability: {
        evidencePath: sourcePaths.identifierAvailability,
        datedEvidenceOnly: true,
        recheckBeforePublication: true,
      },
      privateData: {
        peerIdsAllowed: false,
        privateIpsAllowed: false,
        keysAllowed: false,
        signerStateAllowed: false,
      },
    },
    releaseReadiness: {
      ready: false,
      status: "testnet-published-mainnet-hold",
      checksumsComplete: true,
      signatureComplete: false,
      publicMetadataComplete: true,
      localnetChainStartRehearsalComplete: false,
    },
    holds: [
      "Public genesis signature algorithm and custody are not selected; the testnet genesis is hash-anchored in git history, unsigned.",
      "Devnet and mainnet genesis artifacts do not exist.",
      "Devnet and mainnet RPC, WebSocket and explorer endpoints are unpublished.",
      "Seed, persistent-peer and trusted state-sync values are unpublished for every environment; testnet public P2P peering is closed.",
      "The testnet genesis file is withheld from the repository while P2P peering is closed because its genesis transactions embed validator node IDs; chain/genesis/testnet/manifest.json carries the authoritative sha256.",
      "Chain registry submissions (ethereum-lists/chains, wallet asset registries) are not filed; EVM chain IDs remain collision-checked but unreserved.",
      "System contracts are not deployed to the public testnet; contracts/deployments records localnet only.",
      "Localnet chain-start consumption is rehearsed by chain/releases/rehearse-chain-start-v0.sh (2026-07-29); devnet and mainnet consumption stays unexercised.",
      "Explorer runtime compatibility contracts remain local-conditional while the live testnet explorer runs Blockscout.",
      "Identifier availability must be rechecked immediately before any new environment publication.",
    ],
  };

  function network(environment) {
    const value = identifiers.networks.find(
      (candidate) => candidate.environment === environment
    );
    assert.ok(value, `missing ${environment} identifier`);
    return value;
  }
}

function networkIdentifiers(value) {
  return {
    displayName: value.displayName,
    cosmosChainId: value.cosmos.chainId,
    evmChainId: value.evm.chainId,
    evmChainIdHex: value.evm.chainIdHex,
    networkId: value.evm.networkId,
    caip2: value.evm.caip2,
    shortName: value.evm.shortName,
    nativeCurrencySymbol: value.nativeCurrencySymbol,
    registryStatus: value.evm.registryStatus,
  };
}

function liveTestnetEnvironment(value, manifest) {
  const identifiers = entries.identifiers.value;
  return {
    status: "active-valueless-public-testnet",
    public: true,
    identifiers: networkIdentifiers(value),
    nativeCurrency: nativeCurrency(value),
    genesis: {
      manifestPath: sourcePaths.testnetGenesisManifest,
      sha256: manifest.genesis_sha256,
      canonicalHashAlgorithm: "sha256",
      fileDistribution: "withheld-while-public-p2p-peering-is-closed",
      signature: {
        status: "HOLD-unsigned-hash-anchored-in-git-history",
        algorithm: null,
        keyId: null,
        value: null,
        requiredForPublicArtifact: true,
      },
    },
    endpoints: {
      rpcUrls: [manifest.public_endpoints.evmJsonRpc],
      webSocketUrls: [manifest.public_endpoints.evmWebSocket],
      blockExplorerUrls: [manifest.public_endpoints.blockExplorer],
      faucetUrls: [manifest.public_endpoints.faucet],
      publishable: true,
    },
    wallet: {
      eip3085: {
        chainId: value.evm.chainIdHex,
        chainName: value.displayName,
        nativeCurrency: {
          name: identifiers.currency.nonValueNetworks.name,
          symbol: value.nativeCurrencySymbol,
          decimals: identifiers.currency.decimals,
        },
        rpcUrls: [manifest.public_endpoints.evmJsonRpc],
        blockExplorerUrls: [manifest.public_endpoints.blockExplorer],
      },
      iconAsset: `${manifest.public_endpoints.faucet}/logo.png`,
      iconStatus: "published-faucet-hosted-registry-submissions-pending",
    },
    peerDiscovery: emptyPeerDiscovery(),
    stateSync: emptyStateSync(),
    snapshot: null,
  };
}

function reservedEnvironment(value) {
  return {
    status: "reserved-unpublished-no-genesis",
    public: value.public,
    identifiers: networkIdentifiers(value),
    nativeCurrency: nativeCurrency(value),
    genesis: null,
    endpoints: {
      rpcUrls: [],
      webSocketUrls: [],
      blockExplorerUrls: [],
      publishable: false,
    },
    wallet: null,
    peerDiscovery: emptyPeerDiscovery(),
    stateSync: emptyStateSync(),
    snapshot: null,
  };
}

function nativeCurrency(value) {
  const identifiers = entries.identifiers.value;
  const isMainnet = value.environment === "mainnet";
  return {
    name: isMainnet
      ? identifiers.currency.mainnet.name
      : identifiers.currency.nonValueNetworks.name,
    symbol: value.nativeCurrencySymbol,
    baseDenom: identifiers.currency.baseDenom,
    decimals: identifiers.currency.decimals,
    valueStatus: isMainnet
      ? "not-launched-no-value-claim"
      : "valueless-non-market-network",
  };
}

function emptyStateSync() {
  return {
    status: "HOLD-unconfigured-untrusted",
    enabled: false,
    rpcServers: [],
    snapshotServers: [],
    trustHeight: null,
    trustHash: null,
    trustPeriodSeconds: null,
    mustBeLessThanUnbondingSeconds:
      entries.recovery.value.stateSync.mustBeLessThanUnbondingSeconds,
  };
}

function emptyPeerDiscovery() {
  return {
    status: "HOLD-unpublished",
    seeds: [],
    persistentPeers: [],
    published: false,
    privatePeerDataAllowed: false,
  };
}

function sourceVersion(id, value) {
  return {
    identifiers: value.manifestVersion,
    identifierAvailability: value.checkedAt,
    protocol: value.protocolVersion,
    genesis: "sha256",
    genesisManifest: `schema-${value.schema_version}`,
    testnetGenesisManifest: `schema-${value.schema_version}`,
    recovery: value.recoveryVersion,
    governance: value.contractVersion,
    nodeRoles: value.profileVersion,
    sdk: value.version,
    contracts: value.registryVersion,
    explorerSelection: value.selectionVersion,
    explorerStack: value.stackVersion,
  }[id];
}

function assertSemantics(artifact) {
  const environments = Object.values(artifact.environments);
  assert.equal(new Set(environments.map((item) => item.identifiers.cosmosChainId)).size, 4);
  assert.equal(new Set(environments.map((item) => item.identifiers.evmChainId)).size, 4);
  for (const item of environments) {
    assert.equal(item.identifiers.networkId, item.identifiers.evmChainId);
    assert.equal(item.identifiers.evmChainIdHex, `0x${item.identifiers.evmChainId.toString(16)}`);
    assert.equal(item.identifiers.caip2, `eip155:${item.identifiers.evmChainId}`);
    assert.deepEqual(item.peerDiscovery.seeds, []);
    assert.deepEqual(item.peerDiscovery.persistentPeers, []);
  }
  for (const name of ["devnet", "mainnet"]) {
    const item = artifact.environments[name];
    assert.equal(item.genesis, null);
    assert.equal(item.endpoints.publishable, false);
    assert.deepEqual(item.endpoints.rpcUrls, []);
    assert.deepEqual(item.endpoints.webSocketUrls, []);
    assert.deepEqual(item.endpoints.blockExplorerUrls, []);
  }
  assert.equal(artifact.environments.localnet.public, false);
  assert.equal(artifact.environments.localnet.endpoints.publishable, false);
  assert.match(artifact.environments.localnet.endpoints.rpcUrls[0], /^http:\/\/127\.0\.0\.1:/u);
  assert.equal(artifact.environments.localnet.genesis.signature.value, null);
  const testnet = artifact.environments.testnet;
  assert.equal(testnet.public, true);
  assert.match(testnet.genesis.sha256, /^[0-9a-f]{64}$/u);
  assert.equal(testnet.genesis.signature.value, null);
  for (const url of [...testnet.endpoints.rpcUrls, ...testnet.endpoints.blockExplorerUrls, ...testnet.endpoints.faucetUrls]) {
    assert.match(url, /^https:\/\/[a-z.]+torium\.network$/u);
  }
  for (const url of testnet.endpoints.webSocketUrls) {
    assert.match(url, /^wss:\/\/[a-z.]+torium\.network$/u);
  }
  assert.equal(testnet.wallet.eip3085.chainId, testnet.identifiers.evmChainIdHex);
  assert.deepEqual(testnet.wallet.eip3085.rpcUrls, testnet.endpoints.rpcUrls);
  assert.deepEqual(testnet.wallet.eip3085.blockExplorerUrls, testnet.endpoints.blockExplorerUrls);
  assert.equal(artifact.releaseReadiness.ready, false);
}

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}
