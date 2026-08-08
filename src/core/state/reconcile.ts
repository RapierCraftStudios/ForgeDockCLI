// SPDX-License-Identifier: AGPL-3.0-or-later

import type { DurableArtifact } from "../artifacts/schema.js";
import type { RunStateName } from "./machine.js";

export interface ReconciledSemanticState {
  state: RunStateName;
  warnings: string[];
  artifactIds: string[];
  remediationCheckpoint?: DurableArtifact<"RemediationBlocked">;
}

export interface ReconciledSubjectState extends ReconciledSemanticState {
  runId?: string;
}

export function reconcileLatestRunArtifacts(artifacts: readonly DurableArtifact[]): ReconciledSubjectState {
  const byRun = new Map<string, DurableArtifact[]>();
  for (const artifact of artifacts) byRun.set(artifact.runId, [...(byRun.get(artifact.runId) ?? []), artifact]);
  const latest = [...byRun.entries()]
    .map(([runId, values]) => ({ runId, values, timestamp: Math.max(...values.map((artifact) => Date.parse(artifact.createdAt) || 0)) }))
    .sort((left, right) => right.timestamp - left.timestamp || right.runId.localeCompare(left.runId))[0];
  return latest ? { runId: latest.runId, ...reconcileArtifacts(latest.values) } : reconcileArtifacts([]);
}

/**
 * Reconstructs committed semantic progress from durable artifacts only.
 * In-flight activity is intentionally never inferred from a chat/session log.
 */
export function reconcileArtifacts(artifacts: readonly DurableArtifact[]): ReconciledSemanticState {
  const ordered = [...artifacts].sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt));
  const latest = new Map<string, DurableArtifact>();
  for (const artifact of ordered) latest.set(artifact.kind, artifact);
  const warnings: string[] = [];
  const outcome = latest.get("Outcome") as DurableArtifact<"Outcome"> | undefined;
  const verdict = latest.get("ReviewVerdict") as DurableArtifact<"ReviewVerdict"> | undefined;
  const remediationCheckpoint = latest.get("RemediationBlocked") as DurableArtifact<"RemediationBlocked"> | undefined;
  const build = latest.get("BuildResult") as DurableArtifact<"BuildResult"> | undefined;
  const packet = latest.get("BuildPacket") as DurableArtifact<"BuildPacket"> | undefined;
  const investigation = latest.get("Investigation") as DurableArtifact<"Investigation"> | undefined;
  const intent = latest.get("Intent");

  let state: RunStateName = "queued";
  const checkpointIsLatest = remediationCheckpoint !== undefined
    && (!outcome || Date.parse(remediationCheckpoint.createdAt) >= Date.parse(outcome.createdAt));
  if (checkpointIsLatest) {
    state = remediationCheckpoint.payload.status === "ready-to-resume" ? "reviewing" : "blocked";
    if (remediationCheckpoint.payload.status === "terminal") warnings.push("Remediation checkpoint is terminal and requires human action");
  }
  const interruptedOutcomeSuperseded = (outcome?.payload.status === "blocked" || outcome?.payload.status === "failed")
    && build !== undefined
    && Date.parse(build.createdAt) > Date.parse(outcome.createdAt);
  if (!checkpointIsLatest && outcome && !interruptedOutcomeSuperseded) {
    state = outcome.payload.status === "merged" ? "completed"
      : outcome.payload.status === "invalid" ? "invalid"
        : outcome.payload.status === "decomposed" ? "decomposed"
          : outcome.payload.status === "failed" ? "failed"
            : outcome.payload.status === "abandoned" ? "cancelled"
              : "blocked";
    if (outcome.payload.status === "merged" && !outcome.payload.batchParent && (!verdict || verdict.payload.disposition !== "approve")) {
      warnings.push("Merged Outcome has no approving Review Verdict");
      state = "blocked";
    }
  } else if (!checkpointIsLatest && verdict) {
    state = verdict.payload.disposition === "approve" ? "merging"
      : verdict.payload.disposition === "request_changes" ? "remediating" : "blocked";
    if (!build || build.payload.headSha !== verdict.payload.headSha) {
      warnings.push("Review Verdict does not match a durable Build Result SHA");
      state = "blocked";
    }
  } else if (!checkpointIsLatest && build) {
    state = "publishing";
    if (!packet) warnings.push("Build Result exists without a Build Packet");
  } else if (!checkpointIsLatest && packet) {
    state = "building";
    if (!investigation || investigation.payload.outcome !== "confirmed") {
      warnings.push("Build Packet exists without a confirmed Investigation");
      state = "blocked";
    }
  } else if (!checkpointIsLatest && investigation) {
    state = investigation.payload.outcome === "confirmed" ? "preparing"
      : investigation.payload.outcome === "invalid" ? "invalid" : "decomposed";
  } else if (!checkpointIsLatest && intent) {
    state = "investigating";
  }
  return {
    state,
    warnings,
    artifactIds: ordered.map((artifact) => artifact.id),
    ...(remediationCheckpoint ? { remediationCheckpoint } : {}),
  };
}
