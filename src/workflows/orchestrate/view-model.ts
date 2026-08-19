// SPDX-License-Identifier: AGPL-3.0-or-later

import type { DurableArtifact } from "../../core/artifacts/schema.js";
import type { Lease } from "../../core/ports/lease.js";
import { scheduledWorkItemIssueSlots, type ClaimSerializationEdge, type ScheduledWorkItem, type ScheduleResult, type ScheduledStatus, type WaitReason } from "./scheduler.js";
import type { OrchestrationNode, OrchestrationRoute, OrchestrationSerializationChain, OrchestrationSerializationEdge, OrchestrationSnapshot } from "./events.js";

export function buildOrchestrationSnapshot(input: {
  orchestrationId: string;
  items: readonly ScheduledWorkItem[];
  result?: Pick<ScheduleResult, "status" | "errors" | "waitReasons">;
  activeLeases?: readonly Lease[];
  remediationCheckpoints?: readonly DurableArtifact<"RemediationBlocked">[];
  serializationEdges?: readonly ClaimSerializationEdge[];
  /** Optional projection metadata retained by durable records and read-only previews. */
  repository?: string;
  selectedIssueNumbers?: readonly number[];
  requestedMaxParallel?: number;
  transportCapacity?: number;
  effectiveMaxParallel?: number;
  updatedAt?: string;
}): OrchestrationSnapshot {
  const status = input.result?.status ?? new Map(input.items.map((item) => [item.id, "queued" as ScheduledStatus]));
  const errors = input.result?.errors ?? new Map<string, Error>();
  const nodes: OrchestrationNode[] = input.items.map((item) => {
    const waitReason = input.result?.waitReasons?.get(item.id);
    const error = errors.get(item.id);
    const route = routeFromItem(item, input.repository);
    return {
      id: item.id,
      issue: item.issue,
      memberIssues: [...(item.memberIssues ?? [item.issue])],
      status: status.get(item.id) ?? "queued",
      dependencies: [...item.dependencies],
      claims: [...item.claims],
      ...(item.title !== undefined ? { title: item.title } : {}),
      ...(route !== undefined ? { route } : {}),
      ...(item.promotionTarget !== undefined ? { promotionTarget: item.promotionTarget } : {}),
      ...(waitReason !== undefined ? { waitReason: structuredClone(waitReason) } : {}),
      ...(error !== undefined ? { error: error.message } : {}),
    };
  });
  const serializationPredecessors = new Map<string, string[]>();
  for (const edge of input.serializationEdges ?? []) {
    appendAdjacency(serializationPredecessors, edge.successor, edge.predecessor);
  }
  const isTerminal = (value: ScheduledStatus | undefined): boolean => value === "completed"
    || value === "failed"
    || value === "blocked"
    || value === "skipped"
    || value === "invalid";
  const readyNodes = nodes.filter((node) => node.status === "queued"
    && node.dependencies.every((dependency) => status.get(dependency) === "completed")
    && (serializationPredecessors.get(node.id) ?? []).every((predecessor) => isTerminal(status.get(predecessor)))).map((node) => node.id);
  const selectedIssueNumbers = normalizeSelectedIssues(input.selectedIssueNumbers
    ?? nodes.flatMap((node) => node.memberIssues?.length ? [...node.memberIssues] : [node.issue]));
  const ready = new Set(readyNodes);
  let selectedSlots = 0;
  let rawRunnableSlots = 0;
  for (const node of nodes) {
    const slots = scheduledWorkItemIssueSlots({
      id: node.id,
      issue: node.issue,
      priority: 0,
      dependencies: node.dependencies,
      claims: node.claims,
      memberIssues: node.memberIssues,
    });
    selectedSlots += slots;
    if (ready.has(node.id) && node.waitReason === undefined) rawRunnableSlots += slots;
  }
  const requestedCap = positiveInteger(input.requestedMaxParallel) ?? Math.max(1, selectedSlots);
  const transportCap = nonNegativeInteger(input.transportCapacity);
  const effectiveCap = nonNegativeInteger(input.effectiveMaxParallel)
    ?? (transportCap !== undefined ? Math.min(requestedCap, transportCap) : requestedCap);
  const runnableSlots = effectiveCap === 0 ? 0 : rawRunnableSlots;
  const projectedEdges = projectSerializationEdges(input.items, input.serializationEdges ?? [], input.repository);
  return {
    orchestrationId: input.orchestrationId,
    nodes,
    readyNodes,
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
    selectedIssueNumbers,
    issueSlots: {
      selected: selectedSlots,
      runnableNow: runnableSlots,
      requestedCap,
      ...(transportCap !== undefined ? { transportCap } : {}),
      effectiveCap,
    },
    serializationEdges: projectedEdges,
    serializationChains: buildSerializationChains(projectedEdges),
    updatedAt: input.updatedAt ?? new Date().toISOString(),
  };
}

