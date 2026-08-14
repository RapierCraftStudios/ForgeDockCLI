// SPDX-License-Identifier: AGPL-3.0-or-later

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createArtifact, type ArtifactKind, type DurableArtifact } from "../core/artifacts/schema.js";
import { renderArtifactMarkdown } from "../core/artifacts/codec.js";
import { CachedArtifactRepository, ProjectedRunRepository, type ArtifactRepository, type RunProgressRecord, type RunRepository } from "../core/ports/repositories.js";
import { LeaseContinuityError } from "../core/ports/lease.js";
import type { OrchestrationNodeRecord, OrchestrationRecord } from "../core/ports/orchestration.js";
import { createObservationProducer, type ObservationIdentity, type ObservationSink } from "../observability/contracts.js";
import {
  decideSubjectAdmission,
  latestArtifactOfKind,
  MAX_VERIFICATION_REPAIR_ATTEMPTS,
  latestDeliveryRunArtifacts,
  reviewRemediationCycleCount,
  verificationRepairAttemptCount,
  workOnDeliveryArtifacts,
} from "../core/state/admission.js";
import { reconcileLatestRunArtifacts } from "../core/state/reconcile.js";
import { GitWorktreeManager } from "../adapters/git/git-worktree.js";
import { GitHubArtifactRepository, GitHubClient } from "../adapters/github/github-client.js";
import { ProcessVerificationRunner } from "../adapters/process/process-verifier.js";
import { createConfiguredLeaseWitness } from "../adapters/sqlite/lease-witness.js";
import {
  scopeManifestForBuildPacket,
  STANDARD_SCOPE_METADATA_ROOTS,
  TelemetryAgentRuntime,
  type AgentEvent,
  type AgentRuntime,
  type RuntimePreflightOptions,
} from "../runtime/agent-runtime.js";
import { PiAgentRuntime } from "../runtime/pi-adapter.js";
import { summarizeControllerTiming, summarizeTelemetry, type TelemetryRepository } from "../core/ports/telemetry.js";
import type { CheckResult, VerificationCommand } from "../core/ports/verification.js";
import { colorMode, renderHeader, statusGlyph } from "../tui/brand.js";
import { orchestrationConfigSources, readForgeDockConfig, resolveAutoMerge, splitConfiguredModel, type ThinkingLevel, resolveOrchestrationConfig } from "../core/config/forgedock-config.js";
import { completeInvalidWorkItem } from "../workflows/work-on/complete.js";
import { investigateWorkItem } from "../workflows/work-on/investigate.js";
import { resumeBuildWorkOn, resumeCompletionWorkOn, resumeExpandedReviewWorkOn, resumePublicationWorkOn, resumeReviewWorkOn, resumeWorkOn, workOn as executeWorkOn } from "../workflows/work-on/work-on.js";
import { assertRunFollowsLane, classifyIssueLane, laneEvidence, provisionMissingMilestoneBranches, resolveIssueLane, runTargetForLane, type IssueLane } from "../workflows/work-on/lane.js";
import { resolveParentRemediationTargetFromIssue } from "../workflows/work-on/parent-remediation.js";
import { reviewExistingPullRequest } from "../workflows/review-pr/review-existing.js";
import { promoteBranch, PromotionExecutionError } from "../workflows/promotion/promotion.js";
import { affectedFilesFromIssueBody, contractBatchGroups, inferBatchRiskClass, parseBatchContract, parseBatchMemberIssues, type BatchableWorkItem } from "../workflows/orchestrate/batching.js";
import { assembleWorkUnits } from "../workflows/orchestrate/assemble.js";
import { materializeBatchGroups } from "../workflows/orchestrate/materialize.js";
import { ClaimPromotionConflictError, materializeClaimDependencies, runSchedule, type ScheduledWorkItem } from "../workflows/orchestrate/scheduler.js";
import { RemediationSupervisor } from "../workflows/orchestrate/remediation.js";
import { orchestrationEventFromSchedule } from "../workflows/orchestrate/events.js";
import { buildOrchestrationSnapshot } from "../workflows/orchestrate/view-model.js";
import { AgentEventStreamWriter, observeAgentEvent, setAgentEventObservationIdentity, setAgentEventObservationSink } from "./agent-event-stream.js";
import { ControllerObservationAdapter } from "../observability/adapters.js";
import { createForgeDockObserver, type ForgeDockObserver } from "../observability/observer.js";
import type { RunState } from "../core/state/machine.js";
import { discoverVerificationCommands } from "./verification-policy.js";
import { parseOrchestrationIssueNumbers } from "./argument-parser.js";

const args = process.argv.slice(2);
const mode = colorMode();
const agentEventStream = new AgentEventStreamWriter((text) => process.stdout.write(text), mode);
let activeObserver: ForgeDockObserver | undefined;

await main(args).catch((error: unknown) => {
  agentEventStream.finish();
  const message = error instanceof Error ? error.message : String(error);
  console.error(`${statusGlyph("failed", mode)} ${message}`);
  process.exitCode = 1;
});

type RunDisplayGlyph = "active" | "passed" | "failed" | "blocked";

function runStatePresentation(state: string): { glyph: RunDisplayGlyph; label: string } {
  switch (state) {
    case "completed": return { glyph: "passed", label: "completed" };
    case "failed": return { glyph: "failed", label: "failed · engine recovery required" };
    case "blocked": return { glyph: "blocked", label: "blocked · human/recovery action required" };
    case "invalid": return { glyph: "blocked", label: "invalid · no delivery performed" };
    case "decomposed": return { glyph: "blocked", label: "decomposed · child scope required" };
    case "merging": return { glyph: "active", label: "awaiting human merge" };
    default: return { glyph: "active", label: state };
  }
}

async function main(argv: string[]): Promise<void> {
  const command = argv[0] ?? "help";
  if (command === "help" || command === "--help" || command === "-h") {
    printHelp();
    return;
  }
  const observer: ForgeDockObserver = await createForgeDockObserver(process.cwd(), { component: "forgedock-controller" });
  activeObserver = observer;
  const controllerObservation = new ControllerObservationAdapter(observer, {
    identity: {
      ...(process.env.FORGEDOCK_RUN_ID ? { forgeRunId: process.env.FORGEDOCK_RUN_ID } : {}),
      ...(process.env.FORGEDOCK_ORCHESTRATION_ID ? { orchestrationId: process.env.FORGEDOCK_ORCHESTRATION_ID } : {}),
      ...(process.env.FORGEDOCK_ORCHESTRATION_NODE ? { nodeId: process.env.FORGEDOCK_ORCHESTRATION_NODE, workUnitId: process.env.FORGEDOCK_ORCHESTRATION_NODE } : {}),
      ...(process.env.FORGEDOCK_ORCHESTRATION_ISSUE && /^\d+$/.test(process.env.FORGEDOCK_ORCHESTRATION_ISSUE) ? { issueNumber: Number(process.env.FORGEDOCK_ORCHESTRATION_ISSUE) } : {}),
      ...(process.env.FORGEDOCK_CONTROLLER_TASK_ID ? { controllerTaskId: process.env.FORGEDOCK_CONTROLLER_TASK_ID } : {}),
    },
  });
  controllerObservation.started(command, argv.slice(1));
  setAgentEventObservationSink(observer, {
    ...(process.env.FORGEDOCK_RUN_ID ? { forgeRunId: process.env.FORGEDOCK_RUN_ID } : {}),
    ...(process.env.FORGEDOCK_ORCHESTRATION_ID ? { orchestrationId: process.env.FORGEDOCK_ORCHESTRATION_ID } : {}),
    ...(process.env.FORGEDOCK_ORCHESTRATION_NODE ? { nodeId: process.env.FORGEDOCK_ORCHESTRATION_NODE, workUnitId: process.env.FORGEDOCK_ORCHESTRATION_NODE } : {}),
    ...(process.env.FORGEDOCK_ORCHESTRATION_ISSUE && /^\d+$/.test(process.env.FORGEDOCK_ORCHESTRATION_ISSUE) ? { issueNumber: Number(process.env.FORGEDOCK_ORCHESTRATION_ISSUE) } : {}),
    ...(process.env.FORGEDOCK_CONTROLLER_TASK_ID ? { controllerTaskId: process.env.FORGEDOCK_CONTROLLER_TASK_ID } : {}),
  });
  let controllerFailed = false;
  try {
    if (command === "work-on") {
      await workOn(argv.slice(1));
      return;
    }
    if (command === "status") {
      await status(argv.slice(1));
      return;
    }
    if (command === "review-pr") {
      await reviewPr(argv.slice(1));
      return;
    }
    if (command === "promote") {
      await promote(argv.slice(1));
      return;
    }
    if (command === "reset") {
      await resetIssue(argv.slice(1));
      return;
    }
    if (command === "orchestrate") {
      await orchestrate(argv.slice(1));
      return;
    }
    throw new Error(`Unknown command: ${command}`);
  } catch (error) {
    controllerFailed = true;
    controllerObservation.failed(error);
    throw error;
  } finally {
    controllerObservation.completed(controllerFailed ? 1 : (typeof process.exitCode === "number" ? process.exitCode : 0));
    await observer.flush();
    observer.close();
    activeObserver = undefined;
    setAgentEventObservationSink(undefined);
  }
}

async function status(argv: string[]): Promise<void> {
  const { SqliteRepositories } = await import("../adapters/sqlite/sqlite-repositories.js");
  const statusWitness = createConfiguredLeaseWitness(process.cwd());
  if (!statusWitness) throw new Error("Lease witness configuration is required for status/recovery inspection; token-only local leases are disabled");
  const store = new SqliteRepositories(join(process.cwd(), ".forgedock", "state.db"), { witness: statusWitness });
  try {
    if (argv.includes("--promotions")) {
      const promotions = await store.listPromotions();
      if (argv.includes("--json")) process.stdout.write(`${JSON.stringify(promotions, null, 2)}\n`);
      else {
        process.stdout.write(`${renderHeader({ subtitle: "status · durable promotions" })}\n\n`);
        if (!promotions.length) process.stdout.write("No durable promotions.\n");
        for (const promotion of promotions) {
          const pullRequest = promotion.pullRequest ? ` · PR #${promotion.pullRequest.number}` : "";
          process.stdout.write(`${statusGlyph(promotion.phase === "completed" ? "passed" : promotion.phase === "failed" ? "failed" : "active", mode)} ${promotion.promotionId} · ${promotion.mode} · ${promotion.sourceBranch} → ${promotion.targetBranch} · ${promotion.phase}${pullRequest}\n`);
        }
      }
      return;
    }
    const orchestrationId = option(argv, "--orchestration");
    if (orchestrationId !== undefined) {
      const orchestration = await store.loadOrchestration(orchestrationId);
      if (!orchestration) throw new Error(`Unknown orchestration ${orchestrationId}`);
      if (argv.includes("--json")) {
        process.stdout.write(`${JSON.stringify(orchestration, null, 2)}\n`);
      } else {
        process.stdout.write(`${renderHeader({ subtitle: "status · durable orchestration" })}\n\n`);
        process.stdout.write(`${statusGlyph(orchestration.status === "completed" ? "passed" : orchestration.status === "running" ? "active" : "failed", mode)} ${orchestration.orchestrationId} · ${orchestration.status} · ${orchestration.repository}\n`);
        for (const node of orchestration.nodes) {
          const presentation = runStatePresentation(node.status);
          const childRuns = node.childRunIds.length ? ` · runs=${node.childRunIds.join(",")}` : "";
          process.stdout.write(`  ${statusGlyph(presentation.glyph, mode)} #${node.issue} · ${presentation.label}${childRuns}${node.error ? ` · ${node.error}` : ""}\n`);
        }
      }
      return;
    }
    const issueValue = option(argv, "--issue");
    if (issueValue !== undefined) {
      if (!/^\d+$/.test(issueValue)) throw new Error("--issue must be a positive integer");
      const github = new GitHubClient(process.cwd());
      const issue = await github.getIssue(Number(issueValue), option(argv, "--repo"));
      const artifacts = await new GitHubArtifactRepository(github).list({ repo: issue.repo, issue: issue.number });
      const deliveryArtifacts = workOnDeliveryArtifacts(artifacts);
      const reconciled = reconcileLatestRunArtifacts(deliveryArtifacts.length ? deliveryArtifacts : artifacts);
      const configured = readForgeDockConfig(process.cwd());
      const telemetry = summarizeTelemetry(reconciled.runId ? store.listTelemetry(reconciled.runId) : []);
      const localRun = reconciled.runId ? store.listRuns().find((run) => run.runId === reconciled.runId) : undefined;
      const progress = localRun ? await store.listProgress(localRun.runId) : [];
      const latestProgress = progress.at(-1);
      const controllerTiming = localRun
        ? summarizeControllerTiming(localRun.createdAt, await store.history(localRun.runId))
        : undefined;
      const result = {
        subject: `${issue.repo}#${issue.number}`,
        policy: resolveOrchestrationConfig(configured),
        policySources: orchestrationConfigSources(configured),
        telemetry,
        ...(controllerTiming !== undefined ? { controllerTiming } : {}),
        ...(latestProgress !== undefined ? { controllerProgress: { latest: latestProgress, count: progress.length } } : {}),
        ...reconciled,
      };
      if (argv.includes("--json")) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      else {
        process.stdout.write(`${renderHeader({ subtitle: "status · reconstructed from GitHub" })}\n\n`);
        const presentation = runStatePresentation(reconciled.state);
        const suspended = reconciled.state === "blocked" && ["awaiting-dispatch", "children-running", "ready-to-resume"].includes(reconciled.remediationCheckpoint?.payload.status ?? "");
        const label = suspended ? "suspended · remediation checkpoint awaiting resume" : presentation.label;
        process.stdout.write(`${statusGlyph(suspended ? "active" : presentation.glyph, mode)} ${result.subject} · ${label}\n`);
        renderTelemetryLine(telemetry);
        if (controllerTiming !== undefined) renderControllerTimingLine(controllerTiming);
        if (latestProgress !== undefined) process.stdout.write(`  progress: ${latestProgress.phase} · ${latestProgress.message}\n`);
        for (const warning of reconciled.warnings) process.stdout.write(`  warning: ${warning}\n`);
      }
      return;
    }

    const runs = store.listRuns();
    const configured = readForgeDockConfig(process.cwd());
    const policy = resolveOrchestrationConfig(configured);
    const policySources = orchestrationConfigSources(configured);
    const runsWithTelemetry = await Promise.all(runs.map(async (run) => ({
      ...run,
      telemetry: summarizeTelemetry(store.listTelemetry(run.runId)),
      controllerTiming: summarizeControllerTiming(run.createdAt, await store.history(run.runId)),
      controllerProgress: (await store.listProgress(run.runId)).at(-1),
    })));
    if (argv.includes("--json")) {
      process.stdout.write(`${JSON.stringify({ policy, policySources, runs: runsWithTelemetry }, null, 2)}\n`);
      return;
    }
    process.stdout.write(`${renderHeader({ subtitle: "status · local operational cache" })}\n\n`);
    process.stdout.write(`Effective orchestration: batching=${policy.batchingPolicy}, scope=${policy.scopeExpansion}, dispatch=${policy.dispatchMode}, fast=${policy.fastLaneTarget ?? "repository-default"}, feature-promotion=${policy.featurePromotionTarget ?? "unset"}, production=${policy.productionTarget ?? "repository-default"}, maxParallel=${policy.maxParallel}, remediation=${policy.maxRemediationCycles}/${policy.maxRemediationDepth}/${policy.maxRemediationChildren}\n`);
    process.stdout.write(`Policy sources: ${Object.entries(policySources).map(([key, source]) => `${key}=${source}`).join(", ")}\n\n`);
    if (!runs.length) {
      process.stdout.write("No local runs. Durable semantic artifacts may still exist on GitHub.\n");
      return;
    }
    for (const run of runsWithTelemetry) {
      const subject = `${run.subject.repo}${run.subject.issue ? `#${run.subject.issue}` : ""}${run.subject.pr ? ` PR#${run.subject.pr}` : ""}`;
      const presentation = runStatePresentation(run.state);
      process.stdout.write(`${statusGlyph(presentation.glyph, mode)} ${run.runId} · ${subject} · ${presentation.label} · v${run.version}\n`);
      renderTelemetryLine(run.telemetry, "  ");
      renderControllerTimingLine(run.controllerTiming, "  ");
      if (run.controllerProgress) process.stdout.write(`  progress: ${run.controllerProgress.phase} · ${run.controllerProgress.message}\n`);
    }
  } finally {
    store.close();
  }
}

