// SPDX-License-Identifier: AGPL-3.0-or-later

import { createHash } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { ArtifactKind } from "../../core/artifacts/schema.js";
import type { OrchestrationNodeRecord, OrchestrationRecord } from "../../core/ports/orchestration.js";
import type { SqliteRepositoryPurgeManifest, SqliteRepositoryPurgeResult } from "../../adapters/sqlite/sqlite-repositories.js";
import type { SqliteObservationPurgeManifest, SqliteObservationPurgeResult } from "../../observability/sqlite-store.js";

export const DEFAULT_RESET_MUTATION_CONCURRENCY = 4;

export type ResetProgressStage = "archive" | "external-mutations" | "worktrees" | "postconditions" | "purge";

export interface ResetProgressEvent {
  stage: ResetProgressStage;
  completed: number;
  total: number;
  elapsedMs: number;
}

export type ResetProgressCallback = (event: ResetProgressEvent) => void;

/** A comment identity is an API id, not its mutable body or position. */
export interface ResetCommentIdentity {
  id: number;
  /** Issue number for issue comments; PR number for review-thread comments. */
  issue: number;
  pr?: number;
  marker: string;
  runId?: string;
  artifactId?: string;
  bodySha256: string;
  occurredAt?: string;
  /** Original issue/review comments are evidence and are never selected. */
  managed: true;
}

export interface ResetLabelEvent {
  name: string;
  action: "labeled" | "unlabeled";
  occurredAt: string;
  eventId: number;
}

export interface ResetLabelState {
  current: readonly string[];
  events: readonly ResetLabelEvent[];
  /** Event timestamp at which workflow ownership began, when discoverable. */
  cutoffAt?: string;
  restored: readonly string[];
}

export interface ResetPullRequestIdentity {
  number: number;
  state: "OPEN" | "CLOSED" | "MERGED";
  headSha: string;
  headBranch: string;
  baseBranch: string;
}

export interface ResetRefIdentity {
  name: string;
  kind: "local" | "remote";
  sha: string;
  exactRef: string;
  managed: true;
}

export interface ResetWorktreeIdentity {
  path: string;
  branch: string;
  headSha: string;
  dirty: readonly string[];
  archivePath?: string;
  archiveSha256?: string;
  managed: true;
}

export interface ResetArchiveIdentity {
  path: string;
  sha256: string;
  kind: "dirty-diff" | "database" | "tasks" | "observations" | "evidence";
}

export interface ResetRunIdentity { runId: string; version: number; state: string; }
export interface ResetDagIdentity { orchestrationId: string; repository: string; status: string; updatedAt: string; recordSha256: string; }
/** Evidence for a DAG node intentionally left behind when its parent record is removed. */
export interface ResetPreservedNodeIdentity {
  orchestrationId: string;
  nodeId: string;
  issue: number;
  memberIssues: readonly number[];
  status: string;
  runIds: readonly string[];
  reason: "completed" | "invalid" | "unselected";
}
export interface ResetTaskIdentity { taskId: string; runId?: string; launchKey?: string; snapshotSha256: string; }
export interface ResetObservationIdentity { key: string; runId: string; taskId: string; sessionRef: string; receiptSha256: string; }
export interface ResetFenceIdentity { fenceKey: string; generation: number; snapshotSha256: string; repository?: string; pullRequest?: number; }
export interface ResetPromotionIdentity { promotionId: string; repository: string; version: number; phase: string; snapshotSha256: string; }

export interface ResetExternalAuthorization {
  /** Numbers and branch names derived from exact locally persisted artifacts. */
  pullRequestNumbers: readonly number[];
  headBranches: readonly string[];
}

export interface ResetSelection {
  repo: string;
  issueNumbers: readonly number[];
  dagIds: readonly string[];
}


export interface PristineResetManifest {
  schema: "forgedock.pristine-reset/v1";
  repo: string;
  selection: ResetSelection;
  issues: readonly { number: number; state: "OPEN" | "CLOSED"; labels: readonly string[]; bodySha256: string }[];
  labels: Readonly<Record<string, ResetLabelState>>;
  comments: readonly ResetCommentIdentity[];
  pullRequests: readonly ResetPullRequestIdentity[];
  refs: readonly ResetRefIdentity[];
  worktrees: readonly ResetWorktreeIdentity[];
  runs: readonly ResetRunIdentity[];
  artifacts: readonly { artifactId: string; subjectKey: string; kind: ArtifactKind; sha256: string }[];
  tasks: readonly ResetTaskIdentity[];
  observations: readonly ResetObservationIdentity[];
  observationEvents: SqliteObservationPurgeManifest["events"];
  fences: readonly ResetFenceIdentity[];
  promotions: readonly ResetPromotionIdentity[];
  dags: readonly ResetDagIdentity[];
  /** Proof that deleting a parent DAG did not authorize deletion of these nodes. */
  preservedNodes: readonly ResetPreservedNodeIdentity[];
  /** Run identities referenced by preserved nodes; all must survive apply. */
  preservedRunIds: readonly string[];
  /** Artifact rows reachable from preserved runs; used by the postcondition check. */
  preservedArtifactIds: readonly string[];
  leases: readonly { itemId: string; expiresAt: number; owner: string; tokenSha256: string }[];
  archive: readonly ResetArchiveIdentity[];
  actions: readonly ResetAction[];
  digest: string;
}

