// SPDX-License-Identifier: AGPL-3.0-or-later

import { createArtifact, type DurableArtifact } from "../../core/artifacts/schema.js";
import type { ForgeHost, PullRequestMergeGate, PullRequestSnapshot } from "../../core/ports/forge-host.js";
import type { ReviewWorkspaceManager } from "../../core/ports/git-workspace.js";
import type { ArtifactRepository, RunRepository } from "../../core/ports/repositories.js";
import { attachArtifact, createRun } from "../../core/state/machine.js";
import type { AgentEventSink, AgentRuntime } from "../../runtime/agent-runtime.js";
import { parseDiffPaths } from "./planner.js";
import { reviewPullRequest, type ReviewChecks } from "./review.js";

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
  if (!issue) return reviewDeploymentPullRequest({ input, pullRequest }, dependencies);
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

async function reviewDeploymentPullRequest(
  input: {
    input: { repo: string; pr: number; provider?: string; model?: string; maxReviewSpecialists?: number; signal?: AbortSignal };
    pullRequest: PullRequestSnapshot;
  },
  dependencies: {
    runtime: AgentRuntime;
    host: ForgeHost;
    workspaces: ReviewWorkspaceManager;
    artifacts: ArtifactRepository;
    runs: RunRepository;
    onAgentEvent?: AgentEventSink;
  },
) {
  if (!isDeploymentPullRequest(input.pullRequest)) {
    throw new Error("PR does not identify its original issue and is not a staging-to-main deployment; pass --issue <number>");
  }
  const diff = await dependencies.host.getPullRequestDiff(input.pullRequest.repo, input.pullRequest.number);
  const changedPaths = parseDiffPaths(diff);
  if (!changedPaths.length) throw new Error("Deployment PR diff does not contain any changed paths");
  const mergeGate = dependencies.host.getPullRequestMergeGate
    ? await dependencies.host.getPullRequestMergeGate(
      input.pullRequest.repo,
      input.pullRequest.number,
      input.pullRequest.headSha,
      input.pullRequest.baseBranch,
    )
    : undefined;
  if (mergeGate) assertDeploymentMergeGate(mergeGate);
  const checks = toReviewChecks(mergeGate);
  let run = createRun({ workflow: "review-pr", subject: { repo: input.pullRequest.repo, pr: input.pullRequest.number } });
  run = { ...run, headSha: input.pullRequest.headSha };
  const context = createDeploymentReviewArtifacts({ run, pullRequest: input.pullRequest, changedPaths, checks });
  for (const artifact of [context.intent, context.investigation, context.packet]) {
    await dependencies.artifacts.append(artifact);
    run = attachArtifact(run, artifact.kind, artifact.id);
  }
  await dependencies.runs.create(run);
  const workspace = await dependencies.workspaces.createReview({ runId: run.runId, pr: input.pullRequest.number, headSha: input.pullRequest.headSha });
  try {
    const result = await reviewPullRequest({
      run,
      pullRequest: input.pullRequest,
      ...context,
      deployment: {
        headSha: input.pullRequest.headSha,
        headBranch: input.pullRequest.headBranch,
        baseBranch: input.pullRequest.baseBranch,
        changedPaths,
        checks,
      },
      workspace: workspace.path,
      ...(input.input.provider !== undefined ? { provider: input.input.provider } : {}),
      ...(input.input.model !== undefined ? { model: input.input.model } : {}),
      ...(input.input.maxReviewSpecialists !== undefined ? { maxReviewSpecialists: input.input.maxReviewSpecialists } : {}),
      ...(input.input.signal !== undefined ? { signal: input.input.signal } : {}),
    }, {
      runtime: dependencies.runtime,
      host: dependencies.host,
      artifacts: dependencies.artifacts,
      runs: dependencies.runs,
      ...(dependencies.onAgentEvent !== undefined ? { onAgentEvent: dependencies.onAgentEvent } : {}),
    });
    await publishDeploymentGateMarker(dependencies.host, input.pullRequest, result);
    return result;
  } finally {
    await dependencies.workspaces.remove(workspace);
  }
}

function isDeploymentPullRequest(
  pullRequest: Pick<PullRequestSnapshot, "headBranch" | "baseBranch">,
): boolean {
  return pullRequest.headBranch === "staging" && pullRequest.baseBranch === "main";
}

const DEPLOYMENT_GATE_MARKER_CHECK = "check for forge gate markers";

function assertDeploymentMergeGate(gate: PullRequestMergeGate): void {
  if (!gate.mergeable) throw new Error(`Deployment PR #${gate.pullRequest} is not currently mergeable`);
  const blocked = gate.requiredChecks.filter((check) => {
    if (check.state === "passed") return false;
    // This check is intentionally red until this review posts its trusted
    // marker. It must not deadlock the review that is responsible for it.
    return !(check.name.trim().toLowerCase() === DEPLOYMENT_GATE_MARKER_CHECK
      && (check.state === "pending" || check.state === "failed"));
  });
  if (blocked.length) {
    throw new Error(`Deployment PR checks are not green: ${blocked.map((check) => `${check.name}=${check.state}`).join(", ")}`);
  }
}

