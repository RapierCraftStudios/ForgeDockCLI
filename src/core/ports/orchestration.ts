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
  waitReason?: OrchestrationWaitReason;
}

export interface OrchestrationNodeRecord extends OrchestrationItemRecord {
  status: DurableOrchestrationNodeStatus;
  error?: string;
  childRunIds: string[];
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
  /** Protected promotion target is policy metadata; dispatch never targets it implicitly. */
  productionTarget?: string;
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
  listOrchestrations(limit?: number): Promise<OrchestrationRecord[]>;
}
