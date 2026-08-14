#!/usr/bin/env node
/**
 * Verifies one local release output directory produced by
 * build-release-v0.sh: SHA256SUMS integrity, SBOM agreement with go.sum,
 * provenance materials against the pinned toolchain and commit, and the
 * Ed25519 signatures when a public key is present.
 *
 * Usage: node verify-release-v0.mjs --dir <release-dir> [--commit <sha>]
 */
import assert from "node:assert/strict";
import { createHash, createPublicKey, verify as edVerify } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const argv = process.argv.slice(2);
function argumentValue(flag) {
  const index = argv.indexOf(flag);
  return index === -1 ? "" : argv[index + 1];
}

const releaseDir = argumentValue("--dir");
const expectedCommit = argumentValue("--commit");
if (!releaseDir) {
  console.error("--dir <release-dir> is required");
  process.exit(64);
}

async function exists(candidate) {
  try {
    await access(candidate);
    return true;
  } catch {
    return false;
  }
}

// 1. Every artifact listed in SHA256SUMS exists and hashes correctly.
const sumsText = await readFile(path.join(releaseDir, "SHA256SUMS"), "utf8");
let artifactCount = 0;
for (const line of sumsText.split("\n")) {
  const match = line.match(/^([0-9a-f]{64})  (\S+)$/u);
  if (!match) continue;
  const [, digest, name] = match;
  const buffer = await readFile(path.join(releaseDir, name));
  const actual = createHash("sha256").update(buffer).digest("hex");
  assert.equal(actual, digest, `checksum mismatch for ${name}`);
  artifactCount += 1;
}
assert.ok(artifactCount > 0, "SHA256SUMS lists no artifacts");

// 2. The SBOM agrees with go.sum: same module set, same tree hashes.
const sbom = JSON.parse(await readFile(path.join(releaseDir, "sbom.spdx.json"), "utf8"));
assert.equal(sbom.spdxVersion, "SPDX-2.3");
const goSum = await readFile(path.join(root, "chain/app/go.sum"), "utf8");
const expectedModules = new Map();
for (const line of goSum.split("\n")) {
  const match = line.match(/^(\S+) (\S+) h1:(\S+)$/u);
  if (!match || match[2].endsWith("/go.mod")) continue;
  expectedModules.set(`${match[1]}@${match[2]}`, Buffer.from(match[3], "base64").toString("hex"));
}
const sbomModules = new Map();
for (const pkg of sbom.packages) {
  const purl = pkg.externalRefs?.find((ref) => ref.referenceType === "purl")?.referenceLocator;
  if (!purl?.startsWith("pkg:golang/")) continue;
  sbomModules.set(purl.slice("pkg:golang/".length), pkg.checksums?.[0]?.checksumValue);
}
assert.equal(sbomModules.size, expectedModules.size, "SBOM module count diverges from go.sum");
for (const [key, hash] of expectedModules) {
  assert.equal(sbomModules.get(key), hash, `SBOM hash diverges for ${key}`);
}

// 3. Provenance subjects cover SHA256SUMS and materials match the pins.
const provenance = JSON.parse(
  await readFile(path.join(releaseDir, "provenance-v1.json"), "utf8")
);
assert.equal(provenance._type, "https://in-toto.io/Statement/v1");
assert.equal(provenance.predicateType, "https://slsa.dev/provenance/v1");
assert.equal(provenance.subject.length, artifactCount, "provenance subject count diverges");
const dependencies = new Map(
  provenance.predicate.buildDefinition.resolvedDependencies.map((dependency) => [
    dependency.uri.startsWith("git+") ? "git" : dependency.uri,
    dependency.digest,
  ])
);
for (const pinned of ["chain/toolchain.json", "chain/app/go.sum", "chain/app/Dockerfile"]) {
  const digest = createHash("sha256")
    .update(await readFile(path.join(root, pinned)))
    .digest("hex");
  assert.equal(dependencies.get(pinned)?.sha256, digest, `provenance material diverges for ${pinned}`);
}
if (expectedCommit) {
  assert.equal(dependencies.get("git")?.gitCommit, expectedCommit, "provenance commit diverges");
}

// 4. Verify signatures when a public key is present.
let signatureNote = "unsigned (production signing is user-owned)";
if (await exists(path.join(releaseDir, "signing-public-key.pem"))) {
  const publicKey = createPublicKey(
    await readFile(path.join(releaseDir, "signing-public-key.pem"), "utf8")
  );
  for (const artifact of ["SHA256SUMS", "provenance-v1.json"]) {
    const payload = await readFile(path.join(releaseDir, artifact));
    const signature = Buffer.from(
      (await readFile(path.join(releaseDir, `${artifact}.sig`), "utf8")).trim(),
      "base64"
    );
    assert.ok(
      edVerify(null, payload, publicKey, signature),
      `ed25519 signature verification failed for ${artifact}`
    );
  }
  signatureNote = "ed25519 signatures verified";
}

console.log(
  `Release verified: ${artifactCount} artifacts, SBOM ${sbomModules.size} modules, provenance pinned, ${signatureNote}.`
);
