#!/usr/bin/env node
/**
 * Documentation snippet QA gate (#145).
 *
 * Fails when authored docs drift from the real surfaces:
 * - every `ts` fence must parse as a TypeScript module;
 * - every named runtime import from `@torium-network/sdk[/subpath]` must
 *   exist in the generated API manifest (type-only imports are exempt);
 * - repository file paths mentioned in `bash` fences must exist;
 * - the "Torium" spelling stays consistent outside the repository slug.
 *
 * Generated pages (sourceStatus: generated) are exempt from fence checks
 * because their content is drift-gated by their own generators.
 */
import { readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
const repositoryRoot = path.resolve(appRoot, "../..");
const docsRoot = path.join(appRoot, "content/docs");
const ts = createRequire(path.join(appRoot, "package.json"))("typescript");

const manifest = JSON.parse(
  await readFile(
    path.join(appRoot, "content/generated/sdk-0.1.0.manifest.json"),
    "utf8"
  )
);
const sdkExports = new Map(
  manifest.subpaths.map(({ subpath, runtimeExports }) => [
    subpath === "." ? "" : subpath.slice(2),
    new Set(runtimeExports),
  ])
);

const problems = [];
const stats = { files: 0, tsBlocks: 0, bashBlocks: 0, imports: 0, paths: 0 };

for (const file of await walk(docsRoot)) {
  const relative = path.relative(appRoot, file).split(path.sep).join("/");
  const contents = await readFile(file, "utf8");
  stats.files += 1;

  for (const match of contents.matchAll(/(?<!\w)[Tt]oryum/g)) {
    problems.push(`${relative}: misspelled brand near "${context(contents, match.index)}"`);
  }

  if (/^sourceStatus:\s*generated$/m.test(contents.slice(0, 400))) continue;

  for (const fence of contents.matchAll(/^```(\w*)[^\n]*\n([\s\S]*?)^```/gm)) {
    const [, language, body] = fence;
    if (language === "ts" || language === "typescript") {
      stats.tsBlocks += 1;
      checkTypeScript(relative, body);
    } else if (language === "bash" || language === "sh") {
      stats.bashBlocks += 1;
      checkBashPaths(relative, body);
    }
  }
}

if (problems.length > 0) {
  for (const problem of problems) console.error(`snippet-qa: ${problem}`);
  process.exit(1);
}
console.log(
  `Snippet QA passed: ${stats.files} pages, ${stats.tsBlocks} ts blocks ` +
    `(${stats.imports} SDK imports), ${stats.bashBlocks} bash blocks ` +
    `(${stats.paths} repo paths).`
);

function checkTypeScript(relative, body) {
  const { diagnostics } = ts.transpileModule(body, {
    reportDiagnostics: true,
    compilerOptions: { module: ts.ModuleKind.ESNext, strict: false },
  });
  for (const diagnostic of diagnostics ?? []) {
    problems.push(
      `${relative}: ts snippet does not parse: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, " ")}`
    );
  }

  for (const statement of body.matchAll(
    /import\s+(type\s+)?\{([^}]+)\}\s+from\s+"@torium-network\/sdk(\/[a-z-]+)?"/g
  )) {
    const [, typeOnly, specifierList, subpath = ""] = statement;
    const exportsForSubpath = sdkExports.get(subpath.replace(/^\//, ""));
    if (exportsForSubpath === undefined) {
      problems.push(
        `${relative}: unknown SDK subpath "@torium-network/sdk${subpath}"`
      );
      continue;
    }
    if (typeOnly) continue;
    for (const rawSpecifier of specifierList.split(",")) {
      const specifier = rawSpecifier.trim();
      if (specifier === "" || specifier.startsWith("type ")) continue;
      const name = specifier.split(/\s+as\s+/)[0].trim();
      stats.imports += 1;
      if (!exportsForSubpath.has(name)) {
        problems.push(
          `${relative}: "@torium-network/sdk${subpath}" does not export "${name}"`
        );
      }
    }
  }
}

function checkBashPaths(relative, body) {
  for (const token of body.matchAll(
    /(?<=^|[\s"'=(])\.?\/?((?:chain|apps|packages|contracts|examples|docs|scripts)\/[\w./-]+\.(?:mjs|sh|md|json|ts|sol|yml|yaml))(?=$|[\s"')])/gm
  )) {
    stats.paths += 1;
    if (!existsSync(path.join(repositoryRoot, token[1]))) {
      problems.push(`${relative}: bash snippet references missing ${token[1]}`);
    }
  }
  if (
    body.includes("chain/localnet/torium-localnet") &&
    !existsSync(path.join(repositoryRoot, "chain/localnet/torium-localnet"))
  ) {
    problems.push(`${relative}: torium-localnet launcher path is missing`);
  }
}

function context(contents, index) {
  return contents
    .slice(Math.max(0, index - 20), index + 30)
    .replace(/\s+/g, " ");
}

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(target)));
    else if (entry.name.endsWith(".mdx")) files.push(target);
  }
  return files.sort();
}
