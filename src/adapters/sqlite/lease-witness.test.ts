// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

type ConcurrentChildRole = "winner" | "loser";

interface MaterialDigests {
  checkpoint: string;
  publicKey: string;
  privateKey: string;
}

interface ConcurrentChildResult {
  ok: boolean;
  role?: ConcurrentChildRole;
  state?: string;
  epoch?: number;
  reference?: Record<string, unknown>;
  materialDigests?: MaterialDigests;
  error?: string;
}

interface ConcurrentChildHandle {
  result: Promise<{ code: number | null; output: ConcurrentChildResult }>;
  terminate: () => void;
}

function runConcurrentFirstUseChild(input: {
  checkout: string;
  localDataRoot: string;
  start: string;
  ready: string;
  role: ConcurrentChildRole;
  witnessDirectory: string;
  winnerInstalled: string;
  winnerRelease: string;
  loserPreRename: string;
  loserRelease: string;
  loserRace: string;
}): ConcurrentChildHandle {
  const moduleUrl = new URL("./lease-witness.js", import.meta.url).href;
  const source = `
    import fs, { existsSync, readFileSync, writeFileSync } from "node:fs";
    import { syncBuiltinESMExports } from "node:module";
    import { createHash } from "node:crypto";
    const input = ${JSON.stringify(input)};
    const waiter = new Int32Array(new SharedArrayBuffer(4));
    const waitFor = (path) => {
      while (!existsSync(path)) Atomics.wait(waiter, 0, 0, 2);
    };
    const digest = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
    const materialDigests = (directory) => ({
      checkpoint: digest(directory + "/checkpoint.json"),
      publicKey: digest(directory + "/public.pem"),
      privateKey: digest(directory + "/private.pem"),
    });
    const originalRenameSync = fs.renameSync.bind(fs);
    fs.renameSync = (source, destination) => {
      const isPublicationRename = typeof source === "string"
        && typeof destination === "string"
        && source.startsWith(input.witnessDirectory + ".tmp-")
        && destination === input.witnessDirectory;
      if (!isPublicationRename) return originalRenameSync(source, destination);
      if (input.role === "winner") {
        originalRenameSync(source, destination);
        writeFileSync(input.winnerInstalled, JSON.stringify({ role: input.role, materialDigests: materialDigests(destination) }));
        waitFor(input.winnerRelease);
        return;
      }
      writeFileSync(input.loserPreRename, "pre-rename");
      waitFor(input.winnerInstalled);
      waitFor(input.loserRelease);
      try {
        return originalRenameSync(source, destination);
      } catch (error) {
        const collisionCode = error && typeof error === "object" && "code" in error ? error.code : undefined;
        if (collisionCode === "EEXIST" || collisionCode === "ENOTEMPTY") {
          // A populated directory collision is ENOTEMPTY on this platform.
          // Normalize only the interposed competing rename so production's
          // publication-race marker and bounded retry path are exercised.
          writeFileSync(input.loserRace, JSON.stringify({ code: "EEXIST" }));
          const normalized = new Error(error instanceof Error ? error.message : String(error));
          normalized.code = "EEXIST";
          throw normalized;
        }
        throw error;
      }
    };
    syncBuiltinESMExports();
    const { createOrBootstrapLocalLeaseWitness } = await import(${JSON.stringify(moduleUrl)});
    writeFileSync(input.ready, "ready");
    waitFor(input.start);
    try {
      const witness = createOrBootstrapLocalLeaseWitness(input.checkout, { localDataRoot: input.localDataRoot, environment: {} });
      const snapshot = witness.verify();
      const reference = JSON.parse(readFileSync(input.checkout + "/.forgedock/lease-witness.json", "utf8"));
      process.stdout.write(JSON.stringify({
        ok: true,
        role: input.role,
        state: snapshot.state,
        epoch: snapshot.epoch,
        reference,
        materialDigests: materialDigests(input.witnessDirectory),
      }));
    } catch (error) {
      process.stdout.write(JSON.stringify({ ok: false, role: input.role, error: error instanceof Error ? error.message : String(error) }));
      process.exitCode = 1;
    }
  `;
  const childProcess = spawn(process.execPath, ["--input-type=module", "-e", source], { stdio: ["ignore", "pipe", "pipe"] });
  const result = new Promise<{ code: number | null; output: ConcurrentChildResult }>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    childProcess.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    childProcess.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    childProcess.once("error", reject);
    childProcess.once("close", (code) => {
      try {
        const output = JSON.parse(stdout) as ConcurrentChildResult;
        if (!output.ok && stderr) output.error = `${output.error ?? "child failed"}: ${stderr.trim()}`;
        resolve({ code, output });
      } catch (error) {
        reject(new Error(`concurrent witness child emitted invalid output: ${stdout}\n${stderr}`, { cause: error }));
      }
    });
  });
  return { result, terminate: () => { childProcess.kill(); } };
}

