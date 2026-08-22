// SPDX-License-Identifier: AGPL-3.0-or-later

import type { DurableArtifact } from "../artifacts/schema.js";
import type { RunState, TransitionRecord } from "../state/machine.js";
import type { RunProgressRecord } from "./repositories.js";
import type { OrchestrationWorkerAttemptRecord } from "./orchestration.js";

export type TelemetryUsageSource = "provider" | "unavailable";

export interface AgentUsageReceipt {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  totalTokens?: number;
  estimatedCostUsd?: number;
  source: TelemetryUsageSource;
}

export interface AgentTimingReceipt {
  queuedAt: string;
  startedAt: string;
  completedAt: string;
  activeMs: number;
  queueMs: number;
  retryCount: number;
  resumedFrom?: string;
}

export interface AgentRunReceipt {
  key: string;
  runId: string;
  taskId: string;
  phase: string;
  role: string;
  sessionRef: string;
  sessionLineage: readonly string[];
  provider: string;
  model: string;
  timing: AgentTimingReceipt;
  usage: AgentUsageReceipt;
  /** Low-level execution counters used to detect semantic stalls and budget waste. */
  execution?: AgentExecutionUsage;
  error?: { name: string; message: string };
}

export interface AgentExecutionUsage {
  turns: number;
  toolCalls: number;
  /** Provider usage may be available even when structured output fails. */
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  estimatedCostUsd?: number;
  budget?: { maxTurns?: number; maxToolCalls?: number };
  exhausted?: "maxTurns" | "maxToolCalls";
}

export interface ControllerPhaseTiming {
  phase: string;
  status: "queued" | "active" | "human-held" | "terminal" | "unknown";
  startedAt: string;
  completedAt?: string;
  elapsedMs: number;
}

export interface ControllerTimingSummary {
  queuedMs: number;
  activeMs: number;
  humanHeldMs: number;
  /** Time in the current non-terminal phase that transitions cannot prove was active work. */
  unknownMs: number;
  activityStatus: "fresh" | "stale" | "unknown";
  lastProgressAt?: string;
  activityAgeMs?: number;
  phases: ControllerPhaseTiming[];
}

export interface TelemetrySummary {
  taskCount: number;
  knownUsageTasks: number;
  unavailableUsageTasks: number;
  activeMs: number;
  queueMs: number;
  retries: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  totalTokens?: number;
  estimatedCostUsd?: number;
}

export interface TelemetryRepository {
  recordTelemetry(receipt: AgentRunReceipt): Promise<void>;
  listTelemetry(runId: string): AgentRunReceipt[];
}

export function summarizeControllerTiming(
  createdAt: string,
  records: readonly TransitionRecord[],
  now = Date.now(),
  progress: readonly RunProgressRecord[] = [],
): ControllerTimingSummary {
  const ordered = [...records].sort((left, right) => left.sequence - right.sequence);
  const phases: ControllerPhaseTiming[] = [];
  let phase = ordered[0]?.from ?? "queued";
  let startedMs = Date.parse(createdAt);
  if (!Number.isFinite(startedMs)) startedMs = now;
  for (const record of ordered) {
    const completedMs = Date.parse(record.occurredAt);
    if (!Number.isFinite(completedMs) || completedMs < startedMs) continue;
    phases.push({
      phase,
      status: phase === "queued" ? "queued" : phase === "blocked" ? "human-held" : isTerminalPhase(phase) ? "terminal" : "active",
      startedAt: new Date(startedMs).toISOString(),
      completedAt: new Date(completedMs).toISOString(),
      elapsedMs: completedMs - startedMs,
    });
    phase = record.to;
    startedMs = completedMs;
  }
  if (!isTerminalPhase(phase)) {
    const completedMs = Math.max(startedMs, now);
    phases.push({
      phase,
      // A transition ledger proves when a phase changed, not that a provider
      // or controller was making semantic progress during the open interval.
      // Keep that time visible as unknown so a heartbeat/tool stream cannot be
      // mistaken for completed work.
      status: phase === "queued" ? "queued" : phase === "blocked" ? "human-held" : "unknown",
      startedAt: new Date(startedMs).toISOString(),
      elapsedMs: completedMs - startedMs,
    });
  }
  const latestProgressMs = progress
    .map((item) => Date.parse(item.occurredAt))
    .filter(Number.isFinite)
    .reduce<number | undefined>((latest, value) => latest === undefined || value > latest ? value : latest, undefined);
  const activityAgeMs = latestProgressMs === undefined ? undefined : Math.max(0, now - latestProgressMs);
  return {
    queuedMs: phases.filter((item) => item.status === "queued").reduce((total, item) => total + item.elapsedMs, 0),
    activeMs: phases.filter((item) => item.status === "active").reduce((total, item) => total + item.elapsedMs, 0),
    humanHeldMs: phases.filter((item) => item.status === "human-held").reduce((total, item) => total + item.elapsedMs, 0),
    unknownMs: phases.filter((item) => item.status === "unknown").reduce((total, item) => total + item.elapsedMs, 0),
    activityStatus: latestProgressMs === undefined ? "unknown" : (activityAgeMs ?? 0) <= 60_000 ? "fresh" : "stale",
    ...(latestProgressMs !== undefined && activityAgeMs !== undefined ? { lastProgressAt: new Date(latestProgressMs).toISOString(), activityAgeMs } : {}),
    phases,
  };
}

