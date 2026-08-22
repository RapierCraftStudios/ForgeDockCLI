// SPDX-License-Identifier: AGPL-3.0-or-later

import { createHash } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { relative, resolve, sep, isAbsolute } from "node:path";
import { Check } from "typebox/value";
import { classifyRetryableError, type RetryClassification } from "../../core/retry.js";
import { createArtifact, type DurableArtifact } from "../../core/artifacts/schema.js";
import type { ForgeHost, PullRequestSnapshot } from "../../core/ports/forge-host.js";
import type { EffectiveReviewCiConfig } from "../../core/config/forgedock-config.js";
import { AdvertisedRemoteHeadMismatchError, type GitWorkspace, type GitWorkspaceManager, type PullRequestRepairWorkspaceManager } from "../../core/ports/git-workspace.js";
import type { ArtifactRepository, RunRepository } from "../../core/ports/repositories.js";
import { LeaseContinuityError, type LeaseGuard } from "../../core/ports/lease.js";
import type { CheckResult, VerificationCommand, VerificationRunner } from "../../core/ports/verification.js";
import type { TelemetryRepository } from "../../core/ports/telemetry.js";
import {
  isRepairableVerificationFailure,
  MAX_VERIFICATION_REPAIR_ATTEMPTS,
} from "../../core/state/admission.js";
import { attachArtifact, transition, type RunState } from "../../core/state/machine.js";
import type { AgentEventSink, AgentRuntime, ScopeHints } from "../../runtime/agent-runtime.js";
import { canonicalizeConcreteScopePaths, isConcreteScopePath, scopeManifestForBuildPacket, STANDARD_SCOPE_METADATA_ROOTS, isRecoverableAgentExecutionError } from "../../runtime/agent-runtime.js";
import { ClaimPromotionRecoveryError } from "../../runtime/orchestration-claim-transport.js";
import { buildWorkItem, type BuilderSubmission, VerificationDiagnosisSchema, type VerificationDiagnosis } from "./build.js";
import { completeInvalidWorkItem, completeWorkItem } from "./complete.js";
import {
  deterministicOutcomeId,
  investigateWorkItem,
  resumeInvestigationWorkItem,
  WorkflowExecutionError,
} from "./investigate.js";
import { CONTROLLER_VERIFICATION_GATES, prepareBuildPacket, selectPacketVerificationCommands } from "./prepare.js";
import { certifyRelationGraphCheckpoint } from "../../core/packet/relation-checkpoint-certification.js";
import { validateInvestigationScopeReceipt, revalidateInvestigationScopeEvidence } from "../../core/packet/investigation-scope.js";
import { ClaimPromotionConflictError } from "../orchestrate/scheduler.js";
import { assertTargetHeadUnchanged, TargetBranchAdvancedError } from "./publish.js";
import { publishPullRequest } from "./publish.js";
import { publishRemediationRevision } from "./publish-revision.js";
import { remediateReview } from "./remediate.js";
import { recoverVerificationCheckpoint, verificationProgressRecorder, verifyAndCommit, verifyCommittedRepair, deliveryContentDigest, VerificationDiagnosisCallbackError, type VerificationResult } from "./verify.js";
import { recoverConflictingRevision, resolvePacketConflicts, resolvePacketConflictsForPacket } from "./conflict-recovery.js";
import { materializeReviewFindings, resumeReviewFindingProjection, reviewPullRequest } from "../review-pr/review.js";
import { makePullRequestCiGreen } from "../review-pr/fix-ci.js";
import { RemediationSupervisor, verifyParentRevision } from "../orchestrate/remediation.js";
import type { RemediationFindingInput } from "../orchestrate/remediation.js";
import type { BatchMemberContract } from "../orchestrate/batching.js";
import { repositoryPathFromLocation } from "../review-pr/scope.js";
import { assertParentRemediationTarget, assertRunTargetsBranch, laneEvidence, runTargetForLane, type IssueLane, type ParentRemediationTarget } from "./lane.js";
import { normalizedTargetRouteClaim, persistTargetAdvanceCheckpoint, TARGET_RECOVERY_MAX_ATTEMPTS } from "./target-recovery.js";
import { persistRetryCheckpoint } from "../../core/state/retry-checkpoint.js";
import { expandInvariantMatrix } from "./invariant-matrix.js";

export { repositoryPathFromLocation } from "../review-pr/scope.js";

export interface WorkOnDependencies {
  runtime: AgentRuntime;
  artifacts: ArtifactRepository;
  runs: RunRepository;
  git: GitWorkspaceManager;
  verifier: VerificationRunner;
  host: ForgeHost;
  telemetry?: TelemetryRepository;
  /** Controller-owned fencing guard checked before every dependent mutation. */
  /** Route claim must be held before any target-sensitive recovery mutation. */
  promoteTargetRouteClaim?: () => Promise<void>;
  leaseGuard?: LeaseGuard;
  onAgentEvent?: AgentEventSink;
  /** Repository-owned target-aware CI admission policy. */
  ciPolicy?: EffectiveReviewCiConfig;
  /** Optional controller capability for bounded same-repository PR CI repair. */
  ciRepairWorkspaces?: PullRequestRepairWorkspaceManager;
}

export interface WorkOnResult {
  run: RunState;
  outcome?: DurableArtifact<"Outcome">;
  pullRequest?: PullRequestSnapshot;
  awaitingHuman?: boolean;
}
function assertTargetRecoveryIdentity(input: TargetAdvanceResumeInput): void {
  const { run, checkpoint, intent, packet, buildResult, workspace, pullRequest } = input;
  if (checkpoint.runId !== run.runId || checkpoint.subject.repo.toLowerCase() !== run.subject.repo.toLowerCase()
    || checkpoint.subject.issue !== run.subject.issue || checkpoint.subject.pr !== run.subject.pr) {
    throw new Error("Target recovery checkpoint run/subject identity does not match the admitted run");
  }
  if (checkpoint.payload.packetArtifactId !== packet.id || packet.runId !== run.runId
    || checkpoint.payload.sourceBuildResultId !== buildResult.id
    || checkpoint.payload.sourceHeadSha.toLowerCase() !== buildResult.payload.headSha.toLowerCase()
    || buildResult.runId !== run.runId || intent.runId !== run.runId) {
    throw new Error("Target recovery packet/build/intent identity does not match the admitted run");
  }
  const checkpointBaseSha = checkpoint.payload.sourceBaseSha.toLowerCase();
  const expectedBaseSha = (buildResult.payload.baseSha ?? workspace.baseSha ?? buildResult.payload.headSha).toLowerCase();
  const { number: recoveryAttempt, max: recoveryMax } = checkpoint.payload.attempt;
  if (checkpointBaseSha !== expectedBaseSha) {
    throw new Error("Target recovery checkpoint source base does not match the retained build/fallback base");
  }
  if (!Number.isSafeInteger(recoveryAttempt) || recoveryAttempt < 1
    || !Number.isSafeInteger(recoveryMax) || recoveryMax < 1
    || recoveryAttempt > recoveryMax || recoveryMax > TARGET_RECOVERY_MAX_ATTEMPTS) {
    throw new Error(`Target recovery checkpoint attempt must satisfy 1 <= number <= max <= ${TARGET_RECOVERY_MAX_ATTEMPTS}`);
  }
  const retainedHead = checkpoint.payload.freshBuildResultId && checkpoint.payload.phase !== "target-read"
    ? (checkpoint.payload.integrationHeadSha ?? checkpoint.payload.mergeHeadSha ?? checkpoint.payload.sourceHeadSha)
    : checkpoint.payload.sourceHeadSha;
  if (pullRequest !== undefined
    && (pullRequest.repo.toLowerCase() !== checkpoint.payload.repository.toLowerCase()
      || pullRequest.number !== checkpoint.payload.pullRequest && checkpoint.payload.pullRequest !== undefined
      || pullRequest.baseBranch !== checkpoint.payload.targetBranch
      || pullRequest.headBranch !== workspace.branch
      || pullRequest.headSha.toLowerCase() !== retainedHead.toLowerCase())) {
    throw new Error("Target recovery checkpoint does not match the retained pull request route or head");
  }
  if (checkpoint.payload.targetBranch !== run.targetBranch || checkpoint.payload.repository.toLowerCase() !== run.subject.repo.toLowerCase()) {
    throw new Error("Target recovery checkpoint target route does not match the admitted run");
  }
  if (checkpoint.payload.sourceVerdictId !== undefined && input.priorVerdict?.id !== checkpoint.payload.sourceVerdictId) {
    throw new Error("Target recovery checkpoint source verdict does not match the retained PR verdict");
  }
  if (checkpoint.payload.sourceVerdictId === undefined && input.priorVerdict !== undefined && checkpoint.payload.phase !== "target-read") {
    throw new Error("Target recovery retained an unexpected source verdict");
  }
  if (checkpoint.payload.routeClaimKey !== normalizedTargetRouteClaim(checkpoint.payload.repository, checkpoint.payload.targetBranch)
    || JSON.stringify([...checkpoint.payload.expectedPaths].sort()) !== JSON.stringify([...packet.payload.expectedPaths].sort())) {
    throw new Error("Target recovery checkpoint route or frozen packet scope does not match the run");
  }
  const verificationPlanId = createHash("sha256").update(JSON.stringify(packet.payload.verificationPlan)).digest("hex");
  if (checkpoint.payload.verificationPlanId !== verificationPlanId) throw new Error("Target recovery checkpoint verification plan is stale");
  if (!workspace.path || !workspace.branch || !workspace.baseRef
    || checkpoint.payload.workspace.branch !== workspace.branch || checkpoint.payload.workspace.baseRef !== workspace.baseRef
    || !workspacePathsEquivalent(checkpoint.payload.workspace.path, workspace.path)) {
    throw new Error("Target recovery workspace does not match the canonical checkpoint workspace");
  }
}

async function assertTargetReceiptChain(input: TargetAdvanceResumeInput, artifacts: ArtifactRepository): Promise<void> {
  const payload = input.checkpoint.payload;
  const ordered = await artifacts.list(input.run.subject);
  const requireField = (value: string | undefined, label: string): string => {
    if (!value) throw new Error(`Target recovery ${payload.phase} receipt is missing ${label}`);
    return value;
  };
  if (payload.phase === "integrated" || payload.phase === "verified" || payload.phase === "fenced" || payload.phase === "pushed" || payload.phase === "reviewed") {
    const integration = requireField(payload.integrationHeadSha, "integration head");
    const merge = requireField(payload.mergeHeadSha, "merge head");
    if (integration.toLowerCase() !== merge.toLowerCase()) throw new Error("Target recovery integration and merge receipts disagree");
  }
  if (payload.phase === "verified" || payload.phase === "fenced" || payload.phase === "pushed" || payload.phase === "reviewed") {
    const verificationId = requireField(payload.freshVerificationCheckpointId, "fresh verification checkpoint");
    const buildId = requireField(payload.freshBuildResultId, "fresh BuildResult");
    const verification = ordered.find((artifact): artifact is DurableArtifact<"VerificationCheckpoint"> => artifact.kind === "VerificationCheckpoint" && artifact.id === verificationId);
    const fresh = ordered.find((artifact): artifact is DurableArtifact<"BuildResult"> => artifact.kind === "BuildResult" && artifact.id === buildId);
    if (!verification || !fresh || verification.runId !== input.run.runId || fresh.runId !== input.run.runId) throw new Error("Target recovery fresh receipt references are missing or cross-run");
    if (fresh.payload.headSha.toLowerCase() !== payload.integrationHeadSha!.toLowerCase() || verification.payload.verifiedContentDigest !== payload.verifiedContentDigest) throw new Error("Target recovery fresh receipt content or head proof is stale");
    if (fresh.payload.baseSha?.toLowerCase() !== payload.observedTargetSha.toLowerCase() || verification.payload.baseSha.toLowerCase() !== payload.observedTargetSha.toLowerCase()) throw new Error("Target recovery fresh receipt base is stale");
  }
  if (payload.phase === "pushed" || payload.phase === "reviewed") {
    const pushed = requireField(payload.pushedHeadSha, "pushed head");
    if (payload.pullRequest === undefined) throw new Error(`Target recovery ${payload.phase} receipt is missing pull request identity`);
    if (pushed.toLowerCase() !== payload.integrationHeadSha!.toLowerCase()) throw new Error("Target recovery pushed head receipt is stale");
  }
}

export interface TargetAdvanceResumeInput {
  run: RunState;
  checkpoint: DurableArtifact<"TargetAdvanceCheckpoint">;
  intent: DurableArtifact<"Intent">;
  investigation: DurableArtifact<"Investigation">;
  packet: DurableArtifact<"BuildPacket">;
  /** Source BuildResult named by checkpoint.sourceBuildResultId. */
  buildResult: DurableArtifact<"BuildResult">;
  /** Fresh recovered BuildResult, when a crash occurred after verification. */
  freshBuildResult?: DurableArtifact<"BuildResult">;
  pullRequest?: PullRequestSnapshot;
  workspace: GitWorkspace;
  verification: readonly Omit<VerificationCommand, "cwd">[];
  resolveVerificationCatalog?: VerificationCatalogResolver;
  /** Admission evidence only; it is never passed to a fresh review. */
  priorVerdict?: DurableArtifact<"ReviewVerdict">;
  signal?: AbortSignal;
}

type VerificationCatalogResolver = (
  baseSha: string,
) => readonly Omit<VerificationCommand, "cwd">[] | Promise<readonly Omit<VerificationCommand, "cwd">[]>;

/** from the exact retained worktree. Every
 * target-sensitive operation is fenced by the caller's lease and route claim;
 * this function never reuses the old approval as a verdict for the new head.
 */