async function workOn(argv: string[]): Promise<void> {
  requirePiNodeVersion();
  const issueArg = argv.find((arg) => !arg.startsWith("-"));
  if (!issueArg || !/^\d+$/.test(issueArg)) {
    throw new Error("Usage: forgedock-next work-on <issue-number> [--depends-on N,N] [--through investigate] [--repo owner/repo] [--planning-model provider/model] [--planning-thinking high] [--dry-run] [--auto-merge | --no-auto-merge] [--resume] [--adjudicate-verification REASON] [--rerun]");
  }
  const through = option(argv, "--through");
  if (through && through !== "investigate") throw new Error("--through currently accepts only investigate");
  const dryRun = argv.includes("--dry-run");
  if (dryRun && through !== "investigate") throw new Error("--dry-run must be paired with --through investigate; full work-on creates a branch and PR");
  if (argv.includes("--rerun") && argv.includes("--resume")) throw new Error("--rerun and --resume are mutually exclusive recovery policies");
  const adjudicationReason = option(argv, "--adjudicate-verification");
  if (adjudicationReason !== undefined && !argv.includes("--resume")) throw new Error("--adjudicate-verification requires --resume; it authorizes typed verification checkpoint resume, not a fresh run");
  if (adjudicationReason !== undefined && argv.includes("--rerun")) throw new Error("--adjudicate-verification cannot be combined with --rerun");
  const autoMerge = commandAutoMerge(argv);
  const configuredNext = readForgeDockConfig(process.cwd());
  const scopeExpansionOption = option(argv, "--scope-expansion");
  if (scopeExpansionOption !== undefined && scopeExpansionOption !== "scope-locked" && scopeExpansionOption !== "recursive") throw new Error("--scope-expansion must be scope-locked or recursive");
  const remediationCyclesOption = option(argv, "--max-remediation-cycles");
  const remediationDepthOption = option(argv, "--max-remediation-depth");
  const remediationChildrenOption = option(argv, "--max-remediation-children");
  const effectiveOrchestration = resolveOrchestrationConfig(configuredNext, {
    ...(scopeExpansionOption !== undefined ? { scopeExpansion: scopeExpansionOption } : {}),
    ...(remediationCyclesOption !== undefined ? { maxRemediationCycles: Number(remediationCyclesOption) } : {}),
    ...(remediationDepthOption !== undefined ? { maxRemediationDepth: Number(remediationDepthOption) } : {}),
    ...(remediationChildrenOption !== undefined ? { maxRemediationChildren: Number(remediationChildrenOption) } : {}),
  });
  const maxReviewSpecialists = configuredMaxReviewSpecialists();

  process.stdout.write(`${renderHeader({ subtitle: through === "investigate" ? "work-on · investigation barrier" : "work-on · controlled delivery" })}\n\n`);
  let github = new GitHubClient(process.cwd());
  const issue = await github.getIssue(Number(issueArg), option(argv, "--repo"));
  const localRepository = await github.getRepository();
  if (localRepository.repo !== issue.repo) throw new Error(`Current checkout is ${localRepository.repo}, but the issue belongs to ${issue.repo}`);
  const lane = await resolveIssueLane(issue, localRepository.defaultBranch, github, effectiveOrchestration.fastLaneTarget, effectiveOrchestration.featurePromotionTarget, effectiveOrchestration.productionTarget);
  const runId = `run_${crypto.randomUUID()}`;
  const subject = { repo: issue.repo, issue: issue.number };
  let authoritativeArtifacts = new GitHubArtifactRepository(github);
  const parentRemediation = await resolveParentRemediationTargetFromIssue(issue, authoritativeArtifacts);
  const deliveryTargetBranch = parentRemediation?.parentBranch ?? lane.targetBranch;
  const baseRef = `origin/${deliveryTargetBranch}`;
  const verificationPolicy = argv.includes("--resume") ? undefined : discoverVerificationCommands(process.cwd(), baseRef);
  const dependencyIssues = parseIssueNumbers(option(argv, "--depends-on"));
  const batchMembers = parseBatchMemberIssues(issue.body).filter((member) => member !== issue.number);
  const parsedBatchMemberContracts = batchMembers.length ? parseBatchContract(issue.body) : [];
  const subjectEvidence = issueSubjectEvidence(issue);
  subjectEvidence.push(laneEvidence(lane));
  if (batchMembers.length) subjectEvidence.push(`Batch issue #${issue.number} authoritatively represents member issues: ${batchMembers.map((member) => `#${member}`).join(", ")}`);
  if (dependencyIssues.includes(issue.number)) throw new Error(`Issue #${issue.number} cannot depend on itself`);
  for (const dependency of dependencyIssues) {
    const dependencyArtifacts = await authoritativeArtifacts.list({ repo: issue.repo, issue: dependency });
    const reconciled = reconcileLatestRunArtifacts(dependencyArtifacts);
    if (reconciled.state !== "completed") {
      throw new Error(`Dependency #${dependency} is ${reconciled.state}, not completed; refusing to start #${issue.number}`);
    }
    const dependencyIssue = await github.getIssue(dependency, issue.repo);
    const mergedOutcome = dependencyArtifacts
      .filter((artifact): artifact is DurableArtifact<"Outcome"> => artifact.kind === "Outcome" && artifact.payload.status === "merged")
      .at(-1);
    subjectEvidence.push(
      `Dependency #${dependency} admission: authoritative artifact state completed${reconciled.runId ? ` in run ${reconciled.runId}` : ""}; merged Outcome recorded ${mergedOutcome?.createdAt ?? "with no timestamp"}; issue state ${dependencyIssue.state}; labels ${dependencyIssue.labels.join(", ") || "none"}`,
    );
  }
  let priorArtifacts = dryRun ? [] : await authoritativeArtifacts.list(subject);
  const persistedBatchMemberContracts = !argv.includes("--rerun")
    ? latestArtifactOfKind(priorArtifacts, "Intent")?.payload.batchMemberContracts
    : undefined;
  const batchMemberContracts = persistedBatchMemberContracts ?? parsedBatchMemberContracts;
  if (adjudicationReason !== undefined) {
    const latestDelivery = latestDeliveryRunArtifacts(priorArtifacts);
    const latestOutcome = latestDelivery ? latestArtifactOfKind(latestDelivery.artifacts, "Outcome") : undefined;
    if (!latestDelivery || !latestOutcome || latestOutcome.payload.status !== "blocked" || !latestOutcome.payload.failureEvidence) {
      throw new Error("--adjudicate-verification requires the latest run to have a retained blocked verification Outcome");
    }
    if (!latestOutcome.payload.failureEvidence.criterionCoverage?.length) {
      throw new Error("--adjudicate-verification requires typed builder criterion coverage; legacy evidence must use ordinary checkpoint recovery");
    }
    if (verificationRepairAttemptCount(latestDelivery.artifacts) < MAX_VERIFICATION_REPAIR_ATTEMPTS) {
      throw new Error("--adjudicate-verification is only valid after the bounded verification repair budget is exhausted");
    }
    const adjudicationId = `vadj_${latestDelivery.runId}_${latestOutcome.id}`;
    const existingAdjudication = priorArtifacts.find((artifact) => artifact.id === adjudicationId);
    if (!existingAdjudication) {
      const adjudication = createArtifact({
        kind: "VerificationAdjudication",
        runId: latestDelivery.runId,
        subject,
        producer: { role: "human", runtime: "forgedock" },
        payload: {
          checkpoint: "verification",
          decision: "resume",
          supersedesOutcomeId: latestOutcome.id,
          reason: adjudicationReason,
        },
      }, { id: adjudicationId });
      await authoritativeArtifacts.append(adjudication);
      priorArtifacts = [...priorArtifacts, adjudication];
    }
  }
  let resumeRunId: string | undefined;
  let progressRunId = runId;
  let resumeCheckpoint: string | undefined;
  let resumeArtifacts: DurableArtifact[] = [];
  if (!dryRun) {
    const admission = decideSubjectAdmission(priorArtifacts, { rerun: argv.includes("--rerun"), currentTargetBranch: deliveryTargetBranch });
    if (admission.action === "skip") {
      process.stdout.write(`${statusGlyph("passed", mode)} Existing run ${admission.runId} is already ${admission.state}; no duplicate run was created.\n`);
      return;
    }
    if (admission.action === "block") {
      throw new Error(admission.reason);
    }
    if (admission.action === "resume") {
      if (!argv.includes("--resume")) {
        throw new Error(`Existing run ${admission.runId} has a recoverable ${admission.checkpoint} checkpoint. Re-run with --resume to continue it; reset only if you intentionally want to abandon its durable work`);
      }
      resumeRunId = admission.runId;
      progressRunId = resumeRunId;
      resumeCheckpoint = admission.checkpoint;
      resumeArtifacts = admission.artifacts;
    }
  }
  setAgentEventObservationIdentity({
    repository: issue.repo,
    issueNumber: issue.number,
    forgeRunId: progressRunId,
    ...(process.env.FORGEDOCK_ORCHESTRATION_ID ? { orchestrationId: process.env.FORGEDOCK_ORCHESTRATION_ID } : {}),
    ...(process.env.FORGEDOCK_ORCHESTRATION_NODE ? { nodeId: process.env.FORGEDOCK_ORCHESTRATION_NODE, workUnitId: process.env.FORGEDOCK_ORCHESTRATION_NODE } : {}),
    ...(process.env.FORGEDOCK_CONTROLLER_TASK_ID ? { controllerTaskId: process.env.FORGEDOCK_CONTROLLER_TASK_ID } : {}),
  });
  const intent = createArtifact({
    kind: "Intent", runId, subject,
    producer: { role: "controller", runtime: "forgedock" },
    payload: {
      title: issue.title,
      problem: issue.body || issue.title,
      constraints: [],
      acceptanceHints: [],
      dependencies: dependencyIssues.map((dependency) => `issue-${dependency}`),
      ...(batchMemberContracts.length ? { batchMemberContracts } : {}),
      sourceUrl: issue.url,
      conversation: issue.comments
        .filter((comment) => !comment.containsArtifact && comment.body.trim())
        .map((comment) => ({
          author: comment.author,
          createdAt: comment.createdAt,
          body: comment.body,
          ...(comment.url ? { url: comment.url } : {}),
        })),
    },
  });

  const provider = option(argv, "--provider");
  const model = option(argv, "--model");
  const planning = configuredPlanningOptions(argv);
  const { SqliteRepositories } = await import("../adapters/sqlite/sqlite-repositories.js");
  const leaseWitness = createConfiguredLeaseWitness(process.cwd());
  if (!leaseWitness) throw new Error("Lease witness configuration is required: set FORGEDOCK_LEASE_WITNESS_PATH, FORGEDOCK_LEASE_WITNESS_PUBLIC_KEY, and FORGEDOCK_LEASE_WITNESS_PRIVATE_KEY; token-only local leases are disabled");
  const store = new SqliteRepositories(join(process.cwd(), ".forgedock", "state.db"), { witness: leaseWitness });
  // All remediation callers in this controller share the durable admission
  // repository, including a later --resume invocation in another process.
  github = new GitHubClient(process.cwd(), store);
  authoritativeArtifacts = new GitHubArtifactRepository(github);
  const baseArtifacts = dryRun ? store : new CachedArtifactRepository(authoritativeArtifacts, store);
  const artifacts = activeObserver
    ? observeArtifactRepository(baseArtifacts, activeObserver, { repository: issue.repo, issueNumber: issue.number, forgeRunId: progressRunId })
    : baseArtifacts;
  const baseRuns = dryRun ? store : projectRunsToGitHub(store, github);
  const runs = activeObserver
    ? observeRunRepository(baseRuns, activeObserver, { repository: issue.repo, issueNumber: issue.number, forgeRunId: progressRunId })
    : baseRuns;
  const runtime = createCliRuntime({
    ...(provider !== undefined ? { provider } : {}),
    ...(model !== undefined ? { model } : {}),
    ...planning,
  }, store);
  const onAgentEvent = (event: AgentEvent) => {
    writeAgentEvent(event);
    if (event.type === "thinking.delta" || event.type === "text.delta") return;
    const observability = event.observability;
    const activity = event.type === "tool.started"
      ? `last tool ${event.tool} started`
      : event.type === "tool.completed"
        ? `last tool ${event.tool} ${event.isError ? "failed" : "completed"}`
        : event.type === "session.started"
          ? "agent session started"
          : event.type === "session.completed"
            ? "agent session completed"
            : event.type === "artifact.submitted" ? "artifact submitted" : "agent activity";
    const milestone = observability ? [
      `phase ${observability.phase}`,
      observability.cycle ? `review cycle ${observability.cycle.current}/${observability.cycle.total}` : "",
      observability.activeChild ? `active child ${observability.activeChild}` : "",
      observability.reviewerRoles?.length ? `reviewers ${observability.reviewerRoles.join(", ")}` : "",
      observability.latestArtifacts?.buildResult ? `BuildResult ${observability.latestArtifacts.buildResult}` : "",
      observability.latestArtifacts?.reviewVerdict ? `ReviewVerdict ${observability.latestArtifacts.reviewVerdict}` : "",
      observability.remainingRemediationCycles !== undefined ? `remediation remaining ${observability.remainingRemediationCycles}` : "",
    ].filter(Boolean).join(" · ") : `phase ${event.type}`;
    void runs.recordProgress({
      runId: progressRunId,
      phase: observability?.phase ?? event.type,
      message: `${milestone} · ${activity} · ${event.taskId}`,
      occurredAt: new Date().toISOString(),
    }).catch(() => undefined);
  };
  const leaseItem = `issue-${issue.number}`;
  const leaseOwner = `work-on-${process.pid}-${crypto.randomUUID()}`;
  const leaseController = new AbortController();
  let leaseToken: string | undefined;
  let leaseGuard: import("../core/ports/lease.js").LeaseGuard | undefined;
  let leaseHeartbeat: NodeJS.Timeout | undefined;

  try {
    if (resumeCheckpoint !== "completion" && resumeCheckpoint !== "invalid-closure") {
      await preflightRuntime(runtime, {
        ...(provider !== undefined ? { provider } : {}),
        ...(model !== undefined ? { model } : {}),
      });
    }
    const lease = store.acquire(leaseItem, leaseOwner, 60_000);
    if (!lease) throw new Error(`Issue #${issue.number} already has an active local ForgeDock controller; wait for it or cancel that task before resuming`);
    leaseToken = lease.token;
    leaseGuard = store.guard(leaseItem, lease.token);
    leaseHeartbeat = setInterval(() => {
      try {
        store.heartbeat(leaseItem, lease.token, 60_000);
        void runs.recordProgress({
          runId: progressRunId,
          phase: "controller.heartbeat",
          message: "Controller lease renewed",
          occurredAt: new Date().toISOString(),
        }).catch(() => undefined);
      } catch (error) { leaseController.abort(error); }
    }, 20_000);

    if (resumeRunId) {
      const admission = decideSubjectAdmission(resumeArtifacts, { currentTargetBranch: deliveryTargetBranch });
      if (admission.action === "block") throw new Error(admission.reason);
      if (admission.action !== "resume" || admission.runId !== resumeRunId) {
        throw new Error(`Run ${resumeRunId} no longer has a recoverable durable checkpoint`);
      }
      const runArtifacts = resumeArtifacts.filter((artifact) => artifact.runId === resumeRunId);
      if (admission.checkpoint === "invalid-closure") {
        const intentArtifact = latestArtifactOfKind(runArtifacts, "Intent");
        const investigation = latestArtifactOfKind(runArtifacts, "Investigation");
        const invalidOutcome = latestArtifactOfKind(runArtifacts, "Outcome");
        if (!intentArtifact || !investigation || investigation.payload.outcome !== "invalid"
          || !invalidOutcome || invalidOutcome.payload.status !== "invalid") {
          throw new Error(`Run ${resumeRunId} does not contain the Intent, invalid Investigation, and invalid Outcome required for issue closure resume`);
        }
        const artifactIds: Partial<Record<ArtifactKind, string[]>> = {};
        for (const artifact of runArtifacts) artifactIds[artifact.kind] = [...(artifactIds[artifact.kind] ?? []), artifact.id];
        const frozenTarget = runTargetForLane(lane, effectiveOrchestration.productionTarget);
        const recoveredRun = {
          schema: "forgedock.run/v1" as const, runId: resumeRunId, workflow: "work-on" as const, subject,
          state: "invalid" as const, attempt: 1, version: 0,
          ...frozenTarget,
          createdAt: intentArtifact.createdAt,
          updatedAt: invalidOutcome.createdAt,
          artifactIds,
        };
        let run = await store.load(resumeRunId);
        if (!run) {
          await store.create(recoveredRun);
          run = recoveredRun;
        } else if (run.subject.repo !== subject.repo || run.subject.issue !== subject.issue) {
          throw new Error(`Durable invalid run ${resumeRunId} targets ${run.subject.repo}#${run.subject.issue}, expected ${subject.repo}#${subject.issue}`);
        } else if (run.targetBranch && run.targetBranch !== frozenTarget.targetBranch) {
          throw new Error(`Durable invalid run target ${run.targetBranch} conflicts with current issue lane target ${frozenTarget.targetBranch}`);
        } else if (run.state !== "invalid" || !run.targetBranch) {
          await store.rebuildRun(recoveredRun);
          run = recoveredRun;
        } else {
          assertRunFollowsLane(run, lane, effectiveOrchestration.productionTarget);
        }
        const finalized = await completeInvalidWorkItem({ run, investigation, outcome: invalidOutcome }, { host: github, artifacts });
        process.stdout.write(`${statusGlyph("passed", mode)} Resumed invalid run ${finalized.run.runId} · issue #${issue.number} is authoritatively closed\n`);
        return;
      }
      const priorRemediationCycles = reviewRemediationCycleCount(runArtifacts);
      const intentArtifact = latestArtifactOfKind(runArtifacts, "Intent");
      const investigation = latestArtifactOfKind(runArtifacts, "Investigation");
      const packet = latestArtifactOfKind(runArtifacts, "BuildPacket");
      if (!intentArtifact || !investigation || investigation.payload.outcome !== "confirmed" || !packet) {
        throw new Error(`Run ${resumeRunId} does not contain the Intent, confirmed Investigation, and frozen Build Packet required for ${admission.checkpoint} resume`);
      }
      const durableBatchMemberContracts = intentArtifact.payload.batchMemberContracts ?? batchMemberContracts;
      const durableBatchMembers = durableBatchMemberContracts.map((contract) => contract.issue);
      const remediationCheckpoint = latestArtifactOfKind(runArtifacts, "RemediationBlocked");
      const latestOutcome = latestArtifactOfKind(runArtifacts, "Outcome");
      const verificationAdjudication = latestArtifactOfKind(runArtifacts, "VerificationAdjudication");
      const checkpointArtifact = admission.checkpoint === "verification"
        ? latestOutcome
        : admission.checkpoint === "publication"
          ? latestArtifactOfKind(runArtifacts, "BuildResult")
          : admission.checkpoint === "completion"
            ? latestArtifactOfKind(runArtifacts, "ReviewVerdict")
            : admission.checkpoint === "remediation"
              ? (admission.state === "blocked" ? latestArtifactOfKind(runArtifacts, "Outcome") : latestArtifactOfKind(runArtifacts, "ReviewVerdict"))
              : packet;
      const artifactIds: Partial<Record<ArtifactKind, string[]>> = {};
      for (const artifact of runArtifacts) artifactIds[artifact.kind] = [...(artifactIds[artifact.kind] ?? []), artifact.id];
      const recoveredScopeManifest = scopeManifestForBuildPacket(packet.payload.expectedPaths);
      const priorVerificationRepairAttempts = verificationRepairAttemptCount(runArtifacts);
      const failedOutcome = admission.state === "failed" ? latestOutcome : undefined;
      const retainedBuildResult = latestArtifactOfKind(runArtifacts, "BuildResult");
      const priorVerdict = latestArtifactOfKind(runArtifacts, "ReviewVerdict");
      const durableTargetBranch = retainedBuildResult?.payload.targetBranch
        ?? latestOutcome?.payload.failureEvidence?.targetBranch
        ?? deliveryTargetBranch;
      if (durableTargetBranch !== deliveryTargetBranch) {
        throw new Error(
          `Durable run target ${durableTargetBranch} conflicts with current issue lane target ${deliveryTargetBranch}; refusing cross-branch recovery`,
        );
      }
      const durablePromotionTarget = retainedBuildResult?.payload.promotionTarget
        ?? latestOutcome?.payload.failureEvidence?.promotionTarget
        ?? (lane.kind === "feature" ? lane.promotionTarget : undefined);
      const expectedPromotionTarget = lane.kind === "feature" ? lane.promotionTarget : undefined;
      if (durablePromotionTarget !== expectedPromotionTarget) {
        throw new Error(`Durable run promotion target ${durablePromotionTarget ?? "unset"} conflicts with current issue lane target ${expectedPromotionTarget ?? "unset"}; refusing cross-lane recovery`);
      }
      const durableProductionTarget = retainedBuildResult?.payload.productionTarget
        ?? latestOutcome?.payload.failureEvidence?.productionTarget
        ?? effectiveOrchestration.productionTarget;
      if (durableProductionTarget !== effectiveOrchestration.productionTarget) {
        throw new Error(`Durable run production target ${durableProductionTarget ?? "unset"} conflicts with configured target ${effectiveOrchestration.productionTarget ?? "unset"}; refusing policy drift during recovery`);
      }
      const persistedBaseRef = latestOutcome?.payload.failureEvidence?.baseRef;
      const expectedBaseRef = `origin/${durableTargetBranch}`;
      if (persistedBaseRef !== undefined && persistedBaseRef !== expectedBaseRef) {
        throw new Error(
          `Durable run base ${persistedBaseRef} conflicts with target ${expectedBaseRef}; refusing cross-branch recovery`,
        );
      }
      const recoveryBaseRef = persistedBaseRef ?? expectedBaseRef;
      const openPullRequest = retainedBuildResult
        ? await github.findOpenPullRequest(issue.repo, retainedBuildResult.payload.branch)
        : undefined;
      const checkpointPullRequest = admission.checkpoint === "completion" && priorVerdict?.subject.pr
        ? await github.getPullRequest(issue.repo, priorVerdict.subject.pr)
        : openPullRequest;
      if (admission.checkpoint === "remediation" && (!retainedBuildResult || !priorVerdict || !checkpointPullRequest)) {
        throw new Error(`Run ${resumeRunId} no longer has the Build Result, Review Verdict, and open PR required for remediation resume`);
      }
      if (admission.checkpoint === "remediation" && remediationCheckpoint?.kind === "RemediationBlocked" && remediationCheckpoint.payload.status === "terminal") {
        throw new Error(`Run ${resumeRunId} has a terminal recursive-remediation checkpoint; human intervention is required`);
      }
      if (admission.checkpoint === "completion" && (!retainedBuildResult || !priorVerdict || !checkpointPullRequest)) {
        throw new Error(`Run ${resumeRunId} no longer has the Build Result, approving Review Verdict, and PR required for completion resume`);
      }
      if (checkpointPullRequest && checkpointPullRequest.baseBranch !== deliveryTargetBranch) {
        throw new Error(
          `Existing PR #${checkpointPullRequest.number} targets ${checkpointPullRequest.baseBranch}, but issue #${issue.number} must deliver to ${deliveryTargetBranch}; refusing cross-target resume`,
        );
      }
      const frozenTarget = parentRemediation
        ? { ...runTargetForLane(lane, effectiveOrchestration.productionTarget), targetBranch: parentRemediation.parentBranch }
        : runTargetForLane(lane, effectiveOrchestration.productionTarget);
      const recoveredRun = {
        schema: "forgedock.run/v1" as const, runId: resumeRunId, workflow: "work-on" as const, subject,
        state: admission.state,
        attempt: admission.checkpoint === "build" ? Math.max(1, priorVerificationRepairAttempts) : 1,
        version: 0,
        ...frozenTarget,
        createdAt: intentArtifact.createdAt, updatedAt: checkpointArtifact?.createdAt ?? packet.createdAt,
        artifactIds,
        scopeManifest: recoveredScopeManifest,
        ...(admission.state === "blocked" && checkpointArtifact?.kind === "Outcome" ? { blockedReason: checkpointArtifact.payload.reason } : {}),
        ...(failedOutcome?.kind === "Outcome" && failedOutcome.payload.status === "failed" ? { failure: failedOutcome.payload.reason } : {}),
      };
      let run = await store.load(resumeRunId);
      if (!run) {
        await store.create(recoveredRun);
        run = recoveredRun;
      } else if (run.state !== admission.state
        || (admission.state === "blocked" && run.blockedReason !== recoveredRun.blockedReason)
        || JSON.stringify(run.scopeManifest ?? null) !== JSON.stringify(recoveredScopeManifest)) {
        process.stderr.write(`warning: rebuilding divergent local run ${resumeRunId} state or scope (${run.state}) from durable GitHub authority (${admission.state})\n`);
        await store.rebuildRun(recoveredRun);
        run = recoveredRun;
      } else if (run.targetBranch) {
        assertRunFollowsLane(run, lane, effectiveOrchestration.productionTarget);
      } else {
        run = { ...run, ...frozenTarget, scopeManifest: recoveredScopeManifest };
      }

      const git = new GitWorktreeManager(process.cwd());
      const verifier = new ProcessVerificationRunner();
      let workspace;
      let outcome: DurableArtifact<"Outcome"> | undefined;
      if (admission.checkpoint === "build" || admission.checkpoint === "publication" || admission.checkpoint === "remediation" || admission.checkpoint === "completion") {
        const recoveryInput = {
          runId: resumeRunId,
          issue: issue.number,
          baseRef: recoveryBaseRef,
          ...(admission.checkpoint !== "build" && retainedBuildResult?.payload.baseSha
            ? { baseSha: retainedBuildResult.payload.baseSha }
            : {}),
        };
        if (admission.checkpoint === "completion") {
          try { workspace = await git.recover(recoveryInput); }
          catch (error) { process.stderr.write(`warning: completion will proceed without retained-worktree cleanup: ${error instanceof Error ? error.message : String(error)}\n`); }
        } else {
          workspace = await git.recover(recoveryInput);
        }
      } else {
        outcome = latestArtifactOfKind(runArtifacts, "Outcome");
        if (!outcome || outcome.payload.status !== "blocked" || !outcome.payload.failureEvidence) {
          throw new Error(`Run ${resumeRunId} does not contain complete retained verification evidence`);
        }
        workspace = {
          path: outcome.payload.failureEvidence.workspacePath,
          branch: outcome.payload.failureEvidence.branch,
          baseRef: recoveryBaseRef,
          ...(outcome.payload.failureEvidence.baseSha ? { baseSha: outcome.payload.failureEvidence.baseSha } : {}),
        };
        if (!existsSync(workspace.path)) throw new Error(`Recovery workspace is unavailable: ${workspace.path}`);
      }
      const verification = admission.checkpoint === "completion" ? [] : discoverVerificationCommands(process.cwd(), recoveryBaseRef);
      const baselineChecks = admission.checkpoint === "publication" || admission.checkpoint === "completion"
        ? undefined
        : await collectBaselineChecks({ git, verifier, verification, issue: issue.number, runId: resumeRunId, baseRef: recoveryBaseRef });
      process.stdout.write(`${statusGlyph("active", mode)} Resuming ${resumeRunId} from its durable ${admission.checkpoint} checkpoint; completed semantic phases will not replay\n`);
      const common = {
        run, intent: intentArtifact, investigation, packet, workspace: workspace!,
        ...(admission.checkpoint === "build" && latestOutcome?.payload.status === "blocked" && latestOutcome.payload.failureEvidence
          ? {
            priorVerificationFailure: latestOutcome,
            priorVerificationRepairAttempts,
            ...(retainedBuildResult && priorVerdict ? { repairContext: [retainedBuildResult, priorVerdict] } : {}),
          }
          : admission.checkpoint === "verification" && verificationAdjudication !== undefined
            ? { priorVerificationRepairAttempts }
            : {}),
        baseBranch: durableTargetBranch, verification,
        ...(baselineChecks !== undefined ? { baselineChecks } : {}),
        priorRemediationCycles,
        scopeExpansion: parentRemediation ? "recursive" : effectiveOrchestration.scopeExpansion,
        maxRemediationCycles: effectiveOrchestration.maxRemediationCycles,
        maxRemediationDepth: parentRemediation?.maxRemediationDepth ?? effectiveOrchestration.maxRemediationDepth,
        maxRemediationChildren: parentRemediation?.maxRemediationChildren ?? effectiveOrchestration.maxRemediationChildren,
        remediationDepth: parentRemediation?.remediationDepth ?? 0,
        ...(parentRemediation !== undefined ? { parentRemediation } : {}),
        subjectEvidence,
        ...(effectiveOrchestration.productionTarget !== undefined ? { productionTarget: effectiveOrchestration.productionTarget } : {}),
        ...(durableBatchMembers.length ? { batchMembers: durableBatchMembers } : {}),
        ...(durableBatchMemberContracts.length ? { batchMemberContracts: durableBatchMemberContracts } : {}),
        autoMerge,
        ...(maxReviewSpecialists !== undefined ? { maxReviewSpecialists } : {}),
        ...(provider !== undefined ? { provider } : {}),
        ...(model !== undefined ? { model } : {}),
        ...planning,
        signal: leaseController.signal,
      };
      const dependencies = { runtime, artifacts, runs, git, verifier, host: github, telemetry: store, leaseGuard, onAgentEvent };
      const result = admission.checkpoint === "completion"
        ? await resumeCompletionWorkOn({
          run,
          verdict: priorVerdict!,
          pullRequest: checkpointPullRequest!,
          ...(workspace ? { workspace } : {}),
          ...(durableBatchMembers.length ? { batchMembers: durableBatchMembers } : {}),
          ...(durableBatchMemberContracts.length ? { batchMemberContracts: durableBatchMemberContracts } : {}),
          autoMerge,
          ...(effectiveOrchestration.productionTarget !== undefined ? { productionTarget: effectiveOrchestration.productionTarget } : {}),
        }, dependencies)
        : admission.checkpoint === "build"
          ? await resumeBuildWorkOn(common, dependencies)
          : admission.checkpoint === "publication"
            ? await resumePublicationWorkOn({
              ...common,
              buildResult: retainedBuildResult!,
              ...(priorVerdict ? { priorVerdict } : {}),
            }, dependencies)
            : admission.checkpoint === "remediation"
              ? remediationCheckpoint?.kind === "RemediationBlocked"
                ? await (async () => {
                  let checkpoint = remediationCheckpoint;
                  const supervisor = new RemediationSupervisor({ host: github, artifacts, runs });
                  if (checkpoint.payload.status === "awaiting-dispatch") {
                    const dispatched = await supervisor.resumeAwaiting({
                      checkpoint,
                      parentPullRequest: checkpointPullRequest!,
                    });
                    checkpoint = dispatched.checkpoint;
                  }
                  if (checkpoint.payload.status === "children-running") {
                    const childOutcomes = (await Promise.all(checkpoint.payload.childIssues.map(async (childIssue) =>
                      authoritativeArtifacts.list({ repo: issue.repo, issue: childIssue })))).flat()
                      .filter((artifact): artifact is DurableArtifact<"Outcome"> => artifact.kind === "Outcome" && artifact.payload.status === "merged");
                    checkpoint = await supervisor.reconcileChildren({ checkpoint, childOutcomes, parentPullRequest: checkpointPullRequest! });
                  }
                  if (checkpoint.payload.status !== "ready-to-resume") {
                    throw new Error(`Recursive remediation checkpoint ${checkpoint.payload.checkpointKey} is ${checkpoint.payload.status}; child Outcomes or parent branch proof are still pending`);
                  }
                  return resumeExpandedReviewWorkOn({
                    ...common,
                    scopeExpansion: "recursive",
                    remediationDepth: checkpoint.payload.remediationDepth,
                    maxRemediationDepth: checkpoint.payload.maxRemediationDepth,
                    maxRemediationChildren: checkpoint.payload.maxRemediationChildren ?? effectiveOrchestration.maxRemediationChildren,
                    priorVerdict: priorVerdict!,
                    checkpoint,
                    pullRequest: checkpointPullRequest!,
                  }, dependencies);
                })()
                : await resumeReviewWorkOn({
                  ...common,
                  buildResult: retainedBuildResult!,
                  priorVerdict: priorVerdict!,
                  pullRequest: checkpointPullRequest!,
                }, dependencies)
              : await resumeWorkOn({ ...common, outcome: outcome! }, dependencies);
      const suffix = result.awaitingHuman ? ` · awaiting human merge at ${result.pullRequest?.url ?? "PR"}` : "";
      const presentation = runStatePresentation(result.run.state);
      process.stdout.write(`${statusGlyph(result.awaitingHuman ? "active" : presentation.glyph, mode)} Resumed run ${result.run.runId} · ${result.awaitingHuman ? "awaiting human merge" : presentation.label}${suffix}\n`);
      if (result.run.state !== "completed") process.exitCode = 2;
      return;
    }

    if (through === "investigate") {
      process.stdout.write(`${statusGlyph("active", mode)} Investigating ${issue.repo}#${issue.number} — ${issue.title}\n`);
      const result = await investigateWorkItem({
        intent, priorArtifacts, cwd: process.cwd(), target: runTargetForLane(lane, effectiveOrchestration.productionTarget),
        scopeHints: {
          affectedFiles: affectedFilesFromIssueBody(issue.body),
          metadataRoots: STANDARD_SCOPE_METADATA_ROOTS,
        },
        ...(provider !== undefined ? { provider } : {}),
        ...(model !== undefined ? { model } : {}),
        ...planning,
        signal: leaseController.signal,
      }, { runtime, artifacts, runs, decomposer: github, onAgentEvent });
      const finalized = !dryRun && result.run.state === "invalid" && result.outcome?.payload.status === "invalid"
        ? await completeInvalidWorkItem({ run: result.run, investigation: result.investigation, outcome: result.outcome }, { host: github, artifacts })
        : result;
      process.stdout.write(`\n${renderArtifactMarkdown(result.investigation)}\n\n`);
      const presentation = runStatePresentation(finalized.run.state);
      process.stdout.write(`${statusGlyph(presentation.glyph, mode)} Investigation committed · ${presentation.label}${dryRun ? " · dry run (not published)" : ""}\n`);
      return;
    }

    const verification = verificationPolicy ?? discoverVerificationCommands(process.cwd(), baseRef);
    const git = new GitWorktreeManager(process.cwd());
    const verifier = new ProcessVerificationRunner();
    const baselineChecks = await collectBaselineChecks({ git, verifier, verification, issue: issue.number, runId, baseRef });
    process.stdout.write(`${statusGlyph("active", mode)} Running full workflow for ${issue.repo}#${issue.number}\n`);
    const result = await executeWorkOn({
      intent,
      priorArtifacts,
      repoPath: process.cwd(),
      lane,
      scopeHints: {
        affectedFiles: affectedFilesFromIssueBody(issue.body),
        metadataRoots: STANDARD_SCOPE_METADATA_ROOTS,
      },
      verification,
      baselineChecks,
      subjectEvidence,
      ...(batchMembers.length ? { batchMembers } : {}),
      ...(batchMemberContracts.length ? { batchMemberContracts } : {}),
      autoMerge,
      ...(effectiveOrchestration.productionTarget !== undefined ? { productionTarget: effectiveOrchestration.productionTarget } : {}),
      scopeExpansion: parentRemediation ? "recursive" : effectiveOrchestration.scopeExpansion,
      maxRemediationCycles: effectiveOrchestration.maxRemediationCycles,
      maxRemediationDepth: parentRemediation?.maxRemediationDepth ?? effectiveOrchestration.maxRemediationDepth,
      maxRemediationChildren: parentRemediation?.maxRemediationChildren ?? effectiveOrchestration.maxRemediationChildren,
      remediationDepth: parentRemediation?.remediationDepth ?? 0,
      ...(parentRemediation !== undefined ? { parentRemediation } : {}),
      ...(maxReviewSpecialists !== undefined ? { maxReviewSpecialists } : {}),
      ...(provider !== undefined ? { provider } : {}),
      ...(model !== undefined ? { model } : {}),
      ...planning,
      signal: leaseController.signal,
    }, {
      runtime, artifacts, runs,
      git,
      verifier,
      host: github,
      telemetry: store,
      onAgentEvent,
    });
    const suffix = result.awaitingHuman ? ` · awaiting human merge at ${result.pullRequest?.url ?? "PR"}` : "";
    const presentation = runStatePresentation(result.run.state);
    process.stdout.write(`${statusGlyph(result.awaitingHuman ? "active" : presentation.glyph, mode)} Run ${result.run.runId} · ${result.awaitingHuman ? "awaiting human merge" : presentation.label}${suffix}\n`);
    if (result.run.state !== "completed") process.exitCode = 2;
  } finally {
    if (leaseHeartbeat) clearInterval(leaseHeartbeat);
    if (leaseToken) { try { store.release(leaseItem, leaseToken); } catch { /* continuity failure deliberately retains the row */ } }
    await runtime.close();
    store.close();
  }
}

async function resetIssue(argv: string[]): Promise<void> {
  const issueArg = argv.find((arg) => !arg.startsWith("-"));
  if (!issueArg || !/^\d+$/.test(issueArg)) throw new Error("Usage: forgedock-next reset <issue-number> [--repo owner/repo] [--reason text]");
  const github = new GitHubClient(process.cwd());
  const issue = await github.getIssue(Number(issueArg), option(argv, "--repo"));
  const repository = new GitHubArtifactRepository(github);
  const all = await repository.list({ repo: issue.repo, issue: issue.number });
  const latestRun = latestDeliveryRunArtifacts(all);
  if (!latestRun) {
    await github.clearWorkflowLabels(issue.repo, issue.number);
    process.stdout.write(`Reset ${issue.repo}#${issue.number}; no durable run existed.\n`);
    return;
  }
  const reason = option(argv, "--reason") ?? "User-requested pipeline reset before a clean rerun; prior comments remain durable audit history.";
  const priorOutcome = latestArtifactOfKind(latestRun.artifacts, "Outcome");
  if (priorOutcome?.payload.status !== "abandoned") {
    await repository.append(createArtifact({
      kind: "Outcome", runId: latestRun.runId, subject: { repo: issue.repo, issue: issue.number },
      producer: { role: "controller", runtime: "forgedock" },
      payload: { status: "abandoned", reason, childIssues: [] },
    }));
  }
  const verdict = latestArtifactOfKind(latestRun.artifacts, "ReviewVerdict");
  const buildResult = latestArtifactOfKind(latestRun.artifacts, "BuildResult");
  const pr = verdict?.subject.pr
    ? await github.getPullRequest(issue.repo, verdict.subject.pr)
    : buildResult ? await github.findOpenPullRequest(issue.repo, buildResult.payload.branch) : undefined;
  if (pr?.state === "OPEN") await github.closePullRequest(issue.repo, pr.number, reason);
  await github.clearWorkflowLabels(issue.repo, issue.number);
  process.stdout.write(`Reset ${issue.repo}#${issue.number}; run ${latestRun.runId} is abandoned and audit comments are retained.\n`);
}

async function promote(argv: string[]): Promise<void> {
  requirePiNodeVersion();
  const resumeId = option(argv, "--resume");
  const sourceOption = option(argv, "--from");
  const targetOption = option(argv, "--to");
  const provider = option(argv, "--provider");
  const model = option(argv, "--model");
  const outputMode = mode;
  const authorizeCreation = argv.includes("--confirm");
  const authorizeMerge = argv.includes("--authorize-merge");
  const cancel = argv.includes("--cancel");
  const cancellationReason = option(argv, "--reason");
  if (authorizeMerge && !authorizeCreation && !resumeId) {
    throw new Error("--authorize-merge requires --confirm for a fresh promotion; use --resume <promotion-id> for an existing PR");
  }
  if (cancel && !resumeId) throw new Error("--cancel requires --resume <promotion-id>");
  if (cancel && (authorizeCreation || authorizeMerge)) throw new Error("--cancel cannot be combined with creation or merge authorization");
  const configured = readForgeDockConfig(process.cwd());
  const effective = resolveOrchestrationConfig(configured);
  const { SqliteRepositories } = await import("../adapters/sqlite/sqlite-repositories.js");
  const store = new SqliteRepositories(join(process.cwd(), ".forgedock", "state.db"));
  const resumeRecord = resumeId ? await store.loadPromotion(resumeId) : undefined;
  if (resumeId && !resumeRecord) throw new Error(`Unknown promotion ${resumeId}`);
  const production = resumeRecord?.mode === "production" || argv.includes("--production");
  const promotionMode = resumeRecord?.mode ?? (production ? "production" as const : "feature" as const);
  const sourceBranch = sourceOption ?? resumeRecord?.sourceBranch ?? (production ? effective.featurePromotionTarget : undefined);
  const targetBranch = targetOption ?? resumeRecord?.targetBranch ?? (production ? effective.productionTarget : effective.featurePromotionTarget);
  if (!resumeId && (!sourceBranch || !targetBranch)) {
    throw new Error(production
      ? "Production promotion requires configured feature_promotion_target and production_target (or --from/--to)"
      : "Feature promotion requires --from <milestone/branch> and configured feature_promotion_target (or --to)");
  }
  if (sourceBranch && targetBranch && sourceBranch === targetBranch) throw new Error("Promotion source and target branches must differ");
  const host = new GitHubClient(process.cwd(), store);
  const repository = await host.getRepository(option(argv, "--repo"));
  const artifacts = new CachedArtifactRepository(new GitHubArtifactRepository(host), store);
  const targetForChecks = targetBranch ?? resumeRecord?.targetBranch;
  if (!targetForChecks) throw new Error("Promotion verification requires a resolved target branch");
  const verification = resumeRecord || cancel
    ? []
    : discoverVerificationCommands(process.cwd(), `origin/${targetForChecks}`);
  const runtime = createCliRuntime({
    ...(provider !== undefined ? { provider } : {}),
    ...(model !== undefined ? { model } : {}),
  }, store);
  try {
    if (authorizeCreation || authorizeMerge || resumeId) {
      await preflightRuntime(runtime, {
        ...(provider !== undefined ? { provider } : {}),
        ...(model !== undefined ? { model } : {}),
        role: "reviewer",
      });
    }
    const result = await promoteBranch({
      repository: repository.repo,
      mode: promotionMode,
      ...(sourceBranch !== undefined ? { sourceBranch } : {}),
      ...(targetBranch !== undefined ? { targetBranch } : {}),
      ...(effective.featurePromotionTarget !== undefined ? { configuredPromotionTarget: effective.featurePromotionTarget } : {}),
      ...(effective.productionTarget !== undefined ? { configuredProductionTarget: effective.productionTarget } : {}),
      cwd: process.cwd(),
      verification,
      ...(authorizeCreation ? { authorizeCreation: true } : {}),
      ...(authorizeMerge ? { authorizeMerge: true } : {}),
      ...(resumeId !== undefined ? { promotionId: resumeId } : {}),
      ...(provider !== undefined ? { provider } : {}),
      ...(model !== undefined ? { model } : {}),
      ...(cancel ? { cancel: true } : {}),
      ...(cancellationReason !== undefined ? { cancellationReason } : {}),
    }, {
      host,
      promotions: store,
      artifacts,
      runs: store,
      workspaces: new GitWorktreeManager(process.cwd()),
      verifier: new ProcessVerificationRunner(),
      ...(configuredMaxReviewSpecialists() !== undefined ? { maxReviewSpecialists: configuredMaxReviewSpecialists()! } : {}),
      runtime,
      onAgentEvent: (event) => writeAgentEvent(event),
    });
    if (argv.includes("--json")) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    else {
      const pullRequest = result.pullRequest ? ` · PR ${result.pullRequest.url}` : "";
      process.stdout.write(`${statusGlyph(result.phase === "completed" ? "passed" : result.phase === "failed" ? "failed" : "active", outputMode)} Promotion ${result.promotionId} · ${result.sourceBranch} → ${result.targetBranch} · ${result.phase}${pullRequest}\n`);
      if (result.phase === "planned") process.stdout.write("Preview only. Re-run with --confirm to create the promotion PR.\n");
      if (result.phase === "awaiting-merge") {
        let mergeBlocker: string | undefined;
        if (result.mode === "production") {
          if (!host.isBranchProtected) {
            mergeBlocker = `Production target ${result.targetBranch} has no typed branch-protection check`;
          } else {
            try {
              if (!await host.isBranchProtected(result.repository, result.targetBranch)) {
                mergeBlocker = `Production target ${result.targetBranch} is not protected`;
              }
            } catch (error) {
              mergeBlocker = `Production target protection could not be verified: ${error instanceof Error ? error.message : String(error)}`;
            }
          }
        }
        if (mergeBlocker) {
          process.stdout.write(`Promotion status: blocked-for-merge\nReason: ${mergeBlocker}. The PR remains open for review; protect the target before authorizing merge.\n`);
        } else {
          process.stdout.write("Review passed. Re-run with --resume <promotion-id> --authorize-merge to merge the exact reviewed SHA.\n");
        }
      }
    }
    if (result.phase !== "completed" && result.phase !== "awaiting-merge" && result.phase !== "planned" && result.phase !== "cancelled") process.exitCode = 2;
  } catch (error) {
    if (error instanceof PromotionExecutionError) {
      process.stderr.write(`${statusGlyph("failed", outputMode)} Promotion ${error.record.promotionId} · ${error.record.phase}: ${error.message}\n`);
    }
    throw error;
  } finally {
    await runtime.close();
    store.close();
  }
}

async function reviewPr(argv: string[]): Promise<void> {
  requirePiNodeVersion();
  const prArg = argv.find((arg) => !arg.startsWith("-"));
  if (!prArg || !/^\d+$/.test(prArg)) throw new Error("Usage: forgedock-next review-pr <pr-number> [--repo owner/repo] [--issue number]");
  process.stdout.write(`${renderHeader({ subtitle: "review-pr · fresh context · SHA anchored" })}\n\n`);
  let github = new GitHubClient(process.cwd());
  const localRepository = await github.getRepository();
  const repo = option(argv, "--repo") ?? localRepository.repo;
  if (repo !== localRepository.repo) throw new Error(`Current checkout is ${localRepository.repo}; review workspace for ${repo} is unavailable here`);
  const issueValue = option(argv, "--issue");
  if (issueValue && !/^\d+$/.test(issueValue)) throw new Error("--issue must be a positive integer");
  const provider = option(argv, "--provider");
  const model = option(argv, "--model");
  const maxReviewSpecialists = configuredMaxReviewSpecialists();
  const { SqliteRepositories } = await import("../adapters/sqlite/sqlite-repositories.js");
  const reviewWitness = createConfiguredLeaseWitness(process.cwd());
  if (!reviewWitness) throw new Error("Lease witness configuration is required for CLI repository construction; token-only local leases are disabled");
  const store = new SqliteRepositories(join(process.cwd(), ".forgedock", "state.db"), { witness: reviewWitness });
  github = new GitHubClient(process.cwd(), store);
  const artifacts = new CachedArtifactRepository(new GitHubArtifactRepository(github), store);
  // Standalone review is advisory and read-only. Its operational state must not
  // replace the issue delivery controller's workflow-label projection.
  const runs = store;
  const runtime = createCliRuntime({
    ...(provider !== undefined ? { provider } : {}),
    ...(model !== undefined ? { model } : {}),
  }, store);
  try {
    await preflightRuntime(runtime, {
      ...(provider !== undefined ? { provider } : {}),
      ...(model !== undefined ? { model } : {}),
      role: "reviewer",
    });
    const result = await reviewExistingPullRequest({
      repo, pr: Number(prArg),
      ...(issueValue !== undefined ? { issue: Number(issueValue) } : {}),
      ...(provider !== undefined ? { provider } : {}),
      ...(model !== undefined ? { model } : {}),
      ...(maxReviewSpecialists !== undefined ? { maxReviewSpecialists } : {}),
    }, {
      runtime, host: github, workspaces: new GitWorktreeManager(process.cwd()), artifacts, runs,
      onAgentEvent: (event) => writeAgentEvent(event),
    });
    process.stdout.write(`\n${renderArtifactMarkdown(result.verdict)}\n\n`);
    const approved = result.verdict.payload.disposition === "approve";
    process.stdout.write(`${statusGlyph(approved ? "passed" : "blocked", mode)} Review ${result.verdict.payload.disposition} at ${result.verdict.payload.headSha}\n`);
    if (!approved) process.exitCode = 2;
  } finally {
    await runtime.close();
    store.close();
  }
}

async function orchestrate(argv: string[]): Promise<void> {
  requirePiNodeVersion();
  const issueNumbers = parseOrchestrationIssueNumbers(argv);
  if (!issueNumbers.length) throw new Error("Usage: forgedock-next orchestrate <issue>... [--batching aggressive|conservative|none] [--priority P0,P1] [--milestone TITLE|--no-milestone] [--scope-expansion scope-locked|recursive] [--max-remediation-cycles N] [--max-remediation-depth N] [--max-remediation-children N] [--max-parallel N] [--planning-model provider/model] [--planning-thinking high] [--dry-run|--confirm|--auto] [--rerun]");
  const config = readForgeDockConfig(process.cwd());
  const maxParallelValue = option(argv, "--max-parallel");
  const remediationDepthValue = option(argv, "--max-remediation-depth");
  const remediationChildrenValue = option(argv, "--max-remediation-children");
  const requestedBatching = option(argv, "--batching");
  if (requestedBatching !== undefined && !["aggressive", "conservative", "none"].includes(requestedBatching)) throw new Error("--batching must be aggressive, conservative, or none");
  const effective = resolveOrchestrationConfig(config, {
    ...(requestedBatching ? { batchingPolicy: requestedBatching as "aggressive" | "conservative" | "none" } : {}),
    ...(maxParallelValue ? { maxParallel: Number(maxParallelValue) } : {}),
    ...(option(argv, "--scope-expansion") ? { scopeExpansion: option(argv, "--scope-expansion") as "scope-locked" | "recursive" } : {}),
    ...(option(argv, "--max-remediation-cycles") ? { maxRemediationCycles: Number(option(argv, "--max-remediation-cycles")) } : {}),
    ...(remediationDepthValue !== undefined ? { maxRemediationDepth: Number(remediationDepthValue) } : {}),
    ...(remediationChildrenValue !== undefined ? { maxRemediationChildren: Number(remediationChildrenValue) } : {}),
  });
  if (maxParallelValue !== undefined && (!/^\d+$/.test(maxParallelValue) || Number(maxParallelValue) < 1)) throw new Error("--max-parallel must be a positive integer");
  if (remediationDepthValue !== undefined && !/^\d+$/.test(remediationDepthValue)) throw new Error("--max-remediation-depth must be a non-negative integer");
  if (remediationChildrenValue !== undefined && (!/^\d+$/.test(remediationChildrenValue) || Number(remediationChildrenValue) < 1)) throw new Error("--max-remediation-children must be a positive integer");
  const autoMerge = commandAutoMerge(argv);
  const dispatchMode = argv.includes("--confirm") || argv.includes("--auto") ? "authorized" : effective.dispatchMode;
  const dispatchAuthorized = !argv.includes("--dry-run") && (dispatchMode === "authorized" || dispatchMode === "auto");
  process.stdout.write(`${renderHeader({ subtitle: "orchestrate · dependencies · claims · bounded concurrency" })}\n\n`);
  let github = new GitHubClient(process.cwd());
  const repository = await github.getRepository();
  const baseItems = loadOrchestrationItems(issueNumbers, repository.repo);
  const readAuthoritativeItems = async (allowMissingMilestoneBranch = !dispatchAuthorized) => {
    const issueSnapshots = await Promise.all(baseItems.map((item) => github.getIssue(item.issue, repository.repo)));
    let milestoneBranches = issueSnapshots.some((issue) => issue.milestone)
      ? await github.listBranches(repository.repo, "milestone/")
      : [];
    if (!allowMissingMilestoneBranch && issueSnapshots.some((issue) => issue.milestone)) {
      await provisionMissingMilestoneBranches(issueSnapshots, repository.defaultBranch, github);
      milestoneBranches = await github.listBranches(repository.repo, "milestone/");
    }
    const routedIssues = new Map<number, { issue: (typeof issueSnapshots)[number]; lane: IssueLane }>();
    for (const issue of issueSnapshots) {
      routedIssues.set(issue.number, {
        issue,
        lane: classifyIssueLane(issue, repository.defaultBranch, milestoneBranches, effective.fastLaneTarget, effective.featurePromotionTarget, effective.productionTarget, {
          ...(allowMissingMilestoneBranch ? { allowMissingMilestoneBranch: true } : {}),
        }),
      });
    }
    await Promise.all([...new Set([...routedIssues.values()]
      .map(({ lane }) => lane)
      .filter((lane) => lane.resolution !== "planned-canonical")
      .map((lane) => lane.targetBranch))]
      .map((branch) => github.getBranchHead(repository.repo, branch)));
    const items: BatchableWorkItem[] = baseItems.map((item) => {
      const observed = requiredIssueRoute(routedIssues, item.issue).issue;
      const lane = requiredIssueRoute(routedIssues, item.issue).lane;
      const priority = observed.labels.find((label) => /^(?:priority:)?P[0-3]$/i.test(label))?.slice(-2).toUpperCase();
      return {
        ...item,
        repository: repository.repo,
        targetBranch: lane.targetBranch,
        lane: lane.kind,
        ...(lane.kind === "feature" && lane.promotionTarget !== undefined ? { promotionTarget: lane.promotionTarget } : {}),
        ...(effective.productionTarget !== undefined ? { productionTarget: effective.productionTarget } : {}),
        ...(observed.milestone ? { milestone: observed.milestone } : {}),
        labels: observed.labels,
        title: observed.title,
        summary: observed.body.slice(0, 4_000),
        affectedFiles: affectedFilesFromIssueBody(observed.body),
        riskClass: inferBatchRiskClass(observed.title, observed.body, observed.labels),
        ...(priority ? { urgencyTier: ["P0", "P1"].includes(priority) ? "urgent" as const : "normal" as const } : {}),
      };
    });
    return { items, routedIssues };
  };
  let { items, routedIssues } = await readAuthoritativeItems();
  const priorityOption = option(argv, "--priority");
  const milestoneOption = option(argv, "--milestone");
  const assemblyOptions = {
    policy: effective.batchingPolicy,
    maxBatchSize: effective.maxBatchSize,
    maxSensitiveBatchSize: effective.maxSensitiveBatchSize,
    ...(priorityOption !== undefined ? { priorities: priorityOption.split(",") } : {}),
    ...(milestoneOption !== undefined ? { milestone: milestoneOption } : {}),
    ...(argv.includes("--no-milestone") ? { noMilestone: true } : {}),
  };
  let assembly = assembleWorkUnits(items, assemblyOptions);
  const virtualBase = Math.max(...issueNumbers) + 1;
  const virtualBatches = assembly.groups.map((group, index) => ({ groupId: group.id, issue: virtualBase + index, title: `Proposed batch ${index + 1}`, summary: "Proposed batch" }));
  const proposed = materializeClaimDependencies(contractBatchGroups(assembly.selected, assembly.groups, virtualBatches));
  if (argv.includes("--dry-run") || dispatchMode === "preview") {
    process.stdout.write(`ForgeDock orchestration preview · dispatch_mode=${effective.dispatchMode}\n`);
    for (const item of proposed.items) {
      const route = routedIssues.get(item.issue);
      const lane = route?.lane;
      const target = item.targetBranch ?? lane?.targetBranch ?? "unknown-target";
      process.stdout.write(`${item.id} · ${item.lane ?? lane?.kind ?? "unknown-lane"} → ${target} · depends [${item.dependencies.join(", ") || "none"}] · claims [${item.claims.join(", ")}]\n`);
    }
    process.stdout.write(`batching=${assembly.policy.policy} groups=${assembly.groups.length} ungrouped=${assembly.ungrouped.length} excluded=${assembly.excluded.length}\n`);
    process.stdout.write("Dispatch is disabled in preview mode. Re-run with --confirm/--auto or configure dispatch_mode: confirm|auto.\n");
    return;
  }
  if (dispatchMode !== "authorized" && dispatchMode !== "confirm" && dispatchMode !== "auto") throw new Error(`Unsupported orchestration dispatch mode: ${dispatchMode}`);
  if (dispatchMode === "confirm" && !argv.includes("--confirm")) throw new Error("orchestrate requires --confirm after the authoritative work-unit proposal (use --dry-run to inspect it)");
  // Confirmation is a boundary, not a freshness grant. Re-read every selected
  // issue before freezing the DAG so ungrouped work cannot dispatch stale body,
  // label, state, or lane evidence.
  ({ items, routedIssues } = await readAuthoritativeItems());
  // Rebuild the pure proposal from the authoritative confirmation read. The
  // initial preview is not a freshness grant and must not carry stale groups,
  // claims, or route metadata into materialization.
  assembly = assembleWorkUnits(items, assemblyOptions);
  const provider = option(argv, "--provider");
  const model = option(argv, "--model");
  const planning = configuredPlanningOptions(argv);
  const { SqliteRepositories } = await import("../adapters/sqlite/sqlite-repositories.js");
  const orchestrationWitness = createConfiguredLeaseWitness(process.cwd());
  if (!orchestrationWitness) throw new Error("Lease witness configuration is required before orchestrate dispatch; token-only local leases are disabled");
  const store = new SqliteRepositories(join(process.cwd(), ".forgedock", "state.db"), { witness: orchestrationWitness });
  github = new GitHubClient(process.cwd(), store);
  const runtime = createCliRuntime({
    ...(provider !== undefined ? { provider } : {}),
    ...(model !== undefined ? { model } : {}),
    ...planning,
  }, store);
  const baseArtifacts = new CachedArtifactRepository(new GitHubArtifactRepository(github), store);
  const artifacts = activeObserver
    ? observeArtifactRepository(baseArtifacts, activeObserver, { repository: repository.repo })
    : baseArtifacts;
  const baseRuns = projectRunsToGitHub(store, github);
  const git = new GitWorktreeManager(process.cwd());
  const verifier = new ProcessVerificationRunner();
  try {
    await preflightRuntime(runtime, {
      ...(provider !== undefined ? { provider } : {}),
      ...(model !== undefined ? { model } : {}),
    });
    // Validate the frozen verification policy for every authoritative lane before any batch issue is created.
    for (const targetBranch of new Set([...routedIssues.values()].map(({ lane }) => lane.targetBranch))) {
      discoverVerificationCommands(process.cwd(), `origin/${targetBranch}`);
    }
    const materializedResult = assembly.groups.length
      ? await materializeBatchGroups({
        repo: repository.repo,
        groups: assembly.groups,
        items,
        host: github,
        expectedRoutes: new Map([...routedIssues.entries()].map(([number, value]) => [number, {
          targetBranch: value.lane.targetBranch,
          lane: value.lane.kind,
          ...(value.lane.kind === "feature" && value.lane.promotionTarget !== undefined ? { promotionTarget: value.lane.promotionTarget } : {}),
          ...(effective.productionTarget !== undefined ? { productionTarget: effective.productionTarget } : {}),
        }])),      })
      : { groups: [], materialized: [], validatedItems: items };
    const contracted = materializedResult.validatedItems;
    for (const materialized of materializedResult.materialized) {
      const group = materializedResult.groups.find((candidate) => candidate.id === materialized.groupId);
      const member = group?.members[0];
      if (group && member) {
        const lane = requiredIssueRoute(routedIssues, member.issue).lane;
        const batchIssue = await github.getIssue(materialized.issue, repository.repo);
        routedIssues.set(materialized.issue, { issue: batchIssue, lane });
      }
    }
    const scheduleItems = materializeClaimDependencies(contracted);
    const orchestrationId = `dag_${crypto.randomUUID()}`;
    setAgentEventObservationIdentity({
      repository: repository.repo,
      orchestrationId,
      ...(process.env.FORGEDOCK_CONTROLLER_TASK_ID ? { controllerTaskId: process.env.FORGEDOCK_CONTROLLER_TASK_ID } : {}),
    });
    const runs = activeObserver
      ? observeRunRepository(baseRuns, activeObserver, { repository: repository.repo, orchestrationId })
      : baseRuns;
    const orchestrationCreatedAt = new Date().toISOString();
    let orchestrationRecord: OrchestrationRecord = {
      schema: "forgedock.orchestration/v1",
      orchestrationId,
      repository: repository.repo,
      requestedIssueNumbers: [...issueNumbers],
      issueNumbers: [...issueNumbers],
      maxParallel: effective.maxParallel,
      autoMerge,
      ...(effective.productionTarget !== undefined ? { productionTarget: effective.productionTarget } : {}),
      status: "running",
      createdAt: orchestrationCreatedAt,
      updatedAt: orchestrationCreatedAt,
      serializationEdges: scheduleItems.edges.map((edge) => ({
        predecessor: edge.predecessor,
        successor: edge.successor,
        overlappingClaims: [...edge.overlappingClaims],
      })),
      nodes: scheduleItems.items.map((item): OrchestrationNodeRecord => ({
        id: item.id,
        issue: item.issue,
        priority: item.priority,
        dependencies: [...item.dependencies],
        claims: [...item.claims],
        ...(item.promotionTarget !== undefined ? { promotionTarget: item.promotionTarget } : {}),
        ...(item.productionTarget !== undefined ? { productionTarget: item.productionTarget } : {}),
        ...(item.affectedFiles ? { affectedFiles: [...item.affectedFiles] } : {}),
        ...(item.memberIssues ? { memberIssues: [...item.memberIssues] } : {}),
        ...(item.title ? { title: item.title } : {}),
        ...(item.summary ? { summary: item.summary } : {}),
        status: "queued",
        childRunIds: [],
      })),
    };
    await store.createOrchestration(orchestrationRecord);
    if (activeObserver) {
      await activeObserver.emit({
        producer: activeObserver.producer,
        identity: { repository: repository.repo, orchestrationId },
        source: "workflow",
        channel: "lifecycle",
        kind: "orchestration.created",
        payload: { status: orchestrationRecord.status, nodeCount: orchestrationRecord.nodes.length },
      });
    }
    let orchestrationPersistQueue = Promise.resolve();
    const persistOrchestration = (next: OrchestrationRecord): void => {
      orchestrationRecord = next;
      orchestrationPersistQueue = orchestrationPersistQueue.then(() => store.saveOrchestration(next));
    };
    const updateOrchestrationNode = (nodeId: string, patch: Partial<OrchestrationNodeRecord>): void => {
      persistOrchestration({
        ...orchestrationRecord,
        updatedAt: new Date().toISOString(),
        nodes: orchestrationRecord.nodes.map((node) => node.id === nodeId ? { ...node, ...patch } : node),
      });
    };
    const outcomes = new Map<string, string>();
    const skipped = new Map<string, string>();
    const owner = `pid-${process.pid}-${crypto.randomUUID()}`;
    const schedule = await runSchedule(scheduleItems.items, effective.maxParallel, async (item, scheduler) => {
      const lease = store.acquire(item.id, owner, 60_000);
      if (!lease) throw new Error(`${item.id} already has an active ForgeDock lease`);
      const controller = new AbortController();
      const heartbeat = setInterval(() => {
        try { store.heartbeat(item.id, lease.token, 60_000); }
        catch (error) { controller.abort(error); }
      }, 20_000);
      try {
        const subject = { repo: repository.repo, issue: item.issue };
        const admission = decideSubjectAdmission(await artifacts.list(subject), { rerun: argv.includes("--rerun"), currentTargetBranch: requiredIssueRoute(routedIssues, item.issue).lane.targetBranch });
        if (admission.action === "skip") {
          skipped.set(item.id, admission.state);
          outcomes.set(item.id, admission.state);
          process.stdout.write(`${statusGlyph(admission.state === "decomposed" ? "blocked" : "passed", mode)} ${item.id} skipped · existing run ${admission.runId} is ${admission.state}\n`);
          if (admission.state === "decomposed") {
            return { status: "skipped", error: `${item.id} is decomposed; rerun orchestration to freeze its authoritative child scope` };
          }
          return;
        }
        if (admission.action === "block") {
          throw new Error(admission.reason);
        }
        if (admission.action === "resume") {
          clearInterval(heartbeat);
          store.release(item.id, lease.token);
          const resumeArgs = [String(item.issue), "--repo", repository.repo, "--resume"];
          const dependencies = item.dependencies.map(issueNumberFromScheduledId);
          if (dependencies.length) resumeArgs.push("--depends-on", dependencies.join(","));
          resumeArgs.push(autoMerge ? "--auto-merge" : "--no-auto-merge");
          resumeArgs.push(
            "--scope-expansion", effective.scopeExpansion,
            "--max-remediation-cycles", String(effective.maxRemediationCycles),
            "--max-remediation-depth", String(effective.maxRemediationDepth),
            "--max-remediation-children", String(effective.maxRemediationChildren),
          );
          if (provider !== undefined) resumeArgs.push("--provider", provider);
          if (model !== undefined) resumeArgs.push("--model", model);
          if (planning.planningProvider !== undefined && planning.planningModel !== undefined) resumeArgs.push("--planning-model", `${planning.planningProvider}/${planning.planningModel}`);
          if (planning.planningThinking !== undefined) resumeArgs.push("--planning-thinking", planning.planningThinking);
          await workOn(resumeArgs);
          setAgentEventObservationIdentity({
            repository: repository.repo,
            orchestrationId,
            ...(process.env.FORGEDOCK_CONTROLLER_TASK_ID ? { controllerTaskId: process.env.FORGEDOCK_CONTROLLER_TASK_ID } : {}),
          });
          const resumed = reconcileLatestRunArtifacts(await artifacts.list(subject));
          updateOrchestrationNode(item.id, { childRunIds: resumed.runId ? [resumed.runId] : [] });
          outcomes.set(item.id, resumed.state);
          if (resumed.state !== "completed") throw new Error(`${item.id} resumed to ${resumed.state}; ${resumed.warnings.join("; ") || "durable recovery details are required"}`);
          process.stdout.write(`${statusGlyph("passed", mode)} ${item.id} resumed · completed\n`);
          return;
        }
        const { issue, lane } = requiredIssueRoute(routedIssues, item.issue);
        const parentRemediation = await resolveParentRemediationTargetFromIssue(issue, artifacts);
        const batchMembers = item.memberIssues ? [...item.memberIssues] : [];
        const batchMemberContracts = batchMembers.length ? parseBatchContract(issue.body) : [];
        const intent = createArtifact({
          kind: "Intent", runId: `run_${crypto.randomUUID()}`, subject: { repo: repository.repo, issue: item.issue },
          producer: { role: "controller", runtime: "forgedock" },
          payload: {
            title: issue.title,
            problem: issue.body || issue.title,
            constraints: [],
            acceptanceHints: [],
            dependencies: [...item.dependencies],
            ...(batchMemberContracts.length ? { batchMemberContracts } : {}),
            sourceUrl: issue.url,
          },
        });
        const baseRef = `origin/${parentRemediation?.parentBranch ?? lane.targetBranch}`;
        const verification = discoverVerificationCommands(process.cwd(), baseRef);
        process.stdout.write(`${statusGlyph("active", mode)} ${item.id} started · ${lane.kind} → ${lane.targetBranch}\n`);
        let result;
        try {
          result = await executeWorkOn({
            intent, repoPath: process.cwd(), lane,
            verification, autoMerge,
            ...(effective.productionTarget !== undefined ? { productionTarget: effective.productionTarget } : {}),
            signal: controller.signal,
            scopeExpansion: parentRemediation ? "recursive" : effective.scopeExpansion,
            maxRemediationCycles: effective.maxRemediationCycles,
            maxRemediationDepth: parentRemediation?.maxRemediationDepth ?? effective.maxRemediationDepth,
            maxRemediationChildren: parentRemediation?.maxRemediationChildren ?? effective.maxRemediationChildren,
            remediationDepth: parentRemediation?.remediationDepth ?? 0,
            ...(parentRemediation !== undefined ? { parentRemediation } : {}),
            scopeHints: {
              affectedFiles: item.affectedFiles ?? [],
              claims: item.claims,
              metadataRoots: STANDARD_SCOPE_METADATA_ROOTS,
            },
            onClaimsPromoted: (paths) => {
              scheduler.promoteClaims(paths);
              updateOrchestrationNode(item.id, { claims: [...paths] });
            },
            subjectEvidence: [...issueSubjectEvidence(issue), laneEvidence(lane)],
            ...(batchMembers.length ? { batchMembers } : {}),
            ...(batchMemberContracts.length ? { batchMemberContracts } : {}),
            ...(provider !== undefined ? { provider } : {}),
            ...(model !== undefined ? { model } : {}),
            ...planning,
          }, {
            runtime, artifacts, runs, git, verifier, host: github, telemetry: store,
            leaseGuard: store.guard(item.id, lease.token),
            onAgentEvent: (event) => writeAgentEvent(event, item.id),
          });
        } catch (error) {
          if (controller.signal.aborted || error instanceof LeaseContinuityError) {
            controller.abort(error);
            return { status: "suspended", error: `Lease continuity failed for ${item.id}; worker aborted and dependents remain queued` };
          }
          if (error instanceof ClaimPromotionConflictError) {
            process.stdout.write(`${statusGlyph("active", mode)} ${item.id} suspended · Build Packet claims conflict with ${error.conflicts.join(", ")}; resume after the active node completes\n`);
            return { status: "suspended", error: error.message };
          }
          throw error;
        }
        updateOrchestrationNode(item.id, { childRunIds: [result.run.runId] });
        outcomes.set(item.id, result.run.state);
        if (result.awaitingHuman) {
          process.stdout.write(`${statusGlyph("active", mode)} ${item.id} awaiting human merge${result.pullRequest?.url ? ` · ${result.pullRequest.url}` : ""}\n`);
          return { status: "suspended", error: `Awaiting human merge${result.pullRequest?.url ? ` at ${result.pullRequest.url}` : ""}` };
        }
        if (result.run.state === "invalid") {
          process.stdout.write(`${statusGlyph("blocked", mode)} ${item.id} invalid · no build or delivery performed\n`);
          return { status: "invalid", error: "Investigation classified the issue as invalid; no delivery work was performed" };
        }
        const presentation = runStatePresentation(result.run.state);
        process.stdout.write(`${statusGlyph(presentation.glyph, mode)} ${item.id} ${presentation.label}\n`);
        if (result.run.state === "blocked") {
          const reconciled = reconcileLatestRunArtifacts(await artifacts.list(subject));
          if (reconciled.remediationCheckpoint && ["awaiting-dispatch", "children-running", "ready-to-resume"].includes(reconciled.remediationCheckpoint.payload.status)) {
            return { status: "suspended", error: `Recursive remediation checkpoint ${reconciled.remediationCheckpoint.payload.checkpointKey} is active` };
          }
        }
        if (result.run.state === "decomposed") {
          return { status: "skipped", error: `${item.id} decomposed during orchestration; rerun orchestration to freeze its authoritative child scope` };
        }
        if (result.run.state !== "completed") {
          const reason = result.outcome?.payload.reason ?? result.run.blockedReason ?? result.run.failure ?? "durable recovery details are required";
          throw new Error(`${item.id} ended in ${result.run.state}: ${reason}`);
        }
      } finally {
        clearInterval(heartbeat);
        try { store.release(item.id, lease.token); } catch { /* fail-closed recovery retains the lease row */ }
      }
    }, {
      serializationEdges: scheduleItems.edges,
      onEvent: (scheduleEvent) => {
        const snapshot = buildOrchestrationSnapshot({
          orchestrationId,
          items: scheduleItems.items,
          serializationEdges: scheduleItems.edges,
          result: {
            status: new Map(scheduleEvent.status),
            errors: new Map(scheduleEvent.errors),
            ...(scheduleEvent.waitReasons ? { waitReasons: new Map(scheduleEvent.waitReasons) } : {}),
          },
        });
        const nodes = orchestrationRecord.nodes.map((node) => {
          const status = scheduleEvent.status.get(node.id);
          const error = scheduleEvent.errors.get(node.id);
          const waitReason = scheduleEvent.waitReasons?.get(node.id);
          const { waitReason: _previousWaitReason, ...withoutWaitReason } = node;
          return {
            ...withoutWaitReason,
            ...(status !== undefined ? { status } : {}),
            ...(waitReason ? { waitReason } : {}),
            ...(error !== undefined ? { error: error.message } : {}),
          };
        });
        persistOrchestration({ ...orchestrationRecord, updatedAt: new Date().toISOString(), nodes });
        const event = orchestrationEventFromSchedule(scheduleEvent, snapshot);
        void activeObserver?.emit({
          producer: activeObserver.producer,
          identity: { repository: repository.repo, orchestrationId },
          source: "workflow",
          channel: "lifecycle",
          kind: "orchestration.state.changed",
          payload: { name: event.name, itemId: event.itemId, readyNodes: snapshot.readyNodes, blockedNodes: snapshot.blockedNodes, suspendedNodes: snapshot.suspendedNodes, waitingNodes: snapshot.nodes.filter((node) => node.status === "queued" && node.waitReason).map((node) => ({ id: node.id, reason: node.waitReason })) },
        });
        process.stdout.write(`  ${event.name}${event.itemId ? ` ${event.itemId}` : ""} · ready=${snapshot.readyNodes.length} waiting=${snapshot.nodes.filter((node) => node.status === "queued" && node.waitReason).length} blocked=${snapshot.blockedNodes.length} invalid=${snapshot.nodes.filter((node) => node.status === "invalid").length} suspended=${snapshot.suspendedNodes.length}\n`);
      },
    });
    const failed = [...schedule.status.entries()].filter(([, status]) => status === "failed" || status === "blocked" || status === "skipped");
    const invalid = [...schedule.status.entries()].filter(([, status]) => status === "invalid");
    const suspended = [...schedule.status.entries()].filter(([, status]) => status === "suspended");
    const completed = [...schedule.status.values()].filter((status) => status === "completed").length;
    const satisfiedExisting = [...skipped.values()].filter((state) => state === "completed" || state === "invalid").length;
    const orchestrationFailed = [...schedule.status.values()].some((status) => status === "failed" || status === "blocked" || status === "suspended" || status === "invalid");
    persistOrchestration({
      ...orchestrationRecord,
      status: orchestrationFailed ? "failed" : "completed",
      updatedAt: new Date().toISOString(),
      nodes: orchestrationRecord.nodes.map((node) => {
        const status = schedule.status.get(node.id);
        const error = schedule.errors.get(node.id);
        return {
          ...node,
          ...(status !== undefined ? { status } : {}),
          ...(error !== undefined ? { error: error.message } : {}),
        };
      }),
    });
    await orchestrationPersistQueue;
    if (activeObserver) {
      await activeObserver.emit({
        producer: activeObserver.producer,
        identity: { repository: repository.repo, orchestrationId },
        source: "workflow",
        channel: "lifecycle",
        kind: "orchestration.completed",
        payload: { status: orchestrationFailed ? "failed" : "completed", completed, failed: failed.length, invalid: invalid.length, suspended: suspended.length },
      });
    }
    process.stdout.write(`\nOrchestration ${orchestrationId} complete · ${completed - satisfiedExisting} dispatched successfully · ${skipped.size} already terminal · ${failed.length} blocked/failed · ${invalid.length} invalid · ${suspended.length} suspended/awaiting-human\n`);
    for (const [id, state] of outcomes) process.stdout.write(`  ${id}: ${state}\n`);
    if (failed.length || invalid.length || suspended.length) process.exitCode = 2;
  } finally {
    await runtime.close();
    store.close();
  }
}

function projectRunsToGitHub(runs: RunRepository, github: GitHubClient): RunRepository {
  return new ProjectedRunRepository(
    runs,
    (state) => github.projectRunState(state),
    (error, state) => {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`warning: GitHub label projection failed for ${state.subject.repo}#${state.subject.issue ?? "?"} at ${state.state}: ${message}\n`);
    },
  );
}

