// SPDX-License-Identifier: AGPL-3.0-or-later

import { createHash } from "node:crypto";
import { createArtifact, type DurableArtifact } from "../../core/artifacts/schema.js";
import { pullRequestMergeability, type ForgeHost, type PullRequestSnapshot } from "../../core/ports/forge-host.js";
import type { GitWorkspace, ReviewWorkspaceManager } from "../../core/ports/git-workspace.js";
import type {
  PromotionMode,
  PromotionPhase,
  PromotionPullRequestRecord,
  PromotionRecord,
  PromotionRepository,
  PromotionReviewRecord,
} from "../../core/ports/promotion.js";
import type { ArtifactRepository, RunRepository } from "../../core/ports/repositories.js";
import type { CheckResult } from "../../core/ports/verification.js";
import { attachArtifact, createRun, transition, type RunState } from "../../core/state/machine.js";
import type { AgentEventSink, AgentRuntime } from "../../runtime/agent-runtime.js";
import { reviewPullRequest } from "../review-pr/review.js";
import { parseDiffPaths } from "../review-pr/planner.js";
import type { VerificationCommand, VerificationRunner } from "../../core/ports/verification.js";

const BRANCH_NAME = /^[A-Za-z0-9._/-]+$/u;
const SHA = /^[0-9a-f]{7,64}$/i;

export interface PromotionReviewResult {
  run: RunState;
  verdict: DurableArtifact<"ReviewVerdict">;
}

export interface PromotionDependencies {
  host: ForgeHost;
  promotions: PromotionRepository;
  artifacts: ArtifactRepository;
  runs: RunRepository;
  workspaces: ReviewWorkspaceManager;
  verifier: VerificationRunner;
  runtime?: AgentRuntime;
  onAgentEvent?: AgentEventSink;
  /** Test seam; the default uses the normal independent review controller. */
  review?: (input: {
    record: PromotionRecord;
    pullRequest: PullRequestSnapshot;
    workspace: GitWorkspace;
    intent: DurableArtifact<"Intent">;
    investigation: DurableArtifact<"Investigation">;
    packet: DurableArtifact<"BuildPacket">;
    buildResult: DurableArtifact<"BuildResult">;
  }) => Promise<PromotionReviewResult>;
  maxReviewSpecialists?: number;
}

export interface PromotionInput {
  repository: string;
  mode: PromotionMode;
  sourceBranch?: string;
  targetBranch?: string;
  configuredPromotionTarget?: string;
  configuredProductionTarget?: string;
  cwd: string;
  verification: readonly Omit<VerificationCommand, "cwd">[];
  authorizeCreation?: boolean;
  authorizeMerge?: boolean;
  promotionId?: string;
  provider?: string;
  model?: string;
  signal?: AbortSignal;
  cancel?: boolean;
  cancellationReason?: string;
}

export class PromotionExecutionError extends Error {
  constructor(readonly record: PromotionRecord, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "PromotionExecutionError";
  }
}

/** Validate the immutable route before reading refs or allowing any mutation. */
export function validatePromotionRoute(input: {
  mode: PromotionMode;
  sourceBranch: string;
  targetBranch: string;
  configuredPromotionTarget: string | undefined;
  configuredProductionTarget: string | undefined;
}): void {
  assertBranch(input.sourceBranch, "promotion source branch");
  assertBranch(input.targetBranch, "promotion target branch");
  if (input.sourceBranch === input.targetBranch) throw new Error("Promotion source and target branches must differ");
  if (input.mode === "feature") {
    if (!/^(?:milestone|feature|release)\//u.test(input.sourceBranch)) {
      throw new Error(`Feature promotion source must be a milestone/feature branch, found ${input.sourceBranch}`);
    }
    if (!input.configuredPromotionTarget) throw new Error("Feature promotion requires configured featurePromotionTarget");
    if (input.targetBranch !== input.configuredPromotionTarget) {
      throw new Error(`Feature promotion target ${input.targetBranch} does not match configured promotion target ${input.configuredPromotionTarget}`);
    }
    return;
  }
  if (!input.configuredPromotionTarget) throw new Error("Production promotion requires configured featurePromotionTarget as its integration source");
  if (!input.configuredProductionTarget) throw new Error("Production promotion requires configured productionTarget");
  if (input.sourceBranch !== input.configuredPromotionTarget) {
    throw new Error(`Production promotion source ${input.sourceBranch} does not match configured integration target ${input.configuredPromotionTarget}`);
  }
  if (input.targetBranch !== input.configuredProductionTarget) {
    throw new Error(`Production promotion target ${input.targetBranch} does not match configured production target ${input.configuredProductionTarget}`);
  }
}

