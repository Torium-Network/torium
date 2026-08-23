export const toriumErrorCategories = [
  "configuration",
  "wrong-chain",
  "transport",
  "rate-limit",
  "timeout",
  "cancellation",
  "rpc",
  "simulation",
  "revert",
  "nonce",
  "fee",
  "funds",
  "replacement",
  "compatibility",
  "contract",
  "unknown",
] as const;

export type ToriumSdkErrorCategory = (typeof toriumErrorCategories)[number];

export type ToriumSdkErrorCode =
  | "TORIUM_CONFIG_INVALID"
  | "TORIUM_WRONG_CHAIN"
  | "TORIUM_TRANSPORT_FAILED"
  | "TORIUM_RATE_LIMITED"
  | "TORIUM_TIMEOUT"
  | "TORIUM_CANCELLED"
  | "TORIUM_RPC_FAILED"
  | "TORIUM_SIMULATION_FAILED"
  | "TORIUM_REVERTED"
  | "TORIUM_NONCE_INVALID"
  | "TORIUM_FEE_INVALID"
  | "TORIUM_FUNDS_INSUFFICIENT"
  | "TORIUM_REPLACEMENT_FAILED"
  | "TORIUM_COMPATIBILITY_FAILED"
  | "TORIUM_CONTRACT_FAILED"
  | "TORIUM_UNKNOWN_FAILED";

export type ToriumEndpointValidationErrorCode =
  | "TORIUM_ENDPOINT_CONFIG_INVALID"
  | "TORIUM_CHAIN_ID_MISMATCH"
  | "TORIUM_NETWORK_ID_MISMATCH"
  | "TORIUM_NETWORK_FINGERPRINT_REQUIRED"
  | "TORIUM_NETWORK_FINGERPRINT_MISMATCH"
  | "TORIUM_ENDPOINT_INCOMPATIBLE"
  | "TORIUM_RPC_ABORTED"
  | "TORIUM_RPC_REQUEST_FAILED"
  | "TORIUM_RPC_RESPONSE_INVALID"
  | "TORIUM_RPC_SYNCING"
  | "TORIUM_RPC_NOT_READY"
  | "TORIUM_RPC_STALE";

export type ToriumErrorCode =
  | ToriumSdkErrorCode
  | ToriumEndpointValidationErrorCode;

const safeCauseNames = new Set([
  "Error",
  "TypeError",
  "RangeError",
  "DOMException",
  "AbortError",
  "UserRejectedRequestError",
  "TimeoutError",
  "WaitForTransactionReceiptTimeoutError",
  "LimitExceededRpcError",
  "ChainMismatchError",
  "ChainNotFoundError",
  "SwitchChainError",
  "ReplacementTransactionUnderpricedError",
  "NonceTooLowError",
  "NonceTooHighError",
  "FeeCapTooLowError",
  "TipAboveFeeCapError",
  "InsufficientFundsError",
  "ContractFunctionRevertedError",
  "ExecutionRevertedError",
  "RawContractError",
  "CallExecutionError",
  "EstimateGasExecutionError",
  "SimulationError",
  "ContractFunctionZeroDataError",
  "AbiFunctionNotFoundError",
  "HttpRequestError",
  "WebSocketRequestError",
  "SocketClosedError",
  "NetworkError",
  "FetchError",
  "InvalidParamsRpcError",
  "InternalRpcError",
  "RpcRequestError",
]);

const safeCauseCodes = new Set([
  "ABORT_ERR",
  "ECONNREFUSED",
  "ECONNRESET",
  "ENETUNREACH",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "ERR_NETWORK",
  "ERR_CANCELED",
  "ERR_ABORTED",
]);

export type ToriumClientKind = "endpoint" | "public" | "wallet" | "contract";
export type ToriumOperationKind = "read" | "write" | "broadcast";

export interface ToriumErrorContext {
  readonly operation: string;
  readonly kind: ToriumOperationKind;
  readonly clientKind?: ToriumClientKind;
  readonly method?: string;
  readonly chainId?: number;
  readonly requestId?: string;
  readonly fallbackCategory?: ToriumSdkErrorCategory;
}

export interface ToriumErrorCause {
  readonly name: string;
  readonly message: string;
  readonly code?: string | number;
  readonly cause?: ToriumErrorCause;
}

export interface ToriumSdkErrorOptions<
  TCode extends string = ToriumErrorCode,
