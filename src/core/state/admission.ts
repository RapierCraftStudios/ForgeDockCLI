// SPDX-License-Identifier: AGPL-3.0-or-later

import type { DurableArtifact } from "../artifacts/schema.js";
import type { CheckResult } from "../ports/verification.js";
import { reconcileArtifacts } from "./reconcile.js";
import { terminalStates, type RunStateName } from "./machine.js";

export type SubjectAdmissionDecision =
  | { action: "start" }
  | { action: "resume"; runId: string; state: "investigating" | "preparing" | "building" | "blocked" | "publishing" | "target_recovery" | "retry_wait" | "failed" | "remediating" | "merging" | "invalid"; checkpoint: "investigation" | "preparation" | "build" | "verification" | "remediation" | "publication" | "target-advance" | "retry" | "completion" | "conflict-recovery" | "invalid-closure"; artifacts: DurableArtifact[] }
  | { action: "skip"; runId: string; state: RunStateName }
  | { action: "block"; runId: string; state: RunStateName; reason: string };

export interface DurableLaneMismatch {
  runId: string;
  durableTargetBranch: string;
  currentTargetBranch: string;
  reason: string;
}

/**
 * Prevent repeated commands from creating a new semantic run over an issue that
 * already has a terminal or in-flight durable delivery run. The newest run
 * carrying an Intent wins; standalone review runs cannot mask issue delivery.
 */
export function workOnDeliveryArtifacts(artifacts: readonly DurableArtifact[]): DurableArtifact[] {
  const runIds = new Set(artifacts.filter((artifact) => artifact.kind === "Intent").map((artifact) => artifact.runId));
  return artifacts.filter((artifact) => runIds.has(artifact.runId));
}

export function latestDeliveryRunArtifacts(
  artifacts: readonly DurableArtifact[],
): { runId: string; artifacts: DurableArtifact[] } | undefined {
  const deliveryArtifacts = workOnDeliveryArtifacts(artifacts);
  let latestRunId: string | undefined;
  for (const artifact of deliveryArtifacts) {
    if (artifact.kind === "Intent") latestRunId = artifact.runId;
  }
  if (!latestRunId) return undefined;
  return {
    runId: latestRunId,
    artifacts: deliveryArtifacts.filter((artifact) => artifact.runId === latestRunId),
  };
}

export function reviewRemediationCycleCount(artifacts: readonly DurableArtifact[]): number {
  return artifacts.filter((artifact) =>
    artifact.kind === "ReviewVerdict" && artifact.payload.disposition === "request_changes").length;
}

export const MAX_VERIFICATION_REPAIR_ATTEMPTS = 2;

export function isRepairableVerificationFailure(
  packet: DurableArtifact<"BuildPacket"> | undefined,
  outcome: DurableArtifact<"Outcome"> | undefined,
): boolean {
  if (!packet || !outcome || outcome.payload.status !== "blocked" || !outcome.payload.failureEvidence) return false;
  const evidence = outcome.payload.failureEvidence;
  // Packet/catalog contracts are immutable authority, not builder evidence. A
  // typed contract failure must never be reclassified by repairAttempt or any
  // legacy reason heuristic into retained builder repair.
  if (evidence.failureKind === "packet-contract") return false;
  const reason = outcome.payload.reason;
  const noChanges = /^Builder produced no repository changes$/i.test(reason);
  const dispatchedRepair = evidence.repairAttempt !== undefined;
  const legacyBuilderEvidence = evidence.criterionCoverage === undefined;
  const recognizedFailure = evidence.failureKind === "builder-semantic-evidence"
    || evidence.failureKind === "builder-report"
    || dispatchedRepair
    || legacyBuilderEvidence
    || noChanges
    || /^Required verification failed(?::|$)/i.test(reason)
    || /^Builder (?:criterion coverage is incomplete|change report does not match)/i.test(reason);
  if (!recognizedFailure) return false;
  const changedPaths = evidence.changedPaths.map(normalizeRepoPath);
  if (!changedPaths.length && !noChanges && !dispatchedRepair) return false;
  const expectedPaths = new Set(packet.payload.expectedPaths.map(normalizeRepoPath));
  if (!changedPaths.every((path) => expectedPaths.has(path))) return false;
  if (noChanges) return true;
  const failedChecks = evidence.checks.filter((check) => check.status === "failed");
  return failedChecks.length === 0 || failedChecks.some(isRepairableCheckFailure);
}

