// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionCommandContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import forgedockExtension, { executeController } from "./forgedock-extension.js";
import { buildNativeCommandPrompt } from "./forgedock-tools.js";

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
    ["forgedock_ask_user", "forgedock_configure", "forgedock_memory_search", "forgedock_orchestrate", "forgedock_remember", "forgedock_review_pr", "forgedock_status", "forgedock_work_on"],
  );

  await state.handlers.get("session_start")?.[0]?.({}, { mode: "json", ui: {} });
  assert.deepEqual(state.active, ["read", "bash", "forgedock_configure", "forgedock_remember", "forgedock_memory_search"]);

  await state.commands.get("orchestrate")?.("all open enhancement issues --dry-run", commandContext());
  assert.equal(state.sent.length, 1);
  assert.match(state.sent[0]?.content ?? "", /resolve it to a concrete eligible issue-number set/);
  assert.match(state.sent[0]?.content ?? "", /call forgedock_orchestrate exactly once/);
  assert.match(state.sent[0]?.content ?? "", /execution DAG/);
  assert.doesNotMatch(state.sent[0]?.content ?? "", /commands\/orchestrate\.md|command spec at/);
  assert.deepEqual(state.active, ["read", "bash", "forgedock_configure", "forgedock_remember", "forgedock_memory_search", "forgedock_orchestrate"]);
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

test("supervisor escalations lazily expose MCQ and reply tools", async () => {
  const state = fakePi();
  await state.handlers.get("session_start")?.[0]?.({}, { mode: "json", ui: {} });
  await state.handlers.get("message_start")?.[0]?.({
    message: { role: "custom", customType: "subagent_supervisor_request" },
  });
  assert.deepEqual(state.active, ["read", "bash", "forgedock_configure", "forgedock_remember", "forgedock_memory_search", "forgedock_ask_user", "subagent_supervisor"]);
});

test("human checkpoints present a required recommendation and return the selected option", async () => {
  const state = fakePi();
  let rendered = "";
  const ctx = {
    ...commandContext(),
    ui: {
      select: async (title: string, choices: string[]) => {
        rendered = `${title}\n${choices.join("\n")}`;
        return choices[0];
      },
    },
  } as any;
  const tool = state.tools.get("forgedock_ask_user");
  assert.ok(tool);
  const result = await tool.execute("mcq-1", {
    title: "Choose rollout",
    question: "How should this ship?",
    options: [
      { id: "safe", label: "Canary", description: "Limits blast radius" },
      { id: "fast", label: "Immediate", description: "Finishes sooner with more risk" },
    ],
    recommendedId: "safe",
    recommendation: "Canary has bounded impact.",
  }, undefined, undefined, ctx);
  assert.match(rendered, /safe: Canary ★ recommended/);
  assert.match(rendered, /Recommendation: Canary has bounded impact/);
  assert.match((result.content[0] as { text: string }).text, /User selected safe/);
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

test("orchestrate delegates a validated issue DAG as visible topological batches", async () => {
  const state = fakePi();
  let spawnRequest: any;
  const originalEmit = state.pi.events.emit.bind(state.pi.events);
  state.pi.events.emit = ((name: string, data: any) => {
    originalEmit(name, data);
    if (name === "subagents:rpc:v1:request") {
      spawnRequest = data;
      queueMicrotask(() => originalEmit(`subagents:rpc:v1:reply:${data.requestId}`, {
        version: 1,
        requestId: data.requestId,
        success: true,
        data: { text: "started", details: { asyncId: "test-run" } },
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
        { issue: 7, title: "Seven", summary: "Implement the accepted bounded behavior.", priority: 1, dependsOn: [], claims: ["src/core"] },
        { issue: 8, title: "Eight", summary: "Consume Seven's completed behavior.", priority: 2, dependsOn: [7], claims: ["src/api"] },
      ],
      maxParallel: 2,
      workerModel: "openai-codex/gpt-worker",
    }, undefined, undefined, commandContext() as any);
    assert.match((result.content[0] as { text: string }).text, /accepted the 2-issue DAG/);
    assert.match((result.content[0] as { text: string }).text, /Batch 1: #7/);
    assert.match((result.content[0] as { text: string }).text, /Batch 2: #8/);
  } finally {
    if (previous === undefined) delete process.env.FORGEDOCK_CONTROLLER_ENTRY;
    else process.env.FORGEDOCK_CONTROLLER_ENTRY = previous;
  }

  assert.equal(spawnRequest.method, "spawn");
  assert.equal(spawnRequest.params.async, true);
  assert.equal(spawnRequest.params.chain.length, 2);
  assert.equal(spawnRequest.params.chain[0].parallel.length, 1);
  assert.equal(spawnRequest.params.chain[0].parallel[0].agent, "forgedock-issue-worker");
  assert.equal(spawnRequest.params.chain[0].parallel[0].model, "openai-codex/gpt-worker");
  assert.match(spawnRequest.params.chain[0].parallel[0].task, /forgedock_work_on.*\{"issue":7,"dependencies":\[\]/);
  assert.match(spawnRequest.params.chain[1].parallel[0].task, /"dependencies":\[7\]/);
  assert.match(spawnRequest.params.chain[0].parallel[0].task, /Implement the accepted bounded behavior/);
  assert.match(spawnRequest.params.chain[0].parallel[0].task, /contact_supervisor/);
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

test("native command prompts preserve natural-language intent", () => {
  const prompt = buildNativeCommandPrompt("orchestrate", "all open issues except blocked");
  assert.match(prompt, /\/orchestrate all open issues except blocked/);
  assert.match(prompt, /concrete eligible issue-number set/);
  assert.doesNotMatch(prompt, /invocationToken|\.md/);
});
