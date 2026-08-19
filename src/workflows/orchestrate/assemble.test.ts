import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { assembleWorkUnits, DEFAULT_BATCHING_OPTIONS } from "./assemble.js";
import { contractBatchGroups, parseBatchContract, parseBatchMemberIssues, renderBatchIssueBody, type BatchableWorkItem } from "./batching.js";

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

function sensitiveItem(issue: number, overrides: Partial<BatchableWorkItem> = {}): BatchableWorkItem {
  return item(issue, {
    riskClass: "security",
    causalFamily: "token-validation",
    riskCapabilities: ["credential-validation"],
    primaryDomain: "identity/session",
    sharedSymbols: ["verifyToken"],
    acceptanceCriteria: [`Reject invalid token variant ${issue}`],
    ...overrides,
  });
}

describe("shared work-unit assembly", () => {
  it("defaults five selected issues to five singleton nodes with no contraction", () => {
    const values = [item(5), item(1), item(3), item(2), item(4)];
    const result = assembleWorkUnits(values, DEFAULT_BATCHING_OPTIONS);
    assert.equal(result.policy.policy, "none");
    assert.equal(result.groups.length, 0);
    assert.deepEqual(result.selected.map((member) => member.issue), [1, 2, 3, 4, 5]);
    assert.deepEqual(result.ungrouped.map((member) => member.issue), [1, 2, 3, 4, 5]);
    assert.equal(result.selected.length, values.length);
    assert.equal(contractBatchGroups(result.selected, result.groups, []).length, 5);
  });

  it("preserves explicit aggressive contraction and conservative policy", () => {
    const values = [
      item(1, { labels: ["review-finding", "priority:P2"] }),
      item(2, { labels: ["review-finding", "priority:P2"] }),
      item(3, { labels: ["review-finding", "priority:P2"], affectedFiles: ["src/api/b.ts"] }),
      item(4, { labels: ["review-finding", "priority:P2"], repository: "owner/other" }),
    ];
    const aggressive = assembleWorkUnits(values, { ...DEFAULT_BATCHING_OPTIONS, policy: "aggressive" });
    const conservative = assembleWorkUnits(values, { ...DEFAULT_BATCHING_OPTIONS, policy: "conservative" });
    assert.deepEqual(aggressive.groups[0]?.members.map((member) => member.issue), [1, 2]);
    assert.equal(aggressive.groups[0]?.kind, "same-file");
    assert.deepEqual(conservative.groups[0]?.members.map((member) => member.issue), [1, 2]);
    assert.ok(aggressive.ungrouped.some((member) => member.issue === 4));
    assert.ok(conservative.ungrouped.some((member) => member.issue === 4));
  });

  it("caps explicitly compatible sensitive batches at two members", () => {
    assert.equal(DEFAULT_BATCHING_OPTIONS.maxSensitiveBatchSize, 2);
    const result = assembleWorkUnits([
      sensitiveItem(1), sensitiveItem(2), sensitiveItem(3),
    ], { ...DEFAULT_BATCHING_OPTIONS, policy: "aggressive", maxSensitiveBatchSize: 3 });
    assert.deepEqual(result.groups.map((group) => group.members.map((member) => member.issue)), [[1, 2]]);
    assert.deepEqual(result.ungrouped.map((member) => member.issue), [3]);
  });

  it("rejects same-file and source-PR hints without explicit sensitive compatibility", () => {
    const values = [
      item(10, { riskClass: "security", causalFamily: "token-validation", acceptanceCriteria: ["Reject invalid token"], sourcePullRequest: 44 }),
      item(11, { riskClass: "security", causalFamily: "token-validation", acceptanceCriteria: ["Reject invalid token"], sourcePullRequest: 44 }),
    ];
    const result = assembleWorkUnits(values, { ...DEFAULT_BATCHING_OPTIONS, policy: "aggressive" });
    assert.equal(result.groups.length, 0);
    assert.deepEqual(result.ungrouped.map((member) => member.issue), [10, 11]);

    const differentCause = assembleWorkUnits([
      sensitiveItem(12, { causalFamily: "token-validation" }),
      sensitiveItem(13, { causalFamily: "permission-bypass" }),
    ], { ...DEFAULT_BATCHING_OPTIONS, policy: "aggressive" });
    assert.equal(differentCause.groups.length, 0);
  });

  it("bounds sensitive batches to four production paths and three atomic criteria", () => {
    const tooManyPaths = assembleWorkUnits([
      sensitiveItem(20, { affectedFiles: ["src/security/shared.ts", "src/security/a.ts", "src/security/b.ts"] }),
      sensitiveItem(21, { affectedFiles: ["src/security/shared.ts", "src/security/c.ts", "src/security/d.ts"] }),
    ], { ...DEFAULT_BATCHING_OPTIONS, policy: "aggressive" });
    assert.equal(tooManyPaths.groups.length, 0);

    const tooManyCriteria = assembleWorkUnits([
      sensitiveItem(22, { acceptanceCriteria: ["Reject expired tokens", "Reject wrong-audience tokens"] }),
      sensitiveItem(23, { acceptanceCriteria: ["Reject replayed tokens", "Reject malformed tokens"] }),
    ], { ...DEFAULT_BATCHING_OPTIONS, policy: "aggressive" });
    assert.equal(tooManyCriteria.groups.length, 0);
  });

  it("accepts primary-domain or symbol overlap as secondary sensitive evidence", () => {
    const byDomain = assembleWorkUnits([
      sensitiveItem(30, { riskCapabilities: ["token-read"], sharedSymbols: ["readToken"] }),
      sensitiveItem(31, { riskCapabilities: ["token-write"], sharedSymbols: ["writeToken"] }),
    ], { ...DEFAULT_BATCHING_OPTIONS, policy: "aggressive" });
    assert.deepEqual(byDomain.groups[0]?.members.map((member) => member.issue), [30, 31]);

    const bySymbol = assembleWorkUnits([
      sensitiveItem(32, { riskCapabilities: ["token-read"], primaryDomain: "edge", sharedSymbols: ["verifyToken"] }),
      sensitiveItem(33, { riskCapabilities: ["token-write"], primaryDomain: "worker", sharedSymbols: ["verifyToken"] }),
    ], { ...DEFAULT_BATCHING_OPTIONS, policy: "aggressive" });
    assert.deepEqual(bySymbol.groups[0]?.members.map((member) => member.issue), [32, 33]);
  });

  it("rejects an already-contracted node under none", () => {
    assert.throws(() => assembleWorkUnits([
      item(99, { memberIssues: [1, 2] }),
    ], DEFAULT_BATCHING_OPTIONS), /one selected issue per node/);
  });

  it("keeps recoverable needs-human prerequisites as singleton work units", () => {
    const result = assembleWorkUnits([
      item(110, { labels: ["enhancement", "needs-human"], affectedFiles: [] }),
      item(111, { dependencies: ["issue-110"] }),
      item(112, { labels: ["enhancement", "operator-only"] }),
    ], { ...DEFAULT_BATCHING_OPTIONS, policy: "aggressive" });
    assert.deepEqual(result.selected.map((member) => member.issue), [110, 111]);
    assert.ok(result.ungrouped.some((member) => member.issue === 110));
    assert.ok(result.excluded.some(({ item: member, reason }) => member.issue === 110 && reason === "recovery-state"));
    assert.ok(result.excluded.some(({ item: member, reason }) => member.issue === 112 && reason === "human-or-batch-state"));
  });

  it("does not batch unrelated findings merely because they share a source PR", () => {
    const result = assembleWorkUnits([
      item(201, { affectedFiles: ["src/runtime/a.ts"], claims: ["src/runtime/a.ts"], sourcePullRequest: 137 }),
      item(202, { affectedFiles: [".github/workflows/ci.yml"], claims: [".github/workflows/ci.yml"], sourcePullRequest: 137 }),
    ], { ...DEFAULT_BATCHING_OPTIONS, policy: "aggressive" });
    assert.equal(result.groups.length, 0);
    assert.deepEqual(result.ungrouped.map((member) => member.issue), [201, 202]);
  });

  it("keeps inherited batch-labelled decomposition children dispatchable but never re-batches them", () => {
    const result = assembleWorkUnits([
      item(172, { labels: ["review-finding", "priority:P2", "batch"], sourcePullRequest: 137 }),
      item(173, { labels: ["review-finding", "priority:P2", "batch"], sourcePullRequest: 137 }),
      item(139, { labels: ["review-finding", "priority:P2"], sourcePullRequest: 137 }),
      item(143, { labels: ["review-finding", "priority:P2"], sourcePullRequest: 137 }),
    ], { ...DEFAULT_BATCHING_OPTIONS, policy: "aggressive" });
    assert.deepEqual(result.selected.map((member) => member.issue), [139, 143, 172, 173]);
    assert.deepEqual(result.groups[0]?.members.map((member) => member.issue), [139, 143]);
    assert.deepEqual(result.ungrouped.map((member) => member.issue), [172, 173]);
    assert.ok(result.excluded.every(({ item: member }) => member.issue !== 172 && member.issue !== 173));
  });

  it("filters before grouping and rejects mutually exclusive milestone selectors", () => {
    const result = assembleWorkUnits([
      item(1, { labels: ["enhancement", "priority:P1"], milestone: "release" }),
      item(2, { labels: ["enhancement", "priority:P1"], milestone: "release" }),
      item(3, { labels: ["enhancement", "priority:P1"], milestone: "other" }),
    ], { ...DEFAULT_BATCHING_OPTIONS, policy: "aggressive", priorities: ["P1"], milestone: "release" });
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
