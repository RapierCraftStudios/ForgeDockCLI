// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createArtifact, type DurableArtifact } from "../artifacts/schema.js";
import {
  decideSubjectAdmission,
  isRepairableVerificationFailure,
  latestArtifactOfKind,
  latestDeliveryRunArtifacts,
  reviewRemediationCycleCount,
} from "./admission.js";

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

function outcome(
  runId: string,
  createdAt: string,
  status: "invalid" | "decomposed" | "blocked" | "failed" | "abandoned",
  reason: string = status,
): DurableArtifact {
  const artifact = createArtifact({
    kind: "Outcome",
    runId,
    subject,
    producer: { role: "controller" },
    payload: { status, reason, childIssues: [] },
  });
  return { ...artifact, createdAt };
}

function invalidOutcome(runId: string, createdAt: string, closureStatus?: "pending" | "completed"): DurableArtifact<"Outcome"> {
  const artifact = createArtifact({
    kind: "Outcome",
    runId,
    subject,
    producer: { role: "controller" },
    payload: {
      status: "invalid",
      reason: "Already fixed by the repository implementation",
      childIssues: [],
      ...(closureStatus !== undefined ? {
        issueClosure: { status: closureStatus, repo: subject.repo, issue: subject.issue! },
      } : {}),
    },
  });
  return { ...artifact, createdAt };
}

