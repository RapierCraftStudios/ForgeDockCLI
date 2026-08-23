// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ForgeDockBackgroundTasks, NESTED_AGENT_BRIDGE_RESTART_REQUIRED, processIncarnationWitness, TUI_RESTART_TERMINAL_CAUSE } from "./background-tasks.js";
import { ForgeDockObserver } from "../observability/observer.js";
import { SqliteObservationStore } from "../observability/sqlite-store.js";
import { createObservationProducer } from "../observability/contracts.js";

function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), "forgedock-background-"));
  const messages: string[] = [];
  const notifications: string[] = [];
  const statuses: Array<string | undefined> = [];
  const pi = {
    sendMessage: (message: { content: string }) => { messages.push(message.content); },
  } as unknown as ExtensionAPI;
  const ctx = {
    cwd,
    ui: {
      notify: (message: string) => { notifications.push(message); },
      setStatus: (_key: string, value: string | undefined) => { statuses.push(value); },
    },
  } as unknown as ExtensionContext;
  const tasks = new ForgeDockBackgroundTasks(pi);
  tasks.initialize(ctx);
  return { cwd, messages, notifications, statuses, tasks, ctx, pi };
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

test("waitForTerminal resets semantic idle only for correlated semantic observations", async () => {
  const { cwd, messages, tasks, ctx } = fixture();
  const observer = new ForgeDockObserver({ store: new SqliteObservationStore(":memory:"), maxQueueDepth: 32 });
  const producer = createObservationProducer("background-semantic-test");
  tasks.setObservationSink(observer);
  const record = tasks.start({
    command: process.execPath,
    args: ["-e", "setTimeout(()=>process.exit(0),1200)"],
    cwd,
    ctx,
  });
  const waiting = tasks.waitForTerminal(record.id, { warnAfterMs: 1_000 });
  const events = [
    ["workflow", "activity", "workflow.progress"],
    ["agent", "activity", "activity.changed"],
    ["agent", "tool", "tool.progress"],
    ["agent", "tool", "tool.completed"],
    ["agent", "activity", "output.delta"],
    ["artifact", "artifact", "artifact.submitted"],
    ["agent", "activity", "agent.session.progress"],
  ] as const;
  await observer.emit({ producer, identity: { controllerTaskId: record.id }, source: events[0][0], channel: events[0][1], kind: events[0][2], payload: {} });
  for (const [source, channel, kind] of events.slice(1)) {
    await new Promise((resolve) => setTimeout(resolve, 120));
    await observer.emit({ producer, identity: { controllerTaskId: record.id }, source, channel, kind, payload: {} });
  }
  assert.equal((await waiting).status, "completed");
  assert.equal(messages.some((message) => message.includes("no semantic activity")), false);
  await tasks.shutdown();
  observer.close();
});

test("waitForTerminal replays semantic activity before correlated initial-window process noise", async () => {
  const { cwd, messages, tasks, ctx } = fixture();
  const observer = new ForgeDockObserver({ store: new SqliteObservationStore(":memory:"), maxQueueDepth: 32 });
  const producer = createObservationProducer("background-initial-window-test");
  let releaseFirstQuery!: () => void;
  let firstQueryStarted!: () => void;
  const firstQueryGate = new Promise<void>((resolve) => { releaseFirstQuery = resolve; });
  const firstQueryStartedSignal = new Promise<void>((resolve) => { firstQueryStarted = resolve; });
  let isFirstQuery = true;
  tasks.setObservationSink({
    emit: (draft) => observer.emit(draft),
    query: async (query) => {
      if (isFirstQuery) {
        isFirstQuery = false;
        firstQueryStarted();
        await firstQueryGate;
      }
      return observer.query(query);
    },
  });
  const triggerPath = join(cwd, "emit-correlated-noise");
  const record = tasks.start({
    command: process.execPath,
    args: ["-e", "const fs=require('node:fs'); const trigger=process.argv[1]; const timer=setInterval(()=>{if(fs.existsSync(trigger)){clearInterval(timer); process.stdout.write('correlated process noise'); setTimeout(()=>process.exit(0),25)}},1)", triggerPath],
    cwd,
    ctx,
  });
  const waiting = tasks.waitForTerminal(record.id, { warnAfterMs: 100 });
  try {
    await firstQueryStartedSignal;
    await observer.emit({ producer, identity: { controllerTaskId: record.id }, source: "workflow", channel: "activity", kind: "workflow.progress", payload: { phase: "initial-window" } });
    const noiseSeen = new Promise<void>((resolve) => {
      const observedKinds = new Set<string>();
      let unsubscribe: () => void = () => undefined;
      const subscription = observer.subscribe((event) => {
        if (event.identity.controllerTaskId !== record.id) return;
        if (event.kind !== "output.stdout" && event.kind !== "process.exited") return;
        observedKinds.add(event.kind);
        if (observedKinds.size === 2) {
          unsubscribe();
          resolve();
        }
      });
      unsubscribe = subscription.unsubscribe;
    });
    writeFileSync(triggerPath, "go");
    await noiseSeen;
    releaseFirstQuery();
    assert.equal((await waiting).status, "completed");
    assert.equal(messages.some((message) => message.includes("no semantic activity")), false);
  } finally {
    releaseFirstQuery();
    await waiting.catch(() => undefined);
    if (tasks.isOperationallyActive(record.id)) tasks.cancel(record.id);
    await tasks.shutdown();
    observer.close();
  }
});

