// SPDX-License-Identifier: AGPL-3.0-or-later

import { createHash } from "node:crypto";
import { createArtifact, type DurableArtifact, type RemediationBlockedPayload } from "../../core/artifacts/schema.js";
import { renderArtifactComment } from "../../core/artifacts/codec.js";
import type { ForgeHost, PullRequestSnapshot } from "../../core/ports/forge-host.js";
import type { GitWorkspace, GitWorkspaceManager } from "../../core/ports/git-workspace.js";
import type { LeaseRepository } from "../../core/ports/lease.js";
import type { ArtifactRepository, RunRepository } from "../../core/ports/repositories.js";
import { transition, type RunState } from "../../core/state/machine.js";
import type { CheckResult, VerificationCommand, VerificationRunner } from "../../core/ports/verification.js";
import { canonicalizeConcreteScopePaths } from "../../runtime/agent-runtime.js";
import { repositoryPathFromLocation } from "../review-pr/scope.js";
import { uncoveredVerificationCommands } from "../work-on/verify.js";

export const DEFAULT_REMEDIATION_LIMITS = {
  maxCycles: 2,
  maxDepth: 2,
  maxChildren: 8,
} as const;

const REMEDIATION_LEASE_TTL_MS = 60_000;
const REMEDIATION_LEASE_HEARTBEAT_MS = 20_000;
const REMEDIATION_READ_RETRIES = 8;
const REMEDIATION_READ_RETRY_DELAY_MS = 50;
const REMEDIATION_COMMENT_BUDGET = 60_000;
interface ConsistencyAwareArtifactRepository extends ArtifactRepository {
  listConsistent?(
    subject: { repo: string; issue?: number; pr?: number },
    kind: "RemediationBlocked",
    expected?: { id?: string; checkpointSequence?: number; status?: string },
  ): Promise<DurableArtifact[]>;
}
interface RemediationLease {
  token: string;
  heartbeat: { stop(): void; error(): unknown; assertHealthy(): void; signal: AbortSignal };
}
class RemediationHandoffPendingError extends Error {
  constructor(checkpointId: string) {
    super(`Remediation checkpoint ${checkpointId} was appended but is not yet visible to a fresh controller`);
    this.name = "RemediationHandoffPendingError";
  }
}
const remediationAdmissionLocks = new Map<string, Promise<void>>();

export interface RemediationFindingInput {
  id: string;
  severity: "critical" | "high" | "medium" | "low";
  title: string;
  evidence: string;
  location?: string;
  remediation: string;
  acceptanceCriterion?: string;
}

export interface RemediationBlockedInput {
  parentRun: RunState;
  parentPullRequest: PullRequestSnapshot;
  packetArtifact: DurableArtifact<"BuildPacket">;
  verdictArtifact: DurableArtifact<"ReviewVerdict">;
  reason: RemediationBlockedPayload["reason"];
  findings: readonly RemediationFindingInput[];
  remediationDepth?: number;
  maxRemediationDepth?: number;
  maxRemediationChildren?: number;
  approvedPaths?: readonly string[];
  /** Durable recovery must reuse this exact awaiting admission, never the live PR head. */
  resumeCheckpoint?: DurableArtifact<"RemediationBlocked">;
}

export interface RemediationCheckpointResult {
  checkpoint: DurableArtifact<"RemediationBlocked">;
  childIssues: readonly number[];
}

export interface RemediationSupervisorDependencies {
  host: ForgeHost;
  artifacts: ArtifactRepository;
  runs?: RunRepository;
  leaseRepository?: LeaseRepository;
  leaseOwner?: string;
}

/**
 * Controller-owned recursive remediation coordinator. It writes immutable
 * checkpoints before and after GitHub child materialization so a restart can
 * reconstruct the relationship without relying on an in-memory callback.
 */
export class RemediationSupervisor {
  private readonly leaseOwner: string;

  constructor(
    private readonly dependencies: RemediationSupervisorDependencies,
    private readonly limits: { maxCycles?: number; maxDepth?: number; maxChildren?: number } = {},
  ) {
    this.leaseOwner = dependencies.leaseOwner ?? `remediation-${crypto.randomUUID()}`;
  }

