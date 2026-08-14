import {
  normalizeToriumError,
  ToriumSdkError,
  type ToriumActionOptions,
  type ToriumDiagnosticEvent,
  type ToriumErrorContext,
  type ToriumOperationKind,
  type ToriumReadActionOptions,
  type ToriumReadRetryOptions,
} from "../errors.js";

const maximumReadAttempts = 3;
const maximumTimeoutMs = 300_000;
const maximumBackoffMs = 30_000;

export interface ToriumExecutionAttempt {
  readonly attempt: number;
  readonly signal: AbortSignal;
}

export async function runToriumReadAction<T>(
  action: (attempt: ToriumExecutionAttempt) => Promise<T>,
  context: Omit<ToriumErrorContext, "kind">,
  options: ToriumReadActionOptions = {}
): Promise<T> {
  return runAction(action, { ...context, kind: "read" }, options, true);
}

export async function runToriumWriteActionOnce<T>(
  action: (attempt: ToriumExecutionAttempt) => Promise<T>,
  context: Omit<ToriumErrorContext, "kind"> & {
    readonly kind: "write" | "broadcast";
  },
  options: ToriumActionOptions = {}
): Promise<T> {
  return runAction(action, context, options, false);
}

async function runAction<T>(
  action: (attempt: ToriumExecutionAttempt) => Promise<T>,
  context: ToriumErrorContext,
  options: ToriumReadActionOptions,
  allowRetry: boolean
): Promise<T> {
  const operationContext = {
    ...context,
    requestId: options.requestId ?? context.requestId,
  };
  validateExecutionContext(operationContext);
  let timeoutMs: number | undefined;
  let retry: ValidatedRetry;
  try {
    timeoutMs = validateTimeout(options.timeoutMs);
    retry = validateRetry(allowRetry ? options.retry : undefined);
  } catch (error) {
    throw configurationError(error, operationContext);
  }
  const startedAt = Date.now();
  const operation = createOperationSignal(options.signal, timeoutMs);
  let attempt = 1;
  emit(options, event(operationContext, "start", attempt, startedAt));

  try {
    while (true) {
      try {
        operation.throwIfAborted();
        const pending = action({ attempt, signal: operation.signal });
        const result =
          timeoutMs === undefined && options.signal === undefined
            ? await pending
            : await raceAbort(pending, operation.signal);
        emit(options, event(operationContext, "success", attempt, startedAt));
        return result;
      } catch (error) {
        const normalized = enforceOperationSafety(
          operation.normalize(error, operationContext),
          operationContext
        );
        if (
          !allowRetry ||
          !normalized.safeToRetry ||
          attempt >= retry.maxAttempts ||
          operation.signal.aborted
        ) {
          emit(
            options,
            event(operationContext, "failure", attempt, startedAt, normalized)
          );
          throw normalized;
        }
        attempt += 1;
        emit(
          options,
          event(operationContext, "retry", attempt, startedAt, normalized)
        );
        try {
          await waitForRetry(
            retryDelay(retry, attempt - 1, normalized.retryAfterMs),
            operation.signal
          );
        } catch (backoffError) {
          const interrupted = enforceOperationSafety(
            operation.normalize(backoffError, operationContext),
            operationContext
          );
          emit(
            options,
            event(operationContext, "failure", attempt, startedAt, interrupted)
          );
          throw interrupted;
        }
      }
    }
  } finally {
    operation.cleanup();
  }
}

function configurationError(
  cause: unknown,
  context: ToriumErrorContext
): ToriumSdkError {
  return new ToriumSdkError({
    code: "TORIUM_CONFIG_INVALID",
    category: "configuration",
    message: "The Torium action controls are invalid.",
    cause,
    operation: context.operation,
    kind: context.kind,
    clientKind: context.clientKind,
    method: context.method,
    chainId: context.chainId,
    requestId: context.requestId,
    retryable: false,
    safeToRetry: false,
  });
}

