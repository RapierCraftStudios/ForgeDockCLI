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

  it("decodes legacy v2 subjects into canonical GitHub subjects", () => {
    const artifact = intent();
    const legacy = { ...artifact, subject: { repo: "Acme/Widget", issue: 42 } };
    const marker = `<!-- FORGEDOCK:ARTIFACT v2 b64:${Buffer.from(JSON.stringify(legacy), "utf8").toString("base64url")} -->`;
    assert.deepEqual(decodeArtifactMarker(marker).subject, artifact.subject);
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
