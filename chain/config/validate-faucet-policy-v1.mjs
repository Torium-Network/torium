import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const directory = dirname(fileURLToPath(import.meta.url));
const chainDirectory = join(directory, "..");
const [policy, protocol, identifiers, manifest, compose] = await Promise.all([
  readJSON("faucet-policy-v1.json"),
  readJSON("protocol-v1.json"),
  readJSON("identifiers.json"),
  readJSON(join("..", "genesis", "localnet", "manifest.json")),
  readFile(join(chainDirectory, "localnet", "compose.yaml"), "utf8"),
]);

assert.equal(policy.schemaVersion, 1);
assert.equal(policy.status, "active-local-only");
assert.equal(policy.environment, "localnet");
assert.equal(policy.ownerIssue, 97);
assert.match(policy.warning, /VALUELESS LOCAL DEVELOPMENT/u);

const localnet = identifiers.networks.find(
  ({ environment }) => environment === "localnet"
);
assert.ok(localnet, "canonical localnet identifier row is missing");
assert.equal(policy.network.cosmosChainId, localnet.cosmos.chainId);
assert.equal(policy.network.evmChainId, localnet.evm.chainId);
assert.equal(policy.network.baseDenom, identifiers.currency.baseDenom);
assert.equal(policy.network.displayDenom, localnet.nativeCurrencySymbol);
assert.equal(policy.network.decimals, identifiers.currency.decimals);
assert.equal(policy.network.baseDenom, protocol.nativeAsset.baseDenom);

const amounts = Object.entries(policy.funding)
  .filter(([name]) => name.endsWith("BaseUnits"))
  .map(([name, value]) => [name, BigInt(value)]);
for (const [name, value] of amounts) {
  assert.ok(value > 0n, `${name} must be positive`);
}
assert.ok(
  BigInt(policy.funding.minimumAmountBaseUnits) <=
    BigInt(policy.funding.defaultAmountBaseUnits)
);
assert.ok(
  BigInt(policy.funding.defaultAmountBaseUnits) <=
    BigInt(policy.funding.maximumAmountPerRequestBaseUnits)
);
assert.ok(
  BigInt(policy.funding.maximumAmountPerRequestBaseUnits) <=
    BigInt(policy.funding.maximumAmountPerAddressWindowBaseUnits)
);
assert.ok(policy.funding.cooldownSeconds > 0);
assert.ok(policy.funding.addressWindowSeconds > policy.funding.cooldownSeconds);

assert.equal(policy.exposure.defaultListenAddress, "127.0.0.1:8080");
assert.equal(policy.exposure.hostPublishing, "loopback-only");
assert.equal(policy.exposure.publicUseAllowed, false);
assert.match(compose, /"127\.0\.0\.1:8080:8080"/u);

const faucetAccount = manifest.development_accounts.find(
  ({ name }) => name === policy.signer.fixtureAccount
);
assert.ok(faucetAccount, "genesis manifest has no faucet development account");
assert.equal(policy.signer.lifetime, "process-memory-only");
assert.equal(policy.signer.privateKeyPersistence, false);
assert.equal(policy.signer.privateKeyInEnvironment, false);
assert.equal(policy.signer.privateKeyInApi, false);
assert.equal(policy.signer.privateKeyInLogs, false);
assert.equal(policy.signer.publicNetworkReuseAllowed, false);
assert.equal(policy.privacy.requestBodiesLogged, false);
assert.equal(policy.privacy.mnemonicsAccepted, false);
assert.equal(policy.privacy.privateKeysAccepted, false);
assert.equal(policy.privacy.signedRawTransactionsReturned, false);
assert.equal(policy.publicProfile.implemented, false);
assert.equal(policy.publicProfile.ownerIssue, 172);

process.stdout.write(
  `${JSON.stringify(
    {
      valid: true,
      profileVersion: policy.profileVersion,
      endpoint: policy.exposure.composeHostEndpoint,
      defaultAmountBaseUnits: policy.funding.defaultAmountBaseUnits,
      maximumAmountPerRequestBaseUnits:
        policy.funding.maximumAmountPerRequestBaseUnits,
      publicUseAllowed: policy.exposure.publicUseAllowed,
    },
    null,
    2
  )}\n`
);

async function readJSON(name) {
  return JSON.parse(await readFile(join(directory, name), "utf8"));
}