export type ResetAction =
  | { type: "fence-and-cancel"; ids: readonly string[] }
  | { type: "stop-workers"; ids: readonly string[] }
  | { type: "archive"; paths: readonly string[] }
  | { type: "purge-database"; runs: number; artifacts: number; dags: number; tasks: number; observations: number; fences: number; promotions: number; leases: number }
  | { type: "delete-comments"; ids: readonly number[] }
  | { type: "restore-labels"; issue: number; labels: readonly string[] }
  | { type: "close-pull-requests"; numbers: readonly number[] }
  | { type: "delete-exact-refs"; refs: readonly string[] }
  | { type: "remove-worktrees"; paths: readonly string[] }
  | { type: "verify-postconditions" };

export interface ResetCommentSnapshot extends ResetCommentIdentity { body: string; }
export interface ResetHost {
  readIssue(repo: string, issue: number): Promise<{ number: number; state: "OPEN" | "CLOSED"; labels: readonly string[]; body: string }>;
  listComments(repo: string, issue: number): Promise<readonly ResetCommentSnapshot[]>;
  listPullRequestComments?(repo: string, number: number): Promise<readonly ResetCommentSnapshot[]>;
  deleteComment(repo: string, comment: ResetCommentIdentity): Promise<void>;
  readLabels(repo: string, issue: number): Promise<ResetLabelState>;
  restoreLabels(repo: string, issue: number, labels: readonly string[], expected?: ResetLabelState): Promise<void>;
  readPullRequest(repo: string, number: number): Promise<ResetPullRequestIdentity>;
  listPullRequests?(selection: ResetSelection, authorization?: ResetExternalAuthorization): Promise<readonly ResetPullRequestIdentity[]>;
  listManagedRefs?(selection: ResetSelection, authorization?: ResetExternalAuthorization): Promise<readonly ResetRefIdentity[]>;
  /** Capture complete selected GitHub evidence after fencing and before deletion. */
  archiveSelectedEvidence?(selection: ResetSelection, manifest: PristineResetManifest): Promise<readonly ResetArchiveIdentity[]>;
  closePullRequest(repo: string, number: number, reason: string): Promise<void>;
  readRef(repo: string, exactRef: string): Promise<string | undefined>;
  deleteExactRef(repo: string, exactRef: string, expectedSha: string): Promise<void>;
}

export interface ResetWorkspaceAuthorization {
  /** Exact issue identities and run-derived branch identities admitted for capture. */
  issueNumbers: readonly number[];
  runIds: readonly string[];
  branches: readonly string[];
}

export interface ResetStateStore {
  capture(selection: ResetSelection): Promise<{
    runs: readonly ResetRunIdentity[];
    artifacts: PristineResetManifest["artifacts"];
    tasks: readonly ResetTaskIdentity[];
    observations: readonly ResetObservationIdentity[];
    observationEvents?: SqliteObservationPurgeManifest["events"];
    fences: readonly ResetFenceIdentity[];
    promotions: readonly ResetPromotionIdentity[];
    dags: readonly ResetDagIdentity[];
    preservedNodes?: readonly ResetPreservedNodeIdentity[];
    preservedRunIds?: readonly string[];
    preservedArtifactIds?: readonly string[];
    selectedIssueNumbers?: readonly number[];
    workspaceAuthorization?: ResetWorkspaceAuthorization;
    leases: PristineResetManifest["leases"];
    archive: readonly ResetArchiveIdentity[];
    authorization?: ResetExternalAuthorization;
  }>;
  purgeExactManifest(manifest: SqliteRepositoryPurgeManifest & { tasks?: readonly ResetTaskIdentity[]; observations?: readonly ResetObservationIdentity[]; fences?: readonly ResetFenceIdentity[]; dags?: readonly ResetDagIdentity[] }, now?: number, options?: { allowAbsent?: boolean }): Promise<SqliteRepositoryPurgeResult>;
  observationPurgeExactManifest?(manifest: SqliteObservationPurgeManifest, options?: { allowAbsent?: boolean }): Promise<SqliteObservationPurgeResult>;
  observationVerifyPurged?(manifest: SqliteObservationPurgeManifest): Promise<void>;
  appendAbandonedEvidence?(selection: ResetSelection, reason: string): Promise<void>;
  archiveSnapshots?(selection: ResetSelection, manifest: PristineResetManifest): Promise<readonly ResetArchiveIdentity[]>;
  purgeTaskFiles?(tasks: readonly ResetTaskIdentity[]): Promise<void>;
  verifyPurged?(manifest: PristineResetManifest): Promise<void>;
  verifyPreserved?(manifest: Pick<PristineResetManifest, "preservedNodes" | "preservedRunIds" | "preservedArtifactIds">): Promise<void>;
}

