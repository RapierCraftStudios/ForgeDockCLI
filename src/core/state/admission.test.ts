// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createArtifact, type DurableArtifact } from "../artifacts/schema.js";
import { decideSubjectAdmission } from "./admission.js";

const subject = { repo: "a/b", issue: 1 };

function intent(runId: string, createdAt: string): DurableArtifact {
  const artifact = createArtifact({
    kind: "Intent",
    runId,
    subject,
    producer: { role: "controller" },
    payload: { title: "Fix", problem: "Broken", constraints: [], acceptanceHints: [], dependencies: [] },
  });
  return { ...artifact, createdAt };
}

function outcome(runId: string, createdAt: string, status: "invalid" | "decomposed" | "blocked"): DurableArtifact {
  const artifact = createArtifact({
    kind: "Outcome",
    runId,
    subject,
    producer: { role: "controller" },
    payload: { status, reason: status, childIssues: [] },
  });
  return { ...artifact, createdAt };
}

describe("subject run admission", () => {
  it("starts when no durable state exists", () => {
    assert.deepEqual(decideSubjectAdmission([]), { action: "start" });
  });

  it("skips the newest terminal run instead of publishing duplicate artifacts", () => {
    const artifacts = [
      intent("run_old", "2026-01-01T00:00:00.000Z"),
      outcome("run_old", "2026-01-01T00:01:00.000Z", "decomposed"),
    ];
    assert.deepEqual(decideSubjectAdmission(artifacts), {
      action: "skip",
      runId: "run_old",
      state: "decomposed",
    });
  });

  it("blocks a newer interrupted run even when an older run was terminal", () => {
    const artifacts = [
      intent("run_terminal", "2026-01-01T00:00:00.000Z"),
      outcome("run_terminal", "2026-01-01T00:01:00.000Z", "decomposed"),
      intent("run_interrupted", "2026-01-02T00:00:00.000Z"),
    ];
    const decision = decideSubjectAdmission(artifacts);
    assert.equal(decision.action, "block");
    if (decision.action === "block") {
      assert.equal(decision.runId, "run_interrupted");
      assert.equal(decision.state, "investigating");
    }
  });

  it("does not let rerun discard an interrupted run", () => {
    assert.equal(decideSubjectAdmission([intent("run_old", "2026-01-01T00:00:00.000Z")], { rerun: true }).action, "block");
  });

  it("allows an explicit rerun only after a non-recoverable terminal outcome", () => {
    assert.deepEqual(decideSubjectAdmission([
      intent("run_old", "2026-01-01T00:00:00.000Z"),
      outcome("run_old", "2026-01-01T00:01:00.000Z", "decomposed"),
    ], { rerun: true }), { action: "start" });
  });

  it("resumes an interrupted build from its frozen durable packet", () => {
    const investigation = createArtifact({
      kind: "Investigation", runId: "run_build", subject, producer: { role: "investigator" },
      payload: {
        outcome: "confirmed", confidence: "high", summary: "confirmed",
        evidence: [{ claim: "broken", source: "src/a.ts", detail: "missing guard" }],
        rootCause: "missing guard", affectedSurfaces: ["src/a.ts"], risks: [], recommendation: "add guard",
      },
    });
    const packet = createArtifact({
      kind: "BuildPacket", runId: "run_build", subject, producer: { role: "packet-author" },
      payload: {
        scope: ["add guard"], acceptanceCriteria: ["guard exists"], context: [], implementationPlan: ["edit src/a.ts"],
        expectedPaths: ["src/a.ts"], verificationPlan: ["npm test"], risks: [], outOfScope: [],
      },
    });
    const decision = decideSubjectAdmission([intent("run_build", "2026-01-01T00:00:00.000Z"), investigation, packet]);
    assert.equal(decision.action, "resume");
    if (decision.action === "resume") {
      assert.equal(decision.state, "building");
      assert.equal(decision.checkpoint, "build");
    }
  });

  it("resumes a blocked verification attempt with retained evidence", () => {
    const blocked = createArtifact({
      kind: "Outcome", runId: "run_recover", subject, producer: { role: "controller" },
      payload: {
        status: "blocked", reason: "base failures", childIssues: [],
        failureEvidence: {
          branch: "forgedock/issue-1", workspacePath: "/tmp/recovery", builderSummary: "built",
          changedPaths: ["docs/probe.md"], checks: [{ command: "npm test", status: "failed", durationMs: 1 }],
        },
      },
    });
    const decision = decideSubjectAdmission([intent("run_recover", "2026-01-01T00:00:00.000Z"), blocked]);
    assert.equal(decision.action, "resume");
    if (decision.action === "resume") {
      assert.equal(decision.runId, "run_recover");
      assert.equal(decision.checkpoint, "verification");
    }
  });
});
