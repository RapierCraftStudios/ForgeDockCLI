// SPDX-License-Identifier: AGPL-3.0-or-later

import { createArtifact, type DurableArtifact } from "../../core/artifacts/schema.js";
import type { ForgeHost, PullRequestSnapshot } from "../../core/ports/forge-host.js";
import type { GitWorkspace, GitWorkspaceManager } from "../../core/ports/git-workspace.js";
import type { ArtifactRepository, RunRepository } from "../../core/ports/repositories.js";
import type { CheckResult, VerificationCommand, VerificationRunner } from "../../core/ports/verification.js";
import { attachArtifact, transition, type RunState } from "../../core/state/machine.js";
import type { AgentEventSink, AgentRuntime } from "../../runtime/agent-runtime.js";
import { buildWorkItem } from "./build.js";
import { completeWorkItem } from "./complete.js";
import { investigateWorkItem, WorkflowExecutionError } from "./investigate.js";
import { prepareBuildPacket } from "./prepare.js";
import { publishPullRequest } from "./publish.js";
import { publishRemediationRevision } from "./publish-revision.js";
import { remediateReview } from "./remediate.js";
import { verifyAndCommit } from "./verify.js";
import { materializeReviewFindings, reviewPullRequest } from "../review-pr/review.js";
import { repositoryPathFromLocation } from "../review-pr/scope.js";
import { assertRunTargetsBranch, laneEvidence, runTargetForLane, type IssueLane } from "./lane.js";

export { repositoryPathFromLocation } from "../review-pr/scope.js";

export interface WorkOnDependencies {
  runtime: AgentRuntime;
  artifacts: ArtifactRepository;
  runs: RunRepository;
  git: GitWorkspaceManager;
  verifier: VerificationRunner;
  host: ForgeHost;
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
    workspace = await dependencies.git.create({
      runId: input.intent.runId,
      issue,
      baseRef: `origin/${input.lane.targetBranch}`,
    });
    const investigated = await investigateWorkItem({
      intent: input.intent,
      ...(input.priorArtifacts !== undefined ? { priorArtifacts: input.priorArtifacts } : {}),
      cwd: workspace.path,
      target: runTargetForLane(input.lane),
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
      baseBranch: input.lane.targetBranch, verification: input.verification,
      ...(input.baselineChecks !== undefined ? { baselineChecks: input.baselineChecks } : {}),
      ...(input.provider !== undefined ? { provider: input.provider } : {}),
      ...(input.model !== undefined ? { model: input.model } : {}),
      ...(input.autoMerge !== undefined ? { autoMerge: input.autoMerge } : {}),
      ...(input.maxRemediationCycles !== undefined ? { maxRemediationCycles: input.maxRemediationCycles } : {}),
      ...(input.maxReviewSpecialists !== undefined ? { maxReviewSpecialists: input.maxReviewSpecialists } : {}),
      subjectEvidence: [...(input.subjectEvidence ?? []), laneEvidence(input.lane)],
      ...(input.batchMembers !== undefined ? { batchMembers: input.batchMembers } : {}),
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
    maxReviewSpecialists?: number;
    subjectEvidence?: readonly string[];
    batchMembers?: readonly number[];
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
  }, { host: dependencies.host, artifacts: dependencies.artifacts, runs: dependencies.runs });
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
    }, { host: dependencies.host, artifacts: dependencies.artifacts, runs: dependencies.runs });
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
        }, { host: dependencies.host, artifacts: dependencies.artifacts, runs: dependencies.runs });
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
    }, { host: dependencies.host, artifacts: dependencies.artifacts, runs: dependencies.runs });
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
    }, { host: dependencies.host, artifacts: dependencies.artifacts, runs: dependencies.runs });
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
    }, { host: dependencies.host, artifacts: dependencies.artifacts, runs: dependencies.runs });
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
): string | undefined {
  const expected = packet.payload.expectedPaths.map((path) => normalizeRepoPath(path));
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
