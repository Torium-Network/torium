#!/usr/bin/env node

import { createHash, randomBytes } from "node:crypto";
import { open, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";

import { encodeAbiParameters, getAddress, isAddress, keccak256 } from "viem";

const UINT256_MAX = (1n << 256n) - 1n;
const CLAIM_KEYS = new Set(["index", "account", "amount"]);
const REQUIRED_FLAGS = new Set(["--input", "--output", "--epoch-id"]);
const LEAF_PARAMETERS = [
  { name: "epochId", type: "uint256" },
  { name: "index", type: "uint256" },
  { name: "account", type: "address" },
  { name: "amount", type: "uint256" },
];
const NODE_PARAMETERS = [
  { name: "leftHash", type: "bytes32" },
  { name: "leftSum", type: "uint256" },
  { name: "rightHash", type: "bytes32" },
  { name: "rightSum", type: "uint256" },
];

main().catch((error) => {
  console.error(`reward fixture generation failed: ${error.message}`);
  process.exitCode = 1;
});

async function main() {
  const arguments_ = parseArguments(process.argv.slice(2));
  const inputPath = path.resolve(process.cwd(), arguments_.get("--input"));
  const outputPath = path.resolve(process.cwd(), arguments_.get("--output"));
  if (inputPath === outputPath) {
    throw new Error("--input and --output must be different files");
  }
  if (path.extname(outputPath).toLowerCase() !== ".json") {
    throw new Error("--output must use the .json extension");
  }

  const epochId = parseUint256(arguments_.get("--epoch-id"), "--epoch-id");
  const inputBytes = await readFile(inputPath);
  const claims = normalizeClaims(parseClaims(inputBytes, inputPath));
  const payload = buildFixture(epochId, claims);
  const payloadBytes = serialize(payload);
  const fixture = {
    ...payload,
    integrity: {
      algorithm: "sha256",
      inputSha256: sha256(inputBytes),
      outputPayloadSha256: sha256(payloadBytes),
      outputPayloadSerialization: "json-stringify-2-space-utf8-lf-v1",
      outputPayloadScope:
        "byte-exact generator serialization of all top-level fields except integrity",
    },
  };
  const outputBytes = serialize(fixture);
  await atomicWrite(outputPath, outputBytes);
  console.log(
    `reward fixture generated: ${claims.length} claims, root ${fixture.merkleRoot}, sum ${fixture.rootSum}, output sha256 ${sha256(outputBytes)}`
  );
}

function parseArguments(argv) {
  if (argv.length === 1 && argv[0] === "--help") {
    console.log(
      "usage: node contracts/scripts/generate-reward-fixture.mjs --input <claims.csv|claims.json> --output <fixture.json> --epoch-id <uint256>"
    );
    process.exit(0);
  }
  if (argv.length % 2 !== 0) {
    throw new Error(
      "usage: --input <claims.csv|claims.json> --output <fixture.json> --epoch-id <uint256>"
    );
  }

  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!REQUIRED_FLAGS.has(flag)) throw new Error(`unknown flag: ${flag}`);
    if (values.has(flag)) throw new Error(`duplicate flag: ${flag}`);
    if (
      typeof value !== "string" ||
      value.length === 0 ||
      value.startsWith("--")
    ) {
      throw new Error(`${flag} requires a value`);
    }
    values.set(flag, value);
  }
  for (const flag of REQUIRED_FLAGS) {
    if (!values.has(flag)) throw new Error(`missing required flag: ${flag}`);
  }
  return values;
}

function parseClaims(inputBytes, inputPath) {
  const extension = path.extname(inputPath).toLowerCase();
  const text = inputBytes.toString("utf8");
  if (Buffer.from(text, "utf8").compare(inputBytes) !== 0) {
    throw new Error("input must be valid UTF-8");
  }
  if (extension === ".json") {
    let value;
    try {
      assertNoDuplicateJsonKeys(text);
      value = JSON.parse(text);
    } catch (error) {
      throw new Error(`invalid JSON input: ${error.message}`);
    }
    if (!Array.isArray(value)) {
      throw new Error("JSON input must be an array of claim objects");
    }
    return value;
  }
  if (extension === ".csv") return parseCsv(text);
  throw new Error("--input must use the .csv or .json extension");
}

