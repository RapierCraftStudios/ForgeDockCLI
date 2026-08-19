// SPDX-License-Identifier: AGPL-3.0-or-later

import type { RemediationBlockedPayload } from "../../core/artifacts/schema.js";
import type { ScheduleEvent, ScheduledStatus, WaitReason } from "./scheduler.js";

export type OrchestrationEventName = "queued" | "started" | "completed" | "skipped" | "failed" | "blocked" | "suspended" | "invalid" | "resumed" | "snapshot";

export interface OrchestrationRoute {
  repository?: string;
  targetBranch?: string;
  lane?: "fast" | "feature";
  promotionTarget?: string;
  productionTarget?: string;
}

export interface OrchestrationNode {
  id: string;
  issue: number;
  memberIssues: readonly number[];
  status: ScheduledStatus;
  dependencies: readonly string[];
  claims: readonly string[];
  /** Optional so snapshots serialized before route/title projection still render. */
  title?: string;
  route?: OrchestrationRoute;
  promotionTarget?: string;
  waitReason?: WaitReason;
  error?: string;
}

export interface OrchestrationSerializationEdge {
  predecessor: string;
  successor: string;
  /** Canonical overlapping claim paths/resources that force release ordering. */
  paths: readonly string[];
  route?: OrchestrationRoute;
}

export interface OrchestrationSerializationChain {
  nodes: readonly string[];
  edges: readonly OrchestrationSerializationEdge[];
  route?: OrchestrationRoute;
}

export interface OrchestrationIssueSlots {
  /** Source issue identities represented by the current DAG. */
  selected: number;
  /** Issue-weighted demand whose semantic and serialization predecessors are clear. */
  runnableNow: number;
  /** Caller-requested issue-slot ceiling. */
  requestedCap: number;
  /** Most recently observed transport availability; absent before the first sample. */
  transportCap?: number;
  /** Scheduler ceiling after transport backpressure. */
  effectiveCap: number;
}

export interface OrchestrationSnapshot {
  orchestrationId: string;
  nodes: OrchestrationNode[];
  readyNodes: string[];
  blockedNodes: string[];
  invalidNodes: string[];
  suspendedNodes: string[];
  activeLeases: string[];
  remediationCheckpoints: Array<{ checkpointKey: string; status: RemediationBlockedPayload["status"]; parentIssue: number; childIssues: readonly number[] }>;
  /** Additive presentation data; optional for old serialized snapshots. */
  selectedIssueNumbers?: readonly number[];
  issueSlots?: OrchestrationIssueSlots;
  serializationEdges?: readonly OrchestrationSerializationEdge[];
  serializationChains?: readonly OrchestrationSerializationChain[];
  updatedAt: string;
}

export interface OrchestrationEvent {
  name: OrchestrationEventName;
  orchestrationId: string;
  itemId?: string;
  snapshot: OrchestrationSnapshot;
  at: string;
}

export type OrchestrationEventSink = (event: OrchestrationEvent) => void;

export function orchestrationEventFromSchedule(
  scheduleEvent: ScheduleEvent,
  snapshot: OrchestrationSnapshot,
): OrchestrationEvent {
  return {
    name: scheduleEvent.type,
    orchestrationId: snapshot.orchestrationId,
    ...(scheduleEvent.itemId ? { itemId: scheduleEvent.itemId } : {}),
    snapshot,
    at: snapshot.updatedAt,
  };
}
