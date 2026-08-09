// SPDX-License-Identifier: AGPL-3.0-or-later

import type { DurableArtifact } from "../../core/artifacts/schema.js";
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
  const { intent, investigation, packet, buildResult } = reviewArtifactsForHead(
    source,
    pullRequest.headSha,
    pullRequest.headBranch,
    pullRequest.baseBranch,
  );

  let run = createRun({ workflow: "review-pr", subject: { repo: input.repo, issue, pr: input.pr } });
  run = { ...run, headSha: pullRequest.headSha };
  for (const artifact of [intent, investigation, packet, buildResult]) run = attachArtifact(run, artifact.kind, artifact.id);
  await dependencies.runs.create(run);
  const workspace = await dependencies.workspaces.createReview({ runId: run.runId, pr: input.pr, headSha: pullRequest.headSha });
  try {
    return await reviewPullRequest({
      run, pullRequest, intent, investigation, packet, buildResult, workspace: workspace.path,
      deliveryRunId: buildResult.runId,
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

export function reviewArtifactsForHead(
  artifacts: readonly DurableArtifact[],
  headSha: string,
  headBranch?: string,
  baseBranch?: string,
): {
  intent: DurableArtifact<"Intent">;
  investigation: DurableArtifact<"Investigation">;
  packet: DurableArtifact<"BuildPacket">;
  buildResult: DurableArtifact<"BuildResult">;
} {
  const buildResult = artifacts
    .filter((artifact): artifact is DurableArtifact<"BuildResult"> =>
      artifact.kind === "BuildResult"
      && artifact.payload.headSha.toLowerCase() === headSha.toLowerCase()
      && (headBranch === undefined || artifact.payload.branch === headBranch))
    .at(-1);
  if (!buildResult) throw new Error(`No durable Build Result matches pull request head ${headSha}${headBranch ? ` on ${headBranch}` : ""}`);
  if (baseBranch !== undefined && buildResult.payload.targetBranch !== baseBranch) {
    throw new Error(`Build Result target ${buildResult.payload.targetBranch ?? "unknown"} does not match pull request base ${baseBranch}`);
  }
  const runArtifacts = artifacts.filter((artifact) => artifact.runId === buildResult.runId);
  const required = <K extends DurableArtifact["kind"]>(kind: K): Extract<DurableArtifact, { kind: K }> => {
    const artifact = runArtifacts
      .filter((candidate): candidate is Extract<DurableArtifact, { kind: K }> => candidate.kind === kind)
      .at(-1);
    if (!artifact) throw new Error(`Required ${kind} artifact is missing from delivery run ${buildResult.runId}`);
    return artifact;
  };
  return {
    intent: required("Intent"),
    investigation: required("Investigation"),
    packet: required("BuildPacket"),
    buildResult,
  };
}

function linkedIssue(body: string): number | undefined {
  const match = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)\b/i.exec(body);
  return match?.[1] ? Number(match[1]) : undefined;
}