async function resumeTargetAdvanceWorkOnInternal(
  input: TargetAdvanceResumeInput,
  dependencies: WorkOnDependencies,
): Promise<WorkOnResult & { buildResult: DurableArtifact<"BuildResult"> }> {
  dependencies = guardMutationBoundaries(dependencies);
  if (input.run.state !== "target_recovery" && input.run.state !== "retry_wait") {
    throw new Error(`Target recovery requires target_recovery or retry_wait state, found ${input.run.state}`);
  }
  const checkpoint = input.checkpoint.payload;
  if (checkpoint.phase === "reviewed") {
    throw new Error("Target recovery checkpoint is already reviewed and cannot be republished");
  }
  const pullRequest = input.pullRequest;
  assertTargetRecoveryIdentity(input);
  await assertTargetReceiptChain(input, dependencies.artifacts);
  assertLease(dependencies);
  if (dependencies.promoteTargetRouteClaim) {
    await dependencies.promoteTargetRouteClaim();
    assertLease(dependencies);
  }
  if (!dependencies.host.getBranchHead || !dependencies.git.integrateRemoteBase) {
    throw new Error("Target recovery requires authoritative branch reads and exact remote-base integration");
  }
  let run = input.run;
  const resumed = transition(run, run.state === "retry_wait" ? "RETRY_DUE" : "RESUME_TARGET_ADVANCE", {
    reason: `Recovering ${checkpoint.routeClaimKey} at source ${checkpoint.sourceHeadSha}`,
  });
  await dependencies.runs.commit(run.version, resumed.state, resumed.record);
  run = resumed.state;
  const targetRepository = checkpoint.repository;
  const getBranchHead = dependencies.host.getBranchHead;
  const scheduleTargetRetry = async (error: unknown, phase: "integrated" | "verified" | "target-read"): Promise<never> => {
    const reason = error instanceof Error ? error.message : String(error);
    const observed = await getBranchHead(targetRepository, checkpoint.targetBranch).catch(() => undefined);
    const observedTargetSha = observed && /^[0-9a-f]{7,64}$/i.test(observed) ? observed : checkpoint.sourceBaseSha;
    const attempt = checkpoint.attempt.number + 1;
    const checkpointArtifact = await persistTargetAdvanceCheckpoint({
      run, packet: input.packet, buildResult: input.buildResult, workspace: input.workspace,
      targetBranch: checkpoint.targetBranch, observedTargetSha, phase,
      attempt, maxAttempts: checkpoint.attempt.max, artifacts: dependencies.artifacts,
      ...(input.priorVerdict !== undefined ? { verdict: input.priorVerdict } : {}),
    });
    const retryCheckpoint = await persistRetryCheckpoint({
      artifacts: dependencies.artifacts,
      runId: run.runId,
      subject: run.subject,
      domain: "workflow",
      code: "target-advanced",
      phase,
      operationKey: `target-advanced:${checkpoint.routeClaimKey}`,
      semanticKey: checkpoint.routeClaimKey,
      artifactIds: [input.checkpoint.id, ...(checkpointArtifact ? [checkpointArtifact.id] : [])],
      attempt,
      maxAttempts: checkpoint.attempt.max,
      retryAfterMs: 1_000,
      status: attempt >= checkpoint.attempt.max ? "exhausted" : "waiting",
      cause: error,
    });
    if (attempt >= checkpoint.attempt.max) {
      const exhaustedOutcome = createArtifact({
        kind: "Outcome", runId: run.runId, subject: run.subject,
        producer: { role: "controller", runtime: "forgedock" },
        payload: {
          status: "blocked",
          reason: `Target advancement recovery exhausted after ${checkpoint.attempt.max} attempts: ${reason}`,
          ...(run.targetBranch ? { targetBranch: run.targetBranch } : {}),
          childIssues: [],
          targetRecovery: {
            checkpointId: checkpointArtifact?.id ?? input.checkpoint.id,
            phase,
            cause: reason,
            attempt: { number: attempt, max: checkpoint.attempt.max },
          },
          supersedes: checkpointArtifact?.id ?? input.checkpoint.id,
        },
      }, { id: `target_exhausted_${createHash("sha256").update(`${run.runId}:${checkpoint.routeClaimKey}:${checkpoint.attempt.max}`).digest("hex").slice(0, 32)}` });
      await dependencies.artifacts.append(exhaustedOutcome);
      const blocked = transition(attachArtifact(run, "Outcome", exhaustedOutcome.id), "BLOCK", { reason: exhaustedOutcome.payload.reason });
      await dependencies.runs.commit(run.version, blocked.state, blocked.record);
      throw new WorkflowExecutionError(blocked.record.reason ?? reason, blocked.state, {
        cause: error,
        recoverable: false,
        retryDisposition: {
          disposition: "permanent", retryable: false, domain: "workflow", code: "target-advance-exhausted",
          cause: error instanceof Error ? error : new Error(reason),
        },
        ...(checkpointArtifact ? { targetAdvanceCheckpointId: checkpointArtifact.id } : {}),
        retryCheckpointId: retryCheckpoint.id,
      });
    }
    const recovery = run.state === "target_recovery"
      ? { state: run, record: undefined }
      : transition(run, "TARGET_ADVANCE_DETECTED", { reason });
    const wait = transition(recovery.state, "RETRY_WAIT_SCHEDULED", { reason });
    if (recovery.record) await dependencies.runs.commit(run.version, recovery.state, recovery.record);
    await dependencies.runs.commit(recovery.state.version, wait.state, wait.record);
    const retryDisposition: RetryClassification = {
      disposition: "retryable", retryable: true, domain: "workflow", code: "target-advanced",
      cause: error instanceof Error ? error : new Error(reason),
    };
    throw new WorkflowExecutionError(reason, wait.state, {
      cause: error, recoverable: true, retryDisposition,
      ...(checkpointArtifact ? { targetAdvanceCheckpointId: checkpointArtifact.id } : {}),
      retryCheckpointId: retryCheckpoint.id,
    });
  };
  let targetSha: string;
  const recoveredFresh = input.freshBuildResult
    ?? (checkpoint.freshBuildResultId
      ? (await dependencies.artifacts.list(run.subject, "BuildResult")).find((artifact): artifact is DurableArtifact<"BuildResult"> => artifact.kind === "BuildResult" && artifact.id === checkpoint.freshBuildResultId)
      : undefined);
  if (recoveredFresh && checkpoint.freshBuildResultId && checkpoint.phase !== "target-read") {
    if (recoveredFresh.runId !== run.runId || recoveredFresh.payload.baseSha?.toLowerCase() !== checkpoint.observedTargetSha.toLowerCase()
      || recoveredFresh.payload.headSha.toLowerCase() !== (checkpoint.integrationHeadSha ?? checkpoint.mergeHeadSha ?? recoveredFresh.payload.headSha).toLowerCase()) {
      throw new Error("Target recovery fresh BuildResult receipt is stale or does not match the checkpoint");
    }
    targetSha = await getBranchHead(targetRepository, checkpoint.targetBranch);
    if (targetSha.toLowerCase() !== checkpoint.observedTargetSha.toLowerCase()) {
      return scheduleTargetRetry(new TargetBranchAdvancedError(checkpoint.targetBranch, checkpoint.observedTargetSha, targetSha), "target-read");
    }
    const recoveredHead = await dependencies.git.head(input.workspace);
    if (recoveredHead.toLowerCase() !== recoveredFresh.payload.headSha.toLowerCase()) {
      throw new Error("Retained target recovery workspace is not at the durably verified fresh head");
    }
    let recoveredRun = attachArtifact(attachArtifact(run, "VerificationCheckpoint", checkpoint.freshVerificationCheckpointId ?? ""), "BuildResult", recoveredFresh.id);
    const publishing = transition(recoveredRun, "TARGET_ADVANCE_COMPLETED", { headSha: recoveredFresh.payload.headSha });
    await dependencies.runs.commit(recoveredRun.version, publishing.state, publishing.record);
    recoveredRun = publishing.state;
    if (checkpoint.phase === "verified") {
      await persistTargetAdvanceCheckpoint({
        run: recoveredRun, packet: input.packet, buildResult: recoveredFresh, sourceBuildResult: input.buildResult,
        workspace: input.workspace, targetBranch: checkpoint.targetBranch, observedTargetSha: targetSha, phase: "fenced",
        attempt: checkpoint.attempt.number, maxAttempts: checkpoint.attempt.max,
        ...(input.priorVerdict !== undefined ? { verdict: input.priorVerdict } : {}),
        ...(checkpoint.freshVerificationCheckpointId ? { freshVerificationCheckpointId: checkpoint.freshVerificationCheckpointId } : {}),
        freshBuildResultId: recoveredFresh.id,
        integrationHeadSha: checkpoint.integrationHeadSha ?? recoveredFresh.payload.headSha,
        mergeHeadSha: checkpoint.mergeHeadSha ?? recoveredFresh.payload.headSha,
        ...(pullRequest !== undefined ? { pullRequest: pullRequest.number } : {}), artifacts: dependencies.artifacts,
      });
    }
    const published = pullRequest
      ? await publishRemediationRevision({ run: recoveredRun, pullRequest, packet: input.packet, buildResult: recoveredFresh, workspace: input.workspace, expectedTargetHeadSha: targetSha }, { git: dependencies.git, host: dependencies.host, runs: dependencies.runs, artifacts: dependencies.artifacts })
      : await publishPullRequest({ run: recoveredRun, intent: input.intent, packet: input.packet, buildResult: recoveredFresh, workspace: input.workspace }, { git: dependencies.git, host: dependencies.host, runs: dependencies.runs, artifacts: dependencies.artifacts });
    await persistTargetAdvanceCheckpoint({
      run: published.run, packet: input.packet, buildResult: recoveredFresh, sourceBuildResult: input.buildResult,
      workspace: input.workspace, targetBranch: checkpoint.targetBranch, observedTargetSha: targetSha, phase: "pushed",
      attempt: checkpoint.attempt.number, maxAttempts: checkpoint.attempt.max,
      ...(input.priorVerdict !== undefined ? { verdict: input.priorVerdict } : {}),
      ...(checkpoint.freshVerificationCheckpointId ? { freshVerificationCheckpointId: checkpoint.freshVerificationCheckpointId } : {}), freshBuildResultId: recoveredFresh.id,
      integrationHeadSha: checkpoint.integrationHeadSha ?? recoveredFresh.payload.headSha,
      mergeHeadSha: checkpoint.mergeHeadSha ?? recoveredFresh.payload.headSha,
      pullRequest: published.pullRequest.number, pushedHeadSha: published.pullRequest.headSha, artifacts: dependencies.artifacts,
    });
    const reviewed = await reviewPullRequest({
      run: published.run, pullRequest: published.pullRequest, intent: input.intent, investigation: input.investigation,
      packet: input.packet, buildResult: recoveredFresh, workspace: input.workspace.path, findingIssuePolicy: "all", reviewCycle: { current: 1, total: 1 },
    }, { runtime: dependencies.runtime, host: dependencies.host, artifacts: dependencies.artifacts, runs: dependencies.runs,
      ...(dependencies.onAgentEvent !== undefined ? { onAgentEvent: dependencies.onAgentEvent } : {}) });
    await persistTargetAdvanceCheckpoint({
      run: reviewed.run, packet: input.packet, buildResult: recoveredFresh, sourceBuildResult: input.buildResult,
      workspace: input.workspace, targetBranch: checkpoint.targetBranch, observedTargetSha: targetSha, phase: "reviewed",
      attempt: checkpoint.attempt.number, maxAttempts: checkpoint.attempt.max,
      ...(input.priorVerdict !== undefined ? { verdict: input.priorVerdict } : {}),
      ...(checkpoint.freshVerificationCheckpointId ? { freshVerificationCheckpointId: checkpoint.freshVerificationCheckpointId } : {}), freshBuildResultId: recoveredFresh.id,
      integrationHeadSha: checkpoint.integrationHeadSha ?? recoveredFresh.payload.headSha,
      mergeHeadSha: checkpoint.mergeHeadSha ?? recoveredFresh.payload.headSha,
      pullRequest: published.pullRequest.number, pushedHeadSha: published.pullRequest.headSha, artifacts: dependencies.artifacts,
    });
    return { run: reviewed.run, pullRequest: published.pullRequest, buildResult: recoveredFresh };
  }
  try {
    targetSha = await getBranchHead(targetRepository, checkpoint.targetBranch);
  } catch (error) {
    return scheduleTargetRetry(error, "target-read");
  }
  if (!/^[0-9a-f]{7,64}$/i.test(targetSha)) throw new Error("Authoritative target read is not a Git SHA");
  if (targetSha.toLowerCase() === checkpoint.sourceBaseSha.toLowerCase()) {
    throw new Error(`Target ${checkpoint.targetBranch} has not advanced beyond ${checkpoint.sourceBaseSha}`);
  }
  let integrated;
  try {
    integrated = await dependencies.git.integrateRemoteBase(input.workspace, {
      expectedHeadSha: checkpoint.sourceHeadSha,
      expectedBaseSha: targetSha,
    });
  } catch (error) {
    const observed = await getBranchHead(targetRepository, checkpoint.targetBranch).catch(() => targetSha);
    const classification = classifyRetryableError(error, { domain: "workflow" });
    if (error instanceof TargetBranchAdvancedError || observed.toLowerCase() !== targetSha.toLowerCase() || classification.retryable) {
      return scheduleTargetRetry(error, "integrated");
    }
    throw error;
  }
  let workspace = integrated.workspace;
  await persistTargetAdvanceCheckpoint({
    run, packet: input.packet, buildResult: input.buildResult, workspace,
    targetBranch: checkpoint.targetBranch, observedTargetSha: targetSha, phase: "integrated",
    attempt: checkpoint.attempt.number, maxAttempts: checkpoint.attempt.max,
    artifacts: dependencies.artifacts,
  });
  const conflictPaths = canonicalizeConcreteScopePaths(integrated.conflictPaths).sort();
  const expectedPaths = new Set(canonicalizeConcreteScopePaths(checkpoint.expectedPaths));
  const outside = conflictPaths.filter((path) => !expectedPaths.has(path));
  if (outside.length) throw new Error(`Target merge conflicts outside frozen packet: ${outside.join(", ")}`);
  if (conflictPaths.length) {
    const resolved = await (pullRequest
      ? (!dependencies.git.unmergedPaths || !dependencies.git.stageConflictResolutions || !input.priorVerdict
        ? (() => { throw new Error("Target conflict recovery cannot prove resolver admission or index completion"); })()
        : resolvePacketConflicts({
          input: {
            run, intent: input.intent, investigation: input.investigation, packet: input.packet,
            buildResult: input.buildResult, verdict: input.priorVerdict, pullRequest,
            workspace, commands: input.verification.map((command) => ({ ...command, cwd: workspace.path })),
            mergeGate: { repo: pullRequest.repo, mergeability: "conflicting", mergeable: false, headSha: checkpoint.sourceHeadSha, baseBranch: checkpoint.targetBranch, pullRequest: pullRequest.number, requiredChecks: [], observedAt: new Date().toISOString() },
            ...(input.signal !== undefined ? { signal: input.signal } : {}),
          },
          workspace,
          conflictPaths,
          dependencies: {
            runtime: dependencies.runtime, artifacts: dependencies.artifacts, runs: dependencies.runs,
            git: dependencies.git, verifier: dependencies.verifier, host: dependencies.host,
            ...(dependencies.onAgentEvent !== undefined ? { onAgentEvent: dependencies.onAgentEvent } : {}),
          },
        }))
      : resolvePacketConflictsForPacket({
        run, intent: input.intent, investigation: input.investigation, packet: input.packet,
        buildResult: input.buildResult, workspace, conflictPaths,
        ...(input.priorVerdict !== undefined ? { priorVerdict: input.priorVerdict } : {}),
        ...(input.signal !== undefined ? { signal: input.signal } : {}),
      }, {
        runtime: dependencies.runtime, artifacts: dependencies.artifacts, runs: dependencies.runs,
        git: dependencies.git, verifier: dependencies.verifier, host: dependencies.host,
        ...(dependencies.onAgentEvent !== undefined ? { onAgentEvent: dependencies.onAgentEvent } : {}),
      }));
    const reported = canonicalizeConcreteScopePaths(resolved.changedPaths).sort();
    if (JSON.stringify(reported) !== JSON.stringify(conflictPaths)) throw new Error("Conflict resolver report does not exactly match unmerged paths");
    if (!dependencies.git.stageConflictResolutions || !dependencies.git.unmergedPaths) {
      throw new Error("Target conflict recovery cannot prove index completion");
    }
    await dependencies.git.stageConflictResolutions(workspace, conflictPaths);
    const unresolved = canonicalizeConcreteScopePaths(await dependencies.git.unmergedPaths(workspace)).sort();
    if (unresolved.length) throw new Error(`Unmerged paths remain after packet conflict resolution: ${unresolved.join(", ")}`);
  }
  if (!integrated.mergeCommitExists) await dependencies.git.commit(workspace, `forge: synchronize issue ${run.subject.issue ?? "work item"} with ${checkpoint.targetBranch}`);
  workspace.baseSha = targetSha;
  const newHead = await dependencies.git.head(workspace);
  if (newHead.toLowerCase() === checkpoint.sourceHeadSha.toLowerCase()
    || !await dependencies.git.isAncestor(workspace, checkpoint.sourceHeadSha, newHead)) {
    throw new Error("Synchronized target recovery head is not a descendant of the reviewed head");
  }
  const changedPaths = canonicalizeConcreteScopePaths(await dependencies.git.revisionChangedPaths(workspace)).sort();
  await persistTargetAdvanceCheckpoint({
    run, packet: input.packet, buildResult: input.buildResult, workspace, targetBranch: checkpoint.targetBranch,
    observedTargetSha: targetSha, phase: "integrated", attempt: checkpoint.attempt.number, maxAttempts: checkpoint.attempt.max,
    ...(input.priorVerdict !== undefined ? { verdict: input.priorVerdict } : {}), integrationHeadSha: newHead, mergeHeadSha: newHead,
    artifacts: dependencies.artifacts,
  });
  if (changedPaths.some((path) => !expectedPaths.has(path))) throw new Error("Synchronized revision broadened the frozen packet scope");
  const catalog = input.resolveVerificationCatalog
    ? await input.resolveVerificationCatalog(targetSha)
    : input.verification;
  await certifyPacketRelationAuthority(input.packet, workspace.path, targetSha, dependencies.artifacts);
  const frozenVerification = selectPacketVerificationCommands(input.packet.payload, catalog, targetSha);
  const commands = frozenVerification.map((command) => ({ ...command, cwd: workspace.path }));
  let checks: CheckResult[];
  try {
    checks = await dependencies.verifier.run(commands, input.signal);
  } catch (error) {
    const observed = await getBranchHead(targetRepository, checkpoint.targetBranch).catch(() => targetSha);
    const classification = classifyRetryableError(error, { domain: "workflow" });
    if (error instanceof TargetBranchAdvancedError || observed.toLowerCase() !== targetSha.toLowerCase() || classification.retryable) {
      return scheduleTargetRetry(error, "verified");
    }
    throw error;
  }
  if (commands.some((command, index) => command.required && checks[index]?.status !== "passed")) throw new Error("Frozen verification plan failed after target recovery");
  let postTarget: string;
  try {
    postTarget = await getBranchHead(targetRepository, checkpoint.targetBranch);
    if (postTarget.toLowerCase() !== targetSha.toLowerCase()) throw new TargetBranchAdvancedError(checkpoint.targetBranch, targetSha, postTarget);
  } catch (error) {
    const classification = classifyRetryableError(error, { domain: "workflow" });
    if (error instanceof TargetBranchAdvancedError || classification.retryable) return scheduleTargetRetry(error, "target-read");
    throw error;
  }
  const postHead = await dependencies.git.head(workspace);
  if (postHead.toLowerCase() !== newHead.toLowerCase() || (await dependencies.git.changedPaths(workspace)).length) throw new Error("Retained workspace mutated during target recovery verification");
  if (!dependencies.git.committedContentMatches) throw new Error("Target recovery requires committed regular-file content proof");
  const freshContentDigest = await deliveryContentDigest(workspace.path, changedPaths);
  const contentMatches = await dependencies.git.committedContentMatches(workspace, changedPaths, freshContentDigest, newHead);
  if (!contentMatches) throw new Error("Recovered committed content does not match the verified mutation digest");
  const verificationCheckpoint = createArtifact({
    kind: "VerificationCheckpoint", runId: run.runId, subject: run.subject, producer: { role: "controller", runtime: "forgedock" },
    payload: {
      checkpoint: "verified-commit", branch: workspace.branch, targetBranch: checkpoint.targetBranch, baseSha: targetSha,
      parentHeadSha: checkpoint.sourceHeadSha, changedPaths, pendingChangedPaths: changedPaths,
      verifiedContentDigest: freshContentDigest, commitMessage: `forge: synchronize issue ${run.subject.issue ?? "work item"} with ${checkpoint.targetBranch}`,
      summary: `Fresh target-recovery verification for ${newHead}.`, acceptanceEvidence: await freshTargetRecoveryEvidence(input.packet, input.buildResult, checks, changedPaths, expectedPaths, frozenVerification, workspace.path),
      checks, decisions: [`Target recovery rebased ${checkpoint.sourceHeadSha} onto ${targetSha}.`], residualRisks: [],
    },
  });
  await dependencies.artifacts.append(verificationCheckpoint);
  const freshBuildResult = createArtifact({
    kind: "BuildResult", runId: run.runId, subject: run.subject, producer: { role: "controller", runtime: "forgedock" },
    payload: {
      ...input.buildResult.payload, branch: workspace.branch, targetBranch: checkpoint.targetBranch, headSha: newHead, baseSha: targetSha,
      changedPaths, summary: `Fresh target-recovery build ${newHead}.`, checks,
      acceptanceEvidence: verificationCheckpoint.payload.acceptanceEvidence,
    },
  });
  await dependencies.artifacts.append(freshBuildResult);
  const verifiedTargetCheckpoint = await persistTargetAdvanceCheckpoint({
    run, packet: input.packet, buildResult: freshBuildResult, sourceBuildResult: input.buildResult, workspace,
    targetBranch: checkpoint.targetBranch, observedTargetSha: targetSha, phase: "verified",
    attempt: checkpoint.attempt.number, maxAttempts: checkpoint.attempt.max,
    ...(input.priorVerdict !== undefined ? { verdict: input.priorVerdict } : {}),
    freshVerificationCheckpointId: verificationCheckpoint.id,
    freshBuildResultId: freshBuildResult.id,
    integrationHeadSha: newHead,
    mergeHeadSha: newHead,
    ...(pullRequest !== undefined ? { pullRequest: pullRequest.number } : {}),
    artifacts: dependencies.artifacts,
  });
  run = attachArtifact(run, "VerificationCheckpoint", verificationCheckpoint.id);
  run = attachArtifact(run, "BuildResult", freshBuildResult.id);
  const publishing = transition(run, "TARGET_ADVANCE_COMPLETED", { headSha: newHead });
  await dependencies.runs.commit(run.version, publishing.state, publishing.record);
  const fencedTargetCheckpoint = await persistTargetAdvanceCheckpoint({
    run: publishing.state, packet: input.packet, buildResult: freshBuildResult, sourceBuildResult: input.buildResult, workspace,
    targetBranch: checkpoint.targetBranch, observedTargetSha: targetSha, phase: "fenced",
    attempt: checkpoint.attempt.number, maxAttempts: checkpoint.attempt.max,
    freshVerificationCheckpointId: verificationCheckpoint.id,
    freshBuildResultId: freshBuildResult.id,
    integrationHeadSha: newHead,
    mergeHeadSha: newHead,
    ...(pullRequest !== undefined ? { pullRequest: pullRequest.number } : {}),
    artifacts: dependencies.artifacts,
  });
  const published = pullRequest
    ? await publishRemediationRevision({ run: publishing.state, pullRequest, packet: input.packet, buildResult: freshBuildResult, workspace, expectedTargetHeadSha: targetSha }, {
      git: dependencies.git, host: dependencies.host, runs: dependencies.runs, artifacts: dependencies.artifacts,
    })
    : await publishPullRequest({ run: publishing.state, intent: input.intent, packet: input.packet, buildResult: freshBuildResult, workspace }, {
      git: dependencies.git, host: dependencies.host, runs: dependencies.runs, artifacts: dependencies.artifacts,
    });
  const reviewed = await reviewPullRequest({
    run: published.run, pullRequest: published.pullRequest, intent: input.intent,
    investigation: input.investigation, packet: input.packet, buildResult: freshBuildResult,
    workspace: workspace.path, findingIssuePolicy: "all", reviewCycle: { current: 1, total: 1 },
  }, { runtime: dependencies.runtime, host: dependencies.host, artifacts: dependencies.artifacts, runs: dependencies.runs,
    ...(dependencies.onAgentEvent !== undefined ? { onAgentEvent: dependencies.onAgentEvent } : {}) });
  return { run: reviewed.run, pullRequest: published.pullRequest, buildResult: freshBuildResult };
}

/**
 * Convert a permanent failure observed after target integration into a durable
 * terminal projection. Reconciliation must never let the older checkpoint win
 * merely because the exception interrupted the resume call.
 */
export async function resumeTargetAdvanceWorkOn(
  input: TargetAdvanceResumeInput,
  dependencies: WorkOnDependencies,
): Promise<WorkOnResult & { buildResult: DurableArtifact<"BuildResult"> }> {
  try {
    return await resumeTargetAdvanceWorkOnInternal(input, dependencies);
  } catch (error) {
    // Retryable movement/network failures and ownership ambiguity retain their
    // checkpoint. Only a permanent controller error terminalizes the run.
    if ((error instanceof WorkflowExecutionError && error.recoverable)
      || error instanceof LeaseContinuityError
      || error instanceof ClaimPromotionConflictError
      || error instanceof ClaimPromotionRecoveryError
      || input.signal?.aborted === true) {
      throw error;
    }
    const guarded = guardMutationBoundaries(dependencies);
    const artifacts = await guarded.artifacts.list(input.run.subject);
    const preferredCheckpointId = error instanceof WorkflowExecutionError
      ? error.targetAdvanceCheckpointId
      : undefined;
    const terminalCheckpoint = (preferredCheckpointId
      ? artifacts.find((artifact): artifact is DurableArtifact<"TargetAdvanceCheckpoint"> =>
        artifact.kind === "TargetAdvanceCheckpoint"
        && artifact.runId === input.run.runId
        && artifact.id === preferredCheckpointId)
      : undefined)
      ?? artifacts
        .filter((artifact): artifact is DurableArtifact<"TargetAdvanceCheckpoint"> =>
          artifact.kind === "TargetAdvanceCheckpoint" && artifact.runId === input.run.runId)
        .sort((left, right) => left.payload.updatedAt.localeCompare(right.payload.updatedAt) || left.id.localeCompare(right.id))
        .at(-1)
      ?? input.checkpoint;
    const terminalCheckpointId = terminalCheckpoint.id;
    const existing = artifacts.find((artifact): artifact is DurableArtifact<"Outcome"> =>
      artifact.kind === "Outcome"
      && artifact.runId === input.run.runId
      && (artifact.payload.targetRecovery?.checkpointId === terminalCheckpointId
        || artifact.payload.targetRecovery?.checkpointId === input.checkpoint.id)
      && (artifact.payload.status === "failed" || artifact.payload.status === "blocked"));
    const current = await guarded.runs.load(input.run.runId) ?? input.run;
    if (existing) {
      // Preserve a typed terminal error already produced by the inner recovery
      // path (notably target-advance-exhausted); only synthesize lineage when
      // a restart re-enters the same checkpoint with a raw exception.
      if (error instanceof WorkflowExecutionError && !error.recoverable) throw error;
      // A restart may re-enter the same checkpoint after the terminal append;
      // preserve exactly one Outcome and return the original cause/lineage.
      throw new WorkflowExecutionError(existing.payload.reason, current, {
        cause: error,
        recoverable: false,
        retryDisposition: {
          disposition: "permanent", retryable: false, domain: "workflow", code: "target-recovery-terminal",
          cause: error instanceof Error ? error : new Error(String(error)),
        },
        targetAdvanceCheckpointId: terminalCheckpointId,
      });
    }
    const reason = error instanceof Error ? error.message : String(error);
    // Build the transition receipt before the append, but do not commit it
    // until the terminal artifact is durable. This ordering closes the crash
    // window where a failed run could coexist with a resumable checkpoint.
    const terminalTransition = current.state === "failed" || current.state === "blocked"
      ? undefined
      : transition(current, "FAIL", { reason });
    const terminalRun = terminalTransition?.state ?? current;
    const terminal = createArtifact({
      kind: "Outcome",
      runId: input.run.runId,
      subject: input.run.subject,
      producer: { role: "controller", runtime: "forgedock" },
      payload: {
        status: "failed",
        reason,
        ...(terminalRun.targetBranch ? { targetBranch: terminalRun.targetBranch } : {}),
        ...(terminalRun.promotionTarget ? { promotionTarget: terminalRun.promotionTarget } : {}),
        ...(terminalRun.productionTarget ? { productionTarget: terminalRun.productionTarget } : {}),
        childIssues: [],
        targetRecovery: {
          checkpointId: terminalCheckpointId,
          phase: terminalCheckpoint.payload.phase,
          cause: reason,
          attempt: terminalCheckpoint.payload.attempt,
        },
        supersedes: terminalCheckpointId,
      },
    }, { id: `target_terminal_${createHash("sha256").update(`${input.run.runId}:${terminalCheckpointId}`).digest("hex").slice(0, 40)}` });
    await guarded.artifacts.append(terminal);
    const committedRun = attachArtifact(terminalRun, "Outcome", terminal.id);
    if (terminalTransition) {
      await guarded.runs.commit(current.version, committedRun, terminalTransition.record);
    }
    throw new WorkflowExecutionError(reason, committedRun, {
      cause: error,
      recoverable: false,
      retryDisposition: {
        disposition: "permanent", retryable: false, domain: "workflow", code: "target-recovery-terminal",
        cause: error instanceof Error ? error : new Error(reason),
      },
      targetAdvanceCheckpointId: terminalCheckpointId,
    });
  }
}