export interface ResetWorkspaceStore {
  capture(selection: ResetSelection, authorization?: ResetWorkspaceAuthorization): Promise<readonly ResetWorktreeIdentity[]>;
  archiveDirty(worktree: ResetWorktreeIdentity): Promise<ResetArchiveIdentity | undefined>;
  removeExact(worktree: ResetWorktreeIdentity): Promise<void>;
  assertAbsent?(worktree: ResetWorktreeIdentity): Promise<void>;
}

export interface ResetCancellation {
  fence(selection: ResetSelection, leaseIds?: readonly string[]): Promise<void>;
  stopWorkers(selection: ResetSelection, leaseIds?: readonly string[]): Promise<void>;
}

export interface ResetPlanDependencies {
  host: ResetHost;
  state: ResetStateStore;
  workspaces: ResetWorkspaceStore;
  cancellation: ResetCancellation;
  now?: () => number;
  /** Maximum number of independent destructive operations in flight. */
  mutationConcurrency?: number;
  onProgress?: ResetProgressCallback;
}

export function canonicalResetManifest(manifest: Omit<PristineResetManifest, "digest">): string {
  return stableJson(manifest);
}

export function resetManifestDigest(manifest: Omit<PristineResetManifest, "digest">): string {
  return createHash("sha256").update(canonicalResetManifest(manifest), "utf8").digest("hex");
}

export function withResetManifestDigest(manifest: Omit<PristineResetManifest, "digest">): PristineResetManifest {
  return { ...manifest, digest: resetManifestDigest(manifest) };
}

export function assertResetManifestDigest(manifest: PristineResetManifest, expectedDigest = manifest.digest): void {
  if (!/^[0-9a-f]{64}$/i.test(expectedDigest) || manifest.digest.toLowerCase() !== expectedDigest.toLowerCase()) throw new Error("Pristine reset manifest digest mismatch");
  const { digest: _digest, ...unsigned } = manifest;
  if (resetManifestDigest(unsigned) !== manifest.digest) throw new Error("Pristine reset manifest contents do not match digest");
}

