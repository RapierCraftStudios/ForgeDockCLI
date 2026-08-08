import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { assembleWorkUnits, DEFAULT_BATCHING_OPTIONS } from "./assemble.js";
import { parseBatchContract, parseBatchMemberIssues, renderBatchIssueBody, type BatchableWorkItem } from "./batching.js";

function item(issue: number, overrides: Partial<BatchableWorkItem> = {}): BatchableWorkItem {
  return {
    id: `issue-${issue}`,
    issue,
    priority: 20,
    dependencies: [],
    claims: ["component:api"],
    title: `Issue ${issue}`,
    summary: `Acceptance for ${issue}`,
    labels: ["enhancement", "priority:P2"],
    affectedFiles: ["src/api/a.ts"],
    repository: "owner/repo",
    targetBranch: "main",
    urgencyTier: "normal",
    ...overrides,
  };
}

describe("shared work-unit assembly", () => {
  it("defaults to bounded aggressive ordinary issue grouping with deterministic precedence", () => {
    const result = assembleWorkUnits([
      item(3), item(1), item(2, { affectedFiles: ["src/api/b.ts"] }),
      item(4, { riskClass: "billing" }),
    ], DEFAULT_BATCHING_OPTIONS);
    assert.deepEqual(result.groups[0]?.members.map((member) => member.issue), [1, 3]);
    assert.equal(result.groups[0]?.kind, "same-file");
    assert.ok(result.ungrouped.some((member) => member.issue === 2));
    assert.ok(result.excluded.some(({ item: member, reason }) => member.issue === 4 && reason === "billing"));
  });

  it("keeps conservative and none explicit rather than silently changing policy", () => {
    const values = [item(1), item(2)];
    const conservative = assembleWorkUnits(values, { ...DEFAULT_BATCHING_OPTIONS, policy: "conservative" });
    const none = assembleWorkUnits(values, { ...DEFAULT_BATCHING_OPTIONS, policy: "none" });
    assert.equal(conservative.groups.length, 0);
    assert.equal(none.groups.length, 0);
    assert.deepEqual(none.ungrouped.map((member) => member.issue), [1, 2]);
  });

  it("filters before grouping and rejects mutually exclusive milestone selectors", () => {
    const result = assembleWorkUnits([
      item(1, { labels: ["enhancement", "priority:P1"], milestone: "release" }),
      item(2, { labels: ["enhancement", "priority:P1"], milestone: "release" }),
      item(3, { labels: ["enhancement", "priority:P1"], milestone: "other" }),
    ], { ...DEFAULT_BATCHING_OPTIONS, priorities: ["P1"], milestone: "release" });
    assert.deepEqual(result.selected.map((member) => member.issue), [1, 2]);
    assert.deepEqual(result.groups[0]?.members.map((member) => member.issue), [1, 2]);
    assert.throws(() => assembleWorkUnits([], { ...DEFAULT_BATCHING_OPTIONS, milestone: "release", noMilestone: true }), /mutually exclusive/);
  });

  it("renders a strict bounded member contract", () => {
    const body = renderBatchIssueBody({
      id: "batch:same-file:src/api/a.ts:1-2", kind: "same-file", key: "src/api/a.ts", riskClass: "routine",
      members: [item(1), item(2)],
    });
    assert.deepEqual(parseBatchMemberIssues(body), [1, 2]);
    assert.deepEqual(parseBatchContract(body).map((member) => member.issue), [1, 2]);
    assert.throws(() => parseBatchContract(body.replace("\"issue\":2", "\"issue\":1")), /duplicated|invalid/i);
  });
});