function requiredIssueRoute<T>(routes: ReadonlyMap<number, T>, issue: number): T {
  const route = routes.get(issue);
  if (!route) throw new Error(`Issue #${issue} has no authoritative lane classification`);
  return route;
}

function loadOrchestrationItems(issueNumbers: number[], repo: string): ScheduledWorkItem[] {
  let configured: { items?: Array<{ issue: number; dependsOn?: number[]; claims?: string[]; priority?: number }> } = {};
  const configPath = join(process.cwd(), "forgedock.orchestrate.json");
  if (existsSync(configPath)) {
    try { configured = JSON.parse(readFileSync(configPath, "utf8")); }
    catch (error) { throw new Error(`Invalid forgedock.orchestrate.json: ${error instanceof Error ? error.message : String(error)}`); }
  }
  const selected = new Set(issueNumbers);
  return issueNumbers.map((issue) => {
    const config = configured.items?.find((item) => item.issue === issue);
    const missing = (config?.dependsOn ?? []).filter((dependency) => !selected.has(dependency));
    if (missing.length) throw new Error(`Issue ${issue} depends on unselected issue(s): ${missing.join(", ")}`);
    const dependencies = (config?.dependsOn ?? []).map((dependency) => `issue-${dependency}`);
    return {
      id: `issue-${issue}`,
      issue,
      priority: config?.priority ?? 100,
      dependencies,
      claims: config?.claims?.length ? config.claims : [`component:${repo}`],
    };
  });
}

