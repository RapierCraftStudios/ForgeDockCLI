// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { Type } from "typebox";
import { boundedToolErrorSummary, MAX_NESTED_AGENT_RESPONSE_BYTES, PiAgentRuntime, postNestedAgentRequest, reserveToolCallBudget, resolvePiModelPolicy } from "./pi-adapter.js";
import { createScopeManifestReceipt, scopeManifestFor, scopeManifestForReviewer, type AgentEvent } from "./agent-runtime.js";

const REVIEWER_SCOPE = createScopeManifestReceipt(scopeManifestForReviewer());

async function listen(handler: (request: IncomingMessage, response: ServerResponse) => void) {
  const server = createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address() as AddressInfo;
  return {
    server,
    url: `http://127.0.0.1:${address.port}/v1/run`,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

function taskForRole(role: "investigator" | "packet-author" | "builder" | "reviewer", modelPolicy: Record<string, string> = {}) {
  return {
    id: `run:${role}`,
    role,
    objective: "Test model resolution",
    instructions: "Read only",
    context: [],
    workspace: { cwd: process.cwd(), mode: "read-only" as const, scope: scopeManifestFor("issue-hints", { metadataRoots: ["."] }) },
    tools: ["read" as const],
    outputSchema: Type.Object({ summary: Type.String() }),
    modelPolicy,
  } as any;
}

test("planning model resolution is role-specific and invocation policy wins", () => {
  const environment = {
    FORGEDOCK_PLANNING_MODEL: "env/planner",
    FORGEDOCK_PLANNING_THINKING: "high",
    FORGEDOCK_REVIEWER_MODEL: "env/reviewer",
    PI_PROVIDER: "env/default-provider",
    PI_MODEL: "env/default-model",
  };
  assert.deepEqual(resolvePiModelPolicy(taskForRole("investigator", {
    provider: "generic-provider", model: "generic-model", planningProvider: "flag", planningModel: "planner", planningThinking: "low",
  }), { planningProvider: "option", planningModel: "planner", planningThinking: "max" }, environment), { provider: "flag", model: "planner", thinking: "low" });
  assert.deepEqual(resolvePiModelPolicy(taskForRole("packet-author"), {}, environment), { provider: "env", model: "planner", thinking: "high" });
  assert.deepEqual(resolvePiModelPolicy(taskForRole("builder", { provider: "worker", model: "builder" }), {}, environment), { provider: "worker", model: "builder", thinking: undefined });
  assert.deepEqual(resolvePiModelPolicy(taskForRole("reviewer", { provider: "task", model: "task" }), {}, environment), { provider: "env", model: "reviewer", thinking: undefined });
});

test("tool-call budget reserves parallel beforeToolCall slots without overshoot", () => {
  const state = { toolCalls: 0 };
  for (let index = 0; index < 20; index += 1) {
    assert.equal(reserveToolCallBudget(state, 20), undefined);
  }
  assert.equal(state.toolCalls, 20);
  assert.deepEqual(reserveToolCallBudget(state, 20), { limit: "maxToolCalls", value: 20, maximum: 20 });
  assert.equal(state.toolCalls, 20);
});

test("nested reviewer transport does not depend on fetch or an implicit wall-clock timeout", async () => {
  const endpoint = await listen((_request, response) => {
    setTimeout(() => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ output: { summary: "complete" } }));
    }, 50);
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (() => { throw new Error("fetch must not be used"); }) as typeof fetch;
  try {
    const result = await postNestedAgentRequest<{ output: { summary: string } }>({
      url: endpoint.url,
      token: "test-token",
      body: { task: "long review" },
    });
    assert.equal(result.status, 200);
    assert.deepEqual(result.payload.output, { summary: "complete" });
  } finally {
    globalThis.fetch = originalFetch;
    await endpoint.close();
  }
});