  async begin(input: RemediationBlockedInput): Promise<RemediationCheckpointResult> {
    const maxChildren = input.maxRemediationChildren ?? this.limits.maxChildren ?? DEFAULT_REMEDIATION_LIMITS.maxChildren;
    const eligible = actionableFindings(input.findings).slice(0, maxChildren);
    const resume = input.resumeCheckpoint;
    if (resume) {
      if (resume.kind !== "RemediationBlocked" || resume.runId !== input.parentRun.runId
        || resume.payload.parentRunId !== input.parentRun.runId
        || resume.payload.pullRequest !== input.parentPullRequest.number) {
        throw new Error("Remediation recovery checkpoint does not belong to this run or pull request");
      }
      if (resume.payload.status !== "awaiting-dispatch") {
        return { checkpoint: resume, childIssues: [...resume.payload.childIssues] };
      }
      if (resume.payload.headSha.toLowerCase() !== input.parentPullRequest.headSha.toLowerCase()) {
        throw new Error(`Remediation awaiting checkpoint is anchored to head ${resume.payload.headSha}, but the live PR is ${input.parentPullRequest.headSha}`);
      }
    }
    const checkpointKey = resume?.payload.checkpointKey ?? remediationCheckpointKey(
      input.parentRun.runId,
      input.parentPullRequest.number,
      input.parentPullRequest.headSha,
      eligible,
    );
    return withRemediationAdmissionLock(`${input.parentRun.subject.repo.toLowerCase()}:${checkpointKey}`, async () => {
      const leaseKey = remediationLeaseKey(input, checkpointKey);
      const lease = await this.acquireLease(leaseKey);
      let releaseLease = true;
      try {
        lease?.heartbeat.assertHealthy();
        const result = await this.beginLocked(input, checkpointKey, lease);
        lease?.heartbeat.assertHealthy();
        return result;
      } catch (error) {
        // The running comment is durable even when GitHub has not exposed it
        // to this controller yet. Do not hand the admission to a successor
        // while only this process can know that transition exists.
        if (error instanceof RemediationHandoffPendingError) releaseLease = false;
        throw error;
      } finally {
        lease?.heartbeat.stop();
        if (lease && releaseLease) this.dependencies.leaseRepository?.release(leaseKey, lease.token);
      }
    });
  }

