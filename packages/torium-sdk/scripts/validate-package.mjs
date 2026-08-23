#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { gzipSync } from "node:zlib";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { rollup } from "rollup";

const packageDirectory = join(dirname(fileURLToPath(import.meta.url)), "..");
const root = join(packageDirectory, "../..");
const require = createRequire(join(packageDirectory, "package.json"));
const tsc = require.resolve("typescript/bin/tsc");
const writeSnapshots = process.argv.includes("--write");
const [manifest, policy] = await Promise.all([
  json(join(packageDirectory, "package.json")),
  json(join(root, "chain/config/sdk-policy-v0.json")),
]);

assert.equal(manifest.name, policy.package.name);
assert.equal(manifest.private, policy.package.privateUntilApproved);
assert.equal(manifest.sideEffects, policy.modules.sideEffects);
assert.equal(manifest.license, "Apache-2.0");
assert.equal(manifest.peerDependencies.viem, policy.baseline.viem.peerRange);
assert.equal(manifest.engines.node, policy.runtimes.node.range);
assert.equal(manifest.publishConfig.access, policy.package.publishAccess);
assert.deepEqual(manifest.dependencies, undefined);

const policyExports = policy.modules.exports.toSorted();
assert.deepEqual(
  Object.keys(manifest.exports)
    .filter((entry) => entry !== "./package.json")
    .sort(),
  policyExports
);

const apiEntries = {};
for (const exportName of policyExports) {
  const entry = manifest.exports[exportName];
  assert.deepEqual(Object.keys(entry).sort(), ["import", "require"]);
  assert.deepEqual(Object.keys(entry.import).sort(), ["default", "types"]);
  assert.deepEqual(Object.keys(entry.require).sort(), ["default", "types"]);

  for (const target of [
    entry.import.types,
    entry.import.default,
    entry.require.types,
    entry.require.default,
  ]) {
    assert.equal(isAbsolute(target), false);
    assert.equal((await stat(join(packageDirectory, target))).isFile(), true);
  }

  const [importDeclaration, requireDeclaration] = await Promise.all([
    readFile(join(packageDirectory, entry.import.types), "utf8"),
    readFile(join(packageDirectory, entry.require.types), "utf8"),
  ]);
  assert.equal(importDeclaration, requireDeclaration);
  const runtime = await import(
    pathToFileURL(join(packageDirectory, entry.import.default))
  );
  apiEntries[exportName] = {
    importTypes: entry.import.types,
    requireTypes: entry.require.types,
    declarationSha256: sha256(importDeclaration),
    runtimeExports: Object.keys(runtime).sort(),
    declaration: importDeclaration.trimEnd(),
  };
}

const apiReport = {
  schemaVersion: 1,
  package: manifest.name,
  packageVersion: manifest.version,
  policyVersion: policy.policyVersion,
  entries: apiEntries,
};

const distFiles = await walk(join(packageDirectory, "dist"));
const prohibited = [
  root,
  packageDirectory,
  "packages/backend",
  "CLERK_SECRET_KEY",
  "DATABASE_URL",
  "REDIS_URL",
  "PRIVATE_KEY=",
  "MNEMONIC=",
];

for (const file of distFiles) {
  const contents = await readFile(file);
  const text = contents.toString("utf8");
  for (const value of prohibited) {
    assert.equal(
      text.includes(value),
      false,
      `${relative(packageDirectory, file)} contains ${value}`
    );
  }

  if (file.endsWith(".map")) {
    const sourceMap = JSON.parse(text);
    assert.ok(sourceMap.sources.every((source) => !isAbsolute(source)));
  }
}

const rootEntry = await readFile(
  join(packageDirectory, manifest.exports["."].import.default)
);
assert.ok(
  gzipSync(rootEntry).byteLength <=
    policy.budgets.rootEntryGzipBytesExcludingViem,
  "root ESM entry exceeds the gzip budget"
);

run(join(packageDirectory, "node_modules/.bin/publint"), ["--strict"], {
  cwd: packageDirectory,
});
run(
  join(packageDirectory, "node_modules/.bin/attw"),
  ["--pack", "--profile", "node16", "--quiet", "."],
  { cwd: packageDirectory }
);

