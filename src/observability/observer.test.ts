// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { observeAgentEvent, setAgentEventObservationIdentity, setAgentEventObservationSink } from "../cli/agent-event-stream.js";
import { BackgroundTaskObservationAdapter, createAgentEventObservationSink } from "./adapters.js";
import { ForgeDockObservationControlGateway } from "./control-gateway.js";
import { createObservationProducer, createStreamingObservationText, observationStreamKey, retainObservationLogicalStreamId, sanitizeTerminalText, type ObservationEnvelopeV1, type ObservationDraft, type ObservationIdentity, type ObservationSink } from "./contracts.js";
import { ForgeDockObserver } from "./observer.js";
import { SqliteObservationStore } from "./sqlite-store.js";
import { DEFAULT_WORKSPACE_LAYOUT } from "./workspace-layout.js";

const producer = createObservationProducer("observer-test", 1);

function observerWithStore(store = new SqliteObservationStore(":memory:")): ForgeDockObserver {
  return new ForgeDockObserver({ store, producer });
}

function runNodeModule(source: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "--eval", source], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`Observation subprocess exited ${code}: ${stderr}`)));
  });
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

test("controller-task queries follow a cross-process cursor without replay", async () => {
  const root = mkdtempSync(join(tmpdir(), "forgedock-observer-cursor-"));
  const path = join(root, "observations.db");
  const store = new SqliteObservationStore(path);
  const initial = await store.append({
    producer,
    identity: { forgeRunId: "run-parent", controllerTaskId: "controller-a" },
    source: "workflow",
    channel: "activity",
    kind: "workflow.progress",
    payload: { phase: "started" },
  });
  const moduleUrl = new URL("./sqlite-store.js", import.meta.url).href;
  await runNodeModule(`
    import { SqliteObservationStore } from ${JSON.stringify(moduleUrl)};
    const store = new SqliteObservationStore(${JSON.stringify(path)});
    const producer = { component: "cursor-child", processInstanceId: "cursor-child:1", pid: process.pid };
    await store.append({ producer, identity: { forgeRunId: "run-child", controllerTaskId: "controller-b" }, source: "workflow", channel: "activity", kind: "workflow.progress", payload: { phase: "unrelated" } });
    await store.append({ producer, identity: { forgeRunId: "run-child", controllerTaskId: "controller-a" }, source: "agent", channel: "tool", kind: "tool.progress", payload: { tool: "test" } });
    store.close();
  `);

  const fresh = await store.query({ controllerTaskId: "controller-a", cursor: initial.eventId });
  assert.deepEqual(fresh.map((event) => event.kind), ["tool.progress"]);
  assert.equal(fresh[0]?.identity.forgeRunId, "run-child");
  assert.deepEqual(await store.query({ controllerTaskId: "controller-a", cursor: fresh[0]!.eventId }), []);
  await assert.rejects(store.query({ controllerTaskId: "controller-a", cursor: "missing-event" }), /Unknown observation cursor/);
  store.close();
  const database = new DatabaseSync(path);
  const indexes = database.prepare("PRAGMA index_list(observation_events)").all() as Array<{ name: string }>;
  assert.equal(indexes.some((index) => index.name === "observation_events_controller_task"), true);
  database.close();
  rmSync(root, { recursive: true, force: true });
});

test("observation cursors survive retention and do not exhaust later queries", async () => {
  const store = new SqliteObservationStore(":memory:");
  const identity = { forgeRunId: "run-retained-cursor", controllerTaskId: "controller-retained" };
  const first = await store.append({
    producer,
    identity,
    source: "workflow",
    channel: "activity",
    kind: "workflow.progress",
    payload: { phase: "first" },
  });

  await store.prune(undefined, { maxEventsPerScope: 0 });
  assert.deepEqual(await store.query({ controllerTaskId: identity.controllerTaskId, cursor: first.eventId }), []);

  const second = await store.append({
    producer,
    identity,
    source: "workflow",
    channel: "activity",
    kind: "workflow.progress",
    payload: { phase: "second" },
  });
  assert.deepEqual(
    (await store.query({ controllerTaskId: identity.controllerTaskId, cursor: first.eventId })).map((event) => event.eventId),
    [second.eventId],
  );

  await store.prune(undefined, { maxEventsPerScope: 0 });
  const third = await store.append({
    producer,
    identity,
    source: "workflow",
    channel: "activity",
    kind: "workflow.progress",
    payload: { phase: "third" },
  });
  assert.deepEqual(
    (await store.query({ controllerTaskId: identity.controllerTaskId, cursor: second.eventId })).map((event) => event.eventId),
    [third.eventId],
  );
  store.close();
});

