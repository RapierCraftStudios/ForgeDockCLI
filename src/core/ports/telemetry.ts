// SPDX-License-Identifier: AGPL-3.0-or-later

import type { TransitionRecord } from "../state/machine.js";
import type { RunProgressRecord } from "./repositories.js";

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
