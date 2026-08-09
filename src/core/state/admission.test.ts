// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createArtifact, type DurableArtifact } from "../artifacts/schema.js";
import { decideSubjectAdmission } from "./admission.js";

const subject = { repo: "a/b", issue: 1 };

function intent(runId: string, createdAt: string): DurableArtifact {
  const artifact = createArtifact({
    kind: "Intent",
    runId,
    subject,
    producer: { role: "controller" },
    payload: { title: "Fix", problem: "Broken", constraints: [], acceptanceHints: [], dependencies: [] },
  });
  return { ...artifact, createdAt };
}

function outcome(runId: string, createdAt: string, status: "invalid" | "decomposed" | "blocked" | "failed"): DurableArtifact {
  const artifact = createArtifact({
    kind: "Outcome",
    runId,
    subject,
    producer: { role: "controller" },
    payload: { status, reason: status, childIssues: [] },
  });
  return { ...artifact, createdAt };
}

function publicationArtifacts(runId: string): DurableArtifact[] {
  return [
    createArtifact({
      kind: "Investigation", runId, subject, producer: { role: "investigator" },
      payload: {
        outcome: "confirmed", confidence: "high", summary: "confirmed",
        evidence: [{ claim: "broken", source: "docs/a.md", detail: "missing contract" }],
        rootCause: "missing contract", affectedSurfaces: ["docs/a.md"], risks: [], recommendation: "document it",
      },
    }),
    createArtifact({
      kind: "BuildPacket", runId, subject, producer: { role: "packet-author" },
      payload: {
        scope: ["document contract"], acceptanceCriteria: ["documented"], context: [], implementationPlan: ["edit docs/a.md"],
        expectedPaths: ["docs/a.md"], verificationPlan: ["npm test"], risks: [], outOfScope: [],
      },
    }),
    createArtifact({
      kind: "BuildResult", runId, subject, producer: { role: "controller" },
      payload: {
        branch: "forgedock/issue-1", headSha: "d".repeat(40), changedPaths: ["docs/a.md"], summary: "done",
        acceptanceEvidence: [{ criterion: "documented", status: "passed", evidence: "verified" }],
        checks: [{ command: "npm test", status: "passed", durationMs: 1 }], decisions: [], residualRisks: [],
      },
    }),
  ];
}

