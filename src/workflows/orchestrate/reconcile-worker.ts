// SPDX-License-Identifier: AGPL-3.0-or-later

import type { DurableArtifact } from "../../core/artifacts/schema.js";
import { reconcileLatestRunArtifacts } from "../../core/state/reconcile.js";
import { terminalOrchestrationResult } from "./terminal-result.js";
import type { ScheduleWorkerResult } from "./scheduler.js";

export type AuthoritativeWorkerReconciliation =
  | {
      disposition: "interrupted";
      reason: string;
    }
  | {
      disposition: "terminal";
      result: Exclude<ScheduleWorkerResult, void>;
      reason?: string;
    };

/**
 * Classify one authoritative artifact snapshot using the same admission
 * ordering before and after a stale node-lease wait. A missing classification
 * means the subject is still recoverable and the caller may inspect transport
 * liveness before deciding whether to relaunch it.
 */
export function reconcileAuthoritativeWorkerArtifacts(input: {
  issue: number;
  artifacts: readonly DurableArtifact[];
  childIssuesFromArtifacts: (
    parentIssue: number,
    artifacts: readonly DurableArtifact[],
    runId: string | undefined,
  ) => readonly number[];
  phase: "initial" | "after-wait";
}): AuthoritativeWorkerReconciliation | undefined {
  const reconciled = reconcileLatestRunArtifacts(input.artifacts);
  if (reconciled.state === "completed") {
    return {
      disposition: "terminal",
      result: { status: "completed" },
      ...(input.phase === "after-wait" ? { reason: "Live predecessor completed while recovery waited for its node lease" } : { reason: "Durable Outcome is complete" }),
    };
  }
  if (reconciled.state === "invalid") {
    return {
      disposition: "terminal",
      result: { status: "invalid", error: `#${input.issue} is authoritatively invalid` },
    };
  }
  if (reconciled.state === "decomposed") {
    return {
      disposition: "terminal",
      result: {
        status: "skipped",
        error: `#${input.issue} decomposed into replacement scope`,
        childIssues: input.childIssuesFromArtifacts(input.issue, input.artifacts, reconciled.runId),
      },
    };
  }
  if (reconciled.remediationCheckpoint
    && ["awaiting-dispatch", "children-running", "ready-to-resume"].includes(reconciled.remediationCheckpoint.payload.status)) {
    return {
      disposition: "interrupted",
      reason: `#${input.issue} must resume from remediation checkpoint ${reconciled.remediationCheckpoint.payload.checkpointKey}`,
    };
  }
  const terminal = terminalOrchestrationResult(input.issue, input.artifacts, reconciled);
  if (terminal) {
    return {
      disposition: "terminal",
      result: terminal,
      ...(input.phase === "after-wait" ? { reason: "Live predecessor left a terminal durable outcome" } : {}),
    };
  }
  return undefined;
}
