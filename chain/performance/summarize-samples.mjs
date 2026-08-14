#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const OUTCOMES = new Set([
  "success",
  "expected-revert",
  "unexpected-revert",
  "submission-failed",
  "dropped",
]);

export function summarizeCaseSamples(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("input must be an object");
  }
  const {
    caseId,
    workloadId,
    startedAtMilliseconds,
    endedAtMilliseconds,
    samples,
  } = input;
  if (typeof caseId !== "string" || caseId.length === 0) {
    throw new TypeError("caseId must be a non-empty string");
  }
  if (typeof workloadId !== "string" || workloadId.length === 0) {
    throw new TypeError("workloadId must be a non-empty string");
  }
  assertNonNegativeFinite(startedAtMilliseconds, "startedAtMilliseconds");
  assertNonNegativeFinite(endedAtMilliseconds, "endedAtMilliseconds");
  if (endedAtMilliseconds <= startedAtMilliseconds) {
    throw new RangeError(
      "endedAtMilliseconds must be greater than startedAtMilliseconds"
    );
  }
  if (!Array.isArray(samples) || samples.length === 0) {
    throw new TypeError("samples must be a non-empty array");
  }

  const counts = {
    sample: samples.length,
    includedCommitted: 0,
    committedSuccess: 0,
    committedRevert: 0,
    unexpectedRevert: 0,
    submissionFailed: 0,
    dropped: 0,
  };
  const acknowledgementLatencies = [];
  const inclusionLatencies = [];
  const receiptLatencies = [];
  const gasValues = [];

  for (const [index, sample] of samples.entries()) {
    if (!sample || typeof sample !== "object" || Array.isArray(sample)) {
      throw new TypeError(`sample ${index} must be an object`);
    }
    if (!OUTCOMES.has(sample.outcome)) {
      throw new TypeError(`sample ${index} has an unsupported outcome`);
    }
    if (typeof sample.included !== "boolean") {
      throw new TypeError(`sample ${index} included must be boolean`);
    }
    const committedOutcome =
      sample.outcome === "success" ||
      sample.outcome === "expected-revert" ||
      sample.outcome === "unexpected-revert";
    if (sample.included !== committedOutcome) {
      throw new TypeError(
        `sample ${index} inclusion and outcome are inconsistent`
      );
    }
    counts[toCountKey(sample.outcome)] += 1;
    if (sample.included) {
      counts.includedCommitted += 1;
    } else if (
      sample.inclusionLatencyMilliseconds !== undefined ||
      sample.receiptLatencyMilliseconds !== undefined
    ) {
      throw new TypeError(
        `sample ${index} non-included outcome cannot have inclusion or receipt latency`
      );
    }
    collectLatency(
      sample,
      "acknowledgementLatencyMilliseconds",
      acknowledgementLatencies,
      index
    );
    collectLatency(
      sample,
      "inclusionLatencyMilliseconds",
      inclusionLatencies,
      index
    );
    collectLatency(
      sample,
      "receiptLatencyMilliseconds",
      receiptLatencies,
      index
    );
    assertLatencyOrder(sample, index);
    if (sample.gasUsed !== undefined) {
      if (!sample.included) {
        throw new TypeError(`sample ${index} gasUsed requires inclusion`);
      }
      assertNonNegativeSafeInteger(sample.gasUsed, `sample ${index} gasUsed`);
      gasValues.push(sample.gasUsed);
    }
  }

  const elapsedMilliseconds = endedAtMilliseconds - startedAtMilliseconds;
  const gasTotal = gasValues.reduce((sum, value) => sum + value, 0);
  return {
    caseType: "transaction",
    caseId,
    workloadId,
    counts,
    elapsedMilliseconds,
    includedCommittedTps: round(
      counts.includedCommitted / (elapsedMilliseconds / 1000)
    ),
    successfulTps: round(
      counts.committedSuccess / (elapsedMilliseconds / 1000)
    ),
    latencyMilliseconds: {
      acknowledgement: summarizeNumbers(acknowledgementLatencies),
      inclusion: summarizeNumbers(inclusionLatencies),
      receipt: summarizeNumbers(receiptLatencies),
    },
    gasUsed: {
      sampleCount: gasValues.length,
      total: round(gasTotal),
      mean: gasValues.length === 0 ? null : round(gasTotal / gasValues.length),
    },
    limitations: [
      "exploratory-local-summary-only",
      "no-p99-or-formal-confidence-claim",
    ],
  };
}

function summarizeNumbers(values) {
  if (values.length === 0) {
    return {
      sampleCount: 0,
      minimum: null,
      p50: null,
      p95: null,
      maximum: null,
      mean: null,
    };
  }
  const sorted = [...values].sort((left, right) => left - right);
  const total = sorted.reduce((sum, value) => sum + value, 0);
  return {
    sampleCount: sorted.length,
    minimum: round(sorted[0]),
    p50: round(nearestRank(sorted, 0.5)),
    p95: round(nearestRank(sorted, 0.95)),
    maximum: round(sorted.at(-1)),
    mean: round(total / sorted.length),
  };
}

function nearestRank(sorted, percentile) {
  return sorted[Math.max(0, Math.ceil(percentile * sorted.length) - 1)];
}

function toCountKey(outcome) {
  return {
    success: "committedSuccess",
    "expected-revert": "committedRevert",
    "unexpected-revert": "unexpectedRevert",
    "submission-failed": "submissionFailed",
    dropped: "dropped",
  }[outcome];
}

function collectLatency(sample, field, target, index) {
  if (sample[field] === undefined) return;
  assertNonNegativeFinite(sample[field], `sample ${index} ${field}`);
  target.push(sample[field]);
}

function assertLatencyOrder(sample, index) {
  const acknowledgement = sample.acknowledgementLatencyMilliseconds;
  const inclusion = sample.inclusionLatencyMilliseconds;
  const receipt = sample.receiptLatencyMilliseconds;
  if (
    acknowledgement !== undefined &&
    inclusion !== undefined &&
    acknowledgement > inclusion
  ) {
    throw new RangeError(
      `sample ${index} acknowledgement latency exceeds inclusion latency`
    );
  }
  if (inclusion !== undefined && receipt !== undefined && inclusion > receipt) {
    throw new RangeError(
      `sample ${index} inclusion latency exceeds receipt latency`
    );
  }
}

function assertNonNegativeFinite(value, label) {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${label} must be finite and non-negative`);
  }
}

function assertNonNegativeSafeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer`);
  }
}

function round(value) {
  return Number(value.toFixed(6));
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const inputPath = process.argv[2];
  if (!inputPath) {
    throw new Error("usage: summarize-samples.mjs <samples.json>");
  }
  const input = JSON.parse(await readFile(inputPath, "utf8"));
  process.stdout.write(
    `${JSON.stringify(summarizeCaseSamples(input), null, 2)}\n`
  );
}
