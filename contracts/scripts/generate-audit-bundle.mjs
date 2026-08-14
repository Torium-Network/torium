#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const contractsRoot = path.resolve(path.dirname(scriptPath), "..");
const repositoryRoot = path.resolve(contractsRoot, "..");
const configPath = path.join(contractsRoot, "scripts/audit-bundle.config.json");
const outputDirectory = path.join(contractsRoot, ".artifacts/audit");
const manifestPath = path.join(outputDirectory, "audit-manifest.json");
const checksumsPath = path.join(outputDirectory, "SHA256SUMS");
const checkOnly = parseArguments(process.argv.slice(2));

const { manifest, manifestText, checksumsText } = await buildBundle();
if (checkOnly) {
  await assertFileEquals(manifestPath, manifestText);
  await assertFileEquals(checksumsPath, checksumsText);
  console.log(
    `Verified ${manifest.files.length} audit inputs at ${manifest.provenance.sourceCommit}.`
  );
} else {
  await mkdir(outputDirectory, { recursive: true });
  await writeFile(manifestPath, manifestText, "utf8");
  await writeFile(checksumsPath, checksumsText, "utf8");
  console.log(
    `Generated ${manifest.files.length} audit input checksums at ${manifest.provenance.sourceCommit}.`
  );
}

function parseArguments(argv) {
  if (argv.length === 0) return false;
  if (argv.length === 1 && argv[0] === "--check") return true;
  throw new Error("usage: generate-audit-bundle.mjs [--check]");
}

async function buildBundle() {
  const configBytes = await readFile(configPath);
  const config = JSON.parse(configBytes.toString("utf8"));
  validateConfig(config);
  await validateTestConfigurationOverrides(config.testConfigurationOverrides);

  const sourcePaths = await collectSourcePaths(config);
  assert.ok(sourcePaths.length > 0, "audit source scope is empty");
  const coverage = await collectCoverageEvidence(config.coverageSummary);

  const gitMetadata = await collectGitMetadata();
  const { sourceCommit, sourceTree } = gitMetadata;
  const toolchain = JSON.parse(
    await readRepositoryText("chain/toolchain.json")
  );
  const lockfile = JSON.parse(
    await readRepositoryText("contracts/package-lock.json")
  );
  const foundrySource = await readRepositoryText("contracts/foundry.toml");
  const foundryProfile = parseFoundryProfile(foundrySource, "profile.default");
  const fuzzProfile = parseFoundryProfile(foundrySource, "fuzz");
  const invariantProfile = parseFoundryProfile(foundrySource, "invariant");
  assert.equal(
    foundryProfile.solc_version,
    toolchain.contracts.solidity.version,
    "foundry.toml and chain/toolchain.json Solidity versions differ"
  );

  const files = [];
  for (const repositoryPath of sourcePaths) {
    const bytes = await readRepositoryBytes(repositoryPath);
    files.push({
      path: repositoryPath,
      kind: "source",
      bytes: bytes.length,
      sha256: sha256(bytes),
    });
  }
  files.sort((left, right) => left.path.localeCompare(right.path, "en"));
  const scopeDigestSha256 = sha256(
    Buffer.from(
      `${files
        .map((file) => `${file.sha256} ${file.bytes} ${file.path}`)
        .join("\n")}\n`,
      "utf8"
    )
  );
  const sourceCommitCoverageExceptions = collectCommitCoverageExceptions(
    sourcePaths,
    gitMetadata
  );

  const manifest = {
    schemaVersion: 1,
    bundleId: config.bundleId,
    hashAlgorithm: config.hashAlgorithm,
    provenance: {
      sourceCommit,
      sourceTree,
      sourceCommitIsRuntimeMetadata: true,
      primaryContentIdentity: "scopeDigestSha256",
      scopeDigestSha256,
      allRequiredSourceFilesMatchSourceCommit:
        sourceCommitCoverageExceptions.length === 0,
      sourceCommitCoverageExceptions,
      networkRequired: false,
      liveDeploymentOrRpcEvidenceIncluded: false,
    },
    compiler: {
      solidity: {
        version: toolchain.contracts.solidity.version,
        longVersion: toolchain.contracts.solidity.longVersion,
        image: toolchain.contracts.solidity.image,
        binaryPath: toolchain.contracts.solidity.binaryPath,
      },
      foundry: {
        version: toolchain.contracts.foundry.version,
        image: toolchain.contracts.foundry.image,
      },
      settings: foundryProfile,
    },
    runtime: {
      node: {
        version: toolchain.runtimes.node.version,
        image: toolchain.runtimes.node.image,
      },
    },
    testEvidence: {
      configuration: {
        fuzz: fuzzProfile,
        invariant: invariantProfile,
        overrides: config.testConfigurationOverrides,
      },
      coverage,
    },
    dependencies: collectDependencies(config, lockfile),
    scope: {
      includedFileCount: files.length,
      requiredSourceFileCount: sourcePaths.length,
      exclusions: config.exclusions,
    },
    files,
  };
  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
  const checksumEntries = [
    {
      path: "contracts/.artifacts/audit/audit-manifest.json",
      sha256: sha256(Buffer.from(manifestText, "utf8")),
    },
    ...files,
  ].sort((left, right) => left.path.localeCompare(right.path, "en"));
  const checksumsText = `${checksumEntries
    .map(
      (entry) =>
        `${entry.sha256}  ${path.posix.relative(
          "contracts/.artifacts/audit",
          entry.path
        )}`
    )
    .join("\n")}\n`;
  return { manifest, manifestText, checksumsText };
}

