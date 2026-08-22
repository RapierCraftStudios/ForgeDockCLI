// SPDX-License-Identifier: AGPL-3.0-or-later

import { AgentExecutionBudgetExceededError } from "../../runtime/agent-runtime.js";
import type { ArtifactRepository } from "../../core/ports/repositories.js";
import type { DurableArtifact } from "../../core/artifacts/schema.js";
import { persistRetryCheckpoint } from "../../core/state/retry-checkpoint.js";
import { WorkflowExecutionError } from "../work-on/investigate.js";
import type { ScheduleWorkerResult } from "./scheduler.js";

export const WORK_ON_AGENT_BUDGET_RETRY_MAX_ATTEMPTS = 3;
export const WORK_ON_AGENT_BUDGET_RETRY_DEADLINE_MS = 15 * 60_000;
export const WORK_ON_AGENT_BUDGET_RETRY_BACKOFF_MS = 500;

function nativeWorkOnBudgetCause(error: unknown): unknown | undefined {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current !== undefined && current !== null && !seen.has(current)) {
    seen.add(current);
    if (current instanceof AgentExecutionBudgetExceededError) return current;
    const candidate = current as { name?: unknown; message?: unknown; cause?: unknown };
    const name = typeof candidate.name === "string" ? candidate.name : "";
    const message = typeof candidate.message === "string" ? candidate.message : "";
    // The name/message marker also survives adapters that deserialize or
    // re-wrap the native runtime error before it reaches the CLI boundary.
    if (name === "AgentExecutionBudgetExceededError"
      || /^Agent execution (?:maxTurns|maxToolCalls) budget exhausted\b/i.test(message)) {
      return current;
    }
    current = candidate.cause;
  }
  return undefined;
}

/**
 * Convert only the native work-on execution-budget failure into a durable
 * scheduler retry. Reviewer budgets and lease/liveness failures intentionally
 * remain owned by their existing workflow policies.
 */
export async function retryWorkOnAgentBudget(
  error: unknown,
  input: {
    artifacts: ArtifactRepository;
    subject: { repo: string; issue: number };
    nodeId: string;
    attemptId?: string;
    signal?: AbortSignal;
  },
): Promise<Exclude<ScheduleWorkerResult, void> | undefined> {
  if (input.signal?.aborted) return undefined;
  if (!(error instanceof WorkflowExecutionError) || !error.recoverable) return undefined;
  const budget = nativeWorkOnBudgetCause(error);
  if (!budget) return undefined;
  const budgetMetadata = budget as { sessionRef?: unknown };
  const sessionRef = typeof budgetMetadata.sessionRef === "string" && budgetMetadata.sessionRef.trim()
    ? budgetMetadata.sessionRef.trim()
    : undefined;

  const operationKey = `work-on:agent-execution-budget:${error.run.state}`;
  const semanticKey = `${input.subject.repo}#${input.subject.issue}:${error.run.runId}:${error.run.state}`;
  const prior = (await input.artifacts.list(input.subject, "RetryCheckpoint"))
    .filter((artifact): artifact is DurableArtifact<"RetryCheckpoint"> => artifact.kind === "RetryCheckpoint"
      && artifact.runId === error.run.runId
      && artifact.payload.operationKey === operationKey
      && artifact.payload.semanticKey === semanticKey)
    .sort((left, right) => left.payload.updatedAt.localeCompare(right.payload.updatedAt) || left.id.localeCompare(right.id))
    .at(-1);
  const attempt = (prior?.payload.attempt.number ?? 0) + 1;
  const maxAttempts = WORK_ON_AGENT_BUDGET_RETRY_MAX_ATTEMPTS;
  const firstAt = prior?.payload.attempt.firstAt ?? new Date().toISOString();
  const deadlineAt = prior?.payload.attempt.deadlineAt
    ?? new Date(Date.parse(firstAt) + WORK_ON_AGENT_BUDGET_RETRY_DEADLINE_MS).toISOString();
  const deadline = Date.parse(deadlineAt);
  const now = Date.now();
  const exhausted = attempt >= maxAttempts || !Number.isFinite(deadline) || now >= deadline;
  const nextAttemptAt = exhausted
    ? new Date(now).toISOString()
    : new Date(Math.min(deadline, now + WORK_ON_AGENT_BUDGET_RETRY_BACKOFF_MS)).toISOString();
  const lineage = (await input.artifacts.list(input.subject))
    .filter((artifact) => artifact.runId === error.run.runId)
    .map((artifact) => artifact.id)
    .sort()
    .slice(-256);
  const checkpoint = await persistRetryCheckpoint({
    artifacts: input.artifacts,
    runId: error.run.runId,
    subject: input.subject,
    domain: "workflow",
    code: exhausted ? "agent-execution-budget-exhausted" : "agent-execution-budget",
    phase: error.run.state,
    operationKey,
    semanticKey,
    nodeId: input.nodeId,
    ...(input.attemptId !== undefined ? { attemptId: input.attemptId } : {}),
    ...(sessionRef !== undefined ? { sessionRef } : {}),
    artifactIds: lineage,
    attempt,
    maxAttempts,
    retryAfterMs: exhausted ? 0 : WORK_ON_AGENT_BUDGET_RETRY_BACKOFF_MS,
    nextAttemptAt,
    deadlineAt,
    status: exhausted ? "exhausted" : "waiting",
    cause: budget,
  });
  return {
    status: exhausted ? "failed" : "retry_wait",
    error: error.message,
    retryable: !exhausted,
    retryCheckpointId: checkpoint.id,
    retryAfterMs: exhausted ? 0 : WORK_ON_AGENT_BUDGET_RETRY_BACKOFF_MS,
    nextAttemptAt,
    attempt,
    maxAttempts,
    retryDomain: "workflow",
    retryCode: exhausted ? "agent-execution-budget-exhausted" : "agent-execution-budget",
    operationKey,
  };
}
