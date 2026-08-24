// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createArtifact, type DurableArtifact } from "../../core/artifacts/schema.js";
import { remediationChildMarker, reviewFindingMarker, reviewFindingSemanticMarker } from "../../core/remediation-identity.js";
import { InMemoryArtifactRepository } from "../../core/ports/repositories.js";
import { resolveParentRemediationTargetFromIssue } from "./parent-remediation.js";

const checkpointKey = "c".repeat(64);
const markerHash = remediationChildMarker("owner/repo", "run_parent", 20, 9, "a".repeat(40), "finding-1");
const marker = `<!-- FORGEDOCK:REMEDIATION_CHILD ${markerHash} -->`;
const sourceFinding = { id: "finding-1", title: "Fix", location: "src/a.ts:10", rootId: "root-1", sourceSnapshot: { reviewedHeadSha: "a".repeat(40), path: "src/core/a.ts" }, matchedAcceptanceCriteria: ["Guard passes"] };
const sourceReviewMarker = reviewFindingMarker("owner/repo", 9, sourceFinding);
const sourceSemanticMarker = reviewFindingSemanticMarker("owner/repo", 9, sourceFinding);
const body = [
  "**Parent issue:** #20",
  "**Checkpoint:** `" + checkpointKey + "`",
  "**Finding ID:** `finding-1`",
  marker,
].join("\n");

async function repository(): Promise<InMemoryArtifactRepository> {
  const artifacts = new InMemoryArtifactRepository();
  await artifacts.append(createArtifact({
    kind: "RemediationBlocked",
    runId: "run_parent",
    subject: { repo: "owner/repo", issue: 20 },
    producer: { role: "controller" },
    payload: {
      checkpointKey,
      checkpointSequence: 2,
      status: "children-running",
      parentRunId: "run_parent",
      parentIssue: 20,
      pullRequest: 9,
      headSha: "a".repeat(40),
      headBranch: "forgedock/parent",
      baseBranch: "main",
      packetArtifactId: "art_packet",
      verdictArtifactId: "art_verdict",
      buildResultArtifactId: "art_build",
      projectionArtifactId: "art_projection",
      reason: "scope-violation",
      findings: [{
        id: "finding-1", severity: "high", title: "Fix", evidence: "evidence",
        location: "src/a.ts:10", remediation: "Add guard", acceptanceCriterion: "Guard passes",
        rootId: "root-1", sourceSnapshot: { reviewedHeadSha: "a".repeat(40), path: "src/core/a.ts" }, matchedAcceptanceCriteria: ["Guard passes"],
      }],
      childIssues: [30],
      childRunIds: [],
      approvedPaths: ["src/a.ts"],
      childOutcomeIds: [],
      remediationDepth: 0,
      maxRemediationDepth: 2,
      maxRemediationChildren: 3,
    },
  }));
  const raw = (kind: DurableArtifact["kind"], id: string, subject: { repo: string; issue: number; pr?: number }, payload: unknown) => ({
    schema: "forgedock.artifact/v2" as const, kind, id, runId: "run_parent", subject,
    createdAt: "2026-01-01T00:00:00.000Z", producer: { role: "controller" }, payload,
  } as DurableArtifact);
  await artifacts.append(raw("BuildResult", "art_build", { branch: "forgedock/parent", targetBranch: "main", headSha: "a".repeat(40), baseSha: "b".repeat(40) }));
  await artifacts.append(raw("ReviewVerdict", "art_verdict", { headSha: "a".repeat(40), headBranch: "forgedock/parent", baseBranch: "main", findings: [sourceFinding] }));
  await artifacts.append(raw("ReviewFindingProjection", "art_projection", {
    status: "completed", pullRequest: 9, headSha: "a".repeat(40), headBranch: "forgedock/parent", baseBranch: "main",
    findings: [sourceFinding], findingProjection: { materializedFindingIds: ["finding-1"] },
    projections: [{ findingId: "finding-1", status: "materialized", marker: sourceReviewMarker, issueNumber: 99 }],
  }));
  return artifacts;
}

describe("remediation child routing", () => {
  it("derives parent delivery authority only from the active durable checkpoint", async () => {
    const target = await resolveParentRemediationTargetFromIssue(
      { repo: "owner/repo", number: 30, body },
      await repository(),
    );
    assert.deepEqual(target, {
      sourceRepo: "owner/repo",
      checkpointKey,
      parentRunId: "run_parent",
      parentIssue: 20,
      parentPullRequest: 9,
      parentBranch: "forgedock/parent",
      parentHeadSha: "a".repeat(40),
      sourceBaseBranch: "main",
      sourceBaseSha: "b".repeat(40),
      sourceBuildResultArtifactId: "art_build",
      sourceVerdictArtifactId: "art_verdict",
      sourceProjectionArtifactId: "art_projection",
      sourceSnapshotReviewedSha: "a".repeat(40),
      sourceReviewFindingMarker: sourceReviewMarker,
      sourceReviewFindingSemanticMarker: sourceSemanticMarker,
      remediationMarker: markerHash,
      findingId: "finding-1",
      findingRootId: "root-1",
      findingCriterion: "Guard passes",
      findingLocation: "src/a.ts",
      remediationDepth: 1,
      maxRemediationDepth: 2,
      maxRemediationChildren: 3,
    });
  });

  it("rejects forged remediation prose for an issue absent from the checkpoint", async () => {
    await assert.rejects(
      resolveParentRemediationTargetFromIssue(
        { repo: "owner/repo", number: 31, body },
        await repository(),
      ),
      /not authorized by active checkpoint/,
    );
  });

  it("rejects a syntactically valid but tampered canonical marker", async () => {
    await assert.rejects(
      resolveParentRemediationTargetFromIssue(
        { repo: "owner/repo", number: 30, body: body.replace(markerHash, "d".repeat(64)) },
        await repository(),
      ),
      /mismatched canonical remediation marker/,
    );
  });
});
