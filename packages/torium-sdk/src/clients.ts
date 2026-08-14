import {
  createPublicClient,
  type Hash,
  type PublicClient,
  type PublicClientConfig,
  type RpcSchema,
  type Tokens,
  type Transport,
} from "viem";

import {
  ToriumEndpointValidationError,
  type ToriumClientChain,
  type ToriumEndpointValidationResult,
  validateToriumEndpoint,
} from "./chains.js";
import {
  isToriumSdkError,
  normalizeToriumError,
  type ToriumReadActionOptions,
} from "./errors.js";
import { runToriumReadAction } from "./internal/execution.js";

export type ToriumCapabilityState =
  | "supported"
  | "partial"
  | "stub"
  | "unsupported";

export const toriumReadCapabilities = deepFreeze({
  schemaVersion: 1,
  baseline: {
    cosmosEvm: "v0.7.0",
    viem: "2.55.2",
  },
  blockTags: {
    latest: {
      block: "supported",
      state: "supported",
    },
    pending: {
      block: "partial",
      state: "partial",
      distinctStateViewProven: false,
    },
    safe: {
      block: "partial",
      state: "unsupported",
    },
    finalized: {
      block: "partial",
      state: "partial",
      meaning: "latest-committed-cometbft-state",
    },
  },
  finality: {
    defaultConfirmationBlocks: 1,
    label: "CometBFT committed",
    finalizedTagMeaning: "latest-committed-cometbft-state",
    beaconChainSemantics: false,
    probabilisticConfirmation: false,
    boundedInclusionClaim: false,
    replacementGenesisIsDiscontinuity: true,
  },
  subscriptions: {
    newHeads: {
      baseline: "supported",
      activeLocalProfile: "supported",
    },
    logs: {
      baseline: "supported",
      activeLocalProfile: "supported",
    },
    pendingTransactions: {
      baseline: "supported",
      activeLocalProfile: "supported",
    },
    browserWebSocket: "unsupported",
    serverReplay: false,
    reconnectOwner: "client",
    httpBackfillRequired: true,
  },
  limits: {
    feeHistoryBlocks: 100,
    logBlockRange: 10_000,
    logResults: 10_000,
    ethCallGas: 25_000_000,
    ethCallTimeoutMilliseconds: 5_000,
  },
  cosmosExtension: {
    status: "stub",
    usable: false,
  },
} as const);

export type ToriumReadCapabilities = typeof toriumReadCapabilities;
export type ToriumStateQueryBlockTag =
  | "latest"
  | "pending"
  | "safe"
  | "finalized";

export interface ToriumBlockRange {
  readonly fromBlock: bigint;
  readonly toBlock: bigint;
}

export interface GetToriumNetworkStatusOptions extends ToriumReadActionOptions {
  readonly requireReady?: boolean;
  readonly minimumBlockNumber?: bigint;
  readonly expectedNetworkFingerprint?: Hash;
}

export interface ToriumNetworkStatus extends ToriumEndpointValidationResult {
  readonly listening: boolean;
  readonly peerCount: bigint;
  readonly clientVersion: string;
  readonly finality: ToriumReadCapabilities["finality"];
}

export interface ToriumPublicActions {
  getToriumNetworkStatus(
    options?: GetToriumNetworkStatusOptions
  ): Promise<ToriumNetworkStatus>;
  getToriumReadCapabilities(): ToriumReadCapabilities;
}

export type ToriumPublicClientConfig<
  TTransport extends Transport,
  TChain extends ToriumClientChain,
  TRpcSchema extends RpcSchema | undefined = undefined,
  TTokens extends Tokens | undefined = undefined,
> = Omit<
  PublicClientConfig<TTransport, TChain, undefined, TRpcSchema, TTokens>,
  "chain"
> & {
  readonly chain: TChain;
};

export type ToriumPublicClient<
  TTransport extends Transport = Transport,
  TChain extends ToriumClientChain = ToriumClientChain,
  TRpcSchema extends RpcSchema | undefined = undefined,
  TTokens extends Tokens | undefined = undefined,
> = PublicClient<TTransport, TChain, undefined, TRpcSchema, TTokens> &
  ToriumPublicActions;

type StatusRpcRequester = {
  request(
    parameters: {
      readonly method: string;
      readonly params?: readonly unknown[];
    },
    options?: { readonly signal?: AbortSignal }
  ): Promise<unknown>;
};

export function toriumPublicActions<
  TTransport extends Transport,
  TChain extends ToriumClientChain,
