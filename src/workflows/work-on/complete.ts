// SPDX-License-Identifier: AGPL-3.0-or-later

import { createArtifact, type DurableArtifact } from "../../core/artifacts/schema.js";
import type { ForgeHost, PullRequestSnapshot } from "../../core/ports/forge-host.js";
import type { ArtifactRepository, RunRepository } from "../../core/ports/repositories.js";
import { attachArtifact, transition, type RunState } from "../../core/state/machine.js";
import { WorkflowExecutionError } from "./investigate.js";

export async function completeWorkItem(
  input: {
    run: RunState;
    pullRequest: PullRequestSnapshot;
    verdict: DurableArtifact<"ReviewVerdict">;
    autoMerge: boolean;
    childIssues?: readonly number[];
  },
  dependencies: { host: ForgeHost; artifacts: ArtifactRepository; runs: RunRepository },
): Promise<{ run: RunState; awaitingHuman: boolean; outcome?: DurableArtifact<"Outcome"> }> {
  if (input.run.state !== "merging") throw new Error(`Completion requires merging state, found ${input.run.state}`);
  if (input.verdict.payload.disposition !== "approve") throw new Error("Cannot complete without an approving Review Verdict");
  let run = input.run;
  try {
    let pullRequest = await dependencies.host.getPullRequest(input.pullRequest.repo, input.pullRequest.number);
    if (pullRequest.headSha !== input.verdict.payload.headSha) {
      throw new Error(`Approved SHA ${input.verdict.payload.headSha} is stale; current PR head is ${pullRequest.headSha}`);
    }
    if (pullRequest.state !== "MERGED") {
      if (!input.autoMerge) return { run, awaitingHuman: true };
      await dependencies.host.mergePullRequest(pullRequest.repo, pullRequest.number, input.verdict.payload.headSha);
      pullRequest = await dependencies.host.getPullRequest(pullRequest.repo, pullRequest.number);
      if (pullRequest.state !== "MERGED") throw new Error("Merge command completed but the pull request is not merged");
    }

    const merged = transition(run, "MERGE_COMPLETED", { headSha: pullRequest.headSha });
    await dependencies.runs.commit(run.version, merged.state, merged.record);
    run = merged.state;
    const issue = run.subject.issue;
    if (!issue) throw new Error("work-on completion requires an issue subject");
    const childIssues = [...new Set(input.childIssues ?? [])]
      .filter((child) => Number.isSafeInteger(child) && child > 0 && child !== issue);
    const outcome = createArtifact({
      kind: "Outcome",
      runId: run.runId,
      subject: run.subject,
      producer: { role: "controller", runtime: "forgedock" },
      payload: {
        status: "merged",
        reason: `Merged PR #${pullRequest.number} after independent review of ${pullRequest.headSha}.`,
        finalSha: pullRequest.headSha,
        prUrl: pullRequest.url,
        childIssues: childIssues.map((child) => `issue-${child}`),
      },
    });
    for (const childIssue of childIssues) {
      await dependencies.host.closeIssue(run.subject.repo, childIssue, `Completed by batch issue #${issue} via ${pullRequest.url} at ${pullRequest.headSha}.`);
      await dependencies.artifacts.append(createArtifact({
        kind: "Outcome",
        runId: run.runId,
        subject: { repo: run.subject.repo, issue: childIssue },
        producer: { role: "controller", runtime: "forgedock" },
        payload: {
          status: "merged",
          reason: `Completed as member of batch issue #${issue} by PR #${pullRequest.number}.`,
          finalSha: pullRequest.headSha,
          prUrl: pullRequest.url,
          childIssues: [],
          batchParent: issue,
        },
      }));
    }
    await dependencies.artifacts.append(outcome);
    run = attachArtifact(run, "Outcome", outcome.id);
    await dependencies.host.closeIssue(run.subject.repo, issue, `Completed by ${pullRequest.url} at ${pullRequest.headSha}.`);
    const closed = transition(run, "CLOSE_COMPLETED");
    await dependencies.runs.commit(run.version, closed.state, closed.record);
    return { run: closed.state, awaitingHuman: false, outcome };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const failed = transition(run, "FAIL", { reason });
    await dependencies.runs.commit(run.version, failed.state, failed.record);
    throw new WorkflowExecutionError(reason, failed.state, { cause: error });
  }
}
