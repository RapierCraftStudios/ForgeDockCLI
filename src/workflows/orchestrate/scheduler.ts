// SPDX-License-Identifier: AGPL-3.0-or-later

import { LeaseContinuityError } from "../../core/ports/lease.js";
import type { OrchestrationWaitReason } from "../../core/ports/orchestration.js";

export { InMemoryLeaseRepository } from "../../core/ports/lease.js";
export { LeaseContinuityError };
export type { Lease, LeaseRepository } from "../../core/ports/lease.js";

export interface ScheduledWorkItem {
  id: string;
  issue: number;
  priority: number;
  dependencies: readonly string[];
  claims: readonly string[];
  /** Frozen repository delivery route retained through scheduling and durable recovery. */
  targetBranch?: string;
  lane?: "fast" | "feature";
  promotionTarget?: string;
  productionTarget?: string;
  /** Bounded issue-derived paths retained through scheduling for worker scope hints. */
  affectedFiles?: readonly string[];
  memberIssues?: readonly number[];
  title?: string;
  summary?: string;
}

export type ScheduledStatus = "queued" | "running" | "completed" | "skipped" | "failed" | "blocked" | "suspended" | "invalid";
export type ScheduleWorkerResult = void | {
  status: "completed" | "skipped" | "blocked" | "suspended" | "failed" | "invalid";
  error?: Error | string;
};
export type WaitReason = OrchestrationWaitReason;

export interface ScheduleResult {
  status: Map<string, ScheduledStatus>;
  errors: Map<string, Error>;
  startOrder: string[];
  waitReasons?: Map<string, WaitReason>;
}
export interface ScheduleEvent {
  type: "queued" | "started" | "completed" | "skipped" | "failed" | "blocked" | "suspended" | "invalid" | "resumed";
  itemId?: string;
  status: ReadonlyMap<string, ScheduledStatus>;
  errors: ReadonlyMap<string, Error>;
  waitReasons?: ReadonlyMap<string, WaitReason>;
}
export type ScheduleEventSink = (event: ScheduleEvent) => void;
export type ScheduleClaimsSink = (itemId: string, claims: readonly string[]) => void;
export interface ScheduleWorkerContext {
  /** Add concrete Build Packet paths before the worker mutates its checkout. */
  promoteClaims(claims: readonly string[]): void;
}
export interface RunScheduleOptions {
  onEvent?: ScheduleEventSink;
  onClaimsPromoted?: ScheduleClaimsSink;
  /** Derived release-only edges; semantic dependencies remain on each item. */
  serializationEdges?: readonly ClaimSerializationEdge[];
  /** IDs being retried from a durable orchestration attempt. */
  resumedItemIds?: readonly string[];
}

export class ClaimPromotionConflictError extends Error {
  constructor(readonly itemId: string, readonly conflicts: readonly string[]) {
    super(`Promoted scheduler claims for ${itemId} conflict with active work: ${conflicts.join(", ")}`);
    this.name = "ClaimPromotionConflictError";
  }
}

export interface ClaimSerializationEdge {
  predecessor: string;
  successor: string;
  overlappingClaims: readonly string[];
}

export interface SchedulePreview {
  initialReady: ScheduledWorkItem[];
  criticalPath: ScheduledWorkItem[];
}

export function materializeClaimDependencies(items: readonly ScheduledWorkItem[]): {
  items: ScheduledWorkItem[];
  edges: ClaimSerializationEdge[];
} {
  validateGraph(items);
  // Keep claim serialization separate from semantic dependencies. A claim
  // conflict only means "wait until the predecessor releases its claim"; it
  // must not turn an invalid or failed predecessor into a reason to block
  // otherwise independent work.
  const graph = new Map(
    items.map((item) => [
      item.id,
      {
        ...item,
        dependencies: [...item.dependencies],
        claims: [...item.claims],
      },
    ]),
  );
  const ordered = [...graph.values()].sort(
    (left, right) => left.issue - right.issue || left.id.localeCompare(right.id),
  );
  const edges: ClaimSerializationEdge[] = [];

  for (let leftIndex = 0; leftIndex < ordered.length; leftIndex++) {
    for (let rightIndex = leftIndex + 1; rightIndex < ordered.length; rightIndex++) {
      const left = ordered[leftIndex]!;
      const right = ordered[rightIndex]!;
      if (!claimsConflict(left.claims, right.claims)) continue;
      if (
        dependsTransitively(graph, right.id, left.id)
        || dependsTransitively(graph, left.id, right.id)
      ) continue;
      // Track the derived edge only in the temporary ordering graph so later
      // conflicts do not create redundant transitive edges. It is deliberately
      // not copied to the returned item's semantic dependencies.
      graph.get(right.id)?.dependencies.push(left.id);
      edges.push({
        predecessor: left.id,
        successor: right.id,
        overlappingClaims: overlappingClaims(left.claims, right.claims),
      });
    }
  }

  const result = items.map((item) => ({
    ...item,
    dependencies: [...item.dependencies],
    claims: [...item.claims],
  }));
  validateGraph(result, edges);
  return { items: result, edges };
}

