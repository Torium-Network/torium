import assert from "node:assert/strict";
import test from "node:test";

import {
  getToriumStateQueryCapability,
  toriumReadCapabilities,
} from "../dist/esm/clients.js";

test("capabilities preserve the upstream tag deviations", () => {
  assert.deepEqual(getToriumStateQueryCapability("latest"), {
    state: "supported",
    usableByStableHelper: true,
  });
  assert.deepEqual(getToriumStateQueryCapability("pending"), {
    state: "partial",
    usableByStableHelper: false,
  });
  assert.deepEqual(getToriumStateQueryCapability("safe"), {
    state: "unsupported",
    usableByStableHelper: false,
  });
  assert.deepEqual(getToriumStateQueryCapability("finalized"), {
    state: "partial",
    usableByStableHelper: true,
    meaning: "latest-committed-cometbft-state",
  });
  assert.equal(
    toriumReadCapabilities.blockTags.pending.distinctStateViewProven,
    false
  );
});

test("finality and subscription metadata do not overclaim", () => {
  assert.equal(toriumReadCapabilities.finality.label, "CometBFT committed");
  assert.equal(toriumReadCapabilities.finality.beaconChainSemantics, false);
  assert.equal(
    toriumReadCapabilities.subscriptions.pendingTransactions.baseline,
    "supported"
  );
  assert.equal(
    toriumReadCapabilities.subscriptions.pendingTransactions.activeLocalProfile,
    "supported"
  );
  assert.equal(toriumReadCapabilities.subscriptions.serverReplay, false);
  assert.equal(toriumReadCapabilities.cosmosExtension.status, "stub");
  assert.equal(toriumReadCapabilities.cosmosExtension.usable, false);
  assert.equal(Object.isFrozen(toriumReadCapabilities), true);
  assert.equal(Object.isFrozen(toriumReadCapabilities.finality), true);
});