> extends Partial<ToriumErrorContext> {
  readonly code: TCode;
  readonly category: ToriumSdkErrorCategory;
  readonly message?: string;
  readonly cause?: unknown;
  readonly retryable?: boolean;
  readonly safeToRetry?: boolean;
  readonly rpcCode?: number;
  readonly httpStatus?: number;
  readonly retryAfterMs?: number;
  readonly revertData?: `0x${string}`;
  readonly revertReason?: string;
  readonly issues?: readonly string[];
}

export class ToriumSdkError<
  TCode extends string = ToriumErrorCode,
> extends Error {
  readonly code: TCode;
  readonly category: ToriumSdkErrorCategory;
  readonly operation?: string;
  readonly kind?: ToriumOperationKind;
  readonly clientKind?: ToriumClientKind;
  readonly method?: string;
  readonly chainId?: number;
  readonly requestId?: string;
  readonly retryable: boolean;
  readonly safeToRetry: boolean;
  readonly rpcCode?: number;
  readonly httpStatus?: number;
  readonly retryAfterMs?: number;
  readonly revertData?: `0x${string}`;
  readonly revertReason?: string;
  readonly issues?: readonly string[];
  readonly cause?: ToriumErrorCause;

  constructor(options: ToriumSdkErrorOptions<TCode>) {
    const safeCause = toToriumErrorCause(options.cause);
    super(
      options.message ?? defaultMessage(options.category),
      safeCause === undefined ? undefined : { cause: safeCause }
    );
    this.name = "ToriumSdkError";
    this.code = options.code;
    this.category = options.category;
    this.operation = options.operation;
    this.kind = options.kind;
    this.clientKind = options.clientKind;
    this.method = options.method;
    this.chainId = options.chainId;
    this.requestId = options.requestId;
    this.retryable = options.retryable ?? false;
    this.safeToRetry = options.safeToRetry ?? false;
    this.rpcCode = options.rpcCode;
    this.httpStatus = options.httpStatus;
    this.retryAfterMs = options.retryAfterMs;
    this.revertData = options.revertData;
    this.revertReason = options.revertReason;
    this.issues = options.issues;
    this.cause = safeCause;
  }

  toJSON(): Record<string, unknown> {
    return removeUndefined({
      name: this.name,
      message: this.message,
      code: this.code,
      category: this.category,
      operation: this.operation,
      kind: this.kind,
      clientKind: this.clientKind,
      method: this.method,
      chainId: this.chainId,
      requestId: this.requestId,
      retryable: this.retryable,
      safeToRetry: this.safeToRetry,
      rpcCode: this.rpcCode,
      httpStatus: this.httpStatus,
      retryAfterMs: this.retryAfterMs,
      revertData: this.revertData,
      revertReason: this.revertReason,
      issues: this.issues,
      cause: this.cause,
    });
  }
}

export class ToriumEndpointValidationError extends ToriumSdkError<ToriumEndpointValidationErrorCode> {
  readonly expected?: string | number;
  readonly actual?: string | number;

  constructor(
    code: ToriumEndpointValidationErrorCode,
    message: string,
    options: {
      readonly expected?: string | number;
      readonly actual?: string | number;
      readonly cause?: unknown;
      readonly method?: string;
      readonly operation?: string;
      readonly clientKind?: ToriumClientKind;
      readonly chainId?: number;
      readonly requestId?: string;
      readonly category?: ToriumSdkErrorCategory;
      readonly retryable?: boolean;
      readonly rpcCode?: number;
      readonly httpStatus?: number;
      readonly retryAfterMs?: number;
    } = {}
  ) {
    const category = options.category ?? endpointCategory(code);
    const retryable = options.retryable ?? code === "TORIUM_RPC_REQUEST_FAILED";
    super({
      code,
      category,
      message,
      cause: options.cause,
      method: options.method,
      operation: options.operation ?? "validateToriumEndpoint",
      kind: "read",
      clientKind: options.clientKind ?? "endpoint",
      chainId: options.chainId,
      requestId: options.requestId,
      retryable,
      safeToRetry: retryable,
      rpcCode: options.rpcCode,
      httpStatus: options.httpStatus,
      retryAfterMs: options.retryAfterMs,
    });
    this.name = "ToriumEndpointValidationError";
    this.expected = options.expected;
    this.actual = options.actual;
  }

