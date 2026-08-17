// SPDX-License-Identifier: AGPL-3.0-or-later

import { createHash, randomUUID } from "node:crypto";
import type { LeaseRepository } from "../../core/ports/lease.js";
import { LeaseContinuityError } from "../../core/ports/lease.js";
import type {
  OrchestrationExecutionAdmission,
  OrchestrationExecutionClaim,
} from "../../core/ports/orchestration.js";

const DEFAULT_TTL_MS = 60_000;
const DEFAULT_HEARTBEAT_MS = 20_000;

/**
 * Process adapter for the controller's exclusive-execution port. The backing
 * repository must itself be configured with a retained witness; an
 * unwitnessed SqliteRepositories instance fails closed during acquire.
 */
export class LeaseBackedOrchestrationExecutionAdmission implements OrchestrationExecutionAdmission {
  readonly #owner: string;
  readonly #ttlMs: number;
  readonly #heartbeatMs: number;
  readonly #now: () => number;

  constructor(
    private readonly leases: LeaseRepository,
    options: {
      owner?: string;
      ttlMs?: number;
      heartbeatMs?: number;
      now?: () => number;
    } = {},
  ) {
    this.#owner = options.owner ?? `orchestration-controller:${process.pid}:${randomUUID()}`;
    this.#ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.#heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
    this.#now = options.now ?? Date.now;
    if (!Number.isFinite(this.#ttlMs) || this.#ttlMs <= 0) throw new Error("Orchestration admission TTL must be positive");
    if (!Number.isFinite(this.#heartbeatMs) || this.#heartbeatMs <= 0 || this.#heartbeatMs >= this.#ttlMs) {
      throw new Error("Orchestration admission heartbeat must be positive and shorter than its TTL");
    }
  }

  async acquire(orchestrationId: string): Promise<OrchestrationExecutionClaim | undefined> {
    const normalizedId = orchestrationId.trim();
    if (!normalizedId) throw new Error("Orchestration admission requires an orchestration ID");
    const itemId = `orchestration-execution:${normalizedId}`;
    const lease = this.leases.acquire(itemId, this.#owner, this.#ttlMs, this.#now());
    if (!lease) return undefined;
    const guard = this.leases.guard(itemId, lease.token);
    let expiresAt = lease.expiresAt;
    let failure: unknown;
    let released = false;
    const heartbeat = setInterval(() => {
      if (released || failure !== undefined) return;
      try {
        expiresAt = this.leases.heartbeat(itemId, lease.token, this.#ttlMs, this.#now()).expiresAt;
      } catch (error) {
        failure = error;
      }
    }, this.#heartbeatMs);
    heartbeat.unref?.();

    const assertValid = (): void => {
      if (released) throw new LeaseContinuityError(`orchestration execution claim ${lease.token} was released`);
      if (failure !== undefined) {
        throw failure instanceof Error
          ? failure
          : new LeaseContinuityError(`orchestration execution heartbeat failed: ${String(failure)}`);
      }
      if (this.#now() >= expiresAt) throw new LeaseContinuityError(`orchestration execution claim ${lease.token} expired`);
      guard.assertValid();
    };

    return {
      // The raw holder token is secret fencing authority and must never enter
      // the durable orchestration record. Retain only a one-way audit handle.
      claimId: `${lease.epoch}:${createHash("sha256").update(lease.token).digest("hex").slice(0, 16)}`,
      assertValid,
      release: () => {
        if (released) return;
        released = true;
        clearInterval(heartbeat);
        this.leases.release(itemId, lease.token);
      },
    };
  }
}
