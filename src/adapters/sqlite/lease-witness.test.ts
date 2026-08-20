// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { describe, it } from "node:test";
import { LeaseContinuityError } from "../../core/ports/lease.js";
import { SqliteRepositories } from "./sqlite-repositories.js";
import {
  bootstrapLocalLeaseWitness,
  createConfiguredLeaseWitness,
  createOrBootstrapLocalLeaseWitness,
  createSignedLeaseCheckpoint,
  leaseWitnessRequirementMessage,
  RetainedCheckpointWitness,
} from "./lease-witness.js";

describe("retained lease checkpoint witness", () => {
  it("authenticates compare-and-advance and rejects invalid signatures", () => {
    const root = mkdtempSync(join(tmpdir(), "forgedock-witness-"));
    const path = join(root, "checkpoint.json");
    const keys = generateKeyPairSync("ed25519");
    const privateKey = keys.privateKey.export({ format: "pem", type: "pkcs8" }).toString();
    const publicKey = keys.publicKey.export({ format: "pem", type: "spki" }).toString();
    try {
      const witness = new RetainedCheckpointWitness({ path, publicKey, privateKey, keyId: "test" });
      assert.equal(witness.verify().state, "unverifiable");
      const seeded = new RetainedCheckpointWitness({ path, publicKey, privateKey, keyId: "test" });
      // Seed is an explicit operator action, not an inferred generation zero.
      seeded.reEnroll(createSignedLeaseCheckpoint(1, privateKey, "test"));
      assert.equal(witness.verify().state, "verified");
      assert.equal(witness.compareAndAdvance(1).epoch, 2);
      const invalid = JSON.parse(readFileSync(path, "utf8")) as { epoch: number; signature: string; keyId: string };
      invalid.signature = `${invalid.signature.slice(0, -2)}xx`;
      writeFileSync(path, JSON.stringify(invalid));
      assert.equal(witness.verify().state, "unverifiable");
      assert.throws(() => witness.compareAndAdvance(2), LeaseContinuityError);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("rejects lower checkpoints during explicit re-enrollment", () => {
    const root = mkdtempSync(join(tmpdir(), "forgedock-witness-"));
    const path = join(root, "checkpoint.json");
    const keys = generateKeyPairSync("ed25519");
    const privateKey = keys.privateKey.export({ format: "pem", type: "pkcs8" }).toString();
    const publicKey = keys.publicKey.export({ format: "pem", type: "spki" }).toString();
    try {
      const witness = new RetainedCheckpointWitness({ path, publicKey, privateKey });
      witness.reEnroll(createSignedLeaseCheckpoint(5, privateKey));
      assert.throws(() => witness.reEnroll(createSignedLeaseCheckpoint(4, privateKey)), /higher|observed/i);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("bootstraps a verified per-checkout witness without storing secrets in the checkout", () => {
    const root = mkdtempSync(join(tmpdir(), "forgedock-witness-bootstrap-"));
    const checkout = join(root, "checkout");
    const localDataRoot = join(root, "local-data");
    mkdirSync(checkout);
    try {
      const result = bootstrapLocalLeaseWitness(checkout, { localDataRoot });
      assert.equal(result.recovered, false);
      const referenceText = readFileSync(result.configPath, "utf8");
      const reference = JSON.parse(referenceText) as Record<string, unknown>;
      assert.equal(reference.schema, "forgedock.lease-witness-local/v1");
      assert.equal(reference.checkoutDigest, result.checkoutDigest);
      assert.equal(reference.privateKeyPath, result.privateKeyPath);
      assert.doesNotMatch(referenceText, /PRIVATE KEY|PUBLIC KEY/);
      assert.equal(createConfiguredLeaseWitness(checkout, { localDataRoot, environment: {} })?.verify().state, "verified");
      if (process.platform !== "win32") assert.equal(statSync(result.privateKeyPath).mode & 0o077, 0);
      assert.throws(() => bootstrapLocalLeaseWitness(checkout, { localDataRoot }), /already exists|refusing to overwrite/i);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("uses a freshly bootstrapped witness for the first SQLite lease", () => {
    const root = mkdtempSync(join(tmpdir(), "forgedock-witness-first-lease-"));
    const checkout = join(root, "checkout");
    const localDataRoot = join(root, "local-data");
    mkdirSync(checkout);
    try {
      bootstrapLocalLeaseWitness(checkout, { localDataRoot });
      const witness = createConfiguredLeaseWitness(checkout, { localDataRoot, environment: {} });
      assert.ok(witness);
      assert.equal(witness.verify().epoch, 0);
      const store = new SqliteRepositories(join(checkout, ".forgedock", "state.db"), { witness });
      try {
        const lease = store.acquire("first-use", "worker", 1_000, 1_000);
        assert.equal(lease?.epoch, 1);
        assert.equal(store.continuity().state, "verified");
      } finally { store.close(); }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("creates the local witness on first use without weakening corrupt-state checks", () => {
    const root = mkdtempSync(join(tmpdir(), "forgedock-witness-first-use-"));
    const checkout = join(root, "checkout");
    const localDataRoot = join(root, "local-data");
    mkdirSync(checkout);
    try {
      const witness = createOrBootstrapLocalLeaseWitness(checkout, { localDataRoot, environment: {} });
      assert.equal(witness.verify().state, "verified");
      assert.equal(witness.verify().epoch, 0);

      const configured = createOrBootstrapLocalLeaseWitness(checkout, { localDataRoot, environment: {} });
      assert.equal(configured.verify().state, "verified");

      const referencePath = join(checkout, ".forgedock", "lease-witness.json");
      writeFileSync(referencePath, "not-json");
      assert.throws(
        () => createOrBootstrapLocalLeaseWitness(checkout, { localDataRoot, environment: {} }),
        /malformed|continuity/i,
      );
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("adopts a concurrently completing first-use bootstrap only after full verification", async () => {
    const root = mkdtempSync(join(tmpdir(), "forgedock-witness-concurrent-"));
    const checkout = join(root, "checkout");
    const localDataRoot = join(root, "local-data");
    mkdirSync(checkout);
    const barrier = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 2);
    const workerModule = new URL("./lease-witness.js", import.meta.url).href;
    const workerSource = `
      import { parentPort, workerData } from "node:worker_threads";
      try {
        const { createOrBootstrapLocalLeaseWitness } = await import(workerData.moduleUrl);
        const witness = createOrBootstrapLocalLeaseWitness(workerData.checkout, {
          localDataRoot: workerData.localDataRoot,
          environment: {},
          ...(workerData.pauseAfterInstall ? {
            onWitnessDirectoryInstalled: () => {
              const state = new Int32Array(workerData.barrier);
              Atomics.store(state, 0, 1);
              Atomics.notify(state, 0);
              while (Atomics.load(state, 1) === 0) Atomics.wait(state, 1, 0);
            },
          } : {}),
        });
        parentPort.postMessage({ epoch: witness.verify().epoch });
      } catch (error) {
        parentPort.postMessage({ error: error instanceof Error ? error.message : String(error) });
      }
    `;
    const startWorker = (pauseAfterInstall: boolean): Worker => new Worker(workerSource, {
      eval: true,
      workerData: { moduleUrl: workerModule, checkout, localDataRoot, barrier, pauseAfterInstall },
    });
    const result = (worker: Worker): Promise<{ epoch?: number; error?: string }> => new Promise((resolve, reject) => {
      worker.once("message", resolve);
      worker.once("error", reject);
    });
    const first = startWorker(true);
    const secondPromise = new Promise<{ epoch?: number; error?: string }>((resolve, reject) => {
      const waitForInstall = (): void => {
        if (Atomics.load(new Int32Array(barrier), 0) === 1) {
          const second = startWorker(false);
          void result(second).then(resolve, reject);
          return;
        }
        setTimeout(waitForInstall, 1);
      };
      waitForInstall();
    });
    try {
      const second = await secondPromise;
      assert.equal(second.error, undefined);
      Atomics.store(new Int32Array(barrier), 1, 1);
      Atomics.notify(new Int32Array(barrier), 1);
      const firstResult = await result(first);
      assert.equal(firstResult.error, undefined);
      assert.equal(firstResult.epoch, 0);
      assert.equal(second.epoch, 0);
      const referencePath = join(checkout, ".forgedock", "lease-witness.json");
      const reference = JSON.parse(readFileSync(referencePath, "utf8")) as Record<string, unknown>;
      assert.equal(typeof reference.publicKeyPath, "string");
      assert.equal(createConfiguredLeaseWitness(checkout, { localDataRoot, environment: {} })?.verify().epoch, 0);
    } finally {
      Atomics.store(new Int32Array(barrier), 1, 1);
      Atomics.notify(new Int32Array(barrier), 1);
      await first.terminate();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("bridges the historical epoch-one bootstrap only into an unused lease store", () => {
    const root = mkdtempSync(join(tmpdir(), "forgedock-witness-old-bootstrap-"));
    const checkout = join(root, "checkout");
    const localDataRoot = join(root, "local-data");
    mkdirSync(checkout);
    try {
      bootstrapLocalLeaseWitness(checkout, { localDataRoot });
      const witness = createConfiguredLeaseWitness(checkout, { localDataRoot, environment: {} });
      assert.ok(witness);
      assert.equal(witness.compareAndAdvance(0).epoch, 1);
      const store = new SqliteRepositories(join(checkout, ".forgedock", "state.db"), { witness });
      try {
        const lease = store.acquire("first-use", "worker", 1_000, 1_000);
        assert.equal(lease?.epoch, 2);
        assert.equal(store.continuity().epoch, 2);
      } finally { store.close(); }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("recovers a complete orphaned witness without replacing key material", () => {
    const root = mkdtempSync(join(tmpdir(), "forgedock-witness-recover-"));
    const checkout = join(root, "checkout");
    const localDataRoot = join(root, "local-data");
    mkdirSync(checkout);
    try {
      const created = bootstrapLocalLeaseWitness(checkout, { localDataRoot });
      const privateKeyBefore = readFileSync(created.privateKeyPath, "utf8");
      const publicKeyBefore = readFileSync(created.publicKeyPath, "utf8");
      const checkpointBefore = readFileSync(created.checkpointPath, "utf8");
      rmSync(created.configPath);

      const recovered = bootstrapLocalLeaseWitness(checkout, { localDataRoot });

      assert.equal(recovered.recovered, true);
      assert.equal(readFileSync(recovered.privateKeyPath, "utf8"), privateKeyBefore);
      assert.equal(readFileSync(recovered.publicKeyPath, "utf8"), publicKeyBefore);
      assert.equal(readFileSync(recovered.checkpointPath, "utf8"), checkpointBefore);
      assert.equal(createConfiguredLeaseWitness(checkout, { localDataRoot, environment: {} })?.verify().state, "verified");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("refuses to recover malformed or unexpected orphaned witness material", () => {
    const root = mkdtempSync(join(tmpdir(), "forgedock-witness-recover-invalid-"));
    const checkout = join(root, "checkout");
    const localDataRoot = join(root, "local-data");
    mkdirSync(checkout);
    try {
      const created = bootstrapLocalLeaseWitness(checkout, { localDataRoot });
      rmSync(created.configPath);
      writeFileSync(join(created.checkpointPath, "..", "unexpected.txt"), "unexpected");

      assert.throws(
        () => bootstrapLocalLeaseWitness(checkout, { localDataRoot }),
        /cannot be safely recovered|expected files|continuity/i,
      );
      assert.equal(readFileSync(created.privateKeyPath, "utf8").includes("PRIVATE KEY"), true);
      assert.equal(readFileSync(created.publicKeyPath, "utf8").includes("PUBLIC KEY"), true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("fails closed when the checkout binding or local key material is corrupted", () => {
    const root = mkdtempSync(join(tmpdir(), "forgedock-witness-corrupt-"));
    const checkout = join(root, "checkout");
    const localDataRoot = join(root, "local-data");
    mkdirSync(checkout);
    try {
      const result = bootstrapLocalLeaseWitness(checkout, { localDataRoot });
      const reference = JSON.parse(readFileSync(result.configPath, "utf8")) as Record<string, unknown>;
      writeFileSync(result.configPath, JSON.stringify({ ...reference, checkoutDigest: "0".repeat(64) }));
      assert.throws(
        () => createConfiguredLeaseWitness(checkout, { localDataRoot, environment: {} }),
        /canonical checkout|continuity/i,
      );

      writeFileSync(result.configPath, JSON.stringify(reference));
      const replacement = generateKeyPairSync("ed25519").publicKey.export({ format: "pem", type: "spki" }).toString();
      writeFileSync(result.publicKeyPath, replacement);
      assert.throws(
        () => createConfiguredLeaseWitness(checkout, { localDataRoot, environment: {} }),
        /mismatched|continuity/i,
      );
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("prefers a complete explicit environment witness and rejects partial overrides", () => {
    const root = mkdtempSync(join(tmpdir(), "forgedock-witness-env-"));
    const checkout = join(root, "checkout");
    const localDataRoot = join(root, "local-data");
    const explicitPath = join(root, "explicit-checkpoint.json");
    mkdirSync(checkout);
    try {
      const local = bootstrapLocalLeaseWitness(checkout, { localDataRoot });
      writeFileSync(local.configPath, "not-json");
      const keys = generateKeyPairSync("ed25519");
      const privateKey = keys.privateKey.export({ format: "pem", type: "pkcs8" }).toString();
      const publicKey = keys.publicKey.export({ format: "pem", type: "spki" }).toString();
      const explicit = new RetainedCheckpointWitness({ path: explicitPath, publicKey, privateKey, keyId: "explicit-test" });
      explicit.reEnroll(createSignedLeaseCheckpoint(4, privateKey, "explicit-test"));
      const environment = {
        FORGEDOCK_LEASE_WITNESS_PATH: explicitPath,
        FORGEDOCK_LEASE_WITNESS_PUBLIC_KEY: publicKey,
        FORGEDOCK_LEASE_WITNESS_PRIVATE_KEY: privateKey,
        FORGEDOCK_LEASE_WITNESS_KEY_ID: "explicit-test",
      };
      assert.equal(createConfiguredLeaseWitness(checkout, { localDataRoot, environment })?.verify().epoch, 4);
      assert.throws(
        () => createConfiguredLeaseWitness(checkout, {
          localDataRoot,
          environment: { FORGEDOCK_LEASE_WITNESS_PATH: explicitPath },
        }),
        /must be configured together|continuity/i,
      );
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("distinguishes checkout preflight from GitHub authentication and names the resolved root", () => {
    const message = leaseWitnessRequirementMessage(
      "before orchestration planning can authorize dispatch",
      "/home/dev/Projects/ForgeDockCLI",
    );
    assert.match(message, /not GitHub authentication/);
    assert.match(message, /\/home\/dev\/Projects\/ForgeDockCLI/);
    assert.match(message, /forgedock-next lease-witness-bootstrap/);
  });
});
