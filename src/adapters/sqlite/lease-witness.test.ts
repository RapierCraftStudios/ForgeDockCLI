// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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

  it("serializes independent first-use callers through one published witness", async () => {
    const root = mkdtempSync(join(tmpdir(), "forgedock-witness-concurrent-"));
    const checkout = join(root, "checkout");
    const localDataRoot = join(root, "local-data");
    mkdirSync(checkout);
    try {
      const modulePath = new URL("./lease-witness.js", import.meta.url).href;
      const callers = [
        spawnLeaseBootstrapChild(modulePath, checkout, localDataRoot),
        spawnLeaseBootstrapChild(modulePath, checkout, localDataRoot),
      ];
      // Both children are released by the same barrier, so neither can turn
      // this into a sequential in-process test.
      callers.forEach((child) => child.start());
      const results = await Promise.all(callers.map((child) => child.result));
      const first = results[0]!;
      assert.deepEqual(first, results[1]);
      assert.deepEqual(first.snapshot, { state: "verified", epoch: 0 });
      assert.equal(typeof first.reference.checkoutDigest, "string");
      assert.equal((first.reference.checkoutDigest as string).length, 64);
      assert.equal(existsSync(localBootstrapLockPath(checkout, localDataRoot)), false);
      assert.doesNotMatch(readFileSync(join(checkout, ".forgedock", "lease-witness.json"), "utf8"), /PRIVATE KEY|PUBLIC KEY/);
      assert.deepEqual(readdirSync(join(checkout, ".forgedock")), ["lease-witness.json"]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("reclaims dead bootstrap owners but fails boundedly for live owners", () => {
    const root = mkdtempSync(join(tmpdir(), "forgedock-witness-lock-"));
    const checkout = join(root, "checkout");
    const localDataRoot = join(root, "local-data");
    mkdirSync(checkout);
    const lockPath = localBootstrapLockPath(checkout, localDataRoot);
    try {
      mkdirSync(join(localDataRoot, "ForgeDock", "lease-witnesses"), { recursive: true });
      writeFileSync(lockPath, "not-json");
      assert.throws(
        () => bootstrapLocalLeaseWitness(checkout, { localDataRoot }),
        /bootstrap lock is malformed/i,
      );
      assert.equal(existsSync(lockPath), true);
      rmSync(lockPath);
      writeFileSync(lockPath, JSON.stringify({ pid: findDeadPid(), token: randomUUID(), createdAt: Date.now() }));
      const reclaimed = bootstrapLocalLeaseWitness(checkout, { localDataRoot });
      assert.equal(createConfiguredLeaseWitness(checkout, { localDataRoot, environment: {} })?.verify().epoch, 0);
      assert.equal(reclaimed.privateKeyPath.includes(checkout), false);

      rmSync(reclaimed.configPath);
      writeFileSync(lockPath, JSON.stringify({ pid: process.pid, token: randomUUID(), createdAt: Date.now() }));
      assert.throws(
        () => bootstrapLocalLeaseWitness(checkout, { localDataRoot }),
        /timed out.*bootstrap lock/i,
      );
      assert.equal(readFileSync(reclaimed.privateKeyPath, "utf8").includes("PRIVATE KEY"), true);
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
      assert.equal(readdirSync(join(localDataRoot, "ForgeDock", "lease-witnesses")).some((entry) => entry.endsWith(".bootstrap.lock")), false);
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

interface LeaseBootstrapChildResult {
  snapshot: { state: string; epoch: number };
  reference: Record<string, unknown>;
}

function spawnLeaseBootstrapChild(modulePath: string, checkout: string, localDataRoot: string): {
  start: () => void;
  result: Promise<LeaseBootstrapChildResult>;
} {
  const script = `
    import { readFileSync } from "node:fs";
    import { createOrBootstrapLocalLeaseWitness } from ${JSON.stringify(modulePath)};
    process.stdin.once("data", () => {
      try {
        const witness = createOrBootstrapLocalLeaseWitness(${JSON.stringify(checkout)}, { localDataRoot: ${JSON.stringify(localDataRoot)}, environment: {} });
        const snapshot = witness.verify();
        const reference = JSON.parse(readFileSync(${JSON.stringify(join(checkout, ".forgedock", "lease-witness.json"))}, "utf8"));
        process.stdout.write(JSON.stringify({ snapshot: { state: snapshot.state, epoch: snapshot.epoch }, reference }) + "\\n");
      } catch (error) {
        process.stderr.write(error instanceof Error ? error.stack ?? error.message : String(error));
        process.exitCode = 1;
      }
    });
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
  child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
  const result = new Promise<LeaseBootstrapChildResult>((resolveResult, rejectResult) => {
    child.once("close", (code) => {
      if (code !== 0) {
        rejectResult(new Error(`bootstrap child exited ${code}: ${stderr}`));
        return;
      }
      try {
        resolveResult(JSON.parse(stdout) as LeaseBootstrapChildResult);
      } catch (error) {
        rejectResult(error);
      }
    });
  });
  return {
    start: () => { child.stdin.write("go\\n"); child.stdin.end(); },
    result,
  };
}

function localBootstrapLockPath(checkout: string, localDataRoot: string): string {
  const canonicalCheckout = realpathSync.native(checkout);
  const canonicalIdentity = process.platform === "win32" ? canonicalCheckout.toLowerCase() : canonicalCheckout;
  const digest = createHash("sha256").update(canonicalIdentity, "utf8").digest("hex");
  return join(resolve(localDataRoot), "ForgeDock", "lease-witnesses", `${digest}.bootstrap.lock`);
}

function findDeadPid(): number {
  for (let pid = process.pid + 1; pid < process.pid + 100_000; pid += 1) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return pid;
    }
  }
  return 2_000_000_000;
}
