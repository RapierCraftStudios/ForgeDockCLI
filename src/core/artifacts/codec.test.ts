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

  it("skips a damaged marker and continues parsing valid markers", () => {
    const good = encodeArtifactMarker(intent());
    const found = findArtifacts(`<!-- FORGEDOCK:ARTIFACT v2 b64:not-json -->\n${good}`);
    assert.equal(found.length, 1);
    assert.equal(found[0]?.id, "art_test");
  });
});
