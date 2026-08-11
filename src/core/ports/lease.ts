// SPDX-License-Identifier: AGPL-3.0-or-later

export interface Lease {
  itemId: string;
  owner: string;
  token: string;
  acquiredAt: number;
  heartbeatAt: number;
  expiresAt: number;
}

/** Durable ownership for an operation which may have caused an irreversible side effect. */
export interface LeaseSideEffectFence {
  itemId: string;
  operationKey: string;
  token: string;
  epoch: number;
  status: "active" | "unknown" | "completed";
  startedAt: number;
  updatedAt: number;
}

export interface LeaseRepository {
  acquire(itemId: string, owner: string, ttlMs: number, now?: number): Lease | undefined;
  heartbeat(itemId: string, token: string, ttlMs: number, now?: number): Lease;
  release(itemId: string, token: string): boolean;

  /** Claim an operation only while the lease token is the current durable owner. */
  beginFence(itemId: string, operationKey: string, token: string, now?: number): LeaseSideEffectFence;
  /** Assert the token/epoch ownership boundary immediately before or after a side effect. */
  assertFence(itemId: string, operationKey: string, token: string, epoch: number, now?: number): LeaseSideEffectFence;
  /** Renew an in-flight fence without changing its epoch. */
  renewFence(itemId: string, operationKey: string, token: string, epoch: number, now?: number): LeaseSideEffectFence;
  /** Commit the operation's durable handoff, rejecting stale owners. */
  completeFence(itemId: string, operationKey: string, token: string, epoch: number, now?: number): LeaseSideEffectFence;
  /** Record that a request may have been accepted remotely. This is allowed after lease loss. */
  unknownFence(itemId: string, operationKey: string, token: string, epoch: number, now?: number): LeaseSideEffectFence;
  /** Transfer an unknown operation to the current owner for marker reconciliation. */
  recoverFence(itemId: string, operationKey: string, token: string, now?: number): LeaseSideEffectFence;
}

export class InMemoryLeaseRepository implements LeaseRepository {
  readonly #leases = new Map<string, Lease>();
  readonly #fences = new Map<string, LeaseSideEffectFence>();

  acquire(itemId: string, owner: string, ttlMs: number, now = Date.now()): Lease | undefined {
    const current = this.#leases.get(itemId);
    if (current && current.expiresAt > now) return undefined;
    const lease = { itemId, owner, token: crypto.randomUUID(), acquiredAt: now, heartbeatAt: now, expiresAt: now + ttlMs };
    this.#leases.set(itemId, lease);
    return { ...lease };
  }

  heartbeat(itemId: string, token: string, ttlMs: number, now = Date.now()): Lease {
    const current = this.#leases.get(itemId);
    if (!current || current.token !== token || current.expiresAt <= now) throw new Error(`Lease is absent, stale, or owned by another worker: ${itemId}`);
    const renewed = { ...current, heartbeatAt: now, expiresAt: now + ttlMs };
    this.#leases.set(itemId, renewed);
    return { ...renewed };
  }

  release(itemId: string, token: string): boolean {
    const current = this.#leases.get(itemId);
    if (!current || current.token !== token) return false;
    return this.#leases.delete(itemId);
  }

  beginFence(itemId: string, operationKey: string, token: string, now = Date.now()): LeaseSideEffectFence {
    this.assertLease(itemId, token, now);
    const key = fenceKey(itemId, operationKey);
    const current = this.#fences.get(key);
    if (current && current.token === token) return { ...current };
    const fence: LeaseSideEffectFence = {
      itemId, operationKey, token, epoch: (current?.epoch ?? 0) + 1,
      status: current && current.token !== token ? "unknown" : "active", startedAt: current?.startedAt ?? now, updatedAt: now,
    };
    this.#fences.set(key, fence);
    return { ...fence };
  }

  assertFence(itemId: string, operationKey: string, token: string, epoch: number, now = Date.now()): LeaseSideEffectFence {
    this.assertLease(itemId, token, now);
    const fence = this.#fences.get(fenceKey(itemId, operationKey));
    if (!fence || fence.token !== token || fence.epoch !== epoch) throw new Error(`Lease fence is stale or owned by another worker: ${operationKey}`);
    return { ...fence };
  }

  renewFence(itemId: string, operationKey: string, token: string, epoch: number, now = Date.now()): LeaseSideEffectFence {
    const fence = this.assertFence(itemId, operationKey, token, epoch, now);
    const renewed = { ...fence, updatedAt: now };
    this.#fences.set(fenceKey(itemId, operationKey), renewed);
    return { ...renewed };
  }

  completeFence(itemId: string, operationKey: string, token: string, epoch: number, now = Date.now()): LeaseSideEffectFence {
    const fence = this.assertFence(itemId, operationKey, token, epoch, now);
    const completed = { ...fence, status: "completed" as const, updatedAt: now };
    this.#fences.set(fenceKey(itemId, operationKey), completed);
    return { ...completed };
  }

  unknownFence(itemId: string, operationKey: string, token: string, epoch: number, now = Date.now()): LeaseSideEffectFence {
    const fence = this.#fences.get(fenceKey(itemId, operationKey));
    if (!fence || fence.token !== token || fence.epoch !== epoch) throw new Error(`Lease fence is stale or already recovered: ${operationKey}`);
    const unknown = { ...fence, status: "unknown" as const, updatedAt: now };
    this.#fences.set(fenceKey(itemId, operationKey), unknown);
    return { ...unknown };
  }

  recoverFence(itemId: string, operationKey: string, token: string, now = Date.now()): LeaseSideEffectFence {
    this.assertLease(itemId, token, now);
    const key = fenceKey(itemId, operationKey);
    const current = this.#fences.get(key);
    if (!current) return this.beginFence(itemId, operationKey, token, now);
    const recovered = { ...current, token, epoch: current.epoch + 1, status: "active" as const, updatedAt: now };
    this.#fences.set(key, recovered);
    return { ...recovered };
  }

  private assertLease(itemId: string, token: string, now: number): Lease {
    const lease = this.#leases.get(itemId);
    if (!lease || lease.token !== token || lease.expiresAt <= now) throw new Error(`Lease is absent, stale, or owned by another worker: ${itemId}`);
    return lease;
  }
}

function fenceKey(itemId: string, operationKey: string): string {
  return `${itemId}\u0000${operationKey}`;
}
