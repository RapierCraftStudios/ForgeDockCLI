// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
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

  it("adopts the verified witness across the deterministic rename/reference publication window", async () => {
    const root = mkdtempSync(join(tmpdir(), "forgedock-witness-concurrent-"));
    const checkout = join(root, "checkout");
    const localDataRoot = join(root, "local-data");
    const winnerBefore = join(root, "winner-before");
    const competitorBefore = join(root, "competitor-before");
    const winnerInstall = join(root, "winner-install");
    const competitorInstall = join(root, "competitor-install");
    const winnerInstalled = join(root, "winner-installed");
    const winnerPublish = join(root, "winner-publish");
    const contention = join(root, "contention");
    const winnerResult = join(root, "winner-result.json");
    const competitorResult = join(root, "competitor-result.json");
    mkdirSync(checkout);

    const childSource = [
      'import { existsSync, readFileSync, writeFileSync } from "node:fs";',
      'const { createOrBootstrapLocalLeaseWitness } = await import(process.env.MODULE_URL);',
      'const waitArray = new Int32Array(new SharedArrayBuffer(4));',
      'const waitFor = (path) => { while (!existsSync(path)) Atomics.wait(waitArray, 0, 0, 5); };',
      'const role = process.env.ROLE;',
      'const options = { localDataRoot: process.env.LOCAL_DATA_ROOT, environment: {} };',
      'if (role === "winner") {',
      '  options.beforeWitnessInstall = () => { writeFileSync(process.env.BEFORE, "ready"); waitFor(process.env.INSTALL); };',
      '  options.onWitnessInstalledBeforeReference = () => { writeFileSync(process.env.INSTALLED, "ready"); waitFor(process.env.PUBLISH); };',
      '} else {',
      '  options.beforeWitnessInstall = () => { writeFileSync(process.env.BEFORE, "ready"); waitFor(process.env.INSTALL); const error = new Error("simulated EEXIST at atomic witness install"); error.code = "EEXIST"; throw error; };',
      '  options.onBootstrapContention = () => writeFileSync(process.env.CONTENTION, "ready");',
      '}',
      'try {',
      '  const witness = createOrBootstrapLocalLeaseWitness(process.env.CHECKOUT, options);',
      '  const reference = JSON.parse(readFileSync(`${process.env.CHECKOUT}/.forgedock/lease-witness.json`, "utf8"));',
      '  writeFileSync(process.env.RESULT, JSON.stringify({ state: witness.verify().state, epoch: witness.verify().epoch, checkpoint: readFileSync(reference.checkpointPath, "utf8"), publicKey: readFileSync(reference.publicKeyPath, "utf8"), privateKey: readFileSync(reference.privateKeyPath, "utf8") }));',
      '} catch (error) {',
      '  writeFileSync(process.env.RESULT, JSON.stringify({ error: String(error), code: error?.code }));',
      '  process.exitCode = 1;',
      '}',
    ].join("\n");
    const moduleUrl = new URL("./lease-witness.js", import.meta.url).href;
    const start = (role: "winner" | "competitor", before: string, install: string, result: string) => spawn(process.execPath, ["--input-type=module", "-e", childSource], {
      env: {
        ...process.env,
        MODULE_URL: moduleUrl,
        ROLE: role,
        CHECKOUT: checkout,
        LOCAL_DATA_ROOT: localDataRoot,
        BEFORE: before,
        INSTALL: install,
        RESULT: result,
        ...(role === "winner"
          ? { INSTALLED: winnerInstalled, PUBLISH: winnerPublish }
          : { CONTENTION: contention }),
      },
      stdio: "ignore",
      windowsHide: true,
    });
    const waitForPath = async (path: string): Promise<void> => {
      const deadline = Date.now() + 5_000;
      while (!existsSync(path)) {
        if (Date.now() >= deadline) throw new Error(`timed out waiting for ${path}`);
        await new Promise<void>((resolve) => setTimeout(resolve, 5));
      }
    };
    const waitForExit = (child: ReturnType<typeof spawn>): Promise<void> => new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`witness child exited with ${code}`)));
    });
    let winner: ReturnType<typeof spawn> | undefined;
    let competitor: ReturnType<typeof spawn> | undefined;
    try {
      winner = start("winner", winnerBefore, winnerInstall, winnerResult);
      await waitForPath(winnerBefore);
      competitor = start("competitor", competitorBefore, competitorInstall, competitorResult);
      await waitForPath(competitorBefore);

      // Both callers passed their initial directory checks before either can
      // rename. The winner publishes the directory, then pauses before the
      // checkout reference; the competitor is forced to observe EEXIST.
      writeFileSync(winnerInstall, "go");
      await waitForPath(winnerInstalled);
      writeFileSync(competitorInstall, "go");
      await waitForPath(contention);
      writeFileSync(winnerPublish, "go");
      await Promise.all([waitForExit(winner), waitForExit(competitor)]);

      const winnerState = JSON.parse(readFileSync(winnerResult, "utf8")) as { state?: string; epoch?: number; checkpoint?: string; publicKey?: string; privateKey?: string; error?: string };
      const competitorState = JSON.parse(readFileSync(competitorResult, "utf8")) as { state?: string; epoch?: number; checkpoint?: string; publicKey?: string; privateKey?: string; error?: string };
      assert.equal(winnerState.state, "verified");
      assert.equal(winnerState.epoch, 0);
      assert.deepEqual(competitorState, winnerState);
      const referencePath = join(checkout, ".forgedock", "lease-witness.json");
      const reference = JSON.parse(readFileSync(referencePath, "utf8")) as {
        checkoutDigest: string;
        checkpointPath: string;
        publicKeyPath: string;
        privateKeyPath: string;
      };
      assert.equal(createConfiguredLeaseWitness(checkout, { localDataRoot, environment: {} })?.verify().state, "verified");
      assert.equal(readFileSync(reference.checkpointPath, "utf8"), winnerState.checkpoint);
      assert.equal(readFileSync(reference.publicKeyPath, "utf8"), winnerState.publicKey);
      assert.equal(readFileSync(reference.privateKeyPath, "utf8"), winnerState.privateKey);
      const installedRoot = join(localDataRoot, "ForgeDock", "lease-witnesses");
      assert.deepEqual(readdirSync(installedRoot), [reference.checkoutDigest]);
      assert.deepEqual(readdirSync(join(installedRoot, reference.checkoutDigest)).sort(), ["checkpoint.json", "private.pem", "public.pem"]);
    } finally {
      writeFileSync(winnerInstall, "go");
      writeFileSync(competitorInstall, "go");
      writeFileSync(winnerPublish, "go");
      winner?.kill();
      competitor?.kill();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("returns the original EEXIST after the bounded verified-adoption window", () => {
    const root = mkdtempSync(join(tmpdir(), "forgedock-witness-contention-bound-"));
    const checkout = join(root, "checkout");
    const localDataRoot = join(root, "local-data");
    mkdirSync(checkout);
    try {
      const started = Date.now();
      assert.throws(
        () => createOrBootstrapLocalLeaseWitness(checkout, {
          localDataRoot,
          environment: {},
          beforeWitnessInstall: () => {
            const error = new Error("simulated EEXIST contention");
            (error as NodeJS.ErrnoException).code = "EEXIST";
            throw error;
          },
        }),
        (error: unknown) => (error as NodeJS.ErrnoException).code === "EEXIST",
      );
      assert.ok(Date.now() - started < 2_000, "contention retry must remain bounded");
      assert.equal(existsSync(join(checkout, ".forgedock", "lease-witness.json")), false);
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