function validateExecutionContext(context: ToriumErrorContext): void {
  for (const [label, value] of [
    ["operation", context.operation],
    ["method", context.method],
    ["request ID", context.requestId],
  ] as const) {
    if (
      value !== undefined &&
      (value.length < 1 ||
        value.length > 96 ||
        !/^[a-z0-9_.:-]+$/iu.test(value))
    ) {
      throw new ToriumSdkError({
        code: "TORIUM_CONFIG_INVALID",
        category: "configuration",
        message: `The Torium action ${label} is invalid.`,
        operation: context.operation,
        kind: context.kind,
        clientKind: context.clientKind,
        method: label === "method" ? undefined : context.method,
        chainId: context.chainId,
        retryable: false,
        safeToRetry: false,
      });
    }
  }
}

function enforceOperationSafety(
  error: ToriumSdkError,
  context: ToriumErrorContext
): ToriumSdkError {
  if (context.kind === "read" || !error.safeToRetry) return error;
  return new ToriumSdkError({
    code: error.code,
    category: error.category,
    message: error.message,
    cause: error.cause,
    operation: context.operation,
    kind: context.kind,
    clientKind: context.clientKind ?? error.clientKind,
    method: context.method ?? error.method,
    chainId: context.chainId ?? error.chainId,
    requestId: context.requestId ?? error.requestId,
    retryable: error.retryable,
    safeToRetry: false,
    rpcCode: error.rpcCode,
    httpStatus: error.httpStatus,
    retryAfterMs: error.retryAfterMs,
    revertData: error.revertData,
    revertReason: error.revertReason,
    issues: error.issues,
  });
}

function createOperationSignal(
  signal: AbortSignal | undefined,
  timeoutMs: number | undefined
) {
  if (timeoutMs === undefined && signal !== undefined) {
    return {
      signal,
      throwIfAborted() {
        if (signal.aborted) throw controlError("cancellation");
      },
      normalize(error: unknown, context: ToriumErrorContext): ToriumSdkError {
        if (
          error instanceof ToriumSdkError &&
          error.code === "TORIUM_RPC_ABORTED"
        ) {
          return error;
        }
        if (signal.aborted) return controlError("cancellation", context);
        if (error instanceof ToriumSdkError) return error;
        return normalizeToriumError(error, context);
      },
      cleanup() {},
    };
  }

  const controller = new AbortController();
  let timedOut = false;
  const onAbort = () => controller.abort();
  if (signal?.aborted) controller.abort();
  else signal?.addEventListener("abort", onAbort, { once: true });
  const timer =
    timeoutMs === undefined
      ? undefined
      : setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, timeoutMs);

  return {
    signal: controller.signal,
    throwIfAborted() {
      if (!controller.signal.aborted) return;
      throw controlError(timedOut ? "timeout" : "cancellation");
    },
    normalize(error: unknown, context: ToriumErrorContext): ToriumSdkError {
      if (timedOut) return controlError("timeout", context);
      if (error instanceof ToriumSdkError) return error;
      if (controller.signal.aborted)
        return controlError("cancellation", context);
      return normalizeToriumError(error, context);
    },
    cleanup() {
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    },
  };
}

function controlError(
  category: "timeout" | "cancellation",
  context: Partial<ToriumErrorContext> = {}
): ToriumSdkError {
  return new ToriumSdkError({
    code: category === "timeout" ? "TORIUM_TIMEOUT" : "TORIUM_CANCELLED",
    category,
    message:
      category === "timeout"
        ? "The Torium action exceeded its timeout."
        : "The Torium action was cancelled.",
    operation: context.operation,
    kind: context.kind,
    clientKind: context.clientKind,
    method: context.method,
    chainId: context.chainId,
    requestId: context.requestId,
    retryable: category === "timeout",
    safeToRetry: false,
  });
}

function validateTimeout(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value < 1 || value > maximumTimeoutMs) {
    throw new TypeError(
      `Torium action timeout must be an integer from 1 through ${maximumTimeoutMs}.`
    );
  }
  return value;
}

interface ValidatedRetry {
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
  readonly maximumDelayMs: number;
  readonly jitterRatio: number;
}