test("observer backpressure emits an explicit dropped-output marker", async () => {
  const options = { store: new SqliteObservationStore(":memory:"), producer, maxQueueDepth: 1 };
  const observer = new ForgeDockObserver(options);
  const identity = { forgeRunId: "run-pressure" };
  const first = observer.emit({ producer, identity, source: "process", channel: "stdout", kind: "output.stdout", payload: {}, output: { channel: "stdout", text: "first" } });
  const dropped = observer.emit({ producer, identity, source: "process", channel: "stdout", kind: "output.stdout", payload: {}, output: { channel: "stdout", text: "dropped" } });
  await Promise.all([first, dropped]);
  const events = await observer.query({ forgeRunId: "run-pressure" });
  assert.equal(events.at(-1)?.kind, "output.dropped");
  assert.equal(events.at(-1)?.delivery.droppedEvents, 1);
  observer.close();
});

test("logical stream IDs are collision-free and survive identity enrichment in SQLite", async () => {
  const first = { logicalStreamId: "stream|one", forgeRunId: "run", agentTaskId: "shared" };
  const refreshed = { ...first, workUnitId: "unit|enriched" };
  const second = { logicalStreamId: "stream|two", forgeRunId: "run", agentTaskId: "shared" };
  assert.equal(observationStreamKey(first, "stdout"), observationStreamKey(refreshed, "stdout"));
  assert.notEqual(observationStreamKey(first, "stdout"), observationStreamKey(second, "stdout"));
  assert.notEqual(observationStreamKey({ logicalStreamId: "stream|one" }, "stdout"), observationStreamKey({ logicalStreamId: "stream|one" }, "stderr"));

  const retained = {};
  const allocated = retainObservationLogicalStreamId(retained);
  assert.ok(allocated.logicalStreamId);
  assert.equal(retainObservationLogicalStreamId(retained).logicalStreamId, allocated.logicalStreamId);

  const store = new SqliteObservationStore(":memory:");
  const observer = observerWithStore(store);
  await observer.emit({ producer, identity: first, source: "agent", channel: "activity", kind: "output.delta", payload: { text: "visible" }, output: { channel: "stdout", text: "visible", chunkSequence: 1 } });
  const event = (await observer.query({}))[0];
  assert.equal(event?.identity.logicalStreamId, "stream|one");
  observer.close();
});

test("identity refresh cannot release one quarantined stream or reset its neighbor", async () => {
  const observer = new ForgeDockObserver({ store: new SqliteObservationStore(":memory:"), producer, maxQueueDepth: 1 });
  const firstIdentity = { forgeRunId: "run-interleaved", logicalStreamId: "stream|one", controllerTaskId: "shared" };
  const secondIdentity = { forgeRunId: "run-interleaved", logicalStreamId: "stream|two", controllerTaskId: "shared" };
  const first = observer.emit({ producer, identity: firstIdentity, source: "process", channel: "stdout", kind: "output.stdout", payload: {}, output: { channel: "stdout", text: "first" } });
  const dropped = observer.emit({ producer, identity: firstIdentity, source: "process", channel: "stdout", kind: "output.stdout", payload: {}, output: { channel: "stdout", text: "dropped-secret" } });
  await Promise.all([first, dropped]);
  await observer.emit({ producer, identity: { ...firstIdentity, workUnitId: "refreshed" }, source: "process", channel: "stdout", kind: "output.stdout", payload: {}, output: { channel: "stdout", text: "continuation-secret" } });
  await observer.emit({ producer, identity: secondIdentity, source: "process", channel: "stdout", kind: "output.stdout", payload: {}, output: { channel: "stdout", text: "independent" } });
  await observer.emit({ producer, identity: secondIdentity, source: "process", channel: "lifecycle", kind: "process.exited", payload: { status: "completed" } });
  const events = await observer.query({ forgeRunId: "run-interleaved" });
  const serialized = JSON.stringify(events);
  assert.doesNotMatch(serialized, /dropped-secret|continuation-secret/);
  assert.match(serialized, /independent/);
  observer.close();
});