function issueSubjectEvidence(issue: { number: number; body: string; labels: readonly string[] }): string[] {
  const compactBody = issue.body.replace(/\s+/g, " ").trim().slice(0, 2_000);
  return [
    `GitHub issue #${issue.number} labels: ${issue.labels.length ? issue.labels.join(", ") : "none"}`,
    `GitHub issue #${issue.number} body: ${compactBody || "(empty)"}`,
  ];
}

async function collectBaselineChecks(input: {
  git: GitWorktreeManager;
  verifier: ProcessVerificationRunner;
  verification: readonly Omit<VerificationCommand, "cwd">[];
  issue: number;
  runId: string;
  baseRef: string;
}): Promise<CheckResult[]> {
  const identity = { runId: `${input.runId}-baseline`, issue: input.issue, baseRef: input.baseRef };
  let workspace;
  try {
    workspace = await input.git.create(identity);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    if (!/branch named .+ already exists|already checked out|path .+ already exists/i.test(reason)) throw error;
    workspace = await input.git.recover(identity);
  }
  try {
    return await input.verifier.run(input.verification.map((command) => ({ ...command, cwd: workspace.path })));
  } finally {
    await input.git.remove(workspace);
  }
}

function writeAgentEvent(event: AgentEvent, prefix?: string): void {
  observeAgentEvent(event);
  agentEventStream.write(event, prefix);
}

