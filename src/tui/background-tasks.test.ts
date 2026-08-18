// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ForgeDockBackgroundTasks, NESTED_AGENT_BRIDGE_RESTART_REQUIRED } from "./background-tasks.js";
import { ForgeDockObserver } from "../observability/observer.js";
import { SqliteObservationStore } from "../observability/sqlite-store.js";

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
  return { cwd, messages, statuses, tasks, ctx, pi };
}

async function eventually(assertion: () => void): Promise<void> {
  let last: unknown;
  for (let attempt = 0; attempt < 100; attempt++) {
    try { assertion(); return; } catch (error) { last = error; }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw last;
}

test("background observation captures split stdout and stderr before its terminal event", async () => {
  const { cwd, tasks, ctx } = fixture();
  const observer = new ForgeDockObserver({ store: new SqliteObservationStore(":memory:"), maxQueueDepth: 8 });
  tasks.setObservationSink(observer);
  const record = tasks.start({
    command: process.execPath,
    args: ["-e", "process.stdout.write('stdout bearer supe'); process.stderr.write('\\u001b]52;c;'); setTimeout(()=>{process.stdout.write('r-integration-secret after'); process.stderr.write('\\u0007stderr visible')},20)"],
    cwd,
    ctx,
  });
  await eventually(() => assert.equal(tasks.list().find((candidate) => candidate.id === record.id)?.status, "completed"));
  await observer.flush();
  const events = await observer.query({ scopeKey: record.id, source: "process" });
  const outputEvents = events.filter((event) => event.output);
  const lifecycleIndex = events.findIndex((event) => event.kind === "process.exited");
  assert.ok(lifecycleIndex > outputEvents.length - 1);
  assert.deepEqual(outputEvents.map((event) => event.output?.channel).sort(), ["stderr", "stdout"]);
  const serialized = JSON.stringify(outputEvents);
  assert.match(serialized, /stdout/);
  assert.match(serialized, /stderr visible/);
  assert.match(serialized, /\[REDACTED\]/);
  assert.doesNotMatch(serialized, /integration-secret|\u001b\]52/);
  await tasks.shutdown();
  observer.close();
});

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

