// SPDX-License-Identifier: AGPL-3.0-or-later

import type { DurableArtifact } from "../../core/artifacts/schema.js";
import type { ReconciledSubjectState } from "../../core/state/reconcile.js";
import type { ScheduleWorkerResult } from "./scheduler.js";

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
  if (reconciled.state === "target_recovery") {
    const checkpoint = reconciled.targetAdvanceCheckpoint;
    return {
      status: "target_recovery",
      error: checkpoint
        ? `durable target recovery checkpoint ${checkpoint.id} is resumable at ${checkpoint.payload.phase}/${checkpoint.payload.attempt.number}`
        : "durable target recovery checkpoint retained and resumable",
      ...(checkpoint ? { targetAdvanceCheckpointId: checkpoint.id } : {}),
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
