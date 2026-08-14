// SPDX-License-Identifier: AGPL-3.0-or-later

import { createHash } from "node:crypto";
import type { TSchema } from "typebox";
import type { DurableArtifact } from "../core/artifacts/schema.js";
import type { VerificationCommand, VerificationRunner } from "../core/ports/verification.js";
import { runIdFromTaskId, type AgentRunReceipt, type AgentUsageReceipt } from "../core/ports/telemetry.js";

export type AgentRole = "investigator" | "packet-author" | "builder" | "reviewer" | "adjudicator" | "remediator";
export type ToolGrant = "read" | "grep" | "find" | "ls" | "compute" | "verify" | "bash" | "edit" | "write";

export type ScopeManifestSource = "issue-hints" | "build-packet" | "remediation";

export interface ScopeManifest {
  readRoots: readonly string[];
  writeRoots: readonly string[];
  /** Exact writable files for packet/remediation scopes; directory roots remain supported for legacy callers. */
  writePaths?: readonly string[];
  source: ScopeManifestSource;
}

export const SCOPE_MANIFEST_CONTRACT_VERSION = 1 as const;

export interface ScopeManifestReceipt {
  scopeVersion: typeof SCOPE_MANIFEST_CONTRACT_VERSION;
  scope: ScopeManifest;
  scopeDigest: string;
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

export const STANDARD_SCOPE_DISCOVERY_ROOTS = [
  "src",
  "bin",
  "packages",
  "scripts",
  "test",
  "tests",
  "migrations",
  "docs",
] as const;

export const STANDARD_SCOPE_METADATA_ROOTS = [
  "package.json",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "tsconfig.json",
  "forge.yaml",
  "FORGE.md",
] as const;

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
  const writePaths = canonicalizeConcreteScopePaths(
    [...(hints.writePaths ?? [])].map(stripLocation),
  );
  const readRoots = [...new Set([...paths, ...metadataRoots])];
  return {
    readRoots,
    writeRoots: [],
    ...(writePaths.length ? { writePaths } : {}),
    source,
  };
}

/** Derive one deterministic read/write authority from a frozen Build Packet. */
export function scopeManifestForBuildPacket(expectedPaths: readonly string[]): ScopeManifest {
  const writePaths = canonicalizeConcreteScopePaths(expectedPaths);
  return scopeManifestFor("build-packet", {
    affectedFiles: writePaths,
    metadataRoots: [...STANDARD_SCOPE_METADATA_ROOTS, ...scopeDiscoveryRoots(writePaths)],
    writePaths,
  });
}

/** Reviewers may inspect the complete frozen checkout but never receive write authority. */
export function scopeManifestForReviewer(): ScopeManifest {
  return { readRoots: ["."], writeRoots: [], source: "issue-hints" };
}

/** Canonical, versioned scope receipt used at process/nested-agent boundaries. */
export function createScopeManifestReceipt(scope: ScopeManifest): ScopeManifestReceipt {
  const canonical = canonicalizeScopeManifest(scope);
  return {
    scopeVersion: SCOPE_MANIFEST_CONTRACT_VERSION,
    scope: canonical,
    scopeDigest: digestScopeManifest(canonical),
  };
}

export function validateScopeManifestReceipt(value: {
  scopeVersion?: unknown;
  scope?: unknown;
  scopeDigest?: unknown;
}): ScopeManifestReceipt {
  if (value.scopeVersion !== SCOPE_MANIFEST_CONTRACT_VERSION) {
    throw new Error(`Unsupported scope manifest contract version: ${String(value.scopeVersion)}`);
  }
  if (typeof value.scopeDigest !== "string" || !/^[0-9a-f]{64}$/.test(value.scopeDigest)) {
    throw new Error("Scope manifest digest must be a lowercase SHA-256 digest");
  }
  const scope = canonicalizeScopeManifest(value.scope);
  const expected = digestScopeManifest(scope);
  if (value.scopeDigest !== expected) throw new Error("Scope manifest digest does not match its canonical scope");
  return { scopeVersion: SCOPE_MANIFEST_CONTRACT_VERSION, scope, scopeDigest: expected };
}

function canonicalizeScopeManifest(value: unknown): ScopeManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Scope manifest must be an object");
  const scope = value as Partial<ScopeManifest>;
  const unsupported = Object.keys(scope).find((key) => !["readRoots", "writeRoots", "writePaths", "source"].includes(key));
  if (unsupported) throw new Error(`Scope manifest field is not supported: ${unsupported}`);
  if (!(["issue-hints", "build-packet", "remediation"] as const).includes(scope.source as ScopeManifestSource)) {
    throw new Error(`Scope manifest source is invalid: ${String(scope.source)}`);
  }
  const readRoots = canonicalScopeRoots(scope.readRoots, "readRoots");
  const writeRoots = canonicalScopeRoots(scope.writeRoots, "writeRoots");
  if (!readRoots.length) throw new Error("Scope manifest must contain at least one read root");
  const writePaths = scope.writePaths === undefined
    ? []
    : canonicalizeConcreteScopePaths(assertStringArray(scope.writePaths, "writePaths"));
  return {
    readRoots,
    writeRoots,
    ...(writePaths.length ? { writePaths } : {}),
    source: scope.source as ScopeManifestSource,
  };
}

