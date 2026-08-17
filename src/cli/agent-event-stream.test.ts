// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { test } from "node:test";
import { AgentEventStreamWriter } from "./agent-event-stream.js";

function capture() {
  let output = "";
  return {
    writer: new AgentEventStreamWriter((text) => { output += text; }, "none"),
    output: () => output,
  };
}

test("streams user-visible assistant deltas with task context", () => {
  const stream = capture();
  stream.writer.write({ type: "session.started", taskId: "build:1", sessionRef: "pi_1", provider: "openai-codex", model: "gpt-test" });
  stream.writer.write({ type: "thinking.delta", taskId: "build:1", text: "Inspecting the packet" });
  stream.writer.write({ type: "thinking.delta", taskId: "build:1", text: " and repository.\nNext step." });
  stream.writer.write({ type: "text.delta", taskId: "build:1", text: "I will update the scoped file." });
  stream.writer.finish();

  assert.match(stream.output(), /◆ build:1 · openai-codex\/gpt-test/);
  assert.doesNotMatch(stream.output(), /private|thinking|Inspecting the packet/);
  assert.match(stream.output(), /◆ build:1 · assistant\n      │ I will update the scoped file\./);
});

test("removes terminal control sequences from untrusted streamed text", () => {
  const stream = capture();
  const escape = String.fromCharCode(0x1b);
  const bell = String.fromCharCode(0x07);
  stream.writer.write({ type: "text.delta", taskId: "build:1", text: `${escape}]8;;https://example.test${bell}visible${escape}[31m warning` });
  stream.writer.finish();

  assert.match(stream.output(), /visible warning/);
  assert.doesNotMatch(stream.output(), /https:\/\/example|31m/);
  assert.equal(stream.output().includes(escape), false);
});

test("removes split C1 terminal payloads from the live stream", () => {
  const stream = capture();
  stream.writer.write({ type: "text.delta", taskId: "build:1", text: "prefix\u009d52;c;" });
  stream.writer.write({ type: "text.delta", taskId: "build:1", text: "clipboard-secret\u009cvisible" });
  stream.writer.finish();

  assert.match(stream.output(), /prefix/);
  assert.match(stream.output(), /visible/);
  assert.doesNotMatch(stream.output(), /clipboard-secret|52;c/);
  assert.equal(stream.output().includes("\u009d"), false);
});

test("masks credential-shaped live deltas and terminal summaries", () => {
  const stream = capture();
  stream.writer.write({ type: "text.delta", taskId: "build:1", text: "api_key=live-secret https://user:pass@example.test" });
  stream.writer.write({ type: "session.failed", taskId: "build:1", sessionRef: "pi-failed", errorSummary: "password=failed-secret" });

  assert.doesNotMatch(stream.output(), /live-secret|user:pass|failed-secret/);
  assert.match(stream.output(), /api_key=\[REDACTED\]/);
  assert.match(stream.output(), /session failed · password=\[REDACTED\]/);
});

test("keeps terminal parser state isolated for interleaved live task streams", () => {
  const stream = capture();
  stream.writer.write({ type: "text.delta", taskId: "task-a", text: "\u009d52;c;" });
  stream.writer.write({ type: "text.delta", taskId: "task-b", text: "\u009b31" });
  stream.writer.write({ type: "text.delta", taskId: "task-a", text: "clipboard-a\u009cvisible-a" });
  stream.writer.write({ type: "text.delta", taskId: "task-b", text: "mvisible-b" });
  stream.writer.finish();

  assert.doesNotMatch(stream.output(), /clipboard-a|31m/);
  assert.match(stream.output(), /visible-a/);
  assert.match(stream.output(), /visible-b/);
});

test("shows typed review milestones and artifact timestamps in the live stream", () => {
  const stream = capture();
  stream.writer.write({
    type: "tool.started", taskId: "review:3", toolCallId: "call-grep", tool: "grep",
    observability: {
      phase: "review", cycle: { current: 3, total: 3 }, activeChild: "concurrency",
      reviewerRoles: ["correctness", "concurrency"],
      latestArtifacts: { buildResult: "2026-08-10T14:01:00.000Z", reviewVerdict: "2026-08-10T13:45:00.000Z" },
      remainingRemediationCycles: 0,
    },
  });
  assert.match(stream.output(), /review · cycle 3\/3 · child concurrency/);
  assert.match(stream.output(), /BuildResult 2026-08-10T14:01:00\.000Z/);
  assert.match(stream.output(), /ReviewVerdict 2026-08-10T13:45:00\.000Z/);
  assert.match(stream.output(), /remaining 0/);
});

test("shows bounded tool arguments and completion in the live stream", () => {
  const stream = capture();
  stream.writer.write({
    type: "tool.started",
    taskId: "build:1",
    toolCallId: "call-read-1234567890",
    tool: "read",
    args: { path: "src/example.ts", offset: 10, secretPayload: "must-not-render" },
  });
  stream.writer.write({ type: "tool.completed", taskId: "build:1", toolCallId: "call-read-1234567890", tool: "read", isError: false });
  stream.writer.write({
    type: "tool.started", taskId: "build:1", toolCallId: "call-submit-1", tool: "submit_artifact", args: { huge: "must-not-render" },
  });

  assert.match(stream.output(), /◆ build:1 · read\[d-1234567890\] · path="src\/example\.ts" offset=10/);
  assert.match(stream.output(), /✓ build:1 · read\[d-1234567890\] complete/);
  assert.doesNotMatch(stream.output(), /secretPayload|must-not-render|huge/);
});

test("attributes concurrent tool failures by call id and renders bounded evidence", () => {
  const stream = capture();
  stream.writer.write({ type: "tool.started", taskId: "build:1", toolCallId: "call-a", tool: "edit", args: { path: "src/a.ts" } });
  stream.writer.write({ type: "tool.started", taskId: "build:1", toolCallId: "call-b", tool: "edit", args: { path: "src/b.ts" } });
  stream.writer.write({ type: "tool.completed", taskId: "build:1", toolCallId: "call-b", tool: "edit", isError: true, errorSummary: "oldText was not unique" });
  stream.writer.write({ type: "tool.completed", taskId: "build:1", toolCallId: "call-a", tool: "edit", isError: false });

  assert.match(stream.output(), /edit\[call-b\] failed · oldText was not unique/);
  assert.match(stream.output(), /edit\[call-a\] complete/);
});

test("keeps concurrent task streams readable instead of interleaving open lines", () => {
  const stream = capture();
  stream.writer.write({ type: "text.delta", taskId: "review:1", text: "First" }, "review");
  stream.writer.write({ type: "text.delta", taskId: "review:2", text: "Second" }, "review");

  assert.match(stream.output(), /review · review:1 · assistant\n      │ First\n/);
  assert.match(stream.output(), /review · review:2 · assistant\n      │ Second/);
});

test("renders failed and cancelled sessions as distinct terminal outcomes", () => {
  const stream = capture();
  stream.writer.write({ type: "text.delta", taskId: "build:1", text: "partial output" });
  stream.writer.write({
    type: "session.failed", taskId: "build:1", sessionRef: "pi-failed",
    errorSummary: "provider unavailable",
  });
  stream.writer.write({
    type: "session.cancelled", taskId: "review:1", sessionRef: "pi-cancelled",
    errorSummary: "operator cancelled",
  });

  assert.match(stream.output(), /partial output\n/);
  assert.match(stream.output(), /✕ build:1 · session failed · provider unavailable/);
  assert.match(stream.output(), /■ review:1 · session cancelled · operator cancelled/);
  assert.doesNotMatch(stream.output(), /session complete/);
});