test("waitForTerminal warns for a long noisy process with no semantic activity", async () => {
  const { cwd, messages, tasks, ctx } = fixture();
  const observer = new ForgeDockObserver({ store: new SqliteObservationStore(":memory:"), maxQueueDepth: 32 });
  const producer = createObservationProducer("background-cursor-test");
  tasks.setObservationSink(observer);
  const record = tasks.start({
    command: process.execPath,
    args: ["-e", "const timer=setInterval(()=>{process.stdout.write('raw stdout\\n'); process.stderr.write('raw stderr\\n')},25); setTimeout(()=>{clearInterval(timer); process.exit(0)},1800)"],
    cwd,
    ctx,
  });
  await observer.emit({ producer, identity: { controllerTaskId: record.id }, source: "workflow", channel: "activity", kind: "workflow.progress", payload: { phase: "before-wait" } });
  const waiting = tasks.waitForTerminal(record.id, { warnAfterMs: 1_250 });
  try {
    await new Promise((resolve) => setTimeout(resolve, 150));
    await observer.emit({ producer, identity: { controllerTaskId: "some-other-controller" }, source: "agent", channel: "activity", kind: "activity.changed", payload: {} });
    await eventually(() => assert.ok(messages.some((message) => message.includes("no semantic activity"))));
    assert.equal(tasks.isOperationallyActive(record.id), true);
    await observer.flush();
    const rawKinds = (await observer.query({ controllerTaskId: record.id, source: "process" })).map((event) => event.kind);
    assert.ok(rawKinds.includes("output.stdout"));
    assert.ok(rawKinds.includes("output.stderr"));
    assert.equal((await waiting).status, "completed");
    const warning = messages.find((message) => message.includes("no semantic activity"));
    assert.match(warning ?? "", new RegExp(record.id));
    assert.doesNotMatch(warning ?? "", /semantic output/i);
  } finally {
    if (tasks.isOperationallyActive(record.id)) tasks.cancel(record.id);
    await waiting.catch(() => undefined);
    await tasks.shutdown();
    observer.close();
  }
});