/** Read-only phase. It performs no archive, lease, comment, ref, label, or DB writes. */
export async function dryRunPristineReset(selection: ResetSelection, deps: ResetPlanDependencies): Promise<PristineResetManifest> {
  const issueNumbers = uniqueNumbers(selection.issueNumbers);
  const dagIds = uniqueStrings(selection.dagIds);
  if (!selection.repo.trim()) throw new Error("Reset repository must not be blank");
  if (!issueNumbers.length && !dagIds.length) throw new Error("Reset requires at least one issue or DAG identity");
  const captured = await deps.state.capture({ ...selection, issueNumbers, dagIds });
  // State discovery is authoritative for DAG-only selections: it admits only
  // selected, still-open invalid issues before any host issue/comment/label read.
  const mutableIssueNumbers = uniqueNumbers(captured.selectedIssueNumbers ?? issueNumbers);
  const captureSelection = { ...selection, issueNumbers: mutableIssueNumbers, dagIds };
  const workspaceAuthorization = captured.workspaceAuthorization ?? {
    issueNumbers: mutableIssueNumbers,
    runIds: captured.runs.map((run) => run.runId),
    branches: [],
  };
  const [issues, comments, labels, worktrees] = await Promise.all([
    Promise.all(mutableIssueNumbers.map((number) => deps.host.readIssue(selection.repo, number))),
    Promise.all(mutableIssueNumbers.map((number) => deps.host.listComments(selection.repo, number))).then((x) => x.flat()),
    Promise.all(mutableIssueNumbers.map(async (number) => [number, await deps.host.readLabels(selection.repo, number)] as const)),
    deps.workspaces.capture(captureSelection, workspaceAuthorization),
  ]);
  const authorized = captured.authorization;
  const pullRequests = deps.host.listPullRequests
    ? await deps.host.listPullRequests(captureSelection, authorized)
    : [];
  const refs = deps.host.listManagedRefs
    ? await deps.host.listManagedRefs(captureSelection, authorized)
    : [];
  const selectedRunIds = new Set(captured.runs.map((run) => run.runId));
  const selectedArtifactIds = new Set(captured.artifacts.map((artifact) => artifact.artifactId));
  const selectedDagIds = new Set(captured.dags.map((dag) => dag.orchestrationId));
  const missingDags = dagIds.filter((dagId) => !selectedDagIds.has(dagId));
  if (missingDags.length) throw new Error(`Reset discovery is incomplete; selected DAGs were not found: ${missingDags.join(", ")}`);
  const issueState = new Map(issues.map((issue) => [issue.number, issue.state]));
  const mutableIssues = new Set(mutableIssueNumbers);
  const openPullRequests = new Set(pullRequests.filter((pr) => pr.state === "OPEN").map((pr) => pr.number));
  const pullComments = deps.host.listPullRequestComments
    ? (await Promise.all(pullRequests.filter((pr) => openPullRequests.has(pr.number)).map((pr) => deps.host.listPullRequestComments!(selection.repo, pr.number)))).flat()
    : [];
  const allComments = [...comments.filter((comment) => mutableIssues.has(comment.issue) && issueState.get(comment.issue) === "OPEN"), ...pullComments];
  const managedComments = allComments.filter((comment) => comment.managed === true
    && isSelectedResetComment(comment, selectedRunIds, selectedArtifactIds, selectedDagIds));
  const artifactCommentIds = new Map<string, number>();
  for (const comment of managedComments) {
    if (!comment.artifactId) continue;
    // One controller artifact may intentionally be projected to both its issue
    // and PR threads. Reject only duplicate copies within the same channel.
    const channel = comment.pr !== undefined ? `pr:${comment.pr}` : `issue:${comment.issue}`;
    const publicationKey = `${comment.artifactId}:${channel}`;
    const previous = artifactCommentIds.get(publicationKey);
    if (previous !== undefined && previous !== comment.id) {
      throw new Error(`Reset discovery found duplicate publication for artifact ${comment.artifactId} on ${channel}`);
    }
    artifactCommentIds.set(publicationKey, comment.id);
  }
  const labelMap = Object.fromEntries(labels.filter(([number]) => mutableIssues.has(number) && issueState.get(number) === "OPEN").map(([number, value]) => {
    const issueComments = managedComments.filter((comment) => comment.issue === number && comment.pr === undefined);
    const cutoffAt = firstWorkflowOwnershipCutoff([value], issueComments);
    return [String(number), {
      ...value,
      ...(cutoffAt !== undefined ? { cutoffAt } : {}),
      current: [...value.current].sort(),
      restored: replayLabels(value.events, cutoffAt),
    }];
  }));
  const issueRows = issues.map((issue) => ({ number: issue.number, state: issue.state, labels: [...issue.labels].sort(), bodySha256: sha256(issue.body) }));
  const actions: ResetAction[] = [
    { type: "fence-and-cancel", ids: [...captured.dags.map((dag) => dag.orchestrationId), ...captured.runs.map((run) => run.runId)] },
    { type: "stop-workers", ids: [...captured.runs.map((run) => run.runId)] },
    { type: "archive", paths: [...captured.archive.map((item) => item.path), ...worktrees.flatMap((item) => item.archivePath ? [item.archivePath] : [])] },
    { type: "purge-database", runs: captured.runs.length, artifacts: captured.artifacts.length, dags: captured.dags.length, tasks: captured.tasks.length, observations: captured.observations.length, fences: captured.fences.length, promotions: captured.promotions.length, leases: captured.leases.length },
    { type: "delete-comments", ids: managedComments.map((comment) => comment.id).sort((a, b) => a - b) },
    ...Object.entries(labelMap).map(([issue, state]) => ({ type: "restore-labels" as const, issue: Number(issue), labels: state.restored })),
    { type: "close-pull-requests", numbers: pullRequests.filter((pr) => pr.state === "OPEN").map((pr) => pr.number) },
    { type: "delete-exact-refs", refs: refs.map((ref) => ref.exactRef) },
    { type: "remove-worktrees", paths: worktrees.map((worktree) => worktree.path) },
    { type: "verify-postconditions" },
  ];
  return withResetManifestDigest({
    schema: "forgedock.pristine-reset/v1", repo: selection.repo, selection: { ...selection, issueNumbers, dagIds },
    issues: issueRows, labels: labelMap, comments: managedComments, pullRequests, refs, worktrees,
    runs: captured.runs, artifacts: captured.artifacts, tasks: captured.tasks, observations: captured.observations,
    fences: captured.fences, promotions: captured.promotions, dags: captured.dags,
    preservedNodes: captured.preservedNodes ?? [], preservedRunIds: [...new Set(captured.preservedRunIds ?? [])].sort(),
    preservedArtifactIds: [...new Set(captured.preservedArtifactIds ?? [])].sort(),
    leases: captured.leases,
    observationEvents: captured.observationEvents ?? [],
    archive: captured.archive, actions,
  });
}

