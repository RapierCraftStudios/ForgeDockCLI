// SPDX-License-Identifier: AGPL-3.0-or-later

import { createHash } from "node:crypto";

export type RetryDomain = "github" | "provider" | "workflow" | "lease" | "transport";
export type RetryDisposition = "retryable" | "permanent";

export interface RetryClassification {
  disposition: RetryDisposition;
  retryable: boolean;
  domain: RetryDomain;
  code: string;
  status?: number;
  retryAfterMs?: number;
  resetAt?: number;
  rateLimitReason?: "primary" | "secondary";
  operationKey?: string;
  /** A resumable provider session must be continued, never started again. */
  sessionRef?: string;
  resumableSession?: boolean;
  cause: Error;
}

export interface RetryClassifierOptions {
  domain?: RetryDomain;
  /** Treat a 401 as retryable when the caller can refresh credentials. */
  authenticationRefreshAvailable?: boolean;
  /** Provider/session lineage supplied by a transport adapter. */
  sessionRef?: string;
  resumableSession?: boolean;
}

const RETRYABLE_STATUS = new Set([408, 425, 429]);
const RETRYABLE_CODES = new Set([
  "EAI_AGAIN", "ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "ENETUNREACH", "EHOSTUNREACH",
  "EPIPE", "ECONNABORTED", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_SOCKET", "SOCKET_HANG_UP",
]);
const PERMANENT_WORDS = /validation|invalid\s+(?:argument|input|request)|permission|forbidden|not found|identity|semantic|malformed|unauthorized|authentication failed|bad request/i;
const NETWORK_WORDS = /dns|tls|certificate|socket|network|timeout|temporarily unavailable|connection reset|connection refused|no server|internet connection|eai_again|etimedout|econnreset|econnrefused/i;

/** Classify errors at the controller boundary, without relying on provider classes. */
/**
 * Find retry authority through wrapper errors. Workflow boundaries frequently
 * add context (and `-exhausted` codes) around the transport error; typed
 * external classifications remain authoritative regardless of those wrappers.
 */
export function retryableExternalDisposition(error: unknown): RetryClassification | undefined {
  const seen = new Set<unknown>();
  let current: unknown = error;
  for (let depth = 0; depth < 16 && current !== undefined && current !== null && !seen.has(current); depth++) {
    seen.add(current);
    const candidate = current as Record<string, unknown> | null;
    const disposition = candidate?.retryDisposition;
    if (isRetryClassification(disposition) && disposition.retryable) {
      const normalized = normalizeExternalDisposition(disposition);
      if (normalized.code === "github-primary-rate-limit" || normalized.code === "github-secondary-rate-limit") return normalized;
    }
    const classification = candidate?.classification;
    if (isExternalRateClassification(classification)) {
      const kind = classification.kind;
      const cause = current instanceof Error ? current : new Error(String(current));
      return {
        disposition: "retryable",
        retryable: true,
        domain: "github",
        code: kind,
        ...(classification.status !== undefined ? { status: classification.status } : {}),
        ...(classification.retryAfterMs !== undefined ? { retryAfterMs: classification.retryAfterMs } : {}),
        ...(classification.resetAt !== undefined ? { resetAt: classification.resetAt } : {}),
        rateLimitReason: kind === "github-secondary-rate-limit" ? "secondary" : "primary",
        cause,
      };
    }
    if (candidate?.cause !== undefined) current = candidate.cause;
    else break;
  }
  return undefined;
}

function normalizeExternalDisposition(disposition: RetryClassification): RetryClassification {
  const rateKind = disposition.code === "github-primary-rate-limit" || disposition.code === "github-secondary-rate-limit"
    ? disposition.code
    : undefined;
  if (rateKind === undefined) return disposition;
  return {
    ...disposition,
    domain: "github",
    code: rateKind,
    rateLimitReason: rateKind === "github-secondary-rate-limit" ? "secondary" : "primary",
  };
}

function isRetryClassification(value: unknown): value is RetryClassification {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (candidate.disposition === "retryable" || candidate.disposition === "permanent")
    && typeof candidate.retryable === "boolean"
    && typeof candidate.domain === "string"
    && typeof candidate.code === "string"
    && candidate.cause instanceof Error;
}

