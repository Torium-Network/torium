import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { encodeAbiParameters, getAddress, keccak256 } from "viem";

assert.equal(
  process.env.TORIUM_OFFLINE_TEST,
  "1",
  "reward fixture tests must run through scripts/run-node-offline.sh"
);

const UINT256_MAX = (1n << 256n) - 1n;
const contractRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
const generator = path.join(
  contractRoot,
  "scripts/generate-reward-fixture.mjs"
);
const temporaryDirectory = path.join(
  contractRoot,
  ".work",
  `reward-fixture-tests-${process.pid}`
);
const committedFixturePath = path.join(
  contractRoot,
  "fixtures/rewards/example.fixture.json"
);
const epochId = "7";
const expectedRoot =
  "0xd692683c8bbeeed46328190d8263258744761627c555877d81b617cac717a95c";
const expectedPayloadSha256 =
  "86faf4d8e1fa898b22876b2f5d279ecaeef4cf817e4b633f416bd394cc21be7d";
const claims = [
  {
    index: "0",
    account: "0x1111111111111111111111111111111111111111",
    amount: "1000000000000000000",
  },
  {
    index: "1",
    account: "0x2222222222222222222222222222222222222222",
    amount: "2500000000000000000",
  },
  {
    index: "9",
    account: "0x3333333333333333333333333333333333333333",
    amount: "25",
  },
];
const leafParameters = [
  { name: "epochId", type: "uint256" },
  { name: "index", type: "uint256" },
  { name: "account", type: "address" },
  { name: "amount", type: "uint256" },
];
const nodeParameters = [
  { name: "leftHash", type: "bytes32" },
  { name: "leftSum", type: "uint256" },
  { name: "rightHash", type: "bytes32" },
  { name: "rightSum", type: "uint256" },
];

await mkdir(temporaryDirectory, { recursive: true });
test.after(async () => {
  await rm(temporaryDirectory, { recursive: true, force: true });
});

test("CSV and JSON produce the committed deterministic Merkle-sum vector", async () => {
  const jsonInput = await input(
    "parity.json",
    `${JSON.stringify(claims, null, 2)}\n`
  );
  const csvInput = await input(
    "parity.csv",
    `amount,index,account\n${claims.map((claim) => `${claim.amount},${claim.index},${claim.account}`).join("\n")}\n`
  );
  const jsonOutput = output("parity-json");
  const csvOutput = output("parity-csv");
  const jsonResult = generate(jsonInput, jsonOutput);
  const csvResult = generate(csvInput, csvOutput);
  assert.equal(jsonResult.status, 0, jsonResult.stderr);
  assert.equal(csvResult.status, 0, csvResult.stderr);

  const jsonBytes = await readFile(jsonOutput);
  const committedBytes = await readFile(committedFixturePath);
  assert.deepEqual(
    jsonBytes,
    committedBytes,
    "committed example fixture drifted from byte-exact generator output"
  );
  const jsonFixture = JSON.parse(jsonBytes);
  const csvFixture = JSON.parse(await readFile(csvOutput, "utf8"));
  const committed = JSON.parse(committedBytes);
  assert.deepEqual(
    withoutInputIntegrity(jsonFixture),
    withoutInputIntegrity(csvFixture)
  );
  assert.deepEqual(
    withoutInputIntegrity(jsonFixture),
    withoutInputIntegrity(committed)
  );
  assert.notEqual(
    jsonFixture.integrity.inputSha256,
    csvFixture.integrity.inputSha256
  );
  assert.equal(jsonFixture.rootSum, "3500000000000000025");
  assert.equal(jsonFixture.merkleRoot, expectedRoot);
  assert.equal(
    jsonFixture.integrity.outputPayloadSha256,
    expectedPayloadSha256
  );
  assert.equal(jsonFixture.claimCount, 3);
  assert.equal(jsonFixture.treeFormat.id, "torium-merkle-sum-v1");
});

test("output is byte-for-byte deterministic and input-order independent", async () => {
  const forward = await input(
    "determinism-forward.json",
    `${JSON.stringify(claims)}\n`
  );
  const reverse = await input(
    "determinism-reverse.json",
    `${JSON.stringify([...claims].reverse())}\n`
  );
  const firstOutput = output("determinism-first");
  const secondOutput = output("determinism-second");
  const reverseOutput = output("determinism-reverse");
  assert.equal(generate(forward, firstOutput).status, 0);
  assert.equal(generate(forward, secondOutput).status, 0);
  assert.equal(generate(reverse, reverseOutput).status, 0);

  const first = await readFile(firstOutput);
  const second = await readFile(secondOutput);
  assert.deepEqual(first, second);
  const firstFixture = JSON.parse(first);
  const reverseFixture = JSON.parse(await readFile(reverseOutput, "utf8"));
  assert.deepEqual(
    withoutInputIntegrity(firstFixture),
    withoutInputIntegrity(reverseFixture)
  );
  assert.deepEqual(
    firstFixture.claims.map((claim) => claim.index),
    ["0", "1", "9"]
  );
  const { integrity: _integrity, ...payload } = firstFixture;
  assert.equal(
    firstFixture.integrity.outputPayloadSha256,
    sha256(Buffer.from(`${JSON.stringify(payload, null, 2)}\n`))
  );
});

