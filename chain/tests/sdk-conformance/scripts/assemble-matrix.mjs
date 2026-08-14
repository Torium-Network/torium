#!/usr/bin/env node
/**
 * Assembles the committed compatibility matrix from a conformance run's
 * JSONL capability records. The matrix is deterministic: only capability IDs,
 * their primary RPC methods, and pass status are recorded, never timestamps,
 * addresses, or transaction hashes.
 *
 * Usage: node assemble-matrix.mjs <results.jsonl> [--write]
 */
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const suiteDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
const matrixPath = path.join(
  suiteDirectory,
  "proof/sdk-conformance-matrix.json"
);
const [resultsPath, mode = "--check"] = process.argv.slice(2);
assert.ok(resultsPath, "usage: assemble-matrix.mjs <results.jsonl> [--write]");

const lines = (await readFile(resultsPath, "utf8"))
  .split("\n")
  .filter((line) => line.trim().length > 0)
  .map((line) => JSON.parse(line));
assert.ok(lines.length > 0, "the conformance run recorded no capabilities");

const seen = new Set();
for (const entry of lines) {
  assert.match(entry.id, /^torium\.[a-z-]+(\.[a-z-]+)+$/u);
  assert.equal(entry.status, "pass", `capability ${entry.id} did not pass`);
  assert.ok(!seen.has(entry.id), `duplicate capability ${entry.id}`);
  seen.add(entry.id);
}

const matrix = `${JSON.stringify(
  {
    schemaVersion: 1,
    suite: "torium-sdk-localnet-conformance-v0",
    ownerIssue: 137,
    source: "chain/tests/sdk-conformance/run.sh",
    network: "torium-localnet-1 (disposable, valueless)",
    consumption: "packed @torium-network/sdk tarball, not source aliases",
    capabilities: lines
      .map(({ id, method, status }) => ({ id, method, status }))
      .toSorted((left, right) => left.id.localeCompare(right.id)),
  },
  null,
  2
)}\n`;

if (mode === "--write") {
  await writeFile(matrixPath, matrix);
  console.log(`wrote ${lines.length} capabilities to the committed matrix`);
} else {
  const committed = await readFile(matrixPath, "utf8").catch(() => null);
  assert.equal(
    committed,
    matrix,
    "committed compatibility matrix drifted; rerun run.sh --write"
  );
  console.log(`committed matrix matches the run (${lines.length} capabilities)`);
}
