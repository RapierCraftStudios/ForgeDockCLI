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
  /** Optional for legacy records; new work retains its repository identity per node. */
  repository?: string;
  /** Normalized target-sensitive serialization resource, retained on every delivery item. */
  targetRouteClaim?: string;
  /** Frozen repository delivery route retained through scheduling and durable recovery. */
  targetBranch?: string;
  /** Durable retry wake-up metadata; omitted for legacy queued items. */
  retryNextAt?: string;
  retryAttempt?: number;
  retryMaxAttempts?: number;
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

export type ScheduledStatus = "queued" | "running" | "completed" | "skipped" | "failed" | "blocked" | "suspended" | "target_recovery" | "retry_wait" | "invalid";
export type ScheduleWorkerResult = void | {
  status: "completed" | "skipped" | "blocked" | "suspended" | "target_recovery" | "retry_wait" | "failed" | "invalid";
  error?: Error | string;
  retryable?: boolean;
  retryCheckpointId?: string;
  targetAdvanceCheckpointId?: string;
  retryAfterMs?: number;
  nextAttemptAt?: string;
  attempt?: number;
  maxAttempts?: number;
  retryDomain?: string;
  retryCode?: string;
  operationKey?: string;
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
  /** Last live transport capacity observed by this scheduler pass. */
  observedCapacity?: number;
}
export interface ScheduleEvent {
  type: "queued" | "started" | "completed" | "skipped" | "failed" | "blocked" | "suspended" | "target_recovery" | "retry_wait" | "invalid" | "resumed";
  itemId?: string;
  status: ReadonlyMap<string, ScheduledStatus>;
  errors: ReadonlyMap<string, Error>;
  waitReasons?: ReadonlyMap<string, WaitReason>;
}
export type ScheduleEventSink = (event: ScheduleEvent) => void;
export type ScheduleClaimsSink = (itemId: string, claims: readonly string[]) => void | Promise<void>;
/**
 * A transport may expose either a fixed bound or the number of currently
 * available slots. Function sources are sampled while the queue is live; a
 * zero value is backpressure, not a launch failure.
 */
export type ScheduleCapacity = number | (() => number | Promise<number>);
export interface ScheduleWorkerContext {
  /** Add concrete Build Packet paths before the worker mutates its checkout. */
  promoteClaims(claims: readonly string[]): Promise<void>;
  /** Promote the normalized repository/target route immediately before mutation. */
  promoteTargetRouteClaim(): Promise<void>;
}
export interface RunScheduleOptions {
  onEvent?: ScheduleEventSink;
  onClaimsPromoted?: ScheduleClaimsSink;
  /** Current transport capacity. Function sources are read before launches. */
  capacity?: ScheduleCapacity;
  /** Poll interval while queued work is waiting for capacity to return. */
  capacityPollMs?: number;
  /** Observe each live capacity sample without making it part of scheduling policy. */
  onCapacityObserved?: (capacity: number) => void;
  /** Cancel a queue that is waiting on a permanently unavailable transport. */
  signal?: AbortSignal;
  /** Derived release-only edges; semantic dependencies remain on each item. */
  serializationEdges?: readonly ClaimSerializationEdge[];
  /** IDs being retried from a durable orchestration attempt. */
  resumedItemIds?: readonly string[];
}