test("every hash-and-sum proof reconstructs the root", async () => {
  const inputPath = await input("proofs.json", `${JSON.stringify(claims)}\n`);
  const outputPath = output("proofs");
  const result = generate(inputPath, outputPath);
  assert.equal(result.status, 0, result.stderr);
  const fixture = JSON.parse(await readFile(outputPath, "utf8"));
  for (const claim of fixture.claims) {
    assert.equal(claim.leafSum, claim.amount);
    assert.equal(
      claim.leafHash,
      leafHash(fixture.epochId, claim.index, claim.account, claim.amount)
    );
    assert.equal(verifyClaim(fixture, claim), true);
    for (const sibling of claim.proof) {
      assert.match(sibling.hash, /^0x[0-9a-f]{64}$/u);
      assert.match(sibling.sum, /^(0|[1-9][0-9]*)$/u);
    }
  }
});

test("leaf, sibling hash, sibling sum, root hash and root sum tampering fails", async () => {
  const inputPath = await input("tamper.json", `${JSON.stringify(claims)}\n`);
  const outputPath = output("tamper");
  assert.equal(generate(inputPath, outputPath).status, 0);
  const fixture = JSON.parse(await readFile(outputPath, "utf8"));
  const claim = fixture.claims.find((candidate) => candidate.proof.length > 0);
  assert.ok(claim);
  assert.equal(verifyClaim(fixture, claim), true);

  const amountTamper = structuredClone(claim);
  amountTamper.amount = (BigInt(amountTamper.amount) + 1n).toString();
  assert.equal(verifyClaim(fixture, amountTamper), false);

  const leafSumTamper = structuredClone(claim);
  leafSumTamper.leafSum = (BigInt(leafSumTamper.leafSum) + 1n).toString();
  assert.equal(verifyClaim(fixture, leafSumTamper), false);

  const siblingHashTamper = structuredClone(claim);
  siblingHashTamper.proof[0].hash = flipHash(siblingHashTamper.proof[0].hash);
  assert.equal(verifyClaim(fixture, siblingHashTamper), false);

  const siblingSumTamper = structuredClone(claim);
  siblingSumTamper.proof[0].sum = (
    BigInt(siblingSumTamper.proof[0].sum) + 1n
  ).toString();
  assert.equal(verifyClaim(fixture, siblingSumTamper), false);

  assert.equal(
    verifyClaim(
      { ...fixture, merkleRoot: flipHash(fixture.merkleRoot) },
      claim
    ),
    false
  );
  assert.equal(
    verifyClaim(
      { ...fixture, rootSum: (BigInt(fixture.rootSum) + 1n).toString() },
      claim
    ),
    false
  );
});

test("single-claim tree has an empty proof and exact root sum", async () => {
  const inputPath = await input(
    "single.json",
    `${JSON.stringify([claims[0]])}\n`
  );
  const outputPath = output("single");
  const result = generate(inputPath, outputPath);
  assert.equal(result.status, 0, result.stderr);
  const fixture = JSON.parse(await readFile(outputPath, "utf8"));
  assert.deepEqual(fixture.claims[0].proof, []);
  assert.equal(fixture.merkleRoot, fixture.claims[0].leafHash);
  assert.equal(fixture.rootSum, fixture.claims[0].amount);
  assert.equal(verifyClaim(fixture, fixture.claims[0]), true);
});

test("strictly rejects malformed values, duplicate claims and uint256 overflow", async (t) => {
  const invalidCases = [
    [
      "negative-index",
      [{ ...claims[0], index: "-1" }],
      /index must be a canonical nonnegative/u,
    ],
    [
      "noncanonical-index",
      [{ ...claims[0], index: "01" }],
      /index must be a canonical nonnegative/u,
    ],
    [
      "zero-amount",
      [{ ...claims[0], amount: "0" }],
      /amount must be positive/u,
    ],
    [
      "bad-address",
      [{ ...claims[0], account: "0x1234" }],
      /valid EVM address/u,
    ],
    [
      "zero-account",
      [{ ...claims[0], account: `0x${"00".repeat(20)}` }],
      /must not be the zero address/u,
    ],
    [
      "bad-checksum",
      [{ ...claims[0], account: "0x5a384227B65FA093DEC03Ec34e111Db80A040615" }],
      /invalid EIP-55 checksum/u,
    ],
    [
      "duplicate-index",
      [claims[0], { ...claims[1], index: claims[0].index }],
      /duplicates index/u,
    ],
    [
      "duplicate-account",
      [
        claims[0],
        {
          ...claims[1],
          account: claims[0].account.toUpperCase().replace("0X", "0x"),
        },
      ],
      /duplicates account/u,
    ],
    [
      "value-overflow",
      [{ ...claims[0], amount: (UINT256_MAX + 1n).toString() }],
      /exceeds uint256/u,
    ],
    [
      "parent-sum-overflow",
      [
        { ...claims[0], amount: UINT256_MAX.toString() },
        { ...claims[1], amount: "1" },
      ],
      /parent sum exceeds uint256/u,
    ],
    [
      "unknown-field",
      [{ ...claims[0], memo: "not allowed" }],
      /memo is not allowed/u,
    ],
    [
      "missing-field",
      [{ index: "0", account: claims[0].account }],
      /amount is required/u,
    ],
  ];

  for (const [name, value, message] of invalidCases) {
    await t.test(name, async () => {
      const inputPath = await input(
        `${name}.json`,
        `${JSON.stringify(value)}\n`
      );
      const result = generate(inputPath, output(name));
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, message);
    });
  }
});

