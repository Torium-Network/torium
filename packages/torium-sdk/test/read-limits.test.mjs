import assert from "node:assert/strict";
import test from "node:test";

import {
  assertToriumFeeHistoryBlockCount,
  createToriumLogRanges,
} from "../dist/esm/clients.js";

test("log ranges are inclusive and capped at 10,000 blocks", () => {
  assert.deepEqual(createToriumLogRanges({ fromBlock: 0n, toBlock: 9_999n }), [
    { fromBlock: 0n, toBlock: 9_999n },
  ]);
  assert.deepEqual(createToriumLogRanges({ fromBlock: 0n, toBlock: 10_000n }), [
    { fromBlock: 0n, toBlock: 9_999n },
    { fromBlock: 10_000n, toBlock: 10_000n },
  ]);

  const ranges = createToriumLogRanges({
    fromBlock: 12_345n,
    toBlock: 42_345n,
  });
  for (const [index, range] of ranges.entries()) {
    assert.ok(range.toBlock - range.fromBlock + 1n <= 10_000n);
    if (index > 0)
      assert.equal(range.fromBlock, ranges[index - 1].toBlock + 1n);
  }
});

test("invalid log ranges fail before any RPC request", () => {
  assert.throws(
    () => createToriumLogRanges({ fromBlock: -1n, toBlock: 1n }),
    RangeError
  );
  assert.throws(
    () => createToriumLogRanges({ fromBlock: 2n, toBlock: 1n }),
    RangeError
  );
});

test("fee-history limits accept only integer block counts from 1 through 100", () => {
  assert.doesNotThrow(() => assertToriumFeeHistoryBlockCount(1));
  assert.doesNotThrow(() => assertToriumFeeHistoryBlockCount(100));
  for (const invalid of [0, 101, 1.5, Number.NaN]) {
    assert.throws(() => assertToriumFeeHistoryBlockCount(invalid), RangeError);
  }
});
