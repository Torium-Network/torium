#!/usr/bin/env node

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  verify,
} from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const keyRelativePath = "config/priv_validator_key.json";
const stateRelativePath = "data/priv_validator_state.json";
const maximumFileBytes = 64 * 1024;
const maximumHeight = 9_223_372_036_854_775_807n;
const maximumRound = 2_147_483_647;
const ed25519Pkcs8SeedPrefix = Buffer.from(
  "302e020100300506032b657004220420",
  "hex"
);
const ed25519SpkiPublicPrefix = Buffer.from("302a300506032b6570032100", "hex");

export async function validateSignerRestore({
  currentHome,
  candidateHome,
  validatorStopped,
  trustedMaximumHeight,
}) {
  if (validatorStopped !== true) {
    throw new Error("validator-stopped evidence is required");
  }
  const trustedCeiling = parseHeight(
    trustedMaximumHeight,
    "trusted maximum signer height"
  );
  const current = await readSignerHome(currentHome, "current");
  const candidate = await readSignerHome(candidateHome, "candidate");
  if (current.home === candidate.home) {
    throw new Error("current and candidate signer homes must differ");
  }
  if (
    current.key.address !== candidate.key.address ||
    current.key.pub_key.type !== candidate.key.pub_key.type ||
    current.key.pub_key.value !== candidate.key.pub_key.value
  ) {
    throw new Error("candidate consensus identity differs from current signer");
  }
  for (const signer of [current, candidate]) {
    if (BigInt(signer.state.height) > trustedCeiling) {
      throw new Error(
        `${signer.label} signer state exceeds trusted maximum height`
      );
    }
  }
  const positionComparison = comparePosition(candidate.state, current.state);
  if (positionComparison < 0) {
    throw new Error("candidate signer state is behind current signer state");
  }
  if (
    positionComparison === 0 &&
    (candidate.state.signbytes !== current.state.signbytes ||
      candidate.state.signature !== current.state.signature)
  ) {
    throw new Error(
      "same signer position has different sign bytes or signature"
    );
  }
  return {
    valid: true,
    sameConsensusIdentity: true,
    candidateNotBehind: true,
    samePosition: positionComparison === 0,
    currentPosition: publicPosition(current.state),
    candidatePosition: publicPosition(candidate.state),
    trustedMaximumHeight: trustedCeiling.toString(),
    secretMaterialReturned: false,
    validatorStoppedEvidenceAccepted: true,
  };
}

async function readSignerHome(homeValue, label) {
  if (typeof homeValue !== "string" || homeValue.length === 0) {
    throw new Error(`${label} signer home is required`);
  }
  const home = await requireRealDirectory(
    path.resolve(homeValue),
    `${label} home`
  );
  for (const relative of ["config", "data"]) {
    await requireRealDirectory(
      path.join(home, relative),
      `${label} ${relative}`
    );
  }
  const key = await readStrictJson(
    path.join(home, keyRelativePath),
    `${label} consensus key`
  );
  validateKey(key, `${label} consensus key`);
  const state = validateState(
    await readStrictJson(
      path.join(home, stateRelativePath),
      `${label} signer state`
    ),
    `${label} signer state`,
    key.pub_key.value
  );
  return { home, key, state, label };
}

async function requireRealDirectory(target, label) {
  const metadata = await lstat(target);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`${label} must be a real directory`);
  }
  if ((metadata.mode & 0o777) !== 0o700) {
    throw new Error(`${label} mode must be 0700`);
  }
  return realpath(target);
}

