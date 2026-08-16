// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_REVIEW_CI } from "../../core/config/forgedock-config.js";
import type { PullRequestMergeGate, PullRequestSnapshot } from "../../core/ports/forge-host.js";
import { assessPullRequestCi, assertPullRequestCiReady, classifyPullRequest } from "./ci-policy.js";
const pr = (headBranch: string, baseBranch: string): PullRequestSnapshot => ({ repo: "a/b", number: 8, title: "PR", body: "", url: "https://github.com/a/b/pull/8", state: "OPEN", headSha: "a".repeat(40), headBranch, baseBranch });
const gate = (checks: PullRequestMergeGate["requiredChecks"], mergeable = true): PullRequestMergeGate => ({ repo: "a/b", pullRequest: 8, headSha: "a".repeat(40), baseBranch: "main", mergeable, requiredChecks: checks, observedAt: new Date().toISOString() });
describe("review CI policy", () => {
  it("classifies PR kinds", () => { assert.equal(classifyPullRequest(pr("fix/a", "main")), "delivery"); assert.equal(classifyPullRequest(pr("feature/a", "staging")), "promotion"); assert.equal(classifyPullRequest(pr("staging", "main")), "deployment"); });
  it("owns only the checks selected for the PR type", () => { const a = assessPullRequestCi(pr("fix/a", "main"), gate([{ name: "build", state: "passed" }, { name: "test", state: "pending" }, { name: "release", state: "failed" }]), { ...DEFAULT_REVIEW_CI, deliveryChecks: ["build", "test"] }); assert.deepEqual(a.pending.map((x) => x.name), ["test"]); assert.equal(a.failed.length, 0); });
  it("asks clearly and fails closed for absent exact checks", () => { const a = assessPullRequestCi(pr("fix/a", "main"), gate([{ name: "build", state: "passed" }]), { ...DEFAULT_REVIEW_CI, deliveryChecks: ["build", "release"] }); assert.throws(() => assertPullRequestCiReady(a, "ask", "after"), /Please fix.*rerun \/review-pr.*auto-fix/s); });
  it("fails closed for every unmatched wildcard selector", () => {
    const policy = { ...DEFAULT_REVIEW_CI, deliveryChecks: ["Pipeline *", "Release *"] };
    const unrelated = assessPullRequestCi(pr("fix/a", "main"), gate([{ name: "CI", state: "passed" }]), policy);
    assert.deepEqual(unrelated.selected.map((check) => ({ name: check.name, state: check.state })), [
      { name: "Pipeline *", state: "unavailable" },
      { name: "Release *", state: "unavailable" },
    ]);
    assert.equal(unrelated.ready, false);
    assert.throws(() => assertPullRequestCiReady(unrelated, "ask", "after"), /Pipeline \*=unavailable/);

    const empty = assessPullRequestCi(pr("fix/a", "main"), gate([]), { ...policy, deliveryChecks: ["Pipeline *"] });
    assert.deepEqual(empty.failed.map((check) => check.name), ["Pipeline *"]);
    assert.equal(empty.ready, false);
    assert.throws(() => assertPullRequestCiReady(empty, "ask", "after"), /Pipeline \*=unavailable/);
  });
  it("keeps only matched wildcard checks authoritative across states", () => {
    const states = ["passed", "pending", "failed", "cancelled", "unavailable"] as const;
    for (const state of states) {
      const assessment = assessPullRequestCi(pr("fix/a", "main"), gate([
        { name: "Pipeline Linux", state },
        { name: "CI", state: "passed" },
      ]), { ...DEFAULT_REVIEW_CI, deliveryChecks: ["Pipeline *"] });
      assert.deepEqual(assessment.selected.map((check) => check.name), ["Pipeline Linux"]);
      assert.equal(assessment.pending.length, state === "pending" ? 1 : 0);
      assert.equal(assessment.failed.length, state === "passed" || state === "pending" ? 0 : 1);
      assert.equal(assessment.ready, state === "passed");
    }
  });
  it("normalizes trimmed literal and non-literal wildcard selectors", () => {
    const emptyLiteral = assessPullRequestCi(pr("fix/a", "main"), gate([]), { ...DEFAULT_REVIEW_CI, deliveryChecks: [" * "] });
    assert.deepEqual(emptyLiteral.selected, [{ name: "repository PR checks", state: "unavailable" }]);
    assert.equal(emptyLiteral.ready, false);

    const populatedLiteral = assessPullRequestCi(pr("fix/a", "main"), gate([
      { name: "CI", state: "passed" },
      { name: "Docs", state: "pending" },
    ]), { ...DEFAULT_REVIEW_CI, deliveryChecks: [" * "] });
    assert.deepEqual(populatedLiteral.selected.map((check) => check.name), ["CI", "Docs"]);
    assert.equal(populatedLiteral.selected.some((check) => check.name === "repository PR checks"), false);
    assert.equal(populatedLiteral.ready, false);

    const spacedMatch = assessPullRequestCi(pr("fix/a", "main"), gate([{ name: "Pipeline Linux", state: "passed" }]), { ...DEFAULT_REVIEW_CI, deliveryChecks: [" Pipeline * "] });
    const normalizedMatch = assessPullRequestCi(pr("fix/a", "main"), gate([{ name: "Pipeline Linux", state: "passed" }]), { ...DEFAULT_REVIEW_CI, deliveryChecks: ["Pipeline *"] });
    assert.deepEqual(spacedMatch, normalizedMatch);

    const spacedMissing = assessPullRequestCi(pr("fix/a", "main"), gate([{ name: "CI", state: "passed" }]), { ...DEFAULT_REVIEW_CI, deliveryChecks: [" Pipeline * "] });
    const normalizedMissing = assessPullRequestCi(pr("fix/a", "main"), gate([{ name: "CI", state: "passed" }]), { ...DEFAULT_REVIEW_CI, deliveryChecks: ["Pipeline *"] });
    assert.deepEqual(spacedMissing, normalizedMissing);
    assert.equal(spacedMissing.selected[0]?.name, "Pipeline *");
  });
});