/** Execute or resume one explicit, SHA-frozen branch promotion. */
export async function promoteBranch(
  input: PromotionInput,
  dependencies: PromotionDependencies,
): Promise<PromotionRecord> {
  const sourceBranch = input.sourceBranch?.trim();
  const targetBranch = input.targetBranch?.trim();
  let record = input.promotionId
    ? await dependencies.promotions.loadPromotion(input.promotionId)
    : undefined;

  if (input.promotionId && !record) throw new Error(`Unknown promotion ${input.promotionId}`);
  if (!record && (!sourceBranch || !targetBranch)) {
    throw new Error("A fresh promotion requires source and target branches after route defaults are resolved");
  }
  if (record) {
    validatePromotionRoute({
      mode: record.mode,
      sourceBranch: record.sourceBranch,
      targetBranch: record.targetBranch,
      configuredPromotionTarget: input.configuredPromotionTarget,
      configuredProductionTarget: input.configuredProductionTarget,
    });
    if (sourceBranch !== undefined && sourceBranch !== record.sourceBranch) throw new Error("Promotion resume source branch does not match its frozen checkpoint");
    if (targetBranch !== undefined && targetBranch !== record.targetBranch) throw new Error("Promotion resume target branch does not match its frozen checkpoint");
  } else {
    validatePromotionRoute({
      mode: input.mode,
      sourceBranch: sourceBranch!,
      targetBranch: targetBranch!,
      configuredPromotionTarget: input.configuredPromotionTarget,
      configuredProductionTarget: input.configuredProductionTarget,
    });
    const promotionId = input.promotionId ?? deterministicPromotionId(input.repository, input.mode, sourceBranch!, targetBranch!);
    record = await dependencies.promotions.loadPromotion(promotionId);
    if (record) {
      validatePromotionRoute({
        mode: record.mode,
        sourceBranch: record.sourceBranch,
        targetBranch: record.targetBranch,
        configuredPromotionTarget: input.configuredPromotionTarget,
        configuredProductionTarget: input.configuredProductionTarget,
      });
    } else {
      const [sourceHeadSha, targetHeadSha] = await readRefs(dependencies.host, input.repository, sourceBranch!, targetBranch!);
      const now = new Date().toISOString();
      record = {
        schema: "forgedock.promotion/v1",
        promotionId,
        repository: input.repository,
        mode: input.mode,
        sourceBranch: sourceBranch!,
        targetBranch: targetBranch!,
        sourceHeadSha,
        targetHeadSha,
        authorized: input.authorizeCreation === true,
        mergeAuthorized: input.authorizeMerge === true,
        verificationCommands: input.verification.map((command) => ({
          id: command.id,
          command: command.command,
          args: [...command.args],
          timeoutMs: command.timeoutMs,
          required: command.required,
          ...(command.planId !== undefined ? { planId: command.planId } : {}),
          ...(command.coveredBy !== undefined ? { coveredBy: [...command.coveredBy] } : {}),
        })),
        ...(input.verification[0]?.planId !== undefined ? { verificationPlanId: input.verification[0].planId } : {}),
        restartCount: 0,
        phase: "planned",
        version: 0,
        createdAt: now,
        updatedAt: now,
      };
      await dependencies.promotions.createPromotion(record);
    }
  }
  if (!record) throw new Error("Promotion checkpoint could not be established");
  if (input.verification.length && record.verificationCommands) {
    assertFrozenVerificationPlan(record, input.verification);
  }

  if (record.phase === "completed") return record;
  if (record.phase === "cancelled") return record;
  if (input.cancel) {
    const reason = input.cancellationReason?.trim() || "Promotion cancelled by explicit user request";
    return advance(record, { phase: "cancelled", cancelledAt: new Date().toISOString(), cancellationReason: reason }, dependencies.promotions);
  }
  try {
    await assertFrozenRefs(record, dependencies.host);

    if (input.authorizeCreation && !record.authorized) {
      record = await advance(record, { authorized: true }, dependencies.promotions);
    }
    if (input.authorizeMerge && !record.mergeAuthorized) {
      record = await advance(record, { mergeAuthorized: true }, dependencies.promotions);
    }

    if (record.phase === "failed") {
      const resumePhase = record.resumePhase;
      if (!resumePhase) throw new Error(`Promotion ${record.promotionId} has no resumable checkpoint`);
      record = await resumeCheckpoint(record, resumePhase, dependencies.promotions);
    }
    if (!record.authorized) return record;

    if (record.phase === "planned") {
      record = await createOrReconcilePromotionPullRequest(record, dependencies);
    }
    if (record.phase === "pr-created" || record.phase === "verifying") {
      record = await advance(record, { phase: "verifying" }, dependencies.promotions);
      const verifyingRecord = record;
      const verification = (verifyingRecord.verificationCommands ?? []).map((command) => ({ ...command }));
      if (!verification.length) throw new Error(`Promotion ${verifyingRecord.promotionId} has no frozen verification plan`);
      if (verifyingRecord.verificationPlanId && verification.some((command) => command.planId !== undefined && command.planId !== verifyingRecord.verificationPlanId)) {
        throw new Error(`Promotion verification plan ${verifyingRecord.verificationPlanId} changed during resume`);
      }
      if (verifyingRecord.verificationPlanId && verification.length && verification.some((command) => command.planId === undefined)) {
        throw new Error(`Promotion verification plan ${verifyingRecord.verificationPlanId} cannot be resumed without its frozen plan identity`);
      }
      record = await verifyPromotion(verifyingRecord, verification, dependencies);
    }
    if (record.phase === "reviewing") {
      record = await reviewPromotion(record, input, dependencies);
    }
    if (record.phase === "awaiting-merge" && !record.mergeAuthorized) return record;
    if (record.phase === "awaiting-merge") {
      record = await mergePromotion(record, dependencies);
    }
    return record;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const failed = await failPromotion(record, resumePhaseFor(record.phase), reason, dependencies.promotions);
    throw new PromotionExecutionError(failed, reason, { cause: error });
  }
}