export function buildSchedulePreview(
  items: readonly ScheduledWorkItem[],
  serializationEdges: readonly ClaimSerializationEdge[] = [],
): SchedulePreview {
  validateGraph(items, serializationEdges);
  const byId = new Map(items.map((item) => [item.id, item]));
  const predecessorsBySuccessor = indexSerializationEdges(serializationEdges);
  const predecessorsFor = (item: ScheduledWorkItem): string[] => [
    ...new Set([
      ...item.dependencies,
      ...(predecessorsBySuccessor.get(item.id) ?? []),
    ]),
  ];
  const initialReady = items
    .filter((item) => predecessorsFor(item).length === 0)
    .sort((left, right) => left.priority - right.priority || left.issue - right.issue);
  const paths = new Map<string, ScheduledWorkItem[]>();
  const pathTo = (item: ScheduledWorkItem): ScheduledWorkItem[] => {
    const known = paths.get(item.id);
    if (known) return known;
    const predecessors = predecessorsFor(item).map((dependency) => pathTo(byId.get(dependency)!));
    const longest = predecessors.sort(
      (left, right) => right.length - left.length || comparePaths(left, right),
    )[0] ?? [];
    const path = [...longest, item];
    paths.set(item.id, path);
    return path;
  };
  const criticalPath = items
    .map(pathTo)
    .sort((left, right) => right.length - left.length || comparePaths(left, right))[0] ?? [];
  return { initialReady, criticalPath };
}

