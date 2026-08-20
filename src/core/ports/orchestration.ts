// SPDX-License-Identifier: AGPL-3.0-or-later

export type DurableOrchestrationNodeStatus =
  | "queued"
  | "running"
  | "completed"
  | "skipped"
  | "failed"
  | "blocked"
  | "suspended"
  | "target_recovery"
  | "retry_wait"
  | "invalid";

export type OrchestrationWaitReason =
  | { kind: "dependency"; predecessor: string }
  | { kind: "claim-serialization"; predecessor: string; claims: string[] }
  | { kind: "active-claim-conflict"; node: string; claims: string[] }
  | { kind: "capacity"; maxParallel: number }
  | { kind: "suspended-predecessor"; predecessor: string; checkpoint: string }
  | { kind: "retry"; domain: string; code: string; nextAttemptAt: string; attempt: number; maxAttempts: number }
  | { kind: "decomposition-replan"; children: number[] };

/** JSON-safe, caller-defined evidence frozen with an orchestration plan. */
export type OrchestrationMetadataValue =
  | string
  | number
  | boolean
  | null
  | OrchestrationMetadataValue[]
  | { [key: string]: OrchestrationMetadataValue };

export type OrchestrationPlanMetadata = Record<string, OrchestrationMetadataValue>;

export type OrchestrationRecoveryMode = "initial" | "resume" | "relaunch" | "reattach";

export type OrchestrationWorkerAttemptStatus =
  | "launching"
  | "running"
  | "completed"
  | "skipped"
  | "failed"
  | "blocked"
  | "suspended"
  | "target_recovery"
  | "retry_wait"
  | "invalid"
  | "interrupted";

/**
 * Structured operational identity for one worker attempt. These fields are
 * deliberately transport-neutral: adapters may populate the identities they
 * own without teaching the orchestration domain about Pi or a process runner.
 */
export interface OrchestrationWorkerAttemptRecord {
  attemptId: string;
  attempt: number;
  recovery: OrchestrationRecoveryMode;
  status: OrchestrationWorkerAttemptStatus;
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  taskId?: string;
  controllerTaskId?: string;
  agentTaskId?: string;
  runId?: string;
  sessionId?: string;
  lastHeartbeatAt?: string;
  heartbeatSequence?: number;
  recoveryOfAttemptId?: string;
  /** Authoritative replacement scope persisted with a terminal skipped attempt. */
  decompositionChildren?: number[];
  error?: string;
  retryCheckpointId?: string;
  targetAdvanceCheckpointId?: string;
  retryable?: boolean;
  retryAfterMs?: number;
  retryNextAt?: string;
  retryDomain?: "github" | "provider" | "workflow" | "lease" | "transport";
  retryCode?: string;
}

export interface OrchestrationRecoveryRecord {
  mode: "reattach" | "relaunch" | "terminal";
  reconciledAt: string;
  attemptId?: string;
  taskId?: string;
  reason?: string;
}

/**
 * Exclusive controller admission for one orchestration execution. The
 * implementation is responsible for retaining/renewing the claim until
 * release; assertValid is the synchronous fencing gate used before dispatch
 * and every durable state transition.
 */
export interface OrchestrationExecutionClaim {
  /** Non-secret audit identity. Never expose a lease token or credential. */
  claimId: string;
  assertValid(): void;
  /** Persist through the claim's atomic lease fence when the repository supports it. */
  persist?(repository: OrchestrationRepository, record: OrchestrationRecord): Promise<void>;
  release(): void | Promise<void>;
}

/** Ephemeral fencing evidence; the token never belongs in durable records or diagnostics. */
export interface OrchestrationExecutionFence {
  itemId: string;
  token: string;
  epoch: number;
  now: () => number;
}

export interface OrchestrationListCursor {
  updatedAt: string;
  orchestrationId: string;
}

/** Non-secret diagnostics for one orchestration execution lease. */
export interface OrchestrationExecutionLeaseStatus {
  state: "active" | "expired" | "absent" | "unknown";
  owner?: string;
  heartbeatAt?: number;
  expiresAt?: number;
}

