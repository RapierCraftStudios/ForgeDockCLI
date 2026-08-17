// SPDX-License-Identifier: AGPL-3.0-or-later

import type { DurableArtifact } from "../../core/artifacts/schema.js";
import type { ForgeHost, PullRequestSnapshot } from "../../core/ports/forge-host.js";
import type { GitWorkspace, GitWorkspaceManager } from "../../core/ports/git-workspace.js";
import type { RunRepository } from "../../core/ports/repositories.js";
import { transition, type RunState } from "../../core/state/machine.js";
import { WorkflowExecutionError } from "./investigate.js";
import { assertRunTargetsBranch } from "./lane.js";

export async function publishRemediationRevision(
  input: { run: RunState; pullRequest: PullRequestSnapshot; buildResult: DurableArtifact<"BuildResult">; workspace: GitWorkspace },
  dependencies: { git: GitWorkspaceManager; host: ForgeHost; runs: RunRepository },
): Promise<{ run: RunState; pullRequest: PullRequestSnapshot }> {
  if (input.run.state !== "publishing") throw new Error(`Revision publication requires publishing state, found ${input.run.state}`);
  let run = input.run;
  try {
    assertRunTargetsBranch(run, input.pullRequest.baseBranch);
    const workspaceHead = await dependencies.git.head(input.workspace);
    if (workspaceHead !== input.buildResult.payload.headSha) {
      throw new Error(`Remediation workspace head ${workspaceHead} does not match verified build ${input.buildResult.payload.headSha}`);
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
    const failed = transition(run, "FAIL", { reason });
    await dependencies.runs.commit(run.version, failed.state, failed.record);
    throw new WorkflowExecutionError(reason, failed.state, { cause: error });
  }
}
