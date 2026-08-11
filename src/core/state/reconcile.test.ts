import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createArtifact, type DurableArtifact } from "../artifacts/schema.js";
import { reconcileArtifacts, reconcileLatestRunArtifacts } from "./reconcile.js";

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

  it("continues past an interrupted checkpoint when a resumed build result is newer", () => {
    for (const status of ["blocked", "failed"] as const) {
      const interrupted = createArtifact({
        ...common, kind: "Outcome", payload: { status, reason: "transient interruption", childIssues: [] },
      }, { createdAt: "2099-01-01T00:00:00.000Z" });
      const resumedBuild = { ...build, createdAt: "2026-01-01T00:01:00.000Z" };
      assert.equal(reconcileArtifacts([intent, investigation, packet, interrupted, resumedBuild] as DurableArtifact[]).state, "publishing");
    }
  });

  it("lets a later verified BuildResult supersede a ready remediation checkpoint", () => {
    const checkpoint = createArtifact({
      ...common,
      kind: "RemediationBlocked",
      payload: {
        checkpointKey: "checkpoint",
        checkpointSequence: 1,
        status: "ready-to-resume",
        parentRunId: common.runId,
        parentIssue: 1,
        pullRequest: 9,
        headSha: sha,
        headBranch: "fix",
        baseBranch: "main",
        packetArtifactId: packet.id,
        verdictArtifactId: verdict.id,
        reason: "scope-violation",
        findings: [],
        childIssues: [2],
        childRunIds: ["child"],
        approvedPaths: ["a"],
        childOutcomeIds: ["outcome"],
        remediationDepth: 0,
        maxRemediationDepth: 2,
      },
    });
    assert.equal(reconcileArtifacts([intent, investigation, packet, checkpoint, build] as DurableArtifact[]).state, "publishing");
  });

  it("selects the latest semantic run by durable Intent publication order", () => {
    const oldIntent = { ...intent, runId: "run_old", createdAt: "2099-01-01T00:00:00.000Z" };
    const oldOutcome = createArtifact({
      ...common,
      runId: "run_old",
      kind: "Outcome",
      payload: { status: "invalid", reason: "old terminal run", childIssues: [] },
    }, { createdAt: "2099-01-01T00:01:00.000Z" });
    const newIntent = { ...intent, id: "art_new_intent", runId: "run_new", createdAt: "2026-01-01T00:00:00.000Z" };
    const result = reconcileLatestRunArtifacts([oldIntent, oldOutcome, newIntent] as DurableArtifact[]);
    assert.equal(result.runId, "run_new");
    assert.equal(result.state, "investigating");
  });

  it("fails safe on an inconsistent merged outcome", () => {
    const outcome = createArtifact({ ...common, kind: "Outcome", payload: { status: "merged", reason: "done", finalSha: sha, childIssues: [] } });
    const result = reconcileArtifacts([intent, outcome] as DurableArtifact[]);
    assert.equal(result.state, "blocked");
    assert.match(result.warnings[0] ?? "", /no approving/);
  });

  it("accepts a controller-projected batch-member outcome without duplicating the parent review chain", () => {
    const outcome = createArtifact({
      ...common,
      kind: "Outcome",
      payload: { status: "merged", reason: "completed by batch", finalSha: sha, childIssues: [], batchParent: 20 },
    });
    assert.equal(reconcileArtifacts([outcome] as DurableArtifact[]).state, "completed");
  });
});