/** Cross-process admission stays behind a caller-owned operational port. */
export interface OrchestrationExecutionAdmission {
  acquire(orchestrationId: string): Promise<OrchestrationExecutionClaim | undefined>;
  /** Read-only lease diagnostics; implementations must never expose holder tokens. */
  describe?(orchestrationId: string): Promise<OrchestrationExecutionLeaseStatus>;
}

/** Serializable scheduler input retained so a controller can rebuild its DAG after restart. */
export interface OrchestrationItemRecord {
  id: string;
  issue: number;
  priority: number;
  dependencies: string[];
  claims: string[];
  /** Optional for records written before repository identity was stored per node. */
  repository?: string;
  targetBranch?: string;
  /** Normalized repository/target serialization resource. */
  targetRouteClaim?: string;
  lane?: "fast" | "feature";
  promotionTarget?: string;
  productionTarget?: string;
  affectedFiles?: string[];
  memberIssues?: number[];
  title?: string;
  summary?: string;
  /** Evidence and policy specific to this frozen plan node. */
  plan?: OrchestrationPlanMetadata;
  waitReason?: OrchestrationWaitReason;
}

export interface OrchestrationNodeRecord extends OrchestrationItemRecord {
  status: DurableOrchestrationNodeStatus;
  error?: string;
  childRunIds: string[];
  /** Authoritative replacement issue numbers when this node was decomposed. */
  decompositionChildren?: number[];
  /** Bounded decomposition lineage depth (root nodes are depth zero). */
  decompositionDepth?: number;
  /** Optional for records created before structured worker recovery existed. */
  attempts?: OrchestrationWorkerAttemptRecord[];
  activeAttemptId?: string;
  retryCheckpointId?: string;
  targetAdvanceCheckpointId?: string;
  retryable?: boolean;
  retryAfterMs?: number;
  lastRecovery?: OrchestrationRecoveryRecord;
}

/** Release-only ordering derived from overlapping claims, not a semantic dependency. */
export interface OrchestrationSerializationEdgeRecord {
  predecessor: string;
  successor: string;
  overlappingClaims: string[];
}

export interface OrchestrationRecord {
  schema: "forgedock.orchestration/v1";
  orchestrationId: string;
  repository: string;
  /** Original operator-authorized issue scope, before batching contraction. */
  requestedIssueNumbers?: number[];
  /** Backward-compatible scope field; new records preserve the requested set. */
  issueNumbers: number[];
  maxParallel: number;
  autoMerge: boolean;
  /** Complete caller-authorized plan/policy evidence, kept opaque to execution. */
  plan?: OrchestrationPlanMetadata;
  /** Protected promotion target is policy metadata; dispatch never targets it implicitly. */
  productionTarget?: string;
  /** Most recent controller execution/recovery attempt. */
  executionAttempt?: number;
  /** Capacity observed from the caller transport for the most recent attempt. */
  transportCapacity?: number;
  /** Effective scheduler cap: min(maxParallel, transportCapacity). */
  effectiveMaxParallel?: number;
  /** Non-secret identity of the controller claim used for the most recent execution. */
  executionClaimId?: string;
  status: "running" | "completed" | "failed" | "cancelled";
  createdAt: string;
  updatedAt: string;
  nodes: OrchestrationNodeRecord[];
  /** Optional for backward compatibility with pre-serialization-edge records. */
  serializationEdges?: OrchestrationSerializationEdgeRecord[];
}

/** Canonical repository-qualified identity for issue ownership. */
export interface OrchestrationIssueIdentity {
  repository: string;
  issue: number;
}

/**
 * Durable ownership overlap discovered while admitting a new orchestration.
 * One conflict groups the overlap for one owning DAG and repository; the
 * owning record remains the authoritative source for the complete DAG.
 */
export interface OrchestrationIssueOwnershipConflict {
  orchestrationId: string;
  repository: string;
  issueNumbers: number[];
}

/** Normalize repository identity consistently across durable ownership checks. */
export function normalizeOrchestrationRepository(repository: string): string {
  return repository.trim().toLowerCase();
}

