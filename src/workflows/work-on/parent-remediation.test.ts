// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createArtifact } from "../../core/artifacts/schema.js";
import { InMemoryArtifactRepository } from "../../core/ports/repositories.js";
import { resolveParentRemediationTargetFromIssue } from "./parent-remediation.js";

const checkpointKey = "c".repeat(64);
const marker = `<!-- FORGEDOCK:REMEDIATION_CHILD ${"d".repeat(64)} -->`;
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
      reason: "scope-violation",
      findings: [{
        id: "finding-1", severity: "high", title: "Fix", evidence: "evidence",
        location: "src/a.ts:10", remediation: "Add guard", acceptanceCriterion: "Guard passes",
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
  return artifacts;
}

describe("remediation child routing", () => {
  it("derives parent delivery authority only from the active durable checkpoint", async () => {
    const target = await resolveParentRemediationTargetFromIssue(
      { repo: "owner/repo", number: 30, body },
      await repository(),
    );
    assert.deepEqual(target, {
      parentRunId: "run_parent",
      parentIssue: 20,
      parentPullRequest: 9,
      parentBranch: "forgedock/parent",
      parentHeadSha: "a".repeat(40),
      findingId: "finding-1",
      findingLocation: "src/a.ts",
      remediationDepth: 1,
      maxRemediationDepth: 2,
      maxRemediationChildren: 3,
    });
  });

  it("rejects a child that belongs only to a stale checkpoint", async () => {
    const artifacts = await repository();
    const prior = (await artifacts.list({ repo: "owner/repo", issue: 20 }, "RemediationBlocked"))[0];
    assert.equal(prior?.kind, "RemediationBlocked");
    if (!prior || prior.kind !== "RemediationBlocked") throw new Error("test fixture checkpoint missing");
    await artifacts.append(createArtifact({
      kind: "RemediationBlocked",
      runId: prior.runId,
      subject: prior.subject,
      producer: prior.producer,
      payload: { ...prior.payload, checkpointSequence: 3, childIssues: [31] },
    }));
    await assert.rejects(
      resolveParentRemediationTargetFromIssue({ repo: "owner/repo", number: 30, body }, artifacts),
      /not authorized by active checkpoint/,
    );
    const target = await resolveParentRemediationTargetFromIssue(
      { repo: "owner/repo", number: 31, body }, artifacts,
    );
    assert.equal(target?.parentHeadSha, "a".repeat(40));
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
});
