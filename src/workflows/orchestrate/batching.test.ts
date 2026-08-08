import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  affectedFilesFromIssueBody,
  contractBatchGroups,
  parseBatchMemberIssues,
  planIssueBatches,
  renderBatchIssueBody,
  type BatchableWorkItem,
} from "./batching.js";
import { materializeClaimDependencies } from "./scheduler.js";

function item(issue: number, overrides: Partial<BatchableWorkItem> = {}): BatchableWorkItem {
  return {
    id: `issue-${issue}`,
    issue,
    title: `Finding ${issue}`,
    summary: `Fix finding ${issue}`,
    priority: 30,
    dependencies: [],
    claims: ["src/core/a.ts"],
    labels: ["review-finding", "priority:P3"],
    affectedFiles: ["src/core/a.ts"],
    ...overrides,
  };
}

describe("orchestration work-unit batching", () => {
  it("groups compatible P2/P3 review findings but not milestone feature issues", () => {
    const plan = planIssueBatches([
      item(1, { labels: ["review-finding", "priority:P2"] }),
      item(2),
      item(3, { labels: ["enhancement", "priority:P2"] }),
    ]);
    assert.deepEqual(plan.groups.map((group) => group.members.map((member) => member.issue)), [[1, 2]]);
    assert.equal(plan.excluded.find(({ item: value }) => value.issue === 3)?.reason, "not-review-finding");
  });

  it("excludes high-blast-radius and billing work", () => {
    const plan = planIssueBatches([
      item(1, { affectedFiles: ["src/main.ts"] }),
      item(2, { affectedFiles: ["src/main.ts"] }),
      item(3, { riskClass: "billing" }),
    ]);
    assert.equal(plan.groups.length, 0);
    assert.deepEqual(plan.excluded.map(({ reason }) => reason), ["high-blast-radius", "high-blast-radius", "billing"]);
  });

  it("contracts members into one DAG node and lifts incoming and outgoing dependencies", () => {
    const members = [
      item(2, { dependencies: ["issue-1"] }),
      item(3, { dependencies: ["issue-2"] }),
    ];
    const predecessor = item(1, { labels: ["enhancement"], affectedFiles: ["docs/spec.md"], claims: ["docs"] });
    const successor = item(4, { labels: ["enhancement"], affectedFiles: ["src/api.ts"], claims: ["api"], dependencies: ["issue-3"] });
    const plan = planIssueBatches([predecessor, ...members, successor]);
    const contracted = contractBatchGroups([predecessor, ...members, successor], plan.groups, [{
      groupId: plan.groups[0]!.id,
      issue: 20,
      title: "Batch findings",
      summary: "Deliver findings 2 and 3 together",
    }]);
    const batch = contracted.find((value) => value.issue === 20)!;
    assert.deepEqual(batch.memberIssues, [2, 3]);
    assert.deepEqual(batch.dependencies, ["issue-1"]);
    assert.deepEqual(contracted.find((value) => value.issue === 4)?.dependencies, ["issue-20"]);
    assert.ok(!contracted.some((value) => value.issue === 2 || value.issue === 3));
  });

  it("rejects a non-convex batch contraction that would create a dependency cycle", () => {
    const first = item(1, { dependencies: ["issue-3"] });
    const second = item(2);
    const middle = item(3, { labels: ["enhancement"], affectedFiles: ["src/other.ts"], dependencies: ["issue-2"] });
    const plan = planIssueBatches([first, second, middle]);
    const contracted = contractBatchGroups([first, second, middle], plan.groups, [{
      groupId: plan.groups[0]!.id, issue: 20, title: "Batch", summary: "Batch",
    }]);
    assert.throws(() => materializeClaimDependencies(contracted), /Dependency cycle/);
  });

  it("extracts batching paths only from the scoped affected-files section", () => {
    const body = [
      "## Context", "See `src/not-a-deliverable.ts`.",
      "## Affected Files", "1. `src/core/a.ts` — change", "2. `src/core/b.ts` — test",
      "## Related", "See `src/not-this-either.ts`.",
    ].join("\n");
    assert.deepEqual(affectedFilesFromIssueBody(body), ["src/core/a.ts", "src/core/b.ts"]);
  });

  it("accepts bounded glob paths and ignores unsafe or unbounded paths", () => {
    const body = [
      "## Affected Files", "- `src/**/*.ts`", "- `src/components/*.tsx`", "- `**/*.md`", "- `../outside.ts`", "- `/etc/passwd`",
    ].join("\n");
    assert.deepEqual(affectedFilesFromIssueBody(body), ["src/**/*.ts", "src/components/*.tsx"]);
  });

  it("renders and parses durable batch membership", () => {
    const group = planIssueBatches([item(7), item(8)]).groups[0]!;
    const body = renderBatchIssueBody(group);
    assert.deepEqual(parseBatchMemberIssues(body), [7, 8]);
    assert.match(body, /Successful completion records the batch Outcome on every member/);
  });
});
