import {
  createWalletClient,
  type AccessList,
  type Account,
  type Address,
  type Hash,
  type Hex,
  type ParseAccount,
  type RpcSchema,
  serializeTransaction,
  type Tokens,
  type TransactionReceipt,
  type Transport,
  type WalletClient,
  type WalletClientConfig,
  WaitForTransactionReceiptTimeoutError,
} from "viem";

import { type ToriumClientChain } from "./chains.js";
import {
  ToriumSdkError,
  type ToriumActionOptions,
  type ToriumReadActionOptions,
} from "./errors.js";
import {
  runToriumReadAction,
  runToriumWriteActionOnce,
} from "./internal/execution.js";
import {
  assertToriumChainId,
  assertToriumUint256,
  getToriumChainById,
  normalizeToriumEvmAddress,
  normalizeToriumHash,
  normalizeToriumHexData,
} from "./utils.js";

export const toriumMaxTransactionGas = 25_000_000n;
export const toriumMaxEncodedTransactionBytes = 131_072;
export const toriumMinimumBaseFeePerGas = 1_000_000_000n;
export const toriumMinimumPriorityFeePerGas = 1n;

/** Runtime transaction claims proven for the current local-only chain baseline. */
export const toriumTransactionCapabilities = deepFreeze({
  schemaVersion: 1,
  scope: "sdk-0.1-stable-helper",
  baseline: {
    cosmosEvm: "v0.7.0",
    viem: "2.55.2",
  },
  envelopes: {
    viemWallet: {
      legacy: "supported",
      eip2930: "supported",
      eip1559: "supported",
    },
    stableHelper: {
      eip1559: "supported",
      eip4844: "unsupported",
      eip7702: "unsupported",
    },
    customToriumEnvelope: false,
  },
  submission: {
    rpcHashIsAcknowledgementOnly: true,
    retentionGuaranteed: false,
    boundedInclusion: false,
    automaticWriteRetry: false,
  },
  nonce: {
    pendingState: "partial",
    conflictPreflight: "best-effort",
  },
  fees: {
    pricingModel: "eip1559",
    minimumBaseFeePerGas: toriumMinimumBaseFeePerGas,
    minimumPriorityFeePerGas: toriumMinimumPriorityFeePerGas,
  },
  replacement: {
    state: "partial",
    detectionDefault: false,
    activeLocalProfile: {
      minimumFeeCapBumpPercent: 10,
      minimumTipCapBumpPercent: 10,
      scope: "receiving-node-only",
    },
    historicalBaseline: {
      rejectedBumpPercent: 5,
      acceptedBumpPercent: 100,
    },
    networkPropagationGuaranteed: false,
  },
  cancellation: {
    state: "unsupported",
  },
  finality: {
    defaultConfirmationBlocks: 1,
    label: "CometBFT committed",
    beaconChainSemantics: false,
  },
} as const);

export type ToriumTransactionCapabilities =
  typeof toriumTransactionCapabilities;

export type ToriumWalletClientConfig<
  TTransport extends Transport,
  TChain extends ToriumClientChain,
  TAccountOrAddress extends Account | Address | undefined =
    | Account
    | Address
    | undefined,
  TRpcSchema extends RpcSchema | undefined = undefined,
  TTokens extends Tokens | undefined = Tokens | undefined,
> = Omit<
  WalletClientConfig<
    TTransport,
    TChain,
    TAccountOrAddress,
    TRpcSchema,
    TTokens
  >,
  "chain"
> & {
  readonly chain: TChain;
};

export type ToriumWalletClient<
  TTransport extends Transport = Transport,
  TChain extends ToriumClientChain = ToriumClientChain,
  TAccountOrAddress extends Account | Address | undefined =
    | Account
    | Address
    | undefined,
  TRpcSchema extends RpcSchema | undefined = undefined,
  TTokens extends Tokens | undefined = Tokens | undefined,
> = WalletClient<
  TTransport,
  TChain,
  ParseAccount<TAccountOrAddress>,
  TRpcSchema,
  TTokens
>;

/** Creates a viem wallet client that is statically bound to a Torium chain. */
export function createToriumWalletClient<
  TTransport extends Transport,
  const TChain extends ToriumClientChain,
  TAccountOrAddress extends Account | Address | undefined = undefined,
  TRpcSchema extends RpcSchema | undefined = undefined,
  const TTokens extends Tokens | undefined = undefined,
