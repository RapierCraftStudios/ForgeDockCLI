// SPDX-License-Identifier: AGPL-3.0-or-later

import { createArtifact, type DurableArtifact } from "../../core/artifacts/schema.js";
import type { EffectiveReviewCiConfig } from "../../core/config/forgedock-config.js";
import type { ForgeHost, PullRequestMergeGate, PullRequestSnapshot } from "../../core/ports/forge-host.js";
import type { ReviewWorkspaceManager } from "../../core/ports/git-workspace.js";
import type { ArtifactRepository, RunRepository } from "../../core/ports/repositories.js";
import { attachArtifact, createRun, transition } from "../../core/state/machine.js";
import type { AgentEventSink, AgentRuntime } from "../../runtime/agent-runtime.js";
import { parseDeploymentDiffPaths } from "./planner.js";
import { reviewPullRequest, type ReviewChecks } from "./review.js";
import { WorkflowExecutionError } from "../work-on/investigate.js";
import { assessPullRequestCi, assertPullRequestCiReady, type PullRequestCiAssessment } from "./ci-policy.js";
interface StandaloneReviewCiInput { policy: EffectiveReviewCiConfig; featurePromotionTarget?: string; productionTarget?: string; }

export async function reviewExistingPullRequest(
  input: { repo: string; pr: number; issue?: number; provider?: string; model?: string; maxReviewSpecialists?: number; signal?: AbortSignal; ci?: StandaloneReviewCiInput },
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
  await assertInitialPullRequestCi(pullRequest, input.ci, dependencies.host);
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
    const result = await reviewPullRequest({
      run, pullRequest, intent, investigation, packet, buildResult, workspace: workspace.path,
      deliveryRunId: buildResult.runId,
      ...(input.provider !== undefined ? { provider: input.provider } : {}),
      ...(input.model !== undefined ? { model: input.model } : {}),
      ...(input.maxReviewSpecialists !== undefined ? { maxReviewSpecialists: input.maxReviewSpecialists } : {}),
      ...(input.ci !== undefined ? { beforeVerdictPublication: () => assertFinalPullRequestCi(pullRequest, input.ci, dependencies.host) } : {}),
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
    }, {
      runtime: dependencies.runtime, host: dependencies.host, artifacts: dependencies.artifacts, runs: dependencies.runs,
      ...(dependencies.onAgentEvent !== undefined ? { onAgentEvent: dependencies.onAgentEvent } : {}),
    });
    return result;
  } finally {
    await dependencies.workspaces.remove(workspace);
  }
}