export async function runSchedule(
  items: readonly ScheduledWorkItem[],
  maxParallel: number,
  worker: (item: ScheduledWorkItem, context: ScheduleWorkerContext) => Promise<ScheduleWorkerResult>,
  options: RunScheduleOptions = {},
): Promise<ScheduleResult> {
  if (!Number.isInteger(maxParallel) || maxParallel < 1) throw new Error("maxParallel must be a positive integer");
  const serializationEdges = options.serializationEdges ?? [];
  validateGraph(items, serializationEdges);
  const orderedItems = [...items].sort((left, right) => left.priority - right.priority || left.issue - right.issue);
  const byId = new Map(items.map((item) => [item.id, item]));
  const predecessorsBySuccessor = indexSerializationEdges(serializationEdges);
  const status = new Map(items.map((item) => [item.id, "queued" as ScheduledStatus]));
  const errors = new Map<string, Error>();
  const waitReasons = new Map<string, WaitReason>();
  let queuedCount = items.length;
  const startOrder: string[] = [];
  const running = new Map<string, Promise<void>>();
  const currentClaims = new Map(items.map((item) => [item.id, [...item.claims]]));
  const emit = (type: ScheduleEvent["type"], itemId?: string) => options.onEvent?.({
    type,
    ...(itemId ? { itemId } : {}),
    status: new Map(status),
    errors: new Map(errors),
    ...(waitReasons.size ? { waitReasons: new Map(waitReasons) } : {}),
  });
  for (const item of items) emit("queued", item.id);
  for (const itemId of options.resumedItemIds ?? []) {
    if (!byId.has(itemId)) throw new Error(`Cannot resume unknown scheduled item ${itemId}`);
    emit("resumed", itemId);
  }

  while (running.size || queuedCount > 0) {
    for (const item of orderedItems) {
      if (status.get(item.id) !== "queued") continue;
      // Only explicit semantic dependencies block their successors on
      // failure. Claim-serialization predecessors merely hold the resource
      // until they reach a terminal state, including failed/blocked/invalid.
      const dependency = item.dependencies.find((id) => status.get(id) !== "completed");
      if (dependency) {
        const dependencyStatus = status.get(dependency);
        if (["failed", "blocked", "skipped", "invalid"].includes(dependencyStatus ?? "")) {
          status.set(item.id, "blocked");
          errors.set(item.id, new Error(`Blocked by dependency ${dependency} (${dependencyStatus ?? "unknown"})`));
          waitReasons.delete(item.id);
          queuedCount--;
          emit("blocked", item.id);
        } else if (dependencyStatus === "suspended") {
          waitReasons.set(item.id, { kind: "suspended-predecessor", predecessor: dependency, checkpoint: "durable-recovery" });
        } else {
          waitReasons.set(item.id, { kind: "dependency", predecessor: dependency });
        }
        continue;
      }
      const serializationPredecessor = (predecessorsBySuccessor.get(item.id) ?? [])
        .find((id) => !isTerminal(status.get(id)));
      if (serializationPredecessor) {
        const edge = serializationEdges.find((candidate) => candidate.predecessor === serializationPredecessor && candidate.successor === item.id);
        waitReasons.set(item.id, {
          kind: "claim-serialization",
          predecessor: serializationPredecessor,
          claims: [...(edge?.overlappingClaims ?? [])],
        });
      }
    }

    for (const item of orderedItems) {
      if (status.get(item.id) !== "queued"
        || !item.dependencies.every((id) => status.get(id) === "completed")
        || !(predecessorsBySuccessor.get(item.id) ?? []).every((id) => isTerminal(status.get(id)))) continue;
      if (running.size >= maxParallel) {
        waitReasons.set(item.id, { kind: "capacity", maxParallel });
        continue;
      }
      const activeItems = [...running.keys()].map((id) => byId.get(id)).filter((value): value is ScheduledWorkItem => Boolean(value));
      const conflicting = activeItems.find((active) => claimsConflict(currentClaims.get(item.id) ?? [], currentClaims.get(active.id) ?? []));
      if (conflicting) {
        waitReasons.set(item.id, {
          kind: "active-claim-conflict",
          node: conflicting.id,
          claims: overlappingClaims(currentClaims.get(item.id) ?? [], currentClaims.get(conflicting.id) ?? []),
        });
        continue;
      }
      waitReasons.delete(item.id);
      status.set(item.id, "running");
      queuedCount--;
      startOrder.push(item.id);
      emit("started", item.id);
      const context: ScheduleWorkerContext = {
        promoteClaims: (claims) => {
          const merged = [...new Set([...(currentClaims.get(item.id) ?? []), ...claims.map((claim) => claim.trim()).filter(Boolean)])];
          const conflicts = activeItems
            .filter((active) => active.id !== item.id)
            .filter((active) => claimsConflict(merged, currentClaims.get(active.id) ?? []))
            .map((active) => active.id);
          if (conflicts.length) throw new ClaimPromotionConflictError(item.id, conflicts);
          currentClaims.set(item.id, merged);
          options.onClaimsPromoted?.(item.id, merged);
        },
      };
      const promise = worker(item, context)
        .then((result) => {
          const outcome = result ?? { status: "completed" as const };
          if (outcome.status === "failed" && isLeaseContinuityFailure(outcome.error)) {
            // Continuity loss is a suspension, not an ordinary worker failure:
            // dependents stay queued until the controller explicitly re-enrolls
            // and resumes the retained DAG.
            status.set(item.id, "suspended");
            errors.set(item.id, asError(outcome.error));
            emit("suspended", item.id);
          } else if (outcome.status === "failed") {
            status.set(item.id, "failed");
            errors.set(item.id, asError(outcome.error ?? "scheduled worker failed"));
            emit("failed", item.id);
          } else if (outcome.status === "skipped") {
            status.set(item.id, "skipped");
            if (outcome.error !== undefined) errors.set(item.id, asError(outcome.error));
            emit("skipped", item.id);
          } else if (outcome.status === "blocked") {
            status.set(item.id, "blocked");
            if (outcome.error !== undefined) errors.set(item.id, asError(outcome.error));
            emit("blocked", item.id);
          } else if (outcome.status === "suspended") {
            status.set(item.id, "suspended");
            if (outcome.error !== undefined) errors.set(item.id, asError(outcome.error));
            emit("suspended", item.id);
          } else if (outcome.status === "invalid") {
            status.set(item.id, "invalid");
            if (outcome.error !== undefined) errors.set(item.id, asError(outcome.error));
            emit("invalid", item.id);
          } else {
            status.set(item.id, "completed");
            emit("completed", item.id);
          }
        })
        .catch((error: unknown) => {
          if (isLeaseContinuityFailure(error)) {
            // A thrown continuity error has the same durable meaning as an
            // explicit suspended result returned by a controller worker.
            status.set(item.id, "suspended");
            errors.set(item.id, error);
            emit("suspended", item.id);
          } else {
            status.set(item.id, "failed");
            errors.set(item.id, asError(error));
            emit("failed", item.id);
          }
        })
        .finally(() => { running.delete(item.id); });
      running.set(item.id, promise);
    }

    if (running.size) {
      await Promise.race(running.values());
      continue;
    }
    // A suspended prerequisite intentionally leaves its dependents queued so a
    // supervisor can resume the same DAG after durable child work completes.
    break;
  }
  return { status, errors, startOrder, ...(waitReasons.size ? { waitReasons } : {}) };
}