function isTerminalPhase(phase: string): boolean {
  return ["completed", "invalid", "decomposed", "cancelled", "failed"].includes(phase);
}

export function summarizeTelemetry(receipts: readonly AgentRunReceipt[]): TelemetrySummary {
  const summary: TelemetrySummary = {
    taskCount: receipts.length,
    knownUsageTasks: receipts.filter((receipt) => receipt.usage.source === "provider").length,
    unavailableUsageTasks: receipts.filter((receipt) => receipt.usage.source === "unavailable").length,
    activeMs: receipts.reduce((total, receipt) => total + receipt.timing.activeMs, 0),
    queueMs: receipts.reduce((total, receipt) => total + receipt.timing.queueMs, 0),
    retries: receipts.reduce((total, receipt) => total + receipt.timing.retryCount, 0),
  };
  for (const field of ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "totalTokens", "estimatedCostUsd"] as const) {
    const values = receipts.map((receipt) => receipt.usage[field]).filter((value): value is number => value !== undefined);
    if (values.length) summary[field] = values.reduce((total, value) => total + value, 0);
  }
  return summary;
}

export function runIdFromTaskId(taskId: string): string {
  return taskId.split(":", 1)[0] ?? taskId;
}

/** Machine-proven causal labels. Model-authored prose is intentionally not accepted. */
export type QualityAttributionCategory =
  | "build-packet-omission"
  | "builder-miss"
  | "tool-runtime"
  | "reviewer-false-positive"
  | "target-recovery"
  | "projection-drift"
  | "unknown";
export type QualityConfidence = "deterministic" | "high" | "medium" | "unknown";
export type QualityBoolean = true | false | "unknown";

export interface QualityEvidenceRef {
  kind: "transition" | "progress" | "agent-receipt" | "artifact" | "attempt";
  id: string;
}

export interface QualityPhaseInterval {
  phase: string;
  startedAt: string;
  completedAt?: string;
  elapsedMs: number;
  evidenceRefs: QualityEvidenceRef[];
}

export interface QualityPhaseProjection {
  phase: string;
  intervals: QualityPhaseInterval[];
  /** Union of intervals, not the sum of parallel observations. */
  wallMs: number;
}

export interface QualityWallClockProjection {
  startedAt?: string;
  completedAt?: string;
  elapsedMs: number;
  phaseUnionMs: number;
  phases: QualityPhaseProjection[];
  queuedMs: number;
  claimWaitMs: number;
  retryWaitMs: number;
  targetRecoveryMs: number;
  humanHeldMs: number;
  unknownMs: number;
}

export interface QualityAgentProjection {
  activeMs: number;
  queueMs: number;
  retries: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  totalTokens?: number;
  estimatedCostUsd?: number;
  usageKnown: boolean;
  /** Sum can exceed wall time when agents run in parallel. */
  note: "summed-agent-time-may-exceed-wall-time-under-parallelism";
}

export interface QualityVerificationObservation {
  command: string;
  commandId?: string;
  status: "passed" | "failed" | "skipped";
  durationMs: number;
  outputDigest?: string;
  evidenceRefs: QualityEvidenceRef[];
}

export interface QualityRepeatedObservation {
  command: string;
  commandId?: string;
  outputDigest: string;
  count: number;
  evidenceRefs: QualityEvidenceRef[];
}