export function verificationRepairAttemptCount(artifacts: readonly DurableArtifact[]): number {
  let latestSuccessfulBuildIndex = -1;
  for (let index = 0; index < artifacts.length; index++) {
    if (artifacts[index]?.kind === "BuildResult") latestSuccessfulBuildIndex = index;
  }
  return Math.max(0, ...artifacts
    .slice(latestSuccessfulBuildIndex + 1)
    .flatMap((artifact) => artifact.kind === "Outcome" && artifact.payload.failureEvidence?.repairAttempt !== undefined
      ? [artifact.payload.failureEvidence.repairAttempt]
      : []));
}

export function decideSubjectAdmission(
  artifacts: readonly DurableArtifact[],
  options: {
    rerun?: boolean;
    currentTargetBranch?: string;
    durableTargetBranches?: ReadonlyMap<string, string | undefined>;
  } = {},
): SubjectAdmissionDecision {
  if (artifacts.length === 0) return { action: "start" };

  const latest = latestDeliveryRunArtifacts(artifacts);
  if (!latest) return { action: "start" };

  const reconciled = reconcileArtifacts(latest.artifacts);
  const latestOutcome = latestArtifactOfKind(latest.artifacts, "Outcome");
  const latestArtifact = latest.artifacts.at(-1);
  // `reset` appends an abandoned Outcome as explicit authorization to leave
  // the old run behind and start a clean attempt. Treating that checkpoint as
  // an ordinary cancelled terminal run turns reset into a permanent subject
  // lock: the next worker exits successfully without creating a new run, and
  // its orchestration node can never produce a completed Outcome.
  //
  // Require the abandoned Outcome to be the final durable artifact. If a
  // stale controller published newer work after reset, fail through the
  // ordinary recovery policy instead of silently discarding that evidence.
  if (latestArtifact?.kind === "Outcome" && latestArtifact.payload.status === "abandoned") {
    return { action: "start" };
  }
  const durableTargetBranch = options.durableTargetBranches?.get(latest.runId)
    ?? latestArtifactOfKind(latest.artifacts, "BuildResult")?.payload.targetBranch
    ?? latestArtifactOfKind(latest.artifacts, "Outcome")?.payload.failureEvidence?.targetBranch;
  if (!options.rerun && options.currentTargetBranch && durableTargetBranch && durableTargetBranch !== options.currentTargetBranch) {
    return {
      action: "block",
      runId: latest.runId,
      state: reconciled.state,
      reason: `Durable run ${latest.runId} targets ${durableTargetBranch}, but the current issue lane targets ${options.currentTargetBranch}; refusing cross-branch recovery. Use --rerun to start a fresh run on ${options.currentTargetBranch}.`,
    };
  }
  const latestInvestigation = latestArtifactOfKind(latest.artifacts, "Investigation");
  const latestInvestigationIndex = lastArtifactIndex(latest.artifacts, "Investigation");
  const matchingTerminalOutcomeIndex = latestInvestigation?.payload.outcome === "invalid"
    ? lastOutcomeIndex(latest.artifacts, "invalid")
    : latestInvestigation?.payload.outcome === "decompose"
      ? lastOutcomeIndex(latest.artifacts, "decomposed")
      : -1;
  const matchingTerminalOutcomeCandidate = matchingTerminalOutcomeIndex >= 0
    ? latest.artifacts[matchingTerminalOutcomeIndex]
    : undefined;
  const matchingTerminalOutcome = matchingTerminalOutcomeCandidate?.kind === "Outcome"
    ? matchingTerminalOutcomeCandidate
    : undefined;
  const terminalInvestigationNeedsFinalization = latestInvestigation !== undefined
    && latestInvestigation.payload.outcome !== "confirmed"
    && matchingTerminalOutcomeIndex < latestInvestigationIndex;
  if (terminalInvestigationNeedsFinalization) {
    return {
      action: "resume",
      runId: latest.runId,
      state: "investigating",
      checkpoint: "investigation",
      artifacts: latest.artifacts,
    };
  }
  const invalidClosureOutcome = latestInvestigation?.payload.outcome === "invalid"
    && matchingTerminalOutcomeIndex > latestInvestigationIndex
    && matchingTerminalOutcome?.payload.status === "invalid"
    ? matchingTerminalOutcome
    : latestOutcome?.payload.status === "invalid"
      ? latestOutcome
      : undefined;
  const invalidClosurePending = reconciled.state === "invalid"
    && invalidClosureOutcome !== undefined
    && invalidClosureOutcome.payload.issueClosure?.status !== "completed";
  if (invalidClosurePending) {
    return { action: "resume", runId: latest.runId, state: "invalid", checkpoint: "invalid-closure", artifacts: latest.artifacts };
  }
  // A fresh rerun is an explicit human/controller authorization to abandon a
  // terminal checkpoint. It never overrides an in-flight nonterminal run.
  if (options.rerun && terminalStates.has(reconciled.state)) return { action: "start" };

  const hasIntent = latest.artifacts.some((artifact) => artifact.kind === "Intent");
  const hasInvestigation = latest.artifacts.some((artifact) => artifact.kind === "Investigation" && artifact.payload.outcome === "confirmed");
  const packet = latestArtifactOfKind(latest.artifacts, "BuildPacket");
  const hasPacket = packet !== undefined;
  const build = latestArtifactOfKind(latest.artifacts, "BuildResult");
  const verdict = latestArtifactOfKind(latest.artifacts, "ReviewVerdict");
  const outcome = latestArtifactOfKind(latest.artifacts, "Outcome");
  const remediationCheckpoint = latestArtifactOfKind(latest.artifacts, "RemediationBlocked");
  const deliveryContext = hasIntent && hasInvestigation && hasPacket;
  const latestBuildIndex = lastArtifactIndex(latest.artifacts, "BuildResult");
  const latestVerdictIndex = lastArtifactIndex(latest.artifacts, "ReviewVerdict");
  const latestOutcomeIndex = lastArtifactIndex(latest.artifacts, "Outcome");
  const latestRemediationCheckpointIndex = lastArtifactIndex(latest.artifacts, "RemediationBlocked");
  const latestTargetAdvance = latestArtifactOfKind(latest.artifacts, "TargetAdvanceCheckpoint");
  const latestTargetAdvanceIndex = lastArtifactIndex(latest.artifacts, "TargetAdvanceCheckpoint");
  const latestRetry = latestArtifactOfKind(latest.artifacts, "RetryCheckpoint");
  const latestRetryIndex = lastArtifactIndex(latest.artifacts, "RetryCheckpoint");
  const latestNonterminalCheckpoint = latestRetryIndex > latestTargetAdvanceIndex ? latestRetry : latestTargetAdvance;
  const latestNonterminalCheckpointIndex = Math.max(latestRetryIndex, latestTargetAdvanceIndex);
  if (latestNonterminalCheckpoint && latestNonterminalCheckpointIndex > latestOutcomeIndex
    && latestNonterminalCheckpointIndex > latestBuildIndex) {
    if (latestNonterminalCheckpoint.kind === "RetryCheckpoint"
      && (latestNonterminalCheckpoint.payload.status === "waiting" || latestNonterminalCheckpoint.payload.status === "due")) {
      return { action: "resume", runId: latest.runId, state: "retry_wait", checkpoint: "retry", artifacts: latest.artifacts };
    }
    if (latestNonterminalCheckpoint.kind === "TargetAdvanceCheckpoint") {
      return { action: "resume", runId: latest.runId, state: "target_recovery", checkpoint: "target-advance", artifacts: latest.artifacts };
    }
  }

  const latestVerificationAdjudication = latestArtifactOfKind(latest.artifacts, "VerificationAdjudication");
  const latestVerificationAdjudicationIndex = lastArtifactIndex(latest.artifacts, "VerificationAdjudication");

  if (hasIntent && !latestInvestigation && !latestOutcome && reconciled.state === "investigating") {
    return {
      action: "resume",
      runId: latest.runId,
      state: "investigating",
      checkpoint: "investigation",
      artifacts: latest.artifacts,
    };
  }

  if (hasIntent && latestInvestigation?.payload.outcome === "confirmed" && !hasPacket
    && (!latestOutcome || latestOutcome.payload.status === "failed")) {
    return {
      action: "resume",
      runId: latest.runId,
      state: "preparing",
      checkpoint: "preparation",
      artifacts: latest.artifacts,
    };
  }
  const remediationCheckpointIsPending = remediationCheckpoint !== undefined
    && (remediationCheckpoint.payload.status === "ready-to-resume"
      ? latestRemediationCheckpointIndex > Math.max(latestBuildIndex, latestVerdictIndex, latestOutcomeIndex)
      : latestRemediationCheckpointIndex > Math.max(latestBuildIndex, latestVerdictIndex, latestOutcomeIndex));
  if (remediationCheckpoint && remediationCheckpointIsPending
    && (remediationCheckpoint.payload.status === "awaiting-dispatch"
      || remediationCheckpoint.payload.status === "children-running"
      || remediationCheckpoint.payload.status === "ready-to-resume")) {
    return { action: "resume", runId: latest.runId, state: "blocked", checkpoint: "remediation", artifacts: latest.artifacts };
  }

  if (reconciled.state === "building" && deliveryContext) {
    return { action: "resume", runId: latest.runId, state: "building", checkpoint: "build", artifacts: latest.artifacts };
  }

  // A confirmed target conflict after an approving verdict is a typed,
  // opt-in recovery checkpoint. Keep it ahead of generic verification
  // failure handling so an ordinary `--resume` cannot silently reuse the old
  // approval or treat the conflict as an unrelated builder failure.
  const mergeGate = latestOutcome?.payload.mergeGate;
  const durableGateBaseBranch = build?.payload.targetBranch
    ?? latestOutcome?.payload.targetBranch
    ?? latestOutcome?.payload.failureEvidence?.targetBranch;
  const retainedPullRequest = verdict?.subject.pr
    ?? latestOutcome?.subject.pr
    ?? latest.artifacts.find((artifact) => artifact.subject.pr !== undefined)?.subject.pr;
  const mergeGateIdentityMatches = mergeGate !== undefined
    && retainedPullRequest !== undefined
    && mergeGate.pullRequest === retainedPullRequest
    && (mergeGate.repo === undefined
      || mergeGate.repo.toLowerCase() === (latest.artifacts.find((artifact) => artifact.kind === "Intent")?.subject.repo
        ?? latest.artifacts[0]?.subject.repo
        ?? "").toLowerCase())
    && (durableGateBaseBranch === undefined || mergeGate.baseBranch === durableGateBaseBranch)
    && (verdict?.payload.baseBranch === undefined || mergeGate.baseBranch === verdict.payload.baseBranch);
  const conflictRecoveryPending = deliveryContext
    && reconciled.state === "blocked"
    && latestOutcome?.payload.status === "blocked"
    && mergeGate?.mergeability === "conflicting"
    && mergeGateIdentityMatches
    && build !== undefined
    && verdict !== undefined
    && verdict.payload.disposition === "approve"
    && verdict.payload.headSha === build.payload.headSha
    && mergeGate.headSha === build.payload.headSha
    && latestOutcomeIndex > Math.max(latestBuildIndex, latestVerdictIndex);
  if (conflictRecoveryPending) {
    return {
      action: "resume",
      runId: latest.runId,
      state: "blocked",
      checkpoint: "conflict-recovery",
      artifacts: latest.artifacts,
    };
  }

  // Repository order is durable publication order. Use it rather than worker
  // clocks so equal/skewed timestamps cannot replay superseded failures.
  const sequencedOutcome = latestOutcomeIndex >= 0 ? latest.artifacts[latestOutcomeIndex] : undefined;
  const verificationFailureOutcome = sequencedOutcome?.kind === "Outcome"
    && sequencedOutcome.payload.status === "blocked"
    && sequencedOutcome.payload.failureEvidence !== undefined
    ? sequencedOutcome
    : undefined;
  const pendingVerificationFailure = verificationFailureOutcome !== undefined
    && latestOutcomeIndex >= latestBuildIndex;
  const verificationAdjudicationIsPending = pendingVerificationFailure
    && deliveryContext
    && latestVerificationAdjudication !== undefined
    && latestVerificationAdjudicationIndex > latestOutcomeIndex
    && latestVerificationAdjudication.payload.checkpoint === "verification"
    && latestVerificationAdjudication.payload.decision === "resume"
    && latestVerificationAdjudication.payload.supersedesOutcomeId === verificationFailureOutcome.id;
  if (pendingVerificationFailure) {
    if (verificationAdjudicationIsPending) {
      return { action: "resume", runId: latest.runId, state: "blocked", checkpoint: "verification", artifacts: latest.artifacts };
    }
    if (deliveryContext && isRepairableVerificationFailure(packet, verificationFailureOutcome)) {
      const repairAttempts = verificationRepairAttemptCount(latest.artifacts);
      if (repairAttempts < MAX_VERIFICATION_REPAIR_ATTEMPTS) {
        return { action: "resume", runId: latest.runId, state: "building", checkpoint: "build", artifacts: latest.artifacts };
      }
      return {
        action: "block",
        runId: latest.runId,
        state: "blocked",
        reason: `Verification repair budget exhausted after ${MAX_VERIFICATION_REPAIR_ATTEMPTS} repair attempt(s)`,
      };
    }
    return { action: "resume", runId: latest.runId, state: "blocked", checkpoint: "verification", artifacts: latest.artifacts };
  }

  // A newer verified head means build/remediation and verification completed,
  // but publication or review did not durably finish. Republishing is
  // idempotent and starts an entirely fresh review without replaying build.
  const verifiedAfterLatestVerdict = build && latestBuildIndex > latestVerdictIndex;
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
    const interruptedRemediation = !outcome || outcome.payload.status === "failed" || latestVerdictIndex > latestOutcomeIndex;
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

function isRepairableCheckFailure(check: CheckResult): boolean {
  if (check.regression === false || check.failureClass === "infrastructure") return false;
  // Backward compatibility for failure evidence written before failureClass
  // became part of the durable check schema.
  return !(check.failureClass === undefined
    && check.exitCode === undefined
    && /^Failed to start verification command \([^)]+\)$/i.test(check.summary ?? ""));
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

function normalizeRepoPath(path: string): string {
  return path.replaceAll("\\", "/").replace(/^(?:\.\/)+/, "").replace(/\/$/, "");
}

export function latestArtifactOfKind<K extends DurableArtifact["kind"]>(
  artifacts: readonly DurableArtifact[],
  kind: K,
): Extract<DurableArtifact, { kind: K }> | undefined {
  for (let index = artifacts.length - 1; index >= 0; index--) {
    const artifact = artifacts[index];
    if (artifact?.kind === kind) return artifact as Extract<DurableArtifact, { kind: K }>;
  }
  return undefined;
}
