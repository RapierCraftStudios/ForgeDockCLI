import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { createArtifact } from "../../core/artifacts/schema.js";
import { OrchestrationIssueOwnershipConflictError, type OrchestrationRecord } from "../../core/ports/orchestration.js";
import { ConcurrentPromotionUpdateError, type PromotionRecord } from "../../core/ports/promotion.js";
import { ConcurrentRunUpdateError } from "../../core/ports/repositories.js";
import type { AgentRunReceipt } from "../../core/ports/telemetry.js";
import { createRun, transition } from "../../core/state/machine.js";
import { InMemoryLeaseWitness } from "../../core/ports/lease.js";
import { LeaseBackedOrchestrationExecutionAdmission } from "./orchestration-admission.js";
import { SqliteRepositories } from "./sqlite-repositories.js";

interface ChildOutputState {
  buffer: string;
  stderr: string;
  waiter: { marker: string; resolve: (output: string) => void; reject: (error: Error) => void } | undefined;
}

const childOutputStates = new WeakMap<ReturnType<typeof spawn>, ChildOutputState>();

function waitForChildOutput(child: ReturnType<typeof spawn>, marker: string): Promise<string> {
  let state = childOutputStates.get(child);
  if (!state) {
    state = { buffer: "", stderr: "", waiter: undefined };
    childOutputStates.set(child, state);
    child.stdout?.on("data", (chunk) => {
      state!.buffer += String(chunk);
      resolveChildOutput(state!);
    });
    child.stderr?.on("data", (chunk) => { state!.stderr += String(chunk); });
    child.on("error", (error) => state!.waiter?.reject(error));
    child.on("exit", (code) => {
      if (state!.waiter && !state!.buffer.includes(state!.waiter.marker)) {
        state!.waiter.reject(new Error(`Lease race child exited ${code}: ${state!.stderr}`));
        state!.waiter = undefined;
      }
    });
  }
  if (state.waiter) throw new Error("Only one child-output wait may be active at a time");
  return new Promise<string>((resolve, reject) => {
    state!.waiter = { marker, resolve, reject };
    resolveChildOutput(state!);
  });
}

function resolveChildOutput(state: ChildOutputState): void {
  if (!state.waiter) return;
  const index = state.buffer.indexOf(state.waiter.marker);
  if (index < 0) return;
  const end = index + state.waiter.marker.length;
  const output = state.buffer.slice(0, end);
  state.buffer = state.buffer.slice(end);
  const { resolve } = state.waiter;
  state.waiter = undefined;
  resolve(output);
}

async function assertConcurrentConstructors(moduleUrl: string, className: string, databasePath: string, root: string): Promise<void> {
  const goPath = join(root, `${className}.go`);
  const childSource = [
    'const fs = require("node:fs");',
    'const [databasePath, goPath, moduleUrl, className] = process.argv.slice(1);',
    'const waitArray = new Int32Array(new SharedArrayBuffer(4));',
    'const timer = setInterval(() => {',
    '  if (!fs.existsSync(goPath)) return;',
    '  clearInterval(timer);',
    '  import(moduleUrl).then(({ [className]: Store }) => {',
    '    const store = new Store(databasePath);',
    '    process.stdout.write("ready\\n");',
    '    setTimeout(() => store.close(), 100);',
    '  }).catch((error) => { process.stderr.write(String(error)); process.exitCode = 1; });',
    '}, 1);',
  ].join("\n");
  const children = Array.from({ length: 8 }, () => spawn(process.execPath, [
    "-e", childSource, databasePath, goPath, moduleUrl, className,
  ], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true }));
  try {
    const ready = children.map((child) => waitForChildOutput(child, "ready\n"));
    writeFileSync(goPath, "go");
    await Promise.all(ready);
  } finally {
    writeFileSync(goPath, "go");
    for (const child of children) child.kill();
  }
}