async function freshTargetRecoveryEvidence(
  packet: DurableArtifact<"BuildPacket">,
  sourceBuild: DurableArtifact<"BuildResult">,
  checks: readonly CheckResult[],
  changedPaths: readonly string[],
  expectedPaths: ReadonlySet<string>,
  verification: readonly Omit<VerificationCommand, "cwd">[],
  workspacePath: string,
): Promise<DurableArtifact<"VerificationCheckpoint">["payload"]["acceptanceEvidence"]> {
  const source = sourceBuild.payload.acceptanceEvidence;
  if (source.length !== packet.payload.acceptanceCriteria.length) {
    throw new Error("Target recovery cannot establish fresh criterion evidence from an incomplete prior evidence plan");
  }
  const strictSemantic = packet.payload.verificationPolicyVersion === "forgedock.verification/v2";
  if (strictSemantic && !packet.payload.evidenceContract) {
    throw new Error("Target recovery cannot revalidate policy-v2 evidence without the frozen evidence contract");
  }
  const commandById = new Map(verification.map((command) => [command.id, command]));
  const passedCommands = new Set(checks.filter((check) => check.status === "passed").map((check) => check.commandId).filter((id): id is string => id !== undefined));
  const observedPaths = new Set(changedPaths);
  const contractById = new Map((packet.payload.evidenceContract?.criteria ?? []).map((criterion) => [criterion.criterionId, criterion]));
  return Promise.all(packet.payload.acceptanceCriteria.map(async (criterion, index) => {
    const criterionId = `criterion-${index + 1}`;
    const evidence = source.find((item) => item.criterionId === criterionId && item.criterion === criterion && item.status === "passed");
    if (!evidence || !evidence.evidence.trim() || !evidence.anchors) {
      throw new Error(`Target recovery cannot revalidate criterion evidence for ${criterionId} without semantic anchors`);
    }
    const anchors = evidence.anchors;
    // Resolve the frozen criterion contract before validating any model-supplied
    // path.  Write and evidence paths have deliberately different proof rules.
    const contract = contractById.get(criterionId);
    if (strictSemantic && !contract) throw new Error(`Target recovery criterion ${criterionId} lacks a frozen evidence contract`);
    if (!contract) {
      if (anchors.paths.some((path) => !expectedPaths.has(path) || !observedPaths.has(path))) {
        throw new Error(`Target recovery criterion ${criterionId} has stale or out-of-scope path anchors`);
      }
    } else {
      const allowedWritePaths = new Set(contract.allowedWritePaths);
      const allowedEvidencePaths = new Set(contract.allowedEvidencePaths);
    const declaredEvidencePaths = new Set((packet.payload.evidencePaths ?? [])
      .filter((declaration) => declaration.criterionIds.includes(criterionId))
      .map((declaration) => canonicalizeConcreteScopePaths([declaration.path])[0]));
    for (const path of anchors.paths) {
      let canonicalPath: string;
      try {
        canonicalPath = canonicalizeConcreteScopePaths([path])[0]!;
      } catch (error) {
        throw new Error(`Target recovery criterion ${criterionId} has stale or out-of-scope path anchors: ${path} (${error instanceof Error ? error.message : String(error)})`);
      }
      if (canonicalPath !== path) {
        throw new Error(`Target recovery criterion ${criterionId} has stale or out-of-scope path anchors: ${path} is not canonical`);
      }
      const isWrite = allowedWritePaths.has(path);
      const isEvidence = allowedEvidencePaths.has(path);
      if (!isWrite && !isEvidence) {
        throw new Error(`Target recovery criterion ${criterionId} has stale or out-of-scope path anchors: ${path} is not authorized by the frozen evidence contract`);
      }
      if (isEvidence && (!declaredEvidencePaths.has(path) || !await recoveredEvidenceFile(workspacePath, path))) {
        throw new Error(`Target recovery criterion ${criterionId} has deleted, symlink, or drifted evidence path: ${path}`);
      }
      if (isWrite && !expectedPaths.has(path)) {
        throw new Error(`Target recovery criterion ${criterionId} has stale or out-of-scope path anchors: ${path} is outside the Build Packet write scope`);
      }
      if (isWrite && !observedPaths.has(path) && !isEvidence) {
        throw new Error(`Target recovery criterion ${criterionId} has a write anchor absent from the recovered revision; target may already have converged, but exact source BuildResult content proof is unavailable: ${path}`);
      }
      // A path appearing in both sets is accepted as a write only when the
      // recovered diff proves it.  Otherwise the explicit evidence role may
      // validate the unchanged file, but it never waives write proof.
      if (isEvidence && isWrite && observedPaths.has(path)) continue;
      if (isEvidence && !isWrite && observedPaths.has(path)) {
        throw new Error(`Target recovery criterion ${criterionId} has evidence-only path in the recovered write revision: ${path}`);
      }
      }
    }
    if (strictSemantic && (anchors.symbols.length === 0 || anchors.testIds.length === 0)) {
      throw new Error(`Target recovery criterion ${criterionId} lacks proven symbols or test IDs`);
    }
    const requiredIds = contract?.requiredCommandIds ?? [];
    const semanticIds = contract?.semanticCommandIds ?? [];
    const anchoredIds = new Set(anchors.verificationCommandIds);
    const missingRequired = [...new Set([...requiredIds, ...semanticIds])].filter((id) => !anchoredIds.has(id) || !passedCommands.has(id));
    if (missingRequired.length) throw new Error(`Target recovery criterion ${criterionId} has unproven required semantic commands: ${missingRequired.join(", ")}`);
    if (strictSemantic && requiredIds.length > 0 && semanticIds.length === 0) {
      throw new Error(`Target recovery criterion ${criterionId} is backed only by generic verification capability`);
    }
    for (const id of semanticIds) {
      const command = commandById.get(id);
      if (!command || command.evidenceCapability === undefined || command.evidenceCapability === "generic") {
        throw new Error(`Target recovery criterion ${criterionId} lacks controller semantic capability for ${id}`);
      }
      if ((command.evidenceCapability === "targeted-test" || command.evidenceCapability === "path-bound") && !command.targets?.length) {
        throw new Error(`Target recovery criterion ${criterionId} has unusable semantic capability for ${id}`);
      }
    }
    const matrixIds = (packet.payload.invariantMatrices ?? [])
      .filter((row) => row.criterionId === criterionId)
      .flatMap((row) => [row.testId, ...expandInvariantMatrix(row).map((item) => item.id)]);
    if (matrixIds.some((id) => !anchors.testIds.includes(id))) {
      throw new Error(`Target recovery criterion ${criterionId} has incomplete invariant matrix evidence`);
    }
    if (anchors.verificationCommandIds.some((id) => !passedCommands.has(id))) {
      throw new Error(`Target recovery criterion ${criterionId} has stale verification command anchors`);
    }
    return {
      criterionId,
      criterion,
      status: "passed" as const,
      evidence: `${evidence.evidence} Fresh controller rerun at the recovered target base passed.`,
      anchors,
    };
  }));
}

async function recoveredEvidenceFile(workspacePath: string, path: string): Promise<boolean> {
  try {
    const root = await realpath(workspacePath);
    const absolute = resolve(root, path);
    const relativePath = relative(root, absolute);
    if (!relativePath || isAbsolute(relativePath) || relativePath === ".." || relativePath.startsWith(`..${sep}`)) return false;
    const entry = await lstat(absolute);
    if (!entry.isFile() || entry.isSymbolicLink()) return false;
    const canonical = await realpath(absolute);
    const canonicalRelative = relative(root, canonical);
    return canonical === absolute && Boolean(canonicalRelative) && !isAbsolute(canonicalRelative)
      && canonicalRelative !== ".." && !canonicalRelative.startsWith(`..${sep}`);
  } catch {
    return false;
  }
}

interface ScopeExpansionOptions {
  scopeExpansion?: "scope-locked" | "recursive";
  parentRemediation?: ParentRemediationTarget;
  maxRemediationDepth?: number;
  maxRemediationChildren?: number;
  remediationDepth?: number;
  approvedPaths?: readonly string[];
}

async function prepareCleanPreBuilderExecution(
  input: {
    run: RunState;
    packet: DurableArtifact<"BuildPacket">;
    workspace: GitWorkspace;
    baseBranch: string;
    verification: readonly Omit<VerificationCommand, "cwd">[];
    resolveVerificationCatalog?: VerificationCatalogResolver;
    baselineChecks?: readonly CheckResult[];
    signal?: AbortSignal;
  },
  dependencies: WorkOnDependencies,
): Promise<{
  workspace: GitWorkspace;
  verification: readonly Omit<VerificationCommand, "cwd">[];
  baselineChecks: readonly CheckResult[];
}> {
  if (!dependencies.git.fastForwardToRemoteTarget) {
    throw new Error("Git workspace manager cannot perform an exact target fast-forward");
  }
  const fastForwardToRemoteTarget = dependencies.git.fastForwardToRemoteTarget.bind(dependencies.git);
  if (!dependencies.host.getBranchHead) {
    throw new Error("Host cannot advertise an authoritative target branch SHA for pre-builder refresh");
  }
  await dependencies.runs.recordProgress({
    runId: input.run.runId,
    phase: "workspace.target-refresh.started",
    message: `Refreshing clean workspace to the authoritative ${input.baseBranch} head`,
    occurredAt: new Date().toISOString(),
  });

  let refreshed: GitWorkspace | undefined;
  let lastMismatch: AdvertisedRemoteHeadMismatchError | undefined;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const advertised = await dependencies.host.getBranchHead(input.run.subject.repo, input.baseBranch);
    if (!/^[0-9a-f]{7,64}$/i.test(advertised)) {
      throw new Error(`Host advertised invalid target SHA '${advertised}' for ${input.baseBranch}`);
    }
    try {
      refreshed = await fastForwardToRemoteTarget(input.workspace, advertised);
      break;
    } catch (error) {
      if (!(error instanceof AdvertisedRemoteHeadMismatchError)) throw error;
      lastMismatch = error;
    }
  }
  if (!refreshed) {
    throw new Error("Authoritative target advanced repeatedly while refreshing the build workspace", { cause: lastMismatch });
  }
  if (!refreshed.baseSha) throw new Error("Target refresh did not return a frozen base SHA");
  await certifyPacketRelationAuthority(input.packet, refreshed.path, refreshed.baseSha, dependencies.artifacts);

  const catalog = input.resolveVerificationCatalog
    ? await input.resolveVerificationCatalog(refreshed.baseSha)
    : input.verification;
  const verification = selectPacketVerificationCommands(input.packet.payload, catalog, refreshed.baseSha);
  const commands = verification.map((command) => ({ ...command, cwd: refreshed.path }));
  await dependencies.git.prepareWorkspaceDependencies(refreshed, input.signal);
  await assertPristineWorkspace(refreshed, refreshed.baseSha, dependencies, "after dependency preparation");
  // Baseline evidence is reusable only when every durable check carries the
  // exact identity of the freshly frozen command plan.  planId includes the
  // refreshed base SHA; policy and target checks prevent same-ID catalog drift.
  const baselineMatchesFrozenPlan = input.baselineChecks !== undefined
    && input.baselineChecks.length === commands.length
    && commands.every((command, index) => {
      const check = input.baselineChecks?.find((candidate) =>
        candidate.commandId === command.id) ?? input.baselineChecks?.[index];
      if (!check) return false;
      return check.commandId === command.id
        && check.planId === command.planId
        && check.policyVersion === command.policyVersion
        && JSON.stringify(check.commandTargets ?? []) === JSON.stringify(command.targets ?? [])
        && check.command === [command.command, ...command.args].join(" ");
    });
  const baselineChecks = baselineMatchesFrozenPlan
    ? [...input.baselineChecks!]
    : await dependencies.verifier.run(
      commands,
      input.signal,
      verificationProgressRecorder(input.run.runId, "baseline", dependencies.runs),
    );
  await assertPristineWorkspace(refreshed, refreshed.baseSha, dependencies, "after baseline verification");
  await dependencies.runs.recordProgress({
    runId: input.run.runId,
    phase: "workspace.target-refresh.completed",
    message: `Workspace and ${verification.length} selected verification command(s) are frozen at ${refreshed.baseSha}`,
    occurredAt: new Date().toISOString(),
  });
  return { workspace: refreshed, verification, baselineChecks };
}

async function assertPristineWorkspace(
  workspace: GitWorkspace,
  expectedHeadSha: string,
  dependencies: WorkOnDependencies,
  phase: string,
): Promise<void> {
  if (dependencies.git.assertPristineAtHead) {
    try {
      await dependencies.git.assertPristineAtHead(workspace, expectedHeadSha);
      return;
    } catch (error) {
      throw new Error(`Workspace pristine assertion failed ${phase}`, { cause: error });
    }
  }
  // Compatibility fallback for legacy/in-memory workspace managers. Production
  // adapters implement the stronger assertion, including MERGE_HEAD evidence.
  const [head, changed] = await Promise.all([
    dependencies.git.head(workspace),
    dependencies.git.changedPaths(workspace),
  ]);
  if (head.toLowerCase() !== expectedHeadSha.toLowerCase() || changed.length) {
    throw new Error(`Workspace pristine assertion failed ${phase}: expected ${expectedHeadSha}, observed ${head}${changed.length ? ` with changed paths ${changed.join(", ")}` : ""}`);
  }
}

export async function certifyPacketRelationAuthority(
  packet: DurableArtifact<"BuildPacket">,
  cwd: string,
  baseSha: string,
  artifacts: ArtifactRepository,
): Promise<void> {
  if (packet.payload.investigationScopeReceipt) {
    const receipt = packet.payload.investigationScopeReceipt;
    const [intents, investigations] = await Promise.all([
      artifacts.list(packet.subject, "Intent"),
      artifacts.list(packet.subject, "Investigation"),
    ]);
    const intent = intents.find((artifact): artifact is DurableArtifact<"Intent"> => artifact.id === receipt.intentId);
    const investigation = investigations.find((artifact): artifact is DurableArtifact<"Investigation"> => artifact.id === receipt.investigationId);
    if (!intent || !investigation) throw new Error("[investigation-scope] Receipt-bound Intent or Investigation is missing");
    validateInvestigationScopeReceipt({
      receipt,
      runId: packet.runId,
      subject: packet.subject,
      intent,
      investigation,
      baseSha,
      proposalPaths: packet.payload.expectedPaths,
      expectedPaths: packet.payload.expectedPaths,
      ...(packet.payload.relationGraph ? { relationGraph: {
        checkpointId: packet.payload.relationGraph.checkpointId!,
        checkpointDigest: packet.payload.relationGraph.checkpointDigest!,
        baseSha: packet.payload.relationGraph.baseSha,
      } } : {}),
    });
    await revalidateInvestigationScopeEvidence({ receipt, cwd, baseSha });
  }
  if (!packet.payload.relationGraph) return;
  try {
    const checkpoints = await artifacts.list(packet.subject, "RelationGraphCheckpoint");
    const bound = checkpoints.find((artifact): artifact is DurableArtifact<"RelationGraphCheckpoint"> =>
      artifact.kind === "RelationGraphCheckpoint" && artifact.id === packet.payload.relationGraph?.checkpointId
        && artifact.payload.checkpointDigest === packet.payload.relationGraph?.checkpointDigest);
    if (!bound) throw new Error("[graph-authority] Exact relation graph checkpoint is missing or tampered");
    await certifyRelationGraphCheckpoint({ checkpoint: bound.payload, packet: packet.payload, cwd, baseSha });
  } catch (error) {
    // Legacy packets retain shadow certification during rollout, but a
    // controller-issued investigation receipt is always a blocking authority.
    if (packet.payload.investigationScopeReceipt || process.env.FORGEDOCK_STRICT_RELATION_CHECKPOINT === "1") throw error;
  }
}

function frozenPacketCommands(
  packet: DurableArtifact<"BuildPacket">,
  catalog: readonly Omit<VerificationCommand, "cwd">[],
  workspace: GitWorkspace,
): VerificationCommand[] {
  if (!workspace.baseSha) throw new Error("Frozen packet verification requires an exact workspace base SHA");
  return selectPacketVerificationCommands(packet.payload, catalog, workspace.baseSha)
    .map((command) => ({ ...command, cwd: workspace.path }));
}

export async function workOn(
  input: {
    intent: DurableArtifact<"Intent">;
    priorArtifacts?: readonly DurableArtifact[];
    repoPath: string;
    lane: IssueLane;
    scopeHints?: ScopeHints;
    verification: readonly Omit<VerificationCommand, "cwd">[];
    /** Re-read the controller catalog from the exact post-admission base SHA. */
    resolveVerificationCatalog?: VerificationCatalogResolver;
    baselineChecks?: readonly CheckResult[];
    provider?: string;
    model?: string;
    planningProvider?: string;
    planningModel?: string;
    planningThinking?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
    autoMerge?: boolean;
    maxRemediationCycles?: number;
    maxRemediationDepth?: number;
    maxRemediationChildren?: number;
    remediationDepth?: number;
    scopeExpansion?: "scope-locked" | "recursive";
    parentRemediation?: ParentRemediationTarget;
    maxReviewSpecialists?: number;
    productionTarget?: string;
    subjectEvidence?: readonly string[];
    batchMembers?: readonly number[];
    batchMemberContracts?: readonly BatchMemberContract[];
    /** Promote frozen Build Packet paths into the owning scheduler before edits begin. */
    onClaimsPromoted?: (paths: readonly string[]) => void | Promise<void>;
    signal?: AbortSignal;
  },
  dependencies: WorkOnDependencies,
): Promise<WorkOnResult> {
  dependencies = guardMutationBoundaries(dependencies);
  if (input.batchMemberContracts?.length && !input.intent.payload.batchMemberContracts?.length) {
    input = {
      ...input,
      intent: {
        ...input.intent,
        payload: {
          ...input.intent.payload,
          batchMemberContracts: input.batchMemberContracts.map((contract) => ({
            ...contract,
            acceptanceCriteria: [...contract.acceptanceCriteria],
            affectedFiles: [...contract.affectedFiles],
            claims: [...contract.claims],
          })),
        },
      },
    };
  }
  const runtimeOptions = {
    ...(input.provider !== undefined ? { provider: input.provider } : {}),
    ...(input.model !== undefined ? { model: input.model } : {}),
    ...(input.signal !== undefined ? { signal: input.signal } : {}),
  };
  const planningOptions = {
    ...(input.planningProvider !== undefined ? { planningProvider: input.planningProvider } : {}),
    ...(input.planningModel !== undefined ? { planningModel: input.planningModel } : {}),
    ...(input.planningThinking !== undefined ? { planningThinking: input.planningThinking } : {}),
  };
  const agentDependencies = {
    runtime: dependencies.runtime,
    artifacts: dependencies.artifacts,
    runs: dependencies.runs,
    decomposer: dependencies.host,
    ...(dependencies.onAgentEvent !== undefined ? { onAgentEvent: dependencies.onAgentEvent } : {}),
  };
  let workspace: GitWorkspace | undefined;
  let verification = input.verification;
  let run: RunState | undefined;
  let claimPromotionSuspended = false;
  let claimPromotionPending = false;
  let retainWorkspaceForRecovery = false;
  try {
    assertLease(dependencies);
    const issue = input.intent.subject.issue;
    if (!issue) throw new Error("work-on requires an issue subject");
    await assertFreshIssueOpen(dependencies.host, input.intent.subject.repo, issue);
    if (input.parentRemediation) {
      assertParentRemediationTarget(input.parentRemediation);
      if (dependencies.host.getBranchHead) {
        const currentParentHead = await dependencies.host.getBranchHead(input.intent.subject.repo, input.parentRemediation.parentBranch);
        if (!/^[0-9a-f]{7,64}$/i.test(currentParentHead)) {
          throw new Error(`Parent remediation branch ${input.parentRemediation.parentBranch} has no authoritative head SHA`);
        }
        // Sibling remediation PRs may already have advanced the parent branch.
        // The active checkpoint authorizes the branch, while final parent
        // verification proves the complete expanded revision and exact scope.
      }
    }
    const deliveryBranch = input.parentRemediation?.parentBranch ?? input.lane.targetBranch;
    assertLease(dependencies);
    workspace = await dependencies.git.create({
      runId: input.intent.runId,
      issue,
      baseRef: `origin/${deliveryBranch}`,
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
    });
    if (input.resolveVerificationCatalog) {
      if (!workspace.baseSha) throw new Error("Workspace creation did not return an exact base SHA for verification catalog resolution");
      verification = await input.resolveVerificationCatalog(workspace.baseSha);
    }
    await dependencies.verifier.recoverOperationalOutput?.(verification.map((command) => ({ ...command, cwd: workspace!.path })));
    const laneTarget = input.parentRemediation
      ? { ...runTargetForLane(input.lane, input.productionTarget), targetBranch: input.parentRemediation.parentBranch }
      : runTargetForLane(input.lane, input.productionTarget);
    const investigated = await investigateWorkItem({
      intent: input.intent,
      ...(input.priorArtifacts !== undefined ? { priorArtifacts: input.priorArtifacts } : {}),
      cwd: workspace.path,
      target: laneTarget,
      ...((input.scopeHints || input.parentRemediation) ? {
        scopeHints: {
          ...(input.scopeHints?.affectedFiles ? { affectedFiles: [...input.scopeHints.affectedFiles] } : {}),
          ...(input.scopeHints?.claims ? { claims: [...input.scopeHints.claims] } : {}),
          ...(input.scopeHints?.metadataRoots ? { metadataRoots: [...input.scopeHints.metadataRoots] } : {}),
          ...(input.scopeHints?.writePaths ? { writePaths: [...input.scopeHints.writePaths] } : {}),
          ...(input.parentRemediation?.findingLocation ? { affectedFiles: [...(input.scopeHints?.affectedFiles ?? []), input.parentRemediation.findingLocation] } : {}),
          ...(input.parentRemediation ? { claims: [...(input.scopeHints?.claims ?? []), `finding:${input.parentRemediation.findingId}`] } : {}),
        },
      } : {}),
      ...runtimeOptions,
      ...planningOptions,
    }, agentDependencies);
    run = investigated.run;
    if (run.state === "invalid") {
      if (!investigated.outcome || investigated.outcome.payload.status !== "invalid") {
        throw new Error(`Invalid run ${run.runId} is missing its structured invalid Outcome`);
      }
      return await completeInvalidWorkItem({
        run,
        investigation: investigated.investigation,
        outcome: investigated.outcome,
        ...(input.batchMembers !== undefined ? { childIssues: input.batchMembers } : {}),
        ...(input.batchMemberContracts !== undefined ? { memberContracts: input.batchMemberContracts } : {}),
      }, dependencies);
    }
    if (run.state === "decomposed") return { run };

    const prepared = await prepareBuildPacket({
      run,
      intent: input.intent,
      investigation: investigated.investigation,
      ...(input.priorArtifacts !== undefined ? { priorArtifacts: input.priorArtifacts } : {}),
      cwd: workspace.path,
      ...(workspace.baseSha !== undefined ? { baseSha: workspace.baseSha } : {}),
      ...(input.scopeHints !== undefined ? { scopeHints: input.scopeHints } : {}),
      ...runtimeOptions,
      ...planningOptions,
      verificationCatalog: {
        commands: verification.map((command) => ({ ...command })),
        controllerGates: CONTROLLER_VERIFICATION_GATES,
      },
    }, agentDependencies);
    // prepareBuildPacket commits BUILD_PACKET_READY before returning. Adopt
    // that version before the synchronous scheduler promotion boundary.
    run = prepared.run;
    claimPromotionPending = true;
    await input.onClaimsPromoted?.(prepared.packet.payload.expectedPaths);
    claimPromotionPending = false;
    const preBuilder = await prepareCleanPreBuilderExecution({
      run,
      packet: prepared.packet,
      workspace,
      baseBranch: deliveryBranch,
      verification,
      ...(input.resolveVerificationCatalog !== undefined ? { resolveVerificationCatalog: input.resolveVerificationCatalog } : {}),
      ...(input.baselineChecks !== undefined ? { baselineChecks: input.baselineChecks } : {}),
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
    }, dependencies);
    workspace = preBuilder.workspace;
    const continued = await continueBuildDelivery({
      run, intent: input.intent, investigation: investigated.investigation, packet: prepared.packet, workspace,
      ...(input.scopeHints !== undefined ? { scopeHints: input.scopeHints } : {}),
      baseBranch: deliveryBranch, verification: preBuilder.verification,
      baselineChecks: preBuilder.baselineChecks,
      ...(input.provider !== undefined ? { provider: input.provider } : {}),
      ...(input.model !== undefined ? { model: input.model } : {}),
      ...(input.autoMerge !== undefined ? { autoMerge: input.autoMerge } : {}),
      ...(input.maxRemediationCycles !== undefined ? { maxRemediationCycles: input.maxRemediationCycles } : {}),
      ...(input.maxRemediationDepth !== undefined ? { maxRemediationDepth: input.maxRemediationDepth } : {}),
      ...(input.maxRemediationChildren !== undefined ? { maxRemediationChildren: input.maxRemediationChildren } : {}),
      ...(input.remediationDepth !== undefined ? { remediationDepth: input.remediationDepth } : {}),
      ...(input.scopeExpansion !== undefined ? { scopeExpansion: input.scopeExpansion } : {}),
      ...(input.parentRemediation !== undefined ? { parentRemediation: input.parentRemediation } : {}),
      ...(input.maxReviewSpecialists !== undefined ? { maxReviewSpecialists: input.maxReviewSpecialists } : {}),
      ...(input.productionTarget !== undefined ? { productionTarget: input.productionTarget } : {}),
      subjectEvidence: [...(input.subjectEvidence ?? []), laneEvidence(input.lane)],
      ...(input.batchMembers !== undefined ? { batchMembers: input.batchMembers } : {}),
      ...(input.batchMemberContracts !== undefined ? { batchMemberContracts: input.batchMemberContracts } : {}),
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
    }, dependencies);
    run = continued.run;
    return continued;
  } catch (error) {
    if (error instanceof ClaimPromotionConflictError) {
      claimPromotionSuspended = true;
      if (claimPromotionPending) {
        // The packet checkpoint is already durable and remains the recovery
        // authority. Preserve the original scheduler error for the CLI adapter.
        retainWorkspaceForRecovery = true;
      }
      throw error;
    }
    const recoverable = input.signal?.aborted === true
      || error instanceof ClaimPromotionRecoveryError
      || (error instanceof WorkflowExecutionError && error.recoverable);
    if (error instanceof WorkflowExecutionError) run = error.run;
    if (recoverable) retainWorkspaceForRecovery = true;
    const reason = error instanceof Error ? error.message : String(error);
    if (!recoverable && run && run.state !== "failed" && run.state !== "blocked" && run.state !== "invalid") {
      const failed = transition(run, "FAIL", { reason });
      await dependencies.runs.commit(run.version, failed.state, failed.record);
      run = failed.state;
    }
    if (!recoverable && run?.state === "failed") await appendFailureOutcome(run, reason, dependencies);
    throw error;
  } finally {
    const retainForRecovery = claimPromotionSuspended || retainWorkspaceForRecovery
      || run?.state === "blocked" || run?.state === "failed" || run?.state === "cancelled";
    if (workspace && !retainForRecovery) {
      try { await dependencies.git.remove(workspace); } catch { /* recovery reconciles stale worktrees */ }
    }
  }
}