export interface QualityFirstPassProjection {
  verification: QualityBoolean;
  approval: QualityBoolean;
  firstVerificationEvidenceRefs: QualityEvidenceRef[];
  firstReviewEvidenceRefs: QualityEvidenceRef[];
}

export interface QualityAttribution {
  category: QualityAttributionCategory;
  confidence: QualityConfidence;
  evidenceRefs: QualityEvidenceRef[];
  derivation: string;
  avoidableReworkMs: number | "unknown";
}

export interface QualitySummary {
  schema: "forgedock.quality/v1";
  wallClock: QualityWallClockProjection;
  agent: QualityAgentProjection;
  firstPass: QualityFirstPassProjection;
  remediation: { cycles: number; timeMs: number; evidenceRefs: QualityEvidenceRef[] };
  verification: {
    observations: QualityVerificationObservation[];
    repeated: QualityRepeatedObservation[];
    /** Never inferred from repeated commands; a receipt is required. */
    cacheHits: number | "unknown";
  };
  attributions: QualityAttribution[];
  complexity?: "low" | "medium" | "high";
  providers: string[];
  models: string[];
  redaction: "controller-evidence-only";
}

export type TelemetryQualitySummary = QualitySummary;

export interface QualitySummaryInput {
  run: RunState;
  transitions: readonly TransitionRecord[];
  progress?: readonly RunProgressRecord[];
  agentReceipts?: readonly AgentRunReceipt[];
  artifacts?: readonly DurableArtifact[];
  orchestrationAttempts?: readonly OrchestrationWorkerAttemptRecord[];
  now?: number;
}

type Interval = { start: number; end: number; ref: QualityEvidenceRef };

/**
 * Builds the first-pass operator projection from durable controller evidence.
 * This function does not inspect agent text and does not accept model-authored
 * causal labels as authority. Invalid/backward timestamps are omitted.
 */
