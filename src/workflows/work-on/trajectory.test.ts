import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseTrajectoryComment, renderTrajectoryComment, trajectoryCommentMarker, type TrajectoryReceipt } from "./trajectory.js";

describe("Forge trajectory receipts", () => {
  it("renders a protocol-compliant bounded receipt and parses it exactly", () => {
    const receipt: TrajectoryReceipt = {
      schema: "forgedock.trajectory/v1",
      memberIssue: 7,
      batchParent: 20,
      artifactIds: { Intent: "art_intent", Outcome: "art_outcome" },
      acceptanceCriteria: [{ criterion: "It works", status: "passed", evidence: "check passed" }],
      changedPaths: ["src/a.ts"],
      verificationSummary: "npm test: passed",
      pullRequest: { url: "https://example.test/pr/3", number: 3, finalSha: "a".repeat(40), targetBranch: "main" },
      review: { verdictId: "verdict", disposition: "approve", reviewerRoles: ["correctness"], findingIds: [], sessionRefs: [] },
      disposition: "direct-merge",
      childIssues: [],
      childOutcomeIds: [],
      telemetry: { taskCount: 2, knownUsageTasks: 1, unavailableUsageTasks: 1, activeMs: 120, queueMs: 4, retries: 1, totalTokens: 42 },
      completedAt: new Date(0).toISOString(),
      controllerRunId: "run_7",
    };
    const body = renderTrajectoryComment(receipt);
    assert.ok(body.startsWith("<!-- FORGE:TRAJECTORY -->"));
    assert.ok(body.includes("<!-- FORGE:TRAJECTORY:COMPLETE -->"));
    assert.equal(trajectoryCommentMarker(receipt), "<!-- FORGEDOCK:TRAJECTORY run_7:7:" + "a".repeat(40) + " -->");
    assert.deepEqual(parseTrajectoryComment(body), receipt);
    assert.throws(() => parseTrajectoryComment(body.replace("forgedock.trajectory/v1", "wrong/v1")), /Unsupported trajectory/);
  });
});
