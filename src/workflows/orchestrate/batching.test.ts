import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  affectedFilesFromIssueBody,
  chunkBatchCandidates,
  contractBatchGroups,
  pairSensitiveBatchCandidates,
  parseBatchContract,
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
    repository: "owner/repo",
    targetBranch: "main",
    labels: ["review-finding", "priority:P3"],
    affectedFiles: ["src/core/a.ts"],
    ...overrides,
  };
}

function sensitiveItem(issue: number, overrides: Partial<BatchableWorkItem> = {}): BatchableWorkItem {
  return item(issue, {
    riskClass: "auth",
    causalFamily: "session-validation",
    riskCapabilities: ["session-integrity"],
    primaryDomain: "identity/session",
    sharedSymbols: ["validateSession"],
    acceptanceCriteria: [`Validate session case ${issue}`],
    ...overrides,
  });
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

  it("requires explicit semantic evidence and caps sensitive planner groups at two", () => {
    const hintsOnly = planIssueBatches([
      item(10, { riskClass: "auth", causalFamily: "session-validation", acceptanceCriteria: ["Reject invalid session"], sourcePullRequest: 9 }),
      item(11, { riskClass: "auth", causalFamily: "session-validation", acceptanceCriteria: ["Reject invalid session"], sourcePullRequest: 9 }),
    ]);
    assert.equal(hintsOnly.groups.length, 0);

    const compatible = planIssueBatches([sensitiveItem(12), sensitiveItem(13), sensitiveItem(14)]);
    assert.deepEqual(compatible.groups.map((group) => group.members.map((member) => member.issue)), [[12, 13]]);
    assert.deepEqual(compatible.ungrouped.map((member) => member.issue), [14]);
  });

  it("pairs sensitive candidates in stable order and shares bounded chunking", () => {
    const candidates = [
      sensitiveItem(10, { causalFamily: "unmatched-family" }),
      sensitiveItem(11, { causalFamily: " SESSION-VALIDATION ", riskCapabilities: [" SESSION-INTEGRITY "] }),
      sensitiveItem(12),
      sensitiveItem(13, { causalFamily: "other-family" }),
    ];
    const originalOrder = [...candidates];

    const pairs = pairSensitiveBatchCandidates(candidates);

    assert.deepEqual(pairs.map((pair) => pair.map((member) => member.issue)), [[11, 12]]);
    assert.deepEqual(candidates, originalOrder);
    assert.equal(new Set(pairs.flat()).size, pairs.flat().length);
    assert.deepEqual(chunkBatchCandidates([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
    assert.throws(() => chunkBatchCandidates([1], 0), /chunk size must be a positive integer/);
  });

  it("round-trips sensitive compatibility evidence in the member contract", () => {
    const group = planIssueBatches([sensitiveItem(20), sensitiveItem(21)]).groups[0]!;
    const body = renderBatchIssueBody(group);
    const contracts = parseBatchContract(body);
    assert.deepEqual(contracts[0], {
      issue: 20,
      repository: "owner/repo",
      title: "Finding 20",
      acceptanceCriteria: ["Validate session case 20"],
      affectedFiles: ["src/core/a.ts"],
      claims: ["src/core/a.ts"],
      riskClass: "auth",
      causalFamily: "session-validation",
      riskCapabilities: ["session-integrity"],
      primaryDomain: "identity/session",
      sharedSymbols: ["validateSession"],
    });
    assert.throws(
      () => parseBatchContract(body.replaceAll('"causalFamily":"session-validation",', "")),
      /Sensitive batch contract lacks explicit compatible cause/,
    );
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
    assert.equal(batch.repository, "owner/repo");
    assert.equal(batch.targetBranch, "main");
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
    const affectedFiles = affectedFilesFromIssueBody(body);
    assert.deepEqual(affectedFiles, ["src/core/a.ts", "src/core/b.ts"]);
    const graph = materializeClaimDependencies([
      { id: "planned", issue: 1, priority: 1, dependencies: [], claims: [affectedFiles[0]!] },
      { id: "concrete", issue: 2, priority: 1, dependencies: [], claims: ["src/core/a.ts"] },
    ]);
    assert.deepEqual(graph.edges.map(({ predecessor, successor }) => [predecessor, successor]), [["planned", "concrete"]]);
  });

  it("extracts every plain source location declared in one affected-files bullet", () => {
    const body = [
      "## Affected Files",
      "- `src/workflows/orchestrate/node-lease.ts` — src/workflows/orchestrate/node-lease.ts:34-42; src/core/ports/lease.ts:4-13; src/adapters/sqlite/sqlite-repositories.ts:442-448",
      "## Evidence",
      "Do not authorize src/unrelated/outside.ts from another section.",
    ].join("\n");
    assert.deepEqual(affectedFilesFromIssueBody(body), [
      "src/workflows/orchestrate/node-lease.ts",
      "src/core/ports/lease.ts",
      "src/adapters/sqlite/sqlite-repositories.ts",
    ]);
  });

  it("accepts bounded glob paths and ignores unsafe or unbounded paths", () => {
    const body = [
      "## Affected Files", "- `src/**/*.ts`", "- `src/components/*.tsx`", "- `**/*.md`", "- `../outside.ts`", "- `src/../../outside.ts`", "- `/etc/passwd`", "- `C:/etc/passwd`",
    ].join("\n");
    const affectedFiles = affectedFilesFromIssueBody(body);
    assert.deepEqual(affectedFiles, ["src/**/*.ts", "src/components/*.tsx"]);
    for (const [glob, concrete] of [["src/**/*.ts", "src/foo.ts"], ["src/components/*.tsx", "src/components/button.tsx"]] as const) {
      const graph = materializeClaimDependencies([
        { id: "glob", issue: 1, priority: 1, dependencies: [], claims: [glob] },
        { id: "concrete", issue: 2, priority: 1, dependencies: [], claims: [concrete] },
      ]);
      assert.deepEqual(graph.edges.map(({ predecessor, successor }) => [predecessor, successor]), [["glob", "concrete"]]);
    }
  });

  it("preserves bounded glob claims through contraction and re-materializes concrete conflicts", () => {
    const glob = "src/**/*.ts";
    const members = [
      item(11, { affectedFiles: [glob], claims: [glob] }),
      item(12, { affectedFiles: [glob], claims: [glob] }),
    ];
    const concrete = item(13, { affectedFiles: ["src/foo.ts"], claims: ["src/foo.ts"] });
    const contracted = contractBatchGroups([...members, concrete], [{
      id: "batch:same-file:src-glob:11-12",
      kind: "same-file",
      key: glob,
      riskClass: "routine",
      members,
    }], [{
      groupId: "batch:same-file:src-glob:11-12",
      issue: 20,
      title: "Batch findings",
      summary: "Deliver bounded glob findings",
    }]);
    const batch = contracted.find((candidate) => candidate.issue === 20);
    assert.ok(batch);
    assert.deepEqual(batch.affectedFiles, [glob]);
    assert.deepEqual(batch.claims, [glob]);
    const graph = materializeClaimDependencies(contracted);
    assert.deepEqual(graph.edges.map(({ predecessor, successor }) => [predecessor, successor]), [["issue-13", "issue-20"]]);
    assert.deepEqual(graph.edges[0]?.overlappingClaims, ["src/foo.ts ↔ src/**/*.ts"]);
  });

  it("renders and parses durable batch membership", () => {
    const group = planIssueBatches([item(7), item(8)]).groups[0]!;
    const body = renderBatchIssueBody(group);
    assert.deepEqual(parseBatchMemberIssues(body), [7, 8]);
    assert.match(body, /Successful completion records the batch Outcome on every member/);
  });
});
