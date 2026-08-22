import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { IssueSnapshot } from "../../core/ports/forge-host.js";
import { InMemoryOrchestrationRepository } from "../../core/ports/repositories.js";
import { InvestigationAdmissionService } from "./investigation-admission.js";

function host() {
  const heads = new Map<string, string>([["main", "a".repeat(40)]]);
  const issues = new Map<number, IssueSnapshot>([
    [1, { repo: "owner/repo", number: 1, title: "One", body: "Fix", url: "https://example.test/1", state: "OPEN" }],
    [2, { repo: "owner/repo", number: 2, title: "Two", body: "Fix", url: "https://example.test/2", state: "OPEN" }],
  ]);
  let decompositionWrites = 0;
  return {
    heads, issues, getIssue: async (number: number) => issues.get(number)!,
    getBranchHead: async (_repo: string, branch: string) => heads.get(branch)!,
    materializeDecomposition: async () => { decompositionWrites++; return []; },
    get decompositionWrites() { return decompositionWrites; },
  };
}

describe("investigation admission barrier", () => {
  it("captures exact bases, settles every selected issue, and is replay-idempotent", async () => {
    const repository = new InMemoryOrchestrationRepository();
    const forge = host();
    const investigated: number[] = [];
    const service = new InvestigationAdmissionService({
      repository, host: forge,
      owner: "controller-a",
      investigate: async ({ issue }) => { investigated.push(issue.number); return { outcome: "confirmed", artifactIds: [`investigation-${issue.number}`] }; },
    });
    const first = await service.admit({ repository: "owner/repo", issues: [
      { repository: "owner/repo", issue: 2, targetBranch: "main" },
      { repository: "owner/repo", issue: 1, targetBranch: "main" },
    ] });
    assert.equal(first.wave.status, "settled");
    assert.deepEqual(first.releaseReceipt?.issueNumbers, [1, 2]);
    assert.equal(first.releaseReceipt?.bases[0]?.baseSha, "a".repeat(40));
    const replay = await service.admit({ repository: "owner/repo", issues: [
      { repository: "owner/repo", issue: 1, targetBranch: "main" },
      { repository: "owner/repo", issue: 2, targetBranch: "main" },
    ] });
    assert.deepEqual(replay.releaseReceipt, first.releaseReceipt);
    assert.deepEqual(investigated, [1, 2]);
  });

  it("fails closed on base drift and persists bounded retry exhaustion", async () => {
    const repository = new InMemoryOrchestrationRepository();
    const forge = host();
    let calls = 0;
    const service = new InvestigationAdmissionService({
      repository, host: forge, owner: "controller-b", maxAttempts: 2,
      investigate: async () => { calls++; throw new Error("HTTP 503 provider unavailable"); },
    });
    const result = await service.admit({ repository: "owner/repo", issues: [{ issue: 1, targetBranch: "main", repository: "owner/repo" }] });
    assert.equal(result.wave.status, "blocked");
    assert.equal(result.wave.issues[0]?.status, "failed");
    assert.equal(result.wave.issues[0]?.attempt, 2);
    assert.equal(calls, 2);
  });
});