async function createOrReconcilePromotionPullRequest(
  record: PromotionRecord,
  dependencies: PromotionDependencies,
): Promise<PromotionRecord> {
  if (!dependencies.host.createPromotionPullRequest || !dependencies.host.findOpenPromotionPullRequest) {
    throw new Error("Promotion pull-request transport is unavailable; refusing branch mutation");
  }
  const marker = promotionMarker(record);
  let pullRequest = await dependencies.host.findOpenPromotionPullRequest(record.repository, record.sourceBranch, record.targetBranch);
  if (pullRequest && !pullRequest.body.includes(marker)) {
    throw new Error(`An open ${record.sourceBranch} → ${record.targetBranch} PR exists without ForgeDock promotion marker ${marker}`);
  }
  if (!pullRequest) {
    pullRequest = await dependencies.host.createPromotionPullRequest({
      repo: record.repository,
      headBranch: record.sourceBranch,
      baseBranch: record.targetBranch,
      title: `${record.mode === "production" ? "Promote" : "Ship"} ${record.sourceBranch} → ${record.targetBranch}`,
      body: renderPromotionBody(record, marker),
    });
  }
  assertPromotionPullRequest(record, pullRequest);
  const pullRequestRecord: PromotionPullRequestRecord = {
    number: pullRequest.number,
    url: pullRequest.url,
    headSha: pullRequest.headSha,
    baseBranch: pullRequest.baseBranch,
  };
  return advance(record, { phase: "pr-created", pullRequest: pullRequestRecord }, dependencies.promotions);
}

