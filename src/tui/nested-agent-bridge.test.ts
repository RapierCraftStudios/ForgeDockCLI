// SPDX-License-Identifier: AGPL-3.0-or-later

import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createScopeManifestReceipt, scopeManifestForReviewer } from "../runtime/agent-runtime.js";
import { startNestedAgentBridge, subagentRpc } from "./nested-agent-bridge.js";

const REVIEWER_SCOPE = createScopeManifestReceipt(scopeManifestForReviewer());

class FakeEvents {
  handlers = new Map<string, Array<(data: unknown) => void>>();
  requests: any[] = [];
  rpcRequests: any[] = [];
  cancels: any[] = [];
  autoRespond = true;
  autoRespondRpc = true;

  on(name: string, handler: (data: unknown) => void): () => void {
    this.handlers.set(name, [...(this.handlers.get(name) ?? []), handler]);
    return () => this.handlers.set(name, (this.handlers.get(name) ?? []).filter((candidate) => candidate !== handler));
  }

  emit(name: string, data: any): void {
    if (name === "prompt-template:subagent:request") {
      this.requests.push(data);
      if (this.autoRespond) queueMicrotask(() => this.emit("prompt-template:subagent:response", {
        version: 2,
        requestId: data.requestId,
        ownerRunId: data.ownerRunId,
        nodeId: data.nodeId,
        status: "completed",
        runId: "nested-review-run",
        model: data.model,
        result: { kind: "structured", value: { summary: "clean", findings: [] } },
      }));
    }
    if (name === "prompt-template:subagent:cancel") this.cancels.push(data);
    if (name === "subagents:rpc:v1:request") {
      this.rpcRequests.push(data);
      if (this.autoRespondRpc) queueMicrotask(() => {
        this.emit(`subagents:rpc:v1:reply:${data.requestId}`, {
          version: 1, requestId: data.requestId, method: "resume", success: true,
          data: { text: "Revived run: revived-review", details: { asyncId: "revived-review" } },
        });
        queueMicrotask(() => this.emit("subagent:async-complete", {
          runId: "revived-review", success: true,
          results: [{ success: true, model: "gpt-test", structuredOutput: { summary: "resumed clean", findings: [] } }],
        }));
      });
    }
    for (const handler of this.handlers.get(name) ?? []) handler(data);
  }
}

test("missing child-local RPC acknowledgement fails the transport handshake instead of hanging", async () => {
  const events = new FakeEvents();
  events.autoRespondRpc = false;
  await assert.rejects(
    subagentRpc({ events } as unknown as ExtensionAPI, "resume", { id: "missing", message: "continue" }, new AbortController().signal, undefined, 10),
    /did not acknowledge/,
  );
  assert.equal([...events.handlers.values()].flat().length, 0);
});