function normalizeClaims(claims) {
  if (claims.length === 0) {
    throw new Error("input must contain at least one claim");
  }
  const indexes = new Set();
  const accounts = new Set();
  const normalized = claims.map((claim, position) => {
    const label = `claim[${position}]`;
    if (!isPlainObject(claim)) throw new Error(`${label} must be an object`);
    validateExactKeys(claim, CLAIM_KEYS, label);
    const index = parseUint256(claim.index, `${label}.index`);
    const account = parseAddress(claim.account, `${label}.account`, true);
    const amount = parseUint256(claim.amount, `${label}.amount`, true);
    const indexKey = index.toString();
    const accountKey = account.toLowerCase();
    if (indexes.has(indexKey)) {
      throw new Error(`${label}.index duplicates index ${indexKey}`);
    }
    if (accounts.has(accountKey)) {
      throw new Error(`${label}.account duplicates account ${account}`);
    }
    indexes.add(indexKey);
    accounts.add(accountKey);
    return { index, account, amount };
  });
  normalized.sort((left, right) =>
    left.index < right.index ? -1 : left.index > right.index ? 1 : 0
  );
  return normalized;
}

function buildFixture(epochId, claims) {
  const leaves = claims.map((claim) => ({
    claim,
    node: {
      hash: leafHash(epochId, claim),
      sum: claim.amount,
    },
  }));
  const { root, proofs } = buildMerkleSumTree(leaves);
  return {
    schemaVersion: 1,
    generatedBy: "contracts/scripts/generate-reward-fixture.mjs",
    treeFormat: {
      id: "torium-merkle-sum-v1",
      leafFields: ["epochId", "index", "account", "amount"],
      leafTypes: ["uint256", "uint256", "address", "uint256"],
      leafHash:
        "keccak256(abi.encode(uint256 epochId,uint256 index,address account,uint256 amount))",
      leafSum: "amount",
      leafOrdering: "hash-ascending",
      pairOrdering: "hash-ascending",
      parentFields: ["leftHash", "leftSum", "rightHash", "rightSum"],
      parentTypes: ["bytes32", "uint256", "bytes32", "uint256"],
      parentHash:
        "keccak256(abi.encode(bytes32 leftHash,uint256 leftSum,bytes32 rightHash,uint256 rightSum))",
      parentSum: "checked-leftSum-plus-rightSum",
      treeLayout: "complete-2n-minus-1",
    },
    epochId: epochId.toString(),
    merkleRoot: root.hash,
    rootSum: root.sum.toString(),
    claimCount: claims.length,
    claims: leaves.map(({ claim, node }) => ({
      index: claim.index.toString(),
      account: claim.account,
      amount: claim.amount.toString(),
      leafHash: node.hash,
      leafSum: node.sum.toString(),
      proof: proofs.get(claim.index.toString()).map((sibling) => ({
        hash: sibling.hash,
        sum: sibling.sum.toString(),
      })),
    })),
  };
}

function leafHash(epochId, claim) {
  return keccak256(
    encodeAbiParameters(LEAF_PARAMETERS, [
      epochId,
      claim.index,
      claim.account,
      claim.amount,
    ])
  );
}

// Leaves are hash-sorted and placed from the end of a complete 2n-1 array.
// This supports any positive leaf count without duplicating an odd leaf.
function buildMerkleSumTree(leaves) {
  const sorted = [...leaves].sort((left, right) =>
    compareHash(left.node.hash, right.node.hash)
  );
  for (let index = 1; index < sorted.length; index += 1) {
    if (sorted[index - 1].node.hash === sorted[index].node.hash) {
      throw new Error(
        "distinct claims produced an ambiguous duplicate leaf hash"
      );
    }
  }

  const tree = new Array(2 * sorted.length - 1);
  const indexes = new Map();
  for (const [position, leaf] of sorted.entries()) {
    const treeIndex = tree.length - 1 - position;
    tree[treeIndex] = leaf.node;
    indexes.set(leaf.claim.index.toString(), treeIndex);
  }
  for (let index = sorted.length - 2; index >= 0; index -= 1) {
    tree[index] = combine(tree[2 * index + 1], tree[2 * index + 2]);
  }

  const proofs = new Map();
  for (const leaf of leaves) {
    let index = indexes.get(leaf.claim.index.toString());
    const proof = [];
    while (index > 0) {
      proof.push(tree[index % 2 === 0 ? index - 1 : index + 1]);
      index = Math.floor((index - 1) / 2);
    }
    proofs.set(leaf.claim.index.toString(), proof);
  }
  return { root: tree[0], proofs };
}

function combine(first, second) {
  const order = compareHash(first.hash, second.hash);
  if (order === 0 && first.sum !== second.sum) {
    throw new Error("ambiguous equal node hashes carry different sums");
  }
  const [left, right] = order <= 0 ? [first, second] : [second, first];
  const sum = checkedAdd(left.sum, right.sum, "Merkle parent sum");
  return {
    hash: keccak256(
      encodeAbiParameters(NODE_PARAMETERS, [
        left.hash,
        left.sum,
        right.hash,
        right.sum,
      ])
    ),
    sum,
  };
}

function checkedAdd(left, right, label) {
  const value = left + right;
  if (value > UINT256_MAX) throw new Error(`${label} exceeds uint256`);
  return value;
}