>(
  parameters: ToriumWalletClientConfig<
    TTransport,
    TChain,
    TAccountOrAddress,
    TRpcSchema,
    TTokens
  >
): ToriumWalletClient<
  TTransport,
  TChain,
  TAccountOrAddress,
  TRpcSchema,
  TTokens
> {
  assertToriumChain(parameters.chain);
  return createWalletClient(parameters);
}

export interface ToriumTransactionRequest {
  readonly account: Account | Address;
  readonly to?: Address | null;
  readonly data?: Hex;
  readonly value?: bigint;
  readonly gas?: bigint;
  readonly nonce?: number;
  readonly maxFeePerGas?: bigint;
  readonly maxPriorityFeePerGas?: bigint;
  readonly type?: "eip1559";
  readonly accessList?: AccessList;
}

export interface NormalizedToriumTransactionRequest extends ToriumTransactionRequest {
  readonly account: Account | Address;
}

export type ToriumPreflightBlocker =
  | "gas-below-estimate"
  | "insufficient-funds"
  | "nonce-mismatch";

export interface ToriumTransactionPreflight {
  readonly chainId: number;
  readonly account: Address;
  readonly to: Address | null;
  readonly data: Hex;
  readonly value: bigint;
  readonly accessList: AccessList;
  readonly type: "eip1559";
  readonly gasEstimate: bigint;
  readonly gasLimit: bigint;
  readonly maxFeePerGas: bigint;
  readonly maxPriorityFeePerGas: bigint;
  readonly maximumCost: bigint;
  readonly balance: bigint;
  readonly pendingNonce: number;
  readonly requestedNonce: number;
  readonly encodedTransactionBytes: number;
  readonly canSubmit: boolean;
  readonly blockers: readonly ToriumPreflightBlocker[];
}

export interface ToriumPreflightClient {
  readonly chain: ToriumClientChain;
  getChainId(): Promise<number>;
  call(parameters: ToriumTransactionRequest): Promise<unknown>;
  estimateGas(parameters: ToriumTransactionRequest): Promise<bigint>;
  estimateFeesPerGas(parameters: { readonly type: "eip1559" }): Promise<{
    readonly maxFeePerGas: bigint;
    readonly maxPriorityFeePerGas: bigint;
  }>;
  getBalance(parameters: {
    readonly address: Address;
    readonly blockTag: "pending";
  }): Promise<bigint>;
  getTransactionCount(parameters: {
    readonly address: Address;
    readonly blockTag: "pending";
  }): Promise<number>;
}

export type ToriumPreflightOptions = ToriumReadActionOptions;

/**
 * Validates standard transaction fields, simulates execution and calculates a
 * conservative maximum cost. It never requests a signature or submits a write.
 */
export async function preflightToriumTransaction(
  client: ToriumPreflightClient,
  request: ToriumTransactionRequest,
  options: ToriumPreflightOptions = {}
): Promise<ToriumTransactionPreflight> {
  return runToriumReadAction(
    ({ signal }) => preflightToriumTransactionImpl(client, request, signal),
    {
      operation: "preflightToriumTransaction",
      clientKind: "wallet",
      method: "eth_call",
      chainId: client.chain.id,
      fallbackCategory: "simulation",
    },
    options
  );
}

