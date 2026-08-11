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

/** Serializable scheduler input retained so a controller can rebuild its DAG after restart. */
export interface OrchestrationItemRecord {
  id: string;
  issue: number;
  priority: number;
  dependencies: string[];
  claims: string[];
  affectedFiles?: string[];
  memberIssues?: number[];
  title?: string;
  summary?: string;
}

export interface OrchestrationNodeRecord extends OrchestrationItemRecord {
  status: DurableOrchestrationNodeStatus;
  error?: string;
  childRunIds: string[];
}

export interface OrchestrationRecord {
  schema: "forgedock.orchestration/v1";
  orchestrationId: string;
  repository: string;
  issueNumbers: number[];
  maxParallel: number;
  autoMerge: boolean;
  status: "running" | "completed" | "failed" | "cancelled";
  createdAt: string;
  updatedAt: string;
  nodes: OrchestrationNodeRecord[];
}

/** Durable operational record for a scheduler DAG; semantic issue state remains in artifacts and RunState. */
export interface OrchestrationRepository {
  createOrchestration(record: OrchestrationRecord): Promise<void>;
  loadOrchestration(orchestrationId: string): Promise<OrchestrationRecord | undefined>;
  saveOrchestration(record: OrchestrationRecord): Promise<void>;
  listOrchestrations(limit?: number): Promise<OrchestrationRecord[]>;
}
