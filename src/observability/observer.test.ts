// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BackgroundTaskObservationAdapter, ControllerObservationAdapter, createAgentEventObservationSink } from "./adapters.js";
import { ForgeDockObservationControlGateway } from "./control-gateway.js";
import { createObservationProducer, createTerminalTextSanitizer, normalizeObservationDraft, redactObservationValue, sanitizeTerminalText } from "./contracts.js";
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

test("repeated backpressure drops keep output streams fail-closed until their terminator", async () => {
  const observer = new ForgeDockObserver({
    store: new SqliteObservationStore(":memory:"),
    producer,
    maxQueueDepth: 1,
  });
  const first = observer.emit({
    producer,
    identity: { forgeRunId: "run-pressure-parser", controllerTaskId: "task-1" },
    source: "process",
    channel: "stdout",
    kind: "output.stdout",
    payload: {},
    output: { channel: "stdout", text: "\u009d52;c;", chunkSequence: 1 },
  });
  const droppedOne = observer.emit({
    producer,
    identity: { forgeRunId: "run-pressure-parser", controllerTaskId: "task-1" },
    source: "process",
    channel: "stdout",
    kind: "output.stdout",
    payload: {},
    output: { channel: "stdout", text: "dropped-one", chunkSequence: 2 },
  });
  const droppedTwo = observer.emit({
    producer,
    identity: { forgeRunId: "run-pressure-parser", controllerTaskId: "task-1" },
    source: "process",
    channel: "stdout",
    kind: "output.stdout",
    payload: {},
    output: { channel: "stdout", text: "dropped-two", chunkSequence: 3 },
  });
  await Promise.all([first, droppedOne, droppedTwo]);

  await observer.emit({
    producer,
    identity: { forgeRunId: "run-pressure-parser", controllerTaskId: "task-1" },
    source: "process",
    channel: "stdout",
    kind: "output.stdout",
    payload: {},
    output: { channel: "stdout", text: "discarded-secret\u009cvisible", chunkSequence: 4 },
  });
  const events = await observer.query({ forgeRunId: "run-pressure-parser" });
  const output = events.flatMap((event) => event.output ? [event.output.text] : []);
  assert.equal(output.some((text) => text.includes("discarded-secret")), false);
  assert.ok(output.includes("visible"));
  observer.close();
});

