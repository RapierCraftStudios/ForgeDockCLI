// SPDX-License-Identifier: AGPL-3.0-or-later

export interface LeaseFence {
  itemId: string;
  token: string;
  epoch: number;
}

export interface Lease extends LeaseFence {
  owner: string;
  acquiredAt: number;
  heartbeatAt: number;
  expiresAt: number;
}

export interface LeaseRepository {
  acquire(itemId: string, owner: string, ttlMs: number, now?: number): Lease | undefined;
  heartbeat(itemId: string, token: string, ttlMs: number, now?: number): Lease;
  release(itemId: string, token: string): boolean;
  /** The durable authorization boundary used immediately before/after side effects. */
  assertOwnership(fence: LeaseFence, now?: number): Lease;
}

export class InMemoryLeaseRepository implements LeaseRepository {
  readonly #leases = new Map<string, Lease>();
  readonly #epochs = new Map<string, number>();

  acquire(itemId: string, owner: string, ttlMs: number, now = Date.now()): Lease | undefined {
    const current = this.#leases.get(itemId);
    if (current && current.expiresAt > now) return undefined;
    const epoch = (this.#epochs.get(itemId) ?? 0) + 1;
    this.#epochs.set(itemId, epoch);
    const lease = { itemId, owner, token: crypto.randomUUID(), epoch, acquiredAt: now, heartbeatAt: now, expiresAt: now + ttlMs };
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

  assertOwnership(fence: LeaseFence, now = Date.now()): Lease {
    const current = this.#leases.get(fence.itemId);
    if (!current || current.token !== fence.token || current.epoch !== fence.epoch || current.expiresAt <= now) {
      throw new Error(`Lease fence is absent, stale, or owned by another worker: ${fence.itemId}`);
    }
    return { ...current };
  }

  release(itemId: string, token: string): boolean {
    const current = this.#leases.get(itemId);
    if (!current || current.token !== token) return false;
    return this.#leases.delete(itemId);
  }
}
