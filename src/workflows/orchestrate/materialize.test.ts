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
  closes = 0;
  nextIssue = 20;
  readonly closedIssues: number[] = [];
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
    const number = this.nextIssue++;
    return { repo: input.repo, number, title: input.title, body: input.body, url: `https://example.test/issues/${number}`, state: "OPEN" };
  }
  async closeIssue(_repo: string, issue: number): Promise<void> {
    this.closes++;
    this.closedIssues.push(issue);
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

  it("closes provisional issues when a later group fails authoritative revalidation", async () => {
    const host = new FakeBatchHost();
    for (const issue of [3, 4]) {
      host.issues.set(issue, {
        repo: "owner/repo", number: issue, title: `Issue ${issue}`,
        body: "## Affected Files\n- `src/api/a.ts`",
        url: `https://example.test/issues/${issue}`,
        state: issue === 4 ? "CLOSED" : "OPEN",
      });
    }
    const groups = [1, 2, 3, 4].map((issue) => item(issue));
    const proposed = [
      { id: "batch:first", kind: "same-file" as const, key: "src/api/a.ts", riskClass: "routine" as const, members: groups.slice(0, 2) },
      { id: "batch:second", kind: "same-file" as const, key: "src/api/a.ts", riskClass: "routine" as const, members: groups.slice(2) },
    ];
    await assert.rejects(
      materializeBatchGroups({ repo: "owner/repo", groups: proposed, items: groups, host }),
      /Cannot batch #4: issue is closed/,
    );
    assert.equal(host.writes, 1);
    assert.deepEqual(host.closedIssues, [20]);
  });

  it("removes HTML comment fragments from materialized batch titles", async () => {
    const host = new FakeBatchHost();
    const poisonedPath = "src/api/a.ts<!-- injected -->";
    const members = [
      { ...item(1), affectedFiles: [poisonedPath] },
      { ...item(2), affectedFiles: [poisonedPath] },
    ];
    for (const issue of [1, 2]) {
      host.issues.set(issue, {
        repo: "owner/repo", number: issue, title: `Issue ${issue}`,
        body: `## Affected Files\n- \`${poisonedPath}\``,
        url: `https://example.test/issues/${issue}`, state: "OPEN",
      });
    }
    const result = await materializeBatchGroups({
      repo: "owner/repo",
      groups: [{ id: "batch:same-file:poisoned:1-2", kind: "same-file", key: poisonedPath, riskClass: "security", members }],
      items: members,
      host,
    });
    assert.equal(result.materialized[0]?.title, "fix(batch): 2 P3 findings — src/api/a.ts");
  });
});