test("nested reviewer transport exposes the persisted child identity before terminal completion", async () => {
  const endpoint = await listen((_request, response) => {
    response.writeHead(200, {
      "content-type": "application/json",
      "x-forgedock-nested-session-ref": "persisted-child-run",
    });
    response.flushHeaders();
    setTimeout(() => response.end(JSON.stringify({ output: { summary: "complete" } })), 20);
  });
  const observed: string[] = [];
  try {
    const result = await postNestedAgentRequest<{ output: { summary: string } }>({
      url: endpoint.url,
      token: "test-token",
      body: { task: "identity-bound review" },
      onSessionRef: (sessionRef) => observed.push(sessionRef),
    });
    assert.deepEqual(observed, ["persisted-child-run"]);
    assert.deepEqual(result.payload.output, { summary: "complete" });
  } finally {
    await endpoint.close();
  }
});

test("nested reviewer transport rejects non-loopback bridge destinations", async () => {
  await assert.rejects(
    postNestedAgentRequest({ url: "http://attacker.example/v1/run", token: "test-token", body: {} }),
    /127\.0\.0\.1 \/v1\/run/,
  );
});

test("a stale nested reviewer bridge fails closed without exposing its bearer token", async () => {
  const previousUrl = process.env.FORGEDOCK_NESTED_AGENT_URL;
  const previousToken = process.env.FORGEDOCK_NESTED_AGENT_TOKEN;
  const token = "stale-bridge-token-must-not-appear";
  process.env.FORGEDOCK_NESTED_AGENT_URL = "http://127.0.0.1:1/v1/run";
  process.env.FORGEDOCK_NESTED_AGENT_TOKEN = token;
  const runtime = new PiAgentRuntime({ provider: "test-provider", model: "test-model" });
  try {
    await assert.rejects(runtime.run(taskForRole("reviewer") as any), (error: any) => {
      assert.equal(error.name, "AgentRunError");
      assert.match(error.message, /Nested reviewer transport failed/);
      assert.doesNotMatch(error.message, /stale-bridge-token|authorization|Bearer/i);
      return true;
    });
  } finally {
    await runtime.close();
    restoreNestedEnvironment(previousUrl, previousToken);
  }
});

test("nested reviewer transport bounds response buffering", async () => {
  const endpoint = await listen((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end("x".repeat(MAX_NESTED_AGENT_RESPONSE_BYTES + 1));
  });
  try {
    await assert.rejects(
      postNestedAgentRequest({ url: endpoint.url, token: "test-token", body: {} }),
      /response exceeded/,
    );
  } finally {
    await endpoint.close();
  }
});

test("the controller rejects a malformed nested structured result even after bridge success", async () => {
  const endpoint = await listen((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ output: { wrong: true }, sessionRef: "nested-malformed", scopeVersion: REVIEWER_SCOPE.scopeVersion, scopeDigest: REVIEWER_SCOPE.scopeDigest }));
  });
  const previousUrl = process.env.FORGEDOCK_NESTED_AGENT_URL;
  const previousToken = process.env.FORGEDOCK_NESTED_AGENT_TOKEN;
  process.env.FORGEDOCK_NESTED_AGENT_URL = endpoint.url;
  process.env.FORGEDOCK_NESTED_AGENT_TOKEN = "test-token";
  const runtime = new PiAgentRuntime({ provider: "test-provider", model: "test-model" });
  try {
    await assert.rejects(runtime.run({
      id: "run:review:sha:correctness", role: "reviewer", objective: "Review", instructions: "Read only", context: [],
      workspace: { cwd: process.cwd(), mode: "read-only", scope: scopeManifestFor("issue-hints", { metadataRoots: ["."] }) }, tools: ["read"],
      outputSchema: Type.Object({ summary: Type.String() }), modelPolicy: {},
    }), /invalid structured result/i);
  } finally {
    if (previousUrl === undefined) delete process.env.FORGEDOCK_NESTED_AGENT_URL;
    else process.env.FORGEDOCK_NESTED_AGENT_URL = previousUrl;
    if (previousToken === undefined) delete process.env.FORGEDOCK_NESTED_AGENT_TOKEN;
    else process.env.FORGEDOCK_NESTED_AGENT_TOKEN = previousToken;
    await endpoint.close();
  }
});

