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
  assertRequestedPullRequestIdentity(input.repo, input.pr, pullRequest, "initial read");
  if (isDeploymentPullRequest(pullRequest)) {
    return reviewDeploymentPullRequest({ input, pullRequest }, dependencies);
  }
  const issue = input.issue ?? linkedIssue(pullRequest.body);
  if (!issue) return reviewDeploymentPullRequest({ input, pullRequest }, dependencies);
  if (pullRequest.state !== "OPEN") {
    throw new Error(`Cannot start review: PR #${pullRequest.number} must be OPEN at freeze, found ${pullRequest.state}`);
  }
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
  let latestTrustedSnapshot = input.pullRequest;
  try {
    if (input.pullRequest.state !== "OPEN") {
      throw new Error(`Cannot start deployment review: PR #${input.pullRequest.number} must be OPEN at freeze, found ${input.pullRequest.state}`);
    }
    // Re-read immediately before the start marker. The initial snapshot is
    // routing evidence only; the marker and every subsequent review artifact
    // bind the actual current head frozen at review start.
    const frozen = await dependencies.host.getPullRequest(input.input.repo, input.input.pr);
    assertRequestedPullRequestIdentity(input.input.repo, input.input.pr, frozen, "pre-start read");
    latestTrustedSnapshot = frozen;
    if (!isDeploymentPullRequest(frozen)) {
      throw new Error(`Cannot start deployment review: PR #${frozen.number} no longer routes staging to main`);
    }
    if (frozen.state !== "OPEN") {
      throw new Error(`Cannot start deployment review: PR #${frozen.number} must be OPEN at freeze, found ${frozen.state}`);
    }
    await publishDeploymentGateMarker(dependencies.host, frozen, "start");
    const diff = await dependencies.host.getPullRequestDiff(frozen.repo, frozen.number);
    const changedPaths = parseDiffPaths(diff);
    if (!changedPaths.length) throw new Error("Deployment PR diff does not contain any changed paths");
    const mergeGate = dependencies.host.getPullRequestMergeGate
      ? await dependencies.host.getPullRequestMergeGate(
        frozen.repo,
        frozen.number,
        frozen.headSha,
        frozen.baseBranch,
      )
      : undefined;
    if (mergeGate) {
      assertDeploymentMergeGateAuthority(mergeGate, frozen);
      assertDeploymentMergeGate(mergeGate);
    }
    const checks = toReviewChecks(mergeGate);
    let run = createRun({ workflow: "review-pr", subject: { repo: frozen.repo, pr: frozen.number } });
    run = { ...run, headSha: frozen.headSha };
    const context = createDeploymentReviewArtifacts({ run, pullRequest: frozen, changedPaths, checks });
    for (const artifact of [context.intent, context.investigation, context.packet]) {
      await dependencies.artifacts.append(artifact);
      run = attachArtifact(run, artifact.kind, artifact.id);
    }
    await dependencies.runs.create(run);
    const workspace = await dependencies.workspaces.createReview({ runId: run.runId, pr: frozen.number, headSha: frozen.headSha });
    const result = await (async () => {
      try {
        return await reviewPullRequest({
          run,
          pullRequest: frozen,
          ...context,
          deployment: {
            headSha: frozen.headSha,
            headBranch: frozen.headBranch,
            baseBranch: frozen.baseBranch,
            changedPaths,
            checks,
          },
          workspace: workspace.path,
          ...(input.input.provider !== undefined ? { provider: input.input.provider } : {}),
          ...(input.input.model !== undefined ? { model: input.input.model } : {}),
          // Deployment diffs are often repository-wide. Pack specialist
          // capabilities into one independent group by default so the provider
          // is not asked to process several near-identical giant contexts at once.
          maxReviewSpecialists: input.input.maxReviewSpecialists ?? 1,
          ...(input.input.signal !== undefined ? { signal: input.input.signal } : {}),
        }, {
          runtime: dependencies.runtime,
          host: dependencies.host,
          artifacts: dependencies.artifacts,
          runs: dependencies.runs,
          ...(dependencies.onAgentEvent !== undefined ? { onAgentEvent: dependencies.onAgentEvent } : {}),
        });
      } finally {
        await dependencies.workspaces.remove(workspace);
      }
    })();
    const current = await dependencies.host.getPullRequest(frozen.repo, frozen.number);
    assertDeploymentMarkerHead(frozen, current);
    await publishDeploymentGateMarker(
      dependencies.host,
      current,
      result.verdict.payload.disposition === "approve" ? "pass" : "failure",
      result.verdict.payload.disposition === "approve"
        ? undefined
        : `Review disposition: ${result.verdict.payload.disposition}`,
    );
    return result;
  } catch (error) {
    let reason = error instanceof Error ? error.message : String(error);
    let current = latestTrustedSnapshot;
    try {
      const candidate = await dependencies.host.getPullRequest(input.pullRequest.repo, input.pullRequest.number);
      if (samePullRequestIdentity(input.pullRequest, candidate)) {
        current = candidate;
      } else {
        reason += `; host re-read returned mismatched PR identity ${candidate.repo}#${candidate.number}`;
      }
    } catch {
      // The frozen snapshot remains the only identity available when the host
      // cannot be re-read; publication below still attempts a fail-closed gate.
    }
    try {
      await publishDeploymentGateMarker(dependencies.host, current, "failure", reason);
    } catch (publicationError) {
      const publicationReason = publicationError instanceof Error ? publicationError.message : String(publicationError);
      throw new Error(`${reason}; deployment failure marker publication also failed: ${publicationReason}`, {
        cause: new AggregateError([error, publicationError]),
      });
    }
    throw error;
  }
}

