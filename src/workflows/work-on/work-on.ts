// SPDX-License-Identifier: AGPL-3.0-or-later

import { createArtifact, type DurableArtifact } from "../../core/artifacts/schema.js";
import type { ForgeHost, PullRequestSnapshot } from "../../core/ports/forge-host.js";
import type { GitWorkspace, GitWorkspaceManager } from "../../core/ports/git-workspace.js";
import type { ArtifactRepository, RunRepository } from "../../core/ports/repositories.js";
import type { CheckResult, VerificationCommand, VerificationRunner } from "../../core/ports/verification.js";
import type { TelemetryRepository } from "../../core/ports/telemetry.js";
import { attachArtifact, transition, type RunState } from "../../core/state/machine.js";
import type { AgentEventSink, AgentRuntime, ScopeHints } from "../../runtime/agent-runtime.js";
import { buildWorkItem } from "./build.js";
import { completeWorkItem } from "./complete.js";
import { investigateWorkItem, WorkflowExecutionError } from "./investigate.js";
import { prepareBuildPacket } from "./prepare.js";
import { publishPullRequest } from "./publish.js";
import { publishRemediationRevision } from "./publish-revision.js";
import { remediateReview } from "./remediate.js";
import { verifyAndCommit } from "./verify.js";
import { materializeReviewFindings, reviewPullRequest } from "../review-pr/review.js";
import { RemediationSupervisor, verifyParentRevision } from "../orchestrate/remediation.js";
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
  onAgentEvent?: AgentEventSink;
}

export interface WorkOnResult {
  run: RunState;
  pullRequest?: PullRequestSnapshot;
  awaitingHuman?: boolean;
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
    autoMerge?: boolean;
    maxRemediationCycles?: number;
    maxRemediationDepth?: number;
    maxRemediationChildren?: number;
    scopeExpansion?: "scope-locked" | "recursive";
    parentRemediation?: ParentRemediationTarget;
    maxReviewSpecialists?: number;
    subjectEvidence?: readonly string[];
    batchMembers?: readonly number[];
    batchMemberContracts?: readonly BatchMemberContract[];
    signal?: AbortSignal;
  },
  dependencies: WorkOnDependencies,
): Promise<WorkOnResult> {
  const runtimeOptions = {
    ...(input.provider !== undefined ? { provider: input.provider } : {}),
    ...(input.model !== undefined ? { model: input.model } : {}),
    ...(input.signal !== undefined ? { signal: input.signal } : {}),
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
  try {
    const issue = input.intent.subject.issue;
    if (!issue) throw new Error("work-on requires an issue subject");
    if (input.parentRemediation) {
      assertParentRemediationTarget(input.parentRemediation);
      if (dependencies.host.getBranchHead) {
        const currentParentHead = await dependencies.host.getBranchHead(input.intent.subject.repo, input.parentRemediation.parentBranch);
        if (currentParentHead !== input.parentRemediation.parentHeadSha) {
          throw new Error(`Parent remediation branch ${input.parentRemediation.parentBranch} moved from ${input.parentRemediation.parentHeadSha} to ${currentParentHead}`);
        }
      }
    }
    const deliveryBranch = input.parentRemediation?.parentBranch ?? input.lane.targetBranch;
    workspace = await dependencies.git.create({
      runId: input.intent.runId,
      issue,
      baseRef: `origin/${deliveryBranch}`,
    });
    const laneTarget = input.parentRemediation
      ? { ...runTargetForLane(input.lane), targetBranch: input.parentRemediation.parentBranch }
      : runTargetForLane(input.lane);
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
    }, agentDependencies);
    run = investigated.run;
    if (run.state === "invalid" || run.state === "decomposed") return { run };

    const prepared = await prepareBuildPacket({
      run,
      intent: input.intent,
      investigation: investigated.investigation,
      cwd: workspace.path,
      ...runtimeOptions,
    }, agentDependencies);
    run = prepared.run;
    const continued = await continueBuildDelivery({
      run, intent: input.intent, investigation: investigated.investigation, packet: prepared.packet, workspace,
      baseBranch: deliveryBranch, verification: input.verification,
      ...(input.baselineChecks !== undefined ? { baselineChecks: input.baselineChecks } : {}),
      ...(input.provider !== undefined ? { provider: input.provider } : {}),
      ...(input.model !== undefined ? { model: input.model } : {}),
      ...(input.autoMerge !== undefined ? { autoMerge: input.autoMerge } : {}),
      ...(input.maxRemediationCycles !== undefined ? { maxRemediationCycles: input.maxRemediationCycles } : {}),
      ...(input.maxRemediationDepth !== undefined ? { maxRemediationDepth: input.maxRemediationDepth } : {}),
      ...(input.maxRemediationChildren !== undefined ? { maxRemediationChildren: input.maxRemediationChildren } : {}),
      ...(input.scopeExpansion !== undefined ? { scopeExpansion: input.scopeExpansion } : {}),
      ...(input.parentRemediation !== undefined ? { parentRemediation: input.parentRemediation } : {}),
      ...(input.maxReviewSpecialists !== undefined ? { maxReviewSpecialists: input.maxReviewSpecialists } : {}),
      subjectEvidence: [...(input.subjectEvidence ?? []), laneEvidence(input.lane)],
      ...(input.batchMembers !== undefined ? { batchMembers: input.batchMembers } : {}),
      ...(input.batchMemberContracts !== undefined ? { batchMemberContracts: input.batchMemberContracts } : {}),
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
    }, dependencies);
    run = continued.run;
    return continued;
  } catch (error) {
    if (error instanceof WorkflowExecutionError) run = error.run;
    const reason = error instanceof Error ? error.message : String(error);
    if (run && run.state !== "failed" && run.state !== "blocked") {
      const failed = transition(run, "FAIL", { reason });
      await dependencies.runs.commit(run.version, failed.state, failed.record);
      run = failed.state;
    }
    if (run?.state === "failed") await appendFailureOutcome(run, reason, dependencies);
    throw error;
  } finally {
    const retainForRecovery = run?.state === "blocked" || run?.state === "failed" || run?.state === "cancelled";
    if (workspace && !retainForRecovery) {
      try { await dependencies.git.remove(workspace); } catch { /* recovery reconciles stale worktrees */ }
    }
  }
}

