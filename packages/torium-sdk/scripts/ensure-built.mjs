#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageDirectory = join(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(
  await readFile(join(packageDirectory, "package.json"), "utf8")
);

for (const [exportName, entry] of Object.entries(manifest.exports)) {
  if (exportName === "./package.json") continue;
  for (const target of [
    entry.import.types,
    entry.import.default,
    entry.require.types,
    entry.require.default,
  ]) {
    await assert.doesNotReject(
      stat(join(packageDirectory, target)),
      `Missing ${target}; run pnpm --filter @torium-network/sdk build before packing`
    );
  }
}
