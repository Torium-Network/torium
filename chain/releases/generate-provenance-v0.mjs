#!/usr/bin/env node
/**
 * in-toto Statement v1 with a SLSA provenance v1 predicate for one local
 * release build. Subjects come from the build's SHA256SUMS; materials pin
 * the exact source commit, toolchain contract, module sums, and Dockerfile.
 *
 * Usage: node chain/releases/generate-provenance-v0.mjs \
 *          --sums <SHA256SUMS> --output <file> --commit <sha> \
 *          [--version <v>] [--epoch <unix-seconds>] [--platforms <csv>]
 */
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function parseArguments(argv) {
  const result = {
    sums: "",
    output: "",
    commit: "",
    version: "0.1.0-local.1",
    epoch: null,
    platforms: "linux/amd64,linux/arm64",
  };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--sums") result.sums = argv[index + 1];
    if (argv[index] === "--output") result.output = argv[index + 1];
    if (argv[index] === "--commit") result.commit = argv[index + 1];
    if (argv[index] === "--version") result.version = argv[index + 1];
    if (argv[index] === "--epoch") result.epoch = Number(argv[index + 1]);
    if (argv[index] === "--platforms") result.platforms = argv[index + 1];
  }
  for (const required of ["sums", "output", "commit"]) {
    if (!result[required]) {
      console.error(`--${required} is required`);
      process.exit(64);
    }
  }
  if (result.epoch === null || Number.isNaN(result.epoch)) {
    const environmentEpoch = Number(process.env.SOURCE_DATE_EPOCH);
    result.epoch = Number.isFinite(environmentEpoch) ? environmentEpoch : 0;
  }
  return result;
}

const options = parseArguments(process.argv.slice(2));

async function sha256OfFile(relativePath) {
  const buffer = await readFile(path.join(root, relativePath));
  return createHash("sha256").update(buffer).digest("hex");
}

const sumsText = await readFile(options.sums, "utf8");
const subjects = [];
for (const line of sumsText.split("\n")) {
  const match = line.match(/^([0-9a-f]{64})  (\S+)$/u);
  if (!match) continue;
  subjects.push({ name: match[2], digest: { sha256: match[1] } });
}
if (subjects.length === 0) {
  console.error(`no subjects found in ${options.sums}`);
  process.exit(1);
}

const finishedOn = new Date(options.epoch * 1000).toISOString().replace(/\.\d{3}Z$/u, "Z");

const statement = {
  _type: "https://in-toto.io/Statement/v1",
  subject: subjects,
  predicateType: "https://slsa.dev/provenance/v1",
  predicate: {
    buildDefinition: {
      buildType: "https://torium.network/build-types/local-pinned-toolchain/v0",
      externalParameters: {
        version: options.version,
        platforms: options.platforms.split(","),
        sourceDateEpoch: options.epoch,
      },
      internalParameters: {
        builderScript: "chain/releases/build-release-v0.sh",
        cgoEnabled: "1",
        trimpath: true,
        buildvcs: false,
      },
      resolvedDependencies: [
        {
          uri: `git+https://github.com/Torium-Network/torium@${options.commit}`,
          digest: { gitCommit: options.commit },
        },
        {
          uri: "chain/toolchain.json",
          digest: { sha256: await sha256OfFile("chain/toolchain.json") },
        },
        {
          uri: "chain/app/go.sum",
          digest: { sha256: await sha256OfFile("chain/app/go.sum") },
        },
        {
          uri: "chain/app/Dockerfile",
          digest: { sha256: await sha256OfFile("chain/app/Dockerfile") },
        },
      ],
    },
    runDetails: {
      builder: {
        id: "https://torium.network/builders/local-pinned-toolchain",
        version: { "chain/toolchain.json": "1" },
      },
      metadata: {
        invocationId: `local-release-${options.version}-${options.commit.slice(0, 12)}`,
        finishedOn,
      },
    },
  },
};

const encoded = `${JSON.stringify(statement, null, 2)}\n`;
await writeFile(options.output, encoded);
console.log(
  `Provenance written: ${options.output} (${subjects.length} subjects, commit ${options.commit.slice(0, 12)})`
);
