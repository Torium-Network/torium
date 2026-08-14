import { access, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";

const appRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
const repositoryRoot = path.resolve(appRoot, "../..");
const docsRoot = path.join(appRoot, "content/docs");
const generatedRoot = "apps/developer-docs/content/generated";
const versionPattern = /^v[0-9]+$/;
const allowedVersionStatuses = new Set(["unpublished", "active", "deprecated"]);
const allowedPageStatuses = new Set([
  "planned",
  "foundation",
  "stable",
  "deprecated",
]);
const allowedSourceStatuses = new Set(["planned", "existing", "generated"]);
const expectedOwners = new Map([
  ["home", "139"],
  ["getting-started", "139"],
  ["releases", "139"],
  ["concepts", "140"],
  ["localnet", "140"],
  ["localnet-quickstart", "140"],
  ["localnet-transactions", "140"],
  ["localnet-reference", "140"],
  ["troubleshooting", "140"],
  ["sdk", "141"],
  ["sdk-installation", "141"],
  ["sdk-chains-transports", "141"],
  ["sdk-public-client", "141"],
  ["sdk-wallets-transactions", "141"],
  ["sdk-errors-runtimes", "141"],
  ["sdk-viem-ethers", "141"],
  ["sdk-api-reference", "141"],
  ["evm-tools", "142"],
  ["contracts", "142"],
  ["contracts-registry", "142"],
  ["contracts-rewards", "142"],
  ["contracts-attestations", "142"],
  ["contracts-tooling", "142"],
  ["examples", "143"],
  ["validators", "144"],
  ["operations", "144"],
  ["security", "144"],
  ["reference", "145"],
]);

function fail(message) {
  throw new Error(`Developer docs validation failed: ${message}`);
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(value, location) {
  if (typeof value !== "string" || value.trim() === "")
    fail(`${location} must be a non-empty string`);
}

async function exists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
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

function parseFrontmatter(contents, relativeFile) {
  if (!contents.startsWith("---\n")) fail(`${relativeFile} has no frontmatter`);
  const end = contents.indexOf("\n---\n", 4);
  if (end === -1) fail(`${relativeFile} has unterminated frontmatter`);
  const fields = Object.fromEntries(
    contents
      .slice(4, end)
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const separator = line.indexOf(":");
        if (separator === -1)
          fail(`${relativeFile} has invalid frontmatter line: ${line}`);
        return [
          line.slice(0, separator).trim(),
          line.slice(separator + 1).trim(),
        ];
      })
  );
  return { fields, body: contents.slice(end + 5) };
}

function routeFor(relativeFile) {
  const withoutExtension = relativeFile.replace(/\.mdx$/, "");
  return withoutExtension.endsWith("/index")
    ? `/${withoutExtension.slice(0, -"/index".length)}`
    : `/${withoutExtension}`;
}

function validateCompatibility(version) {
  if (!isRecord(version.compatibility))
    fail(`${version.id}.compatibility must be an object`);
  const { chain, sdk, contracts } = version.compatibility;
  if (!isRecord(chain) || !isRecord(sdk) || !isRecord(contracts)) {
    fail(
      `${version.id} must define chain, sdk, and contracts compatibility objects`
    );
  }
  for (const field of [
    "source",
    "manifestVersion",
    "environment",
    "cosmosChainId",
  ]) {
    requireString(chain[field], `${version.id}.compatibility.chain.${field}`);
  }
  if (!Number.isSafeInteger(chain.evmChainId) || chain.evmChainId <= 0) {
    fail(
      `${version.id}.compatibility.chain.evmChainId must be a positive safe integer`
    );
  }
  for (const field of ["source", "package", "version", "status"]) {
    requireString(sdk[field], `${version.id}.compatibility.sdk.${field}`);
  }
  if (contracts.source !== null)
    requireString(
      contracts.source,
      `${version.id}.compatibility.contracts.source`
    );
  if (contracts.release !== null)
    requireString(
      contracts.release,
      `${version.id}.compatibility.contracts.release`
    );
  requireString(
    contracts.status,
    `${version.id}.compatibility.contracts.status`
  );
  if ((contracts.source === null) !== (contracts.release === null)) {
    fail(
      `${version.id} contract source and release must become available together`
    );
  }
}

