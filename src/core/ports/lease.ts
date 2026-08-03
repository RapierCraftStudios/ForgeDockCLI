// SPDX-License-Identifier: AGPL-3.0-or-later

export interface Lease {
  itemId: string;
  owner: string;
  token: string;
  acquiredAt: number;
  heartbeatAt: number;
  expiresAt: number;
}

export interface LeaseRepository {
  acquire(itemId: string, owner: string, ttlMs: number, now?: number): Lease | undefined;
  heartbeat(itemId: string, token: string, ttlMs: number, now?: number): Lease;
  release(itemId: string, token: string): boolean;
}

export class InMemoryLeaseRepository implements LeaseRepository {
  readonly #leases = new Map<string, Lease>();

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
}
