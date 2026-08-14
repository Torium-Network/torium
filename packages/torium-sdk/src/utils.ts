import {
  bytesToHex,
  formatUnits,
  getAddress,
  hexToBytes,
  isAddress,
  parseUnits,
  type Address,
  type Hash,
  type Hex,
} from "viem";

import {
  toriumChains,
  type ToriumChain,
  type ToriumEnvironment,
} from "./chains.js";

/** Number of fractional decimal places used by native TOR and valueless tTOR. */
export const toriumNativeDecimals = 18 as const;
/** Canonical base denomination used by the chain ledger. */
export const toriumBaseDenom = "atorium" as const;
/** Number of atorium base units in one TOR or tTOR display unit. */
export const atoriumPerDisplayUnit = 1_000_000_000_000_000_000n;
/** Largest amount accepted by EVM-native SDK helpers. */
export const toriumMaxUint256 = (1n << 256n) - 1n;

/** Environment-specific native currency metadata without RPC endpoint claims. */
export const toriumNativeCurrencies = Object.freeze({
  localnet: createNativeCurrency(
    "localnet",
    toriumChains.localnet.nativeCurrency.name,
    toriumChains.localnet.nativeCurrency.symbol,
    "valueless-test-token"
  ),
  devnet: createNativeCurrency(
    "devnet",
    toriumChains.devnet.nativeCurrency.name,
    toriumChains.devnet.nativeCurrency.symbol,
    "valueless-test-token"
  ),
  testnet: createNativeCurrency(
    "testnet",
    toriumChains.testnet.nativeCurrency.name,
    toriumChains.testnet.nativeCurrency.symbol,
    "valueless-test-token"
  ),
  mainnet: createNativeCurrency(
    "mainnet",
    toriumChains.mainnet.nativeCurrency.name,
    toriumChains.mainnet.nativeCurrency.symbol,
    "inactive-prelaunch-no-value-claim"
  ),
} as const);

export type ToriumNativeCurrency =
  (typeof toriumNativeCurrencies)[ToriumEnvironment];
export type ToriumDisplaySymbol = "TOR" | "tTOR";
export type ToriumAccountAddress = `torium1${string}`;
export type ToriumChainId = (typeof toriumChains)[ToriumEnvironment]["id"];

/** Returns immutable native-currency metadata for a canonical environment. */
export function getToriumNativeCurrency<
  const TEnvironment extends ToriumEnvironment,
>(environment: TEnvironment): (typeof toriumNativeCurrencies)[TEnvironment] {
  if (
    !Object.prototype.hasOwnProperty.call(toriumNativeCurrencies, environment)
  ) {
    throw new RangeError(
      "Torium environment must match a canonical network definition."
    );
  }
  return toriumNativeCurrencies[environment];
}

/** Parses a locale-neutral TOR/tTOR decimal into unsigned atorium base units. */
export function parseToriumAmount(value: string): bigint {
  if (
    typeof value !== "string" ||
    value.length > 97 ||
    !/^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,18})?$/u.test(value)
  ) {
    throw new TypeError(
      "Torium amount must be an unsigned locale-neutral decimal with at most 18 fractional digits."
    );
  }
  return assertToriumUint256(parseUnits(value, toriumNativeDecimals));
}

/** Formats unsigned atorium base units as a locale-neutral TOR/tTOR decimal. */
export function formatToriumAmount(value: bigint): string {
  return formatUnits(assertToriumUint256(value), toriumNativeDecimals);
}

/** Parses an unsigned base-10 atorium integer without floating-point conversion. */
export function parseToriumBaseUnits(value: string): bigint {
  if (
    typeof value !== "string" ||
    value.length > 78 ||
    !/^(?:0|[1-9][0-9]*)$/u.test(value)
  ) {
    throw new TypeError(
      "Torium base units must be an unsigned canonical base-10 integer."
    );
  }
  return assertToriumUint256(BigInt(value));
}

/** Formats unsigned atorium base units as a canonical base-10 integer. */
export function formatToriumBaseUnits(value: bigint): string {
  return assertToriumUint256(value).toString(10);
}

/** Validates the unsigned EVM uint256 range used by native amounts and uint256 fields. */
export function assertToriumUint256(value: bigint): bigint {
  if (typeof value !== "bigint") {
    throw new TypeError("Torium integer must be represented as bigint.");
  }
  if (value < 0n || value > toriumMaxUint256) {
    throw new RangeError(
      "Torium integer must fit the unsigned EVM uint256 range."
    );
  }
  return value;
}

/** Returns an EIP-55 checksummed 20-byte EVM account address. */
export function normalizeToriumEvmAddress(value: string): Address {
  if (typeof value !== "string" || !isAddress(value, { strict: true })) {
    throw new TypeError(
      "Torium EVM address must be a valid 20-byte EIP-55 or uniform-case value."
    );
  }
  return getAddress(value);
}

/** Returns whether a string is a valid EVM address accepted by the normalizer. */
export function isToriumEvmAddress(value: unknown): value is Address {
  return typeof value === "string" && isAddress(value, { strict: true });
}

