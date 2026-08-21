// SPDX-License-Identifier: AGPL-3.0-or-later

import type { DurableArtifact } from "../artifacts/schema.js";
import type { RunStateName } from "./machine.js";

export interface ReconciledSemanticState {
  state: RunStateName;
  warnings: string[];
  artifactIds: string[];
  remediationCheckpoint?: DurableArtifact<"RemediationBlocked">;
  targetAdvanceCheckpoint?: DurableArtifact<"TargetAdvanceCheckpoint">;
  retryCheckpoint?: DurableArtifact<"RetryCheckpoint">;
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
  for (const artifact of ordered) {
    const previous = latest.get(artifact.kind);
    if (!previous || artifactOrderingKey(artifact) >= artifactOrderingKey(previous)) latest.set(artifact.kind, artifact);
  }
  const warnings: string[] = [];
  const latestOutcome = latest.get("Outcome") as DurableArtifact<"Outcome"> | undefined;
  const verdict = latest.get("ReviewVerdict") as DurableArtifact<"ReviewVerdict"> | undefined;
  const remediationCheckpoint = latest.get("RemediationBlocked") as DurableArtifact<"RemediationBlocked"> | undefined;
  const targetAdvanceCheckpoint = latest.get("TargetAdvanceCheckpoint") as DurableArtifact<"TargetAdvanceCheckpoint"> | undefined;
  const retryCheckpoint = latest.get("RetryCheckpoint") as DurableArtifact<"RetryCheckpoint"> | undefined;
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
  const buildIndex = lastArtifactIndex(ordered, "BuildResult");
  const remediationCheckpointIndex = lastArtifactIndex(ordered, "RemediationBlocked");
  const targetAdvanceCheckpointIndex = targetAdvanceCheckpoint?.payload.phase === "reviewed"
    ? -1
    : latestArtifactIndex(ordered, "TargetAdvanceCheckpoint");
  const retryCheckpointIndex = latestArtifactIndex(ordered, "RetryCheckpoint");
  const nonterminalCheckpoint = retryCheckpointIndex > targetAdvanceCheckpointIndex ? retryCheckpoint : targetAdvanceCheckpoint;
  const nonterminalCheckpointIndex = Math.max(retryCheckpointIndex, targetAdvanceCheckpointIndex);
  let state: RunStateName = "queued";
  const checkpointIsLatest = (remediationCheckpoint !== undefined
    && remediationCheckpointIndex >= Math.max(outcomeIndex, buildIndex))
    || (nonterminalCheckpoint !== undefined
      && nonterminalCheckpointIndex > Math.max(outcomeIndex, buildIndex));
  if (nonterminalCheckpoint && nonterminalCheckpointIndex > Math.max(outcomeIndex, buildIndex)) {
    state = nonterminalCheckpoint.kind === "RetryCheckpoint"
      ? (nonterminalCheckpoint.payload.status === "exhausted" ? "blocked" : "retry_wait")
      : "target_recovery";
    if (nonterminalCheckpoint.kind === "RetryCheckpoint" && nonterminalCheckpoint.payload.status === "exhausted") {
      warnings.push("RetryCheckpoint is exhausted and cannot authorize another attempt");
    }
  } else if (remediationCheckpoint !== undefined && remediationCheckpointIndex >= Math.max(outcomeIndex, buildIndex)) {
    state = remediationCheckpoint.payload.status === "ready-to-resume" ? "reviewing" : "blocked";
    if (remediationCheckpoint.payload.status === "terminal") warnings.push("Remediation checkpoint is terminal and requires human action");
  }

  // A verified build published after a review verdict is a new review head.
  // The older verdict must not make the run look terminally blocked while the
  // publication/review path is still recoverable. Admission already uses this
  // ordering rule; reconciliation must expose the same state to orchestration
  // resume instead of terminalizing the node.
  const verdictSupersededByBuild = verdict !== undefined
    && build !== undefined
    && buildIndex > lastArtifactIndex(ordered, "ReviewVerdict");

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
  } else if (!checkpointIsLatest && verdict && !verdictSupersededByBuild) {
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
    ...(targetAdvanceCheckpoint ? { targetAdvanceCheckpoint } : {}),
    ...(retryCheckpoint ? { retryCheckpoint } : {}),
  };
}

function artifactOrderingKey(artifact: DurableArtifact): string {
  const payload = artifact.payload as { updatedAt?: string; attempt?: { number?: number } };
  return `${payload.updatedAt ?? artifact.createdAt}|${artifact.createdAt}|${String(payload.attempt?.number ?? 0).padStart(12, "0")}|${artifact.id}`;
}

function latestArtifactIndex(artifacts: readonly DurableArtifact[], kind: DurableArtifact["kind"]): number {
  let latest = -1;
  for (let index = 0; index < artifacts.length; index += 1) {
    if (artifacts[index]?.kind !== kind) continue;
    if (latest < 0 || artifactOrderingKey(artifacts[index]!) >= artifactOrderingKey(artifacts[latest]!)) latest = index;
  }
  return latest;
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