/** Mutating phase. Every identity is checked before the first destructive action. */
export async function applyPristineReset(manifest: PristineResetManifest, expectedDigest: string, deps: ResetPlanDependencies, reason = "Approved pristine reset"): Promise<void> {
  assertResetManifestDigest(manifest, expectedDigest);
  await rereadManifestIdentities(manifest, deps, "before");
  await deps.cancellation.fence(manifest.selection, manifest.leases.map((lease) => lease.itemId));
  await deps.cancellation.stopWorkers(manifest.selection, manifest.leases.map((lease) => lease.itemId));
  // Fencing is a boundary, not merely a preflight check. Re-read after it so
  // a stale worker cannot publish a selected comment between discovery and
  // destruction.
  await rereadManifestIdentities(manifest, deps, "before");

  const archives: ResetArchiveIdentity[] = [...manifest.archive];
  const archiveStarted = Date.now();
  // The signed manifest is the abandonment authority; do not append a new
  // artifact after capture because it would escape exact purge identity.
  for (const worktree of manifest.worktrees) {
    if (worktree.dirty.length) {
      const archive = await deps.workspaces.archiveDirty(worktree);
      if (archive) archives.push(archive);
    }
  }
  if (deps.host.archiveSelectedEvidence) archives.push(...await deps.host.archiveSelectedEvidence(manifest.selection, manifest));
  if (deps.state.archiveSnapshots) archives.push(...await deps.state.archiveSnapshots(manifest.selection, manifest));
  await assertResetArchivesComplete(manifest, archives);
  emitResetProgress(deps, "archive", 1, 1, archiveStarted);

  const externalOperations: ResetMutationOperation[] = [];
  for (const comment of manifest.comments) {
    externalOperations.push({
      resource: `issue:${comment.issue}`,
      identity: `comment ${comment.id} on issue #${comment.issue}`,
      run: () => deps.host.deleteComment(manifest.repo, comment),
    });
  }
  for (const [issueText, expectedState] of Object.entries(manifest.labels).sort(([a], [b]) => Number(a) - Number(b))) {
    const issue = Number(issueText);
    externalOperations.push({
      resource: `issue:${issue}`,
      identity: `labels on issue #${issue}`,
      run: () => deps.host.restoreLabels(manifest.repo, issue, expectedState.restored, expectedState),
    });
  }
  for (const pr of manifest.pullRequests) if (pr.state === "OPEN") {
    externalOperations.push({
      resource: `issue:${pr.number}`,
      identity: `pull request #${pr.number}`,
      run: () => deps.host.closePullRequest(manifest.repo, pr.number, reason),
    });
  }
  for (const ref of manifest.refs) {
    externalOperations.push({
      resource: `ref:${ref.exactRef}`,
      identity: `ref ${ref.exactRef}`,
      run: () => deps.host.deleteExactRef(manifest.repo, ref.exactRef, ref.sha),
    });
  }
  const failures = await runResetMutations(externalOperations, deps, "external-mutations");

  const worktreeFailures = await runResetMutations(manifest.worktrees.map((worktree) => ({
    resource: `worktree:${worktree.path}`,
    identity: `worktree ${worktree.headSha}`,
    run: () => deps.workspaces.removeExact(worktree),
  })), deps, "worktrees");
  failures.push(...worktreeFailures);
  if (failures.length) {
    throw new AggregateError(failures, `Pristine reset mutations failed (${failures.length}); database purge was not attempted`);
  }

  const postconditionStarted = Date.now();
  await rereadManifestIdentities(manifest, deps, "after");
  emitResetProgress(deps, "postconditions", 1, 1, postconditionStarted);
  const purgeStarted = Date.now();
  await deps.state.purgeExactManifest({
    runs: manifest.runs.map(({ runId }) => ({ runId })),
    artifacts: manifest.artifacts.map(({ artifactId, subjectKey, kind }) => ({ artifactId, subjectKey, kind })),
    orchestrations: manifest.dags.map(({ orchestrationId }) => ({ orchestrationId })),
    promotions: manifest.promotions.map(({ promotionId }) => ({ promotionId })),
    telemetry: manifest.observations.map(({ key, runId, taskId, sessionRef }) => ({ telemetryKey: key, runId, taskId, sessionRef })),
    reviewFindingFences: manifest.fences.map(({ fenceKey }) => ({ fenceKey })),
    leases: manifest.leases.map(({ itemId }) => ({ itemId })),
    tasks: manifest.tasks, observations: manifest.observations, fences: manifest.fences, dags: manifest.dags,
  }, deps.now?.() ?? Date.now(), { allowAbsent: true });
  if (deps.state.observationPurgeExactManifest && manifest.observationEvents.length) {
    await deps.state.observationPurgeExactManifest({ events: manifest.observationEvents }, { allowAbsent: true });
  }
  if (deps.state.purgeTaskFiles) await deps.state.purgeTaskFiles(manifest.tasks);
  if (deps.state.verifyPurged) await deps.state.verifyPurged(manifest);
  if (deps.state.verifyPreserved) await deps.state.verifyPreserved(manifest);
  if (deps.state.observationVerifyPurged && manifest.observationEvents.length) await deps.state.observationVerifyPurged({ events: manifest.observationEvents });
  emitResetProgress(deps, "purge", 1, 1, purgeStarted);
}