async function verifyPromotion(
  record: PromotionRecord,
  commands: readonly Omit<VerificationCommand, "cwd">[],
  dependencies: PromotionDependencies,
): Promise<PromotionRecord> {
  if (!record.pullRequest) throw new Error("Promotion verification requires a pull request checkpoint");
  if (!commands.length) throw new Error("Promotion requires at least one configured verification command");
  const pullRequest = await dependencies.host.getPullRequest(record.repository, record.pullRequest.number);
  assertPromotionPullRequest(record, pullRequest);
  const workspace = await dependencies.workspaces.createReview({
    runId: record.promotionId,
    pr: pullRequest.number,
    headSha: pullRequest.headSha,
  });
  try {
    const checks = await dependencies.verifier.run(commands.map((command) => ({ ...command, cwd: workspace.path })), undefined);
    if (!verificationPassed(commands, checks)) {
      throw new Error(`Promotion verification failed: ${checks.filter((check) => check.status !== "passed").map((check) => check.command).join(", ") || "missing evidence"}`);
    }
    return advance(record, { phase: "reviewing", verification: checks }, dependencies.promotions);
  } finally {
    await dependencies.workspaces.remove(workspace);
  }
}

async function reviewPromotion(
  record: PromotionRecord,
  input: PromotionInput,
  dependencies: PromotionDependencies,
): Promise<PromotionRecord> {
  if (!record.pullRequest) throw new Error("Promotion review requires a pull request checkpoint");
  if (!dependencies.runtime && !dependencies.review) throw new Error("Promotion review unavailable: no provider-backed review runtime is configured");
  const pullRequest = await dependencies.host.getPullRequest(record.repository, record.pullRequest.number);
  assertPromotionPullRequest(record, pullRequest);
  const workspace = await dependencies.workspaces.createReview({
    runId: `${record.promotionId}-review`,
    pr: pullRequest.number,
    headSha: pullRequest.headSha,
  });
  try {
    const paths = dependencies.host.getChangedPathsBetween
      ? [...await dependencies.host.getChangedPathsBetween(record.repository, record.targetHeadSha, pullRequest.headSha)]
      : parseDiffPaths(await dependencies.host.getPullRequestDiff(record.repository, pullRequest.number));
    const checks = record.verification ?? [];
    const artifacts = promotionArtifacts(record, pullRequest, paths, checks);
    for (const artifact of artifacts) await dependencies.artifacts.append(artifact);
    const [intent, investigation, packet, buildResult] = artifacts;
    const reviewed = dependencies.review
      ? await dependencies.review({ record, pullRequest, workspace, intent, investigation, packet, buildResult })
      : await defaultPromotionReview({
        record, pullRequest, workspace, intent, investigation, packet, buildResult,
        runtime: dependencies.runtime!, artifacts: dependencies.artifacts, runs: dependencies.runs, host: dependencies.host,
        ...(input.provider !== undefined ? { provider: input.provider } : {}),
        ...(input.model !== undefined ? { model: input.model } : {}),
        ...(input.signal !== undefined ? { signal: input.signal } : {}),
        ...(dependencies.onAgentEvent !== undefined ? { onAgentEvent: dependencies.onAgentEvent } : {}),
        ...(dependencies.maxReviewSpecialists !== undefined ? { maxReviewSpecialists: dependencies.maxReviewSpecialists } : {}),
      });
    const review: PromotionReviewRecord = {
      runId: reviewed.run.runId,
      verdictId: reviewed.verdict.id,
      disposition: reviewed.verdict.payload.disposition,
      headSha: reviewed.verdict.payload.headSha,
      baseBranch: reviewed.verdict.payload.baseBranch ?? record.targetBranch,
    };
    if (review.disposition !== "approve") {
      throw new Error(`Promotion review did not approve ${record.sourceBranch} → ${record.targetBranch}: ${review.disposition}`);
    }
    return advance(record, { phase: "awaiting-merge", review }, dependencies.promotions);
  } finally {
    await dependencies.workspaces.remove(workspace);
  }
}