async function preflightToriumTransactionImpl(
  client: ToriumPreflightClient,
  request: ToriumTransactionRequest,
  signal: AbortSignal
): Promise<ToriumTransactionPreflight> {
  signal.throwIfAborted();
  const normalized = normalizeToriumTransactionRequest(request);
  const account = getAccountAddress(normalized.account);
  assertToriumChain(client.chain);
  const observedChainId = await client.getChainId();
  signal.throwIfAborted();
  if (observedChainId !== client.chain.id) {
    throw new RangeError(
      "Torium preflight endpoint does not match the configured chain."
    );
  }

  const simulationRequest = removeUndefined({
    ...normalized,
    account,
    gas: undefined,
  }) as ToriumTransactionRequest;
  await client.call(simulationRequest);
  signal.throwIfAborted();
  const [gasEstimate, estimatedFees, balance, pendingNonce] = await Promise.all(
    [
      client.estimateGas(simulationRequest),
      client.estimateFeesPerGas({ type: "eip1559" }),
      client.getBalance({ address: account, blockTag: "pending" }),
      client.getTransactionCount({ address: account, blockTag: "pending" }),
    ]
  );
  signal.throwIfAborted();
  assertTransactionGas(gasEstimate);
  assertTransactionNonce(pendingNonce);

  const gasLimit = normalized.gas ?? gasEstimate;
  const maxFeePerGas = normalized.maxFeePerGas ?? estimatedFees.maxFeePerGas;
  const maxPriorityFeePerGas =
    normalized.maxPriorityFeePerGas ?? estimatedFees.maxPriorityFeePerGas;
  assertToriumUint256(maxFeePerGas);
  assertToriumUint256(maxPriorityFeePerGas);
  if (maxPriorityFeePerGas > maxFeePerGas) {
    throw new RangeError(
      "Torium maximum priority fee must not exceed the maximum fee."
    );
  }
  if (maxPriorityFeePerGas < toriumMinimumPriorityFeePerGas) {
    throw new RangeError(
      "Torium maximum priority fee is below the protocol minimum."
    );
  }
  if (maxFeePerGas < toriumMinimumBaseFeePerGas + maxPriorityFeePerGas) {
    throw new RangeError(
      "Torium maximum fee cannot cover the protocol base fee and priority fee."
    );
  }
  const maximumCost = assertToriumUint256(
    gasLimit * maxFeePerGas + (normalized.value ?? 0n)
  );
  const requestedNonce = normalized.nonce ?? pendingNonce;
  const encodedTransactionBytes = getMaximumSignedTransactionBytes({
    chainId: observedChainId,
    nonce: requestedNonce,
    maxFeePerGas,
    maxPriorityFeePerGas,
    gas: gasLimit,
    to: normalized.to,
    value: normalized.value ?? 0n,
    data: normalized.data ?? "0x",
    accessList: normalized.accessList ?? [],
  });
  if (encodedTransactionBytes > toriumMaxEncodedTransactionBytes) {
    throw new RangeError(
      "Torium signed transaction exceeds the encoded transaction limit."
    );
  }
  const blockers: ToriumPreflightBlocker[] = [];
  if (gasLimit < gasEstimate) blockers.push("gas-below-estimate");
  if (balance < maximumCost) blockers.push("insufficient-funds");
  if (requestedNonce !== pendingNonce) blockers.push("nonce-mismatch");

  return Object.freeze({
    chainId: observedChainId,
    account,
    to: normalized.to ?? null,
    data: normalized.data ?? "0x",
    value: normalized.value ?? 0n,
    accessList: normalized.accessList ?? Object.freeze([]),
    type: "eip1559",
    gasEstimate,
    gasLimit,
    maxFeePerGas,
    maxPriorityFeePerGas,
    maximumCost,
    balance,
    pendingNonce,
    requestedNonce,
    encodedTransactionBytes,
    canSubmit: blockers.length === 0,
    blockers: Object.freeze(blockers),
  });
}

export interface ToriumTransactionSender {
  readonly chain: ToriumClientChain;
  sendTransaction(
    parameters: NormalizedToriumTransactionRequest & {
      readonly chain: ToriumClientChain;
    }
  ): Promise<Hash>;
}

export interface ToriumSubmissionAcknowledgement {
  readonly hash: Hash;
  readonly status: "acknowledged";
  readonly retentionGuaranteed: false;
  readonly inclusionGuaranteed: false;
}

export interface SendToriumTransactionOptions extends ToriumActionOptions {
  /** Called with the fresh final preflight immediately before signing. */
  readonly authorize: (
    preflight: ToriumTransactionPreflight
  ) => boolean | Promise<boolean>;
}

/** Submits exactly once and reports RPC acknowledgement without retry claims. */
export async function sendToriumTransactionOnce(
  client: ToriumTransactionSender,
  preflightClient: ToriumPreflightClient,
  request: ToriumTransactionRequest,
  options: SendToriumTransactionOptions
): Promise<ToriumSubmissionAcknowledgement> {
  return runToriumWriteActionOnce(
    ({ signal }) =>
      sendToriumTransactionOnceImpl(
        client,
        preflightClient,
        request,
        options,
        signal
      ),
    {
      operation: "sendToriumTransactionOnce",
      kind: "broadcast",
      clientKind: "wallet",
      method: "eth_sendTransaction",
      chainId: client.chain.id,
      fallbackCategory: "transport",
    },
    options
  );
}

