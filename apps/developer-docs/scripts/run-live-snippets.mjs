#!/usr/bin/env node
/**
 * Live documentation snippet execution (#145).
 *
 * Extracts every executable TypeScript fence from the docs and runs it
 * INSIDE a consumer directory that has the PACKED SDK tarball installed, so
 * bare `@torium-network/sdk` specifiers resolve exactly the way a real
 * consumer resolves them — through the package's own export map, never the
 * workspace source. A snippet that documents a behavior the shipped package
 * cannot perform fails the gate.
 *
 * A fence opts in with `snippet=live` on its info string:
 *   ```ts snippet=live
 *
 * Usage:
 *   node apps/developer-docs/scripts/run-live-snippets.mjs --consumer <dir>
 *     [--rpc-url http://127.0.0.1:8545] [--list]
 */
import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFile = promisify(execFileCallback);
const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const docsRoot = path.join(appRoot, "content/docs");

function parseArguments(argv) {
  const result = { consumer: "", rpcUrl: "http://127.0.0.1:8545", list: false };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--consumer") result.consumer = argv[index + 1];
    if (argv[index] === "--rpc-url") result.rpcUrl = argv[index + 1];
    if (argv[index] === "--list") result.list = true;
  }
  return result;
}
const options = parseArguments(process.argv.slice(2));

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(full)));
    else if (entry.name.endsWith(".mdx")) files.push(full);
  }
  return files.sort();
}

const snippets = [];
for (const file of await walk(docsRoot)) {
  const relative = path.relative(appRoot, file).split(path.sep).join("/");
  const contents = await readFile(file, "utf8");
  const fence = /```ts([^\n]*)\n([\s\S]*?)```/gu;
  let index = 0;
  for (const match of contents.matchAll(fence)) {
    const info = match[1] ?? "";
    if (!/\bsnippet=live\b/u.test(info)) continue;
    index += 1;
    snippets.push({ id: `${relative}#${index}`, file: relative, source: match[2] });
  }
}

if (options.list) {
  console.log(JSON.stringify(snippets.map(({ id }) => id), null, 2));
  process.exit(0);
}
if (!options.consumer) {
  console.error("--consumer <dir> is required (a directory with the packed SDK installed)");
  process.exit(64);
}
if (snippets.length === 0) {
  console.error("no live snippets found; the gate requires at least one");
  process.exit(1);
}

// Snippets execute inside the consumer so Node resolves bare specifiers
// through the consumer's node_modules — the packed tarball's real export
// map, not a rewritten file path.
const workDir = await mkdtemp(
  path.join(options.consumer, ".torium-live-snippets-")
);
const failures = [];
const executed = [];
try {
  for (const snippet of snippets) {
    // Only the endpoint is substituted; imports stay exactly as the reader
    // sees them on the page.
    const rewritten = snippet.source.replaceAll(
      "http://127.0.0.1:8545",
      options.rpcUrl
    );
    const modulePath = path.join(
      workDir,
      `${snippet.id.replace(/[^a-zA-Z0-9]/gu, "_")}.mjs`
    );
    await writeFile(modulePath, `${rewritten}\n`);
    try {
      const { stdout, stderr } = await execFile(process.execPath, [modulePath], {
        timeout: 120_000,
        maxBuffer: 8 * 1024 * 1024,
        env: { ...process.env, TORIUM_RPC_URL: options.rpcUrl },
      });
      executed.push({ id: snippet.id, stdout: stdout.trim(), stderr: stderr.trim() });
      console.log(`live-snippet ok: ${snippet.id}`);
    } catch (error) {
      failures.push({
        id: snippet.id,
        message: (error.stderr || error.message || "").toString().split("\n").slice(0, 6).join("\n"),
      });
      console.error(`live-snippet FAILED: ${snippet.id}`);
    }
  }
} finally {
  await rm(workDir, { recursive: true, force: true });
}

if (failures.length > 0) {
  for (const failure of failures) {
    console.error(`\n--- ${failure.id} ---\n${failure.message}`);
  }
  console.error(`\n${failures.length}/${snippets.length} live snippets failed`);
  process.exit(1);
}
console.log(
  JSON.stringify(
    {
      schemaVersion: 1,
      gate: "live-snippet-execution",
      result: "passed",
      snippetCount: snippets.length,
      snippets: executed.map(({ id }) => id),
      sdkSource: "packed-tarball-consumer",
    },
    null,
    2
  )
);