  override toJSON(): Record<string, unknown> {
    return removeUndefined({
      ...super.toJSON(),
      expected: this.expected,
      actual: this.actual,
    });
  }
}

export interface ToriumReadRetryOptions {
  /** Total attempts including the first call. Defaults to one and is capped at three. */
  readonly maxAttempts?: number;
  readonly baseDelayMs?: number;
  readonly maximumDelayMs?: number;
  /** Fraction from 0 through 1. Defaults to 0.2. */
  readonly jitterRatio?: number;
}

export interface ToriumDiagnosticEvent {
  readonly schemaVersion: 1;
  readonly sdkVersion: "0.1.2";
  readonly policyVersion: "0.1.0";
  readonly phase: "start" | "retry" | "success" | "failure";
  readonly clientKind: ToriumClientKind;
  readonly operation: string;
  readonly method?: string;
  readonly chainId?: number;
  readonly requestId?: string;
  readonly attempt: number;
  readonly durationMs: number;
  readonly code?: string;
  readonly category?: ToriumSdkErrorCategory;
  readonly retryable?: boolean;
  readonly rpcCode?: number;
  readonly httpStatus?: number;
  readonly retryAfterMs?: number;
}

export type ToriumDiagnosticHook = (
  event: ToriumDiagnosticEvent
) => void | Promise<void>;

export interface ToriumActionOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly requestId?: string;
  readonly diagnostics?: ToriumDiagnosticHook;
}

export interface ToriumReadActionOptions extends ToriumActionOptions {
  readonly retry?: ToriumReadRetryOptions;
}

export function isToriumSdkError(error: unknown): error is ToriumSdkError {
  return error instanceof ToriumSdkError;
}

export function normalizeToriumError(
  error: unknown,
  context: ToriumErrorContext
): ToriumSdkError {
  assertContext(context);
  if (error instanceof ToriumSdkError) return error;
  const chain = errorChain(error);
  const category = classify(chain, context);
  const rpcCode = firstNumber(chain, "code");
  const httpStatus = firstNumber(chain, "status");
  const retryAfterMs = getRetryAfterMs(chain);
  const retryable = isTransient(category, rpcCode, httpStatus);
  return new ToriumSdkError({
    code: categoryCode(category),
    category,
    message: defaultMessage(category),
    cause: error,
    operation: context.operation,
    kind: context.kind,
    clientKind: context.clientKind,
    method: context.method,
    chainId: context.chainId,
    requestId: context.requestId,
    retryable,
    safeToRetry: context.kind === "read" && retryable,
    rpcCode,
    httpStatus,
    retryAfterMs,
    revertData: firstRevertData(chain),
    revertReason: firstSafeString(chain, "reason"),
  });
}

function endpointCategory(
  code: ToriumEndpointValidationErrorCode
): ToriumSdkErrorCategory {
  if (code === "TORIUM_ENDPOINT_CONFIG_INVALID") return "configuration";
  if (
    code === "TORIUM_CHAIN_ID_MISMATCH" ||
    code === "TORIUM_NETWORK_ID_MISMATCH"
  ) {
    return "wrong-chain";
  }
  if (code === "TORIUM_RPC_ABORTED") return "cancellation";
  if (code === "TORIUM_RPC_REQUEST_FAILED") return "transport";
  if (code === "TORIUM_RPC_RESPONSE_INVALID") return "rpc";
  return "compatibility";
}

function categoryCode(category: ToriumSdkErrorCategory): ToriumSdkErrorCode {
  const codes: Record<ToriumSdkErrorCategory, ToriumSdkErrorCode> = {
    configuration: "TORIUM_CONFIG_INVALID",
    "wrong-chain": "TORIUM_WRONG_CHAIN",
    transport: "TORIUM_TRANSPORT_FAILED",
    "rate-limit": "TORIUM_RATE_LIMITED",
    timeout: "TORIUM_TIMEOUT",
    cancellation: "TORIUM_CANCELLED",
    rpc: "TORIUM_RPC_FAILED",
    simulation: "TORIUM_SIMULATION_FAILED",
    revert: "TORIUM_REVERTED",
    nonce: "TORIUM_NONCE_INVALID",
    fee: "TORIUM_FEE_INVALID",
    funds: "TORIUM_FUNDS_INSUFFICIENT",
    replacement: "TORIUM_REPLACEMENT_FAILED",
    compatibility: "TORIUM_COMPATIBILITY_FAILED",
    contract: "TORIUM_CONTRACT_FAILED",
    unknown: "TORIUM_UNKNOWN_FAILED",
  };
  return codes[category];
}

