// SPDX-License-Identifier: AGPL-3.0-or-later

import { createHash } from "node:crypto";
import { createArtifact, type DurableArtifact } from "../../core/artifacts/schema.js";
import { pullRequestMergeability, type ForgeHost, type PullRequestMergeGate, type PullRequestSnapshot } from "../../core/ports/forge-host.js";
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
import { resolveReviewCiConfig, type EffectiveReviewCiConfig } from "../../core/config/forgedock-config.js";
import { assessMergeAdmission, formatPullRequestCiBlock, requiredChecksMode } from "../review-pr/ci-policy.js";
import { attachArtifact, createRun, transition, type RunState } from "../../core/state/machine.js";
import type { AgentEventSink, AgentRuntime } from "../../runtime/agent-runtime.js";
import { reviewPullRequest } from "../review-pr/review.js";
import { parseDiffPaths } from "../review-pr/planner.js";
import type { VerificationCommand, VerificationRunner } from "../../core/ports/verification.js";
import {
  abortablePollDelay,
  controllerPollDelay,
  controllerPollInterval,
  pollingAbortError,
  throwIfPollingAborted,
} from "../review-pr/polling.js";

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

export interface PromotionMergeGatePollProgress {
  attempt: number;
  reason: "required-checks-pending" | "mergeability-unknown";
  gate: PullRequestMergeGate;
  nextPollInMs: number;
}

export interface PromotionInput {
  repository: string;
  mode: PromotionMode;
  sourceBranch?: string;
  targetBranch?: string;
  configuredPromotionTarget?: string;
  configuredProductionTarget?: string;
  ciPolicy?: EffectiveReviewCiConfig;
  cwd: string;
  verification: readonly Omit<VerificationCommand, "cwd">[];
  authorizeCreation?: boolean;
  authorizeMerge?: boolean;
  promotionId?: string;
  provider?: string;
  model?: string;
  signal?: AbortSignal;
  /** Poll cadence is bounded; authoritative pending CI is polled without an attempt cap. */
  mergeGatePollIntervalMs?: number;
  onMergeGatePoll?: (progress: PromotionMergeGatePollProgress) => void | Promise<void>;
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

