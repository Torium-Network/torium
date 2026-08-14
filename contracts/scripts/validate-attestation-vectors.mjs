#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  encodeAbiParameters,
  getAddress,
  isAddress,
  keccak256,
  stringToHex,
} from "viem";

const contractRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
const UINT256_MAX = (1n << 256n) - 1n;
const UINT32_MAX = (1n << 32n) - 1n;
const ZERO_BYTES32 = `0x${"00".repeat(32)}`;
const DEFAULT_FIXTURE = "fixtures/attestations/canonical-hash-v1.json";
const COMMITMENT_PARAMETERS = [
  { name: "schemaId", type: "bytes32" },
  { name: "schemaVersion", type: "uint32" },
  { name: "subject", type: "bytes32" },
  { name: "referenceHash", type: "bytes32" },
  { name: "contentHash", type: "bytes32" },
  { name: "metadataHash", type: "bytes32" },
  { name: "metadataUriHash", type: "bytes32" },
  { name: "supersedes", type: "bytes32" },
];
const ATTESTATION_ID_PARAMETERS = [
  { name: "chainId", type: "uint256" },
  { name: "registry", type: "address" },
  { name: "issuer", type: "address" },
  { name: "issuerNonce", type: "uint256" },
  { name: "commitment", type: "bytes32" },
];
const ALGORITHM = {
  id: "torium-attestation-canonical-bytes-v1",
  digest: "keccak256",
  textEncoding: "UTF-8",
  byteDerivation: "exact-decoded-string-to-utf8-without-transformation",
  jsonCanonicalization: "none",
  unicodeNormalization: "none-caller-responsibility",
  uriCanonicalization: "none-exact-utf8",
  commitmentEncoding:
    "abi.encode(bytes32 schemaId,uint32 schemaVersion,bytes32 subject,bytes32 referenceHash,bytes32 contentHash,bytes32 metadataHash,bytes32 metadataUriHash,bytes32 supersedes)",
  attestationIdEncoding:
    "abi.encode(uint256 chainId,address registry,address issuer,uint256 issuerNonce,bytes32 commitment)",
};
const NON_CLAIMS = [
  "no-rfc8785-jcs-json-canonicalization",
  "no-unicode-normalization",
  "no-uri-normalization",
  "hashes-do-not-prove-authenticity-truth-or-availability",
  "hashes-do-not-provide-confidentiality",
  "low-entropy-inputs-are-dictionary-attackable",
  "do-not-place-sensitive-large-or-personal-payloads-on-chain",
];

const fixturePath = parseArguments(process.argv.slice(2));
const source = await readFile(fixturePath, "utf8");
assertNoDuplicateJsonKeys(source);
const fixture = JSON.parse(source);
validateFixture(fixture);
console.log(
  `Validated ${fixture.vectors.length} offline attestation canonical-byte vectors.`
);

function parseArguments(argv) {
  if (argv.length === 0) return path.join(contractRoot, DEFAULT_FIXTURE);
  if (argv.length !== 2 || argv[0] !== "--fixture") {
    throw new Error(
      "usage: validate-attestation-vectors.mjs [--fixture <path>]"
    );
  }
  const resolved = path.resolve(process.cwd(), argv[1]);
  if (path.extname(resolved).toLowerCase() !== ".json") {
    throw new Error("--fixture must reference a .json file");
  }
  return resolved;
}

function validateFixture(value) {
  assertPlainObject(value, "fixture");
  assertExactKeys(
    value,
    [
      "schemaVersion",
      "vectorSet",
      "verifiedBy",
      "algorithm",
      "nonClaims",
      "vectors",
    ],
    "fixture"
  );
  assert.equal(value.schemaVersion, 1);
  assert.equal(value.vectorSet, "torium-attestation-canonical-hash-v1");
  assert.equal(
    value.verifiedBy,
    "contracts/scripts/validate-attestation-vectors.mjs"
  );
  assert.deepEqual(value.algorithm, ALGORITHM);
  assert.deepEqual(value.nonClaims, NON_CLAIMS);
  assert.ok(Array.isArray(value.vectors), "fixture.vectors must be an array");
  assert.equal(
    value.vectors.length,
    4,
    "fixture must contain four review vectors"
  );

  const names = new Set();
  for (const [index, vector] of value.vectors.entries()) {
    validateVector(vector, index);
    assert.equal(
      names.has(vector.name),
      false,
      `duplicate vector name: ${vector.name}`
    );
    names.add(vector.name);
  }
  assert.deepEqual(
    [...names],
    ["json-key-order-ab", "json-key-order-ba", "unicode-nfc", "unicode-nfd"]
  );
  validateAmbiguityExamples(value.vectors);
}

