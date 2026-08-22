import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { InvestigationBarrier } from "./investigation-barrier.js";
import type { OrchestrationRecord } from "../../core/ports/orchestration.js";
import type { ScheduledWorkItem } from "./scheduler.js";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const item = (issue: number): ScheduledWorkItem => ({ id: `issue-${issue}`, issue, priority: 1, dependencies: [], claims: [`src/${issue}.ts`], repository: "acme/repo", targetBranch: "staging" });
function record(): OrchestrationRecord {
  return {
    schema: "forgedock.orchestration/v1", orchestrationId: "dag-test", repository: "acme/repo", issueNumbers: [1], requestedIssueNumbers: [1],
    maxParallel: 2, autoMerge: true, status: "running", createdAt: "2025-01-01T00:00:00.000Z", updatedAt: "2025-01-01T00:00:00.000Z", nodes: [],
  };
}

describe("InvestigationBarrier", () => {
  it("keeps dispatch empty until the complete wave is settled", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let writes = 0;
    const barrier = new InvestigationBarrier({
      admit: async () => ({ baseSha: SHA, targetBranch: "staging", routeIdentity: "acme/repo:staging" }),
      investigate: async ({ item: candidate }) => { if (candidate.issue === 1) await held; return { outcome: "confirmed", baseSha: SHA, artifactId: `investigation-${candidate.issue}` }; },
      persist: async () => { writes++; },
    });
    const pending = barrier.settle(record(), [item(1), item(2)]);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(writes > 0, true);
    release();
    const result = await pending;
    assert.deepEqual(result.items.map(({ issue }) => issue).sort(), [1, 2]);
  });

  it("rejects a result whose exact base differs from admission", async () => {
    const barrier = new InvestigationBarrier({
      admit: async () => ({ baseSha: SHA, targetBranch: "staging", routeIdentity: "route" }),
      investigate: async () => ({ outcome: "confirmed", baseSha: "fedcba9876543210fedcba9876543210fedcba98", artifactId: "a" }),
      persist: async () => undefined,
    });
    await assert.rejects(() => barrier.settle(record(), [item(1)]), /does not match admitted SHA/);
  });

  it("replays a settled wave without invoking investigation again", async () => {
    let calls = 0;
    let durable: OrchestrationRecord | undefined;
    const barrier = new InvestigationBarrier({
      admit: async () => ({ baseSha: SHA, targetBranch: "staging", routeIdentity: "route" }),
      investigate: async () => { calls++; return { outcome: "confirmed", baseSha: SHA, artifactId: "stable-artifact" }; },
      persist: async (next) => { durable = structuredClone(next); },
    });
    const first = await barrier.settle(record(), [item(1)]);
    const second = await barrier.settle(durable!, [item(1)]);
    assert.equal(calls, 1);
    assert.deepEqual(second.items.map(({ issue }) => issue), [1]);
    assert.equal(first.record.investigationBarrier?.settlements[0]?.key, second.record.investigationBarrier?.settlements[0]?.key);
  });
});
