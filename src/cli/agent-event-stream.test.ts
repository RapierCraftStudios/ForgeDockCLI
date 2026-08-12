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

test("streams inner assistant and thinking deltas with task context", () => {
  const stream = capture();
  stream.writer.write({ type: "session.started", taskId: "build:1", sessionRef: "pi_1", provider: "openai-codex", model: "gpt-test" });
  stream.writer.write({ type: "thinking.delta", taskId: "build:1", text: "Inspecting the packet" });
  stream.writer.write({ type: "thinking.delta", taskId: "build:1", text: " and repository.\nNext step." });
  stream.writer.write({ type: "text.delta", taskId: "build:1", text: "I will update the scoped file." });
  stream.writer.finish();

  assert.match(stream.output(), /◆ build:1 · openai-codex\/gpt-test/);
  assert.match(stream.output(), /◆ build:1 · thinking\n      │ Inspecting the packet and repository\.\n      │ Next step\./);
  assert.match(stream.output(), /◆ build:1 · assistant\n      │ I will update the scoped file\./);
});

test("shows bounded tool arguments and completion in the live stream", () => {
  const stream = capture();
  stream.writer.write({
    type: "tool.started",
    taskId: "build:1",
    tool: "read",
    args: { path: "src/example.ts", offset: 10, secretPayload: "must-not-render" },
  });
  stream.writer.write({ type: "tool.completed", taskId: "build:1", tool: "read", isError: false });
  stream.writer.write({ type: "tool.started", taskId: "build:1", tool: "submit_artifact", args: { huge: "must-not-render" } });

  assert.match(stream.output(), /◆ build:1 · read · path="src\/example\.ts" offset=10/);
  assert.match(stream.output(), /✓ build:1 · read complete/);
  assert.doesNotMatch(stream.output(), /secretPayload|must-not-render|huge/);
});

test("keeps concurrent task streams readable instead of interleaving open lines", () => {
  const stream = capture();
  stream.writer.write({ type: "text.delta", taskId: "review:1", text: "First" }, "review");
  stream.writer.write({ type: "text.delta", taskId: "review:2", text: "Second" }, "review");

  assert.match(stream.output(), /review · review:1 · assistant\n      │ First\n/);
  assert.match(stream.output(), /review · review:2 · assistant\n      │ Second/);
});