test("direct output retains a no-ID stream through enrichment, reset, and terminal cleanup", async () => {
  const observer = new ForgeDockObserver({ store: new SqliteObservationStore(":memory:"), producer, maxQueueDepth: 1 });
  const retainedIdentity: ObservationIdentity = { forgeRunId: "run-direct-retained", controllerTaskId: "shared" };
  const independentIdentity = { forgeRunId: "run-direct-retained", controllerTaskId: "shared" };
  const first = observer.emit({ producer, identity: retainedIdentity, source: "process", channel: "stdout", kind: "output.stdout", payload: {}, output: { channel: "stdout", text: "first" } });
  const dropped = observer.emit({ producer, identity: retainedIdentity, source: "process", channel: "stdout", kind: "output.stdout", payload: {}, output: { channel: "stdout", text: "dropped-raw" } });
  const marker = await dropped;
  await first;
  assert.equal(marker.kind, "output.dropped");
  assert.equal(marker.delivery.droppedEvents, 1);
  assert.ok(retainedIdentity.logicalStreamId);

  retainedIdentity.workUnitId = "enriched";
  await observer.emit({ producer, identity: retainedIdentity, source: "process", channel: "stdout", kind: "output.stdout", payload: {}, output: { channel: "stdout", text: "continuation-raw" } });
  await observer.emit({ producer, identity: independentIdentity, source: "process", channel: "stdout", kind: "output.stdout", payload: {}, output: { channel: "stdout", text: "independent-visible" } });
  await observer.emit({ producer, identity: retainedIdentity, source: "process", channel: "lifecycle", kind: "process.exited", payload: { status: "completed" } });
  await observer.emit({ producer, identity: independentIdentity, source: "process", channel: "lifecycle", kind: "process.exited", payload: { status: "completed" } });
  await observer.emit({ producer, identity: retainedIdentity, source: "process", channel: "stdout", kind: "output.stdout", payload: {}, output: { channel: "stdout", text: "after-reset-visible" } });
  await observer.emit({ producer, identity: independentIdentity, source: "process", channel: "stdout", kind: "output.stdout", payload: {}, output: { channel: "stdout", text: "after-terminal-visible" } });
  await observer.flush();

  const events = await observer.query({ forgeRunId: "run-direct-retained" });
  const serialized = JSON.stringify(events);
  assert.equal(events.filter((event) => event.kind === "output.dropped").length, 1);
  assert.doesNotMatch(serialized, /dropped-raw|continuation-raw/);
  assert.match(serialized, /independent-visible|after-reset-visible|after-terminal-visible/);
  observer.close();
});

