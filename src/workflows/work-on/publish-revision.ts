// SPDX-License-Identifier: AGPL-3.0-or-later

import type { DurableArtifact } from "../../core/artifacts/schema.js";
import type { RetryClassification } from "../../core/retry.js";
import type { ForgeHost, PullRequestSnapshot } from "../../core/ports/forge-host.js";
import type { GitWorkspace, GitWorkspaceManager } from "../../core/ports/git-workspace.js";
import type { ArtifactRepository, RunRepository } from "../../core/ports/repositories.js";
import { transition, type RunState } from "../../core/state/machine.js";
import { WorkflowExecutionError, retryableExternalWorkflowError } from "./investigate.js";
import { assertRunTargetsBranch } from "./lane.js";
import { assertTargetHeadUnchanged, TargetBranchAdvancedError } from "./publish.js";
import { persistTargetAdvanceCheckpoint } from "./target-recovery.js";

export async function publishRemediationRevision(
  input: {
    run: RunState;
    pullRequest: PullRequestSnapshot;
    packet: DurableArtifact<"BuildPacket">;
    buildResult: DurableArtifact<"BuildResult">;
    workspace: GitWorkspace;
    /** Exact target head read before this publication attempt. */
    expectedTargetHeadSha: string;
    verdict?: DurableArtifact<"ReviewVerdict">;
    /** Durable source build that proves an explicitly supplied existing branch head. */
    sourceBuildResult?: DurableArtifact<"BuildResult">;
    /** Existing remote/PR head admitted by a target-recovery checkpoint. */
    expectedExistingHeadSha?: string;
    /** Permit old/old versus fresh/fresh adoption only for an exact fenced replay. */
    fencedReplay?: true;
  },
  dependencies: { git: GitWorkspaceManager; host: ForgeHost; runs: RunRepository; artifacts?: ArtifactRepository },
): Promise<{ run: RunState; pullRequest: PullRequestSnapshot }> {
  if (input.run.state !== "publishing") throw new Error(`Revision publication requires publishing state, found ${input.run.state}`);
  let run = input.run;
  try {
    const targetBranch = input.pullRequest.baseBranch;
    assertRunTargetsBranch(run, targetBranch);
    assertRemediationPublicationIdentity(input, targetBranch);

    const buildBaseSha = input.buildResult.payload.baseSha;
    if (!buildBaseSha) throw new Error("Remediation publication requires an exact verified BuildResult base SHA");
    if (input.expectedTargetHeadSha !== buildBaseSha) {
      throw new Error(`Remediation target head ${input.expectedTargetHeadSha} does not match verified BuildResult base ${buildBaseSha}`);
    }
    if (input.workspace.baseSha !== undefined && input.workspace.baseSha !== input.expectedTargetHeadSha) {
      throw new Error(`Remediation workspace base ${input.workspace.baseSha} does not match verified target base ${input.expectedTargetHeadSha}`);
    }
    if (input.expectedExistingHeadSha !== undefined && !input.fencedReplay) {
      throw new Error("Remediation existing-head proof is valid only for a fenced target-recovery replay");
    }
    if (input.expectedExistingHeadSha !== undefined && !input.sourceBuildResult) {
      throw new Error("Remediation publication existing-head proof requires its source BuildResult");
    }
    const workspaceHead = await dependencies.git.head(input.workspace);
    if (workspaceHead !== input.buildResult.payload.headSha) {
      throw new Error(`Remediation workspace head ${workspaceHead} does not match verified build ${input.buildResult.payload.headSha}`);
    }
    await assertTargetHeadUnchanged(
      dependencies.host,
      input.pullRequest.repo,
      targetBranch,
      input.expectedTargetHeadSha,
    );

    let observed = input.pullRequest;
    let alreadyPublished = false;
    if (input.fencedReplay) {
      if (!input.verdict) throw new Error("Fenced remediation replay requires the retained prior ReviewVerdict");
      const existingHead = input.expectedExistingHeadSha ?? input.verdict.payload.headSha;
      const freshHead = input.buildResult.payload.headSha;
      const remoteHead = await requireBranchHead(dependencies.host, input.pullRequest.repo, input.workspace.branch);
      const livePullRequest = await dependencies.host.getPullRequest(input.pullRequest.repo, input.pullRequest.number);
      assertRemediationPullRequestIdentity(livePullRequest, input, targetBranch);
      if (!sameSha(remoteHead, existingHead) && !sameSha(remoteHead, freshHead)) {
        throw new Error(`Remediation remote branch ${input.workspace.branch} is at unexpected head ${remoteHead}`);
      }
      if (!sameSha(livePullRequest.headSha, existingHead) && !sameSha(livePullRequest.headSha, freshHead)) {
        throw new Error(`Remediation PR #${livePullRequest.number} is at unexpected head ${livePullRequest.headSha}`);
      }
      const remoteIsFresh = sameSha(remoteHead, freshHead);
      const pullRequestIsFresh = sameSha(livePullRequest.headSha, freshHead);
      const remoteIsExisting = sameSha(remoteHead, existingHead);
      const pullRequestIsExisting = sameSha(livePullRequest.headSha, existingHead);
      if (remoteIsFresh !== pullRequestIsFresh || remoteIsExisting !== pullRequestIsExisting) {
        throw new Error(`Remediation remote branch and PR heads disagree (${remoteHead}, ${livePullRequest.headSha})`);
      }
      if (remoteIsFresh && pullRequestIsFresh) {
        // This is the only replay-adoption case: the fenced checkpoint proves
        // the old verdict and fresh BuildResult, and both live projections are
        // already exactly at the fresh head. Do not push a second time.
        observed = livePullRequest;
        alreadyPublished = true;
      } else if (!remoteIsExisting || !pullRequestIsExisting) {
        throw new Error(`Remediation publication heads are neither the admitted old head nor the fresh verified head`);
      } else {
        observed = livePullRequest;
      }
    }

    if (!alreadyPublished) {
      await dependencies.git.push(input.workspace);
      observed = await dependencies.host.getPullRequest(input.pullRequest.repo, input.pullRequest.number);
    }
    assertRemediationPullRequestIdentity(observed, input, targetBranch);
    let publishedHead = observed.headSha;
    if (!sameSha(publishedHead, input.buildResult.payload.headSha)) {
      publishedHead = await requireBranchHead(dependencies.host, observed.repo, observed.headBranch);
    }
    if (!sameSha(publishedHead, input.buildResult.payload.headSha)) {
      throw new Error(`Published remediation head ${publishedHead} does not match verified build ${input.buildResult.payload.headSha}`);
    }
    // GitHub's PR projection can briefly lag the branch ref after a successful
    // push. Carry only the directly observed ref SHA forward; fresh review
    // freezes the PR again before granting any authority.
    const pullRequest = observed.headSha === publishedHead ? observed : { ...observed, headSha: publishedHead };
    const advanced = transition(run, "PR_PUBLISHED", { headSha: publishedHead });
    await dependencies.runs.commit(run.version, advanced.state, advanced.record);
    return { run: advanced.state, pullRequest };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const externalRetry = retryableExternalWorkflowError(error, run);
    if (externalRetry) throw externalRetry;
    let targetCheckpoint: DurableArtifact<"TargetAdvanceCheckpoint"> | undefined;
    if (error instanceof TargetBranchAdvancedError) {
      // Persist target drift before changing the run state. The checkpoint is
      // the durable recovery authority when this process dies after the fence.
      targetCheckpoint = await persistTargetAdvanceCheckpoint({
        run,
        packet: input.packet,
        buildResult: input.buildResult,
        workspace: input.workspace,
        targetBranch: input.pullRequest.baseBranch,
        observedTargetSha: error.observedBaseSha,
        phase: "target-read",
        ...(input.verdict ? { verdict: input.verdict } : {}),
        pullRequest: input.pullRequest.number,
        ...(dependencies.artifacts ? { artifacts: dependencies.artifacts } : {}),
      });
    }
    const next = error instanceof TargetBranchAdvancedError ? transition(run, "TARGET_ADVANCE_DETECTED", { reason }) : transition(run, "FAIL", { reason });
    // Target movement is recoverable authority drift, never a terminal block.
    // The retained BuildResult/PR identity is re-admitted by target recovery.
    await dependencies.runs.commit(run.version, next.state, next.record);
    const retryDisposition: RetryClassification | undefined = error instanceof TargetBranchAdvancedError
      ? { disposition: "retryable", retryable: true, domain: "workflow", code: "target-advanced", cause: error }
      : undefined;
    throw new WorkflowExecutionError(reason, next.state, {
      cause: error,
      ...(retryDisposition ? { retryDisposition } : {}),
      ...(targetCheckpoint ? { checkpointId: targetCheckpoint.id } : {}),
    });
  }
}