function repairOutcome(
  runId: string,
  createdAt: string,
  options: {
    reason?: string;
    regression?: boolean;
    repairAttempt?: number;
    failureClass?: "command" | "infrastructure" | "timeout";
    failureKind?: "builder-semantic-evidence" | "builder-report" | "packet-contract" | "required-check" | "scope" | "verification-mutation";
  } = {},
): DurableArtifact<"Outcome"> {
  const artifact = createArtifact({
    kind: "Outcome", runId, subject, producer: { role: "controller" },
    payload: {
      status: "blocked",
      reason: options.reason ?? "Required verification failed: npm test (exit 1)",
      childIssues: [],
      failureEvidence: {
        branch: "forgedock/issue-1",
        workspacePath: "/tmp/issue-1",
        builderSummary: "attempt",
        changedPaths: ["docs/a.md"],
        criterionCoverage: [{ criterion: "documented", implementation: "Added documentation" }],
        decisions: [],
        residualRisks: [],
        ...(options.failureKind !== undefined ? { failureKind: options.failureKind } : {}),
        ...(options.repairAttempt !== undefined ? { repairAttempt: options.repairAttempt } : {}),
        checks: [{
          command: "npm test",
          status: "failed",
          durationMs: 1,
          ...(options.failureClass !== undefined ? { failureClass: options.failureClass } : {}),
          ...(options.regression !== undefined ? { regression: options.regression } : {}),
        }],
      },
    },
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

function retryCheckpoint(runId: string, createdAt: string): DurableArtifact {
  const artifact = createArtifact({
    kind: "RetryCheckpoint", runId, subject, producer: { role: "controller" },
    payload: {
      checkpoint: "retry", version: "forgedock.retry/v1", domain: "workflow", code: "temporary",
      phase: "target-read", operationKey: "target-read", semanticKey: "subject-1", artifactIds: [],
      attempt: {
        number: 1, max: 3, firstAt: createdAt, nextAt: createdAt,
      },
      reconciliation: "pending", status: "waiting",
      cause: { class: "transient", message: "temporary target read failure" },
      createdAt, updatedAt: createdAt,
    },
  });
  return { ...artifact, createdAt };
}

function targetRecoveryCheckpoint(
  runId: string,
  createdAt: string,
  packetArtifactId: string,
  buildResultId: string,
  verdictArtifactId: string,
): DurableArtifact {
  const artifact = createArtifact({
    kind: "TargetAdvanceCheckpoint", runId, subject, producer: { role: "controller" },
    payload: {
      checkpoint: "target-advance", version: "forgedock.target-advance/v1", repository: subject.repo,
      targetBranch: "main", routeClaimKey: `${subject.repo}:main`, packetArtifactId, sourceBuildResultId: buildResultId,
      sourceVerdictId: verdictArtifactId, sourceBaseSha: "a".repeat(40), sourceHeadSha: "d".repeat(40),
      observedTargetSha: "b".repeat(40), phase: "target-read", expectedPaths: ["docs/a.md"],
      verifiedContentDigest: "c".repeat(64), verificationPlanId: "plan-1", attempt: { number: 1, max: 2 },
      workspace: { path: "/tmp/work", branch: "forgedock/issue-1", baseRef: "main" },
      createdAt, updatedAt: createdAt,
    },
  });
  return { ...artifact, createdAt };
}

describe("subject run admission", () => {
  it("starts when no durable state exists", () => {
    assert.deepEqual(decideSubjectAdmission([]), { action: "start" });
  });

  it("returns the original blocker for a durable blocked ReviewVerdict instead of a passed skip", () => {
    const runId = "run_review_verdict_blocked";
    const delivery = publicationArtifacts(runId).map((artifact, index) => ({
      ...artifact, createdAt: `2026-01-01T00:0${index + 1}:00.000Z`,
    }));
    const verdict = createArtifact({
      kind: "ReviewVerdict", runId, subject: { ...subject, pr: 57 }, producer: { role: "controller" },
      payload: {
        headSha: "d".repeat(40), disposition: "blocked", reviewerRoles: ["correctness"], findings: [], checks: [],
        warnings: ["source proof is unavailable at the reviewed head"],
      },
    }, { createdAt: "2026-01-01T00:04:00.000Z" });
    const decision = decideSubjectAdmission([intent(runId, "2026-01-01T00:00:00.000Z"), ...delivery, verdict]);
    assert.equal(decision.action, "blocked");
    if (decision.action === "blocked") {
      assert.equal(decision.runId, runId);
      assert.equal(decision.state, "blocked");
      assert.equal(decision.reason, "source proof is unavailable at the reviewed head");
      assert.ok(decision.artifacts.some((artifact) => artifact.kind === "ReviewVerdict"));
    }
  });

  it("preserves finding evidence when a blocked verdict has empty warnings", () => {
    const runId = "run_review_verdict_blocked_finding";
    const delivery = publicationArtifacts(runId).map((artifact, index) => ({
      ...artifact, createdAt: `2026-01-01T00:0${index + 1}:00.000Z`,
    }));
    const verdict = createArtifact({
      kind: "ReviewVerdict", runId, subject: { ...subject, pr: 57 }, producer: { role: "controller" },
      payload: {
        headSha: "d".repeat(40), disposition: "blocked", reviewerRoles: ["correctness"],
        findings: [{
          id: "finding-source-proof", severity: "high", confidence: "high", blocking: true, mustFix: true,
          title: "Source proof is unavailable", evidence: "The reviewed source snapshot could not be verified at the head.",
          intentRelevance: "Review authority requires current-head source proof.", remediation: "Restore source proof and reassess.",
        }], checks: [], warnings: [],
      },
    }, { createdAt: "2026-01-01T00:04:00.000Z" });
    const decision = decideSubjectAdmission([intent(runId, "2026-01-01T00:00:00.000Z"), ...delivery, verdict]);
    assert.equal(decision.action, "blocked");
    if (decision.action === "blocked") assert.equal(decision.reason, "Source proof is unavailable: The reviewed source snapshot could not be verified at the head.");
  });

  it("falls back to durable Outcome evidence when blocked verdict warnings are empty or absent", () => {
    const warningSets: (string[] | undefined)[] = [[], undefined];
    for (const warnings of warningSets) {
      const runId = `run_review_verdict_blocked_${warnings === undefined ? "absent" : "empty"}`;
      const delivery = publicationArtifacts(runId).map((artifact, index) => ({
        ...artifact, createdAt: `2026-01-01T00:0${index + 1}:00.000Z`,
      }));
      const verdict = createArtifact({
        kind: "ReviewVerdict", runId, subject: { ...subject, pr: 57 }, producer: { role: "controller" },
        payload: {
          headSha: "d".repeat(40), disposition: "blocked", reviewerRoles: ["correctness"], findings: [], checks: [],
          ...(warnings === undefined ? {} : { warnings }),
        },
      }, { createdAt: "2026-01-01T00:04:00.000Z" });
      const blocker = outcome(runId, "2026-01-01T00:05:00.000Z", "blocked", "durable blocker reason");
      const decision = decideSubjectAdmission([intent(runId, "2026-01-01T00:00:00.000Z"), ...delivery, verdict, blocker]);
      assert.equal(decision.action, "blocked");
      if (decision.action === "blocked") assert.equal(decision.reason, "durable blocker reason");
    }
  });

  it("gives current blocking findings precedence over an older unrelated Outcome reason", () => {
    const runId = "run_review_verdict_reason_order";
    const delivery = publicationArtifacts(runId).map((artifact, index) => ({
      ...artifact, createdAt: `2026-01-01T00:0${index + 1}:00.000Z`,
    }));
    const olderOutcome = outcome(runId, "2026-01-01T00:04:00.000Z", "blocked", "stale operational blocker");
    const verdict = createArtifact({
      kind: "ReviewVerdict", runId, subject: { ...subject, pr: 57 }, producer: { role: "controller" },
      payload: {
        headSha: "d".repeat(40), disposition: "blocked", reviewerRoles: ["correctness"], checks: [], warnings: [],
        findings: [{
          id: "current-blocker", severity: "high", confidence: "high", blocking: true, mustFix: true,
          title: "Current review blocker", evidence: "The current head still violates the accepted contract.",
          intentRelevance: "The accepted contract remains unmet.", remediation: "Fix the current head.",
        }],
      },
    }, { createdAt: "2026-01-01T00:05:00.000Z" });
    const decision = decideSubjectAdmission([intent(runId, "2026-01-01T00:00:00.000Z"), ...delivery, olderOutcome, verdict]);
    assert.equal(decision.action, "blocked");
    if (decision.action === "blocked") assert.equal(decision.reason, "Current review blocker: The current head still violates the accepted contract.");
  });

  it("does not let a stale blocked verdict mask a later terminal target-recovery Outcome", () => {
    const runId = "run_stale_blocked_target_failure";
    const delivery = publicationArtifacts(runId).map((artifact, index) => ({
      ...artifact, createdAt: `2026-01-01T00:0${index + 1}:00.000Z`,
    }));
    const build = delivery.find((artifact) => artifact.kind === "BuildResult");
    assert.ok(build?.kind === "BuildResult");
    const verdict = createArtifact({
      kind: "ReviewVerdict", runId, subject: { ...subject, pr: 57 }, producer: { role: "controller" },
      payload: { headSha: build.payload.headSha, disposition: "blocked", reviewerRoles: ["correctness"], findings: [], checks: [] },
    }, { createdAt: "2026-01-01T00:04:00.000Z" });
    const terminal = createArtifact({
      kind: "Outcome", runId, subject, producer: { role: "controller" },
      payload: {
        status: "failed", reason: "target advance failed", childIssues: [],
        targetRecovery: {
          checkpointId: "target-checkpoint", phase: "push", cause: "confirmed conflict", attempt: { number: 1, max: 1 },
        },
      },
    }, { createdAt: "2026-01-01T00:05:00.000Z" });
    const decision = decideSubjectAdmission([intent(runId, "2026-01-01T00:00:00.000Z"), ...delivery, verdict, terminal]);
    assert.equal(decision.action, "block");
    if (decision.action === "block") {
      assert.equal(decision.state, "failed");
      assert.match(decision.reason, /Target recovery checkpoint target-checkpoint is superseded by terminal failed Outcome/);
    }
  });

  it("does not let a stale blocked verdict mask a later retry recovery checkpoint", () => {
    const runId = "run_stale_blocked_retry";
    const delivery = publicationArtifacts(runId).map((artifact, index) => ({
      ...artifact, createdAt: `2026-01-01T00:0${index + 1}:00.000Z`,
    }));
    const build = delivery.find((artifact) => artifact.kind === "BuildResult");
    assert.ok(build?.kind === "BuildResult");
    const verdict = createArtifact({
      kind: "ReviewVerdict", runId, subject: { ...subject, pr: 57 }, producer: { role: "controller" },
      payload: { headSha: build.payload.headSha, disposition: "blocked", reviewerRoles: ["correctness"], findings: [], checks: [] },
    }, { createdAt: "2026-01-01T00:04:00.000Z" });
    const retry = retryCheckpoint(runId, "2026-01-01T00:05:00.000Z");
    const decision = decideSubjectAdmission([intent(runId, "2026-01-01T00:00:00.000Z"), ...delivery, verdict, retry]);
    assert.equal(decision.action, "resume");
    if (decision.action === "resume") {
      assert.equal(decision.state, "retry_wait");
      assert.equal(decision.checkpoint, "retry");
    }
  });

  it("does not let a stale blocked verdict mask a later target-recovery checkpoint", () => {
    const runId = "run_stale_blocked_target_checkpoint";
    const delivery = publicationArtifacts(runId).map((artifact, index) => ({
      ...artifact, createdAt: `2026-01-01T00:0${index + 1}:00.000Z`,
    }));
    const packet = delivery.find((artifact) => artifact.kind === "BuildPacket");
    const build = delivery.find((artifact) => artifact.kind === "BuildResult");
    assert.ok(packet?.kind === "BuildPacket");
    assert.ok(build?.kind === "BuildResult");
    const verdict = createArtifact({
      kind: "ReviewVerdict", runId, subject: { ...subject, pr: 57 }, producer: { role: "controller" },
      payload: { headSha: build.payload.headSha, disposition: "blocked", reviewerRoles: ["correctness"], findings: [], checks: [] },
    }, { createdAt: "2026-01-01T00:04:00.000Z" });
    const checkpoint = targetRecoveryCheckpoint(runId, "2026-01-01T00:05:00.000Z", packet.id, build.id, verdict.id);
    const decision = decideSubjectAdmission([intent(runId, "2026-01-01T00:00:00.000Z"), ...delivery, verdict, checkpoint]);
    assert.equal(decision.action, "resume");
    if (decision.action === "resume") {
      assert.equal(decision.state, "target_recovery");
      assert.equal(decision.checkpoint, "target-advance");
    }
  });

  it("does not let a stale blocked verdict mask a later verified BuildResult", () => {
    const runId = "run_stale_blocked_build";
    const delivery = publicationArtifacts(runId).map((artifact, index) => ({
      ...artifact, createdAt: `2026-01-01T00:0${index + 1}:00.000Z`,
    }));
    const build = delivery.find((artifact) => artifact.kind === "BuildResult");
    assert.ok(build?.kind === "BuildResult");
    const verdict = createArtifact({
      kind: "ReviewVerdict", runId, subject: { ...subject, pr: 57 }, producer: { role: "controller" },
      payload: { headSha: build.payload.headSha, disposition: "blocked", reviewerRoles: ["correctness"], findings: [], checks: [] },
    }, { createdAt: "2026-01-01T00:04:00.000Z" });
    const freshBuild = createArtifact({
      kind: "BuildResult", runId, subject, producer: { role: "controller" },
      payload: { ...build.payload, headSha: "e".repeat(40), summary: "fresh verified build" },
    }, { createdAt: "2026-01-01T00:05:00.000Z" });
    const decision = decideSubjectAdmission([intent(runId, "2026-01-01T00:00:00.000Z"), ...delivery, verdict, freshBuild]);
    assert.equal(decision.action, "resume");
    if (decision.action === "resume") {
      assert.equal(decision.state, "publishing");
      assert.equal(decision.checkpoint, "publication");
    }
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

  it("starts a clean run after reset leaves an abandoned Outcome", () => {
    const artifacts = [
      intent("run_reset", "2026-01-01T00:00:00.000Z"),
      outcome("run_reset", "2026-01-01T00:01:00.000Z", "abandoned"),
    ];
    assert.deepEqual(decideSubjectAdmission(artifacts), { action: "start" });
  });

  it("does not discard durable work published after an abandoned Outcome", () => {
    const runId = "run_reset_race";
    const investigation = createArtifact({
      kind: "Investigation", runId, subject, producer: { role: "investigator" },
      payload: {
        outcome: "confirmed", confidence: "high", summary: "confirmed after reset",
        evidence: [{ claim: "race", source: "src/a.ts", detail: "stale controller survived" }],
        rootCause: "stale controller", affectedSurfaces: ["src/a.ts"], risks: [], recommendation: "recover explicitly",
      },
    });
    assert.deepEqual(decideSubjectAdmission([
      intent(runId, "2026-01-01T00:00:00.000Z"),
      outcome(runId, "2026-01-01T00:01:00.000Z", "abandoned"),
      investigation,
    ]), { action: "skip", runId, state: "cancelled" });
  });

  it("resumes an invalid run until GitHub issue closure is authoritatively proven", () => {
    const runId = "run_invalid_pending";
    const decision = decideSubjectAdmission([
      intent(runId, "2026-01-01T00:00:00.000Z"),
      invalidOutcome(runId, "2026-01-01T00:01:00.000Z", "pending"),
    ]);
    assert.equal(decision.action, "resume");
    if (decision.action === "resume") {
      assert.equal(decision.runId, runId);
      assert.equal(decision.state, "invalid");
      assert.equal(decision.checkpoint, "invalid-closure");
      assert.equal(decision.artifacts.length, 2);
    }
  });

  it("treats legacy invalid Outcomes without closure proof as recoverable", () => {
    const runId = "run_invalid_legacy";
    const decision = decideSubjectAdmission([
      intent(runId, "2026-01-01T00:00:00.000Z"),
      invalidOutcome(runId, "2026-01-01T00:01:00.000Z"),
    ]);
    assert.equal(decision.action, "resume");
    if (decision.action === "resume") assert.equal(decision.checkpoint, "invalid-closure");
  });

  it("skips an invalid run only after closure proof is durable", () => {
    const runId = "run_invalid_closed";
    assert.deepEqual(decideSubjectAdmission([
      intent(runId, "2026-01-01T00:00:00.000Z"),
      invalidOutcome(runId, "2026-01-01T00:01:00.000Z", "completed"),
    ]), { action: "skip", runId, state: "invalid" });
  });

  it("resumes a newer Intent-only run even when an older run was terminal", () => {
    const artifacts = [
      intent("run_terminal", "2099-01-01T00:00:00.000Z"),
      outcome("run_terminal", "2099-01-01T00:01:00.000Z", "decomposed"),
      intent("run_interrupted", "2026-01-02T00:00:00.000Z"),
    ];
    assert.equal(latestDeliveryRunArtifacts(artifacts)?.runId, "run_interrupted");
    const decision = decideSubjectAdmission(artifacts, { rerun: true });
    assert.equal(decision.action, "resume");
    if (decision.action === "resume") {
      assert.equal(decision.runId, "run_interrupted");
      assert.equal(decision.state, "investigating");
      assert.equal(decision.checkpoint, "investigation");
    }
  });

  it("does not let rerun discard an interrupted run", () => {
    assert.equal(decideSubjectAdmission([intent("run_old", "2026-01-01T00:00:00.000Z")], { rerun: true }).action, "resume");
  });

  it("resumes packet preparation after a confirmed Investigation survives a crash", () => {
    const runId = "run_prepare_recovery";
    const investigation = createArtifact({
      kind: "Investigation", runId, subject, producer: { role: "investigator" },
      payload: {
        outcome: "confirmed", confidence: "high", summary: "confirmed",
        evidence: [{ claim: "broken", source: "src/a.ts", detail: "missing guard" }],
        rootCause: "missing guard", affectedSurfaces: ["src/a.ts"], risks: [], recommendation: "add guard",
      },
    });
    const decision = decideSubjectAdmission([
      intent(runId, "2026-01-01T00:00:00.000Z"),
      investigation,
      outcome(runId, "2026-01-01T00:02:00.000Z", "failed"),
    ]);
    assert.equal(decision.action, "resume");
    if (decision.action === "resume") {
      assert.equal(decision.state, "preparing");
      assert.equal(decision.checkpoint, "preparation");
    }
  });

  it("finalizes invalid and decomposed Investigations without replaying the agent", () => {
    for (const investigationOutcome of ["invalid", "decompose"] as const) {
      const runId = `run_${investigationOutcome}_recovery`;
      const investigation = createArtifact({
        kind: "Investigation", runId, subject, producer: { role: "investigator" },
        payload: {
          outcome: investigationOutcome,
          confidence: "high",
          summary: `${investigationOutcome} result`,
          evidence: [{ claim: "classified", source: "src/a.ts", detail: "durable evidence" }],
          affectedSurfaces: ["src/a.ts"],
          risks: [],
          recommendation: "Finalize the durable result",
          ...(investigationOutcome === "decompose" ? {
            decomposition: [
              { title: "Child one", outcome: "First outcome", dependsOn: [] },
              { title: "Child two", outcome: "Second outcome", dependsOn: ["Child one"] },
            ],
          } : {}),
        },
      });
      const decision = decideSubjectAdmission([
        intent(runId, "2026-01-01T00:00:00.000Z"),
        investigation,
        outcome(runId, "2026-01-01T00:02:00.000Z", "failed"),
      ]);
      assert.equal(decision.action, "resume");
      if (decision.action === "resume") {
        assert.equal(decision.state, "investigating");
        assert.equal(decision.checkpoint, "investigation");
      }
    }
  });

  it("preserves a terminal investigation projection when a later transition receipt fails", () => {
    for (const investigationOutcome of ["invalid", "decompose"] as const) {
      const runId = `run_${investigationOutcome}_projection_fault`;
      const investigation = createArtifact({
        kind: "Investigation", runId, subject, producer: { role: "investigator" },
        payload: {
          outcome: investigationOutcome,
          confidence: "high",
          summary: `${investigationOutcome} result`,
          evidence: [{ claim: "classified", source: "src/a.ts", detail: "durable evidence" }],
          affectedSurfaces: ["src/a.ts"],
          risks: [],
          recommendation: "Keep the durable terminal projection",
          ...(investigationOutcome === "decompose" ? {
            decomposition: [
              { title: "Child one", outcome: "First outcome", dependsOn: [] },
              { title: "Child two", outcome: "Second outcome", dependsOn: ["Child one"] },
            ],
          } : {}),
        },
      });
      const terminal = investigationOutcome === "invalid"
        ? invalidOutcome(runId, "2026-01-01T00:02:00.000Z", "pending")
        : outcome(runId, "2026-01-01T00:02:00.000Z", "decomposed");
      const decision = decideSubjectAdmission([
        intent(runId, "2026-01-01T00:00:00.000Z"),
        investigation,
        terminal,
        outcome(runId, "2026-01-01T00:03:00.000Z", "failed"),
      ]);
      if (investigationOutcome === "invalid") {
        assert.equal(decision.action, "resume");
        if (decision.action === "resume") assert.equal(decision.checkpoint, "invalid-closure");
      } else {
        assert.deepEqual(decision, { action: "skip", runId, state: "decomposed" });
      }
    }
  });

  it("allows an explicit rerun after a terminal outcome without discarding in-flight work", () => {
    assert.deepEqual(decideSubjectAdmission([
      intent("run_old", "2026-01-01T00:00:00.000Z"),
      outcome("run_old", "2026-01-01T00:01:00.000Z", "decomposed"),
    ], { rerun: true }), { action: "start" });
  });

  it("rejects a recoverable checkpoint when its durable target is on another lane", () => {
    const runId = "run_wrong_lane";
    const build = createArtifact({
      kind: "BuildResult", runId, subject, producer: { role: "controller" },
      payload: {
        branch: "forgedock/issue-1", targetBranch: "main", headSha: "a".repeat(40),
        changedPaths: ["docs/a.md"], summary: "built",
        acceptanceEvidence: [{ criterion: "documented", status: "passed", evidence: "verified" }],
        checks: [{ command: "npm test", status: "passed", durationMs: 1 }], decisions: [], residualRisks: [],
      },
    });
    const decision = decideSubjectAdmission([intent(runId, "2026-01-01T00:00:00.000Z"), build], { currentTargetBranch: "staging" });
    assert.equal(decision.action, "block");
    if (decision.action === "block") assert.match(decision.reason, /targets main.*current issue lane targets staging.*--rerun/);
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

  it("never admits an explicit packet-contract failure to builder repair", () => {
    const runId = "run_packet_contract_failure";
    const delivery = publicationArtifacts(runId);
    const packet = delivery.find((artifact) => artifact.kind === "BuildPacket");
    assert.ok(packet?.kind === "BuildPacket");
    const blocked = repairOutcome(runId, "2026-01-01T00:01:00.000Z", {
      reason: "Builder criterion coverage is incomplete: missing documented",
      repairAttempt: 1,
      failureKind: "packet-contract",
    });
    assert.equal(isRepairableVerificationFailure(packet, blocked), false);
  });

  it("resumes after one durable repair dispatch but blocks after the second", () => {
    const runId = "run_repair_budget";
    const delivery = publicationArtifacts(runId).filter((artifact) => artifact.kind !== "BuildResult");
    const first = repairOutcome(runId, "2026-01-01T00:01:00.000Z");
    const firstDispatch = repairOutcome(runId, "2026-01-01T00:02:00.000Z", {
      reason: "Verification repair attempt 1 dispatched: Required verification failed",
      repairAttempt: 1,
    });
    const afterFirst = decideSubjectAdmission([intent(runId, "2026-01-01T00:00:00.000Z"), ...delivery, first, firstDispatch]);
    assert.equal(afterFirst.action, "resume");
    const secondDispatch = repairOutcome(runId, "2026-01-01T00:03:00.000Z", {
      reason: "Verification repair attempt 2 dispatched: Required verification failed",
      repairAttempt: 2,
    });
    const exhausted = decideSubjectAdmission([
      intent(runId, "2026-01-01T00:00:00.000Z"), ...delivery, first, firstDispatch, secondDispatch,
    ]);
    assert.equal(exhausted.action, "block");
    if (exhausted.action === "block") assert.match(exhausted.reason, /exhausted after 2 repair attempt/);
  });

  it("accepts only a typed human verification adjudication after repair exhaustion", () => {
    const runId = "run_repair_adjudication";
    const delivery = publicationArtifacts(runId).filter((artifact) => artifact.kind !== "BuildResult");
    const first = repairOutcome(runId, "2026-01-01T00:01:00.000Z");
    const firstDispatch = repairOutcome(runId, "2026-01-01T00:02:00.000Z", { repairAttempt: 1 });
    const secondDispatch = repairOutcome(runId, "2026-01-01T00:03:00.000Z", { repairAttempt: 2 });
    const adjudication = createArtifact({
      kind: "VerificationAdjudication",
      runId,
      subject,
      producer: { role: "human", runtime: "forgedock" },
      payload: {
        checkpoint: "verification",
        decision: "resume",
        supersedesOutcomeId: secondDispatch.id,
        reason: "The verification baseline was repaired and independently checked.",
      },
    });
    const decision = decideSubjectAdmission([
      intent(runId, "2026-01-01T00:00:00.000Z"), ...delivery, first, firstDispatch, secondDispatch, adjudication,
    ]);
    assert.equal(decision.action, "resume");
    if (decision.action === "resume") {
      assert.equal(decision.state, "blocked");
      assert.equal(decision.checkpoint, "verification");
    }
  });

  it("counts every request-changes verdict as a durable remediation cycle", () => {
    const runId = "run_review_cycles";
    const requestChanges = (headSha: string) => createArtifact({
      kind: "ReviewVerdict",
      runId,
      subject,
      producer: { role: "controller" },
      payload: {
        headSha,
        disposition: "request_changes",
        reviewerRoles: ["correctness"],
        findings: [],
        checks: [],
      },
    });
    const approved = createArtifact({
      kind: "ReviewVerdict",
      runId,
      subject,
      producer: { role: "controller" },
      payload: {
        headSha: "c".repeat(40),
        disposition: "approve",
        reviewerRoles: ["correctness"],
        findings: [],
        checks: [],
      },
    });
    assert.equal(reviewRemediationCycleCount([
      requestChanges("a".repeat(40)),
      approved,
      requestChanges("b".repeat(40)),
    ]), 2);
  });

  it("selects the latest artifact by durable publication order instead of worker timestamps", () => {
    const runId = "run_artifact_order";
    const first = repairOutcome(runId, "2099-01-01T00:00:00.000Z");
    const dispatched = repairOutcome(runId, "2026-01-01T00:00:00.000Z", { repairAttempt: 1 });
    assert.equal(latestArtifactOfKind([first, dispatched], "Outcome")?.id, dispatched.id);
  });

  it("does not replay a recursive checkpoint superseded by a later verified BuildResult", () => {
    const runId = "run_recursive_complete";
    const delivery = publicationArtifacts(runId);
    const build = delivery.find((artifact) => artifact.kind === "BuildResult");
    assert.ok(build?.kind === "BuildResult");
    const verdict = createArtifact({
      kind: "ReviewVerdict",
      runId,
      subject,
      producer: { role: "controller" },
      payload: {
        headSha: build.payload.headSha,
        disposition: "approve",
        reviewerRoles: ["correctness"],
        findings: [],
        checks: [],
      },
    });
    const checkpoint = createArtifact({
      kind: "RemediationBlocked",
      runId,
      subject,
      producer: { role: "controller" },
      payload: {
        checkpointKey: "c".repeat(64), checkpointSequence: 3, status: "ready-to-resume",
        parentRunId: runId, parentIssue: 1, pullRequest: 9, headSha: "a".repeat(40),
        headBranch: "forgedock/parent", baseBranch: "main", packetArtifactId: "art_packet",
        verdictArtifactId: "art_verdict", reason: "scope-violation", findings: [], childIssues: [30],
        childRunIds: [], approvedPaths: ["docs/a.md"], childOutcomeIds: ["art_child"],
        remediationDepth: 0, maxRemediationDepth: 2,
      },
    });
    const parentProof = createArtifact({
      kind: "BuildResult", runId, subject, producer: { role: "controller" },
      payload: { ...build.payload, summary: "Expanded parent revision verified" },
    });
    const interrupted = decideSubjectAdmission([
      intent(runId, "2026-01-01T00:00:00.000Z"), ...delivery, verdict, checkpoint, parentProof,
    ]);
    assert.equal(interrupted.action, "resume");
    if (interrupted.action === "resume") assert.equal(interrupted.checkpoint, "publication");

    const merged = createArtifact({
      kind: "Outcome", runId, subject, producer: { role: "controller" },
      payload: {
        status: "merged", reason: "completed", finalSha: build.payload.headSha,
        prUrl: "https://example.test/pr/9", childIssues: [],
      },
    });
    const decision = decideSubjectAdmission([
      intent(runId, "2026-01-01T00:00:00.000Z"), ...delivery, verdict, checkpoint, parentProof, merged,
    ]);
    assert.deepEqual(decision, { action: "skip", runId, state: "completed" });
  });

  it("uses durable artifact order instead of skewed worker timestamps for supersession", () => {
    const runId = "run_skewed_repair";
    const delivery = publicationArtifacts(runId);
    const build = delivery.find((artifact) => artifact.kind === "BuildResult");
    assert.ok(build?.kind === "BuildResult");
    const preBuildFailure = repairOutcome(runId, "2099-01-01T00:00:00.000Z");
    const decision = decideSubjectAdmission([
      intent(runId, "2026-01-01T00:00:00.000Z"),
      ...delivery.filter((artifact) => artifact.kind !== "BuildResult"),
      preBuildFailure,
      { ...build, createdAt: "2025-01-01T00:00:00.000Z" },
    ]);
    assert.equal(decision.action, "resume");
    if (decision.action === "resume") assert.equal(decision.checkpoint, "publication");
  });

  it("does not send an unchanged baseline failure to a builder repair loop", () => {
    const runId = "run_known_baseline";
    const delivery = publicationArtifacts(runId).filter((artifact) => artifact.kind !== "BuildResult");
    const blocked = repairOutcome(runId, "2026-01-01T00:01:00.000Z", { regression: false });
    const decision = decideSubjectAdmission([intent(runId, "2026-01-01T00:00:00.000Z"), ...delivery, blocked]);
    assert.equal(decision.action, "resume");
    if (decision.action === "resume") assert.equal(decision.checkpoint, "verification");
  });

  it("keeps verification infrastructure failures out of the builder repair loop", () => {
    const runId = "run_infrastructure_failure";
    const delivery = publicationArtifacts(runId).filter((artifact) => artifact.kind !== "BuildResult");
    const blocked = repairOutcome(runId, "2026-01-01T00:01:00.000Z", {
      failureClass: "infrastructure",
      repairAttempt: 1,
    });
    const decision = decideSubjectAdmission([intent(runId, "2026-01-01T00:00:00.000Z"), ...delivery, blocked]);
    assert.equal(decision.action, "resume");
    if (decision.action === "resume") assert.equal(decision.checkpoint, "verification");
  });

  it("treats incomplete criterion coverage as a repairable builder failure", () => {
    const runId = "run_coverage_repair";
    const delivery = publicationArtifacts(runId).filter((artifact) => artifact.kind !== "BuildResult");
    const blocked = repairOutcome(runId, "2026-01-01T00:01:00.000Z", {
      reason: "Builder criterion coverage is incomplete: missing documented",
    });
    const decision = decideSubjectAdmission([intent(runId, "2026-01-01T00:00:00.000Z"), ...delivery, blocked]);
    assert.equal(decision.action, "resume");
    if (decision.action === "resume") assert.equal(decision.checkpoint, "build");
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

  it("refuses rootless remediation authority but resumes a finding linked to the current controller ledger", () => {
    const runId = "run_root_authority_admission";
    const delivery = publicationArtifacts(runId).map((artifact, index) => ({
      ...artifact, createdAt: `2026-01-01T00:0${index + 1}:00.000Z`,
    }));
    const finding = {
      id: "root-authority-finding", rootId: "root-authority-1", severity: "high" as const,
      confidence: "high" as const, blocking: true, mustFix: true, scopeDisposition: "in_scope" as const,
      title: "Guard remains incomplete", evidence: "The accepted guard path is missing.",
      intentRelevance: "The frozen criterion requires the guard.", remediation: "Complete the guard.",
    };
    const { rootId: _rootId, ...rootlessFinding } = finding;
    const rootlessVerdict = createArtifact({
      kind: "ReviewVerdict", runId, subject: { ...subject, pr: 57 }, producer: { role: "controller" },
      payload: {
        headSha: "d".repeat(40), disposition: "request_changes", reviewerRoles: ["correctness"],
        findings: [rootlessFinding], checks: [],
      },
    }, { createdAt: "2026-01-01T00:04:00.000Z" });
    const rootlessDecision = decideSubjectAdmission([
      intent(runId, "2026-01-01T00:00:00.000Z"), ...delivery, rootlessVerdict,
    ]);
    assert.equal(rootlessDecision.action, "block");
    if (rootlessDecision.action === "block") assert.match(rootlessDecision.reason, /controller-owned finding-root ledger/);

    const verdict = createArtifact({
      kind: "ReviewVerdict", runId, subject: { ...subject, pr: 57 }, producer: { role: "controller" },
      payload: {
        headSha: "d".repeat(40), disposition: "request_changes", reviewerRoles: ["correctness"],
        findings: [finding], checks: [],
      },
    }, { createdAt: "2026-01-01T00:04:00.000Z" });
    const ledger = createArtifact({
      kind: "FindingRootLedger", runId, subject: { ...subject, pr: 57 }, producer: { role: "controller" },
      payload: {
        checkpoint: "finding-root-ledger", pullRequest: 57, headSha: "d".repeat(40), epoch: 1,
        roots: [{
          rootId: finding.rootId, structuralKey: "root-structure", aliases: ["root-structure"], criterionIds: ["criterion-1"],
          component: "docs/a.md", symbols: ["guard"], invariantFamily: "criterion", failureFamily: "guard", triggerFamily: "missing",
          state: "open", firstSeenHeadSha: "d".repeat(40), lastSeenHeadSha: "d".repeat(40), epochsOpen: 1,
          findingIds: [finding.id], ownerRoles: ["correctness"], representative: finding,
        }],
      },
    }, { createdAt: "2026-01-01T00:05:00.000Z" });
    const rootedDecision = decideSubjectAdmission([
      intent(runId, "2026-01-01T00:00:00.000Z"), ...delivery, verdict, ledger,
    ]);
    assert.equal(rootedDecision.action, "resume");
    if (rootedDecision.action === "resume") {
      assert.equal(rootedDecision.state, "remediating");
      assert.equal(rootedDecision.checkpoint, "remediation");
    }
  });

  it("does not resume remediation when the current root ledger is stale", () => {
    const runId = "run_stale_root_authority";
    const delivery = publicationArtifacts(runId).map((artifact, index) => ({
      ...artifact, createdAt: `2026-01-01T00:0${index + 1}:00.000Z`,
    }));
    const finding = {
      id: "stale-root-finding", rootId: "root-stale", severity: "high" as const, confidence: "high" as const,
      blocking: true, mustFix: true, scopeDisposition: "in_scope" as const, title: "Stale root", evidence: "stale",
      intentRelevance: "criterion", remediation: "fix",
    };
    const verdict = createArtifact({
      kind: "ReviewVerdict", runId, subject: { ...subject, pr: 57 }, producer: { role: "controller" },
      payload: { headSha: "d".repeat(40), disposition: "request_changes", reviewerRoles: ["correctness"], findings: [finding], checks: [] },
    });
    const staleLedger = createArtifact({
      kind: "FindingRootLedger", runId, subject: { ...subject, pr: 57 }, producer: { role: "controller" },
      payload: {
        checkpoint: "finding-root-ledger", pullRequest: 57, headSha: "a".repeat(40), epoch: 1,
        roots: [{
          rootId: finding.rootId, structuralKey: "stale", aliases: ["stale"], criterionIds: ["criterion-1"], component: "docs/a.md",
          symbols: ["guard"], invariantFamily: "criterion", failureFamily: "guard", triggerFamily: "missing", state: "open",
          firstSeenHeadSha: "a".repeat(40), lastSeenHeadSha: "a".repeat(40), epochsOpen: 1, findingIds: [finding.id], ownerRoles: ["correctness"], representative: finding,
        }],
      },
    });
    const decision = decideSubjectAdmission([
      intent(runId, "2026-01-01T00:00:00.000Z"), ...delivery, verdict, staleLedger,
    ]);
    assert.equal(decision.action, "block");
    if (decision.action === "block") assert.match(decision.reason, /reviewed head/);
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

  it("salvages remediation after a failed Outcome with a prior request-changes verdict", () => {
    const runId = "run_failed_remediation_salvage";
    const delivery = publicationArtifacts(runId).map((artifact, index) => ({
      ...artifact, createdAt: `2026-01-01T00:0${index + 1}:00.000Z`,
    }));
    const verdict = createArtifact({
      kind: "ReviewVerdict", runId, subject: { ...subject, pr: 57 }, producer: { role: "controller" },
      payload: { headSha: "d".repeat(40), disposition: "request_changes", reviewerRoles: ["correctness"], findings: [], checks: [] },
    }, { createdAt: "2026-01-01T00:04:00.000Z" });
    const failed = outcome(runId, "2026-01-01T00:05:00.000Z", "failed");

    const decision = decideSubjectAdmission([intent(runId, "2026-01-01T00:00:00.000Z"), ...delivery, verdict, failed]);

    assert.equal(decision.action, "resume");
    if (decision.action === "resume") {
      assert.equal(decision.runId, runId);
      assert.equal(decision.state, "remediating");
      assert.equal(decision.checkpoint, "remediation");
      assert.equal(decision.artifacts.at(-1)?.id, failed.id);
      assert.equal(decision.artifacts.at(-2)?.id, verdict.id);
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

  it("routes a no-change remediation through the bounded packet builder with review context", () => {
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
    const intentArtifact = intent(runId, "2026-01-01T00:00:00.000Z");
    const artifacts = [intentArtifact, ...delivery, verdict, blocked];
    const decision = decideSubjectAdmission(artifacts);
    assert.equal(decision.action, "resume");
    if (decision.action === "resume") {
      assert.equal(decision.state, "building");
      assert.equal(decision.checkpoint, "build");
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

  it("requires explicit conflict recovery after an approval becomes conflicting", () => {
    const runId = "run_conflict_recovery";
    const delivery = publicationArtifacts(runId).map((artifact, index) => ({
      ...artifact,
      createdAt: `2026-01-01T00:0${index + 1}:00.000Z`,
    }));
    const headSha = "d".repeat(40);
    const verdict = createArtifact({
      kind: "ReviewVerdict", runId, subject: { ...subject, pr: 77 }, producer: { role: "reviewer" },
      payload: { headSha, disposition: "approve", reviewerRoles: ["correctness"], findings: [], checks: [] },
    }, { createdAt: "2026-01-01T00:04:00.000Z" });
    const blocked = createArtifact({
      kind: "Outcome", runId, subject, producer: { role: "controller" },
      payload: {
        status: "blocked",
        reason: "Merge admission is blocked: confirmed conflict",
        childIssues: [],
        mergeGate: {
          pullRequest: 77,
          headSha,
          baseBranch: "staging",
          mergeable: false,
          mergeability: "conflicting",
          observedAt: "2026-01-01T00:05:00.000Z",
          requiredChecks: [],
        },
      },
    }, { createdAt: "2026-01-01T00:05:00.000Z" });
    const intentArtifact = intent(runId, "2026-01-01T00:00:00.000Z");
    const artifacts = [intentArtifact, ...delivery, verdict, blocked];
    const decision = decideSubjectAdmission(artifacts);
    assert.deepEqual(decision, {
      action: "resume",
      runId,
      state: "blocked",
      checkpoint: "conflict-recovery",
      artifacts,
    });
  });

  it("does not admit a conflicting checkpoint whose PR, base, or repository identity drifted", () => {
    const runId = "run_conflict_identity";
    const headSha = "d".repeat(40);
    const delivery = publicationArtifacts(runId).map((artifact) => artifact.kind === "BuildResult"
      ? { ...artifact, payload: { ...artifact.payload, targetBranch: "staging" } }
      : artifact);
    const verdict = createArtifact({
      kind: "ReviewVerdict", runId, subject: { ...subject, pr: 77 }, producer: { role: "reviewer" },
      payload: {
        headSha, baseBranch: "staging", disposition: "approve", reviewerRoles: ["correctness"], findings: [], checks: [],
      },
    });
    const gate = {
      repo: "a/b",
      pullRequest: 77,
      headSha,
      baseBranch: "staging",
      mergeable: false,
      mergeability: "conflicting" as const,
      observedAt: "2026-01-01T00:05:00.000Z",
      requiredChecks: [],
    };
    for (const [label, drift] of [
      ["pull request", { pullRequest: 78 }],
      ["base branch", { baseBranch: "main" }],
      ["repository", { repo: "other/repo" }],
    ] as const) {
      const blocked = createArtifact({
        kind: "Outcome", runId, subject, producer: { role: "controller" },
        payload: {
          status: "blocked", reason: `identity drift: ${label}`, childIssues: [],
          mergeGate: { ...gate, ...drift },
        },
      });
      const decision = decideSubjectAdmission([intent(runId, "2026-01-01T00:00:00.000Z"), ...delivery, verdict, blocked]);
      assert.notEqual(
        decision.action === "resume" ? decision.checkpoint : undefined,
        "conflict-recovery",
        `identity drift in ${label} must not authorize conflict recovery`,
      );
    }
  });

  it("does not promote transient or unavailable mergeability into conflict recovery", () => {
    const runId = "run_transient_mergeability";
    const delivery = publicationArtifacts(runId);
    const headSha = "d".repeat(40);
    const verdict = createArtifact({
      kind: "ReviewVerdict", runId, subject: { ...subject, pr: 78 }, producer: { role: "reviewer" },
      payload: { headSha, disposition: "approve", reviewerRoles: ["correctness"], findings: [], checks: [] },
    });
    for (const mergeability of ["unknown", "unavailable"] as const) {
      const blocked = createArtifact({
        kind: "Outcome", runId, subject, producer: { role: "controller" },
        payload: {
          status: "blocked", reason: "Merge admission is not ready", childIssues: [],
          mergeGate: {
            pullRequest: 78, headSha, baseBranch: "staging", mergeable: false, mergeability,
            observedAt: "2026-01-01T00:05:00.000Z", requiredChecks: [],
          },
        },
      });
      const decision = decideSubjectAdmission([intent(runId, "2026-01-01T00:00:00.000Z"), ...delivery, verdict, blocked]);
      assert.notEqual(decision.action === "resume" ? decision.checkpoint : undefined, "conflict-recovery");
    }
  });
});
