// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  chmodSync,
  existsSync,
  lstatSync,
  linkSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createHash, createPublicKey, generateKeyPairSync, randomUUID, sign, timingSafeEqual, verify, type KeyLike } from "node:crypto";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
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

const LOCAL_WITNESS_SCHEMA = "forgedock.lease-witness-local/v1" as const;
const LOCAL_WITNESS_CONFIG = join(".forgedock", "lease-witness.json");
const LOCAL_WITNESS_PUBLICATION_RETRY_ATTEMPTS = 50;
const LOCAL_WITNESS_PUBLICATION_RETRY_DELAY_MS = 5;
const LOCAL_WITNESS_PUBLICATION_RACE = Symbol("forgedock lease-witness publication race");

interface LocalLeaseWitnessReference {
  schema: typeof LOCAL_WITNESS_SCHEMA;
  checkoutDigest: string;
  checkpointPath: string;
  publicKeyPath: string;
  privateKeyPath: string;
  keyId: string;
}

export interface LocalLeaseWitnessBootstrap {
  recovered: boolean;
  checkoutDigest: string;
  configPath: string;
  checkpointPath: string;
  publicKeyPath: string;
  privateKeyPath: string;
  keyId: string;
}

interface LocalLeaseWitnessOptions {
  /** Test/embedded override. Production defaults to OS-local user data. */
  localDataRoot?: string;
  /** Test/embedded override. Production defaults to process.env. */
  environment?: NodeJS.ProcessEnv;
}

export function leaseWitnessRequirementMessage(phase: string, checkoutRoot: string): string {
  return [
    `Authenticated lease witness is required ${phase}.`,
    "ForgeDock checkout lease-witness preflight (not GitHub authentication) resolved this checkout:",
    `  ${checkoutRoot}`,
    "",
    "No valid lease witness is configured for this checkout.",
    "Bootstrap one from the resolved checkout with:",
    "  forgedock-next lease-witness-bootstrap",
    "or configure all FORGEDOCK_LEASE_WITNESS_* variables.",
  ].join("\n");
}

/**
 * Resolve an explicitly configured witness first, then the per-checkout local
 * bootstrap reference. Partial environment configuration and any corrupt local
 * reference fail closed instead of falling back to weaker lease semantics.
 */
export function createConfiguredLeaseWitness(
  cwd: string,
  options: LocalLeaseWitnessOptions = {},
): RetainedCheckpointWitness | undefined {
  const environment = options.environment ?? process.env;
  const path = environment.FORGEDOCK_LEASE_WITNESS_PATH;
  const publicKey = environment.FORGEDOCK_LEASE_WITNESS_PUBLIC_KEY;
  const privateKey = environment.FORGEDOCK_LEASE_WITNESS_PRIVATE_KEY;
  const environmentValues = [path, publicKey, privateKey];
  if (environmentValues.some((value) => value !== undefined)) {
    if (!path || !publicKey || !privateKey) {
      throw new LeaseContinuityError("FORGEDOCK_LEASE_WITNESS_PATH, FORGEDOCK_LEASE_WITNESS_PUBLIC_KEY, and FORGEDOCK_LEASE_WITNESS_PRIVATE_KEY must be configured together");
    }
    const keyId = environment.FORGEDOCK_LEASE_WITNESS_KEY_ID;
    return verifiedWitness({
      path: path.startsWith(".") ? resolve(cwd, path) : path,
      publicKey,
      privateKey,
      ...(keyId !== undefined ? { keyId } : {}),
    });
  }

  const paths = localWitnessPaths(cwd, options.localDataRoot);
  if (!existsSync(paths.configPath)) return undefined;
  const reference = readLocalReference(paths.configPath);
  assertLocalReference(reference, paths);
  assertRegularFile(reference.checkpointPath, "retained checkpoint");
  assertRegularFile(reference.publicKeyPath, "witness public key");
  assertRegularFile(reference.privateKeyPath, "witness private key");
  assertPrivateKeyPermissions(reference.privateKeyPath);
  const configuredPublicKey = readFileSync(reference.publicKeyPath, "utf8");
  const configuredPrivateKey = readFileSync(reference.privateKeyPath, "utf8");
  return verifiedWitness({
    path: reference.checkpointPath,
    publicKey: configuredPublicKey,
    privateKey: configuredPrivateKey,
    keyId: reference.keyId,
  });
}

/**
 * Return the checkout's configured witness, creating the local single-machine
 * witness on first use. Explicit environment configuration and any existing
 * local state are still validated before bootstrap, so partial, corrupt, or
 * cross-checkout state continues to fail closed.
 */