test("rejects duplicate JSON members, unknown CLI flags and invalid CSV headers", async () => {
  const duplicateMember = await input(
    "duplicate-member.json",
    `[{"index":"0","account":"${claims[0].account}","amount":"1","amount":"2"}]\n`
  );
  const duplicateResult = generate(duplicateMember, output("duplicate-member"));
  assert.notEqual(duplicateResult.status, 0);
  assert.match(duplicateResult.stderr, /duplicate JSON object key: amount/u);

  const validInput = await input("strict.json", `${JSON.stringify(claims)}\n`);
  const unknownFlag = spawnGenerator([
    "--input",
    validInput,
    "--output",
    output("unknown-flag"),
    "--wat",
    epochId,
  ]);
  assert.notEqual(unknownFlag.status, 0);
  assert.match(unknownFlag.stderr, /unknown flag: --wat/u);

  const duplicateFlag = spawnGenerator([
    "--input",
    validInput,
    "--output",
    output("duplicate-flag"),
    "--epoch-id",
    epochId,
    "--epoch-id",
    epochId,
  ]);
  assert.notEqual(duplicateFlag.status, 0);
  assert.match(duplicateFlag.stderr, /duplicate flag: --epoch-id/u);

  const unknownCsv = await input(
    "unknown.csv",
    `index,account,amount,memo\n0,${claims[0].account},1,nope\n`
  );
  const unknownCsvResult = generate(unknownCsv, output("unknown-csv"));
  assert.notEqual(unknownCsvResult.status, 0);
  assert.match(unknownCsvResult.stderr, /unknown field: memo/u);
});

async function input(name, contents) {
  const filePath = path.join(temporaryDirectory, name);
  await writeFile(filePath, contents);
  return filePath;
}

function output(name) {
  return path.join(temporaryDirectory, `${name}.fixture.json`);
}

function generate(inputPath, outputPath) {
  return spawnGenerator([
    "--input",
    inputPath,
    "--output",
    outputPath,
    "--epoch-id",
    epochId,
  ]);
}

function spawnGenerator(arguments_) {
  return spawnSync(process.execPath, [generator, ...arguments_], {
    cwd: contractRoot,
    encoding: "utf8",
    timeout: 30_000,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      NODE_ENV: "test",
      TORIUM_OFFLINE_TEST: "1",
    },
  });
}

function withoutInputIntegrity(fixture) {
  return {
    ...fixture,
    integrity: {
      ...fixture.integrity,
      inputSha256: "<source-specific>",
    },
  };
}

function verifyClaim(fixture, claim) {
  try {
    const expectedLeafHash = leafHash(
      fixture.epochId,
      claim.index,
      claim.account,
      claim.amount
    );
    if (claim.leafHash !== expectedLeafHash || claim.leafSum !== claim.amount) {
      return false;
    }
    let node = { hash: expectedLeafHash, sum: BigInt(claim.amount) };
    for (const sibling of claim.proof) {
      node = combine(node, { hash: sibling.hash, sum: BigInt(sibling.sum) });
    }
    return (
      node.hash === fixture.merkleRoot && node.sum === BigInt(fixture.rootSum)
    );
  } catch {
    return false;
  }
}

function leafHash(epoch, index, account, amount) {
  return keccak256(
    encodeAbiParameters(leafParameters, [
      BigInt(epoch),
      BigInt(index),
      getAddress(account),
      BigInt(amount),
    ])
  );
}

function combine(first, second) {
  const comparison = Buffer.compare(
    hexBytes(first.hash),
    hexBytes(second.hash)
  );
  if (comparison === 0 && first.sum !== second.sum) {
    throw new Error("ambiguous equal node hashes");
  }
  const [left, right] = comparison <= 0 ? [first, second] : [second, first];
  const sum = left.sum + right.sum;
  if (sum > UINT256_MAX) throw new Error("uint256 overflow");
  return {
    hash: keccak256(
      encodeAbiParameters(nodeParameters, [
        left.hash,
        left.sum,
        right.hash,
        right.sum,
      ])
    ),
    sum,
  };
}

function flipHash(value) {
  const finalNibble = value.at(-1) === "0" ? "1" : "0";
  return `${value.slice(0, -1)}${finalNibble}`;
}

function hexBytes(value) {
  return Buffer.from(value.slice(2), "hex");
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