  private async beginLocked(input: RemediationBlockedInput, checkpointKey: string, lease?: RemediationLease): Promise<RemediationCheckpointResult> {
    lease?.heartbeat.assertHealthy();
    const depth = input.remediationDepth ?? 0;
    const maxDepth = input.maxRemediationDepth ?? this.limits.maxDepth ?? DEFAULT_REMEDIATION_LIMITS.maxDepth;
    const maxChildren = input.maxRemediationChildren ?? this.limits.maxChildren ?? DEFAULT_REMEDIATION_LIMITS.maxChildren;
    const actionable = actionableFindings(input.findings);
    const eligible = actionable.slice(0, maxChildren);
    const observed = await latestCheckpoint(this.dependencies.artifacts, input.parentRun.subject, checkpointKey);
    // The CLI may have recovered an awaiting artifact from the startup barrier
    // while a subsequent projection read is still stale. Prefer that exact
    // stored sequence over deriving a new admission for the same key.
    const resumed = input.resumeCheckpoint?.payload.checkpointKey === checkpointKey
      && (!observed || input.resumeCheckpoint.payload.checkpointSequence >= observed.payload.checkpointSequence)
      ? input.resumeCheckpoint
      : undefined;
    const existing = resumed ?? observed;
    if (existing && existing.payload.status !== "awaiting-dispatch") {
      return { checkpoint: existing, childIssues: [...existing.payload.childIssues] };
    }

    const sequence = existing?.payload.checkpointSequence
      ?? await nextCheckpointSequence(this.dependencies.artifacts, input.parentRun.subject, checkpointKey);
    const authorizedInput = {
      ...input,
      findings: eligible,
      remediationDepth: existing?.payload.remediationDepth ?? depth,
      maxRemediationDepth: existing?.payload.maxRemediationDepth ?? maxDepth,
      maxRemediationChildren: existing?.payload.maxRemediationChildren ?? maxChildren,
    };
    const base = existing?.payload ?? remediationPayload(
      authorizedInput,
      checkpointKey,
      sequence,
      "awaiting-dispatch",
      [],
      [],
      [],
      depth,
      maxDepth,
    );
    if (!existing && (depth >= maxDepth || eligible.length === 0 || actionable.length > maxChildren)) {
      const terminal = createCheckpoint(input, { ...base, status: "terminal", checkpointSequence: sequence });
      lease?.heartbeat.assertHealthy();
      await appendRemediationCheckpoint(this.dependencies.artifacts, terminal, lease);
      lease?.heartbeat.assertHealthy();
      return { checkpoint: await persistedCheckpoint(this.dependencies.artifacts, terminal), childIssues: [] };
    }

    const awaiting = existing ?? createCheckpoint(input, base);
    if (!existing) {
      lease?.heartbeat.assertHealthy();
      await appendRemediationCheckpoint(this.dependencies.artifacts, awaiting, lease);
      lease?.heartbeat.assertHealthy();
    }
    if (!this.dependencies.host.materializeRemediationChildren) throw new Error("ForgeHost does not support recursive remediation child materialization");
    lease?.heartbeat.assertHealthy();
    const materializationInput = {
      repo: input.parentRun.subject.repo,
      parentRunId: base.parentRunId,
      parentIssue: base.parentIssue,
      parentPullRequest: base.pullRequest,
      headSha: base.headSha,
      headBranch: base.headBranch,
      baseBranch: base.baseBranch,
      checkpointKey,
      remediationDepth: base.remediationDepth + 1,
      findings: base.findings.flatMap((finding) => finding.location && finding.acceptanceCriterion ? [{
        id: finding.id,
        title: finding.title,
        evidence: finding.evidence,
        location: finding.location,
        remediation: finding.remediation,
        acceptanceCriterion: finding.acceptanceCriterion,
      }] : []),
      ...(lease ? { signal: lease.heartbeat.signal } : {}),
    };
    const children = await this.dependencies.host.materializeRemediationChildren(materializationInput);
    lease?.heartbeat.assertHealthy();
    const childIssues = normalizeChildIssues(children.map((child) => child.number));
    const running = createCheckpointFromExisting(awaiting, {
      ...base,
      checkpointSequence: sequence + 1,
      status: "children-running",
      childIssues,
    });
    lease?.heartbeat.assertHealthy();
    await appendRemediationCheckpoint(this.dependencies.artifacts, running, lease);
    lease?.heartbeat.assertHealthy();
    const persisted = await persistedCheckpoint(this.dependencies.artifacts, running);
    lease?.heartbeat.assertHealthy();
    return { checkpoint: persisted, childIssues: [...persisted.payload.childIssues] };
  }