export async function resumeBuildWorkOn(
  input: {
    run: RunState;
    intent: DurableArtifact<"Intent">;
    investigation: DurableArtifact<"Investigation">;
    packet: DurableArtifact<"BuildPacket">;
    workspace: GitWorkspace;
    baseBranch: string;
    verification: readonly Omit<VerificationCommand, "cwd">[];
    baselineChecks?: readonly CheckResult[];
    provider?: string;
    model?: string;
    autoMerge?: boolean;
    maxRemediationCycles?: number;
    maxReviewSpecialists?: number;
    subjectEvidence?: readonly string[];
    batchMembers?: readonly number[];
    signal?: AbortSignal;
  },
  dependencies: WorkOnDependencies,
): Promise<WorkOnResult> {
  if (input.run.state !== "building") throw new Error(`Build resume requires building state, found ${input.run.state}`);
  assertRunTargetsBranch(input.run, input.baseBranch);
  let run = input.run;
  try {
    const resumed = transition(run, "RESUME_BUILD", { reason: `Resuming frozen Build Packet in retained workspace ${input.workspace.path}` });
    await dependencies.runs.commit(run.version, resumed.state, resumed.record);
    run = resumed.state;
    const result = await continueBuildDelivery({ ...input, run }, dependencies);
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

async function continueBuildDelivery(
  input: {
    run: RunState;
    intent: DurableArtifact<"Intent">;
    investigation: DurableArtifact<"Investigation">;
    packet: DurableArtifact<"BuildPacket">;
    workspace: GitWorkspace;
    baseBranch: string;
    verification: readonly Omit<VerificationCommand, "cwd">[];
    baselineChecks?: readonly CheckResult[];
    provider?: string;
    model?: string;
    autoMerge?: boolean;
    maxRemediationCycles?: number;
    maxRemediationDepth?: number;
    maxRemediationChildren?: number;
    scopeExpansion?: "scope-locked" | "recursive";
    parentRemediation?: ParentRemediationTarget;
    maxReviewSpecialists?: number;
    subjectEvidence?: readonly string[];
    batchMembers?: readonly number[];
    batchMemberContracts?: readonly BatchMemberContract[];
    signal?: AbortSignal;
  },
  dependencies: WorkOnDependencies,
): Promise<WorkOnResult> {
  assertRunTargetsBranch(input.run, input.baseBranch);
  const runtimeOptions = {
    ...(input.provider !== undefined ? { provider: input.provider } : {}),
    ...(input.model !== undefined ? { model: input.model } : {}),
    ...(input.signal !== undefined ? { signal: input.signal } : {}),
  };
  let run = input.run;
  const built = await buildWorkItem({
    run, intent: input.intent, investigation: input.investigation, packet: input.packet,
    worktree: input.workspace.path, ...runtimeOptions,
  }, {
    runtime: dependencies.runtime,
    runs: dependencies.runs,
    ...(dependencies.onAgentEvent !== undefined ? { onAgentEvent: dependencies.onAgentEvent } : {}),
  });
  run = built.run;
  const commands = input.verification.map((command) => ({ ...command, cwd: input.workspace.path }));
  let verified = await verifyAndCommit({
    run, packet: input.packet, submission: built.submission, workspace: input.workspace, commands,
    ...(input.baselineChecks !== undefined ? { baselineChecks: input.baselineChecks } : {}),
    ...(input.subjectEvidence !== undefined ? { subjectEvidence: input.subjectEvidence } : {}),
    ...(input.signal !== undefined ? { signal: input.signal } : {}),
  }, { verifier: dependencies.verifier, git: dependencies.git, artifacts: dependencies.artifacts, runs: dependencies.runs });
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
  let cycle = 0;

  while (true) {
    const reviewed = await reviewPullRequest({
      run, pullRequest, intent: input.intent, investigation: input.investigation,
      packet: input.packet, buildResult, workspace: input.workspace.path,
      findingIssuePolicy: "approved-only",
      ...(input.maxReviewSpecialists !== undefined ? { maxReviewSpecialists: input.maxReviewSpecialists } : {}),
      ...(priorVerdict !== undefined ? { priorVerdict } : {}),
      ...runtimeOptions,
    }, {
      runtime: dependencies.runtime, host: dependencies.host, artifacts: dependencies.artifacts, runs: dependencies.runs,
      ...(dependencies.onAgentEvent !== undefined ? { onAgentEvent: dependencies.onAgentEvent } : {}),
    });
    run = reviewed.run;
    verdict = reviewed.verdict;
    priorVerdict = verdict;
    if (run.state === "merging") break;
    const scopeViolation = blockingFindingOutsidePacket(verdict, input.packet);
    if (scopeViolation) {
      if (input.scopeExpansion === "recursive" && input.parentRemediation === undefined) {
        run = await blockForRecursiveRemediation(run, pullRequest, input.packet, verdict, dependencies, {
          ...(input.maxRemediationDepth !== undefined ? { maxDepth: input.maxRemediationDepth } : {}),
          ...(input.maxRemediationChildren !== undefined ? { maxChildren: input.maxRemediationChildren } : {}),
        });
      } else {
        run = await blockForReviewFindings(run, pullRequest, verdict, dependencies, scopeViolation);
      }
      return { run, pullRequest };
    }

    cycle++;
    if (cycle > (input.maxRemediationCycles ?? 2)) {
      run = await blockForReviewFindings(run, pullRequest, verdict, dependencies, `Remediation budget exhausted after ${cycle - 1} cycle(s)`);
      return { run, pullRequest };
    }
    const remediated = await remediateReview({
      run, intent: input.intent, investigation: input.investigation, packet: input.packet,
      buildResult, verdict, worktree: input.workspace.path, ...runtimeOptions,
    }, {
      runtime: dependencies.runtime, runs: dependencies.runs,
      ...(dependencies.onAgentEvent !== undefined ? { onAgentEvent: dependencies.onAgentEvent } : {}),
    });
    run = remediated.run;
    verified = await verifyAndCommit({
      run, packet: input.packet, submission: remediated.submission, workspace: input.workspace, commands,
      ...(input.baselineChecks !== undefined ? { baselineChecks: input.baselineChecks } : {}),
      ...(input.subjectEvidence !== undefined ? { subjectEvidence: input.subjectEvidence } : {}),
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
    }, { verifier: dependencies.verifier, git: dependencies.git, artifacts: dependencies.artifacts, runs: dependencies.runs });
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
    maxReviewSpecialists?: number;
    subjectEvidence?: readonly string[];
    batchMembers?: readonly number[];
    parentRemediation?: ParentRemediationTarget;
    signal?: AbortSignal;
  },
  dependencies: WorkOnDependencies,
): Promise<WorkOnResult> {
  const evidence = input.outcome.payload.failureEvidence;
  if (input.run.state !== "blocked" || !evidence) throw new Error("Only a blocked verification run with retained evidence can resume");
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
    criterionCoverage: input.packet.payload.acceptanceCriteria.map((criterion) => ({
      criterion,
      implementation: `Retained implementation resumed from ${input.workspace.branch}; executable verification is re-run before publication.`,
    })),
    decisions: [],
    residualRisks: [],
  };
  const commands = input.verification.map((command) => ({ ...command, cwd: input.workspace.path }));
  try {
    let verified = await verifyAndCommit({
      run, packet: input.packet, submission, workspace: input.workspace, commands,
      ...(input.baselineChecks !== undefined ? { baselineChecks: input.baselineChecks } : {}),
      ...(input.subjectEvidence !== undefined ? { subjectEvidence: input.subjectEvidence } : {}),
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
    }, { verifier: dependencies.verifier, git: dependencies.git, artifacts: dependencies.artifacts, runs: dependencies.runs });
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
        findingIssuePolicy: "approved-only",
        ...(input.maxReviewSpecialists !== undefined ? { maxReviewSpecialists: input.maxReviewSpecialists } : {}),
        ...(priorVerdict !== undefined ? { priorVerdict } : {}),
        ...runtimeOptions,
      }, {
        runtime: dependencies.runtime, host: dependencies.host, artifacts: dependencies.artifacts, runs: dependencies.runs,
        ...(dependencies.onAgentEvent !== undefined ? { onAgentEvent: dependencies.onAgentEvent } : {}),
      });
      run = reviewed.run;
      verdict = reviewed.verdict;
      priorVerdict = verdict;
      if (run.state === "merging") break;
      const scopeViolation = blockingFindingOutsidePacket(verdict, input.packet);
      if (scopeViolation) {
        run = await blockForReviewFindings(run, pullRequest, verdict, dependencies, scopeViolation);
        return { run, pullRequest };
      }
      cycle++;
      if (cycle > (input.maxRemediationCycles ?? 2)) {
        run = await blockForReviewFindings(run, pullRequest, verdict, dependencies, `Remediation budget exhausted after ${cycle - 1} cycle(s)`);
        return { run, pullRequest };
      }
      const remediated = await remediateReview({
        run, intent: input.intent, investigation: input.investigation, packet: input.packet,
        buildResult, verdict, worktree: input.workspace.path, ...runtimeOptions,
      }, {
        runtime: dependencies.runtime, runs: dependencies.runs,
        ...(dependencies.onAgentEvent !== undefined ? { onAgentEvent: dependencies.onAgentEvent } : {}),
      });
      run = remediated.run;
      verified = await verifyAndCommit({
        run, packet: input.packet, submission: remediated.submission, workspace: input.workspace, commands,
        ...(input.baselineChecks !== undefined ? { baselineChecks: input.baselineChecks } : {}),
        ...(input.subjectEvidence !== undefined ? { subjectEvidence: input.subjectEvidence } : {}),
        ...(input.signal !== undefined ? { signal: input.signal } : {}),
      }, { verifier: dependencies.verifier, git: dependencies.git, artifacts: dependencies.artifacts, runs: dependencies.runs });
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
    maxReviewSpecialists?: number;
    subjectEvidence?: readonly string[];
    batchMembers?: readonly number[];
    parentRemediation?: ParentRemediationTarget;
    signal?: AbortSignal;
  },
  dependencies: WorkOnDependencies,
): Promise<WorkOnResult> {
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
  let cycle = 1;
  const remediationLimit = budgetBlocked ? 1 : (input.maxRemediationCycles ?? 2);
  try {
    if (budgetBlocked) {
      const reassessed = await reviewPullRequest({
        run, pullRequest, intent: input.intent, investigation: input.investigation,
        packet: input.packet, buildResult, workspace: input.workspace.path,
        findingIssuePolicy: "approved-only",
        ...(input.maxReviewSpecialists !== undefined ? { maxReviewSpecialists: input.maxReviewSpecialists } : {}),
        priorVerdict: verdict,
        ...runtimeOptions,
      }, {
        runtime: dependencies.runtime, host: dependencies.host, artifacts: dependencies.artifacts, runs: dependencies.runs,
        ...(dependencies.onAgentEvent !== undefined ? { onAgentEvent: dependencies.onAgentEvent } : {}),
      });
      run = reassessed.run;
      verdict = reassessed.verdict;
      if (run.state === "merging") {
        const completed = await completeWorkItem({
          run, pullRequest, verdict, autoMerge: input.autoMerge ?? false,
          ...(input.batchMembers?.length ? { childIssues: input.batchMembers } : {}),
        }, dependencies);
        run = completed.run;
        return { run, pullRequest, awaitingHuman: completed.awaitingHuman };
      }
      const scopeViolation = blockingFindingOutsidePacket(verdict, input.packet);
      if (scopeViolation) {
        run = await blockForReviewFindings(run, pullRequest, verdict, dependencies, scopeViolation);
        return { run, pullRequest };
      }
    }

    const firstRemediation = await remediateReview({
      run, intent: input.intent, investigation: input.investigation, packet: input.packet,
      buildResult, verdict, worktree: input.workspace.path, ...runtimeOptions,
    }, {
      runtime: dependencies.runtime, runs: dependencies.runs,
      ...(dependencies.onAgentEvent !== undefined ? { onAgentEvent: dependencies.onAgentEvent } : {}),
    });
    run = firstRemediation.run;
    let verified = await verifyAndCommit({
      run, packet: input.packet, submission: firstRemediation.submission, workspace: input.workspace, commands,
      ...(input.baselineChecks !== undefined ? { baselineChecks: input.baselineChecks } : {}),
      ...(input.subjectEvidence !== undefined ? { subjectEvidence: input.subjectEvidence } : {}),
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
    }, { verifier: dependencies.verifier, git: dependencies.git, artifacts: dependencies.artifacts, runs: dependencies.runs });
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
        findingIssuePolicy: "approved-only",
        ...(input.maxReviewSpecialists !== undefined ? { maxReviewSpecialists: input.maxReviewSpecialists } : {}),
        priorVerdict: verdict,
        ...runtimeOptions,
      }, {
        runtime: dependencies.runtime, host: dependencies.host, artifacts: dependencies.artifacts, runs: dependencies.runs,
        ...(dependencies.onAgentEvent !== undefined ? { onAgentEvent: dependencies.onAgentEvent } : {}),
      });
      run = reviewed.run;
      verdict = reviewed.verdict;
      if (run.state === "merging") break;
      const scopeViolation = blockingFindingOutsidePacket(verdict, input.packet);
      if (scopeViolation) {
        run = await blockForReviewFindings(run, pullRequest, verdict, dependencies, scopeViolation);
        return { run, pullRequest };
      }
      cycle++;
      if (cycle > remediationLimit) {
        run = await blockForReviewFindings(run, pullRequest, verdict, dependencies, `Remediation budget exhausted after ${cycle - 1} cycle(s)`);
        return { run, pullRequest };
      }
      const remediated = await remediateReview({
        run, intent: input.intent, investigation: input.investigation, packet: input.packet,
        buildResult, verdict, worktree: input.workspace.path, ...runtimeOptions,
      }, {
        runtime: dependencies.runtime, runs: dependencies.runs,
        ...(dependencies.onAgentEvent !== undefined ? { onAgentEvent: dependencies.onAgentEvent } : {}),
      });
      run = remediated.run;
      verified = await verifyAndCommit({
        run, packet: input.packet, submission: remediated.submission, workspace: input.workspace, commands,
        ...(input.baselineChecks !== undefined ? { baselineChecks: input.baselineChecks } : {}),
        ...(input.subjectEvidence !== undefined ? { subjectEvidence: input.subjectEvidence } : {}),
        ...(input.signal !== undefined ? { signal: input.signal } : {}),
      }, { verifier: dependencies.verifier, git: dependencies.git, artifacts: dependencies.artifacts, runs: dependencies.runs });
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
    signal?: AbortSignal;
  },
  dependencies: WorkOnDependencies,
): Promise<WorkOnResult> {
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
    workspacePath: input.workspace.path,
    verifier: dependencies.verifier,
  }, { host: dependencies.host, artifacts: dependencies.artifacts, runs: dependencies.runs });
  if (!proof.buildResult || proof.run.state !== "reviewing") return { run: proof.run, pullRequest: input.pullRequest };

  const reviewed = await reviewPullRequest({
    run: proof.run,
    pullRequest: { ...input.pullRequest, headSha: proof.buildResult.payload.headSha },
    intent: input.intent,
    investigation: input.investigation,
    packet: input.packet,
    buildResult: proof.buildResult,
    workspace: input.workspace.path,
    findingIssuePolicy: "approved-only",
    priorVerdict: input.priorVerdict,
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
  if (reviewed.run.state !== "merging") {
    const violation = blockingFindingOutsidePacket(reviewed.verdict, input.packet, input.checkpoint);
    const reason = violation ?? "Fresh expanded-scope review requested additional changes";
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
    maxReviewSpecialists?: number;
    subjectEvidence?: readonly string[];
    batchMembers?: readonly number[];
    parentRemediation?: ParentRemediationTarget;
    signal?: AbortSignal;
  },
  dependencies: WorkOnDependencies,
): Promise<WorkOnResult> {
  if (input.run.state !== "publishing" && input.run.state !== "failed") {
    throw new Error(`Publication resume requires publishing or recoverable failed state, found ${input.run.state}`);
  }
  assertRunTargetsBranch(input.run, input.baseBranch);
  const recoveringRevision = input.run.state === "failed";
  if (recoveringRevision) {
    const expectedHead = /^Published remediation head [0-9a-f]{7,64} does not match verified build ([0-9a-f]{7,64})$/i
      .exec(input.run.failure ?? "")?.[1];
    if (!input.priorVerdict
      || Date.parse(input.buildResult.createdAt) <= Date.parse(input.priorVerdict.createdAt)
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
        findingIssuePolicy: "approved-only",
        ...(input.maxReviewSpecialists !== undefined ? { maxReviewSpecialists: input.maxReviewSpecialists } : {}),
        ...(priorVerdict !== undefined ? { priorVerdict } : {}),
        ...runtimeOptions,
      }, {
        runtime: dependencies.runtime, host: dependencies.host, artifacts: dependencies.artifacts, runs: dependencies.runs,
        ...(dependencies.onAgentEvent !== undefined ? { onAgentEvent: dependencies.onAgentEvent } : {}),
      });
      run = reviewed.run;
      verdict = reviewed.verdict;
      priorVerdict = verdict;
      if (run.state === "merging") break;
      const scopeViolation = blockingFindingOutsidePacket(verdict, input.packet);
      if (scopeViolation) {
        run = await blockForReviewFindings(run, pullRequest, verdict, dependencies, scopeViolation);
        return { run, pullRequest };
      }
      cycle++;
      if (cycle > (input.maxRemediationCycles ?? 2)) {
        run = await blockForReviewFindings(run, pullRequest, verdict, dependencies, `Remediation budget exhausted after ${cycle - 1} cycle(s)`);
        return { run, pullRequest };
      }
      const remediated = await remediateReview({
        run, intent: input.intent, investigation: input.investigation, packet: input.packet,
        buildResult, verdict, worktree: input.workspace.path, ...runtimeOptions,
      }, {
        runtime: dependencies.runtime, runs: dependencies.runs,
        ...(dependencies.onAgentEvent !== undefined ? { onAgentEvent: dependencies.onAgentEvent } : {}),
      });
      run = remediated.run;
      const verified = await verifyAndCommit({
        run, packet: input.packet, submission: remediated.submission, workspace: input.workspace, commands,
        ...(input.baselineChecks !== undefined ? { baselineChecks: input.baselineChecks } : {}),
        ...(input.subjectEvidence !== undefined ? { subjectEvidence: input.subjectEvidence } : {}),
        ...(input.signal !== undefined ? { signal: input.signal } : {}),
      }, { verifier: dependencies.verifier, git: dependencies.git, artifacts: dependencies.artifacts, runs: dependencies.runs });
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
    workspace?: GitWorkspace;
  },
  dependencies: WorkOnDependencies,
): Promise<WorkOnResult> {
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
): string | undefined {
  const expected = [
    ...packet.payload.expectedPaths,
    ...(checkpoint?.payload.status === "ready-to-resume" ? checkpoint.payload.approvedPaths : []),
  ].map((path) => normalizeRepoPath(path));
  const violations = verdict.payload.findings
    .filter((finding) => finding.blocking && finding.location)
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
    .sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt))
    .at(-1);
  return latestFailure?.payload.reason !== reason;
}

