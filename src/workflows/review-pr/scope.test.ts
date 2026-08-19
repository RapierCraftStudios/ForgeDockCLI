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
    expectedPaths: ["src/a.ts"], verificationPlan: ["npm test"], risks: [], outOfScope: ["Redesign deployment", "Implementing a GitHub-backed or cross-machine lease service", "Runtime/controller behavior"],
  },
});

function finding(overrides: Partial<ReviewFinding> = {}): ReviewFinding {
  return {
    id: "review-current", severity: "high", confidence: "high", blocking: true,
    title: "Update is not atomic", causalRoot: "write escapes atomic lock", evidence: "The write escapes the lock", location: "src/a.ts:20",
    intentRelevance: "Breaks the guarded update", remediation: "Keep the write inside the lock",
    impact: {
      category: "correctness",
      trigger: "Two concurrent updates reach the write after the lock is released.",
      affectedInvariant: criterion,
      consequence: "The persisted value can lose one accepted update.",
    },
    reviewerRoles: ["correctness"], scopeDisposition: "in_scope", scopeRationale: "Direct criterion violation",
    matchedAcceptanceCriteria: [criterion], matchedPriorFindingIds: [], introducedByRemediation: false,
    ...overrides,
  };
}

describe("review finding scope policy", () => {
  it("downgrades path and criterion expansion before remediation", () => {
    const [outside, excludedTopic, excludedRuntime, localLease] = applyFindingScopePolicy([
      finding({ location: "deploy/production.yml:2", matchedAcceptanceCriteria: ["Invent a deployment contract"] }),
      finding({ title: "Cross-machine lease service is missing", evidence: "The GitHub-backed lease service is not implemented", remediation: "Implement a cross-machine lease service" }),
      finding({ title: "Runtime controller bypass", evidence: "The agent runtime skips the controller", remediation: "Redesign the runtime adapter" }),
      finding({ title: "Lease heartbeat can expire", evidence: "The retained witness heartbeat stalls", remediation: "Keep the local witness fail-closed" }),
    ], packet);
    assert.equal(outside?.scopeDisposition, "follow_up");
    assert.equal(outside?.blocking, false);
    assert.match(outside?.scopeRationale ?? "", /no exact frozen acceptance criterion|outside the frozen expected paths/);
    assert.equal(excludedTopic?.blocking, false);
    assert.match(excludedTopic?.scopeRationale ?? "", /excluded cross-machine lease\/coordination service/);
    assert.equal(excludedRuntime?.blocking, false);
    assert.match(excludedRuntime?.scopeRationale ?? "", /excluded runtime\/controller behavior/);
    assert.equal(localLease?.blocking, true);
    assert.equal(localLease?.scopeDisposition, "in_scope");
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

  it("prevents fresh concern expansion and distrusts unsupported introduced flags after remediation", () => {
    const prior = createArtifact({
      kind: "ReviewVerdict", runId, subject: { ...subject, pr: 2 }, producer: { role: "controller" },
      payload: { headSha: "a".repeat(40), disposition: "request_changes", reviewerRoles: ["correctness"], findings: [finding({ id: "review-prior" })], checks: [] },
    });
    const locationlessIntroduced = finding({ id: "false-introduced", introducedByRemediation: true });
    delete locationlessIntroduced.location;
    assert.throws(() => applyFindingScopePolicy([locationlessIntroduced], packet, prior, {
      remediationDeltaPaths: ["src/unrelated.ts"],
    }), /without exact current-head hunk authority/);
    assert.throws(() => applyFindingScopePolicy([
      finding({ id: "cumulative", introducedByRemediation: true, location: "src/a.ts:25" }),
    ], packet, prior, { remediationDeltaPaths: ["src/a.ts"] }), /without exact current-head hunk authority/);

    const [newConcern, continued] = applyFindingScopePolicy([
      finding({ id: "new", matchedPriorFindingIds: [] }),
      finding({ id: "continued", matchedPriorFindingIds: ["review-prior"] }),
    ], packet, prior, { remediationDeltaPaths: ["src/unrelated.ts"], remediationDeltaHunks: ["src/unrelated.ts:L1-L1"] });
    assert.equal(newConcern?.blocking, false);
    assert.equal(newConcern?.scopeDisposition, "follow_up");
    assert.equal(continued?.blocking, true);
    const priorMustFix = createArtifact({
      kind: "ReviewVerdict", runId, subject: { ...subject, pr: 2 }, producer: { role: "controller" },
      payload: {
        headSha: "a".repeat(40), disposition: "request_changes", reviewerRoles: ["correctness"],
        findings: [finding({ id: "review-medium", blocking: false, mustFix: true, rootId: "root-medium" })], checks: [],
      },
    });
    const [rootContinuation] = applyFindingScopePolicy([
      finding({ id: "continued-root", blocking: false, mustFix: true, matchedPriorFindingIds: ["root-medium"] }),
    ], packet, priorMustFix, { remediationDeltaPaths: ["src/a.ts"], remediationDeltaHunks: ["src/a.ts:L1-L1"] });
    assert.equal(rootContinuation?.scopeDisposition, "in_scope");
    assert.equal(rootContinuation?.mustFix, true);
    const [exactDelta] = applyFindingScopePolicy([
      finding({
        id: "exact-regression", introducedByRemediation: true, location: "src/a.ts:30",
        introductionEvidence: {
          priorReproducer: "guard returns true",
          currentReproducer: "guard returns false",
          causalSymbols: ["guard"],
          hunkReferences: ["src/a.ts:L30-L30:guard"],
        },
      }),
    ], packet, prior, {
      remediationDeltaPaths: ["src/a.ts"],
      remediationDeltaHunks: ["src/a.ts:L30-L30:guard"],
    });
    assert.equal(exactDelta?.blocking, true);

    const currentOnly = finding({
      id: "current-route", introducedByRemediation: true,
      evidenceAnchor: { kind: "delivery-authority", reference: "PR.baseBranch=main" },
    });
    delete currentOnly.location;
    const [genericAuthority] = applyFindingScopePolicy([currentOnly], packet, prior, {
      changedRemediationAuthorityReferences: [],
    });
    assert.equal(genericAuthority?.blocking, false, "a generic current route fact is not an introduced authority change");
    const changedFact = "ReviewVerdict.baseBranch=release->PR.baseBranch=main";
    const changedAuthorityFinding = finding({
      id: "changed-route", introducedByRemediation: true,
      evidenceAnchor: { kind: "delivery-authority", reference: changedFact },
      introductionEvidence: {
        priorReproducer: "baseBranch=release",
        currentReproducer: "baseBranch=main",
        causalSymbols: ["baseBranch"],
        hunkReferences: ["authority:baseBranch"],
        authorityReferences: [changedFact],
      },
    });
    delete changedAuthorityFinding.location;
    const [explicitAuthorityChange] = applyFindingScopePolicy(
      [changedAuthorityFinding], packet, prior, { changedRemediationAuthorityReferences: [changedFact] },
    );
    assert.equal(explicitAuthorityChange?.blocking, true);
  });

  it("materializes every accepted finding and retains rejected candidates only in the verdict", () => {
    assert.equal(shouldMaterializeFinding(finding()), true);
    assert.equal(shouldMaterializeFinding(finding({ blocking: false, scopeDisposition: "follow_up" })), true);
    assert.equal(shouldMaterializeFinding(finding({
      blocking: false, scopeDisposition: "follow_up", reviewerRoles: ["correctness", "security"],
    })), true);
    assert.equal(shouldMaterializeFinding(finding({ blocking: false, scopeDisposition: "rejected" })), false);
  });

  it("keeps the impact gate fail-closed for advisory and malformed evidence", () => {
    assert.equal(shouldMaterializeFinding(finding(), "impact-gated"), true);
    assert.equal(shouldMaterializeFinding(finding({
      severity: "low", blocking: false, impact: {
        category: "test-gap",
        trigger: "A focused race interleaving is not covered.",
        affectedInvariant: criterion,
        consequence: "The regression could recur without a targeted test.",
      },
    }), "impact-gated"), false);
    assert.equal(shouldMaterializeFinding(finding({
      impact: { category: "advisory", trigger: "A reviewer prefers another shape.", affectedInvariant: "No frozen criterion", consequence: "No observable consequence." },
    }), "impact-gated"), false);
    const missingImpact = finding();
    delete missingImpact.impact;
    assert.equal(shouldMaterializeFinding(missingImpact, "impact-gated"), false);
    assert.equal(shouldMaterializeFinding(finding({ confidence: "medium" }), "impact-gated"), false);
    assert.equal(shouldMaterializeFinding(finding({ scopeDisposition: "follow_up", blocking: false }), "impact-gated"), false);
  });
});
