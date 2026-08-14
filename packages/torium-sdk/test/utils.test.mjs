import assert from "node:assert/strict";
import test from "node:test";
import { formatUnits, getAddress, parseUnits } from "viem";

import {
  assertToriumChainId,
  assertToriumUint256,
  atoriumPerDisplayUnit,
  formatToriumAmount,
  formatToriumBaseUnits,
  getToriumNativeCurrency,
  getToriumChainById,
  isToriumAccountAddress,
  isToriumChainId,
  isToriumEvmAddress,
  isToriumHash,
  isToriumHexData,
  normalizeToriumBlockReference,
  normalizeToriumEvmAddress,
  normalizeToriumHash,
  normalizeToriumHexData,
  parseToriumAmount,
  parseToriumBaseUnits,
  parseToriumJson,
  stringifyToriumJson,
  toriumBaseDenom,
  toriumBech32AddressToEvm,
  toriumEvmAddressToBech32,
  toriumMaxUint256,
  toriumNativeCurrencies,
  toriumNativeDecimals,
} from "../dist/esm/utils.js";

const addressVectors = [
  [
    "0x0000000000000000000000000000000000000000",
    "torium1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqmhxxp0",
  ],
  [
    "0x52908400098527886E0F7030069857D2E4169EE7",
    "torium122gggqqfs5ncsms0wqcqdxzh6tjpd8h8qzqrsf",
  ],
  [
    "0x000000000000000000000000000000000000dEaD",
    "torium1qqqqqqqqqqqqqqqqqqqqqqqqqqqqph4dan4mxl",
  ],
  [
    "0x00112233445566778899AABbCCdDeeFf00112233",
    "torium1qqgjyv6y24n80zye42aueh0wluqpzg3nn2jt40",
  ],
];

test("native currency metadata cannot confuse tTOR and TOR environments", () => {
  assert.equal(toriumNativeDecimals, 18);
  assert.equal(toriumBaseDenom, "atorium");
  assert.equal(atoriumPerDisplayUnit, 10n ** 18n);
  assert.equal(toriumNativeCurrencies.localnet.symbol, "tTOR");
  assert.equal(
    toriumNativeCurrencies.testnet.valueStatus,
    "valueless-test-token"
  );
  assert.equal(toriumNativeCurrencies.mainnet.symbol, "TOR");
  assert.equal(
    toriumNativeCurrencies.mainnet.valueStatus,
    "inactive-prelaunch-no-value-claim"
  );
  assert.equal(
    getToriumNativeCurrency("devnet"),
    toriumNativeCurrencies.devnet
  );
  assert.equal(Object.isFrozen(toriumNativeCurrencies), true);
  assert.equal(Object.isFrozen(toriumNativeCurrencies.localnet), true);
});

test("TOR decimal parsing is bigint-only and agrees with viem", () => {
  const fixtures = [
    "0",
    "1",
    "0.000000000000000001",
    "1.000000000000000001",
    "999999999.999999999999999999",
  ];
  for (const fixture of fixtures) {
    const parsed = parseToriumAmount(fixture);
    assert.equal(typeof parsed, "bigint");
    assert.equal(parsed, parseUnits(fixture, 18));
    assert.equal(formatToriumAmount(parsed), formatUnits(parsed, 18));
    assert.equal(parseToriumAmount(formatToriumAmount(parsed)), parsed);
  }
});

test("amount helpers cover uint256 boundaries and deterministic round trips", () => {
  assert.equal(assertToriumUint256(0n), 0n);
  assert.equal(assertToriumUint256(toriumMaxUint256), toriumMaxUint256);
  const maximumDisplay = formatToriumAmount(toriumMaxUint256);
  assert.equal(parseToriumAmount(maximumDisplay), toriumMaxUint256);
  assert.equal(
    formatToriumBaseUnits(toriumMaxUint256),
    toriumMaxUint256.toString()
  );
  assert.equal(
    parseToriumBaseUnits(toriumMaxUint256.toString()),
    toriumMaxUint256
  );

  let state = 0x544f52n;
  for (let index = 0; index < 128; index += 1) {
    state =
      (state * 6364136223846793005n + 1442695040888963407n) & toriumMaxUint256;
    assert.equal(parseToriumAmount(formatToriumAmount(state)), state);
    assert.equal(parseToriumBaseUnits(formatToriumBaseUnits(state)), state);
  }
});

test("amount parsers reject signs, locale syntax, whitespace, precision and overflow", () => {
  for (const invalid of [
    "",
    " 1",
    "1 ",
    "+1",
    "-1",
    "01",
    ".1",
    "1.",
    "1,0",
    "1e18",
    "0.0000000000000000001",
  ]) {
    assert.throws(() => parseToriumAmount(invalid), { name: "TypeError" });
  }
  for (const invalid of ["", " 1", "+1", "-1", "01", "1.0", "1e18"]) {
    assert.throws(() => parseToriumBaseUnits(invalid), { name: "TypeError" });
  }
  assert.throws(
    () => parseToriumBaseUnits((toriumMaxUint256 + 1n).toString()),
    {
      name: "RangeError",
    }
  );
  assert.throws(() => formatToriumAmount(-1n), { name: "RangeError" });
  assert.throws(() => parseToriumAmount(1.25), { name: "TypeError" });
  assert.throws(() => parseToriumBaseUnits(1), { name: "TypeError" });
  assert.throws(() => assertToriumUint256(1), { name: "TypeError" });
  assert.throws(() => formatToriumBaseUnits(toriumMaxUint256 + 1n), {
    name: "RangeError",
  });
  assert.throws(() => parseToriumAmount("9".repeat(100_000)), {
    name: "TypeError",
  });
  assert.throws(() => parseToriumBaseUnits("9".repeat(100_000)), {
    name: "TypeError",
  });
});