test("fresh nested reviewer attempts use unique wire nodes but retain the logical task identity", async () => {
  const requests: Array<Record<string, any>> = [];
  const endpoint = await listen((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer | string) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    request.on("end", () => {
      requests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, any>);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        output: { summary: "complete" }, sessionRef: `nested-${requests.length}`,
        scopeVersion: requests.at(-1)?.scopeVersion, scopeDigest: requests.at(-1)?.scopeDigest,
      }));
    });
  });
  const previousUrl = process.env.FORGEDOCK_NESTED_AGENT_URL;
  const previousToken = process.env.FORGEDOCK_NESTED_AGENT_TOKEN;
  process.env.FORGEDOCK_NESTED_AGENT_URL = endpoint.url;
  process.env.FORGEDOCK_NESTED_AGENT_TOKEN = "test-token";
  const runtime = new PiAgentRuntime({ provider: "test-provider", model: "test-model" });
  const task = taskForRole("reviewer", {}) as any;
  task.id = "run-review:review:sha:correctness";
  task.executionBudget = { maxToolCalls: 64 };
  try {
    await runtime.run(task);
    await runtime.run(task);
    assert.equal(requests.length, 2);
    assert.notEqual(requests[0]?.id, requests[1]?.id);
    assert.deepEqual(requests.map((request) => request.logicalTaskId), [task.id, task.id]);
    assert.deepEqual(requests.map((request) => request.scopeVersion), [1, 1]);
    assert.deepEqual(requests.map((request) => request.scope), [REVIEWER_SCOPE.scope, REVIEWER_SCOPE.scope]);
    assert.deepEqual(requests.map((request) => request.scopeDigest), [REVIEWER_SCOPE.scopeDigest, REVIEWER_SCOPE.scopeDigest]);
    assert.deepEqual(requests.map((request) => request.toolBudget), [64, 64]);
    assert.deepEqual(requests.map((request) => request.turnBudget), [undefined, undefined]);
  } finally {
    if (previousUrl === undefined) delete process.env.FORGEDOCK_NESTED_AGENT_URL;
    else process.env.FORGEDOCK_NESTED_AGENT_URL = previousUrl;
    if (previousToken === undefined) delete process.env.FORGEDOCK_NESTED_AGENT_TOKEN;
    else process.env.FORGEDOCK_NESTED_AGENT_TOKEN = previousToken;
    await endpoint.close();
  }
});

test("verification agency requires a frozen controller-approved plan", async () => {
  const runtime = new PiAgentRuntime({ provider: "test-provider", model: "test-model" });
  await assert.rejects(runtime.run({
    id: "run:build:verify-policy", role: "builder", objective: "Build", instructions: "Use the approved checks", context: [],
    workspace: { cwd: process.cwd(), mode: "write", scope: scopeManifestFor("build-packet", { writePaths: ["src/a.ts"], metadataRoots: ["package.json"] }) },
    tools: ["read", "verify", "edit"],
    outputSchema: Type.Object({ summary: Type.String() }), modelPolicy: {},
  }), /no frozen controller-approved command plan/i);
});

test("tool error summaries expose only allowlisted classifications", () => {
  const arbitrary = boundedToolErrorSummary({
    content: [{
      type: "text",
      text: `Edit failed\n token=github_pat_${"a".repeat(80)} C:\\Users\\secret\\key.pem -----BEGIN PRIVATE KEY-----`,
    }],
  });
  assert.equal(arbitrary, "Tool execution failed; inspect the scoped arguments and retry");
  assert.doesNotMatch(arbitrary, /github_pat_|Users|PRIVATE KEY|\n/);
  assert.equal(
    boundedToolErrorSummary({ content: [{ type: "text", text: "oldText occurs 3 times and is not unique" }] }),
    "Edit target text was not unique",
  );
  assert.equal(
    boundedToolErrorSummary({ content: [{ type: "text", text: "Tool write path is outside the assigned scope: C:\\secret" }] }),
    "Path is outside the assigned workspace scope",
  );
  assert.equal(boundedToolErrorSummary({ content: [{ type: "image", data: "secret" }] }), undefined);
});

