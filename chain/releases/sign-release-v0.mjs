#!/usr/bin/env node
/**
 * Ed25519 signing for local release artifacts. Production keys are
 * user-owned under the key-custody contract and never live in this
 * repository; --generate-throwaway creates a clearly-valueless rehearsal
 * key inside the (untracked) output directory.
 *
 * Usage:
 *   node sign-release-v0.mjs --generate-throwaway <key-file>
 *   node sign-release-v0.mjs --key <key-file> --dir <release-dir>
 */
import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as edSign,
} from "node:crypto";
import { chmod, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const argv = process.argv.slice(2);
function argumentValue(flag) {
  const index = argv.indexOf(flag);
  return index === -1 ? "" : argv[index + 1];
}

const throwawayTarget = argumentValue("--generate-throwaway");
if (throwawayTarget) {
  const { privateKey } = generateKeyPairSync("ed25519");
  const pem = privateKey.export({ type: "pkcs8", format: "pem" });
  const banner =
    "# VALUELESS THROWAWAY REHEARSAL KEY — generated for one local release\n" +
    "# rehearsal, never a production or custody key. Do not reuse.\n";
  await writeFile(throwawayTarget, banner + pem);
  await chmod(throwawayTarget, 0o600);
  console.log(`throwaway rehearsal key written: ${throwawayTarget}`);
  process.exit(0);
}

const keyFile = argumentValue("--key");
const releaseDir = argumentValue("--dir");
if (!keyFile || !releaseDir) {
  console.error("usage: sign-release-v0.mjs --key <file> --dir <release-dir>");
  process.exit(64);
}

const keyPem = (await readFile(keyFile, "utf8"))
  .split("\n")
  .filter((line) => !line.startsWith("#"))
  .join("\n");
const privateKey = createPrivateKey(keyPem);
if (privateKey.asymmetricKeyType !== "ed25519") {
  console.error("signing key must be Ed25519");
  process.exit(1);
}
const publicKey = createPublicKey(privateKey);

for (const artifact of ["SHA256SUMS", "provenance-v1.json"]) {
  const artifactPath = path.join(releaseDir, artifact);
  const payload = await readFile(artifactPath);
  const signature = edSign(null, payload, privateKey);
  await writeFile(`${artifactPath}.sig`, `${signature.toString("base64")}\n`);
  console.log(`signed ${artifact} (${signature.length}-byte ed25519 signature)`);
}
await writeFile(
  path.join(releaseDir, "signing-public-key.pem"),
  publicKey.export({ type: "spki", format: "pem" })
);
console.log("public key exported: signing-public-key.pem");