async function sendToriumTransactionOnceImpl(
  client: ToriumTransactionSender,
  preflightClient: ToriumPreflightClient,
  request: ToriumTransactionRequest,
  options: SendToriumTransactionOptions,
  signal: AbortSignal
): Promise<ToriumSubmissionAcknowledgement> {
  signal.throwIfAborted();
  assertToriumChain(client.chain);
  assertToriumChain(preflightClient.chain);
  if (client.chain.id !== preflightClient.chain.id) {
    throw new RangeError(
      "Torium wallet and preflight clients must use the same chain."
    );
  }
  const requestSnapshot = normalizeToriumTransactionRequest(request);
  const preflight = await preflightToriumTransactionImpl(
    preflightClient,
    requestSnapshot,
    signal
  );
  if (!preflight.canSubmit) {
    const category = preflight.blockers.includes("insufficient-funds")
      ? "funds"
      : preflight.blockers.includes("nonce-mismatch")
        ? "nonce"
        : "simulation";
    const code =
      category === "funds"
        ? "TORIUM_FUNDS_INSUFFICIENT"
        : category === "nonce"
          ? "TORIUM_NONCE_INVALID"
          : "TORIUM_SIMULATION_FAILED";
    throw new ToriumSdkError({
      code,
      category,
      message: "Torium transaction preflight did not authorize submission.",
      operation: "sendToriumTransactionOnce",
      kind: "broadcast",
      clientKind: "wallet",
      method: "eth_sendTransaction",
      chainId: client.chain.id,
      issues: preflight.blockers,
      retryable: false,
      safeToRetry: false,
    });
  }
  const preparedRequest = normalizeToriumTransactionRequest({
    ...requestSnapshot,
    type: "eip1559",
    gas: preflight.gasLimit,
    nonce: preflight.requestedNonce,
    maxFeePerGas: preflight.maxFeePerGas,
    maxPriorityFeePerGas: preflight.maxPriorityFeePerGas,
  });
  signal.throwIfAborted();
  if ((await options.authorize(preflight)) !== true) {
    throw new ToriumSdkError({
      code: "TORIUM_CANCELLED",
      category: "cancellation",
      message: "Torium transaction authorization was rejected.",
      operation: "sendToriumTransactionOnce",
      kind: "broadcast",
      clientKind: "wallet",
      method: "eth_sendTransaction",
      chainId: client.chain.id,
      retryable: false,
      safeToRetry: false,
    });
  }
  signal.throwIfAborted();
  if (getAccountAddress(preparedRequest.account) !== preflight.account) {
    throw new Error("Torium transaction signer changed after authorization.");
  }
  const hash = normalizeToriumHash(
    await client.sendTransaction({ ...preparedRequest, chain: client.chain })
  );
  return {
    hash,
    status: "acknowledged",
    retentionGuaranteed: false,
    inclusionGuaranteed: false,
  };
}

export interface WaitForToriumTransactionOptions extends ToriumActionOptions {
  readonly hash: Hash;
  readonly confirmations?: number;
  readonly timeout?: number;
}

export interface ToriumReceiptClient {
  waitForTransactionReceipt(parameters: {
    readonly hash: Hash;
    readonly confirmations: number;
    readonly timeout: number;
    readonly checkReplacement: false;
  }): Promise<TransactionReceipt>;
}

export type ToriumTransactionLifecycle =
  | {
      readonly status: "committed";
      readonly hash: Hash;
      readonly receipt: TransactionReceipt;
      readonly finality: "CometBFT committed";
    }
  | {
      readonly status: "reverted";
      readonly hash: Hash;
      readonly receipt: TransactionReceipt;
      readonly finality: "CometBFT committed";
    }
  | {
      readonly status: "unknown";
      readonly hash: Hash;
      readonly reason: "timeout";
      readonly safeToAutomaticallyResubmit: false;
    };

