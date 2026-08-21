// SPDX-License-Identifier: AGPL-3.0-or-later

/** Typed transient failures that are safe to retry at an external-operation boundary. */
export type ExternalFaultKind =
  | "timeout"
  | "dns"
  | "connection-reset"
  | "connection-refused"
  | "tls"
  | "network"
  | "http";

export interface ExternalFaultClassification {
  kind: ExternalFaultKind;
  code?: string;
  status?: number;
  retryAfterMs?: number;
}

export class ExternalOperationError extends Error {
  readonly classification: ExternalFaultClassification;

  constructor(message: string, classification: ExternalFaultClassification, options: ErrorOptions = {}) {
    super(message, options);
    this.name = "ExternalOperationError";
    this.classification = classification;
  }
}

/** Raised after every permitted attempt has failed with a transient fault. */
export class ExternalOperationRetryError extends Error {
  readonly attempts: number;
  readonly failures: readonly unknown[];
  readonly classification: ExternalFaultClassification;

  constructor(
    message: string,
    options: {
      attempts: number;
      failures: readonly unknown[];
      classification: ExternalFaultClassification;
      cause: unknown;
    },
  ) {
    super(message, { cause: options.cause });
    this.name = "ExternalOperationRetryError";
    this.attempts = options.attempts;
    this.failures = options.failures;
    this.classification = options.classification;
  }
}

export type OperationalFailureKind = "external-transient-exhausted" | "external-operation" | "cancelled";

/** JSON-safe operational evidence used when no semantic RunState exists yet. */
export interface OperationalFailureRecord {
  schema: "forgedock.operational-failure/v1";
  kind: OperationalFailureKind;
  phase: string;
  message: string;
  rootCause: string;
  retryable: boolean;
  automaticRetry: boolean;
  attempts?: number;
  classification?: ExternalFaultClassification;
}

export class OperationalFailureError extends Error {
  readonly classification: OperationalFailureKind;
  readonly phase: string;
  readonly retryable: boolean;
  readonly automaticRetry: boolean;
  readonly attempts?: number;
  readonly externalFault?: ExternalFaultClassification;
  readonly rootCause: string;

  constructor(
    message: string,
    options: {
      classification: OperationalFailureKind;
      phase: string;
      rootCause: string;
      retryable: boolean;
      automaticRetry: boolean;
      attempts?: number;
      externalFault?: ExternalFaultClassification;
      cause: unknown;
    },
  ) {
    super(message, { cause: options.cause });
    this.name = "OperationalFailureError";
    this.classification = options.classification;
    this.phase = options.phase;
    this.retryable = options.retryable;
    this.automaticRetry = options.automaticRetry;
    this.rootCause = options.rootCause;
    if (options.attempts !== undefined) this.attempts = options.attempts;
    if (options.externalFault !== undefined) this.externalFault = options.externalFault;
  }

  toRecord(): OperationalFailureRecord {
    return {
      schema: "forgedock.operational-failure/v1",
      kind: this.classification,
      phase: this.phase,
      message: this.message,
      rootCause: this.rootCause,
      retryable: this.retryable,
      automaticRetry: this.automaticRetry,
      ...(this.attempts !== undefined ? { attempts: this.attempts } : {}),
      ...(this.externalFault !== undefined ? { classification: this.externalFault } : {}),
    };
  }
}

export function operationalFailureFrom(
  error: unknown,
  options: { phase: string; signal?: AbortSignal },
): OperationalFailureError {
  const rootCause = boundedCause(error);
  if (options.signal?.aborted) {
    return new OperationalFailureError(`Operational cancellation during ${options.phase}: ${rootCause}`, {
      classification: "cancelled",
      phase: options.phase,
      rootCause,
      retryable: false,
      automaticRetry: false,
      cause: error,
    });
  }
  if (error instanceof ExternalOperationRetryError) {
    return new OperationalFailureError(`Transient external operation exhausted during ${options.phase}: ${rootCause}`, {
      classification: "external-transient-exhausted",
      phase: options.phase,
      rootCause,
      retryable: true,
      automaticRetry: false,
      attempts: error.attempts,
      externalFault: error.classification,
      cause: error,
    });
  }
  const externalFault = classifyExternalFault(error);
  return new OperationalFailureError(`Operational failure during ${options.phase}: ${rootCause}`, {
    classification: "external-operation",
    phase: options.phase,
    rootCause,
    retryable: externalFault !== undefined,
    automaticRetry: false,
    ...(externalFault !== undefined ? { externalFault } : {}),
    cause: error,
  });
}