interface ResetMutationOperation {
  resource: string;
  identity: string;
  run: () => Promise<void>;
}

async function runResetMutations(
  operations: readonly ResetMutationOperation[],
  deps: ResetPlanDependencies,
  stage: "external-mutations" | "worktrees",
): Promise<Error[]> {
  const started = Date.now();
  const concurrency = deps.mutationConcurrency ?? DEFAULT_RESET_MUTATION_CONCURRENCY;
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) throw new Error("Reset mutation concurrency must be a positive integer");
  const byResource = new Map<string, ResetMutationOperation[]>();
  for (const operation of operations) {
    const group = byResource.get(operation.resource) ?? [];
    group.push(operation);
    byResource.set(operation.resource, group);
  }
  let active = 0;
  const waiters: (() => void)[] = [];
  const acquire = async (): Promise<void> => {
    if (active < concurrency && waiters.length === 0) { active += 1; return; }
    await new Promise<void>((resolve) => waiters.push(resolve));
    active += 1;
  };
  const release = (): void => {
    active -= 1;
    waiters.shift()?.();
  };
  const failures = new Map<number, Error>();
  let completed = 0;
  const report = (): void => emitResetProgress(deps, stage, completed, operations.length, started);
  report();
  await Promise.all([...byResource.values()].map(async (group) => {
    for (const operation of group) {
      const index = operations.indexOf(operation);
      await acquire();
      try {
        await operation.run();
      } catch {
        // Keep the aggregate bounded to the signed, nonsecret resource identity.
        failures.set(index, new Error(`Reset ${operation.identity} failed`));
      } finally {
        completed += 1;
        report();
        release();
      }
    }
  }));
  return [...failures.entries()].sort(([a], [b]) => a - b).map(([, failure]) => failure);
}

function emitResetProgress(
  deps: ResetPlanDependencies,
  stage: ResetProgressStage,
  completed: number,
  total: number,
  started: number,
): void {
  try { deps.onProgress?.({ stage, completed, total, elapsedMs: Math.max(0, Date.now() - started) }); } catch {
    // Progress presentation is observational and must never alter reset authority.
  }
}

async function rereadManifestIdentities(manifest: PristineResetManifest, deps: ResetPlanDependencies, phase: "before" | "after"): Promise<void> {
  for (const issue of manifest.issues) {
    const current = await deps.host.readIssue(manifest.repo, issue.number);
    if (current.number !== issue.number || sha256(current.body) !== issue.bodySha256 || current.state !== issue.state) throw new Error(`Reset identity drift for issue #${issue.number}`);
  }
  for (const comment of manifest.comments) {
    const currentComments = comment.pr !== undefined && deps.host.listPullRequestComments
      ? await deps.host.listPullRequestComments(manifest.repo, comment.pr)
      : await deps.host.listComments(manifest.repo, comment.issue);
    const current = currentComments.find((candidate) => candidate.id === comment.id);
    if (phase === "after") {
      if (current) throw new Error(`Reset postcondition failed; comment remains: ${comment.id}`);
      continue;
    }
    if (current && (!current.managed || current.marker !== comment.marker || current.bodySha256 !== comment.bodySha256)) {
      throw new Error(`Reset comment identity drift: ${comment.id}`);
    }
  }
  if (phase === "before") {
    const runIds = new Set(manifest.runs.map((run) => run.runId));
    const artifactIds = new Set(manifest.artifacts.map((artifact) => artifact.artifactId));
    const dagIds = new Set(manifest.dags.map((dag) => dag.orchestrationId));
    const selectedIds = new Set(manifest.comments.map((comment) => comment.id));
    const issueComments = (await Promise.all(manifest.selection.issueNumbers
      .filter((issue) => manifest.labels[String(issue)] !== undefined)
      .map((issue) => deps.host.listComments(manifest.repo, issue)))).flat();
    const pullComments = deps.host.listPullRequestComments
      ? (await Promise.all(manifest.pullRequests.filter((pr) => pr.state === "OPEN").map((pr) => deps.host.listPullRequestComments!(manifest.repo, pr.number)))).flat()
      : [];
    for (const candidate of [...issueComments, ...pullComments]) {
      if (candidate.managed && isSelectedResetComment(candidate, runIds, artifactIds, dagIds) && !selectedIds.has(candidate.id)) {
        throw new Error(`Reset discovery drift; newly appeared selected comment: ${candidate.id}`);
      }
    }
  }
  for (const ref of manifest.refs) {
    const current = await deps.host.readRef(manifest.repo, ref.exactRef);
    if (phase === "after") {
      if (current !== undefined) throw new Error(`Reset postcondition failed; ref remains: ${ref.exactRef}`);
    } else if (current !== undefined && current.toLowerCase() !== ref.sha.toLowerCase()) throw new Error(`Reset ref identity drift: ${ref.exactRef}`);
  }
  for (const pr of manifest.pullRequests) {
    const current = await deps.host.readPullRequest(manifest.repo, pr.number);
    if (phase === "after") {
      if (current.state !== "CLOSED" && current.state !== "MERGED") throw new Error(`Reset postcondition failed; PR remains open: #${pr.number}`);
    } else if (current.state !== pr.state && !(pr.state === "OPEN" && (current.state === "CLOSED" || current.state === "MERGED"))) {
      throw new Error(`Reset PR identity drift: #${pr.number}`);
    }
    if (current.headSha.toLowerCase() !== pr.headSha.toLowerCase() || current.baseBranch !== pr.baseBranch) throw new Error(`Reset PR identity drift: #${pr.number}`);
  }
  for (const [issue, state] of Object.entries(manifest.labels)) {
    const current = await deps.host.readLabels(manifest.repo, Number(issue));
    const expected = phase === "before" ? state.current : state.restored;
    // Empty event projections in legacy fakes cannot prove a label history;
    // real GitHub captures always carry events for a restoration decision.
    if (state.events.length) {
      const currentLabels = new Set(current.current);
      const matches = (expectedLabels: readonly string[]): boolean => {
        const expectedSet = new Set(expectedLabels);
        return expectedLabels.every((label) => currentLabels.has(label))
          && ![...currentLabels].some((label) => isResetManagedLabel(label) && !expectedSet.has(label));
      };
      const matchesExpected = matches(expected);
      const matchesCompletedPhase = phase === "before" && matches(state.restored);
      if (!matchesExpected && !matchesCompletedPhase) throw new Error(`Reset label ${phase}condition drift: #${issue}`);
    }
  }
  if (phase === "after" && deps.workspaces.assertAbsent) {
    for (const worktree of manifest.worktrees) await deps.workspaces.assertAbsent(worktree);
  }
}

