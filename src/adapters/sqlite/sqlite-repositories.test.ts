import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createArtifact } from "../../core/artifacts/schema.js";
import { ConcurrentRunUpdateError } from "../../core/ports/repositories.js";
import type { AgentRunReceipt } from "../../core/ports/telemetry.js";
import { createRun, transition } from "../../core/state/machine.js";
import { SqliteRepositories } from "./sqlite-repositories.js";

describe("SQLite operational repositories", () => {
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
      store.rebuildRun({ ...queued, state: "building" });
      assert.equal((await store.load(queued.runId))?.state, "building");
      assert.deepEqual(await store.history(queued.runId), []);
      assert.deepEqual(await store.listProgress(queued.runId), []);
    } finally {
      store.close();
    }
  });

  it("persists cross-process-style leases with stale recovery", () => {
    const store = new SqliteRepositories(":memory:");
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
