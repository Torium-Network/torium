#!/usr/bin/env node
/**
 * Validates the public faucet service contract against the reviewed #172
 * design: fail-closed deployment, design-matching testnet limits, and a
 * local-rehearsal profile that can never masquerade as a public one.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const contract = JSON.parse(
  await readFile(path.join(root, "chain/config/public-faucet-service-v0.json"), "utf8")
);
assert.equal(contract.schemaVersion, 1);
assert.equal(contract.ownerIssue, 172);
assert.equal(contract.publicDeploymentAllowed, false, "deployment stays fail-closed");
assert.ok(/valueless/iu.test(contract.notice), "the valueless notice is mandatory");

const names = contract.profiles.map((profile) => profile.name);
assert.deepEqual(names.toSorted(), ["local-rehearsal", "testnet"]);

for (const profile of contract.profiles) {
  const label = `profile ${profile.name}`;
  for (const amountField of [
    "amountPerRequestBaseUnits",
    "globalDailyBudgetBaseUnits",
    "hotBalanceCapBaseUnits",
    "refillBelowBaseUnits",
    "alertBelowBaseUnits",
    "haltBelowBaseUnits",
  ]) {
    assert.match(profile[amountField], /^[1-9][0-9]*$/u, `${label}: ${amountField}`);
  }
  const amount = BigInt(profile.amountPerRequestBaseUnits);
  const budget = BigInt(profile.globalDailyBudgetBaseUnits);
  const hotCap = BigInt(profile.hotBalanceCapBaseUnits);
  const refill = BigInt(profile.refillBelowBaseUnits);
  const alert = BigInt(profile.alertBelowBaseUnits);
  const halt = BigInt(profile.haltBelowBaseUnits);
  assert.ok(amount <= budget, `${label}: per-request amount fits the budget`);
  assert.ok(hotCap >= budget, `${label}: hot cap covers one daily budget`);
  assert.ok(hotCap <= budget * 2n, `${label}: hot cap stays within the designed 2x budget blast radius`);
  assert.ok(halt <= alert && alert <= refill, `${label}: thresholds are ordered halt <= alert <= refill`);
  assert.ok(profile.perAddressDailyCap >= 1, label);
  assert.ok(profile.cooldownPerAddressSeconds >= 86400, `${label}: cooldown is at least 24h`);
  assert.ok(profile.queueCapacity > 0 && profile.queueCapacity <= 1024, `${label}: queue is bounded`);
  assert.ok(profile.errorRateTripCount <= profile.errorRateWindow, label);
  if (profile.name === "testnet") {
    assert.equal(profile.localRehearsal, false, `${label} is not a rehearsal`);
    assert.equal(profile.cosmosChainId, "torium-testnet-1");
    assert.equal(profile.evmChainId, 1414484564);
    assert.equal(profile.challengeMode, "turnstile", `${label} requires a real challenge`);
    assert.equal(profile.amountPerRequestBaseUnits, "1000000000000000000", "design: 1 tTOR per request");
    assert.equal(profile.globalDailyBudgetBaseUnits, "500000000000000000000", "design: 500 tTOR daily budget");
    assert.equal(profile.perAddressDailyCap, 1, "design: 1 request per address per day");
    assert.equal(profile.cooldownPerAddressSeconds, 86400, "design: 24h cooldown");
  } else {
    assert.equal(profile.localRehearsal, true, `${label} must be marked as rehearsal`);
    assert.equal(profile.cosmosChainId, "torium-localnet-1");
    assert.equal(profile.evmChainId, 1414484556);
    assert.equal(profile.challengeMode, "static-local");
  }
}

assert.ok(contract.holds.length >= 3, "operational holds must stay explicit");

console.log(
  `Public faucet service contract valid: ${contract.profiles.length} profiles, deployment HOLD.`
);
