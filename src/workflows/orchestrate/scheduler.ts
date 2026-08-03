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

export function buildScheduleBatches(items: readonly ScheduledWorkItem[], maxParallel: number): ScheduledWorkItem[][] {
  if (!Number.isInteger(maxParallel) || maxParallel < 1) throw new Error("maxParallel must be a positive integer");
  validateGraph(items);
  const remaining = new Map(items.map((item) => [item.id, item]));
  const completed = new Set<string>();
  const batches: ScheduledWorkItem[][] = [];

  while (remaining.size) {
    const ready = [...remaining.values()]
      .filter((item) => item.dependencies.every((dependency) => completed.has(dependency)))
      .sort((left, right) => left.priority - right.priority || left.issue - right.issue);
    if (!ready.length) throw new Error("Orchestration graph has no schedulable items");

    const waveIds: string[] = [];
    const pending = [...ready];
    while (pending.length) {
      const batch: ScheduledWorkItem[] = [];
      for (let index = 0; index < pending.length && batch.length < maxParallel;) {
        const candidate = pending[index]!;
        if (batch.some((active) => claimsConflict(candidate.claims, active.claims))) {
          index++;
          continue;
        }
        batch.push(candidate);
        pending.splice(index, 1);
      }
      if (!batch.length) batch.push(pending.shift()!);
      batches.push(batch);
      waveIds.push(...batch.map((item) => item.id));
    }
    for (const id of waveIds) {
      remaining.delete(id);
      completed.add(id);
    }
  }
  return batches;
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
