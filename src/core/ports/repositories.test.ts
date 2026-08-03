// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { test } from "node:test";
import { createRun, transition } from "../state/machine.js";
import { InMemoryRunRepository, ProjectedRunRepository } from "./repositories.js";

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