/** Converts an EVM account address to the `torium` Bech32 account representation. */
export function toriumEvmAddressToBech32(value: string): ToriumAccountAddress {
  const address = normalizeToriumEvmAddress(value);
  return encodeBech32Account(hexToBytes(address));
}

/** Validates a Torium account HRP/checksum/length and returns an EIP-55 address. */
export function toriumBech32AddressToEvm(value: string): Address {
  const bytes = decodeBech32Account(value);
  return getAddress(bytesToHex(bytes));
}

/** Returns whether a value is a canonical Torium Bech32 account address. */
export function isToriumAccountAddress(
  value: unknown
): value is ToriumAccountAddress {
  if (typeof value !== "string") return false;
  try {
    decodeBech32Account(value);
    return true;
  } catch {
    return false;
  }
}

/** Returns a normalized 32-byte transaction, block or state hash. */
export function normalizeToriumHash(value: string): Hash {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/u.test(value)) {
    throw new TypeError(
      "Torium hash must be an exact 32-byte 0x-prefixed hexadecimal value."
    );
  }
  return value.toLowerCase() as Hash;
}

/** Returns whether a value is an exact 32-byte EVM hash. */
export function isToriumHash(value: unknown): value is Hash {
  return typeof value === "string" && /^0x[0-9a-fA-F]{64}$/u.test(value);
}

/** Returns normalized, byte-aligned EVM hex data, including empty `0x`. */
export function normalizeToriumHexData(value: string): Hex {
  if (typeof value !== "string" || !/^0x(?:[0-9a-fA-F]{2})*$/u.test(value)) {
    throw new TypeError(
      "Torium hex data must be 0x-prefixed and contain complete bytes."
    );
  }
  return value.toLowerCase() as Hex;
}

/** Returns whether a value is byte-aligned 0x-prefixed EVM data. */
export function isToriumHexData(value: unknown): value is Hex {
  return typeof value === "string" && /^0x(?:[0-9a-fA-F]{2})*$/u.test(value);
}

/** Returns whether a value is one of the four canonical Torium EIP-155 IDs. */
export function isToriumChainId(value: unknown): value is ToriumChainId {
  return (
    Number.isSafeInteger(value) &&
    Object.values(toriumChains).some(({ id }) => id === value)
  );
}

/** Validates and returns one of the four canonical Torium EIP-155 IDs. */
export function assertToriumChainId(value: unknown): ToriumChainId {
  if (!isToriumChainId(value)) {
    throw new RangeError(
      "Torium chain ID must match a canonical versioned replay domain."
    );
  }
  return value;
}

/** Returns the canonical chain definition for a validated EIP-155 ID. */
export function getToriumChainById(value: unknown): ToriumChain {
  const chainId = assertToriumChainId(value);
  const chain = Object.values(toriumChains).find(({ id }) => id === chainId);
  if (!chain) {
    throw new RangeError("Torium chain ID is not available in this manifest.");
  }
  return chain;
}

export type ToriumBlockTag =
  | "earliest"
  | "latest"
  | "pending"
  | "safe"
  | "finalized";
export type ToriumBlockReference = bigint | Hash | ToriumBlockTag;

/**
 * Validates block-reference syntax only. Runtime support remains capability-dependent:
 * Torium `safe` state is unsupported and `pending` state is partial in SDK 0.1.0.
 */
export function normalizeToriumBlockReference(
  value: bigint | string
): ToriumBlockReference {
  if (typeof value === "bigint") return assertToriumUint256(value);
  if (typeof value !== "string") {
    throw new TypeError(
      "Torium block reference must be a bigint, hash or standard tag."
    );
  }
  if (toriumBlockTags.has(value as ToriumBlockTag))
    return value as ToriumBlockTag;
  return normalizeToriumHash(value);
}

/**
 * Serializes bigint fields in JSON-compatible data with an explicit tagged envelope.
 * This is not an authenticity, schema-validation, or diagnostic-redaction layer.
 */
export function stringifyToriumJson(value: unknown, space?: number): string {
  const serialized = JSON.stringify(
    value,
    (_key, candidate: unknown) => {
      if (typeof candidate === "bigint") {
        return { [toriumBigIntTag]: candidate.toString(10) };
      }
      if (
        isRecord(candidate) &&
        Object.prototype.hasOwnProperty.call(candidate, toriumBigIntTag)
      ) {
        throw new TypeError(
          "Torium JSON value contains a reserved serialization tag."
        );
      }
      return candidate;
    },
    space
  );
  if (serialized === undefined) {
    throw new TypeError("Torium JSON root must be a serializable value.");
  }
  return serialized;
}

/**
 * Restores tagged bigint fields. Untrusted JSON can imitate the tag and must be
 * validated by the caller; other JavaScript types retain ordinary JSON semantics.
 */
