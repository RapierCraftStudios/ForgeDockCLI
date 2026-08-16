// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { LeaseContinuityError } from "../../core/ports/lease.js";
import {
  bootstrapLocalLeaseWitness,
  createConfiguredLeaseWitness,
  createSignedLeaseCheckpoint,
  RetainedCheckpointWitness,
} from "./lease-witness.js";

describe("retained lease checkpoint witness", () => {
  it("authenticates compare-and-advance and rejects invalid signatures", () => {
    const root = mkdtempSync(join(process.env.TEMP ?? process.env.TMP ?? ".", "forgedock-witness-"));
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
    const root = mkdtempSync(join(process.env.TEMP ?? process.env.TMP ?? ".", "forgedock-witness-"));
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
    const root = mkdtempSync(join(process.env.TEMP ?? process.env.TMP ?? ".", "forgedock-witness-bootstrap-"));
    const checkout = join(root, "checkout");
    const localDataRoot = join(root, "local-data");
    mkdirSync(checkout);
    try {
      const result = bootstrapLocalLeaseWitness(checkout, { localDataRoot });
      const referenceText = readFileSync(result.configPath, "utf8");
      const reference = JSON.parse(referenceText) as Record<string, unknown>;
      assert.equal(reference.schema, "forgedock.lease-witness-local/v1");
      assert.equal(reference.checkoutDigest, result.checkoutDigest);
      assert.equal(reference.privateKeyPath, result.privateKeyPath);
      assert.doesNotMatch(referenceText, /PRIVATE KEY|PUBLIC KEY/);
      const checkpoint = JSON.parse(readFileSync(result.checkpointPath, "utf8")) as Record<string, unknown>;
      assert.equal(checkpoint.epoch, 0);
      assert.equal(checkpoint.keyId, result.keyId);
      const configured = createConfiguredLeaseWitness(checkout, { localDataRoot, environment: {} });
      assert.ok(configured);
      const snapshot = configured.verify();
      assert.equal(snapshot.state, "verified");
      if (snapshot.state !== "verified") throw new Error("expected the bootstrapped checkpoint to verify");
      assert.equal(snapshot.epoch, 0);
      assert.equal(snapshot.checkpoint?.epoch, 0);
      assert.equal(snapshot.checkpoint?.keyId, result.keyId);
      assert.ok(snapshot.checkpoint?.signature);
      if (process.platform !== "win32") assert.equal(statSync(result.privateKeyPath).mode & 0o077, 0);
      const installedCheckpoint = readFileSync(result.checkpointPath, "utf8");
      const installedConfig = readFileSync(result.configPath, "utf8");
      assert.throws(() => bootstrapLocalLeaseWitness(checkout, { localDataRoot }), /already exists|refusing to overwrite/i);
      assert.equal(readFileSync(result.checkpointPath, "utf8"), installedCheckpoint);
      assert.equal(readFileSync(result.configPath, "utf8"), installedConfig);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("rejects missing, malformed, wrong-key, and tampered checkpoints instead of treating them as epoch zero", () => {
    const root = mkdtempSync(join(process.env.TEMP ?? process.env.TMP ?? ".", "forgedock-witness-checkpoint-"));
    const checkout = join(root, "checkout");
    const localDataRoot = join(root, "local-data");
    mkdirSync(checkout);
    try {
      const result = bootstrapLocalLeaseWitness(checkout, { localDataRoot });
      const privateKey = readFileSync(result.privateKeyPath, "utf8");
      const valid = createSignedLeaseCheckpoint(0, privateKey, result.keyId);

      rmSync(result.checkpointPath);
      assert.throws(
        () => createConfiguredLeaseWitness(checkout, { localDataRoot, environment: {} }),
        /missing|continuity/i,
      );

      writeFileSync(result.checkpointPath, "not-json");
      assert.throws(
        () => createConfiguredLeaseWitness(checkout, { localDataRoot, environment: {} }),
        /malformed|continuity/i,
      );

      const wrongKey = generateKeyPairSync("ed25519").privateKey.export({ format: "pem", type: "pkcs8" }).toString();
      writeFileSync(result.checkpointPath, JSON.stringify(createSignedLeaseCheckpoint(0, wrongKey, result.keyId)));
      assert.throws(
        () => createConfiguredLeaseWitness(checkout, { localDataRoot, environment: {} }),
        /invalid|continuity/i,
      );

      const tampered = { ...valid, signature: `${valid.signature}tampered` };
      writeFileSync(result.checkpointPath, JSON.stringify(tampered));
      assert.throws(
        () => createConfiguredLeaseWitness(checkout, { localDataRoot, environment: {} }),
        /invalid|continuity/i,
      );
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("fails closed when the checkout binding or local key material is corrupted", () => {
    const root = mkdtempSync(join(process.env.TEMP ?? process.env.TMP ?? ".", "forgedock-witness-corrupt-"));
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
    const root = mkdtempSync(join(process.env.TEMP ?? process.env.TMP ?? ".", "forgedock-witness-env-"));
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
});
