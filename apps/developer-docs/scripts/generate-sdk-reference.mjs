#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
const repositoryRoot = path.resolve(appRoot, "../..");
const packageJsonPath = path.join(
  repositoryRoot,
  "packages/torium-sdk/package.json"
);
const generatedDirectory = path.join(appRoot, "content/generated");
const pagePath = path.join(appRoot, "content/docs/v0/sdk/api-reference.mdx");
const check = process.argv.includes("--check");

const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));
const docsVersions = JSON.parse(
  await readFile(path.join(appRoot, "content/versions.json"), "utf8")
);
const currentTuple = docsVersions.versions.find(
  (candidate) => candidate.id === docsVersions.current
);
if (packageJson.version !== currentTuple?.compatibility?.sdk?.version) {
  throw new Error(
    `Docs ${docsVersions.current} is pinned to SDK ${currentTuple?.compatibility?.sdk?.version}, received ${packageJson.version}; update the version tuple before generating`
  );
}
const reportRelative = `packages/torium-sdk/api/${packageJson.version}.api.md`;
const report = await readFile(
  path.join(repositoryRoot, reportRelative),
  "utf8"
);
const generatedRelative = `apps/developer-docs/content/generated/sdk-${packageJson.version}.api.md`;
const generatedPath = path.join(repositoryRoot, generatedRelative);
const manifestRelative = `apps/developer-docs/content/generated/sdk-${packageJson.version}.manifest.json`;
const manifestPath = path.join(repositoryRoot, manifestRelative);

if (
  !report.startsWith(
    `# Public API report: ${packageJson.name}@${packageJson.version}\n`
  )
) {
  throw new Error(
    `SDK API report header does not match ${packageJson.name}@${packageJson.version}`
  );
}

const reportSections = [
  ...report.matchAll(/^## `([^`]+)`\n([\s\S]*?)(?=^## `|(?![\s\S]))/gm),
].map(([, subpath, body]) => {
  const declarationSha256 = body.match(
    /Declaration SHA-256: `([0-9a-f]{64})`/
  )?.[1];
  const runtimeLine = body.match(/^- Runtime exports: (.+)$/m)?.[1];
  if (!declarationSha256 || !runtimeLine) {
    throw new Error(`SDK API report section ${subpath} is incomplete`);
  }
  return {
    subpath,
    declarationSha256,
    runtimeExports:
      runtimeLine === "none"
        ? []
        : [...runtimeLine.matchAll(/`([^`]+)`/g)].map((match) => match[1]),
  };
});
const expectedSubpaths = Object.keys(packageJson.exports).filter(
  (subpath) => subpath !== "./package.json"
);
const actualSubpaths = reportSections.map(({ subpath }) => subpath);
if (
  JSON.stringify(actualSubpaths.toSorted()) !==
  JSON.stringify(expectedSubpaths.toSorted())
) {
  throw new Error(
    `SDK API report/export map mismatch (${actualSubpaths.join(", ")} vs ${expectedSubpaths.join(", ")})`
  );
}

const manifest = `${JSON.stringify(
  {
    schemaVersion: 1,
    generatorVersion: 1,
    package: packageJson.name,
    packageVersion: packageJson.version,
    source: reportRelative,
    packageDataExport: "./package.json",
    subpaths: reportSections,
  },
  null,
  2
)}\n`;

const page = [
  "---",
  "title: SDK API reference",
  `description: Generated public declarations and runtime exports for ${packageJson.name}@${packageJson.version}.`,
  "docId: sdk-api-reference",
  "version: v0",
  "status: foundation",
  "ownerIssue: 141",
  `sourceOfTruth: ${generatedRelative}`,
  "sourceStatus: generated",
  "---",
  "",
  "> Generated from the package declaration report. Do not edit this page or its generated source by hand.",
  "> Run `pnpm --filter developer-docs generate:sdk-reference` after an approved SDK API change.",
  "",
  "The `./package.json` path is an intentional data export. The `./experimental` section is a",
  "public reserved subpath with no members in SDK 0.1.0.",
  "There are no deprecated or experimental runtime APIs in this release.",
  "",
  report.replace(/^# Public API report:/, "## Public API report:"),
].join("\n");

async function synchronize(file, expected) {
  if (check) {
    let actual;
    try {
      actual = await readFile(file, "utf8");
    } catch {
      throw new Error(
        `${path.relative(repositoryRoot, file)} is missing; regenerate SDK docs`
      );
    }
    if (actual !== expected) {
      throw new Error(
        `${path.relative(repositoryRoot, file)} is stale; regenerate SDK docs`
      );
    }
    return;
  }
  await writeFile(file, expected);
}

await synchronize(generatedPath, report);
await synchronize(manifestPath, manifest);
await synchronize(pagePath, page);
console.log(
  `${check ? "Validated" : "Generated"} SDK API reference for ${packageJson.name}@${packageJson.version}.`
);
