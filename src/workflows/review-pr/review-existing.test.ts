// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createArtifact, type DurableArtifact } from "../../core/artifacts/schema.js";
import { reviewArtifactsForHead } from "./review-existing.js";

const subject = { repo: "owner/repo", issue: 12 };

function runArtifacts(runId: string, headSha: string, createdAt: string): DurableArtifact[] {
  const common = { runId, subject, producer: { role: "controller" } };
  return [
    createArtifact({
      ...common,
      kind: "Intent",
      payload: { title: "Fix", problem: "Broken", constraints: [], acceptanceHints: [], dependencies: [] },
    }, { createdAt }),
    createArtifact({
      ...common,
      kind: "Investigation",
      payload: {
        outcome: "confirmed",
        confidence: "high",
        summary: "Confirmed",
        evidence: [{ claim: "broken", source: "src/a.ts", detail: "missing guard" }],
        affectedSurfaces: ["src/a.ts"],
        risks: [],
        recommendation: "Add guard",
      },
    }, { createdAt }),
    createArtifact({
      ...common,
      kind: "BuildPacket",
      payload: {
        scope: ["Add guard"],
        acceptanceCriteria: ["Guard passes"],
        context: [],
        implementationPlan: ["Edit src/a.ts"],
        expectedPaths: ["src/a.ts"],
        verificationPlan: ["npm test"],
        risks: [],
        outOfScope: [],
      },
    }, { createdAt }),
    createArtifact({
      ...common,
      kind: "BuildResult",
      payload: {
        branch: `forgedock/${runId}`,
        targetBranch: "main",
        headSha,
        changedPaths: ["src/a.ts"],
        summary: "Implemented guard",
        acceptanceEvidence: [{ criterion: "Guard passes", status: "passed", evidence: "npm test" }],
        checks: [{ command: "npm test", status: "passed", durationMs: 1 }],
        decisions: [],
        residualRisks: [],
      },
    }, { createdAt }),
  ];
}

describe("standalone review artifact selection", () => {
  it("selects one coherent delivery run by the pull request head, not worker clocks", () => {
    const old = runArtifacts("run_old", "a".repeat(40), "2099-01-01T00:00:00.000Z");
    const current = runArtifacts("run_current", "b".repeat(40), "2026-01-01T00:00:00.000Z");
    const selected = reviewArtifactsForHead(
      [...old, ...current],
      "b".repeat(40),
      "forgedock/run_current",
      "main",
    );
    assert.equal(selected.intent.runId, "run_current");
    assert.equal(selected.investigation.runId, "run_current");
    assert.equal(selected.packet.runId, "run_current");
    assert.equal(selected.buildResult.runId, "run_current");
  });

  it("never borrows a missing packet from another run", () => {
    const old = runArtifacts("run_old", "a".repeat(40), "2099-01-01T00:00:00.000Z");
    const current = runArtifacts("run_current", "b".repeat(40), "2026-01-01T00:00:00.000Z")
      .filter((artifact) => artifact.kind !== "BuildPacket");
    assert.throws(
      () => reviewArtifactsForHead([...old, ...current], "b".repeat(40), "forgedock/run_current", "main"),
      /Required BuildPacket artifact is missing from delivery run run_current/,
    );
  });

  it("rejects a matching SHA carried by a different PR route", () => {
    const current = runArtifacts("run_current", "b".repeat(40), "2026-01-01T00:00:00.000Z");
    assert.throws(
      () => reviewArtifactsForHead(current, "b".repeat(40), "forgedock/other", "main"),
      /No durable Build Result matches pull request head/,
    );
    assert.throws(
      () => reviewArtifactsForHead(current, "b".repeat(40), "forgedock/run_current", "release"),
      /does not match pull request base release/,
    );
  });
});