/** Stable key for one repository-qualified issue identity. */
export function orchestrationIssueIdentityKey(identity: OrchestrationIssueIdentity): string {
  return JSON.stringify([normalizeOrchestrationRepository(identity.repository), identity.issue]);
}

/** Effective repository for a node, including records written before per-node identity existed. */
export function orchestrationNodeRepository(
  record: Pick<OrchestrationRecord, "repository">,
  node: Pick<OrchestrationItemRecord, "repository">,
): string {
  return normalizeOrchestrationRepository(node.repository?.trim() ? node.repository : record.repository);
}

/**
 * Return every canonical issue identity owned by a durable orchestration.
 *
 * Root scope fields belong to the record repository. A node and all of its
 * members/decomposition children belong to its effective repository. Missing
 * per-node repository identity is a legacy record and falls back to the root.
 */
export function orchestrationRecordIssueIdentities(record: OrchestrationRecord): OrchestrationIssueIdentity[] {
  const rootRepository = normalizeOrchestrationRepository(record.repository);
  const values: OrchestrationIssueIdentity[] = [
    ...(record.requestedIssueNumbers ?? []).map((issue) => ({ repository: rootRepository, issue })),
    ...record.issueNumbers.map((issue) => ({ repository: rootRepository, issue })),
    ...record.nodes.flatMap((node) => {
      const repository = orchestrationNodeRepository(record, node);
      return [
        { repository, issue: node.issue },
        ...(node.memberIssues ?? []).map((issue) => ({ repository, issue })),
        ...(node.decompositionChildren ?? []).map((issue) => ({ repository, issue })),
        ...(node.attempts ?? []).flatMap((attempt) =>
          (attempt.decompositionChildren ?? []).map((issue) => ({ repository, issue })),
        ),
      ];
    }),
  ];
  return [...new Map(values.map((identity) => [orchestrationIssueIdentityKey(identity), identity])).values()]
    .sort((left, right) => left.repository.localeCompare(right.repository) || left.issue - right.issue);
}

/** Backward-compatible unqualified view for callers that only support root-repository scope. */
export function orchestrationRecordIssueNumbers(record: OrchestrationRecord): number[] {
  return [...new Set(orchestrationRecordIssueIdentities(record).map((identity) => identity.issue))]
    .sort((left, right) => left - right);
}

/**
 * Find overlaps with running durable DAGs. Qualified callers may submit a
 * mixed-repository scope; the legacy three-argument form remains root-only.
 */
export function findRunningOrchestrationIssueConflicts(
  records: readonly OrchestrationRecord[],
  identities: readonly OrchestrationIssueIdentity[],
): OrchestrationIssueOwnershipConflict[];
export function findRunningOrchestrationIssueConflicts(
  records: readonly OrchestrationRecord[],
  repository: string,
  issueNumbers: readonly number[],
): OrchestrationIssueOwnershipConflict[];
export function findRunningOrchestrationIssueConflicts(
  records: readonly OrchestrationRecord[],
  repositoryOrIdentities: string | readonly OrchestrationIssueIdentity[],
  issueNumbers: readonly number[] = [],
): OrchestrationIssueOwnershipConflict[] {
  const identities = typeof repositoryOrIdentities === "string"
    ? issueNumbers.map((issue) => ({ repository: normalizeOrchestrationRepository(repositoryOrIdentities), issue }))
    : repositoryOrIdentities.map((identity) => ({
      repository: normalizeOrchestrationRepository(identity.repository),
      issue: identity.issue,
    }));
  const requested = new Set(identities.map(orchestrationIssueIdentityKey));
  const conflicts: OrchestrationIssueOwnershipConflict[] = [];
  for (const record of records) {
    if (record.status !== "running") continue;
    const byRepository = new Map<string, number[]>();
    for (const identity of orchestrationRecordIssueIdentities(record)) {
      if (!requested.has(orchestrationIssueIdentityKey(identity))) continue;
      const owned = byRepository.get(identity.repository) ?? [];
      owned.push(identity.issue);
      byRepository.set(identity.repository, owned);
    }
    for (const [repository, issues] of byRepository) {
      conflicts.push({
        orchestrationId: record.orchestrationId,
        repository,
        issueNumbers: [...new Set(issues)].sort((left, right) => left - right),
      });
    }
  }
  return conflicts.sort((left, right) =>
    left.orchestrationId.localeCompare(right.orchestrationId)
      || left.repository.localeCompare(right.repository),
  );
}

