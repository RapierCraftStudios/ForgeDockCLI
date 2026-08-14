// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createAgentEventObservationSink } from "./adapters.js";
import { ForgeDockObservationControlGateway } from "./control-gateway.js";
import { createObservationProducer, sanitizeTerminalText } from "./contracts.js";
import { ForgeDockObserver } from "./observer.js";
import { SqliteObservationStore } from "./sqlite-store.js";
import { DEFAULT_WORKSPACE_LAYOUT } from "./workspace-layout.js";

const producer = createObservationProducer("observer-test", 1);

function observerWithStore(store = new SqliteObservationStore(":memory:")): ForgeDockObserver {
  return new ForgeDockObserver({ store, producer });
}

test("journal assigns per-run sequences, preserves channels, and redacts sensitive payloads", async () => {
  const observer = observerWithStore();
  await observer.emit({
    producer,
    identity: { forgeRunId: "run-1", agentTaskId: "task-1" },
    source: "controller",
    channel: "lifecycle",
    kind: "controller.started",
    payload: { token: "super-secret", message: "started" },
  });
  await observer.emit({
    producer,
    identity: { forgeRunId: "run-1", agentTaskId: "task-1" },
    source: "controller",
    channel: "stderr",
    kind: "output.stderr",
    payload: { bytes: 12 },
    output: { channel: "stderr", text: "warning", chunkSequence: 1 },
  });
  const events = await observer.query({ forgeRunId: "run-1" });
  assert.deepEqual(events.map((event) => event.runSequence), [1, 2]);
  assert.equal(events[0]?.security.redacted, true);
  assert.deepEqual((events[0]?.payload as { token?: string }).token, "[REDACTED]");
  assert.equal(events[1]?.output?.channel, "stderr");
  assert.equal(events[1]?.output?.text, "warning");
  observer.close();
});

test("observer backpressure emits an explicit dropped-output marker", async () => {
  const options = { store: new SqliteObservationStore(":memory:"), producer, maxQueueDepth: 1 };
  const observer = new ForgeDockObserver(options);
  const first = observer.emit({ producer, identity: { forgeRunId: "run-pressure" }, source: "process", channel: "stdout", kind: "output.stdout", payload: {}, output: { channel: "stdout", text: "first" } });
  const dropped = observer.emit({ producer, identity: { forgeRunId: "run-pressure" }, source: "process", channel: "stdout", kind: "output.stdout", payload: {}, output: { channel: "stdout", text: "dropped" } });
  await Promise.all([first, dropped]);
  const events = await observer.query({ forgeRunId: "run-pressure" });
  assert.equal(events.at(-1)?.kind, "output.dropped");
  assert.equal(events.at(-1)?.delivery.droppedEvents, 1);
  observer.close();
});

test("journal hydrates projections after observer restart", async () => {
  const root = mkdtempSync(join(tmpdir(), "forgedock-observer-test-"));
  const path = join(root, "observations.db");
  const first = new ForgeDockObserver({ store: new SqliteObservationStore(path), producer });
  await first.emit({
    producer,
    identity: { forgeRunId: "run-restart", workUnitId: "unit-1", issueNumber: 68 },
    source: "workflow",
    channel: "lifecycle",
    kind: "workflow.state.changed",
    payload: { phase: "building", state: "building", label: "#68 implementation" },
  });
  await first.emit({
    producer,
    identity: { forgeRunId: "run-restart", workUnitId: "unit-1", issueNumber: 68 },
    source: "workflow",
    channel: "decision",
    kind: "attention.created",
    severity: "warning",
    payload: { attentionId: "attention-1", level: "action-required", reason: "Resume checkpoint" },
  });
  await first.flush();
  first.close();

  const second = new ForgeDockObserver({ store: new SqliteObservationStore(path), producer });
  await second.hydrate({ forgeRunId: "run-restart" });
  const snapshot = second.snapshot();
  assert.equal(snapshot.entities[0]?.workflow.state, "building");
  assert.equal(snapshot.attention[0]?.reason, "Resume checkpoint");
  second.close();
  rmSync(root, { recursive: true, force: true });
});

test("agent adapter preserves user-visible events but discards private thinking text", async () => {
  const observer = observerWithStore();
  const sink = createAgentEventObservationSink(observer, { identity: { forgeRunId: "run-agent" }, producer });
  sink({ type: "session.started", taskId: "agent-1", sessionRef: "pi-1", provider: "test", model: "model" });
  sink({ type: "thinking.delta", taskId: "agent-1", text: "private chain of thought" });
  sink({ type: "text.delta", taskId: "agent-1", text: "visible progress" });
  sink({ type: "tool.started", taskId: "agent-1", toolCallId: "call-1", tool: "read", args: { path: "src/a.ts", secret: "hide" } });
  await observer.flush();
  const events = await observer.query({ forgeRunId: "run-agent" });
  assert.equal(events.some((event) => JSON.stringify(event.payload).includes("private chain")), false);
  assert.equal(events.some((event) => JSON.stringify(event.payload).includes("visible progress")), true);
  const tool = events.find((event) => event.kind === "tool.started");
  assert.deepEqual((tool?.payload as { args?: Record<string, unknown> }).args, { path: "src/a.ts" });
  observer.close();
});

test("workspace layouts survive observer restart in the operational journal", async () => {
  const root = mkdtempSync(join(tmpdir(), "forgedock-layout-test-"));
  const path = join(root, "observations.db");
  const first = new ForgeDockObserver({ store: new SqliteObservationStore(path), producer });
  const layout = { ...DEFAULT_WORKSPACE_LAYOUT, name: "Review", updatedAt: "2026-01-01T00:00:00.000Z" };
  await first.saveLayout(layout);
  first.close();

  const second = new ForgeDockObserver({ store: new SqliteObservationStore(path), producer });
  assert.deepEqual(await second.loadLayout("default"), layout);
  second.close();
  rmSync(root, { recursive: true, force: true });
});

test("terminal sanitization removes executable control sequences while preserving text", () => {
  const value = sanitizeTerminalText("\u001b]8;;https://example.test\u0007visible\u001b]8;;\u0007\u001b[31m warning");
  assert.equal(value, "visible warning");
});

test("control gateway records rejection without mutating state when no adapter exists", async () => {
  const observer = observerWithStore();
  const gateway = new ForgeDockObservationControlGateway(observer);
  const receipt = await gateway.cancelRun({ identity: { forgeRunId: "run-control" }, actor: "test", confirmation: "confirmed" });
  assert.equal(receipt.accepted, false);
  assert.match(receipt.message, /adapter/);
  const events = await observer.query({ forgeRunId: "run-control" });
  assert.deepEqual(events.map((event) => event.kind), ["control.requested", "control.rejected"]);
  observer.close();
});
