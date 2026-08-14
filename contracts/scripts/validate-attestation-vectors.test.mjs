import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { encodeAbiParameters, keccak256, stringToHex } from "viem";

assert.equal(
  process.env.TORIUM_OFFLINE_TEST,
  "1",
  "run through scripts/run-node-offline.sh"
);

const contractRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
const validator = path.join(
  contractRoot,
  "scripts/validate-attestation-vectors.mjs"
);
const fixturePath = path.join(
  contractRoot,
  "fixtures/attestations/canonical-hash-v1.json"
);
const temporaryRoot = path.join(
  contractRoot,
  ".work",
  `attestation-vector-tests-${process.pid}`
);
const source = await readFile(fixturePath, "utf8");
const fixture = JSON.parse(source);

test.before(async () => mkdir(temporaryRoot, { recursive: true }));
test.after(async () => rm(temporaryRoot, { recursive: true, force: true }));

test("validates the checked-in reference set offline", () => {
  const result = runValidator(fixturePath);
  assert.equal(result.status, 0, result.stderr);
  assert.match(
    result.stdout,
    /Validated 4 offline attestation canonical-byte vectors/u
  );
});

test("matches an independently recomputed exact-byte commitment and ID", () => {
  const vector = fixture.vectors[0];
  const input = vector.inputs;
  const contentHash = keccak256(stringToHex(input.contentUtf8));
  const metadataHash = keccak256(stringToHex(input.metadataUtf8));
  const metadataUriHash = keccak256(stringToHex(input.metadataUriUtf8));
  assert.equal(
    contentHash,
    "0xe3c9864ce56fd4cecf6cd1820ec0145cb6dfb75bcb6cf643ce6def88d162c57f"
  );
  assert.equal(
    metadataHash,
    "0xb8ffb64722137f4b100665a52e3c943f8066e8ab8ba3b427e6f4b404defd82b0"
  );
  const commitment = keccak256(
    encodeAbiParameters(
      [
        { type: "bytes32" },
        { type: "uint32" },
        { type: "bytes32" },
        { type: "bytes32" },
        { type: "bytes32" },
        { type: "bytes32" },
        { type: "bytes32" },
        { type: "bytes32" },
      ],
      [
        input.schemaId,
        input.schemaVersion,
        input.subject,
        input.referenceHash,
        contentHash,
        metadataHash,
        metadataUriHash,
        input.supersedes,
      ]
    )
  );
  assert.equal(commitment, vector.expected.commitment);
  const attestationId = keccak256(
    encodeAbiParameters(
      [
        { type: "uint256" },
        { type: "address" },
        { type: "address" },
        { type: "uint256" },
        { type: "bytes32" },
      ],
      [
        BigInt(input.chainId),
        input.registry,
        input.issuer,
        BigInt(input.issuerNonce),
        commitment,
      ]
    )
  );
  assert.equal(
    attestationId,
    "0x51ee9be3f49f132ee8f952726a7701fe069e397bd6eeacc008f3973e3c41a532"
  );
});

test("documents byte ambiguity instead of silently normalizing it", () => {
  const [orderAb, orderBa, nfc, nfd] = fixture.vectors;
  assert.deepEqual(
    JSON.parse(orderAb.inputs.metadataUtf8),
    JSON.parse(orderBa.inputs.metadataUtf8)
  );
  assert.notEqual(orderAb.expected.metadataHash, orderBa.expected.metadataHash);
  assert.equal(
    nfc.inputs.contentUtf8.normalize("NFC"),
    nfd.inputs.contentUtf8.normalize("NFC")
  );
  assert.notEqual(nfc.expected.contentHash, nfd.expected.contentHash);
});

test("rejects tampered bytes, derived hashes, and commitment inputs", async (t) => {
  const cases = [
    ["content bytes", (value) => (value.vectors[0].inputs.contentUtf8 += "!")],
    [
      "metadata hash",
      (value) =>
        (value.vectors[0].expected.metadataHash = `0x${"11".repeat(32)}`),
    ],
    [
      "URI bytes",
      (value) => (value.vectors[0].inputs.metadataUriUtf8 += "#changed"),
    ],
    [
      "commitment",
      (value) =>
        (value.vectors[0].expected.commitment = `0x${"22".repeat(32)}`),
    ],
    [
      "attestation ID",
      (value) =>
        (value.vectors[0].expected.attestationId = `0x${"33".repeat(32)}`),
    ],
    [
      "supersedes",
      (value) => (value.vectors[0].inputs.supersedes = `0x${"44".repeat(32)}`),
    ],
  ];

  for (const [name, mutate] of cases) {
    await t.test(name, async () => {
      const value = structuredClone(fixture);
      mutate(value);
      await expectRejectedFixture(
        `${name.replaceAll(" ", "-")}.json`,
        JSON.stringify(value)
      );
    });
  }
});

test("rejects unknown fields and duplicate JSON members", async () => {
  const unknown = structuredClone(fixture);
  unknown.vectors[0].inputs.unrecognized = true;
  await expectRejectedFixture("unknown-field.json", JSON.stringify(unknown));

  const duplicate = source.replace(
    '"schemaVersion": 1,',
    '"schemaVersion": 1, "schemaVersion": 1,'
  );
  await expectRejectedFixture("duplicate-member.json", duplicate);
});

async function expectRejectedFixture(name, contents) {
  const target = path.join(temporaryRoot, name);
  await writeFile(target, contents, "utf8");
  const result = runValidator(target);
  assert.notEqual(
    result.status,
    0,
    `tampered fixture unexpectedly passed: ${name}`
  );
}

function runValidator(target) {
  return spawnSync(process.execPath, [validator, "--fixture", target], {
    cwd: contractRoot,
    encoding: "utf8",
    env: process.env,
  });
}