async function reviewDeploymentPullRequest(
  input: {
    input: { repo: string; pr: number; provider?: string; model?: string; maxReviewSpecialists?: number; signal?: AbortSignal; ci?: StandaloneReviewCiInput };
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
  if (input.pullRequest.state !== "OPEN") {
    throw new Error(`Cannot start deployment review: PR #${input.pullRequest.number} must be OPEN at freeze, found ${input.pullRequest.state}`);
  }
  // The initial snapshot is routing evidence only. Re-read immediately before
  // reviewer setup and bind every review artifact to the actual current head.
  const frozen = await dependencies.host.getPullRequest(input.input.repo, input.input.pr);
  assertRequestedPullRequestIdentity(input.input.repo, input.input.pr, frozen, "pre-review read");
  if (!isDeploymentPullRequest(frozen)) {
    throw new Error(`Cannot start deployment review: PR #${frozen.number} no longer routes staging to main`);
  }
  if (frozen.state !== "OPEN") {
    throw new Error(`Cannot start deployment review: PR #${frozen.number} must be OPEN at freeze, found ${frozen.state}`);
  }
  // Read the deployment diff exactly once and carry that frozen snapshot
  // through artifact construction and the core review boundary.
  const diff = await dependencies.host.getPullRequestDiff(frozen.repo, frozen.number);
  const mergeGate = await readDeploymentMergeGate(frozen, dependencies.host);
  if (input.input.ci) assertInitialAssessment(assessmentFor(frozen, mergeGate, input.input.ci), input.input.ci.policy.failureAction); else assertDeploymentMergeGate(mergeGate);
  const checks = toReviewChecks(mergeGate);
  let run = createRun({ workflow: "review-pr", subject: { repo: frozen.repo, pr: frozen.number } });
  run = { ...run, headSha: frozen.headSha };
  // Create the run and workspace before strict parsing so an inventory failure
  // has durable failure state and the caller's allocated workspace is cleaned.
  await dependencies.runs.create(run);
  const workspace = await dependencies.workspaces.createReview({ runId: run.runId, pr: frozen.number, headSha: frozen.headSha });
  const result = await (async () => {
    try {
      let changedPaths: readonly string[];
      try {
        changedPaths = parseDeploymentDiffPaths(diff);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        const failed = transition(run, "FAIL", { reason });
        await dependencies.runs.commit(run.version, failed.state, failed.record);
        throw new WorkflowExecutionError(reason, failed.state, { cause: error });
      }
      const context = createDeploymentReviewArtifacts({ run, pullRequest: frozen, changedPaths, checks });
      // Deployment reviews have no single delivery issue, so their Intent,
      // Investigation, and Build Packet are deterministic reviewer context rather
      // than workflow artifacts. Keep them in the isolated reviewer input; do not
      // project work-on lifecycle comments onto the deployment pull request.
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
          diff,
        },
        workspace: workspace.path,
        ...(input.input.provider !== undefined ? { provider: input.input.provider } : {}),
        ...(input.input.model !== undefined ? { model: input.input.model } : {}),
        // Deployment diffs are often repository-wide. Pack specialist
        // capabilities into one independent group by default so the provider
        // is not asked to process several near-identical giant contexts at once.
        maxReviewSpecialists: input.input.maxReviewSpecialists ?? 1,
        beforeVerdictPublication: () => assertFinalDeploymentPullRequestCi(frozen, input.input.ci, dependencies.host),
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
  return result;
}
async function assertInitialPullRequestCi(pr: PullRequestSnapshot, ci: StandaloneReviewCiInput | undefined, host: ForgeHost): Promise<void> { if (ci) assertInitialAssessment(await readPullRequestCi(pr, ci, host), ci.policy.failureAction); }
function assertInitialAssessment(a: PullRequestCiAssessment, action: EffectiveReviewCiConfig["failureAction"]): void { if (!a.mergeable || a.failed.length) assertPullRequestCiReady(a, action, "before"); }
async function assertFinalPullRequestCi(pr: PullRequestSnapshot, ci: StandaloneReviewCiInput | undefined, host: ForgeHost): Promise<void> { if (!ci) return; const current = await host.getPullRequest(pr.repo, pr.number); assertPullRequestHeadStable(pr, current); assertPullRequestCiReady(await readPullRequestCi(current, ci, host), ci.policy.failureAction, "after"); }
async function readPullRequestCi(pr: PullRequestSnapshot, ci: StandaloneReviewCiInput, host: ForgeHost): Promise<PullRequestCiAssessment> { if (!host.getPullRequestMergeGate) throw new Error("Standalone review CI policy requires an authoritative merge-gate adapter"); const gate = await host.getPullRequestMergeGate(pr.repo, pr.number, pr.headSha, pr.baseBranch); assertDeploymentMergeGateAuthority(gate, pr); return assessmentFor(pr, gate, ci); }
async function readDeploymentMergeGate(pr: PullRequestSnapshot, host: ForgeHost): Promise<PullRequestMergeGate> { if (!host.getPullRequestMergeGate) throw new Error("Deployment review requires an authoritative merge-gate adapter"); const gate = await host.getPullRequestMergeGate(pr.repo, pr.number, pr.headSha, pr.baseBranch); assertDeploymentMergeGateAuthority(gate, pr); return gate; }
async function assertFinalDeploymentPullRequestCi(pr: PullRequestSnapshot, ci: StandaloneReviewCiInput | undefined, host: ForgeHost): Promise<void> { const current = await host.getPullRequest(pr.repo, pr.number); assertPullRequestHeadStable(pr, current); const gate = await readDeploymentMergeGate(current, host); if (ci) assertPullRequestCiReady(assessmentFor(current, gate, ci), ci.policy.failureAction, "after"); else assertDeploymentMergeGate(gate); }
function assessmentFor(pr: PullRequestSnapshot, gate: PullRequestMergeGate, ci: StandaloneReviewCiInput): PullRequestCiAssessment { return assessPullRequestCi(pr, gate, ci.policy, { ...(ci.featurePromotionTarget ? { featurePromotionTarget: ci.featurePromotionTarget } : {}), ...(ci.productionTarget ? { productionTarget: ci.productionTarget } : {}) }); }

function isDeploymentPullRequest(
  pullRequest: Pick<PullRequestSnapshot, "headBranch" | "baseBranch">,
): boolean {
  return pullRequest.headBranch === "staging" && pullRequest.baseBranch === "main";
}

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
  const blocked = gate.requiredChecks.filter((check) => check.state !== "passed");
  if (blocked.length) {
    throw new Error(`Deployment PR checks are not green: ${blocked.map((check) => `${check.name}=${check.state}`).join(", ")}`);
  }
}

function assertPullRequestHeadStable(frozen: PullRequestSnapshot, current: PullRequestSnapshot): void {
  if (!samePullRequestIdentity(frozen, current)
    || current.headSha.toLowerCase() !== frozen.headSha.toLowerCase()
    || current.headBranch !== frozen.headBranch
    || current.baseBranch !== frozen.baseBranch
    || current.state !== "OPEN") {
    throw new Error(
      `Pull request route changed before review completion: ${frozen.repo}#${frozen.number} ${frozen.headBranch}@${frozen.headSha} -> ${frozen.baseBranch} (OPEN)`
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
  return (gate?.requiredChecks ?? []).map((check) => ({
    command: `GitHub required check: ${check.name}`,
    // CheckResult has no pending/cancelled/unavailable state. Preserve the
    // exact GitHub state in summary and fail closed instead of claiming that
    // an observed non-green check was intentionally skipped.
    status: check.state === "passed" ? "passed" : "failed",
    durationMs: 0,
    ...(check.state !== "passed" ? {
      failureClass: check.state === "failed" ? "command" as const : "infrastructure" as const,
      failureSignatures: [`github-required-check:${check.state}`],
    } : {}),
    ...(check.detailsUrl || check.state !== "passed" ? {
      summary: [
        `GitHub state: ${check.state}`,
        ...(check.detailsUrl ? [`Details: ${check.detailsUrl}`] : []),
      ].join("; "),
    } : {}),
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