async function readStrictJson(target, label) {
  const metadata = await lstat(target);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`${label} must be a regular file`);
  }
  if ((metadata.mode & 0o777) !== 0o600) {
    throw new Error(`${label} mode must be 0600`);
  }
  if (metadata.size < 2 || metadata.size > maximumFileBytes) {
    throw new Error(`${label} size is outside the allowed range`);
  }
  let parsed;
  try {
    parsed = JSON.parse(await readFile(target, "utf8"));
  } catch {
    throw new Error(`${label} must contain valid JSON`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${label} must contain one JSON object`);
  }
  return parsed;
}

function validateKey(key, label) {
  assertExactKeys(key, ["address", "priv_key", "pub_key"], label);
  assertExactKeys(key.pub_key, ["type", "value"], `${label} public key`);
  assertExactKeys(key.priv_key, ["type", "value"], `${label} private key`);
  if (!/^[0-9A-F]{40}$/u.test(key.address)) {
    throw new Error(`${label} address must be uppercase 20-byte hex`);
  }
  if (key.pub_key.type !== "tendermint/PubKeyEd25519") {
    throw new Error(`${label} public key type is unsupported`);
  }
  if (key.priv_key.type !== "tendermint/PrivKeyEd25519") {
    throw new Error(`${label} private key type is unsupported`);
  }
  const publicBytes = decodeCanonicalBase64(
    key.pub_key.value,
    32,
    `${label} public key`
  );
  const privateBytes = decodeCanonicalBase64(
    key.priv_key.value,
    64,
    `${label} private key`
  );
  if (!privateBytes.subarray(32).equals(publicBytes)) {
    throw new Error(`${label} public and private key material disagree`);
  }
  const derivedPublicBytes = deriveEd25519Public(privateBytes.subarray(0, 32));
  if (!derivedPublicBytes.equals(publicBytes)) {
    throw new Error(`${label} private-key seed does not derive the public key`);
  }
  const address = createHash("sha256")
    .update(publicBytes)
    .digest()
    .subarray(0, 20)
    .toString("hex")
    .toUpperCase();
  if (address !== key.address) {
    throw new Error(`${label} address differs from the public key`);
  }
}

function deriveEd25519Public(seed) {
  const privateKey = createPrivateKey({
    key: Buffer.concat([ed25519Pkcs8SeedPrefix, seed]),
    format: "der",
    type: "pkcs8",
  });
  const publicDer = createPublicKey(privateKey).export({
    format: "der",
    type: "spki",
  });
  return publicDer.subarray(-32);
}

function validateState(state, label, publicKeyBase64) {
  assertAllowedKeys(
    state,
    ["height", "round", "step"],
    ["signature", "signbytes"],
    label
  );
  const height = parseHeight(state.height, `${label} height`);
  if (
    !Number.isSafeInteger(state.round) ||
    state.round < 0 ||
    state.round > maximumRound
  ) {
    throw new Error(`${label} round must fit a non-negative CometBFT int32`);
  }
  if (!Number.isSafeInteger(state.step) || state.step < 0 || state.step > 3) {
    throw new Error(`${label} step must be an integer from 0 through 3`);
  }
  const signature = state.signature ?? null;
  const signbytes = state.signbytes ?? null;
  const signaturePresent = signature !== null;
  const signbytesPresent = signbytes !== null;
  if (signaturePresent !== signbytesPresent) {
    throw new Error(`${label} signature and signbytes must appear together`);
  }
  if (height === 0n) {
    if (state.round !== 0 || state.step !== 0 || signaturePresent) {
      throw new Error(`${label} initial state must be (0,0,0) and unsigned`);
    }
  } else {
    if (state.step < 1 || !signaturePresent) {
      throw new Error(`${label} signed state requires step 1 through 3`);
    }
    const signatureBytes = decodeCanonicalBase64(
      signature,
      64,
      `${label} signature`
    );
    const signBytes = decodeCanonicalUpperHex(signbytes, `${label} signbytes`);
    const publicBytes = decodeCanonicalBase64(
      publicKeyBase64,
      32,
      `${label} public key`
    );
    if (
      !verify(null, signBytes, ed25519PublicKey(publicBytes), signatureBytes)
    ) {
      throw new Error(`${label} signature does not verify over signbytes`);
    }
  }
  return {
    height: state.height,
    round: state.round,
    step: state.step,
    signature,
    signbytes,
  };
}

function parseHeight(value, label) {
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]*)$/u.test(value)) {
    throw new Error(`${label} must be a non-negative decimal string`);
  }
  const parsed = BigInt(value);
  if (parsed > maximumHeight) {
    throw new Error(`${label} must fit a non-negative CometBFT int64`);
  }
  return parsed;
}

function comparePosition(left, right) {
  const leftValues = [
    BigInt(left.height),
    BigInt(left.round),
    BigInt(left.step),
  ];
  const rightValues = [
    BigInt(right.height),
    BigInt(right.round),
    BigInt(right.step),
  ];
  for (let index = 0; index < leftValues.length; index += 1) {
    if (leftValues[index] < rightValues[index]) return -1;
    if (leftValues[index] > rightValues[index]) return 1;
  }
  return 0;
}

function publicPosition(state) {
  return { height: state.height, round: state.round, step: state.step };
}

function decodeCanonicalBase64(value, bytes, label) {
  const decoded = decodeBoundedBase64(value, label);
  if (decoded.length !== bytes) {
    throw new Error(`${label} must decode to ${bytes} bytes`);
  }
  return decoded;
}

function decodeCanonicalUpperHex(value, label) {
  if (
    typeof value !== "string" ||
    value.length < 2 ||
    value.length > 32 * 1024 ||
    value.length % 2 !== 0 ||
    !/^[0-9A-F]+$/u.test(value)
  ) {
    throw new Error(`${label} must be canonical bounded uppercase hex`);
  }
  const decoded = Buffer.from(value, "hex");
  if (decoded.toString("hex").toUpperCase() !== value) {
    throw new Error(`${label} must be canonical bounded uppercase hex`);
  }
  return decoded;
}

function decodeBoundedBase64(value, label) {
  if (
    typeof value !== "string" ||
    value.length < 4 ||
    value.length > 16 * 1024 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(
      value
    )
  ) {
    throw new Error(`${label} must be canonical bounded base64`);
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value) {
    throw new Error(`${label} must be canonical bounded base64`);
  }
  return decoded;
}

function assertExactKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const required = [...expected].sort();
  if (
    actual.length !== required.length ||
    actual.some((field, index) => field !== required[index])
  ) {
    throw new Error(`${label} fields differ from the contract`);
  }
}

function assertAllowedKeys(value, required, optional, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  for (const field of required) {
    if (!Object.hasOwn(value, field)) {
      throw new Error(`${label} fields differ from the contract`);
    }
  }
  const allowed = new Set([...required, ...optional]);
  if (Object.keys(value).some((field) => !allowed.has(field))) {
    throw new Error(`${label} fields differ from the contract`);
  }
}

function ed25519PublicKey(publicBytes) {
  return createPublicKey({
    key: Buffer.concat([ed25519SpkiPublicPrefix, publicBytes]),
    format: "der",
    type: "spki",
  });
}

function parseArguments(argv) {
  const options = {
    currentHome: null,
    candidateHome: null,
    validatorStopped: false,
    trustedMaximumHeight: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (option === "--validator-stopped") {
      options.validatorStopped = true;
      continue;
    }
    if (
      option !== "--current-home" &&
      option !== "--candidate-home" &&
      option !== "--trusted-maximum-height"
    ) {
      throw new Error(`unknown signer-state guard option ${option}`);
    }
    const value = argv[++index];
    if (!value || value.startsWith("--")) {
      throw new Error(`${option} requires a path`);
    }
    const property = {
      "--current-home": "currentHome",
      "--candidate-home": "candidateHome",
      "--trusted-maximum-height": "trustedMaximumHeight",
    }[option];
    options[property] = value;
  }
  return options;
}

async function main() {
  const report = await validateSignerRestore(
    parseArguments(process.argv.slice(2))
  );
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath && fileURLToPath(import.meta.url) === invokedPath) {
  main().catch((error) => {
    process.stderr.write(
      `Torium signer-state guard rejected candidate: ${error instanceof Error ? error.message : "unknown error"}\n`
    );
    process.exitCode = 2;
  });
}