describe("SQLite operational repositories", () => {
  it("waits for simultaneous repository and observation-store constructors", async () => {
    const root = mkdtempSync(join(process.env.TEMP ?? process.env.TMP ?? ".", "forgedock-sqlite-constructor-race-"));
    try {
      await assertConcurrentConstructors(new URL("./sqlite-repositories.js", import.meta.url).href, "SqliteRepositories", join(root, "state.db"), root);
      await assertConcurrentConstructors(new URL("../../observability/sqlite-store.js", import.meta.url).href, "SqliteObservationStore", join(root, "observations.db"), root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

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
      serializationEdges: [{
        predecessor: "issue-9",
        successor: "issue-10",
        overlappingClaims: ["src/**/*.ts ↔ src/foo.ts"],
      }],
      nodes: [{
        id: "issue-9", issue: 9, priority: 1, dependencies: [], claims: ["src/**/*.ts"],
        repository: "a/b", targetBranch: "main",
        status: "running", childRunIds: ["run_9"],
      }, {
        id: "issue-10", issue: 10, priority: 2, dependencies: [], claims: ["src/foo.ts"],
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

  it("atomically rejects a fresh DAG that overlaps an active generated batch", async () => {
    const root = mkdtempSync(join(process.env.TEMP ?? process.env.TMP ?? ".", "forgedock-sqlite-orchestration-conflict-"));
    const path = join(root, "state.db");
    const store = new SqliteRepositories(path);
    const active: OrchestrationRecord = {
      schema: "forgedock.orchestration/v1",
      orchestrationId: "dag_batch",
      repository: "a/b",
      requestedIssueNumbers: [7, 8],
      issueNumbers: [7, 8],
      maxParallel: 1,
      autoMerge: true,
      status: "running",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      nodes: [{ id: "issue-900", issue: 900, priority: 1, dependencies: [], claims: [], status: "running", childRunIds: [], memberIssues: [7, 8] }],
    };
    try {
      await store.createOrchestration(active);
      await assert.rejects(
        store.createOrchestration({ ...active, orchestrationId: "dag_duplicate", requestedIssueNumbers: [8], issueNumbers: [8], nodes: [{ ...active.nodes[0]!, id: "issue-8", issue: 8, memberIssues: [8] }] }),
        (error: unknown) => error instanceof OrchestrationIssueOwnershipConflictError
          && /#8.*dag_batch/.test(error.message),
      );
      const readOnly = new SqliteRepositories(path, { readOnly: true });
      try {
        assert.equal((await readOnly.listRunningOrchestrations())[0]?.orchestrationId, "dag_batch");
      } finally {
        readOnly.close();
      }
    } finally {
      store.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("atomically qualifies mixed-repository DAG ownership without same-number false positives", async () => {
    const store = new SqliteRepositories(":memory:");
    const mixed: OrchestrationRecord = {
      schema: "forgedock.orchestration/v1",
      orchestrationId: "dag_mixed",
      repository: "owner/control",
      requestedIssueNumbers: [1],
      issueNumbers: [1],
      maxParallel: 1,
      autoMerge: true,
      status: "running",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      nodes: [{
        id: "remote-7",
        repository: "owner/work",
        issue: 7,
        priority: 1,
        dependencies: [],
        claims: [],
        status: "running",
        childRunIds: [],
      }],
    };
    const proposal = (orchestrationId: string, repository: string, issue: number): OrchestrationRecord => ({
      ...mixed,
      orchestrationId,
      repository,
      requestedIssueNumbers: [issue],
      issueNumbers: [issue],
      nodes: [{ ...mixed.nodes[0]!, id: `${repository}-${issue}`, repository, issue }],
    });
    try {
      await store.createOrchestration(mixed);
      await assert.rejects(
        store.createOrchestration(proposal("dag_remote_duplicate", "OWNER/WORK", 7)),
        /owner\/work#7.*dag_mixed/,
      );
      await assert.doesNotReject(store.createOrchestration(proposal("dag_root_same_number", "owner/control", 7)));
    } finally {
      store.close();
    }
  });

  it("atomically rejects a running DAG update that acquires another DAG's issue", async () => {
    const store = new SqliteRepositories(":memory:");
    const parent: OrchestrationRecord = {
      schema: "forgedock.orchestration/v1",
      orchestrationId: "dag_parent",
      repository: "owner/control",
      requestedIssueNumbers: [1],
      issueNumbers: [1],
      maxParallel: 1,
      autoMerge: true,
      status: "running",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      nodes: [{
        id: "issue-1",
        repository: "owner/work",
        issue: 1,
        priority: 1,
        dependencies: [],
        claims: [],
        status: "skipped",
        childRunIds: [],
      }],
    };
    const childOwner: OrchestrationRecord = {
      ...parent,
      orchestrationId: "dag_child_owner",
      repository: "owner/work",
      requestedIssueNumbers: [2],
      issueNumbers: [2],
      nodes: [{ ...parent.nodes[0]!, id: "issue-2", issue: 2, status: "running" }],
    };
    try {
      await store.createOrchestration(parent);
      await store.createOrchestration(childOwner);
      const expanded: OrchestrationRecord = {
        ...parent,
        nodes: [{
          ...parent.nodes[0]!,
          attempts: [{
            attemptId: "attempt-decomposed",
            attempt: 1,
            recovery: "initial",
            status: "skipped",
            startedAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:01.000Z",
            completedAt: "2026-01-01T00:00:01.000Z",
            decompositionChildren: [2],
          }],
        }],
      };
      await assert.rejects(store.saveOrchestration(expanded), /#2.*dag_child_owner/);
      assert.deepEqual((await store.loadOrchestration("dag_parent"))?.nodes[0]?.attempts, undefined);
    } finally {
      store.close();
    }
  });

  it("atomically fences orchestration saves to the current lease and claim identity", async () => {
    const store = new SqliteRepositories(":memory:", { witness: new InMemoryLeaseWitness() });
    let now = 1_000;
    const admission = new LeaseBackedOrchestrationExecutionAdmission(store, {
      owner: "atomic-test",
      ttlMs: 100,
      heartbeatMs: 50,
      now: () => now,
    });
    const record: OrchestrationRecord = {
      schema: "forgedock.orchestration/v1",
      orchestrationId: "dag_atomic_fence",
      repository: "a/b",
      issueNumbers: [9],
      maxParallel: 1,
      autoMerge: true,
      status: "running",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      nodes: [{ id: "issue-9", issue: 9, priority: 1, dependencies: [], claims: [], status: "running", childRunIds: [] }],
    };
    try {
      await store.createOrchestration(record);
      const claim = await admission.acquire(record.orchestrationId);
      assert.ok(claim);
      const owned = { ...record, executionAttempt: 1, executionClaimId: claim.claimId, updatedAt: "2026-01-01T00:00:01.000Z" };
      assert.ok(claim.persist);
      await claim.persist(store, owned);
      now = 1_101;
      await assert.rejects(
        claim.persist(store, { ...owned, status: "completed", updatedAt: "2026-01-01T00:00:02.000Z" }),
        /expired|current/i,
      );
      assert.equal((await store.loadOrchestration(record.orchestrationId))?.status, "running");
      await claim.release();

      await assert.rejects(
        store.saveOrchestration({ ...owned, executionClaimId: "different-claim", status: "completed" }),
        /Conflicting orchestration claim/,
      );
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
      const recovered = { ...started.state, state: "building" as const, version: 0 };
      const persisted = await store.rebuildRun(recovered);
      assert.equal(persisted.state, "building");
      assert.equal(persisted.version, 1);
      assert.deepEqual(await store.load(queued.runId), persisted);
      assert.deepEqual((await store.history(queued.runId)).map((record) => record.event), ["START_INVESTIGATION"]);
      assert.deepEqual((await store.listProgress(queued.runId)).map(({ phase, message }) => ({ phase, message })), [{ phase: "controller.heartbeat", message: "stale" }]);
      const stale = transition(recovered, "RESUME_BUILD");
      await assert.rejects(store.commit(recovered.version, stale.state, stale.record), ConcurrentRunUpdateError);
      const resumed = transition(persisted, "RESUME_BUILD");
      await store.commit(persisted.version, resumed.state, resumed.record);
      assert.equal((await store.load(queued.runId))?.version, 2);
      assert.deepEqual((await store.history(queued.runId)).map((record) => record.event), ["START_INVESTIGATION", "RESUME_BUILD"]);
      assert.deepEqual((await store.listProgress(queued.runId)).map(({ phase, message }) => ({ phase, message })), [{ phase: "controller.heartbeat", message: "stale" }]);
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

  it("rejects expired mutation guards before another holder takes over", () => {
    const store = new SqliteRepositories(":memory:", { witness: new InMemoryLeaseWitness() });
    try {
      let now = 1_050;
      const lease = store.acquire("issue-guard", "worker-a", 100, 1_000);
      assert.ok(lease);
      const guard = store.guard("issue-guard", lease.token, () => now);

      assert.doesNotThrow(() => guard.assertValid());
      now = 1_100;
      assert.throws(() => guard.check(), /expired/i);
      assert.equal(store.inspect("issue-guard")?.token, lease.token, "guard expiry must retain takeover evidence");
      assert.equal(store.acquire("issue-guard", "worker-b", 100, now)?.owner, "worker-b");
    } finally {
      store.close();
    }
  });

  it("serializes continuity verification across a concurrent checkpoint advance", async () => {
    const root = mkdtempSync(join(process.env.TEMP ?? process.env.TMP ?? ".", "forgedock-lease-race-"));
    const path = join(root, "state.db");
    const checkpointPath = join(root, "checkpoint");
    const firstGo = join(root, "first.go");
    const secondGo = join(root, "second.go");
    const release = join(root, "release");
    writeFileSync(checkpointPath, "0");
    const childSource = [
      'const fs = require("node:fs");',
      'const [databasePath, checkpointPath, goPath, releasePath, role, moduleUrl] = process.argv.slice(1);',
      'const waitArray = new Int32Array(new SharedArrayBuffer(4));',
      'const snapshot = () => ({ state: "verified", epoch: Number(fs.readFileSync(checkpointPath, "utf8")) });',
      'const witness = {',
      '  verify: snapshot,',
      '  compareAndAdvance(observedEpoch) {',
      '    const epoch = Math.max(observedEpoch, snapshot().epoch) + 1;',
      '    fs.writeFileSync(checkpointPath, String(epoch));',
      '    if (role === "first") {',
      '      process.stdout.write("advanced\\n");',
      '      while (!fs.existsSync(releasePath)) Atomics.wait(waitArray, 0, 0, 10);',
      '    }',
      '    return snapshot();',
      '  },',
      '  reEnroll() { throw new Error("not used"); },',
      '};',
      'import(moduleUrl).then(({ SqliteRepositories }) => {',
      '  const store = new SqliteRepositories(databasePath, { witness });',
      '  process.stdout.write("ready\\n");',
      '  const timer = setInterval(() => {',
      '    if (!fs.existsSync(goPath)) return;',
      '    clearInterval(timer);',
      '    try {',
      '      const lease = store.acquire(`item-${role}`, `worker-${role}`, 60_000);',
      '      process.stdout.write(`${JSON.stringify({ ok: Boolean(lease), epoch: lease?.epoch })}\\n`);',
      '      store.close();',
      '    } catch (error) {',
      '      process.stdout.write(`${JSON.stringify({ ok: false, error: String(error) })}\\n`);',
      '      store.close();',
      '    }',
      '  }, 5);',
      '}).catch((error) => { process.stderr.write(String(error)); process.exitCode = 1; });',
    ].join("\n");
    const moduleUrl = new URL("./sqlite-repositories.js", import.meta.url).href;
    const start = (role: "first" | "second", goPath: string) => spawn(process.execPath, [
      "-e", childSource, path, checkpointPath, goPath, release, role, moduleUrl,
    ], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    const first = start("first", firstGo);
    const second = start("second", secondGo);
    try {
      await Promise.all([waitForChildOutput(first, "ready\n"), waitForChildOutput(second, "ready\n")]);
      writeFileSync(firstGo, "go");
      await waitForChildOutput(first, "advanced\n");
      writeFileSync(secondGo, "go");
      // Give the second process time to reach BEGIN IMMEDIATE while the first
      // has advanced the external checkpoint but not committed lease_state.
      const firstResultOutput = waitForChildOutput(first, "\n");
      const secondResultOutput = waitForChildOutput(second, "\n");
      await new Promise((resolve) => setTimeout(resolve, 100));
      writeFileSync(release, "release");
      const [firstResult, secondResult] = (await Promise.all([firstResultOutput, secondResultOutput]))
        .map((output) => JSON.parse(output.trim()) as { ok: boolean; epoch?: number; error?: string });
      assert.deepEqual(firstResult, { ok: true, epoch: 1 });
      assert.deepEqual(secondResult, { ok: true, epoch: 2 });
    } finally {
      writeFileSync(release, "release");
      first.kill();
      second.kill();
      rmSync(root, { recursive: true, force: true });
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

  it("idempotently adopts a witness checkpoint advanced by an interrupted re-enrollment", () => {
    const retained = new InMemoryLeaseWitness();
    let interruptAfterAdvance = true;
    const witness = {
      verify: () => retained.verify(),
      compareAndAdvance: (epoch: number) => retained.compareAndAdvance(epoch),
      reEnroll: (checkpoint: Parameters<typeof retained.reEnroll>[0]) => {
        const snapshot = retained.reEnroll(checkpoint);
        if (interruptAfterAdvance) {
          interruptAfterAdvance = false;
          throw new Error("simulated interruption after retained checkpoint advance");
        }
        return snapshot;
      },
    };
    const store = new SqliteRepositories(":memory:", { witness });
    const checkpoint = { epoch: 10, signature: Buffer.from("10:forgedock-test-retained-key", "utf8").toString("base64url") };
    try {
      assert.throws(() => store.reEnroll(checkpoint), /simulated interruption/);
      assert.equal(retained.verify().epoch, 10);
      assert.doesNotThrow(() => store.reEnroll(checkpoint));
      assert.equal(store.continuity().state, "verified");
      assert.equal(store.acquire("issue-recovered", "worker", 100, 1_000)?.epoch, 11);
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

  it("persists a monotonic per-PR review publication fence across instances", async () => {
    const root = mkdtempSync(join(process.env.TEMP ?? process.env.TMP ?? ".", "forgedock-review-fence-"));
    const path = join(root, "state.db");
    const first = new SqliteRepositories(path);
    const second = new SqliteRepositories(path);
    const route = {
      repo: "Owner/Repo", pullRequest: 9, runId: "run-old", headSha: "a".repeat(40),
      headBranch: "fix", baseBranch: "main",
    };
    try {
      const older = await first.beginReviewFindingPublication(route);
      await second.assertReviewFindingPublication(older);
      const newer = await second.beginReviewFindingPublication({ ...route, runId: "run-new", headSha: "b".repeat(40) });
      assert.equal(newer.generation, older.generation + 1);
      await assert.rejects(first.assertReviewFindingPublication(older), /publication fence is stale/);
      await first.assertReviewFindingPublication(newer);
    } finally {
      first.close();
      second.close();
      try { rmSync(root, { recursive: true, force: true }); } catch { /* Windows may release SQLite handles shortly after close. */ }
    }
  });

  it("purges only an exact repository manifest, refuses active leases, and preserves lease state", async () => {
    const store = new SqliteRepositories(":memory:", { witness: new InMemoryLeaseWitness() });
    try {
      const target = createRun({ workflow: "work-on", subject: { repo: "a/b", issue: 91 }, runId: "run-purge-target" });
      const unrelated = createRun({ workflow: "work-on", subject: { repo: "a/b", issue: 92 }, runId: "run-purge-unrelated" });
      const artifact = createArtifact({
        kind: "Intent", runId: target.runId, subject: target.subject,
        producer: { role: "controller" },
        payload: { title: "Purge", problem: "Purge", constraints: [], acceptanceHints: [], dependencies: [] },
      });
      await store.create(target);
      await store.create(unrelated);
      await store.append(artifact);
      const next = transition(target, "START_INVESTIGATION");
      await store.commit(target.version, next.state, next.record);
      await store.recordProgress({ runId: target.runId, phase: "purge-test", message: "child row", occurredAt: "2026-01-01T00:00:00.000Z" });
      const lease = store.acquire(target.runId, "purge-test", 100, 1_000);
      assert.ok(lease);
      const manifest = { runs: [{ runId: target.runId }], artifacts: [{ artifactId: artifact.id, subjectKey: "a/b|i:91|p:", kind: "Intent" as const }], leases: [{ itemId: target.runId }] };
      await assert.rejects(store.purgeExactManifest({ ...manifest, artifacts: [{ ...manifest.artifacts[0]!, subjectKey: "a/b|i:999|p:" }] }), /identity mismatch/);
      await assert.rejects(store.purgeExactManifest(manifest, 1_050), /active lease/);
      assert.equal((await store.load(target.runId))?.runId, target.runId);
      const purged = await store.purgeExactManifest(manifest, 1_101);
      assert.deepEqual(purged, { runs: 1, artifacts: 1, orchestrations: 0, promotions: 0, telemetry: 0, remediationAdmissions: 0, reviewFindingFences: 0, leases: 1 });
      assert.equal(await store.load(target.runId), undefined);
      assert.deepEqual(await store.history(target.runId), []);
      assert.deepEqual(await store.listProgress(target.runId), []);
      assert.equal((await store.load(unrelated.runId))?.runId, unrelated.runId);
      assert.equal(store.acquire("lease-state-check", "purge-test", 100, 1_101)?.epoch, 2, "purge must not reset lease_state");
    } finally {
      store.close();
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
