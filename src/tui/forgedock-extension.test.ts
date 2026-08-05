// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionCommandContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { readForgeDockConfig } from "../core/config/forgedock-config.js";
import forgedockExtension, { executeController, isLifecycleControllerShellCommand } from "./forgedock-extension.js";
import { buildNativeCommandPrompt, resolveIssueWorkerRecovery, resolveModelReference, VisibleDagDelegator } from "./forgedock-tools.js";

interface FakePiState {
  pi: ExtensionAPI;
  tools: Map<string, ToolDefinition>;
  commands: Map<string, (args: string, ctx: ExtensionCommandContext) => Promise<void>>;
  handlers: Map<string, Array<(event: any, ctx?: any) => unknown>>;
  sent: Array<{ content: string; options?: { deliverAs?: "steer" | "followUp" } }>;
  active: string[];
  emitted: Array<{ event: string; data: any }>;
}

function fakePi(initialActive = ["read", "bash", "subagent", "subagent_wait", "subagent_supervisor"]): FakePiState {
  const tools = new Map<string, ToolDefinition>();
  const commands = new Map<string, (args: string, ctx: ExtensionCommandContext) => Promise<void>>();
  const handlers = new Map<string, Array<(event: any, ctx?: any) => unknown>>();
  const sent: FakePiState["sent"] = [];
  const emitted: FakePiState["emitted"] = [];
  let active = [...initialActive];
  const eventHandlers = new Map<string, Array<(data: unknown) => void>>();
  const state = {} as FakePiState;
  const pi = {
    on: (name: string, handler: (event: any, ctx?: any) => unknown) => {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
    registerTool: (tool: ToolDefinition) => { tools.set(tool.name, tool); },
    registerCommand: (name: string, options: { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }) => {
      commands.set(name, options.handler);
    },
    sendUserMessage: (content: string, options?: { deliverAs?: "steer" | "followUp" }) => {
      sent.push(options ? { content, options } : { content });
    },
    sendMessage: (message: { content: string }) => {
      sent.push({ content: message.content });
    },
    getActiveTools: () => active,
    setActiveTools: (names: string[]) => { active = names; state.active = names; },
    events: {
      on: (name: string, handler: (data: unknown) => void) => {
        eventHandlers.set(name, [...(eventHandlers.get(name) ?? []), handler]);
        return () => eventHandlers.set(name, (eventHandlers.get(name) ?? []).filter((candidate) => candidate !== handler));
      },
      emit: (name: string, data: unknown) => {
        emitted.push({ event: name, data });
        for (const handler of eventHandlers.get(name) ?? []) handler(data);
      },
    },
  } as unknown as ExtensionAPI;
  Object.assign(state, { pi, tools, commands, handlers, sent, active, emitted });
  forgedockExtension(pi);
  return state;
}

function commandContext(idle = true): ExtensionCommandContext {
  return {
    cwd: process.cwd(),
    model: { provider: "openai-codex", id: "gpt-test" },
    isIdle: () => idle,
    hasUI: true,
    ui: {
      confirm: async () => true,
      notify: () => undefined,
      setStatus: () => undefined,
    },
  } as unknown as ExtensionCommandContext;
}

test("commands lazily activate separate semantic native tools without loading Markdown specs", async () => {
  const state = fakePi();
  assert.deepEqual(
    [...state.tools.keys()].sort(),
    ["forgedock_ask_user", "forgedock_configure", "forgedock_memory_search", "forgedock_orchestrate", "forgedock_remember", "forgedock_resume_orchestration", "forgedock_review_pr", "forgedock_status", "forgedock_tasks", "forgedock_work_on"],
  );

  await state.handlers.get("session_start")?.[0]?.({}, { mode: "json", cwd: process.cwd(), ui: {} });
  assert.deepEqual(state.active, ["read", "bash", "forgedock_configure", "forgedock_remember", "forgedock_memory_search", "forgedock_tasks", "forgedock_resume_orchestration"]);

  await state.commands.get("orchestrate")?.("all open enhancement issues --dry-run", commandContext());
  assert.equal(state.sent.length, 1);
  assert.match(state.sent[0]?.content ?? "", /resolve it to a concrete eligible issue-number set/);
  assert.match(state.sent[0]?.content ?? "", /call forgedock_orchestrate exactly once/);
  assert.match(state.sent[0]?.content ?? "", /execution DAG/);
  assert.match(state.sent[0]?.content ?? "", /Automatic merge .* is the default/);
  assert.doesNotMatch(state.sent[0]?.content ?? "", /commands\/orchestrate\.md|command spec at/);
  assert.deepEqual(state.active, ["read", "bash", "forgedock_configure", "forgedock_remember", "forgedock_memory_search", "forgedock_tasks", "forgedock_resume_orchestration", "forgedock_orchestrate"]);
});

test("natural configuration resolves a friendly live model name for all subagents", async () => {
  const state = fakePi();
  const cwd = mkdtempSync(join(tmpdir(), "forgedock-model-config-"));
  const models = [
    { provider: "openai-codex", id: "gpt-5.6-luna", name: "GPT-5.6 Luna" },
    { provider: "openai-codex", id: "gpt-5.6-sol", name: "GPT-5.6 Sol" },
  ];
  try {
    const tool = state.tools.get("forgedock_configure");
    assert.ok(tool);
    await tool.execute("config-1", {
      subagentModel: "Luna 5.6",
      subagentThinking: "max",
    }, undefined, undefined, {
      ...commandContext(),
      cwd,
      hasUI: false,
      modelRegistry: { getAvailable: () => models, getAll: () => models },
    } as any);
    assert.deepEqual(readForgeDockConfig(cwd), {
      workerModel: "openai-codex/gpt-5.6-luna",
      workerThinking: "max",
      reviewerModel: "openai-codex/gpt-5.6-luna",
      reviewerThinking: "max",
    });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("model configuration rejects installed models without available authentication", () => {
  const unavailable = { provider: "example", id: "luna-5.6" };
  assert.throws(() => resolveModelReference("example/luna-5.6", {
    modelRegistry: { getAvailable: () => [], getAll: () => [unavailable] },
  } as any), /installed but unavailable/);
});

test("runtime diagnostic verifies the real bundled subagent RPC bridge", async () => {
  const state = fakePi();
  const notices: string[] = [];
  const originalEmit = state.pi.events.emit.bind(state.pi.events);
  state.pi.events.emit = ((name: string, data: any) => {
    originalEmit(name, data);
    if (name === "subagents:rpc:v1:request" && data.method === "ping") {
      queueMicrotask(() => originalEmit(`subagents:rpc:v1:reply:${data.requestId}`, {
        version: 1,
        requestId: data.requestId,
        success: true,
        data: { version: 1, capabilities: { asyncSpawn: true, fleetStatus: { version: 1 } } },
      }));
    }
  }) as typeof state.pi.events.emit;
  const previous = process.env.FORGEDOCK_RUNTIME_ROOT;
  process.env.FORGEDOCK_RUNTIME_ROOT = "C:/checkout/forgedock";
  try {
    const ctx = commandContext() as any;
    ctx.ui.notify = (message: string) => notices.push(message);
    await state.commands.get("forgedock-runtime")?.("", ctx);
  } finally {
    if (previous === undefined) delete process.env.FORGEDOCK_RUNTIME_ROOT;
    else process.env.FORGEDOCK_RUNTIME_ROOT = previous;
  }
  assert.match(notices[0] ?? "", /semantic-tools\+live-subagents-v2/);
  assert.match(notices[0] ?? "", /Bundled subagents: ready/);
  assert.match(notices[0] ?? "", /C:\/checkout\/forgedock/);
});

test("idle TUI does not reserve space for a persistent ForgeDock help widget", async () => {
  const state = fakePi();
  const widgets: string[] = [];
  await state.handlers.get("session_start")?.[0]?.({}, {
    mode: "tui",
    cwd: process.cwd(),
    hasUI: true,
    ui: {
      setTitle: () => undefined,
      setStatus: () => undefined,
      setWidget: (key: string) => widgets.push(key),
    },
  });
  assert.deepEqual(widgets, []);
});

test("busy sessions queue native workflow intent as a follow-up", async () => {
  const state = fakePi();
  await state.commands.get("work-on")?.("42", commandContext(false));
  assert.deepEqual(state.sent[0]?.options, { deliverAs: "followUp" });
});

test("supervisor escalations lazily expose decision-interview and reply tools", async () => {
  const state = fakePi();
  await state.handlers.get("session_start")?.[0]?.({}, { mode: "json", cwd: process.cwd(), ui: {} });
  await state.handlers.get("message_start")?.[0]?.({
    message: { role: "custom", customType: "subagent_supervisor_request" },
  });
  assert.deepEqual(state.active, ["read", "bash", "forgedock_configure", "forgedock_remember", "forgedock_memory_search", "forgedock_tasks", "forgedock_resume_orchestration", "forgedock_ask_user", "subagent_supervisor"]);
});

test("human checkpoints use the tabbed decision interview and return typed answers", async () => {
  const state = fakePi();
  const screens: string[] = [];
  const ctx = {
    ...commandContext(),
    mode: "tui",
    ui: {
      setWorkingVisible: () => undefined,
      custom: async (factory: (...args: any[]) => any) => {
        let completed: unknown;
        const component = factory(
          { requestRender: () => undefined },
          {
            fg: (_color: string, text: string) => text,
            bg: (_color: string, text: string) => text,
            bold: (text: string) => text,
          },
          {},
          (value: unknown) => { completed = value; },
        );
        screens.push(component.render(80).join("\n"));
        component.handleInput("1");
        screens.push(component.render(80).join("\n"));
        component.handleInput("1");
        return completed;
      },
    },
  } as any;
  const tool = state.tools.get("forgedock_ask_user");
  assert.ok(tool);
  const result = await tool.execute("decision-1", {
    title: "Choose rollout",
    questions: [{
      id: "rollout",
      label: "Rollout",
      prompt: "How should this ship?",
      type: "single",
      options: [
        { value: "safe", label: "Canary", description: "Limits blast radius" },
        { value: "fast", label: "Immediate", description: "Finishes sooner with more risk" },
      ],
      recommendedValue: "safe",
      recommendation: "Canary has bounded impact.",
    }],
  }, undefined, undefined, ctx);
  assert.match(screens[0] ?? "", /★ Recommended: Canary/);
  assert.match(screens[0] ?? "", /Canary has bounded impact/);
  assert.match(screens[1] ?? "", /Review your decisions/);
  assert.match((result.content[0] as { text: string }).text, /rollout: Canary/);
  assert.deepEqual((result.details as { answers: Record<string, { values: string[] }> }).answers.rollout?.values, ["safe"]);
});

test("decision interviews normalize stored legacy single-question calls", () => {
  const tool = fakePi().tools.get("forgedock_ask_user");
  assert.ok(tool?.prepareArguments);
  const normalized = tool.prepareArguments!({
    title: "Legacy",
    question: "Choose?",
    options: [
      { id: "a", label: "A", description: "First" },
      { id: "b", label: "B", description: "Second" },
    ],
    recommendedId: "a",
    recommendation: "A is safer.",
  }) as { questions: Array<{ id: string; recommendedValue: string; options: Array<{ value: string }> }> };
  assert.equal(normalized.questions[0]?.id, "decision");
  assert.equal(normalized.questions[0]?.recommendedValue, "a");
  assert.deepEqual(normalized.questions[0]?.options.map((option) => option.value), ["a", "b"]);
});

test("ForgeDock issue children receive only the typed mutation tool", async () => {
  const previous = process.env.PI_SUBAGENT_CHILD_AGENT;
  process.env.PI_SUBAGENT_CHILD_AGENT = "forgedock-issue-worker";
  try {
    const state = fakePi(["forgedock_work_on", "contact_supervisor", "subagent_supervisor"]);
    await state.handlers.get("session_start")?.[0]?.({}, { mode: "json", ui: {} });
    assert.deepEqual(state.active, ["contact_supervisor", "forgedock_work_on"]);
    assert.ok(!state.active.includes("subagent"));
  } finally {
    if (previous === undefined) delete process.env.PI_SUBAGENT_CHILD_AGENT;
    else process.env.PI_SUBAGENT_CHILD_AGENT = previous;
  }
});

test("orchestrate starts only the live DAG ready set without static batch phases", async () => {
  const state = fakePi();
  const spawnRequests: any[] = [];
  const originalEmit = state.pi.events.emit.bind(state.pi.events);
  state.pi.events.emit = ((name: string, data: any) => {
    originalEmit(name, data);
    if (name === "subagents:rpc:v1:request" && data.method === "spawn") {
      spawnRequests.push(data);
      queueMicrotask(() => originalEmit(`subagents:rpc:v1:reply:${data.requestId}`, {
        version: 1,
        requestId: data.requestId,
        success: true,
        data: { text: "started", details: { asyncId: `test-run-${spawnRequests.length}` } },
      }));
    }
  }) as typeof state.pi.events.emit;

  const previous = process.env.FORGEDOCK_CONTROLLER_ENTRY;
  process.env.FORGEDOCK_CONTROLLER_ENTRY = "C:/Forge Dock/bin/forgedock-next.mjs";
  try {
    const tool = state.tools.get("forgedock_orchestrate");
    assert.ok(tool);
    const result = await tool.execute("call-1", {
      issueNumbers: [7, 8],
      executionPlan: [
        { issue: 7, title: "Seven", summary: "Implement the accepted bounded behavior.", priority: 1, dependsOn: [], claims: ["src/core"], labels: ["workflow:building"] },
        { issue: 8, title: "Eight", summary: "Consume Seven's completed behavior.", priority: 2, dependsOn: [7], claims: ["src/api"] },
      ],
      maxParallel: 2,
      workerModel: "openai-codex/gpt-worker",
    }, undefined, undefined, commandContext() as any);
    assert.match((result.content[0] as { text: string }).text, /started streaming DAG/);
    assert.match((result.content[0] as { text: string }).text, /Initial ready set: #7/);
    assert.match((result.content[0] as { text: string }).text, /DAG nodes: 2/);
    assert.doesNotMatch((result.content[0] as { text: string }).text, /visible batch|Batch 1/);
  } finally {
    if (previous === undefined) delete process.env.FORGEDOCK_CONTROLLER_ENTRY;
    else process.env.FORGEDOCK_CONTROLLER_ENTRY = previous;
  }

  assert.equal(spawnRequests.length, 1);
  const spawnRequest = spawnRequests[0];
  assert.equal(spawnRequest.method, "spawn");
  assert.equal(spawnRequest.params.async, true);
  assert.equal(spawnRequest.params.agent, "forgedock-issue-worker");
  assert.match(spawnRequest.params.model, /^openai-codex\/gpt-worker(?::[a-z]+)?$/);
  assert.equal(spawnRequest.params.chain, undefined);
  assert.match(spawnRequest.params.task, /forgedock_work_on.*\{"issue":7,"dependencies":\[\]/);
  assert.match(spawnRequest.params.task, /"autoMerge":true/);
  assert.match(spawnRequest.params.task, /"resume":true/);
  assert.match(spawnRequest.params.task, /Implement the accepted bounded behavior/);
  assert.match(spawnRequest.params.task, /contact_supervisor/);
});

test("headless orchestration requires explicit dispatch authorization", async () => {
  const state = fakePi();
  const tool = state.tools.get("forgedock_orchestrate");
  assert.ok(tool);
  await assert.rejects(() => tool.execute("headless", {
    issueNumbers: [7],
    executionPlan: [{ issue: 7, title: "Seven", summary: "Deliver Seven", dependsOn: [], claims: ["src/a"], labels: [] }],
  }, undefined, undefined, { ...commandContext(), hasUI: false } as any), /requires explicit confirmed=true/);
});

test("visible DAG delegation dispatches a successor on its predecessor completion event", async () => {
  const state = fakePi();
  const launched: number[] = [];
  const originalEmit = state.pi.events.emit.bind(state.pi.events);
  state.pi.events.emit = ((name: string, data: any) => {
    originalEmit(name, data);
    if (name === "subagents:rpc:v1:request" && data.method === "spawn") {
      const issue = Number(/issue #(\d+)/.exec(data.params.task)?.[1]);
      launched.push(issue);
      queueMicrotask(() => originalEmit(`subagents:rpc:v1:reply:${data.requestId}`, {
        version: 1, requestId: data.requestId, success: true,
        data: { details: { asyncId: `run-${issue}` } },
      }));
    }
  }) as typeof state.pi.events.emit;
  const delegator = new VisibleDagDelegator(state.pi);
  const completed: number[] = [];
  const run = await delegator.start({
    items: [
      { id: "issue-1", issue: 1, title: "One", summary: "One", priority: 1, dependencies: [], claims: [], labels: [], affectedFiles: [], memberIssues: [1] },
      { id: "issue-2", issue: 2, title: "Two", summary: "Two", priority: 1, dependencies: ["issue-1"], claims: [], labels: [], affectedFiles: [], memberIssues: [2] },
    ],
    maxParallel: 2,
    taskFor: (item) => ({ agent: "forgedock-issue-worker", task: `Deliver issue #${item.issue}`, cwd: process.cwd() }),
    assertCompleted: async (item) => { completed.push(item.issue); },
    onComplete: () => undefined,
  });
  assert.deepEqual(launched, [1]);
  originalEmit("subagent:async-complete", { runId: "run-1" });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(launched, [1, 2]);
  originalEmit("subagent:async-complete", { runId: "run-2" });
  await run.completion;
  assert.deepEqual(completed, [1, 2]);
  await delegator.shutdown();
});

test("fresh-rerun authorization cannot be converted back into checkpoint resume", () => {
  assert.deepEqual(resolveIssueWorkerRecovery(["needs-human"], false, "rerun"), { rerun: true, resume: false });
  assert.deepEqual(resolveIssueWorkerRecovery(["workflow:engine-error"], true, "initial"), { rerun: true, resume: false });
  assert.deepEqual(resolveIssueWorkerRecovery([], false, "resume"), { rerun: false, resume: true });
});

test("visible DAG resume retries failed nodes without replaying completed nodes", async () => {
  const state = fakePi();
  const launched: string[] = [];
  const originalEmit = state.pi.events.emit.bind(state.pi.events);
  state.pi.events.emit = ((name: string, data: any) => {
    originalEmit(name, data);
    if (name === "subagents:rpc:v1:request" && data.method === "spawn") {
      const runId = `retry-run-${launched.length + 1}`;
      launched.push(runId);
      queueMicrotask(() => originalEmit(`subagents:rpc:v1:reply:${data.requestId}`, {
        version: 1, requestId: data.requestId, success: true, data: { details: { asyncId: runId } },
      }));
    }
  }) as typeof state.pi.events.emit;
  const delegator = new VisibleDagDelegator(state.pi);
  let assertions = 0;
  const results: string[] = [];
  const recoveryModes: string[] = [];
  const first = await delegator.start({
    items: [{ id: "issue-6", issue: 6, title: "Six", summary: "Six", priority: 1, dependencies: [], claims: [], labels: [], affectedFiles: [], memberIssues: [6] }],
    maxParallel: 1,
    taskFor: (item, recovery) => {
      recoveryModes.push(recovery);
      return { agent: "forgedock-issue-worker", task: `Deliver issue #${item.issue}`, cwd: process.cwd() };
    },
    assertCompleted: async () => {
      assertions++;
      if (assertions === 1) throw new Error("interrupted build");
    },
    onComplete: (result) => results.push(result.status.get("issue-6") ?? "missing"),
  });
  originalEmit("subagent:async-complete", { runId: "retry-run-1" });
  await first.completion;
  assert.deepEqual(results, ["failed"]);

  const resumed = await delegator.resume(first.id);
  originalEmit("subagent:async-complete", { runId: "retry-run-2" });
  await resumed.completion;
  assert.deepEqual(launched, ["retry-run-1", "retry-run-2"]);
  assert.deepEqual(recoveryModes, ["initial", "resume"]);
  assert.deepEqual(results, ["failed", "completed"]);
  await delegator.shutdown();
});

test("visible DAG recovery applies an explicitly authorized fresh rerun to the failed issue", async () => {
  const state = fakePi();
  const originalEmit = state.pi.events.emit.bind(state.pi.events);
  let launches = 0;
  state.pi.events.emit = ((name: string, data: any) => {
    originalEmit(name, data);
    if (name === "subagents:rpc:v1:request" && data.method === "spawn") {
      const runId = `rerun-override-${++launches}`;
      queueMicrotask(() => originalEmit(`subagents:rpc:v1:reply:${data.requestId}`, {
        version: 1, requestId: data.requestId, success: true, data: { details: { asyncId: runId } },
      }));
    }
  }) as typeof state.pi.events.emit;
  const delegator = new VisibleDagDelegator(state.pi);
  const recoveryModes: string[] = [];
  let assertions = 0;
  const first = await delegator.start({
    items: [{ id: "issue-6", issue: 6, title: "Six", summary: "Six", priority: 1, dependencies: [], claims: [], labels: ["needs-human"], affectedFiles: [], memberIssues: [6] }],
    maxParallel: 1,
    taskFor: (_item, recovery) => {
      recoveryModes.push(recovery);
      return { agent: "forgedock-issue-worker", task: "Deliver issue #6", cwd: process.cwd() };
    },
    assertCompleted: async () => {
      if (++assertions === 1) throw new Error("checkpoint is not recoverable");
    },
    onComplete: () => undefined,
  });
  originalEmit("subagent:async-complete", { runId: "rerun-override-1" });
  await first.completion;

  const resumed = await delegator.resume(first.id, { rerunIssueNumbers: [6] });
  originalEmit("subagent:async-complete", { runId: "rerun-override-2" });
  await resumed.completion;
  assert.deepEqual(recoveryModes, ["initial", "rerun"]);
  await assert.rejects(() => delegator.resume(first.id, { rerunIssueNumbers: [99] }), /already complete|does not match/);
  await delegator.shutdown();
});

test("controller subprocess output streams before completion", async () => {
  const updates: string[] = [];
  const result = await executeController(
    process.execPath,
    ["-e", "process.stdout.write('first\\n'); setTimeout(() => process.stdout.write('second\\n'), 20)"],
    process.cwd(),
    undefined,
    (output) => updates.push(output),
  );
  assert.equal(result.code, 0);
  assert.match(result.stdout, /first/);
  assert.match(result.stdout, /second/);
  assert.ok(updates.some((output) => output.includes("first")));
  assert.ok(updates.some((output) => output.includes("second")));
});

test("controller subprocess does not inherit the invoking worker role", async () => {
  const previous = process.env.PI_SUBAGENT_CHILD_AGENT;
  process.env.PI_SUBAGENT_CHILD_AGENT = "forgedock-issue-worker";
  try {
    const result = await executeController(
      process.execPath,
      ["-e", "process.stdout.write(process.env.PI_SUBAGENT_CHILD_AGENT ?? 'clean')"],
      process.cwd(),
      undefined,
      () => undefined,
    );
    assert.equal(result.code, 0);
    assert.equal(result.stdout, "clean");
  } finally {
    if (previous === undefined) delete process.env.PI_SUBAGENT_CHILD_AGENT;
    else process.env.PI_SUBAGENT_CHILD_AGENT = previous;
  }
});

test("work-on rejects contradictory fresh-rerun and checkpoint-resume policies", async () => {
  const state = fakePi();
  const ctx = commandContext() as any;
  await state.handlers.get("session_start")?.[0]?.({}, ctx);
  const tool = state.tools.get("forgedock_work_on");
  assert.ok(tool);
  await assert.rejects(tool.execute("conflicting-recovery", { issue: 6, rerun: true, resume: true }, undefined, undefined, ctx), /mutually exclusive/);
});

test("direct work-on defaults to a native non-blocking controller task", async () => {
  const root = mkdtempSync(join(tmpdir(), "forgedock-tool-background-"));
  const entry = join(root, "controller.mjs");
  writeFileSync(entry, "setTimeout(() => console.log('controller done'), 50);\n");
  const state = fakePi();
  const ctx = { ...commandContext(), cwd: root, mode: "rpc" } as any;
  await state.handlers.get("session_start")?.[0]?.({}, ctx);
  const previous = process.env.FORGEDOCK_CONTROLLER_ENTRY;
  process.env.FORGEDOCK_CONTROLLER_ENTRY = entry;
  try {
    const tool = state.tools.get("forgedock_work_on");
    assert.ok(tool);
    const started = Date.now();
    const result = await tool.execute("background-work", { issue: 20 }, undefined, undefined, ctx);
    assert.ok(Date.now() - started < 1_000);
    const details = result.details as { taskId?: string; state?: string; args?: string[] };
    assert.equal(details.state, "delegated");
    assert.ok(details.args?.includes("--auto-merge"));
    assert.match(details.taskId ?? "", /^task_/);
    const tasks = state.tools.get("forgedock_tasks");
    assert.ok(tasks);
    for (let attempt = 0; attempt < 100; attempt++) {
      const listed = await tasks.execute("list", { action: "list" }, undefined, undefined, ctx);
      const records = (listed.details as { records: Array<{ id: string; status: string }> }).records;
      if (records.find((record) => record.id === details.taskId)?.status === "completed") break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const listed = await tasks.execute("list-final", { action: "list" }, undefined, undefined, ctx);
    assert.equal((listed.details as { records: Array<{ id: string; status: string }> }).records.find((record) => record.id === details.taskId)?.status, "completed");
  } finally {
    await state.handlers.get("session_shutdown")?.[0]?.({}, ctx);
    if (previous === undefined) delete process.env.FORGEDOCK_CONTROLLER_ENTRY;
    else process.env.FORGEDOCK_CONTROLLER_ENTRY = previous;
  }
});

test("missing reviewer probe paths remain evidence instead of failing the review process", () => {
  const state = fakePi();
  forgedockExtension(state.pi);
  const handler = state.handlers.get("tool_result")?.[0];
  assert.ok(handler);
  const previous = process.env.PI_SUBAGENT_CHILD_AGENT;
  process.env.PI_SUBAGENT_CHILD_AGENT = "forgedock-reviewer";
  try {
    const result = handler({
      toolName: "read",
      isError: true,
      content: [{ type: "text", text: "ENOENT: no such file or directory, access 'workflows/missing.yml'" }],
    });
    assert.deepEqual(result, {
      isError: false,
      content: [{ type: "text", text: "File does not exist at the requested path. Treat absence as review evidence and continue with ls/find rather than failing the review." }],
    });
    assert.equal(handler({ toolName: "read", isError: true, content: [{ type: "text", text: "EACCES: permission denied" }] }), undefined);
  } finally {
    if (previous === undefined) delete process.env.PI_SUBAGENT_CHILD_AGENT;
    else process.env.PI_SUBAGENT_CHILD_AGENT = previous;
  }
});

test("shell fallback cannot impose a wall-clock timeout on lifecycle controllers", () => {
  const state = fakePi();
  forgedockExtension(state.pi);
  const guard = state.handlers.get("tool_call")?.[0];
  assert.ok(guard);
  const blocked = guard({ toolName: "bash", input: { command: "node dist/cli/main.js work-on 6 --rerun" } });
  assert.deepEqual(blocked, {
    block: true,
    reason: "ForgeDock lifecycle controllers cannot be launched through the shell tool or bounded by its wall-clock timeout. Use the active semantic workflow, resume, task-status, or cancellation tool instead.",
  });
  assert.equal(guard({ toolName: "bash", input: { command: "node dist/cli/main.js status --issue 6" } }), undefined);
  assert.equal(guard({ toolName: "bash", input: { command: "npm test" } }), undefined);
  assert.equal(isLifecycleControllerShellCommand("forgedock-next orchestrate 6,7"), true);
  assert.equal(isLifecycleControllerShellCommand("npm run next -- work-on 6 --rerun"), true);
});

test("native command prompts preserve natural-language intent", () => {
  const prompt = buildNativeCommandPrompt("orchestrate", "all open issues except blocked");
  assert.match(prompt, /\/orchestrate all open issues except blocked/);
  assert.match(prompt, /concrete eligible issue-number set/);
  assert.match(prompt, /Never invoke forgedock-next, dist\/cli\/main\.js, or another lifecycle controller through bash\/shell/);
  assert.match(buildNativeCommandPrompt("work-on", "6 --resume"), /Never invoke the lifecycle CLI through bash\/shell or add a wall-clock timeout/);
  assert.doesNotMatch(prompt, /invocationToken|\.md/);
});