async function publishDeploymentGateMarker(
  host: ForgeHost,
  pullRequest: PullRequestSnapshot,
  result: { run: ReturnType<typeof createRun>; verdict: DurableArtifact<"ReviewVerdict"> },
): Promise<void> {
  const passed = result.verdict.payload.disposition === "approve";
  const idempotencyMarker = `<!-- FORGEDOCK:DEPLOYMENT_GATE:${result.run.runId}:${pullRequest.headSha} -->`;
  const gateMarker = passed ? "<!-- FORGE:GATE_PASS -->" : "<!-- FORGE:GATE_FAILURE -->";
  await host.publishPullRequestComment({
    repo: pullRequest.repo,
    pullRequest: pullRequest.number,
    marker: idempotencyMarker,
    body: [
      gateMarker,
      "<!-- FORGE:SPEC_LOADED -->",
      idempotencyMarker,
      `ForgeDock deployment review ${passed ? "passed" : "blocked"} for PR #${pullRequest.number}.`,
      `Reviewed head: ${pullRequest.headSha}`,
      `Disposition: ${result.verdict.payload.disposition}`,
    ].join("\\n"),
  });
}

function toReviewChecks(gate: PullRequestMergeGate | undefined): ReviewChecks {
  return (gate?.requiredChecks ?? []).map((check) => ({
    command: `GitHub required check: ${check.name}`,
    status: check.state === "passed" ? "passed" : "skipped",
    durationMs: 0,
    ...(check.detailsUrl ? { summary: check.detailsUrl } : {}),
  }));
}

function createDeploymentReviewArtifacts(input: {
  run: ReturnType<typeof createRun>;
  pullRequest: PullRequestSnapshot;
  changedPaths: readonly string[];
  checks: ReviewChecks;
}): {
  intent: DurableArtifact<"Intent">;
  investigation: DurableArtifact<"Investigation">;
  packet: DurableArtifact<"BuildPacket">;
} {
  const { pullRequest, changedPaths, checks } = input;
  const subject = input.run.subject;
  const producer = { role: "deployment-review", runtime: "forgedock" };
  const target = `${pullRequest.headBranch} → ${pullRequest.baseBranch}`;
  const checkSummary = checks.length
    ? checks.map((check) => `${check.command}=${check.status}`).join(", ")
    : "No required GitHub check runs were reported by the host.";
  const idPrefix = `deployment-review-${pullRequest.number}-${pullRequest.headSha.slice(0, 12)}`;
  const intent = createArtifact({
    kind: "Intent", runId: input.run.runId, subject, producer,
    payload: {
      title: pullRequest.title,
      problem: `Review the complete ${target} deployment pull request before promotion.`,
      desiredOutcome: `Confirm that PR #${pullRequest.number} is safe to promote from ${pullRequest.headBranch} to ${pullRequest.baseBranch}.`,
      constraints: [`Review exactly PR #${pullRequest.number} at head ${pullRequest.headSha}.`, "Do not merge or change the deployment pull request as part of review."],
      acceptanceHints: [
        "The complete deployment diff is free of actionable correctness, security, data, compatibility, infrastructure, frontend, and concurrency defects.",
        "The reviewed PR head remains unchanged throughout the review.",
      ],
      dependencies: [], sourceUrl: pullRequest.url,
    },
  }, { id: `${idPrefix}-intent` });
  const investigation = createArtifact({
    kind: "Investigation", runId: input.run.runId, subject, producer,
    payload: {
      outcome: "confirmed", confidence: "high",
      summary: `Deployment PR #${pullRequest.number} promotes ${pullRequest.headBranch} to ${pullRequest.baseBranch}; review evidence is anchored to ${pullRequest.headSha}.`,
      evidence: [
        { claim: "The deployment PR head is the review anchor.", source: pullRequest.url, detail: `${pullRequest.headBranch} at ${pullRequest.headSha} targets ${pullRequest.baseBranch}.` },
        { claim: "The complete deployment diff is in scope.", source: pullRequest.url, detail: `${changedPaths.length} changed path(s): ${changedPaths.join(", ")}.` },
        { claim: "Current required-check evidence was captured before reviewer dispatch.", source: pullRequest.url, detail: checkSummary },
      ],
      affectedSurfaces: [...changedPaths],
      risks: ["A deployment PR aggregates changes from multiple issue-backed runs and has no single originating issue scope."],
      recommendation: "Run independent reviewers over the complete deployment diff and preserve the exact PR head SHA.",
    },
  }, { id: `${idPrefix}-investigation` });
  const packet = createArtifact({
    kind: "BuildPacket", runId: input.run.runId, subject, producer,
    payload: {
      scope: [`Promote ${pullRequest.headBranch} to ${pullRequest.baseBranch} through PR #${pullRequest.number}.`],
      acceptanceCriteria: [
        "The complete deployment diff is safe to promote from staging to main.",
        "The reviewed PR head remains unchanged throughout the review.",
      ],
      context: [
        { source: pullRequest.url, relevance: pullRequest.title },
        { source: "GitHub required checks", relevance: checkSummary },
      ],
      implementationPlan: ["Review every changed path and applicable risk surface in the deployment diff."],
      expectedPaths: [...changedPaths],
      verificationPlan: ["Re-read the PR head before and after independent review.", "Use current GitHub required-check results as deployment evidence."],
      risks: [{ risk: "A promotion PR can combine unrelated changes without issue-level Build Packets.", mitigation: "Review the full diff, freeze the PR head, and require independent risk specialists." }],
      outOfScope: ["Merging the PR", "Creating or changing issue delivery work"],
    },
  }, { id: `${idPrefix}-packet` });
  return { intent, investigation, packet };
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
