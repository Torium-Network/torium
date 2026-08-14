import {
  defineChain,
  extendSchema,
  type Client,
  type EIP1193Provider,
  type Hash,
} from "viem";

import {
  normalizeToriumError,
  ToriumEndpointValidationError,
} from "./errors.js";

export {
  ToriumEndpointValidationError,
  type ToriumEndpointValidationErrorCode,
} from "./errors.js";

export type ToriumEnvironment = "localnet" | "devnet" | "testnet" | "mainnet";

export type ToriumHttpUrl = `http://${string}` | `https://${string}`;
export type ToriumWebSocketUrl = `ws://${string}` | `wss://${string}`;

export interface ToriumChainMetadata {
  readonly manifestVersion: "0.2.0";
  readonly environment: ToriumEnvironment;
  readonly public: boolean;
  readonly cosmosChainId: string;
  readonly chainIdHex: `0x${string}`;
  readonly networkId: number;
  readonly caip2: `eip155:${number}`;
  readonly baseDenom: "atorium";
  readonly endpointStatus: "local-loopback" | "deferred-unpublished";
  readonly blockExplorerStatus: "deferred";
  readonly contractRegistryStatus: "deferred";
  readonly rpcProfile?: {
    readonly profileVersion: "1.0.1";
    readonly maxBatchRequests: 100;
    readonly subscriptions: readonly [
      "newHeads",
      "logs",
      "newPendingTransactions",
    ];
    readonly serverReplaysMissedMessages: false;
    readonly clientReconnectRequired: true;
    readonly httpBackfillRequired: true;
  };
}

const localnetMetadata = {
  manifestVersion: "0.2.0",
  environment: "localnet",
  public: false,
  cosmosChainId: "torium-localnet-1",
  chainIdHex: "0x544f524c",
  networkId: 1414484556,
  caip2: "eip155:1414484556",
  baseDenom: "atorium",
  endpointStatus: "local-loopback",
  blockExplorerStatus: "deferred",
  contractRegistryStatus: "deferred",
  rpcProfile: {
    profileVersion: "1.0.1",
    maxBatchRequests: 100,
    subscriptions: ["newHeads", "logs", "newPendingTransactions"],
    serverReplaysMissedMessages: false,
    clientReconnectRequired: true,
    httpBackfillRequired: true,
  },
} as const satisfies ToriumChainMetadata;

const devnetMetadata = {
  manifestVersion: "0.2.0",
  environment: "devnet",
  public: false,
  cosmosChainId: "torium-devnet-1",
  chainIdHex: "0x544f5244",
  networkId: 1414484548,
  caip2: "eip155:1414484548",
  baseDenom: "atorium",
  endpointStatus: "deferred-unpublished",
  blockExplorerStatus: "deferred",
  contractRegistryStatus: "deferred",
} as const satisfies ToriumChainMetadata;

const testnetMetadata = {
  manifestVersion: "0.2.0",
  environment: "testnet",
  public: true,
  cosmosChainId: "torium-testnet-1",
  chainIdHex: "0x544f5254",
  networkId: 1414484564,
  caip2: "eip155:1414484564",
  baseDenom: "atorium",
  endpointStatus: "deferred-unpublished",
  blockExplorerStatus: "deferred",
  contractRegistryStatus: "deferred",
} as const satisfies ToriumChainMetadata;

const mainnetMetadata = {
  manifestVersion: "0.2.0",
  environment: "mainnet",
  public: true,
  cosmosChainId: "torium-1",
  chainIdHex: "0x544f52",
  networkId: 5525330,
  caip2: "eip155:5525330",
  baseDenom: "atorium",
  endpointStatus: "deferred-unpublished",
  blockExplorerStatus: "deferred",
  contractRegistryStatus: "deferred",
} as const satisfies ToriumChainMetadata;

const toriumExtensionSchema = extendSchema<{
  readonly torium: ToriumChainMetadata;
}>();

export const toriumLocalnet = defineChain({
  id: 1414484556,
  name: "Torium Localnet",
  supportsTransactionReplacementDetection: false,
  nativeCurrency: {
    decimals: 18,
    name: "Torium Test Token",
    symbol: "tTOR",
  },
  rpcUrls: {
    default: {
      http: ["http://127.0.0.1:8545"],
      webSocket: ["ws://127.0.0.1:8546"],
    },
  },
  testnet: true,
  extendSchema: toriumExtensionSchema,
}).extend({ torium: localnetMetadata });

export const toriumDevnet = defineChain({
  id: 1414484548,
  name: "Torium Devnet",
  supportsTransactionReplacementDetection: false,
  nativeCurrency: {
    decimals: 18,
    name: "Torium Test Token",
    symbol: "tTOR",
  },
  rpcUrls: { default: { http: [] } },
  testnet: true,
  extendSchema: toriumExtensionSchema,
}).extend({ torium: devnetMetadata });