function boundedCause(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > 2_000 ? `${message.slice(0, 1_997)}...` : message;
}

export interface ExternalOperationRetryOptions {
  /** Total operation attempts, including the first attempt. Defaults to three. */
  maxAttempts?: number;
  /** Convenience alias; maxAttempts takes precedence when both are supplied. */
  maxRetries?: number;
  signal?: AbortSignal;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Fractional bounded jitter. Zero makes delays deterministic for tests. */
  jitterRatio?: number;
  random?: () => number;
  /** Shared remote host admission key; callers using the same key honor one backoff. */
  hostKey?: string;
  /** Clock used by the shared admission gate. */
  now?: () => number;
  /** Maximum shared gate delay, independent of per-call retry bounds. */
  maxGateDelayMs?: number;
  sleep?: (delayMs: number, signal?: AbortSignal) => Promise<void>;
}

/**
 * Run an idempotent external operation with bounded exponential backoff.
 * The callback receives the caller's signal so cancellation reaches the actual
 * transport. Non-transient errors and cancellation are returned untouched.
 */
const externalAdmissionUntil = new Map<string, number>();

export async function withExternalOperationRetry<T>(
  operation: (signal: AbortSignal | undefined, attempt: number) => Promise<T>,
  options: ExternalOperationRetryOptions = {},
): Promise<T> {
  const maxAttempts = normalizeAttempts(options);
  const baseDelayMs = Math.max(0, options.baseDelayMs ?? 250);
  const maxDelayMs = Math.max(baseDelayMs, options.maxDelayMs ?? 5_000);
  const jitterRatio = Math.min(1, Math.max(0, options.jitterRatio ?? 0.2));
  const random = options.random ?? Math.random;
  const sleep = options.sleep ?? defaultSleep;
  const failures: unknown[] = [];

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    await waitForAdmission(options);
    throwIfAborted(options.signal);
    try {
      return await operation(options.signal, attempt);
    } catch (error) {
      if (options.signal?.aborted) throw options.signal.reason ?? error;
      const classification = classifyExternalFault(error);
      if (!classification) throw error;
      failures.push(error);
      if (attempt >= maxAttempts) {
        throw new ExternalOperationRetryError(
          `External operation failed after ${attempt} attempt${attempt === 1 ? "" : "s"} (${classification.kind}): ${boundedErrorMessage(error)}`,
          { attempts: attempt, failures, classification, cause: error },
        );
      }
      const exponential = Math.min(maxDelayMs, baseDelayMs * (2 ** (attempt - 1)));
      const retryAfter = classification.retryAfterMs;
      const bounded = retryAfter === undefined ? exponential : Math.min(maxDelayMs, Math.max(exponential, retryAfter));
      if (options.hostKey !== undefined) setAdmission(options, retryAfter ?? bounded);
      const jitter = bounded * jitterRatio * ((random() * 2) - 1);
      await sleep(Math.max(0, Math.min(maxDelayMs, bounded + jitter)), options.signal);
    }
  }
  throw new Error("External operation retry loop terminated unexpectedly");
}

async function waitForAdmission(options: ExternalOperationRetryOptions): Promise<void> {
  const key = options.hostKey;
  if (key === undefined) return;
  const now = options.now ?? Date.now;
  const until = externalAdmissionUntil.get(key) ?? 0;
  const delay = until - now();
  if (delay > 0) await (options.sleep ?? defaultSleep)(delay, options.signal);
}

function setAdmission(options: ExternalOperationRetryOptions, delayMs: number): void {
  const key = options.hostKey;
  if (key === undefined) return;
  const now = options.now ?? Date.now;
  const bounded = Math.max(0, Math.min(options.maxGateDelayMs ?? 60_000, delayMs));
  const until = now() + bounded;
  externalAdmissionUntil.set(key, Math.max(externalAdmissionUntil.get(key) ?? 0, until));
}

/** Test/support hook; production callers normally use host keys with natural expiry. */
export function clearExternalOperationAdmission(key?: string): void {
  if (key === undefined) externalAdmissionUntil.clear();
  else externalAdmissionUntil.delete(key);
}

