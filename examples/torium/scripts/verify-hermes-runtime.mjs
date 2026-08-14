import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const exampleRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
const matrix = JSON.parse(
  await readFile(path.join(exampleRoot, "runtime-matrix.json"), "utf8")
);
const outputRoot = await mkdtemp(path.join(tmpdir(), "torium-hermes-runtime-"));
const bundle = path.join(outputRoot, "runtime.hbc");
const sourceMap = path.join(outputRoot, "runtime.map");
const hermesBinary = path.join(
  exampleRoot,
  "node_modules/react-native/sdks/hermesc",
  process.platform === "darwin"
    ? "osx-bin/hermesc"
    : process.platform === "win32"
      ? "win64-bin/hermesc.exe"
      : "linux64-bin/hermesc"
);

try {
  const hermesVersion = capture(hermesBinary, ["-version"], exampleRoot);
  assert.match(
    hermesVersion,
    new RegExp(
      `HBC bytecode version: ${matrix.reactNative.bytecodeVersion}`,
      "u"
    ),
    "installed Hermes bytecode version drifted from runtime-matrix.json"
  );

  run(
    "pnpm",
    [
      "exec",
      "expo",
      "export:embed",
      "--config",
      path.join(exampleRoot, "react-native/metro.runtime.config.cjs"),
      "--entry-file",
      "examples/torium/react-native/runtime-entry.ts",
      "--platform",
      "android",
      "--dev",
      "false",
      "--minify",
      "true",
      "--bundle-output",
      bundle,
      "--sourcemap-output",
      sourceMap,
      "--unstable-transform-profile",
      "hermes",
      "--bytecode",
      "--max-workers",
      "2",
    ],
    exampleRoot
  );

  const bundleBytes = (await stat(bundle)).size;
  assert.ok(
    bundleBytes <= matrix.reactNative.maximumBytecodeBytes,
    `Hermes bytecode ${bundleBytes} exceeds ${matrix.reactNative.maximumBytecodeBytes}`
  );
  const map = JSON.parse(await readFile(sourceMap, "utf8"));
  assert.ok(Array.isArray(map.sources), "Hermes source map has no sources");
  assert.ok(
    map.sources.length <= matrix.reactNative.maximumSourceModules,
    `Hermes module count ${map.sources.length} exceeds ${matrix.reactNative.maximumSourceModules}`
  );
  assert.ok(
    map.sources.some((source) =>
      source.endsWith("react-native/runtime-entry.ts")
    ),
    "Hermes bundle omitted the runtime fixture"
  );
  assert.ok(
    map.sources.some((source) => source.includes("packages/torium-sdk/")),
    "Hermes bundle omitted the Torium SDK"
  );

  for (const source of map.sources) {
    const normalized = source.toLowerCase();
    assert.equal(
      normalized.includes("node:"),
      false,
      `${source} imports node:`
    );
    for (const forbidden of matrix.forbiddenBundleModules) {
      assert.equal(
        includesPackage(normalized, forbidden.toLowerCase()),
        false,
        `${source} includes forbidden runtime dependency ${forbidden}`
      );
    }
  }

  const header = await readFile(bundle);
  assert.equal(header.subarray(0, 4).toString("hex"), "c61fbc03");
  console.log(
    `Hermes runtime: ${bundleBytes} bytecode bytes, ${map.sources.length} source modules, no forbidden modules.`
  );
} finally {
  await rm(outputRoot, { force: true, recursive: true });
}

function includesPackage(source, forbidden) {
  if (forbidden.includes("/")) return source.includes(forbidden);
  return new RegExp(
    `/node_modules/(?:\\.pnpm/[^/]+/node_modules/)?${escapeRegExp(forbidden)}(?:/|$)`,
    "u"
  ).test(source);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function run(command, args, cwd) {
  const env = { ...process.env };
  delete env.FORCE_COLOR;
  env.NO_COLOR = "1";
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env,
  });
  if (result.status === 0) return;
  process.stderr.write(result.stdout);
  process.stderr.write(result.stderr);
  process.exit(result.status ?? 1);
}

function capture(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
  });
  if (result.status === 0) return `${result.stdout}\n${result.stderr}`;
  process.stderr.write(result.stdout);
  process.stderr.write(result.stderr);
  process.exit(result.status ?? 1);
}