const temporaryDirectory = await mkdtemp(join(tmpdir(), "torium-sdk-package-"));
try {
  const pack = run(
    "npm",
    ["pack", "--json", "--pack-destination", temporaryDirectory],
    { cwd: packageDirectory }
  );
  const [packResult] = JSON.parse(pack.stdout);
  assert.ok(
    packResult.size <= policy.budgets.packedTarballBytes,
    "tarball exceeds budget"
  );

  const packedFiles = await Promise.all(
    packResult.files.map(async ({ path }) => {
      const contents = await readFile(join(packageDirectory, path));
      return { path, bytes: contents.byteLength, sha256: sha256(contents) };
    })
  );
  const packageFiles = {
    schemaVersion: 2,
    package: manifest.name,
    packageVersion: manifest.version,
    files: packedFiles.toSorted(({ path: left }, { path: right }) =>
      left.localeCompare(right)
    ),
  };

  await textSnapshot(
    `api/${manifest.version}.api.md`,
    renderApiReport(apiReport)
  );
  await jsonSnapshot("api/package-files.json", packageFiles);

  const fixture = join(temporaryDirectory, "fixture");
  await writeFile(
    join(temporaryDirectory, "package.json"),
    `${JSON.stringify({ name: "torium-sdk-clean-fixture", private: true }, null, 2)}\n`
  );
  run(
    "npm",
    [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--package-lock=false",
      "--prefer-offline",
      join(temporaryDirectory, packResult.filename),
      `viem@${policy.baseline.viem.testedVersion}`,
    ],
    { cwd: temporaryDirectory }
  );

  await writeFile(
    `${fixture}.mjs`,
    [
      'import { toriumSdkPolicyVersion, toriumSdkVersion } from "@torium-network/sdk";',
      'import { toriumLocalnet, toriumTestnet } from "@torium-network/sdk/chains";',
      'if (toriumSdkVersion !== "0.1.2" || toriumSdkPolicyVersion !== "0.1.0") process.exit(1);',
      "if (toriumLocalnet.id !== 1414484556 || toriumTestnet.rpcUrls.default.http.length !== 0) process.exit(1);",
      ...policyExports
        .filter((entry) => entry !== ".")
        .map(
          (entry) => `await import("@torium-network/sdk/${entry.slice(2)}");`
        ),
      "",
    ].join("\n")
  );
  await writeFile(
    `${fixture}.cjs`,
    [
      'const sdk = require("@torium-network/sdk");',
      'const chains = require("@torium-network/sdk/chains");',
      'if (sdk.toriumSdkVersion !== "0.1.2" || sdk.toriumSdkPolicyVersion !== "0.1.0") process.exit(1);',
      "if (chains.toriumLocalnet.id !== 1414484556 || chains.toriumMainnet.rpcUrls.default.http.length !== 0) process.exit(1);",
      ...policyExports
        .filter((entry) => entry !== ".")
        .map((entry) => `require("@torium-network/sdk/${entry.slice(2)}");`),
      "",
    ].join("\n")
  );
  await writeFile(
    `${fixture}.mts`,
    [
      'import { toriumSdkPolicyVersion, toriumSdkVersion } from "@torium-network/sdk";',
      'import { toriumLocalnet, toriumTestnet, validateToriumEndpoint, withToriumRpcUrls } from "@torium-network/sdk/chains";',
      'import { createToriumPublicClient } from "@torium-network/sdk/clients";',
      'import { isToriumSdkError, normalizeToriumError, ToriumSdkError, type ToriumDiagnosticEvent } from "@torium-network/sdk/errors";',
      'import { createToriumWalletClient, preflightToriumTransaction, sendToriumTransactionOnce, waitForToriumTransaction } from "@torium-network/sdk/wallet";',
      'import { getToriumChainById, parseToriumAmount, toriumEvmAddressToBech32, toriumNativeCurrencies } from "@torium-network/sdk/utils";',
      'import { http } from "viem";',
      ...policyExports
        .filter((entry) => entry !== ".")
        .map((entry) => `import "@torium-network/sdk/${entry.slice(2)}";`),
      'const versions: readonly ["0.1.2", "0.1.0"] = [toriumSdkVersion, toriumSdkPolicyVersion];',
      'const callerChain = withToriumRpcUrls(toriumTestnet, { http: ["https://rpc.caller.example"] });',
      'const callerUrl: "https://rpc.caller.example" = callerChain.rpcUrls.default.http[0];',
      "const chainId: 1414484556 = toriumLocalnet.id;",
      'const parsedAmount: bigint = parseToriumAmount("1.25");',
      'const bech32Account: `torium1${string}` = toriumEvmAddressToBech32("0x0000000000000000000000000000000000000001");',
      "const utilityChainId: 1414484556 | 1414484548 | 1414484564 | 5525330 = getToriumChainById(1414484556).id;",
      'const localSymbol: "tTOR" = toriumNativeCurrencies.localnet.symbol;',
      'const mainnetSymbol: "TOR" = toriumNativeCurrencies.mainnet.symbol;',
      'const mainnetValueStatus: "inactive-prelaunch-no-value-claim" = toriumNativeCurrencies.mainnet.valueStatus;',
      "// @ts-expect-error Native amount parsing never accepts JavaScript numbers.",
      "parseToriumAmount(1.25);",
      "const client = createToriumPublicClient({ chain: callerChain, transport: http() });",
      "const wallet = createToriumWalletClient({ chain: callerChain, transport: http() });",
      'declare const localAccount: import("viem").LocalAccount;',
      "const localWallet = createToriumWalletClient({ account: localAccount, chain: callerChain, transport: http() });",
      'const transactionRequest = { account: "0x0000000000000000000000000000000000000001", to: "0x0000000000000000000000000000000000000002", value: 1n } as const;',
      'const preflight: Promise<import("@torium-network/sdk/wallet").ToriumTransactionPreflight> = preflightToriumTransaction(client, transactionRequest, { retry: { maxAttempts: 3 }, timeoutMs: 5_000 });',
      'const submission: Promise<import("@torium-network/sdk/wallet").ToriumSubmissionAcknowledgement> = sendToriumTransactionOnce(wallet, client, transactionRequest, { authorize: async () => true });',
      'const localSubmission: Promise<import("@torium-network/sdk/wallet").ToriumSubmissionAcknowledgement> = sendToriumTransactionOnce(localWallet, client, { ...transactionRequest, account: localAccount }, { authorize: async () => true });',
      'const lifecycle: Promise<import("@torium-network/sdk/wallet").ToriumTransactionLifecycle> = waitForToriumTransaction(client, { hash: `0x${"00".repeat(32)}` });',
      'const balance: Promise<bigint> = client.getBalance({ address: "0x0000000000000000000000000000000000000001" });',
      'const status: Promise<import("@torium-network/sdk/clients").ToriumNetworkStatus> = client.getToriumNetworkStatus({ retry: { maxAttempts: 3 }, timeoutMs: 5_000, diagnostics(event: ToriumDiagnosticEvent) { void event.category; } });',
      'const normalized: ToriumSdkError = normalizeToriumError(new Error("upstream"), { operation: "fixture", kind: "read" });',
      "const normalizedCheck: boolean = isToriumSdkError(normalized);",
      "declare const maybeToriumError: unknown;",
      'if (isToriumSdkError(maybeToriumError)) { const code: import("@torium-network/sdk/errors").ToriumErrorCode = maybeToriumError.code; if (code === "TORIUM_CHAIN_ID_MISMATCH") void code; }',
      "// @ts-expect-error A Torium public client requires a canonical Torium chain.",
      "createToriumPublicClient({ transport: http() });",
      "// @ts-expect-error A Torium wallet client requires a canonical Torium chain.",
      "createToriumWalletClient({ transport: http() });",
      "// @ts-expect-error The stable helper does not permit disabling chain assertions.",
      "sendToriumTransactionOnce(wallet, client, { ...transactionRequest, assertChainId: false }, { authorize: async () => true });",
      "// @ts-expect-error An unhoisted wallet request still requires an explicit account.",
      "sendToriumTransactionOnce(wallet, client, { to: transactionRequest.to, value: 1n }, { authorize: async () => true });",
      "// @ts-expect-error Broadcast helpers never accept automatic retry configuration.",
      "sendToriumTransactionOnce(wallet, client, transactionRequest, { authorize: async () => true, retry: { maxAttempts: 2 } });",
      'const provider: Pick<import("viem").EIP1193Provider, "request"> = { async request() { return undefined as any; } };',
      "const clientValidation = validateToriumEndpoint(client, { chain: toriumLocalnet, minimumBlockNumber: 1n });",
      'const providerValidation = validateToriumEndpoint(provider, { chain: toriumLocalnet, requireCompatibility: true, compatibilityChecks: [{ kind: "protocol", async check() { return true; } }] });',
      "void client.getBlockNumber;",
      "void balance;",
      "void preflight;",
      "void submission;",
      "void localSubmission;",
      "void lifecycle;",
      "void status;",
      "void normalized;",
      "void normalizedCheck;",
      "void clientValidation;",
      "void callerChain;",
      "void callerUrl;",
      "void chainId;",
      "void parsedAmount;",
      "void bech32Account;",
      "void utilityChainId;",
      "void localSymbol;",
      "void mainnetSymbol;",
      "void mainnetValueStatus;",
      "void providerValidation;",
      "void versions;",
      "",
    ].join("\n")
  );
  await writeFile(
    `${fixture}.cts`,
    [
      'import sdk = require("@torium-network/sdk");',
      'import chains = require("@torium-network/sdk/chains");',
      'import clients = require("@torium-network/sdk/clients");',
      'import utils = require("@torium-network/sdk/utils");',
      'import viem = require("viem");',
      'const versions: readonly ["0.1.2", "0.1.0"] = [sdk.toriumSdkVersion, sdk.toriumSdkPolicyVersion];',
      "const chainId: 1414484556 = chains.toriumLocalnet.id;",
      'const parsedAmount: bigint = utils.parseToriumAmount("1.25");',
      'const bech32Account: `torium1${string}` = utils.toriumEvmAddressToBech32("0x0000000000000000000000000000000000000001");',
      'const localSymbol: "tTOR" = utils.toriumNativeCurrencies.localnet.symbol;',
      'const mainnetSymbol: "TOR" = utils.toriumNativeCurrencies.mainnet.symbol;',
      "// @ts-expect-error Native amount parsing never accepts JavaScript numbers.",
      "utils.parseToriumAmount(1.25);",
      'const callerChain = chains.withToriumRpcUrls(chains.toriumTestnet, { http: ["https://rpc.caller.example"] });',
      'const callerUrl: "https://rpc.caller.example" = callerChain.rpcUrls.default.http[0];',
      "const client = clients.createToriumPublicClient({ chain: callerChain, transport: viem.http() });",
      'const balance: Promise<bigint> = client.getBalance({ address: "0x0000000000000000000000000000000000000001" });',
      "const status: Promise<clients.ToriumNetworkStatus> = client.getToriumNetworkStatus();",
      "// @ts-expect-error A Torium public client requires a canonical Torium chain.",
      "clients.createToriumPublicClient({ transport: viem.http() });",
      'const provider: Pick<viem.EIP1193Provider, "request"> = { async request() { return undefined as any; } };',
      "const clientValidation = chains.validateToriumEndpoint(client, { chain: chains.toriumLocalnet, minimumBlockNumber: 1n });",
      'const providerValidation = chains.validateToriumEndpoint(provider, { chain: chains.toriumLocalnet, requireCompatibility: true, compatibilityChecks: [{ kind: "contract", async check() { return true; } }] });',
      ...policyExports
        .filter((entry) => entry !== ".")
        .map(
          (entry, index) =>
            `import subpath${index} = require("@torium-network/sdk/${entry.slice(2)}");`
        ),
      ...policyExports
        .filter((entry) => entry !== ".")
        .map((_, index) => `void subpath${index};`),
      "void versions;",
      "void callerChain;",
      "void callerUrl;",
      "void chainId;",
      "void parsedAmount;",
      "void bech32Account;",
      "void localSymbol;",
      "void mainnetSymbol;",
      "void client.getBlockNumber;",
      "void balance;",
      "void status;",
      "void clientValidation;",
      "void providerValidation;",
      "",
    ].join("\n")
  );
  await writeFile(
    join(temporaryDirectory, "tsconfig.json"),
    `${JSON.stringify(
      {
        compilerOptions: {
          target: "ES2022",
          module: "NodeNext",
          moduleResolution: "NodeNext",
          strict: true,
          noEmit: true,
          skipLibCheck: false,
        },
        files: [`${fixture}.mts`, `${fixture}.cts`],
      },
      null,
      2
    )}\n`
  );
  await writeFile(
    join(temporaryDirectory, "tree-shake-unused.mjs"),
    [
      'import { createToriumPublicClient } from "@torium-network/sdk/clients";',
      'console.log("tree-shake-fixture");',
      "void createToriumPublicClient;",
      "",
    ].join("\n")
  );
  await writeFile(
    join(temporaryDirectory, "tree-shake-used.mjs"),
    'export { createToriumPublicClient } from "@torium-network/sdk/clients";\n'
  );

  run(process.execPath, [`${fixture}.mjs`], { cwd: temporaryDirectory });
  run(process.execPath, [`${fixture}.cjs`], { cwd: temporaryDirectory });
  run(process.execPath, [tsc, "-p", "tsconfig.json"], {
    cwd: temporaryDirectory,
  });

  const installedPackageDirectory = join(
    temporaryDirectory,
    "node_modules/@torium-network/sdk"
  );
  const installedManifest = await json(
    join(installedPackageDirectory, "package.json")
  );
  assert.equal(installedManifest.sideEffects, false);
  const unusedConsumerCode = await bundleFixture(
    join(temporaryDirectory, "tree-shake-unused.mjs"),
    installedPackageDirectory,
    installedManifest
  );
  assert.equal(unusedConsumerCode.includes("createToriumPublicClient"), false);
  assert.equal(unusedConsumerCode.includes("viem"), false);

  const usedConsumerCode = await bundleFixture(
    join(temporaryDirectory, "tree-shake-used.mjs"),
    installedPackageDirectory,
    installedManifest
  );
  assert.equal(usedConsumerCode.includes("createToriumPublicClient"), true);
  assert.equal(usedConsumerCode.includes("viem"), true);
  assert.ok(
    gzipSync(usedConsumerCode).byteLength <=
      policy.budgets.rootEntryGzipBytesExcludingViem,
    "used SDK consumer bundle exceeds the gzip budget excluding viem"
  );

  console.log(
    `Validated ${manifest.name}@${manifest.version}: ${packageFiles.files.length} hashed packed files, ${packResult.size} bytes`
  );
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}

