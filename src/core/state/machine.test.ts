import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { InvalidTransitionError, attachArtifact, createRun, transition } from "./machine.js";

describe("workflow state machine", () => {
  it("stores a canonical forge-qualified subject in new runs", () => {
    const run = createRun({ workflow: "work-on", subject: { forge: " GitHub.COM.. ", repo: " ACME/Widget ", issue: 7 } });
    assert.deepEqual(run.subject, { forge: "github.com", repo: "acme/widget", issue: 7 });
  });

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
      "MERGE_COMPLETED",
      "CLOSE_COMPLETED",
    ] as const) {
      run = transition(run, event, { now: "2026-01-01T00:00:01.000Z" }).state;
    }
    assert.equal(run.state, "completed");
    assert.equal(run.version, 9);
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
    assert.deepEqual(started.milestone, target.milestone);
  });

  it("makes invalid and decomposed investigations terminal", () => {
    const started = transition(createRun({ workflow: "work-on", subject: { repo: "a/b", issue: 1 } }), "START_INVESTIGATION").state;
    assert.equal(transition(started, "INVESTIGATION_INVALID").state.state, "invalid");
    assert.equal(transition(started, "INVESTIGATION_DECOMPOSED").state.state, "decomposed");
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
});
