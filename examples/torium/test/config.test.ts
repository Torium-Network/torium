import assert from "node:assert/strict";
import test from "node:test";

import {
  assertToriumExampleChain,
  defaultToriumLocalnetRpcUrl,
  expectedToriumLocalnetChainId,
  getToriumExampleChain,
  parseToriumExampleRpcUrl,
} from "../shared/config.js";

test("example config defaults to the canonical loopback localnet", async () => {
  assert.equal(
    parseToriumExampleRpcUrl(undefined),
    defaultToriumLocalnetRpcUrl
  );
  assert.equal(getToriumExampleChain().id, expectedToriumLocalnetChainId);
  await assert.doesNotReject(
    assertToriumExampleChain({
      async getChainId() {
        return expectedToriumLocalnetChainId;
      },
    })
  );
});

test("example config rejects wrong chains before a journey continues", async () => {
  await assert.rejects(
    assertToriumExampleChain({
      async getChainId() {
        return 1;
      },
    }),
    /Wrong chain/u
  );
});

test("example RPC overrides reject non-HTTP schemes", () => {
  assert.throws(() => parseToriumExampleRpcUrl("ws://127.0.0.1:8546"), /http/u);
});
