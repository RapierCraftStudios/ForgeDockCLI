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
