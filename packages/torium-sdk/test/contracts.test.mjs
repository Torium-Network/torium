import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  decodeFunctionData,
  encodeErrorResult,
  keccak256,
  zeroHash,
} from "viem";

import {
  computeToriumAttestationCommitment,
  computeToriumAttestationId,
  computeToriumAttestationReplayKey,
  decodeToriumContractRevert,
  extractToriumRevertData,
  getToriumAttestation,
  getToriumAttestationStatus,
  getToriumRewardDistributorState,
  getToriumRewardEpoch,
  hashToriumAttestationUtf8,
  hashToriumRewardLeaf,
  hashToriumRewardNode,
  isToriumRewardClaimed,
  preflightToriumAttestation,
  preflightToriumAttestationRevocation,
  preflightToriumRewardClaim,
  prepareToriumAttestation,
  prepareToriumAttestationRevocation,
  prepareToriumRewardClaim,
  prepareToriumRewardClawback,
  prepareToriumRewardEpochPublication,
  processToriumRewardProof,
  resolveToriumContractDeployment,
  simulateToriumContractRequest,
  toriumAttestationRegistryAbi,
  toriumContractAbis,
  toriumContractNames,
  toriumContractRegistryChainId,
  toriumLocalnetContractRegistry,
  toriumRewardDistributorAbi,
  toriumRewardDistributorRoles,
  validateToriumAttestationPayload,
  verifyToriumAttestation,
  verifyToriumContractDeployment,
} from "../dist/esm/contracts.js";

const attestationVectors = JSON.parse(
  await readFile(
    new URL(
      "../../../contracts/fixtures/attestations/canonical-hash-v1.json",
      import.meta.url
    ),
    "utf8"
  )
);
const rewardFixture = JSON.parse(
  await readFile(
    new URL(
      "../../../contracts/fixtures/rewards/example.fixture.json",
      import.meta.url
    ),
    "utf8"
  )
);

const distributorAddress = "0x1111111111111111111111111111111111111111";
const registryAddress = "0x2222222222222222222222222222222222222222";
const issuerAddress = "0x5A384227B65FA093DEC03Ec34e111Db80A040615";
const otherAddress = "0x3333333333333333333333333333333333333333";

function createReadClient(handlers, extras = {}) {
  return {
    async readContract({ functionName, args }) {
      const handler = handlers[functionName];
      if (handler === undefined) {
        throw new Error(`unexpected readContract ${functionName}`);
      }
      return typeof handler === "function" ? handler(args ?? []) : handler;
    },
    ...extras,
  };
}

function fixtureLeaf(claim) {
  return {
    epochId: BigInt(rewardFixture.epochId),
    index: BigInt(claim.index),
    account: claim.account,
    amount: BigInt(claim.amount),
  };
}

function fixtureProof(claim) {
  return claim.proof.map((node) => ({
    nodeHash: node.hash,
    sum: BigInt(node.sum),
  }));
}

test("generated registry and ABI surfaces stay raw and exposed", () => {
  assert.deepEqual(
    Object.keys(toriumContractAbis).sort(),
    [...toriumContractNames].sort()
  );
  assert.equal(
    toriumContractRegistryChainId,
    toriumLocalnetContractRegistry.chain.evmChainId
  );
  assert.equal(
    toriumRewardDistributorRoles.epochPublisher,
    keccak256(new TextEncoder().encode("EPOCH_PUBLISHER_ROLE"))
  );
});