function validateRetry(
  value: ToriumReadRetryOptions | undefined
): ValidatedRetry {
  const retry = {
    maxAttempts: value?.maxAttempts ?? 1,
    baseDelayMs: value?.baseDelayMs ?? 150,
    maximumDelayMs: value?.maximumDelayMs ?? 2_000,
    jitterRatio: value?.jitterRatio ?? 0.2,
  };
  if (
    !Number.isInteger(retry.maxAttempts) ||
    retry.maxAttempts < 1 ||
    retry.maxAttempts > maximumReadAttempts
  ) {
    throw new TypeError("Torium read retry attempts must be from 1 through 3.");
  }
  for (const [label, number] of [
    ["base delay", retry.baseDelayMs],
    ["maximum delay", retry.maximumDelayMs],
  ] as const) {
    if (
      !Number.isSafeInteger(number) ||
      number < 0 ||
      number > maximumBackoffMs
    ) {
      throw new TypeError(
        `Torium read retry ${label} must be from 0 through ${maximumBackoffMs}.`
      );
    }
  }
  if (retry.maximumDelayMs < retry.baseDelayMs) {
    throw new TypeError(
      "Torium read retry maximum delay is below its base delay."
    );
  }
  if (
    !Number.isFinite(retry.jitterRatio) ||
    retry.jitterRatio < 0 ||
    retry.jitterRatio > 1
  ) {
    throw new TypeError(
      "Torium read retry jitter ratio must be from 0 through 1."
    );
  }
  return retry;
}

function retryDelay(
  retry: ValidatedRetry,
  failure: number,
  retryAfterMs?: number
): number {
  const exponential = Math.min(
    retry.maximumDelayMs,
    retry.baseDelayMs * 2 ** Math.max(failure - 1, 0)
  );
  const jitter = exponential * retry.jitterRatio * (Math.random() * 2 - 1);
  return Math.min(
    maximumBackoffMs,
    Math.max(0, retryAfterMs ?? Math.round(exponential + jitter))
  );
}

async function raceAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal
): Promise<T> {
  if (signal.aborted) {
    void promise.catch(() => {});
    throw controlError("cancellation");
  }
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(controlError("cancellation"));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  const guarded = promise.catch((error: unknown) => {
    if (signal.aborted) return new Promise<never>(() => {});
    throw error;
  });
  try {
    return await Promise.race([guarded, aborted]);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

async function waitForRetry(
  delayMs: number,
  signal: AbortSignal
): Promise<void> {
  if (signal.aborted) throw controlError("cancellation");
  await new Promise<void>((resolve, reject) => {
    const finish = () => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    };
    const timer = setTimeout(finish, delayMs);
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(controlError("cancellation"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function event(
  context: Omit<ToriumErrorContext, "kind"> & {
    readonly kind?: ToriumOperationKind;
  },
  phase: ToriumDiagnosticEvent["phase"],
  attempt: number,
  startedAt: number,
  error?: ToriumSdkError
): ToriumDiagnosticEvent {
  const clientKind = context.clientKind ?? "public";
  return removeUndefined({
    schemaVersion: 1,
    sdkVersion: "0.1.0",
    policyVersion: "0.1.0",
    phase,
    clientKind,
    operation: context.operation,
    method: context.method,
    chainId: context.chainId,
    requestId: context.requestId,
    attempt,
    durationMs: Math.max(0, Date.now() - startedAt),
    code: error?.code,
    category: error?.category,
    retryable: error?.retryable,
    rpcCode: error?.rpcCode,
    httpStatus: error?.httpStatus,
    retryAfterMs: error?.retryAfterMs,
  }) as unknown as ToriumDiagnosticEvent;
}

function emit(
  options: ToriumActionOptions,
  diagnosticEvent: ToriumDiagnosticEvent
): void {
  try {
    const pending = options.diagnostics?.(diagnosticEvent);
    if (pending) void pending.catch(() => {});
  } catch {
    // Diagnostics are observational and must never change action behavior.
  }
}

function removeUndefined<T extends Record<string, unknown>>(
  value: T
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined)
  );
}
