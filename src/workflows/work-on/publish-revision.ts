// SPDX-License-Identifier: AGPL-3.0-or-later

import type { DurableArtifact } from "../../core/artifacts/schema.js";
import type { ForgeHost, PullRequestSnapshot } from "../../core/ports/forge-host.js";
import type { GitWorkspace, GitWorkspaceManager } from "../../core/ports/git-workspace.js";
import type { RunRepository } from "../../core/ports/repositories.js";
import { transition, type RunState } from "../../core/state/machine.js";
import { WorkflowExecutionError } from "./investigate.js";

export async function publishRemediationRevision(
  input: { run: RunState; pullRequest: PullRequestSnapshot; buildResult: DurableArtifact<"BuildResult">; workspace: GitWorkspace },
  dependencies: { git: GitWorkspaceManager; host: ForgeHost; runs: RunRepository },
): Promise<{ run: RunState; pullRequest: PullRequestSnapshot }> {
  if (input.run.state !== "publishing") throw new Error(`Revision publication requires publishing state, found ${input.run.state}`);
  let run = input.run;
  try {
    await dependencies.git.push(input.workspace);
    const pullRequest = await dependencies.host.getPullRequest(input.pullRequest.repo, input.pullRequest.number);
    if (pullRequest.headSha !== input.buildResult.payload.headSha) {
      throw new Error(`Published remediation head ${pullRequest.headSha} does not match verified build ${input.buildResult.payload.headSha}`);
    }
    const advanced = transition(run, "PR_PUBLISHED", { headSha: pullRequest.headSha });
    await dependencies.runs.commit(run.version, advanced.state, advanced.record);
    return { run: advanced.state, pullRequest };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const failed = transition(run, "FAIL", { reason });
    await dependencies.runs.commit(run.version, failed.state, failed.record);
    throw new WorkflowExecutionError(reason, failed.state, { cause: error });
  }
}
