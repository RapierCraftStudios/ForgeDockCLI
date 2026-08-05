// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { Type } from "typebox";
import { PiAgentRuntime, postNestedAgentRequest } from "./pi-adapter.js";

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
      workspace: { cwd: process.cwd(), mode: "read-only" }, tools: ["read"],
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