function validateVector(vector, index) {
  const label = `fixture.vectors[${index}]`;
  assertPlainObject(vector, label);
  assertExactKeys(vector, ["name", "inputs", "expected"], label);
  assert.match(vector.name, /^[a-z0-9]+(?:-[a-z0-9]+)*$/u);
  assertPlainObject(vector.inputs, `${label}.inputs`);
  assertExactKeys(
    vector.inputs,
    [
      "chainId",
      "registry",
      "issuer",
      "issuerNonce",
      "schemaId",
      "schemaVersion",
      "subject",
      "referenceHash",
      "contentUtf8",
      "metadataUtf8",
      "metadataUriUtf8",
      "supersedes",
    ],
    `${label}.inputs`
  );
  const input = vector.inputs;
  const chainId = parseUint(
    input.chainId,
    `${label}.inputs.chainId`,
    UINT256_MAX,
    true
  );
  const issuerNonce = parseUint(
    input.issuerNonce,
    `${label}.inputs.issuerNonce`,
    UINT256_MAX,
    false
  );
  const schemaVersion = parseUint(
    input.schemaVersion,
    `${label}.inputs.schemaVersion`,
    UINT32_MAX,
    true
  );
  assertChecksummedAddress(input.registry, `${label}.inputs.registry`, true);
  assertChecksummedAddress(input.issuer, `${label}.inputs.issuer`, true);
  assertBytes32(input.schemaId, `${label}.inputs.schemaId`, true);
  assertBytes32(input.subject, `${label}.inputs.subject`, true);
  assertBytes32(input.referenceHash, `${label}.inputs.referenceHash`, false);
  assertBytes32(input.supersedes, `${label}.inputs.supersedes`, false);
  assert.equal(
    input.supersedes,
    ZERO_BYTES32,
    `${label}.inputs.supersedes must remain zero in the v1 reference set`
  );
  assertUtf8Input(input.contentUtf8, `${label}.inputs.contentUtf8`, 4096);
  assertUtf8Input(input.metadataUtf8, `${label}.inputs.metadataUtf8`, 4096);
  assertUtf8Input(
    input.metadataUriUtf8,
    `${label}.inputs.metadataUriUtf8`,
    2048
  );
  assert.doesNotMatch(
    input.metadataUriUtf8,
    /[\u0000-\u001f\u007f]/u,
    `${label}.inputs.metadataUriUtf8 contains a control character`
  );

  assertPlainObject(vector.expected, `${label}.expected`);
  assertExactKeys(
    vector.expected,
    [
      "contentBytesHex",
      "metadataBytesHex",
      "metadataUriBytesHex",
      "contentHash",
      "metadataHash",
      "metadataUriHash",
      "commitmentAbiEncoded",
      "commitment",
      "attestationIdAbiEncoded",
      "attestationId",
    ],
    `${label}.expected`
  );
  const expected = vector.expected;
  const contentBytesHex = stringToHex(input.contentUtf8);
  const metadataBytesHex = stringToHex(input.metadataUtf8);
  const metadataUriBytesHex = stringToHex(input.metadataUriUtf8);
  assertHexBytes(expected.contentBytesHex, `${label}.expected.contentBytesHex`);
  assertHexBytes(
    expected.metadataBytesHex,
    `${label}.expected.metadataBytesHex`
  );
  assertHexBytes(
    expected.metadataUriBytesHex,
    `${label}.expected.metadataUriBytesHex`
  );
  assert.equal(expected.contentBytesHex, contentBytesHex);
  assert.equal(expected.metadataBytesHex, metadataBytesHex);
  assert.equal(expected.metadataUriBytesHex, metadataUriBytesHex);

  const contentHash = keccak256(contentBytesHex);
  const metadataHash = keccak256(metadataBytesHex);
  const metadataUriHash = keccak256(metadataUriBytesHex);
  assertBytes32(expected.contentHash, `${label}.expected.contentHash`, false);
  assertBytes32(expected.metadataHash, `${label}.expected.metadataHash`, false);
  assertBytes32(
    expected.metadataUriHash,
    `${label}.expected.metadataUriHash`,
    false
  );
  assert.equal(expected.contentHash, contentHash);
  assert.equal(expected.metadataHash, metadataHash);
  assert.equal(expected.metadataUriHash, metadataUriHash);

  const commitmentAbiEncoded = encodeAbiParameters(COMMITMENT_PARAMETERS, [
    input.schemaId,
    schemaVersion,
    input.subject,
    input.referenceHash,
    contentHash,
    metadataHash,
    metadataUriHash,
    input.supersedes,
  ]);
  assertHexBytes(
    expected.commitmentAbiEncoded,
    `${label}.expected.commitmentAbiEncoded`
  );
  assert.equal(expected.commitmentAbiEncoded, commitmentAbiEncoded);
  const commitment = keccak256(commitmentAbiEncoded);
  assertBytes32(expected.commitment, `${label}.expected.commitment`, false);
  assert.equal(expected.commitment, commitment);

  const attestationIdAbiEncoded = encodeAbiParameters(
    ATTESTATION_ID_PARAMETERS,
    [chainId, input.registry, input.issuer, issuerNonce, commitment]
  );
  assertHexBytes(
    expected.attestationIdAbiEncoded,
    `${label}.expected.attestationIdAbiEncoded`
  );
  assert.equal(expected.attestationIdAbiEncoded, attestationIdAbiEncoded);
  const attestationId = keccak256(attestationIdAbiEncoded);
  assertBytes32(
    expected.attestationId,
    `${label}.expected.attestationId`,
    false
  );
  assert.equal(expected.attestationId, attestationId);
}