async function defaultPromotionReview(input: {
  record: PromotionRecord;
  pullRequest: PullRequestSnapshot;
  workspace: GitWorkspace;
  intent: DurableArtifact<"Intent">;
  investigation: DurableArtifact<"Investigation">;
  packet: DurableArtifact<"BuildPacket">;
  buildResult: DurableArtifact<"BuildResult">;
  runtime: AgentRuntime;
  artifacts: ArtifactRepository;
  runs: RunRepository;
  host: ForgeHost;
  provider?: string;
  model?: string;
  signal?: AbortSignal;
  onAgentEvent?: AgentEventSink;
  maxReviewSpecialists?: number;
}): Promise<PromotionReviewResult> {
  const reviewRunId = `run_promotion_${input.record.promotionId}`;
  let run = await input.runs.load(reviewRunId);
  const existingVerdict = (await input.artifacts.list({ repo: input.record.repository, pr: input.pullRequest.number }, "ReviewVerdict"))
    .filter((artifact): artifact is DurableArtifact<"ReviewVerdict"> => artifact.runId === reviewRunId)
    .filter((artifact) => artifact.payload.headSha === input.pullRequest.headSha)
    .at(-1);
  if (existingVerdict && run?.state === "merging") return { run, verdict: existingVerdict };
  if (!run) {
    run = createRun({ workflow: "review-pr", subject: { repo: input.record.repository, pr: input.pullRequest.number }, runId: reviewRunId });
    run = { ...run, headSha: input.pullRequest.headSha };
    for (const artifact of [input.intent, input.investigation, input.packet, input.buildResult]) run = attachArtifact(run, artifact.kind, artifact.id);
    await input.runs.create(run);
  } else if (run.state !== "reviewing") {
    if (run.state !== "blocked" || !input.runs.commit) throw new Error(`Promotion review run is ${run.state}, not recoverable`);
    const resumed = transition(run, "RESUME_REVIEW", { reason: "Resuming durable promotion review checkpoint" });
    await input.runs.commit(run.version, resumed.state, resumed.record);
    run = resumed.state;
  }
  return reviewPullRequest({
    run,
    pullRequest: input.pullRequest,
    intent: input.intent,
    investigation: input.investigation,
    packet: input.packet,
    buildResult: input.buildResult,
    workspace: input.workspace.path,
    deliveryRunId: reviewRunId,
    ...(input.provider !== undefined ? { provider: input.provider } : {}),
    ...(input.model !== undefined ? { model: input.model } : {}),
    findingIssuePolicy: "all",
    ...(input.maxReviewSpecialists !== undefined ? { maxReviewSpecialists: input.maxReviewSpecialists } : {}),
    ...(input.signal !== undefined ? { signal: input.signal } : {}),
    ...(input.maxReviewSpecialists !== undefined ? { maxReviewSpecialists: input.maxReviewSpecialists } : {}),
  }, {
    runtime: input.runtime,
    host: input.host,
    artifacts: input.artifacts,
    runs: input.runs,
    ...(input.onAgentEvent ? { onAgentEvent: input.onAgentEvent } : {}),
  });
}