async function appendFailureOutcome(run: RunState, reason: string, dependencies: WorkOnDependencies): Promise<void> {
  const existing = await dependencies.artifacts.list(run.subject);
  if (!shouldAppendFailureOutcome(existing, run.runId, reason)) return;
  await dependencies.artifacts.append(createArtifact({
    kind: "Outcome",
    runId: run.runId,
    subject: run.subject,
    producer: { role: "controller", runtime: "forgedock" },
    payload: { status: "failed", reason, childIssues: [] },
  }));
}

async function blockForRecursiveRemediation(
  run: RunState,
  pullRequest: PullRequestSnapshot,
  packet: DurableArtifact<"BuildPacket">,
  verdict: DurableArtifact<"ReviewVerdict">,
  dependencies: WorkOnDependencies,
  limits: { maxDepth?: number; maxChildren?: number },
): Promise<RunState> {
  const supervisor = new RemediationSupervisor({ host: dependencies.host, artifacts: dependencies.artifacts, runs: dependencies.runs }, {
    ...(limits.maxDepth !== undefined ? { maxDepth: limits.maxDepth } : {}),
    ...(limits.maxChildren !== undefined ? { maxChildren: limits.maxChildren } : {}),
  });
  const findings: RemediationFindingInput[] = verdict.payload.findings.filter((finding) => finding.blocking && finding.location).map((finding) => ({
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
    ...(limits.maxDepth !== undefined ? { maxRemediationDepth: limits.maxDepth } : {}),
    ...(limits.maxChildren !== undefined ? { maxRemediationChildren: limits.maxChildren } : {}),
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
    payload: { status: "blocked", reason, childIssues: [] },
  });
  await dependencies.artifacts.append(outcome);
  run = attachArtifact(run, "Outcome", outcome.id);
  const blocked = transition(run, "BLOCK", { reason });
  await dependencies.runs.commit(run.version, blocked.state, blocked.record);
  return blocked.state;
}