function isError(value: unknown): value is Error {
  return typeof value === "object" && value !== null && value instanceof Error;
}

function asError(value: unknown): Error {
  return isError(value) ? value : new Error(String(value));
}

export function isLeaseContinuityFailure(value: unknown): value is LeaseContinuityError {
  return value instanceof LeaseContinuityError
    || (isError(value) && (value as Error & { code?: unknown }).code === "LEASE_CONTINUITY_UNVERIFIABLE");
}

export function claimsConflict(left: readonly string[], right: readonly string[]): boolean {
  return left.some((a) => right.some((b) => claimOverlaps(a, b)));
}

function claimOverlaps(left: string, right: string): boolean {
  const a = normalizeClaim(left);
  const b = normalizeClaim(right);
  if (a.startsWith("component:") || b.startsWith("component:")) return a === b;
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

function normalizeClaim(claim: string): string {
  return claim.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, "").toLowerCase();
}

function overlappingClaims(left: readonly string[], right: readonly string[]): string[] {
  return [...new Set(left.flatMap((a) => right.filter((b) => claimOverlaps(a, b)).map((b) => `${a} ↔ ${b}`)))];
}

function dependsTransitively(items: ReadonlyMap<string, ScheduledWorkItem>, itemId: string, dependencyId: string): boolean {
  const pending = [...(items.get(itemId)?.dependencies ?? [])];
  const visited = new Set<string>();
  while (pending.length) {
    const current = pending.pop()!;
    if (current === dependencyId) return true;
    if (visited.has(current)) continue;
    visited.add(current);
    pending.push(...(items.get(current)?.dependencies ?? []));
  }
  return false;
}

function comparePaths(left: readonly ScheduledWorkItem[], right: readonly ScheduledWorkItem[]): number {
  return left.map((item) => item.issue).join(",").localeCompare(right.map((item) => item.issue).join(","));
}

function isTerminal(status: ScheduledStatus | undefined): boolean {
  return status === "completed"
    || status === "failed"
    || status === "blocked"
    || status === "skipped"
    || status === "invalid";
}

function indexSerializationEdges(
  edges: readonly ClaimSerializationEdge[],
): Map<string, string[]> {
  const predecessors = new Map<string, string[]>();
  for (const edge of edges) {
    const values = predecessors.get(edge.successor) ?? [];
    values.push(edge.predecessor);
    predecessors.set(edge.successor, values);
  }
  return predecessors;
}

export function validateGraph(
  items: readonly ScheduledWorkItem[],
  serializationEdges: readonly ClaimSerializationEdge[] = [],
): void {
  const ids = new Set<string>();
  for (const item of items) {
    if (ids.has(item.id)) throw new Error(`Duplicate work item id: ${item.id}`);
    ids.add(item.id);
  }
  const predecessorsBySuccessor = indexSerializationEdges(serializationEdges);
  for (const item of items) {
    for (const dependency of item.dependencies) {
      if (!ids.has(dependency)) throw new Error(`Unknown dependency ${dependency} for ${item.id}`);
      if (dependency === item.id) throw new Error(`Work item ${item.id} depends on itself`);
    }
  }
  for (const edge of serializationEdges) {
    if (!ids.has(edge.predecessor)) throw new Error(`Unknown serialization predecessor ${edge.predecessor} for ${edge.successor}`);
    if (!ids.has(edge.successor)) throw new Error(`Unknown serialization successor ${edge.successor} for ${edge.predecessor}`);
    if (edge.predecessor === edge.successor) throw new Error(`Work item ${edge.successor} serializes against itself`);
  }
  const byId = new Map(items.map((item) => [item.id, item]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string, path: string[]): void => {
    if (visiting.has(id)) throw new Error(`Dependency cycle: ${[...path, id].join(" -> ")}`);
    if (visited.has(id)) return;
    visiting.add(id);
    const item = byId.get(id);
    const predecessors = [
      ...(item?.dependencies ?? []),
      ...(predecessorsBySuccessor.get(id) ?? []),
    ];
    for (const dependency of new Set(predecessors)) visit(dependency, [...path, id]);
    visiting.delete(id);
    visited.add(id);
  };
  for (const item of items) visit(item.id, []);
}
