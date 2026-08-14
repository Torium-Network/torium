import assert from "node:assert/strict";
import test from "node:test";

import { summarizeCaseSamples } from "./summarize-samples.mjs";

test("summarizes deterministic local samples without p99 or confidence claims", () => {
  const result = summarizeCaseSamples({
    caseId: "synthetic-1",
    workloadId: "native-transfer-closed-loop",
    startedAtMilliseconds: 1000,
    endedAtMilliseconds: 5000,
    samples: [
      {
        outcome: "success",
        included: true,
        acknowledgementLatencyMilliseconds: 20,
        inclusionLatencyMilliseconds: 100,
        receiptLatencyMilliseconds: 110,
        gasUsed: 21000,
      },
      {
        outcome: "success",
        included: true,
        acknowledgementLatencyMilliseconds: 30,
        inclusionLatencyMilliseconds: 200,
        receiptLatencyMilliseconds: 210,
        gasUsed: 21000,
      },
      {
        outcome: "expected-revert",
        included: true,
        acknowledgementLatencyMilliseconds: 40,
        inclusionLatencyMilliseconds: 300,
        receiptLatencyMilliseconds: 310,
        gasUsed: 30000,
      },
      {
        outcome: "unexpected-revert",
        included: true,
        acknowledgementLatencyMilliseconds: 45,
        inclusionLatencyMilliseconds: 350,
        receiptLatencyMilliseconds: 360,
      },
      {
        outcome: "submission-failed",
        included: false,
        acknowledgementLatencyMilliseconds: 50,
      },
      { outcome: "dropped", included: false },
    ],
  });

  assert.deepEqual(result.counts, {
    sample: 6,
    includedCommitted: 4,
    committedSuccess: 2,
    committedRevert: 1,
    unexpectedRevert: 1,
    submissionFailed: 1,
    dropped: 1,
  });
  assert.equal(result.includedCommittedTps, 1);
  assert.equal(result.successfulTps, 0.5);
  assert.deepEqual(result.latencyMilliseconds.acknowledgement, {
    sampleCount: 5,
    minimum: 20,
    p50: 40,
    p95: 50,
    maximum: 50,
    mean: 37,
  });
  assert.equal(result.latencyMilliseconds.inclusion.p95, 350);
  assert.equal(result.latencyMilliseconds.receipt.p50, 210);
  assert.deepEqual(result.gasUsed, {
    sampleCount: 3,
    total: 72000,
    mean: 24000,
  });
  assert.equal("p99" in result.latencyMilliseconds.receipt, false);
});

test("rejects empty, negative and unsupported sample input", () => {
  assert.throws(
    () =>
      summarizeCaseSamples({
        caseId: "x",
        workloadId: "x",
        startedAtMilliseconds: 0,
        endedAtMilliseconds: 1,
        samples: [],
      }),
    /non-empty array/u
  );
  assert.throws(
    () =>
      summarizeCaseSamples({
        caseId: "x",
        workloadId: "x",
        startedAtMilliseconds: 0,
        endedAtMilliseconds: 1,
        samples: [
          {
            outcome: "submission-failed",
            included: false,
            acknowledgementLatencyMilliseconds: -1,
          },
        ],
      }),
    /non-negative/u
  );
  assert.throws(
    () =>
      summarizeCaseSamples({
        caseId: "x",
        workloadId: "x",
        startedAtMilliseconds: 0,
        endedAtMilliseconds: 1,
        samples: [{ outcome: "unknown", included: false }],
      }),
    /unsupported outcome/u
  );
  assert.throws(
    () =>
      summarizeCaseSamples({
        caseId: "x",
        workloadId: "x",
        startedAtMilliseconds: 0,
        endedAtMilliseconds: 1,
        samples: [{ outcome: "expected-revert", included: false }],
      }),
    /inconsistent/u
  );
  assert.throws(
    () =>
      summarizeCaseSamples({
        caseId: "x",
        workloadId: "x",
        startedAtMilliseconds: 0,
        endedAtMilliseconds: 1,
        samples: [
          {
            outcome: "dropped",
            included: false,
            inclusionLatencyMilliseconds: 1,
          },
        ],
      }),
    /non-included/u
  );
  assert.throws(
    () =>
      summarizeCaseSamples({
        caseId: "x",
        workloadId: "x",
        startedAtMilliseconds: 0,
        endedAtMilliseconds: 1,
        samples: [
          {
            outcome: "success",
            included: true,
            acknowledgementLatencyMilliseconds: 2,
            inclusionLatencyMilliseconds: 1,
          },
        ],
      }),
    /exceeds inclusion/u
  );
});
