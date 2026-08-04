// SPDX-License-Identifier: AGPL-3.0-or-later

export { InMemoryLeaseRepository } from "../../core/ports/lease.js";
export type { Lease, LeaseRepository } from "../../core/ports/lease.js";

export interface ScheduledWorkItem {
  id: string;
  issue: number;
  priority: number;
  dependencies: readonly string[];
  claims: readonly string[];
}

export type ScheduledStatus = "queued" | "running" | "completed" | "failed" | "blocked";
export interface ScheduleResult {
  status: Map<string, ScheduledStatus>;
  errors: Map<string, Error>;
  startOrder: string[];
}

export interface ClaimSerializationEdge {
  predecessor: string;
  successor: string;
  overlappingClaims: string[];
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
  const mutable = new Map(items.map((item) => [item.id, { ...item, dependencies: [...item.dependencies], claims: [...item.claims] }]));
  const ordered = [...mutable.values()].sort((left, right) => left.issue - right.issue || left.id.localeCompare(right.id));
  const edges: ClaimSerializationEdge[] = [];

  for (let leftIndex = 0; leftIndex < ordered.length; leftIndex++) {
    for (let rightIndex = leftIndex + 1; rightIndex < ordered.length; rightIndex++) {
      const left = ordered[leftIndex]!;
      const right = ordered[rightIndex]!;
      if (!claimsConflict(left.claims, right.claims)) continue;
      if (dependsTransitively(mutable, right.id, left.id) || dependsTransitively(mutable, left.id, right.id)) continue;
      right.dependencies.push(left.id);
      edges.push({ predecessor: left.id, successor: right.id, overlappingClaims: overlappingClaims(left.claims, right.claims) });
    }
  }

  const result = items.map((item) => mutable.get(item.id)!);
  validateGraph(result);
  return { items: result, edges };
}

export function buildSchedulePreview(items: readonly ScheduledWorkItem[]): SchedulePreview {
  validateGraph(items);
  const byId = new Map(items.map((item) => [item.id, item]));
  const initialReady = items
    .filter((item) => item.dependencies.length === 0)
    .sort((left, right) => left.priority - right.priority || left.issue - right.issue);
  const paths = new Map<string, ScheduledWorkItem[]>();
  const pathTo = (item: ScheduledWorkItem): ScheduledWorkItem[] => {
    const known = paths.get(item.id);
    if (known) return known;
    const predecessors = item.dependencies.map((dependency) => pathTo(byId.get(dependency)!));
    const longest = predecessors.sort((left, right) => right.length - left.length || comparePaths(left, right))[0] ?? [];
    const path = [...longest, item];
    paths.set(item.id, path);
    return path;
  };
  const criticalPath = items.map(pathTo).sort((left, right) => right.length - left.length || comparePaths(left, right))[0] ?? [];
  return { initialReady, criticalPath };
}

export async function runSchedule(
  items: readonly ScheduledWorkItem[],
  maxParallel: number,
  worker: (item: ScheduledWorkItem) => Promise<void>,
): Promise<ScheduleResult> {
  if (!Number.isInteger(maxParallel) || maxParallel < 1) throw new Error("maxParallel must be a positive integer");
  validateGraph(items);
  const byId = new Map(items.map((item) => [item.id, item]));
  const status = new Map(items.map((item) => [item.id, "queued" as ScheduledStatus]));
  const errors = new Map<string, Error>();
  const startOrder: string[] = [];
  const running = new Map<string, Promise<void>>();

  while ([...status.values()].some((value) => value === "queued" || value === "running")) {
    for (const item of items) {
      if (status.get(item.id) !== "queued") continue;
      if (item.dependencies.some((id) => status.get(id) === "failed" || status.get(id) === "blocked")) {
        status.set(item.id, "blocked");
      }
    }

    const candidates = items
      .filter((item) => status.get(item.id) === "queued")
      .filter((item) => item.dependencies.every((id) => status.get(id) === "completed"))
      .sort((left, right) => left.priority - right.priority || left.issue - right.issue);

    for (const item of candidates) {
      if (running.size >= maxParallel) break;
      const activeItems = [...running.keys()].map((id) => byId.get(id)).filter((value): value is ScheduledWorkItem => Boolean(value));
      if (activeItems.some((active) => claimsConflict(item.claims, active.claims))) continue;
      status.set(item.id, "running");
      startOrder.push(item.id);
      const promise = worker(item)
        .then(() => { status.set(item.id, "completed"); })
        .catch((error: unknown) => {
          status.set(item.id, "failed");
          errors.set(item.id, error instanceof Error ? error : new Error(String(error)));
        })
        .finally(() => { running.delete(item.id); });
      running.set(item.id, promise);
    }

    if (running.size) {
      await Promise.race(running.values());
      continue;
    }
    const stranded = items.filter((item) => status.get(item.id) === "queued");
    if (stranded.length) {
      for (const item of stranded) status.set(item.id, "blocked");
    }
  }
  return { status, errors, startOrder };
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

export function validateGraph(items: readonly ScheduledWorkItem[]): void {
  const ids = new Set<string>();
  for (const item of items) {
    if (ids.has(item.id)) throw new Error(`Duplicate work item id: ${item.id}`);
    ids.add(item.id);
  }
  for (const item of items) {
    for (const dependency of item.dependencies) {
      if (!ids.has(dependency)) throw new Error(`Unknown dependency ${dependency} for ${item.id}`);
      if (dependency === item.id) throw new Error(`Work item ${item.id} depends on itself`);
    }
  }
  const byId = new Map(items.map((item) => [item.id, item]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string, path: string[]): void => {
    if (visiting.has(id)) throw new Error(`Dependency cycle: ${[...path, id].join(" -> ")}`);
    if (visited.has(id)) return;
    visiting.add(id);
    const item = byId.get(id);
    for (const dependency of item?.dependencies ?? []) visit(dependency, [...path, id]);
    visiting.delete(id);
    visited.add(id);
  };
  for (const item of items) visit(item.id, []);
}