/** Waits for one CometBFT commit without claiming replacement detection. */
export async function waitForToriumTransaction(
  client: ToriumReceiptClient,
  options: WaitForToriumTransactionOptions
): Promise<ToriumTransactionLifecycle> {
  return runToriumReadAction(
    () => waitForToriumTransactionImpl(client, options),
    {
      operation: "waitForToriumTransaction",
      clientKind: "wallet",
      method: "eth_getTransactionReceipt",
      fallbackCategory: "rpc",
    },
    options
  );
}

async function waitForToriumTransactionImpl(
  client: ToriumReceiptClient,
  options: WaitForToriumTransactionOptions
): Promise<ToriumTransactionLifecycle> {
  const hash = normalizeToriumHash(options.hash);
  const confirmations = options.confirmations ?? 1;
  const timeout = options.timeout ?? 180_000;
  if (!Number.isInteger(confirmations) || confirmations < 1) {
    throw new RangeError(
      "Torium receipt confirmations must be a positive integer."
    );
  }
  if (!Number.isSafeInteger(timeout) || timeout < 1) {
    throw new RangeError(
      "Torium receipt timeout must be a positive safe integer."
    );
  }

  try {
    const receipt = await client.waitForTransactionReceipt({
      hash,
      confirmations,
      timeout,
      checkReplacement: false,
    });
    if (receipt.status !== "success" && receipt.status !== "reverted") {
      throw new TypeError(
        "Torium receipt returned an unsupported transaction status."
      );
    }
    if (normalizeToriumHash(receipt.transactionHash) !== hash) {
      throw new TypeError(
        "Torium receipt transaction hash does not match the requested hash."
      );
    }
    return {
      status: receipt.status === "success" ? "committed" : "reverted",
      hash,
      receipt,
      finality: "CometBFT committed",
    };
  } catch (error) {
    if (!(error instanceof WaitForTransactionReceiptTimeoutError)) throw error;
    return {
      status: "unknown",
      hash,
      reason: "timeout",
      safeToAutomaticallyResubmit: false,
    };
  }
}

/** Normalizes and validates the stable standard-EVM request subset. */
export function normalizeToriumTransactionRequest(
  request: ToriumTransactionRequest
): NormalizedToriumTransactionRequest {
  if (typeof request !== "object" || request === null) {
    throw new TypeError("Torium transaction request must be an object.");
  }
  const unsupportedKey = Object.keys(request).find(
    (key) => !toriumTransactionRequestKeys.has(key)
  );
  if (unsupportedKey !== undefined) {
    throw new TypeError(
      "Torium stable transaction helper received an unsupported standard EVM field."
    );
  }
  if (request.account === undefined || request.account === null) {
    throw new TypeError("Torium transaction requires an explicit account.");
  }
  if (request.type !== undefined && request.type !== "eip1559") {
    throw new TypeError(
      "Torium stable transaction helper accepts EIP-1559 requests only."
    );
  }
  const accountAddress = getAccountAddress(request.account);
  const account =
    typeof request.account === "string" ? accountAddress : request.account;
  const to =
    request.to === undefined || request.to === null
      ? request.to
      : normalizeToriumEvmAddress(request.to);
  const data =
    request.data === undefined
      ? undefined
      : normalizeToriumHexData(request.data);
  if (
    (to === undefined || to === null) &&
    (data === undefined || data === "0x")
  ) {
    throw new TypeError(
      "Torium contract deployment requires non-empty standard EVM bytecode."
    );
  }
  if (
    data !== undefined &&
    (data.length - 2) / 2 >= toriumMaxEncodedTransactionBytes
  ) {
    throw new RangeError(
      "Torium transaction data cannot fit within the encoded transaction limit."
    );
  }
  if (request.value !== undefined) assertToriumUint256(request.value);
  if (request.gas !== undefined) assertTransactionGas(request.gas);
  if (request.nonce !== undefined) assertTransactionNonce(request.nonce);
  for (const fee of [request.maxFeePerGas, request.maxPriorityFeePerGas]) {
    if (fee !== undefined) assertToriumUint256(fee);
  }
  if (
    request.maxPriorityFeePerGas !== undefined &&
    request.maxPriorityFeePerGas < toriumMinimumPriorityFeePerGas
  ) {
    throw new RangeError(
      "Torium maximum priority fee is below the protocol minimum."
    );
  }
  if (
    request.maxFeePerGas !== undefined &&
    request.maxFeePerGas <
      toriumMinimumBaseFeePerGas +
        (request.maxPriorityFeePerGas ?? toriumMinimumPriorityFeePerGas)
  ) {
    throw new RangeError(
      "Torium maximum fee cannot cover the protocol base fee and priority fee."
    );
  }
  if (
    request.maxFeePerGas !== undefined &&
    request.maxPriorityFeePerGas !== undefined &&
    request.maxPriorityFeePerGas > request.maxFeePerGas
  ) {
    throw new RangeError(
      "Torium maximum priority fee must not exceed the maximum fee."
    );
  }
  const accessList = normalizeAccessList(request.accessList);
  return removeUndefined({
    ...request,
    type: "eip1559",
    account,
    to,
    data,
    accessList,
  }) as NormalizedToriumTransactionRequest;
}