async function textSnapshot(path, serialized) {
  const target = join(packageDirectory, path);
  if (writeSnapshots) {
    await writeFile(target, serialized);
    return;
  }
  assert.equal(
    await readFile(target, "utf8"),
    serialized,
    `${path} drifted; regenerate and review`
  );
}

async function jsonSnapshot(path, value) {
  await textSnapshot(path, `${JSON.stringify(value, null, 2)}\n`);
}

function renderApiReport(report) {
  const lines = [
    `# Public API report: ${report.package}@${report.packageVersion}`,
    "",
    `Policy version: \`${report.policyVersion}\``,
    "",
    "This file is generated and byte-compared during package validation. Review declaration changes before updating it.",
    "",
  ];
  for (const [exportName, entry] of Object.entries(report.entries)) {
    lines.push(
      `## \`${exportName}\``,
      "",
      `- Import types: \`${entry.importTypes}\``,
      `- Require types: \`${entry.requireTypes}\``,
      `- Declaration SHA-256: \`${entry.declarationSha256}\``,
      `- Runtime exports: ${entry.runtimeExports.length === 0 ? "none" : entry.runtimeExports.map((value) => `\`${value}\``).join(", ")}`,
      "",
      "```ts",
      entry.declaration,
      "```",
      ""
    );
  }
  return lines.join("\n");
}