function isExternalRateClassification(value: unknown): value is {
  kind: "github-primary-rate-limit" | "github-secondary-rate-limit";
  status?: number;
  retryAfterMs?: number;
  resetAt?: number;
} {
  if (!value || typeof value !== "object") return false;
  const kind = (value as Record<string, unknown>).kind;
  return kind === "github-primary-rate-limit" || kind === "github-secondary-rate-limit";
}

export function classifyRetryableError(error: unknown, options: RetryClassifierOptions = {}): RetryClassification {
  const cause = asError(error);
  const candidate = error as Record<string, unknown> | null;
  const externalClassification = candidate?.classification;
  const externalKind = externalClassification && typeof externalClassification === "object"
    ? stringValue((externalClassification as Record<string, unknown>).kind)
    : undefined;
  const externalRetryable = externalKind !== undefined && typeof candidate?.attempts === "number";
  const isGitHubRateLimit = externalKind === "github-primary-rate-limit" || externalKind === "github-secondary-rate-limit";
  const status = numeric(candidate?.status) ?? numeric(candidate?.statusCode) ?? numeric((externalClassification as Record<string, unknown> | undefined)?.status) ?? parseStatus(cause.message);
  const retryAfterMs = parseRetryAfter(candidate, cause.message)
    ?? numeric((externalClassification as Record<string, unknown> | undefined)?.retryAfterMs);
  const sessionRef = options.sessionRef ?? stringValue(candidate?.sessionRef) ?? stringValue(candidate?.sessionId);
  const resumableSession = options.resumableSession === true
    || candidate?.resumable === true
    || (sessionRef !== undefined && candidate?.resumable !== false);
  const domain = options.domain ?? (isGitHubRateLimit ? "github" : externalRetryable ? "transport" : inferDomain(cause.message, candidate));
  const code = stringValue(candidate?.code)?.toLowerCase() ?? (isGitHubRateLimit ? externalKind : externalRetryable ? `${externalKind}-exhausted` : codeFor(status, cause.message, resumableSession));

  let retryable = false;
  if (externalRetryable) retryable = true;
  if (status !== undefined && (RETRYABLE_STATUS.has(status) || status >= 500)) retryable = true;
  if (status === 401 && options.authenticationRefreshAvailable) retryable = true;
  if (RETRYABLE_CODES.has(String(candidate?.code ?? "").toUpperCase()) || NETWORK_WORDS.test(cause.message)) retryable = true;
  // A provider may lose the response after committing work. Session lineage is
  // the authority for resume; this is intentionally true even without a status.
  if (resumableSession && sessionRef !== undefined) retryable = true;
  if (PERMANENT_WORDS.test(cause.message) && !externalRetryable
    && !(status !== undefined && (status >= 500 || RETRYABLE_STATUS.has(status)))) {
    retryable = status === 401 && options.authenticationRefreshAvailable === true;
  }

  return {
    disposition: retryable ? "retryable" : "permanent",
    retryable,
    domain,
    code,
    ...(status !== undefined ? { status } : {}),
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    ...((typeof (externalClassification as Record<string, unknown> | undefined)?.resetAt === "number") ? { resetAt: (externalClassification as Record<string, unknown>).resetAt as number } : {}),
    ...((externalClassification as Record<string, unknown> | undefined)?.reason !== undefined ? { rateLimitReason: stringValue((externalClassification as Record<string, unknown>).reason) as "primary" | "secondary" } : {}),
    ...(sessionRef !== undefined ? { sessionRef } : {}),
    ...(resumableSession ? { resumableSession: true } : {}),
    cause,
  };
}

export interface RetryBackoffOptions {
  baseMs?: number;
  maxMs?: number;
  jitterRatio?: number;
  retryAfterMs?: number;
  /** Security ceiling for untrusted server cooldowns; defaults to fifteen minutes. */
  maxRetryAfterMs?: number;
  operationKey?: string;
}

