// SPDX-License-Identifier: AGPL-3.0-or-later

/** A lease holder token is ownership evidence; the epoch is the fencing authority. */
export interface Lease {
  itemId: string;
  owner: string;
  token: string;
  /** Non-secret logical owner binding used to reconcile stale workers. */
  binding?: string;
  epoch: number;
  acquiredAt: number;
  heartbeatAt: number;
  expiresAt: number;
  continuity: "verified";
}

/**
 * Optional logical binding carried by a lease row. It is deliberately
 * separate from the secret holder token: recovery can identify which
 * orchestration/node attempt owns a live row without gaining authority to
 * heartbeat, release, or fence it.
 */
export interface LeaseAcquisitionOptions {
  binding?: string;
  recovery?: "initial" | "resume" | "relaunch" | "reattach";
}

export interface AuthenticatedLeaseCheckpoint {
  epoch: number;
  signature: string;
  keyId?: string;
}

export interface LeaseWitnessSnapshot {
  state: "verified" | "unverifiable";
  epoch: number;
  checkpoint?: AuthenticatedLeaseCheckpoint;
  reason?: string;
}

/**
 * The witness is deliberately synchronous: lease operations are synchronous
 * controller gates. Implementations must retain their checkpoint outside the
 * rollbackable operational repository.
 */
export interface LeaseWitness {
  verify(): LeaseWitnessSnapshot;
  compareAndAdvance(observedEpoch: number): LeaseWitnessSnapshot;
  reEnroll(checkpoint: AuthenticatedLeaseCheckpoint): LeaseWitnessSnapshot;
}

export class LeaseContinuityError extends Error {
  readonly code = "LEASE_CONTINUITY_UNVERIFIABLE" as const;
  constructor(readonly reason: string) {
    super(`Lease continuity is unverifiable; operation denied: ${reason}`);
    this.name = "LeaseContinuityError";
  }
}

export interface LeaseGuard {
  /** Throws LeaseContinuityError when the retained witness is no longer valid. */
  assertValid(): void;
  check(): void;
}

export interface LeaseRepository {
  acquire(itemId: string, owner: string, ttlMs: number, now?: number, options?: LeaseAcquisitionOptions): Lease | undefined;
  /** Read-only lease evidence for diagnostics and stale-controller reconciliation. */
  inspect?(itemId: string, now?: number): Lease | undefined;
  heartbeat(itemId: string, token: string, ttlMs: number, now?: number): Lease;
  release(itemId: string, token: string): boolean;
  guard(itemId: string, token: string, now?: () => number): LeaseGuard;
  reEnroll(checkpoint: AuthenticatedLeaseCheckpoint): void;
  continuity(): LeaseWitnessSnapshot;
}