test("waitForTerminal survives observation query failures", async () => {
  const { cwd, tasks, ctx } = fixture();
  const observer = new ForgeDockObserver({ store: new SqliteObservationStore(":memory:") });
  tasks.setObservationSink({
    emit: (draft) => observer.emit(draft),
    query: async () => { throw new Error("observation database unavailable"); },
  });
  const record = tasks.start({ command: process.execPath, args: ["-e", "setTimeout(()=>process.exit(0),300)"], cwd, ctx });
  assert.equal((await tasks.waitForTerminal(record.id, { warnAfterMs: 50 })).status, "completed");
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

test("successful background tasks surface bounded ForgeDock warnings", async () => {
  const { cwd, messages, tasks, ctx } = fixture();
  const record = tasks.start({
    command: process.execPath,
    args: ["-e", "console.error(['unrelated','stderr'].join(' ')); console.error('ForgeDock warning: advisory review has no required checks')"],
    cwd,
    ctx,
  });

  await eventually(() => assert.equal(tasks.list().find((candidate) => candidate.id === record.id)?.status, "completed"));
  assert.match(messages[0] ?? "", /completed.*ForgeDock warning: advisory review has no required checks/s);
  assert.doesNotMatch(messages[0] ?? "", /unrelated stderr/);
  await tasks.shutdown();
});

test("failed native spawn is consumed without stranding a running task", async () => {
  const { cwd, tasks, ctx } = fixture();
  assert.throws(() => tasks.start({
    command: join(cwd, "missing-forgedock-controller"),
    args: [],
    cwd,
    ctx,
  }), /failed to start/i);

  await new Promise<void>((resolve) => setTimeout(resolve, 25));
  assert.deepEqual(tasks.list(), []);
  await tasks.shutdown();
});

test("native controller launch is idempotent for one orchestration attempt", async () => {
  const { cwd, tasks, ctx, pi } = fixture();
  const launchKey = "dag_launch/node-1/attempt-1";
  const first = tasks.start({
    command: process.execPath,
    args: ["-e", "setTimeout(()=>{},100)"],
    cwd,
    launchKey,
    ctx,
  });
  const adopted = tasks.start({
    command: process.execPath,
    args: ["-e", "throw new Error('duplicate must not start')"],
    cwd,
    launchKey,
    ctx,
  });
  assert.equal(adopted.id, first.id);
  assert.equal(tasks.findByLaunchKey(launchKey)?.id, first.id);
  assert.equal(tasks.list().filter((record) => record.launchKey === launchKey).length, 1);
  await eventually(() => assert.equal(tasks.list().find((record) => record.id === first.id)?.status, "completed"));
  await tasks.shutdown();
  const restarted = new ForgeDockBackgroundTasks(pi);
  restarted.initialize(ctx);
  assert.equal(restarted.findByLaunchKey(launchKey)?.id, first.id);
  await restarted.shutdown();
});

test("an immediately exiting controller is reconciled exactly once", async () => {
  const { cwd, messages, tasks, ctx } = fixture();
  const record = tasks.start({ command: process.execPath, args: ["-e", "process.exit(0)"], cwd, ctx });
  await eventually(() => assert.equal(tasks.list().find((candidate) => candidate.id === record.id)?.status, "completed"));
  assert.equal(messages.filter((message) => message.includes(record.id) && message.includes("completed")).length, 1);
  await tasks.shutdown();
});

test("ordinary exit-2 claim deferrals have no TUI restart cause or wording", async () => {
  const { cwd, messages, tasks, ctx } = fixture();
  const record = tasks.start({
    command: process.execPath,
    args: ["-e", "process.exit(2)"],
    cwd,
    restartRequired: NESTED_AGENT_BRIDGE_RESTART_REQUIRED,
    resumeScope: "orchestration",
    ctx,
  });
  await eventually(() => assert.equal(tasks.list().find((candidate) => candidate.id === record.id)?.status, "blocked"));
  const persisted = JSON.parse(readFileSync(join(cwd, ".forgedock", "tasks", `${record.id}.json`), "utf8")) as Record<string, unknown>;
  assert.equal(persisted.terminalCause, undefined);
  assert.doesNotMatch(tasks.output(record.id), /TUI restart|resume required/i);
  assert.doesNotMatch(messages.filter((message) => message.includes(record.id)).join("\n"), /terminal restart|nested-agent bridge|resume|required checkpoint|forgedock_resume/i);
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

test("non-cancelling shutdown leaves native controllers detached but not adoptable", async () => {
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
  assert.equal(adopter.isOperationallyActive(record.id), false);
  assert.equal(adopter.isPersistedOperationallyActive(record.id), true);
  assert.throws(() => adopter.cancel(record.id), /not supervised/i);
  process.kill(record.pid, "SIGTERM");
  await adopter.shutdown();
});

test("terminal restart leaves a still-live controller external and unresolved", async () => {
  const first = fixture();
  const record = first.tasks.start({
    command: process.execPath,
    args: ["-e", "setInterval(()=>{},1000)"],
    cwd: first.cwd,
    ctx: first.ctx,
  });
  const second = new ForgeDockBackgroundTasks(first.pi);
  second.initialize(first.ctx);
  assert.equal(second.list().find((candidate) => candidate.id === record.id)?.status, "running");
  assert.match(second.output(record.id), /running/);
  assert.equal(second.isOperationallyActive(record.id), false);
  assert.equal(second.isPersistedOperationallyActive(record.id), true);
  assert.throws(() => second.cancel(record.id), /not supervised/i);
  // Keep the original supervisor from overwriting the adopted cancellation
  // when its child exit event arrives.
  first.tasks.cancel(record.id);
  await eventually(() => assert.equal(second.list().find((candidate) => candidate.id === record.id)?.status, "cancelled"));
  await first.tasks.shutdown();
  await second.shutdown();
});

test("terminal presentation does not warn for a bridge-bound controller owned by a live TUI", async () => {
  const first = fixture();
  const record = first.tasks.start({
    command: process.execPath,
    args: ["-e", "setInterval(()=>{},1000)"],
    cwd: first.cwd,
    restartRequired: NESTED_AGENT_BRIDGE_RESTART_REQUIRED,
    resumeScope: "orchestration",
    ctx: first.ctx,
  });
  const second = new ForgeDockBackgroundTasks(first.pi);

  assert.deepEqual(second.pendingRestartRecords(first.ctx), []);
  assert.equal(first.messages.some((message) => message.includes(record.id)), false);
  assert.equal(second.list().find((candidate) => candidate.id === record.id)?.status, "running");
  assert.equal(second.isOperationallyActive(record.id), false);

  first.tasks.cancel(record.id);
  await eventually(() => assert.equal(first.tasks.list().find((candidate) => candidate.id === record.id)?.status, "cancelled"));
  await first.tasks.shutdown();
  await second.shutdown();
});

test("dispatch initialization leaves a live owner's bridge-bound controller untouched", async () => {
  const first = fixture();
  const record = first.tasks.start({
    command: process.execPath,
    args: ["-e", "setInterval(()=>{},1000)"],
    cwd: first.cwd,
    restartRequired: NESTED_AGENT_BRIDGE_RESTART_REQUIRED,
    resumeScope: "work-on",
    ctx: first.ctx,
  });
  const second = new ForgeDockBackgroundTasks(first.pi);
  second.initialize(first.ctx);

  const persisted = JSON.parse(readFileSync(join(first.cwd, ".forgedock", "tasks", `${record.id}.json`), "utf8")) as Record<string, unknown>;
  assert.equal(persisted.status, "running");
  assert.equal(second.list().find((candidate) => candidate.id === record.id)?.status, "running");
  assert.equal(second.isOperationallyActive(record.id), false);
  assert.equal(first.messages.some((message) => message.includes("interrupted during terminal restart")), false);
  assert.doesNotThrow(() => process.kill(record.pid, 0));

  first.tasks.cancel(record.id);
  await eventually(() => assert.equal(first.tasks.list().find((candidate) => candidate.id === record.id)?.status, "cancelled"));
  await first.tasks.shutdown();
  await second.shutdown();
});

test("invariant:matrix-chunk-boundary-93f85b1dae42 restart recovery is UI-only", async () => {
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
  // A graceful owner teardown is the fail-closed handoff boundary. The
  // controller remains alive here so the replacement must prove ownership is
  // gone before terminating it.
  await first.tasks.shutdown({ cancel: false });
  const second = new ForgeDockBackgroundTasks(first.pi);
  second.initialize(first.ctx);

  const persisted = JSON.parse(readFileSync(join(first.cwd, ".forgedock", "tasks", `${record.id}.json`), "utf8")) as Record<string, unknown>;
  assert.equal(persisted.status, "blocked");
  assert.equal(persisted.terminalCause, TUI_RESTART_TERMINAL_CAUSE);
  assert.equal(persisted.restartRequired, NESTED_AGENT_BRIDGE_RESTART_REQUIRED);
  assert.equal(persisted.resumeScope, "orchestration");
  assert.doesNotMatch(JSON.stringify(persisted), /FORGEDOCK_NESTED_AGENT|bridge-secret|45678/);
  assert.deepEqual(second.pendingRestartRecords(first.ctx).map((candidate) => candidate.id), [record.id]);
  assert.equal(second.isOperationallyActive(record.id), false);
  assert.match(second.output(record.id), /resume required after TUI restart/);
  assert.equal(first.messages.some((message) => message.includes(record.id)), false);
  assert.match(first.notifications.at(-1) ?? "", /forgedock_resume_orchestration/);
  await eventually(() => assert.throws(() => process.kill(record.pid, 0)));

  await first.tasks.shutdown({ cancel: false });
  await second.shutdown();
});

test("blocked bridge records without a restart cause stay readable but silent", async () => {
  const { cwd, messages, tasks, ctx } = fixture();
  const directory = join(cwd, ".forgedock", "tasks");
  mkdirSync(directory, { recursive: true });
  const id = "task_old_blocked_bridge";
  writeFileSync(join(directory, `${id}.json`), JSON.stringify({
    id,
    command: process.execPath,
    args: ["controller"],
    cwd,
    pid: 999_999_999,
    logPath: join(directory, `${id}.log`),
    status: "blocked",
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    exitCode: 2,
    restartRequired: NESTED_AGENT_BRIDGE_RESTART_REQUIRED,
    resumeScope: "orchestration",
  }));

  assert.deepEqual(tasks.pendingRestartRecords(ctx), []);
  const record = tasks.list().find((candidate) => candidate.id === id);
  assert.equal(record?.status, "blocked");
  assert.doesNotMatch(tasks.output(id), /TUI restart|resume required/i);
  if (record) tasks.announceRestartRequired(record);
  assert.equal(messages.some((message) => message.includes(id)), false);
  await tasks.shutdown();
});

test("older bridge-bound records without a resume scope remain parseable", async () => {
  const { cwd, messages, notifications, tasks, ctx } = fixture();
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
  assert.equal(tasks.list().find((record) => record.id === id)?.terminalCause, TUI_RESTART_TERMINAL_CAUSE);
  assert.equal(messages.length, 0);
  assert.doesNotMatch(notifications.at(-1) ?? "", /forgedock_resume_orchestration/);
  assert.match(notifications.at(-1) ?? "", /owning workflow checkpoint/);
  await tasks.shutdown();
});

test("restart guidance matches each controller recovery contract", async () => {
  const cases = [
    { scope: "work-on" as const, expected: /work-on checkpoint/, forbidden: /not resumable|promotion checkpoint/ },
    { scope: "review-pr-rerun" as const, expected: /not resumable.*\/review-pr/, forbidden: /checkpoint is preserved/ },
    { scope: "promote" as const, expected: /promotion checkpoint.*promotionId/i, forbidden: /not resumable|work-on checkpoint/ },
  ];
  for (const [index, scenario] of cases.entries()) {
    const { cwd, notifications, tasks, ctx } = fixture();
    const directory = join(cwd, ".forgedock", "tasks");
    mkdirSync(directory, { recursive: true });
    const id = `task_scope_${index}`;
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
      resumeScope: scenario.scope,
    }));
    tasks.initialize(ctx);
    const message = notifications.at(-1) ?? "";
    assert.match(message, scenario.expected);
    assert.doesNotMatch(message, scenario.forbidden);
    await tasks.shutdown();
  }
});

test("a replacement supervisor preserves the original supervisor's durable completion result", async () => {
  const first = fixture();
  const record = first.tasks.start({
    command: process.execPath,
    args: ["-e", "setTimeout(()=>process.exit(0),100)"],
    cwd: first.cwd,
    ctx: first.ctx,
  });
  const second = new ForgeDockBackgroundTasks(first.pi);
  second.initialize(first.ctx);
  assert.equal(second.list().find((candidate) => candidate.id === record.id)?.status, "running");
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
  assert.equal(tasks.list().find((candidate) => candidate.id === record.id)?.status, "running");
  await assert.rejects(tasks.waitForTerminal(record.id), /without a locally observable controller result/);
  assert.equal(tasks.list().find((candidate) => candidate.id === record.id)?.status, "detached");
  await tasks.shutdown();
});

test("persisted PID reuse evidence fails closed for adoption and cancellation", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "forgedock-background-pid-reuse-"));
  const directory = join(cwd, ".forgedock", "tasks");
  mkdirSync(directory, { recursive: true });
  const id = "task_pid_reuse";
  const record = {
    id,
    command: process.execPath,
    args: ["controller"],
    cwd,
    pid: process.pid,
    // Deliberately identify a different incarnation of this live PID.
    processIncarnation: "proc-start:an-old-incarnation",
    logPath: join(directory, `${id}.log`),
    status: "detached" as const,
    startedAt: new Date().toISOString(),
  };
  writeFileSync(join(directory, `${id}.json`), JSON.stringify(record));
  const pi = { sendMessage: () => undefined } as unknown as ExtensionAPI;
  const ctx = { cwd, ui: { notify: () => undefined, setStatus: () => undefined } } as unknown as ExtensionContext;
  const tasks = new ForgeDockBackgroundTasks(pi);
  tasks.initialize(ctx);
  assert.equal(tasks.isOperationallyActive(id), false);
  // A mismatched witness is unresolved external evidence until the PID exits;
  // capacity remains conservatively occupied and stop must not signal it.
  assert.equal(tasks.isPersistedOperationallyActive(id), true);
  assert.equal(tasks.cancelPersisted(id).status, "detached");
  assert.equal(tasks.list().find((candidate) => candidate.id === id)?.status, "detached");
  await tasks.shutdown();
});