async function assertResetArchivesComplete(manifest: PristineResetManifest, archives: readonly ResetArchiveIdentity[]): Promise<void> {
  const seen = new Set<string>();
  for (const archive of archives) {
    if (seen.has(archive.path)) continue;
    seen.add(archive.path);
    if (!/^[0-9a-f]{64}$/i.test(archive.sha256)) throw new Error(`Reset archive has invalid hash: ${archive.path}`);
    let contents: Buffer;
    try { contents = await readFile(archive.path); } catch { throw new Error(`Reset archive is missing: ${archive.path}`); }
    if (sha256Bytes(contents) !== archive.sha256.toLowerCase()) throw new Error(`Reset archive hash mismatch: ${archive.path}`);
    const mode = (await stat(archive.path)).mode & 0o777;
    if (archive.kind !== "dirty-diff" && (mode & 0o077) !== 0) throw new Error(`Reset archive is not private: ${archive.path}`);
  }
  for (const archive of manifest.archive) {
    if (!seen.has(archive.path)) throw new Error(`Reset manifest archive was not verified: ${archive.path}`);
  }
  const dirtyCount = manifest.worktrees.filter((worktree) => worktree.dirty.length > 0).length;
  if (dirtyCount && archives.filter((archive) => archive.kind === "dirty-diff").length < dirtyCount) {
    throw new Error("Reset archive is incomplete; dirty worktree evidence is missing");
  }
}

function sha256Bytes(value: Uint8Array): string { return createHash("sha256").update(value).digest("hex"); }

/**
 * Select unfinished node identities without letting an issue selector authorize
 * an unselected DAG. Repeated runs may legitimately share an issue, but only an
 * explicit complete DAG selection proves that those identities belong together.
 */
