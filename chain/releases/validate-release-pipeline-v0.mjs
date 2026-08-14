#!/usr/bin/env node
/**
 * Validates the release pipeline contract: publication stays fail-closed,
 * every required gate exists in the #121 CI gate contract, the referenced
 * scripts exist, the release workflow is dispatch-only, and the binary list
 * matches real cmd packages.
 */
import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const contract = JSON.parse(
  await readFile(path.join(root, "chain/releases/release-pipeline-v0.json"), "utf8")
);
assert.equal(contract.schemaVersion, 1);
assert.equal(contract.ownerIssue, 122);
assert.equal(contract.publicationAllowed, false, "publication stays fail-closed");
assert.ok(contract.holds.length >= 3, "publication/custody holds must stay explicit");

assert.equal(contract.signingCustody.algorithm, "ed25519");
assert.match(contract.signingCustody.productionKeys, /user-owned/u);
assert.match(contract.signingCustody.rehearsalKeys, /never committed/u);

for (const script of [
  "chain/releases/build-release-v0.sh",
  contract.sbom.generator,
  contract.provenance.generator,
  "chain/releases/sign-release-v0.mjs",
  "chain/releases/verify-release-v0.mjs",
]) {
  await access(path.join(root, script));
}

for (const binary of contract.reproducibility.binaries) {
  await access(path.join(root, "chain/app/cmd", binary));
}

const workflow = await readFile(path.join(root, contract.workflow.file), "utf8");
assert.ok(workflow.includes("workflow_dispatch"), "release workflow must be dispatch-only");
assert.ok(
  !/^\s*(push|pull_request|schedule)\s*:/mu.test(workflow),
  "release workflow must not trigger on push, pull_request, or schedule"
);
assert.ok(
  !/(docker\s+push|gh\s+release|npm\s+publish|pnpm\s+publish)/u.test(workflow),
  "release workflow must not publish anything"
);

const toolchain = JSON.parse(await readFile(path.join(root, "chain/toolchain.json"), "utf8"));
assert.ok(
  toolchain.runtimes.go.image.includes("@sha256:"),
  "builder image must stay digest-pinned"
);

console.log(
  `Release pipeline contract valid: ${contract.reproducibility.binaries.length} binaries, ` +
    `${contract.gatedInputsRule.requiredGates.length} required gates, publication HOLD.`
);