function validateConfig(config) {
  assert.equal(config.schemaVersion, 1);
  assert.match(config.bundleId, /^[a-z0-9]+(?:-[a-z0-9]+)*$/u);
  assert.equal(config.hashAlgorithm, "sha256");
  assertRepositoryPath(config.coverageSummary);
  assert.ok(Array.isArray(config.testConfigurationOverrides));
  for (const override of config.testConfigurationOverrides) {
    assert.deepEqual(Object.keys(override).sort(), [
      "contract",
      "invariantDepth",
      "invariantRuns",
      "reason",
      "source",
    ]);
    assert.match(override.contract, /^[A-Za-z][A-Za-z0-9]*$/u);
    assertRepositoryPath(override.source);
    assert.ok(Number.isInteger(override.invariantRuns));
    assert.ok(override.invariantRuns > 0);
    assert.ok(Number.isInteger(override.invariantDepth));
    assert.ok(override.invariantDepth > 0);
    assert.ok(override.reason.length > 40);
  }
  assert.ok(Array.isArray(config.sourceFiles));
  assert.ok(Array.isArray(config.sourceTrees));
  assert.ok(Array.isArray(config.directDependencies));
  assert.ok(Array.isArray(config.exclusions));
  for (const exclusion of config.exclusions) {
    assert.deepEqual(Object.keys(exclusion).sort(), ["path", "reason"]);
    assert.ok(exclusion.path.length > 0 && exclusion.reason.length > 0);
  }
}

async function validateTestConfigurationOverrides(overrides) {
  for (const override of overrides) {
    const source = await readRepositoryText(override.source);
    const marker = `contract ${override.contract}`;
    const markerIndex = source.indexOf(marker);
    assert.ok(
      markerIndex >= 0,
      `${override.contract} is missing from ${override.source}`
    );
    const prefix = source.slice(Math.max(0, markerIndex - 240), markerIndex);
    assert.match(
      prefix,
      new RegExp(
        `forge-config: default\\.invariant\\.runs = ${override.invariantRuns}\\s+[\\s\\S]*forge-config: default\\.invariant\\.depth = ${override.invariantDepth}\\s*$`,
        "u"
      ),
      `${override.contract} inline invariant config differs from audit config`
    );
  }
}

async function collectSourcePaths(config) {
  const paths = new Set();
  for (const repositoryPath of config.sourceFiles) {
    assertRepositoryPath(repositoryPath);
    await assertRegularFile(repositoryPath);
    paths.add(repositoryPath);
  }
  for (const tree of config.sourceTrees) {
    assert.deepEqual(Object.keys(tree).sort(), ["extensions", "path"]);
    assertRepositoryPath(tree.path);
    assert.ok(Array.isArray(tree.extensions) && tree.extensions.length > 0);
    const absoluteTree = resolveRepositoryPath(tree.path);
    for (const absolutePath of await walkFiles(absoluteTree)) {
      if (tree.extensions.includes(path.extname(absolutePath))) {
        paths.add(toRepositoryPath(absolutePath));
      }
    }
  }
  return [...paths].sort((left, right) => left.localeCompare(right, "en"));
}