function extractDestinations(body) {
  const prose = body.replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]*`/g, "");
  const destinations = [];
  for (const match of prose.matchAll(/!?\[[^\]]*\]\(([^)\n]+)\)/g))
    destinations.push(match[1]);
  for (const match of prose.matchAll(/^\s*\[[^\]]+\]:\s*(\S+)/gm))
    destinations.push(match[1]);
  for (const match of prose.matchAll(
    /\bhref\s*=\s*(?:["']([^"']+)["']|\{\s*["']([^"']+)["']\s*\})/g
  )) {
    destinations.push(match[1] ?? match[2]);
  }
  return destinations.filter(Boolean).map((value) => {
    const trimmed = value.trim();
    if (trimmed.startsWith("<") && trimmed.includes(">"))
      return trimmed.slice(1, trimmed.indexOf(">"));
    return trimmed.split(/\s+["']/)[0];
  });
}

const versions = await readJson(path.join(appRoot, "content/versions.json"));
const versionSchema = await readJson(
  path.join(appRoot, "content/versions.schema.json")
);
const validateVersionSchema = new Ajv2020({
  allErrors: true,
  strict: true,
}).compile(versionSchema);
if (!validateVersionSchema(versions)) {
  fail(
    `content/versions.json violates its JSON Schema: ${JSON.stringify(validateVersionSchema.errors)}`
  );
}
if (
  !isRecord(versions) ||
  versions.schemaVersion !== 1 ||
  !Array.isArray(versions.versions)
) {
  fail("content/versions.json does not match schema version 1");
}
if (!versionPattern.test(versions.current))
  fail("current must use the v<number> format");
if (versions.versions.length === 0)
  fail("at least one docs version is required");

const knownVersions = new Set();
for (const version of versions.versions) {
  if (!isRecord(version)) fail("each version entry must be an object");
  requireString(version.id, "version.id");
  requireString(version.label, `${version.id}.label`);
  if (!versionPattern.test(version.id))
    fail(`${version.id} does not use the v<number> format`);
  if (knownVersions.has(version.id))
    fail(`version ID ${version.id} is duplicated`);
  if (!allowedVersionStatuses.has(version.status))
    fail(`${version.id} has invalid status ${version.status}`);
  validateCompatibility(version);
  knownVersions.add(version.id);
}
if (!knownVersions.has(versions.current))
  fail(`current version ${versions.current} is unknown`);

const contentVersions = (await readdir(docsRoot, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();
const declaredVersions = [...knownVersions].sort();
if (JSON.stringify(contentVersions) !== JSON.stringify(declaredVersions)) {
  fail(
    `manifest/content version roots differ (${declaredVersions.join(", ")} vs ${contentVersions.join(", ")})`
  );
}
for (const version of declaredVersions) {
  if (!(await exists(path.join(docsRoot, version, "index.mdx"))))
    fail(`${version} has no root index.mdx`);
  if (!(await exists(path.join(docsRoot, version, "meta.json"))))
    fail(`${version} has no meta.json`);
}

const identifiers = await readJson(
  path.join(repositoryRoot, "chain/config/identifiers.json")
);
const sdkPackage = await readJson(
  path.join(repositoryRoot, "packages/torium-sdk/package.json")
);
const current = versions.versions.find(
  (version) => version.id === versions.current
);
if (!current) fail("current docs version is missing");
const expected = current.compatibility;
const network = identifiers.networks.find(
  (candidate) => candidate.environment === expected.chain.environment
);
if (!network)
  fail(`canonical ${expected.chain.environment} network is missing`);
if (expected.chain.source !== "chain/config/identifiers.json")
  fail("current chain source is not canonical");
if (expected.chain.manifestVersion !== identifiers.manifestVersion)
  fail("chain manifest version is stale");
if (expected.chain.evmChainId !== network.evm.chainId)
  fail(`${expected.chain.environment} EVM chain ID is stale`);
if (expected.chain.cosmosChainId !== network.cosmos.chainId)
  fail(`${expected.chain.environment} Cosmos chain ID is stale`);
if (expected.sdk.source !== "packages/torium-sdk/package.json")
  fail("current SDK source is not canonical");
if (
  expected.sdk.package !== sdkPackage.name ||
  expected.sdk.version !== sdkPackage.version
) {
  fail("SDK compatibility tuple is stale");
}

const files = await walk(docsRoot);
const pages = [];
const docIds = new Set();
for (const file of files) {
  const relativeFile = path.relative(docsRoot, file).split(path.sep).join("/");
  const [pathVersion] = relativeFile.split("/");
  const { fields, body } = parseFrontmatter(
    await readFile(file, "utf8"),
    relativeFile
  );
  for (const required of [
    "title",
    "description",
    "docId",
    "version",
    "status",
    "ownerIssue",
    "sourceOfTruth",
    "sourceStatus",
  ]) {
    if (!fields[required]) fail(`${relativeFile} is missing ${required}`);
  }
  if (fields.version !== pathVersion)
    fail(`${relativeFile} mixes ${fields.version} with ${pathVersion}`);
  if (!allowedPageStatuses.has(fields.status))
    fail(`${relativeFile} has invalid status ${fields.status}`);
  if (!allowedSourceStatuses.has(fields.sourceStatus))
    fail(`${relativeFile} has invalid sourceStatus ${fields.sourceStatus}`);
  if (!/^\d+$/.test(fields.ownerIssue))
    fail(`${relativeFile} has invalid ownerIssue ${fields.ownerIssue}`);
  const expectedOwner = expectedOwners.get(fields.docId);
  if (!expectedOwner || fields.ownerIssue !== expectedOwner) {
    fail(
      `${relativeFile} must be owned by roadmap issue #${expectedOwner ?? "unknown"}`
    );
  }
  if (fields.sourceStatus === "planned" && fields.status !== "planned") {
    fail(
      `${relativeFile} cannot call a ${fields.sourceStatus} source ${fields.status}`
    );
  }
  if (
    fields.sourceStatus === "generated" &&
    !fields.sourceOfTruth.startsWith(`${generatedRoot}/`) &&
    fields.sourceOfTruth !== generatedRoot
  ) {
    fail(`${relativeFile} generated source must stay below ${generatedRoot}`);
  }
  if (
    fields.sourceStatus !== "planned" &&
    !(await exists(path.join(repositoryRoot, fields.sourceOfTruth)))
  ) {
    fail(
      `${relativeFile} references missing ${fields.sourceStatus} source ${fields.sourceOfTruth}`
    );
  }
  const scopedDocId = `${fields.version}:${fields.docId}`;
  if (docIds.has(scopedDocId))
    fail(`${relativeFile} duplicates docId ${fields.docId}`);
  docIds.add(scopedDocId);
  pages.push({ relativeFile, route: routeFor(relativeFile), body });
}

