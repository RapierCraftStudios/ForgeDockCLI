// SPDX-License-Identifier: AGPL-3.0-or-later

import { renderArtifactMarkdown } from "../../core/artifacts/codec.js";
import type { DurableArtifact } from "../../core/artifacts/schema.js";
import type { ForgeHost, PullRequestSnapshot } from "../../core/ports/forge-host.js";
import type { GitWorkspace, GitWorkspaceManager } from "../../core/ports/git-workspace.js";
import type { RunRepository } from "../../core/ports/repositories.js";
import { transition, type RunState } from "../../core/state/machine.js";
import { WorkflowExecutionError } from "./investigate.js";

export async function publishPullRequest(
  input: {
    run: RunState;
    intent: DurableArtifact<"Intent">;
    packet: DurableArtifact<"BuildPacket">;
    buildResult: DurableArtifact<"BuildResult">;
    workspace: GitWorkspace;
    baseBranch: string;
  },
  dependencies: { git: GitWorkspaceManager; host: ForgeHost; runs: RunRepository },
): Promise<{ run: RunState; pullRequest: PullRequestSnapshot }> {
  if (input.run.state !== "publishing") throw new Error(`Publication requires publishing state, found ${input.run.state}`);
  let run = input.run;
  try {
    await dependencies.git.push(input.workspace);
    const issue = run.subject.issue;
    if (!issue) throw new Error("work-on publication requires an issue subject");
    const body = [
      `Closes #${issue}`,
      "",
      renderArtifactMarkdown(input.packet),
      "",
      renderArtifactMarkdown(input.buildResult),
    ].join("\n");
    const pullRequest = await dependencies.host.createPullRequest({
      repo: run.subject.repo,
      issue,
      headBranch: input.workspace.branch,
      baseBranch: input.baseBranch,
      title: input.intent.payload.title,
      body,
    });
    if (pullRequest.headSha !== input.buildResult.payload.headSha) {
      throw new Error(`Published PR head ${pullRequest.headSha} does not match verified build ${input.buildResult.payload.headSha}`);
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
