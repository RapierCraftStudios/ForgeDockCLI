// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { test } from "node:test";
import { createArtifact } from "../artifacts/schema.js";
import { createRun, transition } from "../state/machine.js";
import { InMemoryArtifactRepository, InMemoryRunRepository, ProjectedRunRepository } from "./repositories.js";

test("matches canonical subjects by forge and issue/PR overlap while filtering kind", async () => {
  const repository = new InMemoryArtifactRepository();
  const makeIntent = (id: string, subject: { forge?: string; repo: string; issue?: number; pr?: number }) => createArtifact({
    kind: "Intent", runId: id, subject, producer: { role: "test" },
    payload: { title: id, problem: "test", constraints: [], acceptanceHints: [], dependencies: [] },
  }, { id });
  const makeInvestigation = (id: string, subject: { forge?: string; repo: string; issue?: number; pr?: number }) => createArtifact({
    kind: "Investigation", runId: id, subject, producer: { role: "test" },
    payload: { outcome: "confirmed", confidence: "high", summary: id, evidence: [{ claim: "claim", source: "test", detail: "detail" }], affectedSurfaces: [], risks: [], recommendation: "test" },
  }, { id });
  await repository.append(makeIntent("issue", { repo: "A/B", issue: 2 }));
  await repository.append(makeIntent("pull", { repo: "a/b", pr: 3 }));
  await repository.append(makeInvestigation("other-kind", { repo: "a/b", issue: 2, pr: 3 }));
  await repository.append(makeIntent("other-forge", { forge: "forge.example", repo: "a/b", issue: 2 }));
  assert.deepEqual((await repository.list({ forge: "github.com.", repo: " a/b ", issue: 2, pr: 3 })).map((artifact) => artifact.id), ["issue", "pull", "other-kind"]);
  assert.deepEqual((await repository.list({ repo: "a/b", issue: 2 }, "Intent")).map((artifact) => artifact.id), ["issue"]);
});

test("run-state projection follows every committed typed transition without owning authority", async () => {
  const inner = new InMemoryRunRepository();
  const projected: string[] = [];
  const runs = new ProjectedRunRepository(inner, async (state) => { projected.push(state.state); });
  const queued = createRun({ workflow: "work-on", subject: { repo: "acme/widget", issue: 7 } });
  await runs.create(queued);
  const investigating = transition(queued, "START_INVESTIGATION");
  await runs.commit(queued.version, investigating.state, investigating.record);
  assert.deepEqual(projected, ["queued", "investigating"]);
  assert.equal((await inner.load(queued.runId))?.state, "investigating");
});

test("run progress is durable and separate from state-machine versions", async () => {
  const runs = new InMemoryRunRepository();
  const queued = createRun({ workflow: "work-on", subject: { repo: "acme/widget", issue: 10 } });
  await runs.create(queued);
  await runs.recordProgress({ runId: queued.runId, phase: "session.started", message: "Agent session started", occurredAt: "2026-01-01T00:00:00.000Z" });
  await runs.recordProgress({ runId: queued.runId, phase: "controller.heartbeat", message: "Lease renewed", occurredAt: "2026-01-01T00:00:01.000Z" });
  assert.equal((await runs.load(queued.runId))?.version, queued.version);
  assert.deepEqual(await runs.listProgress(queued.runId), [
    { runId: queued.runId, phase: "session.started", message: "Agent session started", occurredAt: "2026-01-01T00:00:00.000Z" },
    { runId: queued.runId, phase: "controller.heartbeat", message: "Lease renewed", occurredAt: "2026-01-01T00:00:01.000Z" },
  ]);
});

test("projection retries transient external-view failures before reporting them", async () => {
  const inner = new InMemoryRunRepository();
  let attempts = 0;
  const projected: string[] = [];
  const runs = new ProjectedRunRepository(inner, async (state) => {
    attempts += 1;
    if (attempts < 3) throw new Error("GitHub temporarily unavailable");
    projected.push(state.state);
  });
  const queued = createRun({ workflow: "work-on", subject: { repo: "acme/widget", issue: 9 } });
  await runs.create(queued);
  assert.equal(attempts, 3);
  assert.deepEqual(projected, ["queued"]);
});

test("projection failure does not roll back authoritative run state", async () => {
  const inner = new InMemoryRunRepository();
  const failures: string[] = [];
  const runs = new ProjectedRunRepository(
    inner,
    async () => { throw new Error("GitHub unavailable"); },
    (error) => failures.push(error instanceof Error ? error.message : String(error)),
  );
  const queued = createRun({ workflow: "work-on", subject: { repo: "acme/widget", issue: 8 } });
  await runs.create(queued);
  assert.equal((await inner.load(queued.runId))?.state, "queued");
  assert.deepEqual(failures, ["GitHub unavailable"]);
});