export interface EarlyWorkOnResumeInput extends ScopeExpansionOptions {
  checkpoint: "investigation" | "preparation";
  run: RunState;
  intent: DurableArtifact<"Intent">;
  investigation?: DurableArtifact<"Investigation">;
  priorArtifacts?: readonly DurableArtifact[];
  workspace: GitWorkspace;
  baseBranch: string;
  scopeHints?: ScopeHints;
  verification: readonly Omit<VerificationCommand, "cwd">[];
  /** Re-read the controller catalog from the exact post-admission base SHA. */
  resolveVerificationCatalog?: VerificationCatalogResolver;
  baselineChecks?: readonly CheckResult[];
  provider?: string;
  model?: string;
  planningProvider?: string;
  planningModel?: string;
  planningThinking?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  autoMerge?: boolean;
  maxRemediationCycles?: number;
  priorRemediationCycles?: number;
  maxReviewSpecialists?: number;
  productionTarget?: string;
  subjectEvidence?: readonly string[];
  batchMembers?: readonly number[];
  batchMemberContracts?: readonly BatchMemberContract[];
  onClaimsPromoted?: (paths: readonly string[]) => void | Promise<void>;
  signal?: AbortSignal;
}

/**
 * Recover the two durable checkpoints before a Build Packet exists. The
 * controller never replays an Investigation artifact: it either dispatches
 * from Intent-only state or advances the existing result to preparation (or
 * its invalid/decomposed terminal projection).
 */
export async function resumeEarlyWorkOn(
  input: EarlyWorkOnResumeInput,
  dependencies: WorkOnDependencies,
): Promise<WorkOnResult> {
  dependencies = guardMutationBoundaries(dependencies);
  let run = input.run;
  let verification = input.verification;
  let investigation = input.investigation;
  let workspace = input.workspace;
  let claimPromotionSuspended = false;
  let claimPromotionPending = false;
  let retainWorkspaceForRecovery = false;
  const agentDependencies = {
    runtime: dependencies.runtime,
    artifacts: dependencies.artifacts,
    runs: dependencies.runs,
    decomposer: dependencies.host,
    ...(dependencies.onAgentEvent !== undefined ? { onAgentEvent: dependencies.onAgentEvent } : {}),
  };
  try {
    assertLease(dependencies);
    assertRunTargetsBranch(run, input.baseBranch);
    if (input.resolveVerificationCatalog) {
      if (!workspace.baseSha) throw new Error("Resumed workspace does not retain an exact base SHA for verification catalog resolution");
      verification = await input.resolveVerificationCatalog(workspace.baseSha);
    }
    if (input.checkpoint === "investigation") {
      if (run.state !== "investigating") {
        throw new Error(`Investigation checkpoint requires investigating state, found ${run.state}`);
      }
      const investigated = await resumeInvestigationWorkItem({
        run,
        intent: input.intent,
        ...(investigation ? { investigation } : {}),
        ...(input.priorArtifacts !== undefined ? { priorArtifacts: input.priorArtifacts } : {}),
        cwd: workspace.path,
        ...(input.scopeHints !== undefined ? { scopeHints: input.scopeHints } : {}),
        ...(input.provider !== undefined ? { provider: input.provider } : {}),
        ...(input.model !== undefined ? { model: input.model } : {}),
        ...(input.planningProvider !== undefined ? { planningProvider: input.planningProvider } : {}),
        ...(input.planningModel !== undefined ? { planningModel: input.planningModel } : {}),
        ...(input.planningThinking !== undefined ? { planningThinking: input.planningThinking } : {}),
        ...(input.signal !== undefined ? { signal: input.signal } : {}),
      }, agentDependencies);
      run = investigated.run;
      investigation = investigated.investigation;
      if (run.state === "invalid") {
        if (!investigated.outcome || investigated.outcome.payload.status !== "invalid") {
          throw new Error(`Invalid run ${run.runId} is missing its structured invalid Outcome`);
        }
        return await completeInvalidWorkItem({
          run,
          investigation,
          outcome: investigated.outcome,
          ...(input.batchMembers !== undefined ? { childIssues: input.batchMembers } : {}),
          ...(input.batchMemberContracts !== undefined ? { memberContracts: input.batchMemberContracts } : {}),
        }, dependencies);
      }
      if (run.state === "decomposed") {
        return {
          run,
          ...(investigated.outcome ? { outcome: investigated.outcome } : {}),
        };
      }
    } else {
      if (run.state !== "preparing") {
        throw new Error(`Preparation checkpoint requires preparing state, found ${run.state}`);
      }
      if (!investigation || investigation.payload.outcome !== "confirmed") {
        throw new Error("Preparation checkpoint requires a confirmed durable Investigation");
      }
    }

    if (!investigation || investigation.payload.outcome !== "confirmed") {
      throw new Error("Build Packet recovery requires a confirmed durable Investigation");
    }
    const prepared = await prepareBuildPacket({
      run,
      intent: input.intent,
      investigation,
      ...(input.priorArtifacts !== undefined ? { priorArtifacts: input.priorArtifacts } : {}),
      cwd: workspace.path,
      ...(workspace.baseSha !== undefined ? { baseSha: workspace.baseSha } : {}),
      ...(input.scopeHints !== undefined ? { scopeHints: input.scopeHints } : {}),
      ...(input.provider !== undefined ? { provider: input.provider } : {}),
      ...(input.model !== undefined ? { model: input.model } : {}),
      ...(input.planningProvider !== undefined ? { planningProvider: input.planningProvider } : {}),
      ...(input.planningModel !== undefined ? { planningModel: input.planningModel } : {}),
      ...(input.planningThinking !== undefined ? { planningThinking: input.planningThinking } : {}),
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
      verificationCatalog: {
        commands: verification.map((command) => ({ ...command })),
        controllerGates: CONTROLLER_VERIFICATION_GATES,
      },
    }, agentDependencies);
    // Adopt the committed packet checkpoint before entering the synchronous
    // scheduler promotion boundary.
    run = prepared.run;
    claimPromotionPending = true;
    await input.onClaimsPromoted?.(prepared.packet.payload.expectedPaths);
    claimPromotionPending = false;
    const preBuilder = await prepareCleanPreBuilderExecution({
      run,
      packet: prepared.packet,
      workspace,
      baseBranch: input.baseBranch,
      verification,
      ...(input.resolveVerificationCatalog !== undefined ? { resolveVerificationCatalog: input.resolveVerificationCatalog } : {}),
      ...(input.baselineChecks !== undefined ? { baselineChecks: input.baselineChecks } : {}),
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
    }, dependencies);
    workspace = preBuilder.workspace;
    const continued = await continueBuildDelivery({
      run,
      intent: input.intent,
      investigation,
      packet: prepared.packet,
      workspace,
      ...(input.scopeHints !== undefined ? { scopeHints: input.scopeHints } : {}),
      baseBranch: input.baseBranch,
      verification: preBuilder.verification,
      baselineChecks: preBuilder.baselineChecks,
      ...(input.provider !== undefined ? { provider: input.provider } : {}),
      ...(input.model !== undefined ? { model: input.model } : {}),
      ...(input.autoMerge !== undefined ? { autoMerge: input.autoMerge } : {}),
      ...(input.maxRemediationCycles !== undefined ? { maxRemediationCycles: input.maxRemediationCycles } : {}),
      ...(input.priorRemediationCycles !== undefined ? { priorRemediationCycles: input.priorRemediationCycles } : {}),
      ...(input.maxRemediationDepth !== undefined ? { maxRemediationDepth: input.maxRemediationDepth } : {}),
      ...(input.maxRemediationChildren !== undefined ? { maxRemediationChildren: input.maxRemediationChildren } : {}),
      ...(input.remediationDepth !== undefined ? { remediationDepth: input.remediationDepth } : {}),
      ...(input.scopeExpansion !== undefined ? { scopeExpansion: input.scopeExpansion } : {}),
      ...(input.parentRemediation !== undefined ? { parentRemediation: input.parentRemediation } : {}),
      ...(input.maxReviewSpecialists !== undefined ? { maxReviewSpecialists: input.maxReviewSpecialists } : {}),
      ...(input.productionTarget !== undefined ? { productionTarget: input.productionTarget } : {}),
      ...(input.subjectEvidence !== undefined ? { subjectEvidence: input.subjectEvidence } : {}),
      ...(input.batchMembers !== undefined ? { batchMembers: input.batchMembers } : {}),
      ...(input.batchMemberContracts !== undefined ? { batchMemberContracts: input.batchMemberContracts } : {}),
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
    }, dependencies);
    run = continued.run;
    return continued;
  } catch (error) {
    if (error instanceof ClaimPromotionConflictError) {
      claimPromotionSuspended = true;
      if (claimPromotionPending) {
        // Keep the committed Build Packet checkpoint and retained workspace
        // resumable; the caller must receive this exact conflict instance.
        retainWorkspaceForRecovery = true;
      }
      throw error;
    }
    const recoverable = input.signal?.aborted === true
      || error instanceof ClaimPromotionRecoveryError
      || (error instanceof WorkflowExecutionError && error.recoverable);
    if (error instanceof WorkflowExecutionError) run = error.run;
    if (recoverable) retainWorkspaceForRecovery = true;
    const reason = error instanceof Error ? error.message : String(error);
    if (!recoverable && run.state !== "failed" && run.state !== "blocked" && run.state !== "invalid") {
      const failed = transition(run, "FAIL", { reason });
      await dependencies.runs.commit(run.version, failed.state, failed.record);
      run = failed.state;
    }
    if (!recoverable && run.state === "failed") await appendFailureOutcome(run, reason, dependencies);
    throw error;
  } finally {
    const retainForRecovery = claimPromotionSuspended || retainWorkspaceForRecovery
      || run.state === "blocked" || run.state === "failed" || run.state === "cancelled";
    if (!retainForRecovery) {
      try { await dependencies.git.remove(workspace); } catch { /* recovery reconciles stale worktrees */ }
    }
  }
}

async function appendVerificationRepairCheckpoint(
  run: RunState,
  failure: DurableArtifact<"Outcome">,
  repairAttempt: number,
  dependencies: Pick<WorkOnDependencies, "artifacts">,
  diagnosis?: VerificationDiagnosis,
): Promise<{ run: RunState; outcome: DurableArtifact<"Outcome"> }> {
  const failureEvidence = failure.payload.failureEvidence;
  if (!failureEvidence) throw new Error("Verification repair requires durable failure evidence");
  const outcome = createArtifact({
    kind: "Outcome",
    runId: run.runId,
    subject: run.subject,
    producer: { role: "controller", runtime: "forgedock" },
    payload: {
      status: "repairing",
      reason: `Verification repair attempt ${repairAttempt} dispatched: ${failure.payload.reason}`,
      ...(run.targetBranch ? { targetBranch: run.targetBranch } : {}),
      ...(run.promotionTarget ? { promotionTarget: run.promotionTarget } : {}),
      ...(run.productionTarget ? { productionTarget: run.productionTarget } : {}),
      childIssues: [],
      failureEvidence: {
        ...failureEvidence,
        repairAttempt,
        ...(diagnosis ? {
          diagnostics: [
            ...(failureEvidence.diagnostics ?? []),
            {
              code: "verification-diagnosis",
              message: "Controller-validated ephemeral diagnosis for the verification failure transition",
              details: { diagnosis },
            },
          ],
        } : {}),
      },
    },
  }, {
    id: deterministicOutcomeId(
      run.runId,
      run.subject,
      `repairing:verification-repair:${repairAttempt}:supersedes:${failure.id}`,
    ),
  });
  await dependencies.artifacts.append(outcome);
  return { run: attachArtifact(run, "Outcome", outcome.id), outcome };
}

function diagnosisFromOutcome(outcome: DurableArtifact<"Outcome"> | undefined): VerificationDiagnosis | undefined {
  const diagnostic = outcome?.payload.failureEvidence?.diagnostics?.find(({ code }) => code === "verification-diagnosis");
  if (!diagnostic) return undefined;
  const details = diagnostic.details;
  const candidate = details && typeof details === "object" && !Array.isArray(details)
    ? (details as { diagnosis?: unknown }).diagnosis
    : undefined;
  if (candidate === undefined) throw new Error("Persisted verification diagnosis is missing");
  if (!Check(VerificationDiagnosisSchema, candidate)) throw new Error("Persisted verification diagnosis is malformed");
  return candidate as VerificationDiagnosis;
}

function checkSignature(check: CheckResult): string {
  return [
    check.commandId ?? check.command,
    check.status,
    check.failureClass ?? "",
    check.exitCode === undefined ? "" : String(check.exitCode),
    [...(check.failureSignatures ?? [])].sort().join(","),
  ].join("|");
}

/**
 * Diagnosis prompts must not require the model to reproduce an unbounded log
 * signature verbatim. These IDs are deterministic, short, and still bound to
 * the complete controller-canonical signature.
 */
function verificationSignatureId(signature: string): string {
  return `sig-${createHash("sha256").update(signature).digest("hex").slice(0, 16)}`;
}

function diagnosisMappingIds(mapping: VerificationDiagnosis["failureSignatureMapping"]): Set<string> {
  if (typeof mapping === "string") return new Set(mapping.match(/sig-[0-9a-f]{16}/g) ?? []);
  return new Set(mapping.map(({ signatureId }) => signatureId));
}

function canonicalFailedCheckSignatures(
  outcome: DurableArtifact<"Outcome">,
  commands: readonly VerificationCommand[],
): string[] {
  const required = commands.filter((command) => command.required);
  const requiredIds = new Set(required.map((command) => command.id));
  const requiredCommands = new Set(required.map((command) => command.command));
  const signatures = (outcome.payload.failureEvidence?.checks ?? [])
    .filter((check) => check.status !== "passed" && (check.failureSignatures?.length || check.failureClass !== undefined)
      && (check.commandId !== undefined
        ? requiredIds.has(check.commandId)
        : requiredCommands.has(check.command)))
    .map(checkSignature);
  if (signatures.length) return [...new Set(signatures)].sort();
  const evidence = outcome.payload.failureEvidence;
  const reportOnly = [evidence?.failureKind ?? "", ...(evidence?.diagnostics ?? []).map(({ code }) => code)].filter(Boolean);
  return [...new Set(reportOnly)].sort();
}

function diagnosisScope(packet: DurableArtifact<"BuildPacket">) {
  const scope = scopeManifestForBuildPacket(
    packet.payload.expectedPaths,
    (packet.payload.evidencePaths ?? []).map(({ path }) => path),
  );
  return { readRoots: scope.readRoots, writeRoots: [], source: scope.source } as const;
}

async function validateVerificationDiagnosis(
  diagnosis: VerificationDiagnosis,
  packet: DurableArtifact<"BuildPacket">,
  currentSignatures: readonly string[],
  workspacePath: string,
): Promise<VerificationDiagnosis> {
  if (!Check(VerificationDiagnosisSchema, diagnosis)) throw new Error("Verification diagnosis failed its bounded schema");
  const scope = diagnosisScope(packet);
  const allowed = new Set([
    ...canonicalizeConcreteScopePaths(packet.payload.expectedPaths),
    ...canonicalizeConcreteScopePaths((packet.payload.evidencePaths ?? []).map(({ path }) => path)),
    ...STANDARD_SCOPE_METADATA_ROOTS,
  ]);
  for (const anchor of diagnosis.sourceAnchors) {
    if (!isConcreteScopePath(anchor.path) || canonicalizeConcreteScopePaths([anchor.path])[0] !== anchor.path) {
      throw new Error(`Verification diagnosis anchor is not a canonical concrete path: ${anchor.path}`);
    }
    const inReadRoot = scope.readRoots.some((root) => anchor.path === root || anchor.path.startsWith(`${root}/`));
    if (!allowed.has(anchor.path) && !inReadRoot) throw new Error(`Verification diagnosis anchor is outside packet read scope: ${anchor.path}`);
    const absolute = resolve(workspacePath, anchor.path);
    let entry;
    try {
      entry = await lstat(absolute);
      if (!entry.isFile() || entry.isSymbolicLink()) throw new Error("not a regular file");
      const root = await realpath(workspacePath);
      const canonical = await realpath(absolute);
      const withinWorkspace = relative(root, canonical);
      if (!withinWorkspace || isAbsolute(withinWorkspace) || withinWorkspace === ".." || withinWorkspace.startsWith(`..${sep}`)) {
        throw new Error("resolves outside workspace");
      }
    } catch (error) {
      throw new Error(`Verification diagnosis anchor is not a regular in-scope file: ${anchor.path} (${error instanceof Error ? error.message : String(error)})`);
    }
  }
  const mappedIds = diagnosisMappingIds(diagnosis.failureSignatureMapping);
  const legacyMapping = typeof diagnosis.failureSignatureMapping === "string"
    ? diagnosis.failureSignatureMapping
    : "";
  const unmapped = currentSignatures.filter((signature) => {
    const id = verificationSignatureId(signature);
    // The legacy fallback is intentionally retained for durable diagnoses
    // written before bounded IDs existed. New structured mappings use IDs.
    return !mappedIds.has(id) && !legacyMapping.includes(signature);
  });
  if (!currentSignatures.length || unmapped.length) {
    const missing = unmapped.map(verificationSignatureId).join(", ");
    throw new Error(`Verification diagnosis does not map every current failure signature (missing IDs: ${missing || "none"})`);
  }
  return diagnosis;
}