test("attestation canonical hash helpers reproduce every committed vector", () => {
  assert.ok(attestationVectors.vectors.length >= 3);
  for (const vector of attestationVectors.vectors) {
    const { inputs, expected } = vector;
    const payload = {
      schemaId: inputs.schemaId,
      schemaVersion: Number(inputs.schemaVersion),
      subject: inputs.subject,
      referenceHash: inputs.referenceHash,
      contentHash: hashToriumAttestationUtf8(inputs.contentUtf8),
      metadataHash: hashToriumAttestationUtf8(inputs.metadataUtf8),
      metadataUriHash: hashToriumAttestationUtf8(inputs.metadataUriUtf8),
    };
    assert.equal(payload.contentHash, expected.contentHash, vector.name);
    assert.equal(payload.metadataHash, expected.metadataHash, vector.name);
    assert.equal(
      payload.metadataUriHash,
      expected.metadataUriHash,
      vector.name
    );
    const commitment = computeToriumAttestationCommitment(
      payload,
      inputs.supersedes
    );
    assert.equal(commitment, expected.commitment, vector.name);
    assert.equal(
      computeToriumAttestationId({
        chainId: BigInt(inputs.chainId),
        registry: inputs.registry,
        issuer: inputs.issuer,
        issuerNonce: BigInt(inputs.issuerNonce),
        commitment,
      }),
      expected.attestationId,
      vector.name
    );
  }
});

test("attestation payload validation mirrors the contract zero checks", () => {
  const payload = {
    schemaId: keccak256(new TextEncoder().encode("schema")),
    schemaVersion: 1,
    subject: keccak256(new TextEncoder().encode("subject")),
    contentHash: hashToriumAttestationUtf8("content"),
    metadataHash: hashToriumAttestationUtf8("{}"),
    metadataUriHash: hashToriumAttestationUtf8("ipfs://x"),
  };
  validateToriumAttestationPayload(payload);
  assert.throws(
    () => validateToriumAttestationPayload({ ...payload, schemaId: zeroHash }),
    RangeError
  );
  assert.throws(
    () => validateToriumAttestationPayload({ ...payload, schemaVersion: 0 }),
    RangeError
  );
  assert.throws(
    () =>
      validateToriumAttestationPayload({
        ...payload,
        metadataUriHash: zeroHash,
      }),
    RangeError
  );
  assert.notEqual(
    computeToriumAttestationReplayKey(issuerAddress, payload),
    computeToriumAttestationCommitment(payload)
  );
});

test("reward Merkle-sum helpers reproduce the committed fixture", () => {
  assert.equal(rewardFixture.claims.length, Number(rewardFixture.claimCount));
  for (const claim of rewardFixture.claims) {
    const leaf = fixtureLeaf(claim);
    assert.equal(hashToriumRewardLeaf(leaf), claim.leafHash);
    const { rootHash, rootSum } = processToriumRewardProof(
      leaf,
      fixtureProof(claim)
    );
    assert.equal(rootHash, rewardFixture.merkleRoot);
    assert.equal(rootSum, BigInt(rewardFixture.rootSum));
  }
});

test("reward node hashing is order-insensitive like the contract", () => {
  const first = { nodeHash: keccak256("0x01"), sum: 5n };
  const second = { nodeHash: keccak256("0x02"), sum: 7n };
  assert.deepEqual(
    hashToriumRewardNode(first, second),
    hashToriumRewardNode(second, first)
  );
});

test("tampered reward claims stop reproducing the committed root", () => {
  const claim = rewardFixture.claims[0];
  const tampered = { ...fixtureLeaf(claim), amount: BigInt(claim.amount) + 1n };
  const { rootHash } = processToriumRewardProof(tampered, fixtureProof(claim));
  assert.notEqual(rootHash, rewardFixture.merkleRoot);
});

test("malformed reward proof nodes are rejected exactly like the contract", () => {
  const claim = rewardFixture.claims[0];
  assert.throws(
    () =>
      processToriumRewardProof(fixtureLeaf(claim), [
        { nodeHash: zeroHash, sum: 1n },
      ]),
    /malformed/u
  );
  assert.throws(
    () =>
      processToriumRewardProof(fixtureLeaf(claim), [
        { nodeHash: keccak256("0x01"), sum: 0n },
      ]),
    /malformed/u
  );
});