async function collectCoverageEvidence(repositoryPath) {
  const source = await readRepositoryText(repositoryPath);
  const totalLine = source
    .split(/\r?\n/u)
    .find((line) => /^\| Total\s+\|/u.test(line));
  assert.ok(totalLine, `${repositoryPath} has no Total coverage row`);
  const cells = totalLine
    .split("|")
    .slice(2, 6)
    .map((cell) => cell.trim());
  assert.equal(cells.length, 4, "coverage Total row has unexpected columns");
  return {
    source: repositoryPath,
    normalized: true,
    lines: parseCoverageMetric(cells[0], "lines"),
    statements: parseCoverageMetric(cells[1], "statements"),
    branches: parseCoverageMetric(cells[2], "branches"),
    functions: parseCoverageMetric(cells[3], "functions"),
  };
}

function parseCoverageMetric(value, label) {
  const match = value.match(/^(\d+(?:\.\d+)?)% \((\d+)\/(\d+)\)$/u);
  assert.ok(match, `invalid ${label} coverage metric: ${value}`);
  return {
    percent: Number(match[1]),
    covered: Number(match[2]),
    total: Number(match[3]),
  };
}

async function walkFiles(directory) {
  const results = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`symlink is not allowed in audit scope: ${absolutePath}`);
    }
    if (entry.isDirectory()) results.push(...(await walkFiles(absolutePath)));
    else if (entry.isFile()) results.push(absolutePath);
  }
  return results.sort((left, right) => left.localeCompare(right, "en"));
}

async function collectGitMetadata() {
  const environment = process.env;
  const supplied = [
    environment.TORIUM_AUDIT_SOURCE_COMMIT,
    environment.TORIUM_AUDIT_SOURCE_TREE,
    environment.TORIUM_AUDIT_TRACKED_PATHS_FILE,
    environment.TORIUM_AUDIT_CHANGED_PATHS_FILE,
  ];
  if (supplied.some(Boolean)) {
    assert.ok(
      supplied.every(Boolean),
      "incomplete audit Git metadata environment"
    );
    const sourceCommit = environment.TORIUM_AUDIT_SOURCE_COMMIT;
    const sourceTree = environment.TORIUM_AUDIT_SOURCE_TREE;
    assert.match(sourceCommit, /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u);
    assert.match(sourceTree, /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u);
    return {
      sourceCommit,
      sourceTree,
      trackedAtHead: new Set(
        splitNonemptyLines(
          await readFile(environment.TORIUM_AUDIT_TRACKED_PATHS_FILE, "utf8")
        )
      ),
      changedFromHead: new Set(
        splitNonemptyLines(
          await readFile(environment.TORIUM_AUDIT_CHANGED_PATHS_FILE, "utf8")
        )
      ),
    };
  }
  return {
    sourceCommit: git(["rev-parse", "HEAD"]),
    sourceTree: git(["rev-parse", "HEAD^{tree}"]),
    trackedAtHead: new Set(
      git(["ls-tree", "-r", "--name-only", "HEAD"]).split("\n")
    ),
    changedFromHead: new Set(
      splitNonemptyLines(git(["diff", "--name-only", "HEAD"], true))
    ),
  };
}

function collectCommitCoverageExceptions(sourcePaths, gitMetadata) {
  const exceptions = [];
  for (const repositoryPath of sourcePaths) {
    if (!gitMetadata.trackedAtHead.has(repositoryPath)) {
      exceptions.push({ path: repositoryPath, state: "not-in-source-commit" });
    } else if (gitMetadata.changedFromHead.has(repositoryPath)) {
      exceptions.push({
        path: repositoryPath,
        state: "differs-from-source-commit",
      });
    }
  }
  return exceptions;
}