>(client: PublicClient<TTransport, TChain>) {
  return {
    async getToriumNetworkStatus(
      options: GetToriumNetworkStatusOptions = {}
    ): Promise<ToriumNetworkStatus> {
      try {
        return await runToriumReadAction(
          async ({ signal }) => {
            const endpoint = await validateToriumEndpoint(client, {
              chain: client.chain,
              requireReady: options.requireReady,
              minimumBlockNumber: options.minimumBlockNumber,
              expectedNetworkFingerprint: options.expectedNetworkFingerprint,
              signal,
            });
            const requester = client as unknown as StatusRpcRequester;
            const clientVersion = parseString(
              await requestStatusRpc(requester, "web3_clientVersion", signal),
              "web3_clientVersion"
            );
            const listening = parseBoolean(
              await requestStatusRpc(requester, "net_listening", signal),
              "net_listening"
            );
            const peerCount = parseHexBigInt(
              await requestStatusRpc(requester, "net_peerCount", signal),
              "net_peerCount"
            );

            return {
              ...endpoint,
              clientVersion,
              listening,
              peerCount,
              finality: toriumReadCapabilities.finality,
            };
          },
          {
            operation: "getToriumNetworkStatus",
            clientKind: "public",
            method: "torium_networkStatus",
            chainId: client.chain.id,
          },
          options
        );
      } catch (error) {
        if (
          isToriumSdkError(error) &&
          error.category === "cancellation" &&
          !(error instanceof ToriumEndpointValidationError)
        ) {
          throw new ToriumEndpointValidationError(
            "TORIUM_RPC_ABORTED",
            "The Torium network-status action was cancelled.",
            {
              cause: error,
              operation: "getToriumNetworkStatus",
              clientKind: "public",
              method: "torium_networkStatus",
              chainId: client.chain.id,
              requestId: options.requestId,
            }
          );
        }
        throw error;
      }
    },
    getToriumReadCapabilities(): ToriumReadCapabilities {
      return toriumReadCapabilities;
    },
  };
}

export function createToriumPublicClient<
  TTransport extends Transport,
  const TChain extends ToriumClientChain,
  TRpcSchema extends RpcSchema | undefined = undefined,
  const TTokens extends Tokens | undefined = undefined,
>(
  parameters: ToriumPublicClientConfig<TTransport, TChain, TRpcSchema, TTokens>
): ToriumPublicClient<TTransport, TChain, TRpcSchema, TTokens> {
  return createPublicClient(parameters).extend(
    toriumPublicActions
  ) as ToriumPublicClient<TTransport, TChain, TRpcSchema, TTokens>;
}

export function getToriumStateQueryCapability(
  blockTag: ToriumStateQueryBlockTag
): {
  readonly state: ToriumCapabilityState;
  readonly usableByStableHelper: boolean;
  readonly meaning?: string;
} {
  const capability = toriumReadCapabilities.blockTags[blockTag];
  return {
    state: capability.state,
    usableByStableHelper: blockTag === "latest" || blockTag === "finalized",
    ...("meaning" in capability ? { meaning: capability.meaning } : {}),
  };
}

export function createToriumLogRanges(
  parameters: ToriumBlockRange
): readonly ToriumBlockRange[] {
  const { fromBlock, toBlock } = parameters;
  if (fromBlock < 0n || toBlock < 0n) {
    throw new RangeError("Torium log ranges must not use negative blocks.");
  }
  if (toBlock < fromBlock) {
    throw new RangeError("Torium log range end must not precede its start.");
  }

  const ranges: ToriumBlockRange[] = [];
  const maximumSpan = BigInt(toriumReadCapabilities.limits.logBlockRange);
  for (let start = fromBlock; start <= toBlock; start += maximumSpan) {
    const end = start + maximumSpan - 1n;
    ranges.push({
      fromBlock: start,
      toBlock: end < toBlock ? end : toBlock,
    });
  }
  return ranges;
}

export function assertToriumFeeHistoryBlockCount(blockCount: number): void {
  if (
    !Number.isInteger(blockCount) ||
    blockCount < 1 ||
    blockCount > toriumReadCapabilities.limits.feeHistoryBlocks
  ) {
    throw new RangeError(
      `Torium fee history block count must be an integer from 1 to ${toriumReadCapabilities.limits.feeHistoryBlocks}.`
    );
  }
}

async function requestStatusRpc(
  requester: StatusRpcRequester,
  method: string,
  signal?: AbortSignal
): Promise<unknown> {
  try {
    return await requester.request({ method }, signal ? { signal } : undefined);
  } catch (error) {
    if (signal?.aborted) {
      throw new ToriumEndpointValidationError(
        "TORIUM_RPC_ABORTED",
        `The ${method} network-status request was cancelled.`,
        { cause: error, method }
      );
    }
    const normalized = normalizeToriumError(error, {
      operation: "getToriumNetworkStatus",
      kind: "read",
      clientKind: "public",
      method,
      fallbackCategory: "transport",
    });
    throw new ToriumEndpointValidationError(
      "TORIUM_RPC_REQUEST_FAILED",
      `The endpoint failed the ${method} network-status request.`,
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

function parseString(value: unknown, method: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw invalidStatusResponse(method);
  }
  return value;
}

function parseBoolean(value: unknown, method: string): boolean {
  if (typeof value !== "boolean") throw invalidStatusResponse(method);
  return value;
}

function parseHexBigInt(value: unknown, method: string): bigint {
  if (typeof value === "string" && /^0x[0-9a-f]+$/iu.test(value)) {
    return BigInt(value);
  }
  // The live cosmos-evm node returns net_peerCount as a bare JSON number
  // rather than a spec hex quantity; accept both encodings fail-closed.
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return BigInt(value);
  }
  throw invalidStatusResponse(method);
}

function invalidStatusResponse(method: string): ToriumEndpointValidationError {
  return new ToriumEndpointValidationError(
    "TORIUM_RPC_RESPONSE_INVALID",
    `The endpoint returned an invalid ${method} network-status response.`
  );
}

function deepFreeze<const TObject extends object>(
  value: TObject
): Readonly<TObject> {
  for (const child of Object.values(value)) {
    if (typeof child === "object" && child !== null) deepFreeze(child);
  }
  return Object.freeze(value);
}
