// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createArtifact } from "../../core/artifacts/schema.js";
import { consolidateReviewerFindings as consolidateReviewerFindingsWithPolicy } from "./consolidate.js";
import type { ReviewerSubmission } from "./review.js";
import { applyFindingScopePolicy } from "./scope.js";

const base = {
  severity: "high" as const,
  confidence: "high" as const,
  blocking: false,
  intentRelevance: "The authority contract must be interoperable.",
  remediation: "Freeze an exact schema and conformance vectors.",
  scopeDisposition: "in_scope" as const,
  scopeRationale: "Directly violates the frozen interoperability criterion.",
  matchedAcceptanceCriteria: ["The authority contract is interoperable."],
  matchedPriorFindingIds: [] as string[],
  introducedByRemediation: false,
};

type FindingInput = Omit<ReviewerSubmission["findings"][number], "causalRoot"> & { causalRoot?: string };

function submission(findings: FindingInput[]): ReviewerSubmission {
  return {
    summary: `${findings.length} finding(s)`,
    findings: findings.map((finding) => ({ ...finding, causalRoot: finding.causalRoot ?? finding.id })),
  };
}

const defaultPolicy = {
  reviewedPaths: ["docs/next/VERIFIABLE-WORKFLOW-AUTHORITY.md", "docs/spec.md", "src/schema.ts", "src/a.ts", "src/b.ts", "src/adapters/github/admission-store.ts", "src/adapters/sqlite/sqlite-repositories.ts"],
  expectedPaths: [] as string[],
};
function consolidateReviewerFindings(
  ...args: Parameters<typeof consolidateReviewerFindingsWithPolicy>
): ReturnType<typeof consolidateReviewerFindingsWithPolicy> {
  return consolidateReviewerFindingsWithPolicy(args[0], args[1], args[2] ?? defaultPolicy);
}

