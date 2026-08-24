import assert from "node:assert/strict";
import { createRequire } from "node:module";

const [major, minor, patch] = process.versions.node.split(".").map(Number);
const supported =
  (major === 22 &&
    Number.isInteger(minor) &&
    Number.isInteger(patch) &&
    (minor > 23 || (minor === 23 && patch >= 1))) ||
  major === 24;
if (!supported) {
  throw new Error(
    `@torium-network/sdk supports Node >=22.23.1 <23 or >=24 <25; received ${process.version}.`
  );
}

const esm = await import("../dist/esm/index.js");
const esmChains = await import("../dist/esm/chains.js");
const require = createRequire(import.meta.url);
const cjs = require("../dist/cjs/index.js");
const cjsChains = require("../dist/cjs/chains.js");
const manifestVersion = require("../package.json").version;

assert.equal(esm.toriumSdkVersion, manifestVersion);
assert.equal(cjs.toriumSdkVersion, manifestVersion);
assert.equal(esmChains.toriumLocalnet.id, 1414484556);
assert.equal(cjsChains.toriumLocalnet.id, 1414484556);
console.log(
  `Node runtime ${process.version}: ESM and CommonJS imports passed.`
);