export class ClaimPromotionConflictError extends Error {
  constructor(readonly itemId: string, readonly conflicts: readonly string[]) {
    super(`Promoted scheduler claims for ${itemId} are deferred while active work holds overlapping scope (${conflicts.join(", ")}); the scheduler will retry automatically after release`);
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
  /** Issue-weighted demand; one contracted node can occupy several issue slots. */
  issueSlots: {
    total: number;
    initialReady: number;
  };
}

export interface ClaimMaterializationDiagnostics {
  conflictCandidates: number;
  reachabilityChecks: number;
  reachabilityNodeVisits: number;
  frontierUpdates: number;
}

export function materializeClaimDependencies(
  items: readonly ScheduledWorkItem[],
  diagnostics?: ClaimMaterializationDiagnostics,
): {
  items: ScheduledWorkItem[];
  edges: ClaimSerializationEdge[];
} {
  if (diagnostics) {
    diagnostics.conflictCandidates = 0;
    diagnostics.reachabilityChecks = 0;
    diagnostics.reachabilityNodeVisits = 0;
    diagnostics.frontierUpdates = 0;
  }
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
  const ordered = topologicallyOrderItems(graph);
  const edges: ClaimSerializationEdge[] = [];

  // Claims are canonical repository scopes (or exact component resources),
  // so an item only conflicts with equal/ancestor/descendant path scopes on a
  // route that can touch the same checkout. Partition known repository/target
  // routes before indexing scopes; legacy items without complete route evidence
  // remain in a conservative cross-route frontier.
  const claimIndex = createRoutedClaimScopeIndex(diagnostics);
  const order = new Map(ordered.map((item, index) => [item.id, index]));

  for (const right of ordered) {
    const conflictingItemIds = claimIndex.conflictingItemIds(right);
    if (diagnostics) diagnostics.conflictCandidates += conflictingItemIds.length;
    const reaches = (itemId: string, dependencyId: string): boolean => {
      if (diagnostics) diagnostics.reachabilityChecks += 1;
      return dependsTransitively(graph, itemId, dependencyId, () => {
        if (diagnostics) diagnostics.reachabilityNodeVisits += 1;
      });
    };
    const candidates = conflictingItemIds
      .flatMap((id) => {
        const left = graph.get(id);
        if (!left
          || !scheduledClaimsConflict(left, right)
          || reaches(right.id, left.id)) return [];
        // `ordered` is a topological order of the semantic graph, and every
        // derived edge added in this loop points from an already-visited item
        // to the current item. An earlier candidate therefore cannot depend on
        // `right`; walking its growing predecessor chain to prove that
        // impossibility made a shared-claim chain quadratic.
        return [left];
      });

    // If one candidate already reaches another candidate through a semantic
    // dependency or an earlier claim edge, the reached candidate's edge would
    // be transitively redundant. Keep only the sinks of the candidate DAG.
    // This is important for a shared fallback claim: 500 mutually conflicting
    // nodes become one deterministic chain (499 edges), not a complete DAG.
    const candidateIds = new Set(candidates.map((candidate) => candidate.id));
    const transitivelyRedundant = new Set<string>();
    if (candidates.length > 1) {
      for (const candidate of candidates) {
        markCandidateAncestors(graph, candidate.id, candidateIds, transitivelyRedundant, diagnostics);
      }
    }
    const frontier = candidates.filter((candidate) => !transitivelyRedundant.has(candidate.id));
    frontier.sort((left, right) => (order.get(left.id) ?? 0) - (order.get(right.id) ?? 0));
    for (const left of frontier) {
      graph.get(right.id)?.dependencies.push(left.id);
      edges.push({
        predecessor: left.id,
        successor: right.id,
        overlappingClaims: overlappingClaims(left.claims, right.claims),
      });
    }
    claimIndex.add(right, new Set(conflictingItemIds));
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
  const issueSlotsById = validateGraphAndIndexIssueSlots(items, serializationEdges);
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
  return {
    initialReady,
    criticalPath,
    issueSlots: {
      total: items.reduce((sum, item) => sum + issueSlotsById.get(item.id)!, 0),
      initialReady: initialReady.reduce((sum, item) => sum + issueSlotsById.get(item.id)!, 0),
    },
  };
}

export async function runSchedule(
  items: readonly ScheduledWorkItem[],
  maxParallel: number,
  worker: (item: ScheduledWorkItem, context: ScheduleWorkerContext) => Promise<ScheduleWorkerResult>,
  options: RunScheduleOptions = {},
): Promise<ScheduleResult> {
  if (!Number.isInteger(maxParallel) || maxParallel < 1) throw new Error("maxParallel must be a positive integer");
  const capacitySource = options.capacity;
  const dynamicCapacity = typeof capacitySource === "function";
  const capacityPollMs = options.capacityPollMs ?? 25;
  if (!Number.isInteger(capacityPollMs) || capacityPollMs < 1) throw new Error("capacityPollMs must be a positive integer");
  const throwIfAborted = (): void => {
    if (!options.signal?.aborted) return;
    const reason = options.signal.reason;
    throw reason instanceof Error ? reason : new Error(String(reason ?? "Orchestration scheduling was cancelled"));
  };
  const waitForCapacity = async (): Promise<void> => {
    throwIfAborted();
    const signal = options.signal;
    if (!signal) {
      await new Promise<void>((resolve) => setTimeout(resolve, capacityPollMs));
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, capacityPollMs);
      const onAbort = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        const reason = signal.reason;
        reject(reason instanceof Error ? reason : new Error(String(reason ?? "Orchestration scheduling was cancelled")));
      };
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
    });
  };
  const waitForRetry = async (delayMs: number): Promise<void> => {
    throwIfAborted();
    if (!options.signal) {
      await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        options.signal!.removeEventListener("abort", onAbort);
        resolve();
      }, delayMs);
      const onAbort = () => {
        clearTimeout(timer);
        options.signal!.removeEventListener("abort", onAbort);
        const reason = options.signal!.reason;
        reject(reason instanceof Error ? reason : new Error(String(reason ?? "Orchestration scheduling was cancelled")));
      };
      options.signal!.addEventListener("abort", onAbort, { once: true });
      if (options.signal!.aborted) onAbort();
    });
  };
  let observedCapacity = maxParallel;
  const readCapacity = async (): Promise<number> => {
    let value: number;
    try {
      value = capacitySource === undefined
        ? maxParallel
        : typeof capacitySource === "function" ? await capacitySource() : capacitySource;
      if (!Number.isSafeInteger(value) || value < 0) throw new Error("transport capacity must be a non-negative integer");
    } catch {
      // Capacity is an external admission signal. A transient probe failure
      // must stop new launches and leave queued work recoverable; it must not
      // turn into a worker failure or allow a best-effort oversubscription.
      value = 0;
    }
    observedCapacity = Math.min(maxParallel, value);
    options.onCapacityObserved?.(observedCapacity);
    return observedCapacity;
  };
  const serializationEdges = options.serializationEdges ?? [];
  const issueSlotsById = validateGraphAndIndexIssueSlots(items, serializationEdges);
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
  const retryWakeups = new Map<string, Promise<void>>();
  const targetRecoveryWakeups = new Map<string, Promise<void>>();
  const targetRecoveryWakeQueue: Array<{ itemId: string; at: number; resolve: () => void; reject: (error: unknown) => void }> = [];
  let targetRecoveryWakeTimer: ReturnType<typeof setTimeout> | undefined;
  let targetRecoveryAbortHandler: (() => void) | undefined;
  const targetRecoveryAttempts = new Map<string, number>();
  const targetRecoveryMaxAttempts = new Map<string, number>();
  let occupiedIssueSlots = 0;
  const currentClaims = new Map(items.map((item) => [item.id, [...item.claims]]));
  const queuedWaitReasonChanges = new Set<string>();
  const emit = (type: ScheduleEvent["type"], itemId?: string) => {
    queuedWaitReasonChanges.clear();
    options.onEvent?.({
      type,
      ...(itemId ? { itemId } : {}),
      status: new Map(status),
      errors: new Map(errors),
      ...(waitReasons.size ? { waitReasons: new Map(waitReasons) } : {}),
    });
  };
  const armTargetRecoveryWakeTimer = (): void => {
    if (targetRecoveryWakeTimer !== undefined) clearTimeout(targetRecoveryWakeTimer);
    const first = targetRecoveryWakeQueue[0];
    if (!first) {
      targetRecoveryWakeTimer = undefined;
      if (targetRecoveryAbortHandler && options.signal) {
        options.signal.removeEventListener("abort", targetRecoveryAbortHandler);
        targetRecoveryAbortHandler = undefined;
      }
      return;
    }
    targetRecoveryWakeTimer = setTimeout(() => {
      targetRecoveryWakeTimer = undefined;
      const now = Date.now();
      while (targetRecoveryWakeQueue.length && targetRecoveryWakeQueue[0]!.at <= now) targetRecoveryWakeQueue.shift()?.resolve();
      armTargetRecoveryWakeTimer();
    }, Math.max(0, first.at - Date.now()));
  };
  const scheduleTargetRecoveryWake = (itemId: string, at: number): Promise<void> => new Promise<void>((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(options.signal.reason ?? new Error("Orchestration scheduling was cancelled"));
      return;
    }
    targetRecoveryWakeQueue.push({ itemId, at, resolve, reject });
    if (targetRecoveryAbortHandler === undefined && options.signal) {
      targetRecoveryAbortHandler = () => {
        const reason = options.signal?.reason ?? new Error("Orchestration scheduling was cancelled");
        if (targetRecoveryWakeTimer !== undefined) clearTimeout(targetRecoveryWakeTimer);
        targetRecoveryWakeTimer = undefined;
        const pending = targetRecoveryWakeQueue.splice(0);
        const handler = targetRecoveryAbortHandler;
        targetRecoveryAbortHandler = undefined;
        if (handler) options.signal?.removeEventListener("abort", handler);
        for (const wake of pending) wake.reject(reason);
      };
      options.signal.addEventListener("abort", targetRecoveryAbortHandler, { once: true });
    }
    targetRecoveryWakeQueue.sort((left, right) => left.at - right.at);
    armTargetRecoveryWakeTimer();
  });
  const updateQueuedWaitReason = (itemId: string, next: WaitReason | undefined, announce = true): void => {
    const previous = waitReasons.get(itemId);
    if (sameWaitReason(previous, next)) return;
    if (next === undefined) waitReasons.delete(itemId);
    else waitReasons.set(itemId, next);
    if (announce) queuedWaitReasonChanges.add(itemId);
    else queuedWaitReasonChanges.delete(itemId);
  };
  const emitQueuedWaitReasonChanges = (): void => {
    const itemId = queuedWaitReasonChanges.values().next().value as string | undefined;
    if (itemId === undefined) return;
    queuedWaitReasonChanges.clear();
    emit("queued", itemId);
  };
  for (const item of items) emit("queued", item.id);
  for (const itemId of options.resumedItemIds ?? []) {
    if (!byId.has(itemId)) throw new Error(`Cannot resume unknown scheduled item ${itemId}`);
    emit("resumed", itemId);
  }

  while (running.size || queuedCount > 0 || retryWakeups.size > 0 || targetRecoveryWakeups.size > 0) {
    if (options.signal?.aborted && running.size) {
      // Cancellation stops new launches immediately, but the controller must
      // retain its execution claim until every admitted worker has settled.
      await Promise.race(running.values());
      continue;
    }
    throwIfAborted();
    let waitingForCapacity = false;
    for (const item of orderedItems) {
      if (status.get(item.id) !== "queued") continue;
      if (item.retryNextAt !== undefined && Date.parse(item.retryNextAt) > Date.now()) {
        const nextAttemptAt = item.retryNextAt;
        const attempt = item.retryAttempt ?? 1;
        const maxAttempts = item.retryMaxAttempts ?? Number.MAX_SAFE_INTEGER;
        status.set(item.id, "retry_wait");
        waitReasons.set(item.id, { kind: "retry", domain: "workflow", code: "durable-checkpoint", nextAttemptAt, attempt, maxAttempts });
        const delay = Math.max(0, Date.parse(nextAttemptAt) - Date.now());
        const wake = waitForRetry(delay).then(() => {
          retryWakeups.delete(item.id);
          if (status.get(item.id) !== "retry_wait") return;
          status.set(item.id, "queued");
          waitReasons.delete(item.id);
          emit("resumed", item.id);
        });
        retryWakeups.set(item.id, wake);
        emit("retry_wait", item.id);
        continue;
      }
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
      if (options.signal?.aborted) break;
      if (status.get(item.id) !== "queued"
        || !item.dependencies.every((id) => status.get(id) === "completed")
        || !(predecessorsBySuccessor.get(item.id) ?? []).every((id) => isTerminal(status.get(id)))) continue;
      const capacity = await readCapacity();
      if (options.signal?.aborted) break;
      const requiredIssueSlots = issueSlotsById.get(item.id)!;
      // An indivisible explicit batch larger than the configured cap runs alone
      // rather than deadlocking forever. Otherwise maxParallel is an issue-slot
      // budget, not a count of contracted scheduler nodes.
      const hasIssueSlotCapacity = occupiedIssueSlots === 0
        ? capacity > 0
        : occupiedIssueSlots + requiredIssueSlots <= capacity;
      if (!hasIssueSlotCapacity) {
        updateQueuedWaitReason(item.id, { kind: "capacity", maxParallel: capacity });
        waitingForCapacity ||= capacity === 0;
        continue;
      }
      const activeItems = [...running.keys()].map((id) => byId.get(id)).filter((value): value is ScheduledWorkItem => Boolean(value));
      const conflicting = activeItems.find((active) => scheduledClaimsConflict(
        item,
        active,
        currentClaims.get(item.id) ?? [],
        currentClaims.get(active.id) ?? [],
      ));
      if (conflicting) {
        updateQueuedWaitReason(item.id, {
          kind: "active-claim-conflict",
          node: conflicting.id,
          claims: overlappingClaims(currentClaims.get(item.id) ?? [], currentClaims.get(conflicting.id) ?? []),
        });
        continue;
      }
      updateQueuedWaitReason(item.id, undefined, false);
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
            .filter((activeId) => scheduledClaimsConflict(
              item,
              byId.get(activeId)!,
              merged,
              currentClaims.get(activeId) ?? [],
            ));
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
        promoteTargetRouteClaim: async () => {
          const route = item.targetRouteClaim
            ?? (item.repository !== undefined && item.targetBranch !== undefined
              ? normalizedDeliveryRouteClaim(item.repository, item.targetBranch)
              : undefined);
          if (!route) throw new Error(`Delivery item ${item.id} has no complete repository/target route`);
          await context.promoteClaims([route]);
        },
      };
      const promise = worker(item, context)
        .then((result) => {
          const outcome = result ?? { status: "completed" as const };
          if (outcome.status === "target_recovery") {
            const legacyAttempt = (targetRecoveryAttempts.get(item.id) ?? 0) + 1;
            const attempt = outcome.attempt ?? legacyAttempt;
            targetRecoveryAttempts.set(item.id, attempt);
            const maxAttempts = outcome.maxAttempts
              ?? targetRecoveryMaxAttempts.get(item.id)
              ?? 3;
            targetRecoveryMaxAttempts.set(item.id, maxAttempts);
            status.set(item.id, "target_recovery");
            if (outcome.error !== undefined) errors.set(item.id, asError(outcome.error));
            const nextAttemptAt = outcome.nextAttemptAt
              ?? new Date(Date.now() + (outcome.retryAfterMs ?? 0)).toISOString();
            updateQueuedWaitReason(item.id, {
              kind: "retry",
              domain: outcome.retryDomain ?? "workflow",
              code: outcome.retryCode ?? "target-advanced",
              nextAttemptAt,
              attempt,
              maxAttempts,
            }, false);
            emit("target_recovery", item.id);
            if (attempt >= maxAttempts) {
              status.set(item.id, "failed");
              emit("failed", item.id);
            } else {
              // The worker has finished and released its lease/capacity. Yield
              // through a timer before re-admitting the same node so repeated
              // target movement cannot spin a hot synchronous loop.
              queuedCount++;
              const wake = scheduleTargetRecoveryWake(item.id, Date.parse(nextAttemptAt)).then(() => {
                targetRecoveryWakeups.delete(item.id);
                if (status.get(item.id) !== "target_recovery") return;
                status.set(item.id, "queued");
                errors.delete(item.id);
                waitReasons.delete(item.id);
                emit("resumed", item.id);
              });
              targetRecoveryWakeups.set(item.id, wake);
            }
          } else if (outcome.status === "retry_wait") {
            const nextAttemptAt = outcome.nextAttemptAt
              ?? new Date(Date.now() + (outcome.retryAfterMs ?? 0)).toISOString();
            const attempt = outcome.attempt ?? 1;
            const maxAttempts = outcome.maxAttempts ?? Number.MAX_SAFE_INTEGER;
            status.set(item.id, "retry_wait");
            if (outcome.error !== undefined) errors.set(item.id, asError(outcome.error));
            waitReasons.set(item.id, {
              kind: "retry",
              domain: outcome.retryDomain ?? "workflow",
              code: outcome.retryCode ?? "retryable",
              nextAttemptAt,
              attempt,
              maxAttempts,
            });
            if (attempt >= maxAttempts) {
              status.set(item.id, "failed");
              emit("failed", item.id);
            } else {
              // Retry waits do not occupy worker capacity or a node lease. Keep
              // the DAG running and wake exactly this item when its durable
              // deadline arrives; dependents remain queued meanwhile.
              queuedCount++;
              const delay = Math.max(0, Date.parse(nextAttemptAt) - Date.now());
              const wake = new Promise<void>((resolve) => setTimeout(resolve, delay)).then(() => {
                retryWakeups.delete(item.id);
                if (status.get(item.id) !== "retry_wait") return;
                status.set(item.id, "queued");
                errors.delete(item.id);
                waitReasons.delete(item.id);
                emit("resumed", item.id);
              });
              retryWakeups.set(item.id, wake);
              emit("retry_wait", item.id);
            }
          } else if (outcome.status === "failed" && isLeaseContinuityFailure(outcome.error)) {
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
        .finally(() => {
          running.delete(item.id);
          occupiedIssueSlots -= requiredIssueSlots;
        });
      occupiedIssueSlots += requiredIssueSlots;
      running.set(item.id, promise);
    }
    emitQueuedWaitReasonChanges();

    if (running.size) {
      // A live capacity source can increase while existing work is still
      // running. Poll alongside completion so newly available slots are
      // consumed without waiting for an unrelated worker to finish. A lower
      // capacity simply prevents additional launches until active work drains.
      const capacityWait = dynamicCapacity
        ? new Promise<void>((resolve) => setTimeout(resolve, capacityPollMs))
        : undefined;
      await Promise.race([
        ...running.values(),
        ...(capacityWait ? [capacityWait] : []),
      ]);
      continue;
    }
    throwIfAborted();
    if (dynamicCapacity && waitingForCapacity && queuedCount > 0 && [...status.values()].some((value) => value === "queued")) {
      // There is ready work but no slot. Keep the queue durable and wait for a
      // fresh external capacity sample instead of failing a launch.
      await waitForCapacity();
      continue;
    }
    if (retryWakeups.size || targetRecoveryWakeups.size) {
      await Promise.race([...retryWakeups.values(), ...targetRecoveryWakeups.values()]);
      continue;
    }
    // A suspended prerequisite intentionally leaves its dependents queued so a
    // supervisor can resume the same DAG after durable child work completes.
    break;
  }
  throwIfAborted();
  return {
    status,
    errors,
    startOrder,
    ...(waitReasons.size ? { waitReasons } : {}),
    ...(decompositions.size ? { decompositions } : {}),
    observedCapacity,
  };
}

function sameWaitReason(left: WaitReason | undefined, right: WaitReason | undefined): boolean {
  if (left === right) return true;
  if (left === undefined || right === undefined || left.kind !== right.kind) return false;
  return JSON.stringify(left) === JSON.stringify(right);
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

export function scheduledWorkItemIssueSlots(item: ScheduledWorkItem): number {
  if (!item.memberIssues?.length) return 1;
  const issues = new Set<number>();
  for (const issue of item.memberIssues) {
    if (!Number.isSafeInteger(issue) || issue < 1) {
      throw new Error(`Work item ${item.id} contains an invalid member issue: ${String(issue)}`);
    }
    if (issues.has(issue)) throw new Error(`Work item ${item.id} contains duplicate member issue #${issue}`);
    issues.add(issue);
  }
  return issues.size;
}

export function claimsConflict(left: readonly string[], right: readonly string[]): boolean {
  return left.some((a) => right.some((b) => claimOverlaps(a, b)));
}

/**
 * Claim scopes are checkout-local. Complete repository and target-branch
 * evidence can prove two nodes do not share a route; a missing field on either
 * legacy node cannot prove isolation and therefore remains conservative.
 */
export function scheduledClaimsConflict(
  left: ScheduledWorkItem,
  right: ScheduledWorkItem,
  leftClaims: readonly string[] = left.claims,
  rightClaims: readonly string[] = right.claims,
): boolean {
  if (!claimRoutesMayConflict(left, right)) return false;
  return claimsConflict(leftClaims, rightClaims);
}

export function normalizedDeliveryRouteClaim(repository: string, targetBranch: string): string {
  const repo = repository.trim().toLowerCase().replaceAll("\\", "/").replace(/^https?:\/\//, "").replace(/\/+$/, "");
  const target = targetBranch.trim().replaceAll("\\", "/").replace(/^refs\/heads\//, "");
  if (!repo || !target) throw new Error("Delivery route requires repository and target branch");
  return `target-route:${repo}:${target}`;
}

function claimRouteKey(item: ScheduledWorkItem): string | undefined {
  const repository = item.repository?.trim();
  const targetBranch = item.targetBranch?.trim();
  return repository && targetBranch ? normalizedDeliveryRouteClaim(repository, targetBranch) : undefined;
}

function claimRoutesMayConflict(left: ScheduledWorkItem, right: ScheduledWorkItem): boolean {
  const leftRoute = claimRouteKey(left);
  const rightRoute = claimRouteKey(right);
  return leftRoute === undefined || rightRoute === undefined || leftRoute === rightRoute;
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

interface RoutedClaimScopeIndex {
  add(item: ScheduledWorkItem, dominatedItemIds: ReadonlySet<string>): void;
  conflictingItemIds(item: ScheduledWorkItem): string[];
}

/**
 * Preserve the sparse per-scope frontier while isolating repositories and
 * delivery targets. Unknown legacy routes use one universal frontier: every
 * known route queries it, and an unknown query inspects each known partition.
 */
function createRoutedClaimScopeIndex(diagnostics?: ClaimMaterializationDiagnostics): RoutedClaimScopeIndex {
  const byRoute = new Map<string, ClaimScopeIndex>();
  const legacy = createClaimScopeIndex(diagnostics);
  const routeIndex = (key: string): ClaimScopeIndex => {
    let index = byRoute.get(key);
    if (!index) {
      index = createClaimScopeIndex(diagnostics);
      byRoute.set(key, index);
    }
    return index;
  };

  return {
    add(item, dominatedItemIds) {
      const route = claimRouteKey(item);
      if (route === undefined) legacy.add(item, dominatedItemIds);
      else routeIndex(route).add(item, dominatedItemIds);
    },
    conflictingItemIds(item) {
      const route = claimRouteKey(item);
      const ids = new Set(legacy.conflictingItemIds(item.claims));
      if (route === undefined) {
        for (const index of byRoute.values()) {
          for (const id of index.conflictingItemIds(item.claims)) ids.add(id);
        }
      } else {
        for (const id of routeIndex(route).conflictingItemIds(item.claims)) ids.add(id);
      }
      return [...ids];
    },
  };
}

interface ClaimScopeIndex {
  add(item: ScheduledWorkItem, dominatedItemIds: ReadonlySet<string>): void;
  conflictingItemIds(claims: readonly string[]): string[];
}

interface ClaimPathTrieNode {
  holders: string[];
  children: Map<string, ClaimPathTrieNode>;
  /** Compact reachability frontier for holders strictly below this scope. */
  descendantHolders: Set<string>;
}

/**
 * Index canonical claims for materialization without constructing the dense
 * pairwise conflict graph. Component claims are exact resources. Path claims
 * are indexed in a trie so a query can inspect ancestors and descendants only
 * (the same relation used by `claimOverlaps`).
 */
function createClaimScopeIndex(diagnostics?: ClaimMaterializationDiagnostics): ClaimScopeIndex {
  const components = new Map<string, string[]>();
  const root: ClaimPathTrieNode = { holders: [], children: new Map(), descendantHolders: new Set() };

  const pathNodes = (scope: string, create: boolean): ClaimPathTrieNode[] | undefined => {
    const nodes = [root];
    if (!scope) return nodes;
    let node = root;
    for (const segment of scope.split("/")) {
      let child = node.children.get(segment);
      if (!child && create) {
        child = { holders: [], children: new Map(), descendantHolders: new Set() };
        node.children.set(segment, child);
      }
      if (!child) return undefined;
      node = child;
      nodes.push(node);
    }
    return nodes;
  };

  const pathNode = (scope: string, create: boolean): ClaimPathTrieNode | undefined =>
    pathNodes(scope, create)?.at(-1);

  const collectDescendants = (node: ClaimPathTrieNode, itemIds: Set<string>): void => {
    for (const itemId of node.descendantHolders) itemIds.add(itemId);
  };

  const collectPathConflicts = (scope: string, itemIds: Set<string>): void => {
    // Every ancestor scope conflicts with this scope. The root node represents
    // a repository-wide claim (for example `*.ts` after conservative scope
    // reduction), and is therefore always included.
    let node: ClaimPathTrieNode | undefined = root;
    for (const itemId of node.holders) itemIds.add(itemId);
    if (scope) {
      for (const segment of scope.split("/")) {
        node = node.children.get(segment);
        if (!node) break;
        for (const itemId of node.holders) itemIds.add(itemId);
      }
    }

    // Every descendant scope conflicts with this scope. Sibling subtrees are
    // never visited, preserving the existing boundary behavior (`src/a` does
    // not conflict with `src/b`).
    const exact = pathNode(scope, false);
    if (exact) collectDescendants(exact, itemIds);
  };

  return {
    add(item, dominatedItemIds) {
      const seen = new Set<string>();
      for (const claim of item.claims) {
        const scope = canonicalClaimScope(claim);
        const key = `${scope.kind}:${scope.value}`;
        if (seen.has(key)) continue;
        seen.add(key);
        if (scope.kind === "component") {
          // Every prior holder of this exact resource was returned as a
          // conflict. Once the derived frontier edges have been inserted, the
          // current item reaches all of them and is the sole useful frontier.
          components.set(scope.value, [item.id]);
          if (diagnostics) diagnostics.frontierUpdates += 1;
        } else {
          const nodes = pathNodes(scope.value, true)!;
          const node = nodes.at(-1)!;
          // An exact/broad holder reaches every conflicting holder at this
          // scope and below after materialization, so it replaces both exact
          // and descendant frontiers without walking the subtree.
          node.holders = [item.id];
          node.descendantHolders.clear();
          if (diagnostics) diagnostics.frontierUpdates += 2;
          for (const ancestor of nodes.slice(0, -1)) {
            // At a strict ancestor, keep unrelated sibling holders and remove
            // only conflicts the current item is now known to reach. This set
            // came from the index query that immediately preceded insertion,
            // avoiding both recursive trie scans and transitive DAG walks.
            for (const holder of dominatedItemIds) {
              ancestor.descendantHolders.delete(holder);
              if (diagnostics) diagnostics.frontierUpdates += 1;
            }
            ancestor.descendantHolders.add(item.id);
            if (diagnostics) diagnostics.frontierUpdates += 1;
          }
        }
      }
    },
    conflictingItemIds(claims) {
      const itemIds = new Set<string>();
      const seen = new Set<string>();
      for (const claim of claims) {
        const scope = canonicalClaimScope(claim);
        const key = `${scope.kind}:${scope.value}`;
        if (seen.has(key)) continue;
        seen.add(key);
        if (scope.kind === "component") {
          for (const itemId of components.get(scope.value) ?? []) itemIds.add(itemId);
        } else {
          collectPathConflicts(scope.value, itemIds);
        }
      }
      return [...itemIds];
    },
  };
}

function topologicallyOrderItems(
  items: ReadonlyMap<string, ScheduledWorkItem>,
): ScheduledWorkItem[] {
  const compare = (left: ScheduledWorkItem, right: ScheduledWorkItem): number =>
    left.issue - right.issue || left.id.localeCompare(right.id);
  const remainingDependencies = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const item of items.values()) {
    remainingDependencies.set(item.id, item.dependencies.length);
    for (const dependency of item.dependencies) {
      const values = dependents.get(dependency) ?? [];
      values.push(item.id);
      dependents.set(dependency, values);
    }
  }

  const ready: ScheduledWorkItem[] = [];
  const pushReady = (item: ScheduledWorkItem): void => {
    ready.push(item);
    let index = ready.length - 1;
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (compare(ready[parent]!, ready[index]!) <= 0) break;
      [ready[parent], ready[index]] = [ready[index]!, ready[parent]!];
      index = parent;
    }
  };
  const popReady = (): ScheduledWorkItem => {
    const first = ready[0]!;
    const last = ready.pop()!;
    if (ready.length) {
      ready[0] = last;
      let index = 0;
      while (true) {
        const left = index * 2 + 1;
        const right = left + 1;
        let smallest = index;
        if (left < ready.length && compare(ready[left]!, ready[smallest]!) < 0) smallest = left;
        if (right < ready.length && compare(ready[right]!, ready[smallest]!) < 0) smallest = right;
        if (smallest === index) break;
        [ready[index], ready[smallest]] = [ready[smallest]!, ready[index]!];
        index = smallest;
      }
    }
    return first;
  };
  for (const item of items.values()) if (item.dependencies.length === 0) pushReady(item);
  const ordered: ScheduledWorkItem[] = [];
  while (ready.length) {
    const item = popReady();
    ordered.push(item);
    for (const dependentId of dependents.get(item.id) ?? []) {
      const remaining = (remainingDependencies.get(dependentId) ?? 0) - 1;
      remainingDependencies.set(dependentId, remaining);
      if (remaining !== 0) continue;
      pushReady(items.get(dependentId)!);
    }
  }
  if (ordered.length !== items.size) throw new Error("Dependency cycle detected while ordering claim materialization");
  return ordered;
}

function markCandidateAncestors(
  items: ReadonlyMap<string, ScheduledWorkItem>,
  itemId: string,
  candidateIds: ReadonlySet<string>,
  redundant: Set<string>,
  diagnostics?: ClaimMaterializationDiagnostics,
): void {
  const pending = [...(items.get(itemId)?.dependencies ?? [])];
  const visited = new Set<string>();
  while (pending.length) {
    const current = pending.pop()!;
    if (visited.has(current)) continue;
    visited.add(current);
    if (diagnostics) diagnostics.reachabilityNodeVisits += 1;
    if (candidateIds.has(current)) redundant.add(current);
    pending.push(...(items.get(current)?.dependencies ?? []));
  }
}

function dependsTransitively(
  items: ReadonlyMap<string, ScheduledWorkItem>,
  itemId: string,
  dependencyId: string,
  onVisit?: () => void,
): boolean {
  const pending = [...(items.get(itemId)?.dependencies ?? [])];
  const visited = new Set<string>();
  while (pending.length) {
    onVisit?.();
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
  validateGraphAndIndexIssueSlots(items, serializationEdges);
}

function validateGraphAndIndexIssueSlots(
  items: readonly ScheduledWorkItem[],
  serializationEdges: readonly ClaimSerializationEdge[] = [],
): Map<string, number> {
  const ids = new Set<string>();
  const issueSlotsById = new Map<string, number>();
  for (const item of items) {
    if (ids.has(item.id)) throw new Error(`Duplicate work item id: ${item.id}`);
    if (item.targetRouteClaim !== undefined) {
      if (item.repository === undefined || item.targetBranch === undefined) {
        throw new Error(`Work item ${item.id} has a target route claim without repository and target branch identity`);
      }
      const expectedRoute = normalizedDeliveryRouteClaim(item.repository, item.targetBranch);
      if (item.targetRouteClaim !== expectedRoute) {
        throw new Error(`Work item ${item.id} target route claim is inconsistent with its repository/target branch`);
      }
    }
    issueSlotsById.set(item.id, scheduledWorkItemIssueSlots(item));
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
  return issueSlotsById;
}