function defaultMessage(category: ToriumSdkErrorCategory): string {
  const messages: Record<ToriumSdkErrorCategory, string> = {
    configuration: "The Torium action configuration is invalid.",
    "wrong-chain": "The Torium action is connected to the wrong chain.",
    transport: "The Torium transport request failed.",
    "rate-limit": "The Torium RPC request was rate limited.",
    timeout: "The Torium action exceeded its timeout.",
    cancellation: "The Torium action was cancelled.",
    rpc: "The Torium JSON-RPC request failed.",
    simulation: "The Torium transaction simulation failed.",
    revert: "The Torium EVM execution reverted.",
    nonce: "The Torium transaction nonce is invalid.",
    fee: "The Torium transaction fee is invalid.",
    funds: "The Torium account has insufficient funds.",
    replacement: "The Torium transaction replacement failed.",
    compatibility: "The Torium endpoint or deployment is incompatible.",
    contract: "The Torium contract action failed.",
    unknown: "The Torium action failed.",
  };
  return messages[category];
}

function classify(
  chain: readonly ErrorRecord[],
  context: ToriumErrorContext
): ToriumSdkErrorCategory {
  const names = chain.map(({ name }) => name.toLowerCase());
  const messages = chain.map(({ message }) => message.toLowerCase());
  const codes = chain.map(({ value }) => value.code);
  const statuses = chain.map(({ value }) => value.status);
  const hasName = (pattern: RegExp) => names.some((name) => pattern.test(name));
  const hasMessage = (pattern: RegExp) =>
    messages.some((message) => pattern.test(message));

  if (
    hasName(/abort|userrejectedrequest/u) ||
    codes.includes(4001) ||
    hasMessage(/user rejected|request rejected by user/u)
  ) {
    return "cancellation";
  }
  if (hasName(/timeout/u) || hasMessage(/timed? out|timeout/u))
    return "timeout";
  if (
    codes.includes(-32005) ||
    statuses.includes(429) ||
    hasName(/limitexceeded|ratelimit/u) ||
    hasMessage(/rate.?limit|too many requests/u)
  ) {
    return "rate-limit";
  }
  if (
    hasName(/chainmismatch|chainnotfound|switchchain/u) ||
    hasMessage(
      /wrong chain|chain id.+does not match|chain mismatch|does not match the configured chain|must use the same chain/u
    )
  ) {
    return "wrong-chain";
  }
  if (/typeerror|rangeerror/u.test(names[0] ?? "")) return "configuration";
  if (
    hasName(/replacement/u) ||
    hasMessage(/replacement transaction underpriced|transaction replaced/u)
  ) {
    return "replacement";
  }
  if (
    hasName(/nonce/u) ||
    hasMessage(/nonce too (?:low|high)|nonce mismatch|transaction nonce/u)
  ) {
    return "nonce";
  }
  if (
    hasName(/fee|tipabovefeecap/u) ||
    hasMessage(/fee cap|priority fee|transaction fee/u)
  ) {
    return "fee";
  }
  if (hasName(/insufficientfunds/u) || hasMessage(/insufficient funds/u)) {
    return "funds";
  }
  if (
    hasName(/contractfunctionreverted|executionreverted|rawcontract/u) ||
    hasMessage(/execution reverted|revert(?:ed)?/u)
  ) {
    return "revert";
  }
  if (
    hasName(/httprequest|websocketrequest|socketclosed|network|fetch/u) ||
    hasMessage(
      /transport unavailable|network error|fetch failed|offline|connection (?:closed|refused|reset)/u
    ) ||
    statuses.some((status) => typeof status === "number")
  ) {
    return "transport";
  }
  if (hasName(/rpc/u) || codes.some((code) => typeof code === "number")) {
    return "rpc";
  }
  if (hasName(/callexecution|estimategasexecution|simulation/u)) {
    return "simulation";
  }
  if (hasName(/contractfunction|abifunction|contract/u)) return "contract";
  return context.fallbackCategory ?? "unknown";
}

function isTransient(
  category: ToriumSdkErrorCategory,
  rpcCode?: number,
  httpStatus?: number
): boolean {
  if (category === "transport") {
    return (
      httpStatus === undefined ||
      [408, 429, 500, 502, 503, 504].includes(httpStatus)
    );
  }
  if (category === "rate-limit" || category === "timeout") return true;
  return category === "rpc" && [-32603, -32002, -32005].includes(rpcCode ?? 0);
}