test("an immediately exiting controller is reconciled exactly once", async () => {
  const { cwd, messages, tasks, ctx } = fixture();
  const record = tasks.start({ command: process.execPath, args: ["-e", "process.exit(0)"], cwd, ctx });
  await eventually(() => assert.equal(tasks.list().find((candidate) => candidate.id === record.id)?.status, "completed"));
  assert.equal(messages.filter((message) => message.includes(record.id) && message.includes("completed")).length, 1);
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

test("non-cancelling shutdown leaves native controllers detached and adoptable", async () => {
  const first = fixture();
  const record = first.tasks.start({
    command: process.execPath,
    args: ["-e", "setInterval(()=>{},1000)"],
    cwd: first.cwd,
    ctx: first.ctx,
  });
  await first.tasks.shutdown({ cancel: false });
  assert.equal(first.tasks.list().find((candidate) => candidate.id === record.id)?.status, "detached");

  const adopter = new ForgeDockBackgroundTasks(first.pi);
  adopter.initialize(first.ctx);
  assert.equal(adopter.list().find((candidate) => candidate.id === record.id)?.status, "detached");
  assert.equal(adopter.isOperationallyActive(record.id), true);
  assert.equal(adopter.cancel(record.id).status, "cancelled");
  await adopter.shutdown();
});

test("terminal restart adopts a still-live controller instead of marking it failed", async () => {
  const first = fixture();
  const record = first.tasks.start({
    command: process.execPath,
    args: ["-e", "setInterval(()=>{},1000)"],
    cwd: first.cwd,
    ctx: first.ctx,
  });
  const second = new ForgeDockBackgroundTasks(first.pi);
  second.initialize(first.ctx);
  assert.equal(second.list().find((candidate) => candidate.id === record.id)?.status, "detached");
  assert.match(second.output(record.id), /detached/);
  assert.equal(second.cancel(record.id).status, "cancelled");
  // Keep the original supervisor from overwriting the adopted cancellation
  // when its child exit event arrives.
  first.tasks.cancel(record.id);
  await eventually(() => assert.equal(second.list().find((candidate) => candidate.id === record.id)?.status, "cancelled"));
  await first.tasks.shutdown();
  await second.shutdown();
});

test("terminal restart blocks bridge-bound controllers without persisting bridge credentials", async () => {
  const first = fixture();
  const record = first.tasks.start({
    command: process.execPath,
    args: ["-e", "setInterval(()=>{},1000)"],
    cwd: first.cwd,
    env: {
      FORGEDOCK_NESTED_AGENT_URL: "http://127.0.0.1:45678/v1/run",
      FORGEDOCK_NESTED_AGENT_TOKEN: "bridge-secret-that-must-not-persist",
    },
    restartRequired: NESTED_AGENT_BRIDGE_RESTART_REQUIRED,
    resumeScope: "orchestration",
    ctx: first.ctx,
  });
  const second = new ForgeDockBackgroundTasks(first.pi);
  second.initialize(first.ctx);

  const persisted = JSON.parse(readFileSync(join(first.cwd, ".forgedock", "tasks", `${record.id}.json`), "utf8")) as Record<string, unknown>;
  assert.equal(persisted.status, "blocked");
  assert.equal(persisted.restartRequired, NESTED_AGENT_BRIDGE_RESTART_REQUIRED);
  assert.equal(persisted.resumeScope, "orchestration");
  assert.doesNotMatch(JSON.stringify(persisted), /FORGEDOCK_NESTED_AGENT|bridge-secret|45678/);
  assert.equal(second.isOperationallyActive(record.id), false);
  assert.match(second.output(record.id), /resume required after TUI restart/);
  assert.match(first.messages.at(-1) ?? "", /forgedock_resume_orchestration/);
  await eventually(() => assert.throws(() => process.kill(record.pid, 0)));

  await first.tasks.shutdown({ cancel: false });
  await second.shutdown();
});

test("older bridge-bound records without a resume scope remain parseable", async () => {
  const { cwd, messages, tasks, ctx } = fixture();
  const directory = join(cwd, ".forgedock", "tasks");
  mkdirSync(directory, { recursive: true });
  const id = "task_legacy_bridge";
  writeFileSync(join(directory, `${id}.json`), JSON.stringify({
    id,
    command: process.execPath,
    args: ["controller"],
    cwd,
    pid: 999_999_999,
    logPath: join(directory, `${id}.log`),
    status: "detached",
    startedAt: new Date().toISOString(),
    restartRequired: NESTED_AGENT_BRIDGE_RESTART_REQUIRED,
  }));
  tasks.initialize(ctx);
  assert.equal(tasks.list().find((record) => record.id === id)?.status, "blocked");
  assert.doesNotMatch(messages.at(-1) ?? "", /forgedock_resume_orchestration/);
  assert.match(messages.at(-1) ?? "", /owning workflow checkpoint/);
  await tasks.shutdown();
});

test("an adopter preserves the original supervisor's durable completion result", async () => {
  const first = fixture();
  const record = first.tasks.start({
    command: process.execPath,
    args: ["-e", "setTimeout(()=>process.exit(0),100)"],
    cwd: first.cwd,
    ctx: first.ctx,
  });
  const second = new ForgeDockBackgroundTasks(first.pi);
  second.initialize(first.ctx);
  assert.equal(second.list().find((candidate) => candidate.id === record.id)?.status, "detached");
  await eventually(() => assert.equal(first.tasks.list().find((candidate) => candidate.id === record.id)?.status, "completed"));
  await eventually(() => assert.equal(second.list().find((candidate) => candidate.id === record.id)?.status, "completed"));
  await first.tasks.shutdown();
  await second.shutdown();
});

test("task observations re-read records created or updated by another process", async () => {
  const { cwd, tasks } = fixture();
  const directory = join(cwd, ".forgedock", "tasks");
  mkdirSync(directory, { recursive: true });
  const record = {
    id: "task_external", command: process.execPath, args: ["controller"], cwd, pid: 999_999_999,
    logPath: join(directory, "task_external.log"), status: "detached", startedAt: new Date().toISOString(),
  };
  writeFileSync(record.logPath, "external controller\n");
  writeFileSync(join(directory, "task_external.json"), JSON.stringify(record));
  assert.equal(tasks.list().find((candidate) => candidate.id === record.id)?.status, "detached");
  const completed = { ...record, status: "completed", completedAt: new Date().toISOString(), exitCode: 0 };
  writeFileSync(join(directory, "task_external.json"), JSON.stringify(completed));
  assert.equal(tasks.list().find((candidate) => candidate.id === record.id)?.status, "completed");
  assert.match(tasks.output(record.id), /completed/);
  assert.equal((await tasks.waitForTerminal(record.id)).status, "completed");
  await tasks.shutdown();
});

test("disk refresh rejects task records whose durable log paths escape their task directory", async () => {
  const { cwd, tasks } = fixture();
  const directory = join(cwd, ".forgedock", "tasks");
  mkdirSync(directory, { recursive: true });
  const outsideLog = join(cwd, "outside.log");
  writeFileSync(outsideLog, "must not be exposed\n");
  const record = {
    id: "task_escape", command: process.execPath, args: ["controller"], cwd, pid: 999_999_999,
    logPath: outsideLog, status: "detached", startedAt: new Date().toISOString(),
  };
  writeFileSync(join(directory, `${record.id}.json`), JSON.stringify(record));
  assert.equal(tasks.list().some((candidate) => candidate.id === record.id), false);
  assert.throws(() => tasks.output(record.id), /Unknown ForgeDock background task/);
  await tasks.shutdown();
});

test("a disappeared adopted PID remains operationally detached without inventing semantic failure", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "forgedock-background-detached-"));
  const directory = join(cwd, ".forgedock", "tasks");
  mkdirSync(directory, { recursive: true });
  const record = {
    id: "task_disappeared", command: process.execPath, args: ["controller"], cwd, pid: 999_999_999,
    logPath: join(directory, "task_disappeared.log"), status: "running", startedAt: new Date().toISOString(),
  };
  writeFileSync(record.logPath, "controller output\n");
  writeFileSync(join(directory, `${record.id}.json`), JSON.stringify(record));
  const pi = { sendMessage: () => undefined } as unknown as ExtensionAPI;
  const ctx = { cwd, ui: { notify: () => undefined, setStatus: () => undefined } } as unknown as ExtensionContext;
  const tasks = new ForgeDockBackgroundTasks(pi);
  tasks.initialize(ctx);
  assert.equal(tasks.list().find((candidate) => candidate.id === record.id)?.status, "detached");
  assert.equal(tasks.isOperationallyActive(record.id), false);
  await assert.rejects(tasks.waitForTerminal(record.id), /without a locally observable controller result/);
  await tasks.shutdown();
});

