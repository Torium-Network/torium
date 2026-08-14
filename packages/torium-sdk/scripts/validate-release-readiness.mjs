#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageDirectory = join(dirname(fileURLToPath(import.meta.url)), "..");
const root = join(packageDirectory, "../..");

const [policy, manifest, packageFiles, sdkPolicy, identifiers, docsVersions] =
  await Promise.all([
    json(join(packageDirectory, "release/release-policy-v0.json")),
    json(join(packageDirectory, "package.json")),
    json(join(packageDirectory, "api/package-files.json")),
    json(join(root, "chain/config/sdk-policy-v0.json")),
    json(join(root, "chain/config/identifiers.json")),
    json(join(root, "apps/developer-docs/content/versions.json")),
  ]);

// Package identity and premature-publish guards.
assert.equal(policy.schemaVersion, 1);
assert.equal(policy.ownerIssue, 138);
assert.equal(manifest.name, policy.package.name);
assert.equal(manifest.version, policy.package.version);
assert.equal(
  policy.publishAllowed,
  true,
  "publishing is authorized for v0.1.0"
);
assert.equal(policy.releaseReady, true, "release readiness must be affirmed");
assert.equal(
  manifest.private,
  false,
  "the package must be publishable while publishAllowed is true"
);
assert.equal(manifest.publishConfig.access, policy.package.access);
assert.equal(
  manifest.publishConfig.provenance,
  true,
  "trusted-publishing provenance is required"
);

// No long-lived npm credentials anywhere near the package or repository root.
assert.equal(policy.authentication.longLivedTokensAllowed, false);
for (const candidate of [
  join(packageDirectory, ".npmrc"),
  join(root, ".npmrc"),
]) {
  if (!existsSync(candidate)) continue;
  const contents = await readFile(candidate, "utf8");
  assert.ok(
    !/_authToken|_password|_auth\s*=/u.test(contents),
    `${candidate} must not contain npm credentials`
  );
}

// Namespace ownership must be recorded before any release step.
assert.equal(policy.namespaceOwnership.status, "proven-organization-created");
assert.ok(
  existsSync(join(root, policy.namespaceOwnership.evidencePath)),
  "identifier availability evidence must exist"
);

// Compatibility gates must reference the actual pinned surfaces.
const gates = policy.compatibilityGates;
assert.equal(gates.viemPeerRange, manifest.peerDependencies.viem);
assert.equal(gates.viemPeerRange, sdkPolicy.baseline.viem.peerRange);
assert.equal(gates.chainManifestVersion, identifiers.manifestVersion);
const contractsRegistry = await json(
  join(root, "contracts/deployments/localnet.json")
);
assert.equal(gates.contractsRegistryVersion, contractsRegistry.registryVersion);
const docsVersion = docsVersions.versions.find(
  (candidate) => candidate.id === gates.docsVersionId
);
assert.ok(docsVersion, "docs version tuple must exist");
assert.equal(docsVersion.compatibility.sdk.version, manifest.version);
const matrix = await json(join(root, gates.conformanceMatrixPath));
assert.equal(matrix.ownerIssue, 137);
assert.ok(matrix.capabilities.length >= 20);
for (const capability of matrix.capabilities) {
  assert.equal(capability.status, "pass");
}

// The changelog must describe the version being prepared.
const changelog = await readFile(
  join(packageDirectory, "CHANGELOG.md"),
  "utf8"
);
assert.ok(
  changelog.includes(`## ${manifest.version}`),
  `CHANGELOG.md must document version ${manifest.version}`
);

// Release gates must include every blocking control the checklist relies on.
const gateIds = policy.releaseGates.map((gate) => gate.id);
for (const required of [
  "package-verify",
  "dry-run-tarball-exact",
  "localnet-conformance",
  "docs-current",
  "namespace-ownership-evidence",
  "explicit-user-approval",
]) {
  assert.ok(gateIds.includes(required), `missing release gate ${required}`);
}
for (const gate of policy.releaseGates) {
  assert.equal(gate.blocking, true, `release gate ${gate.id} must block`);
}
assert.equal(policy.rollback.unpublishAllowed, false);
assert.ok(policy.compromisedRelease.steps.length >= 4);
assert.ok(
  existsSync(join(root, policy.review.checklistPath)),
  "the release checklist must exist"
);

// The dry run must reproduce the reviewed publishable tarball exactly.
const dryRun = spawnSync("npm", ["pack", "--dry-run", "--json"], {
  cwd: packageDirectory,
  encoding: "utf8",
});
assert.equal(dryRun.status, 0, `npm pack --dry-run failed: ${dryRun.stderr}`);
const [packResult] = JSON.parse(dryRun.stdout);
const observed = packResult.files
  .map(({ path, size }) => ({ path, size }))
  .toSorted((left, right) => left.path.localeCompare(right.path));
const reviewed = packageFiles.files.map(({ path, bytes }) => ({
  path,
  size: bytes,
}));
assert.deepEqual(
  observed,
  reviewed,
  "npm pack --dry-run does not reproduce the reviewed publishable file set"
);

console.log(
  `Release readiness validated for ${manifest.name}@${manifest.version}: ` +
    `${observed.length} packed files reproduced, publishing is authorized.`
);

async function json(path) {
  return JSON.parse(await readFile(path, "utf8"));
}
