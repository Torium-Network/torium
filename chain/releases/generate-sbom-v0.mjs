#!/usr/bin/env node
/**
 * Deterministic SPDX 2.3 SBOM for the Torium chain binaries: every Go module
 * from chain/app/go.sum (module hashes included) plus the digest-pinned
 * build/runtime images. No network access; byte-identical output for
 * identical inputs. Timestamps derive from SOURCE_DATE_EPOCH.
 *
 * Usage: node chain/releases/generate-sbom-v0.mjs --output <file>
 *        [--version <release-version>] [--epoch <unix-seconds>]
 */
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function parseArguments(argv) {
  const result = { output: "", version: "0.1.0-local.1", epoch: null };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--output") result.output = argv[index + 1];
    if (argv[index] === "--version") result.version = argv[index + 1];
    if (argv[index] === "--epoch") result.epoch = Number(argv[index + 1]);
  }
  if (!result.output) {
    console.error("--output <file> is required");
    process.exit(64);
  }
  if (result.epoch === null || Number.isNaN(result.epoch)) {
    const environmentEpoch = Number(process.env.SOURCE_DATE_EPOCH);
    result.epoch = Number.isFinite(environmentEpoch) ? environmentEpoch : 0;
  }
  return result;
}

const { output, version, epoch } = parseArguments(process.argv.slice(2));
const created = new Date(epoch * 1000).toISOString().replace(/\.\d{3}Z$/u, "Z");

const goSum = await readFile(path.join(root, "chain/app/go.sum"), "utf8");
const goMod = await readFile(path.join(root, "chain/app/go.mod"), "utf8");
const toolchain = JSON.parse(await readFile(path.join(root, "chain/toolchain.json"), "utf8"));

// go.sum lines: "<module> <version>[/go.mod] h1:<base64>". Keep only the
// module-tree hashes (not /go.mod) so each dependency appears once per
// version actually vendored into the build.
const modules = new Map();
for (const line of goSum.split("\n")) {
  const match = line.match(/^(\S+) (\S+) h1:(\S+)$/u);
  if (!match) continue;
  const [, name, moduleVersion, hash] = match;
  if (moduleVersion.endsWith("/go.mod")) continue;
  modules.set(`${name}@${moduleVersion}`, { name, version: moduleVersion, hash });
}

const goDirective = goMod.match(/^go (\S+)$/mu)?.[1] ?? "unknown";

function spdxId(value) {
  return `SPDXRef-${value.replace(/[^A-Za-z0-9.-]/gu, "-")}`;
}

const packages = [
  {
    SPDXID: spdxId("torium-chain-binaries"),
    name: "torium-chain-binaries",
    versionInfo: version,
    downloadLocation: "NOASSERTION",
    filesAnalyzed: false,
    licenseConcluded: "NOASSERTION",
    licenseDeclared: "NOASSERTION",
    supplier: "Organization: Torium Network",
    primaryPackagePurpose: "APPLICATION",
    comment: `Built with Go ${goDirective} from the digest-pinned toolchain container.`,
  },
  {
    SPDXID: spdxId("builder-go-image"),
    name: "golang-builder-image",
    versionInfo: toolchain.runtimes.go.version,
    downloadLocation: `docker://${toolchain.runtimes.go.image}`,
    filesAnalyzed: false,
    licenseConcluded: "NOASSERTION",
    licenseDeclared: "NOASSERTION",
    supplier: "Organization: Docker Official Images",
    primaryPackagePurpose: "CONTAINER",
  },
];

const relationships = [
  {
    spdxElementId: "SPDXRef-DOCUMENT",
    relationshipType: "DESCRIBES",
    relatedSpdxElement: spdxId("torium-chain-binaries"),
  },
  {
    spdxElementId: spdxId("torium-chain-binaries"),
    relationshipType: "BUILD_TOOL_OF",
    relatedSpdxElement: spdxId("builder-go-image"),
  },
];

for (const key of [...modules.keys()].sort()) {
  const { name, version: moduleVersion, hash } = modules.get(key);
  const id = spdxId(`go-module-${name}-${moduleVersion}`);
  packages.push({
    SPDXID: id,
    name,
    versionInfo: moduleVersion,
    downloadLocation: "NOASSERTION",
    filesAnalyzed: false,
    licenseConcluded: "NOASSERTION",
    licenseDeclared: "NOASSERTION",
    supplier: "NOASSERTION",
    checksums: [{ algorithm: "SHA256", checksumValue: goSumHashToHex(hash) }],
    externalRefs: [
      {
        referenceCategory: "PACKAGE-MANAGER",
        referenceType: "purl",
        referenceLocator: `pkg:golang/${name}@${moduleVersion}`,
      },
    ],
  });
  relationships.push({
    spdxElementId: spdxId("torium-chain-binaries"),
    relationshipType: "DEPENDS_ON",
    relatedSpdxElement: id,
  });
}

// go.sum h1: hashes are base64 SHA-256 of the module tree (dirhash).
function goSumHashToHex(h1) {
  return Buffer.from(h1, "base64").toString("hex");
}

const document = {
  spdxVersion: "SPDX-2.3",
  dataLicense: "CC0-1.0",
  SPDXID: "SPDXRef-DOCUMENT",
  name: `torium-chain-binaries-${version}`,
  documentNamespace: `https://torium.network/spdx/torium-chain-binaries/${version}`,
  creationInfo: {
    created,
    creators: ["Tool: chain/releases/generate-sbom-v0.mjs"],
    licenseListVersion: "3.24",
  },
  packages,
  relationships,
};

const encoded = `${JSON.stringify(document, null, 2)}\n`;
await writeFile(output, encoded);
const digest = createHash("sha256").update(encoded).digest("hex");
console.log(`SBOM written: ${output} (${modules.size} Go modules, sha256 ${digest})`);
