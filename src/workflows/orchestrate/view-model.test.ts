import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildOrchestrationSnapshot, renderOrchestrationBoard, renderWaitReason } from "./view-model.js";

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

  it("projects issue slots, routes, titles, and same-route serialization chains with paths", () => {
    const items = [
      { id: "first", issue: 10, priority: 1, dependencies: [], claims: ["src/shared"], repository: "owner/repo", targetBranch: "main", lane: "fast" as const, title: "First route" },
      { id: "second", issue: 11, priority: 1, dependencies: [], claims: ["src/shared/file.ts"], repository: "owner/repo", targetBranch: "main", lane: "fast" as const, title: "Batch route", memberIssues: [11, 12] },
      { id: "third", issue: 13, priority: 1, dependencies: ["first"], claims: ["src/shared/deep.ts"], repository: "owner/repo", targetBranch: "main", lane: "fast" as const, title: "Third route" },
    ];
    const snapshot = buildOrchestrationSnapshot({
      orchestrationId: "orch-detail",
      items,
      serializationEdges: [
        { predecessor: "first", successor: "second", overlappingClaims: ["src/shared"] },
        { predecessor: "second", successor: "third", overlappingClaims: ["src/shared/file.ts"] },
      ],
      selectedIssueNumbers: [10, 11, 12, 13],
      requestedMaxParallel: 4,
      transportCapacity: 2,
      effectiveMaxParallel: 2,
    });
    assert.deepEqual(snapshot.selectedIssueNumbers, [10, 11, 12, 13]);
    assert.deepEqual(snapshot.issueSlots, {
      selected: 4,
      runnableNow: 1,
      requestedCap: 4,
      transportCap: 2,
      effectiveCap: 2,
    });
    assert.equal(snapshot.nodes[0]?.title, "First route");
    assert.deepEqual(snapshot.nodes[0]?.route, { repository: "owner/repo", targetBranch: "main", lane: "fast" });
    assert.deepEqual(snapshot.serializationChains?.map((chain) => chain.nodes), [["first", "second", "third"]]);
    assert.deepEqual(snapshot.serializationEdges?.map((edge) => edge.paths), [["src/shared"], ["src/shared/file.ts"]]);
    const rendered = renderOrchestrationBoard(snapshot);
    assert.match(rendered, /4 selected · 1 runnable now · requested cap 4 · transport cap 2 · effective cap 2/);
    assert.match(rendered, /#11 members=#11,#12 Batch route/);
    assert.match(rendered, /#10 → #11\[#11, #12\] → #13 · route owner\/repo@main \(fast\) · paths src\/shared, src\/shared\/file\.ts/);
    assert.match(rendered, /semantic-deps=first/);
  });

  it("renders every wait reason kind and tolerates legacy snapshots", () => {
    assert.equal(renderWaitReason({ kind: "dependency", predecessor: "a" }), "semantic dependency a");
    assert.equal(renderWaitReason({ kind: "claim-serialization", predecessor: "a", claims: ["src/a.ts"] }), "serialized after a on src/a.ts");
    assert.match(renderWaitReason({ kind: "active-claim-conflict", node: "a", claims: ["src/a.ts"] }), /deferred behind active a.*scheduler retries automatically/);
    assert.equal(renderWaitReason({ kind: "capacity", maxParallel: 0 }), "capacity 0 issue slot(s)");
    assert.equal(renderWaitReason({ kind: "suspended-predecessor", predecessor: "a", checkpoint: "cp-1" }), "suspended predecessor a at cp-1");
    assert.equal(renderWaitReason({ kind: "decomposition-replan", children: [20, 21] }), "decomposition replan #20,#21");

    const legacy = {
      orchestrationId: "legacy",
      nodes: [{ id: "legacy-node", issue: 9, status: "queued", dependencies: [], claims: [] }],
      readyNodes: ["legacy-node"],
      blockedNodes: [],
      invalidNodes: [],
      suspendedNodes: [],
      activeLeases: [],
      remediationCheckpoints: [],
      updatedAt: "2026-01-01T00:00:00.000Z",
    } as any;
    assert.doesNotThrow(() => renderOrchestrationBoard(legacy));
    assert.match(renderOrchestrationBoard(legacy), /1 selected · 1 runnable now · requested cap unknown/);
  });
});
