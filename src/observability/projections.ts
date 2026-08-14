// SPDX-License-Identifier: AGPL-3.0-or-later

import { observationEntityId, type ObservationEnvelopeV1, type ObservationIdentity } from "./contracts.js";

export type ObservedEntityType = "run" | "work-unit" | "controller" | "agent" | "reviewer" | "task";
export type ObservedProcessState = "unknown" | "starting" | "alive" | "unresponsive" | "exited";
export type ObservedActivityKind =
  | "idle"
  | "thinking"
  | "running-tool"
  | "awaiting-supervisor"
  | "awaiting-user"
  | "awaiting-dependency"
  | "reviewing"
  | "recovering";
export type AttentionLevel = "none" | "info" | "action-required" | "blocker";

export interface ObservedEntity {
  id: string;
  type: ObservedEntityType;
  label: string;
  parentId?: string;
  identity: ObservationIdentity;
  workflow: {
    phase: string;
    state: string;
  };
  process: {
    state: ObservedProcessState;
    lastHeartbeatAt?: string;
  };
  activity: {
    kind: ObservedActivityKind;
    summary?: string;
    startedAt?: string;
  };
  attention: {
    level: AttentionLevel;
    reason?: string;
    decisionId?: string;
  };
  lastEventAt: string;
  lastSequence: number;
  childCount: number;
  outputLoss?: {
    truncated?: boolean;
    droppedEvents?: number;
  };
}

export interface ObservedAttention {
  id: string;
  entityId: string;
  level: Exclude<AttentionLevel, "none">;
  reason: string;
  decisionId?: string;
  createdAt: string;
  resolvedAt?: string;
}

export interface ObservedTimelineEntry {
  event: ObservationEnvelopeV1;
  entityId: string;
  summary: string;
}

export interface ObservationProjectionSnapshot {
  entities: ObservedEntity[];
  attention: ObservedAttention[];
  timeline: ObservedTimelineEntry[];
  output: ObservationEnvelopeV1[];
  updatedAt?: string;
}

const TERMINAL_STATES = new Set(["completed", "complete", "failed", "blocked", "cancelled", "stopped", "exited", "invalid"]);

export class ObservationProjector {
  readonly #entities = new Map<string, ObservedEntity>();
  readonly #attention = new Map<string, ObservedAttention>();
  readonly #timeline: ObservedTimelineEntry[] = [];
  readonly #output: ObservationEnvelopeV1[] = [];
  #updatedAt: string | undefined;