export const toriumTestnet = defineChain({
  id: 1414484564,
  name: "Torium Testnet",
  supportsTransactionReplacementDetection: false,
  nativeCurrency: {
    decimals: 18,
    name: "Torium Test Token",
    symbol: "tTOR",
  },
  rpcUrls: { default: { http: [] } },
  testnet: true,
  extendSchema: toriumExtensionSchema,
}).extend({ torium: testnetMetadata });

export const toriumMainnet = defineChain({
  id: 5525330,
  name: "Torium",
  supportsTransactionReplacementDetection: false,
  nativeCurrency: {
    decimals: 18,
    name: "Torium",
    symbol: "TOR",
  },
  rpcUrls: { default: { http: [] } },
  testnet: false,
  extendSchema: toriumExtensionSchema,
}).extend({ torium: mainnetMetadata });

export const toriumChains = {
  localnet: toriumLocalnet,
  devnet: toriumDevnet,
  testnet: toriumTestnet,
  mainnet: toriumMainnet,
} as const;

export type ToriumChain = (typeof toriumChains)[ToriumEnvironment];

export type ToriumClientChain = {
  [TEnvironment in ToriumEnvironment]: Omit<
    (typeof toriumChains)[TEnvironment],
    "rpcUrls"
  > & {
    readonly rpcUrls: {
      readonly default: {
        readonly http: readonly ToriumHttpUrl[];
        readonly webSocket?: readonly ToriumWebSocketUrl[];
      };
    };
  };
}[ToriumEnvironment];

export function getToriumChain<const TEnvironment extends ToriumEnvironment>(
  environment: TEnvironment
): (typeof toriumChains)[TEnvironment] {
  return toriumChains[environment];
}

export interface ToriumRpcUrlOverrides {
  readonly http: readonly [ToriumHttpUrl, ...ToriumHttpUrl[]];
  readonly webSocket?: readonly [ToriumWebSocketUrl, ...ToriumWebSocketUrl[]];
}

export type ToriumChainWithRpcUrls<
  TChain extends ToriumChain,
  TOverrides extends ToriumRpcUrlOverrides,
> = Omit<TChain, "rpcUrls"> & {
  readonly rpcUrls: {
    readonly default: {
      readonly http: TOverrides["http"];
    } & (TOverrides extends {
      readonly webSocket: infer TWebSocket extends readonly [
        ToriumWebSocketUrl,
        ...ToriumWebSocketUrl[],
      ];
    }
      ? { readonly webSocket: TWebSocket }
      : {});
  };
};

export function withToriumRpcUrls<
  const TChain extends ToriumChain,
  const TOverrides extends ToriumRpcUrlOverrides,
>(
  chain: TChain,
  overrides: TOverrides
): ToriumChainWithRpcUrls<TChain, TOverrides> {
  validateUrls(overrides.http, ["http:", "https:"]);
  if (overrides.webSocket) {
    validateUrls(overrides.webSocket, ["ws:", "wss:"]);
  }

  return defineChain({
    ...chain,
    rpcUrls: {
      default: {
        http: [...overrides.http],
        ...(overrides.webSocket ? { webSocket: [...overrides.webSocket] } : {}),
      },
    },
  }) as ToriumChainWithRpcUrls<TChain, TOverrides>;
}

export type ToriumEndpointRequester =
  | Pick<EIP1193Provider, "request">
  | Pick<Client, "request" | "chain">;

export interface ToriumEndpointCompatibilityCheck {
  readonly kind: "protocol" | "contract" | "capability";
  readonly check: (requester: ToriumEndpointRequester) => Promise<boolean>;
}

export interface ValidateToriumEndpointOptions {
  readonly chain: ToriumClientChain;
  readonly requireReady?: boolean;
  readonly expectedNetworkFingerprint?: Hash;
  readonly minimumBlockNumber?: bigint;
  readonly requireCompatibility?: boolean;
  readonly compatibilityChecks?: readonly ToriumEndpointCompatibilityCheck[];
  readonly signal?: AbortSignal;
}

export interface ToriumEndpointValidationResult {
  readonly status: "ready" | "booting" | "syncing";
  readonly environment: ToriumEnvironment;
  readonly manifestVersion: "0.2.0";
  readonly expectedChainId: number;
  readonly observedChainId: number;
  readonly expectedNetworkId: number;
  readonly observedNetworkId: number;
  readonly blockNumber: bigint;
  readonly syncing: boolean;
  readonly fingerprintStatus: "verified" | "unavailable-local";
  readonly compatibilityStatus: "verified" | "not-requested";
  readonly compatibilityChecks: number;
}

type RpcRequest = (
  parameters: {
    readonly method: string;
    readonly params?: readonly unknown[];
  },
  options?: { readonly signal?: AbortSignal }
) => Promise<unknown>;