async function waitForFiles(paths: string[], message = "concurrent witness children did not become ready"): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!paths.every(existsSync) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(paths.every(existsSync), true, message);
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

  it("admits coordinated concurrent first use through one verified witness", async () => {
    const root = mkdtempSync(join(tmpdir(), "forgedock-witness-concurrent-"));
    const checkout = join(root, "checkout");
    const localDataRoot = join(root, "local-data");
    const winnerStart = join(root, "winner-start");
    const loserStart = join(root, "loser-start");
    const ready = [join(root, "ready-1"), join(root, "ready-2")];
    const winnerInstalled = join(root, "winner-installed");
    const winnerRelease = join(root, "winner-release");
    const loserPreRename = join(root, "loser-pre-rename");
    const loserRelease = join(root, "loser-release");
    const loserRace = join(root, "loser-race");
    mkdirSync(checkout);
    const canonicalCheckout = realpathSync.native(checkout);
    const canonicalIdentity = process.platform === "win32" ? canonicalCheckout.toLowerCase() : canonicalCheckout;
    const checkoutDigest = createHash("sha256").update(canonicalIdentity, "utf8").digest("hex");
    const witnessDirectory = join(localDataRoot, "ForgeDock", "lease-witnesses", checkoutDigest);
    const children: ConcurrentChildHandle[] = [];
    try {
      children.push(runConcurrentFirstUseChild({
        checkout,
        localDataRoot,
        start: winnerStart,
        ready: ready[0]!,
        role: "winner",
        witnessDirectory,
        winnerInstalled,
        winnerRelease,
        loserPreRename,
        loserRelease,
        loserRace,
      }));
      children.push(runConcurrentFirstUseChild({
        checkout,
        localDataRoot,
        start: loserStart,
        ready: ready[1]!,
        role: "loser",
        witnessDirectory,
        winnerInstalled,
        winnerRelease,
        loserPreRename,
        loserRelease,
        loserRace,
      }));
      await waitForFiles(ready, "concurrent witness children did not become ready");

      // Admit the loser first. It pauses inside the competing rename before
      // the winner is admitted, making the pre-rename handshake deterministic.
      writeFileSync(loserStart, "start");
      await waitForFiles([loserPreRename], "loser did not reach the pre-rename handshake");

      // Now admit the winner. It installs the directory and pauses before
      // publishing the checkout reference.
      writeFileSync(winnerStart, "start");
      await waitForFiles([winnerInstalled], "winner did not install the witness directory");

      // Release the competing rename first. The winner remains paused after
      // directory publication, so this marker proves that the loser observed
      // EEXIST before the checkout reference could be published.
      assert.equal(existsSync(winnerRelease), false);
      writeFileSync(loserRelease, "release");
      await waitForFiles([loserRace], "loser did not observe the publication-race EEXIST");
      assert.equal(existsSync(winnerRelease), false);
      assert.deepEqual(JSON.parse(readFileSync(loserRace, "utf8")), { code: "EEXIST" });
      writeFileSync(winnerRelease, "release");

      const results = await Promise.all(children.map((child) => child.result));
      for (const result of results) {
        assert.equal(result.code, 0, result.output.error);
        assert.equal(result.output.ok, true, result.output.error);
        assert.equal(result.output.state, "verified");
        assert.equal(result.output.epoch, 0);
        assert.doesNotMatch(result.output.error ?? "", /EEXIST/);
        assert.ok(result.output.reference);
        assert.ok(result.output.materialDigests);
      }

      const winner = results.find((result) => result.output.role === "winner");
      const loser = results.find((result) => result.output.role === "loser");
      assert.ok(winner);
      assert.ok(loser);
      const winnerManifest = JSON.parse(readFileSync(winnerInstalled, "utf8")) as {
        role: ConcurrentChildRole;
        materialDigests: MaterialDigests;
      };
      assert.equal(winnerManifest.role, "winner");
      assert.deepEqual(winner?.output.materialDigests, winnerManifest.materialDigests);
      assert.deepEqual(loser?.output.materialDigests, winnerManifest.materialDigests);
      assert.deepEqual(loser?.output.reference, winner?.output.reference);

      const expectedReference = {
        schema: "forgedock.lease-witness-local/v1",
        checkoutDigest,
        checkpointPath: join(witnessDirectory, "checkpoint.json"),
        publicKeyPath: join(witnessDirectory, "public.pem"),
        privateKeyPath: join(witnessDirectory, "private.pem"),
        keyId: `forgedock-local-${checkoutDigest.slice(0, 16)}`,
      };
      assert.deepEqual(winner?.output.reference, expectedReference);
      assert.equal(createConfiguredLeaseWitness(checkout, { localDataRoot, environment: {} })?.verify().state, "verified");
    } finally {
      // Always open the child gates before terminating children, including
      // assertion failures while the loser or winner is paused.
      writeFileSync(loserStart, "cleanup");
      writeFileSync(winnerStart, "cleanup");
      writeFileSync(loserRelease, "cleanup");
      writeFileSync(winnerRelease, "cleanup");
      for (const child of children) child.terminate();
      await Promise.allSettled(children.map((child) => child.result));
      rmSync(root, { recursive: true, force: true });
    }
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
