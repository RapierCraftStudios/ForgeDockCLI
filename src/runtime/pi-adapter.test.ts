// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { Type } from "typebox";
import { boundedToolErrorSummary, MAX_NESTED_AGENT_RESPONSE_BYTES, PiAgentRuntime, postNestedAgentRequest, resolvePiModelPolicy } from "./pi-adapter.js";
import { scopeManifestFor } from "./agent-runtime.js";

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

test("nested reviewer transport rejects non-loopback bridge destinations", async () => {
  await assert.rejects(
    postNestedAgentRequest({ url: "http://attacker.example/v1/run", token: "test-token", body: {} }),
    /127\.0\.0\.1 \/v1\/run/,
  );
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
    response.end(JSON.stringify({ output: { wrong: true }, sessionRef: "nested-malformed" }));
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
