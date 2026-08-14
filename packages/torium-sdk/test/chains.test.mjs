import assert from "node:assert/strict";
import test from "node:test";

import {
  ToriumEndpointValidationError,
  getToriumChain,
  toriumChains,
  toriumDevnet,
  toriumLocalnet,
  toriumMainnet,
  toriumTestnet,
  withToriumRpcUrls,
} from "../dist/esm/chains.js";

test("exports the four canonical Torium networks without invented services", () => {
  assert.deepEqual(
    Object.values(toriumChains).map(({ id }) => id),
    [1414484556, 1414484548, 1414484564, 5525330]
  );
  assert.equal(
    Object.values(toriumChains).some(({ id }) => id === 262144),
    false
  );
  assert.equal(getToriumChain("localnet"), toriumLocalnet);
  assert.equal(getToriumChain("devnet"), toriumDevnet);
  assert.equal(getToriumChain("testnet"), toriumTestnet);
  assert.equal(getToriumChain("mainnet"), toriumMainnet);

  for (const chain of Object.values(toriumChains)) {
    assert.equal(chain.blockExplorers, undefined);
    assert.equal(chain.contracts, undefined);
    assert.equal(chain.nativeCurrency.decimals, 18);
  }
  assert.deepEqual(toriumLocalnet.rpcUrls.default, {
    http: ["http://127.0.0.1:8545"],
    webSocket: ["ws://127.0.0.1:8546"],
  });
  for (const chain of [toriumDevnet, toriumTestnet, toriumMainnet]) {
    assert.deepEqual(chain.rpcUrls.default, { http: [] });
  }
});

test("caller-owned URL overrides are immutable and scheme constrained", () => {
  const overridden = withToriumRpcUrls(toriumTestnet, {
    http: ["https://rpc.caller.example"],
    webSocket: ["wss://rpc.caller.example"],
  });
  assert.notEqual(overridden, toriumTestnet);
  assert.deepEqual(toriumTestnet.rpcUrls.default, { http: [] });
  assert.deepEqual(overridden.rpcUrls.default, {
    http: ["https://rpc.caller.example"],
    webSocket: ["wss://rpc.caller.example"],
  });
  assert.equal(overridden.id, toriumTestnet.id);
  assert.equal(overridden.torium, toriumTestnet.torium);
  assert.deepEqual(
    overridden.extend({ torium: overridden.torium }).rpcUrls.default,
    overridden.rpcUrls.default
  );

  for (const overrides of [
    { http: [] },
    { http: ["ftp://rpc.example"] },
    { http: ["https://user:password@rpc.example"] },
    { http: ["https://rpc.example"], webSocket: ["https://rpc.example"] },
  ]) {
    assert.throws(
      () => withToriumRpcUrls(toriumTestnet, overrides),
      (error) =>
        error instanceof ToriumEndpointValidationError &&
        error.code === "TORIUM_ENDPOINT_CONFIG_INVALID" &&
        !error.message.includes("password")
    );
  }
});