  if (record.phase === "completed" || record.phase === "blocked") return record;
  if (record.phase === "cancelled") return record;
  if (input.cancel) {
    const reason = input.cancellationReason?.trim() || "Promotion cancelled by explicit user request";
    return advance(record, { phase: "cancelled", cancelledAt: new Date().toISOString(), cancellationReason: reason }, dependencies.promotions);
  }
  try {
    const recovered = await recoverMergedPromotion(record, dependencies, input.ciPolicy ?? resolveReviewCiConfig());
    if (recovered) return recovered;
    throwIfPollingAborted(input.signal, "Promotion merge-gate polling aborted");
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
      record = await mergePromotion(record, input, dependencies);
    }
    return record;
  } catch (error) {
    if (input.signal?.aborted || (error instanceof Error && error.name === "AbortError")) {
      const reason = cancellationReason(error, input.signal);
      return advance(record, {
        phase: "cancelled",
        cancelledAt: new Date().toISOString(),
        cancellationReason: reason,
      }, dependencies.promotions);
    }
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

type PromotionMergeObservation =
  | { status: "ready"; pullRequest: PullRequestSnapshot; gate: PullRequestMergeGate }
  | { status: "pending"; pullRequest: PullRequestSnapshot; gate: PullRequestMergeGate; reason: PromotionMergeGatePollProgress["reason"] }
  | { status: "blocked"; pullRequest: PullRequestSnapshot; gate: PullRequestMergeGate; reason: string }
  | { status: "merged"; pullRequest: PullRequestSnapshot; gate: PullRequestMergeGate };

async function mergePromotion(
  record: PromotionRecord,
  input: PromotionInput,
  dependencies: PromotionDependencies,
): Promise<PromotionRecord> {
  assertPromotionReviewCheckpoint(record);
  const pollIntervalMs = controllerPollInterval(input.mergeGatePollIntervalMs);
  let attempt = 0;
  while (true) {
    const observation = await observePromotionMergeGate(record, dependencies.host, input.signal, input.ciPolicy ?? resolveReviewCiConfig());
    if (observation.status === "merged") return completeMergedPromotion(record, observation.pullRequest, dependencies);
    if (observation.status === "blocked") {
      return blockPromotion(record, observation.reason, dependencies.promotions);
    }
    if (observation.status === "pending") {
      attempt += 1;
      await pollPromotionMergeGate(input, observation.gate, observation.reason, attempt, pollIntervalMs);
      continue;
    }

    throwIfPollingAborted(input.signal, "Promotion merge-gate polling aborted");
    await assertProductionProtection(record.mode, record.repository, record.targetBranch, dependencies.host);
    await assertPromotionMutationBoundary(record, dependencies.host);
    try {
      await dependencies.host.mergePullRequest(
        record.repository,
        record.pullRequest!.number,
        record.review!.headSha,
        record.targetBranch,
        { requiredChecksMode: requiredChecksMode(input.ciPolicy ?? resolveReviewCiConfig(), record.targetBranch) },
      );
    } catch (error) {
      // A transport can report failure after GitHub accepted the merge. Re-read
      // the exact PR first so crash/error recovery never mistakes target drift
      // caused by this PR's merge for stale authority.
      const afterCommand = await readExactPromotionPullRequest(record, dependencies.host);
      if (afterCommand.state === "MERGED") return completeMergedPromotion(record, afterCommand, dependencies);

      // Never classify a merge-command error from its text. Only a fresh typed
      // gate may turn it into pending/unknown or a terminal authority blocker.
      const afterFailure = await observePromotionMergeGate(record, dependencies.host, input.signal, input.ciPolicy ?? resolveReviewCiConfig());
      if (afterFailure.status === "merged") return completeMergedPromotion(record, afterFailure.pullRequest, dependencies);
      if (afterFailure.status === "blocked") {
        if (promotionMergeGateAuthorityUnavailable(afterFailure.gate)) throw error;
        return blockPromotion(record, afterFailure.reason, dependencies.promotions);
      }
      if (afterFailure.status === "pending") {
        attempt += 1;
        await pollPromotionMergeGate(input, afterFailure.gate, afterFailure.reason, attempt, pollIntervalMs);
        continue;
      }
      // The authoritative gate still admits the merge, so this was not a typed
      // conflict/check transition. Preserve transport/authentication failure.
      throw error;
    }

    const merged = await readExactPromotionPullRequest(record, dependencies.host);
    if (merged.state !== "MERGED") throw new Error("Promotion merge command completed but the pull request is not merged");
    return completeMergedPromotion(record, merged, dependencies);
  }
}

async function observePromotionMergeGate(
  record: PromotionRecord,
  host: ForgeHost,
  signal?: AbortSignal,
  policy?: EffectiveReviewCiConfig,
): Promise<PromotionMergeObservation> {
  throwIfPollingAborted(signal, "Promotion merge-gate polling aborted");
  const pullRequest = await readExactPromotionPullRequest(record, host);
  if (pullRequest.state !== "OPEN" && pullRequest.state !== "MERGED") {
    throw new Error(`Promotion pull request #${pullRequest.number} is ${pullRequest.state}, expected OPEN or MERGED`);
  }
  if (pullRequest.state !== "MERGED") await assertFrozenRefs(record, host);
  if (!host.getPullRequestMergeGate) throw new Error("Promotion merge requires authoritative GitHub merge-admission support");
  const effectivePolicy = policy ?? resolveReviewCiConfig();
  const gate = await host.getPullRequestMergeGate(
    record.repository,
    pullRequest.number,
    record.review!.headSha,
    record.targetBranch,
  );
  assertPromotionMergeGateIdentity(record, gate);

  // Bind every gate observation to a fresh exact PR/ref observation. This also
  // prevents a pending check result for one head from being stamped onto a
  // later incarnation of the same branch name.
  const revalidated = await readExactPromotionPullRequest(record, host);
  if (revalidated.state === "MERGED") {
    const mergedAssessment = assessMergeAdmission(revalidated, gate, effectivePolicy);
    if (!mergedAssessment.ready) {
      return { status: "blocked", pullRequest: revalidated, gate, reason: `Promotion merge admission is blocked: ${formatPullRequestCiBlock(mergedAssessment, effectivePolicy.failureAction, "after")}` };
    }
    return { status: "merged", pullRequest: revalidated, gate };
  }
  if (revalidated.state !== "OPEN") {
    throw new Error(`Promotion pull request #${revalidated.number} changed state while reading merge admission: ${revalidated.state}`);
  }
  await assertFrozenRefs(record, host);

  const terminalReason = promotionMergeGateBlocker(gate, revalidated, effectivePolicy);
  if (terminalReason) return { status: "blocked", pullRequest: revalidated, gate, reason: terminalReason };
  const transientReason = promotionMergeGatePendingReason(gate);
  if (transientReason) return { status: "pending", pullRequest: revalidated, gate, reason: transientReason };
  return { status: "ready", pullRequest: revalidated, gate };
}

async function pollPromotionMergeGate(
  input: PromotionInput,
  gate: PullRequestMergeGate,
  reason: PromotionMergeGatePollProgress["reason"],
  attempt: number,
  baseIntervalMs: number,
): Promise<void> {
  const nextPollInMs = controllerPollDelay(baseIntervalMs, attempt);
  await input.onMergeGatePoll?.({ attempt, reason, gate, nextPollInMs });
  await abortablePollDelay(
    nextPollInMs,
    input.signal,
    (signal) => pollingAbortError(signal, "Promotion merge-gate polling aborted"),
  );
}

function promotionMergeGateBlocker(gate: PullRequestMergeGate, pullRequest: PullRequestSnapshot, policy: EffectiveReviewCiConfig): string | undefined {
  const assessment = assessMergeAdmission(pullRequest, gate, policy);
  if (assessment.pending.length || pullRequestMergeability(gate) === "unknown") return undefined;
  return assessment.ready ? undefined : `Promotion merge admission is blocked: ${formatPullRequestCiBlock(assessment, policy.failureAction, "after")}`;
}

function promotionMergeGateAuthorityUnavailable(gate: PullRequestMergeGate): boolean {
  return gate.requiredChecksProvenance !== "github-required"
    || gate.requiredChecksHeadSha?.toLowerCase() !== gate.headSha.toLowerCase()
    || gate.requiredChecks.some((check) => check.state === "unavailable")
    || pullRequestMergeability(gate) === "unavailable";
}

function promotionMergeGatePendingReason(gate: PullRequestMergeGate): PromotionMergeGatePollProgress["reason"] | undefined {
  if (gate.requiredChecks.some((check) => check.state === "pending")) return "required-checks-pending";
  if (pullRequestMergeability(gate) === "unknown") return "mergeability-unknown";
  return undefined;
}

function assertPromotionMergeGateIdentity(record: PromotionRecord, gate: PullRequestMergeGate): void {
  if (!record.pullRequest || !record.review) throw new Error("Promotion merge gate requires PR and review checkpoints");
  if (gate.repo.toLowerCase() !== record.repository.toLowerCase() || gate.pullRequest !== record.pullRequest.number) {
    throw new Error(`Promotion merge admission identified ${gate.repo}#${gate.pullRequest}, expected ${record.repository}#${record.pullRequest.number}`);
  }
  if (gate.headSha !== record.review.headSha || gate.headSha !== record.sourceHeadSha) {
    throw new Error(`Promotion merge admission is stale: reviewed ${record.review.headSha}, gate observed ${gate.headSha}`);
  }
  if (gate.baseBranch !== record.targetBranch || gate.baseBranch !== record.review.baseBranch) {
    throw new Error(`Promotion merge admission target changed: expected ${record.targetBranch}, gate observed ${gate.baseBranch}`);
  }
}

async function assertPromotionMutationBoundary(record: PromotionRecord, host: ForgeHost): Promise<void> {
  await assertFrozenRefs(record, host);
  const pullRequest = await readExactPromotionPullRequest(record, host);
  if (pullRequest.state !== "OPEN") throw new Error(`Promotion pull request #${pullRequest.number} is ${pullRequest.state}, expected OPEN at merge boundary`);
}

async function readExactPromotionPullRequest(record: PromotionRecord, host: ForgeHost): Promise<PullRequestSnapshot> {
  if (!record.pullRequest) throw new Error("Promotion requires a pull request checkpoint");
  const pullRequest = await host.getPullRequest(record.repository, record.pullRequest.number);
  assertPromotionPullRequest(record, pullRequest);
  assertPromotionReviewIdentity(record, pullRequest);
  return pullRequest;
}

function assertPromotionReviewCheckpoint(record: PromotionRecord): asserts record is PromotionRecord & {
  pullRequest: PromotionPullRequestRecord;
  review: PromotionReviewRecord;
} {
  if (!record.pullRequest || !record.review) throw new Error("Promotion merge requires PR and approving review checkpoints");
  if (record.review.disposition !== "approve") throw new Error("Promotion merge requires an approving review");
}

function assertPromotionReviewIdentity(record: PromotionRecord, pullRequest: PullRequestSnapshot): void {
  if (!record.review) return;
  if (record.review.disposition !== "approve") throw new Error("Promotion merge requires an approving review");
  if (pullRequest.headSha !== record.review.headSha || pullRequest.headSha !== record.sourceHeadSha) {
    throw new Error(`Promotion reviewed SHA ${record.review.headSha} is stale; current PR/source head is ${pullRequest.headSha}/${record.sourceHeadSha}`);
  }
  if (pullRequest.baseBranch !== record.review.baseBranch) throw new Error("Promotion reviewed target changed before merge");
}

async function completeMergedPromotion(
  record: PromotionRecord,
  pullRequest: PullRequestSnapshot,
  dependencies: PromotionDependencies,
): Promise<PromotionRecord> {
  assertPromotionReviewCheckpoint(record);
  if (pullRequest.state !== "MERGED") throw new Error(`Promotion PR #${pullRequest.number} is not merged`);
  assertPromotionPullRequest(record, pullRequest);
  assertPromotionReviewIdentity(record, pullRequest);
  await assertProductionProtection(record.mode, record.repository, record.targetBranch, dependencies.host);
  const completed: PromotionRecord = {
    ...record,
    phase: "completed",
    pullRequest: { ...record.pullRequest, headSha: pullRequest.headSha, baseBranch: pullRequest.baseBranch },
    version: record.version + 1,
    updatedAt: new Date().toISOString(),
  };
  delete completed.failure;
  delete completed.resumePhase;
  await dependencies.promotions.savePromotion(record.version, completed);
  return completed;
}

async function recoverMergedPromotion(
  record: PromotionRecord,
  dependencies: PromotionDependencies,
  policy: EffectiveReviewCiConfig,
): Promise<PromotionRecord | undefined> {
  const awaitingMerge = record.phase === "awaiting-merge"
    || (record.phase === "failed" && record.resumePhase === "awaiting-merge");
  if (!awaitingMerge || !record.pullRequest || !record.review) return undefined;
  const pullRequest = await readExactPromotionPullRequest(record, dependencies.host);
  if (pullRequest.state !== "MERGED") return undefined;
  const observation = await observePromotionMergeGate(record, dependencies.host, undefined, policy);
  if (observation.status === "blocked") return blockPromotion(record, observation.reason, dependencies.promotions);
  if (observation.status !== "merged") return undefined;
  return completeMergedPromotion(record, observation.pullRequest, dependencies);
}

async function blockPromotion(
  record: PromotionRecord,
  reason: string,
  repository: PromotionRepository,
): Promise<PromotionRecord> {
  return advance(record, { phase: "blocked", failure: reason }, repository);
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
  if (record.pullRequest && pullRequest.number !== record.pullRequest.number) {
    throw new Error(`Promotion pull request identity changed: expected #${record.pullRequest.number}, found #${pullRequest.number}`);
  }
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
  phase: Exclude<PromotionPhase, "completed" | "blocked" | "failed" | "cancelled">,
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
  resumePhase: Exclude<PromotionPhase, "completed" | "blocked" | "failed" | "cancelled">,
  reason: string,
  repository: PromotionRepository,
): Promise<PromotionRecord> {
  if (record.phase === "completed" || record.phase === "blocked" || record.phase === "failed") return record;
  try {
    return await advance(record, { phase: "failed", resumePhase, failure: reason }, repository);
  } catch {
    return { ...record, phase: "failed", resumePhase, failure: reason };
  }
}

function resumePhaseFor(phase: PromotionPhase): Exclude<PromotionPhase, "completed" | "blocked" | "failed" | "cancelled"> {
  if (phase === "planned" || phase === "pr-created" || phase === "verifying" || phase === "reviewing" || phase === "awaiting-merge") return phase;
  return "planned";
}

function cancellationReason(error: unknown, signal?: AbortSignal): string {
  const reason = signal?.reason ?? error;
  if (reason instanceof Error && reason.message.trim()) return reason.message;
  if (typeof reason === "string" && reason.trim()) return reason.trim();
  return "Promotion cancelled while polling merge admission";
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