test("output without a retainable identity is rejected before queueing or storage", async () => {
  const observer = observerWithStore();
  const draft = { producer, source: "process" as const, channel: "stdout" as const, kind: "output.stdout", payload: {}, output: { channel: "stdout" as const, text: "must-not-persist" } };
  await assert.rejects(observer.emit(draft), /retainable identity/);
  await assert.rejects(observer.emit({ ...draft, identity: Object.freeze({ forgeRunId: "frozen" }) }), /mutable/);
  await observer.emit({ producer, source: "process", channel: "lifecycle", kind: "process.started", payload: {} });
  const events = await observer.query({});
  assert.equal(events.length, 1);
  assert.throws(() => observationStreamKey({}, "stdout"), /logicalStreamId/);
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
  sink({ type: "session.started", logicalStreamId: "stream-agent-1", taskId: "agent-1", sessionRef: "pi-1", provider: "test", model: "model" });
  sink({ type: "thinking.delta", logicalStreamId: "stream-agent-1", taskId: "agent-1", text: "private chain of thought" });
  sink({ type: "text.delta", logicalStreamId: "stream-agent-1", taskId: "agent-1", text: "visible progress" });
  sink({ type: "tool.started", logicalStreamId: "stream-agent-1", taskId: "agent-1", toolCallId: "call-1", tool: "read", args: { path: "src/a.ts", secret: "hide" } });
  await observer.flush();
  const events = await observer.query({ forgeRunId: "run-agent" });
  assert.equal(events.some((event) => JSON.stringify(event.payload).includes("private chain")), false);
  assert.equal(events.some((event) => JSON.stringify(event.payload).includes("visible progress")), true);
  const tool = events.find((event) => event.kind === "tool.started");
  assert.deepEqual((tool?.payload as { args?: Record<string, unknown> }).args, { path: "src/a.ts" });
  observer.close();
});

test("agent adapter isolates concurrent sessions that reuse one task ID", async () => {
  const observer = observerWithStore();
  const sink = createAgentEventObservationSink(observer, { identity: { forgeRunId: "run-agent-concurrent" }, producer });
  sink({ type: "session.started", logicalStreamId: "stream-one", taskId: "shared-task", sessionRef: "session-one", provider: "test", model: "model" });
  sink({ type: "text.delta", logicalStreamId: "stream-one", taskId: "shared-task", text: "Bearer first-" });
  sink({ type: "session.started", logicalStreamId: "stream-two", taskId: "shared-task", sessionRef: "session-two", provider: "test", model: "model" });
  sink({ type: "text.delta", logicalStreamId: "stream-two", taskId: "shared-task", text: "second visible" });
  sink({ type: "session.completed", logicalStreamId: "stream-one", taskId: "shared-task", sessionRef: "session-one" });
  sink({ type: "session.completed", logicalStreamId: "stream-two", taskId: "shared-task", sessionRef: "session-two" });
  await observer.flush();

  const events = await observer.query({ forgeRunId: "run-agent-concurrent" });
  const lifecycle = events.filter((event) => event.kind === "agent.session.started" || event.kind === "agent.session.completed");
  assert.equal(new Set(lifecycle.map((event) => event.identity.logicalStreamId)).size, 2);
  const outputs = events.filter((event) => event.kind === "output.delta");
  assert.equal(outputs.length, 2);
  assert.equal(new Set(outputs.map((event) => event.identity.logicalStreamId)).size, 2);
  assert.match(JSON.stringify(outputs), /\[REDACTED\]/);
  assert.match(JSON.stringify(outputs), /second visible/);
  observer.close();
});

test("agent adapter preserves failed and cancelled terminal semantics", async () => {
  const observer = observerWithStore();
  const sink = createAgentEventObservationSink(observer, { identity: { forgeRunId: "run-terminal" }, producer });
  sink({ type: "session.failed", logicalStreamId: "stream-failed", taskId: "agent-failed", sessionRef: "pi-failed", errorSummary: "provider unavailable" });
  sink({ type: "session.cancelled", logicalStreamId: "stream-cancelled", taskId: "agent-cancelled", sessionRef: "pi-cancelled", errorSummary: "operator cancelled" });
  await observer.flush();

  const events = await observer.query({ forgeRunId: "run-terminal" });
  assert.deepEqual(events.map((event) => ({
    kind: event.kind,
    severity: event.severity,
    summary: (event.payload as { summary?: string }).summary,
    session: event.identity.piSessionRef,
  })), [
    { kind: "agent.session.failed", severity: "error", summary: "provider unavailable", session: "pi-failed" },
    { kind: "agent.session.cancelled", severity: "warning", summary: "operator cancelled", session: "pi-cancelled" },
  ]);
  observer.close();
});