function canonicalScopeRoots(value: unknown, field: string): string[] {
  const roots = assertStringArray(value, field).map(normalizeScopePath);
  const invalid = roots.filter((root) => !root || !isSafeRelativeScopePath(root));
  if (invalid.length) throw new Error(`Scope manifest ${field} contains unsafe paths: ${invalid.join(", ")}`);
  return [...new Set(roots)].sort();
}

function assertStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error(`Scope manifest ${field} must be an array of strings`);
  }
  return value as string[];
}

function digestScopeManifest(scope: ScopeManifest): string {
  return createHash("sha256").update(JSON.stringify({
    version: SCOPE_MANIFEST_CONTRACT_VERSION,
    source: scope.source,
    readRoots: scope.readRoots,
    writeRoots: scope.writeRoots,
    writePaths: scope.writePaths ?? [],
  })).digest("hex");
}

/** Build Packet and remediation writes must name concrete repository-relative files. */
export function assertConcreteScopePaths(paths: readonly string[]): void {
  const invalid = paths.filter((path) => !isConcreteScopePath(path));
  if (invalid.length) {
    throw new Error(`Scope write paths must be concrete repository-relative files: ${invalid.join(", ")}`);
  }
}

/** Canonical representation shared by packet grants and Git diff comparisons. */
export function canonicalizeConcreteScopePaths(paths: readonly string[]): string[] {
  const normalized = paths.map(normalizeScopePath).filter(Boolean);
  assertConcreteScopePaths(normalized);
  return [...new Set(normalized)];
}

/** Top-level, non-root read boundaries used to discover cross-directory consumers. */
export function scopeDiscoveryRoots(paths: readonly string[]): string[] {
  const roots = paths
    .map((value) => scopeDirectory(stripLocation(value)))
    .filter((value) => Boolean(value) && value !== "." && isSafeRelativeScopePath(value))
    .map((value) => value.split("/")[0]!)
    .filter((value) => value !== ".");
  return [...new Set(roots)];
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
  planningProvider?: string;
  planningModel?: string;
  planningThinking?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  requireDifferentFrom?: { provider?: string; model?: string };
}

export interface AgentTask<_T> {
  id: string;
  role: AgentRole;
  /** Short live-fleet label; it is observational metadata, never workflow authority. */
  description?: string;
  objective: string;
  instructions: string;
  context: readonly DurableArtifact[];
  workspace: WorkspaceGrant;
  tools: readonly ToolGrant[];
  /** Optional live phase/cycle context projected into controller and fleet observability. */
  observability?: AgentObservability;
  /** Optional typed authority to run only controller-approved checks in this worktree. */
  verification?: {
    commands: readonly VerificationCommand[];
    runner: VerificationRunner;
  };
  outputSchema: TSchema;
  modelPolicy: ModelPolicy;
}

export interface AgentObservability {
  phase: string;
  cycle?: { current: number; total: number };
  activeChild?: string;
  reviewerRoles?: readonly string[];
  latestArtifacts?: { buildResult?: string; reviewVerdict?: string };
  remainingRemediationCycles?: number;
}

export type AgentEvent =
  | { type: "session.started"; taskId: string; sessionRef: string; provider: string; model: string; observability?: AgentObservability }
  | { type: "thinking.delta"; taskId: string; text: string; observability?: AgentObservability }
  | { type: "text.delta"; taskId: string; text: string; observability?: AgentObservability }
  | { type: "tool.started"; taskId: string; toolCallId: string; tool: string; args?: unknown; observability?: AgentObservability }
  | { type: "tool.completed"; taskId: string; toolCallId: string; tool: string; isError: boolean; errorSummary?: string; observability?: AgentObservability }
  | { type: "artifact.submitted"; taskId: string; observability?: AgentObservability }
  | { type: "session.completed"; taskId: string; sessionRef: string; observability?: AgentObservability }
  | { type: "session.failed"; taskId: string; sessionRef: string; errorSummary: string; observability?: AgentObservability }
  | { type: "session.cancelled"; taskId: string; sessionRef: string; errorSummary: string; observability?: AgentObservability };

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
  capabilities?: RuntimeCapabilities;
  diagnostics?: readonly string[];
}

export interface RuntimeBudgetLimits {
  /** Aggregate input + output token ceiling for this controller process. */
  maxTotalTokens?: number;
  /** Aggregate estimated USD ceiling for this controller process. */
  maxCostUsd?: number;
  /** Optional per-agent token ceiling, checked after every completed attempt. */
  maxTokensPerRun?: number;
}

export interface RuntimeBudgetUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  estimatedCostUsd: number;
  observedRuns: number;
  unknownUsageRuns: number;
}

export class AgentBudgetExceededError extends Error {
  constructor(readonly limit: keyof RuntimeBudgetLimits, readonly value: number, readonly maximum: number) {
    super(`Agent ${limit} budget exceeded: ${value} > ${maximum}`);
    this.name = "AgentBudgetExceededError";
  }
}