test("nested reviewer transport still honors explicit cancellation", async () => {
  const endpoint = await listen(() => undefined);
  const controller = new AbortController();
  try {
    const pending = postNestedAgentRequest({
      url: endpoint.url,
      token: "test-token",
      body: { task: "cancelled review" },
      signal: controller.signal,
    });
    controller.abort();
    await assert.rejects(pending, /Nested reviewer transport failed:.*abort/i);
  } finally {
    await endpoint.close();
  }
});

test("pre-aborted nested run and resume reject before bridge dispatch or session start", async () => {
  let requests = 0;
  const endpoint = await listen((_request, response) => {
    requests += 1;
    response.writeHead(500, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "must not dispatch" }));
  });
  const previousUrl = process.env.FORGEDOCK_NESTED_AGENT_URL;
  const previousToken = process.env.FORGEDOCK_NESTED_AGENT_TOKEN;
  process.env.FORGEDOCK_NESTED_AGENT_URL = endpoint.url;
  process.env.FORGEDOCK_NESTED_AGENT_TOKEN = "test-token";
  const runtime = new PiAgentRuntime({ provider: "test-provider", model: "test-model" });
  const controller = new AbortController();
  controller.abort(new Error("cancel before allocation"));
  const events: AgentEvent[] = [];
  try {
    await assert.rejects(runtime.run(taskForRole("reviewer") as any, { signal: controller.signal, onEvent: (event) => events.push(event) }), /cancel before allocation/);
    await assert.rejects(runtime.resume!("persisted-review", taskForRole("reviewer") as any, { signal: controller.signal, onEvent: (event) => events.push(event) }), /cancel before allocation/);
    assert.equal(requests, 0);
    assert.deepEqual(events, []);
  } finally {
    await runtime.close();
    restoreNestedEnvironment(previousUrl, previousToken);
    await endpoint.close();
  }
});

test("nested terminal failure carries the persisted child session identity", async () => {
  const endpoint = await listen((request, response) => {
    request.resume();
    request.once("end", () => {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "provider disconnected", sessionRef: "nested-real-session", resumable: true }));
    });
  });
  const previousUrl = process.env.FORGEDOCK_NESTED_AGENT_URL;
  const previousToken = process.env.FORGEDOCK_NESTED_AGENT_TOKEN;
  process.env.FORGEDOCK_NESTED_AGENT_URL = endpoint.url;
  process.env.FORGEDOCK_NESTED_AGENT_TOKEN = "test-token";
  const runtime = new PiAgentRuntime({ provider: "test-provider", model: "test-model" });
  const events: AgentEvent[] = [];
  try {
    await assert.rejects(runtime.run(taskForRole("reviewer") as any, { onEvent: (event) => events.push(event) }), (error: any) => {
      assert.equal(error.sessionRef, "nested-real-session");
      assert.equal(error.resumable, false, "typed reviewers must retry with a fresh V2 schema contract");
      return true;
    });
    const terminal = events.find((event) => event.type === "session.failed");
    assert.equal(terminal?.sessionRef, "nested-real-session");
    assert.equal(terminal && "errorSummary" in terminal ? terminal.errorSummary : undefined, "Agent session failed");
  } finally {
    await runtime.close();
    restoreNestedEnvironment(previousUrl, previousToken);
    await endpoint.close();
  }
});