/** Exponential backoff with bounded, deterministic jitter for stable tests/restarts. */
export function retryBackoffMs(attempt: number, options: RetryBackoffOptions = {}): number {
  if (!Number.isSafeInteger(attempt) || attempt < 1) throw new Error("retry attempt must be a positive integer");
  const base = options.baseMs ?? 250;
  const maximum = options.maxMs ?? 60_000;
  const ratio = options.jitterRatio ?? 0.2;
  const serverCeiling = options.maxRetryAfterMs ?? 15 * 60_000;
  if (![base, maximum, ratio, serverCeiling].every(Number.isFinite)
    || base < 0 || maximum < base || ratio < 0 || ratio > 1 || serverCeiling < 0) {
    throw new Error("invalid retry backoff options");
  }
  const retryAfter = options.retryAfterMs === undefined ? 0 : Math.max(0, options.retryAfterMs);
  const serverDelay = Math.min(serverCeiling, retryAfter);
  const exponential = Math.min(maximum, base * 2 ** Math.min(attempt - 1, 30));
  const floor = Math.max(exponential, serverDelay);
  const upperBound = Math.max(maximum, serverDelay);
  const seed = options.operationKey === undefined ? 0.5 : deterministicUnit(`${options.operationKey}\n${attempt}`);
  const jitter = 1 - ratio + seed * 2 * ratio;
  return Math.min(upperBound, Math.max(serverDelay, Math.round(floor * jitter)));
}

/** Stable key for an external mutation; use it in checkpoints and reconciliation. */
export function deterministicOperationKey(operation: string, input: unknown): string {
  const canonical = canonicalJson(input);
  return `${operation.trim()}:${createHash("sha256").update(canonical).digest("hex")}`;
}

function asError(value: unknown): Error {
  if (value instanceof Error) return value;
  return new Error(typeof value === "string" ? value : JSON.stringify(value));
}
function numeric(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : typeof value === "string" && /^\d{3}$/.test(value) ? Number(value) : undefined;
}
function stringValue(value: unknown): string | undefined { return typeof value === "string" && value.trim() ? value.trim() : undefined; }
function parseStatus(message: string): number | undefined {
  const match = message.match(/(?:HTTP|status(?:\s*code)?)\s*[:=]?\s*(\d{3})\b/i);
  return match ? Number(match[1]) : undefined;
}
function parseRetryAfter(candidate: Record<string, unknown> | null, message: string): number | undefined {
  const explicitMs = candidate?.retryAfterMs;
  if (typeof explicitMs === "number" && Number.isFinite(explicitMs)) return Math.max(0, Math.round(explicitMs));
  const value = candidate?.retryAfter
    ?? (candidate?.headers && typeof candidate.headers === "object"
      ? (candidate.headers as Record<string, unknown>)["retry-after"]
      : undefined);
  if (typeof value === "number" && Number.isFinite(value)) return Math.max(0, Math.round(value * 1000));
  if (typeof value === "string") {
    const seconds = Number(value);
    if (Number.isFinite(seconds)) return Math.max(0, Math.round(seconds * 1000));
    const date = Date.parse(value);
    if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  }
  const match = message.match(/retry[- ]after\s*[:=]?\s*(\d+(?:\.\d+)?)\s*(ms|s|seconds?)?/i);
  return match ? Math.max(0, Math.round(Number(match[1]) * (match[2]?.toLowerCase() === "ms" ? 1 : 1000))) : undefined;
}
function inferDomain(message: string, candidate: Record<string, unknown> | null): RetryDomain {
  const explicit = stringValue(candidate?.domain);
  if (explicit === "github" || explicit === "provider" || explicit === "workflow" || explicit === "lease" || explicit === "transport") return explicit;
  if (/github|gh\s|pull request|github api/i.test(message)) return "github";
  if (/lease|fence|claim/i.test(message)) return "lease";
  if (/agent|provider|session|model/i.test(message)) return "provider";
  if (NETWORK_WORDS.test(message)) return "transport";
  return "workflow";
}
function codeFor(status: number | undefined, message: string, resumable: boolean): string {
  if (resumable) return "resumable-session";
  if (status !== undefined) return `http-${status}`;
  if (/dns|eai_again/i.test(message)) return "dns";
  if (/tls|certificate/i.test(message)) return "tls";
  if (/socket|econn|etimedout|timeout/i.test(message)) return "transport";
  return "workflow-transient";
}
function deterministicUnit(value: string): number {
  return createHash("sha256").update(value).digest()[0]! / 255;
}
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
}
