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
  input: { run: RunState; pullRequest: PullRequestSnapshot; packet: DurableArtifact<"BuildPacket">; buildResult: DurableArtifact<"BuildResult">; workspace: GitWorkspace; expectedTargetHeadSha?: string; verdict?: DurableArtifact<"ReviewVerdict"> },
  dependencies: { git: GitWorkspaceManager; host: ForgeHost; runs: RunRepository; artifacts?: ArtifactRepository },
): Promise<{ run: RunState; pullRequest: PullRequestSnapshot }> {
  if (input.run.state !== "publishing") throw new Error(`Revision publication requires publishing state, found ${input.run.state}`);
  let run = input.run;
  try {
    assertRunTargetsBranch(run, input.pullRequest.baseBranch);
    const workspaceHead = await dependencies.git.head(input.workspace);
    if (workspaceHead !== input.buildResult.payload.headSha) {
      throw new Error(`Remediation workspace head ${workspaceHead} does not match verified build ${input.buildResult.payload.headSha}`);
    }
    if (input.expectedTargetHeadSha !== undefined) {
      await assertTargetHeadUnchanged(
        dependencies.host,
        input.pullRequest.repo,
        input.pullRequest.baseBranch,
        input.expectedTargetHeadSha,
      );
    }
    await dependencies.git.push(input.workspace);
    const observed = await dependencies.host.getPullRequest(input.pullRequest.repo, input.pullRequest.number);
    assertRunTargetsBranch(run, observed.baseBranch);
    if (observed.headBranch !== input.workspace.branch) {
      throw new Error(`Published PR branch ${observed.headBranch} does not match remediation branch ${input.workspace.branch}`);
    }
    let publishedHead = observed.headSha;
    if (publishedHead !== input.buildResult.payload.headSha && dependencies.host.getBranchHead) {
      publishedHead = await dependencies.host.getBranchHead(observed.repo, observed.headBranch);
    }
    if (publishedHead !== input.buildResult.payload.headSha) {
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
