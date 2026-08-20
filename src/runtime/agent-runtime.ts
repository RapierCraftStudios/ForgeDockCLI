// SPDX-License-Identifier: AGPL-3.0-or-later

import { createHash } from "node:crypto";
import type { TSchema } from "typebox";
import type { DurableArtifact } from "../core/artifacts/schema.js";
import type { VerificationCommand, VerificationRunner } from "../core/ports/verification.js";
import { runIdFromTaskId, type AgentExecutionUsage, type AgentRunReceipt, type AgentUsageReceipt } from "../core/ports/telemetry.js";

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

/** Derive one deterministic read/write authority from a frozen Build Packet.
 * Evidence paths are additive read authority only; they never become writable paths. */
export function scopeManifestForBuildPacket(
  expectedPaths: readonly string[],
  evidencePaths: readonly string[] = [],
): ScopeManifest {
  const writePaths = canonicalizeConcreteScopePaths(expectedPaths);
  const readOnlyPaths = canonicalizeConcreteScopePaths(evidencePaths);
  return scopeManifestFor("build-packet", {
    affectedFiles: writePaths,
    metadataRoots: [
      ...STANDARD_SCOPE_METADATA_ROOTS,
      ...scopeDiscoveryRoots(writePaths),
      ...readOnlyPaths,
    ],
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
  /** Controller-owned ceilings for bounded provider-backed work. Each dimension is independently optional. */
  executionBudget?: {
    maxTurns?: number;
    maxToolCalls?: number;
  };
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
  | { readonly type: "session.started"; readonly logicalStreamId: string; readonly taskId: string; readonly sessionRef: string; readonly provider: string; readonly model: string; readonly observability?: AgentObservability }
  /** A semantic progress snapshot relayed from an owned nested session. */
  | { readonly type: "session.progress"; readonly logicalStreamId: string; readonly taskId: string; readonly sessionRef: string; readonly observability?: AgentObservability }
  | { readonly type: "thinking.delta"; readonly logicalStreamId: string; readonly taskId: string; readonly text: string; readonly observability?: AgentObservability }
  | { readonly type: "text.delta"; readonly logicalStreamId: string; readonly taskId: string; readonly text: string; readonly observability?: AgentObservability }
  | { readonly type: "tool.started"; readonly logicalStreamId: string; readonly taskId: string; readonly toolCallId: string; readonly tool: string; readonly args?: unknown; readonly observability?: AgentObservability }
  /** A bounded tool is still running; this is liveness evidence, not a new tool call. */
  | { readonly type: "tool.progress"; readonly logicalStreamId: string; readonly taskId: string; readonly toolCallId: string; readonly tool: string; readonly elapsedMs: number; readonly timeoutMs: number; readonly observability?: AgentObservability }
  | { readonly type: "tool.completed"; readonly logicalStreamId: string; readonly taskId: string; readonly toolCallId: string; readonly tool: string; readonly isError: boolean; readonly errorSummary?: string; readonly observability?: AgentObservability }
  | { readonly type: "artifact.submitted"; readonly logicalStreamId: string; readonly taskId: string; readonly observability?: AgentObservability }
  | { readonly type: "session.completed"; readonly logicalStreamId: string; readonly taskId: string; readonly sessionRef: string; readonly observability?: AgentObservability }
  | { readonly type: "session.failed"; readonly logicalStreamId: string; readonly taskId: string; readonly sessionRef: string; readonly errorSummary: string; readonly observability?: AgentObservability }
  | { readonly type: "session.cancelled"; readonly logicalStreamId: string; readonly taskId: string; readonly sessionRef: string; readonly errorSummary: string; readonly observability?: AgentObservability };

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
  readonly execution: AgentExecutionUsage | undefined;

  constructor(message: string, options: { sessionRef?: string; resumable?: boolean; cause?: unknown; execution?: AgentExecutionUsage } = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "AgentRunError";
    this.sessionRef = options.sessionRef;
    this.resumable = options.resumable === true && options.sessionRef !== undefined;
    this.execution = options.execution;
  }
}

/** Operational interruption, distinct from a provider/semantic failure. */
export class AgentExecutionInterruptedError extends AgentRunError {
  readonly interrupted = true as const;
  readonly reason: "semantic-idle" | "cancelled" | "process-tree";
  readonly idleMs: number | undefined;
  readonly lastProgressAt: number | undefined;
  readonly drainExpired: boolean;
  readonly drainMs: number | undefined;

  constructor(
    message: string,
    options: {
      reason: "semantic-idle" | "cancelled" | "process-tree";
      idleMs?: number;
      lastProgressAt?: number;
      drainExpired?: boolean;
      drainMs?: number;
      sessionRef?: string;
      resumable?: boolean;
      cause?: unknown;
      execution?: AgentExecutionUsage;
    },
  ) {
    super(message, {
      ...(options.sessionRef !== undefined ? { sessionRef: options.sessionRef } : {}),
      resumable: options.resumable === true,
      ...(options.cause !== undefined ? { cause: options.cause } : {}),
      ...(options.execution !== undefined ? { execution: options.execution } : {}),
    });
    this.name = "AgentExecutionInterruptedError";
    this.reason = options.reason;
    this.idleMs = options.idleMs;
    this.lastProgressAt = options.lastProgressAt;
    this.drainExpired = options.drainExpired === true;
    this.drainMs = options.drainMs;
  }
}

/** Alias for callers that describe the interruption as a liveness failure. */
export class AgentExecutionLivenessError extends AgentExecutionInterruptedError {
  constructor(message: string, options: ConstructorParameters<typeof AgentExecutionInterruptedError>[1]) {
    super(message, options);
    this.name = "AgentExecutionLivenessError";
  }
}

/** A bounded provider session stopped before producing its typed artifact. */
export class AgentExecutionBudgetExceededError extends AgentRunError {
  constructor(
    readonly limit: "maxTurns" | "maxToolCalls",
    readonly value: number,
    readonly maximum: number,
    options: { sessionRef: string; execution: AgentExecutionUsage; cause?: unknown },
  ) {
    super(`Agent execution ${limit} budget exhausted: ${value} >= ${maximum}`, {
      sessionRef: options.sessionRef,
      resumable: false,
      cause: options.cause,
      execution: options.execution,
    });
    this.name = "AgentExecutionBudgetExceededError";
  }
}

export function isRecoverableAgentExecutionError(error: unknown): boolean {
  return error instanceof AgentExecutionBudgetExceededError
    || error instanceof AgentExecutionInterruptedError;
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
  executionTurns: number;
  executionToolCalls: number;
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
  /** Interrupt one owned task without closing unrelated provider sessions. */
  interrupt?(taskId: string, reason?: unknown): void | Promise<void>;
  close(): Promise<void>;
}

export type AgentReceiptSink = (receipt: AgentRunReceipt) => void | Promise<void>;

/** Adds rebuildable telemetry without giving telemetry authority over workflow state. */
/** Enforces aggregate controller budgets without making telemetry authoritative state. */
export const DEFAULT_RUNTIME_BUDGET_LIMITS: RuntimeBudgetLimits = {};

export function configuredRuntimeBudgetLimits(environment: NodeJS.ProcessEnv = process.env): RuntimeBudgetLimits {
  const read = (name: string): number | undefined => {
    const raw = environment[name];
    if (raw === undefined || raw.trim() === "") return undefined;
    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive finite number`);
    return value;
  };
  const maxTotalTokens = read("FORGEDOCK_AGENT_MAX_TOTAL_TOKENS");
  const maxCostUsd = read("FORGEDOCK_AGENT_MAX_COST_USD");
  const maxTokensPerRun = read("FORGEDOCK_AGENT_MAX_TOKENS_PER_RUN");
  return {
    ...(maxTotalTokens !== undefined ? { maxTotalTokens } : {}),
    ...(maxCostUsd !== undefined ? { maxCostUsd } : {}),
    ...(maxTokensPerRun !== undefined ? { maxTokensPerRun } : {}),
  };
}

/**
 * Runtime construction seam shared by CLI and TUI. Keeping the budget wrapper
 * here prevents a new production caller from accidentally bypassing limits.
 */
export function budgetedAgentRuntime(inner: AgentRuntime, limits = configuredRuntimeBudgetLimits()): BudgetedAgentRuntime {
  return new BudgetedAgentRuntime(inner, limits);
}

export class BudgetedAgentRuntime implements AgentRuntime {
  readonly #usage: RuntimeBudgetUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0, estimatedCostUsd: 0, executionTurns: 0, executionToolCalls: 0, observedRuns: 0, unknownUsageRuns: 0 };

  constructor(readonly inner: AgentRuntime, readonly limits: RuntimeBudgetLimits) {}

  capabilities(): Promise<RuntimeCapabilities> { return this.inner.capabilities(); }
  preflight(options?: RuntimePreflightOptions): Promise<RuntimePreflightResult> {
    if (!this.inner.preflight) return Promise.reject(new Error("Agent runtime does not support preflight"));
    return this.inner.preflight(options);
  }
  usage(): RuntimeBudgetUsage { return { ...this.#usage }; }

  async run<T>(task: AgentTask<T>, options?: { signal?: AbortSignal; onEvent?: AgentEventSink }): Promise<AgentRunResult<T>> {
    this.assertAggregateBudget(task.id);
    let result: AgentRunResult<T>;
    try {
      result = await this.inner.run(task, options);
    } catch (error) {
      this.recordFailure(error, task.id);
      throw error;
    }
    this.record(result, task.id);
    return result;
  }

  async resume<T>(sessionRef: string, task: AgentTask<T>, options?: { signal?: AbortSignal; onEvent?: AgentEventSink }): Promise<AgentRunResult<T>> {
    this.assertAggregateBudget(task.id);
    let result: AgentRunResult<T>;
    try {
      if (!this.inner.resume) throw new AgentRunError("Agent runtime cannot resume persisted sessions");
      result = await this.inner.resume(sessionRef, task, options);
    } catch (error) {
      this.recordFailure(error, task.id);
      throw error;
    }
    this.record(result, task.id);
    return result;
  }

  interrupt(taskId: string, reason?: unknown): void | Promise<void> {
    return this.inner.interrupt?.(taskId, reason);
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
    this.chargeExecution(result.receipt?.execution);
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

  /** Failed attempts still consume provider execution and must count before the original error escapes. */
  private recordFailure(error: unknown, runId: string): void {
    this.#usage.observedRuns += 1;
    const execution = error instanceof AgentRunError ? error.execution : undefined;
    this.chargeExecution(execution);
    if (!execution) this.#usage.unknownUsageRuns += 1;
    const inputTokens = execution?.inputTokens ?? 0;
    const outputTokens = execution?.outputTokens ?? 0;
    const totalTokens = execution?.totalTokens ?? (execution?.inputTokens !== undefined || execution?.outputTokens !== undefined ? inputTokens + outputTokens : undefined);
    this.#usage.inputTokens += inputTokens;
    this.#usage.outputTokens += outputTokens;
    this.#usage.totalTokens += totalTokens ?? 0;
    this.#usage.estimatedCostUsd += execution?.estimatedCostUsd ?? 0;
    // A failed attempt must not replace the provider's typed error with a budget
    // diagnostic. The next run/resume is stopped by assertAggregateBudget.
    void runId;
  }

  private chargeExecution(execution: AgentExecutionUsage | undefined): void {
    if (!execution) return;
    this.#usage.executionTurns += execution.turns;
    this.#usage.executionToolCalls += execution.toolCalls;
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

  interrupt(taskId: string, reason?: unknown): void | Promise<void> {
    return this.inner.interrupt?.(taskId, reason);
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
    ...(error instanceof AgentRunError && error.execution !== undefined ? { execution: error.execution } : {}),
    error: { name: detail.name, message: detail.message.slice(0, 500) },
  };
}
