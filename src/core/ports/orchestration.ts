// SPDX-License-Identifier: AGPL-3.0-or-later

export type DurableOrchestrationNodeStatus =
  | "queued"
  | "running"
  | "completed"
  | "skipped"
  | "failed"
  | "blocked"
  | "suspended"
  | "invalid";

export type OrchestrationWaitReason =
  | { kind: "dependency"; predecessor: string }
  | { kind: "claim-serialization"; predecessor: string; claims: string[] }
  | { kind: "active-claim-conflict"; node: string; claims: string[] }
  | { kind: "capacity"; maxParallel: number }
  | { kind: "suspended-predecessor"; predecessor: string; checkpoint: string }
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
  error?: string;
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
  targetBranch?: string;
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