export class AgentBudgetUnknownError extends Error {
  constructor(readonly limit: keyof RuntimeBudgetLimits, readonly runId: string) {
    super(`Cannot evaluate ${limit} budget for agent run ${runId}; runtime did not report the required usage`);
    this.name = "AgentBudgetUnknownError";
  }
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
/** Enforces aggregate controller budgets without making telemetry authoritative state. */
export class BudgetedAgentRuntime implements AgentRuntime {
  readonly #usage: RuntimeBudgetUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0, estimatedCostUsd: 0, observedRuns: 0, unknownUsageRuns: 0 };

  constructor(readonly inner: AgentRuntime, readonly limits: RuntimeBudgetLimits) {}

  capabilities(): Promise<RuntimeCapabilities> { return this.inner.capabilities(); }
  preflight(options?: RuntimePreflightOptions): Promise<RuntimePreflightResult> {
    if (!this.inner.preflight) return Promise.reject(new Error("Agent runtime does not support preflight"));
    return this.inner.preflight(options);
  }
  usage(): RuntimeBudgetUsage { return { ...this.#usage }; }

  async run<T>(task: AgentTask<T>, options?: { signal?: AbortSignal; onEvent?: AgentEventSink }): Promise<AgentRunResult<T>> {
    this.assertAggregateBudget(task.id);
    const result = await this.inner.run(task, options);
    this.record(result, task.id);
    return result;
  }

  async resume<T>(sessionRef: string, task: AgentTask<T>, options?: { signal?: AbortSignal; onEvent?: AgentEventSink }): Promise<AgentRunResult<T>> {
    this.assertAggregateBudget(task.id);
    if (!this.inner.resume) throw new AgentRunError("Agent runtime cannot resume persisted sessions");
    const result = await this.inner.resume(sessionRef, task, options);
    this.record(result, task.id);
    return result;
  }

  close(): Promise<void> { return this.inner.close(); }

  private assertAggregateBudget(runId: string): void {
    if (this.limits.maxTotalTokens !== undefined && this.#usage.totalTokens >= this.limits.maxTotalTokens) {
      throw new AgentBudgetExceededError("maxTotalTokens", this.#usage.totalTokens, this.limits.maxTotalTokens);
    }
    if (this.limits.maxCostUsd !== undefined && this.#usage.estimatedCostUsd >= this.limits.maxCostUsd) {
      throw new AgentBudgetExceededError("maxCostUsd", this.#usage.estimatedCostUsd, this.limits.maxCostUsd);
    }
    void runId;
  }

  private record(result: AgentRunResult<unknown>, runId: string): void {
    const usage = result.receipt?.usage;
    this.#usage.observedRuns += 1;
    if (!usage) {
      this.#usage.unknownUsageRuns += 1;
      this.assertKnown("maxTotalTokens", runId, this.limits.maxTotalTokens !== undefined);
      this.assertKnown("maxCostUsd", runId, this.limits.maxCostUsd !== undefined);
      return;
    }
    const inputTokens = usage.inputTokens ?? 0;
    const outputTokens = usage.outputTokens ?? 0;
    const totalTokens = usage.totalTokens ?? (usage.inputTokens !== undefined || usage.outputTokens !== undefined ? inputTokens + outputTokens : undefined);
    const cost = usage.estimatedCostUsd;
    if (this.limits.maxTokensPerRun !== undefined && totalTokens === undefined) {
      throw new AgentBudgetUnknownError("maxTokensPerRun", runId);
    }
    if (this.limits.maxTotalTokens !== undefined && totalTokens === undefined) {
      throw new AgentBudgetUnknownError("maxTotalTokens", runId);
    }
    if (this.limits.maxCostUsd !== undefined && cost === undefined) {
      throw new AgentBudgetUnknownError("maxCostUsd", runId);
    }
    this.#usage.inputTokens += inputTokens;
    this.#usage.outputTokens += outputTokens;
    this.#usage.totalTokens += totalTokens ?? 0;
    this.#usage.estimatedCostUsd += cost ?? 0;
    if (this.limits.maxTokensPerRun !== undefined && totalTokens! > this.limits.maxTokensPerRun) {
      throw new AgentBudgetExceededError("maxTokensPerRun", totalTokens!, this.limits.maxTokensPerRun);
    }
    if (this.limits.maxTotalTokens !== undefined && this.#usage.totalTokens > this.limits.maxTotalTokens) {
      throw new AgentBudgetExceededError("maxTotalTokens", this.#usage.totalTokens, this.limits.maxTotalTokens);
    }
    if (this.limits.maxCostUsd !== undefined && this.#usage.estimatedCostUsd > this.limits.maxCostUsd) {
      throw new AgentBudgetExceededError("maxCostUsd", this.#usage.estimatedCostUsd, this.limits.maxCostUsd);
    }
  }

  private assertKnown(limit: keyof RuntimeBudgetLimits, runId: string, required: boolean): void {
    if (required) throw new AgentBudgetUnknownError(limit, runId);
  }
}

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
  const sessionRef = error instanceof AgentRunError && error.sessionRef
    ? error.sessionRef
    : resumedFrom ?? `failed_${crypto.randomUUID()}`;
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
