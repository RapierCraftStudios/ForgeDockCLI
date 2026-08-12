// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { consolidateReviewerFindings } from "./consolidate.js";
import type { ReviewerSubmission } from "./review.js";

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

function submission(findings: ReviewerSubmission["findings"]): ReviewerSubmission {
  return { summary: `${findings.length} finding(s)`, findings };
}

describe("cross-reviewer finding consolidation", () => {
  it("merges differently worded registry findings with source lineage", () => {
    const findings = consolidateReviewerFindings([
      { role: "data", sessionRef: "session-data", output: submission([{
        ...base, id: "DATA-1", title: "Protected artifact registry has no concrete payload schemas",
        evidence: "The protected registry names payloads but does not define fields.",
        location: "docs/next/VERIFIABLE-WORKFLOW-AUTHORITY.md:117-126",
      }]) },
      { role: "infrastructure", sessionRef: "session-infra", output: submission([{
        ...base, id: "INFRA-1", severity: "medium", title: "Protected v1 does not define the payload schemas it signs",
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
        ...base, id: "COR-SHA", title: "Capability rules make ordinary non-SHA actions unrepresentable",
        evidence: "reviewedSha is mandatory for actions with no revision.",
        location: "docs/next/VERIFIABLE-WORKFLOW-AUTHORITY.md:235-286",
      }, {
        ...base, id: "COR-ID", title: "Reusable capability mutations share an operation ID",
        evidence: "The operation ID is reused across distinct mutations.",
        location: "docs/next/VERIFIABLE-WORKFLOW-AUTHORITY.md:240-250",
      }]) },
      { role: "data", output: submission([{
        ...base, id: "DATA-SHA", title: "Capability reviewedSha rules make non-SHA capabilities invalid",
        evidence: "Artifact and issue actions cannot satisfy the reviewed SHA binding.",
        location: "docs/next/VERIFIABLE-WORKFLOW-AUTHORITY.md:235-280",
      }]) },
      { role: "concurrency", output: submission([{
        ...base, id: "CONC-ID", title: "Reusable capability operation IDs collide across lease heartbeats",
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
});
