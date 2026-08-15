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
});