test("Linux process witnesses bind boot, session, and start identities", () => {
  if (process.platform !== "linux") return;
  assert.match(processIncarnationWitness(process.pid) ?? "", /^proc-boot:[^:]+:session:\d+:start:\d+$/);
});

test("legacy live bridge records remain unresolved until their PID exits", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "forgedock-background-legacy-live-"));
  const directory = join(cwd, ".forgedock", "tasks");
  mkdirSync(directory, { recursive: true });
  const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { windowsHide: true, stdio: "ignore" });
  assert.ok(child.pid);
  const id = "task_legacy_live";
  writeFileSync(join(directory, `${id}.json`), JSON.stringify({
    id,
    command: process.execPath,
    args: ["controller"],
    cwd,
    pid: child.pid,
    logPath: join(directory, `${id}.log`),
    status: "running",
    startedAt: new Date().toISOString(),
    restartRequired: NESTED_AGENT_BRIDGE_RESTART_REQUIRED,
    resumeScope: "orchestration",
  }));
  const pi = { sendMessage: () => undefined } as unknown as ExtensionAPI;
  const ctx = { cwd, ui: { notify: () => undefined, setStatus: () => undefined } } as unknown as ExtensionContext;
  const tasks = new ForgeDockBackgroundTasks(pi);
  tasks.initialize(ctx);
  assert.equal(tasks.list().find((record) => record.id === id)?.status, "running");
  assert.equal(tasks.list().find((record) => record.id === id)?.terminalCause, undefined);
  assert.equal(tasks.isPersistedOperationallyActive(id), true);
  child.kill("SIGTERM");
  await new Promise<void>((resolve) => child.once("exit", () => resolve()));
  tasks.initialize(ctx);
  assert.equal(tasks.list().find((record) => record.id === id)?.status, "blocked");
  assert.equal(tasks.list().find((record) => record.id === id)?.terminalCause, TUI_RESTART_TERMINAL_CAUSE);
  await tasks.shutdown();
});

