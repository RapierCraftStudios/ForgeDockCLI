// SPDX-License-Identifier: AGPL-3.0-or-later

import { LeaseContinuityError } from "../../core/ports/lease.js";
import type { OrchestrationPlanMetadata, OrchestrationWaitReason } from "../../core/ports/orchestration.js";

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
  /** Caller-frozen evidence retained without influencing scheduler policy. */
  plan?: OrchestrationPlanMetadata;
}

export type ScheduledStatus = "queued" | "running" | "completed" | "skipped" | "failed" | "blocked" | "suspended" | "invalid";
export type ScheduleWorkerResult = void | {
  status: "completed" | "skipped" | "blocked" | "suspended" | "failed" | "invalid";
  error?: Error | string;
  /** Authoritative replacement issue numbers returned by a decomposition outcome. */
  childIssues?: readonly number[];
};
export type WaitReason = OrchestrationWaitReason;

export interface ScheduleResult {
  status: Map<string, ScheduledStatus>;
  errors: Map<string, Error>;
  startOrder: string[];
  waitReasons?: Map<string, WaitReason>;
  /** Decomposition outcomes discovered during this scheduler pass. */
  decompositions?: Map<string, number[]>;
}
export interface ScheduleEvent {
  type: "queued" | "started" | "completed" | "skipped" | "failed" | "blocked" | "suspended" | "invalid" | "resumed";
  itemId?: string;
  status: ReadonlyMap<string, ScheduledStatus>;
  errors: ReadonlyMap<string, Error>;
  waitReasons?: ReadonlyMap<string, WaitReason>;
}
export type ScheduleEventSink = (event: ScheduleEvent) => void;
export type ScheduleClaimsSink = (itemId: string, claims: readonly string[]) => void | Promise<void>;
export interface ScheduleWorkerContext {
  /** Add concrete Build Packet paths before the worker mutates its checkout. */
  promoteClaims(claims: readonly string[]): Promise<void>;
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
  const decompositions = new Map<string, number[]>();
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
      const blockingDependency = item.dependencies.find((id) => {
        const dependencyStatus = status.get(id);
        return dependencyStatus === "failed"
          || dependencyStatus === "blocked"
          || dependencyStatus === "skipped"
          || dependencyStatus === "invalid";
      });
      if (blockingDependency) {
        const dependencyStatus = status.get(blockingDependency);
        status.set(item.id, "blocked");
        errors.set(item.id, new Error(`Blocked by dependency ${blockingDependency} (${dependencyStatus ?? "unknown"})`));
        waitReasons.delete(item.id);
        queuedCount--;
        emit("blocked", item.id);
        continue;
      }
      const dependency = item.dependencies.find((id) => status.get(id) !== "completed");
      if (dependency) {
        const dependencyStatus = status.get(dependency);
        if (dependencyStatus === "suspended") {
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
        promoteClaims: async (claims) => {
          const merged = [...new Set([...(currentClaims.get(item.id) ?? []), ...claims.map((claim) => claim.trim()).filter(Boolean)])];
          // Re-read the live set here. A worker can discover Build Packet
          // paths after later workers have started, so the dispatch-time
          // `activeItems` snapshot is insufficient for promotion safety.
          const conflicts = [...running.keys()]
            .filter((activeId) => activeId !== item.id)
            .filter((activeId) => claimsConflict(merged, currentClaims.get(activeId) ?? []));
          if (conflicts.length) {
            // A worker may only publish claims after the scheduler has
            // admitted them. Keep the durable projection at its last admitted
            // value, but retain the attempted scope in this live scheduler so
            // an automatic retry waits for the conflicting worker instead of
            // hot-looping the same failed promotion.
            currentClaims.set(item.id, merged);
            throw new ClaimPromotionConflictError(item.id, conflicts);
          }
          const previousClaims = currentClaims.get(item.id);
          currentClaims.set(item.id, merged);
          try {
            // Publish the discovered Build Packet scope before exposing the
            // worker's conflict or completion to the scheduler. If the
            // durable sink rejects, roll back the in-memory claim projection.
            await options.onClaimsPromoted?.(item.id, merged);
          } catch (error) {
            if (previousClaims === undefined) currentClaims.delete(item.id);
            else currentClaims.set(item.id, previousClaims);
            throw error;
          }
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
            if (outcome.childIssues !== undefined) {
              const children = normalizeChildIssues(outcome.childIssues, item.issue);
              if (children.length) {
                decompositions.set(item.id, children);
                waitReasons.set(item.id, { kind: "decomposition-replan", children: [...children] });
              }
            }
            emit("skipped", item.id);
          } else if (outcome.status === "blocked") {
            status.set(item.id, "blocked");
            if (outcome.error !== undefined) errors.set(item.id, asError(outcome.error));
            emit("blocked", item.id);
          } else if (outcome.status === "suspended") {
            status.set(item.id, "suspended");
            if (outcome.error !== undefined) errors.set(item.id, asError(outcome.error));
            emit("suspended", item.id);
            const claimConflict = claimPromotionConflict(outcome.error);
            if (claimConflict) {
              // A promoted-claim conflict is transient and owned entirely by
              // this live scheduler. The controller has already persisted the
              // suspended attempt, so return the node to the queue and create
              // a fresh recovery attempt after the conflicting worker exits.
              status.set(item.id, "queued");
              errors.delete(item.id);
              const predecessor = claimConflict.conflicts[0];
              if (predecessor) {
                waitReasons.set(item.id, {
                  kind: "active-claim-conflict",
                  node: predecessor,
                  claims: overlappingClaims(currentClaims.get(item.id) ?? [], currentClaims.get(predecessor) ?? []),
                });
              }
              queuedCount++;
              emit("resumed", item.id);
            }
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
  return {
    status,
    errors,
    startOrder,
    ...(waitReasons.size ? { waitReasons } : {}),
    ...(decompositions.size ? { decompositions } : {}),
  };
}

function normalizeChildIssues(values: readonly number[], parentIssue: number): number[] {
  if (!Array.isArray(values)) throw new Error(`Decomposition children for #${parentIssue} must be an array`);
  const seen = new Set<number>();
  const children: number[] = [];
  for (const value of values) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new Error(`Decomposition child for #${parentIssue} is not a positive issue number: ${String(value)}`);
    }
    if (value === parentIssue) throw new Error(`Decomposition child for #${parentIssue} points back to its parent`);
    if (seen.has(value)) throw new Error(`Decomposition for #${parentIssue} contains duplicate child #${value}`);
    seen.add(value);
    children.push(value);
  }
  return children;
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

function claimPromotionConflict(value: unknown): ClaimPromotionConflictError | undefined {
  return value instanceof ClaimPromotionConflictError ? value : undefined;
}

export function claimsConflict(left: readonly string[], right: readonly string[]): boolean {
  return left.some((a) => right.some((b) => claimOverlaps(a, b)));
}

/**
 * Compare claims as repository scopes rather than as glob strings. A glob is
 * intentionally reduced to the nearest complete literal directory segment;
 * this is conservative for partial segments and uncertain bracket/brace
 * expressions, but it cannot let a wildcard escape its slash boundary.
 */
function claimOverlaps(left: string, right: string): boolean {
  const a = canonicalClaimScope(left);
  const b = canonicalClaimScope(right);
  if (a.kind === "component" || b.kind === "component") return a.value === b.value;
  return scopesOverlap(a.value, b.value);
}

function normalizeClaim(claim: string): string {
  return claim
    .trim()
    .replaceAll("\\", "/")
    .replace(/\/+/g, "/")
    .replace(/^(?:\.\/)+/, "")
    .replace(/\/+$/, "")
    .toLowerCase();
}

function canonicalClaimScope(claim: string): { kind: "component" | "path"; value: string } {
  const normalized = normalizeClaim(claim);
  if (normalized.startsWith("component:")) return { kind: "component", value: normalized };
  const firstGlob = normalized.search(/[*?[{]/);
  if (firstGlob < 0) return { kind: "path", value: normalized };
  // Keep only complete literal segments before the first uncertain segment.
  // Thus `src/foo*.ts` is conservatively scoped to `src`, while
  // `src/components/*.tsx` is scoped to `src/components`.
  const literalPrefix = normalized.slice(0, firstGlob);
  const segmentBoundary = literalPrefix.lastIndexOf("/");
  return {
    kind: "path",
    value: segmentBoundary < 0 ? "" : literalPrefix.slice(0, segmentBoundary),
  };
}

function scopesOverlap(left: string, right: string): boolean {
  // An absent literal prefix represents the repository-wide scope.
  return left === ""
    || right === ""
    || left === right
    || left.startsWith(`${right}/`)
    || right.startsWith(`${left}/`);
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
