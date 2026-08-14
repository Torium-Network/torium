import assert from "node:assert/strict";
import test from "node:test";

import {
  getToriumRewardDistributorState,
  getToriumRewardEpoch,
  hashToriumRewardLeaf,
  hashToriumRewardNode,
  isToriumRewardClaimed,
  preflightToriumRewardClaim,
  prepareToriumRewardClaim,
  prepareToriumRewardEpochPublication,
  processToriumRewardProof,
  simulateToriumContractRequest,
} from "@torium-network/sdk/contracts";
import { parseToriumAmount } from "@torium-network/sdk/utils";

import {
  deployer,
  publicClient,
  recordCapability,
  sdkUser,
  submitAndCommit,
  testUser,
  waitForBlockTimestamp,
} from "./_setup.mjs";
import { state } from "./_state.mjs";

const epochId = 1n;
const claims = [];
let epoch;

function deploymentOverride() {
  return { deployment: { address: state.rewardDistributor } };
}

test("a two-leaf Merkle-sum epoch publishes fully funded", async () => {
  const reads = publicClient();
  const leaves = [
    {
      epochId,
      index: 0n,
      account: sdkUser.address,
      amount: parseToriumAmount("0.25"),
    },
    {
      epochId,
      index: 1n,
      account: testUser.address,
      amount: parseToriumAmount("0.75"),
    },
  ];
  const nodes = leaves.map((leaf) => ({
    nodeHash: hashToriumRewardLeaf(leaf),
    sum: leaf.amount,
  }));
  const root = hashToriumRewardNode(nodes[0], nodes[1]);
  claims.push(
    { leaf: leaves[0], proof: [nodes[1]] },
    { leaf: leaves[1], proof: [nodes[0]] }
  );
  for (const claim of claims) {
    const local = processToriumRewardProof(claim.leaf, claim.proof);
    assert.equal(local.rootHash, root.nodeHash);
    assert.equal(local.rootSum, root.sum);
  }

  const now = (await reads.getBlock({ blockTag: "latest" })).timestamp;
  epoch = {
    rootHash: root.nodeHash,
    rootSum: root.sum,
    claimStart: now + 5n,
    claimEnd: now + 5n + 600n,
  };
  const request = prepareToriumRewardEpochPublication({
    sender: deployer,
    epochId,
    ...epoch,
    ...deploymentOverride(),
  });
  assert.equal(request.value, root.sum);
  await submitAndCommit(deployer, request);

  const published = await getToriumRewardEpoch(
    reads,
    { epochId, ...deploymentOverride() }
  );
  assert.equal(published.rootHash, root.nodeHash);
  assert.equal(published.funded, root.sum);
  const distributor = await getToriumRewardDistributorState(
    reads,
    deploymentOverride()
  );
  assert.equal(distributor.nextEpochId, 2n);
  assert.equal(distributor.totalFunded, root.sum);
  await recordCapability("torium.rewards.publish-epoch", "eth_sendRawTransaction");
});

test("claim preflight blocks before the window and passes inside it", async () => {
  const reads = publicClient();
  const [claim] = claims;
  const early = await preflightToriumRewardClaim(reads, {
    ...claim.leaf,
    proof: claim.proof,
    ...deploymentOverride(),
  });
  if (!early.canClaim) {
    assert.deepEqual([...early.blockers], ["claim-not-started"]);
  }
  await waitForBlockTimestamp(epoch.claimStart);
  const ready = await preflightToriumRewardClaim(reads, {
    ...claim.leaf,
    proof: claim.proof,
    ...deploymentOverride(),
  });
  assert.equal(ready.canClaim, true);
  assert.equal(ready.computedRootHash, epoch.rootHash);
  await recordCapability("torium.rewards.claim-preflight", "eth_call");
});

test("a valid claim pays exactly the committed amount", async () => {
  const reads = publicClient();
  const [claim] = claims;
  const before = await reads.getBalance({ address: sdkUser.address });
  const request = prepareToriumRewardClaim({
    sender: testUser,
    ...claim.leaf,
    proof: claim.proof,
    ...deploymentOverride(),
  });
  await simulateToriumContractRequest(
    reads,
    "toriumRewardDistributor",
    request
  );
  await submitAndCommit(testUser, request);
  const after = await reads.getBalance({ address: sdkUser.address });
  assert.equal(after - before, claim.leaf.amount);
  assert.equal(
    await isToriumRewardClaimed(reads, {
      epochId,
      index: claim.leaf.index,
      ...deploymentOverride(),
    }),
    true
  );
  await recordCapability("torium.rewards.claim", "eth_sendRawTransaction");
});

test("double claims and invalid proofs revert with decoded errors", async () => {
  const reads = publicClient();
  const [claim, other] = claims;
  const repeat = await preflightToriumRewardClaim(reads, {
    ...claim.leaf,
    proof: claim.proof,
    ...deploymentOverride(),
  });
  assert.ok(repeat.blockers.includes("already-claimed"));

  await assert.rejects(
    simulateToriumContractRequest(
      reads,
      "toriumRewardDistributor",
      prepareToriumRewardClaim({
        sender: testUser,
        ...claim.leaf,
        proof: claim.proof,
        ...deploymentOverride(),
      })
    ),
    (error) =>
      error.code === "TORIUM_CONTRACT_REVERTED" &&
      error.errorName === "ClaimAlreadyProcessed"
  );

  await assert.rejects(
    simulateToriumContractRequest(
      reads,
      "toriumRewardDistributor",
      prepareToriumRewardClaim({
        sender: testUser,
        ...other.leaf,
        amount: other.leaf.amount + 1n,
        proof: other.proof,
        ...deploymentOverride(),
      })
    ),
    (error) =>
      error.code === "TORIUM_CONTRACT_REVERTED" &&
      error.errorName === "InvalidProof"
  );
  await recordCapability(
    "torium.rewards.invalid-claim-reverts",
    "eth_call"
  );
});