async function diagnoseVerificationTransition(
  input: {
    run: RunState;
    intent: DurableArtifact<"Intent">;
    investigation: DurableArtifact<"Investigation">;
    packet: DurableArtifact<"BuildPacket">;
    workspace: GitWorkspace;
    currentFailure: DurableArtifact<"Outcome">;
    priorFailure: DurableArtifact<"Outcome">;
    submission: BuilderSubmission;
    repairContext?: readonly DurableArtifact[];
    commands: readonly VerificationCommand[];
    provider?: string;
    model?: string;
    signal?: AbortSignal;
  },
  dependencies: WorkOnDependencies,
  currentSignatures: readonly string[],
): Promise<VerificationDiagnosis> {
  const summarize = (failure: DurableArtifact<"Outcome">) => (failure.payload.failureEvidence?.checks ?? [])
    .map((check) => `${check.commandId ?? check.command}: ${check.status}; class=${check.failureClass ?? ""}; signatures=${(check.failureSignatures ?? []).join(",")}; summary=${check.summary ?? ""}`)
    .join("\n");
  const result = await dependencies.runtime.run<VerificationDiagnosis>({
    id: `${input.run.runId}:verification-diagnosis:${input.run.attempt}`,
    role: "investigator",
    objective: "Diagnose one controller verification failure transition without editing the workspace.",
    instructions: [
      "This is a fresh read-only diagnostic session. Use only read, grep, find, ls, and the frozen verify tool; never edit, write, commit, or invoke GitHub.",
      "Inspect only packet expected paths, packet evidence paths, and packet metadata/read scope. Produce source-backed root cause evidence, not guesses.",
      `The current failed-check/report signature IDs (map every ID exactly in failureSignatureMapping) are:\n${currentSignatures.map(verificationSignatureId).join("\n")}`,
      `Human-readable current failure signature context (do not copy this as the mapping key):\n${currentSignatures.join("\n")}`,
      `The prior failed-check/report signatures were:\n${canonicalFailedCheckSignatures(input.priorFailure, input.commands).join("\n") || "(none)"}`,
      `Current failure checks:\n${summarize(input.currentFailure)}`,
      `Prior failure checks:\n${summarize(input.priorFailure)}`,
      `Prior builder submission/hypotheses/diff evidence:\n${JSON.stringify(input.submission)}\n${JSON.stringify(input.priorFailure.payload.failureEvidence)}`,
      ...(input.repairContext?.length ? [`Retained packet context:\n${JSON.stringify(input.repairContext)}`] : []),
      "Explain any transition from the prior failure to the current failure. Explicitly reject previous builder hypotheses that the inspected source disproves. Explain how the reproducer maps to every exact current signature and give only minimal fix guidance; do not make the fix.",
    ].join("\n"),
    context: [input.intent, input.investigation, input.packet, ...(input.repairContext ?? []), input.priorFailure, input.currentFailure],
    workspace: { cwd: input.workspace.path, mode: "read-only", scope: diagnosisScope(input.packet) },
    tools: ["read", "grep", "find", "ls", "verify"],
    verification: { commands: input.commands, runner: dependencies.verifier },
    outputSchema: VerificationDiagnosisSchema,
    modelPolicy: {
      ...(input.provider !== undefined ? { provider: input.provider } : {}),
      ...(input.model !== undefined ? { model: input.model } : {}),
    },
  }, {
    ...(input.signal !== undefined ? { signal: input.signal } : {}),
    ...(dependencies.onAgentEvent !== undefined ? { onEvent: dependencies.onAgentEvent } : {}),
  });
  return validateVerificationDiagnosis(result.output, input.packet, currentSignatures, input.workspace.path);
}
export async function resumeBuildWorkOn(
  input: {
    run: RunState;
    intent: DurableArtifact<"Intent">;
    investigation: DurableArtifact<"Investigation">;
    packet: DurableArtifact<"BuildPacket">;
    verificationCheckpoint?: DurableArtifact<"VerificationCheckpoint">;
    priorVerificationFailure?: DurableArtifact<"Outcome">;
    priorVerificationRepairAttempts?: number;
    repairContext?: readonly DurableArtifact[];
    workspace: GitWorkspace;
    baseBranch: string;
    verification: readonly Omit<VerificationCommand, "cwd">[];
    /** Re-read the controller catalog from the exact post-admission base SHA. */
    resolveVerificationCatalog?: VerificationCatalogResolver;
    baselineChecks?: readonly CheckResult[];
    provider?: string;
    model?: string;
    autoMerge?: boolean;
    maxRemediationCycles?: number;
    priorRemediationCycles?: number;
    maxRemediationDepth?: number;
    maxRemediationChildren?: number;
    remediationDepth?: number;
    scopeExpansion?: "scope-locked" | "recursive";
    maxReviewSpecialists?: number;
    subjectEvidence?: readonly string[];
    batchMembers?: readonly number[];
    batchMemberContracts?: readonly BatchMemberContract[];
    parentRemediation?: ParentRemediationTarget;
    /** Re-register the frozen packet paths with the owning scheduler before builder dispatch. */
    onClaimsPromoted?: (paths: readonly string[]) => void | Promise<void>;
    /** Exact packet paths already promoted before retained-workspace recovery. */
    preflightedPacketClaims?: readonly string[];
    signal?: AbortSignal;
  },
  dependencies: WorkOnDependencies,
): Promise<WorkOnResult> {
  dependencies = guardMutationBoundaries(dependencies);
  if (input.run.state !== "building") throw new Error(`Build resume requires building state, found ${input.run.state}`);
  assertRunTargetsBranch(input.run, input.baseBranch);
  let run = input.run;
  let claimPromotionPending = false;
  let retainWorkspaceForRecovery = false;
  try {
    let priorVerificationFailure = input.priorVerificationFailure;
    let verificationDiagnosis = diagnosisFromOutcome(priorVerificationFailure);
    if (verificationDiagnosis !== undefined && priorVerificationFailure !== undefined) {
      verificationDiagnosis = await validateVerificationDiagnosis(
        verificationDiagnosis,
        input.packet,
        canonicalFailedCheckSignatures(priorVerificationFailure, input.verification.map((command) => ({ ...command, cwd: input.workspace.path }))),
        input.workspace.path,
      );
    }
    let repairAttempts = input.priorVerificationRepairAttempts ?? 0;
    if (priorVerificationFailure) {
      const dispatchedAttempt = priorVerificationFailure.payload.failureEvidence?.repairAttempt;
      if (dispatchedAttempt !== undefined) {
        if (dispatchedAttempt > MAX_VERIFICATION_REPAIR_ATTEMPTS) {
          throw new Error(`Invalid verification repair attempt ${dispatchedAttempt}`);
        }
        // A durable dispatch checkpoint may survive a crash before its builder
        // starts. Resume that same attempt instead of spending another slot.
        repairAttempts = Math.max(repairAttempts, dispatchedAttempt);
      } else {
        if (repairAttempts >= MAX_VERIFICATION_REPAIR_ATTEMPTS) {
          throw new Error(`Verification repair budget exhausted after ${MAX_VERIFICATION_REPAIR_ATTEMPTS} repair attempt(s)`);
        }
        const checkpoint = await appendVerificationRepairCheckpoint(
          run,
          priorVerificationFailure,
          repairAttempts + 1,
          dependencies,
        );
        run = checkpoint.run;
        priorVerificationFailure = checkpoint.outcome;
        repairAttempts += 1;
      }
    }
    const resumed = transition(run, "RESUME_BUILD", { reason: `Resuming frozen Build Packet in retained workspace ${input.workspace.path}` });
    await dependencies.runs.commit(run.version, resumed.state, resumed.record);
    run = resumed.state;
    if (input.preflightedPacketClaims === undefined) {
      claimPromotionPending = true;
      await input.onClaimsPromoted?.(input.packet.payload.expectedPaths);
      claimPromotionPending = false;
    } else {
      assertExactPacketClaims(input.packet.payload.expectedPaths, input.preflightedPacketClaims);
    }

    if (input.verificationCheckpoint) {
      const recovered = await recoverVerificationCheckpoint({
        run,
        checkpoint: input.verificationCheckpoint,
        workspace: input.workspace,
        packet: input.packet,
        commands: frozenPacketCommands(input.packet, input.verification, input.workspace),
        verifier: dependencies.verifier,
      }, {
        git: dependencies.git,
        artifacts: dependencies.artifacts,
        runs: dependencies.runs,
      });
      if (!recovered.buildResult) throw new Error("Verified commit recovery did not reconstruct a Build Result");
      run = recovered.run;
      const result = await resumePublicationWorkOn({
        ...input,
        run,
        buildResult: recovered.buildResult,
      }, dependencies);
      run = result.run;
      return result;
    }

    let executionWorkspace = input.workspace;
    let executionVerification = input.verification;
    let executionBaseline = input.baselineChecks;
    const pristinePaths = await dependencies.git.changedPaths(input.workspace);
    const currentHead = await dependencies.git.head(input.workspace);
    const pristinePreBuilder = pristinePaths.length === 0
      && input.workspace.baseSha !== undefined
      && currentHead.toLowerCase() === input.workspace.baseSha.toLowerCase()
      && input.priorVerificationFailure === undefined;
    if (pristinePreBuilder) {
      const preBuilder = await prepareCleanPreBuilderExecution({
        run,
        packet: input.packet,
        workspace: input.workspace,
        baseBranch: input.baseBranch,
        verification: input.verification,
        ...(input.resolveVerificationCatalog !== undefined ? { resolveVerificationCatalog: input.resolveVerificationCatalog } : {}),
        ...(input.baselineChecks !== undefined ? { baselineChecks: input.baselineChecks } : {}),
        ...(input.signal !== undefined ? { signal: input.signal } : {}),
      }, dependencies);
      executionWorkspace = preBuilder.workspace;
      executionVerification = preBuilder.verification;
      executionBaseline = preBuilder.baselineChecks;
    } else if (input.packet.payload.verificationRequirements?.length && input.workspace.baseSha) {
      // A partially built revision stays on its frozen base. Selection is pure;
      // target refresh and baseline execution must never touch retained edits.
      executionVerification = selectPacketVerificationCommands(
        input.packet.payload,
        input.verification,
        input.workspace.baseSha,
      );
    }
    const result = await continueBuildDelivery({
      ...input,
      workspace: executionWorkspace,
      verification: executionVerification,
      ...(executionBaseline !== undefined ? { baselineChecks: executionBaseline } : {}),
      run,
      priorVerificationRepairAttempts: repairAttempts,
      ...(verificationDiagnosis !== undefined ? { verificationDiagnosis } : {}),
      ...(priorVerificationFailure ? { priorVerificationFailure } : {}),
    }, dependencies);
    run = result.run;
    return result;
  } catch (error) {
    if (claimPromotionPending && error instanceof ClaimPromotionConflictError) {
      // The RESUME_BUILD checkpoint is already durable. Preserve it and the
      // retained workspace while the scheduler waits for a later explicit retry.
      retainWorkspaceForRecovery = true;
      throw error;
    }
    const recoverable = input.signal?.aborted === true
      || error instanceof ClaimPromotionRecoveryError
      || (error instanceof WorkflowExecutionError && error.recoverable);
    if (error instanceof WorkflowExecutionError) run = error.run;
    if (recoverable) retainWorkspaceForRecovery = true;
    const reason = error instanceof Error ? error.message : String(error);
    if (!recoverable && run.state !== "failed" && run.state !== "blocked") {
      const failed = transition(run, "FAIL", { reason });
      await dependencies.runs.commit(run.version, failed.state, failed.record);
      run = failed.state;
    }
    if (!recoverable && run.state === "failed") await appendFailureOutcome(run, reason, dependencies);
    throw error;
  } finally {
    const retainForRecovery = retainWorkspaceForRecovery || run.state === "blocked" || run.state === "failed" || run.state === "cancelled";
    if (!retainForRecovery) {
      try { await dependencies.git.remove(input.workspace); } catch { /* recovery reconciles stale worktrees */ }
    }
  }
}

async function verifyWithBuilderRepairs(
  input: {
    run: RunState;
    intent: DurableArtifact<"Intent">;
    investigation: DurableArtifact<"Investigation">;
    packet: DurableArtifact<"BuildPacket">;
    submission: BuilderSubmission;
    builderSessionRef?: string;
    repairContext?: readonly DurableArtifact[];
    priorVerificationRepairAttempts?: number;
    priorVerificationFailure?: DurableArtifact<"Outcome">;
    verificationDiagnosis?: VerificationDiagnosis;
    workspace: GitWorkspace;
    commands: readonly VerificationCommand[];
    baselineChecks?: readonly CheckResult[];
    subjectEvidence?: readonly string[];
    automaticRepair?: boolean;
    provider?: string;
    model?: string;
    signal?: AbortSignal;
  },
  dependencies: WorkOnDependencies,
): Promise<VerificationResult> {
  let run = input.run;
  let submission = input.submission;
  let builderSessionRef = input.builderSessionRef;
  let repairAttempts = input.priorVerificationRepairAttempts ?? 0;
  let priorFailureForSignature = input.priorVerificationFailure;
  let verificationDiagnosis = input.verificationDiagnosis;
  const runtimeOptions = {
    ...(input.provider !== undefined ? { provider: input.provider } : {}),
    ...(input.model !== undefined ? { model: input.model } : {}),
    ...(input.signal !== undefined ? { signal: input.signal } : {}),
  };
  try {
    while (true) {
      const shouldDiagnose = repairAttempts === 1
        && priorFailureForSignature !== undefined;
      let verified: VerificationResult;
      try {
        verified = await verifyAndCommit({
        run,
        packet: input.packet,
        submission,
      workspace: input.workspace,
      commands: input.commands,
      ...(input.baselineChecks !== undefined ? { baselineChecks: input.baselineChecks } : {}),
      ...(input.subjectEvidence !== undefined ? { subjectEvidence: input.subjectEvidence } : {}),
      ...(input.automaticRepair !== false && repairAttempts < MAX_VERIFICATION_REPAIR_ATTEMPTS
        ? {
          automaticRepair: {
            attempt: repairAttempts + 1,
            ...(shouldDiagnose ? {
              enrichFailure: async (currentFailure: DurableArtifact<"Outcome">) => {
                const currentSignatures = canonicalFailedCheckSignatures(currentFailure, input.commands);
                if (currentSignatures.length === 0) return [];
                try {
                  verificationDiagnosis = await diagnoseVerificationTransition({
                    run,
                    intent: input.intent,
                    investigation: input.investigation,
                    packet: input.packet,
                    workspace: input.workspace,
                    currentFailure,
                    priorFailure: priorFailureForSignature!,
                    submission,
                    ...(input.repairContext !== undefined ? { repairContext: input.repairContext } : {}),
                    commands: input.commands,
                    ...runtimeOptions,
                  }, dependencies, canonicalFailedCheckSignatures(currentFailure, input.commands));
                } catch (error) {
                  const reason = error instanceof Error ? error.message : String(error);
                  throw new VerificationDiagnosisCallbackError(
                    reason,
                    isRecoverableAgentExecutionError(error),
                    currentFailure,
                    { cause: error },
                  );
                }
                return [{
                  code: "verification-diagnosis",
                  message: "Controller-validated ephemeral diagnosis for the verification failure transition",
                  details: { diagnosis: verificationDiagnosis },
                }];
              },
            } : {}),
          },
        }
        : {}),
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
      }, {
        verifier: dependencies.verifier,
        git: dependencies.git,
        artifacts: dependencies.artifacts,
        runs: dependencies.runs,
      });
      } catch (error) {
        if (error instanceof VerificationDiagnosisCallbackError) {
          if (error.recoverable) {
            throw new WorkflowExecutionError(error.message, run, {
              cause: error,
              recoverable: true,
            });
          }
          const candidateEvidence = error.candidate.payload.failureEvidence;
          if (!candidateEvidence) throw new Error("Verification diagnosis failure requires durable candidate evidence");
          const terminalOutcome = createArtifact({
            ...error.candidate,
            payload: {
              ...error.candidate.payload,
              status: "blocked",
              reason: error.message,
              failureEvidence: {
                ...candidateEvidence,
                diagnostics: [
                  ...(candidateEvidence.diagnostics ?? []),
                  {
                    code: "verification-diagnosis-validation",
                    message: error.message,
                    details: { reason: error.message },
                  },
                ],
              },
            },
          }, {
            id: deterministicOutcomeId(
              run.runId,
              run.subject,
              `blocked:verification-diagnosis:${error.candidate.id}`,
            ),
          });
          await dependencies.artifacts.append(terminalOutcome);
          run = attachArtifact(run, "Outcome", terminalOutcome.id);
          const blocked = transition(run, "VERIFICATION_FAILED", { reason: error.message });
          await dependencies.runs.commit(run.version, blocked.state, blocked.record);
          run = blocked.state;
          throw new WorkflowExecutionError(error.message, run, { cause: error });
        }
        throw error;
      }
      run = verified.run;
      if (verified.buildResult || !isRepairableVerificationFailure(input.packet, verified.outcome)) return verified;

    if (repairAttempts >= MAX_VERIFICATION_REPAIR_ATTEMPTS) {
      const reason = `Verification repair budget exhausted after ${MAX_VERIFICATION_REPAIR_ATTEMPTS} repair attempt(s)`;
      const exhausted = transition(run, "VERIFICATION_REPAIR_EXHAUSTED", { reason });
      await dependencies.runs.commit(run.version, exhausted.state, exhausted.record);
      return { ...verified, run: exhausted.state };
    }

    const nextRepairAttempt = repairAttempts + 1;
    priorFailureForSignature = verified.outcome!;
    if (run.state === "blocked") {
      const repair = transition(run, "VERIFICATION_REPAIR_REQUESTED", {
        reason: `Repairing retained verification failure ${nextRepairAttempt} of ${MAX_VERIFICATION_REPAIR_ATTEMPTS}`,
      });
      await dependencies.runs.commit(run.version, repair.state, repair.record);
      run = repair.state;
    }
    repairAttempts = nextRepairAttempt;
    const repaired = await buildWorkItem({
      run,
      intent: input.intent,
      investigation: input.investigation,
      packet: input.packet,
      priorVerificationFailure: verified.outcome!,
      ...(verificationDiagnosis !== undefined ? { verificationDiagnosis } : {}),
      priorSubmission: submission,
      ...(builderSessionRef !== undefined ? { priorBuilderSessionRef: builderSessionRef } : {}),
      ...(input.repairContext !== undefined ? { repairContext: input.repairContext } : {}),
      worktree: input.workspace.path,
      verification: input.commands,
      verificationRunner: dependencies.verifier,
      ...runtimeOptions,
    }, {
      runtime: dependencies.runtime,
      runs: dependencies.runs,
      verifier: dependencies.verifier,
      ...(dependencies.onAgentEvent !== undefined ? { onAgentEvent: dependencies.onAgentEvent } : {}),
    });
    run = repaired.run;
    submission = repaired.submission;
    builderSessionRef = repaired.sessionRef;
    }
  } catch (error) {
    // verifyAndCommit may have durably advanced the run before diagnosis or
    // another repair-stage operation throws. Never let callers retain the
    // stale run they passed into this helper.
    const errorRun = error instanceof WorkflowExecutionError ? error.run : undefined;
    const latestRun = errorRun && errorRun.version >= run.version ? errorRun : run;
    if (error instanceof WorkflowExecutionError && errorRun === latestRun) throw error;
    const reason = error instanceof Error ? error.message : String(error);
    const recoverable = error instanceof WorkflowExecutionError
      ? error.recoverable
      : isRecoverableAgentExecutionError(error);
    throw new WorkflowExecutionError(reason, latestRun, {
      cause: error,
      recoverable,
      ...(error instanceof WorkflowExecutionError ? { retryDisposition: error.retryDisposition } : {}),
    });
  }
}

