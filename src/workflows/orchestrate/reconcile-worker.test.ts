// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createArtifact, type DurableArtifact } from "../../core/artifacts/schema.js";
import { InMemoryLeaseRepository } from "../../core/ports/lease.js";
import { acquireNodeLease } from "./node-lease.js";
import { reconcileAuthoritativeWorkerArtifacts } from "./reconcile-worker.js";

const subject = { repo: "owner/repo", issue: 190 };
const runId = "run_reconcile_worker";
const common = { runId, subject, producer: { role: "test" } };
const intent = createArtifact({
  ...common,
  kind: "Intent",
  payload: { title: "Fix", problem: "Broken", constraints: [], acceptanceHints: [], dependencies: [] },
});
const investigation = createArtifact({
  ...common,
  kind: "Investigation",
  payload: {
    outcome: "confirmed",
    confidence: "high",
    summary: "Confirmed",
    evidence: [{ claim: "Broken", source: "src/a.ts", detail: "Evidence" }],
    rootCause: "cause",
    affectedSurfaces: ["src/a.ts"],
    risks: [],
    recommendation: "fix",
  },
});
const packet = createArtifact({
  ...common,
  kind: "BuildPacket",
  payload: {
    scope: ["fix"],
    acceptanceCriteria: ["pass"],
    context: [],
    implementationPlan: ["edit"],
    expectedPaths: ["src/a.ts"],
    verificationPlan: ["test"],
    risks: [],
    outOfScope: [],
  },
});
const build = createArtifact({
  ...common,
  kind: "BuildResult",
  payload: {
    branch: "fix",
    headSha: "a".repeat(40),
    changedPaths: ["src/a.ts"],
    summary: "fixed",
    acceptanceEvidence: [{ criterion: "pass", status: "passed", evidence: "test" }],
    checks: [{ command: "test", status: "passed", durationMs: 1 }],
    decisions: [],
    residualRisks: [],
  },
});
const verdict = createArtifact({
  ...common,
  kind: "ReviewVerdict",
  payload: { headSha: "a".repeat(40), disposition: "request_changes", reviewerRoles: ["correctness"], findings: [], checks: [] },
});

function decompositionOutcome(): DurableArtifact<"Outcome"> {
  return createArtifact({
    ...common,
    kind: "Outcome",
    payload: { status: "decomposed", reason: "split into child scope", childIssues: ["#191 first child", "#192 second child"] },
  });
}

function remediationCheckpoint(): DurableArtifact<"RemediationBlocked"> {
  return createArtifact({
    ...common,
    kind: "RemediationBlocked",
    payload: {
      checkpointKey: "remediation-190",
      checkpointSequence: 1,
      status: "children-running",
      parentRunId: runId,
      parentIssue: subject.issue,
      pullRequest: 9,
      headSha: "a".repeat(40),
      headBranch: "fix",
      baseBranch: "main",
      packetArtifactId: packet.id,
      verdictArtifactId: verdict.id,
      reason: "scope-violation",
      findings: [],
      childIssues: [191],
      childRunIds: ["run_child"],
      approvedPaths: ["src/a.ts"],
      childOutcomeIds: [],
      remediationDepth: 0,
      maxRemediationDepth: 2,
    },
  });
}

function childIssuesFromArtifacts(
  parentIssue: number,
  _artifacts: readonly DurableArtifact[],
  runIdValue: string | undefined,
): readonly number[] {
  assert.equal(parentIssue, subject.issue);
  assert.equal(runIdValue, runId);
  return [191, 192];
}

describe("authoritative worker reconciliation after node-lease wait", () => {
  it("classifies decomposition published while recovery waits as terminal replacement scope", async () => {
    const leases = new InMemoryLeaseRepository();
    const predecessor = leases.acquire("issue-190", "predecessor", 10_000, 1_000);
    assert.ok(predecessor);
    let artifacts: readonly DurableArtifact[] = [intent, investigation];
    const recovery = acquireNodeLease(leases, "issue-190", "recovery", 10_000, {
      waitForLive: true,
      pollMs: 1,
      now: () => 1_001,
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 2));
    artifacts = [intent, investigation, decompositionOutcome()];
    assert.equal(leases.release("issue-190", predecessor.token), true);
    assert.ok(await recovery);

    const classification = reconcileAuthoritativeWorkerArtifacts({
      issue: subject.issue,
      artifacts,
      childIssuesFromArtifacts,
      phase: "after-wait",
    });
    assert.deepEqual(classification, {
      disposition: "terminal",
      result: {
        status: "skipped",
        error: "#190 decomposed into replacement scope",
        childIssues: [191, 192],
      },
    });
  });

  it("keeps remediation published while recovery waits on the resume path", async () => {
    const leases = new InMemoryLeaseRepository();
    const predecessor = leases.acquire("issue-190", "predecessor", 10_000, 2_000);
    assert.ok(predecessor);
    let artifacts: readonly DurableArtifact[] = [intent, investigation, packet, build, verdict];
    const recovery = acquireNodeLease(leases, "issue-190", "recovery", 10_000, {
      waitForLive: true,
      pollMs: 1,
      now: () => 2_001,
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 2));
    artifacts = [...artifacts, remediationCheckpoint()];
    assert.equal(leases.release("issue-190", predecessor.token), true);
    assert.ok(await recovery);

    const classification = reconcileAuthoritativeWorkerArtifacts({
      issue: subject.issue,
      artifacts,
      childIssuesFromArtifacts,
      phase: "after-wait",
    });
    assert.deepEqual(classification, {
      disposition: "interrupted",
      reason: "#190 must resume from remediation checkpoint remediation-190",
    });
  });
});