  private async acquireLease(itemId: string): Promise<RemediationLease | undefined> {
    const repository = this.dependencies.leaseRepository;
    if (!repository) return undefined;
    let lease = repository.acquire(itemId, this.leaseOwner, REMEDIATION_LEASE_TTL_MS);
    while (!lease) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      lease = repository.acquire(itemId, this.leaseOwner, REMEDIATION_LEASE_TTL_MS);
    }
    let heartbeatError: unknown;
    const controller = new AbortController();
    const recordHeartbeatFailure = (error: unknown): void => {
      heartbeatError ??= error;
      controller.abort(error);
    };
    const timer = setInterval(() => {
      try { repository.heartbeat(itemId, lease!.token, REMEDIATION_LEASE_TTL_MS); }
      catch (error) { recordHeartbeatFailure(error); }
    }, REMEDIATION_LEASE_HEARTBEAT_MS);
    return {
      ...lease,
      heartbeat: {
        stop: () => clearInterval(timer),
        error: () => heartbeatError,
        signal: controller.signal,
        assertHealthy: () => {
          if (heartbeatError) throw heartbeatError;
          try { repository.heartbeat(itemId, lease!.token, REMEDIATION_LEASE_TTL_MS); }
          catch (error) { recordHeartbeatFailure(error); throw error; }
        },
      },
    };
  }

  async reconcileChildren(input: {
    checkpoint: DurableArtifact<"RemediationBlocked">;
    childOutcomes: readonly DurableArtifact<"Outcome">[];
    parentPullRequest: PullRequestSnapshot;
  }): Promise<DurableArtifact<"RemediationBlocked">> {
    const checkpoint = input.checkpoint.payload;
    const expected = new Set(checkpoint.childIssues);
    if (!expected.size || input.parentPullRequest.headSha === checkpoint.headSha) return input.checkpoint;
    const merged = input.childOutcomes.filter((outcome) => outcome.payload.status === "merged" && outcome.subject.issue && expected.has(outcome.subject.issue));
    if (merged.length !== expected.size) return input.checkpoint;
    const childFinalShas = merged.map((outcome) => outcome.payload.finalSha);
    if (childFinalShas.some((sha) => sha === undefined)) return input.checkpoint;
    const approvedPaths = [...checkpoint.approvedPaths];
    const next = createCheckpointFromExisting(input.checkpoint, {
      ...checkpoint,
      checkpointSequence: checkpoint.checkpointSequence + 1,
      status: "ready-to-resume",
      approvedPaths,
      childOutcomeIds: merged.map((outcome) => outcome.id),
      childFinalShas: childFinalShas as string[],
    });
    await this.dependencies.artifacts.append(next);
    return next;
  }

  async terminalize(checkpoint: DurableArtifact<"RemediationBlocked">): Promise<DurableArtifact<"RemediationBlocked">> {
    if (checkpoint.payload.status === "terminal") return checkpoint;
    const terminal = createCheckpointFromExisting(checkpoint, {
      ...checkpoint.payload,
      checkpointSequence: checkpoint.payload.checkpointSequence + 1,
      status: "terminal",
    });
    await this.dependencies.artifacts.append(terminal);
    return terminal;
  }

  async resumeParent(input: {
    run: RunState;
    checkpoint: DurableArtifact<"RemediationBlocked">;
    headSha?: string;
  }): Promise<RunState> {
    if (input.checkpoint.payload.status !== "ready-to-resume") throw new Error("Remediation checkpoint is not ready to resume");
    if (input.run.state !== "blocked") throw new Error(`Expanded review resume requires blocked state, found ${input.run.state}`);
    if (input.checkpoint.payload.parentRunId !== input.run.runId) throw new Error("Remediation checkpoint belongs to a different run");
    if (!this.dependencies.runs) return transition(input.run, "RESUME_EXPANDED_REVIEW", { headSha: input.checkpoint.payload.headSha }).state;
    const result = transition(input.run, "RESUME_EXPANDED_REVIEW", {
      ...(input.headSha !== undefined ? { headSha: input.headSha } : {}),
      reason: `Resuming exact remediation paths after child Outcomes ${input.checkpoint.payload.childOutcomeIds.join(", ")}`,
    });
    await this.dependencies.runs.commit(input.run.version, result.state, result.record);
    return result.state;
  }

  async reconstruct(input: { subject: { repo: string; issue: number }; checkpointKey?: string }): Promise<DurableArtifact<"RemediationBlocked"> | undefined> {
    const artifacts = await this.dependencies.artifacts.list(input.subject, "RemediationBlocked");
    const checkpoints = artifacts.filter((artifact): artifact is DurableArtifact<"RemediationBlocked"> => artifact.kind === "RemediationBlocked")
      .filter((artifact) => !input.checkpointKey || artifact.payload.checkpointKey === input.checkpointKey)
      .sort((left, right) => left.payload.checkpointSequence - right.payload.checkpointSequence);
    return checkpoints.at(-1);
  }
}