test("controller reviewer tasks use the child-safe nested delegation protocol", async () => {
  const events = new FakeEvents();
  const bridge = await startNestedAgentBridge({ events } as unknown as ExtensionAPI);
  try {
    const health = await fetch(bridge.env.FORGEDOCK_NESTED_AGENT_HEALTH_URL!, {
      headers: { authorization: `Bearer ${bridge.env.FORGEDOCK_NESTED_AGENT_TOKEN}` },
    });
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { ok: true, owner: "forgedock" });
    const response = await fetch(bridge.env.FORGEDOCK_NESTED_AGENT_URL!, {
      method: "POST",
      headers: {
        authorization: `Bearer ${bridge.env.FORGEDOCK_NESTED_AGENT_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        ownerRunId: "run-4",
        id: "run-4:review:abc:correctness",
        role: "reviewer",
        objective: "Review frozen SHA abc",
        instructions: "Read only",
        context: [],
        cwd: process.cwd(),
        ...REVIEWER_SCOPE,
        tools: ["read", "grep", "find", "ls"],
        turnBudget: 24,
        toolBudget: 64,
        outputSchema: { type: "object" },
        provider: "openai-codex",
        model: "gpt-test",
      }),
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-forgedock-nested-session-ref"), "nested-review-run");
    const result = await response.json() as any;
    assert.deepEqual(result.output, { summary: "clean", findings: [] });
    assert.equal(result.sessionRef, "nested-review-run");
    assert.equal(events.requests[0]?.version, 2);
    assert.equal(events.requests[0]?.agent, "forgedock-reviewer");
    assert.match(events.requests[0]?.task ?? "", /^ForgeDock review · correctness\n/);
    assert.equal(events.requests[0]?.context, "fresh");
    assert.equal(events.requests[0]?.result.kind, "structured");
    assert.deepEqual(events.requests[0]?.turnBudget, { maxTurns: 24, graceTurns: 2 });
    assert.deepEqual(events.requests[0]?.toolBudget, { soft: 48, hard: 64, block: ["read", "grep", "find", "ls"] });
    assert.equal(events.requests[0]?.scope, undefined, "ForgeDock scope is carried in task text, not as an unsupported upstream field");
    assert.match(events.requests[0]?.task ?? "", new RegExp(`scope contract: v1 sha256:${REVIEWER_SCOPE.scopeDigest}`));
    assert.equal(result.scopeVersion, REVIEWER_SCOPE.scopeVersion);
    assert.equal(result.scopeDigest, REVIEWER_SCOPE.scopeDigest);
  } finally {
    await bridge.close();
  }
});

test("nested delegation relays V2 updates as JSON-safe streamed progress", async () => {
  const events = new FakeEvents();
  events.autoRespond = false;
  const bridge = await startNestedAgentBridge({ events } as unknown as ExtensionAPI);
  try {
    const pending = fetch(bridge.env.FORGEDOCK_NESTED_AGENT_URL!, {
      method: "POST",
      headers: {
        authorization: `Bearer ${bridge.env.FORGEDOCK_NESTED_AGENT_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        ownerRunId: "run-progress",
        id: "run-progress:review:abc:correctness",
        role: "reviewer",
        objective: "Review frozen SHA abc",
        instructions: "Read only",
        context: [],
        cwd: process.cwd(),
        ...REVIEWER_SCOPE,
        tools: ["read"],
        outputSchema: { type: "object" },
        provider: "openai-codex",
        model: "gpt-test",
      }),
    });
    for (let attempt = 0; attempt < 100 && events.requests.length === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    const request = events.requests[0];
    assert.ok(request);
    events.emit("prompt-template:subagent:update", {
      version: 2,
      requestId: request.requestId,
      ownerRunId: request.ownerRunId,
      nodeId: request.nodeId,
      runId: "nested-progress-run",
      currentTool: "read",
      toolCount: 1,
    });
    events.emit("prompt-template:subagent:response", {
      version: 2,
      requestId: request.requestId,
      ownerRunId: request.ownerRunId,
      nodeId: request.nodeId,
      status: "completed",
      runId: "nested-progress-run",
      result: { kind: "structured", value: { summary: "clean", findings: [] } },
    });
    const response = await pending;
    assert.equal(response.status, 200);
    const body = await response.text();
    assert.match(body, /^\s+\{/);
    assert.deepEqual(JSON.parse(body), {
      output: { summary: "clean", findings: [] },
      sessionRef: "nested-progress-run",
      provider: "openai-codex",
      model: "gpt-test",
      scopeVersion: REVIEWER_SCOPE.scopeVersion,
      scopeDigest: REVIEWER_SCOPE.scopeDigest,
    });
  } finally {
    await bridge.close();
  }
});

test("nested reviewer scope receipts fail closed on omission, tampering, or narrowed/write authority", async () => {
  const events = new FakeEvents();
  const bridge = await startNestedAgentBridge({ events } as unknown as ExtensionAPI);
  const base = {
    ownerRunId: "run-scope", id: "run-scope:review:abc:correctness", role: "reviewer",
    objective: "Review", instructions: "Read only", context: [], cwd: process.cwd(),
    tools: ["read"], outputSchema: { type: "object" }, provider: "openai-codex", model: "gpt-test",
  };
  const post = (body: unknown) => fetch(bridge.env.FORGEDOCK_NESTED_AGENT_URL!, {
    method: "POST",
    headers: { authorization: `Bearer ${bridge.env.FORGEDOCK_NESTED_AGENT_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  try {
    assert.equal((await post(base)).status, 500);
    assert.equal((await post({ ...base, ...REVIEWER_SCOPE, scopeVersion: 2 })).status, 500);
    assert.equal((await post({ ...base, ...REVIEWER_SCOPE, scopeDigest: "0".repeat(64) })).status, 500);
    assert.equal((await post({ ...base, ...REVIEWER_SCOPE, unversionedScopeHint: "src" })).status, 500);
    const narrow = createScopeManifestReceipt({ readRoots: ["src"], writeRoots: [], source: "issue-hints" });
    assert.equal((await post({ ...base, ...narrow })).status, 500);
    const writable = createScopeManifestReceipt({ readRoots: ["."], writeRoots: ["src"], source: "issue-hints" });
    assert.equal((await post({ ...base, ...writable })).status, 500);
    assert.equal((await post({ ...base, ...REVIEWER_SCOPE, tools: ["read", "verify"] })).status, 500);
    assert.equal(events.requests.length, 0, "invalid scope must be rejected before nested dispatch");
  } finally {
    await bridge.close();
  }
});

test("nested bridge confines reviewer cwd to canonical trusted roots", async () => {
  const root = mkdtempSync(join(tmpdir(), "forgedock-bridge-roots-"));
  const managed = join(root, "managed");
  const valid = join(managed, "review");
  const escape = join(root, "escape");
  mkdirSync(valid, { recursive: true });
  symlinkSync("/etc", escape, "dir");
  const events = new FakeEvents();
  const bridge = await startNestedAgentBridge({ events } as unknown as ExtensionAPI, { allowedRoots: [managed] });
  const base = {
    ownerRunId: "run-path", id: "run-path:review:abc:security", role: "reviewer",
    objective: "Review", instructions: "Read only", context: [],
    ...REVIEWER_SCOPE, tools: ["read"], outputSchema: { type: "object" }, provider: "openai-codex", model: "gpt-test",
  };
  const post = (cwd: string) => fetch(bridge.env.FORGEDOCK_NESTED_AGENT_URL!, {
    method: "POST",
    headers: { authorization: `Bearer ${bridge.env.FORGEDOCK_NESTED_AGENT_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ ...base, cwd }),
  });
  try {
    assert.equal((await post(valid)).status, 200);
    assert.equal((await post("/etc")).status, 500);
    assert.equal((await post(join(managed, "missing"))).status, 500);
    assert.equal((await post(escape)).status, 500);
  } finally {
    await bridge.close();
    rmSync(root, { recursive: true, force: true });
  }
});
test("incomplete persisted reviewers are resumed through the package-owned RPC lifecycle", async () => {
  const events = new FakeEvents();
  const bridge = await startNestedAgentBridge({ events } as unknown as ExtensionAPI);
  try {
    const response = await fetch(bridge.env.FORGEDOCK_NESTED_AGENT_URL!, {
      method: "POST",
      headers: {
        authorization: `Bearer ${bridge.env.FORGEDOCK_NESTED_AGENT_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        ownerRunId: "run-resume",
        id: "run-resume:review:abc:correctness:resume",
        role: "reviewer",
        objective: "Finish the frozen review",
        instructions: "Read only",
        context: [],
        cwd: process.cwd(),
        ...REVIEWER_SCOPE,
        tools: ["read", "grep", "find", "ls"],
        outputSchema: { type: "object" },
        provider: "openai-codex",
        model: "gpt-test",
        resumeSessionRef: "nested-incomplete-run",
      }),
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-forgedock-nested-session-ref"), "revived-review");
    const result = await response.json() as any;
    assert.deepEqual(result.output, { summary: "resumed clean", findings: [] });
    assert.equal(result.sessionRef, "revived-review");
    assert.equal(events.requests.length, 0, "resume must not launch a fresh V2 delegation");
    assert.equal(events.rpcRequests[0]?.method, "resume");
    assert.equal(events.rpcRequests[0]?.params.id, "nested-incomplete-run");
  } finally {
    await bridge.close();
  }
});


test("a resumed reviewer may recover an exact schema-valid terminal JSON report", async () => {
  const events = new FakeEvents();
  events.autoRespondRpc = false;
  const bridge = await startNestedAgentBridge({ events } as unknown as ExtensionAPI);
  try {
    const pending = fetch(bridge.env.FORGEDOCK_NESTED_AGENT_URL!, {
      method: "POST",
      headers: { authorization: `Bearer ${bridge.env.FORGEDOCK_NESTED_AGENT_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({
        ownerRunId: "run-terminal-json", id: "run-terminal-json:review:abc:security:resume", role: "reviewer",
        objective: "Resume", instructions: "Read only", context: [], cwd: process.cwd(), tools: ["read"],
        ...REVIEWER_SCOPE,
        outputSchema: {
          type: "object", additionalProperties: false, required: ["summary", "findings"],
          properties: { summary: { type: "string", minLength: 1 }, findings: { type: "array" } },
        },
        provider: "openai-codex", model: "gpt-test", resumeSessionRef: "source-terminal-json",
      }),
    });
    while (events.rpcRequests.length === 0) await new Promise((resolve) => setTimeout(resolve, 1));
    const request = events.rpcRequests[0];
    events.emit(`subagents:rpc:v1:reply:${request.requestId}`, {
      version: 1, requestId: request.requestId, method: "resume", success: true,
      data: { details: { asyncId: "resumed-terminal-json" } },
    });
    events.emit("subagent:async-complete", {
      runId: "resumed-terminal-json", success: false, state: "failed",
      results: [{
        success: false, status: "failed", model: "gpt-test", error: "structured_output was not called",
        finalOutput: JSON.stringify({ summary: "Recovered exact report", findings: [] }),
      }],
    });
    const response = await pending;
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json() as any).output, { summary: "Recovered exact report", findings: [] });
  } finally {
    await bridge.close();
  }
});

test("schema-valid output from a resumed reviewer survives a trailing failed status", async () => {
  const events = new FakeEvents();
  events.autoRespondRpc = false;
  const bridge = await startNestedAgentBridge({ events } as unknown as ExtensionAPI);
  try {
    const pending = fetch(bridge.env.FORGEDOCK_NESTED_AGENT_URL!, {
      method: "POST",
      headers: { authorization: `Bearer ${bridge.env.FORGEDOCK_NESTED_AGENT_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({
        ownerRunId: "run-resume-transport", id: "run-resume-transport:review:abc:correctness:resume", role: "reviewer",
        objective: "Resume", instructions: "Read only", context: [], cwd: process.cwd(), tools: ["read"],
        ...REVIEWER_SCOPE,
        outputSchema: { type: "object" }, provider: "openai-codex", model: "gpt-test", resumeSessionRef: "source-run",
      }),
    });
    while (events.rpcRequests.length === 0) await new Promise((resolve) => setTimeout(resolve, 1));
    const request = events.rpcRequests[0];
    events.emit(`subagents:rpc:v1:reply:${request.requestId}`, {
      version: 1, requestId: request.requestId, method: "resume", success: true,
      data: { details: { asyncId: "resumed-before-transport" } },
    });
    events.emit("subagent:async-complete", {
      runId: "resumed-before-transport", success: false, state: "failed", error: "WebSocket error",
      results: [{ success: false, status: "failed", error: "WebSocket error", structuredOutput: { summary: "resumed valid", findings: [] } }],
    });
    const response = await pending;
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json() as any).output, { summary: "resumed valid", findings: [] });
  } finally {
    await bridge.close();
  }
});

test("cancelling during resume interrupts a revived child even when its RPC reply arrives late", async () => {
  const events = new FakeEvents();
  events.autoRespondRpc = false;
  const bridge = await startNestedAgentBridge({ events } as unknown as ExtensionAPI);
  const controller = new AbortController();
  try {
    const pending = fetch(bridge.env.FORGEDOCK_NESTED_AGENT_URL!, {
      method: "POST",
      headers: { authorization: `Bearer ${bridge.env.FORGEDOCK_NESTED_AGENT_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({
        ownerRunId: "run-cancel-resume", id: "run-cancel-resume:review:abc:correctness:resume", role: "reviewer",
        objective: "Resume", instructions: "Read only", context: [], cwd: process.cwd(), tools: ["read"],
        ...REVIEWER_SCOPE,
        outputSchema: { type: "object" }, provider: "openai-codex", model: "gpt-test", resumeSessionRef: "source-run",
      }),
      signal: controller.signal,
    });
    while (events.rpcRequests.length === 0) await new Promise((resolve) => setTimeout(resolve, 1));
    const resumeRequest = events.rpcRequests[0];
    controller.abort();
    await assert.rejects(pending, /abort/i);
    await new Promise((resolve) => setTimeout(resolve, 5));
    events.emit(`subagents:rpc:v1:reply:${resumeRequest.requestId}`, {
      version: 1, requestId: resumeRequest.requestId, method: "resume", success: true,
      data: { details: { asyncId: "late-revived-run" } },
    });
    for (let attempt = 0; attempt < 100 && !events.rpcRequests.some((request) => request.method === "interrupt"); attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    assert.ok(events.rpcRequests.some((request) => request.method === "interrupt" && request.params.id === "late-revived-run"));
  } finally {
    await bridge.close();
  }
});

test("a schema-valid structured result survives a trailing failed terminal status", async () => {
  const events = new FakeEvents();
  events.autoRespond = false;
  const bridge = await startNestedAgentBridge({ events } as unknown as ExtensionAPI);
  try {
    const pending = fetch(bridge.env.FORGEDOCK_NESTED_AGENT_URL!, {
      method: "POST",
      headers: {
        authorization: `Bearer ${bridge.env.FORGEDOCK_NESTED_AGENT_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        ownerRunId: "run-transport",
        id: "run-transport:review:abc:correctness",
        role: "reviewer",
        objective: "Review",
        instructions: "Read only",
        context: [], cwd: process.cwd(), ...REVIEWER_SCOPE, tools: ["read"], outputSchema: { type: "object" },
        provider: "openai-codex", model: "gpt-test",
      }),
    });
    while (events.requests.length === 0) await new Promise((resolve) => setTimeout(resolve, 1));
    const request = events.requests[0];
    events.emit("prompt-template:subagent:response", {
      version: 2, requestId: request.requestId, ownerRunId: request.ownerRunId, nodeId: request.nodeId,
      status: "failed", error: "WebSocket error", runId: "completed-before-transport",
      result: { kind: "structured", value: { summary: "valid result", findings: [] } },
    });
    const response = await pending;
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json() as any).output, { summary: "valid result", findings: [] });
  } finally {
    await bridge.close();
  }
});

test("a terminal-only failed delegation preserves its session reference but requires a fresh typed retry", async () => {
  const events = new FakeEvents();
  events.autoRespond = false;
  const bridge = await startNestedAgentBridge({ events } as unknown as ExtensionAPI);
  try {
    const pending = fetch(bridge.env.FORGEDOCK_NESTED_AGENT_URL!, {
      method: "POST",
      headers: { authorization: `Bearer ${bridge.env.FORGEDOCK_NESTED_AGENT_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({
        ownerRunId: "run-incomplete", id: "run-incomplete:review:abc:correctness", role: "reviewer",
        objective: "Review", instructions: "Read only", context: [], cwd: process.cwd(), ...REVIEWER_SCOPE, tools: ["read"],
        outputSchema: { type: "object" }, provider: "openai-codex", model: "gpt-test",
      }),
    });
    while (events.requests.length === 0) await new Promise((resolve) => setTimeout(resolve, 1));
    const request = events.requests[0];
    events.emit("prompt-template:subagent:response", {
      version: 2, requestId: request.requestId, ownerRunId: request.ownerRunId, nodeId: request.nodeId,
      status: "failed", error: "provider disconnected", runId: "persisted-incomplete",
    });
    const response = await pending;
    assert.equal(response.status, 200, "the early identity header fixes the transport status before terminal failure");
    assert.equal(response.headers.get("x-forgedock-nested-session-ref"), "persisted-incomplete");
    const result = await response.json() as any;
    assert.equal(result.sessionRef, "persisted-incomplete");
    assert.equal(result.resumable, undefined);
  } finally {
    await bridge.close();
  }
});

test("turn-budget and structured-output terminal failures require a fresh bounded retry", async () => {
  for (const terminal of [
    { status: "turn_budget_exhausted", error: "Subagent exceeded turn budget" },
    { status: "structured_output_failed", error: "Missing structured_output call" },
    { status: "failed", error: "Delegated subagent did not capture the requested structured result" },
  ]) {
    const events = new FakeEvents();
    events.autoRespond = false;
    const bridge = await startNestedAgentBridge({ events } as unknown as ExtensionAPI);
    try {
      const pending = fetch(bridge.env.FORGEDOCK_NESTED_AGENT_URL!, {
        method: "POST",
        headers: { authorization: `Bearer ${bridge.env.FORGEDOCK_NESTED_AGENT_TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({
          ownerRunId: `run-${terminal.status}`, id: `run-${terminal.status}:review:abc:correctness`, role: "reviewer",
          objective: "Review", instructions: "Read only", context: [], cwd: process.cwd(), ...REVIEWER_SCOPE, tools: ["read"],
          outputSchema: { type: "object" }, provider: "openai-codex", model: "gpt-test",
        }),
      });
      while (events.requests.length === 0) await new Promise((resolve) => setTimeout(resolve, 1));
      const request = events.requests[0];
      events.emit("prompt-template:subagent:response", {
        version: 2, requestId: request.requestId, ownerRunId: request.ownerRunId, nodeId: request.nodeId,
        ...terminal, runId: `persisted-${terminal.status}`,
      });
      const response = await pending;
      const result = await response.json() as any;
      assert.equal(result.sessionRef, `persisted-${terminal.status}`);
      assert.equal(result.resumable, undefined);
    } finally {
      await bridge.close();
    }
  }
});

test("nested reviewers have no fixed wall-clock lifetime and stop on explicit client cancellation", async () => {
  const events = new FakeEvents();
  events.autoRespond = false;
  const bridge = await startNestedAgentBridge({ events } as unknown as ExtensionAPI);
  const controller = new AbortController();
  try {
    const pending = fetch(bridge.env.FORGEDOCK_NESTED_AGENT_URL!, {
      method: "POST",
      headers: {
        authorization: `Bearer ${bridge.env.FORGEDOCK_NESTED_AGENT_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        ownerRunId: "run-long",
        id: "run-long:review:abc:correctness",
        role: "reviewer",
        objective: "Review for as long as useful progress continues",
        instructions: "Read only",
        context: [],
        cwd: process.cwd(),
        ...REVIEWER_SCOPE,
        tools: ["read", "grep", "find", "ls"],
        outputSchema: { type: "object" },
        provider: "openai-codex",
        model: "gpt-test",
      }),
      signal: controller.signal,
    });
    for (let attempt = 0; attempt < 100 && events.requests.length === 0; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(events.requests.length, 1);
    assert.equal(events.handlers.get("prompt-template:subagent:response")?.length, 1);
    controller.abort();
    await assert.rejects(pending, /abort/i);
    for (let attempt = 0; attempt < 100 && events.handlers.get("prompt-template:subagent:response")?.length; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(events.handlers.get("prompt-template:subagent:response")?.length, 0);
    assert.equal(events.cancels.length, 1);
    assert.equal(events.cancels[0]?.requestId, events.requests[0]?.requestId);
  } finally {
    await bridge.close();
  }
});