export function summarizeQuality(input: QualitySummaryInput): QualitySummary {
  const now = Number.isFinite(input.now ?? Date.now()) ? (input.now ?? Date.now()) : Date.now();
  const transitions = [...input.transitions].sort((a, b) => a.sequence - b.sequence);
  const phases: QualityPhaseInterval[] = [];
  let phase = input.run.state === "queued" ? "queued" : "queued";
  let start = validDate(input.run.createdAt);
  if (start === undefined) start = now;
  for (const record of transitions) {
    const end = validDate(record.occurredAt);
    if (end === undefined || end < start) continue;
    phases.push({ phase, startedAt: iso(start), completedAt: iso(end), elapsedMs: end - start, evidenceRefs: [{ kind: "transition", id: String(record.sequence) }] });
    phase = record.to;
    start = end;
  }
  const openEnd = Math.max(start, now);
  if (!isTerminalPhase(phase) && openEnd >= start) {
    phases.push({ phase, startedAt: iso(start), elapsedMs: openEnd - start, evidenceRefs: [] });
  }
  const grouped = new Map<string, QualityPhaseInterval[]>();
  for (const item of phases) grouped.set(item.phase, [...(grouped.get(item.phase) ?? []), item]);
  const phaseProjections = [...grouped.entries()].map(([name, intervals]) => ({
    phase: name, intervals, wallMs: unionMs(intervals.map((item) => ({ start: Date.parse(item.startedAt), end: Date.parse(item.completedAt ?? iso(now)), ref: item.evidenceRefs[0] ?? { kind: "transition", id: name } }))),
  }));
  const totalStart = phases.length ? Date.parse(phases[0]!.startedAt) : undefined;
  const totalEnd = phases.length ? Math.max(...phases.map((item) => Date.parse(item.completedAt ?? iso(now)))) : undefined;
  const wallMs = totalStart !== undefined && totalEnd !== undefined ? Math.max(0, totalEnd - totalStart) : 0;
  const duration = (name: string) => phaseProjections.find((item) => item.phase === name)?.wallMs ?? 0;
  const queuedMs = duration("queued");
  const retryWaitMs = duration("retry_wait");
  const targetRecoveryMs = duration("target_recovery");
  const humanHeldMs = duration("blocked");
  const knownPhaseMs = phaseProjections.filter((item) => !["queued", "retry_wait", "target_recovery", "blocked", "completed", "failed", "cancelled", "invalid", "decomposed"].includes(item.phase)).reduce((sum, item) => sum + item.wallMs, 0);
  const unknownMs = Math.max(0, wallMs - queuedMs - retryWaitMs - targetRecoveryMs - humanHeldMs - knownPhaseMs);

  const receipts = input.agentReceipts ?? [];
  const telemetry = summarizeTelemetry(receipts);
  const progress = input.progress ?? [];
  const claimWaitMs = progressClaimWaitMs(progress);
  const artifacts = [...(input.artifacts ?? [])].sort((a, b) => (validDate(a.createdAt) ?? Number.MAX_SAFE_INTEGER) - (validDate(b.createdAt) ?? Number.MAX_SAFE_INTEGER));
  const checks = observationsFromArtifacts(artifacts);
  const firstRepairAt = transitions.map((item) => item.event === "VERIFICATION_REPAIR_REQUESTED" || item.event === "REVIEW_CHANGES_REQUESTED" ? validDate(item.occurredAt) : undefined).find((value): value is number => value !== undefined);
  const firstVerification = firstVerificationResult(transitions, artifacts, firstRepairAt);
  const firstReview = artifacts.find((a) => a.kind === "ReviewVerdict" && (firstRepairAt === undefined || (validDate(a.createdAt) ?? Number.MAX_SAFE_INTEGER) < firstRepairAt));
  const firstPass: QualityFirstPassProjection = {
    verification: firstVerification.result,
    approval: firstReview?.kind === "ReviewVerdict" ? firstReview.payload.disposition === "approve" : "unknown",
    firstVerificationEvidenceRefs: firstVerification.refs,
    firstReviewEvidenceRefs: firstReview ? [{ kind: "artifact", id: firstReview.id }] : [],
  };
  const remediationRefs = transitions.filter((r) => r.event === "VERIFICATION_REPAIR_REQUESTED" || r.event === "REVIEW_CHANGES_REQUESTED").map((r) => ({ kind: "transition" as const, id: String(r.sequence) }));
  const remediationCycles = remediationRefs.length;
  const remediationTimeMs = remediationElapsedMs(phases, firstRepairAt);
  const attributions = deriveAttributions({ transitions, artifacts, progress, attempts: input.orchestrationAttempts ?? [], remediationTimeMs, remediationRefs });
  const complexity = artifacts.find((a) => a.kind === "BuildPacket")?.payload.complexitySignal?.level;
  const providers = unique(receipts.map((receipt) => receipt.provider).filter(Boolean));
  const models = unique(receipts.map((receipt) => receipt.model).filter(Boolean));
  return {
    schema: "forgedock.quality/v1",
    wallClock: { ...(totalStart !== undefined ? { startedAt: iso(totalStart) } : {}), ...(totalEnd !== undefined ? { completedAt: iso(totalEnd) } : {}), elapsedMs: wallMs, phaseUnionMs: unionMs(phases.map((item) => ({ start: Date.parse(item.startedAt), end: Date.parse(item.completedAt ?? iso(now)), ref: item.evidenceRefs[0] ?? { kind: "transition", id: item.phase } }))), phases: phaseProjections, queuedMs, claimWaitMs, retryWaitMs, targetRecoveryMs, humanHeldMs, unknownMs },
    agent: { ...telemetry, usageKnown: telemetry.knownUsageTasks > 0, note: "summed-agent-time-may-exceed-wall-time-under-parallelism" },
    firstPass,
    remediation: { cycles: remediationCycles, timeMs: remediationTimeMs, evidenceRefs: remediationRefs },
    verification: { observations: checks, repeated: repeatedChecks(checks), cacheHits: receipts.some((receipt) => (receipt.usage.cacheReadTokens ?? 0) > 0) ? receipts.filter((receipt) => (receipt.usage.cacheReadTokens ?? 0) > 0).length : "unknown" },
    attributions,
    ...(complexity ? { complexity } : {}),
    providers,
    models,
    redaction: "controller-evidence-only",
  };
}

/** Compatibility name for callers treating the projection as telemetry quality. */
export const summarizeTelemetryQuality = summarizeQuality;

