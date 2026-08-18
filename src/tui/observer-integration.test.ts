// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ControllerObservationAdapter } from "../observability/adapters.js";
import { ForgeDockObserver } from "../observability/observer.js";
import { SqliteObservationStore } from "../observability/sqlite-store.js";
import { ForgeDockBackgroundTasks } from "./background-tasks.js";
import { executeController } from "./forgedock-tools.js";

test("background task supervisor persists sanitized split channels before its terminal event", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "forgedock-observer-integration-"));
  const observer = new ForgeDockObserver({
    store: new SqliteObservationStore(":memory:"),
    maxQueueDepth: 8,
  });
  const pi = { sendMessage: () => undefined } as unknown as ExtensionAPI;
  const ctx = {
    cwd,
    ui: { notify: () => undefined, setStatus: () => undefined },
  } as unknown as ExtensionContext;
  const tasks = new ForgeDockBackgroundTasks(pi);
  tasks.initialize(ctx);
  tasks.setObservationSink(observer);
  const record = tasks.start({
    command: process.execPath,
    args: ["-e", "process.stdout.write('stdout Bearer supe'); process.stderr.write('\\u001b]52;c;'); setTimeout(() => { process.stdout.write('r-integration-secret after'); process.stderr.write('\\u0007stderr visible'); }, 20)"],
    cwd,
    ctx,
  });

  try {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (tasks.list().find((candidate) => candidate.id === record.id)?.status === "completed") break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(tasks.list().find((candidate) => candidate.id === record.id)?.status, "completed");
    await observer.flush();
    const events = await observer.query({ scopeKey: record.id, source: "process" });
    const outputEvents = events.filter((event) => event.output);
    const lifecycleIndex = events.findIndex((event) => event.kind === "process.exited");
    assert.ok(lifecycleIndex >= 0);
    assert.ok(outputEvents.every((event) => events.indexOf(event) < lifecycleIndex));
    assert.deepEqual(outputEvents.map((event) => event.output?.channel).sort(), ["stderr", "stdout"]);
    const serialized = JSON.stringify(outputEvents);
    assert.ok(outputEvents.every((event) => event.identity.logicalStreamId));
    assert.equal(new Set(outputEvents.map((event) => event.identity.logicalStreamId)).size, 1);
    assert.match(serialized, /stdout/);
    assert.match(serialized, /stderr visible/);
    assert.match(serialized, /\[REDACTED\]/);
    assert.doesNotMatch(serialized, /integration-secret|\u001b\]52/);
  } finally {
    await tasks.shutdown();
    observer.close();
  }
});

test("controller default path persists only sanitized split and quoted output", async () => {
  const observer = new ForgeDockObserver({ store: new SqliteObservationStore(":memory:") });
  const adapter = new ControllerObservationAdapter(observer, { identity: { forgeRunId: "run-controller-redaction", controllerTaskId: "controller-redaction" } });
  adapter.output("stdout", "visible password=");
  adapter.output("stderr", "visible token=");
  adapter.output("stdout", "split-secret after");
  adapter.output("stdout", ' and {"password":');
  adapter.output("stdout", '"json-secret"}');
  adapter.output("stderr", "https://user:");
  adapter.output("stderr", "url-secret@example.test");
  adapter.output("stdout", "ftp://alice:");
  adapter.output("stdout", "ftp-secret@example.test/path");
  adapter.output("stderr", "git+ssh://bob:");
  adapter.output("stderr", "ssh-secret@example.test/path");
  adapter.output("stderr", 'password="[REDACTED]"suffix');
  adapter.completed(0);
  await observer.flush();

  const events = await observer.query({ forgeRunId: "run-controller-redaction" });
  const outputs = events.filter((event) => event.output);
  const serialized = JSON.stringify(outputs);
  assert.doesNotMatch(serialized, /split-secret|json-secret|url-secret|ftp-secret|ssh-secret|suffix/);
  assert.match(serialized, /visible/);
  assert.match(serialized, /\[REDACTED\]/);
  assert.deepEqual([...new Set(outputs.map((event) => event.output?.channel))].sort(), ["stderr", "stdout"]);
  assert.ok(events.find((event) => event.kind === "controller.completed"));
  assert.ok(outputs.every((event) => event.identity.logicalStreamId));
  assert.equal(new Set(outputs.map((event) => event.identity.logicalStreamId)).size, 1);
  observer.close();
});

test("controller adapter preserves stdout and stderr as separate observation channels", async () => {
  const observer = new ForgeDockObserver({
    store: new SqliteObservationStore(":memory:"),
    producer: { component: "controller-test", processInstanceId: "controller-test:1", pid: 1 },
  });
  const adapter = new ControllerObservationAdapter(observer, { identity: { controllerTaskId: "controller-1" } });
  const channels: string[] = [];
  const result = await executeController(
    process.execPath,
    ["-e", "process.stdout.write('out'); process.stderr.write('err')"],
    process.cwd(),
    undefined,
    () => undefined,
    {},
    (channel, text) => {
      channels.push(`${channel}:${text}`);
      adapter.output(channel, text);
    },
  );
  adapter.completed(result.code, result.truncated);
  await observer.flush();
  const events = await observer.query({ scopeKey: "controller-1" });
  assert.equal(result.code, 0);
  assert.ok(channels.some((value) => value.startsWith("stdout:")));
  assert.ok(channels.some((value) => value.startsWith("stderr:")));
  assert.deepEqual(events.filter((event) => event.output).map((event) => event.output?.channel).sort(), ["stderr", "stdout"]);
  const controllerEvents = events.filter((event) => event.identity.controllerTaskId === "controller-1");
  assert.ok(controllerEvents.every((event) => event.identity.logicalStreamId));
  assert.equal(new Set(controllerEvents.map((event) => event.identity.logicalStreamId)).size, 1);
  observer.close();
});
