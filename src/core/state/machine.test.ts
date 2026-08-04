import assert from "node:assert/strict";
import { describe, it } from "node:test";
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
      "MERGE_COMPLETED",
      "CLOSE_COMPLETED",
    ] as const) {
      run = transition(run, event, { now: "2026-01-01T00:00:01.000Z" }).state;
    }
    assert.equal(run.state, "completed");
    assert.equal(run.version, 9);
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
