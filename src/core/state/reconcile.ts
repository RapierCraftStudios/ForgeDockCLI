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
  let latestRunId: string | undefined;
  for (const artifact of artifacts) {
    if (artifact.kind === "Intent") latestRunId = artifact.runId;
  }
  latestRunId ??= artifacts.at(-1)?.runId;
  if (!latestRunId) return reconcileArtifacts([]);
  return {
    runId: latestRunId,
    ...reconcileArtifacts(artifacts.filter((artifact) => artifact.runId === latestRunId)),
  };
}

/**
 * Reconstructs committed semantic progress from durable artifacts only.
 * In-flight activity is intentionally never inferred from a chat/session log.
 */
export function reconcileArtifacts(artifacts: readonly DurableArtifact[]): ReconciledSemanticState {
  const ordered = [...artifacts];
  const latest = new Map<string, DurableArtifact>();
  for (const artifact of ordered) latest.set(artifact.kind, artifact);
  const warnings: string[] = [];
  const latestOutcome = latest.get("Outcome") as DurableArtifact<"Outcome"> | undefined;
  const verdict = latest.get("ReviewVerdict") as DurableArtifact<"ReviewVerdict"> | undefined;
  const remediationCheckpoint = latest.get("RemediationBlocked") as DurableArtifact<"RemediationBlocked"> | undefined;
  const build = latest.get("BuildResult") as DurableArtifact<"BuildResult"> | undefined;
  const packet = latest.get("BuildPacket") as DurableArtifact<"BuildPacket"> | undefined;
  const investigation = latest.get("Investigation") as DurableArtifact<"Investigation"> | undefined;
  const intent = latest.get("Intent");

  const latestOutcomeIndex = lastArtifactIndex(ordered, "Outcome");
  const investigationIndex = lastArtifactIndex(ordered, "Investigation");
  const terminalInvestigationOutcomeIndex = investigation?.payload.outcome === "invalid"
    ? lastOutcomeIndex(ordered, "invalid")
    : investigation?.payload.outcome === "decompose"
      ? lastOutcomeIndex(ordered, "decomposed")
      : -1;
  const terminalInvestigationOutcomeCandidate = terminalInvestigationOutcomeIndex >= 0
    ? ordered[terminalInvestigationOutcomeIndex]
    : undefined;
  const terminalInvestigationOutcome = terminalInvestigationOutcomeCandidate?.kind === "Outcome"
    ? terminalInvestigationOutcomeCandidate
    : undefined;
  const laterOutcomesAreOnlyFailures = terminalInvestigationOutcomeIndex >= 0
    && ordered.slice(terminalInvestigationOutcomeIndex + 1)
      .every((artifact) => artifact.kind !== "Outcome" || artifact.payload.status === "failed");
  // A controller may record an operational failure after the semantic
  // terminal projection was durably accepted but before the transition
  // receipt returned. Preserve that earlier projection so recovery closes an
  // invalid issue (or recognizes decomposition) instead of masking it as a
  // fresh failed run.
  const recoverableTerminalOutcome = terminalInvestigationOutcomeIndex > investigationIndex
    && latestOutcomeIndex > terminalInvestigationOutcomeIndex
    && latestOutcome?.payload.status === "failed"
    && laterOutcomesAreOnlyFailures
    ? terminalInvestigationOutcome
    : undefined;
  const outcome = recoverableTerminalOutcome ?? latestOutcome;
  const outcomeIndex = recoverableTerminalOutcome ? terminalInvestigationOutcomeIndex : latestOutcomeIndex;
  const remediationCheckpointIndex = lastArtifactIndex(ordered, "RemediationBlocked");
  const buildIndex = lastArtifactIndex(ordered, "BuildResult");

  let state: RunStateName = "queued";
  const checkpointIsLatest = remediationCheckpoint !== undefined
    && remediationCheckpointIndex >= Math.max(outcomeIndex, buildIndex);
  if (checkpointIsLatest) {
    state = remediationCheckpoint.payload.status === "ready-to-resume" ? "reviewing" : "blocked";
    if (remediationCheckpoint.payload.status === "terminal") warnings.push("Remediation checkpoint is terminal and requires human action");
  }
  const interruptedOutcomeSuperseded = (outcome?.payload.status === "blocked" || outcome?.payload.status === "failed")
    && build !== undefined
    && buildIndex > outcomeIndex;
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
    state = investigation.payload.outcome === "confirmed" ? "preparing" : "investigating";
    if (investigation.payload.outcome !== "confirmed") {
      warnings.push(`${investigation.payload.outcome === "invalid" ? "Invalid" : "Decomposed"} Investigation is missing its terminal Outcome`);
    }
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

function lastArtifactIndex(artifacts: readonly DurableArtifact[], kind: DurableArtifact["kind"]): number {
  for (let index = artifacts.length - 1; index >= 0; index--) {
    if (artifacts[index]?.kind === kind) return index;
  }
  return -1;
}

function lastOutcomeIndex(
  artifacts: readonly DurableArtifact[],
  status: DurableArtifact<"Outcome">["payload"]["status"],
): number {
  for (let index = artifacts.length - 1; index >= 0; index--) {
    const artifact = artifacts[index];
    if (artifact?.kind === "Outcome" && artifact.payload.status === status) return index;
  }
  return -1;
}
