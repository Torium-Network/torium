#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

function usage() {
  return `Usage:
  node chain/operator/verify-upgrade-binary.mjs --plan-info FILE --binary FILE [--expected-profile post]
  node chain/operator/verify-upgrade-binary.mjs --plan-info FILE --docker-image IMAGE [--expected-profile post]`;
}

function fail(message) {
  console.error(`Torium upgrade preflight failed: ${message}`);
  process.exit(1);
}

function run(command, args) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) fail(`${command} could not start: ${result.error.message}`);
  if (result.status !== 0) {
    fail(`${command} exited ${result.status}: ${(result.stderr || result.stdout).trim()}`);
  }
  return result.stdout.trim();
}

const options = { expectedProfile: "post" };
for (let index = 2; index < process.argv.length; index += 1) {
  const argument = process.argv[index];
  if (argument === "--help" || argument === "-h") {
    console.log(usage());
    process.exit(0);
  }
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) fail(`missing value for ${argument}`);
  if (argument === "--plan-info") options.planInfo = value;
  else if (argument === "--binary") options.binary = value;
  else if (argument === "--docker-image") options.dockerImage = value;
  else if (argument === "--expected-profile") options.expectedProfile = value;
  else fail(`unknown argument ${argument}\n${usage()}`);
  index += 1;
}

if (!options.planInfo) fail(`--plan-info is required\n${usage()}`);
if (Boolean(options.binary) === Boolean(options.dockerImage)) {
  fail(`select exactly one of --binary or --docker-image\n${usage()}`);
}
if (!new Set(["post", "failed-rehearsal"]).has(options.expectedProfile)) {
  fail("--expected-profile must be post or failed-rehearsal");
}

let plan;
try {
  plan = JSON.parse(readFileSync(resolve(options.planInfo), "utf8"));
} catch (error) {
  fail(`cannot read plan info: ${error.message}`);
}
const planKeys = [
  "binarySha256",
  "migrationSha256",
  "planName",
  "protocolVersion",
  "schemaVersion",
  "targetVersion",
];
if (
  !plan ||
  typeof plan !== "object" ||
  Array.isArray(plan) ||
  JSON.stringify(Object.keys(plan).sort()) !== JSON.stringify(planKeys)
) {
  fail("plan info must contain exactly the torium-upgrade-info-v1 fields");
}
if (plan.schemaVersion !== 1 || plan.planName !== "torium-local-v1") {
  fail("plan identity is not torium-local-v1 schema 1");
}
for (const field of ["targetVersion", "protocolVersion", "migrationSha256", "binarySha256"]) {
  if (typeof plan[field] !== "string" || plan[field].length === 0) fail(`${field} is required`);
}
if (!/^[0-9a-f]{64}$/.test(plan.binarySha256) || !/^[0-9a-f]{64}$/.test(plan.migrationSha256)) {
  fail("plan checksums must be lowercase SHA-256");
}
if (plan.migrationSha256 !== "47f5aa5306c8a116260395bb9f0a9ac0a7c8ddb96f9f6ac56af7156a65f8355d") {
  fail("plan migration checksum is not the reviewed torium-local-v1 migration");
}

let metadataText;
let binarySha256;
if (options.binary) {
  const binary = resolve(options.binary);
  metadataText = run(binary, ["version"]);
  try {
    binarySha256 = createHash("sha256").update(readFileSync(binary)).digest("hex");
  } catch (error) {
    fail(`cannot read binary: ${error.message}`);
  }
} else {
  metadataText = run("docker", ["run", "--rm", "--entrypoint", "toriumd", options.dockerImage, "version"]);
  binarySha256 = run("docker", [
    "run",
    "--rm",
    "--entrypoint",
    "sha256sum",
    options.dockerImage,
    "/usr/local/bin/toriumd",
  ]).split(/\s+/u)[0];
}

let metadata;
try {
  metadata = JSON.parse(metadataText);
} catch (error) {
  fail(`binary version output is not JSON: ${error.message}`);
}
if (binarySha256 !== plan.binarySha256) {
  fail(`binary SHA-256 ${binarySha256} does not match plan ${plan.binarySha256}`);
}
if (metadata.name !== "Torium" || metadata.binary !== "toriumd") fail("binary identity is not Torium/toriumd");
if (metadata.version !== plan.targetVersion) {
  fail(`binary version ${metadata.version} does not match target ${plan.targetVersion}`);
}
if (metadata.protocolVersion !== plan.protocolVersion) {
  fail(`binary protocol ${metadata.protocolVersion} does not match plan ${plan.protocolVersion}`);
}
if (metadata.upgradeProfile !== options.expectedProfile) {
  fail(`binary profile ${metadata.upgradeProfile} does not match expected ${options.expectedProfile}`);
}

console.log(
  JSON.stringify(
    {
      status: "verified",
      planName: plan.planName,
      targetVersion: plan.targetVersion,
      protocolVersion: plan.protocolVersion,
      upgradeProfile: metadata.upgradeProfile,
      binarySha256,
      source: options.binary ? resolve(options.binary) : options.dockerImage,
    },
    null,
    2,
  ),
);
