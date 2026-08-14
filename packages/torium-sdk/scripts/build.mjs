#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { copyFile, readdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageDirectory = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(packageDirectory, "package.json"));
const tsc = require.resolve("typescript/bin/tsc");

await rm(join(packageDirectory, "dist"), { recursive: true, force: true });

for (const project of [
  "tsconfig.esm.json",
  "tsconfig.cjs.json",
  "tsconfig.types.json",
]) {
  const result = spawnSync(process.execPath, [tsc, "-p", project], {
    cwd: packageDirectory,
    encoding: "utf8",
    stdio: "inherit",
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

const declarationsDirectory = join(packageDirectory, "dist/types");
for (const entry of await readdir(declarationsDirectory)) {
  if (!entry.endsWith(".d.ts")) continue;
  const base = entry.slice(0, -".d.ts".length);
  await Promise.all([
    copyFile(
      join(declarationsDirectory, entry),
      join(declarationsDirectory, `${base}.d.mts`)
    ),
    copyFile(
      join(declarationsDirectory, entry),
      join(declarationsDirectory, `${base}.d.cts`)
    ),
  ]);
}

await writeFile(
  join(packageDirectory, "dist/cjs/package.json"),
  `${JSON.stringify({ type: "commonjs" }, null, 2)}\n`
);