function promotionArtifacts(
  record: PromotionRecord,
  pullRequest: PullRequestSnapshot,
  paths: readonly string[],
  checks: readonly CheckResult[],
): [
  DurableArtifact<"Intent">,
  DurableArtifact<"Investigation">,
  DurableArtifact<"BuildPacket">,
  DurableArtifact<"BuildResult">,
] {
  const runId = `run_promotion_${record.promotionId}`;
  const subject = { repo: record.repository, pr: pullRequest.number };
  const artifactId = (kind: string) => `art_${record.promotionId}_${kind}`;
  const intent = createArtifact({
    kind: "Intent", runId, subject,
    producer: { role: "controller", runtime: "forgedock" },
    payload: {
      title: `${record.mode === "production" ? "Promote" : "Ship"} ${record.sourceBranch} to ${record.targetBranch}`,
      problem: `Review the complete ${record.sourceBranch} branch before promoting it into ${record.targetBranch}.`,
      desiredOutcome: `The exact reviewed source head is merged into ${record.targetBranch}.`,
      constraints: [`source head must remain ${record.sourceHeadSha}`, `target head must remain ${record.targetHeadSha}`],
      acceptanceHints: ["All configured promotion checks pass", "Independent review approves the exact PR head"],
      dependencies: [],
    },
  }, { id: artifactId("intent") });
  const investigation = createArtifact({
    kind: "Investigation", runId, subject,
    producer: { role: "controller", runtime: "forgedock" },
    payload: {
      outcome: "confirmed", confidence: "high",
      summary: `Controller observed ${record.sourceBranch}@${record.sourceHeadSha} and ${record.targetBranch}@${record.targetHeadSha} for explicit ${record.mode} promotion.`,
      evidence: [
        { claim: "source ref is frozen", source: "GitHub branch ref", detail: record.sourceHeadSha },
        { claim: "target ref is frozen", source: "GitHub branch ref", detail: record.targetHeadSha },
      ],
      affectedSurfaces: [...paths], risks: ["Promotion crosses a protected delivery boundary."],
      recommendation: "Review and merge only the exact SHA-anchored promotion pull request.",
    },
  }, { id: artifactId("investigation") });
  const packet = createArtifact({
    kind: "BuildPacket", runId, subject,
    producer: { role: "controller", runtime: "forgedock" },
    payload: {
      scope: paths.length ? [...paths] : ["promotion-diff"],
      acceptanceCriteria: [
        "The source branch is promoted only to its configured integration or production target.",
        "The exact source head passes every configured promotion check and independent review.",
      ],
      context: [
        { source: "promotion route", relevance: `${record.sourceBranch} → ${record.targetBranch}` },
        { source: "frozen refs", relevance: `${record.sourceHeadSha} against ${record.targetHeadSha}` },
      ],
      implementationPlan: ["Review the complete branch diff", "Run the frozen promotion verification plan", "Merge only after explicit authorization"],
      expectedPaths: [...paths],
      verificationPlan: checks.map((check) => check.command).length ? checks.map((check) => check.command) : ["controller-gate:promotion-review"],
      controllerGates: [{ id: "merge-closure", description: "Controller re-reads source, PR, and target authority before merge." }],
      risks: [{ risk: "Protected target drift", mitigation: "Reject source, target, PR, or reviewed-SHA drift." }],
      outOfScope: ["Issue delivery workflows", "Implicit production promotion"],
    },
  }, { id: artifactId("packet") });
  const buildResult = createArtifact({
    kind: "BuildResult", runId, subject,
    producer: { role: "controller", runtime: "forgedock" },
    payload: {
      branch: record.sourceBranch,
      targetBranch: record.targetBranch,
      promotionTarget: record.targetBranch,
      headSha: pullRequest.headSha,
      baseSha: record.targetHeadSha,
      changedPaths: [...paths],
      summary: `Controller-verified promotion candidate ${record.sourceBranch} → ${record.targetBranch}.`,
      acceptanceEvidence: [
        { criterion: "The source branch is promoted only to its configured integration or production target.", status: "passed", evidence: `${record.sourceBranch} → ${record.targetBranch}` },
        { criterion: "The exact source head passes every configured promotion check and independent review.", status: "passed", evidence: checks.map((check) => `${check.command}: ${check.status}`).join("; ") || "Review gate pending" },
      ],
      checks: [...checks], decisions: ["Promotion route frozen by controller."], residualRisks: [],
    },
  }, { id: artifactId("build") });
  return [intent, investigation, packet, buildResult];
}

async function mergePromotion(record: PromotionRecord, dependencies: PromotionDependencies): Promise<PromotionRecord> {
  if (!record.pullRequest || !record.review) throw new Error("Promotion merge requires PR and approving review checkpoints");
  if (record.review.disposition !== "approve") throw new Error("Promotion merge requires an approving review");
  const [sourceHead, targetHead] = await readRefs(dependencies.host, record.repository, record.sourceBranch, record.targetBranch);
  if (sourceHead !== record.sourceHeadSha || targetHead !== record.targetHeadSha) {
    throw new Error(`Promotion refs changed after review: expected ${record.sourceBranch}@${record.sourceHeadSha} and ${record.targetBranch}@${record.targetHeadSha}, found ${sourceHead} and ${targetHead}`);
  }
  const pullRequest = await dependencies.host.getPullRequest(record.repository, record.pullRequest.number);
  assertPromotionPullRequest(record, pullRequest);
  if (pullRequest.headSha !== record.review.headSha || pullRequest.headSha !== record.sourceHeadSha) {
    throw new Error(`Promotion reviewed SHA ${record.review.headSha} is stale; current PR/source head is ${pullRequest.headSha}/${sourceHead}`);
  }
  if (pullRequest.baseBranch !== record.review.baseBranch) throw new Error("Promotion reviewed target changed before merge");
  // Protection is a promotion-completion gate, not a PR-publication gate. Check
  // it even when the host reports an externally merged PR so ForgeDock never
  // records an unprotected production promotion as successfully completed.
  await assertProductionProtection(record.mode, record.repository, record.targetBranch, dependencies.host);
  if (pullRequest.state !== "MERGED") {
    if (!dependencies.host.getPullRequestMergeGate) throw new Error("Promotion merge requires authoritative GitHub merge-admission support");
    const gate = await dependencies.host.getPullRequestMergeGate(
      record.repository,
      pullRequest.number,
      record.review.headSha,
      record.targetBranch,
      { refreshUnknown: true },
    );
    const mergeability = pullRequestMergeability(gate);
    const failedChecks = gate.requiredChecks.filter((check) => check.state !== "passed");
    if (mergeability !== "mergeable" || failedChecks.length) {
      const blockers = [
        ...(mergeability !== "mergeable" ? [`mergeability=${mergeability}${gate.mergeabilityReason ? ` (${gate.mergeabilityReason})` : ""}`] : []),
        ...failedChecks.map((check) => `${check.name}=${check.state}`),
      ];
      throw new Error(`Promotion merge admission is blocked for PR #${pullRequest.number}: ${blockers.join(", ")}`);
    }
    await dependencies.host.mergePullRequest(record.repository, pullRequest.number, record.review.headSha, record.targetBranch);
  }
  const merged = await dependencies.host.getPullRequest(record.repository, pullRequest.number);
  if (merged.state !== "MERGED") throw new Error("Promotion merge command completed but the pull request is not merged");
  return advance(record, { phase: "completed", pullRequest: { ...record.pullRequest, headSha: merged.headSha, baseBranch: merged.baseBranch } }, dependencies.promotions);
}