/** Create a controller-authored Build Result for a parent branch after child merges. */
export async function verifyParentRevision(input: {
  run: RunState;
  packet: DurableArtifact<"BuildPacket">;
  checkpoint: DurableArtifact<"RemediationBlocked">;
  pullRequest: PullRequestSnapshot;
  commands: readonly VerificationCommand[];
  workspace: GitWorkspace;
  verifier: VerificationRunner;
}, dependencies: {
  host: ForgeHost;
  git: GitWorkspaceManager;
  artifacts: ArtifactRepository;
  runs: RunRepository;
}): Promise<{
  run: RunState;
  buildResult?: DurableArtifact<"BuildResult">;
  checks: CheckResult[];
}> {
  if (input.checkpoint.payload.status !== "ready-to-resume") throw new Error("Parent revision proof requires a ready remediation checkpoint");
  if (!input.checkpoint.payload.childOutcomeIds.length) throw new Error("Parent revision proof requires authoritative child Outcomes");
  const current = await dependencies.host.getPullRequest(input.pullRequest.repo, input.pullRequest.number);
  if (current.headBranch !== input.checkpoint.payload.headBranch || current.baseBranch !== input.checkpoint.payload.baseBranch) {
    throw new Error("Parent PR branch target changed during remediation");
  }
  if (current.headSha === input.checkpoint.payload.headSha) {
    throw new Error(`Parent branch head did not advance after child remediation: ${current.headSha}`);
  }
  const uncoveredPlan = uncoveredVerificationCommands(input.packet.payload.verificationPlan, input.commands);
  if (uncoveredPlan.length) {
    throw new Error(`Parent revision verification does not cover the frozen plan: ${uncoveredPlan.join(", ")}`);
  }
  if (!input.commands.some((command) => command.required)) {
    throw new Error("Parent revision verification requires at least one controller-approved required command");
  }

  await dependencies.git.syncToRemoteHead(input.workspace, current.headSha);
  const childFinalShas = input.checkpoint.payload.childFinalShas ?? [];
  if (childFinalShas.length !== input.checkpoint.payload.childOutcomeIds.length) {
    throw new Error("Parent revision proof requires a captured final SHA for every child Outcome");
  }
  for (const childFinalSha of childFinalShas) {
    if (!await dependencies.git.isAncestor(input.workspace, childFinalSha, current.headSha)) {
      throw new Error(`Parent revision ${current.headSha} does not contain remediated child ${childFinalSha}`);
    }
  }
  const localHead = await dependencies.git.head(input.workspace);
  if (localHead.toLowerCase() !== current.headSha.toLowerCase()) {
    throw new Error(`Retained workspace head ${localHead} does not match parent PR head ${current.headSha}`);
  }
  const revisionChangedPaths = canonicalizeConcreteScopePaths(
    await dependencies.git.revisionChangedPaths(input.workspace),
  ).sort();
  const approvedPaths = new Set(canonicalizeConcreteScopePaths(input.checkpoint.payload.approvedPaths));
  const unexpectedPaths = revisionChangedPaths.filter((path) => !approvedPaths.has(path));
  if (unexpectedPaths.length) {
    throw new Error(`Parent remediation revision contains paths outside controller-approved scope: ${unexpectedPaths.join(", ")}`);
  }
  await dependencies.git.prepareWorkspaceDependencies(input.workspace);

  const checks = await input.verifier.run(input.commands);
  const failed = input.commands.some((command, index) => command.required && checks[index]?.status !== "passed");
  const postVerificationHead = await dependencies.git.head(input.workspace);
  const refreshed = await dependencies.host.getPullRequest(input.pullRequest.repo, input.pullRequest.number);
  if (postVerificationHead.toLowerCase() !== current.headSha.toLowerCase()
    || refreshed.headSha.toLowerCase() !== current.headSha.toLowerCase()) {
    throw new Error(`Parent branch changed while verification ran: local ${postVerificationHead}, remote ${refreshed.headSha}, expected ${current.headSha}`);
  }
  const verificationSideEffects = await dependencies.git.changedPaths(input.workspace);
  if (verificationSideEffects.length) {
    throw new Error(`Parent verification mutated the retained workspace: ${verificationSideEffects.join(", ")}`);
  }
  if (failed) {
    if (input.run.state === "blocked") return { run: input.run, checks };
    const blocked = transition(input.run, "BLOCK", { reason: "Parent revision verification failed after child remediation" });
    await dependencies.runs.commit(input.run.version, blocked.state, blocked.record);
    return { run: blocked.state, checks };
  }
  const buildResult = createArtifact({
    kind: "BuildResult",
    runId: input.run.runId,
    subject: input.run.subject,
    producer: { role: "controller", runtime: "forgedock" },
    payload: {
      branch: current.headBranch,
      targetBranch: current.baseBranch,
      headSha: current.headSha,
      ...(input.workspace.baseSha ? { baseSha: input.workspace.baseSha } : {}),
      changedPaths: revisionChangedPaths,
      summary: `Parent revision ${current.headSha} verified locally after recursive remediation child merges.`,
      acceptanceEvidence: input.packet.payload.acceptanceCriteria.map((criterion) => ({
        criterion,
        status: "passed" as const,
        evidence: `Controller verification passed in the synchronized retained workspace at ${current.headSha}.`,
      })),
      checks,
      decisions: [`Child Outcomes: ${input.checkpoint.payload.childOutcomeIds.join(", ")}`],
      residualRisks: [],
    },
  });
  await dependencies.artifacts.append(buildResult);
  let nextRun = input.run;
  if (nextRun.state === "blocked") {
    const next = transition(nextRun, "RESUME_EXPANDED_REVIEW", { headSha: current.headSha, reason: "Parent revision verification passed" });
    await dependencies.runs.commit(nextRun.version, next.state, next.record);
    nextRun = next.state;
  } else if (nextRun.state !== "reviewing") {
    throw new Error(`Parent revision verification requires blocked or reviewing state, found ${nextRun.state}`);
  }
  return { run: nextRun, buildResult, checks };
}

