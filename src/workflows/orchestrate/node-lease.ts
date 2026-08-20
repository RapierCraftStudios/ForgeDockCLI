// SPDX-License-Identifier: AGPL-3.0-or-later

import type {
  Lease,
  LeaseAcquisitionOptions,
  LeaseInspection,
  LeaseRepository,
} from "../../core/ports/lease.js";

export type NodeLeaseObservation =
  | { state: "absent" }
  | { state: "active"; lease: LeaseInspection }
  | { state: "expired"; lease: LeaseInspection };

export interface NodeLeaseWaitOptions {
  now?: () => number;
  pollMs?: number;
  signal?: AbortSignal;
}

export interface NodeLeaseAcquireOptions extends NodeLeaseWaitOptions, LeaseAcquisitionOptions {
  /** Wait for a live predecessor instead of converting it into a launch failure. */
  waitForLive?: boolean;
}

export function orchestrationNodeLeaseBinding(
  orchestrationId: string,
  executionAttempt: number,
  nodeId: string,
  workerAttemptId: string,
): string {
  return `orchestration:${orchestrationId}:execution:${executionAttempt}:node:${nodeId}:attempt:${workerAttemptId}`;
}

/** Read one node lease without exposing its holder token to diagnostics. */
export function inspectNodeLease(
  repository: LeaseRepository,
  itemId: string,
  now = Date.now(),
): NodeLeaseObservation | undefined {
  const lease = repository.inspect?.(itemId, now);
  if (!lease) return repository.inspect ? { state: "absent" } : undefined;
  return lease.expiresAt > now ? { state: "active", lease } : { state: "expired", lease };
}

/**
 * Wait until a predecessor has released or its host-observed lease has
 * expired. A live heartbeat extends the wait; it is never stolen by recovery.
 */
export async function waitForNodeLease(
  repository: LeaseRepository,
  itemId: string,
  options: NodeLeaseWaitOptions = {},
): Promise<NodeLeaseObservation | undefined> {
  const now = options.now ?? (() => Date.now());
  const pollMs = options.pollMs ?? 50;
  if (!Number.isInteger(pollMs) || pollMs < 1) throw new Error("Node lease poll interval must be a positive integer");
  while (true) {
    throwIfAborted(options.signal);
    const observation = inspectNodeLease(repository, itemId, now());
    if (!observation || observation.state !== "active") return observation;
    await waitForPoll(pollMs, options.signal);
  }
}

/**
 * Acquire the canonical issue/node key. Recovery callers may wait for a live
 * predecessor, but takeover remains the repository's normal expired-row CAS;
 * this helper never deletes or force-releases a live lease.
 */
export async function acquireNodeLease(
  repository: LeaseRepository,
  itemId: string,
  owner: string,
  ttlMs: number,
  options: NodeLeaseAcquireOptions = {},
): Promise<Lease | undefined> {
  const now = options.now ?? (() => Date.now());
  const acquisition: LeaseAcquisitionOptions = {
    ...(options.binding !== undefined ? { binding: options.binding } : {}),
    ...(options.recovery !== undefined ? { recovery: options.recovery } : {}),
  };
  while (true) {
    throwIfAborted(options.signal);
    const lease = repository.acquire(itemId, owner, ttlMs, now(), acquisition);
    if (lease) return lease;
    if (!options.waitForLive) return undefined;
    const observation = inspectNodeLease(repository, itemId, now());
    if (!observation || observation.state !== "active") continue;
    await waitForPoll(options.pollMs ?? 50, options.signal);
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  const reason = signal.reason;
  throw reason instanceof Error ? reason : new Error(String(reason ?? "Node lease recovery was cancelled"));
}

async function waitForPoll(pollMs: number, signal: AbortSignal | undefined): Promise<void> {
  if (!Number.isInteger(pollMs) || pollMs < 1) throw new Error("Node lease poll interval must be a positive integer");
  if (!signal) {
    await new Promise<void>((resolve) => setTimeout(resolve, pollMs));
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, pollMs);
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      const reason = signal.reason;
      reject(reason instanceof Error ? reason : new Error(String(reason ?? "Node lease recovery was cancelled")));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}