export function renderOrchestrationBoard(snapshot: OrchestrationSnapshot): string {
  const lines = [`Orchestration ${snapshot.orchestrationId}`, `Updated ${snapshot.updatedAt}`, ""];
  const selected = snapshot.issueSlots?.selected ?? selectedIssueCount(snapshot);
  const runnable = snapshot.issueSlots?.runnableNow ?? runnableIssueSlots(snapshot);
  const requested = snapshot.issueSlots?.requestedCap;
  const transport = snapshot.issueSlots?.transportCap;
  const effective = snapshot.issueSlots?.effectiveCap ?? requested;
  lines.push(`Issue slots: ${selected} selected · ${runnable} runnable now · requested cap ${requested ?? "unknown"} · transport cap ${transport ?? "not sampled"} · effective cap ${effective ?? "unknown"}`);
  for (const node of snapshot.nodes) {
    const members = (node.memberIssues?.length ?? 0) > 1 ? ` members=${node.memberIssues.map((issue) => `#${issue}`).join(",")}` : "";
    const title = node.title ? ` ${safeInline(node.title)}` : "";
    const route = node.route ? ` route=${renderRoute(node.route)}` : "";
    const promotion = !node.route?.promotionTarget && node.promotionTarget ? ` promotion=${node.promotionTarget}` : "";
    const wait = node.waitReason ? ` wait=${renderWaitReason(node.waitReason)}` : "";
    const error = node.error ? ` — ${safeInline(node.error)}` : "";
    lines.push(`${statusGlyph(node.status)} #${node.issue}${members}${title} [${node.status}] semantic-deps=${node.dependencies.join(",") || "none"}${route}${promotion}${wait}${error}`);
  }
  lines.push(...renderSerializationLines(snapshot));
  if (snapshot.remediationCheckpoints.length) {
    lines.push("", "Review Desk");
    for (const checkpoint of snapshot.remediationCheckpoints) lines.push(`  #${checkpoint.parentIssue} ${checkpoint.status} · ${checkpoint.childIssues.map((issue) => `#${issue}`).join(", ") || "no children"}`);
  }
  return lines.join("\n");
}

export function renderSerializationLines(snapshot: Pick<OrchestrationSnapshot, "nodes" | "serializationEdges" | "serializationChains">): string[] {
  const byId = new Map(snapshot.nodes.map((node) => [node.id, node]));
  const chains = snapshot.serializationChains ?? buildSerializationChains(snapshot.serializationEdges ?? []);
  if (!chains.length) return ["Serialized same-route claim chains: none"];
  return [
    "Serialized same-route claim chains:",
    ...chains.map((chain) => {
      const issues = chain.nodes.map((id) => nodeLabel(byId.get(id), id)).join(" → ");
      const paths = [...new Set(chain.edges.flatMap((edge) => [...edge.paths]))];
      const route = chain.route ?? chain.edges.find((edge) => edge.route)?.route;
      return `  ${issues} · route ${route ? renderRoute(route) : "legacy/unknown"} · paths ${paths.join(", ") || "unknown"}`;
    }),
  ];
}

export function renderWaitReason(reason: WaitReason | { kind?: unknown; [key: string]: unknown }): string {
  switch (reason.kind) {
    case "dependency": return `semantic dependency ${(reason as WaitReason & { kind: "dependency" }).predecessor}`;
    case "claim-serialization": {
      const typed = reason as WaitReason & { kind: "claim-serialization" };
      return `serialized after ${typed.predecessor} on ${typed.claims.join(", ") || "overlapping claim"}`;
    }
    case "active-claim-conflict": {
      const typed = reason as WaitReason & { kind: "active-claim-conflict" };
      return `deferred behind active ${typed.node} on ${typed.claims.join(", ") || "overlapping claim"}; scheduler retries automatically`;
    }
    case "capacity": return `capacity ${(reason as WaitReason & { kind: "capacity" }).maxParallel} issue slot(s)`;
    case "suspended-predecessor": {
      const typed = reason as WaitReason & { kind: "suspended-predecessor" };
      return `suspended predecessor ${typed.predecessor} at ${typed.checkpoint}`;
    }
    case "decomposition-replan": return `decomposition replan ${(reason as WaitReason & { kind: "decomposition-replan" }).children.map((issue) => `#${issue}`).join(",")}`;
    default: return `unknown wait reason ${safeInline(String(reason.kind ?? "unknown"))}`;
  }
}

export function renderRunTimeline(records: readonly { sequence: number; event: string; from: string; to: string; occurredAt: string; reason?: string }[]): string {
  return records.map((record) => `${record.occurredAt} · ${record.sequence} · ${record.from} --${record.event}--> ${record.to}${record.reason ? ` · ${record.reason}` : ""}`).join("\n");
}

function appendAdjacency<T>(index: Map<string, T[]>, id: string, value: T): void {
  const values = index.get(id);
  if (values) values.push(value);
  else index.set(id, [value]);
}

function projectSerializationEdges(
  items: readonly ScheduledWorkItem[],
  edges: readonly ClaimSerializationEdge[],
  repository?: string,
): OrchestrationSerializationEdge[] {
  const byId = new Map(items.map((item) => [item.id, item]));
  return edges.map((edge) => {
    const route = routeFromItem(byId.get(edge.successor) ?? byId.get(edge.predecessor), repository);
    return {
      predecessor: edge.predecessor,
      successor: edge.successor,
      paths: [...edge.overlappingClaims],
      ...(route !== undefined ? { route } : {}),
    };
  });
}

function buildSerializationChains(edges: readonly OrchestrationSerializationEdge[]): OrchestrationSerializationChain[] {
  if (!edges.length) return [];
  const incoming = new Map<string, OrchestrationSerializationEdge[]>();
  const outgoing = new Map<string, OrchestrationSerializationEdge[]>();
  for (const edge of edges) {
    appendAdjacency(incoming, edge.successor, edge);
    appendAdjacency(outgoing, edge.predecessor, edge);
  }
  const visited = new Set<OrchestrationSerializationEdge>();
  const chains: OrchestrationSerializationChain[] = [];
  const addChain = (first: OrchestrationSerializationEdge): void => {
    if (visited.has(first)) return;
    const chainEdges = [first];
    const nodes = [first.predecessor, first.successor];
    visited.add(first);
    let current = first;
    while (true) {
      const nextEdges = outgoing.get(current.successor) ?? [];
      if (nextEdges.length !== 1 || (incoming.get(current.successor) ?? []).length !== 1) break;
      const next = nextEdges[0]!;
      if (visited.has(next) || routeKey(next.route) !== routeKey(first.route)) break;
      visited.add(next);
      chainEdges.push(next);
      nodes.push(next.successor);
      current = next;
    }
    chains.push({ nodes, edges: chainEdges, ...(first.route !== undefined ? { route: first.route } : {}) });
  };
  for (const edge of edges) {
    const predecessorIncoming = incoming.get(edge.predecessor) ?? [];
    const predecessorOutgoing = outgoing.get(edge.predecessor) ?? [];
    if (predecessorIncoming.length !== 1 || predecessorOutgoing.length !== 1) addChain(edge);
  }
  for (const edge of edges) addChain(edge);
  return chains;
}

function routeFromItem(item: ScheduledWorkItem | undefined, repository?: string): OrchestrationRoute | undefined {
  if (!item) return repository !== undefined ? { repository } : undefined;
  const effectiveRepository = item.repository ?? repository;
  if (effectiveRepository === undefined
    && item.targetBranch === undefined
    && item.lane === undefined
    && item.promotionTarget === undefined
    && item.productionTarget === undefined) return undefined;
  return {
    ...(effectiveRepository !== undefined ? { repository: effectiveRepository } : {}),
    ...(item.targetBranch !== undefined ? { targetBranch: item.targetBranch } : {}),
    ...(item.lane !== undefined ? { lane: item.lane } : {}),
    ...(item.promotionTarget !== undefined ? { promotionTarget: item.promotionTarget } : {}),
    ...(item.productionTarget !== undefined ? { productionTarget: item.productionTarget } : {}),
  };
}

function renderRoute(route: OrchestrationRoute): string {
  const repository = route.repository ?? "repository?";
  const target = route.targetBranch ?? "target?";
  const lane = route.lane ? ` (${route.lane})` : "";
  const promotion = route.promotionTarget ? ` → ${route.promotionTarget}` : "";
  const production = route.productionTarget ? ` → protected ${route.productionTarget}` : "";
  return `${repository}@${target}${lane}${promotion}${production}`;
}

function routeKey(route: OrchestrationRoute | undefined): string {
  return JSON.stringify(route ?? null);
}

function normalizeSelectedIssues(values: readonly number[]): number[] {
  return [...new Set(values.filter((value) => Number.isSafeInteger(value) && value > 0))];
}

function positiveInteger(value: number | undefined): number | undefined {
  return value !== undefined && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function nonNegativeInteger(value: number | undefined): number | undefined {
  return value !== undefined && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function selectedIssueCount(snapshot: OrchestrationSnapshot): number {
  if (snapshot.selectedIssueNumbers?.length) return snapshot.selectedIssueNumbers.length;
  return new Set(snapshot.nodes.flatMap((node) => node.memberIssues?.length ? [...node.memberIssues] : [node.issue])).size;
}

function runnableIssueSlots(snapshot: OrchestrationSnapshot): number {
  const ready = new Set(snapshot.readyNodes);
  return snapshot.nodes.filter((node) => ready.has(node.id)).reduce(
    (sum, node) => sum + Math.max(1, new Set(node.memberIssues?.length ? node.memberIssues : [node.issue]).size),
    0,
  );
}

function nodeLabel(node: OrchestrationNode | undefined, fallback: string): string {
  if (!node) return fallback;
  const members = (node.memberIssues?.length ?? 0) > 1 ? `[${node.memberIssues.map((issue) => `#${issue}`).join(", ")}]` : "";
  return `#${node.issue}${members}`;
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

function safeInline(value: string): string {
  return value.replace(/[ -]/g, " ").replace(/\s+/g, " ").trim();
}
