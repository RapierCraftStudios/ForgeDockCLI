import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { evaluateDeploymentGateMarkers } from "./evaluate-deployment-gate-markers.mjs";

const sha = "a".repeat(40);
const oldSha = "b".repeat(40);
const identity = `repo=owner/repo pr=42 head=${sha}`;
const trustedAuthors = ["ForgeBot"];

function evaluate(items) {
  return evaluateDeploymentGateMarkers({
    items,
    repo: "Owner/Repo",
    pullRequest: 42,
    headSha: sha.toUpperCase(),
    trustedAuthors,
  });
}

describe("deployment gate marker evaluation", () => {
  it("accepts a trusted v2 pass bound to the current repo, PR, and head", () => {
    const result = evaluate([{
      login: "forgebot",
      body: `<!-- FORGEDOCK:DEPLOYMENT_GATE_PASS v2 ${identity} -->`,
    }]);
    assert.equal(result.markerFound, "pass");
    assert.equal(result.counts.pass, 1);
  });

  it("rejects stale and identity-mismatched v2 passes", () => {
    const result = evaluate([
      { login: "ForgeBot", body: `<!-- FORGEDOCK:DEPLOYMENT_GATE_PASS v2 repo=owner/repo pr=42 head=${oldSha} -->` },
      { login: "ForgeBot", body: `<!-- FORGEDOCK:DEPLOYMENT_GATE_PASS v2 repo=other/repo pr=42 head=${sha} -->` },
      { login: "ForgeBot", body: `<!-- FORGEDOCK:DEPLOYMENT_GATE_PASS v2 repo=owner/repo pr=41 head=${sha} -->` },
    ]);
    assert.equal(result.markerFound, "none");
    assert.equal(result.counts.mismatched, 3);
  });

  it("makes a current-head failure dominant over passes", () => {
    const result = evaluate([
      { login: "ForgeBot", body: `<!-- FORGEDOCK:DEPLOYMENT_GATE_PASS v2 ${identity} -->` },
      { login: "ForgeBot", body: `<!-- FORGEDOCK:DEPLOYMENT_GATE_FAILURE v2 ${identity} -->` },
      { login: "ForgeBot", body: `<!-- FORGEDOCK:DEPLOYMENT_GATE_PASS v2 repo=owner/repo pr=42 head=${oldSha} -->` },
    ]);
    assert.equal(result.markerFound, "failure");
  });

  it("does not let a stale legacy pass override a current v2 failure", () => {
    const result = evaluate([
      {
        login: "ForgeBot",
        body: `<!-- FORGE:GATE_PASS -->\n<!-- FORGEDOCK:DEPLOYMENT_GATE:old-run:${oldSha} -->`,
      },
      { login: "ForgeBot", body: `<!-- FORGEDOCK:DEPLOYMENT_GATE_FAILURE v2 ${identity} -->` },
    ]);
    assert.equal(result.markerFound, "failure");
    assert.equal(result.counts.legacyPass, 0);
  });

  it("requires the exact current-head identity marker for legacy terminals", () => {
    const bound = evaluate([{
      login: "ForgeBot",
      body: `<!-- FORGE:GATE_PASS -->\n<!-- FORGEDOCK:DEPLOYMENT_GATE:run-123:${sha} -->`,
    }]);
    assert.equal(bound.markerFound, "pass");

    const bare = evaluate([{ login: "ForgeBot", body: "<!-- FORGE:GATE_PASS -->" }]);
    assert.equal(bare.markerFound, "none");

    const stale = evaluate([{
      login: "ForgeBot",
      body: `<!-- FORGE:GATE_PASS -->\n<!-- FORGEDOCK:DEPLOYMENT_GATE:run-123:${oldSha} -->`,
    }]);
    assert.equal(stale.markerFound, "none");

    const splitAcrossComments = evaluate([
      { login: "ForgeBot", body: "<!-- FORGE:GATE_PASS -->" },
      { login: "ForgeBot", body: `<!-- FORGEDOCK:DEPLOYMENT_GATE:run-123:${sha} -->` },
    ]);
    assert.equal(splitAcrossComments.markerFound, "none");
  });

  it("ignores markers from authors outside the case-insensitive allowlist", () => {
    const result = evaluate([{
      login: "outsider",
      body: `<!-- FORGEDOCK:DEPLOYMENT_GATE_PASS v2 ${identity} -->`,
    }]);
    assert.equal(result.markerFound, "none");
    assert.equal(result.counts.untrusted, 1);
  });

  it("treats a current-head start marker as non-terminal but current spec evidence", () => {
    const result = evaluate([{
      login: "ForgeBot",
      body: `<!-- FORGE:SPEC_LOADED -->\n<!-- FORGEDOCK:DEPLOYMENT_GATE_START v2 ${identity} -->`,
    }]);
    assert.equal(result.markerFound, "none");
    assert.equal(result.counts.start, 1);
    assert.equal(result.counts.specLoaded, 1);
  });
});
