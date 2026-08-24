import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const directory = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(
  await readFile(join(directory, "identifiers.json"), "utf8")
);
const audit = JSON.parse(
  await readFile(join(directory, "identifier-availability.json"), "utf8")
);

assert.equal(manifest.schemaVersion, 1);
assert.equal(manifest.product.publicName, "Torium");
assert.equal(manifest.currency.baseDenom, "atorium");
assert.equal(manifest.currency.decimals, 18);
assert.equal(manifest.currency.mainnet.symbol, "TOR");
assert.equal(manifest.currency.nonValueNetworks.symbol, "tTOR");
assert.equal(manifest.currency.nonValueNetworks.hasMarketValue, false);
assert.equal(manifest.namespaces.npm.scope, "@torium-network");
assert.equal(manifest.namespaces.npm.primaryPackage, "@torium-network/sdk");
assert.equal(manifest.namespaces.npm.reservationStatus, "organization-created");
assert.equal(
  manifest.namespaces.github.reservationStatus,
  "blocked-owner-action"
);
assert.equal(manifest.namespaces.docs.canonicalBasePath, "/docs");
assert.deepEqual(manifest.walletMetadata.localnetDefaults.rpcUrls, [
  "http://127.0.0.1:8545",
]);
assert.deepEqual(manifest.walletMetadata.localnetDefaults.webSocketUrls, [
  "ws://127.0.0.1:8546",
]);
assert.deepEqual(
  manifest.walletMetadata.localnetDefaults.blockExplorerUrls,
  []
);
assert.equal(manifest.walletMetadata.localnetDefaults.publishable, false);
assert.equal(
  manifest.walletMetadata.publicEndpointStatus,
  "deferred-unpublished"
);

const environments = ["localnet", "devnet", "testnet", "mainnet"];
assert.deepEqual(
  manifest.networks.map((network) => network.environment),
  environments
);

const chainIds = new Set();
const cosmosChainIds = new Set();
const shortNames = new Set();
for (const network of manifest.networks) {
  const { evm, cosmos } = network;
  assert.ok(Number.isSafeInteger(evm.chainId) && evm.chainId > 0);
  assert.ok(evm.chainId <= 2_147_483_647, "chain ID exceeds signed 32-bit");
  assert.equal(evm.networkId, evm.chainId);
  assert.equal(evm.chainIdHex, `0x${evm.chainId.toString(16)}`);
  assert.equal(evm.caip2, `eip155:${evm.chainId}`);
  assert.match(evm.shortName, /^[a-z][a-z0-9-]*$/u);
  assert.match(cosmos.chainId, /^[a-z0-9-]+-[1-9][0-9]*$/u);
  assert.ok(!chainIds.has(evm.chainId), `duplicate EIP-155 ID ${evm.chainId}`);
  assert.ok(
    !cosmosChainIds.has(cosmos.chainId),
    `duplicate Cosmos chain ID ${cosmos.chainId}`
  );
  assert.ok(
    !shortNames.has(evm.shortName),
    `duplicate shortName ${evm.shortName}`
  );
  chainIds.add(evm.chainId);
  cosmosChainIds.add(cosmos.chainId);
  shortNames.add(evm.shortName);

  if (network.environment === "localnet" || network.environment === "devnet") {
    assert.equal(network.public, false);
    assert.equal(evm.registryStatus, "local-only-not-registered");
  } else if (network.environment === "testnet") {
    assert.equal(network.public, true);
    assert.equal(evm.registryStatus, "registered-ethereum-lists-chains");
    assert.match(evm.collisionFallback, /never reuse/u);
  } else {
    assert.equal(network.public, true);
    assert.equal(evm.registryStatus, "collision-checked-unreserved");
    assert.match(evm.collisionFallback, /never reuse/u);
  }
}

const bech32 = Object.values(manifest.addressing.cosmos.bech32);
assert.equal(new Set(bech32).size, bech32.length);
for (const prefix of bech32) assert.match(prefix, /^[a-z0-9]+$/u);
assert.equal(manifest.addressing.evm.coinType, 60);
assert.equal(manifest.addressing.cosmos.coinType, 60);
assert.equal(manifest.addressing.cosmos.mappingContractIssue, 86);

const obsoleteFixture = manifest.nonCanonicalFixtures.find(
  (fixture) => fixture.evmChainId === 262_144
);
assert.ok(
  obsoleteFixture,
  "the upstream PoC fixture must remain explicitly noncanonical"
);
assert.match(obsoleteFixture.reason, /collides/u);

assert.equal(audit.schemaVersion, 1);
assert.ok(!Number.isNaN(Date.parse(audit.checkedAt)));
const auditById = new Map();
for (const check of audit.checks) {
  assert.ok(!auditById.has(check.id), `duplicate audit ID ${check.id}`);
  for (const field of [
    "id",
    "kind",
    "identifier",
    "checkedAt",
    "source",
    "result",
    "evidence",
    "owner",
    "followUp",
  ]) {
    assert.equal(typeof check[field], "string", `${check.id}.${field}`);
    assert.ok(check[field].length > 0, `${check.id}.${field} is empty`);
  }
  assert.ok(!Number.isNaN(Date.parse(check.checkedAt)));
  auditById.set(check.id, check);
}

const expectedAuditIds = [
  "eip155-poc-262144",
  "eip155-mainnet-5525330",
  "eip155-testnet-1414484564",
  "eip155-localnet-1414484556",
  "eip155-devnet-1414484548",
  "npm-primary-package",
  "npm-fallback-package",
  "github-target-organization",
  "github-current-repository",
  "bech32-torium",
  "public-name-torium",
  "ticker-tor",
  "ticker-trium-fallback",
  "docs-canonical-path",
  "docs-redirect-host",
];
for (const id of expectedAuditIds) {
  assert.ok(auditById.has(id), `missing availability audit ${id}`);
}
assert.equal(auditById.get("eip155-poc-262144").result, "collision");
assert.equal(
  auditById.get("eip155-mainnet-5525330").result,
  "clear-at-check-time-unreserved"
);
assert.equal(
  auditById.get("eip155-testnet-1414484564").result,
  "clear-at-check-time-unreserved"
);
assert.equal(
  auditById.get("eip155-localnet-1414484556").result,
  "clear-local-only"
);
assert.equal(
  auditById.get("eip155-devnet-1414484548").result,
  "clear-local-only"
);
assert.equal(
  auditById.get("npm-primary-package").result,
  "organization-owned-package-published"
);
assert.equal(
  auditById.get("github-target-organization").result,
  "not-found-unreserved"
);
assert.equal(
  auditById.get("ticker-tor").result,
  "collision-accepted-prelaunch"
);

process.stdout.write(
  `${JSON.stringify(
    {
      valid: true,
      manifestVersion: manifest.manifestVersion,
      environments,
      evmChainIds: [...chainIds],
      cosmosChainIds: [...cosmosChainIds],
      availabilityChecks: audit.checks.length,
      blockedOwnerActions: ["npm", "github"],
    },
    null,
    2
  )}\n`
);