/** Deterministic authenticated witness used by unit tests and embedded callers. */
export class InMemoryLeaseWitness implements LeaseWitness {
  #epoch = 0;
  #invalidReason: string | undefined;
  readonly #secret: string;
  constructor(secret = "forgedock-test-retained-key") { this.#secret = secret; }

  verify(): LeaseWitnessSnapshot {
    if (this.#invalidReason) return { state: "unverifiable", epoch: this.#epoch, reason: this.#invalidReason };
    return { state: "verified", epoch: this.#epoch, checkpoint: this.checkpoint() };
  }
  compareAndAdvance(observedEpoch: number): LeaseWitnessSnapshot {
    this.#requireUsable();
    this.#epoch = Math.max(this.#epoch, observedEpoch) + 1;
    return this.verify();
  }
  reEnroll(checkpoint: AuthenticatedLeaseCheckpoint): LeaseWitnessSnapshot {
    // Re-enrollment is the explicit recovery path, so it must remain possible
    // after the witness has reported an invalid or unavailable checkpoint.
    if (!verifyTestCheckpoint(checkpoint, this.#secret)) throw new LeaseContinuityError("checkpoint signature is invalid");
    if (!Number.isSafeInteger(checkpoint.epoch) || checkpoint.epoch <= this.#epoch) {
      throw new LeaseContinuityError("re-enrollment checkpoint is not higher than the retained epoch");
    }
    this.#epoch = checkpoint.epoch;
    this.#invalidReason = undefined;
    return this.verify();
  }
  checkpoint(): AuthenticatedLeaseCheckpoint {
    return { epoch: this.#epoch, signature: signTestCheckpoint(this.#epoch, this.#secret) };
  }
  /** Fault-injection helpers intentionally make continuity failure explicit. */
  invalidate(reason = "witness checkpoint is unavailable"): void { this.#invalidReason = reason; }
  restore(): void { this.#invalidReason = undefined; }
  rollback(epoch: number): void { this.#epoch = epoch; }

  #requireUsable(): void {
    if (this.#invalidReason) throw new LeaseContinuityError(this.#invalidReason);
  }
}

function signTestCheckpoint(epoch: number, secret: string): string {
  // The in-memory fixture is authenticated (and deterministic), while the
  // retained filesystem adapter uses Ed25519 below the SQLite boundary.
  return Buffer.from(`${epoch}:${secret}`, "utf8").toString("base64url");
}
function verifyTestCheckpoint(checkpoint: AuthenticatedLeaseCheckpoint, secret: string): boolean {
  return checkpoint.signature === signTestCheckpoint(checkpoint.epoch, secret);
}

function normalizedBinding(binding: string | undefined): string | undefined {
  if (binding === undefined) return undefined;
  const value = binding.trim();
  if (!value) throw new Error("Lease binding must not be empty");
  if (value.length > 512) throw new Error("Lease binding is too long");
  return value;
}

export class InMemoryLeaseRepository implements LeaseRepository {
  readonly #leases = new Map<string, Lease>();
  readonly #witness: LeaseWitness;
  #localMaximum = 0;
  #recoveryEpoch: number | undefined;
  #unverifiableReason: string | undefined;

  constructor(witness: LeaseWitness = new InMemoryLeaseWitness()) { this.#witness = witness; }

  acquire(itemId: string, owner: string, ttlMs: number, now = Date.now(), options?: LeaseAcquisitionOptions): Lease | undefined {
    this.#assertContinuity();
    const current = this.#leases.get(itemId);
    const recoveredRow = current && this.#recoveryEpoch !== undefined && current.epoch < this.#recoveryEpoch;
    if (current && current.expiresAt > now && !recoveredRow) return undefined;
    const advanced = this.#witness.compareAndAdvance(this.#localMaximum);
    this.#acceptWitness(advanced);
    const binding = normalizedBinding(options?.binding);
    const lease: Lease = { itemId, owner, token: crypto.randomUUID(), ...(binding !== undefined ? { binding } : {}), epoch: advanced.epoch, acquiredAt: now, heartbeatAt: now, expiresAt: now + ttlMs, continuity: "verified" };
    this.#leases.set(itemId, lease);
    this.#recoveryEpoch = undefined;
    return { ...lease };
  }

  inspect(itemId: string): Lease | undefined {
    this.#assertContinuity();
    const lease = this.#leases.get(itemId);
    return lease ? { ...lease } : undefined;
  }

  heartbeat(itemId: string, token: string, ttlMs: number, now = Date.now()): Lease {
    this.#assertContinuity();
    const current = this.#leases.get(itemId);
    if (current && this.#recoveryEpoch !== undefined && current.epoch < this.#recoveryEpoch) {
      throw new LeaseContinuityError(`lease epoch is stale after re-enrollment for ${itemId}`);
    }
    if (!current || current.token !== token || current.expiresAt <= now) throw new Error(`Lease is absent, stale, or owned by another worker: ${itemId}`);
    const renewed = { ...current, heartbeatAt: now, expiresAt: now + ttlMs };
    this.#leases.set(itemId, renewed);
    return { ...renewed };
  }

  release(itemId: string, token: string): boolean {
    this.#assertContinuity();
    const current = this.#leases.get(itemId);
    if (current && this.#recoveryEpoch !== undefined && current.epoch < this.#recoveryEpoch) {
      throw new LeaseContinuityError(`lease epoch is stale after re-enrollment for ${itemId}`);
    }
    if (!current || current.token !== token) return false;
    return this.#leases.delete(itemId);
  }

  guard(itemId: string, token: string, now: () => number = Date.now): LeaseGuard {
    const assertValid = (): void => {
      this.#assertContinuity();
      const lease = this.#leases.get(itemId);
      if (lease && this.#recoveryEpoch !== undefined && lease.epoch < this.#recoveryEpoch) {
        throw new LeaseContinuityError(`lease epoch is stale after re-enrollment for ${itemId}`);
      }
      if (!lease || lease.token !== token) throw new LeaseContinuityError(`holder token is no longer current for ${itemId}`);
      if (lease.expiresAt <= now()) throw new LeaseContinuityError(`holder lease has expired for ${itemId}`);
    };
    return { assertValid, check: assertValid };
  }

  continuity(): LeaseWitnessSnapshot {
    if (this.#unverifiableReason) return { state: "unverifiable", epoch: this.#localMaximum, reason: this.#unverifiableReason };
    const snapshot = this.#witness.verify();
    if (snapshot.state !== "verified" || snapshot.epoch !== this.#localMaximum) {
      return { ...snapshot, state: "unverifiable", reason: snapshot.reason ?? "local maximum diverges from the retained witness" };
    }
    return snapshot;
  }

  reEnroll(checkpoint: AuthenticatedLeaseCheckpoint): void {
    if (!Number.isSafeInteger(checkpoint.epoch) || checkpoint.epoch <= this.#localMaximum) {
      throw new LeaseContinuityError("re-enrollment checkpoint is not higher than the local maximum");
    }
    try {
      const snapshot = this.#witness.reEnroll(checkpoint);
      this.#acceptWitness(snapshot);
      this.#recoveryEpoch = snapshot.epoch;
      this.#unverifiableReason = undefined;
    } catch (error) {
      this.#unverifiableReason = error instanceof Error ? error.message : String(error);
      throw error;
    }
  }

  #assertContinuity(): void {
    if (this.#unverifiableReason) throw new LeaseContinuityError(this.#unverifiableReason);
    try {
      const snapshot = this.#witness.verify();
      if (snapshot.state !== "verified" || snapshot.epoch !== this.#localMaximum) {
        throw new LeaseContinuityError(snapshot.reason ?? "local maximum diverges from the retained witness");
      }
      this.#acceptWitness(snapshot);
    } catch (error) {
      this.#unverifiableReason = error instanceof Error ? error.message : String(error);
      throw new LeaseContinuityError(this.#unverifiableReason);
    }
  }
  #acceptWitness(snapshot: LeaseWitnessSnapshot): void {
    if (snapshot.state !== "verified" || !Number.isSafeInteger(snapshot.epoch) || snapshot.epoch < 0 || snapshot.epoch < this.#localMaximum) {
      this.#unverifiableReason = snapshot.reason ?? "witness epoch rolled back or failed verification";
      throw new LeaseContinuityError(this.#unverifiableReason);
    }
    this.#localMaximum = Math.max(this.#localMaximum, snapshot.epoch);
  }
}
