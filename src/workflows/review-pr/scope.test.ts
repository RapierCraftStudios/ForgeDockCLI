// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createArtifact } from "../../core/artifacts/schema.js";
import { applyFindingScopePolicy, shouldMaterializeFinding, type ReviewFinding } from "./scope.js";

const runId = "run_scope";
const subject = { repo: "a/b", issue: 1 };
const criterion = "The guarded update remains atomic.";
const packet = createArtifact({
  kind: "BuildPacket", runId, subject, producer: { role: "packet-author" },
  payload: {
    scope: ["Guard the update"], acceptanceCriteria: [criterion], context: [], implementationPlan: ["Edit src/a.ts"],
    expectedPaths: ["src/a.ts"], verificationPlan: ["npm test"], risks: [], outOfScope: ["Redesign deployment", "Lease and heartbeat behavior", "Runtime/controller behavior"],
  },
});

function finding(overrides: Partial<ReviewFinding> = {}): ReviewFinding {
  return {
    id: "review-current", severity: "high", confidence: "high", blocking: true,
    title: "Update is not atomic", evidence: "The write escapes the lock", location: "src/a.ts:20",
    intentRelevance: "Breaks the guarded update", remediation: "Keep the write inside the lock",
    reviewerRoles: ["correctness"], scopeDisposition: "in_scope", scopeRationale: "Direct criterion violation",
    matchedAcceptanceCriteria: [criterion], matchedPriorFindingIds: [], introducedByRemediation: false,
    ...overrides,
  };
}

describe("review finding scope policy", () => {
  it("downgrades path and criterion expansion before remediation", () => {
    const [outside, excludedTopic, excludedRuntime] = applyFindingScopePolicy([
      finding({ location: "deploy/production.yml:2", matchedAcceptanceCriteria: ["Invent a deployment contract"] }),
      finding({ title: "Lease heartbeat can expire", evidence: "The heartbeat generation stalls", remediation: "Redesign lease heartbeat generations" }),
      finding({ title: "Runtime controller bypass", evidence: "The agent runtime skips the controller", remediation: "Redesign the runtime adapter" }),
    ], packet);
    assert.equal(outside?.scopeDisposition, "follow_up");
    assert.equal(outside?.blocking, false);
    assert.match(outside?.scopeRationale ?? "", /no exact frozen acceptance criterion|outside the frozen expected paths/);
    assert.equal(excludedTopic?.blocking, false);
    assert.match(excludedTopic?.scopeRationale ?? "", /excluded lease\/coordination behavior/);
    assert.equal(excludedRuntime?.blocking, false);
    assert.match(excludedRuntime?.scopeRationale ?? "", /excluded runtime\/controller behavior/);
  });

  it("gives explicit runtime exclusions precedence over affirmative adapter wording", () => {
    const adapterPacket = createArtifact({
      kind: "BuildPacket", runId, subject, producer: { role: "packet-author" },
      payload: {
        scope: ["Implement the requested adapter"], acceptanceCriteria: ["Implement the requested adapter"], context: [],
        implementationPlan: ["Edit src/runtime/adapter.ts"], expectedPaths: ["src/runtime/adapter.ts"], verificationPlan: ["npm test"], risks: [],
        outOfScope: ["Do not change runtime or controller behavior"],
      },
    });
    const [result] = applyFindingScopePolicy([finding({
      title: "Runtime controller bypass", evidence: "The agent runtime skips the controller", remediation: "Redesign the runtime adapter",
      location: "src/runtime/adapter.ts:1", matchedAcceptanceCriteria: ["Implement the requested adapter"],
    })], adapterPacket);
    assert.equal(result?.blocking, false);
    assert.match(result?.scopeRationale ?? "", /excluded runtime\/controller behavior/);
  });

  it("prevents fresh concern expansion after remediation while preserving continuity and regressions", () => {
    const prior = createArtifact({
      kind: "ReviewVerdict", runId, subject: { ...subject, pr: 2 }, producer: { role: "controller" },
      payload: { headSha: "a".repeat(40), disposition: "request_changes", reviewerRoles: ["correctness"], findings: [finding({ id: "review-prior" })], checks: [] },
    });
    const [newConcern, continued, regression] = applyFindingScopePolicy([
      finding({ id: "new", matchedPriorFindingIds: [] }),
      finding({ id: "continued", matchedPriorFindingIds: ["review-prior"] }),
      finding({ id: "regression", introducedByRemediation: true }),
    ], packet, prior);
    assert.equal(newConcern?.blocking, false);
    assert.equal(newConcern?.scopeDisposition, "follow_up");
    assert.equal(continued?.blocking, true);
    assert.equal(regression?.blocking, true);
  });

  it("materializes blockers but requires corroboration for nonblocking follow-ups", () => {
    assert.equal(shouldMaterializeFinding(finding()), true);
    assert.equal(shouldMaterializeFinding(finding({ blocking: false, scopeDisposition: "follow_up" })), false);
    assert.equal(shouldMaterializeFinding(finding({
      blocking: false, scopeDisposition: "follow_up", reviewerRoles: ["correctness", "security"],
    })), true);
    assert.equal(shouldMaterializeFinding(finding({ blocking: false, scopeDisposition: "rejected" })), false);
  });
});