async function continueBuildDelivery(
  input: {
    run: RunState;
    intent: DurableArtifact<"Intent">;
    investigation: DurableArtifact<"Investigation">;
    packet: DurableArtifact<"BuildPacket">;
    scopeHints?: ScopeHints;
    priorVerificationFailure?: DurableArtifact<"Outcome">;
    priorVerificationRepairAttempts?: number;
    verificationDiagnosis?: VerificationDiagnosis;
    repairContext?: readonly DurableArtifact[];
    workspace: GitWorkspace;
    baseBranch: string;
    verification: readonly Omit<VerificationCommand, "cwd">[];
    baselineChecks?: readonly CheckResult[];
    provider?: string;
    model?: string;
    autoMerge?: boolean;
    maxRemediationCycles?: number;
    priorRemediationCycles?: number;
    maxRemediationDepth?: number;
    maxRemediationChildren?: number;
    remediationDepth?: number;
    scopeExpansion?: "scope-locked" | "recursive";
    parentRemediation?: ParentRemediationTarget;
    maxReviewSpecialists?: number;
    productionTarget?: string;
    subjectEvidence?: readonly string[];
    batchMembers?: readonly number[];
    batchMemberContracts?: readonly BatchMemberContract[];
    signal?: AbortSignal;
  },
  dependencies: WorkOnDependencies,
): Promise<WorkOnResult> {
  assertRunTargetsBranch(input.run, input.baseBranch);
  assertLease(dependencies);
  const runtimeOptions = {
    ...(input.provider !== undefined ? { provider: input.provider } : {}),
    ...(input.model !== undefined ? { model: input.model } : {}),
    ...(input.signal !== undefined ? { signal: input.signal } : {}),
  };
  let run = input.run;
  const commands = input.verification.map((command) => ({ ...command, cwd: input.workspace.path }));
  if (!input.workspace.baseSha) throw new Error("Builder dispatch requires an exact frozen workspace base SHA");
  await certifyPacketRelationAuthority(input.packet, input.workspace.path, input.workspace.baseSha, dependencies.artifacts);
  if (input.priorVerificationFailure === undefined) {
    await assertPristineWorkspace(input.workspace, input.workspace.baseSha, dependencies, "immediately before builder dispatch");
  }
  const built = await buildWorkItem({
    run, intent: input.intent, investigation: input.investigation, packet: input.packet,
    ...(input.scopeHints !== undefined ? { scopeHints: input.scopeHints } : {}),
    ...(input.priorVerificationFailure !== undefined ? { priorVerificationFailure: input.priorVerificationFailure } : {}),
    ...(input.verificationDiagnosis !== undefined ? { verificationDiagnosis: input.verificationDiagnosis } : {}),
    ...(input.repairContext !== undefined ? { repairContext: input.repairContext } : {}),
    worktree: input.workspace.path,
    verification: commands,
    verificationRunner: dependencies.verifier,
    ...runtimeOptions,
  }, {
    runtime: dependencies.runtime,
    runs: dependencies.runs,
    verifier: dependencies.verifier,
    ...(dependencies.onAgentEvent !== undefined ? { onAgentEvent: dependencies.onAgentEvent } : {}),
  });
  run = built.run;
  const initialVerification = await verifyWithBuilderRepairs({
    run,
    intent: input.intent,
    investigation: input.investigation,
    packet: input.packet,
    submission: built.submission,
    builderSessionRef: built.sessionRef,
    ...(input.repairContext !== undefined ? { repairContext: input.repairContext } : {}),
    priorVerificationRepairAttempts: input.priorVerificationRepairAttempts ?? 0,
    ...(input.priorVerificationFailure !== undefined ? { priorVerificationFailure: input.priorVerificationFailure } : {}),
    ...(input.verificationDiagnosis !== undefined ? { verificationDiagnosis: input.verificationDiagnosis } : {}),
    workspace: input.workspace,
    commands,
    ...(input.baselineChecks !== undefined ? { baselineChecks: input.baselineChecks } : {}),
    ...(input.subjectEvidence !== undefined ? { subjectEvidence: input.subjectEvidence } : {}),
    automaticRepair: commands.length > 0,
    ...runtimeOptions,
  }, dependencies);
  run = initialVerification.run;
  if (!initialVerification.buildResult) return { run };
  let buildResult = initialVerification.buildResult;

  assertLease(dependencies);
  const published = await publishPullRequest({
    run, intent: input.intent, packet: input.packet, buildResult, workspace: input.workspace,
    ...(input.parentRemediation ? { parentRemediation: { parentBranch: input.parentRemediation.parentBranch, parentPullRequest: input.parentRemediation.parentPullRequest } } : {}),
  }, { git: dependencies.git, host: dependencies.host, runs: dependencies.runs, artifacts: dependencies.artifacts });
  run = published.run;
  let pullRequest = published.pullRequest;
  let verdict: DurableArtifact<"ReviewVerdict">;
  let priorVerdict: DurableArtifact<"ReviewVerdict"> | undefined;
  let cycle = input.priorRemediationCycles ?? 0;

  while (true) {
    const reviewed = await reviewPullRequest({
      run, pullRequest, intent: input.intent, investigation: input.investigation,
      packet: input.packet, buildResult, workspace: input.workspace.path,
      findingIssuePolicy: "all",
      ...(input.maxReviewSpecialists !== undefined ? { maxReviewSpecialists: input.maxReviewSpecialists } : {}),
      ...(priorVerdict !== undefined ? { priorVerdict } : {}),
      reviewCycle: { current: cycle + 1, total: (input.maxRemediationCycles ?? 2) + 1 },
      ...runtimeOptions,
    }, {
      runtime: dependencies.runtime, host: dependencies.host, artifacts: dependencies.artifacts, runs: dependencies.runs,
      ...(dependencies.onAgentEvent !== undefined ? { onAgentEvent: dependencies.onAgentEvent } : {}),
    });
    run = reviewed.run;
    verdict = reviewed.verdict;
    priorVerdict = verdict;
    const scopeViolation = blockingFindingOutsidePacket(
      verdict, input.packet, undefined, input.scopeExpansion === "recursive",
    );
    if (scopeViolation) {
      run = await blockForScopeViolation(
        run, pullRequest, input.packet, verdict, scopeViolation, input, dependencies,
      );
      return { run, pullRequest };
    }
    if (run.state === "merging") {
      // Approval is bound to one exact head. If configured, repair only the
      // mutable same-repository delivery branch before completion. A changed
      // head invalidates the verdict and must return through independent review.
      const repairManager = dependencies.ciRepairWorkspaces ?? repairWorkspaceManagerFromGit(dependencies.git);
      if (repairManager && dependencies.ciPolicy?.failureAction === "auto-fix") {
        const repaired = await makePullRequestCiGreen({
          repo: pullRequest.repo,
          pullRequest: pullRequest.number,
          policy: dependencies.ciPolicy,
          ...(input.productionTarget !== undefined ? { productionTarget: input.productionTarget } : {}),
          ...(input.provider !== undefined ? { provider: input.provider } : {}),
          ...(input.model !== undefined ? { model: input.model } : {}),
          ...(input.signal !== undefined ? { signal: input.signal } : {}),
        }, {
          runtime: dependencies.runtime,
          host: dependencies.host,
          workspaces: repairManager,
          verifier: dependencies.verifier,
          verificationCommands: (cwd, _baseRef) => frozenPacketCommands(
            input.packet,
            input.verification,
            { ...input.workspace, path: cwd },
          ),
          ...(dependencies.onAgentEvent !== undefined ? { onAgentEvent: dependencies.onAgentEvent } : {}),
        });
        const repairedHead = repaired.pullRequest.headSha;
        if (repairedHead.toLowerCase() !== verdict.payload.headSha.toLowerCase()) {
          // Refresh the retained packet workspace to the exact pushed head;
          // never run packet verification against the pre-repair checkout.
          await dependencies.git.syncToRemoteHead(input.workspace, repairedHead);
          await assertPristineWorkspace(input.workspace, repairedHead, dependencies, "after CI repair publication");
          // The repair agent already ran bounded diagnostics; the controller
          // reselects only the packet's frozen commands and proves the pushed
          // commit, scope, blobs, symlink safety, and non-mutating checks.
          const repairedWorkspace = { ...input.workspace };
          const reverifyCommands = frozenPacketCommands(input.packet, input.verification, repairedWorkspace);
          const repairVerification = await verifyCommittedRepair({
            packet: input.packet,
            workspace: repairedWorkspace,
            expectedHeadSha: repairedHead,
            parentHeadSha: verdict.payload.headSha,
            commands: reverifyCommands,
            verifier: dependencies.verifier,
            ...(input.signal !== undefined ? { signal: input.signal } : {}),
          }, dependencies.git);
          const evidence = buildResult.payload.acceptanceEvidence;
          if (evidence.length !== input.packet.payload.acceptanceCriteria.length
            || evidence.some((item, index) => item.status !== "passed"
              || item.criterion !== input.packet.payload.acceptanceCriteria[index]
              || item.criterionId !== `criterion-${index + 1}`)) {
            throw new Error("CI repair cannot inherit incomplete or mismatched Build Packet criterion evidence");
          }
          const repairedBuildResult = createArtifact({
            kind: "BuildResult",
            runId: buildResult.runId,
            subject: buildResult.subject,
            producer: { role: "controller", runtime: "forgedock" },
            payload: {
              ...buildResult.payload,
              headSha: repairedHead,
              changedPaths: repairVerification.changedPaths,
              checks: repairVerification.checks,
              summary: `${buildResult.payload.summary} (reverified after bounded CI repair)`,
            },
          });
          await dependencies.artifacts.append(repairedBuildResult);
          buildResult = repairedBuildResult;
          run = attachArtifact(run, "BuildResult", repairedBuildResult.id);
          const blocked = transition(run, "BLOCK", { reason: `CI repair changed PR head from ${verdict.payload.headSha} to ${repairedHead}; fresh independent review required` });
          await dependencies.runs.commit(run.version, blocked.state, blocked.record);
          const resumed = transition(blocked.state, "RESUME_REVIEW", { headSha: repairedHead, reason: "CI repair published a new exact PR head" });
          await dependencies.runs.commit(blocked.state.version, resumed.state, resumed.record);
          run = resumed.state;
          pullRequest = repaired.pullRequest;
          priorVerdict = undefined;
          continue;
        }
      }
      break;
    }

    cycle++;
    if (cycle > (input.maxRemediationCycles ?? 2)) {
      run = await blockForReviewFindings(run, pullRequest, verdict, dependencies, `Remediation budget exhausted after ${cycle - 1} cycle(s)`);
      return { run, pullRequest };
    }
    const remediated = await remediateReview({
      run, intent: input.intent, investigation: input.investigation, packet: input.packet,
      buildResult, verdict, reviewCycle: { current: cycle, total: (input.maxRemediationCycles ?? 2) + 1 }, worktree: input.workspace.path,
      verification: commands,
      verificationRunner: dependencies.verifier,
      ...runtimeOptions,
    }, {
      runtime: dependencies.runtime, runs: dependencies.runs, verifier: dependencies.verifier,
      ...(dependencies.onAgentEvent !== undefined ? { onAgentEvent: dependencies.onAgentEvent } : {}),
    });
    run = remediated.run;
    const remediationVerification = await verifyWithBuilderRepairs({
      run,
      intent: input.intent,
      investigation: input.investigation,
      packet: input.packet,
      submission: remediated.submission,
      builderSessionRef: remediated.sessionRef,
      repairContext: [buildResult, verdict],
      workspace: input.workspace,
      commands,
      ...(input.baselineChecks !== undefined ? { baselineChecks: input.baselineChecks } : {}),
      ...(input.subjectEvidence !== undefined ? { subjectEvidence: input.subjectEvidence } : {}),
      ...runtimeOptions,
    }, dependencies);
    run = remediationVerification.run;
    if (!remediationVerification.buildResult) return { run, pullRequest };
    buildResult = remediationVerification.buildResult;
    const revision = await publishRemediationRevision({ run, pullRequest, packet: input.packet, ...(verdict ? { verdict } : {}), buildResult, workspace: input.workspace }, {
      git: dependencies.git, host: dependencies.host, runs: dependencies.runs, artifacts: dependencies.artifacts,
    });
    run = revision.run;
    pullRequest = revision.pullRequest;
  }

  assertLease(dependencies);
  const completed = await completeWorkItem({
    run, pullRequest, verdict, autoMerge: input.autoMerge ?? false,
    ...(dependencies.ciPolicy ? { ciPolicy: dependencies.ciPolicy } : {}),
    ...(input.batchMembers?.length ? { childIssues: input.batchMembers } : {}),
    ...(input.batchMemberContracts !== undefined ? { memberContracts: input.batchMemberContracts } : {}),
    ...(input.signal !== undefined ? { signal: input.signal } : {}),
  }, dependencies);
  return { run: completed.run, pullRequest, awaitingHuman: completed.awaitingHuman };
}

export async function resumeWorkOn(
  input: {
    run: RunState;
    intent: DurableArtifact<"Intent">;
    investigation: DurableArtifact<"Investigation">;
    packet: DurableArtifact<"BuildPacket">;
    outcome: DurableArtifact<"Outcome">;
    workspace: GitWorkspace;
    baseBranch: string;
    verification: readonly Omit<VerificationCommand, "cwd">[];
    baselineChecks?: readonly CheckResult[];
    provider?: string;
    model?: string;
    autoMerge?: boolean;
    maxRemediationCycles?: number;
    priorRemediationCycles?: number;
    priorVerificationRepairAttempts?: number;
    maxRemediationDepth?: number;
    maxRemediationChildren?: number;
    remediationDepth?: number;
    scopeExpansion?: "scope-locked" | "recursive";
    maxReviewSpecialists?: number;
    subjectEvidence?: readonly string[];
    batchMembers?: readonly number[];
    batchMemberContracts?: readonly BatchMemberContract[];
    parentRemediation?: ParentRemediationTarget;
    signal?: AbortSignal;
  },
  dependencies: WorkOnDependencies,
): Promise<WorkOnResult> {
  dependencies = guardMutationBoundaries(dependencies);
  const evidence = input.outcome.payload.failureEvidence;
  if (input.run.state !== "blocked" || !evidence) throw new Error("Only a blocked verification run with retained evidence can resume");
  if (!evidence.criterionCoverage) {
    throw new Error("Legacy verification evidence lacks builder criterion coverage and must resume through a bounded builder repair");
  }
  assertRunTargetsBranch(input.run, input.baseBranch);
  if (!workspacePathsEquivalent(evidence.workspacePath, input.workspace.path) || evidence.branch !== input.workspace.branch) {
    throw new Error("Recovery workspace does not match the durable failure evidence");
  }
  let run = input.run;
  let retainWorkspaceForRecovery = false;
  const resumed = transition(run, "RESUME_VERIFICATION", { reason: `Resuming retained workspace ${input.workspace.path}` });
  await dependencies.runs.commit(run.version, resumed.state, resumed.record);
  run = resumed.state;
  const runtimeOptions = {
    ...(input.provider !== undefined ? { provider: input.provider } : {}),
    ...(input.model !== undefined ? { model: input.model } : {}),
    ...(input.signal !== undefined ? { signal: input.signal } : {}),
  };
  const submission = {
    summary: evidence.builderSummary,
    changedPaths: evidence.changedPaths,
    criterionCoverage: evidence.criterionCoverage,
    decisions: evidence.decisions ?? [],
    residualRisks: evidence.residualRisks ?? [],
  };
  const commands = frozenPacketCommands(input.packet, input.verification, input.workspace);
  try {
    let verified = await verifyWithBuilderRepairs({
      run,
      intent: input.intent,
      investigation: input.investigation,
      packet: input.packet,
      submission,
      workspace: input.workspace,
      commands,
      ...(input.baselineChecks !== undefined ? { baselineChecks: input.baselineChecks } : {}),
      ...(input.subjectEvidence !== undefined ? { subjectEvidence: input.subjectEvidence } : {}),
      ...(input.priorVerificationRepairAttempts !== undefined ? { priorVerificationRepairAttempts: input.priorVerificationRepairAttempts } : {}),
      ...runtimeOptions,
    }, dependencies);
    run = verified.run;
    if (!verified.buildResult) return { run };
    let buildResult = verified.buildResult;
    const published = await publishPullRequest({
      run, intent: input.intent, packet: input.packet, buildResult, workspace: input.workspace,
      ...(input.parentRemediation ? { parentRemediation: { parentBranch: input.parentRemediation.parentBranch, parentPullRequest: input.parentRemediation.parentPullRequest } } : {}),
    }, { git: dependencies.git, host: dependencies.host, runs: dependencies.runs, artifacts: dependencies.artifacts });
    run = published.run;
    let pullRequest = published.pullRequest;
    let verdict: DurableArtifact<"ReviewVerdict">;
    let priorVerdict: DurableArtifact<"ReviewVerdict"> | undefined;
    let cycle = input.priorRemediationCycles ?? 0;
    while (true) {
      const reviewed = await reviewPullRequest({
        run, pullRequest, intent: input.intent, investigation: input.investigation,
        packet: input.packet, buildResult, workspace: input.workspace.path,
        findingIssuePolicy: "all",
        ...(input.maxReviewSpecialists !== undefined ? { maxReviewSpecialists: input.maxReviewSpecialists } : {}),
        ...(priorVerdict !== undefined ? { priorVerdict } : {}),
        reviewCycle: { current: cycle + 1, total: (input.maxRemediationCycles ?? 2) + 1 },
        ...runtimeOptions,
      }, {
        runtime: dependencies.runtime, host: dependencies.host, artifacts: dependencies.artifacts, runs: dependencies.runs,
        ...(dependencies.onAgentEvent !== undefined ? { onAgentEvent: dependencies.onAgentEvent } : {}),
      });
      run = reviewed.run;
      verdict = reviewed.verdict;
      priorVerdict = verdict;
      const scopeViolation = blockingFindingOutsidePacket(
        verdict, input.packet, undefined, input.scopeExpansion === "recursive",
      );
      if (scopeViolation) {
        run = await blockForScopeViolation(
          run, pullRequest, input.packet, verdict, scopeViolation, input, dependencies,
        );
        return { run, pullRequest };
      }
      if (run.state === "merging") break;
      cycle++;
      if (cycle > (input.maxRemediationCycles ?? 2)) {
        run = await blockForReviewFindings(run, pullRequest, verdict, dependencies, `Remediation budget exhausted after ${cycle - 1} cycle(s)`);
        return { run, pullRequest };
      }
      const remediated = await remediateReview({
        run, intent: input.intent, investigation: input.investigation, packet: input.packet,
        buildResult, verdict, reviewCycle: { current: cycle, total: (input.maxRemediationCycles ?? 2) + 1 }, worktree: input.workspace.path,
        verification: commands, verificationRunner: dependencies.verifier, ...runtimeOptions,
      }, {
        runtime: dependencies.runtime, runs: dependencies.runs, verifier: dependencies.verifier,
        ...(dependencies.onAgentEvent !== undefined ? { onAgentEvent: dependencies.onAgentEvent } : {}),
      });
      run = remediated.run;
      verified = await verifyWithBuilderRepairs({
        run,
        intent: input.intent,
        investigation: input.investigation,
        packet: input.packet,
        submission: remediated.submission,
        builderSessionRef: remediated.sessionRef,
        repairContext: [buildResult, verdict],
        workspace: input.workspace,
        commands,
        ...(input.baselineChecks !== undefined ? { baselineChecks: input.baselineChecks } : {}),
        ...(input.subjectEvidence !== undefined ? { subjectEvidence: input.subjectEvidence } : {}),
        ...runtimeOptions,
      }, dependencies);
      run = verified.run;
      if (!verified.buildResult) return { run, pullRequest };
      buildResult = verified.buildResult;
      const revision = await publishRemediationRevision({ run, pullRequest, packet: input.packet, ...(verdict ? { verdict } : {}), buildResult, workspace: input.workspace }, {
        git: dependencies.git, host: dependencies.host, runs: dependencies.runs, artifacts: dependencies.artifacts,
      });
      run = revision.run;
      pullRequest = revision.pullRequest;
    }
    const completed = await completeWorkItem({
      run, pullRequest, verdict, autoMerge: input.autoMerge ?? false,
    ...(dependencies.ciPolicy ? { ciPolicy: dependencies.ciPolicy } : {}),
      ...(input.batchMembers?.length ? { childIssues: input.batchMembers } : {}),
      ...(input.batchMemberContracts !== undefined ? { memberContracts: input.batchMemberContracts } : {}),
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
    }, dependencies);
    run = completed.run;
    return { run, pullRequest, awaitingHuman: completed.awaitingHuman };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const recoverable = input.signal?.aborted === true
      || error instanceof ClaimPromotionRecoveryError
      || (error instanceof WorkflowExecutionError && error.recoverable);
    if (error instanceof WorkflowExecutionError) run = error.run;
    if (recoverable) retainWorkspaceForRecovery = true;
    if (!recoverable && run.state !== "failed" && run.state !== "blocked") {
      const failed = transition(run, "FAIL", { reason });
      await dependencies.runs.commit(run.version, failed.state, failed.record);
      run = failed.state;
    }
    if (!recoverable && run.state === "failed") await appendFailureOutcome(run, reason, dependencies);
    throw error;
  } finally {
    const retainForRecovery = retainWorkspaceForRecovery || run.state === "blocked" || run.state === "failed" || run.state === "cancelled";
    if (!retainForRecovery) {
      try { await dependencies.git.remove(input.workspace); } catch { /* recovery reconciles stale worktrees */ }
    }
  }
}

export async function resumeReviewWorkOn(
  input: {
    run: RunState;
    intent: DurableArtifact<"Intent">;
    investigation: DurableArtifact<"Investigation">;
    packet: DurableArtifact<"BuildPacket">;
    buildResult: DurableArtifact<"BuildResult">;
    priorVerdict: DurableArtifact<"ReviewVerdict">;
    pullRequest: PullRequestSnapshot;
    workspace: GitWorkspace;
    baseBranch: string;
    verification: readonly Omit<VerificationCommand, "cwd">[];
    baselineChecks?: readonly CheckResult[];
    provider?: string;
    model?: string;
    autoMerge?: boolean;
    maxRemediationCycles?: number;
    priorRemediationCycles?: number;
    maxRemediationDepth?: number;
    maxRemediationChildren?: number;
    remediationDepth?: number;
    scopeExpansion?: "scope-locked" | "recursive";
    maxReviewSpecialists?: number;
    subjectEvidence?: readonly string[];
    batchMembers?: readonly number[];
    batchMemberContracts?: readonly BatchMemberContract[];
    parentRemediation?: ParentRemediationTarget;
    signal?: AbortSignal;
  },
  dependencies: WorkOnDependencies,
): Promise<WorkOnResult> {
  dependencies = guardMutationBoundaries(dependencies);
  const budgetBlocked = input.run.state === "blocked"
    && /^Remediation budget exhausted after \d+ cycle\(s\)$/i.test(input.run.blockedReason ?? "");
  const interruptedRemediation = input.run.state === "remediating";
  if (!budgetBlocked && !interruptedRemediation) {
    throw new Error("Remediation resume requires an interrupted remediation or remediation-budget blocked run");
  }
  assertRunTargetsBranch(input.run, input.baseBranch);
  if (input.priorVerdict.payload.disposition !== "request_changes"
    || input.priorVerdict.payload.headSha !== input.buildResult.payload.headSha
    || input.pullRequest.headSha !== input.buildResult.payload.headSha
    || input.pullRequest.baseBranch !== input.baseBranch) {
    throw new Error("Review resume requires one matching request-changes verdict, verified Build Result, and open PR head");
  }
  let run = input.run;
  let retainWorkspaceForRecovery = false;
  const resumed = transition(run, budgetBlocked ? "RESUME_REVIEW" : "RESUME_REMEDIATION", {
    reason: budgetBlocked
      ? `Reassessing exhausted findings at ${input.buildResult.payload.headSha} against the frozen scope before authorizing any further remediation`
      : `Continuing accepted review remediation at ${input.buildResult.payload.headSha} from the retained verified workspace`,
    headSha: input.buildResult.payload.headSha,
  });
  await dependencies.runs.commit(run.version, resumed.state, resumed.record);
  run = resumed.state;
  const runtimeOptions = {
    ...(input.provider !== undefined ? { provider: input.provider } : {}),
    ...(input.model !== undefined ? { model: input.model } : {}),
    ...(input.signal !== undefined ? { signal: input.signal } : {}),
  };
  const commands = frozenPacketCommands(input.packet, input.verification, input.workspace);
  let buildResult = input.buildResult;
  let pullRequest = input.pullRequest;
  let verdict = input.priorVerdict;
  const exhaustedCycleCount = Number(/^Remediation budget exhausted after (\d+) cycle\(s\)$/i
    .exec(input.run.blockedReason ?? "")?.[1] ?? 0);
  let cycle = Math.max(0, input.priorRemediationCycles ?? (interruptedRemediation ? 1 : exhaustedCycleCount));
  const remediationLimit = input.maxRemediationCycles ?? 2;
  try {
    if (budgetBlocked) {
      const reassessed = await reviewPullRequest({
        run, pullRequest, intent: input.intent, investigation: input.investigation,
        packet: input.packet, buildResult, workspace: input.workspace.path,
        findingIssuePolicy: "all",
        allowSameHeadReassessment: true,
        ...(input.maxReviewSpecialists !== undefined ? { maxReviewSpecialists: input.maxReviewSpecialists } : {}),
        priorVerdict: verdict,
        reviewCycle: { current: cycle + 1, total: remediationLimit + 1 },
        ...runtimeOptions,
      }, {
        runtime: dependencies.runtime, host: dependencies.host, artifacts: dependencies.artifacts, runs: dependencies.runs,
        ...(dependencies.onAgentEvent !== undefined ? { onAgentEvent: dependencies.onAgentEvent } : {}),
      });
      run = reassessed.run;
      verdict = reassessed.verdict;
      const scopeViolation = blockingFindingOutsidePacket(
        verdict, input.packet, undefined, input.scopeExpansion === "recursive",
      );
      if (scopeViolation) {
        run = await blockForScopeViolation(
          run, pullRequest, input.packet, verdict, scopeViolation, input, dependencies,
        );
        return { run, pullRequest };
      }
      if (run.state === "merging") {
        const completed = await completeWorkItem({
          run, pullRequest, verdict, autoMerge: input.autoMerge ?? false,
    ...(dependencies.ciPolicy ? { ciPolicy: dependencies.ciPolicy } : {}),
          ...(input.batchMembers?.length ? { childIssues: input.batchMembers } : {}),
          ...(input.batchMemberContracts !== undefined ? { memberContracts: input.batchMemberContracts } : {}),
          ...(input.signal !== undefined ? { signal: input.signal } : {}),
        }, dependencies);
        run = completed.run;
        return { run, pullRequest, awaitingHuman: completed.awaitingHuman };
      }
      if (cycle >= remediationLimit) {
        run = await blockForReviewFindings(
          run,
          pullRequest,
          verdict,
          dependencies,
          `Remediation budget exhausted after ${cycle} cycle(s)`,
        );
        return { run, pullRequest };
      }
      cycle += 1;
    }

    const firstRemediation = await remediateReview({
      run, intent: input.intent, investigation: input.investigation, packet: input.packet,
      buildResult, verdict, reviewCycle: { current: cycle, total: remediationLimit + 1 }, worktree: input.workspace.path,
      verification: commands, verificationRunner: dependencies.verifier, ...runtimeOptions,
    }, {
      runtime: dependencies.runtime, runs: dependencies.runs, verifier: dependencies.verifier,
      ...(dependencies.onAgentEvent !== undefined ? { onAgentEvent: dependencies.onAgentEvent } : {}),
    });
    run = firstRemediation.run;
    let verified = await verifyWithBuilderRepairs({
      run,
      intent: input.intent,
      investigation: input.investigation,
      packet: input.packet,
      submission: firstRemediation.submission,
      builderSessionRef: firstRemediation.sessionRef,
      repairContext: [buildResult, verdict],
      workspace: input.workspace,
      commands,
      ...(input.baselineChecks !== undefined ? { baselineChecks: input.baselineChecks } : {}),
      ...(input.subjectEvidence !== undefined ? { subjectEvidence: input.subjectEvidence } : {}),
      ...runtimeOptions,
    }, dependencies);
    run = verified.run;
    if (!verified.buildResult) return { run, pullRequest };
    buildResult = verified.buildResult;
    let revision = await publishRemediationRevision({ run, pullRequest, packet: input.packet, ...(verdict ? { verdict } : {}), buildResult, workspace: input.workspace }, {
      git: dependencies.git, host: dependencies.host, runs: dependencies.runs, artifacts: dependencies.artifacts,
    });
    run = revision.run;
    pullRequest = revision.pullRequest;

    while (true) {
      const reviewed = await reviewPullRequest({
        run, pullRequest, intent: input.intent, investigation: input.investigation,
        packet: input.packet, buildResult, workspace: input.workspace.path,
        findingIssuePolicy: "all",
        ...(input.maxReviewSpecialists !== undefined ? { maxReviewSpecialists: input.maxReviewSpecialists } : {}),
        priorVerdict: verdict,
        reviewCycle: { current: cycle + 1, total: remediationLimit + 1 },
        ...runtimeOptions,
      }, {
        runtime: dependencies.runtime, host: dependencies.host, artifacts: dependencies.artifacts, runs: dependencies.runs,
        ...(dependencies.onAgentEvent !== undefined ? { onAgentEvent: dependencies.onAgentEvent } : {}),
      });
      run = reviewed.run;
      verdict = reviewed.verdict;
      const scopeViolation = blockingFindingOutsidePacket(
        verdict, input.packet, undefined, input.scopeExpansion === "recursive",
      );
      if (scopeViolation) {
        run = await blockForScopeViolation(
          run, pullRequest, input.packet, verdict, scopeViolation, input, dependencies,
        );
        return { run, pullRequest };
      }
      if (run.state === "merging") break;
      cycle++;
      if (cycle > remediationLimit) {
        run = await blockForReviewFindings(run, pullRequest, verdict, dependencies, `Remediation budget exhausted after ${cycle - 1} cycle(s)`);
        return { run, pullRequest };
      }
      const remediated = await remediateReview({
        run, intent: input.intent, investigation: input.investigation, packet: input.packet,
        buildResult, verdict, reviewCycle: { current: cycle, total: remediationLimit + 1 }, worktree: input.workspace.path, ...runtimeOptions,
      }, {
        runtime: dependencies.runtime, runs: dependencies.runs,
        ...(dependencies.onAgentEvent !== undefined ? { onAgentEvent: dependencies.onAgentEvent } : {}),
      });
      run = remediated.run;
      verified = await verifyWithBuilderRepairs({
        run,
        intent: input.intent,
        investigation: input.investigation,
        packet: input.packet,
        submission: remediated.submission,
        builderSessionRef: remediated.sessionRef,
        repairContext: [buildResult, verdict],
        workspace: input.workspace,
        commands,
        ...(input.baselineChecks !== undefined ? { baselineChecks: input.baselineChecks } : {}),
        ...(input.subjectEvidence !== undefined ? { subjectEvidence: input.subjectEvidence } : {}),
        ...runtimeOptions,
      }, dependencies);
      run = verified.run;
      if (!verified.buildResult) return { run, pullRequest };
      buildResult = verified.buildResult;
      revision = await publishRemediationRevision({ run, pullRequest, packet: input.packet, ...(verdict ? { verdict } : {}), buildResult, workspace: input.workspace }, {
        git: dependencies.git, host: dependencies.host, runs: dependencies.runs, artifacts: dependencies.artifacts,
      });
      run = revision.run;
      pullRequest = revision.pullRequest;
    }

    const completed = await completeWorkItem({
      run, pullRequest, verdict, autoMerge: input.autoMerge ?? false,
    ...(dependencies.ciPolicy ? { ciPolicy: dependencies.ciPolicy } : {}),
      ...(input.batchMembers?.length ? { childIssues: input.batchMembers } : {}),
      ...(input.batchMemberContracts !== undefined ? { memberContracts: input.batchMemberContracts } : {}),
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
    }, dependencies);
    run = completed.run;
    return { run, pullRequest, awaitingHuman: completed.awaitingHuman };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const recoverable = input.signal?.aborted === true
      || error instanceof ClaimPromotionRecoveryError
      || (error instanceof WorkflowExecutionError && error.recoverable);
    if (error instanceof WorkflowExecutionError) run = error.run;
    if (recoverable) retainWorkspaceForRecovery = true;
    if (!recoverable && run.state !== "failed" && run.state !== "blocked") {
      const failed = transition(run, "FAIL", { reason });
      await dependencies.runs.commit(run.version, failed.state, failed.record);
      run = failed.state;
    }
    if (!recoverable && run.state === "failed") await appendFailureOutcome(run, reason, dependencies);
    throw error;
  } finally {
    const retainForRecovery = retainWorkspaceForRecovery || run.state === "blocked" || run.state === "failed" || run.state === "cancelled";
    if (!retainForRecovery) {
      try { await dependencies.git.remove(input.workspace); } catch { /* recovery reconciles stale worktrees */ }
    }
  }
}

