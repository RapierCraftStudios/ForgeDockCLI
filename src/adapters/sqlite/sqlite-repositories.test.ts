import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { createArtifact } from "../../core/artifacts/schema.js";
import type { OrchestrationRecord } from "../../core/ports/orchestration.js";
import { ConcurrentPromotionUpdateError, type PromotionRecord } from "../../core/ports/promotion.js";
import { ConcurrentRunUpdateError } from "../../core/ports/repositories.js";
import type { AgentRunReceipt } from "../../core/ports/telemetry.js";
import { createRun, transition } from "../../core/state/machine.js";
import { InMemoryLeaseWitness } from "../../core/ports/lease.js";
import { bootstrapLocalLeaseWitness, createConfiguredLeaseWitness, createSignedLeaseCheckpoint } from "./lease-witness.js";
import { SqliteRepositories } from "./sqlite-repositories.js";

describe("SQLite operational repositories", () => {
  it("waits for a concurrent writer before recording operational progress", async () => {
    const root = mkdtempSync(join(process.env.TEMP ?? process.env.TMP ?? ".", "forgedock-sqlite-lock-"));
    const path = join(root, "state.db");
    const store = new SqliteRepositories(path);
    let holder: ReturnType<typeof spawn> | undefined;
    try {
      const run = createRun({ workflow: "work-on", subject: { repo: "a/b", issue: 10 }, runId: "run_lock" });
      await store.create(run);
      holder = spawn(process.execPath, ["-e", [
        'const { DatabaseSync } = require("node:sqlite");',
        'const db = new DatabaseSync(process.argv[1]);',
        'db.exec("BEGIN IMMEDIATE");',
        'process.stdout.write("locked\\n");',
        'setTimeout(() => { db.exec("COMMIT"); db.close(); }, 250);',
      ].join(""), path], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
      await new Promise<void>((resolve, reject) => {
        holder!.stdout!.once("data", () => resolve());
        holder!.once("error", reject);
      });
      await store.recordProgress({ runId: run.runId, phase: "controller.lock-test", message: "Recovered after a concurrent writer", occurredAt: "2026-01-01T00:00:00.000Z" });
      await new Promise<void>((resolve, reject) => {
        holder!.once("close", () => resolve());
        holder!.once("error", reject);
      });
      holder = undefined;
      assert.equal((await store.listProgress(run.runId)).length, 1);
    } finally {
      holder?.kill();
      store.close();
      await new Promise((resolve) => setTimeout(resolve, 100));
      try { rmSync(root, { recursive: true, force: true }); } catch { /* Windows may release SQLite handles shortly after close. */ }
    }
  });

  it("persists artifacts and run transitions across repository instances", async () => {
    const store = new SqliteRepositories(":memory:");
    try {
      const subject = { repo: "acme/widget", issue: 9 };
      const run = createRun({ workflow: "work-on", subject, runId: "run_sql", now: "2026-01-01T00:00:00.000Z" });
      const artifact = createArtifact({
        kind: "Intent", runId: run.runId, subject,
        producer: { role: "controller" },
        payload: { title: "Test", problem: "Test persistence", constraints: [], acceptanceHints: [], dependencies: [] },
      });
      await store.append(artifact);
      await store.create(run);
      const started = transition(run, "START_INVESTIGATION", { now: "2026-01-01T00:00:01.000Z" });
      await store.commit(run.version, started.state, started.record);

      assert.equal((await store.list(subject))[0]?.id, artifact.id);
      assert.equal((await store.load(run.runId))?.state, "investigating");
      assert.deepEqual((await store.history(run.runId)).map((record) => record.event), ["START_INVESTIGATION"]);
    } finally {
      store.close();
    }
  });

  it("persists controller progress without advancing the state-machine version", async () => {
    const store = new SqliteRepositories(":memory:");
    try {
      const run = createRun({ workflow: "work-on", subject: { repo: "a/b", issue: 11 }, runId: "run_progress" });
      await store.create(run);
      await store.recordProgress({ runId: run.runId, phase: "controller.heartbeat", message: "Lease renewed", occurredAt: "2026-01-01T00:00:00.000Z" });
      assert.equal((await store.load(run.runId))?.version, run.version);
      assert.deepEqual(await store.listProgress(run.runId), [{
        runId: run.runId, phase: "controller.heartbeat", message: "Lease renewed", occurredAt: "2026-01-01T00:00:00.000Z",
      }]);
    } finally {
      store.close();
    }
  });

  it("persists orchestration DAG records for restart inspection", async () => {
    const store = new SqliteRepositories(":memory:");
    const record: OrchestrationRecord = {
      schema: "forgedock.orchestration/v1",
      orchestrationId: "dag_test",
      repository: "a/b",
      issueNumbers: [9, 10],
      maxParallel: 2,
      autoMerge: true,
      status: "running",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      nodes: [{
        id: "issue-9", issue: 9, priority: 1, dependencies: [], claims: ["src"],
        status: "running", childRunIds: ["run_9"],
      }, {
        id: "issue-10", issue: 10, priority: 2, dependencies: ["issue-9"], claims: ["docs"],
        status: "queued", childRunIds: [],
      }],
    };
    try {
      await store.createOrchestration(record);
      const loaded = await store.loadOrchestration(record.orchestrationId);
      assert.deepEqual(loaded, record);
      const completed = { ...record, status: "completed" as const, updatedAt: "2026-01-01T00:01:00.000Z" };
      await store.saveOrchestration(completed);
      assert.equal((await store.listOrchestrations())[0]?.status, "completed");
    } finally {
      store.close();
    }
  });

  it("persists promotion checkpoints with optimistic versions", async () => {
    const store = new SqliteRepositories(":memory:");
    const record: PromotionRecord = {
      schema: "forgedock.promotion/v1",
      promotionId: "promotion_test",
      repository: "a/b",
      mode: "production",
      sourceBranch: "staging",
      targetBranch: "main",
      sourceHeadSha: "a".repeat(40),
      targetHeadSha: "b".repeat(40),
      authorized: true,
      mergeAuthorized: false,
      phase: "planned",
      version: 0,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    try {
      await store.createPromotion(record);
      assert.deepEqual(await store.loadPromotion(record.promotionId), record);
      const next = { ...record, phase: "pr-created" as const, version: 1, updatedAt: "2026-01-01T00:00:01.000Z" };
      await store.savePromotion(record.version, next);
      assert.equal((await store.listPromotions())[0]?.phase, "pr-created");
      await assert.rejects(store.savePromotion(record.version, { ...next, version: 1 }), ConcurrentPromotionUpdateError);
    } finally {
      store.close();
    }
  });

  it("persists telemetry receipts idempotently for status projections", async () => {
    const store = new SqliteRepositories(":memory:");
    try {
      const receipt: AgentRunReceipt = {
        key: "run_telemetry:task:session",
        runId: "run_telemetry",
        taskId: "run_telemetry:investigation:1",
        phase: "investigation",
        role: "investigator",
        sessionRef: "session",
        sessionLineage: ["session"],
        provider: "test",
        model: "model",
        timing: { queuedAt: "2026-01-01T00:00:00.000Z", startedAt: "2026-01-01T00:00:00.000Z", completedAt: "2026-01-01T00:00:01.000Z", activeMs: 1_000, queueMs: 0, retryCount: 0 },
        usage: { source: "unavailable" },
      };
      await store.recordTelemetry(receipt);
      await store.recordTelemetry(receipt);
      assert.deepEqual(store.listTelemetry(receipt.runId), [receipt]);
    } finally {
      store.close();
    }
  });

  it("rebuilds divergent operational run state from durable authority", async () => {
    const store = new SqliteRepositories(":memory:");
    try {
      const queued = createRun({ workflow: "work-on", subject: { repo: "a/b", issue: 1 }, runId: "run_rebuild" });
      await store.create(queued);
      const started = transition(queued, "START_INVESTIGATION");
      await store.commit(queued.version, started.state, started.record);
      await store.recordProgress({ runId: queued.runId, phase: "controller.heartbeat", message: "stale", occurredAt: "2026-01-01T00:00:00.000Z" });
      await store.rebuildRun({ ...queued, state: "building" });
      assert.equal((await store.load(queued.runId))?.state, "building");
      assert.deepEqual(await store.history(queued.runId), []);
      assert.deepEqual(await store.listProgress(queued.runId), []);
    } finally {
      store.close();
    }
  });

  it("persists cross-process-style leases with stale recovery", () => {
    const store = new SqliteRepositories(":memory:", { witness: new InMemoryLeaseWitness() });
    try {
      const first = store.acquire("issue-9", "worker-a", 100, 1_000);
      assert.ok(first);
      assert.equal(store.acquire("issue-9", "worker-b", 100, 1_050), undefined);
      assert.equal(store.heartbeat("issue-9", first.token, 100, 1_050).expiresAt, 1_150);
      assert.equal(store.acquire("issue-9", "worker-b", 100, 1_151)?.owner, "worker-b");
    } finally {
      store.close();
    }
  });

  it("bootstraps an authenticated epoch-zero witness for the first file-backed lease", () => {
    const root = mkdtempSync(join(process.env.TEMP ?? process.env.TMP ?? ".", "forgedock-sqlite-bootstrap-"));
    const checkout = join(root, "checkout");
    const localDataRoot = join(root, "local-data");
    const databasePath = join(checkout, ".forgedock", "state.db");
    let store: SqliteRepositories | undefined;
    mkdirSync(checkout);
    try {
      const bootstrap = bootstrapLocalLeaseWitness(checkout, { localDataRoot });
      const witness = createConfiguredLeaseWitness(checkout, { localDataRoot, environment: {} });
      assert.ok(witness);
      const initial = witness.verify();
      assert.equal(initial.state, "verified");
      if (initial.state !== "verified") throw new Error("expected the local checkpoint to verify");
      assert.equal(initial.epoch, 0);
      assert.equal(initial.checkpoint?.keyId, bootstrap.keyId);
      assert.ok(initial.checkpoint?.signature);
      assert.equal((JSON.parse(readFileSync(bootstrap.checkpointPath, "utf8")) as { epoch: number }).epoch, 0);

      store = new SqliteRepositories(databasePath, { witness });
      const empty = store.continuity();
      assert.equal(empty.state, "verified");
      assert.equal(empty.epoch, 0);
      const first = store.acquire("issue-bootstrap", "worker-a", 100, 1_000);
      assert.ok(first);
      assert.equal(first.epoch, 1);
      assert.equal(first.continuity, "verified");
      assert.equal(store.continuity().epoch, 1);
    } finally {
      store?.close();
      try { rmSync(root, { recursive: true, force: true }); } catch { /* Windows may release SQLite handles shortly after close. */ }
    }
  });

  it("does not adopt a rolled-back file checkpoint after lease history exists", () => {
    const root = mkdtempSync(join(process.env.TEMP ?? process.env.TMP ?? ".", "forgedock-sqlite-rollback-"));
    const checkout = join(root, "checkout");
    const localDataRoot = join(root, "local-data");
    const databasePath = join(checkout, ".forgedock", "state.db");
    let store: SqliteRepositories | undefined;
    mkdirSync(checkout);
    try {
      const bootstrap = bootstrapLocalLeaseWitness(checkout, { localDataRoot });
      const privateKey = readFileSync(bootstrap.privateKeyPath, "utf8");
      const witness = createConfiguredLeaseWitness(checkout, { localDataRoot, environment: {} });
      assert.ok(witness);
      store = new SqliteRepositories(databasePath, { witness });
      const first = store.acquire("issue-file-rollback", "worker-a", 100, 1_000);
      assert.ok(first);
      const staleGuard = store.guard("issue-file-rollback", first.token);

      writeFileSync(bootstrap.checkpointPath, JSON.stringify(createSignedLeaseCheckpoint(0, privateKey, bootstrap.keyId)));
      assert.throws(() => store!.heartbeat("issue-file-rollback", first.token, 100, 1_010), /continuity|backwards|unverifiable/i);
      assert.throws(() => store!.release("issue-file-rollback", first.token), /continuity|backwards|unverifiable/i);
      assert.throws(() => staleGuard.assertValid(), /continuity|backwards|unverifiable/i);
      assert.throws(() => store!.acquire("issue-file-rollback", "worker-b", 100, 2_000), /continuity|backwards|unverifiable/i);

      store!.reEnroll(createSignedLeaseCheckpoint(10, privateKey, bootstrap.keyId));
      assert.equal(store!.continuity().state, "verified");
      assert.equal(store!.continuity().epoch, 10);
      assert.throws(() => store!.heartbeat("issue-file-rollback", first.token, 100, 2_010), /re-enrollment|predates/i);
      assert.throws(() => store!.release("issue-file-rollback", first.token), /re-enrollment|predates/i);
      assert.throws(() => staleGuard.assertValid(), /re-enrollment|predates/i);
      const recovered = store!.acquire("issue-file-rollback", "worker-b", 100, 2_000);
      assert.ok(recovered);
      assert.equal(recovered.epoch, 11);
      assert.notEqual(recovered.token, first.token);
    } finally {
      store?.close();
      try { rmSync(root, { recursive: true, force: true }); } catch { /* Windows may release SQLite handles shortly after close. */ }
    }
  });

  it("rejects a higher checkpoint in a historical store until explicit re-enrollment", () => {
    const root = mkdtempSync(join(process.env.TEMP ?? process.env.TMP ?? ".", "forgedock-sqlite-higher-"));
    const checkout = join(root, "checkout");
    const localDataRoot = join(root, "local-data");
    const databasePath = join(checkout, ".forgedock", "state.db");
    let store: SqliteRepositories | undefined;
    mkdirSync(checkout);
    try {
      const bootstrap = bootstrapLocalLeaseWitness(checkout, { localDataRoot });
      const privateKey = readFileSync(bootstrap.privateKeyPath, "utf8");
      const witness = createConfiguredLeaseWitness(checkout, { localDataRoot, environment: {} });
      assert.ok(witness);
      store = new SqliteRepositories(databasePath, { witness });
      const first = store.acquire("issue-file-higher", "worker-a", 100, 1_000);
      assert.ok(first);
      const staleGuard = store.guard("issue-file-higher", first.token);

      writeFileSync(bootstrap.checkpointPath, JSON.stringify(createSignedLeaseCheckpoint(5, privateKey, bootstrap.keyId)));
      assert.throws(() => store!.acquire("issue-file-higher", "worker-b", 100, 2_000), /diverge|continuity|unverifiable/i);
      assert.throws(() => store!.heartbeat("issue-file-higher", first.token, 100, 2_010), /continuity|diverge|unverifiable/i);
      assert.throws(() => store!.release("issue-file-higher", first.token), /continuity|diverge|unverifiable/i);
      assert.throws(() => staleGuard.assertValid(), /continuity|diverge|unverifiable/i);

      store!.reEnroll(createSignedLeaseCheckpoint(10, privateKey, bootstrap.keyId));
      const recovered = store!.acquire("issue-file-higher", "worker-b", 100, 2_000);
      assert.ok(recovered);
      assert.equal(recovered.epoch, 11);
      assert.notEqual(recovered.token, first.token);
    } finally {
      store?.close();
      try { rmSync(root, { recursive: true, force: true }); } catch { /* Windows may release SQLite handles shortly after close. */ }
    }
  });

  it("latches a historical store closed on an invalid checkpoint", () => {
    const root = mkdtempSync(join(process.env.TEMP ?? process.env.TMP ?? ".", "forgedock-sqlite-tampered-"));
    const checkout = join(root, "checkout");
    const localDataRoot = join(root, "local-data");
    const databasePath = join(checkout, ".forgedock", "state.db");
    let store: SqliteRepositories | undefined;
    mkdirSync(checkout);
    try {
      const bootstrap = bootstrapLocalLeaseWitness(checkout, { localDataRoot });
      const privateKey = readFileSync(bootstrap.privateKeyPath, "utf8");
      const witness = createConfiguredLeaseWitness(checkout, { localDataRoot, environment: {} });
      assert.ok(witness);
      store = new SqliteRepositories(databasePath, { witness });
      const first = store.acquire("issue-file-tampered", "worker-a", 100, 1_000);
      assert.ok(first);
      const staleGuard = store.guard("issue-file-tampered", first.token);

      const tampered = createSignedLeaseCheckpoint(1, privateKey, bootstrap.keyId);
      tampered.signature = `${tampered.signature}tampered`;
      writeFileSync(bootstrap.checkpointPath, JSON.stringify(tampered));
      assert.throws(() => store!.heartbeat("issue-file-tampered", first.token, 100, 1_010), /invalid|continuity|unverifiable/i);
      assert.throws(() => store!.release("issue-file-tampered", first.token), /invalid|continuity|unverifiable/i);
      assert.throws(() => staleGuard.assertValid(), /invalid|continuity|unverifiable/i);
      assert.throws(() => store!.acquire("issue-file-tampered", "worker-b", 100, 2_000), /invalid|continuity|unverifiable/i);

      store!.reEnroll(createSignedLeaseCheckpoint(10, privateKey, bootstrap.keyId));
      const recovered = store!.acquire("issue-file-tampered", "worker-b", 100, 2_000);
      assert.ok(recovered);
      assert.equal(recovered.epoch, 11);
      assert.notEqual(recovered.token, first.token);
    } finally {
      store?.close();
      try { rmSync(root, { recursive: true, force: true }); } catch { /* Windows may release SQLite handles shortly after close. */ }
    }
  });

  it("reopens a file-backed local witness without reusing an expiry epoch", () => {
    const root = mkdtempSync(join(process.env.TEMP ?? process.env.TMP ?? ".", "forgedock-sqlite-local-restart-"));
    const checkout = join(root, "checkout");
    const localDataRoot = join(root, "local-data");
    const databasePath = join(checkout, ".forgedock", "state.db");
    let firstStore: SqliteRepositories | undefined;
    let restarted: SqliteRepositories | undefined;
    mkdirSync(checkout);
    try {
      bootstrapLocalLeaseWitness(checkout, { localDataRoot });
      const firstWitness = createConfiguredLeaseWitness(checkout, { localDataRoot, environment: {} });
      assert.ok(firstWitness);
      firstStore = new SqliteRepositories(databasePath, { witness: firstWitness });
      const first = firstStore.acquire("issue-local-restart", "worker-a", 100, 1_000);
      assert.ok(first);
      firstStore.close();
      firstStore = undefined;

      const restartedWitness = createConfiguredLeaseWitness(checkout, { localDataRoot, environment: {} });
      assert.ok(restartedWitness);
      restarted = new SqliteRepositories(databasePath, { witness: restartedWitness });
      assert.equal(restarted.continuity().epoch, first.epoch);
      assert.equal(restarted.acquire("issue-local-restart", "worker-b", 100, 1_050), undefined);
      const recovered = restarted.acquire("issue-local-restart", "worker-b", 100, 1_101);
      assert.ok(recovered);
      assert.equal(recovered.epoch, first.epoch + 1);
      assert.notEqual(recovered.token, first.token);
    } finally {
      firstStore?.close();
      restarted?.close();
      try { rmSync(root, { recursive: true, force: true }); } catch { /* Windows may release SQLite handles shortly after close. */ }
    }
  });

  it("fails closed on rollback and permits only higher authenticated re-enrollment", () => {
    const witness = new InMemoryLeaseWitness();
    const store = new SqliteRepositories(":memory:", { witness });
    try {
      const first = store.acquire("issue-rollback", "worker-a", 100, 1_000);
      assert.ok(first);
      witness.rollback(0);
      assert.throws(() => store.heartbeat("issue-rollback", first.token, 100, 1_010), /unverifiable|rolled back/i);
      assert.throws(() => store.release("issue-rollback", first.token), /unverifiable|rolled back/i);
      const higher = { ...witness.checkpoint(), epoch: 10 };
      higher.signature = Buffer.from(`10:forgedock-test-retained-key`, "utf8").toString("base64url");
      store.reEnroll(higher);
      assert.throws(() => store.heartbeat("issue-rollback", first.token, 100, 1_020), /re-enrollment|unverifiable/i);
      assert.throws(() => store.release("issue-rollback", first.token), /re-enrollment|unverifiable/i);
      const recovered = store.acquire("issue-rollback", "worker-b", 100, 1_020);
      assert.equal(recovered?.epoch, 11);
      assert.equal(recovered?.token === first.token, false);
    } finally { store.close(); }
  });

  it("retains fencing epochs across a repository restart and expiry recovery", () => {
    const root = mkdtempSync(join(process.env.TEMP ?? process.env.TMP ?? ".", "forgedock-sqlite-restart-"));
    const path = join(root, "state.db");
    const witness = new InMemoryLeaseWitness();
    const firstStore = new SqliteRepositories(path, { witness });
    try {
      const first = firstStore.acquire("issue-restart", "worker-a", 100, 1_000);
      assert.ok(first);
      firstStore.close();
      const restarted = new SqliteRepositories(path, { witness });
      try {
        assert.equal(restarted.acquire("issue-restart", "worker-b", 100, 1_050), undefined);
        const recovered = restarted.acquire("issue-restart", "worker-b", 100, 1_101);
        assert.equal(recovered?.epoch, first.epoch + 1);
        assert.notEqual(recovered?.token, first.token);
      } finally { restarted.close(); }
    } finally {
      try { rmSync(root, { recursive: true, force: true }); } catch { /* Windows may release SQLite handles shortly after close. */ }
    }
  });

  it("atomically shares remediation admission across repository instances", async () => {
    const root = mkdtempSync(join(process.env.TEMP ?? process.env.TMP ?? ".", "forgedock-admission-"));
    const path = join(root, "state.db");
    const first = new SqliteRepositories(path);
    const second = new SqliteRepositories(path);
    const key = {
      repo: "Owner/Repo", parentIssue: 20, parentPullRequest: 9, headSha: "A".repeat(40), marker: "marker-1",
    } as const;
    const snapshot = { repo: "Owner/Repo", number: 31, title: "Child", body: "", url: "https://example.test/issues/31", state: "OPEN" as const };
    try {
      const claims = await Promise.all([first.claim(key), second.claim(key)]);
      assert.equal(claims.filter((claim) => claim.status === "claimed").length, 1);
      assert.equal(claims.filter((claim) => claim.status === "pending").length, 1);
      await first.complete(key, snapshot);
      assert.deepEqual(await second.claim(key), { status: "materialized", snapshot });
      assert.equal(await second.invalidateMaterialized(key, snapshot.number + 1), false);
      assert.deepEqual(await first.claim(key), { status: "materialized", snapshot });
      assert.equal(await second.invalidateMaterialized(key, snapshot.number), true);
      assert.deepEqual(await Promise.all([first.claim(key), second.claim(key)]).then((claims) => claims.map(({ status }) => status).sort()), ["claimed", "pending"]);
    } finally {
      first.close();
      second.close();
      try { rmSync(root, { recursive: true, force: true }); } catch { /* Windows may release SQLite handles shortly after close. */ }
    }
  });

  it("uses compare-and-swap versions to reject concurrent writers", async () => {
    const store = new SqliteRepositories(":memory:");
    try {
      const run = createRun({ workflow: "work-on", subject: { repo: "a/b", issue: 1 }, runId: "run_cas" });
      await store.create(run);
      const first = transition(run, "START_INVESTIGATION");
      await store.commit(0, first.state, first.record);
      await assert.rejects(store.commit(0, first.state, first.record), ConcurrentRunUpdateError);
    } finally {
      store.close();
    }
  });
});
