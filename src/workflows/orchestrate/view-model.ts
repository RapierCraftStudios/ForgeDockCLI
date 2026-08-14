// SPDX-License-Identifier: AGPL-3.0-or-later

import type { DurableArtifact } from "../../core/artifacts/schema.js";
import type { Lease } from "../../core/ports/lease.js";
import type { ClaimSerializationEdge, ScheduledWorkItem, ScheduleResult, ScheduledStatus } from "./scheduler.js";
import type { OrchestrationNode, OrchestrationSnapshot } from "./events.js";

export function buildOrchestrationSnapshot(input: {
  orchestrationId: string;
  items: readonly ScheduledWorkItem[];
  result?: Pick<ScheduleResult, "status" | "errors" | "waitReasons">;
  activeLeases?: readonly Lease[];
  remediationCheckpoints?: readonly DurableArtifact<"RemediationBlocked">[];
  serializationEdges?: readonly ClaimSerializationEdge[];
  updatedAt?: string;
}): OrchestrationSnapshot {
  const status = input.result?.status ?? new Map(input.items.map((item) => [item.id, "queued" as ScheduledStatus]));
  const errors = input.result?.errors ?? new Map<string, Error>();
  const nodes: OrchestrationNode[] = input.items.map((item) => {
    const waitReason = input.result?.waitReasons?.get(item.id);
    const error = errors.get(item.id);
    return {
      id: item.id,
      issue: item.issue,
      memberIssues: [...(item.memberIssues ?? [item.issue])],
      status: status.get(item.id) ?? "queued",
      dependencies: [...item.dependencies],
      claims: [...item.claims],
      ...(item.promotionTarget !== undefined ? { promotionTarget: item.promotionTarget } : {}),
      ...(waitReason !== undefined ? { waitReason } : {}),
      ...(error !== undefined ? { error: error.message } : {}),
    };
  });
  const serializationPredecessors = new Map<string, string[]>();
  for (const edge of input.serializationEdges ?? []) {
    const predecessors = serializationPredecessors.get(edge.successor) ?? [];
    predecessors.push(edge.predecessor);
    serializationPredecessors.set(edge.successor, predecessors);
  }
  const isTerminal = (value: ScheduledStatus | undefined): boolean => value === "completed"
    || value === "failed"
    || value === "blocked"
    || value === "skipped"
    || value === "invalid";
  return {
    orchestrationId: input.orchestrationId,
    nodes,
    readyNodes: nodes.filter((node) => node.status === "queued"
      && node.dependencies.every((dependency) => status.get(dependency) === "completed")
      && (serializationPredecessors.get(node.id) ?? []).every((predecessor) => isTerminal(status.get(predecessor)))).map((node) => node.id),
    blockedNodes: nodes.filter((node) => node.status === "blocked" || node.status === "failed" || node.status === "skipped").map((node) => node.id),
    invalidNodes: nodes.filter((node) => node.status === "invalid").map((node) => node.id),
    suspendedNodes: nodes.filter((node) => node.status === "suspended").map((node) => node.id),
    activeLeases: [...(input.activeLeases ?? [])].map((lease) => lease.itemId),
    remediationCheckpoints: [...(input.remediationCheckpoints ?? [])].map((artifact) => ({
      checkpointKey: artifact.payload.checkpointKey,
      status: artifact.payload.status,
      parentIssue: artifact.payload.parentIssue,
      childIssues: [...artifact.payload.childIssues],
    })),
    updatedAt: input.updatedAt ?? new Date().toISOString(),
  };
}

export function renderOrchestrationBoard(snapshot: OrchestrationSnapshot): string {
  const lines = [`Orchestration ${snapshot.orchestrationId}`, `Updated ${snapshot.updatedAt}`, ""];
  for (const node of snapshot.nodes) {
    const members = node.memberIssues.length > 1 ? ` members=${node.memberIssues.map((issue) => `#${issue}`).join(",")}` : "";
    const promotion = node.promotionTarget ? ` promotion=${node.promotionTarget}` : "";
    const wait = node.waitReason ? ` wait=${renderWaitReason(node.waitReason)}` : "";
    const error = node.error ? ` — ${node.error}` : "";
    lines.push(`${statusGlyph(node.status)} #${node.issue}${members} [${node.status}] deps=${node.dependencies.join(",") || "none"}${promotion}${wait}${error}`);
  }
  if (snapshot.remediationCheckpoints.length) {
    lines.push("", "Review Desk");
    for (const checkpoint of snapshot.remediationCheckpoints) lines.push(`  #${checkpoint.parentIssue} ${checkpoint.status} · ${checkpoint.childIssues.map((issue) => `#${issue}`).join(", ") || "no children"}`);
  }
  return lines.join("\n");
}

export function renderRunTimeline(records: readonly { sequence: number; event: string; from: string; to: string; occurredAt: string; reason?: string }[]): string {
  return records.map((record) => `${record.occurredAt} · ${record.sequence} · ${record.from} --${record.event}--> ${record.to}${record.reason ? ` · ${record.reason}` : ""}`).join("\n");
}

function renderWaitReason(reason: import("./scheduler.js").WaitReason): string {
  switch (reason.kind) {
    case "dependency": return `dependency:${reason.predecessor}`;
    case "claim-serialization": return `claim:${reason.predecessor}`;
    case "active-claim-conflict": return `active-claim:${reason.node}`;
    case "capacity": return `capacity:${reason.maxParallel}`;
    case "suspended-predecessor": return `suspended:${reason.predecessor}`;
    case "decomposition-replan": return `replan:${reason.children.map((issue) => `#${issue}`).join(",")}`;
  }
}

function statusGlyph(status: ScheduledStatus): string {
  switch (status) {
    case "completed": return "✓";
    case "running": return "◆";
    case "blocked": return "■";
    case "failed": return "✕";
    case "invalid": return "!";
    case "skipped": return "↷";
    case "suspended": return "Ⅱ";
    default: return "·";
  }
}
