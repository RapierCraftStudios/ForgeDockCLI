// SPDX-License-Identifier: AGPL-3.0-or-later

import type { DurableArtifact } from "../artifacts/schema.js";
import { reconcileArtifacts } from "./reconcile.js";
import { terminalStates, type RunStateName } from "./machine.js";

export type SubjectAdmissionDecision =
  | { action: "start" }
  | { action: "resume"; runId: string; state: "building" | "blocked" | "publishing" | "failed"; checkpoint: "build" | "verification" | "publication"; artifacts: DurableArtifact[] }
  | { action: "skip"; runId: string; state: RunStateName }
  | { action: "block"; runId: string; state: RunStateName; reason: string };

/**
 * Prevent repeated commands from creating a new semantic run over an issue that
 * already has a terminal or in-flight durable delivery run. The newest run
 * carrying an Intent wins; standalone review runs cannot mask issue delivery.
 */
export function workOnDeliveryArtifacts(artifacts: readonly DurableArtifact[]): DurableArtifact[] {
  const runIds = new Set(artifacts.filter((artifact) => artifact.kind === "Intent").map((artifact) => artifact.runId));
  return artifacts.filter((artifact) => runIds.has(artifact.runId));
}

export function decideSubjectAdmission(
  artifacts: readonly DurableArtifact[],
  options: { rerun?: boolean } = {},
): SubjectAdmissionDecision {
  if (artifacts.length === 0) return { action: "start" };

  const byRun = new Map<string, DurableArtifact[]>();
  for (const artifact of workOnDeliveryArtifacts(artifacts)) {
    const runArtifacts = byRun.get(artifact.runId) ?? [];
    runArtifacts.push(artifact);
    byRun.set(artifact.runId, runArtifacts);
  }
  const deliveryRuns = [...byRun.entries()];
  if (deliveryRuns.length === 0) return { action: "start" };

  const latest = deliveryRuns
    .map(([runId, runArtifacts]) => ({
      runId,
      artifacts: runArtifacts,
      timestamp: Math.max(...runArtifacts.map((artifact) => Date.parse(artifact.createdAt) || 0)),
    }))
    .sort((left, right) => right.timestamp - left.timestamp || right.runId.localeCompare(left.runId))[0];
  if (!latest) return { action: "start" };

  const reconciled = reconcileArtifacts(latest.artifacts);
  // A fresh rerun is an explicit human/controller authorization to abandon a
  // terminal checkpoint. It never overrides an in-flight nonterminal run.
  if (options.rerun && terminalStates.has(reconciled.state)) return { action: "start" };
  if (reconciled.state === "building") {
    const intent = latest.artifacts.some((artifact) => artifact.kind === "Intent");
    const investigation = latest.artifacts.some((artifact) => artifact.kind === "Investigation" && artifact.payload.outcome === "confirmed");
    const packet = latest.artifacts.some((artifact) => artifact.kind === "BuildPacket");
    if (intent && investigation && packet) {
      return { action: "resume", runId: latest.runId, state: "building", checkpoint: "build", artifacts: latest.artifacts };
    }
  }
  if (reconciled.state === "blocked") {
    // Recovery evidence belongs to one specific blocked checkpoint. Never reuse
    // an older verification Outcome after a newer review/budget block superseded it.
    const blocked = latestOfKind(latest.artifacts, "Outcome");
    if (blocked?.payload.status === "blocked" && blocked.payload.failureEvidence) {
      return { action: "resume", runId: latest.runId, state: "blocked", checkpoint: "verification", artifacts: latest.artifacts };
    }
  }
  if (reconciled.state === "publishing" || reconciled.state === "failed") {
    const intent = latest.artifacts.some((artifact) => artifact.kind === "Intent");
    const investigation = latest.artifacts.some((artifact) => artifact.kind === "Investigation" && artifact.payload.outcome === "confirmed");
    const packet = latest.artifacts.some((artifact) => artifact.kind === "BuildPacket");
    const build = latestOfKind(latest.artifacts, "BuildResult");
    const verdict = latestOfKind(latest.artifacts, "ReviewVerdict");
    const failure = latestOfKind(latest.artifacts, "Outcome");
    if (intent && investigation && packet && build && !verdict) {
      return { action: "resume", runId: latest.runId, state: "publishing", checkpoint: "publication", artifacts: latest.artifacts };
    }
    const expectedPublishedHead = failure?.kind === "Outcome" && failure.payload.status === "failed"
      ? /^Published remediation head [0-9a-f]{7,64} does not match verified build ([0-9a-f]{7,64})$/i.exec(failure.payload.reason)?.[1]
      : undefined;
    const verifiedAfterReview = build && verdict && Date.parse(build.createdAt) > Date.parse(verdict.createdAt);
    if (reconciled.state === "failed" && intent && investigation && packet && verifiedAfterReview
      && expectedPublishedHead?.toLowerCase() === build.payload.headSha.toLowerCase()) {
      return { action: "resume", runId: latest.runId, state: "failed", checkpoint: "publication", artifacts: latest.artifacts };
    }
  }
  if (terminalStates.has(reconciled.state)) {
    return { action: "skip", runId: latest.runId, state: reconciled.state };
  }
  return {
    action: "block",
    runId: latest.runId,
    state: reconciled.state,
    reason: `Existing run ${latest.runId} is ${reconciled.state} and has no controller-supported durable resume checkpoint; reset it before starting another run`,
  };
}

function latestOfKind<K extends DurableArtifact["kind"]>(
  artifacts: readonly DurableArtifact[],
  kind: K,
): Extract<DurableArtifact, { kind: K }> | undefined {
  return artifacts
    .filter((artifact): artifact is Extract<DurableArtifact, { kind: K }> => artifact.kind === kind)
    .sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt))
    .at(-1);
}
