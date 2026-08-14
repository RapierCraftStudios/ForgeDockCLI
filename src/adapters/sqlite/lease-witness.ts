// SPDX-License-Identifier: AGPL-3.0-or-later

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createPublicKey, sign, verify, type KeyLike } from "node:crypto";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";
import type { AuthenticatedLeaseCheckpoint, LeaseWitness, LeaseWitnessSnapshot } from "../../core/ports/lease.js";
import { LeaseContinuityError } from "../../core/ports/lease.js";

/**
 * Retained checkpoint adapter. The checkpoint file and verification key are
 * intentionally supplied independently of the SQLite operational-store path.
 * A malformed, missing, or rolled-back checkpoint is never treated as epoch 0.
 */
export class RetainedCheckpointWitness implements LeaseWitness {
  readonly #path: string;
  readonly #publicKey: KeyLike;
  readonly #privateKey: KeyLike | undefined;
  readonly #keyId: string;
  #observedEpoch = 0;
  #unverifiableReason: string | undefined;

  constructor(options: { path: string; publicKey: KeyLike; privateKey?: KeyLike; keyId?: string }) {
    this.#path = options.path;
    this.#publicKey = options.publicKey;
    this.#privateKey = options.privateKey;
    this.#keyId = options.keyId ?? "forgedock-lease";
  }

  verify(): LeaseWitnessSnapshot {
    if (this.#unverifiableReason) return { state: "unverifiable", epoch: this.#observedEpoch, reason: this.#unverifiableReason };
    try {
      const checkpoint = readCheckpoint(this.#path);
      if (checkpoint.keyId !== this.#keyId || !verifyCheckpoint(checkpoint, this.#publicKey, this.#keyId)) {
        throw new LeaseContinuityError("checkpoint signature or key identity is invalid");
      }
      if (checkpoint.epoch < this.#observedEpoch) throw new LeaseContinuityError("retained checkpoint moved backwards");
      this.#observedEpoch = checkpoint.epoch;
      return { state: "verified", epoch: checkpoint.epoch, checkpoint };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      // A first-start missing checkpoint is retryable after an explicit
      // operator seed/re-enrollment. Once an epoch has been observed, any
      // verification failure is latched until higher authenticated recovery.
      if (this.#observedEpoch > 0) this.#unverifiableReason = reason;
      return { state: "unverifiable", epoch: this.#observedEpoch, reason };
    }
  }

  compareAndAdvance(observedEpoch: number): LeaseWitnessSnapshot {
    const current = this.verify();
    if (current.state !== "verified") throw new LeaseContinuityError(current.reason ?? "checkpoint cannot be verified");
    if (!this.#privateKey) throw new LeaseContinuityError("witness private key is unavailable for compare-and-advance");
    const epoch = Math.max(observedEpoch, current.epoch) + 1;
    const checkpoint = signCheckpoint(epoch, this.#privateKey, this.#keyId);
    writeCheckpoint(this.#path, checkpoint);
    this.#observedEpoch = epoch;
    return { state: "verified", epoch, checkpoint };
  }

  reEnroll(checkpoint: AuthenticatedLeaseCheckpoint): LeaseWitnessSnapshot {
    if (!this.#privateKey) throw new LeaseContinuityError("witness private key is unavailable for re-enrollment");
    if (checkpoint.keyId !== this.#keyId || !verifyCheckpoint(checkpoint, this.#publicKey, this.#keyId)) {
      throw new LeaseContinuityError("re-enrollment checkpoint signature or key identity is invalid");
    }
    if (checkpoint.epoch <= this.#observedEpoch) throw new LeaseContinuityError("re-enrollment checkpoint must be higher than the observed epoch");
    writeCheckpoint(this.#path, checkpoint);
    this.#observedEpoch = checkpoint.epoch;
    this.#unverifiableReason = undefined;
    return { state: "verified", epoch: checkpoint.epoch, checkpoint };
  }
}

export function createSignedLeaseCheckpoint(epoch: number, privateKey: KeyLike, keyId = "forgedock-lease"): AuthenticatedLeaseCheckpoint {
  return signCheckpoint(epoch, privateKey, keyId);
}

export function createConfiguredLeaseWitness(cwd: string): RetainedCheckpointWitness | undefined {
  const path = process.env.FORGEDOCK_LEASE_WITNESS_PATH;
  const publicKey = process.env.FORGEDOCK_LEASE_WITNESS_PUBLIC_KEY;
  const privateKey = process.env.FORGEDOCK_LEASE_WITNESS_PRIVATE_KEY;
  if (!path || !publicKey || !privateKey) return undefined;
  const keyId = process.env.FORGEDOCK_LEASE_WITNESS_KEY_ID;
  return new RetainedCheckpointWitness({
    path: path.startsWith(".") ? `${cwd}/${path}` : path,
    publicKey,
    privateKey,
    ...(keyId !== undefined ? { keyId } : {}),
  });
}

function payload(epoch: number, keyId: string): Buffer {
  return Buffer.from(JSON.stringify({ epoch, keyId }), "utf8");
}
function signCheckpoint(epoch: number, privateKey: KeyLike, keyId: string): AuthenticatedLeaseCheckpoint {
  return { epoch, keyId, signature: sign(null, payload(epoch, keyId), privateKey).toString("base64url") };
}
function verifyCheckpoint(checkpoint: AuthenticatedLeaseCheckpoint, publicKey: KeyLike, keyId: string): boolean {
  try { return verify(null, payload(checkpoint.epoch, keyId), createPublicKey(publicKey), Buffer.from(checkpoint.signature, "base64url")); }
  catch { return false; }
}
function readCheckpoint(path: string): AuthenticatedLeaseCheckpoint {
  if (!existsSync(path)) throw new LeaseContinuityError("retained checkpoint is missing");
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!parsed || typeof parsed !== "object") throw new LeaseContinuityError("retained checkpoint is malformed");
  const value = parsed as Record<string, unknown>;
  const epoch = value.epoch;
  const signature = value.signature;
  const keyId = value.keyId;
  if (typeof epoch !== "number" || !Number.isSafeInteger(epoch) || epoch < 0
    || typeof signature !== "string" || typeof keyId !== "string") {
    throw new LeaseContinuityError("retained checkpoint is malformed");
  }
  return { epoch, signature, keyId };
}
function writeCheckpoint(path: string, checkpoint: AuthenticatedLeaseCheckpoint): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${crypto.randomUUID()}`;
  writeFileSync(temporary, `${JSON.stringify(checkpoint)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(temporary, path);
}