/**
 * Typed error used at the preview and durable insert boundaries. A fresh DAG
 * cannot bypass this conflict with the issue-worker `rerun` flag; recovery of
 * an already-owned scope belongs to the owning DAG's resume path.
 */
export class OrchestrationIssueOwnershipConflictError extends Error {
  constructor(readonly conflicts: readonly OrchestrationIssueOwnershipConflict[]) {
    const details = conflicts.map((conflict) =>
      `${conflict.issueNumbers.map((issue) => `${conflict.repository}#${issue}`).join(", ")} → ${conflict.orchestrationId}`,
    ).join("; ");
    super(
      `Orchestration scope conflicts with active durable DAG ownership: ${details}. `
      + "The fresh DAG was not admitted; resume the owning DAG or choose issues outside its active scope.",
    );
    this.name = "OrchestrationIssueOwnershipConflictError";
  }
}

/** Durable operational record for a scheduler DAG; semantic issue state remains in artifacts and RunState. */
export interface OrchestrationRepository {
  createOrchestration(record: OrchestrationRecord): Promise<void>;
  loadOrchestration(orchestrationId: string): Promise<OrchestrationRecord | undefined>;
  saveOrchestration(record: OrchestrationRecord): Promise<void>;
  /** Validate lease evidence and write the record in one repository transaction. */
  saveOrchestrationFenced?(record: OrchestrationRecord, fence: OrchestrationExecutionFence): Promise<void>;
  listOrchestrations(limit?: number): Promise<OrchestrationRecord[]>;
  /** Enumerate only running records in bounded keyset pages. */
  listRunningOrchestrations(limit?: number, before?: OrchestrationListCursor): Promise<OrchestrationRecord[]>;
}

export const MAX_ORCHESTRATION_PAGE_SIZE = 100;

/**
 * Read all bounded running-DAG pages before admitting a fresh scope. Durable
 * stores are allowed to retain more records than one status page, so callers
 * must not treat the first page as an exhaustive ownership index.
 */
export function findDurableOrchestrationIssueConflicts(
  repository: OrchestrationRepository,
  identities: readonly OrchestrationIssueIdentity[],
): Promise<OrchestrationIssueOwnershipConflict[]>;
export function findDurableOrchestrationIssueConflicts(
  repository: OrchestrationRepository,
  repositoryName: string,
  issueNumbers: readonly number[],
): Promise<OrchestrationIssueOwnershipConflict[]>;
export async function findDurableOrchestrationIssueConflicts(
  repository: OrchestrationRepository,
  repositoryOrIdentities: string | readonly OrchestrationIssueIdentity[],
  issueNumbers: readonly number[] = [],
): Promise<OrchestrationIssueOwnershipConflict[]> {
  const records: OrchestrationRecord[] = [];
  let before: OrchestrationListCursor | undefined;
  let previousCursor: string | undefined;
  while (true) {
    const page = await repository.listRunningOrchestrations(MAX_ORCHESTRATION_PAGE_SIZE, before);
    records.push(...page);
    if (page.length < MAX_ORCHESTRATION_PAGE_SIZE) break;
    const last = page[page.length - 1];
    if (!last) break;
    const cursor: OrchestrationListCursor = {
      updatedAt: last.updatedAt,
      orchestrationId: last.orchestrationId,
    };
    const cursorKey = `${cursor.updatedAt}\u0000${cursor.orchestrationId}`;
    if (cursorKey === previousCursor) break;
    previousCursor = cursorKey;
    before = cursor;
  }
  return typeof repositoryOrIdentities === "string"
    ? findRunningOrchestrationIssueConflicts(records, repositoryOrIdentities, issueNumbers)
    : findRunningOrchestrationIssueConflicts(records, repositoryOrIdentities);
}