/**
 * Resume a recursive parent only after child Outcomes, branch advancement, and
 * controller-owned verification have produced a fresh proof at the new SHA.
 */
export async function resumeExpandedReviewWorkOn(
  input: {
    run: RunState;
    intent: DurableArtifact<"Intent">;
    investigation: DurableArtifact<"Investigation">;
    packet: DurableArtifact<"BuildPacket">;
    checkpoint: DurableArtifact<"RemediationBlocked">;
    priorVerdict: DurableArtifact<"ReviewVerdict">;
    pullRequest: PullRequestSnapshot;
    workspace: GitWorkspace;
    baseBranch: string;
    verification: readonly Omit<VerificationCommand, "cwd">[];
    provider?: string;
    model?: string;
    autoMerge?: boolean;
    maxReviewSpecialists?: number;
    subjectEvidence?: readonly string[];
    batchMembers?: readonly number[];
    batchMemberContracts?: readonly BatchMemberContract[];
    scopeExpansion?: "scope-locked" | "recursive";
    maxRemediationDepth?: number;
    maxRemediationChildren?: number;
    remediationDepth?: number;
    parentRemediation?: ParentRemediationTarget;
    signal?: AbortSignal;
  },
  dependencies: WorkOnDependencies,
): Promise<WorkOnResult> {
  dependencies = guardMutationBoundaries(dependencies);
  if (input.run.state !== "blocked") throw new Error(`Expanded review resume requires blocked state, found ${input.run.state}`);
  if (input.checkpoint.payload.status !== "ready-to-resume") throw new Error("Expanded review resume requires a ready remediation checkpoint");
  assertRunTargetsBranch(input.run, input.baseBranch);
  const commands = frozenPacketCommands(input.packet, input.verification, input.workspace);
  const proof = await verifyParentRevision({
    run: input.run,
    packet: input.packet,
    checkpoint: input.checkpoint,
    pullRequest: input.pullRequest,
    commands,
    workspace: input.workspace,
    verifier: dependencies.verifier,
  }, {
    host: dependencies.host,
    git: dependencies.git,
    artifacts: dependencies.artifacts,
    runs: dependencies.runs,
  });
  if (!proof.buildResult || proof.run.state !== "reviewing") return { run: proof.run, pullRequest: input.pullRequest };

  const reviewed = await reviewPullRequest({
    run: proof.run,
    pullRequest: { ...input.pullRequest, headSha: proof.buildResult.payload.headSha },
    intent: input.intent,
    investigation: input.investigation,
    packet: input.packet,
    buildResult: proof.buildResult,
    workspace: input.workspace.path,
    findingIssuePolicy: "all",
    priorVerdict: input.priorVerdict,
    reviewCycle: { current: 1, total: 1 },
    ...(input.provider !== undefined ? { provider: input.provider } : {}),
    ...(input.model !== undefined ? { model: input.model } : {}),
    ...(input.maxReviewSpecialists !== undefined ? { maxReviewSpecialists: input.maxReviewSpecialists } : {}),
    ...(input.signal !== undefined ? { signal: input.signal } : {}),
  }, {
    runtime: dependencies.runtime,
    host: dependencies.host,
    artifacts: dependencies.artifacts,
    runs: dependencies.runs,
    ...(dependencies.onAgentEvent !== undefined ? { onAgentEvent: dependencies.onAgentEvent } : {}),
  });
  const expandedViolation = blockingFindingOutsidePacket(
    reviewed.verdict, input.packet, input.checkpoint, input.scopeExpansion === "recursive",
  );
  if (expandedViolation && input.scopeExpansion === "recursive") {
    await new RemediationSupervisor({ host: dependencies.host, artifacts: dependencies.artifacts, runs: dependencies.runs }).terminalize(input.checkpoint);
    return {
      run: await blockForScopeViolation(reviewed.run, input.pullRequest, input.packet, reviewed.verdict, expandedViolation, {
        scopeExpansion: input.scopeExpansion,
        ...(input.maxRemediationDepth !== undefined ? { maxRemediationDepth: input.maxRemediationDepth } : {}),
        ...(input.maxRemediationChildren !== undefined ? { maxRemediationChildren: input.maxRemediationChildren } : {}),
        ...(input.remediationDepth !== undefined ? { remediationDepth: input.remediationDepth } : {}),
        ...(input.parentRemediation !== undefined ? { parentRemediation: input.parentRemediation } : {}),
        approvedPaths: input.checkpoint.payload.approvedPaths,
      }, dependencies),
      pullRequest: input.pullRequest,
    };
  }
  if (reviewed.run.state !== "merging") {
    const reason = expandedViolation ?? "Fresh expanded-scope review requested additional changes";
    await new RemediationSupervisor({ host: dependencies.host, artifacts: dependencies.artifacts, runs: dependencies.runs }).terminalize(input.checkpoint);
    return { run: await blockForReviewFindings(reviewed.run, input.pullRequest, reviewed.verdict, dependencies, reason), pullRequest: input.pullRequest };
  }
  const completed = await completeWorkItem({
    run: reviewed.run,
    pullRequest: { ...input.pullRequest, headSha: proof.buildResult.payload.headSha },
    verdict: reviewed.verdict,
    autoMerge: input.autoMerge ?? false,
    ...(dependencies.ciPolicy ? { ciPolicy: dependencies.ciPolicy } : {}),
    ...(input.batchMembers?.length ? { childIssues: input.batchMembers } : {}),
    ...(input.batchMemberContracts !== undefined ? { memberContracts: input.batchMemberContracts } : {}),
    ...(input.signal !== undefined ? { signal: input.signal } : {}),
  }, dependencies);
  return { run: completed.run, pullRequest: { ...input.pullRequest, headSha: proof.buildResult.payload.headSha }, awaitingHuman: completed.awaitingHuman };
}

export async function resumePublicationWorkOn(
  input: {
    run: RunState;
    intent: DurableArtifact<"Intent">;
    investigation: DurableArtifact<"Investigation">;
    packet: DurableArtifact<"BuildPacket">;
    buildResult: DurableArtifact<"BuildResult">;
    priorVerdict?: DurableArtifact<"ReviewVerdict">;
    workspace: GitWorkspace;
    baseBranch: string;
    verification: readonly Omit<VerificationCommand, "cwd">[];
    baselineChecks?: readonly CheckResult[];
    provider?: string;
    model?: string;
    autoMerge?: boolean;
    maxRemediationCycles?: number;
    priorRemediationCycles?: number;
    maxRemediationDepth?: number;
    maxRemediationChildren?: number;
    remediationDepth?: number;
    scopeExpansion?: "scope-locked" | "recursive";
    maxReviewSpecialists?: number;
    subjectEvidence?: readonly string[];
    batchMembers?: readonly number[];
    batchMemberContracts?: readonly BatchMemberContract[];
    parentRemediation?: ParentRemediationTarget;
    signal?: AbortSignal;
  },
  dependencies: WorkOnDependencies,
): Promise<WorkOnResult> {
  dependencies = guardMutationBoundaries(dependencies);
  if (input.run.state !== "publishing" && input.run.state !== "failed") {
    throw new Error(`Publication resume requires publishing or recoverable failed state, found ${input.run.state}`);
  }
  assertRunTargetsBranch(input.run, input.baseBranch);
  const recoveringRevision = input.run.state === "failed";
  if (recoveringRevision) {
    const expectedHead = /^Published remediation head [0-9a-f]{7,64} does not match verified build ([0-9a-f]{7,64})$/i
      .exec(input.run.failure ?? "")?.[1];
    const findingProjectionFailure = /review[- ]finding|projection|authoritative identity/i.test(input.run.failure ?? "");
    if ((!input.priorVerdict
      || input.priorVerdict.payload.headSha === input.buildResult.payload.headSha
      || expectedHead?.toLowerCase() !== input.buildResult.payload.headSha.toLowerCase()) && !findingProjectionFailure) {
      throw new Error("Failed run does not carry proof of a newer verified remediation head after a stale PR projection");
    }
  }
  let run = input.run;
  let retainWorkspaceForRecovery = false;
  const resumed = transition(run, recoveringRevision ? "RECOVER_REVISION_PUBLICATION" : "RESUME_PUBLICATION", {
    reason: recoveringRevision
      ? `Recovering verified remediation head ${input.buildResult.payload.headSha} after its PR projection lagged the pushed branch`
      : `Resuming verified head ${input.buildResult.payload.headSha} without replaying build or verification`,
  });
  await dependencies.runs.commit(run.version, resumed.state, resumed.record);
  run = resumed.state;
  const runtimeOptions = {
    ...(input.provider !== undefined ? { provider: input.provider } : {}),
    ...(input.model !== undefined ? { model: input.model } : {}),
    ...(input.signal !== undefined ? { signal: input.signal } : {}),
  };
  const commands = frozenPacketCommands(input.packet, input.verification, input.workspace);
  let buildResult = input.buildResult;
  try {
    const published = await publishPullRequest({
      run, intent: input.intent, packet: input.packet, buildResult, workspace: input.workspace,
      ...(input.parentRemediation ? { parentRemediation: { parentBranch: input.parentRemediation.parentBranch, parentPullRequest: input.parentRemediation.parentPullRequest } } : {}),
    }, { git: dependencies.git, host: dependencies.host, runs: dependencies.runs, artifacts: dependencies.artifacts });
    run = published.run;
    let pullRequest = published.pullRequest;
    let verdict!: DurableArtifact<"ReviewVerdict">;
    let priorVerdict = input.priorVerdict;
    let cycle = input.priorRemediationCycles ?? 0;
    let resumedProjectionReview: Awaited<ReturnType<typeof resumeReviewFindingProjection>> | undefined;
    const projectionArtifacts = await dependencies.artifacts.list({
      repo: pullRequest.repo,
      ...(run.subject.issue ? { issue: run.subject.issue } : {}),
      pr: pullRequest.number,
    }, "ReviewFindingProjection");
    const projectionCheckpoint = projectionArtifacts
      .filter((artifact): artifact is DurableArtifact<"ReviewFindingProjection"> => artifact.kind === "ReviewFindingProjection"
        && artifact.runId === run.runId
        && artifact.payload.headSha.toLowerCase() === pullRequest.headSha.toLowerCase()
        && (artifact.payload.status === "planned" || artifact.payload.status === "completed"))
      .at(-1);
    if (projectionCheckpoint && priorVerdict?.payload.headSha.toLowerCase() !== pullRequest.headSha.toLowerCase()) {
      resumedProjectionReview = await resumeReviewFindingProjection({ run, pullRequest, projection: projectionCheckpoint }, {
        host: dependencies.host,
        artifacts: dependencies.artifacts,
        runs: dependencies.runs,
      });
      run = resumedProjectionReview.run;
      verdict = resumedProjectionReview.verdict;
      priorVerdict = verdict;
    }
    while (true) {
      if (resumedProjectionReview) {
        resumedProjectionReview = undefined;
      } else {
        const reviewed = await reviewPullRequest({
          run, pullRequest, intent: input.intent, investigation: input.investigation,
          packet: input.packet, buildResult, workspace: input.workspace.path,
          findingIssuePolicy: "all",
          ...(input.maxReviewSpecialists !== undefined ? { maxReviewSpecialists: input.maxReviewSpecialists } : {}),
          ...(priorVerdict !== undefined ? { priorVerdict } : {}),
          reviewCycle: { current: cycle + 1, total: (input.maxRemediationCycles ?? 2) + 1 },
          ...runtimeOptions,
        }, {
          runtime: dependencies.runtime, host: dependencies.host, artifacts: dependencies.artifacts, runs: dependencies.runs,
          ...(dependencies.onAgentEvent !== undefined ? { onAgentEvent: dependencies.onAgentEvent } : {}),
        });
        run = reviewed.run;
        verdict = reviewed.verdict;
        priorVerdict = verdict;
      }
      const scopeViolation = blockingFindingOutsidePacket(
        verdict, input.packet, undefined, input.scopeExpansion === "recursive",
      );
      if (scopeViolation) {
        run = await blockForScopeViolation(
          run, pullRequest, input.packet, verdict, scopeViolation, input, dependencies,
        );
        return { run, pullRequest };
      }
      if (run.state === "merging") break;
      cycle++;
      if (cycle > (input.maxRemediationCycles ?? 2)) {
        run = await blockForReviewFindings(run, pullRequest, verdict, dependencies, `Remediation budget exhausted after ${cycle - 1} cycle(s)`);
        return { run, pullRequest };
      }
      const remediated = await remediateReview({
        run, intent: input.intent, investigation: input.investigation, packet: input.packet,
        buildResult, verdict, reviewCycle: { current: cycle, total: (input.maxRemediationCycles ?? 2) + 1 }, worktree: input.workspace.path,
        verification: commands, verificationRunner: dependencies.verifier, ...runtimeOptions,
      }, {
        runtime: dependencies.runtime, runs: dependencies.runs, verifier: dependencies.verifier,
        ...(dependencies.onAgentEvent !== undefined ? { onAgentEvent: dependencies.onAgentEvent } : {}),
      });
      run = remediated.run;
      const verified = await verifyWithBuilderRepairs({
        run,
        intent: input.intent,
        investigation: input.investigation,
        packet: input.packet,
        submission: remediated.submission,
        builderSessionRef: remediated.sessionRef,
        repairContext: [buildResult, verdict],
        workspace: input.workspace,
        commands,
        ...(input.baselineChecks !== undefined ? { baselineChecks: input.baselineChecks } : {}),
        ...(input.subjectEvidence !== undefined ? { subjectEvidence: input.subjectEvidence } : {}),
        ...runtimeOptions,
      }, dependencies);
      run = verified.run;
      if (!verified.buildResult) return { run, pullRequest };
      buildResult = verified.buildResult;
      const revision = await publishRemediationRevision({ run, pullRequest, packet: input.packet, ...(verdict ? { verdict } : {}), buildResult, workspace: input.workspace }, {
        git: dependencies.git, host: dependencies.host, runs: dependencies.runs, artifacts: dependencies.artifacts,
      });
      run = revision.run;
      pullRequest = revision.pullRequest;
    }
    const completed = await completeWorkItem({
      run, pullRequest, verdict, autoMerge: input.autoMerge ?? false,
    ...(dependencies.ciPolicy ? { ciPolicy: dependencies.ciPolicy } : {}),
      ...(input.batchMembers?.length ? { childIssues: input.batchMembers } : {}),
      ...(input.batchMemberContracts !== undefined ? { memberContracts: input.batchMemberContracts } : {}),
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
    }, dependencies);
    run = completed.run;
    return { run, pullRequest, awaitingHuman: completed.awaitingHuman };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const recoverable = input.signal?.aborted === true
      || error instanceof ClaimPromotionRecoveryError
      || (error instanceof WorkflowExecutionError && error.recoverable);
    if (error instanceof WorkflowExecutionError) run = error.run;
    if (recoverable) retainWorkspaceForRecovery = true;
    if (!recoverable && run.state !== "failed" && run.state !== "blocked") {
      const failed = transition(run, "FAIL", { reason });
      await dependencies.runs.commit(run.version, failed.state, failed.record);
      run = failed.state;
    }
    if (!recoverable && run.state === "failed") await appendFailureOutcome(run, reason, dependencies);
    throw error;
  } finally {
    const retainForRecovery = retainWorkspaceForRecovery || run.state === "blocked" || run.state === "failed" || run.state === "cancelled";
    if (!retainForRecovery) {
      try { await dependencies.git.remove(input.workspace); } catch { /* recovery reconciles stale worktrees */ }
    }
  }
}

