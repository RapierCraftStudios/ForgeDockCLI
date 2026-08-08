import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import { createArtifact } from "../../core/artifacts/schema.js";
import { ConcurrentRunUpdateError } from "../../core/ports/repositories.js";
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

  it("rebuilds divergent operational run state from durable authority", async () => {
    const store = new SqliteRepositories(":memory:");
    try {
      const queued = createRun({ workflow: "work-on", subject: { repo: "a/b", issue: 1 }, runId: "run_rebuild" });
      await store.create(queued);
      const started = transition(queued, "START_INVESTIGATION");
      await store.commit(queued.version, started.state, started.record);
      store.rebuildRun({ ...queued, state: "building" });
      assert.equal((await store.load(queued.runId))?.state, "building");
      assert.deepEqual(await store.history(queued.runId), []);
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

  it("waits for a concurrent opener and rechecks the migration marker", async () => {
    const directory = mkdtempSync(join(tmpdir(), "forgedock-sqlite-"));
    const path = join(directory, "concurrent.sqlite");
    const fixture = new DatabaseSync(path);
    const moduleUrl = new URL("./sqlite-repositories.js", import.meta.url).href;
    const script = `
      const { SqliteRepositories } = await import(${JSON.stringify(moduleUrl)});
      console.log("ready");
      const repository = new SqliteRepositories(process.argv[1]);
      repository.close();
    `;
    const children: Array<{
      ready: Promise<void>;
      done: Promise<{ code: number | null; stderr: string }>;
    }> = [];

    try {
      fixture.exec("CREATE TABLE artifacts (artifact_id TEXT PRIMARY KEY, subject_key TEXT NOT NULL, kind TEXT NOT NULL, artifact_json TEXT NOT NULL);");
      fixture.prepare("INSERT INTO artifacts VALUES (?, ?, ?, ?)").run("legacy", "legacy-key", "Intent", JSON.stringify({ subject: { repo: "acme/widget", issue: 1 } }));
      fixture.exec("BEGIN IMMEDIATE");

      for (let index = 0; index < 2; index += 1) {
        const child = spawn(process.execPath, ["--input-type=module", "-e", script, path], { stdio: ["ignore", "pipe", "pipe"] });
        let output = "";
        let stderr = "";
        const ready = new Promise<void>((resolve, reject) => {
          child.stdout.on("data", (chunk: Buffer) => {
            output += chunk.toString();
            if (output.includes("ready")) resolve();
          });
          child.once("error", reject);
        });
        const done = new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
          child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
          child.once("error", reject);
          child.once("close", (code) => resolve({ code, stderr }));
        });
        children.push({ ready, done });
      }
      await Promise.all(children.map((child) => child.ready));
      fixture.exec("COMMIT");
      const results = await Promise.all(children.map((child) => child.done));
      assert.deepEqual(results.map((result) => result.code), [0, 0]);
      assert.equal(results.some((result) => /SQLITE_BUSY|database is locked/i.test(result.stderr)), false);
    } finally {
      try { fixture.close(); } catch { /* already closed */ }
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
