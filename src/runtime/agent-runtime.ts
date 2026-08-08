// SPDX-License-Identifier: AGPL-3.0-or-later

import type { TSchema } from "typebox";
import type { DurableArtifact } from "../core/artifacts/schema.js";
import { runIdFromTaskId, type AgentRunReceipt, type AgentUsageReceipt } from "../core/ports/telemetry.js";

export type AgentRole = "investigator" | "packet-author" | "builder" | "reviewer" | "adjudicator" | "remediator";
export type ToolGrant = "read" | "grep" | "find" | "ls" | "compute" | "bash" | "edit" | "write";

export type ScopeManifestSource = "issue-hints" | "build-packet" | "remediation";

export interface ScopeManifest {
  readRoots: readonly string[];
  writeRoots: readonly string[];
  /** Exact writable files for packet/remediation scopes; directory roots remain supported for legacy callers. */
  writePaths?: readonly string[];
  source: ScopeManifestSource;
}

export interface ScopeHints {
  affectedFiles?: readonly string[];
  claims?: readonly string[];
  metadataRoots?: readonly string[];
  writePaths?: readonly string[];
}

export interface WorkspaceGrant {
  cwd: string;
  mode: "read-only" | "write";
  scope: ScopeManifest;
}

const GLOB_PATTERN = /[*?[{]/;

/** Build a bounded manifest from issue/packet evidence; never grants an unbounded root by default. */
export function scopeManifestFor(source: ScopeManifestSource, hints: ScopeHints = {}): ScopeManifest {
  const pathClaims = (hints.claims ?? []).filter((claim) => {
    const normalized = normalizeScopePath(claim);
    // Claims also carry semantic scheduler labels such as component:api or
    // finding:review-1; only path-shaped claims can become filesystem roots.
    return normalized !== "." && (normalized.includes("/") || (!normalized.includes(":") && normalized.includes(".")));
  });
  const paths = [...(hints.affectedFiles ?? []), ...pathClaims]
    .map((value) => scopeDirectory(stripLocation(value)))
    .filter((value): value is string => Boolean(value) && isSafeRelativeScopePath(value));
  const metadataRoots = [...(hints.metadataRoots ?? [])]
    .map(normalizeScopePath)
    .filter((value): value is string => Boolean(value) && isSafeRelativeScopePath(value));
  const writePaths = [...(hints.writePaths ?? [])]
    .map((value) => normalizeScopePath(stripLocation(value)))
    .filter(Boolean);
  assertConcreteScopePaths(writePaths);
  const readRoots = [...new Set([...paths, ...metadataRoots])];
  return {
    readRoots,
    writeRoots: [],
    ...(writePaths.length ? { writePaths: [...new Set(writePaths)] } : {}),
    source,
  };
}

/** Build Packet and remediation writes must name concrete repository-relative files. */
export function assertConcreteScopePaths(paths: readonly string[]): void {
  const invalid = paths.filter((path) => !isConcreteScopePath(path));
  if (invalid.length) {
    throw new Error(`Scope write paths must be concrete repository-relative files: ${invalid.join(", ")}`);
  }
}

export function isConcreteScopePath(value: string): boolean {
  const normalized = normalizeScopePath(value);
  return Boolean(normalized) && normalized !== "." && isSafeRelativeScopePath(normalized) && !GLOB_PATTERN.test(normalized);
}

function normalizeScopePath(value: string): string {
  return value.replaceAll("\\", "/").replace(/^(?:\.\/)+/, "").replace(/\/$/, "").trim();
}

function stripLocation(value: string): string {
  return value.replace(/:\d+(?::\d+)?$/, "");
}

function isSafeRelativeScopePath(value: string): boolean {
  if (!value || value === ".") return value === ".";
  if (value.startsWith("/") || /^[A-Za-z]:\//.test(value) || value.includes(":")) return false;
  const segments = value.split("/");
  return segments.every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

function scopeDirectory(value: string): string {
  const normalized = normalizeScopePath(value);
  if (!normalized || normalized === "." || !isSafeRelativeScopePath(normalized)) return "";
  const globIndex = normalized.search(GLOB_PATTERN);
  if (globIndex >= 0) return normalized.slice(0, globIndex).replace(/\/$/, "");
  // Paths with a filename extension are treated as file claims; nested files
  // expose only their containing directory while packet writes remain exact.
  const final = normalized.split("/").at(-1) ?? normalized;
  return final.includes(".") ? normalized.slice(0, Math.max(0, normalized.lastIndexOf("/"))) || normalized : normalized;
}

export interface ModelPolicy {
  provider?: string;
  model?: string;
  thinking?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  requireDifferentFrom?: { provider?: string; model?: string };
}

export interface AgentTask<_T> {
  id: string;
  role: AgentRole;
  objective: string;
  instructions: string;
  context: readonly DurableArtifact[];
  workspace: WorkspaceGrant;
  tools: readonly ToolGrant[];
  outputSchema: TSchema;
  modelPolicy: ModelPolicy;
}

export type AgentEvent =
  | { type: "session.started"; taskId: string; sessionRef: string; provider: string; model: string }
  | { type: "thinking.delta"; taskId: string; text: string }
  | { type: "text.delta"; taskId: string; text: string }
  | { type: "tool.started"; taskId: string; tool: string; args?: unknown }
  | { type: "tool.completed"; taskId: string; tool: string; isError: boolean }
  | { type: "artifact.submitted"; taskId: string }
  | { type: "session.completed"; taskId: string; sessionRef: string };

export interface AgentRunResult<T> {
  output: T;
  sessionRef: string;
  /** Ordered persisted-session ancestry when a failed session was resumed. */
  sessionLineage?: readonly string[];
  provider: string;
  model: string;
  receipt?: AgentRunReceipt;
}

/** Operational failure metadata used only to recover the same persisted agent session. */
export class AgentRunError extends Error {
  readonly sessionRef: string | undefined;
  readonly resumable: boolean;

  constructor(message: string, options: { sessionRef?: string; resumable?: boolean; cause?: unknown } = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "AgentRunError";
    this.sessionRef = options.sessionRef;
    this.resumable = options.resumable === true && options.sessionRef !== undefined;
  }
}

export type AgentEventSink = (event: AgentEvent) => void;

export interface RuntimeCapabilities {
  runtime: string;
  resumableSessions: boolean;
  tools: readonly ToolGrant[];
}

export interface RuntimePreflightOptions {
  provider?: string;
  model?: string;
  role?: AgentRole;
}

export interface RuntimePreflightResult {
  provider: string;
  model: string;
}

export interface AgentRuntime {
  capabilities(): Promise<RuntimeCapabilities>;
  preflight?(options?: RuntimePreflightOptions): Promise<RuntimePreflightResult>;
  run<T>(task: AgentTask<T>, options?: { signal?: AbortSignal; onEvent?: AgentEventSink }): Promise<AgentRunResult<T>>;
  /** Resume one explicitly identified persisted session; runtimes without this seam report resumableSessions=false. */
  resume?<T>(sessionRef: string, task: AgentTask<T>, options?: { signal?: AbortSignal; onEvent?: AgentEventSink }): Promise<AgentRunResult<T>>;
  close(): Promise<void>;
}

export type AgentReceiptSink = (receipt: AgentRunReceipt) => void | Promise<void>;

/** Adds rebuildable telemetry without giving telemetry authority over workflow state. */
export class TelemetryAgentRuntime implements AgentRuntime {
  constructor(readonly inner: AgentRuntime, readonly sink: AgentReceiptSink) {}

  capabilities(): Promise<RuntimeCapabilities> { return this.inner.capabilities(); }
  preflight(options?: RuntimePreflightOptions): Promise<RuntimePreflightResult> {
    if (!this.inner.preflight) return Promise.reject(new Error("Agent runtime does not support preflight"));
    return this.inner.preflight(options);
  }

  async run<T>(task: AgentTask<T>, options?: { signal?: AbortSignal; onEvent?: AgentEventSink }): Promise<AgentRunResult<T>> {
    const startedAt = Date.now();
    try {
      const result = await this.inner.run(task, options);
      await this.record(result.receipt ?? successReceipt(task, result, startedAt));
      return result;
    } catch (error) {
      await this.record(failureReceipt(task, startedAt, error));
      throw error;
    }
  }

  async resume<T>(sessionRef: string, task: AgentTask<T>, options?: { signal?: AbortSignal; onEvent?: AgentEventSink }): Promise<AgentRunResult<T>> {
    const startedAt = Date.now();
    try {
      if (!this.inner.resume) throw new AgentRunError("Agent runtime cannot resume persisted sessions");
      const result = await this.inner.resume(sessionRef, task, options);
      await this.record(result.receipt ?? successReceipt(task, result, startedAt, sessionRef));
      return result;
    } catch (error) {
      await this.record(failureReceipt(task, startedAt, error, sessionRef));
      throw error;
    }
  }

  close(): Promise<void> { return this.inner.close(); }

  private async record(receipt: AgentRunReceipt | undefined): Promise<void> {
    if (!receipt) return;
    try {
      await this.sink(receipt);
    } catch {
      // Telemetry is operational projection data and must not change workflow authority.
    }
  }
}

function successReceipt<T>(task: AgentTask<T>, result: AgentRunResult<T>, startedAt: number, resumedFrom?: string): AgentRunReceipt {
  const completedAt = Date.now();
  return {
    key: `${task.id}:${result.sessionRef}`,
    runId: runIdFromTaskId(task.id),
    taskId: task.id,
    phase: task.id.split(":")[1] ?? task.role,
    role: task.role,
    sessionRef: result.sessionRef,
    sessionLineage: result.sessionLineage ?? [...new Set([...(resumedFrom ? [resumedFrom] : []), result.sessionRef])],
    provider: result.provider,
    model: result.model,
    timing: {
      queuedAt: new Date(startedAt).toISOString(),
      startedAt: new Date(startedAt).toISOString(),
      completedAt: new Date(completedAt).toISOString(),
      activeMs: Math.max(0, completedAt - startedAt),
      queueMs: 0,
      retryCount: 0,
      ...(resumedFrom !== undefined ? { resumedFrom } : {}),
    },
    usage: { source: "unavailable" },
  };
}

function failureReceipt<T>(task: AgentTask<T>, startedAt: number, error: unknown, resumedFrom?: string): AgentRunReceipt {
  const completedAt = Date.now();
  const sessionRef = `failed_${crypto.randomUUID()}`;
  const detail = error instanceof Error ? error : new Error(String(error));
  return {
    key: `${task.id}:${sessionRef}`,
    runId: runIdFromTaskId(task.id),
    taskId: task.id,
    phase: task.id.split(":")[1] ?? task.role,
    role: task.role,
    sessionRef,
    sessionLineage: [...new Set([...(resumedFrom ? [resumedFrom] : []), sessionRef])],
    provider: task.modelPolicy.provider ?? "unknown",
    model: task.modelPolicy.model ?? "unknown",
    timing: {
      queuedAt: new Date(startedAt).toISOString(),
      startedAt: new Date(startedAt).toISOString(),
      completedAt: new Date(completedAt).toISOString(),
      activeMs: Math.max(0, completedAt - startedAt),
      queueMs: 0,
      retryCount: 0,
      ...(resumedFrom !== undefined ? { resumedFrom } : {}),
    },
    usage: { source: "unavailable" } satisfies AgentUsageReceipt,
    error: { name: detail.name, message: detail.message.slice(0, 500) },
  };
}
