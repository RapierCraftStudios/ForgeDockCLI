// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { DurableArtifact } from "../../core/artifacts/schema.js";
import type { OrchestrationNodeRecord } from "../../core/ports/orchestration.js";
import { reportLegacyTargetFenceMigration, type LegacyTargetFenceNode } from "./migration.js";

const sha = "a".repeat(40);
const node = (status: OrchestrationNodeRecord["status"], id = "issue-1"): OrchestrationNodeRecord => ({ id, issue: 1, priority: 1, dependencies: [], claims: [], status, childRunIds: ["run-1"] });
const artifact = (kind: "BuildPacket" | "BuildResult", id: string): DurableArtifact => ({
  id, kind, runId: "run-1", subject: { repo: "o/r", issue: 1 }, producer: { role: "controller", runtime: "test" },
  createdAt: "2026-01-01T00:00:00.000Z", payload: kind === "BuildPacket"
    ? { scope: ["x"], acceptanceCriteria: ["x"], context: [], implementationPlan: ["x"], expectedPaths: [], verificationPlan: ["x"], risks: [], outOfScope: [] }
    : { branch: "forgedock/issue-1-run", baseSha: sha, headSha: sha, changedPaths: [], summary: "ok", acceptanceEvidence: [], checks: [], decisions: [], residualRisks: [] },
} as unknown as DurableArtifact);

describe("legacy target-fence migration report", () => {
  it("proposes only exact packet/build/workspace conversion and never mutates", () => {
    const input: LegacyTargetFenceNode = { node: node("blocked"), reason: "target-fence", artifacts: [artifact("BuildPacket", "packet"), artifact("BuildResult", "build")], workspace: { path: "/tmp/w", branch: "forgedock/issue-1-run", baseRef: "main", targetBranch: "main", observedTargetSha: sha } };
    const report = reportLegacyTargetFenceMigration([input]);
    assert.equal(report.readOnly, true);
    assert.equal(report.proposals[0]?.disposition, "convert-target-advance");
    assert.equal(report.proposals[0]?.checkpoint?.packetArtifactId, "packet");
  });

  it("keeps generic prepacket failures reset-only and stopped work retryable", () => {
    const report = reportLegacyTargetFenceMigration([
      { node: node("blocked"), reason: "target-fence HTTP 400", artifacts: [] },
      { node: node("queued", "issue-2"), stopped: true, artifacts: [] },
    ]);
    assert.deepEqual(report.proposals.map((proposal) => proposal.disposition), ["reset-fresh", "retry-requeue"]);
  });
});