function isDeploymentPullRequest(
  pullRequest: Pick<PullRequestSnapshot, "headBranch" | "baseBranch">,
): boolean {
  return pullRequest.headBranch === "staging" && pullRequest.baseBranch === "main";
}

const DEPLOYMENT_GATE_MARKER_CHECK = "check for forge gate markers";

function assertDeploymentMergeGateAuthority(gate: PullRequestMergeGate, pullRequest: PullRequestSnapshot): void {
  if (gate.repo.trim().toLowerCase() !== pullRequest.repo.trim().toLowerCase()
    || gate.pullRequest !== pullRequest.number
    || gate.headSha.toLowerCase() !== pullRequest.headSha.toLowerCase()
    || gate.baseBranch !== pullRequest.baseBranch) {
    throw new Error(
      `Deployment merge-gate identity mismatch: expected ${pullRequest.repo}#${pullRequest.number} ${pullRequest.headSha} -> ${pullRequest.baseBranch}`
      + `, received ${gate.repo}#${gate.pullRequest} ${gate.headSha} -> ${gate.baseBranch}`,
    );
  }
}

function assertDeploymentMergeGate(gate: PullRequestMergeGate): void {
  if (!gate.mergeable) throw new Error(`Deployment PR #${gate.pullRequest} is not currently mergeable`);
  const blocked = gate.requiredChecks.filter((check) => {
    if (check.state === "passed") return false;
    // This check is intentionally red until this review posts its trusted
    // marker. It must not deadlock the review that is responsible for it.
    return !(isDeploymentGateMarkerCheck(check.name)
      && (check.state === "pending" || check.state === "failed"));
  });
  if (blocked.length) {
    throw new Error(`Deployment PR checks are not green: ${blocked.map((check) => `${check.name}=${check.state}`).join(", ")}`);
  }
}

function isDeploymentGateMarkerCheck(name: string): boolean {
  return name.trim().toLowerCase() === DEPLOYMENT_GATE_MARKER_CHECK;
}

type DeploymentGateMarkerState = "start" | "failure" | "pass";

async function publishDeploymentGateMarker(
  host: ForgeHost,
  pullRequest: PullRequestSnapshot,
  state: DeploymentGateMarkerState,
  detail?: string,
): Promise<void> {
  const repo = pullRequest.repo.trim().toLowerCase();
  const headSha = pullRequest.headSha.trim().toLowerCase();
  const identity = `repo=${repo} pr=${pullRequest.number} head=${headSha}`;
  // ForgeHost publication is create-once by canonical marker, so each state
  // needs its own deterministic marker. Repeated publication of the same
  // state/head remains idempotent without suppressing the later terminal state.
  const idempotencyMarker = `<!-- FORGEDOCK:DEPLOYMENT_GATE_${state.toUpperCase()} v2 ${identity} -->`;
  const gateMarker = state === "pass"
    ? "<!-- FORGE:GATE_PASS -->"
    : state === "failure" ? "<!-- FORGE:GATE_FAILURE -->" : undefined;
  await host.publishPullRequestComment({
    repo: pullRequest.repo,
    pullRequest: pullRequest.number,
    marker: idempotencyMarker,
    body: [
      ...(gateMarker ? [gateMarker] : []),
      "<!-- FORGE:SPEC_LOADED -->",
      idempotencyMarker,
      `ForgeDock deployment review ${state === "start" ? "started" : state === "pass" ? "passed" : "blocked"} for ${pullRequest.repo}#${pullRequest.number}.`,
      `Repository: ${pullRequest.repo}`,
      `Pull request: ${pullRequest.number}`,
      `Reviewed head: ${pullRequest.headSha}`,
      `Gate state: ${state}`,
      ...(detail ? [`Detail: ${safeDeploymentMarkerDetail(detail)}`] : []),
    ].join("\n"),
  });
}

