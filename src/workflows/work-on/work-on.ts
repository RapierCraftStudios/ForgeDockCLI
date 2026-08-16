// SPDX-License-Identifier: AGPL-3.0-or-later

import { createArtifact, type DurableArtifact } from "../../core/artifacts/schema.js";
import type { ForgeHost, PullRequestSnapshot } from "../../core/ports/forge-host.js";
import type { GitWorkspace, GitWorkspaceManager } from "../../core/ports/git-workspace.js";
import type { ArtifactRepository, RunRepository } from "../../core/ports/repositories.js";
import type { LeaseGuard } from "../../core/ports/lease.js";
import type { CheckResult, VerificationCommand, VerificationRunner } from "../../core/ports/verification.js";
import type { TelemetryRepository } from "../../core/ports/telemetry.js";
import {
  isRepairableVerificationFailure,
  MAX_VERIFICATION_REPAIR_ATTEMPTS,
} from "../../core/state/admission.js";
import { attachArtifact, transition, type RunState } from "../../core/state/machine.js";
import type { AgentEventSink, AgentRuntime, ScopeHints } from "../../runtime/agent-runtime.js";
import { buildWorkItem, type BuilderSubmission } from "./build.js";
import { completeInvalidWorkItem, completeWorkItem } from "./complete.js";
import {
  deterministicOutcomeId,
  investigateWorkItem,
  resumeInvestigationWorkItem,
  WorkflowExecutionError,
} from "./investigate.js";
import { CONTROLLER_VERIFICATION_GATES, prepareBuildPacket } from "./prepare.js";
import { publishPullRequest } from "./publish.js";
import { publishRemediationRevision } from "./publish-revision.js";
import { remediateReview } from "./remediate.js";
import { verifyAndCommit, type VerificationResult } from "./verify.js";
import { materializeReviewFindings, reviewPullRequest } from "../review-pr/review.js";
import { RemediationSupervisor, verifyParentRevision } from "../orchestrate/remediation.js";
import { ClaimPromotionConflictError } from "../orchestrate/scheduler.js";
import type { RemediationFindingInput } from "../orchestrate/remediation.js";
import type { BatchMemberContract } from "../orchestrate/batching.js";
import { repositoryPathFromLocation } from "../review-pr/scope.js";
import { assertParentRemediationTarget, assertRunTargetsBranch, laneEvidence, runTargetForLane, type IssueLane, type ParentRemediationTarget } from "./lane.js";

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
  leaseGuard?: LeaseGuard;
  onAgentEvent?: AgentEventSink;
}

export interface WorkOnResult {
  run: RunState;
  outcome?: DurableArtifact<"Outcome">;
  pullRequest?: PullRequestSnapshot;
  awaitingHuman?: boolean;
}

interface ScopeExpansionOptions {
  scopeExpansion?: "scope-locked" | "recursive";
  parentRemediation?: ParentRemediationTarget;
  maxRemediationDepth?: number;
  maxRemediationChildren?: number;
  remediationDepth?: number;
  approvedPaths?: readonly string[];
}

