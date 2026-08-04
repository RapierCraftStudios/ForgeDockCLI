// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ForgeDockBackgroundTasks } from "./background-tasks.js";

function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), "forgedock-background-"));
  const messages: string[] = [];
  const statuses: Array<string | undefined> = [];
  const pi = {
    sendMessage: (message: { content: string }) => { messages.push(message.content); },
  } as unknown as ExtensionAPI;
  const ctx = {
    cwd,
    ui: {
      notify: () => undefined,
      setStatus: (_key: string, value: string | undefined) => { statuses.push(value); },
    },
  } as unknown as ExtensionContext;
  const tasks = new ForgeDockBackgroundTasks(pi);
  tasks.initialize(ctx);
  return { cwd, messages, statuses, tasks, ctx };
}

async function eventually(assertion: () => void): Promise<void> {
  let last: unknown;
  for (let attempt = 0; attempt < 100; attempt++) {
    try { assertion(); return; } catch (error) { last = error; }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw last;
}

test("native background controller records output and completion without blocking", async () => {
  const { cwd, messages, tasks, ctx } = fixture();
  const record = tasks.start({
    command: process.execPath,
    args: ["-e", "setTimeout(()=>{console.log('workflow complete')},30)"],
    cwd,
    ctx,
  });
  assert.equal(record.status, "running");
  assert.ok(existsSync(join(cwd, ".forgedock", "tasks", `${record.id}.json`)));
  await eventually(() => assert.equal(tasks.list().find((candidate) => candidate.id === record.id)?.status, "completed"));
  assert.match(tasks.output(record.id), /workflow complete/);
  assert.match(messages[0] ?? "", new RegExp(`${record.id}.*completed`));
  const persisted = JSON.parse(readFileSync(join(cwd, ".forgedock", "tasks", `${record.id}.json`), "utf8")) as { status: string };
  assert.equal(persisted.status, "completed");
  await tasks.shutdown();
});

test("native background controller does not inherit the invoking worker role", async () => {
  const previous = process.env.PI_SUBAGENT_CHILD_AGENT;
  process.env.PI_SUBAGENT_CHILD_AGENT = "forgedock-issue-worker";
  const { cwd, tasks, ctx } = fixture();
  try {
    const record = tasks.start({
      command: process.execPath,
      args: ["-e", "console.log(process.env.PI_SUBAGENT_CHILD_AGENT ?? 'clean')"],
      cwd,
      ctx,
    });
    await eventually(() => assert.equal(tasks.list().find((candidate) => candidate.id === record.id)?.status, "completed"));
    assert.match(tasks.output(record.id), /clean/);
    assert.doesNotMatch(tasks.output(record.id), /forgedock-issue-worker/);
  } finally {
    await tasks.shutdown();
    if (previous === undefined) delete process.env.PI_SUBAGENT_CHILD_AGENT;
    else process.env.PI_SUBAGENT_CHILD_AGENT = previous;
  }
});

test("native background cancellation terminates the owned task", async () => {
  const { cwd, tasks, ctx } = fixture();
  const record = tasks.start({
    command: process.execPath,
    args: ["-e", "setInterval(()=>{},1000)"],
    cwd,
    ctx,
  });
  assert.equal(tasks.cancel(record.id).status, "cancelled");
  await eventually(() => assert.equal(tasks.list().find((candidate) => candidate.id === record.id)?.status, "cancelled"));
  await tasks.shutdown();
});