export async function resumeCompletionWorkOn(
  input: {
    run: RunState;
    verdict: DurableArtifact<"ReviewVerdict">;
    pullRequest: PullRequestSnapshot;
    autoMerge?: boolean;
    batchMembers?: readonly number[];
    batchMemberContracts?: readonly BatchMemberContract[];
    workspace?: GitWorkspace;
    signal?: AbortSignal;
  },
  dependencies: WorkOnDependencies,
): Promise<WorkOnResult> {
  dependencies = guardMutationBoundaries(dependencies);
  if (input.run.state !== "merging" && input.run.state !== "closing") throw new Error(`Completion resume requires merging or closing state, found ${input.run.state}`);
  if (input.verdict.payload.disposition !== "approve"
    || input.verdict.payload.headSha !== input.pullRequest.headSha) {
    throw new Error("Completion resume requires an approving verdict for the current pull request head");
  }
  let run = input.run;
  let retainWorkspaceForRecovery = false;
  try {
    if (run.state === "merging") {
      const resumed = transition(run, "RESUME_COMPLETION", {
        reason: `Resuming idempotent merge and issue closure at approved head ${input.verdict.payload.headSha}`,
        headSha: input.verdict.payload.headSha,
      });
      await dependencies.runs.commit(run.version, resumed.state, resumed.record);
      run = resumed.state;
    }
    const completed = await completeWorkItem({
      run,
      pullRequest: input.pullRequest,
      verdict: input.verdict,
      autoMerge: input.autoMerge ?? false,
    ...(dependencies.ciPolicy ? { ciPolicy: dependencies.ciPolicy } : {}),
      ...(input.batchMembers?.length ? { childIssues: input.batchMembers } : {}),
      ...(input.batchMemberContracts !== undefined ? { memberContracts: input.batchMemberContracts } : {}),
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
    }, dependencies);
    run = completed.run;
    return { run, pullRequest: input.pullRequest, awaitingHuman: completed.awaitingHuman };
  } catch (error) {
    if (input.signal?.aborted) throw error;
    const reason = error instanceof Error ? error.message : String(error);
    if (error instanceof WorkflowExecutionError) run = error.run;
    if (error instanceof WorkflowExecutionError && error.recoverable) {
      // completeWorkItem has already persisted the exact merged head as the
      // closing checkpoint. Keep it resumable instead of converting an
      // ambiguous external side effect into FAIL.
      retainWorkspaceForRecovery = true;
      throw error;
    }
    if (run.state !== "failed" && run.state !== "blocked") {
      const failed = transition(run, "FAIL", { reason });
      await dependencies.runs.commit(run.version, failed.state, failed.record);
      run = failed.state;
    }
    if (run.state === "failed") await appendFailureOutcome(run, reason, dependencies);
    throw error;
  } finally {
    if (input.workspace && !input.signal?.aborted && !retainWorkspaceForRecovery
      && run.state !== "failed" && run.state !== "blocked" && run.state !== "cancelled") {
      try { await dependencies.git.remove(input.workspace); } catch { /* stale worktree reconciliation is operational */ }
    }
  }
}

/**
 * Explicitly recover a confirmed target conflict. This path synchronizes and
 * verifies a new descendant revision, then deliberately starts review with no
 * prior verdict so an approval for the old SHA cannot authorize the new one.
 */
export async function resumeConflictRecoveryWorkOn(
  input: {
    run: RunState;
    intent: DurableArtifact<"Intent">;
    investigation: DurableArtifact<"Investigation">;
    packet: DurableArtifact<"BuildPacket">;
    buildResult: DurableArtifact<"BuildResult">;
    verdict: DurableArtifact<"ReviewVerdict">;
    pullRequest: PullRequestSnapshot;
    workspace: GitWorkspace;
    baseBranch: string;
    verification: readonly Omit<VerificationCommand, "cwd">[];
    mergeGate: NonNullable<DurableArtifact<"Outcome">["payload"]["mergeGate"]>;
    provider?: string;
    model?: string;
    autoMerge?: boolean;
    maxRemediationCycles?: number;
    maxRemediationDepth?: number;
    maxRemediationChildren?: number;
    remediationDepth?: number;
    scopeExpansion?: "scope-locked" | "recursive";
    maxReviewSpecialists?: number;
    subjectEvidence?: readonly string[];
    batchMembers?: readonly number[];
    batchMemberContracts?: readonly BatchMemberContract[];
    signal?: AbortSignal;
  },
  dependencies: WorkOnDependencies,
): Promise<WorkOnResult> {
  dependencies = guardMutationBoundaries(dependencies);
  if (input.run.state !== "blocked") throw new Error(`Conflict recovery requires blocked state, found ${input.run.state}`);
  if (input.verdict.payload.disposition !== "approve") throw new Error("Conflict recovery requires an approving verdict");
  if (input.mergeGate.mergeability !== "conflicting") throw new Error("Conflict recovery requires confirmed conflicting mergeability");
  assertRunTargetsBranch(input.run, input.baseBranch);
  if (input.pullRequest.baseBranch !== input.baseBranch
    || input.pullRequest.headSha !== input.buildResult.payload.headSha
    || input.verdict.payload.headSha !== input.buildResult.payload.headSha
    || input.mergeGate.pullRequest !== input.pullRequest.number
    || input.mergeGate.baseBranch !== input.baseBranch
    || (input.mergeGate.repo !== undefined && input.mergeGate.repo.toLowerCase() !== input.pullRequest.repo.toLowerCase())
    || input.run.subject.repo.toLowerCase() !== input.pullRequest.repo.toLowerCase()
    || (input.verdict.subject.pr !== undefined && input.verdict.subject.pr !== input.pullRequest.number)
    || (input.verdict.payload.baseBranch !== undefined && input.verdict.payload.baseBranch !== input.baseBranch)) {
    throw new Error("Conflict recovery requires one matching approved PR, Build Result, and Review Verdict head");
  }
  let run = input.run;
  let retainWorkspaceForRecovery = true;
  const commands = frozenPacketCommands(input.packet, input.verification, input.workspace);
  try {
    const synchronized = await recoverConflictingRevision({
      run,
      intent: input.intent,
      investigation: input.investigation,
      packet: input.packet,
      buildResult: input.buildResult,
      verdict: input.verdict,
      pullRequest: input.pullRequest,
      workspace: input.workspace,
      commands,
      mergeGate: input.mergeGate,
      ...(input.provider !== undefined ? { provider: input.provider } : {}),
      ...(input.model !== undefined ? { model: input.model } : {}),
      ...(input.subjectEvidence !== undefined ? { subjectEvidence: input.subjectEvidence } : {}),
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
    }, {
      runtime: dependencies.runtime,
      artifacts: dependencies.artifacts,
      runs: dependencies.runs,
      git: dependencies.git,
      verifier: dependencies.verifier,
      host: dependencies.host,
      ...(dependencies.onAgentEvent !== undefined ? { onAgentEvent: dependencies.onAgentEvent } : {}),
    });
    run = synchronized.run;
    if (!synchronized.buildResult || !synchronized.pullRequest || run.state !== "reviewing") {
      return { run, ...(synchronized.pullRequest ? { pullRequest: synchronized.pullRequest } : {}) };
    }

    // A new head has a new authority chain. Never pass input.verdict as
    // priorVerdict to the first review after synchronization.
    let buildResult = synchronized.buildResult;
    let pullRequest = synchronized.pullRequest;
    let verdict: DurableArtifact<"ReviewVerdict">;
    let priorVerdict: DurableArtifact<"ReviewVerdict"> | undefined;
    let cycle = 0;
    const remediationLimit = input.maxRemediationCycles ?? 2;
    const runtimeOptions = {
      ...(input.provider !== undefined ? { provider: input.provider } : {}),
      ...(input.model !== undefined ? { model: input.model } : {}),
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
    };
    while (true) {
      const reviewed = await reviewPullRequest({
        run,
        pullRequest,
        intent: input.intent,
        investigation: input.investigation,
        packet: input.packet,
        buildResult,
        workspace: input.workspace.path,
        findingIssuePolicy: "all",
        ...(input.maxReviewSpecialists !== undefined ? { maxReviewSpecialists: input.maxReviewSpecialists } : {}),
        ...(priorVerdict !== undefined ? { priorVerdict } : {}),
        reviewCycle: { current: cycle + 1, total: remediationLimit + 1 },
        ...runtimeOptions,
      }, {
        runtime: dependencies.runtime,
        host: dependencies.host,
        artifacts: dependencies.artifacts,
        runs: dependencies.runs,
        ...(dependencies.onAgentEvent !== undefined ? { onAgentEvent: dependencies.onAgentEvent } : {}),
      });
      run = reviewed.run;
      verdict = reviewed.verdict;
      priorVerdict = verdict;
      const scopeViolation = blockingFindingOutsidePacket(
        verdict,
        input.packet,
        undefined,
        input.scopeExpansion === "recursive",
      );
      if (scopeViolation) {
        run = await blockForScopeViolation(run, pullRequest, input.packet, verdict, scopeViolation, input, dependencies);
        return { run, pullRequest };
      }
      if (run.state === "merging") break;
      cycle += 1;
      if (cycle > remediationLimit) {
        run = await blockForReviewFindings(run, pullRequest, verdict, dependencies, `Remediation budget exhausted after ${cycle - 1} cycle(s)`);
        return { run, pullRequest };
      }
      const remediated = await remediateReview({
        run,
        intent: input.intent,
        investigation: input.investigation,
        packet: input.packet,
        buildResult,
        verdict,
        reviewCycle: { current: cycle, total: remediationLimit + 1 },
        worktree: input.workspace.path,
        verification: commands,
        verificationRunner: dependencies.verifier,
        ...runtimeOptions,
      }, {
        runtime: dependencies.runtime,
        runs: dependencies.runs,
        verifier: dependencies.verifier,
        ...(dependencies.onAgentEvent !== undefined ? { onAgentEvent: dependencies.onAgentEvent } : {}),
      });
      run = remediated.run;
      const verified = await verifyWithBuilderRepairs({
        run,
        intent: input.intent,
        investigation: input.investigation,
        packet: input.packet,
        submission: remediated.submission,
        builderSessionRef: remediated.sessionRef,
        repairContext: [buildResult, verdict],
        workspace: input.workspace,
        commands,
        ...(input.subjectEvidence !== undefined ? { subjectEvidence: input.subjectEvidence } : {}),
        ...runtimeOptions,
      }, dependencies);
      run = verified.run;
      if (!verified.buildResult) return { run, pullRequest };
      buildResult = verified.buildResult;
      const published = await publishRemediationRevision({ run, pullRequest, packet: input.packet, ...(verdict ? { verdict } : {}), buildResult, workspace: input.workspace }, {
        git: dependencies.git,
        host: dependencies.host,
        runs: dependencies.runs,
        artifacts: dependencies.artifacts,
      });
      run = published.run;
      pullRequest = published.pullRequest;
    }
    const completed = await completeWorkItem({
      run,
      pullRequest,
      verdict,
      autoMerge: input.autoMerge ?? false,
    ...(dependencies.ciPolicy ? { ciPolicy: dependencies.ciPolicy } : {}),
      ...(input.batchMembers?.length ? { childIssues: input.batchMembers } : {}),
      ...(input.batchMemberContracts !== undefined ? { memberContracts: input.batchMemberContracts } : {}),
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
    }, dependencies);
    run = completed.run;
    retainWorkspaceForRecovery = false;
    return { run, pullRequest, awaitingHuman: completed.awaitingHuman };
  } catch (error) {
    if (input.signal?.aborted) {
      retainWorkspaceForRecovery = true;
      throw error;
    }
    const reason = error instanceof Error ? error.message : String(error);
    if (error instanceof WorkflowExecutionError) run = error.run;
    if (run.state !== "failed" && run.state !== "blocked") {
      const failed = transition(run, "FAIL", { reason });
      await dependencies.runs.commit(run.version, failed.state, failed.record);
      run = failed.state;
    }
    if (run.state === "failed") await appendFailureOutcome(run, reason, dependencies);
    throw error;
  } finally {
    if (!retainWorkspaceForRecovery && run.state !== "blocked" && run.state !== "failed" && run.state !== "cancelled") {
      try { await dependencies.git.remove(input.workspace); } catch { /* retained recovery reconciles stale worktrees */ }
    }
  }
}

function blockingFindingOutsidePacket(
  verdict: DurableArtifact<"ReviewVerdict">,
  packet: DurableArtifact<"BuildPacket">,
  checkpoint?: DurableArtifact<"RemediationBlocked">,
  includeEligibleFollowUps = false,
): string | undefined {
  const expected = [
    ...packet.payload.expectedPaths,
    ...(checkpoint?.payload.status === "ready-to-resume" ? checkpoint.payload.approvedPaths : []),
  ].map((path) => normalizeRepoPath(path));
  const violations = verdict.payload.findings
    .filter((finding) => finding.location
      && (finding.blocking || (includeEligibleFollowUps && finding.scopeDisposition === "follow_up")))
    .map((finding) => ({ finding, path: repositoryPathFromLocation(finding.location!) }))
    .filter(({ path }) => path !== undefined && !expected.some((allowed) => pathMatchesExpectation(path!, allowed)));
  if (!violations.length) return undefined;
  const details = violations.map(({ finding, path }) => `${finding.id} at ${path}`).join(", ");
  return `Blocking review finding requires changes outside the frozen Build Packet (${details}); refusing automatic scope expansion`;
}

function normalizeRepoPath(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, "");
}

function assertExactPacketClaims(expected: readonly string[], preflighted: readonly string[]): void {
  const canonical = (paths: readonly string[]): string[] => [...new Set(paths.map((path) => path.trim()).filter(Boolean))].sort();
  if (JSON.stringify(canonical(expected)) !== JSON.stringify(canonical(preflighted))) {
    throw new Error("Preflighted Build Packet claims do not match the retained packet; refusing to skip typed claim arbitration");
  }
}

function pathMatchesExpectation(path: string, expected: string): boolean {
  if (expected.endsWith("/**")) return path.startsWith(expected.slice(0, -3));
  return path === expected || path.startsWith(`${expected}/`);
}

export function shouldAppendFailureOutcome(existing: readonly DurableArtifact[], runId: string, reason: string): boolean {
  const latestFailure = existing
    .filter((artifact): artifact is DurableArtifact<"Outcome"> => artifact.runId === runId && artifact.kind === "Outcome" && artifact.payload.status === "failed")
    .at(-1);
  return latestFailure?.payload.reason !== reason;
}

/**
 * Durable verification evidence can outlive the OS/runtime that wrote it.
 * Treat Windows drive paths and their WSL `/mnt/<drive>/` spelling as the
 * same workspace identity while preserving exact comparison for ordinary
 * POSIX paths.
 */
export function workspacePathsEquivalent(left: string, right: string): boolean {
  return canonicalWorkspacePath(left) === canonicalWorkspacePath(right);
}

function canonicalWorkspacePath(path: string): string {
  const normalized = path.replaceAll("\\", "/").replace(/\/+/g, "/");
  const wslPath = normalized.match(/^\/mnt\/([a-zA-Z])\/(.*)$/);
  if (wslPath) return `${wslPath[1]!.toUpperCase()}:/${wslPath[2]!}`.toLowerCase();
  const windowsPath = normalized.match(/^([a-zA-Z]):\/(.*)$/);
  if (windowsPath) return `${windowsPath[1]!.toUpperCase()}:/${windowsPath[2]!}`.toLowerCase();
  return normalized;
}

function repairWorkspaceManagerFromGit(git: GitWorkspaceManager): PullRequestRepairWorkspaceManager | undefined {
  const candidate = git as GitWorkspaceManager & Partial<PullRequestRepairWorkspaceManager>;
  if (typeof candidate.createReview !== "function"
    || typeof candidate.publishPullRequestRepair !== "function"
    || typeof candidate.head !== "function") return undefined;
  return candidate as PullRequestRepairWorkspaceManager;
}

function assertLease(dependencies: Pick<WorkOnDependencies, "leaseGuard">): void {
  dependencies.leaseGuard?.assertValid();
}

async function assertFreshIssueOpen(host: ForgeHost, expectedRepo: string, expectedIssue: number): Promise<void> {
  if (!host.getIssue) return;
  const issue = await host.getIssue(expectedIssue, expectedRepo);
  if (issue.repo.toLowerCase() !== expectedRepo.toLowerCase() || issue.number !== expectedIssue) {
    throw new Error(`Issue admission identified ${issue.repo}#${issue.number}, expected ${expectedRepo}#${expectedIssue}`);
  }
  if (issue.state === "CLOSED") {
    throw new Error(`Issue #${expectedIssue} is already closed; refusing to start fresh work`);
  }
}

/**
 * Guard the actual mutation ports, not merely the phase entry points. A
 * heartbeat can discover continuity loss while an awaited helper is between
 * phase checks, so every dependent write gets a final controller-owned check.
 * Cleanup is intentionally not guarded: failed worktrees must remain
 * removable during recovery.
 */
function guardMutationBoundaries(dependencies: WorkOnDependencies): WorkOnDependencies {
  if (!dependencies.leaseGuard) return dependencies;
  const guarded = <T extends object>(target: T, methods: readonly string[]): T => {
    const mutationMethods = new Set(methods);
    return new Proxy(target, {
      get(value, property) {
        const member = Reflect.get(value, property, value);
        if (typeof member !== "function") return member;
        if (!mutationMethods.has(String(property))) return member.bind(value);
        return (...args: never[]) => {
          dependencies.leaseGuard!.assertValid();
          return member.apply(value, args);
        };
      },
    });
  };
  return {
    ...dependencies,
    artifacts: guarded(dependencies.artifacts, ["append"]),
    runs: guarded(dependencies.runs, ["create", "commit", "recordProgress"]),
    git: guarded(dependencies.git, ["create", "fastForwardToRemoteTarget", "syncToRemoteHead", "integrateRemoteBase", "prepareWorkspaceDependencies", "stageConflictResolutions", "commit", "push"]),
    host: guarded(dependencies.host, [
      "materializeBatchIssue", "publishIssueComment", "materializeRemediationChildren",
      "materializeDecomposition", "createPullRequest", "publishPullRequestComment",
      "materializeReviewFinding", "reconcileReviewFindings", "mergePullRequest", "closeIssue",
    ]),
    ...(dependencies.telemetry !== undefined
      ? { telemetry: guarded(dependencies.telemetry, ["recordTelemetry"]) }
      : {}),
  };
}

async function appendFailureOutcome(run: RunState, reason: string, dependencies: WorkOnDependencies): Promise<void> {
  const existing = await dependencies.artifacts.list(run.subject);
  if (!shouldAppendFailureOutcome(existing, run.runId, reason)) return;
  await dependencies.artifacts.append(createArtifact({
    kind: "Outcome",
    runId: run.runId,
    subject: run.subject,
    producer: { role: "controller", runtime: "forgedock" },
    payload: {
      status: "failed", reason,
      ...(run.targetBranch ? { targetBranch: run.targetBranch } : {}),
      ...(run.promotionTarget ? { promotionTarget: run.promotionTarget } : {}),
      ...(run.productionTarget ? { productionTarget: run.productionTarget } : {}),
      childIssues: [],
    },
  }, {
    id: deterministicOutcomeId(run.runId, run.subject, `failed:${reason}`),
  }));
}

async function blockForScopeViolation(
  run: RunState,
  pullRequest: PullRequestSnapshot,
  packet: DurableArtifact<"BuildPacket">,
  verdict: DurableArtifact<"ReviewVerdict">,
  scopeViolation: string,
  options: ScopeExpansionOptions,
  dependencies: WorkOnDependencies,
): Promise<RunState> {
  if (options.scopeExpansion === "recursive") {
    return blockForRecursiveRemediation(run, pullRequest, packet, verdict, dependencies, {
      ...(options.remediationDepth !== undefined ? { depth: options.remediationDepth } : {}),
      ...(options.maxRemediationDepth !== undefined ? { maxDepth: options.maxRemediationDepth } : {}),
      ...(options.maxRemediationChildren !== undefined ? { maxChildren: options.maxRemediationChildren } : {}),
      ...(options.approvedPaths !== undefined ? { approvedPaths: options.approvedPaths } : {}),
    });
  }
  return blockForReviewFindings(run, pullRequest, verdict, dependencies, scopeViolation);
}

async function blockForRecursiveRemediation(
  run: RunState,
  pullRequest: PullRequestSnapshot,
  packet: DurableArtifact<"BuildPacket">,
  verdict: DurableArtifact<"ReviewVerdict">,
  dependencies: WorkOnDependencies,
  limits: { depth?: number; maxDepth?: number; maxChildren?: number; approvedPaths?: readonly string[] },
): Promise<RunState> {
  const supervisor = new RemediationSupervisor({ host: dependencies.host, artifacts: dependencies.artifacts, runs: dependencies.runs }, {
    ...(limits.maxDepth !== undefined ? { maxDepth: limits.maxDepth } : {}),
    ...(limits.maxChildren !== undefined ? { maxChildren: limits.maxChildren } : {}),
  });
  const findings: RemediationFindingInput[] = verdict.payload.findings
    .filter((finding) => finding.location && (finding.blocking || finding.scopeDisposition === "follow_up"))
    .map((finding) => ({
    id: finding.id,
    severity: finding.severity,
    title: finding.title,
    evidence: finding.evidence,
    ...(finding.location ? { location: finding.location } : {}),
    remediation: finding.remediation,
    ...(finding.matchedAcceptanceCriteria?.[0] ? { acceptanceCriterion: finding.matchedAcceptanceCriteria[0] } : {}),
  }));
  const result = await supervisor.begin({
    parentRun: run,
    parentPullRequest: pullRequest,
    packetArtifact: packet,
    verdictArtifact: verdict,
    reason: "scope-violation",
    findings,
    ...(limits.depth !== undefined ? { remediationDepth: limits.depth } : {}),
    ...(limits.maxDepth !== undefined ? { maxRemediationDepth: limits.maxDepth } : {}),
    ...(limits.maxChildren !== undefined ? { maxRemediationChildren: limits.maxChildren } : {}),
    ...(limits.approvedPaths !== undefined ? { approvedPaths: limits.approvedPaths } : {}),
  });
  const reason = result.childIssues.length
    ? `Recursive remediation suspended with checkpoint ${result.checkpoint.payload.checkpointKey}; child issues: ${result.childIssues.map((issue) => `#${issue}`).join(", ")}`
    : `Recursive remediation could not dispatch actionable children; checkpoint ${result.checkpoint.payload.checkpointKey} is terminal`;
  return blockForBudget(run, dependencies, reason);
}

async function blockForReviewFindings(
  run: RunState,
  pullRequest: PullRequestSnapshot,
  verdict: DurableArtifact<"ReviewVerdict">,
  dependencies: WorkOnDependencies,
  reason: string,
): Promise<RunState> {
  await materializeReviewFindings({
    run,
    pullRequest,
    findings: verdict.payload.findings,
    fallbackReviewerRoles: verdict.payload.reviewerRoles,
  }, dependencies.host);
  return blockForBudget(run, dependencies, reason);
}

async function blockForBudget(run: RunState, dependencies: WorkOnDependencies, reason: string): Promise<RunState> {
  const outcome = createArtifact({
    kind: "Outcome", runId: run.runId, subject: run.subject,
    producer: { role: "controller", runtime: "forgedock" },
    payload: {
      status: "blocked", reason,
      ...(run.targetBranch ? { targetBranch: run.targetBranch } : {}),
      ...(run.promotionTarget ? { promotionTarget: run.promotionTarget } : {}),
      ...(run.productionTarget ? { productionTarget: run.productionTarget } : {}),
      childIssues: [],
    },
  }, {
    id: deterministicOutcomeId(run.runId, run.subject, `blocked:${reason}`),
  });
  await dependencies.artifacts.append(outcome);
  run = attachArtifact(run, "Outcome", outcome.id);
  const blocked = transition(run, "BLOCK", { reason });
  await dependencies.runs.commit(run.version, blocked.state, blocked.record);
  return blocked.state;
}