for (const version of declaredVersions) {
  if (!pages.some((page) => page.route === `/${version}`))
    fail(`${version} has no routable root page`);
}
const routes = new Set(pages.map((page) => page.route));
for (const page of pages) {
  const pageVersion = page.route.split("/")[1];
  for (const destination of extractDestinations(page.body)) {
    if (
      destination.startsWith("#") ||
      destination.startsWith("//") ||
      /^[a-z][a-z+.-]*:/i.test(destination)
    )
      continue;
    if (/^\/(?:docs\/)?latest(?:[/?#]|$)/.test(destination))
      fail(`${page.relativeFile} links to non-canonical latest route`);
    if (/^\/docs(?:[/?#]|$)/.test(destination))
      fail(
        `${page.relativeFile} includes the public base path in an authored link`
      );
    const resolved = new URL(
      destination,
      `https://docs.local/docs${page.route}`
    );
    const publicPath =
      decodeURIComponent(resolved.pathname).replace(/\/$/, "") || "/";
    const target = publicPath.startsWith("/docs/")
      ? publicPath.slice("/docs".length)
      : publicPath;
    const targetVersion = target.split("/")[1];
    if (targetVersion !== pageVersion)
      fail(
        `${page.relativeFile} links across documentation versions to ${target}`
      );
    if (!routes.has(target))
      fail(`${page.relativeFile} links to missing route ${target}`);
  }
}

console.log(
  `Validated ${pages.length} pages across ${declaredVersions.length} documentation version(s).`
);
console.log(
  `Compatibility: ${versions.current} -> chain ${expected.chain.manifestVersion}, SDK ${expected.sdk.version}, contracts ${expected.contracts.status}.`
);
