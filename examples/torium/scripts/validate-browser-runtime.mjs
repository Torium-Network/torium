import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { builtinModules } from "node:module";
import { gzipSync } from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";

const exampleRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
const matrix = JSON.parse(
  await readFile(path.join(exampleRoot, "runtime-matrix.json"), "utf8")
);
const assetRoot = path.join(exampleRoot, "dist/browser/assets");
const files = (await readdir(assetRoot)).filter((file) => file.endsWith(".js"));
assert.ok(files.length > 0, "Vite emitted no browser JavaScript");
const builtinPackages = new Set(
  builtinModules.map((module) => module.replace(/^node:/u, "").split("/")[0])
);

let javaScriptBytes = 0;
let gzipBytes = 0;
for (const file of files) {
  const contents = await readFile(path.join(assetRoot, file));
  const text = contents.toString("utf8");
  javaScriptBytes += contents.byteLength;
  gzipBytes += gzipSync(contents).byteLength;
  assert.doesNotMatch(text, /(?:from|require\()\s*["']node:/u);
}

const sourceMaps = (await readdir(assetRoot)).filter((file) =>
  file.endsWith(".js.map")
);
assert.equal(
  sourceMaps.length,
  files.length,
  "each browser chunk needs a source map"
);
for (const file of sourceMaps) {
  const map = JSON.parse(await readFile(path.join(assetRoot, file), "utf8"));
  for (const source of map.sources) {
    const normalized = source.toLowerCase();
    assert.doesNotMatch(
      normalized,
      /(?:__vite-browser-external|browser-external|commonjs-external)/u,
      `${source} is an externalized browser fallback`
    );
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
    for (const builtin of builtinPackages) {
      assert.equal(
        includesPackage(normalized, builtin),
        false,
        `${source} includes Node builtin package ${builtin}`
      );
    }
  }
}

assert.ok(
  javaScriptBytes <= matrix.browser.maximumJavaScriptBytes,
  `browser JavaScript ${javaScriptBytes} exceeds ${matrix.browser.maximumJavaScriptBytes}`
);
assert.ok(
  gzipBytes <= matrix.browser.maximumGzipBytes,
  `browser gzip ${gzipBytes} exceeds ${matrix.browser.maximumGzipBytes}`
);
console.log(
  `Browser runtime: ${files.length} chunks, ${javaScriptBytes} bytes, ${gzipBytes} gzip bytes, no forbidden modules.`
);

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