describe("subject run admission", () => {
  it("starts when no durable state exists", () => {
    assert.deepEqual(decideSubjectAdmission([]), { action: "start" });
  });

  it("skips the newest terminal run instead of publishing duplicate artifacts", () => {
    const artifacts = [
      intent("run_old", "2026-01-01T00:00:00.000Z"),
      outcome("run_old", "2026-01-01T00:01:00.000Z", "decomposed"),
    ];
    assert.deepEqual(decideSubjectAdmission(artifacts), {
      action: "skip",
      runId: "run_old",
      state: "decomposed",
    });
  });

  it("blocks a newer interrupted run even when an older run was terminal", () => {
    const artifacts = [
      intent("run_terminal", "2026-01-01T00:00:00.000Z"),
      outcome("run_terminal", "2026-01-01T00:01:00.000Z", "decomposed"),
      intent("run_interrupted", "2026-01-02T00:00:00.000Z"),
    ];
    const decision = decideSubjectAdmission(artifacts);
    assert.equal(decision.action, "block");
    if (decision.action === "block") {
      assert.equal(decision.runId, "run_interrupted");
      assert.equal(decision.state, "investigating");
    }
  });

  it("does not let rerun discard an interrupted run", () => {
    assert.equal(decideSubjectAdmission([intent("run_old", "2026-01-01T00:00:00.000Z")], { rerun: true }).action, "block");
  });

  it("allows an explicit rerun after a terminal outcome without discarding in-flight work", () => {
    assert.deepEqual(decideSubjectAdmission([
      intent("run_old", "2026-01-01T00:00:00.000Z"),
      outcome("run_old", "2026-01-01T00:01:00.000Z", "decomposed"),
    ], { rerun: true }), { action: "start" });
  });

  it("resumes an interrupted build from its frozen durable packet", () => {
    const investigation = createArtifact({
      kind: "Investigation", runId: "run_build", subject, producer: { role: "investigator" },
      payload: {
        outcome: "confirmed", confidence: "high", summary: "confirmed",
        evidence: [{ claim: "broken", source: "src/a.ts", detail: "missing guard" }],
        rootCause: "missing guard", affectedSurfaces: ["src/a.ts"], risks: [], recommendation: "add guard",
      },
    });
    const packet = createArtifact({
      kind: "BuildPacket", runId: "run_build", subject, producer: { role: "packet-author" },
      payload: {
        scope: ["add guard"], acceptanceCriteria: ["guard exists"], context: [], implementationPlan: ["edit src/a.ts"],
        expectedPaths: ["src/a.ts"], verificationPlan: ["npm test"], risks: [], outOfScope: [],
      },
    });
    const decision = decideSubjectAdmission([intent("run_build", "2026-01-01T00:00:00.000Z"), investigation, packet]);
    assert.equal(decision.action, "resume");
    if (decision.action === "resume") {
      assert.equal(decision.state, "building");
      assert.equal(decision.checkpoint, "build");
    }
  });

  it("routes an in-packet verification failure back through a bounded builder repair", () => {
    const runId = "run_build_repair";
    const delivery = publicationArtifacts(runId).filter((artifact) => artifact.kind !== "BuildResult");
    const blocked = createArtifact({
      kind: "Outcome", runId, subject, producer: { role: "controller" },
      payload: {
        status: "blocked", reason: "Required verification failed: npm test (exit 1)", childIssues: [],
        failureEvidence: {
          branch: "forgedock/issue-1", workspacePath: "/tmp/issue-1", builderSummary: "first attempt",
          changedPaths: ["docs/a.md"], checks: [{ command: "npm test", status: "failed", durationMs: 1 }],
        },
      },
    });
    const decision = decideSubjectAdmission([intent(runId, "2026-01-01T00:00:00.000Z"), ...delivery, blocked]);
    assert.equal(decision.action, "resume");
    if (decision.action === "resume") {
      assert.equal(decision.state, "building");
      assert.equal(decision.checkpoint, "build");
    }
  });

  it("keeps out-of-packet verification failures at the human checkpoint", () => {
    const runId = "run_scope_block";
    const delivery = publicationArtifacts(runId).filter((artifact) => artifact.kind !== "BuildResult");
    const blocked = createArtifact({
      kind: "Outcome", runId, subject, producer: { role: "controller" },
      payload: {
        status: "blocked", reason: "Diff contains paths outside the Build Packet: unrelated.ts", childIssues: [],
        failureEvidence: {
          branch: "forgedock/issue-1", workspacePath: "/tmp/issue-1", builderSummary: "expanded scope",
          changedPaths: ["docs/a.md", "unrelated.ts"], checks: [],
        },
      },
    });
    const decision = decideSubjectAdmission([intent(runId, "2026-01-01T00:00:00.000Z"), ...delivery, blocked]);
    assert.equal(decision.action, "resume");
    if (decision.action === "resume") {
      assert.equal(decision.state, "blocked");
      assert.equal(decision.checkpoint, "verification");
    }
  });

  it("resumes publication after a verified build failed before review", () => {
    const runId = "run_publish";
    const decision = decideSubjectAdmission([
      intent(runId, "2026-01-01T00:00:00.000Z"),
      ...publicationArtifacts(runId),
      outcome(runId, "2026-01-01T00:02:00.000Z", "failed"),
    ]);
    assert.equal(decision.action, "resume");
    if (decision.action === "resume") {
      assert.equal(decision.state, "publishing");
      assert.equal(decision.checkpoint, "publication");
    }
  });

  it("resumes an interrupted publication without requiring a failed Outcome", () => {
    const runId = "run_publish_interrupted";
    const decision = decideSubjectAdmission([
      intent(runId, "2026-01-01T00:00:00.000Z"),
      ...publicationArtifacts(runId),
    ]);
    assert.equal(decision.action, "resume");
    if (decision.action === "resume") {
      assert.equal(decision.state, "publishing");
      assert.equal(decision.checkpoint, "publication");
    }
  });

  it("does not let a newer standalone review mask a recoverable delivery run", () => {
    const deliveryRunId = "run_delivery";
    const reviewVerdict = createArtifact({
      kind: "ReviewVerdict", runId: "run_standalone_review", subject: { ...subject, pr: 56 }, producer: { role: "controller" },
      payload: { headSha: "d".repeat(40), disposition: "request_changes", reviewerRoles: ["reviewer"], findings: [], checks: [] },
    });
    const decision = decideSubjectAdmission([
      intent(deliveryRunId, "2026-01-01T00:00:00.000Z"),
      ...publicationArtifacts(deliveryRunId),
      { ...reviewVerdict, createdAt: "2026-01-02T00:00:00.000Z" },
    ]);
    assert.equal(decision.action, "resume");
    if (decision.action === "resume") {
      assert.equal(decision.runId, deliveryRunId);
      assert.equal(decision.checkpoint, "publication");
    }
  });

  it("starts delivery when an issue has only standalone review artifacts", () => {
    const verdict = createArtifact({
      kind: "ReviewVerdict", runId: "run_review_only", subject: { ...subject, pr: 56 }, producer: { role: "controller" },
      payload: { headSha: "d".repeat(40), disposition: "request_changes", reviewerRoles: ["reviewer"], findings: [], checks: [] },
    });
    assert.deepEqual(decideSubjectAdmission([verdict]), { action: "start" });
  });

  it("resumes a failed remediation publication when a newer verified head outlived a stale PR projection", () => {
    const runId = "run_revision_projection_lag";
    const initial = publicationArtifacts(runId).map((artifact, index) => ({
      ...artifact,
      createdAt: `2026-01-01T00:0${index + 1}:00.000Z`,
    }));
    const verdict = createArtifact({
      kind: "ReviewVerdict", runId, subject: { ...subject, pr: 57 }, producer: { role: "controller" },
      payload: { headSha: "d".repeat(40), disposition: "request_changes", reviewerRoles: ["correctness"], findings: [], checks: [] },
    }, { createdAt: "2026-01-01T00:04:00.000Z" });
    const firstBuild = initial.find((artifact) => artifact.kind === "BuildResult");
    assert.ok(firstBuild?.kind === "BuildResult");
    const remediationSha = "e".repeat(40);
    const remediatedBuild = createArtifact({
      kind: "BuildResult", runId, subject, producer: { role: "controller" },
      payload: { ...firstBuild.payload, headSha: remediationSha },
    }, { createdAt: "2026-01-01T00:05:00.000Z" });
    const failed = createArtifact({
      kind: "Outcome", runId, subject, producer: { role: "controller" },
      payload: {
        status: "failed",
        reason: `Published remediation head ${"d".repeat(40)} does not match verified build ${remediationSha}`,
        childIssues: [],
      },
    }, { createdAt: "2026-01-01T00:06:00.000Z" });
    const decision = decideSubjectAdmission([
      intent(runId, "2026-01-01T00:00:00.000Z"), ...initial, verdict, remediatedBuild, failed,
    ]);
    assert.equal(decision.action, "resume");
    if (decision.action === "resume") {
      assert.equal(decision.state, "failed");
      assert.equal(decision.checkpoint, "publication");
    }
  });

  it("resumes a failed post-approval run at completion rather than publication", () => {
    const runId = "run_review_failed";
    const artifacts = publicationArtifacts(runId);
    const verdict = createArtifact({
      kind: "ReviewVerdict", runId, subject: { ...subject, pr: 57 }, producer: { role: "reviewer" },
      payload: { headSha: "d".repeat(40), disposition: "approve", reviewerRoles: ["reviewer"], findings: [], checks: [] },
    });
    const decision = decideSubjectAdmission([
      intent(runId, "2026-01-01T00:00:00.000Z"), ...artifacts, verdict,
      outcome(runId, "2026-01-01T00:03:00.000Z", "failed"),
    ]);
    assert.equal(decision.action, "resume");
    if (decision.action === "resume") {
      assert.equal(decision.state, "merging");
      assert.equal(decision.checkpoint, "completion");
    }
  });

  it("resumes a remediation-budget review block from its matching verified head", () => {
    const runId = "run_review_budget";
    const delivery = publicationArtifacts(runId).map((artifact, index) => ({
      ...artifact,
      createdAt: `2026-01-01T00:0${index + 1}:00.000Z`,
    }));
    const verdict = createArtifact({
      kind: "ReviewVerdict", runId, subject: { ...subject, pr: 57 }, producer: { role: "controller" },
      payload: {
        headSha: "d".repeat(40), disposition: "request_changes", reviewerRoles: ["correctness"],
        findings: [], checks: [],
      },
    }, { createdAt: "2026-01-01T00:04:00.000Z" });
    const blocked = createArtifact({
      kind: "Outcome", runId, subject, producer: { role: "controller" },
      payload: { status: "blocked", reason: "Remediation budget exhausted after 2 cycle(s)", childIssues: [] },
    }, { createdAt: "2026-01-01T00:05:00.000Z" });
    const decision = decideSubjectAdmission([
      intent(runId, "2026-01-01T00:00:00.000Z"), ...delivery, verdict, blocked,
    ]);
    assert.equal(decision.action, "resume");
    if (decision.action === "resume") {
      assert.equal(decision.state, "blocked");
      assert.equal(decision.checkpoint, "remediation");
    }
  });

  it("restarts publication and fresh review when a newer verified remediation head outlives an interrupted panel", () => {
    const runId = "run_interrupted_panel";
    const delivery = publicationArtifacts(runId).map((artifact, index) => ({
      ...artifact, createdAt: `2026-01-01T00:0${index + 1}:00.000Z`,
    }));
    const firstBuild = delivery.find((artifact) => artifact.kind === "BuildResult");
    assert.ok(firstBuild?.kind === "BuildResult");
    const priorVerdict = createArtifact({
      kind: "ReviewVerdict", runId, subject: { ...subject, pr: 57 }, producer: { role: "controller" },
      payload: { headSha: firstBuild.payload.headSha, disposition: "request_changes", reviewerRoles: ["correctness"], findings: [], checks: [] },
    }, { createdAt: "2026-01-01T00:04:00.000Z" });
    const oldBlock = createArtifact({
      kind: "Outcome", runId, subject, producer: { role: "controller" },
      payload: { status: "blocked", reason: "Remediation budget exhausted after 2 cycle(s)", childIssues: [] },
    }, { createdAt: "2026-01-01T00:05:00.000Z" });
    const latestBuild = createArtifact({
      kind: "BuildResult", runId, subject, producer: { role: "controller" },
      payload: { ...firstBuild.payload, headSha: "e".repeat(40) },
    }, { createdAt: "2026-01-01T00:06:00.000Z" });
    const decision = decideSubjectAdmission([intent(runId, "2026-01-01T00:00:00.000Z"), ...delivery, priorVerdict, oldBlock, latestBuild]);
    assert.equal(decision.action, "resume");
    if (decision.action === "resume") {
      assert.equal(decision.state, "publishing");
      assert.equal(decision.checkpoint, "publication");
    }
  });

  it("resumes an interrupted remediator from the matching request-changes verdict", () => {
    const runId = "run_interrupted_remediator";
    const delivery = publicationArtifacts(runId).map((artifact, index) => ({
      ...artifact, createdAt: `2026-01-01T00:0${index + 1}:00.000Z`,
    }));
    const verdict = createArtifact({
      kind: "ReviewVerdict", runId, subject: { ...subject, pr: 57 }, producer: { role: "controller" },
      payload: { headSha: "d".repeat(40), disposition: "request_changes", reviewerRoles: ["correctness"], findings: [], checks: [] },
    }, { createdAt: "2026-01-01T00:04:00.000Z" });
    const decision = decideSubjectAdmission([intent(runId, "2026-01-01T00:00:00.000Z"), ...delivery, verdict]);
    assert.equal(decision.action, "resume");
    if (decision.action === "resume") {
      assert.equal(decision.state, "remediating");
      assert.equal(decision.checkpoint, "remediation");
    }
  });

  it("does not reuse stale verification evidence after a newer review block", () => {
    const runId = "run_review_blocked";
    const staleVerification = createArtifact({
      kind: "Outcome", runId, subject, producer: { role: "controller" },
      payload: {
        status: "blocked", reason: "verification failed", childIssues: [],
        failureEvidence: {
          branch: "forgedock/issue-1", workspacePath: "/tmp/recovery", builderSummary: "built",
          changedPaths: ["docs/probe.md"], checks: [{ command: "npm test", status: "failed", durationMs: 1 }],
        },
      },
    }, { createdAt: "2026-01-01T00:01:00.000Z" });
    const reviewBlocked = outcome(runId, "2026-01-01T00:03:00.000Z", "blocked");
    const artifacts = [intent(runId, "2026-01-01T00:00:00.000Z"), staleVerification, reviewBlocked];
    assert.deepEqual(decideSubjectAdmission(artifacts), { action: "skip", runId, state: "blocked" });
    assert.deepEqual(decideSubjectAdmission(artifacts, { rerun: true }), { action: "start" });
  });

  it("retries the responsible remediator when verification proves it produced no changes", () => {
    const runId = "run_no_change_remediation";
    const delivery = publicationArtifacts(runId).map((artifact, index) => ({
      ...artifact, createdAt: `2026-01-01T00:0${index + 1}:00.000Z`,
    }));
    const verdict = createArtifact({
      kind: "ReviewVerdict", runId, subject: { ...subject, pr: 57 }, producer: { role: "controller" },
      payload: { headSha: "d".repeat(40), disposition: "request_changes", reviewerRoles: ["correctness"], findings: [], checks: [] },
    }, { createdAt: "2026-01-01T00:04:00.000Z" });
    const blocked = createArtifact({
      kind: "Outcome", runId, subject, producer: { role: "controller" },
      payload: {
        status: "blocked", reason: "Builder produced no repository changes", childIssues: [],
        failureEvidence: {
          branch: "forgedock/issue-1", workspacePath: "/tmp/recovery", builderSummary: "Could not compute fixture",
          changedPaths: [], checks: [{ command: "npm test", status: "passed", durationMs: 1 }],
        },
      },
    }, { createdAt: "2026-01-01T00:05:00.000Z" });
    const decision = decideSubjectAdmission([intent(runId, "2026-01-01T00:00:00.000Z"), ...delivery, verdict, blocked]);
    assert.equal(decision.action, "resume");
    if (decision.action === "resume") {
      assert.equal(decision.state, "remediating");
      assert.equal(decision.checkpoint, "remediation");
    }
  });

  it("resumes a blocked verification attempt with retained evidence", () => {
    const blocked = createArtifact({
      kind: "Outcome", runId: "run_recover", subject, producer: { role: "controller" },
      payload: {
        status: "blocked", reason: "base failures", childIssues: [],
        failureEvidence: {
          branch: "forgedock/issue-1", workspacePath: "/tmp/recovery", builderSummary: "built",
          changedPaths: ["docs/probe.md"], checks: [{ command: "npm test", status: "failed", durationMs: 1 }],
        },
      },
    });
    const decision = decideSubjectAdmission([intent("run_recover", "2026-01-01T00:00:00.000Z"), blocked]);
    assert.equal(decision.action, "resume");
    if (decision.action === "resume") {
      assert.equal(decision.runId, "run_recover");
      assert.equal(decision.checkpoint, "verification");
    }
    assert.deepEqual(decideSubjectAdmission([intent("run_recover", "2026-01-01T00:00:00.000Z"), blocked], { rerun: true }), { action: "start" });
  });
});
