import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createInvestigationFirstWorkers } from "./investigation-first.js";
import type { OrchestrationRecord } from "../../core/ports/orchestration.js";
import type { ScheduledWorkItem } from "./scheduler.js";

const item = (id: string, issue: number, dependencies: readonly string[] = []): ScheduledWorkItem => ({
  id, issue, priority: 1, dependencies: [...dependencies], claims: [`src/${id}.ts`],
  repository: "owner/repo", targetBranch: "staging", lane: "fast", plan: { id },
});

function node(work: ScheduledWorkItem, extra: Record<string, unknown> = {}) {
  return {
    ...work, status: "queued" as const, childRunIds: [], attempts: [], ...extra,
  };
}

describe("investigation-first execution handoff", () => {
  it("materializes the monotonic confirmed union and excludes invalid parents", async () => {
    const initial = [item("a", 1), item("parent", 2), item("invalid", 5)];
    const children = [item("child-c", 3, ["a", "invalid"]), item("child-d", 4, ["a"])];
    const record = {
      schema: "forgedock.orchestration/v1", orchestrationId: "dag-test", repository: "owner/repo",
      issueNumbers: [1, 2, 3, 4, 5], requestedIssueNumbers: [1, 2, 3, 4, 5], maxParallel: 2,
      autoMerge: false, status: "running", createdAt: "now", updatedAt: "now", investigationWave: 2,
      serializationEdges: [], nodes: [
        node(initial[0]!), node(initial[1]!, { decompositionChildren: [3, 4] }), node(initial[2]!),
        node(children[0]!), node(children[1]!),
      ], investigations: [
        { issue: 1, nodeId: "a", wave: 1, status: "completed", outcome: "confirmed", attemptCount: 1 },
        { issue: 2, nodeId: "parent", wave: 1, status: "completed", outcome: "decompose", attemptCount: 1 },
        { issue: 5, nodeId: "invalid", wave: 1, status: "completed", outcome: "invalid", attemptCount: 1 },
        { issue: 3, nodeId: "child-c", wave: 2, status: "completed", outcome: "confirmed", attemptCount: 1 },
        { issue: 4, nodeId: "child-d", wave: 2, status: "completed", outcome: "confirmed", attemptCount: 1 },
      ],
    } as unknown as OrchestrationRecord;
    const workers = createInvestigationFirstWorkers({
      repository: "owner/repo", checkoutRoot: process.cwd(), runtime: {} as never,
      artifacts: {} as never, runs: {} as never,
      resolveRoute: async () => ({ issue: { title: "", body: "", url: "" }, targetBranch: "staging", lane: "fast" }),
      getBranchHead: async () => "a".repeat(40), sourceItems: () => [...initial, ...children],
      materializeDecomposition: async () => undefined,
    }, initial);
    const result = await workers.materializeExecution({ orchestration: record, wave: 2, investigations: record.investigations!, });
    assert.deepEqual(result.items.map((candidate) => candidate.id), ["a", "child-c", "child-d"]);
    assert.equal(result.items.some((candidate) => candidate.id === "invalid"), false);
    assert.deepEqual(result.items.find((candidate) => candidate.id === "child-d")?.dependencies, ["a"]);
    assert.equal(new Set(result.items.map((candidate) => candidate.issue)).size, 3);
  });

  it("fails closed when a durable packet references a non-confirmed dependency", async () => {
    const confirmed = [item("confirmed", 1), item("successor", 2, ["confirmed"])] as const;
    const record = {
      schema: "forgedock.orchestration/v1", orchestrationId: "packet-test", repository: "owner/repo",
      issueNumbers: [1, 2], requestedIssueNumbers: [1, 2], maxParallel: 2,
      autoMerge: false, status: "running", createdAt: "now", updatedAt: "now", investigationWave: 1,
      serializationEdges: [], nodes: [node(confirmed[0]!), node(confirmed[1]!)], investigations: [
        { issue: 1, nodeId: "confirmed", wave: 1, status: "completed", outcome: "confirmed", attemptCount: 1 },
        { issue: 2, nodeId: "successor", wave: 1, status: "completed", outcome: "confirmed", attemptCount: 1 },
      ],
    } as unknown as OrchestrationRecord;
    const workers = createInvestigationFirstWorkers({
      repository: "owner/repo", checkoutRoot: process.cwd(), runtime: {} as never,
      artifacts: {} as never, runs: {} as never,
      resolveRoute: async () => ({ issue: { title: "", body: "", url: "" }, targetBranch: "staging", lane: "fast" }),
      getBranchHead: async () => "a".repeat(40), sourceItems: () => [...confirmed],
      materializeDecomposition: async () => undefined,
    }, confirmed);
    await assert.rejects(
      workers.materializeExecution({
        orchestration: record, wave: 1, investigations: record.investigations!, packets: [
          { nodeId: "confirmed", wave: 1, status: "completed", attemptCount: 1, expectedPaths: ["src/confirmed.ts"], baseSha: "base" , semanticDependencies: [] },
          { nodeId: "successor", wave: 1, status: "completed", attemptCount: 1, expectedPaths: ["src/successor.ts"], baseSha: "base", semanticDependencies: ["not-confirmed"] },
        ],
      }),
      /unknown semantic dependency/,
    );
  });
});