export function remediationCheckpointKey(parentRunId: string, pullRequest: number, headSha: string, findings: readonly RemediationFindingInput[]): string {
  return createHash("sha256").update([
    parentRunId, String(pullRequest), headSha.toLowerCase(), ...findings.map((finding) => `${finding.id}:${finding.location ?? ""}`).sort(),
  ].join("\n")).digest("hex");
}

function actionableFindings(findings: readonly RemediationFindingInput[]): RemediationFindingInput[] {
  return findings.filter((finding) => finding.location && finding.remediation.trim() && finding.evidence.trim() && finding.acceptanceCriterion?.trim())
    .filter((finding, index, all) => all.findIndex((candidate) => candidate.id === finding.id) === index);
}

function remediationPayload(
  input: RemediationBlockedInput,
  checkpointKey: string,
  checkpointSequence: number,
  status: RemediationBlockedPayload["status"],
  childIssues: readonly number[],
  childRunIds: readonly string[],
  childOutcomeIds: readonly string[],
  remediationDepth: number,
  maxRemediationDepth: number,
): RemediationBlockedPayload {
  return {
    checkpointKey,
    checkpointSequence,
    status,
    parentRunId: input.parentRun.runId,
    parentIssue: input.parentRun.subject.issue ?? input.parentPullRequest.number,
    pullRequest: input.parentPullRequest.number,
    headSha: input.parentPullRequest.headSha,
    headBranch: input.parentPullRequest.headBranch,
    baseBranch: input.parentPullRequest.baseBranch,
    packetArtifactId: input.packetArtifact.id,
    verdictArtifactId: input.verdictArtifact.id,
    reason: input.reason,
    findings: input.findings.map((finding) => ({
      id: finding.id, severity: finding.severity, title: finding.title, evidence: finding.evidence.slice(0, 8_000),
      ...(finding.location ? { location: finding.location } : {}), remediation: finding.remediation.slice(0, 4_000),
      ...(finding.acceptanceCriterion ? { acceptanceCriterion: finding.acceptanceCriterion } : {}),
    })),
    childIssues: [...childIssues],
    childRunIds: [...childRunIds],
    approvedPaths: [...new Set([
      ...(input.approvedPaths ?? []),
      ...input.packetArtifact.payload.expectedPaths,
      ...input.findings.flatMap((finding) => finding.location
        ? [repositoryPathFromLocation(finding.location) ?? finding.location]
        : []),
    ])].slice(0, 100),
    childOutcomeIds: [...childOutcomeIds],
    childFinalShas: [],
    remediationDepth,
    maxRemediationDepth,
    ...(input.maxRemediationChildren !== undefined ? { maxRemediationChildren: input.maxRemediationChildren } : {}),
  };
}

function createCheckpoint(input: RemediationBlockedInput, payload: RemediationBlockedPayload): DurableArtifact<"RemediationBlocked"> {
  const artifactInput = {
    kind: "RemediationBlocked" as const,
    runId: input.parentRun.runId,
    subject: input.parentRun.subject,
    producer: { role: "controller", runtime: "forgedock" },
  };
  const artifact = createArtifact({ ...artifactInput, payload }, { id: `rem_${payload.checkpointKey}_${payload.checkpointSequence}` });
  return fitRemediationArtifact(artifact);
}

