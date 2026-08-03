import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createArtifact, type DurableArtifact } from "../artifacts/schema.js";
import { reconcileArtifacts } from "./reconcile.js";

const common = { runId: "run_reconcile", subject: { repo: "a/b", issue: 1 }, producer: { role: "test" } };
const intent = createArtifact({ ...common, kind: "Intent", payload: { title: "Fix", problem: "Broken", constraints: [], acceptanceHints: [], dependencies: [] } });
const investigation = createArtifact({ ...common, kind: "Investigation", payload: { outcome: "confirmed", confidence: "high", summary: "Confirmed", evidence: [{ claim: "Broken", source: "a", detail: "b" }], rootCause: "cause", affectedSurfaces: ["a"], risks: [], recommendation: "fix" } });
const packet = createArtifact({ ...common, kind: "BuildPacket", payload: { scope: ["fix"], acceptanceCriteria: ["pass"], context: [], implementationPlan: ["edit"], expectedPaths: ["a"], verificationPlan: ["test"], risks: [], outOfScope: [] } });
const sha = "a".repeat(40);
const build = createArtifact({ ...common, kind: "BuildResult", payload: { branch: "fix", headSha: sha, changedPaths: ["a"], summary: "fixed", acceptanceEvidence: [{ criterion: "pass", status: "passed", evidence: "test" }], checks: [{ command: "test", status: "passed", durationMs: 1 }], decisions: [], residualRisks: [] } });
const verdict = createArtifact({ ...common, kind: "ReviewVerdict", payload: { headSha: sha, disposition: "approve", reviewerRoles: ["correctness"], findings: [], checks: [] } });

describe("GitHub artifact reconciliation", () => {
  it("reconstructs the highest committed quality barrier", () => {
    assert.equal(reconcileArtifacts([intent]).state, "investigating");
    assert.equal(reconcileArtifacts([intent, investigation]).state, "preparing");
    assert.equal(reconcileArtifacts([intent, investigation, packet]).state, "building");
    assert.equal(reconcileArtifacts([intent, investigation, packet, build]).state, "publishing");
    assert.equal(reconcileArtifacts([intent, investigation, packet, build, verdict]).state, "merging");
  });

  it("continues past a blocked checkpoint when a resumed build result is newer", () => {
    const blocked = createArtifact({
      ...common, kind: "Outcome", payload: { status: "blocked", reason: "base test failure", childIssues: [] },
    }, { createdAt: "2026-01-01T00:00:00.000Z" });
    const resumedBuild = { ...build, createdAt: "2026-01-01T00:01:00.000Z" };
    assert.equal(reconcileArtifacts([intent, investigation, packet, blocked, resumedBuild] as DurableArtifact[]).state, "publishing");
  });

  it("fails safe on an inconsistent merged outcome", () => {
    const outcome = createArtifact({ ...common, kind: "Outcome", payload: { status: "merged", reason: "done", finalSha: sha, childIssues: [] } });
    const result = reconcileArtifacts([intent, outcome] as DurableArtifact[]);
    assert.equal(result.state, "blocked");
    assert.match(result.warnings[0] ?? "", /no approving/);
  });
});
