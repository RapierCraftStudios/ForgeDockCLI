import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { IssueSnapshot } from "../../core/ports/forge-host.js";
import { materializeBatchGroups, type BatchMaterializationHost } from "./materialize.js";
import { assembleWorkUnits } from "./assemble.js";
import type { BatchableWorkItem } from "./batching.js";

function item(issue: number): BatchableWorkItem {
  return {
    id: `issue-${issue}`, issue, priority: 20, dependencies: [], claims: ["src/api"],
    title: `Issue ${issue}`, summary: "Fix", labels: ["enhancement", "priority:P2"],
    affectedFiles: ["src/api/a.ts"], repository: "owner/repo", targetBranch: "main", urgencyTier: "normal",
  };
}

class FakeBatchHost implements BatchMaterializationHost {
  writes = 0;
  readonly issues = new Map<number, IssueSnapshot>([
    [1, { repo: "owner/repo", number: 1, title: "One", body: "## Affected Files\n- `src/api/a.ts`", url: "https://example.test/issues/1", state: "OPEN" }],
    [2, { repo: "owner/repo", number: 2, title: "Two", body: "## Affected Files\n- `src/api/a.ts`", url: "https://example.test/issues/2", state: "OPEN" }],
  ]);
  async getIssue(number: number): Promise<IssueSnapshot> {
    const issue = this.issues.get(number);
    if (!issue) throw new Error(`missing #${number}`);
    return issue;
  }
  async materializeBatchIssue(input: { repo: string; title: string; body: string; priorityLabel: "priority:P2" | "P2" | "priority:P3" | "P3" }): Promise<IssueSnapshot> {
    this.writes++;
    return { repo: input.repo, number: 20, title: input.title, body: input.body, url: "https://example.test/issues/20", state: "OPEN" };
  }
}

describe("authoritative batch materialization", () => {
  it("revalidates members and writes only through the host port", async () => {
    const host = new FakeBatchHost();
    const assembly = assembleWorkUnits([item(1), item(2)], {
      policy: "aggressive", maxBatchSize: 8, maxSensitiveBatchSize: 3,
    });
    const result = await materializeBatchGroups({ repo: "owner/repo", groups: assembly.groups, items: [item(1), item(2)], host });
    assert.equal(host.writes, 1);
    assert.equal(result.materialized[0]?.issue, 20);
    assert.equal(result.groups[0]?.members[0]?.title, "One");
  });
});