export async function validateToriumEndpoint(
  requester: ToriumEndpointRequester,
  options: ValidateToriumEndpointOptions
): Promise<ToriumEndpointValidationResult> {
  const {
    chain,
    requireReady = true,
    expectedNetworkFingerprint,
    minimumBlockNumber,
    requireCompatibility = false,
    compatibilityChecks = [],
    signal,
  } = options;
  if (
    expectedNetworkFingerprint !== undefined &&
    !/^0x[0-9a-f]{64}$/iu.test(expectedNetworkFingerprint)
  ) {
    throw new ToriumEndpointValidationError(
      "TORIUM_ENDPOINT_CONFIG_INVALID",
      "The expected network fingerprint must be a 32-byte hex block hash."
    );
  }
  if (minimumBlockNumber !== undefined && minimumBlockNumber < 0n) {
    throw new ToriumEndpointValidationError(
      "TORIUM_ENDPOINT_CONFIG_INVALID",
      "The minimum block number must not be negative."
    );
  }
  if (requireCompatibility && compatibilityChecks.length === 0) {
    throw new ToriumEndpointValidationError(
      "TORIUM_ENDPOINT_CONFIG_INVALID",
      "At least one compatibility check is required when compatibility enforcement is enabled."
    );
  }
  if (
    "chain" in requester &&
    requester.chain !== undefined &&
    requester.chain !== null &&
    requester.chain.id !== chain.id
  ) {
    throw new ToriumEndpointValidationError(
      "TORIUM_CHAIN_ID_MISMATCH",
      "The configured viem client chain does not match the selected Torium environment.",
      { expected: chain.id, actual: requester.chain.id }
    );
  }

  const request = requester.request as unknown as RpcRequest;
  const observedChainId = parseHexNumber(
    await requestRpc(request, "eth_chainId", undefined, signal),
    "eth_chainId"
  );
  if (observedChainId !== chain.id) {
    throw new ToriumEndpointValidationError(
      "TORIUM_CHAIN_ID_MISMATCH",
      "The endpoint returned a different EIP-155 chain ID.",
      { expected: chain.id, actual: observedChainId }
    );
  }

  const observedNetworkId = parseDecimalNumber(
    await requestRpc(request, "net_version", undefined, signal),
    "net_version"
  );
  if (observedNetworkId !== chain.torium.networkId) {
    throw new ToriumEndpointValidationError(
      "TORIUM_NETWORK_ID_MISMATCH",
      "The endpoint returned a different EVM network ID.",
      { expected: chain.torium.networkId, actual: observedNetworkId }
    );
  }

  const syncingResponse = await requestRpc(
    request,
    "eth_syncing",
    undefined,
    signal
  );
  if (
    syncingResponse !== false &&
    (typeof syncingResponse !== "object" || syncingResponse === null)
  ) {
    throw invalidRpcResponse("eth_syncing");
  }
  const syncing = syncingResponse !== false;

  const blockNumber = parseHexBigInt(
    await requestRpc(request, "eth_blockNumber", undefined, signal),
    "eth_blockNumber"
  );
  const status = syncing ? "syncing" : blockNumber === 0n ? "booting" : "ready";

  if (requireReady && status === "syncing") {
    throw new ToriumEndpointValidationError(
      "TORIUM_RPC_SYNCING",
      "The Torium endpoint is still syncing."
    );
  }
  if (requireReady && status === "booting") {
    throw new ToriumEndpointValidationError(
      "TORIUM_RPC_NOT_READY",
      "The Torium endpoint has not produced a block yet."
    );
  }
  if (minimumBlockNumber !== undefined && blockNumber < minimumBlockNumber) {
    throw new ToriumEndpointValidationError(
      "TORIUM_RPC_STALE",
      "The Torium endpoint is behind the caller's minimum block height.",
      {
        expected: minimumBlockNumber.toString(),
        actual: blockNumber.toString(),
      }
    );
  }

  if (chain.torium.environment !== "localnet" && !expectedNetworkFingerprint) {
    throw new ToriumEndpointValidationError(
      "TORIUM_NETWORK_FINGERPRINT_REQUIRED",
      "A canonical network fingerprint is required for non-local Torium environments."
    );
  }

  let fingerprintStatus: ToriumEndpointValidationResult["fingerprintStatus"] =
    "unavailable-local";
  if (expectedNetworkFingerprint) {
    const genesis = await requestRpc(
      request,
      "eth_getBlockByNumber",
      ["0x0", false],
      signal
    );
    const observedFingerprint = parseBlockHash(genesis);
    if (
      observedFingerprint.toLowerCase() !==
      expectedNetworkFingerprint.toLowerCase()
    ) {
      throw new ToriumEndpointValidationError(
        "TORIUM_NETWORK_FINGERPRINT_MISMATCH",
        "The endpoint genesis fingerprint does not match the selected Torium network.",
        {
          expected: expectedNetworkFingerprint,
          actual: observedFingerprint,
        }
      );
    }
    fingerprintStatus = "verified";
  }

  for (const compatibilityCheck of compatibilityChecks) {
    let compatible: boolean;
    try {
      compatible = await compatibilityCheck.check(requester);
    } catch (error) {
      throw new ToriumEndpointValidationError(
        "TORIUM_ENDPOINT_INCOMPATIBLE",
        "A Torium endpoint compatibility check failed.",
        { cause: error }
      );
    }
    if (compatible !== true) {
      throw new ToriumEndpointValidationError(
        "TORIUM_ENDPOINT_INCOMPATIBLE",
        "The endpoint failed a required Torium compatibility check."
      );
    }
  }

  return {
    status,
    environment: chain.torium.environment,
    manifestVersion: chain.torium.manifestVersion,
    expectedChainId: chain.id,
    observedChainId,
    expectedNetworkId: chain.torium.networkId,
    observedNetworkId,
    blockNumber,
    syncing,
    fingerprintStatus,
    compatibilityStatus:
      compatibilityChecks.length === 0 ? "not-requested" : "verified",
    compatibilityChecks: compatibilityChecks.length,
  };
}