test("registry deployments without broadcast addresses fail closed", () => {
  for (const contractName of [
    "toriumRewardDistributor",
    "toriumAttestationRegistry",
  ]) {
    assert.throws(
      () => resolveToriumContractDeployment(contractName),
      (error) => error.code === "TORIUM_CONTRACT_NOT_DEPLOYED"
    );
  }
  const factory = resolveToriumContractDeployment("toriumCreate2Factory");
  assert.equal(
    factory.address,
    toriumLocalnetContractRegistry.contracts.toriumCreate2Factory.address
  );
  assert.equal(
    factory.runtimeCodeKeccak256,
    toriumLocalnetContractRegistry.contracts.toriumCreate2Factory
      .runtimeCodeKeccak256
  );
});

test("custom deployments override the registry for local testing", () => {
  const deployment = resolveToriumContractDeployment(
    "toriumRewardDistributor",
    { deployment: { address: distributorAddress } }
  );
  assert.equal(deployment.address, distributorAddress);
  assert.equal(
    deployment.runtimeCodeKeccak256,
    toriumLocalnetContractRegistry.contracts.toriumRewardDistributor
      .runtimeCodeKeccak256
  );
  const foreign = resolveToriumContractDeployment("toriumRewardDistributor", {
    deployment: { address: distributorAddress, implementationVersion: "2.0.0" },
  });
  assert.equal(foreign.runtimeCodeKeccak256, null);
});

test("implementation version expectations are enforced", () => {
  assert.throws(
    () =>
      resolveToriumContractDeployment("toriumRewardDistributor", {
        deployment: {
          address: distributorAddress,
          implementationVersion: "2.0.0",
        },
        expectedImplementationVersion: "1.0.0",
      }),
    (error) => error.code === "TORIUM_CONTRACT_VERSION_MISMATCH"
  );
});

test("deployment verification detects wrong and drifted deployments", async () => {
  const runtimeCode = "0x6001600101";
  const deployment = resolveToriumContractDeployment(
    "toriumRewardDistributor",
    {
      deployment: {
        address: distributorAddress,
        runtimeCodeKeccak256: keccak256(runtimeCode),
      },
    }
  );

  const verified = await verifyToriumContractDeployment(
    { getCode: async () => runtimeCode },
    deployment
  );
  assert.equal(verified.runtimeCodeKeccak256, keccak256(runtimeCode));

  await assert.rejects(
    verifyToriumContractDeployment({ getCode: async () => "0x" }, deployment),
    (error) => error.code === "TORIUM_CONTRACT_CODE_MISSING"
  );
  await assert.rejects(
    verifyToriumContractDeployment(
      { getCode: async () => "0xdeadbeef" },
      deployment
    ),
    (error) => error.code === "TORIUM_CONTRACT_CODE_MISMATCH"
  );

  const unpinned = resolveToriumContractDeployment("toriumRewardDistributor", {
    deployment: { address: distributorAddress, implementationVersion: "9.9.9" },
  });
  await assert.rejects(
    verifyToriumContractDeployment(
      { getCode: async () => runtimeCode },
      unpinned
    ),
    (error) => error.code === "TORIUM_CONTRACT_CONFIG_INVALID"
  );
});

test("custom-error reverts decode against the generated ABIs", () => {
  const revertData = encodeErrorResult({
    abi: toriumAttestationRegistryAbi,
    errorName: "IssuerMismatch",
    args: [issuerAddress, otherAddress],
  });
  const decoded = decodeToriumContractRevert(
    "toriumAttestationRegistry",
    revertData
  );
  assert.equal(decoded.errorName, "IssuerMismatch");
  assert.equal(decoded.args.length, 2);
  assert.equal(decodeToriumContractRevert("toriumNative", revertData), null);
  assert.equal(
    extractToriumRevertData({ cause: { cause: { data: revertData } } }),
    revertData
  );
});