test("the first dropped output chunk initializes fail-closed parser state", async () => {
  const observer = new ForgeDockObserver({
    store: new SqliteObservationStore(":memory:"),
    producer,
    maxQueueDepth: 1,
  });
  const identity = { forgeRunId: "run-pressure-first-drop", controllerTaskId: "task-1" };
  const occupyingEvent = observer.emit({
    producer,
    identity,
    source: "process",
    channel: "lifecycle",
    kind: "process.started",
    payload: { command: "test" },
  });
  const droppedFirstChunk = observer.emit({
    producer,
    identity,
    source: "process",
    channel: "stdout",
    kind: "output.stdout",
    payload: {},
    output: { channel: "stdout", text: "\u009d52;c;", chunkSequence: 1 },
  });

  await Promise.all([occupyingEvent, droppedFirstChunk]);
  await observer.emit({
    producer,
    identity,
    source: "process",
    channel: "stdout",
    kind: "output.stdout",
    payload: {},
    output: { channel: "stdout", text: "clipboard-secret\u009cvisible", chunkSequence: 2 },
  });
  await observer.flush();

  const events = await observer.query({ forgeRunId: "run-pressure-first-drop" });
  const output = events.flatMap((event) => event.output ? [event.output.text] : []);
  assert.equal(output.some((text) => text.includes("clipboard-secret")), false);
  assert.ok(output.includes("visible"));
  assert.equal(JSON.stringify(events).includes("clipboard-secret"), false);
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

test("agent adapter preserves failed and cancelled terminal semantics", async () => {
  const observer = observerWithStore();
  const sink = createAgentEventObservationSink(observer, { identity: { forgeRunId: "run-terminal" }, producer });
  sink({ type: "session.failed", taskId: "agent-failed", sessionRef: "pi-failed", errorSummary: "provider unavailable" });
  sink({ type: "session.cancelled", taskId: "agent-cancelled", sessionRef: "pi-cancelled", errorSummary: "operator cancelled" });
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

test("terminal sanitization covers C1 OSC, CSI, SS3, string controls, and allowed line controls", () => {
  const value = sanitizeTerminalText("\u009b31mtext\u009d52;c;clipboard\u009cvisible\u008fPdone\u0090ignored\u009cafter\u0001\n\t\r");
  assert.equal(value, "textvisibledoneafter\n\t\r");
  assert.doesNotMatch(value, /[\u0080-\u009f\u001b]/u);
});

test("stateful terminal sanitization removes sequences split across chunks", () => {
  const sanitizer = createTerminalTextSanitizer();
  assert.equal(sanitizer.write("prefix\u009d52;c;"), "prefix");
  assert.equal(sanitizer.write("clipboard\u009cvisible"), "visible");
  sanitizer.finish();

  const escOsc = createTerminalTextSanitizer();
  assert.equal(escOsc.write("before\u001b]52;c;"), "before");
  assert.equal(escOsc.write("clipboard\u001b\\after"), "after");
  escOsc.finish();

  const csi = createTerminalTextSanitizer();
  assert.equal(csi.write("\u009b31"), "");
  assert.equal(csi.write("mvisible"), "visible");
  csi.finish();
});

test("observation redaction masks recursive assignments, JSON, URLs, and output idempotently", () => {
  const draft = normalizeObservationDraft({
    producer,
    identity: { forgeRunId: "run-redaction" },
    source: "process",
    channel: "stdout",
    kind: "output.stdout",
    payload: {
      args: ["--password=secret", "OPENAI_API_KEY=provider-secret"],
      nested: [`{\"token\":\"json-secret\"}`],
      url: "https://user:password@example.test/path",
    },
    output: { channel: "stdout", text: "api_key=output-secret https://u:p@example.test", chunkSequence: 1 },
  });
  const serialized = JSON.stringify(draft.payload);
  assert.equal(draft.security?.redacted, true);
  assert.doesNotMatch(serialized, /secret|password@example|provider-secret|json-secret/u);
  assert.equal(draft.output?.text, "api_key=[REDACTED] https://[REDACTED]@example.test");
  assert.equal(normalizeObservationDraft(draft).output?.text, draft.output?.text);
  assert.deepEqual(redactObservationValue(["--password=secret"]).value, ["--password=[REDACTED]"]);
  const separated = redactObservationValue(["--password", "secret", "--api-key=other"]).value;
  assert.deepEqual(separated, ["--password", "[REDACTED]", "--api-key=[REDACTED]"]);

  const bounded = normalizeObservationDraft({
    producer,
    source: "controller",
    channel: "stdout",
    kind: "output.stdout",
    payload: { message: "0123456789" },
    output: { channel: "stdout", text: "0123456789", chunkSequence: 1 },
  }, { maxStringBytes: 5, maxOutputBytes: 5 });
  assert.equal(bounded.security?.redacted, true);
  assert.ok(Buffer.byteLength(String((bounded.payload as { message?: unknown }).message), "utf8") <= 5);
  assert.ok(Buffer.byteLength(bounded.output?.text ?? "", "utf8") <= 5);
  assert.deepEqual(normalizeObservationDraft(bounded).output?.text, bounded.output?.text);

  const boundedPayload = redactObservationValue({ message: "x".repeat(200) }, { maxPayloadBytes: 32 });
  assert.ok(Buffer.byteLength(JSON.stringify(boundedPayload.value), "utf8") <= 32);
});

test("agent, controller, background, and direct SQLite output preserve isolated chunk state", async () => {
  const observer = observerWithStore();
  const agent = createAgentEventObservationSink(observer, { identity: { forgeRunId: "run-chunks" }, producer });
  agent({ type: "text.delta", taskId: "agent-a", text: "\u009d52;c;" });
  agent({ type: "text.delta", taskId: "agent-b", text: "\u009b31" });
  agent({ type: "text.delta", taskId: "agent-a", text: "secret\u009cvisible-a" });
  agent({ type: "text.delta", taskId: "agent-b", text: "mvisible-b" });

  const controller = new ControllerObservationAdapter(observer, { identity: { forgeRunId: "run-chunks", controllerTaskId: "controller-1" }, producer });
  controller.output("stdout", "\u009d52;c;");
  controller.output("stdout", "controller-secret\u009ccontroller-visible");
  controller.completed(0);

  const background = new BackgroundTaskObservationAdapter(observer, producer);
  background.output("task-1", "stderr", "\u009b31", 1);
  background.output("task-1", "stderr", "mbackground-visible", 2);
  background.finished("task-1", "completed", 0);

  const store = new SqliteObservationStore(":memory:");
  await store.append({ producer, identity: { forgeRunId: "run-direct", controllerTaskId: "direct" }, source: "controller", channel: "stdout", kind: "output.stdout", payload: {}, output: { channel: "stdout", text: "\u009d52;c;", chunkSequence: 1 } });
  await store.append({ producer, identity: { forgeRunId: "run-direct", controllerTaskId: "direct" }, source: "controller", channel: "stdout", kind: "output.stdout", payload: {}, output: { channel: "stdout", text: "direct-secret\u009c direct-visible", chunkSequence: 2 } });

  await observer.flush();
  const events = await observer.query();
  const output = events.flatMap((event) => event.output ? [event.output.text] : []);
  assert.ok(output.includes("visible-a"));
  assert.ok(output.includes("visible-b"));
  assert.ok(output.includes("controller-visible"));
  assert.ok(output.includes("background-visible"));
  assert.equal(output.some((text) => /secret|[\u0080-\u009f\u001b]/u.test(text)), false);
  assert.equal(events.filter((event) => event.output).some((event) => event.security.redacted), true);
  assert.equal(events.filter((event) => event.output).every((event) => event.output!.bytes === Buffer.byteLength(event.output!.text, "utf8")), true);
  assert.equal(events.filter((event) => event.output).every((event) => {
    const payload = event.payload as { bytes?: unknown };
    return typeof payload.bytes !== "number" || payload.bytes === event.output!.bytes;
  }), true);

  const direct = await store.query({ forgeRunId: "run-direct" });
  assert.deepEqual(direct.map((event) => event.output?.text), ["", " direct-visible"]);
  store.close();
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
