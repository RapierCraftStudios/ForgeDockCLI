// SPDX-License-Identifier: AGPL-3.0-or-later

import type { DurableArtifact } from "../artifacts/schema.js";
import { reconcileArtifacts } from "./reconcile.js";
import { terminalStates, type RunStateName } from "./machine.js";

export type SubjectAdmissionDecision =
  | { action: "start" }
  | { action: "resume"; runId: string; state: "building" | "blocked" | "publishing" | "failed" | "remediating" | "merging"; checkpoint: "build" | "verification" | "remediation" | "publication" | "completion"; artifacts: DurableArtifact[] }
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

  const hasIntent = latest.artifacts.some((artifact) => artifact.kind === "Intent");
  const hasInvestigation = latest.artifacts.some((artifact) => artifact.kind === "Investigation" && artifact.payload.outcome === "confirmed");
  const hasPacket = latest.artifacts.some((artifact) => artifact.kind === "BuildPacket");
  const build = latestOfKind(latest.artifacts, "BuildResult");
  const verdict = latestOfKind(latest.artifacts, "ReviewVerdict");
  const outcome = latestOfKind(latest.artifacts, "Outcome");
  const remediationCheckpoint = latestOfKind(latest.artifacts, "RemediationBlocked");
  const deliveryContext = hasIntent && hasInvestigation && hasPacket;
  if (remediationCheckpoint && (remediationCheckpoint.payload.status === "awaiting-dispatch" || remediationCheckpoint.payload.status === "children-running" || remediationCheckpoint.payload.status === "ready-to-resume")) {
    return { action: "resume", runId: latest.runId, state: "blocked", checkpoint: "remediation", artifacts: latest.artifacts };
  }
  const buildTime = build ? Date.parse(build.createdAt) : 0;
  const verdictTime = verdict ? Date.parse(verdict.createdAt) : 0;
  const outcomeTime = outcome ? Date.parse(outcome.createdAt) : 0;

  if (reconciled.state === "building" && deliveryContext) {
    return { action: "resume", runId: latest.runId, state: "building", checkpoint: "build", artifacts: latest.artifacts };
  }

  // A verification failure is authoritative only while no newer verified build
  // supersedes it. This avoids replaying stale retained evidence after a resume.
  const pendingVerificationFailure = outcome?.payload.status === "blocked"
    && outcome.payload.failureEvidence !== undefined
    && outcomeTime >= buildTime;
  if (pendingVerificationFailure) {
    const noChangeAttempt = /^Builder produced no repository changes$/i.test(outcome.payload.reason);
    if (noChangeAttempt && deliveryContext && build && verdict
      && verdict.payload.disposition === "request_changes" && verdict.payload.headSha === build.payload.headSha) {
      return { action: "resume", runId: latest.runId, state: "remediating", checkpoint: "remediation", artifacts: latest.artifacts };
    }
    if (noChangeAttempt && deliveryContext && !verdict) {
      return { action: "resume", runId: latest.runId, state: "building", checkpoint: "build", artifacts: latest.artifacts };
    }
    return { action: "resume", runId: latest.runId, state: "blocked", checkpoint: "verification", artifacts: latest.artifacts };
  }

  // A newer verified head means build/remediation and verification completed,
  // but publication or review did not durably finish. Republishing is
  // idempotent and starts an entirely fresh review without replaying build.
  const verifiedAfterLatestVerdict = build && (!verdict || buildTime > verdictTime);
  if (deliveryContext && verifiedAfterLatestVerdict && outcome?.payload.status !== "merged") {
    const expectedPublishedHead = outcome?.payload.status === "failed"
      ? /^Published remediation head [0-9a-f]{7,64} does not match verified build ([0-9a-f]{7,64})$/i.exec(outcome.payload.reason)?.[1]
      : undefined;
    const provenRevisionRecovery = expectedPublishedHead?.toLowerCase() === build.payload.headSha.toLowerCase();
    return {
      action: "resume", runId: latest.runId,
      state: provenRevisionRecovery ? "failed" : "publishing",
      checkpoint: "publication", artifacts: latest.artifacts,
    };
  }

  const matchingReviewedHead = build && verdict && verdict.payload.headSha === build.payload.headSha;
  if (deliveryContext && matchingReviewedHead && verdict.payload.disposition === "approve"
    && outcome?.payload.status !== "merged") {
    return { action: "resume", runId: latest.runId, state: "merging", checkpoint: "completion", artifacts: latest.artifacts };
  }

  if (deliveryContext && matchingReviewedHead && verdict.payload.disposition === "request_changes") {
    const reviewBudgetExhausted = outcome?.payload.status === "blocked"
      && /^Remediation budget exhausted after \d+ cycle\(s\)$/i.test(outcome.payload.reason);
    const interruptedRemediation = !outcome || outcome.payload.status === "failed" || verdictTime > outcomeTime;
    if (reviewBudgetExhausted || interruptedRemediation) {
      return {
        action: "resume", runId: latest.runId,
        state: reviewBudgetExhausted ? "blocked" : "remediating",
        checkpoint: "remediation", artifacts: latest.artifacts,
      };
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