test("simulation surfaces decoded unauthorized-issuer reverts", async () => {
  const revertData = encodeErrorResult({
    abi: toriumAttestationRegistryAbi,
    errorName: "IssuerMismatch",
    args: [issuerAddress, otherAddress],
  });
  const request = prepareToriumAttestationRevocation({
    sender: otherAddress,
    attestationId: keccak256("0x01"),
    revocationReasonHash: keccak256("0x02"),
    deployment: { address: registryAddress },
  });
  await assert.rejects(
    simulateToriumContractRequest(
      {
        call: async () => {
          throw Object.assign(new Error("execution reverted"), {
            data: revertData,
          });
        },
      },
      "toriumAttestationRegistry",
      request
    ),
    (error) =>
      error.code === "TORIUM_CONTRACT_REVERTED" &&
      error.errorName === "IssuerMismatch" &&
      error.revertData === revertData
  );
});

test("simulation surfaces decoded invalid-proof reverts", async () => {
  const revertData = encodeErrorResult({
    abi: toriumRewardDistributorAbi,
    errorName: "InvalidProof",
    args: [keccak256("0x01"), 5n],
  });
  const claim = rewardFixture.claims[0];
  const request = prepareToriumRewardClaim({
    sender: otherAddress,
    ...fixtureLeaf(claim),
    proof: fixtureProof(claim),
    deployment: { address: distributorAddress },
  });
  await assert.rejects(
    simulateToriumContractRequest(
      {
        call: async () => {
          throw Object.assign(new Error("execution reverted"), {
            cause: { data: revertData },
          });
        },
      },
      "toriumRewardDistributor",
      request
    ),
    (error) =>
      error.code === "TORIUM_CONTRACT_REVERTED" &&
      error.errorName === "InvalidProof"
  );
});

test("reward reads parse distributor state, epochs, and claim bits", async () => {
  const claim = rewardFixture.claims[0];
  const epochTuple = [
    rewardFixture.merkleRoot,
    BigInt(rewardFixture.rootSum),
    100n,
    200n,
    0n,
    0n,
  ];
  const client = createReadClient({
    nextEpochId: 2n,
    totalFunded: BigInt(rewardFixture.rootSum),
    totalClaimed: 0n,
    totalClawed: 0n,
    treasury: otherAddress,
    publicationDelay: 3600n,
    clawbackDelay: 3600n,
    paused: false,
    epochs: (args) =>
      args[0] === BigInt(rewardFixture.epochId)
        ? epochTuple
        : [zeroHash, 0n, 0n, 0n, 0n, 0n],
    isClaimed: () => false,
  });
  const parameters = { deployment: { address: distributorAddress } };

  const state = await getToriumRewardDistributorState(client, parameters);
  assert.equal(state.nextEpochId, 2n);
  assert.equal(state.paused, false);

  const epoch = await getToriumRewardEpoch(client, {
    ...parameters,
    epochId: BigInt(rewardFixture.epochId),
  });
  assert.equal(epoch.rootHash, rewardFixture.merkleRoot);
  assert.equal(epoch.funded, BigInt(rewardFixture.rootSum));

  assert.equal(
    await getToriumRewardEpoch(client, { ...parameters, epochId: 999n }),
    null
  );
  assert.equal(
    await isToriumRewardClaimed(client, {
      ...parameters,
      epochId: BigInt(rewardFixture.epochId),
      index: BigInt(claim.index),
    }),
    false
  );
});

test("reward claim preflight passes a valid fixture claim", async () => {
  const claim = rewardFixture.claims[0];
  const client = createReadClient(
    {
      epochs: [
        rewardFixture.merkleRoot,
        BigInt(rewardFixture.rootSum),
        100n,
        200n,
        0n,
        0n,
      ],
      isClaimed: false,
      paused: false,
    },
    { getBlock: async () => ({ timestamp: 150n }) }
  );
  const preflight = await preflightToriumRewardClaim(client, {
    ...fixtureLeaf(claim),
    proof: fixtureProof(claim),
    deployment: { address: distributorAddress },
  });
  assert.equal(preflight.canClaim, true);
  assert.deepEqual([...preflight.blockers], []);
  assert.equal(preflight.computedRootHash, rewardFixture.merkleRoot);
});

