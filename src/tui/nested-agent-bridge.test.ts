// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { startNestedAgentBridge } from "./nested-agent-bridge.js";

class FakeEvents {
  handlers = new Map<string, Array<(data: unknown) => void>>();
  requests: any[] = [];

  on(name: string, handler: (data: unknown) => void): () => void {
    this.handlers.set(name, [...(this.handlers.get(name) ?? []), handler]);
    return () => this.handlers.set(name, (this.handlers.get(name) ?? []).filter((candidate) => candidate !== handler));
  }

  emit(name: string, data: any): void {
    if (name === "prompt-template:subagent:request") {
      this.requests.push(data);
      queueMicrotask(() => this.emit("prompt-template:subagent:response", {
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
    for (const handler of this.handlers.get(name) ?? []) handler(data);
  }
}

test("controller reviewer tasks use the child-safe nested delegation protocol", async () => {
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
        ownerRunId: "run-4",
        id: "run-4:review:abc:correctness",
        role: "reviewer",
        objective: "Review frozen SHA abc",
        instructions: "Read only",
        context: [],
        cwd: process.cwd(),
        tools: ["read", "grep", "find", "ls"],
        outputSchema: { type: "object" },
        provider: "openai-codex",
        model: "gpt-test",
      }),
    });
    assert.equal(response.status, 200);
    const result = await response.json() as any;
    assert.deepEqual(result.output, { summary: "clean", findings: [] });
    assert.equal(result.sessionRef, "nested-review-run");
    assert.equal(events.requests[0]?.version, 2);
    assert.equal(events.requests[0]?.agent, "forgedock-reviewer");
    assert.equal(events.requests[0]?.context, "fresh");
    assert.equal(events.requests[0]?.result.kind, "structured");
  } finally {
    await bridge.close();
  }
});