export async function workOn(
  input: {
    intent: DurableArtifact<"Intent">;
    priorArtifacts?: readonly DurableArtifact[];
    repoPath: string;
    lane: IssueLane;
    scopeHints?: ScopeHints;
    verification: readonly Omit<VerificationCommand, "cwd">[];
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
    onClaimsPromoted?: (paths: readonly string[]) => void;
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
  let run: RunState | undefined;
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
    });
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
      }, dependencies);
    }
    if (run.state === "decomposed") return { run };

    const prepared = await prepareBuildPacket({
      run,
      intent: input.intent,
      investigation: investigated.investigation,
      ...(input.priorArtifacts !== undefined ? { priorArtifacts: input.priorArtifacts } : {}),
      cwd: workspace.path,
      ...(input.scopeHints !== undefined ? { scopeHints: input.scopeHints } : {}),
      ...runtimeOptions,
      ...planningOptions,
      verificationCatalog: {
        commands: input.verification.map(({ id, command, args }) => ({ id, command, args })),
        controllerGates: CONTROLLER_VERIFICATION_GATES,
      },
    }, agentDependencies);
    // prepareBuildPacket commits BUILD_PACKET_READY before returning. Adopt its
    // version before the synchronous scheduler callback can fail.
    run = prepared.run;
    claimPromotionPending = true;
    input.onClaimsPromoted?.(prepared.packet.payload.expectedPaths);
    claimPromotionPending = false;
    const continued = await continueBuildDelivery({
      run, intent: input.intent, investigation: investigated.investigation, packet: prepared.packet, workspace,
      ...(input.scopeHints !== undefined ? { scopeHints: input.scopeHints } : {}),
      baseBranch: deliveryBranch, verification: input.verification,
      ...(input.baselineChecks !== undefined ? { baselineChecks: input.baselineChecks } : {}),
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
    if (claimPromotionPending && error instanceof ClaimPromotionConflictError) {
      // The packet checkpoint is already durable and remains the recovery
      // authority. Preserve the original scheduler error for the CLI adapter.
      retainWorkspaceForRecovery = true;
      throw error;
    }
    if (error instanceof WorkflowExecutionError) run = error.run;
    const reason = error instanceof Error ? error.message : String(error);
    if (run && run.state !== "failed" && run.state !== "blocked" && run.state !== "invalid") {
      const failed = transition(run, "FAIL", { reason });
      await dependencies.runs.commit(run.version, failed.state, failed.record);
      run = failed.state;
    }
    if (run?.state === "failed") await appendFailureOutcome(run, reason, dependencies);
    throw error;
  } finally {
    const retainForRecovery = retainWorkspaceForRecovery
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
  onClaimsPromoted?: (paths: readonly string[]) => void;
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
  let investigation = input.investigation;
  const workspace = input.workspace;
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
      ...(input.scopeHints !== undefined ? { scopeHints: input.scopeHints } : {}),
      ...(input.provider !== undefined ? { provider: input.provider } : {}),
      ...(input.model !== undefined ? { model: input.model } : {}),
      ...(input.planningProvider !== undefined ? { planningProvider: input.planningProvider } : {}),
      ...(input.planningModel !== undefined ? { planningModel: input.planningModel } : {}),
      ...(input.planningThinking !== undefined ? { planningThinking: input.planningThinking } : {}),
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
      verificationCatalog: {
        commands: input.verification.map(({ id, command, args }) => ({ id, command, args })),
        controllerGates: CONTROLLER_VERIFICATION_GATES,
      },
    }, agentDependencies);
    // Adopt the committed packet checkpoint before entering the synchronous
    // scheduler promotion boundary.
    run = prepared.run;
    claimPromotionPending = true;
    input.onClaimsPromoted?.(prepared.packet.payload.expectedPaths);
    claimPromotionPending = false;
    const continued = await continueBuildDelivery({
      run,
      intent: input.intent,
      investigation,
      packet: prepared.packet,
      workspace,
      baseBranch: input.baseBranch,
      verification: input.verification,
      ...(input.scopeHints !== undefined ? { scopeHints: input.scopeHints } : {}),
      ...(input.baselineChecks !== undefined ? { baselineChecks: input.baselineChecks } : {}),
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
    if (claimPromotionPending && error instanceof ClaimPromotionConflictError) {
      // Keep the committed Build Packet checkpoint and retained workspace
      // resumable; the caller must receive this exact conflict instance.
      retainWorkspaceForRecovery = true;
      throw error;
    }
    if (error instanceof WorkflowExecutionError) run = error.run;
    const reason = error instanceof Error ? error.message : String(error);
    if (run.state !== "failed" && run.state !== "blocked" && run.state !== "invalid") {
      const failed = transition(run, "FAIL", { reason });
      await dependencies.runs.commit(run.version, failed.state, failed.record);
      run = failed.state;
    }
    if (run.state === "failed") await appendFailureOutcome(run, reason, dependencies);
    throw error;
  } finally {
    const retainForRecovery = retainWorkspaceForRecovery
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
): Promise<{ run: RunState; outcome: DurableArtifact<"Outcome"> }> {
  const failureEvidence = failure.payload.failureEvidence;
  if (!failureEvidence) throw new Error("Verification repair requires durable failure evidence");
  const outcome = createArtifact({
    kind: "Outcome",
    runId: run.runId,
    subject: run.subject,
    producer: { role: "controller", runtime: "forgedock" },
    payload: {
      status: "blocked",
      reason: `Verification repair attempt ${repairAttempt} dispatched: ${failure.payload.reason}`,
      ...(run.targetBranch ? { targetBranch: run.targetBranch } : {}),
      ...(run.promotionTarget ? { promotionTarget: run.promotionTarget } : {}),
      ...(run.productionTarget ? { productionTarget: run.productionTarget } : {}),
      childIssues: [],
      failureEvidence: { ...failureEvidence, repairAttempt },
    },
  }, {
    id: deterministicOutcomeId(
      run.runId,
      run.subject,
      `blocked:verification-repair:${repairAttempt}:supersedes:${failure.id}`,
    ),
  });
  await dependencies.artifacts.append(outcome);
  return { run: attachArtifact(run, "Outcome", outcome.id), outcome };
}

export async function resumeBuildWorkOn(
  input: {
    run: RunState;
    intent: DurableArtifact<"Intent">;
    investigation: DurableArtifact<"Investigation">;
    packet: DurableArtifact<"BuildPacket">;
    priorVerificationFailure?: DurableArtifact<"Outcome">;
    priorVerificationRepairAttempts?: number;
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
  if (input.run.state !== "building") throw new Error(`Build resume requires building state, found ${input.run.state}`);
  assertRunTargetsBranch(input.run, input.baseBranch);
  let run = input.run;
  try {
    let priorVerificationFailure = input.priorVerificationFailure;
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
    const result = await continueBuildDelivery({
      ...input,
      run,
      priorVerificationRepairAttempts: repairAttempts,
      ...(priorVerificationFailure ? { priorVerificationFailure } : {}),
    }, dependencies);
    run = result.run;
    return result;
  } catch (error) {
    if (error instanceof WorkflowExecutionError) run = error.run;
    const reason = error instanceof Error ? error.message : String(error);
    if (run.state !== "failed" && run.state !== "blocked") {
      const failed = transition(run, "FAIL", { reason });
      await dependencies.runs.commit(run.version, failed.state, failed.record);
      run = failed.state;
    }
    if (run.state === "failed") await appendFailureOutcome(run, reason, dependencies);
    throw error;
  } finally {
    const retainForRecovery = run.state === "blocked" || run.state === "failed" || run.state === "cancelled";
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
    repairContext?: readonly DurableArtifact[];
    priorVerificationRepairAttempts?: number;
    workspace: GitWorkspace;
    commands: readonly VerificationCommand[];
    baselineChecks?: readonly CheckResult[];
    subjectEvidence?: readonly string[];
    provider?: string;
    model?: string;
    signal?: AbortSignal;
  },
  dependencies: WorkOnDependencies,
): Promise<VerificationResult> {
  let run = input.run;
  let submission = input.submission;
  let repairAttempts = input.priorVerificationRepairAttempts ?? 0;
  const runtimeOptions = {
    ...(input.provider !== undefined ? { provider: input.provider } : {}),
    ...(input.model !== undefined ? { model: input.model } : {}),
    ...(input.signal !== undefined ? { signal: input.signal } : {}),
  };
  while (true) {
    const verified = await verifyAndCommit({
      run,
      packet: input.packet,
      submission,
      workspace: input.workspace,
      commands: input.commands,
      ...(input.baselineChecks !== undefined ? { baselineChecks: input.baselineChecks } : {}),
      ...(input.subjectEvidence !== undefined ? { subjectEvidence: input.subjectEvidence } : {}),
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
    }, {
      verifier: dependencies.verifier,
      git: dependencies.git,
      artifacts: dependencies.artifacts,
      runs: dependencies.runs,
    });
    run = verified.run;
    if (verified.buildResult || !isRepairableVerificationFailure(input.packet, verified.outcome)) return verified;

    if (repairAttempts >= MAX_VERIFICATION_REPAIR_ATTEMPTS) {
      const reason = `Verification repair budget exhausted after ${MAX_VERIFICATION_REPAIR_ATTEMPTS} repair attempt(s)`;
      const exhausted = transition(run, "VERIFICATION_REPAIR_EXHAUSTED", { reason });
      await dependencies.runs.commit(run.version, exhausted.state, exhausted.record);
      return { ...verified, run: exhausted.state };
    }

    const nextRepairAttempt = repairAttempts + 1;
    const checkpoint = await appendVerificationRepairCheckpoint(
      run,
      verified.outcome!,
      nextRepairAttempt,
      dependencies,
    );
    run = checkpoint.run;
    const repair = transition(run, "VERIFICATION_REPAIR_REQUESTED", {
      reason: `Repairing retained verification failure ${nextRepairAttempt} of ${MAX_VERIFICATION_REPAIR_ATTEMPTS}`,
    });
    await dependencies.runs.commit(run.version, repair.state, repair.record);
    run = repair.state;
    repairAttempts = nextRepairAttempt;
    const repaired = await buildWorkItem({
      run,
      intent: input.intent,
      investigation: input.investigation,
      packet: input.packet,
      priorVerificationFailure: checkpoint.outcome,
      ...(input.repairContext !== undefined ? { repairContext: input.repairContext } : {}),
      worktree: input.workspace.path,
      ...runtimeOptions,
    }, {
      runtime: dependencies.runtime,
      runs: dependencies.runs,
      ...(dependencies.onAgentEvent !== undefined ? { onAgentEvent: dependencies.onAgentEvent } : {}),
    });
    run = repaired.run;
    submission = repaired.submission;
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
  const built = await buildWorkItem({
    run, intent: input.intent, investigation: input.investigation, packet: input.packet,
    ...(input.scopeHints !== undefined ? { scopeHints: input.scopeHints } : {}),
    ...(input.priorVerificationFailure !== undefined ? { priorVerificationFailure: input.priorVerificationFailure } : {}),
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
    ...(input.repairContext !== undefined ? { repairContext: input.repairContext } : {}),
    priorVerificationRepairAttempts: input.priorVerificationRepairAttempts ?? 0,
    workspace: input.workspace,
    commands,
    ...(input.baselineChecks !== undefined ? { baselineChecks: input.baselineChecks } : {}),
    ...(input.subjectEvidence !== undefined ? { subjectEvidence: input.subjectEvidence } : {}),
    ...runtimeOptions,
  }, dependencies);
  run = initialVerification.run;
  if (!initialVerification.buildResult) return { run };
  let buildResult = initialVerification.buildResult;

  assertLease(dependencies);
  const published = await publishPullRequest({
    run, intent: input.intent, packet: input.packet, buildResult, workspace: input.workspace,
    ...(input.parentRemediation ? { parentRemediation: { parentBranch: input.parentRemediation.parentBranch, parentPullRequest: input.parentRemediation.parentPullRequest } } : {}),
  }, { git: dependencies.git, host: dependencies.host, runs: dependencies.runs });
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
    const revision = await publishRemediationRevision({ run, pullRequest, buildResult, workspace: input.workspace }, {
      git: dependencies.git, host: dependencies.host, runs: dependencies.runs,
    });
    run = revision.run;
    pullRequest = revision.pullRequest;
  }

  assertLease(dependencies);
  const completed = await completeWorkItem({
    run, pullRequest, verdict, autoMerge: input.autoMerge ?? false,
    ...(input.batchMembers?.length ? { childIssues: input.batchMembers } : {}),
    ...(input.batchMemberContracts !== undefined ? { memberContracts: input.batchMemberContracts } : {}),
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
  if (evidence.workspacePath !== input.workspace.path || evidence.branch !== input.workspace.branch) {
    throw new Error("Recovery workspace does not match the durable failure evidence");
  }
  let run = input.run;
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
  const commands = input.verification.map((command) => ({ ...command, cwd: input.workspace.path }));
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
    }, { git: dependencies.git, host: dependencies.host, runs: dependencies.runs });
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
        buildResult, verdict, reviewCycle: { current: cycle, total: (input.maxRemediationCycles ?? 2) + 1 }, worktree: input.workspace.path, ...runtimeOptions,
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
      const revision = await publishRemediationRevision({ run, pullRequest, buildResult, workspace: input.workspace }, {
        git: dependencies.git, host: dependencies.host, runs: dependencies.runs,
      });
      run = revision.run;
      pullRequest = revision.pullRequest;
    }
    const completed = await completeWorkItem({
      run, pullRequest, verdict, autoMerge: input.autoMerge ?? false,
      ...(input.batchMembers?.length ? { childIssues: input.batchMembers } : {}),
      ...(input.batchMemberContracts !== undefined ? { memberContracts: input.batchMemberContracts } : {}),
    }, dependencies);
    run = completed.run;
    return { run, pullRequest, awaitingHuman: completed.awaitingHuman };
  } catch (error) {
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
    const retainForRecovery = run.state === "blocked" || run.state === "failed" || run.state === "cancelled";
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
  const commands = input.verification.map((command) => ({ ...command, cwd: input.workspace.path }));
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
          ...(input.batchMembers?.length ? { childIssues: input.batchMembers } : {}),
          ...(input.batchMemberContracts !== undefined ? { memberContracts: input.batchMemberContracts } : {}),
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
      buildResult, verdict, reviewCycle: { current: cycle, total: remediationLimit + 1 }, worktree: input.workspace.path, ...runtimeOptions,
    }, {
      runtime: dependencies.runtime, runs: dependencies.runs,
      ...(dependencies.onAgentEvent !== undefined ? { onAgentEvent: dependencies.onAgentEvent } : {}),
    });
    run = firstRemediation.run;
    let verified = await verifyWithBuilderRepairs({
      run,
      intent: input.intent,
      investigation: input.investigation,
      packet: input.packet,
      submission: firstRemediation.submission,
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
    let revision = await publishRemediationRevision({ run, pullRequest, buildResult, workspace: input.workspace }, {
      git: dependencies.git, host: dependencies.host, runs: dependencies.runs,
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
      revision = await publishRemediationRevision({ run, pullRequest, buildResult, workspace: input.workspace }, {
        git: dependencies.git, host: dependencies.host, runs: dependencies.runs,
      });
      run = revision.run;
      pullRequest = revision.pullRequest;
    }

    const completed = await completeWorkItem({
      run, pullRequest, verdict, autoMerge: input.autoMerge ?? false,
      ...(input.batchMembers?.length ? { childIssues: input.batchMembers } : {}),
      ...(input.batchMemberContracts !== undefined ? { memberContracts: input.batchMemberContracts } : {}),
    }, dependencies);
    run = completed.run;
    return { run, pullRequest, awaitingHuman: completed.awaitingHuman };
  } catch (error) {
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
    const retainForRecovery = run.state === "blocked" || run.state === "failed" || run.state === "cancelled";
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
  const commands = input.verification.map((command) => ({ ...command, cwd: input.workspace.path }));
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
    ...(input.batchMembers?.length ? { childIssues: input.batchMembers } : {}),
    ...(input.batchMemberContracts !== undefined ? { memberContracts: input.batchMemberContracts } : {}),
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
    if (!input.priorVerdict
      || input.priorVerdict.payload.headSha === input.buildResult.payload.headSha
      || expectedHead?.toLowerCase() !== input.buildResult.payload.headSha.toLowerCase()) {
      throw new Error("Failed run does not carry proof of a newer verified remediation head after a stale PR projection");
    }
  }
  let run = input.run;
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
  const commands = input.verification.map((command) => ({ ...command, cwd: input.workspace.path }));
  let buildResult = input.buildResult;
  try {
    const published = await publishPullRequest({
      run, intent: input.intent, packet: input.packet, buildResult, workspace: input.workspace,
      ...(input.parentRemediation ? { parentRemediation: { parentBranch: input.parentRemediation.parentBranch, parentPullRequest: input.parentRemediation.parentPullRequest } } : {}),
    }, { git: dependencies.git, host: dependencies.host, runs: dependencies.runs });
    run = published.run;
    let pullRequest = published.pullRequest;
    let verdict: DurableArtifact<"ReviewVerdict">;
    let priorVerdict = input.priorVerdict;
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
        buildResult, verdict, reviewCycle: { current: cycle, total: (input.maxRemediationCycles ?? 2) + 1 }, worktree: input.workspace.path, ...runtimeOptions,
      }, {
        runtime: dependencies.runtime, runs: dependencies.runs,
        ...(dependencies.onAgentEvent !== undefined ? { onAgentEvent: dependencies.onAgentEvent } : {}),
      });
      run = remediated.run;
      const verified = await verifyWithBuilderRepairs({
        run,
        intent: input.intent,
        investigation: input.investigation,
        packet: input.packet,
        submission: remediated.submission,
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
      const revision = await publishRemediationRevision({ run, pullRequest, buildResult, workspace: input.workspace }, {
        git: dependencies.git, host: dependencies.host, runs: dependencies.runs,
      });
      run = revision.run;
      pullRequest = revision.pullRequest;
    }
    const completed = await completeWorkItem({
      run, pullRequest, verdict, autoMerge: input.autoMerge ?? false,
      ...(input.batchMembers?.length ? { childIssues: input.batchMembers } : {}),
      ...(input.batchMemberContracts !== undefined ? { memberContracts: input.batchMemberContracts } : {}),
    }, dependencies);
    run = completed.run;
    return { run, pullRequest, awaitingHuman: completed.awaitingHuman };
  } catch (error) {
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
    const retainForRecovery = run.state === "blocked" || run.state === "failed" || run.state === "cancelled";
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
  },
  dependencies: WorkOnDependencies,
): Promise<WorkOnResult> {
  dependencies = guardMutationBoundaries(dependencies);
  if (input.run.state !== "merging") throw new Error(`Completion resume requires merging state, found ${input.run.state}`);
  if (input.verdict.payload.disposition !== "approve"
    || input.verdict.payload.headSha !== input.pullRequest.headSha) {
    throw new Error("Completion resume requires an approving verdict for the current pull request head");
  }
  let run = input.run;
  try {
    const resumed = transition(run, "RESUME_COMPLETION", {
      reason: `Resuming idempotent merge and issue closure at approved head ${input.verdict.payload.headSha}`,
      headSha: input.verdict.payload.headSha,
    });
    await dependencies.runs.commit(run.version, resumed.state, resumed.record);
    run = resumed.state;
    const completed = await completeWorkItem({
      run,
      pullRequest: input.pullRequest,
      verdict: input.verdict,
      autoMerge: input.autoMerge ?? false,
      ...(input.batchMembers?.length ? { childIssues: input.batchMembers } : {}),
      ...(input.batchMemberContracts !== undefined ? { memberContracts: input.batchMemberContracts } : {}),
    }, dependencies);
    run = completed.run;
    return { run, pullRequest: input.pullRequest, awaitingHuman: completed.awaitingHuman };
  } catch (error) {
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
    if (input.workspace && run.state !== "failed" && run.state !== "blocked" && run.state !== "cancelled") {
      try { await dependencies.git.remove(input.workspace); } catch { /* stale worktree reconciliation is operational */ }
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
    git: guarded(dependencies.git, ["create", "syncToRemoteHead", "prepareWorkspaceDependencies", "commit", "push"]),
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