async function assertFrozenRefs(record: PromotionRecord, host: ForgeHost): Promise<void> {
  const [sourceHead, targetHead] = await readRefs(host, record.repository, record.sourceBranch, record.targetBranch);
  if (sourceHead !== record.sourceHeadSha || targetHead !== record.targetHeadSha) {
    throw new Error(`Promotion checkpoint refs changed: expected ${record.sourceBranch}@${record.sourceHeadSha} and ${record.targetBranch}@${record.targetHeadSha}, found ${sourceHead} and ${targetHead}`);
  }
}

async function readRefs(host: ForgeHost, repository: string, sourceBranch: string, targetBranch: string): Promise<[string, string]> {
  if (!host.getBranchHead) throw new Error("Promotion requires authoritative branch-head support");
  const [sourceHead, targetHead] = await Promise.all([
    host.getBranchHead(repository, sourceBranch),
    host.getBranchHead(repository, targetBranch),
  ]);
  if (!SHA.test(sourceHead) || !SHA.test(targetHead)) throw new Error("Promotion branch refs did not return valid SHAs");
  return [sourceHead, targetHead];
}

async function assertProductionProtection(mode: PromotionMode, repository: string, targetBranch: string, host: ForgeHost): Promise<void> {
  if (mode !== "production") return;
  if (!host.isBranchProtected) throw new Error(`Production promotion target ${targetBranch} has no typed branch-protection check`);
  if (!await host.isBranchProtected(repository, targetBranch)) {
    throw new Error(`Production promotion target ${targetBranch} is not protected; refusing fail-open promotion`);
  }
}

function assertPromotionPullRequest(record: PromotionRecord, pullRequest: PullRequestSnapshot): void {
  if (pullRequest.repo.toLowerCase() !== record.repository.toLowerCase()) throw new Error("Promotion pull request repository changed");
  if (pullRequest.headBranch !== record.sourceBranch) throw new Error(`Promotion PR source changed: expected ${record.sourceBranch}, found ${pullRequest.headBranch}`);
  if (pullRequest.baseBranch !== record.targetBranch) throw new Error(`Promotion PR target changed: expected ${record.targetBranch}, found ${pullRequest.baseBranch}`);
  if (pullRequest.headSha !== record.sourceHeadSha) throw new Error(`Promotion PR head ${pullRequest.headSha} does not match frozen source ${record.sourceHeadSha}`);
}