test("Pi does not advertise generic session resume as typed reviewer recovery", async () => {
  const previousUrl = process.env.FORGEDOCK_NESTED_AGENT_URL;
  const previousToken = process.env.FORGEDOCK_NESTED_AGENT_TOKEN;
  process.env.FORGEDOCK_NESTED_AGENT_URL = "http://127.0.0.1:1/v1/run";
  process.env.FORGEDOCK_NESTED_AGENT_TOKEN = "test-token";
  const runtime = new PiAgentRuntime({ provider: "test-provider", model: "test-model" });
  try {
    assert.equal((await runtime.capabilities()).resumableSessions, false);
    await assert.rejects(
      runtime.resume!("persisted-review", taskForRole("reviewer") as any),
      (error: any) => error.sessionRef === "persisted-review" && error.resumable === false
        && /fresh bounded delegation/.test(error.message),
    );
  } finally {
    await runtime.close();
    restoreNestedEnvironment(previousUrl, previousToken);
  }
});

test("closing the runtime cancels and awaits an active nested reviewer", async () => {
  let requests = 0;
  const endpoint = await listen((request, response) => {
    requests += 1;
    request.resume();
    response.writeHead(200, {
      "content-type": "application/json",
      "x-forgedock-nested-session-ref": "nested-active-child",
    });
    response.flushHeaders();
  });
  const previousUrl = process.env.FORGEDOCK_NESTED_AGENT_URL;
  const previousToken = process.env.FORGEDOCK_NESTED_AGENT_TOKEN;
  process.env.FORGEDOCK_NESTED_AGENT_URL = endpoint.url;
  process.env.FORGEDOCK_NESTED_AGENT_TOKEN = "test-token";
  const runtime = new PiAgentRuntime({ provider: "test-provider", model: "test-model" });
  const events: AgentEvent[] = [];
  try {
    const pending = runtime.run(taskForRole("reviewer") as any, { onEvent: (event) => events.push(event) });
    for (let attempt = 0; attempt < 100
      && !events.some((event) => event.type === "session.started" && event.sessionRef === "nested-active-child"); attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    assert.equal(requests, 1);
    assert.ok(events.some((event) => event.type === "session.started" && event.sessionRef === "nested-active-child"));
    const closing = runtime.close();
    await assert.rejects(pending, /Pi runtime closed|aborted/i);
    await closing;
    const terminals = events.filter((event) => event.type === "session.cancelled");
    assert.equal(terminals.length, 1);
    assert.equal(terminals[0]?.sessionRef, "nested-active-child");
  } finally {
    restoreNestedEnvironment(previousUrl, previousToken);
    await endpoint.close();
  }
});

test("nested success without the exact scope acknowledgement fails closed", async () => {
  const endpoint = await listen((request, response) => {
    request.resume();
    request.once("end", () => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ output: { summary: "complete" }, sessionRef: "nested-unbound" }));
    });
  });
  const previousUrl = process.env.FORGEDOCK_NESTED_AGENT_URL;
  const previousToken = process.env.FORGEDOCK_NESTED_AGENT_TOKEN;
  process.env.FORGEDOCK_NESTED_AGENT_URL = endpoint.url;
  process.env.FORGEDOCK_NESTED_AGENT_TOKEN = "test-token";
  const runtime = new PiAgentRuntime({ provider: "test-provider", model: "test-model" });
  try {
    await assert.rejects(runtime.run(taskForRole("reviewer") as any), /did not acknowledge the exact scope manifest receipt/);
  } finally {
    await runtime.close();
    restoreNestedEnvironment(previousUrl, previousToken);
    await endpoint.close();
  }
});

function restoreNestedEnvironment(previousUrl: string | undefined, previousToken: string | undefined): void {
  if (previousUrl === undefined) delete process.env.FORGEDOCK_NESTED_AGENT_URL;
  else process.env.FORGEDOCK_NESTED_AGENT_URL = previousUrl;
  if (previousToken === undefined) delete process.env.FORGEDOCK_NESTED_AGENT_TOKEN;
  else process.env.FORGEDOCK_NESTED_AGENT_TOKEN = previousToken;
}
