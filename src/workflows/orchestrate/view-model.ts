// SPDX-License-Identifier: AGPL-3.0-or-later

import type { DurableArtifact } from "../../core/artifacts/schema.js";
import type { Lease } from "../../core/ports/lease.js";
import type { ScheduledWorkItem, ScheduleResult, ScheduledStatus } from "./scheduler.js";
import type { OrchestrationNode, OrchestrationSnapshot } from "./events.js";

export function buildOrchestrationSnapshot(input: {
  orchestrationId: string;
  items: readonly ScheduledWorkItem[];
  result?: Pick<ScheduleResult, "status" | "errors">;
  activeLeases?: readonly Lease[];
  remediationCheckpoints?: readonly DurableArtifact<"RemediationBlocked">[];
  updatedAt?: string;
}): OrchestrationSnapshot {
  const status = input.result?.status ?? new Map(input.items.map((item) => [item.id, "queued" as ScheduledStatus]));
  const errors = input.result?.errors ?? new Map<string, Error>();
  const nodes: OrchestrationNode[] = input.items.map((item) => ({
    id: item.id,
    issue: item.issue,
    memberIssues: [...(item.memberIssues ?? [item.issue])],
    status: status.get(item.id) ?? "queued",
    dependencies: [...item.dependencies],
    claims: [...item.claims],
    ...(errors.get(item.id) ? { error: errors.get(item.id)!.message } : {}),
  }));
  return {
    orchestrationId: input.orchestrationId,
    nodes,
    readyNodes: nodes.filter((node) => node.status === "queued" && node.dependencies.every((dependency) => status.get(dependency) === "completed")).map((node) => node.id),
    blockedNodes: nodes.filter((node) => node.status === "blocked" || node.status === "failed").map((node) => node.id),
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
    const error = node.error ? ` — ${node.error}` : "";
    lines.push(`${statusGlyph(node.status)} #${node.issue}${members} [${node.status}] deps=${node.dependencies.join(",") || "none"}${error}`);
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

function statusGlyph(status: ScheduledStatus): string {
  switch (status) {
    case "completed": return "✓";
    case "running": return "◆";
    case "blocked":
    case "failed": return "■";
    case "suspended": return "Ⅱ";
    default: return "·";
  }
}