/** Stable, privacy-preserving operator text; it never renders agent messages or command output. */
export function renderQualitySummary(summary: QualitySummary): string {
  const attribution = summary.attributions.map((item) => `${item.category} (${item.confidence})`).join(", ") || "unknown (unknown)";
  return [
    `wall ${summary.wallClock.elapsedMs}ms; active-agent ${summary.agent.activeMs}ms; queue ${summary.wallClock.queuedMs}ms; claim-wait ${summary.wallClock.claimWaitMs}ms`,
    `first-pass verification=${summary.firstPass.verification}; approval=${summary.firstPass.approval}; remediation=${summary.remediation.cycles} cycles/${summary.remediation.timeMs}ms`,
    `attribution: ${attribution}; evidence=${summary.redaction}`,
  ].join("\\n");
}

function validDate(value: string): number | undefined { const parsed = Date.parse(value); return Number.isFinite(parsed) ? parsed : undefined; }
function iso(value: number): string { return new Date(value).toISOString(); }
function unique(values: readonly string[]): string[] { return [...new Set(values)].sort(); }
function unionMs(intervals: readonly Interval[]): number {
  const valid = intervals.filter((item) => Number.isFinite(item.start) && Number.isFinite(item.end) && item.end >= item.start).sort((a, b) => a.start - b.start || a.end - b.end);
  let total = 0; let start: number | undefined; let end = 0;
  for (const item of valid) { if (start === undefined) { start = item.start; end = item.end; } else if (item.start > end) { total += end - start; start = item.start; end = item.end; } else end = Math.max(end, item.end); }
  return start === undefined ? 0 : total + end - start;
}
function progressClaimWaitMs(progress: readonly RunProgressRecord[]): number {
  const times = progress.filter((item) => /claim|queued|serialization|capacity/i.test(`${item.phase} ${item.message}`)).map((item) => validDate(item.occurredAt)).filter((v): v is number => v !== undefined);
  return times.length > 1 ? Math.max(0, times.at(-1)! - times[0]!) : 0;
}
function remediationElapsedMs(phases: readonly QualityPhaseInterval[], firstRepairAt: number | undefined): number {
  if (firstRepairAt === undefined) return 0;
  return phases.filter((item) => (item.phase === "remediating" || item.phase === "building") && Date.parse(item.startedAt) >= firstRepairAt)
    .reduce((sum, item) => sum + item.elapsedMs, 0);
}
function observationsFromArtifacts(artifacts: readonly DurableArtifact[]): QualityVerificationObservation[] {
  const result: QualityVerificationObservation[] = [];
  for (const artifact of artifacts) {
    if (artifact.kind !== "BuildResult" && artifact.kind !== "VerificationCheckpoint" && artifact.kind !== "ReviewVerdict") continue;
    for (const check of artifact.payload.checks) result.push({ command: check.command, ...(check.commandId ? { commandId: check.commandId } : {}), status: check.status, durationMs: check.durationMs, ...(check.outputDigest ? { outputDigest: check.outputDigest } : {}), evidenceRefs: [{ kind: "artifact", id: artifact.id }] });
  }
  return result;
}
function repeatedChecks(checks: readonly QualityVerificationObservation[]): QualityRepeatedObservation[] {
  const groups = new Map<string, QualityRepeatedObservation>();
  for (const check of checks) if (check.outputDigest) { const key = `${check.commandId ?? check.command}\\0${check.outputDigest}`; const prior = groups.get(key); if (prior) { prior.count += 1; prior.evidenceRefs.push(...check.evidenceRefs); } else groups.set(key, { command: check.command, ...(check.commandId ? { commandId: check.commandId } : {}), outputDigest: check.outputDigest, count: 1, evidenceRefs: [...check.evidenceRefs] }); }
  return [...groups.values()].filter((item) => item.count > 1);
}
function firstVerificationResult(transitions: readonly TransitionRecord[], artifacts: readonly DurableArtifact[], before?: number): { result: QualityBoolean; refs: QualityEvidenceRef[] } {
  const event = transitions.find((item) => (item.event === "VERIFICATION_PASSED" || item.event === "VERIFICATION_FAILED") && (before === undefined || (validDate(item.occurredAt) ?? Number.MAX_SAFE_INTEGER) <= before));
  if (event) return { result: event.event === "VERIFICATION_PASSED", refs: [{ kind: "transition", id: String(event.sequence) }] };
  const artifact = artifacts.find((item) => (item.kind === "BuildResult" || item.kind === "VerificationCheckpoint") && (before === undefined || (validDate(item.createdAt) ?? Number.MAX_SAFE_INTEGER) <= before));
  if (!artifact) return { result: "unknown", refs: [] };
  const checks = artifact.kind === "BuildResult" || artifact.kind === "VerificationCheckpoint" ? artifact.payload.checks : [];
  return { result: checks.length > 0 ? checks.every((check) => check.status === "passed") : "unknown", refs: [{ kind: "artifact", id: artifact.id }] };
}
function deriveAttributions(input: { transitions: readonly TransitionRecord[]; artifacts: readonly DurableArtifact[]; progress: readonly RunProgressRecord[]; attempts: readonly OrchestrationWorkerAttemptRecord[]; remediationTimeMs: number; remediationRefs: QualityEvidenceRef[] }): QualityAttribution[] {
  const result: QualityAttribution[] = [];
  const add = (category: QualityAttributionCategory, refs: QualityEvidenceRef[], derivation: string, avoidable: number | "unknown", confidence: QualityConfidence = "deterministic") => result.push({ category, confidence, evidenceRefs: refs, derivation, avoidableReworkMs: avoidable });
  const target = input.transitions.filter((item) => item.to === "target_recovery" || item.event.includes("TARGET_RECOVERY"));
  const targetAttempts = input.attempts.filter((attempt) => attempt.status === "target_recovery");
  if (target.length || targetAttempts.length) add("target-recovery", [
    ...target.map((item) => ({ kind: "transition" as const, id: String(item.sequence) })),
    ...targetAttempts.map((attempt) => ({ kind: "attempt" as const, id: attempt.attemptId })),
  ], "A controller transition or durable orchestration attempt entered target_recovery.", input.remediationTimeMs, "deterministic");
  const drift = input.artifacts.filter((item) => item.kind === "ReviewFindingProjection" && item.payload.projections.some((entry) => entry.status === "projection-drift"));
  if (drift.length) add("projection-drift", drift.map((item) => ({ kind: "artifact", id: item.id })), "A durable finding projection recorded projection-drift.", "unknown", "deterministic");
  const runtime = input.artifacts.filter((item) => (item.kind === "BuildResult" || item.kind === "VerificationCheckpoint" || item.kind === "ReviewVerdict") && item.payload.checks.some((check) => check.failureClass === "infrastructure" || check.failureClass === "timeout"));
  if (runtime.length) add("tool-runtime", runtime.map((item) => ({ kind: "artifact", id: item.id })), "A controller check recorded infrastructure or timeout failureClass.", input.remediationTimeMs, "deterministic");
  const packet = input.artifacts.find((item) => item.kind === "BuildPacket");
  const packetCommandIds = new Set(packet?.kind === "BuildPacket" ? (packet.payload.verificationCommandIdentities ?? []).map((command) => command.id) : []);
  const failedChecks = input.artifacts.filter((item) => (item.kind === "BuildResult" || item.kind === "VerificationCheckpoint") && item.payload.checks.some((check) => check.status === "failed"));
  const omitted = failedChecks.filter((item) => item.kind === "BuildResult" || item.kind === "VerificationCheckpoint").filter((item) => item.payload.checks.some((check) => check.status === "failed" && check.commandId !== undefined && !packetCommandIds.has(check.commandId)));
  if (omitted.length) add("build-packet-omission", omitted.map((item) => ({ kind: "artifact", id: item.id })), "A failed controller check names a command ID absent from the frozen packet command identities.", input.remediationTimeMs, "deterministic");
  const builderMiss = failedChecks.filter((item) => item.kind === "BuildResult" && item.payload.checks.some((check) => check.status === "failed" && check.failureClass === "command" && (check.commandId === undefined || packetCommandIds.has(check.commandId))));
  if (builderMiss.length) add("builder-miss", builderMiss.map((item) => ({ kind: "artifact", id: item.id })), "A packet-covered controller command failed with failureClass command.", input.remediationTimeMs, "deterministic");
  const rejectedReview = input.artifacts.filter((item) => item.kind === "ReviewVerdict" && item.payload.findings.some((finding) => finding.scopeDisposition === "rejected"));
  if (rejectedReview.length) add("reviewer-false-positive", rejectedReview.map((item) => ({ kind: "artifact", id: item.id })), "The controller rejected a reviewer finding as out of scope.", "unknown", "deterministic");
  if (!result.length) add("unknown", [], "No machine evidence proves a causal category; model-authored attribution is excluded.", "unknown", "unknown");
  return result;
}
