import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildOrchestrationSnapshot, renderOrchestrationBoard } from "./view-model.js";

describe("orchestration status presentation", () => {
  it("keeps failed, blocked, invalid, and suspended nodes visibly distinct", () => {
    const snapshot = buildOrchestrationSnapshot({
      orchestrationId: "orch-status",
      items: [
        { id: "failed", issue: 1, priority: 1, dependencies: [], claims: [] },
        { id: "blocked", issue: 2, priority: 1, dependencies: [], claims: [] },
        { id: "invalid", issue: 3, priority: 1, dependencies: [], claims: [] },
        { id: "suspended", issue: 4, priority: 1, dependencies: [], claims: [] },
      ],
      result: {
        status: new Map([
          ["failed", "failed"],
          ["blocked", "blocked"],
          ["invalid", "invalid"],
          ["suspended", "suspended"],
        ]),
        errors: new Map(),
      },
    });
    const rendered = renderOrchestrationBoard(snapshot);
    assert.match(rendered, /✕ #1 \[failed\]/);
    assert.match(rendered, /■ #2 \[blocked\]/);
    assert.match(rendered, /! #3 \[invalid\]/);
    assert.match(rendered, /Ⅱ #4 \[suspended\]/);
    assert.deepEqual(snapshot.blockedNodes, ["failed", "blocked"]);
    assert.deepEqual(snapshot.invalidNodes, ["invalid"]);
    assert.deepEqual(snapshot.suspendedNodes, ["suspended"]);
  });
});