/** Classify only faults that are safe for an idempotent external operation. */
export function classifyExternalFault(error: unknown): ExternalFaultClassification | undefined {
  const seen = new Set<unknown>();
  let current: unknown = error;
  for (let depth = 0; depth < 8 && current !== undefined && current !== null && !seen.has(current); depth++) {
    seen.add(current);
    const classification = classifyOne(current);
    if (classification) return classification;
    current = isObject(current) ? current.cause : undefined;
  }
  return undefined;
}

/** Convert an unsuccessful fetch response into a typed, retryable HTTP fault. */
export function externalHttpError(response: {
  status: number;
  statusText?: string;
  headers?: Headers;
  body?: unknown;
}): Error {
  const body = typeof response.body === "string" ? response.body : "";
  const retryAfterMs = parseRetryAfter(response.headers?.get("retry-after"));
  const resetMs = parseRateLimitReset(response.headers?.get("x-ratelimit-reset"));
  const quota = response.status === 403 && isQuotaLimited(body, response.headers);
  const retryable = isRetryableHttpStatus(response.status) || quota;
  if (!retryable) return new Error(`External HTTP operation failed (${response.status}${response.statusText ? ` ${response.statusText}` : ""})`);
  const authoritativeRetry = retryAfterMs ?? resetMs;
  const classification: ExternalFaultClassification = {
    kind: "http",
    status: response.status,
    ...(authoritativeRetry !== undefined ? { retryAfterMs: authoritativeRetry } : {}),
  };
  return new ExternalOperationError(
    `External HTTP operation failed (${response.status}${response.statusText ? ` ${response.statusText}` : ""})`,
    classification,
  );
}

function classifyOne(error: unknown): ExternalFaultClassification | undefined {
  if (!isObject(error)) return undefined;
  const known = error.classification;
  if (isClassification(known)) return known;

  const status = numericProperty(error, "status") ?? numericProperty(error, "statusCode");
  if (status === 403 && isQuotaLimited(stringProperty(error, "body") ?? stringProperty(error, "message") ?? "", headersProperty(error))) {
    const retryAfterMs = numericProperty(error, "retryAfterMs")
      ?? parseRetryAfter(headersProperty(error)?.get("retry-after"))
      ?? parseRateLimitReset(headersProperty(error)?.get("x-ratelimit-reset"));
    return { kind: "http", status, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) };
  }
  if (status !== undefined && isRetryableHttpStatus(status)) {
    const retryAfterMs = numericProperty(error, "retryAfterMs")
      ?? parseRetryAfter(headersProperty(error)?.get("retry-after"));
    return { kind: "http", status, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) };
  }

  const codeValue = error.code;
  const code = typeof codeValue === "string" ? codeValue.toUpperCase() : undefined;
  if (code === "ETIMEDOUT" || code === "ESOCKETTIMEDOUT" || code === "UND_ERR_CONNECT_TIMEOUT") return { kind: "timeout", ...(code ? { code } : {}) };
  if (code === "EAI_AGAIN") return { kind: "dns", ...(code ? { code } : {}) };
  if (code === "ECONNRESET" || code === "UND_ERR_SOCKET") return { kind: "connection-reset", ...(code ? { code } : {}) };
  if (code === "ECONNREFUSED") return { kind: "connection-refused", ...(code ? { code } : {}) };
  if (code?.startsWith("ERR_TLS") || code?.startsWith("ERR_SSL") || code === "CERT_HAS_EXPIRED" || code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE" || code === "DEPTH_ZERO_SELF_SIGNED_CERT") return { kind: "tls", ...(code ? { code } : {}) };
  if (code === "ENETUNREACH" || code === "EHOSTUNREACH" || code === "ECONNABORTED" || code === "EPIPE" || code?.startsWith("UND_ERR_")) return { kind: "network", ...(code ? { code } : {}) };

  const message = typeof error.message === "string" ? error.message : "";
  if (/\b403\b/.test(message) && isQuotaLimited(message, headersProperty(error))) {
    const retryAfterMs = parseRetryAfter(headersProperty(error)?.get("retry-after"))
      ?? parseRetryAfterFromMessage(message)
      ?? parseRateLimitReset(headersProperty(error)?.get("x-ratelimit-reset"));
    return { kind: "http", status: 403, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) };
  }
  if (/\b(408|425|429|5\d\d)\b/.test(message) && /\b(?:HTTP|status|response|request|server|npm)\b/i.test(message)) {
    const matched = /\b(408|425|429|5\d\d)\b/.exec(message);
    const httpStatus = matched?.[1] ? Number(matched[1]) : undefined;
    if (httpStatus !== undefined) {
      const retryAfterMs = parseRetryAfterFromMessage(message);
      return { kind: "http", status: httpStatus, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) };
    }
  }
  if (/\b(?:ETIMEDOUT|ESOCKETTIMEDOUT|timeout|timed out)\b/i.test(message)) return { kind: "timeout" };
  if (/\bEAI_AGAIN\b|temporary failure in name resolution|dns lookup/i.test(message)) return { kind: "dns" };
  if (/\bECONNRESET\b|socket hang up|connection reset/i.test(message)) return { kind: "connection-reset" };
  if (/\bECONNREFUSED\b|connection refused/i.test(message)) return { kind: "connection-refused" };
  if (/\b(?:TLS|SSL|CERT_HAS_EXPIRED|certificate)\b/i.test(message)) return { kind: "tls" };
  if (/error connecting to api\.github\.com[\s\S]*check your internet connection/i.test(message)) return { kind: "network" };
  if (/\b(?:fetch failed|network error|network is unreachable|socket|connectivity)\b/i.test(message)) return { kind: "network" };
  return undefined;
}

function boundedErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > 2_000 ? `${message.slice(0, 1_997)}...` : message;
}

function isRetryableHttpStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || (status >= 500 && status <= 599);
}

function isQuotaLimited(body: string, headers?: Headers): boolean {
  const remaining = headers?.get("x-ratelimit-remaining");
  const headerSignal = headers !== undefined && (
    remaining === "0" || headers.get("x-ratelimit-reset") !== null || headers.get("retry-after") !== null
  );
  return headerSignal || /secondary rate limit|rate limit exceeded|api rate limit|abuse detection|too many requests|temporarily blocked/i.test(body);
}

function parseRateLimitReset(value: string | null | undefined): number | undefined {
  if (!value) return undefined;
  const epoch = Number(value.trim());
  if (!Number.isFinite(epoch)) return undefined;
  return Math.max(0, epoch * 1_000 - Date.now());
}
function parseRetryAfterFromMessage(message: string): number | undefined {
  const match = /retry[- ]after[=: ]+(\d+)/i.exec(message);
  return match?.[1] === undefined ? undefined : Number(match[1]) * 1_000;
}

function parseRetryAfter(value: string | null | undefined): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value.trim());
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
  const date = Date.parse(value);
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  return undefined;
}

function normalizeAttempts(options: ExternalOperationRetryOptions): number {
  const candidate = options.maxAttempts ?? (options.maxRetries === undefined ? 3 : options.maxRetries + 1);
  if (!Number.isInteger(candidate) || candidate < 1) throw new RangeError("External-operation max attempts must be a positive integer");
  return candidate;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw signal.reason ?? new Error("External operation was aborted");
}

async function defaultSleep(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (delayMs <= 0) {
    throwIfAborted(signal);
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      if (signal) signal.removeEventListener("abort", abort);
      resolve();
    }, delayMs);
    const abort = () => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", abort);
      reject(signal?.reason ?? new Error("External operation was aborted"));
    };
    if (signal) {
      if (signal.aborted) return abort();
      signal.addEventListener("abort", abort, { once: true });
    }
  });
}

type ObjectLike = Record<string, unknown> & { cause?: unknown; classification?: unknown; code?: unknown; kind?: unknown; message?: unknown; status?: unknown; statusCode?: unknown; retryAfterMs?: unknown; body?: unknown; headers?: unknown };
function isObject(value: unknown): value is ObjectLike { return typeof value === "object" && value !== null; }
function stringProperty(value: ObjectLike, key: "body" | "message"): string | undefined {
  const candidate = value[key];
  return typeof candidate === "string" ? candidate : undefined;
}
function headersProperty(value: ObjectLike): Headers | undefined {
  return value.headers instanceof Headers ? value.headers : undefined;
}
function numericProperty(value: ObjectLike, key: "status" | "statusCode" | "retryAfterMs"): number | undefined {
  const candidate = value[key];
  return typeof candidate === "number" && Number.isFinite(candidate) ? candidate : undefined;
}
function isClassification(value: unknown): value is ExternalFaultClassification {
  if (!isObject(value) || typeof value.kind !== "string") return false;
  return ["timeout", "dns", "connection-reset", "connection-refused", "tls", "network", "http"].includes(value.kind);
}