function validateAmbiguityExamples(vectors) {
  const orderAb = vectors.find((vector) => vector.name === "json-key-order-ab");
  const orderBa = vectors.find((vector) => vector.name === "json-key-order-ba");
  assert.deepEqual(
    JSON.parse(orderAb.inputs.metadataUtf8),
    JSON.parse(orderBa.inputs.metadataUtf8),
    "JSON order vectors must be semantically equal after parsing"
  );
  assert.notEqual(orderAb.inputs.metadataUtf8, orderBa.inputs.metadataUtf8);
  assert.notEqual(
    orderAb.expected.metadataBytesHex,
    orderBa.expected.metadataBytesHex
  );
  assert.notEqual(orderAb.expected.metadataHash, orderBa.expected.metadataHash);

  const nfc = vectors.find((vector) => vector.name === "unicode-nfc");
  const nfd = vectors.find((vector) => vector.name === "unicode-nfd");
  assert.equal(
    nfc.inputs.contentUtf8.normalize("NFC"),
    nfd.inputs.contentUtf8.normalize("NFC"),
    "Unicode vectors must be visually equivalent after caller-selected NFC"
  );
  assert.notEqual(nfc.inputs.contentUtf8, nfd.inputs.contentUtf8);
  assert.notEqual(nfc.expected.contentBytesHex, nfd.expected.contentBytesHex);
  assert.notEqual(nfc.expected.contentHash, nfd.expected.contentHash);
}

function parseUint(value, label, maximum, positive) {
  let decimal;
  if (typeof value === "number") {
    assert.ok(Number.isSafeInteger(value) && value >= 0, `${label} is invalid`);
    decimal = String(value);
  } else {
    assert.match(value, /^(0|[1-9][0-9]*)$/u, `${label} is not canonical`);
    decimal = value;
  }
  const parsed = BigInt(decimal);
  assert.ok(parsed <= maximum, `${label} exceeds its ABI type`);
  if (positive) assert.notEqual(parsed, 0n, `${label} must be nonzero`);
  return parsed;
}