describe("cross-reviewer finding consolidation", () => {
  it("merges differently worded registry findings with source lineage", () => {
    const findings = consolidateReviewerFindings([
      { role: "data", sessionRef: "session-data", output: submission([{
        ...base, id: "DATA-1", causalRoot: "protected registry lacks payload schemas", title: "Protected artifact registry has no concrete payload schemas",
        evidence: "The protected registry names payloads but does not define fields.",
        location: "docs/next/VERIFIABLE-WORKFLOW-AUTHORITY.md:117-126",
      }]) },
      { role: "infrastructure", sessionRef: "session-infra", output: submission([{
        ...base, id: "INFRA-1", causalRoot: "protected registry lacks payload schemas", severity: "medium", title: "Protected v1 does not define the payload schemas it signs",
        evidence: "Independent implementations cannot agree on the protected artifact registry.",
        location: "docs/next/VERIFIABLE-WORKFLOW-AUTHORITY.md:117-130",
      }]) },
    ], new Set(["critical", "high", "medium"]));
    assert.equal(findings.length, 1);
    assert.deepEqual(findings[0]?.reviewerRoles, ["data", "infrastructure"]);
    assert.deepEqual(findings[0]?.sourceFindingIds, ["data:DATA-1", "infrastructure:INFRA-1"]);
    assert.deepEqual(findings[0]?.sourceSessionRefs, ["session-data", "session-infra"]);
    assert.equal(findings[0]?.severity, "high");
    assert.equal(findings[0]?.blocking, true);
    assert.match(findings[0]?.evidence ?? "", /\[data:DATA-1\]/);
    assert.match(findings[0]?.evidence ?? "", /\[infrastructure:INFRA-1\]/);
  });

  it("merges capability SHA-applicability duplicates but preserves a distinct idempotency defect", () => {
    const findings = consolidateReviewerFindings([
      { role: "correctness", output: submission([{
        ...base, id: "COR-SHA", causalRoot: "non-sha capabilities require reviewed sha", title: "Capability rules make ordinary non-SHA actions unrepresentable",
        evidence: "reviewedSha is mandatory for actions with no revision.",
        location: "docs/next/VERIFIABLE-WORKFLOW-AUTHORITY.md:235-286",
      }, {
        ...base, id: "COR-ID", causalRoot: "operation ids collide across mutations", title: "Reusable capability mutations share an operation ID",
        evidence: "The operation ID is reused across distinct mutations.",
        location: "docs/next/VERIFIABLE-WORKFLOW-AUTHORITY.md:240-250",
      }]) },
      { role: "data", output: submission([{
        ...base, id: "DATA-SHA", causalRoot: "non-sha capabilities require reviewed sha", title: "Capability reviewedSha rules make non-SHA capabilities invalid",
        evidence: "Artifact and issue actions cannot satisfy the reviewed SHA binding.",
        location: "docs/next/VERIFIABLE-WORKFLOW-AUTHORITY.md:235-280",
      }]) },
      { role: "concurrency", output: submission([{
        ...base, id: "CONC-ID", causalRoot: "operation ids collide across mutations", title: "Reusable capability operation IDs collide across lease heartbeats",
        evidence: "Distinct heartbeat requests reuse one idempotency operation ID.",
        location: "docs/next/VERIFIABLE-WORKFLOW-AUTHORITY.md:240-300",
      }]) },
    ], new Set(["critical", "high", "medium"]));
    assert.equal(findings.length, 2);
    assert.ok(findings.some((finding) => finding.sourceFindingIds.includes("correctness:COR-SHA") && finding.sourceFindingIds.includes("data:DATA-SHA")));
    assert.ok(findings.some((finding) => finding.sourceFindingIds.includes("correctness:COR-ID") && finding.sourceFindingIds.includes("concurrency:CONC-ID")));
  });

  it("does not collapse separate findings from one reviewer merely because they share a broad concept", () => {
    const findings = consolidateReviewerFindings([{ role: "security", output: submission([
      {
        ...base, id: "SEC-AUTH", title: "Capabilities are not signed",
        evidence: "No signature binds the capability body.", location: "docs/spec.md:20",
      },
      {
        ...base, id: "SEC-REVOKE", title: "Capability revocation is not enforced",
        evidence: "Descendants remain valid after ancestor revocation.", location: "docs/spec.md:30",
      },
    ]) }], new Set(["critical", "high", "medium"]));
    assert.equal(findings.length, 2);
  });

  it("assigns distinct stable IDs to same-location findings that remain separate", () => {
    const findings = consolidateReviewerFindings([{ role: "correctness", output: submission([
      { ...base, id: "ONE", title: "Schema is incomplete", evidence: "Request fields are missing", location: "src/schema.ts:1" },
      { ...base, id: "TWO", title: "Schema is incomplete", evidence: "Response variants are missing", location: "src/schema.ts:1" },
    ]) }], new Set(["critical", "high", "medium"]));
    assert.equal(findings.length, 2);
    assert.equal(new Set(findings.map(({ id }) => id)).size, 2);
  });

  it("keeps findings in different files separate even when their titles are similar", () => {
    const findings = consolidateReviewerFindings([
      { role: "correctness", output: submission([{
        ...base, id: "A", title: "Schema is incomplete", evidence: "Payload schema missing", location: "src/a.ts:1",
      }]) },
      { role: "data", output: submission([{
        ...base, id: "B", title: "Schema is incomplete", evidence: "Payload schema missing", location: "src/b.ts:1",
      }]) },
    ], new Set(["critical", "high", "medium"]));
    assert.equal(findings.length, 2);
  });

  it("deduplicates same-reviewer paraphrases by normalized causal root", () => {
    const findings = consolidateReviewerFindings([{ role: "correctness", output: submission([
      { ...base, id: "A", causalRoot: "unfenced admission claim", title: "Admission can create duplicate children", evidence: "Claim A races", location: "src/adapters/github/admission-store.ts:10" },
      { ...base, id: "B", causalRoot: "Unfenced admission claim", title: "Concurrent claim duplicates materialization", evidence: "A second caller also wins", location: "src/adapters/github/admission-store.ts:12" },
    ]) }], new Set(["critical", "high", "medium"]));
    assert.equal(findings.length, 1);
    assert.deepEqual(findings[0]?.sourceFindingIds, ["correctness:A", "correctness:B"]);
  });

  it("merges strongly corroborated paraphrases with different causal-root wording", () => {
    const findings = consolidateReviewerFindings([
      { role: "correctness", output: submission([{
        ...base, id: "EXPIRY-A", causalRoot: "lease guard omits expiry", title: "LeaseGuard authorizes expired leases",
        evidence: "The guard checks the token but not expires_at.", location: "src/adapters/sqlite/sqlite-repositories.ts:323-329",
      }]) },
      { role: "data", output: submission([{
        ...base, id: "EXPIRY-B", causalRoot: "expired lease passes mutation guard", title: "Expired lease remains valid at the mutation boundary",
        evidence: "A worker can pass guard after the TTL because guard never reads expires_at.", location: "src/adapters/sqlite/sqlite-repositories.ts:344-354",
      }]) },
    ], new Set(["critical", "high", "medium"]));
    assert.equal(findings.length, 1);
    assert.deepEqual(findings[0]?.reviewerRoles, ["correctness", "data"]);
  });

  it("collapses PR #162-like cross-reviewer admission-store duplicates", () => {
    const findings = consolidateReviewerFindings([
      { role: "data", output: submission([{ ...base, id: "DATA", causalRoot: "admission completion is not durable", title: "Admission store can lose completion", evidence: "Completion is not persisted", location: "src/adapters/github/admission-store.ts:40" }]) },
      { role: "concurrency", output: submission([{ ...base, id: "CONC", causalRoot: "admission completion is not durable", title: "Restart replays materialization after completion", evidence: "The completed claim disappears", location: "src/adapters/github/admission-store.ts:44" }]) },
    ], new Set(["critical", "high", "medium"]));
    assert.equal(findings.length, 1);
    assert.deepEqual(findings[0]?.reviewerRoles, ["data", "concurrency"]);
  });

  it("applies confidence, anchoring, and corroboration instead of severity alone", () => {
    for (const severity of ["medium", "high"] as const) {
      const [lowConfidence] = consolidateReviewerFindings([{ role: "correctness", output: submission([{
        ...base, id: `low-${severity}`, severity, confidence: "low", title: "Possible defect", evidence: "Maybe wrong", location: "src/a.ts:1",
      }]) }], new Set(["critical", "high", "medium"]));
      assert.equal(lowConfidence?.blocking, false);
    }
    const [anchoredHigh] = consolidateReviewerFindings([{ role: "correctness", output: submission([{
      ...base, id: "high", severity: "high", confidence: "high", title: "Wrong result", evidence: "Deterministically returns false", location: "src/a.ts:1",
    }]) }], new Set(["critical", "high", "medium"]));
    assert.equal(anchoredHigh?.blocking, true);

    const [singleMedium] = consolidateReviewerFindings([{ role: "correctness", output: submission([{
      ...base, id: "medium-one", severity: "medium", confidence: "high", causalRoot: "incorrect result", title: "Wrong result", evidence: "Returns false", location: "src/a.ts:1",
    }]) }], new Set(["critical", "high", "medium"]));
    assert.equal(singleMedium?.blocking, false);
    const [corroboratedMedium] = consolidateReviewerFindings([
      { role: "correctness", output: submission([{ ...base, id: "medium-a", severity: "medium", causalRoot: "incorrect result", title: "Wrong result", evidence: "Returns false", location: "src/a.ts:1" }]) },
      { role: "data", output: submission([{ ...base, id: "medium-b", severity: "medium", causalRoot: "incorrect result", title: "Persisted result is wrong", evidence: "Stores false", location: "src/a.ts:2" }]) },
    ], new Set(["critical", "high", "medium"]));
    assert.equal(corroboratedMedium?.blocking, true);

    const checkReference = "BuildResult.check=npm test:failed";
    const [deterministicMedium] = consolidateReviewerFindings([{ role: "correctness", output: submission([{
      ...base, id: "medium-check", severity: "medium", confidence: "high", title: "Focused test reproduces the defect",
      evidence: "The controller-recorded test fails deterministically", evidenceAnchor: { kind: "deterministic-check", reference: checkReference },
    }]) }], new Set(["critical", "high", "medium"]), {
      reviewedPaths: [], expectedPaths: [], verifiedCheckReferences: [checkReference],
    });
    assert.equal(deterministicMedium?.blocking, true);
  });

  it("does not launder severity, confidence, scope, or corroboration across mixed-quality duplicates", () => {
    const cases = [
      {
        name: "low confidence cannot donate high severity",
        second: { severity: "high" as const, confidence: "low" as const, scopeDisposition: "in_scope" as const },
      },
      {
        name: "rejected source cannot corroborate",
        second: { severity: "medium" as const, confidence: "high" as const, scopeDisposition: "rejected" as const },
      },
      {
        name: "follow-up source cannot corroborate",
        second: { severity: "medium" as const, confidence: "high" as const, scopeDisposition: "follow_up" as const },
      },
    ];
    for (const testCase of cases) {
      const [result] = consolidateReviewerFindings([
        { role: "correctness", output: submission([{
          ...base, id: `${testCase.name}-primary`, causalRoot: "same causal failure", severity: "medium",
          title: "Guard returns the wrong value", evidence: "Returns false", location: "src/a.ts:1",
        }]) },
        { role: "data", output: submission([{
          ...base, ...testCase.second, id: `${testCase.name}-duplicate`, causalRoot: "same causal failure",
          title: "Persisted guard returns the wrong value", evidence: "Stores false", location: "src/a.ts:2",
        }]) },
      ], new Set(["critical", "high", "medium"]));
      assert.equal(result?.severity, "medium", testCase.name);
      assert.equal(result?.confidence, "high", testCase.name);
      assert.deepEqual(result?.reviewerRoles, ["correctness"], testCase.name);
      assert.equal(result?.blocking, false, testCase.name);
    }

    const [qualified] = consolidateReviewerFindings([
      { role: "correctness", output: submission([{ ...base, id: "qualified-a", causalRoot: "same qualified root", severity: "medium", title: "Wrong value", evidence: "Returns false", location: "src/a.ts:1" }]) },
      { role: "data", output: submission([{ ...base, id: "qualified-b", causalRoot: "same qualified root", severity: "medium", title: "Wrong stored value", evidence: "Stores false", location: "src/a.ts:2" }]) },
    ], new Set(["critical", "high", "medium"]));
    assert.deepEqual(qualified?.reviewerRoles, ["correctness", "data"]);
    assert.equal(qualified?.blocking, true);
  });

  it("does not synthesize remediation continuity from provenance split across duplicate attestations", () => {
    const [consolidated] = consolidateReviewerFindings([
      { role: "correctness", output: submission([{
        ...base, id: "coherent-anchor", causalRoot: "same remediation regression", title: "Guard still returns early",
        evidence: "The guarded path returns before save", location: "src/a.ts:10",
      }]) },
      { role: "data", output: submission([{
        ...base, id: "foreign-lineage", causalRoot: "same remediation regression", title: "Persisted guard still returns early",
        evidence: "The persisted path returns before save", location: "src/a.ts:11",
        matchedPriorFindingIds: ["review-prior-root"], introducedByRemediation: true,
      }]) },
    ], new Set(["critical", "high", "medium"]));
    assert.ok(consolidated);
    assert.equal(consolidated.blocking, true);
    assert.deepEqual(consolidated.matchedPriorFindingIds, []);
    assert.equal(consolidated.introducedByRemediation, false);

    const packet = createArtifact({
      kind: "BuildPacket", runId: "run-provenance", subject: { repo: "a/b", issue: 1 }, producer: { role: "packet-author" },
      payload: {
        scope: ["Fix guard"], acceptanceCriteria: ["The authority contract is interoperable."], context: [],
        implementationPlan: ["Fix src/a.ts"], expectedPaths: ["src/a.ts"], verificationPlan: ["npm test"], risks: [], outOfScope: [],
      },
    });
    const priorVerdict = createArtifact({
      kind: "ReviewVerdict", runId: "run-provenance", subject: { repo: "a/b", issue: 1, pr: 2 }, producer: { role: "controller" },
      payload: {
        headSha: "a".repeat(40), disposition: "request_changes", reviewerRoles: ["correctness"], checks: [],
        findings: [{
          ...base, id: "review-prior-root", causalRoot: "prior root", title: "Prior guard defect", evidence: "Prior evidence",
          location: "src/a.ts:1", blocking: true,
        }],
      },
    });
    const [scoped] = applyFindingScopePolicy([consolidated], packet, priorVerdict, { remediationDeltaPaths: [] });
    assert.equal(scoped?.scopeDisposition, "follow_up");
    assert.equal(scoped?.blocking, false);
  });

  it("rejects vague locationless blockers but permits controller-verified delivery authority", () => {
    const [vague] = consolidateReviewerFindings([{ role: "correctness", output: submission([{
      ...base, id: "vague", severity: "critical", title: "Something is wrong", evidence: "The route seems suspicious",
    }]) }], new Set(["critical", "high", "medium"]));
    assert.equal(vague?.blocking, false);

    const authorityReference = "BuildResult.targetBranch=main != PR.baseBranch=release";
    const [authority] = consolidateReviewerFindings([{ role: "correctness", output: submission([{
      ...base, id: "authority", severity: "high", title: "Delivery targets the wrong authority", evidence: "Verified target/base mismatch",
      evidenceAnchor: { kind: "delivery-authority", reference: authorityReference },
    }]) }], new Set(["critical", "high", "medium"]), {
      reviewedPaths: [], expectedPaths: [], verifiedAuthorityReferences: [authorityReference],
    });
    assert.equal(authority?.blocking, true);
  });
});
