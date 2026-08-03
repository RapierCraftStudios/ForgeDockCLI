// SPDX-License-Identifier: AGPL-3.0-or-later

import type { DurableArtifact } from "../artifacts/schema.js";
import { reconcileArtifacts } from "./reconcile.js";
import { terminalStates, type RunStateName } from "./machine.js";

export type SubjectAdmissionDecision =
  | { action: "start" }
  | { action: "resume"; runId: string; state: "blocked"; artifacts: DurableArtifact[] }
  | { action: "skip"; runId: string; state: RunStateName }
  | { action: "block"; runId: string; state: RunStateName; reason: string };

/**
 * Prevent repeated commands from creating a new semantic run over an issue that
 * already has a terminal or in-flight durable run. The newest run wins; older
 * terminal artifacts must not hide a later interrupted attempt.
 */
export function decideSubjectAdmission(
  artifacts: readonly DurableArtifact[],
  options: { rerun?: boolean } = {},
): SubjectAdmissionDecision {
  if (artifacts.length === 0) return { action: "start" };

  const byRun = new Map<string, DurableArtifact[]>();
  for (const artifact of artifacts) {
    const runArtifacts = byRun.get(artifact.runId) ?? [];
    runArtifacts.push(artifact);
    byRun.set(artifact.runId, runArtifacts);
  }
  const latest = [...byRun.entries()]
    .map(([runId, runArtifacts]) => ({
      runId,
      artifacts: runArtifacts,
      timestamp: Math.max(...runArtifacts.map((artifact) => Date.parse(artifact.createdAt) || 0)),
    }))
    .sort((left, right) => right.timestamp - left.timestamp || right.runId.localeCompare(left.runId))[0];
  if (!latest) return { action: "start" };

  const reconciled = reconcileArtifacts(latest.artifacts);
  if (reconciled.state === "blocked") {
    const recoverable = latest.artifacts.some((artifact) => artifact.kind === "Outcome" && artifact.payload.status === "blocked" && artifact.payload.failureEvidence);
    if (recoverable) return { action: "resume", runId: latest.runId, state: "blocked", artifacts: latest.artifacts };
  }
  if (options.rerun && terminalStates.has(reconciled.state)) return { action: "start" };
  if (terminalStates.has(reconciled.state)) {
    return { action: "skip", runId: latest.runId, state: reconciled.state };
  }
  return {
    action: "block",
    runId: latest.runId,
    state: reconciled.state,
    reason: `Existing run ${latest.runId} is ${reconciled.state}; resume or clean it before starting another run`,
  };
}