export function parseToriumJson<T = unknown>(value: string): T {
  if (typeof value !== "string") {
    throw new TypeError("Torium JSON input must be a string.");
  }
  try {
    return JSON.parse(value, (_key, candidate: unknown) => {
      if (!isRecord(candidate) || Object.keys(candidate).length !== 1)
        return candidate;
      const encoded = candidate[toriumBigIntTag];
      if (typeof encoded !== "string") return candidate;
      if (!/^(?:0|-[1-9][0-9]*|[1-9][0-9]*)$/u.test(encoded)) {
        throw new TypeError("Torium JSON contains an invalid bigint envelope.");
      }
      return BigInt(encoded);
    }) as T;
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new SyntaxError("Torium JSON input is not valid JSON.");
    }
    throw error;
  }
}

const toriumBlockTags = new Set<ToriumBlockTag>([
  "earliest",
  "latest",
  "pending",
  "safe",
  "finalized",
]);
const toriumBigIntTag = "$torium.bigint";
const bech32Alphabet = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const bech32Generator = [
  0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3,
] as const;

function createNativeCurrency<
  const TEnvironment extends ToriumEnvironment,
  const TName extends "Torium Test Token" | "Torium",
  const TSymbol extends ToriumDisplaySymbol,
  const TValueStatus extends
    | "valueless-test-token"
    | "inactive-prelaunch-no-value-claim",
>(
  environment: TEnvironment,
  name: TName,
  symbol: TSymbol,
  valueStatus: TValueStatus
) {
  return Object.freeze({
    environment,
    name,
    symbol,
    decimals: toriumNativeDecimals,
    baseDenom: toriumBaseDenom,
    valueStatus,
  });
}

function encodeBech32Account(bytes: Uint8Array): ToriumAccountAddress {
  if (bytes.length !== 20)
    throw new TypeError(
      "Torium account address must contain exactly 20 bytes."
    );
  const words = convertBits(bytes, 8, 5, true);
  const checksum = createBech32Checksum("torium", words);
  return `torium1${[...words, ...checksum].map((word) => bech32Alphabet[word]).join("")}`;
}

function decodeBech32Account(value: string): Uint8Array {
  if (
    value.length !== 45 ||
    value !== value.toLowerCase() ||
    !value.startsWith("torium1")
  ) {
    throw new TypeError(
      "Torium Bech32 account must use the lowercase torium HRP."
    );
  }
  const payload = value.slice("torium1".length);
  if (payload.length < 7)
    throw new TypeError("Torium Bech32 account is incomplete.");
  const words = [...payload].map((character) =>
    bech32Alphabet.indexOf(character)
  );
  if (
    words.some((word) => word < 0) ||
    !verifyBech32Checksum("torium", words)
  ) {
    throw new TypeError(
      "Torium Bech32 account has an invalid checksum or alphabet."
    );
  }
  const bytes = Uint8Array.from(convertBits(words.slice(0, -6), 5, 8, false));
  if (bytes.length !== 20)
    throw new TypeError(
      "Torium Bech32 account must decode to exactly 20 bytes."
    );
  return bytes;
}

function expandBech32Hrp(hrp: string): number[] {
  return [
    ...[...hrp].map((character) => character.charCodeAt(0) >> 5),
    0,
    ...[...hrp].map((character) => character.charCodeAt(0) & 31),
  ];
}

function bech32Polymod(values: readonly number[]): number {
  let checksum = 1;
  for (const value of values) {
    const top = checksum >>> 25;
    checksum = ((checksum & 0x1ffffff) << 5) ^ value;
    for (let index = 0; index < bech32Generator.length; index += 1) {
      if ((top >>> index) & 1) checksum ^= bech32Generator[index] ?? 0;
    }
  }
  return checksum >>> 0;
}

function createBech32Checksum(hrp: string, words: readonly number[]): number[] {
  const polymod =
    bech32Polymod([...expandBech32Hrp(hrp), ...words, 0, 0, 0, 0, 0, 0]) ^ 1;
  return Array.from(
    { length: 6 },
    (_, index) => (polymod >>> (5 * (5 - index))) & 31
  );
}

function verifyBech32Checksum(hrp: string, words: readonly number[]): boolean {
  return bech32Polymod([...expandBech32Hrp(hrp), ...words]) === 1;
}

function convertBits(
  values: Iterable<number>,
  fromBits: number,
  toBits: number,
  pad: boolean
): number[] {
  let accumulator = 0;
  let bitCount = 0;
  const result: number[] = [];
  const maximumOutput = (1 << toBits) - 1;
  const maximumAccumulator = (1 << (fromBits + toBits - 1)) - 1;
  for (const value of values) {
    if (value < 0 || value >>> fromBits !== 0) {
      throw new TypeError(
        "Torium Bech32 account contains an invalid data word."
      );
    }
    accumulator = ((accumulator << fromBits) | value) & maximumAccumulator;
    bitCount += fromBits;
    while (bitCount >= toBits) {
      bitCount -= toBits;
      result.push((accumulator >>> bitCount) & maximumOutput);
    }
  }
  if (pad) {
    if (bitCount > 0)
      result.push((accumulator << (toBits - bitCount)) & maximumOutput);
  } else if (
    bitCount >= fromBits ||
    ((accumulator << (toBits - bitCount)) & maximumOutput) !== 0
  ) {
    throw new TypeError("Torium Bech32 account has invalid padding.");
  }
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
