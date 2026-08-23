// SPDX-License-Identifier: AGPL-3.0-or-later

import type { DurableArtifact } from "../../core/artifacts/schema.js";
import type { ReconciledSubjectState } from "../../core/state/reconcile.js";
import type { OrchestrationRecoverableCheckpoint } from "../../core/ports/orchestration.js";
import type { ScheduleWorkerResult } from "./scheduler.js";

/**
 * Admit only an approved, exact-SHA completion checkpoint. Blocked Outcomes,
 * pending/unavailable checks, human merge, and inconsistent evidence remain
 * terminal/suspended and are never converted into an automatic retry.
 */
export function recoverableCompletionCheckpoint(
  artifacts: readonly DurableArtifact[],
  reconciled: ReconciledSubjectState,
  autoMerge: boolean,
): OrchestrationRecoverableCheckpoint | undefined {
  if (!autoMerge || reconciled.state !== "merging" || !reconciled.runId || reconciled.warnings.length) return undefined;
  const verdict = [...artifacts].reverse().find((artifact): artifact is DurableArtifact<"ReviewVerdict"> =>
    artifact.kind === "ReviewVerdict" && artifact.runId === reconciled.runId && artifact.payload.disposition === "approve",
  );
  if (!verdict?.subject.pr || !verdict.payload.headSha) return undefined;
  const build = [...artifacts].reverse().find((artifact): artifact is DurableArtifact<"BuildResult"> =>
    artifact.kind === "BuildResult" && artifact.runId === reconciled.runId,
  );
  if (!build || build.payload.headSha !== verdict.payload.headSha) return undefined;
  return {
    checkpointKey: `${reconciled.runId}:completion:pr:${verdict.subject.pr}:sha:${verdict.payload.headSha}`,
    checkpoint: "completion",
    runId: reconciled.runId,
    headSha: verdict.payload.headSha,
    pullRequest: verdict.subject.pr,
  };
}

/**
 * Convert authoritative latest-run reconciliation into a terminal scheduler
 * result. Historical failure Outcomes may be retained for audit after a later
 * BuildResult resumes the same run, so raw Outcome presence is never terminal
 * by itself.
 */
export function terminalOrchestrationResult(
  issue: number,
  artifacts: readonly DurableArtifact[],
  reconciled: ReconciledSubjectState,
): Exclude<ScheduleWorkerResult, void> | undefined {
  const terminalTargetOutcome = [...artifacts].reverse().find((artifact): artifact is DurableArtifact<"Outcome"> =>
    artifact.kind === "Outcome"
    && artifact.runId === reconciled.runId
    && artifact.payload.targetRecovery?.checkpointId !== undefined
    && (artifact.payload.status === "failed" || artifact.payload.status === "blocked"));
  if (terminalTargetOutcome) {
    return {
      status: terminalTargetOutcome.payload.status === "blocked" ? "blocked" : "failed",
      error: `#${issue} reached ${terminalTargetOutcome.payload.status}: ${terminalTargetOutcome.payload.reason}`,
      targetAdvanceCheckpointId: terminalTargetOutcome.payload.targetRecovery!.checkpointId,
      attempt: terminalTargetOutcome.payload.targetRecovery!.attempt.number,
      maxAttempts: terminalTargetOutcome.payload.targetRecovery!.attempt.max,
      retryable: false,
    };
  }
  if (reconciled.state === "target_recovery") {
    const checkpoint = reconciled.targetAdvanceCheckpoint;
    return {
      status: "target_recovery",
      error: checkpoint
        ? `durable target recovery checkpoint ${checkpoint.id} is resumable at ${checkpoint.payload.phase}/${checkpoint.payload.attempt.number}`
        : "durable target recovery checkpoint retained and resumable",
      ...(checkpoint ? { targetAdvanceCheckpointId: checkpoint.id } : {}),
      ...(checkpoint ? { attempt: checkpoint.payload.attempt.number, maxAttempts: checkpoint.payload.attempt.max } : {}),
      retryable: true,
    };
  }
  if (reconciled.state === "retry_wait") {
    const retry = reconciled.retryCheckpoint;
    return {
      status: "retry_wait",
      error: retry ? `${retry.payload.domain}/${retry.payload.code} retry due at ${retry.payload.attempt.nextAt}` : "durable RetryCheckpoint retained",
      ...(retry?.id !== undefined ? { retryCheckpointId: retry.id } : {}),
      ...(retry?.payload.attempt.nextAt !== undefined ? { nextAttemptAt: retry.payload.attempt.nextAt } : {}),
      ...(retry?.payload.attempt.number !== undefined ? { attempt: retry.payload.attempt.number } : {}),
      ...(retry?.payload.attempt.max !== undefined ? { maxAttempts: retry.payload.attempt.max } : {}),
    };
  }
  if (reconciled.state !== "blocked" && reconciled.state !== "failed") return undefined;

  const outcome = [...artifacts].reverse().find((artifact): artifact is DurableArtifact<"Outcome"> =>
    artifact.kind === "Outcome"
    && artifact.runId === reconciled.runId
    && artifact.payload.status === reconciled.state);
  const checkpoint = reconciled.remediationCheckpoint;
  const checkpointDetail = checkpoint
    ? ` checkpoint=${checkpoint.payload.checkpointKey} status=${checkpoint.payload.status}`
    : "";
  if (outcome) {
    return {
      status: reconciled.state,
      error: `#${issue} reached ${reconciled.state}: ${outcome.payload.reason}${checkpointDetail}`,
    };
  }
  return {
    status: reconciled.state,
    error: `#${issue} reconciled as ${reconciled.state}${reconciled.warnings.length ? `: ${reconciled.warnings.join("; ")}` : " without a terminal Outcome reason"}${checkpointDetail}`,
  };
}