test("reward claim preflight reports every contract blocker", async () => {
  const claim = rewardFixture.claims[0];
  const run = (overrides, leafOverrides = {}, proofOverride) =>
    preflightToriumRewardClaim(
      createReadClient(
        {
          epochs: overrides.epochs ?? [
            rewardFixture.merkleRoot,
            BigInt(rewardFixture.rootSum),
            100n,
            200n,
            0n,
            0n,
          ],
          isClaimed: overrides.isClaimed ?? false,
          paused: overrides.paused ?? false,
        },
        { getBlock: async () => ({ timestamp: overrides.timestamp ?? 150n }) }
      ),
      {
        ...fixtureLeaf(claim),
        ...leafOverrides,
        proof: proofOverride ?? fixtureProof(claim),
        deployment: { address: distributorAddress },
      }
    );

  assert.deepEqual(
    [...(await run({ epochs: [zeroHash, 0n, 0n, 0n, 0n, 0n] })).blockers],
    ["epoch-not-found"]
  );
  assert.deepEqual(
    [...(await run({ paused: true })).blockers],
    ["distributor-paused"]
  );
  assert.deepEqual(
    [...(await run({ timestamp: 50n })).blockers],
    ["claim-not-started"]
  );
  assert.deepEqual(
    [...(await run({ timestamp: 200n })).blockers],
    ["claim-window-closed"]
  );
  assert.deepEqual(
    [...(await run({ isClaimed: true })).blockers],
    ["already-claimed"]
  );
  assert.deepEqual(
    [...(await run({}, { amount: BigInt(claim.amount) + 1n })).blockers],
    ["invalid-proof"]
  );
  assert.deepEqual(
    [...(await run({}, {}, [{ nodeHash: zeroHash, sum: 1n }])).blockers],
    ["malformed-proof"]
  );
});

test("prepared reward transactions encode the exact contract calls", () => {
  const claim = rewardFixture.claims[0];
  const request = prepareToriumRewardClaim({
    sender: otherAddress,
    ...fixtureLeaf(claim),
    proof: fixtureProof(claim),
    deployment: { address: distributorAddress },
  });
  assert.equal(request.to, distributorAddress);
  assert.equal(request.value, 0n);
  const decoded = decodeFunctionData({
    abi: toriumRewardDistributorAbi,
    data: request.data,
  });
  assert.equal(decoded.functionName, "claim");
  assert.equal(decoded.args[0], BigInt(rewardFixture.epochId));

  const publication = prepareToriumRewardEpochPublication({
    sender: otherAddress,
    epochId: 1n,
    rootHash: rewardFixture.merkleRoot,
    rootSum: BigInt(rewardFixture.rootSum),
    claimStart: 100n,
    claimEnd: 200n,
    deployment: { address: distributorAddress },
  });
  assert.equal(publication.value, BigInt(rewardFixture.rootSum));
  assert.equal(
    decodeFunctionData({
      abi: toriumRewardDistributorAbi,
      data: publication.data,
    }).functionName,
    "publishEpoch"
  );
  assert.throws(
    () =>
      prepareToriumRewardEpochPublication({
        sender: otherAddress,
        epochId: 1n,
        rootHash: zeroHash,
        rootSum: 1n,
        claimStart: 100n,
        claimEnd: 200n,
        deployment: { address: distributorAddress },
      }),
    RangeError
  );

  const clawback = prepareToriumRewardClawback({
    sender: otherAddress,
    epochId: 1n,
    deployment: { address: distributorAddress },
  });
  assert.equal(
    decodeFunctionData({
      abi: toriumRewardDistributorAbi,
      data: clawback.data,
    }).functionName,
    "clawback"
  );
});