test("EVM and Torium Bech32 account vectors round trip exactly", () => {
  for (const [evm, bech32] of addressVectors) {
    assert.equal(normalizeToriumEvmAddress(evm), getAddress(evm));
    assert.equal(isToriumEvmAddress(evm), true);
    assert.equal(toriumEvmAddressToBech32(evm), bech32);
    assert.equal(toriumBech32AddressToEvm(bech32), getAddress(evm));
    assert.equal(isToriumAccountAddress(bech32), true);
  }
  assert.equal(
    normalizeToriumEvmAddress("0x00112233445566778899aabbccddeeff00112233"),
    addressVectors[3][0]
  );
});

test("address helpers reject wrong roles, checksum, alphabet, padding and length", () => {
  assert.equal(isToriumEvmAddress("0x1234"), false);
  assert.equal(isToriumEvmAddress(null), false);
  assert.throws(() => normalizeToriumEvmAddress(null), { name: "TypeError" });
  assert.throws(
    () =>
      normalizeToriumEvmAddress("0x52908400098527886E0F7030069857D2E4169Ee7"),
    { name: "TypeError" }
  );
  for (const invalid of [
    addressVectors[0][1].replace("torium1", "toriumvaloper1"),
    "toriumvaloper1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqgm0m7r",
    "toriumvalcons1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqugu8jz",
    addressVectors[0][1].toUpperCase(),
    `${addressVectors[0][1].slice(0, -1)}q`,
    "torium1qqqqqqq",
  ]) {
    assert.throws(() => toriumBech32AddressToEvm(invalid), {
      name: "TypeError",
    });
    assert.equal(isToriumAccountAddress(invalid), false);
  }
  assert.equal(isToriumAccountAddress(`torium1${"q".repeat(100_000)}`), false);
});

test("hash, hex, chain ID and block reference normalizers are strict", () => {
  const hash = `0x${"AB".repeat(32)}`;
  assert.equal(normalizeToriumHash(hash), hash.toLowerCase());
  assert.equal(isToriumHash(hash), true);
  assert.equal(normalizeToriumHexData("0xDeAdBeEf"), "0xdeadbeef");
  assert.equal(normalizeToriumHexData("0x"), "0x");
  assert.equal(isToriumHexData("0x"), true);
  assert.equal(assertToriumChainId(1414484556), 1414484556);
  assert.equal(isToriumChainId(1414484556), true);
  assert.equal(getToriumChainById(1414484556).torium.environment, "localnet");
  assert.equal(normalizeToriumBlockReference(0n), 0n);
  assert.equal(normalizeToriumBlockReference("finalized"), "finalized");
  assert.equal(normalizeToriumBlockReference(hash), hash.toLowerCase());

  assert.throws(() => normalizeToriumHash("0x1234"), { name: "TypeError" });
  assert.throws(() => normalizeToriumHash(1), { name: "TypeError" });
  assert.equal(isToriumHash("0x1234"), false);
  assert.throws(() => normalizeToriumHexData("0xabc"), { name: "TypeError" });
  assert.throws(() => normalizeToriumHexData(null), { name: "TypeError" });
  assert.equal(isToriumHexData("0xabc"), false);
  assert.throws(() => assertToriumChainId(0), { name: "RangeError" });
  assert.throws(() => assertToriumChainId(Number.MAX_SAFE_INTEGER + 1), {
    name: "RangeError",
  });
  assert.throws(() => assertToriumChainId(262144), { name: "RangeError" });
  assert.throws(() => normalizeToriumBlockReference(-1n), {
    name: "RangeError",
  });
  assert.throws(() => normalizeToriumBlockReference(1), { name: "TypeError" });
  assert.throws(() => normalizeToriumBlockReference("head"), {
    name: "TypeError",
  });
});

test("tagged JSON serialization round trips bigint values without precision loss", () => {
  const input = {
    balance: toriumMaxUint256,
    nested: [0n, { fee: 1_000_000_000n }],
    ordinaryDecimalString: "1000000000000000000",
  };
  const encoded = stringifyToriumJson(input, 2);
  assert.match(encoded, /"\$torium\.bigint": "115792089/);
  assert.deepEqual(parseToriumJson(encoded), input);
  assert.throws(() => stringifyToriumJson(undefined), { name: "TypeError" });
  assert.throws(() => stringifyToriumJson({ "$torium.bigint": "1" }), {
    name: "TypeError",
  });
  assert.throws(() => parseToriumJson('{"$torium.bigint":"01"}'), {
    name: "TypeError",
  });
  assert.throws(() => parseToriumJson(null), { name: "TypeError" });
});

test("validation error messages never echo rejected secret-shaped input", () => {
  const secretShaped = `0x${"de".repeat(32)}ff`;
  for (const operation of [
    () => normalizeToriumEvmAddress(secretShaped),
    () => normalizeToriumHash(secretShaped),
    () => normalizeToriumHexData(`${secretShaped}f`),
    () => parseToriumJson(`{"secret":"${secretShaped}"`),
  ]) {
    assert.throws(operation, (error) => {
      assert.equal(error.message.includes(secretShaped), false);
      return true;
    });
  }
});