function safeDeploymentMarkerDetail(value: string): string {
  return value.slice(0, 1_000).replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function assertDeploymentMarkerHead(frozen: PullRequestSnapshot, current: PullRequestSnapshot): void {
  if (!samePullRequestIdentity(frozen, current)
    || current.headSha.toLowerCase() !== frozen.headSha.toLowerCase()
    || current.headBranch !== frozen.headBranch
    || current.baseBranch !== frozen.baseBranch
    || current.state !== "OPEN") {
    throw new Error(
      `Deployment PR route changed before gate publication: ${frozen.repo}#${frozen.number} ${frozen.headBranch}@${frozen.headSha} -> ${frozen.baseBranch} (OPEN)`
      + ` became ${current.repo}#${current.number} ${current.headBranch}@${current.headSha} -> ${current.baseBranch} (${current.state})`,
    );
  }
}

function samePullRequestIdentity(left: PullRequestSnapshot, right: PullRequestSnapshot): boolean {
  return left.repo.trim().toLowerCase() === right.repo.trim().toLowerCase()
    && left.number === right.number;
}

function assertRequestedPullRequestIdentity(
  repo: string,
  pullRequest: number,
  snapshot: PullRequestSnapshot,
  phase: string,
): void {
  if (snapshot.repo.trim().toLowerCase() !== repo.trim().toLowerCase() || snapshot.number !== pullRequest) {
    throw new Error(
      `GitHub ${phase} returned mismatched PR identity ${snapshot.repo}#${snapshot.number}`
      + ` for requested ${repo}#${pullRequest}`,
    );
  }
}

function toReviewChecks(gate: PullRequestMergeGate | undefined): ReviewChecks {
  return (gate?.requiredChecks ?? []).map((check) => {
    const bootstrapMarkerCheck = isDeploymentGateMarkerCheck(check.name);
    return {
      command: `GitHub required check: ${check.name}`,
      // CheckResult has no pending/cancelled/unavailable state. Preserve the
      // exact GitHub state in summary and fail closed instead of claiming that
      // an observed non-green check was intentionally skipped.
      status: check.state === "passed" ? "passed" : "failed",
      durationMs: 0,
      ...(check.state !== "passed" ? {
        failureClass: check.state === "failed" && !bootstrapMarkerCheck ? "command" as const : "infrastructure" as const,
        failureSignatures: [`github-required-check:${check.state}`],
      } : {}),
      ...(check.detailsUrl || check.state !== "passed" ? {
        summary: [
          `GitHub state: ${check.state}`,
          ...(bootstrapMarkerCheck && check.state !== "passed"
            ? ["Self-referential deployment gate; this review must publish its terminal marker before the check can turn green"]
            : []),
          ...(check.detailsUrl ? [`Details: ${check.detailsUrl}`] : []),
        ].join("; "),
      } : {}),
    };
  });
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
    ? checks.map((check) => `${check.command}=${check.status}${check.summary ? ` (${check.summary})` : ""}`).join(", ")
    : "No required GitHub check runs were reported by the host.";
  const idPrefix = `deployment-review-${pullRequest.number}-${pullRequest.headSha.slice(0, 12)}`;
  const intent = createArtifact({
    kind: "Intent", runId: input.run.runId, subject, producer,
    payload: {
      title: pullRequest.title,
      problem: `Review the complete ${target} deployment pull request before promotion.`,
      desiredOutcome: `Confirm that PR #${pullRequest.number} is safe to promote from ${pullRequest.headBranch} to ${pullRequest.baseBranch}.`,
      constraints: [
        `Review exactly PR #${pullRequest.number} at head ${pullRequest.headSha}.`,
        "Do not merge or change the deployment pull request as part of review.",
        "The self-referential Forge gate-marker check may be pending or failed until this review publishes its terminal marker; preserve that observation, but do not treat it alone as a deployment defect.",
      ],
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