test("agent identity refresh does not reset streaming redaction state", async () => {
  const observer = observerWithStore();
  setAgentEventObservationSink(observer, { forgeRunId: "run-refresh" });
  observeAgentEvent({ type: "text.delta", logicalStreamId: "stream-refresh", taskId: "agent-refresh", text: "Bearer split" });
  setAgentEventObservationIdentity({ forgeRunId: "run-refresh", workUnitId: "unit-refresh" });
  observeAgentEvent({ type: "text.delta", logicalStreamId: "stream-refresh", taskId: "agent-refresh", text: "-secret-value" });
  observeAgentEvent({ type: "session.completed", logicalStreamId: "stream-refresh", taskId: "agent-refresh", sessionRef: "pi-refresh" });
  await observer.flush();
  const events = await observer.query({ forgeRunId: "run-refresh" });
  const output = events.find((event) => event.kind === "output.delta");
  assert.ok(output);
  assert.equal(output.identity.workUnitId, "unit-refresh");
  assert.doesNotMatch(JSON.stringify(output), /split-secret-value/);
  setAgentEventObservationSink(undefined);
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

test("streaming sanitizer carries split terminal and credential state across chunks", () => {
  const stream = createStreamingObservationText();
  const output = [
    stream.push("before \u001b]8;;https://example.test"),
    stream.push("\u0007visible bearer supe"),
    stream.push("r-secret-value\u001b[31m after"),
    stream.finish(),
  ].join("");
  assert.match(output, /before visible/);
  assert.match(output, /\[REDACTED\]/);
  assert.match(output, /after/);
  assert.doesNotMatch(output, /super-secret-value/);
  assert.doesNotMatch(output, /https:\/\/example\.test/);
});

test("background task adapter isolates colon-containing task streams and drains before lifecycle", async () => {
  const observer = observerWithStore();
  const adapter = new BackgroundTaskObservationAdapter(observer, producer);
  adapter.output("task:child", "stdout", "\u001b]52;c;", 1);
  adapter.output("task", "stdout", "parent tail", 1);
  const parentFinished = adapter.finished("task", "completed", 0);
  adapter.output("task:child", "stdout", "\u0007visible bearer supe", 2);
  adapter.output("task:child", "stdout", "r-child-secret after", 3);
  await Promise.all([parentFinished, adapter.finished("task:child", "completed", 0)]);
  await observer.flush();

  const events = await observer.query({ source: "process" });
  const parentOutput = events.findIndex((event) => event.identity.controllerTaskId === "task" && event.output?.text === "parent tail");
  const parentLifecycle = events.findIndex((event) => event.identity.controllerTaskId === "task" && event.kind === "process.exited");
  assert.ok(parentOutput >= 0);
  assert.ok(parentLifecycle > parentOutput);
  const childText = events.filter((event) => event.identity.controllerTaskId === "task:child" && event.output).map((event) => event.output?.text ?? "").join("");
  assert.match(childText, /visible/);
  assert.match(childText, /after/);
  assert.doesNotMatch(JSON.stringify(events), /child-secret|\u001b\]52/);
  observer.close();
});

test("background task adapter quarantines only the stream dropped by bounded observer backpressure", async () => {
  const observer = new ForgeDockObserver({
    store: new SqliteObservationStore(":memory:"),
    producer,
    maxQueueDepth: 1,
  });
  const adapter = new BackgroundTaskObservationAdapter(observer, producer);
  const first = adapter.output("kept", "stdout", "kept visible", 1);
  const dropped = adapter.output("dropped", "stdout", "dropped visible", 1);
  const secret = adapter.output("dropped", "stdout", "Bearer dropped-secret", 2);
  await Promise.all([
    first,
    dropped,
    secret,
    adapter.finished("kept", "completed", 0),
    adapter.finished("dropped", "cancelled"),
  ]);
  await observer.flush();
  const events = await observer.query({ source: "process" });
  const serialized = JSON.stringify(events);
  assert.match(serialized, /kept visible/);
  assert.doesNotMatch(serialized, /dropped visible|dropped-secret/);
  assert.equal(events.filter((event) => event.identity.controllerTaskId === "dropped" && event.kind === "process.failed").length, 1);
  observer.close();
});

test("background task adapter quarantines only a rejected stream", async () => {
  const drafts: ObservationDraft[] = [];
  const sink: ObservationSink = {
    emit: async (draft) => {
      drafts.push(draft);
      if (draft.output?.text === "reject-me") throw new Error("sink unavailable");
      return {} as ObservationEnvelopeV1;
    },
  };
  const adapter = new BackgroundTaskObservationAdapter(sink, producer);
  adapter.output("rejected", "stdout", "reject-me", 1);
  adapter.output("rejected", "stdout", "Bearer rejected-secret", 2);
  adapter.output("independent", "stdout", "independent visible", 1);
  await Promise.all([adapter.finished("rejected", "cancelled"), adapter.finished("independent", "completed", 0)]);

  assert.equal(drafts.filter((draft) => draft.identity?.controllerTaskId === "rejected" && draft.output).length, 1);
  assert.match(JSON.stringify(drafts), /independent visible/);
  assert.doesNotMatch(JSON.stringify(drafts), /rejected-secret/);
});

test("streaming sanitizer retains a long split token until its delimiter", () => {
  const stream = createStreamingObservationText();
  const output = [
    stream.push("Bearer abcdefgh"),
    stream.push("ijklmnopqrstuvwxyz"),
    stream.push(" after"),
    stream.finish(),
  ].join("");
  assert.match(output, /\[REDACTED\] after/);
  assert.doesNotMatch(output, /abcdefgh|ijklmnopqrstuvwxyz/);
});

test("streaming sanitizer retains a split private-key body until the closing delimiter", () => {
  const stream = createStreamingObservationText();
  const output = [
    stream.push("-----BEGIN RSA PRIVATE KEY-----\\nMIIE"),
    stream.push("private-body-fragment"),
    stream.push("\\n-----END RSA PRIVATE KEY----- after"),
    stream.finish(),
  ].join("");
  assert.match(output, /\[REDACTED\] after/);
  assert.doesNotMatch(output, /private-body-fragment|MIIE/);
});

test("streaming sanitizer quarantines an unbounded secret candidate", () => {
  const stream = createStreamingObservationText();
  assert.equal(stream.push(`Bearer ${"a".repeat(8)}`), "");
  assert.equal(stream.push("b".repeat(16 * 1024)), "");
  assert.equal(stream.quarantined, true);
  assert.equal(stream.push("tail-must-not-escape"), "");
  assert.equal(stream.finish(), "");
});

test("streaming sanitizer fails closed after a dropped chunk until reset", () => {
  const stream = createStreamingObservationText();
  stream.push("safe output");
  stream.markDropped();
  assert.equal(stream.push("credential=should-not-escape"), "");
  assert.equal(stream.finish(), "");
  stream.reset();
  assert.match(`${stream.push("visible")}${stream.finish()}`, /visible/);
});

test("observer never retains raw dropped output and quarantines the next chunk", async () => {
  const observer = new ForgeDockObserver({ store: new SqliteObservationStore(":memory:"), producer, maxQueueDepth: 1 });
  const identity = { forgeRunId: "run-quarantine", agentTaskId: "task-1" };
  const first = observer.emit({ producer, identity, source: "agent", channel: "activity", kind: "output.delta", payload: { text: "first" }, output: { channel: "stdout", text: "first" } });
  const dropped = observer.emit({ producer, identity, source: "agent", channel: "activity", kind: "output.delta", payload: { text: "drop-secret-value" }, output: { channel: "stdout", text: "drop-secret-value" } });
  await Promise.all([first, dropped]);
  const next = observer.emit({ producer, identity, source: "agent", channel: "activity", kind: "output.delta", payload: { text: "next-secret-value" }, output: { channel: "stdout", text: "next-secret-value" } });
  await next;
  const events = await observer.query({ forgeRunId: "run-quarantine" });
  const serialized = JSON.stringify(events);
  assert.doesNotMatch(serialized, /drop-secret-value|next-secret-value/);
  assert.match(serialized, /quarantined after backpressure drop/);
  observer.close();
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
