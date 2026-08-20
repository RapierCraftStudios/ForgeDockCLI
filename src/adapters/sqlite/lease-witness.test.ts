// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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

function runWitnessController(modulePath: string, checkout: string, localDataRoot: string): Promise<{ epoch: number; signature: string }> {
  const source = `
    import { createOrBootstrapLocalLeaseWitness } from ${JSON.stringify(modulePath)};
    const witness = createOrBootstrapLocalLeaseWitness(${JSON.stringify(checkout)}, {
      localDataRoot: ${JSON.stringify(localDataRoot)},
      environment: {},
    });
    const snapshot = witness.verify();
    if (snapshot.state !== "verified" || snapshot.epoch !== 0 || !snapshot.checkpoint) {
      throw new Error("child controller did not obtain a verified epoch-zero witness");
    }
    process.stdout.write(JSON.stringify({ epoch: snapshot.epoch, signature: snapshot.checkpoint.signature }));
  `;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", source], {
      env: { ...process.env, FORGEDOCK_TEST_LEASE_WITNESS_PAUSE_AFTER_INSTALL_MS: "250" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code !== 0) {
        reject(new Error(`witness controller exited ${code}: ${stderr}`));
        return;
      }
      try { resolve(JSON.parse(stdout) as { epoch: number; signature: string }); }
      catch (error) { reject(new Error(`invalid witness controller output: ${stdout}`, { cause: error })); }
    });
  });
}

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

  it("adopts one verified witness across concurrent first-use controller processes", async () => {
    const root = mkdtempSync(join(tmpdir(), "forgedock-witness-concurrent-"));
    const checkout = join(root, "checkout");
    const localDataRoot = join(root, "local-data");
    mkdirSync(checkout);
    try {
      const modulePath = join(dirname(fileURLToPath(import.meta.url)), "lease-witness.js");
      const results = await Promise.all([
        runWitnessController(modulePath, checkout, localDataRoot),
        runWitnessController(modulePath, checkout, localDataRoot),
      ]);
      assert.deepEqual(results[0], results[1]);
      assert.equal(results[0].epoch, 0);

      const witness = createConfiguredLeaseWitness(checkout, { localDataRoot, environment: {} });
      assert.ok(witness);
      assert.equal(witness.verify().state, "verified");
      assert.equal(witness.verify().epoch, 0);
      const store = new SqliteRepositories(join(checkout, ".forgedock", "state.db"), { witness });
      try {
        assert.equal(store.acquire("concurrent-first-use", "worker", 1_000, 1_000)?.epoch, 1);
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