function splitNonemptyLines(value) {
  return value.split(/\r?\n/u).filter((line) => line.length > 0);
}

function collectDependencies(config, lockfile) {
  const root = lockfile.packages?.[""];
  assert.ok(root, "package-lock root package is missing");
  return [...config.directDependencies]
    .sort((left, right) => left.localeCompare(right, "en"))
    .map((name) => {
      const dependencyGroup = Object.hasOwn(root.dependencies ?? {}, name)
        ? "dependencies"
        : Object.hasOwn(root.devDependencies ?? {}, name)
          ? "devDependencies"
          : null;
      assert.ok(dependencyGroup, `${name} is not a direct dependency`);
      const requested = root[dependencyGroup][name];
      const locked = lockfile.packages[`node_modules/${name}`];
      assert.ok(locked, `${name} is not present in package-lock.json`);
      assert.equal(
        requested,
        locked.version,
        `${name} must use an exact direct version pin`
      );
      return {
        name,
        dependencyGroup,
        requested,
        version: locked.version,
        resolved: locked.resolved,
        integrity: locked.integrity,
        license: locked.license,
      };
    });
}

function parseFoundryProfile(source, profileName) {
  const settings = {};
  let inProfile = false;
  for (const rawLine of source.split(/\r?\n/u)) {
    const line = rawLine.replace(/\s+#.*$/u, "").trim();
    if (line.startsWith("[") && line.endsWith("]")) {
      inProfile = line === `[${profileName}]`;
      continue;
    }
    if (!inProfile || line === "") continue;
    const match = line.match(/^([a-z_]+)\s*=\s*(.+)$/u);
    assert.ok(match, `unsupported foundry.toml line: ${rawLine}`);
    settings[match[1]] = parseTomlScalar(match[2]);
  }
  assert.ok(Object.keys(settings).length > 0, `[${profileName}] is missing`);
  return settings;
}

function parseTomlScalar(value) {
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^[0-9]+$/u.test(value)) return Number(value);
  if (value.startsWith('"') || value.startsWith("[")) return JSON.parse(value);
  throw new Error(`unsupported TOML value: ${value}`);
}

async function assertRegularFile(repositoryPath) {
  const stats = await lstat(resolveRepositoryPath(repositoryPath));
  assert.ok(
    stats.isFile() && !stats.isSymbolicLink(),
    `${repositoryPath} is not a regular file`
  );
}

async function readRepositoryBytes(repositoryPath) {
  assertRepositoryPath(repositoryPath);
  await assertRegularFile(repositoryPath);
  return readFile(resolveRepositoryPath(repositoryPath));
}

async function readRepositoryText(repositoryPath) {
  return (await readRepositoryBytes(repositoryPath)).toString("utf8");
}

function resolveRepositoryPath(repositoryPath) {
  const absolutePath = path.resolve(repositoryRoot, repositoryPath);
  const prefix = `${repositoryRoot}${path.sep}`;
  assert.ok(
    absolutePath.startsWith(prefix),
    `path escapes repository: ${repositoryPath}`
  );
  return absolutePath;
}

function toRepositoryPath(absolutePath) {
  const repositoryPath = path.relative(repositoryRoot, absolutePath);
  assertRepositoryPath(repositoryPath);
  return repositoryPath.split(path.sep).join(path.posix.sep);
}

function assertRepositoryPath(repositoryPath) {
  assert.equal(typeof repositoryPath, "string");
  assert.ok(repositoryPath.length > 0 && !path.isAbsolute(repositoryPath));
  assert.equal(
    repositoryPath,
    repositoryPath.split(path.sep).join(path.posix.sep)
  );
  assert.ok(!repositoryPath.split("/").includes(".."));
}

function git(arguments_, allowEmpty = false) {
  const output = execFileSync("git", arguments_, {
    cwd: repositoryRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  if (!allowEmpty)
    assert.ok(output.length > 0, `git ${arguments_[0]} returned no output`);
  return output;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function assertFileEquals(filePath, expected) {
  const actual = await readFile(filePath, "utf8");
  assert.equal(
    actual,
    expected,
    `${path.relative(repositoryRoot, filePath)} is stale; regenerate it`
  );
}