export function createOrBootstrapLocalLeaseWitness(
  cwd: string,
  options: LocalLeaseWitnessOptions = {},
): RetainedCheckpointWitness {
  const configured = createConfiguredLeaseWitness(cwd, options);
  if (configured) return configured;

  try {
    bootstrapLocalLeaseWitness(cwd, options);
  } catch (error) {
    // A concurrent first-use process may have completed bootstrap after our
    // initial lookup. Adopt it only if the complete witness now verifies.
    // The directory publication can precede the checkout reference by a
    // small, intentional window, so only that marked EEXIST is retried.
    if (isWitnessDirectoryPublicationRace(error)) {
      return retryLocalWitnessPublication(cwd, options, error);
    }
    const raced = createConfiguredLeaseWitness(cwd, options);
    if (raced) return raced;
    throw error;
  }

  const created = createConfiguredLeaseWitness(cwd, options);
  if (!created) throw new LeaseContinuityError("local lease witness bootstrap did not produce a configured witness");
  return created;
}

/**
 * Create one fail-closed, single-checkout witness in OS-local user data. The
 * operation never overwrites existing key material or checkout configuration.
 */
export function bootstrapLocalLeaseWitness(
  cwd: string,
  options: Pick<LocalLeaseWitnessOptions, "localDataRoot"> = {},
): LocalLeaseWitnessBootstrap {
  const paths = localWitnessPaths(cwd, options.localDataRoot);
  if (existsSync(paths.configPath)) throw new Error(`Lease witness bootstrap already exists at ${paths.configPath}`);
  if (existsSync(paths.witnessDirectory)) return recoverLocalLeaseWitness(paths);

  mkdirSync(dirname(paths.witnessDirectory), { recursive: true, mode: 0o700 });
  mkdirSync(dirname(paths.configPath), { recursive: true, mode: 0o700 });
  const temporaryDirectory = `${paths.witnessDirectory}.tmp-${process.pid}-${randomUUID()}`;
  let installed = false;
  try {
    mkdirSync(temporaryDirectory, { mode: 0o700 });
    const keys = generateKeyPairSync("ed25519");
    const privateKey = keys.privateKey.export({ format: "pem", type: "pkcs8" }).toString();
    const publicKey = keys.publicKey.export({ format: "pem", type: "spki" }).toString();
    const temporaryCheckpoint = join(temporaryDirectory, "checkpoint.json");
    const temporaryPublicKey = join(temporaryDirectory, "public.pem");
    const temporaryPrivateKey = join(temporaryDirectory, "private.pem");
    writeFileSync(temporaryPublicKey, publicKey, { encoding: "utf8", mode: 0o600, flag: "wx" });
    writeFileSync(temporaryPrivateKey, privateKey, { encoding: "utf8", mode: 0o600, flag: "wx" });
    const witness = new RetainedCheckpointWitness({
      path: temporaryCheckpoint,
      publicKey,
      privateKey,
      keyId: paths.keyId,
    });
    // An empty SQLite lease store starts at epoch 0. The first successful
    // acquire advances both stores to epoch 1; bootstrap must not make the
    // retained witness one epoch newer before the database has any history.
    writeCheckpoint(temporaryCheckpoint, createSignedLeaseCheckpoint(0, privateKey, paths.keyId));
    if (witness.verify().state !== "verified") throw new LeaseContinuityError("newly seeded local witness could not be verified");
    try {
      renameSync(temporaryDirectory, paths.witnessDirectory);
    } catch (error) {
      // Preserve the original fs error while identifying this exact expected
      // publication race to the bounded first-use retry path.
      if (isErrnoException(error) && error.code === "EEXIST") {
        Object.defineProperty(error, LOCAL_WITNESS_PUBLICATION_RACE, { value: true });
      }
      throw error;
    }
    installed = true;
    if (process.platform !== "win32") chmodSync(paths.witnessDirectory, 0o700);

    const reference = localWitnessReference(paths);
    publishLocalWitnessReference(paths.configPath, reference);
    return localWitnessBootstrapResult(paths, false);
  } catch (error) {
    if (existsSync(temporaryDirectory)) rmSync(temporaryDirectory, { recursive: true, force: true });
    if (installed && !existsSync(paths.configPath) && existsSync(paths.witnessDirectory)) {
      rmSync(paths.witnessDirectory, { recursive: true, force: true });
    }
    throw error;
  }
}

/**
 * Complete the only recoverable bootstrap interruption: key material was
 * atomically installed, but the checkout reference was not. Existing material
 * is adopted only after the directory shape, key pair, and signed checkpoint
 * all verify for this canonical checkout. Nothing in the witness directory is
 * modified by recovery.
 */