  apply(event: ObservationEnvelopeV1): void {
    const entityId = observationEntityId(event.identity, event.producer);
    const entity = this.#entities.get(entityId) ?? createEntity(entityId, event);
    const payload = asRecord(event.payload);
    const state = stringValue(payload?.state) ?? stringValue(payload?.status);
    const phase = stringValue(payload?.phase);
    const activity = activityFromEvent(event, payload);
    const processState = processStateFromEvent(event, state);
    const label = stringValue(payload?.label) ?? (this.#entities.has(entityId) ? entity.label : labelFor(event, entity.identity, entity.type));

    entity.label = label;
    entity.identity = { ...entity.identity, ...event.identity };
    const parentId = entity.identity.parentAgentId
      ?? (entity.identity.controllerTaskId && entity.id !== entity.identity.controllerTaskId ? entity.identity.controllerTaskId : undefined)
      ?? stringValue(payload?.parentId);
    if (parentId) entity.parentId = parentId;
    entity.workflow = {
      phase: phase ?? entity.workflow.phase,
      state: state ?? entity.workflow.state,
    };
    entity.process = {
      state: processState ?? entity.process.state,
      ...(processState === "alive" || event.kind.endsWith("heartbeat") ? { lastHeartbeatAt: event.occurredAt } : entity.process.lastHeartbeatAt ? { lastHeartbeatAt: entity.process.lastHeartbeatAt } : {}),
    };
    entity.activity = {
      kind: activity.kind ?? entity.activity.kind,
      ...(activity.summary ? { summary: activity.summary } : entity.activity.summary ? { summary: entity.activity.summary } : {}),
      ...(activity.startedAt ? { startedAt: activity.startedAt } : entity.activity.startedAt ? { startedAt: entity.activity.startedAt } : {}),
    };
    entity.lastEventAt = event.occurredAt;
    entity.lastSequence = event.runSequence;
    entity.childCount = [...this.#entities.values()].filter((candidate) => candidate.parentId === entity.id).length;
    if (event.delivery.truncated || event.delivery.droppedEvents) {
      entity.outputLoss = {
        ...(event.delivery.truncated ? { truncated: true } : {}),
        ...(event.delivery.droppedEvents ? { droppedEvents: event.delivery.droppedEvents } : {}),
      };
    }
    this.#entities.set(entityId, entity);
    this.refreshParentCounts();

    const summary = summaryFor(event, payload);
    this.#timeline.push({ event, entityId, summary });
    if (this.#timeline.length > 2_000) this.#timeline.splice(0, this.#timeline.length - 2_000);
    if (event.channel === "stdout" || event.channel === "stderr" || event.channel === "tool" || event.kind.startsWith("output.")) {
      this.#output.push(event);
      if (this.#output.length > 1_000) this.#output.splice(0, this.#output.length - 1_000);
    }

    if (event.kind === "attention.created") this.addAttention(event, entityId, payload);
    if (event.kind === "attention.resolved") this.resolveAttention(payload);
    this.refreshEntityAttention(entityId);
    this.#updatedAt = event.ingestedAt;
  }

  snapshot(): ObservationProjectionSnapshot {
    return {
      entities: [...this.#entities.values()].sort(compareEntities),
      attention: [...this.#attention.values()].filter((item) => !item.resolvedAt).sort((left, right) => right.createdAt.localeCompare(left.createdAt)),
      timeline: [...this.#timeline].reverse(),
      output: [...this.#output].reverse(),
      ...(this.#updatedAt ? { updatedAt: this.#updatedAt } : {}),
    };
  }

  clear(): void {
    this.#entities.clear();
    this.#attention.clear();
    this.#timeline.length = 0;
    this.#output.length = 0;
    this.#updatedAt = undefined;
  }

  private addAttention(event: ObservationEnvelopeV1, entityId: string, payload: Record<string, unknown> | undefined): void {
    const id = stringValue(payload?.attentionId) ?? event.eventId;
    const level = stringValue(payload?.level);
    if (level !== "info" && level !== "action-required" && level !== "blocker") return;
    const decisionId = stringValue(payload?.decisionId);
    this.#attention.set(id, {
      id,
      entityId,
      level,
      reason: stringValue(payload?.reason) ?? "Attention required",
      ...(decisionId ? { decisionId } : {}),
      createdAt: event.occurredAt,
    });
  }

  private resolveAttention(payload: Record<string, unknown> | undefined): void {
    const id = stringValue(payload?.attentionId);
    if (!id) return;
    const current = this.#attention.get(id);
    if (current) this.#attention.set(id, { ...current, resolvedAt: new Date().toISOString() });
  }

  private refreshParentCounts(): void {
    for (const entity of this.#entities.values()) {
      entity.childCount = [...this.#entities.values()].filter((candidate) => candidate.parentId === entity.id).length;
    }
  }

  private refreshEntityAttention(entityId: string): void {
    const active = [...this.#attention.values()]
      .filter((item) => item.entityId === entityId && !item.resolvedAt)
      .sort((left, right) => attentionRank(right.level) - attentionRank(left.level));
    const current = active[0];
    const entity = this.#entities.get(entityId);
    if (!entity) return;
    entity.attention = current
      ? { level: current.level, reason: current.reason, ...(current.decisionId ? { decisionId: current.decisionId } : {}) }
      : { level: "none" };
  }
}

function attentionRank(level: Exclude<AttentionLevel, "none">): number {
  return level === "blocker" ? 3 : level === "action-required" ? 2 : 1;
}

function createEntity(id: string, event: ObservationEnvelopeV1): ObservedEntity {
  const type = entityTypeFor(event);
  return {
    id,
    type,
    label: labelFor(event, event.identity, type),
    ...(event.identity.parentAgentId ? { parentId: event.identity.parentAgentId } : {}),
    identity: { ...event.identity },
    workflow: { phase: "unknown", state: "unknown" },
    process: { state: "unknown" },
    activity: { kind: "idle" },
    attention: { level: "none" },
    lastEventAt: event.occurredAt,
    lastSequence: event.runSequence,
    childCount: 0,
  };
}

function entityTypeFor(event: ObservationEnvelopeV1): ObservedEntityType {
  if (event.identity.agentRole === "reviewer" || event.source === "reviewer") return "reviewer";
  if (event.identity.controllerTaskId || event.source === "controller" || event.source === "process") return "controller";
  if (event.identity.agentTaskId || event.source === "agent" || event.source === "tool") return "agent";
  if (event.identity.workUnitId || event.identity.nodeId) return "work-unit";
  if (event.identity.forgeRunId || event.identity.orchestrationId || event.source === "workflow") return "run";
  return "task";
}

function labelFor(event: ObservationEnvelopeV1, identity: ObservationIdentity, type: ObservedEntityType): string {
  const payload = asRecord(event.payload);
  const explicit = stringValue(payload?.label) ?? stringValue(payload?.description);
  if (explicit) return explicit;
  if (identity.issueNumber !== undefined) return `#${identity.issueNumber} ${identity.agentRole ?? type}`;
  if (identity.agentRole) return identity.agentRole;
  if (identity.controllerTaskId) return `controller ${identity.controllerTaskId.slice(0, 12)}`;
  if (identity.piAsyncId) return `async ${identity.piAsyncId.slice(0, 12)}`;
  return identity.forgeRunId ?? identity.orchestrationId ?? `${type} ${event.producer.processInstanceId.slice(-8)}`;
}

function activityFromEvent(event: ObservationEnvelopeV1, payload: Record<string, unknown> | undefined): { kind?: ObservedActivityKind; summary?: string; startedAt?: string } {
  if (event.kind === "tool.started") return withActivity("running-tool", stringValue(payload?.tool) ?? "Running tool", event.occurredAt);
  if (event.kind === "tool.completed") return withActivity("idle", stringValue(payload?.summary));
  if (event.kind === "activity.changed" || event.kind === "progress.updated") {
    const value = stringValue(payload?.activity) ?? stringValue(payload?.kind);
    return withActivity(normalizeActivity(value), stringValue(payload?.summary), event.occurredAt);
  }
  if (event.kind === "attention.created") return withActivity("awaiting-user", stringValue(payload?.reason));
  if (event.kind.includes("review")) return withActivity("reviewing", stringValue(payload?.summary));
  if (event.kind.includes("recover")) return withActivity("recovering", stringValue(payload?.summary));
  if (event.kind === "lifecycle.completed" || event.kind === "lifecycle.failed") return { kind: "idle" };
  return {};
}

function withActivity(kind: ObservedActivityKind, summary?: string, startedAt?: string): { kind: ObservedActivityKind; summary?: string; startedAt?: string } {
  return {
    kind,
    ...(summary ? { summary } : {}),
    ...(startedAt ? { startedAt } : {}),
  };
}

function normalizeActivity(value: string | undefined): ObservedActivityKind {
  if (value === "thinking" || value === "running-tool" || value === "awaiting-supervisor" || value === "awaiting-user" || value === "awaiting-dependency" || value === "reviewing" || value === "recovering") return value;
  return "idle";
}

function processStateFromEvent(event: ObservationEnvelopeV1, state: string | undefined): ObservedProcessState | undefined {
  if (event.kind === "process.started" || event.kind === "lifecycle.started" || event.kind === "agent.session.started") return "alive";
  if (event.kind === "process.heartbeat" || event.kind === "process.adopted") return "alive";
  if (event.kind === "process.unresponsive") return "unresponsive";
  if (event.kind === "process.exited" || event.kind === "lifecycle.completed" || event.kind === "lifecycle.failed" || (state && TERMINAL_STATES.has(state))) return "exited";
  return undefined;
}

function summaryFor(event: ObservationEnvelopeV1, payload: Record<string, unknown> | undefined): string {
  return stringValue(payload?.summary)
    ?? stringValue(payload?.message)
    ?? stringValue(payload?.reason)
    ?? (event.kind === "output.dropped" ? "Output was dropped" : event.kind.replaceAll(".", " "));
}

function compareEntities(left: ObservedEntity, right: ObservedEntity): number {
  const attentionRank = (entity: ObservedEntity) => entity.attention.level === "blocker" ? 3 : entity.attention.level === "action-required" ? 2 : entity.process.state === "unresponsive" ? 1 : 0;
  return attentionRank(right) - attentionRank(left) || right.lastEventAt.localeCompare(left.lastEventAt) || left.label.localeCompare(right.label);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
