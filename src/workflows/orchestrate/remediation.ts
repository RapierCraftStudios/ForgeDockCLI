// SPDX-License-Identifier: AGPL-3.0-or-later

import { createHash } from "node:crypto";
import { createArtifact, type DurableArtifact, type RemediationBlockedPayload } from "../../core/artifacts/schema.js";
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
interface RemediationLease {
  token: string;
  heartbeat: { stop(): void; error(): unknown };
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
    const checkpointKey = remediationCheckpointKey(
      input.parentRun.runId,
      input.parentPullRequest.number,
      input.parentPullRequest.headSha,
      eligible,
    );
    return withRemediationAdmissionLock(`${input.parentRun.subject.repo.toLowerCase()}:${checkpointKey}`, async () => {
      const leaseKey = remediationLeaseKey(input, checkpointKey);
      const lease = await this.acquireLease(leaseKey);
      try {
        const result = await this.beginLocked(input, checkpointKey);
        const heartbeatError = lease?.heartbeat.error();
        if (heartbeatError) throw heartbeatError;
        return result;
      } finally {
        lease?.heartbeat.stop();
        if (lease) this.dependencies.leaseRepository?.release(leaseKey, lease.token);
      }
    });
  }

  private async beginLocked(input: RemediationBlockedInput, checkpointKey: string): Promise<RemediationCheckpointResult> {
    const depth = input.remediationDepth ?? 0;
    const maxDepth = input.maxRemediationDepth ?? this.limits.maxDepth ?? DEFAULT_REMEDIATION_LIMITS.maxDepth;
    const maxChildren = input.maxRemediationChildren ?? this.limits.maxChildren ?? DEFAULT_REMEDIATION_LIMITS.maxChildren;
    const actionable = actionableFindings(input.findings);
    const eligible = actionable.slice(0, maxChildren);
    const existing = await latestCheckpoint(this.dependencies.artifacts, input.parentRun.subject, checkpointKey);
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
      await this.dependencies.artifacts.append(terminal);
      return { checkpoint: await persistedCheckpoint(this.dependencies.artifacts, terminal), childIssues: [] };
    }

    const awaiting = existing ?? createCheckpoint(input, base);
    if (!existing) await this.dependencies.artifacts.append(awaiting);
    if (!this.dependencies.host.materializeRemediationChildren) throw new Error("ForgeHost does not support recursive remediation child materialization");
    const children = await this.dependencies.host.materializeRemediationChildren({
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
    });
    const childIssues = normalizeChildIssues(children.map((child) => child.number));
    const running = createCheckpointFromExisting(awaiting, {
      ...base,
      checkpointSequence: sequence + 1,
      status: "children-running",
      childIssues,
    });
    await this.dependencies.artifacts.append(running);
    const persisted = await persistedCheckpoint(this.dependencies.artifacts, running);
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
    const timer = setInterval(() => {
      try { repository.heartbeat(itemId, lease!.token, REMEDIATION_LEASE_TTL_MS); }
      catch (error) { heartbeatError = error; }
    }, REMEDIATION_LEASE_HEARTBEAT_MS);
    return {
      ...lease,
      heartbeat: {
        stop: () => clearInterval(timer),
        error: () => heartbeatError,
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
    findings: input.findings.slice(0, 32).map((finding) => ({
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
  return createArtifact({
    kind: "RemediationBlocked",
    runId: input.parentRun.runId,
    subject: input.parentRun.subject,
    producer: { role: "controller", runtime: "forgedock" },
    payload,
  }, { id: `rem_${payload.checkpointKey}_${payload.checkpointSequence}` });
}

function createCheckpointFromExisting(
  existing: DurableArtifact<"RemediationBlocked">,
  payload: RemediationBlockedPayload,
): DurableArtifact<"RemediationBlocked"> {
  return createArtifact({
    kind: "RemediationBlocked",
    runId: existing.runId,
    subject: existing.subject,
    producer: existing.producer,
    payload,
  }, { id: `rem_${payload.checkpointKey}_${payload.checkpointSequence}` });
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

async function latestCheckpoint(
  artifacts: ArtifactRepository,
  subject: { repo: string; issue?: number; pr?: number },
  key: string,
): Promise<DurableArtifact<"RemediationBlocked"> | undefined> {
  const existing = await artifacts.list(subject, "RemediationBlocked");
  return existing
    .filter((artifact): artifact is DurableArtifact<"RemediationBlocked"> => artifact.kind === "RemediationBlocked" && artifact.payload.checkpointKey === key)
    .sort((left, right) => left.payload.checkpointSequence - right.payload.checkpointSequence)
    .at(-1);
}

async function persistedCheckpoint(
  artifacts: ArtifactRepository,
  checkpoint: DurableArtifact<"RemediationBlocked">,
): Promise<DurableArtifact<"RemediationBlocked">> {
  return await latestCheckpoint(artifacts, checkpoint.subject, checkpoint.payload.checkpointKey) ?? checkpoint;
}

async function nextCheckpointSequence(artifacts: ArtifactRepository, subject: { repo: string; issue?: number }, key: string): Promise<number> {
  if (!subject.issue) return 1;
  const existing = await artifacts.list({ repo: subject.repo, issue: subject.issue }, "RemediationBlocked");
  const values = existing.filter((artifact): artifact is DurableArtifact<"RemediationBlocked"> => artifact.kind === "RemediationBlocked" && artifact.payload.checkpointKey === key);
  return Math.max(0, ...values.map((artifact) => artifact.payload.checkpointSequence)) + 1;
}