function validateUrls(
  values: readonly string[],
  protocols: readonly string[]
): void {
  if (values.length === 0) {
    throw new ToriumEndpointValidationError(
      "TORIUM_ENDPOINT_CONFIG_INVALID",
      "At least one caller-owned RPC URL is required."
    );
  }

  for (const value of values) {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new ToriumEndpointValidationError(
        "TORIUM_ENDPOINT_CONFIG_INVALID",
        "An RPC URL is malformed."
      );
    }
    if (!protocols.includes(url.protocol)) {
      throw new ToriumEndpointValidationError(
        "TORIUM_ENDPOINT_CONFIG_INVALID",
        "An RPC URL uses an unsupported protocol."
      );
    }
    if (url.username !== "" || url.password !== "") {
      throw new ToriumEndpointValidationError(
        "TORIUM_ENDPOINT_CONFIG_INVALID",
        "RPC URLs must not embed credentials."
      );
    }
  }
}

async function requestRpc(
  request: RpcRequest,
  method: string,
  params?: readonly unknown[],
  signal?: AbortSignal
): Promise<unknown> {
  try {
    return await request(
      { method, ...(params ? { params } : {}) },
      signal ? { signal } : undefined
    );
  } catch (error) {
    if (signal?.aborted) {
      throw new ToriumEndpointValidationError(
        "TORIUM_RPC_ABORTED",
        `The ${method} readiness request was cancelled.`,
        { cause: error, method }
      );
    }
    const normalized = normalizeToriumError(error, {
      operation: "validateToriumEndpoint",
      kind: "read",
      clientKind: "endpoint",
      method,
      fallbackCategory: "transport",
    });
    throw new ToriumEndpointValidationError(
      "TORIUM_RPC_REQUEST_FAILED",
      `The endpoint failed the ${method} readiness request.`,
      {
        cause: error,
        method,
        category: normalized.category,
        retryable: normalized.retryable,
        rpcCode: normalized.rpcCode,
        httpStatus: normalized.httpStatus,
        retryAfterMs: normalized.retryAfterMs,
      }
    );
  }
}

function parseHexNumber(value: unknown, method: string): number {
  const parsed = parseHexBigInt(value, method);
  if (parsed > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw invalidRpcResponse(method);
  }
  return Number(parsed);
}

function parseHexBigInt(value: unknown, method: string): bigint {
  if (typeof value !== "string" || !/^0x[0-9a-f]+$/iu.test(value)) {
    throw invalidRpcResponse(method);
  }
  return BigInt(value);
}

function parseDecimalNumber(value: unknown, method: string): number {
  if (typeof value !== "string" || !/^[0-9]+$/u.test(value)) {
    throw invalidRpcResponse(method);
  }
  const parsed = BigInt(value);
  if (parsed > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw invalidRpcResponse(method);
  }
  return Number(parsed);
}

function parseBlockHash(value: unknown): Hash {
  if (
    typeof value !== "object" ||
    value === null ||
    !("hash" in value) ||
    typeof value.hash !== "string" ||
    !/^0x[0-9a-f]{64}$/iu.test(value.hash)
  ) {
    throw invalidRpcResponse("eth_getBlockByNumber");
  }
  return value.hash as Hash;
}

function invalidRpcResponse(method: string): ToriumEndpointValidationError {
  return new ToriumEndpointValidationError(
    "TORIUM_RPC_RESPONSE_INVALID",
    `The endpoint returned an invalid ${method} response.`
  );
}