function recoverLocalLeaseWitness(paths: ReturnType<typeof localWitnessPaths>): LocalLeaseWitnessBootstrap {
  assertWitnessDirectory(paths);
  const publicKey = readFileSync(paths.publicKeyPath, "utf8");
  const privateKey = readFileSync(paths.privateKeyPath, "utf8");
  verifiedWitness({
    path: paths.checkpointPath,
    publicKey,
    privateKey,
    keyId: paths.keyId,
  });

  const reference = localWitnessReference(paths);
  publishLocalWitnessReference(paths.configPath, reference);
  return localWitnessBootstrapResult(paths, true);
}

function assertWitnessDirectory(paths: ReturnType<typeof localWitnessPaths>): void {
  try {
    const directory = lstatSync(paths.witnessDirectory);
    if (directory.isSymbolicLink() || !directory.isDirectory()) {
      throw new Error("witness path must be a regular non-symlink directory");
    }
    if (!samePath(realpathSync.native(paths.witnessDirectory), paths.witnessDirectory)) {
      throw new Error("witness directory resolved outside its expected path");
    }
    const actualEntries = readdirSync(paths.witnessDirectory).sort();
    const expectedEntries = ["checkpoint.json", "private.pem", "public.pem"].sort();
    if (actualEntries.join("\0") !== expectedEntries.join("\0")) {
      throw new Error("witness directory does not contain exactly the expected files");
    }
    assertRegularFile(paths.checkpointPath, "retained checkpoint");
    assertRegularFile(paths.publicKeyPath, "witness public key");
    assertRegularFile(paths.privateKeyPath, "witness private key");
    assertPrivateKeyPermissions(paths.privateKeyPath);
  } catch (error) {
    if (error instanceof LeaseContinuityError) throw error;
    const detail = error instanceof Error ? error.message : String(error);
    throw new LeaseContinuityError(`existing local witness cannot be safely recovered: ${detail}`);
  }
}

function localWitnessReference(paths: ReturnType<typeof localWitnessPaths>): LocalLeaseWitnessReference {
  return {
    schema: LOCAL_WITNESS_SCHEMA,
    checkoutDigest: paths.checkoutDigest,
    checkpointPath: paths.checkpointPath,
    publicKeyPath: paths.publicKeyPath,
    privateKeyPath: paths.privateKeyPath,
    keyId: paths.keyId,
  };
}

function localWitnessBootstrapResult(
  paths: ReturnType<typeof localWitnessPaths>,
  recovered: boolean,
): LocalLeaseWitnessBootstrap {
  return {
    recovered,
    checkoutDigest: paths.checkoutDigest,
    configPath: paths.configPath,
    checkpointPath: paths.checkpointPath,
    publicKeyPath: paths.publicKeyPath,
    privateKeyPath: paths.privateKeyPath,
    keyId: paths.keyId,
  };
}

function publishLocalWitnessReference(configPath: string, reference: LocalLeaseWitnessReference): void {
  // A wx destination is visible before writeFileSync has finished. Write the
  // complete reference under a unique name first, then create the checkout
  // name with linkSync. linkSync is an atomic no-replace operation on the same
  // filesystem, so readers see either no reference or a complete reference;
  // an existing reference is never overwritten.
  const temporaryPath = `${configPath}.tmp-${process.pid}-${randomUUID()}`;
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(reference, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    linkSync(temporaryPath, configPath);
  } finally {
    if (existsSync(temporaryPath)) rmSync(temporaryPath, { force: true });
  }
}

function retryLocalWitnessPublication(
  cwd: string,
  options: LocalLeaseWitnessOptions,
  originalError: unknown,
): RetainedCheckpointWitness {
  const waiter = new Int32Array(new SharedArrayBuffer(4));
  for (let attempt = 0; attempt < LOCAL_WITNESS_PUBLICATION_RETRY_ATTEMPTS; attempt += 1) {
    if (attempt > 0) Atomics.wait(waiter, 0, 0, LOCAL_WITNESS_PUBLICATION_RETRY_DELAY_MS);
    const configured = createConfiguredLeaseWitness(cwd, options);
    if (configured) return configured;
  }
  // Do not replace the bootstrap failure with a timeout or an unverified
  // directory; callers retain the original fail-closed error.
  throw originalError;
}