test("attestation reads parse status and full records", async () => {
  const attestationId = keccak256("0x11");
  const record = {
    schemaId: keccak256("0x12"),
    schemaVersion: 3n,
    issuer: issuerAddress,
    issuerNonce: 4n,
    subject: keccak256("0x13"),
    referenceHash: zeroHash,
    contentHash: keccak256("0x14"),
    metadataHash: keccak256("0x15"),
    metadataUriHash: keccak256("0x16"),
    supersedes: zeroHash,
    supersededBy: zeroHash,
    createdAt: 1000n,
    revokedAt: 0n,
    supersededAt: 0n,
    revocationReasonHash: zeroHash,
  };
  const client = createReadClient({
    statusOf: (args) => (args[0] === attestationId ? 1 : 0),
    getAttestation: record,
    verify: true,
  });
  const parameters = { deployment: { address: registryAddress } };

  assert.equal(
    await getToriumAttestationStatus(client, { ...parameters, attestationId }),
    "active"
  );
  const attestation = await getToriumAttestation(client, {
    ...parameters,
    attestationId,
  });
  assert.equal(attestation.status, "active");
  assert.equal(attestation.schemaVersion, 3);
  assert.equal(attestation.issuer, issuerAddress);

  assert.equal(
    await getToriumAttestation(client, {
      ...parameters,
      attestationId: keccak256("0xff"),
    }),
    null
  );
  assert.equal(
    await verifyToriumAttestation(client, {
      ...parameters,
      attestationId,
      expectedIssuer: issuerAddress,
      expectedCommitment: keccak256("0x17"),
    }),
    true
  );
});

test("attestation preflight predicts identity and blocks rule violations", async () => {
  const payload = {
    schemaId: keccak256("0x21"),
    schemaVersion: 1,
    subject: keccak256("0x22"),
    contentHash: hashToriumAttestationUtf8("content"),
    metadataHash: hashToriumAttestationUtf8("{}"),
    metadataUriHash: hashToriumAttestationUtf8("ipfs://x"),
  };
  const supersedes = keccak256("0x23");
  const priorRecord = {
    schemaId: payload.schemaId,
    schemaVersion: 1n,
    issuer: issuerAddress,
    issuerNonce: 1n,
    subject: payload.subject,
    referenceHash: zeroHash,
    contentHash: keccak256("0x24"),
    metadataHash: keccak256("0x25"),
    metadataUriHash: keccak256("0x26"),
    supersedes: zeroHash,
    supersededBy: zeroHash,
    createdAt: 1000n,
    revokedAt: 0n,
    supersededAt: 0n,
    revocationReasonHash: zeroHash,
  };
  const run = (overrides = {}) =>
    preflightToriumAttestation(
      createReadClient(
        {
          usedPayloads: overrides.usedPayloads ?? false,
          issuerNonces: 6n,
          statusOf: overrides.statusOf ?? 1,
          getAttestation: overrides.getAttestation ?? priorRecord,
        },
        { getChainId: async () => toriumContractRegistryChainId }
      ),
      {
        issuer: overrides.issuer ?? issuerAddress,
        payload,
        supersedes: overrides.supersedes ?? supersedes,
        deployment: { address: registryAddress },
      }
    );

  const clean = await run();
  assert.equal(clean.canAttest, true);
  assert.equal(clean.predictedIssuerNonce, 7n);
  assert.equal(
    clean.predictedCommitment,
    computeToriumAttestationCommitment(payload, supersedes)
  );
  assert.equal(
    clean.predictedAttestationId,
    computeToriumAttestationId({
      chainId: toriumContractRegistryChainId,
      registry: registryAddress,
      issuer: issuerAddress,
      issuerNonce: 7n,
      commitment: clean.predictedCommitment,
    })
  );

  assert.deepEqual(
    [...(await run({ usedPayloads: true })).blockers],
    ["duplicate-payload"]
  );
  assert.deepEqual(
    [...(await run({ statusOf: 0 })).blockers],
    ["supersedes-not-found"]
  );
  assert.deepEqual(
    [...(await run({ statusOf: 3 })).blockers],
    ["supersedes-not-active"]
  );
  assert.deepEqual(
    [
      ...(
        await run({ getAttestation: { ...priorRecord, issuer: otherAddress } })
      ).blockers,
    ],
    ["supersedes-issuer-mismatch"]
  );
  assert.deepEqual(
    [
      ...(
        await run({
          getAttestation: { ...priorRecord, schemaId: keccak256("0x27") },
        })
      ).blockers,
    ],
    ["supersedes-schema-mismatch"]
  );
  assert.deepEqual(
    [
      ...(
        await run({
          getAttestation: { ...priorRecord, subject: keccak256("0x28") },
        })
      ).blockers,
    ],
    ["supersedes-subject-mismatch"]
  );
});