function assertRemediationPublicationIdentity(
  input: {
    run: RunState;
    pullRequest: PullRequestSnapshot;
    buildResult: DurableArtifact<"BuildResult">;
    workspace: GitWorkspace;
    verdict?: DurableArtifact<"ReviewVerdict">;
    sourceBuildResult?: DurableArtifact<"BuildResult">;
  },
  targetBranch: string,
): void {
  const { run, pullRequest, buildResult, workspace, verdict, sourceBuildResult } = input;
  if (pullRequest.repo.toLowerCase() !== run.subject.repo.toLowerCase()) {
    throw new Error(`Remediation PR repository ${pullRequest.repo} does not match run ${run.subject.repo}`);
  }
  if (pullRequest.headBranch !== workspace.branch) {
    throw new Error(`Remediation PR branch ${pullRequest.headBranch} does not match workspace branch ${workspace.branch}`);
  }
  if (workspace.baseRef !== targetBranch && workspace.baseRef !== `origin/${targetBranch}`) {
    throw new Error(`Remediation workspace follows ${workspace.baseRef}, not target ${targetBranch}`);
  }
  if (buildResult.runId !== run.runId
    || buildResult.subject.repo.toLowerCase() !== run.subject.repo.toLowerCase()
    || buildResult.subject.issue !== run.subject.issue
    || buildResult.payload.branch !== workspace.branch
    || (buildResult.payload.targetBranch !== undefined && buildResult.payload.targetBranch !== targetBranch)) {
    throw new Error("Remediation BuildResult identity does not match the run, PR, or workspace");
  }
  if (sourceBuildResult !== undefined
    && (sourceBuildResult.runId !== run.runId
      || sourceBuildResult.subject.repo.toLowerCase() !== run.subject.repo.toLowerCase()
      || sourceBuildResult.subject.issue !== run.subject.issue
      || sourceBuildResult.payload.branch !== workspace.branch)) {
    throw new Error("Remediation source BuildResult identity does not match the run or workspace");
  }
  if (!verdict) return;
  if (verdict.runId !== run.runId
    || verdict.subject.repo.toLowerCase() !== run.subject.repo.toLowerCase()
    || verdict.subject.issue !== run.subject.issue
    || verdict.subject.pr !== pullRequest.number
    || (verdict.payload.baseBranch !== undefined && verdict.payload.baseBranch !== targetBranch)
    || (verdict.payload.headBranch !== undefined && verdict.payload.headBranch !== workspace.branch)) {
    throw new Error("Remediation prior ReviewVerdict identity does not match the run, PR, or target");
  }
}