function configuredPlanningOptions(argv: string[]): {
  planningProvider?: string;
  planningModel?: string;
  planningThinking?: ThinkingLevel;
} {
  const configured = readForgeDockConfig(process.cwd());
  const reference = option(argv, "--planning-model") ?? configured.planningModel ?? process.env.FORGEDOCK_PLANNING_MODEL;
  const planningThinkingValue = option(argv, "--planning-thinking") ?? configured.planningThinking ?? process.env.FORGEDOCK_PLANNING_THINKING;
  if (planningThinkingValue !== undefined && !["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(planningThinkingValue)) throw new Error(`Unsupported planning thinking level: ${planningThinkingValue}`);
  if (reference !== undefined && !splitConfiguredModel(reference)) throw new Error(`Planning model must use provider/model form: ${reference}`);
  const selected = splitConfiguredModel(reference);
  return {
    ...(selected ? { planningProvider: selected.provider, planningModel: selected.model } : {}),
    ...(planningThinkingValue ? { planningThinking: planningThinkingValue as ThinkingLevel } : {}),
  };
}

function configuredMaxReviewSpecialists(): number | undefined {
  const configured = process.env.FORGEDOCK_MAX_REVIEW_SPECIALISTS;
  if (configured !== undefined) {
    const parsed = Number(configured);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 6) throw new Error("FORGEDOCK_MAX_REVIEW_SPECIALISTS must be an integer from 1 to 6");
    return parsed;
  }
  return readForgeDockConfig(process.cwd()).maxReviewSpecialists;
}

function createCliRuntime(options: { provider?: string; model?: string; planningProvider?: string; planningModel?: string; planningThinking?: ThinkingLevel }, telemetry: TelemetryRepository): AgentRuntime {
  const inner = new PiAgentRuntime({
    ...(options.provider !== undefined ? { provider: options.provider } : {}),
    ...(options.model !== undefined ? { model: options.model } : {}),
    ...(options.planningProvider !== undefined ? { planningProvider: options.planningProvider } : {}),
    ...(options.planningModel !== undefined ? { planningModel: options.planningModel } : {}),
    ...(options.planningThinking !== undefined ? { planningThinking: options.planningThinking } : {}),
  });
  return new TelemetryAgentRuntime(inner, (receipt) => telemetry.recordTelemetry(receipt));
}

async function preflightRuntime(runtime: AgentRuntime, options: RuntimePreflightOptions): Promise<void> {
  if (!runtime.preflight) throw new Error("Configured agent runtime does not support preflight; refusing to publish or dispatch semantic work");
  await runtime.preflight(options);
}

function observeArtifactRepository(inner: ArtifactRepository, observer: ObservationSink, context: ObservationIdentity): ArtifactRepository {
  const producer = createObservationProducer("forgedock-artifact");
  return {
    async append(artifact) {
      await inner.append(artifact);
      void observer.emit({
        producer,
        identity: {
          ...context,
          forgeRunId: artifact.runId,
          artifactId: artifact.id,
          ...(artifact.subject.issue !== undefined ? { issueNumber: artifact.subject.issue } : {}),
        },
        source: "artifact",
        channel: "artifact",
        kind: "artifact.created",
        payload: { artifactId: artifact.id, artifactKind: artifact.kind, runId: artifact.runId, subject: artifact.subject },
      });
    },
    list: (subject, kind) => inner.list(subject, kind),
  };
}

function observeRunRepository(inner: RunRepository, observer: ObservationSink, context: ObservationIdentity): RunRepository {
  const producer = createObservationProducer("forgedock-workflow");
  const emit = (state: RunState, kind: string, payload: Record<string, unknown>, occurredAt = state.updatedAt): void => {
    void observer.emit({
      producer,
      identity: { ...context, forgeRunId: state.runId },
      source: "workflow",
      channel: "lifecycle",
      kind,
      occurredAt,
      payload: {
        ...payload,
        runId: state.runId,
        workflow: state.workflow,
        state: state.state,
        attempt: state.attempt,
        version: state.version,
        ...(context.orchestrationId ? { parentId: context.orchestrationId } : {}),
      },
    });
  };
  const emitProgress = (progress: RunProgressRecord): void => {
    void observer.emit({
      producer,
      identity: { ...context, forgeRunId: progress.runId },
      source: "workflow",
      channel: "activity",
      kind: "workflow.progress",
      occurredAt: progress.occurredAt,
      payload: { phase: progress.phase, message: progress.message, runId: progress.runId },
    });
  };
  return {
    async create(state) {
      await inner.create(state);
      emit(state, "workflow.created", { phase: "queued" });
    },
    load: (runId) => inner.load(runId),
    async commit(expectedVersion, state, record) {
      await inner.commit(expectedVersion, state, record);
      emit(state, "workflow.state.changed", { event: record.event, from: record.from, to: record.to, ...(record.reason ? { reason: record.reason } : {}) }, record.occurredAt);
    },
    history: (runId) => inner.history(runId),
    async recordProgress(progress) {
      await inner.recordProgress(progress);
      emitProgress(progress);
    },
    listProgress: (runId) => inner.listProgress(runId),
  };
}

function renderTelemetryLine(summary: ReturnType<typeof summarizeTelemetry>, prefix = ""): void {
  const tokens = summary.totalTokens ?? "unavailable";
  const cost = summary.estimatedCostUsd === undefined ? "unavailable" : `$${summary.estimatedCostUsd.toFixed(4)}`;
  process.stdout.write(`${prefix}telemetry: tasks=${summary.taskCount} active=${summary.activeMs}ms queue=${summary.queueMs}ms retries=${summary.retries} tokens=${tokens} cost=${cost}\n`);
}

function renderControllerTimingLine(summary: ReturnType<typeof summarizeControllerTiming>, prefix = ""): void {
  process.stdout.write(`${prefix}controller timing: active=${summary.activeMs}ms queued=${summary.queuedMs}ms human-held=${summary.humanHeldMs}ms phases=${summary.phases.length}\n`);
}

function commandAutoMerge(argv: string[]): boolean {
  const enabled = argv.includes("--auto-merge");
  const disabled = argv.includes("--no-auto-merge");
  if (enabled && disabled) throw new Error("--auto-merge and --no-auto-merge cannot be used together");
  const requested = enabled ? true : disabled ? false : undefined;
  return resolveAutoMerge(requested, readForgeDockConfig(process.cwd()).autoMerge);
}

function option(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  if (index < 0) return undefined;
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

function issueNumberFromScheduledId(id: string): number {
  const match = /^issue-(\d+)$/.exec(id);
  if (!match) throw new Error(`Invalid scheduled issue dependency: ${id}`);
  return Number(match[1]);
}

function parseIssueNumbers(value: string | undefined): number[] {
  if (!value) return [];
  const values = value.split(",").map((item) => item.trim());
  if (values.some((item) => !/^\d+$/.test(item) || Number(item) < 1)) throw new Error("--depends-on must be a comma-separated list of positive issue numbers");
  return [...new Set(values.map(Number))];
}

function requirePiNodeVersion(): void {
  const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
  if (major < 22 || (major === 22 && minor < 19)) {
    throw new Error(`Pi 0.83.0 requires Node >=22.19.0; current Node is ${process.versions.node}`);
  }
}

function printHelp(): void {
  process.stdout.write(`${renderHeader({ subtitle: "greenfield workflow runtime" })}\n\n`);
  process.stdout.write("Core workflows\n");
  process.stdout.write("  forgedock-next work-on <issue> [--depends-on N,N] [--repo owner/repo] [--scope-expansion scope-locked|recursive] [--max-remediation-cycles N] [--no-auto-merge] [--resume] [--adjudicate-verification REASON] [--rerun]\n");
  process.stdout.write("  forgedock-next work-on <issue> --through investigate --dry-run\n");
  process.stdout.write("  forgedock-next review-pr <pr> [--repo owner/repo] [--issue number]\n");
  process.stdout.write("  forgedock-next promote [--from branch] [--to branch] [--production] [--confirm] [--authorize-merge] [--resume promotion-id] [--cancel --reason text] [--repo owner/repo]\n");
  process.stdout.write("  forgedock-next reset <issue> [--repo owner/repo] [--reason text]\n");
  process.stdout.write("  forgedock-next orchestrate <issues> [--batching aggressive|conservative|none] [--priority P0,P1] [--milestone title|--no-milestone] [--max-parallel N] [--planning-model provider/model] [--planning-thinking high] [--dry-run|--confirm|--auto] [--rerun]\n");
  process.stdout.write("  forgedock-next status [--json] [--issue N --repo owner/repo | --orchestration DAG_ID | --promotions]\n\n");
  process.stdout.write("Orchestration defaults to preview-only; use --confirm/--auto or forge.yaml dispatch_mode: confirm|auto to dispatch. Automatic merge is enabled by default after verification and independent approval; use --no-auto-merge or forge.yaml to require a human merge.\n");
  process.stdout.write("Model selection uses --provider/--model or PI_PROVIDER/PI_MODEL.\n");
}
