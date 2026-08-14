#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));
const manifest = JSON.parse(
  readFileSync(`${root}/chain/toolchain.json`, "utf8")
);
const args = new Set(process.argv.slice(2));
const verifyImages = args.has("--verify-images");
const jsonOutput = args.has("--json");
const checks = [];

function command(program, commandArgs, options = {}) {
  const result = spawnSync(program, commandArgs, {
    cwd: root,
    encoding: "utf8",
    timeout: options.timeout ?? 300_000,
  });
  return {
    status: result.status,
    output: `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim(),
    error: result.error?.message,
  };
}

function versionTuple(value) {
  const match = value.match(/(?:^|[^0-9])(\d+)\.(\d+)\.(\d+)(?:[^0-9]|$)/);
  if (!match) return null;
  return match.slice(1).map(Number);
}

function atLeast(actual, minimum) {
  const left = versionTuple(actual);
  const right = versionTuple(minimum);
  if (!left || !right) return false;
  for (let index = 0; index < 3; index += 1) {
    if (left[index] > right[index]) return true;
    if (left[index] < right[index]) return false;
  }
  return true;
}

function record(name, passed, detail, required = true) {
  checks.push({ name, passed, required, detail });
}

function checkMinimum(name, program, commandArgs, minimum) {
  const result = command(program, commandArgs);
  const passed = result.status === 0 && atLeast(result.output, minimum);
  record(
    name,
    passed,
    result.error ?? (result.output || "command produced no version")
  );
}

function checkImage(name, image, entrypoint, commandArgs, expected) {
  const result = command(
    "docker",
    ["run", "--rm", "--entrypoint", entrypoint, image, ...commandArgs],
    { timeout: 600_000 }
  );
  record(
    name,
    result.status === 0 && result.output.includes(expected),
    result.error ?? (result.output || "container produced no version")
  );
}

function validateManifest() {
  record(
    "manifest schema",
    manifest.schemaVersion === 1,
    `schemaVersion=${manifest.schemaVersion}`
  );
  record(
    "container digest policy",
    [
      manifest.runtimes.node.image,
      manifest.runtimes.go.image,
      manifest.protobuf.image,
      manifest.contracts.foundry.image,
      manifest.contracts.solidity.image,
      manifest.quality.golangciLint.image,
      manifest.quality.protolint.image,
      manifest.quality.shfmt.image,
    ].every((image) => /@sha256:[a-f0-9]{64}$/.test(image)),
    "all canonical tool images must use sha256 digests"
  );

  const packageJson = JSON.parse(readFileSync(`${root}/package.json`, "utf8"));
  const contractsPackage = JSON.parse(
    readFileSync(`${root}/contracts/package.json`, "utf8")
  );
  const contractsLock = JSON.parse(
    readFileSync(`${root}/contracts/package-lock.json`, "utf8")
  );
  const contractsLockRoot = contractsLock.packages?.[""];
  const openZeppelinLock =
    contractsLock.packages?.[
      `node_modules/${manifest.contracts.openZeppelin.package}`
    ];
  const solhintLock = contractsLock.packages?.["node_modules/solhint"];
  const prettierLock = contractsLock.packages?.["node_modules/prettier"];
  const ajvLock = contractsLock.packages?.["node_modules/ajv"];
  const upstreamPins = JSON.parse(
    readFileSync(`${root}/chain/poc/upstream-baseline/pins.json`, "utf8")
  );
  record(
    "pnpm pin",
    packageJson.packageManager === `pnpm@${manifest.runtimes.pnpm.version}`,
    `packageManager=${packageJson.packageManager}`
  );
  record(
    "chain Node pin files",
    readFileSync(`${root}/chain/.node-version`, "utf8").trim() ===
      manifest.runtimes.node.version &&
      readFileSync(`${root}/chain/.nvmrc`, "utf8").trim() ===
        manifest.runtimes.node.version,
    `expected=${manifest.runtimes.node.version}`
  );
  record(
    "Cosmos EVM dependency pins",
    manifest.chain.cosmosEvm === upstreamPins.baseline.release &&
      manifest.chain.cosmosSdk === upstreamPins.baseline.modules.cosmosSdk &&
      manifest.chain.cometBft === upstreamPins.baseline.modules.cometBft &&
      manifest.runtimes.go.version === upstreamPins.baseline.go,
    `Cosmos EVM=${manifest.chain.cosmosEvm}; Cosmos SDK=${manifest.chain.cosmosSdk}; CometBFT=${manifest.chain.cometBft}; Go=${manifest.runtimes.go.version}`
  );
  record(
    "contract toolchain pins",
    manifest.contracts.foundry.version === "1.7.1" &&
      manifest.contracts.solidity.version === "0.8.30" &&
      manifest.contracts.solidity.longVersion === "0.8.30+commit.73712a01" &&
      manifest.contracts.solidity.binaryPath === "/usr/bin/solc" &&
      manifest.contracts.openZeppelin.version === "5.6.1" &&
      manifest.contracts.solhint.version === "5.0.5" &&
      manifest.contracts.formatter.foundryVersion ===
        manifest.contracts.foundry.version &&
      manifest.contracts.coverage.foundryVersion ===
        manifest.contracts.foundry.version &&
      manifest.contracts.analysis.foundryVersion ===
        manifest.contracts.foundry.version &&
      manifest.contracts.schemaValidator.version === "8.17.1" &&
      manifest.contracts.openZeppelin.release.endsWith(
        `/v${manifest.contracts.openZeppelin.version}`
      ) &&
      manifest.contracts.coverage.minimumLinePercent === 90 &&
      JSON.stringify(manifest.contracts.analysis.severities) ===
        JSON.stringify(["high", "med"]),
    `Foundry=${manifest.contracts.foundry.version}; solc=${manifest.contracts.solidity.version}; OpenZeppelin=${manifest.contracts.openZeppelin.version}; Solhint=${manifest.contracts.solhint.version}`
  );
  record(
    "contract dependency manifest",
    contractsPackage.private === true &&
      contractsPackage.dependencies?.[
        manifest.contracts.openZeppelin.package
      ] === manifest.contracts.openZeppelin.version &&
      contractsPackage.devDependencies?.ajv ===
        manifest.contracts.schemaValidator.version &&
      contractsPackage.devDependencies?.prettier ===
        manifest.quality.prettier.version &&
      contractsPackage.devDependencies?.solhint ===
        manifest.contracts.solhint.version,
    `Ajv=${contractsPackage.devDependencies?.ajv}; OpenZeppelin=${contractsPackage.dependencies?.[manifest.contracts.openZeppelin.package]}; Prettier=${contractsPackage.devDependencies?.prettier}; Solhint=${contractsPackage.devDependencies?.solhint}`
  );
  record(
    "contract dependency lock",
    contractsLock.lockfileVersion === 3 &&
      contractsLockRoot?.dependencies?.[
        manifest.contracts.openZeppelin.package
      ] === manifest.contracts.openZeppelin.version &&
      contractsLockRoot?.devDependencies?.solhint ===
        manifest.contracts.solhint.version &&
      contractsLockRoot?.devDependencies?.ajv ===
        manifest.contracts.schemaValidator.version &&
      contractsLockRoot?.devDependencies?.prettier ===
        manifest.quality.prettier.version &&
      openZeppelinLock?.version === manifest.contracts.openZeppelin.version &&
      /^sha512-/.test(openZeppelinLock?.integrity ?? "") &&
      ajvLock?.version === manifest.contracts.schemaValidator.version &&
      /^sha512-/.test(ajvLock?.integrity ?? "") &&
      prettierLock?.version === manifest.quality.prettier.version &&
      /^sha512-/.test(prettierLock?.integrity ?? "") &&
      solhintLock?.version === manifest.contracts.solhint.version &&
      /^sha512-/.test(solhintLock?.integrity ?? ""),
    `lockfileVersion=${contractsLock.lockfileVersion}; Ajv=${ajvLock?.version}; OpenZeppelin=${openZeppelinLock?.version}; Prettier=${prettierLock?.version}; Solhint=${solhintLock?.version}`
  );
}

validateManifest();
checkMinimum("host git", "git", ["--version"], manifest.hostMinimums.git);
checkMinimum(
  "host Docker",
  "docker",
  ["version", "--format", "{{.Client.Version}}"],
  manifest.hostMinimums.docker
);
checkMinimum(
  "host Docker Compose",
  "docker",
  ["compose", "version", "--short"],
  manifest.hostMinimums.dockerCompose
);

const hostNode = process.version.replace(/^v/, "");
record(
  "host Node bootstrap",
  atLeast(hostNode, "22.0.0"),
  `host=${hostNode}; canonical=${manifest.runtimes.node.version}; canonical commands run in the pinned container`
);

if (verifyImages) {
  checkImage(
    "canonical Node image",
    manifest.runtimes.node.image,
    "node",
    ["--version"],
    `v${manifest.runtimes.node.version}`
  );
  checkImage(
    "canonical pnpm",
    manifest.runtimes.node.image,
    "sh",
    [
      "-lc",
      `corepack prepare pnpm@${manifest.runtimes.pnpm.version} --activate >/dev/null && corepack pnpm --version`,
    ],
    manifest.runtimes.pnpm.version
  );
  checkImage(
    "canonical Go image",
    manifest.runtimes.go.image,
    "go",
    ["version"],
    `go${manifest.runtimes.go.version}`
  );
  checkImage(
    "Buf generator",
    manifest.protobuf.image,
    "buf",
    ["--version"],
    manifest.protobuf.bufVersion
  );
  checkImage(
    "protobuf clang-format",
    manifest.protobuf.image,
    "clang-format",
    ["--version"],
    manifest.protobuf.clangFormatVersion
  );
  checkImage(
    "Foundry",
    manifest.contracts.foundry.image,
    "cast",
    ["--version"],
    manifest.contracts.foundry.version
  );
  checkImage(
    "Solidity compiler",
    manifest.contracts.solidity.image,
    manifest.contracts.solidity.binaryPath,
    ["--version"],
    manifest.contracts.solidity.version
  );
  checkImage(
    "golangci-lint",
    manifest.quality.golangciLint.image,
    "golangci-lint",
    ["version"],
    manifest.quality.golangciLint.version
  );
  checkImage(
    "protolint",
    manifest.quality.protolint.image,
    "protolint",
    ["version"],
    manifest.quality.protolint.version
  );
  checkImage(
    "shfmt",
    manifest.quality.shfmt.image,
    "shfmt",
    ["--version"],
    manifest.quality.shfmt.version
  );
}

const failed = checks.filter((check) => check.required && !check.passed);
const report = {
  passed: failed.length === 0,
  mode: verifyImages ? "full" : "host-and-manifest",
  canonicalNode: manifest.runtimes.node.version,
  canonicalGo: manifest.runtimes.go.version,
  checks,
};

if (jsonOutput) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`Torium chain toolchain (${report.mode})\n`);
  for (const check of checks) {
    console.log(
      `${check.passed ? "PASS" : "FAIL"} ${check.name}: ${check.detail}`
    );
  }
  console.log(
    `\n${report.passed ? "Toolchain validation passed." : `${failed.length} required check(s) failed.`}`
  );
}

if (!report.passed) process.exit(1);