export function selectResetDagNodes(
  dags: readonly OrchestrationRecord[],
  target: ResetSelection,
): {
  selected: Array<{ dag: OrchestrationRecord; node: OrchestrationNodeRecord }>;
  /** Terminal invalid nodes retain identity proof but may be mutable when explicitly selected and still open. */
  selectedInvalid: Array<{ dag: OrchestrationRecord; node: OrchestrationNodeRecord }>;
  preserved: Array<{ dag: OrchestrationRecord; node: OrchestrationNodeRecord; reason: "completed" | "invalid" | "unselected" }>;
} {
  const terminal = new Set(["completed", "invalid", "skipped"]);
  const candidates = dags.flatMap((dag) => dag.nodes.map((node) => ({ dag, node })));
  const selectedDagIds = new Set(target.dagIds);
  for (const dag of dags) {
    if (selectedDagIds.has(dag.orchestrationId) && dag.repository.trim().toLowerCase() !== target.repo.trim().toLowerCase()) {
      throw new Error(`Reset selection repository mismatch for DAG ${dag.orchestrationId}`);
    }
  }
  const selected = new Set<string>();
  if (target.issueNumbers.length) {
    for (const issue of target.issueNumbers) {
      const matches = candidates.filter(({ dag, node }) => {
        const repository = (node.repository ?? dag.repository).trim();
        return repository.toLowerCase() === target.repo.trim().toLowerCase()
          && (node.issue === issue || (node.memberIssues ?? []).includes(issue));
      });
      if (matches.length > 1) {
        const routeKeys = new Set(matches.map(({ dag, node }) => {
          const route = node.targetRouteClaim?.trim() ?? node.targetBranch?.trim();
          return route === undefined ? undefined : route.toLowerCase();
        }));
        const sameAuthority = routeKeys.size <= 1;
        const everyIdentityExplicitlySelected = matches.every(({ dag }) => selectedDagIds.has(dag.orchestrationId));
        if (!(sameAuthority && everyIdentityExplicitlySelected)) {
          throw new Error(`Reset selection is ambiguous for issue #${issue}; it maps to multiple repository/node/member identities`);
        }
      }
      if (matches.length === 0 && dags.length) {
        throw new Error(`Reset selection could not map issue #${issue} to an exact DAG node identity`);
      }
      for (const match of matches) selected.add(`${match.dag.orchestrationId}|${match.node.id}`);
    }
  } else if (selectedDagIds.size) {
    for (const { dag, node } of candidates) {
      if (selectedDagIds.has(dag.orchestrationId)) selected.add(`${dag.orchestrationId}|${node.id}`);
    }
  } else {
    for (const { dag, node } of candidates) selected.add(`${dag.orchestrationId}|${node.id}`);
  }
  const selectedNodes = candidates.filter(({ dag, node }) => selected.has(`${dag.orchestrationId}|${node.id}`) && !terminal.has(node.status));
  const selectedInvalid = candidates.filter(({ dag, node }) => selected.has(`${dag.orchestrationId}|${node.id}`) && node.status === "invalid");
  const preserved = candidates.filter(({ dag, node }) => !selected.has(`${dag.orchestrationId}|${node.id}`) || terminal.has(node.status)).map(({ dag, node }) => ({
    dag, node, reason: terminal.has(node.status) ? (node.status === "invalid" ? "invalid" : "completed") : "unselected",
  } as const));
  return { selected: selectedNodes, selectedInvalid, preserved };
}

export function replayLabels(events: readonly ResetLabelEvent[], before?: string): string[] {
  const labels = new Set<string>();
  for (const event of [...events]
    .filter((event) => before === undefined || event.occurredAt < before)
    .sort((a, b) => a.occurredAt.localeCompare(b.occurredAt) || a.eventId - b.eventId)) {
    if (event.action === "labeled") labels.add(event.name);
    else labels.delete(event.name);
  }
  return [...labels].sort();
}

function isSelectedResetComment(
  comment: ResetCommentSnapshot,
  _runIds: ReadonlySet<string>,
  artifactIds: ReadonlySet<string>,
  _dagIds: ReadonlySet<string>,
): boolean {
  // An artifact publication is selected only when its exact canonical artifact
  // marker names a locally persisted artifact. A copied body/run-id substring
  // is not an authorization to delete a comment.
  if (comment.artifactId !== undefined && artifactIds.has(comment.artifactId)
    && comment.marker === `artifact:${comment.artifactId}`) return true;
  // Reviewer/wave/trajectory markers have no deletion authority without a
  // durable publication ledger; leave them for human review.
  return false;
}

function isResetManagedLabel(label: string): boolean {
  return /^(?:workflow(?::|$)|needs-human(?:$|:))/i.test(label);
}

function firstWorkflowOwnershipCutoff(states: readonly ResetLabelState[], comments: readonly ResetCommentSnapshot[]): string | undefined {
  const labelCutoffs = states.flatMap((state) => state.events)
    .filter((event) => /^(?:workflow(?::|$)|needs-human(?:$|:))/i.test(event.name))
    .map((event) => event.occurredAt);
  const commentCutoffs = comments.map((comment) => comment.occurredAt).filter((value): value is string => value !== undefined);
  return [...labelCutoffs, ...commentCutoffs].sort()[0];
}

export function sha256(value: string): string { return createHash("sha256").update(value, "utf8").digest("hex"); }
export async function writeResetManifest(path: string, manifest: PristineResetManifest): Promise<void> {
  await mkdir(dirname(resolve(path)), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, path);
}

function uniqueNumbers(values: readonly number[]): number[] { return [...new Set(values)].sort((a, b) => a - b); }
function uniqueStrings(values: readonly string[]): string[] { return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort(); }
function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
}