test("an adopted process that disappears without a task result is not rewritten as failed", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "forgedock-background-lost-"));
  const directory = join(cwd, ".forgedock", "tasks");
  mkdirSync(directory, { recursive: true });
  const child = spawn(process.execPath, ["-e", "setTimeout(()=>process.exit(0),100)"], { windowsHide: true, stdio: "ignore" });
  assert.ok(child.pid);
  const record = {
    id: "task_lost", command: process.execPath, args: ["controller"], cwd, pid: child.pid,
    logPath: join(directory, "task_lost.log"), status: "running", startedAt: new Date().toISOString(),
  };
  writeFileSync(record.logPath, "controller started\n");
  writeFileSync(join(directory, `${record.id}.json`), JSON.stringify(record));
  const pi = { sendMessage: () => undefined } as unknown as ExtensionAPI;
  const ctx = { cwd, ui: { notify: () => undefined, setStatus: () => undefined } } as unknown as ExtensionContext;
  const tasks = new ForgeDockBackgroundTasks(pi);
  tasks.initialize(ctx);
  assert.equal(tasks.list().find((candidate) => candidate.id === record.id)?.status, "detached");
  await assert.rejects(tasks.waitForTerminal(record.id), /without a locally observable controller result/);
  assert.equal(tasks.list().find((candidate) => candidate.id === record.id)?.status, "detached");
  await tasks.shutdown();
});
