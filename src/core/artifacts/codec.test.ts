import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createArtifact } from "./schema.js";
import { decodeArtifactMarker, encodeArtifactMarker, findArtifacts, renderArtifactComment } from "./codec.js";

function intent() {
  return createArtifact({
    kind: "Intent",
    runId: "run_test",
    subject: { repo: "acme/widget", issue: 42 },
    producer: { role: "controller", runtime: "forgedock" },
    payload: {
      title: "Fix delimiter handling",
      problem: "Input may contain --> and <!-- without damaging transport.",
      constraints: ["No regression"],
      acceptanceHints: ["Round trip"],
      dependencies: [],
    },
  }, { id: "art_test", createdAt: "2026-08-03T00:00:00.000Z" });
}

describe("artifact codec", () => {
  it("round trips a versioned artifact without HTML delimiter risk", () => {
    const artifact = intent();
    const marker = encodeArtifactMarker(artifact);
    assert.doesNotMatch(marker.slice(4, -3), /<!--|-->/);
    assert.deepEqual(decodeArtifactMarker(marker), artifact);
  });

  it("renders readable markdown plus a machine marker", () => {
    const comment = renderArtifactComment(intent());
    assert.match(comment, /ForgeDock · Intent/);
    assert.match(comment, /Fix delimiter handling/);
    assert.match(comment, /FORGEDOCK:ARTIFACT v2/);
  });

  it("escapes embedded artifact markers in human-readable fields", () => {
    const injected = encodeArtifactMarker(intent());
    const artifact = createArtifact({
      kind: "Intent", runId: "run_injected", subject: { repo: "acme/widget", issue: 42 }, producer: { role: "controller" },
      payload: {
        title: "Untrusted input", problem: `Reviewer text: ${injected}`, constraints: [], acceptanceHints: [], dependencies: [],
      },
    });
    const comment = renderArtifactComment(artifact);
    assert.equal(findArtifacts(comment).length, 1);
    assert.match(comment, /&lt;!-- FORGEDOCK:ARTIFACT/);
  });

  it("renders a typed verification adjudication checkpoint", () => {
    const adjudication = createArtifact({
      kind: "VerificationAdjudication",
      runId: "run_verify",
      subject: { repo: "acme/widget", issue: 42 },
      producer: { role: "human", runtime: "forgedock" },
      payload: {
        checkpoint: "verification",
        decision: "resume",
        supersedesOutcomeId: "outcome-1",
        reason: "The clean-worktree baseline was repaired and checked independently.",
      },
    });
    const comment = renderArtifactComment(adjudication);
    assert.match(comment, /Verification Adjudication/);
    assert.match(comment, /outcome-1/);
    assert.deepEqual(findArtifacts(comment)[0], adjudication);
  });

  it("renders explainable review routing and consolidated finding lineage", () => {
    const verdict = createArtifact({
      kind: "ReviewVerdict", runId: "run_review", subject: { repo: "acme/widget", issue: 42, pr: 9 },
      producer: { role: "controller", runtime: "forgedock" },
      payload: {
        headSha: "a".repeat(40), disposition: "request_changes", reviewerRoles: ["correctness", "security"], checks: [],
        reviewPlan: {
          riskTier: "high", specialistBudget: 3,
          selected: [
            { role: "correctness", score: 1000, reasons: ["mandatory"], scope: ["src/auth.ts"], required: true },
            { role: "security", score: 120, reasons: ["security-sensitive path"], scope: ["src/auth.ts"], required: true },
          ],
          skipped: [{ role: "frontend", score: 0, reason: "below-threshold", evidence: [] }],
        },
        findings: [{
          id: "review-1", severity: "high", confidence: "high", blocking: true, title: "Token is replayable",
          evidence: "Nonce is not consumed", location: "src/auth.ts:20", intentRelevance: "Breaks authorization",
          remediation: "Consume the nonce", sourceFindingIds: ["security:SEC-1"], sourceSessionRefs: ["review-session-1"], reviewerRoles: ["security"],
        }],
      },
    });
    const comment = renderArtifactComment(verdict);
    assert.match(comment, /Review plan/);
    assert.match(comment, /security.*score 120/);
    assert.match(comment, /frontend.*below-threshold/);
    assert.match(comment, /Sources: `security:SEC-1`/);
    assert.match(comment, /Sessions: `review-session-1`/);
    assert.deepEqual(findArtifacts(comment)[0], verdict);
  });

  it("never renders a baseline-equivalent required failure as passed", () => {
    const outcome = createArtifact({
      kind: "Outcome",
      runId: "run_test",
      subject: { repo: "acme/widget", issue: 42 },
      producer: { role: "controller", runtime: "forgedock" },
      payload: {
        status: "blocked",
        reason: "Required verification failed",
        childIssues: [],
        failureEvidence: {
          branch: "forgedock/issue-42",
          workspacePath: "/tmp/issue-42",
          builderSummary: "Implemented the change",
          changedPaths: ["src/index.ts"],
          checks: [{
            command: "npm test", status: "failed", exitCode: 1, durationMs: 10,
            outputDigest: "a".repeat(64), failureSignatures: ["not ok - flaky fixture"],
            baselineStatus: "failed", baselineFailureSignatures: ["not ok - flaky fixture"], regression: false,
          }],
        },
      },
    });
    const comment = renderArtifactComment(outcome);
    assert.match(comment, /failed \(baseline failures unchanged\)/);
    assert.doesNotMatch(comment, /passed \(baseline failures unchanged\)/);
  });

  it("skips a damaged marker and continues parsing valid markers", () => {
    const good = encodeArtifactMarker(intent());
    const found = findArtifacts(`<!-- FORGEDOCK:ARTIFACT v2 b64:not-json -->\n${good}`);
    assert.equal(found.length, 1);
    assert.equal(found[0]?.id, "art_test");
  });
});