function assertFrozenVerificationPlan(
  record: PromotionRecord,
  commands: readonly Omit<VerificationCommand, "cwd">[],
): void {
  const frozen = record.verificationCommands ?? [];
  const normalize = (items: readonly Omit<VerificationCommand, "cwd">[]) => items.map((command) => ({
    id: command.id,
    command: command.command,
    args: [...command.args],
    timeoutMs: command.timeoutMs,
    required: command.required,
    ...(command.planId !== undefined ? { planId: command.planId } : {}),
    ...(command.coveredBy !== undefined ? { coveredBy: [...command.coveredBy] } : {}),
  }));
  if (JSON.stringify(normalize(commands)) !== JSON.stringify(frozen)) {
    throw new Error(`Promotion ${record.promotionId} verification plan changed after its durable checkpoint was created`);
  }
}

function verificationPassed(commands: readonly Omit<VerificationCommand, "cwd">[], checks: readonly CheckResult[]): boolean {
  if (checks.length < commands.length) return false;
  return commands.every((command) => checks.some((check) => (
    check.command === renderVerificationCommand(command)
      || (command.args.length === 0 && check.command === command.command)
  ) && check.status === "passed"))
    && checks.every((check) => check.status === "passed");
}

function renderVerificationCommand(command: Pick<VerificationCommand, "command" | "args">): string {
  return [command.command, ...command.args].join(" ");
}

async function advance(
  record: PromotionRecord,
  patch: Partial<PromotionRecord>,
  repository: PromotionRepository,
): Promise<PromotionRecord> {
  const next: PromotionRecord = {
    ...record,
    ...patch,
    version: record.version + 1,
    updatedAt: new Date().toISOString(),
  };
  await repository.savePromotion(record.version, next);
  return next;
}

async function resumeCheckpoint(
  record: PromotionRecord,
  phase: Exclude<PromotionPhase, "completed" | "failed" | "cancelled">,
  repository: PromotionRepository,
): Promise<PromotionRecord> {
  const next: PromotionRecord = {
    ...record,
    phase,
    restartCount: (record.restartCount ?? 0) + 1,
    lastRestartAt: new Date().toISOString(),
    version: record.version + 1,
    updatedAt: new Date().toISOString(),
  };
  delete next.failure;
  delete next.resumePhase;
  await repository.savePromotion(record.version, next);
  return next;
}

async function failPromotion(
  record: PromotionRecord,
  resumePhase: Exclude<PromotionPhase, "completed" | "failed" | "cancelled">,
  reason: string,
  repository: PromotionRepository,
): Promise<PromotionRecord> {
  if (record.phase === "completed" || record.phase === "failed") return record;
  try {
    return await advance(record, { phase: "failed", resumePhase, failure: reason }, repository);
  } catch {
    return { ...record, phase: "failed", resumePhase, failure: reason };
  }
}

function resumePhaseFor(phase: PromotionPhase): Exclude<PromotionPhase, "completed" | "failed" | "cancelled"> {
  if (phase === "planned" || phase === "pr-created" || phase === "verifying" || phase === "reviewing" || phase === "awaiting-merge") return phase;
  return "planned";
}

function deterministicPromotionId(repository: string, mode: PromotionMode, sourceBranch: string, targetBranch: string): string {
  const digest = createHash("sha256").update(`${repository.toLowerCase()}\0${mode}\0${sourceBranch}\0${targetBranch}`).digest("hex").slice(0, 24);
  return `promotion_${digest}`;
}

function promotionMarker(record: Pick<PromotionRecord, "repository" | "sourceBranch" | "targetBranch">): string {
  return `<!-- FORGEDOCK:PROMOTION repo=${record.repository.toLowerCase()} from=${record.sourceBranch} to=${record.targetBranch} -->`;
}

function renderPromotionBody(record: PromotionRecord, marker: string): string {
  return [
    "## ForgeDock explicit branch promotion",
    "",
    `- **Mode:** ${record.mode}`,
    `- **Source:** \`${record.sourceBranch}\` at \`${record.sourceHeadSha}\``,
    `- **Target:** \`${record.targetBranch}\` at \`${record.targetHeadSha}\``,
    "",
    "This PR is a separately authorized promotion. It is not an issue-delivery PR and must pass the controller's verification and independent review gates.",
    "",
    marker,
  ].join("\n");
}

function assertBranch(branch: string, label: string): void {
  if (!branch || !BRANCH_NAME.test(branch) || branch.startsWith("/") || branch.endsWith("/") || branch.includes("..") || branch.includes("//")) {
    throw new Error(`Invalid ${label}: '${branch}'`);
  }
}