const toriumTransactionRequestKeys = new Set([
  "account",
  "to",
  "data",
  "value",
  "gas",
  "nonce",
  "maxFeePerGas",
  "maxPriorityFeePerGas",
  "type",
  "accessList",
]);
const maximumLengthSignatureComponent = `0x${"ff".repeat(32)}` as Hex;

function getAccountAddress(account: Account | Address): Address {
  return normalizeToriumEvmAddress(
    typeof account === "string" ? account : account.address
  );
}

function normalizeAccessList(
  accessList: AccessList | undefined
): AccessList | undefined {
  if (accessList === undefined) return undefined;
  if (!Array.isArray(accessList)) {
    throw new TypeError("Torium transaction access list must be an array.");
  }
  return deepFreeze(
    accessList.map((entry) => {
      if (
        typeof entry !== "object" ||
        entry === null ||
        !Array.isArray(entry.storageKeys)
      ) {
        throw new TypeError("Torium transaction access-list entry is invalid.");
      }
      return {
        address: normalizeToriumEvmAddress(entry.address),
        storageKeys: entry.storageKeys.map(normalizeToriumHash),
      };
    })
  );
}

function getMaximumSignedTransactionBytes(request: {
  readonly chainId: number;
  readonly nonce: number;
  readonly maxFeePerGas: bigint;
  readonly maxPriorityFeePerGas: bigint;
  readonly gas: bigint;
  readonly to?: Address | null;
  readonly value: bigint;
  readonly data: Hex;
  readonly accessList: AccessList;
}): number {
  const serialized = serializeTransaction(
    { ...request, type: "eip1559" },
    {
      r: maximumLengthSignatureComponent,
      s: maximumLengthSignatureComponent,
      yParity: 1,
    }
  );
  return (serialized.length - 2) / 2;
}

function assertToriumChain(chain: ToriumClientChain): void {
  const canonical = getToriumChainById(assertToriumChainId(chain.id));
  if (
    typeof chain.torium !== "object" ||
    chain.torium === null ||
    !sameCanonicalValue(chain.torium, canonical.torium) ||
    !sameCanonicalValue(chain.nativeCurrency, canonical.nativeCurrency)
  ) {
    throw new TypeError(
      "Torium wallet client requires a canonical Torium chain definition."
    );
  }
}

function sameCanonicalValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (
    typeof left !== "object" ||
    left === null ||
    typeof right !== "object" ||
    right === null ||
    Array.isArray(left) !== Array.isArray(right)
  ) {
    return false;
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord).sort();
  const rightKeys = Object.keys(rightRecord).sort();
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key, index) =>
        key === rightKeys[index] &&
        sameCanonicalValue(leftRecord[key], rightRecord[key])
    )
  );
}

function assertTransactionGas(value: bigint): void {
  assertToriumUint256(value);
  if (value > toriumMaxTransactionGas) {
    throw new RangeError(
      "Torium transaction gas exceeds the local block gas limit."
    );
  }
}

function assertTransactionNonce(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(
      "Torium transaction nonce must be a non-negative safe integer."
    );
  }
}

function removeUndefined<TObject extends object>(value: TObject): TObject {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined)
  ) as TObject;
}

function deepFreeze<const TObject extends object>(
  value: TObject
): Readonly<TObject> {
  for (const child of Object.values(value)) {
    if (typeof child === "object" && child !== null) deepFreeze(child);
  }
  return Object.freeze(value);
}