interface ErrorRecord {
  readonly value: Record<string, unknown>;
  readonly name: string;
  readonly message: string;
}

function errorChain(error: unknown): readonly ErrorRecord[] {
  const result: ErrorRecord[] = [];
  const visited = new Set<unknown>();
  let current = error;
  while (current !== undefined && current !== null && result.length < 8) {
    if (visited.has(current)) break;
    visited.add(current);
    const value = toRecord(current);
    result.push({
      value,
      name: typeof value.name === "string" ? value.name : "Error",
      message: typeof value.message === "string" ? value.message : "",
    });
    current = value.cause;
  }
  return result;
}

function firstNumber(
  chain: readonly ErrorRecord[],
  key: "code" | "status"
): number | undefined {
  for (const { value } of chain) {
    const candidate = value[key];
    if (typeof candidate === "number" && Number.isFinite(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

function firstSafeString(
  chain: readonly ErrorRecord[],
  key: string
): string | undefined {
  for (const { value } of chain) {
    if (typeof value[key] === "string") return sanitizeText(value[key]);
  }
  return undefined;
}

function firstRevertData(
  chain: readonly ErrorRecord[]
): `0x${string}` | undefined {
  for (const { value } of chain) {
    for (const candidate of [
      value.raw,
      value.data,
      toRecord(value.data).data,
    ]) {
      if (
        typeof candidate === "string" &&
        /^0x[0-9a-f]*$/iu.test(candidate) &&
        candidate.length <= 131_074
      ) {
        return candidate as `0x${string}`;
      }
    }
  }
  return undefined;
}

function getRetryAfterMs(chain: readonly ErrorRecord[]): number | undefined {
  for (const { value } of chain) {
    const direct = value.retryAfterMs;
    if (typeof direct === "number" && Number.isFinite(direct) && direct >= 0) {
      return Math.min(Math.floor(direct), 30_000);
    }
    const headers = toRecord(value.headers);
    if (typeof headers.get === "function") {
      const seconds = Number(
        (headers.get as (name: string) => unknown)("retry-after")
      );
      if (Number.isFinite(seconds) && seconds >= 0) {
        return Math.min(Math.floor(seconds * 1_000), 30_000);
      }
    }
  }
  return undefined;
}

function toToriumErrorCause(
  error: unknown,
  depth = 0,
  visited = new Set<unknown>()
): ToriumErrorCause | undefined {
  if (
    error === undefined ||
    error === null ||
    depth >= 5 ||
    visited.has(error)
  ) {
    return undefined;
  }
  visited.add(error);
  const value = toRecord(error);
  const name = safeCauseName(value.name);
  const message = `Upstream ${name} details were redacted.`;
  const code = safeCauseCode(value.code);
  const cause = toToriumErrorCause(value.cause, depth + 1, visited);
  return removeUndefined({
    name,
    message,
    code,
    cause,
  }) as unknown as ToriumErrorCause;
}

function safeCauseName(value: unknown): string {
  return typeof value === "string" && safeCauseNames.has(value)
    ? value
    : "Error";
}

function safeCauseCode(value: unknown): string | number | undefined {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === "string" && safeCauseCodes.has(value)) {
    return value;
  }
  return undefined;
}

function sanitizeText(value: string): string {
  return value
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/giu, "[redacted-url]")
    .replace(/\bbearer\s+\S+/giu, "Bearer [redacted]")
    .replace(
      /\b(?:authorization|api[-_ ]?key|token|secret|password|mnemonic|private[-_ ]?key)\s*[:=]\s*\S+/giu,
      "[redacted-field]"
    )
    .replace(/0x[0-9a-f]{64,}/giu, "[redacted-hex]");
}

function assertContext(context: ToriumErrorContext): void {
  for (const [label, value] of [
    ["operation", context.operation],
    ["method", context.method],
    ["requestId", context.requestId],
  ] as const) {
    if (
      value !== undefined &&
      (value.length < 1 ||
        value.length > 96 ||
        !/^[a-z0-9_.:-]+$/iu.test(value))
    ) {
      throw new TypeError(`Torium diagnostic ${label} is invalid.`);
    }
  }
}

function toRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

function removeUndefined<T extends Record<string, unknown>>(
  value: T
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined)
  );
}