function compareHash(left, right) {
  return Buffer.compare(hexBytes(left), hexBytes(right));
}

function hexBytes(value) {
  return Buffer.from(value.slice(2), "hex");
}

function parseUint256(value, label, positive = false) {
  let decimal;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(
        `${label} must be a safe nonnegative integer or canonical decimal string`
      );
    }
    decimal = String(value);
  } else if (typeof value === "string" && /^(0|[1-9][0-9]*)$/u.test(value)) {
    decimal = value;
  } else {
    throw new Error(`${label} must be a canonical nonnegative decimal uint256`);
  }
  const parsed = BigInt(decimal);
  if (parsed > UINT256_MAX) throw new Error(`${label} exceeds uint256`);
  if (positive && parsed === 0n) throw new Error(`${label} must be positive`);
  return parsed;
}

function parseAddress(value, label, nonzero) {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{40}$/u.test(value)) {
    throw new Error(`${label} must be a valid EVM address`);
  }
  if (!isAddress(value, { strict: true })) {
    throw new Error(`${label} has an invalid EIP-55 checksum`);
  }
  try {
    const address = getAddress(value);
    if (nonzero && /^0x0{40}$/u.test(address)) {
      throw new Error(`${label} must not be the zero address`);
    }
    return address;
  } catch (error) {
    if (nonzero && /^0x0{40}$/iu.test(value)) {
      throw new Error(`${label} must not be the zero address`);
    }
    if (error.message === `${label} must not be the zero address`) throw error;
    throw new Error(`${label} has an invalid EIP-55 checksum`);
  }
}

function parseCsv(text) {
  const rows = csvRows(text);
  if (rows.length < 2) {
    throw new Error("CSV input must contain a header and at least one claim");
  }
  const header = rows[0];
  for (const field of header) {
    if (!CLAIM_KEYS.has(field)) {
      throw new Error(`CSV header contains unknown field: ${field}`);
    }
  }
  if (
    header.length !== CLAIM_KEYS.size ||
    new Set(header).size !== header.length
  ) {
    throw new Error(
      "CSV header must contain each of index,account,amount exactly once"
    );
  }
  for (const field of CLAIM_KEYS) {
    if (!header.includes(field)) {
      throw new Error(`CSV header is missing field: ${field}`);
    }
  }
  return rows.slice(1).map((row, rowIndex) => {
    if (row.length !== header.length) {
      throw new Error(
        `CSV row ${rowIndex + 2} has ${row.length} fields; expected ${header.length}`
      );
    }
    return Object.fromEntries(
      header.map((field, index) => [field, row[index]])
    );
  });
}

function csvRows(text) {
  if (text.charCodeAt(0) === 0xfeff) {
    throw new Error("CSV input must not contain a UTF-8 BOM");
  }
  if (text.includes("\0"))
    throw new Error("CSV input must not contain NUL bytes");
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  let closedQuote = false;
  const finishField = () => {
    row.push(field);
    field = "";
    closedQuote = false;
  };
  const finishRow = () => {
    finishField();
    if (row.every((value) => value.length === 0)) {
      throw new Error(`CSV row ${rows.length + 1} must not be blank`);
    }
    rows.push(row);
    row = [];
  };

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
          closedQuote = true;
        }
      } else {
        field += character;
      }
      continue;
    }
    if (
      closedQuote &&
      character !== "," &&
      character !== "\n" &&
      character !== "\r"
    ) {
      throw new Error("CSV contains characters after a closing quote");
    }
    if (character === '"') {
      if (field.length !== 0) {
        throw new Error("CSV quote must begin at the start of a field");
      }
      quoted = true;
    } else if (character === ",") {
      finishField();
    } else if (character === "\n") {
      finishRow();
    } else if (character === "\r") {
      if (text[index + 1] !== "\n") {
        throw new Error("CSV carriage returns must be followed by a newline");
      }
    } else {
      field += character;
    }
  }
  if (quoted) throw new Error("CSV contains an unterminated quoted field");
  if (row.length > 0 || field.length > 0 || closedQuote) finishRow();
  return rows;
}

function assertNoDuplicateJsonKeys(text) {
  let offset = 0;
  parseValue();
  skipWhitespace();
  if (offset !== text.length) {
    throw new Error(`unexpected JSON token at byte ${offset}`);
  }

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

function validateExactKeys(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`${label}.${key} is not allowed`);
  }
  for (const key of allowed) {
    if (!Object.hasOwn(value, key)) {
      throw new Error(`${label}.${key} is required`);
    }
  }
}

async function atomicWrite(outputPath, bytes) {
  const temporaryPath = `${outputPath}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  let handle;
  try {
    handle = await open(temporaryPath, "wx", 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, outputPath);
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    await rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }
}

function serialize(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