function fitRemediationArtifact(artifact: DurableArtifact<"RemediationBlocked">): DurableArtifact<"RemediationBlocked"> {
  if (renderArtifactComment(artifact).length <= REMEDIATION_COMMENT_BUDGET) return artifact;

  // GitHub's projection contains both Markdown and a base64 JSON envelope.
  // Compact only bounded prose, never finding IDs, severity, locations, child
  // IDs, or checkpoint metadata. The binary search makes the whole artifact
  // budget deterministic at every supported child count.
  let low = 1;
  let high = 2_000;
  let best: DurableArtifact<"RemediationBlocked"> | undefined;
  while (low <= high) {
    const perFindingBudget = Math.floor((low + high) / 2);
    const compacted = compactRemediationPayload(artifact.payload, perFindingBudget);
    const candidate = createArtifact({
      kind: artifact.kind,
      runId: artifact.runId,
      subject: artifact.subject,
      producer: artifact.producer,
      payload: compacted,
    }, { id: artifact.id });
    if (renderArtifactComment(candidate).length <= REMEDIATION_COMMENT_BUDGET) {
      best = candidate;
      low = perFindingBudget + 1;
    } else {
      high = perFindingBudget - 1;
    }
  }
  if (!best) throw new Error(`Remediation checkpoint ${artifact.id} exceeds the GitHub artifact comment budget`);
  return best;
}

function compactRemediationPayload(payload: RemediationBlockedPayload, budget: number): RemediationBlockedPayload {
  return {
    ...payload,
    findings: payload.findings.map((finding) => {
      // Location is retained verbatim because it is the routing/scope field;
      // only prose is compacted. The finding ID and severity are untouched by
      // the spread below as well.
      const values = [finding.title, finding.evidence, finding.remediation, finding.acceptanceCriterion]
        .filter((value): value is string => value !== undefined);
      const each = Math.max(1, Math.floor(budget / Math.max(1, values.length)));
      return {
        ...finding,
        title: compactRemediationText(finding.title, each),
        evidence: compactRemediationText(finding.evidence, each),
        remediation: compactRemediationText(finding.remediation, each),
        ...(finding.acceptanceCriterion !== undefined ? { acceptanceCriterion: compactRemediationText(finding.acceptanceCriterion, each) } : {}),
      };
    }),
  };
}

function compactRemediationText(value: string, maximum: number): string {
  const normalized = value.replaceAll("\u0000", "").trim();
  if (normalized.length <= maximum) return normalized || "…";
  if (maximum <= 1) return "…";
  return `${normalized.slice(0, maximum - 1)}…`;
}

function createCheckpointFromExisting(
  existing: DurableArtifact<"RemediationBlocked">,
  payload: RemediationBlockedPayload,
): DurableArtifact<"RemediationBlocked"> {
  return fitRemediationArtifact(createArtifact({
    kind: "RemediationBlocked",
    runId: existing.runId,
    subject: existing.subject,
    producer: existing.producer,
    payload,
  }, { id: `rem_${payload.checkpointKey}_${payload.checkpointSequence}` }));
}

async function withRemediationAdmissionLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = remediationAdmissionLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  remediationAdmissionLocks.set(key, current);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (remediationAdmissionLocks.get(key) === current) remediationAdmissionLocks.delete(key);
  }
}

function remediationLeaseKey(input: RemediationBlockedInput, checkpointKey: string): string {
  return `remediation:${input.parentRun.subject.repo.toLowerCase()}:${input.parentRun.subject.issue ?? input.parentPullRequest.number}:${input.parentRun.runId}:${input.parentPullRequest.number}:${checkpointKey}`;
}

function normalizeChildIssues(numbers: readonly number[]): number[] {
  const unique = new Set<number>();
  for (const number of numbers) {
    if (!Number.isSafeInteger(number) || number < 1) throw new Error(`Remediation child issue number is invalid: ${number}`);
    unique.add(number);
  }
  return [...unique].sort((left, right) => left - right);
}

interface FencedArtifactRepository extends ArtifactRepository {
  appendFenced?(artifact: DurableArtifact, assertOwnership: () => void, signal?: AbortSignal): Promise<void>;
  authoritative?: ArtifactRepository;
  cache?: ArtifactRepository;
}

async function appendRemediationCheckpoint(
  artifacts: ArtifactRepository,
  checkpoint: DurableArtifact<"RemediationBlocked">,
  lease: RemediationLease | undefined,
): Promise<void> {
  const assertOwnership = () => lease?.heartbeat.assertHealthy();
  assertOwnership();
  const repository = artifacts as FencedArtifactRepository;
  const fenced = repository.appendFenced;
  if (fenced) {
    await fenced.call(repository, checkpoint, assertOwnership, lease?.heartbeat.signal);
  } else {
    // CachedArtifactRepository intentionally exposes its authoritative and
    // cache members. Fence the authoritative projection, then refresh the
    // rebuildable cache only after the durable write succeeds.
    const authoritative = repository.authoritative as FencedArtifactRepository | undefined;
    if (authoritative?.appendFenced) {
      await authoritative.appendFenced(checkpoint, assertOwnership, lease?.heartbeat.signal);
      await repository.cache?.append(checkpoint);
    } else {
      await artifacts.append(checkpoint);
    }
  }
  // A failed fence must never be converted into a successful child-set
  // result. Repositories with appendFenced perform this check at publication;
  // this postcondition also protects the ordinary test/cache repositories.
  assertOwnership();
}