function assertRemediationPullRequestIdentity(
  pullRequest: PullRequestSnapshot,
  input: { run: RunState; pullRequest: PullRequestSnapshot; buildResult: DurableArtifact<"BuildResult">; workspace: GitWorkspace; verdict?: DurableArtifact<"ReviewVerdict"> },
  targetBranch: string,
): void {
  if (pullRequest.repo.toLowerCase() !== input.run.subject.repo.toLowerCase()
    || pullRequest.number !== input.pullRequest.number
    || pullRequest.baseBranch !== targetBranch
    || pullRequest.headBranch !== input.workspace.branch) {
    throw new Error(`Remediation PR identity changed for ${input.run.subject.repo}#${input.pullRequest.number}`);
  }
  if (input.verdict && pullRequest.number !== input.verdict.subject.pr) {
    throw new Error(`Remediation PR #${pullRequest.number} does not match prior ReviewVerdict PR #${input.verdict.subject.pr}`);
  }
}

async function requireBranchHead(host: ForgeHost, repo: string, branch: string): Promise<string> {
  if (!host.getBranchHead) throw new Error(`Remediation publication requires an authoritative branch head reader for ${repo}:${branch}`);
  const head = await host.getBranchHead(repo, branch);
  if (!/^[0-9a-f]{7,64}$/i.test(head)) throw new Error(`Authoritative branch ${repo}:${branch} returned invalid head ${head}`);
  return head;
}

function sameSha(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}
