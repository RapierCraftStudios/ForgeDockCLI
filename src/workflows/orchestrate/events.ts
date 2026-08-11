// SPDX-License-Identifier: AGPL-3.0-or-later

import type { RemediationBlockedPayload } from "../../core/artifacts/schema.js";
import type { ScheduleEvent, ScheduledStatus } from "./scheduler.js";

export type OrchestrationEventName = "queued" | "started" | "completed" | "skipped" | "failed" | "blocked" | "suspended" | "invalid" | "resumed" | "snapshot";

export interface OrchestrationNode {
  id: string;
  issue: number;
  memberIssues: readonly number[];
  status: ScheduledStatus;
  dependencies: readonly string[];
  claims: readonly string[];
  error?: string;
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