function assertChecksummedAddress(value, label, nonzero) {
  assert.equal(
    typeof value === "string" && isAddress(value, { strict: true }),
    true,
    `${label} is not a valid EVM address`
  );
  assert.equal(value, getAddress(value), `${label} is not EIP-55 checksummed`);
  if (nonzero) {
    assert.notEqual(
      value,
      "0x0000000000000000000000000000000000000000",
      `${label} must be nonzero`
    );
  }
}

function assertBytes32(value, label, nonzero) {
  assert.match(value, /^0x[0-9a-f]{64}$/u, `${label} is not canonical bytes32`);
  if (nonzero) assert.notEqual(value, ZERO_BYTES32, `${label} must be nonzero`);
}

function assertHexBytes(value, label) {
  assert.match(
    value,
    /^0x(?:[0-9a-f]{2})*$/u,
    `${label} is not canonical hex bytes`
  );
}

function assertUtf8Input(value, label, maximumBytes) {
  assert.equal(typeof value, "string", `${label} must be a string`);
  assert.ok(value.length > 0, `${label} must not be empty`);
  assert.ok(
    Buffer.byteLength(value, "utf8") <= maximumBytes,
    `${label} exceeds ${maximumBytes} UTF-8 bytes`
  );
}

function assertPlainObject(value, label) {
  assert.ok(
    value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.getPrototypeOf(value) === Object.prototype,
    `${label} must be a plain object`
  );
}

function assertExactKeys(value, expected, label) {
  assert.deepEqual(
    Object.keys(value).sort(),
    [...expected].sort(),
    `${label} has missing or unknown fields`
  );
}

function assertNoDuplicateJsonKeys(text) {
  let offset = 0;
  parseValue();
  skipWhitespace();
  if (offset !== text.length)
    throw new Error(`unexpected JSON token at byte ${offset}`);

  function parseValue() {
    skipWhitespace();
    const token = text[offset];
    if (token === "{") return parseObject();
    if (token === "[") return parseArray();
    if (token === '"') return parseString();
    if (token === "t") return consumeLiteral("true");
    if (token === "f") return consumeLiteral("false");
    if (token === "n") return consumeLiteral("null");
    return parseNumber();
  }

  function parseObject() {
    offset += 1;
    skipWhitespace();
    const keys = new Set();
    if (text[offset] === "}") {
      offset += 1;
      return;
    }
    while (offset < text.length) {
      skipWhitespace();
      const key = parseString();
      if (keys.has(key)) throw new Error(`duplicate JSON object key: ${key}`);
      keys.add(key);
      skipWhitespace();
      expect(":");
      parseValue();
      skipWhitespace();
      if (text[offset] === "}") {
        offset += 1;
        return;
      }
      expect(",");
    }
  }

  function parseArray() {
    offset += 1;
    skipWhitespace();
    if (text[offset] === "]") {
      offset += 1;
      return;
    }
    while (offset < text.length) {
      parseValue();
      skipWhitespace();
      if (text[offset] === "]") {
        offset += 1;
        return;
      }
      expect(",");
    }
  }

  function parseString() {
    const start = offset;
    expect('"');
    while (offset < text.length) {
      const character = text[offset];
      offset += 1;
      if (character === '"') return JSON.parse(text.slice(start, offset));
      if (character === "\\") offset += 1;
    }
    throw new Error("unterminated JSON string");
  }

  function parseNumber() {
    const match = text
      .slice(offset)
      .match(/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/u);
    if (!match) throw new Error(`unexpected JSON token at byte ${offset}`);
    offset += match[0].length;
  }

  function consumeLiteral(literal) {
    if (!text.startsWith(literal, offset)) {
      throw new Error(`unexpected JSON token at byte ${offset}`);
    }
    offset += literal.length;
  }

  function expect(character) {
    if (text[offset] !== character) {
      throw new Error(`expected ${character} at byte ${offset}`);
    }
    offset += 1;
  }

  function skipWhitespace() {
    while (/\s/u.test(text[offset] ?? "")) offset += 1;
  }
}