test("attestation revocation preflight blocks revoked and foreign records", async () => {
  const attestationId = keccak256("0x31");
  const record = {
    schemaId: keccak256("0x32"),
    schemaVersion: 1n,
    issuer: issuerAddress,
    issuerNonce: 1n,
    subject: keccak256("0x33"),
    referenceHash: zeroHash,
    contentHash: keccak256("0x34"),
    metadataHash: keccak256("0x35"),
    metadataUriHash: keccak256("0x36"),
    supersedes: zeroHash,
    supersededBy: zeroHash,
    createdAt: 1000n,
    revokedAt: 0n,
    supersededAt: 0n,
    revocationReasonHash: zeroHash,
  };
  const run = (statusOf, issuer) =>
    preflightToriumAttestationRevocation(
      createReadClient({ statusOf, getAttestation: record }),
      {
        attestationId,
        issuer,
        deployment: { address: registryAddress },
      }
    );

  assert.equal((await run(1, issuerAddress)).canRevoke, true);
  assert.deepEqual(
    [...(await run(0, issuerAddress)).blockers],
    ["attestation-not-found"]
  );
  assert.deepEqual(
    [...(await run(3, issuerAddress)).blockers],
    ["attestation-not-active"]
  );
  assert.deepEqual(
    [...(await run(1, otherAddress)).blockers],
    ["issuer-mismatch"]
  );
});

test("prepared attestation transactions encode the exact contract calls", () => {
  const payload = {
    schemaId: keccak256("0x41"),
    schemaVersion: 2,
    subject: keccak256("0x42"),
    contentHash: hashToriumAttestationUtf8("content"),
    metadataHash: hashToriumAttestationUtf8("{}"),
    metadataUriHash: hashToriumAttestationUtf8("ipfs://x"),
  };
  const request = prepareToriumAttestation({
    sender: issuerAddress,
    payload,
    deployment: { address: registryAddress },
  });
  const decoded = decodeFunctionData({
    abi: toriumAttestationRegistryAbi,
    data: request.data,
  });
  assert.equal(decoded.functionName, "attest");
  assert.equal(decoded.args[0], payload.schemaId);
  assert.equal(decoded.args[3], zeroHash);
  assert.equal(decoded.args[7], zeroHash);

  const revocation = prepareToriumAttestationRevocation({
    sender: issuerAddress,
    attestationId: keccak256("0x43"),
    revocationReasonHash: keccak256("0x44"),
    deployment: { address: registryAddress },
  });
  assert.equal(
    decodeFunctionData({
      abi: toriumAttestationRegistryAbi,
      data: revocation.data,
    }).functionName,
    "revoke"
  );
  assert.throws(
    () =>
      prepareToriumAttestationRevocation({
        sender: issuerAddress,
        attestationId: keccak256("0x43"),
        revocationReasonHash: zeroHash,
        deployment: { address: registryAddress },
      }),
    RangeError
  );
});