function isWitnessDirectoryPublicationRace(error: unknown): boolean {
  return isErrnoException(error) && error[LOCAL_WITNESS_PUBLICATION_RACE] === true;
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException & Record<typeof LOCAL_WITNESS_PUBLICATION_RACE, boolean> {
  return typeof error === "object" && error !== null && "code" in error;
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

function verifiedWitness(options: { path: string; publicKey: KeyLike; privateKey: KeyLike; keyId?: string }): RetainedCheckpointWitness {
  assertMatchingKeyPair(options.publicKey, options.privateKey);
  const witness = new RetainedCheckpointWitness(options);
  const snapshot = witness.verify();
  if (snapshot.state !== "verified") throw new LeaseContinuityError(snapshot.reason ?? "retained checkpoint cannot be verified");
  return witness;
}

function assertMatchingKeyPair(publicKey: KeyLike, privateKey: KeyLike): void {
  try {
    const configured = createPublicKey(publicKey).export({ format: "der", type: "spki" });
    const derived = createPublicKey(privateKey).export({ format: "der", type: "spki" });
    if (configured.length !== derived.length || !timingSafeEqual(configured, derived)) {
      throw new Error("public and private key do not match");
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new LeaseContinuityError(`witness key material is invalid or mismatched: ${detail}`);
  }
}

function readLocalReference(path: string): LocalLeaseWitnessReference {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("reference must be an object");
    const value = parsed as Record<string, unknown>;
    const expectedKeys = ["schema", "checkoutDigest", "checkpointPath", "publicKeyPath", "privateKeyPath", "keyId"];
    if (Object.keys(value).sort().join("\0") !== expectedKeys.sort().join("\0")
      || value.schema !== LOCAL_WITNESS_SCHEMA
      || typeof value.checkoutDigest !== "string"
      || typeof value.checkpointPath !== "string"
      || typeof value.publicKeyPath !== "string"
      || typeof value.privateKeyPath !== "string"
      || typeof value.keyId !== "string") {
      throw new Error("reference shape is invalid");
    }
    return value as unknown as LocalLeaseWitnessReference;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new LeaseContinuityError(`local witness reference is malformed: ${detail}`);
  }
}

function assertLocalReference(reference: LocalLeaseWitnessReference, expected: ReturnType<typeof localWitnessPaths>): void {
  if (reference.checkoutDigest !== expected.checkoutDigest
    || reference.keyId !== expected.keyId
    || !samePath(reference.checkpointPath, expected.checkpointPath)
    || !samePath(reference.publicKeyPath, expected.publicKeyPath)
    || !samePath(reference.privateKeyPath, expected.privateKeyPath)) {
    throw new LeaseContinuityError("local witness reference does not match this canonical checkout and OS-local witness directory");
  }
  if (![reference.checkpointPath, reference.publicKeyPath, reference.privateKeyPath].every(isAbsolute)) {
    throw new LeaseContinuityError("local witness paths must be absolute");
  }
}

function assertRegularFile(path: string, label: string): void {
  try {
    const link = lstatSync(path);
    if (link.isSymbolicLink() || !link.isFile()) throw new Error(`${label} must be a regular non-symlink file`);
    if (!samePath(realpathSync.native(path), path)) throw new Error(`${label} resolved outside its configured path`);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new LeaseContinuityError(`${label} is unavailable or unsafe: ${detail}`);
  }
}

function assertPrivateKeyPermissions(path: string): void {
  if (process.platform === "win32") return;
  if ((statSync(path).mode & 0o077) !== 0) {
    throw new LeaseContinuityError("local witness private key permissions must deny group and other access");
  }
}

function localWitnessPaths(cwd: string, requestedLocalDataRoot?: string) {
  const canonicalCheckout = realpathSync.native(cwd);
  const canonicalIdentity = process.platform === "win32" ? canonicalCheckout.toLowerCase() : canonicalCheckout;
  const checkoutDigest = createHash("sha256").update(canonicalIdentity, "utf8").digest("hex");
  const localDataRoot = resolve(requestedLocalDataRoot ?? defaultLocalDataRoot());
  const witnessDirectory = join(localDataRoot, "ForgeDock", "lease-witnesses", checkoutDigest);
  const keyId = `forgedock-local-${checkoutDigest.slice(0, 16)}`;
  return {
    checkoutDigest,
    keyId,
    witnessDirectory,
    configPath: join(canonicalCheckout, LOCAL_WITNESS_CONFIG),
    checkpointPath: join(witnessDirectory, "checkpoint.json"),
    publicKeyPath: join(witnessDirectory, "public.pem"),
    privateKeyPath: join(witnessDirectory, "private.pem"),
  };
}

function defaultLocalDataRoot(): string {
  if (process.platform === "win32") return process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
  if (process.platform === "darwin") return join(homedir(), "Library", "Application Support");
  return process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state");
}

function samePath(left: string, right: string): boolean {
  const normalizedLeft = resolve(left);
  const normalizedRight = resolve(right);
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}
