// SPDX-License-Identifier: AGPL-3.0-or-later

import type { ArtifactKind, DurableArtifact } from "../../core/artifacts/schema.js";
import type { ForgeHost } from "../../core/ports/forge-host.js";
import type { ReviewWorkspaceManager } from "../../core/ports/git-workspace.js";
import type { ArtifactRepository, RunRepository } from "../../core/ports/repositories.js";
import { attachArtifact, createRun } from "../../core/state/machine.js";
import type { AgentEventSink, AgentRuntime } from "../../runtime/agent-runtime.js";
import { reviewPullRequest } from "./review.js";

export async function reviewExistingPullRequest(
  input: { repo: string; pr: number; issue?: number; provider?: string; model?: string; maxReviewSpecialists?: number; signal?: AbortSignal },
  dependencies: {
    runtime: AgentRuntime;
    host: ForgeHost;
    workspaces: ReviewWorkspaceManager;
    artifacts: ArtifactRepository;
    runs: RunRepository;
    onAgentEvent?: AgentEventSink;
  },
) {
  const pullRequest = await dependencies.host.getPullRequest(input.repo, input.pr);
  const issue = input.issue ?? linkedIssue(pullRequest.body);
  if (!issue) throw new Error("PR does not identify its original issue; pass --issue <number>");
  const source = await dependencies.artifacts.list({ repo: input.repo, issue });
  const intent = latest(source, "Intent");
  const investigation = latest(source, "Investigation");
  const packet = latest(source, "BuildPacket");
  const buildResult = latest(source, "BuildResult");
  if (buildResult.payload.headSha !== pullRequest.headSha) {
    throw new Error(`Latest Build Result is ${buildResult.payload.headSha}, but PR head is ${pullRequest.headSha}`);
  }

  let run = createRun({ workflow: "review-pr", subject: { repo: input.repo, issue, pr: input.pr } });
  run = { ...run, headSha: pullRequest.headSha };
  for (const artifact of [intent, investigation, packet, buildResult]) run = attachArtifact(run, artifact.kind, artifact.id);
  await dependencies.runs.create(run);
  const workspace = await dependencies.workspaces.createReview({ runId: run.runId, pr: input.pr, headSha: pullRequest.headSha });
  try {
    return await reviewPullRequest({
      run, pullRequest, intent, investigation, packet, buildResult, workspace: workspace.path,
      ...(input.provider !== undefined ? { provider: input.provider } : {}),
      ...(input.model !== undefined ? { model: input.model } : {}),
      ...(input.maxReviewSpecialists !== undefined ? { maxReviewSpecialists: input.maxReviewSpecialists } : {}),
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
    }, {
      runtime: dependencies.runtime, host: dependencies.host, artifacts: dependencies.artifacts, runs: dependencies.runs,
      ...(dependencies.onAgentEvent !== undefined ? { onAgentEvent: dependencies.onAgentEvent } : {}),
    });
  } finally {
    await dependencies.workspaces.remove(workspace);
  }
}

function latest<K extends ArtifactKind>(artifacts: DurableArtifact[], kind: K): DurableArtifact<K> {
  const matching = artifacts.filter((artifact): artifact is DurableArtifact<K> => artifact.kind === kind)
    .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));
  const artifact = matching[0];
  if (!artifact) throw new Error(`Required ${kind} artifact is missing from the linked issue`);
  return artifact;
}

function linkedIssue(body: string): number | undefined {
  const match = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)\b/i.exec(body);
  return match?.[1] ? Number(match[1]) : undefined;
}