async function listRemediationArtifacts(
  artifacts: ArtifactRepository,
  subject: { repo: string; issue?: number; pr?: number },
  expected?: { id?: string; checkpointSequence?: number; status?: string },
): Promise<DurableArtifact<"RemediationBlocked">[]> {
  const consistent = (artifacts as ConsistencyAwareArtifactRepository).listConsistent;
  const values = consistent
    ? await consistent.call(artifacts as ConsistencyAwareArtifactRepository, subject, "RemediationBlocked", expected)
    : await artifacts.list(subject, "RemediationBlocked");
  return values.filter((artifact): artifact is DurableArtifact<"RemediationBlocked"> => artifact.kind === "RemediationBlocked");
}

async function latestCheckpoint(
  artifacts: ArtifactRepository,
  subject: { repo: string; issue?: number; pr?: number },
  key: string,
): Promise<DurableArtifact<"RemediationBlocked"> | undefined> {
  const existing = await listRemediationArtifacts(artifacts, subject);
  return existing
    .filter((artifact) => artifact.payload.checkpointKey === key)
    .sort((left, right) => left.payload.checkpointSequence - right.payload.checkpointSequence)
    .at(-1);
}

async function persistedCheckpoint(
  artifacts: ArtifactRepository,
  checkpoint: DurableArtifact<"RemediationBlocked">,
): Promise<DurableArtifact<"RemediationBlocked">> {
  const expected = {
    id: checkpoint.id,
    checkpointSequence: checkpoint.payload.checkpointSequence,
    status: checkpoint.payload.status,
  };
  const consistent = (artifacts as ConsistencyAwareArtifactRepository).listConsistent;
  if (consistent) {
    try {
      const observed = await listRemediationArtifacts(artifacts, checkpoint.subject, expected);
      const match = observed.find((candidate) => candidate.id === checkpoint.id
        && candidate.payload.checkpointSequence === checkpoint.payload.checkpointSequence
        && candidate.payload.status === checkpoint.payload.status
        && JSON.stringify(candidate.payload.childIssues) === JSON.stringify(checkpoint.payload.childIssues));
      if (match) return match;
    } catch {
      // The consistency-aware repository already performed its bounded wait.
      // Preserve the durable append and retain the lease for handoff recovery.
    }
  } else {
    for (let attempt = 0; attempt < REMEDIATION_READ_RETRIES; attempt += 1) {
      const observed = await listRemediationArtifacts(artifacts, checkpoint.subject, expected);
      const match = observed.find((candidate) => candidate.id === checkpoint.id
        && candidate.payload.checkpointSequence === checkpoint.payload.checkpointSequence
        && candidate.payload.status === checkpoint.payload.status
        && JSON.stringify(candidate.payload.childIssues) === JSON.stringify(checkpoint.payload.childIssues));
      if (match) return match;
      if (attempt + 1 < REMEDIATION_READ_RETRIES) {
        await new Promise((resolve) => setTimeout(resolve, REMEDIATION_READ_RETRY_DELAY_MS * (attempt + 1)));
      }
    }
  }
  // Never release admission while only a caller-local projection knows the
  // running transition. The durable awaiting checkpoint remains recoverable;
  // this owner fails and a later controller adopts the exact transition.
  throw new RemediationHandoffPendingError(checkpoint.id);
}

async function nextCheckpointSequence(artifacts: ArtifactRepository, subject: { repo: string; issue?: number }, key: string): Promise<number> {
  if (!subject.issue) return 1;
  const existing = await artifacts.list({ repo: subject.repo, issue: subject.issue }, "RemediationBlocked");
  const values = existing.filter((artifact): artifact is DurableArtifact<"RemediationBlocked"> => artifact.kind === "RemediationBlocked" && artifact.payload.checkpointKey === key);
  return Math.max(0, ...values.map((artifact) => artifact.payload.checkpointSequence)) + 1;
}