async function bundleFixture(
  input,
  installedPackageDirectory,
  installedManifest
) {
  const clientsExport = installedManifest.exports["./clients"].import.default;
  const bundle = await rollup({
    input,
    external: ["viem"],
    treeshake: {
      moduleSideEffects(id, external) {
        return external && id === "viem" ? false : true;
      },
    },
    plugins: [
      {
        name: "torium-sdk-installed-export-map-resolution",
        resolveId(source) {
          if (source !== "@torium-network/sdk/clients") return null;
          return {
            id: join(installedPackageDirectory, clientsExport),
            moduleSideEffects: installedManifest.sideEffects !== false,
          };
        },
      },
    ],
    onLog(level, log, handler) {
      if (log.code === "EMPTY_BUNDLE") return;
      handler(level, log);
    },
  });
  const generated = await bundle.generate({ format: "esm" });
  await bundle.close();
  return generated.output
    .filter(({ type }) => type === "chunk")
    .map(({ code }) => code)
    .join("\n");
}

function run(command, args, options) {
  const result = spawnSync(command, args, { ...options, encoding: "utf8" });
  if (result.status !== 0) {
    process.stderr.write(result.stdout);
    process.stderr.write(result.stderr);
    process.exit(result.status ?? 1);
  }
  return result;
}

async function json(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map((entry) => {
      const path = join(directory, entry.name);
      return entry.isDirectory() ? walk(path) : [path];
    })
  );
  return files.flat().sort();
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