test("unsupported process witnesses retain live persisted tasks without signaling", async () => {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
  const cwd = mkdtempSync(join(tmpdir(), "forgedock-background-unsupported-"));
  const directory = join(cwd, ".forgedock", "tasks");
  mkdirSync(directory, { recursive: true });
  const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { windowsHide: true, stdio: "ignore" });
  assert.ok(child.pid);
  try {
    Object.defineProperty(process, "platform", { configurable: true, value: "freebsd" });
    assert.equal(processIncarnationWitness(child.pid), undefined);
    const id = "task_unsupported_live";
    writeFileSync(join(directory, `${id}.json`), JSON.stringify({
      id, command: process.execPath, args: ["controller"], cwd, pid: child.pid,
      logPath: join(directory, `${id}.log`), status: "running", startedAt: new Date().toISOString(),
    }));
    const pi = { sendMessage: () => undefined } as unknown as ExtensionAPI;
    const ctx = { cwd, ui: { notify: () => undefined, setStatus: () => undefined } } as unknown as ExtensionContext;
    const tasks = new ForgeDockBackgroundTasks(pi);
    tasks.initialize(ctx);
    assert.equal(tasks.list().find((record) => record.id === id)?.status, "running");
    assert.equal(tasks.isPersistedOperationallyActive(id), true);
    assert.equal(tasks.cancelPersisted(id).status, "running");
    await tasks.shutdown();
  } finally {
    child.kill("SIGTERM");
    await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    if (originalPlatform) Object.defineProperty(process, "platform", originalPlatform);
  }
});
