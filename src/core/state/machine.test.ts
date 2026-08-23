import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { PullRequestMergeGate } from "../ports/forge-host.js";
import { InvalidTransitionError, attachArtifact, createRun, transition } from "./machine.js";

describe("workflow state machine", () => {
  it("routes confirmed work through the controlled happy path", () => {
    let run = createRun({ workflow: "work-on", subject: { repo: "acme/widget", issue: 7 }, runId: "run_7", now: "2026-01-01T00:00:00.000Z" });
    for (const event of [
      "START_INVESTIGATION",
      "INVESTIGATION_CONFIRMED",
      "BUILD_PACKET_READY",
      "BUILD_COMPLETED",
      "VERIFICATION_PASSED",
      "PR_PUBLISHED",
      "REVIEW_APPROVED",
    ] as const) {
      run = transition(run, event, { now: "2026-01-01T00:00:01.000Z" }).state;
    }
    const gate: PullRequestMergeGate = {
      repo: "acme/widget",
      pullRequest: 7,
      headSha: "a".repeat(40),
      baseBranch: "main",
      mergeable: true,
      requiredChecksProvenance: "github-required",
      requiredChecksHeadSha: "a".repeat(40),
      requiredChecks: [{ name: "CI", state: "passed" }],
      observedAt: "2026-01-01T00:00:01.000Z",
    };
    const mergeAttempt = {
      schema: "forgedock.merge-attempt/v1" as const,
      repo: gate.repo,
      pullRequest: gate.pullRequest,
      headSha: gate.headSha,
      baseBranch: gate.baseBranch,
      gate,
      admittedAt: "2026-01-01T00:00:01.000Z",
    };
    run = transition(run, "MERGE_ATTEMPT_RECORDED", { now: "2026-01-01T00:00:01.000Z", mergeAttempt }).state;
    assert.deepEqual(run.mergeAttempt, mergeAttempt);
    run = transition(run, "MERGE_COMPLETED", { now: "2026-01-01T00:00:01.000Z", mergeAttempt: null }).state;
    assert.equal(run.mergeAttempt, undefined);
    run = transition(run, "CLOSE_COMPLETED", { now: "2026-01-01T00:00:01.000Z" }).state;
    assert.equal(run.state, "completed");
    assert.equal(run.version, 10);
  });

  it("freezes lane identity and target branch across transitions", () => {
    const target = {
      lane: "feature" as const,
      targetBranch: "milestone/verifiable-workflow-authority",
      milestone: { number: 1, title: "Verifiable Workflow Authority & Portability" },
    };
    const run = createRun({ workflow: "work-on", subject: { repo: "a/b", issue: 6 }, target });
    const started = transition(run, "START_INVESTIGATION").state;
    assert.equal(started.lane, "feature");
    assert.equal(started.targetBranch, target.targetBranch);
    assert.equal(started.promotionTarget, undefined);
    assert.equal(started.productionTarget, undefined);
    assert.deepEqual(started.milestone, target.milestone);
  });

  it("makes invalid and decomposed investigations terminal", () => {
    const started = transition(createRun({ workflow: "work-on", subject: { repo: "a/b", issue: 1 } }), "START_INVESTIGATION").state;
    assert.equal(transition(started, "INVESTIGATION_INVALID").state.state, "invalid");
    assert.equal(transition(started, "INVESTIGATION_DECOMPOSED").state.state, "decomposed");
  });

  it("persists promotion and protected production targets in RunState", () => {
    const run = createRun({
      workflow: "work-on",
      subject: { repo: "a/b", issue: 12 },
      target: { lane: "feature", targetBranch: "milestone/ship", promotionTarget: "staging", productionTarget: "main", milestone: { number: 2, title: "Ship" } },
    });
    assert.equal(run.promotionTarget, "staging");
    assert.equal(run.productionTarget, "main");
  });

  it("records a new attempt when resuming an interrupted build", () => {
    let run = createRun({ workflow: "work-on", subject: { repo: "a/b", issue: 8 } });
    for (const event of ["START_INVESTIGATION", "INVESTIGATION_CONFIRMED", "BUILD_PACKET_READY"] as const) run = transition(run, event).state;
    const resumed = transition(run, "RESUME_BUILD").state;
    assert.equal(resumed.state, "building");
    assert.equal(resumed.attempt, 2);
  });

  it("atomically replaces issue-hint scope when the Build Packet freezes", () => {
    let run = createRun({
      workflow: "work-on",
      subject: { repo: "a/b", issue: 8 },
      scopeManifest: { readRoots: ["src/core"], writeRoots: [], source: "issue-hints" },
    });
    run = transition(run, "START_INVESTIGATION").state;
    run = transition(run, "INVESTIGATION_CONFIRMED").state;
    const packetScope = {
      readRoots: ["src"],
      writeRoots: [],
      writePaths: ["src/core/a.ts"],
      source: "build-packet" as const,
    };
    run = transition(run, "BUILD_PACKET_READY", { scopeManifest: packetScope }).state;
    assert.deepEqual(run.scopeManifest, packetScope);
    assert.throws(() => transition(run, "BUILD_COMPLETED", { scopeManifest: packetScope }), /only when the Build Packet freezes/);
  });

  it("routes two verification repairs before recording deterministic exhaustion", () => {
    let run = createRun({ workflow: "work-on", subject: { repo: "a/b", issue: 8 } });
    for (const event of ["START_INVESTIGATION", "INVESTIGATION_CONFIRMED", "BUILD_PACKET_READY", "BUILD_COMPLETED", "VERIFICATION_FAILED"] as const) {
      run = transition(run, event, event === "VERIFICATION_FAILED" ? { reason: "failed" } : {}).state;
    }
    run = transition(run, "VERIFICATION_REPAIR_REQUESTED").state;
    assert.equal(run.state, "building");
    assert.equal(run.attempt, 2);
    run = transition(run, "BUILD_COMPLETED").state;
    run = transition(run, "VERIFICATION_FAILED", { reason: "failed again" }).state;
    run = transition(run, "VERIFICATION_REPAIR_REQUESTED").state;
    assert.equal(run.attempt, 3);
    run = transition(run, "BUILD_COMPLETED").state;
    run = transition(run, "VERIFICATION_FAILED", { reason: "still failed" }).state;
    run = transition(run, "VERIFICATION_REPAIR_EXHAUSTED", { reason: "Verification repair budget exhausted after 2 repair attempt(s)" }).state;
    assert.equal(run.state, "blocked");
    assert.match(run.blockedReason ?? "", /exhausted after 2/);
  });

  it("does not consume semantic attempts while rehydrating a retry wait", () => {
    let run = createRun({ workflow: "work-on", subject: { repo: "a/b", issue: 12 }, target: { lane: "fast", targetBranch: "main" } });
    for (const event of ["START_INVESTIGATION", "INVESTIGATION_CONFIRMED", "BUILD_PACKET_READY", "BUILD_COMPLETED", "VERIFICATION_PASSED", "TARGET_RECOVERY_REQUESTED"] as const) {
      run = transition(run, event).state;
    }
    run = transition(run, "RETRY_WAIT_SCHEDULED").state;
    const attempt = run.attempt;
    run = transition(run, "RESUME_RETRY_WAIT").state;
    run = transition(run, "RESUME_RETRY_WAIT").state;
    assert.equal(run.attempt, attempt);
  });

  it("resumes a retained verification workspace without replaying investigation or build", () => {
    let run = createRun({ workflow: "work-on", subject: { repo: "a/b", issue: 8 } });
    for (const event of ["START_INVESTIGATION", "INVESTIGATION_CONFIRMED", "BUILD_PACKET_READY", "BUILD_COMPLETED", "VERIFICATION_FAILED"] as const) {
      run = transition(run, event, event === "VERIFICATION_FAILED" ? { reason: "known base failure" } : {}).state;
    }
    const resumed = transition(run, "RESUME_VERIFICATION").state;
    assert.equal(resumed.state, "verifying");
    assert.equal(resumed.attempt, 2);
    assert.equal(resumed.blockedReason, undefined);
  });

  it("reassesses an exhausted review budget before authorizing more remediation", () => {
    let run = createRun({ workflow: "work-on", subject: { repo: "a/b", issue: 8 } });
    for (const event of [
      "START_INVESTIGATION", "INVESTIGATION_CONFIRMED", "BUILD_PACKET_READY", "BUILD_COMPLETED",
      "VERIFICATION_PASSED", "PR_PUBLISHED", "REVIEW_CHANGES_REQUESTED", "BLOCK",
    ] as const) {
      run = transition(run, event, event === "BLOCK" ? { reason: "Remediation budget exhausted after 2 cycle(s)" } : {}).state;
    }
    const resumed = transition(run, "RESUME_REVIEW").state;
    assert.equal(resumed.state, "reviewing");
    assert.equal(resumed.attempt, 2);
    assert.equal(resumed.blockedReason, undefined);
  });

  it("allows the exact controller-authored expanded review resume", () => {
    const queued = createRun({ workflow: "work-on", subject: { repo: "a/b", issue: 11 }, target: { lane: "fast", targetBranch: "main" } });
    const blocked = transition(queued, "BLOCK", { reason: "recursive remediation" }).state;
    const resumed = transition(blocked, "RESUME_EXPANDED_REVIEW", { headSha: "a".repeat(40) }).state;
    assert.equal(resumed.state, "reviewing");
    assert.equal(resumed.blockedReason, undefined);
  });

  it("uses a distinct typed transition for explicitly authorized conflict recovery", () => {
    const queued = createRun({ workflow: "work-on", subject: { repo: "a/b", issue: 11 }, target: { lane: "fast", targetBranch: "main" } });
    const blocked = transition(queued, "BLOCK", { reason: "confirmed target conflict" }).state;
    const resumed = transition(blocked, "RESUME_CONFLICT_RECOVERY", {
      reason: "operator authorized target synchronization",
      headSha: "a".repeat(40),
    }).state;
    assert.equal(resumed.state, "verifying");
    assert.equal(resumed.attempt, blocked.attempt + 1);
    assert.equal(resumed.blockedReason, undefined);
  });

  it("records typed interruption recovery within remediation and completion", () => {
    let remediation = createRun({ workflow: "work-on", subject: { repo: "a/b", issue: 9 } });
    for (const event of [
      "START_INVESTIGATION", "INVESTIGATION_CONFIRMED", "BUILD_PACKET_READY", "BUILD_COMPLETED",
      "VERIFICATION_PASSED", "PR_PUBLISHED", "REVIEW_CHANGES_REQUESTED",
    ] as const) remediation = transition(remediation, event).state;
    assert.equal(transition(remediation, "RESUME_REMEDIATION").state.state, "remediating");

    let completion = createRun({ workflow: "work-on", subject: { repo: "a/b", issue: 10 } });
    for (const event of [
      "START_INVESTIGATION", "INVESTIGATION_CONFIRMED", "BUILD_PACKET_READY", "BUILD_COMPLETED",
      "VERIFICATION_PASSED", "PR_PUBLISHED", "REVIEW_APPROVED",
    ] as const) completion = transition(completion, event).state;
    const resumed = transition(completion, "RESUME_COMPLETION").state;
    assert.equal(resumed.state, "merging");
    assert.equal(resumed.attempt, 2);
  });

  it("permits only typed publication recovery from a failed revision projection", () => {
    let run = createRun({ workflow: "work-on", subject: { repo: "a/b", issue: 8 } });
    run = transition(run, "FAIL", { reason: "Published remediation head old does not match verified build new" }).state;
    assert.throws(() => transition(run, "RESUME_PUBLICATION"), InvalidTransitionError);
    const resumed = transition(run, "RECOVER_REVISION_PUBLICATION").state;
    assert.equal(resumed.state, "publishing");
    assert.equal(resumed.attempt, 2);
    assert.throws(() => transition(run, "REVIEW_APPROVED"), InvalidTransitionError);
  });

  it("forces changes through remediation, verification, publish and fresh review", () => {
    let run = createRun({ workflow: "review-pr", subject: { repo: "a/b", pr: 8 } });
    run = transition(run, "REVIEW_CHANGES_REQUESTED").state;
    run = transition(run, "REMEDIATION_COMPLETED").state;
    assert.equal(run.state, "verifying");
    run = transition(run, "VERIFICATION_PASSED").state;
    assert.equal(run.state, "publishing");
    run = transition(run, "PR_PUBLISHED").state;
    assert.equal(run.state, "reviewing");
  });

  it("rejects model-like attempts to skip verification or review", () => {
    const started = transition(createRun({ workflow: "work-on", subject: { repo: "a/b", issue: 2 } }), "START_INVESTIGATION").state;
    assert.throws(() => transition(started, "REVIEW_APPROVED"), InvalidTransitionError);
  });

  it("attaches artifacts idempotently", () => {
    const run = createRun({ workflow: "work-on", subject: { repo: "a/b", issue: 3 } });
    const once = attachArtifact(run, "Intent", "art_1");
    const twice = attachArtifact(once, "Intent", "art_1");
    assert.deepEqual(twice.artifactIds.Intent, ["art_1"]);
  });

  it("invariant:matrix-identity-isolation-32c8f76132c0 preserves exact review route across restart transitions", () => {
    const route = {
      routeKind: "retained-revision" as const,
      repository: "a/b", pullRequest: 9, reviewedHeadSha: "a".repeat(40),
      headBranch: "forgedock/delivery", baseBranch: "staging", baseSha: "b".repeat(40),
      deliveryIssue: 8, deliveryRun: "run_8", findingId: "finding-1", findingRoot: "root-1",
      lineage: { lineageId: "lineage-1", sourceRunId: "run_8", sourcePullRequest: 9, sourceHeadSha: "a".repeat(40), findingId: "finding-1", findingRoot: "root-1" },
    };
    let run = createRun({ workflow: "work-on", subject: { repo: "a/b", issue: 10 }, target: { lane: "fast", targetBranch: route.headBranch, route } });
    run = transition(run, "START_INVESTIGATION").state;
    run = transition(run, "BLOCK", { reason: "restart checkpoint" }).state;
    assert.deepEqual(run.route, route);
    assert.equal(run.route?.lineage.sourceHeadSha, route.reviewedHeadSha);
  });

  it("invariant:matrix-terminal-metadata-9ff555a27dbf retains route metadata on cancellation", () => {
    const route = {
      routeKind: "base-follow-up" as const,
      repository: "a/b", pullRequest: 9, reviewedHeadSha: "a".repeat(40),
      headBranch: "forgedock/delivery", baseBranch: "staging", baseSha: "b".repeat(40),
      deliveryIssue: 8, deliveryRun: "run_8", findingId: "finding-1", findingRoot: "root-1",
      lineage: { lineageId: "lineage-1", sourceRunId: "run_8", sourcePullRequest: 9, sourceHeadSha: "a".repeat(40), findingId: "finding-1", findingRoot: "root-1" },
    };
    const run = createRun({ workflow: "work-on", subject: { repo: "a/b", issue: 10 }, target: { lane: "fast", targetBranch: "staging", route } });
    const cancelled = transition(run, "CANCEL", { reason: "operator cancellation" }).state;
    assert.equal(cancelled.state, "cancelled");
    assert.equal(cancelled.route?.routeKind, "base-follow-up");
    assert.equal(cancelled.route?.lineage.lineageId, "lineage-1");
  });
});
