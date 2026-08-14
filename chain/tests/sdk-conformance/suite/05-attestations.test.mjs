import assert from "node:assert/strict";
import test from "node:test";

import {
  computeToriumAttestationCommitment,
  getToriumAttestation,
  getToriumAttestationStatus,
  hashToriumAttestationUtf8,
  preflightToriumAttestation,
  preflightToriumAttestationRevocation,
  prepareToriumAttestation,
  prepareToriumAttestationRevocation,
  simulateToriumContractRequest,
  verifyToriumAttestation,
} from "@torium-network/sdk/contracts";

import {
  publicClient,
  recordCapability,
  sdkUser,
  submitAndCommit,
  testUser,
} from "./_setup.mjs";
import { state } from "./_state.mjs";

const payload = {
  schemaId: hashToriumAttestationUtf8("torium.conformance.schema.v1"),
  schemaVersion: 1,
  subject: hashToriumAttestationUtf8("torium.conformance.subject.v1"),
  contentHash: hashToriumAttestationUtf8("conformance content v1"),
  metadataHash: hashToriumAttestationUtf8('{"suite":"sdk-conformance"}'),
  metadataUriHash: hashToriumAttestationUtf8("ipfs://torium-conformance/v1"),
};
const replacementPayload = {
  ...payload,
  contentHash: hashToriumAttestationUtf8("conformance content v2"),
};
let firstAttestationId;
let replacementAttestationId;

function deploymentOverride() {
  return { deployment: { address: state.attestationRegistry } };
}

test("issuance preflight predicts the exact on-chain attestation identity", async () => {
  const reads = publicClient();
  const preflight = await preflightToriumAttestation(reads, {
    issuer: sdkUser.address,
    payload,
    ...deploymentOverride(),
  });
  assert.equal(preflight.canAttest, true);
  firstAttestationId = preflight.predictedAttestationId;

  await submitAndCommit(
    sdkUser,
    prepareToriumAttestation({
      sender: sdkUser,
      payload,
      ...deploymentOverride(),
    })
  );

  const attestation = await getToriumAttestation(reads, {
    attestationId: firstAttestationId,
    ...deploymentOverride(),
  });
  assert.ok(attestation, "predicted attestation ID must exist on-chain");
  assert.equal(attestation.status, "active");
  assert.equal(attestation.issuer, sdkUser.address);
  assert.equal(attestation.contentHash, payload.contentHash);
  await recordCapability(
    "torium.attestations.issue-with-predicted-id",
    "eth_sendRawTransaction"
  );
});

test("on-chain verification agrees with the local canonical commitment", async () => {
  const reads = publicClient();
  const commitment = computeToriumAttestationCommitment(payload);
  assert.equal(
    await verifyToriumAttestation(reads, {
      attestationId: firstAttestationId,
      expectedIssuer: sdkUser.address,
      expectedCommitment: commitment,
      ...deploymentOverride(),
    }),
    true
  );
  assert.equal(
    await verifyToriumAttestation(reads, {
      attestationId: firstAttestationId,
      expectedIssuer: testUser.address,
      expectedCommitment: commitment,
      ...deploymentOverride(),
    }),
    false
  );
  await recordCapability("torium.attestations.verify", "eth_call");
});

test("replayed payloads are blocked and revert with decoded errors", async () => {
  const reads = publicClient();
  const preflight = await preflightToriumAttestation(reads, {
    issuer: sdkUser.address,
    payload,
    ...deploymentOverride(),
  });
  assert.deepEqual([...preflight.blockers], ["duplicate-payload"]);
  await assert.rejects(
    simulateToriumContractRequest(
      reads,
      "toriumAttestationRegistry",
      prepareToriumAttestation({
        sender: sdkUser,
        payload,
        ...deploymentOverride(),
      })
    ),
    (error) =>
      error.code === "TORIUM_CONTRACT_REVERTED" &&
      error.errorName === "DuplicatePayload"
  );
  await recordCapability("torium.attestations.replay-blocked", "eth_call");
});

test("supersession retires the prior record under the same issuer", async () => {
  const reads = publicClient();
  const preflight = await preflightToriumAttestation(reads, {
    issuer: sdkUser.address,
    payload: replacementPayload,
    supersedes: firstAttestationId,
    ...deploymentOverride(),
  });
  assert.equal(preflight.canAttest, true);
  replacementAttestationId = preflight.predictedAttestationId;

  await submitAndCommit(
    sdkUser,
    prepareToriumAttestation({
      sender: sdkUser,
      payload: replacementPayload,
      supersedes: firstAttestationId,
      ...deploymentOverride(),
    })
  );

  assert.equal(
    await getToriumAttestationStatus(reads, {
      attestationId: firstAttestationId,
      ...deploymentOverride(),
    }),
    "superseded"
  );
  const replacement = await getToriumAttestation(reads, {
    attestationId: replacementAttestationId,
    ...deploymentOverride(),
  });
  assert.equal(replacement.status, "active");
  assert.equal(replacement.supersedes, firstAttestationId);
  await recordCapability(
    "torium.attestations.supersede",
    "eth_sendRawTransaction"
  );
});

test("only the issuer can revoke, and revocation is recorded", async () => {
  const reads = publicClient();
  const foreign = await preflightToriumAttestationRevocation(reads, {
    attestationId: replacementAttestationId,
    issuer: testUser.address,
    ...deploymentOverride(),
  });
  assert.deepEqual([...foreign.blockers], ["issuer-mismatch"]);
  await assert.rejects(
    simulateToriumContractRequest(
      reads,
      "toriumAttestationRegistry",
      prepareToriumAttestationRevocation({
        sender: testUser,
        attestationId: replacementAttestationId,
        revocationReasonHash: hashToriumAttestationUtf8("not yours"),
        ...deploymentOverride(),
      })
    ),
    (error) =>
      error.code === "TORIUM_CONTRACT_REVERTED" &&
      error.errorName === "IssuerMismatch"
  );

  await submitAndCommit(
    sdkUser,
    prepareToriumAttestationRevocation({
      sender: sdkUser,
      attestationId: replacementAttestationId,
      revocationReasonHash: hashToriumAttestationUtf8(
        "torium.conformance.revocation.v1"
      ),
      ...deploymentOverride(),
    })
  );
  assert.equal(
    await getToriumAttestationStatus(reads, {
      attestationId: replacementAttestationId,
      ...deploymentOverride(),
    }),
    "revoked"
  );
  const revoked = await preflightToriumAttestationRevocation(reads, {
    attestationId: replacementAttestationId,
    issuer: sdkUser.address,
    ...deploymentOverride(),
  });
  assert.deepEqual([...revoked.blockers], ["attestation-not-active"]);
  await recordCapability(
    "torium.attestations.revoke",
    "eth_sendRawTransaction"
  );
});
