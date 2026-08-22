import assert from "node:assert/strict";
import { test } from "node:test";
import { createRun } from "../state/machine.js";
import { summarizeQuality, renderQualitySummary } from "./telemetry.js";

test("quality projection unions phase intervals and exposes first pass evidence", () => {
  const run = createRun({ workflow: "work-on", subject: { repo: "r", issue: 443 }, runId: "run-443", now: "2026-01-01T00:00:00.000Z" });
  const summary = summarizeQuality({
    run,
    transitions: [
      { runId: run.runId, sequence: 1, event: "START_INVESTIGATION", from: "queued", to: "investigating", occurredAt: "2026-01-01T00:00:01.000Z" },
      { runId: run.runId, sequence: 2, event: "INVESTIGATION_CONFIRMED", from: "investigating", to: "preparing", occurredAt: "2026-01-01T00:00:02.000Z" },
      { runId: run.runId, sequence: 3, event: "BUILD_PACKET_READY", from: "preparing", to: "building", occurredAt: "2026-01-01T00:00:03.000Z" },
      { runId: run.runId, sequence: 4, event: "BUILD_COMPLETED", from: "building", to: "verifying", occurredAt: "2026-01-01T00:00:04.000Z" },
      { runId: run.runId, sequence: 5, event: "VERIFICATION_FAILED", from: "verifying", to: "blocked", occurredAt: "2026-01-01T00:00:05.000Z" },
    ],
    now: Date.parse("2026-01-01T00:00:08.000Z"),
    agentReceipts: [
      { key: "a", runId: run.runId, taskId: "run-443:build", phase: "build", role: "builder", sessionRef: "session", sessionLineage: ["session"], provider: "provider", model: "model", timing: { queuedAt: "2026-01-01T00:00:00.000Z", startedAt: "2026-01-01T00:00:01.000Z", completedAt: "2026-01-01T00:00:03.000Z", activeMs: 2_000, queueMs: 1_000, retryCount: 0 }, usage: { source: "unavailable" } },
      { key: "b", runId: run.runId, taskId: "run-443:review", phase: "review", role: "reviewer", sessionRef: "session-2", sessionLineage: ["session-2"], provider: "provider", model: "model", timing: { queuedAt: "2026-01-01T00:00:01.000Z", startedAt: "2026-01-01T00:00:02.000Z", completedAt: "2026-01-01T00:00:04.000Z", activeMs: 2_000, queueMs: 1_000, retryCount: 1 }, usage: { source: "unavailable" } },
    ],
  });
  assert.equal(summary.firstPass.verification, false);
  assert.equal(summary.wallClock.queuedMs, 1_000);
  assert.equal(summary.wallClock.humanHeldMs, 3_000);
  assert.equal(summary.agent.activeMs, 4_000);
  assert.equal(summary.agent.retries, 1);
  assert.equal(summary.attributions[0]?.category, "unknown");
});

test("quality projection fails closed on invalid timestamps and redacts operator output", () => {
  const run = createRun({ workflow: "work-on", subject: { repo: "r", issue: 458 }, runId: "run-458", now: "not-a-date" });
  const summary = summarizeQuality({ run, transitions: [{ runId: run.runId, sequence: 1, event: "START_INVESTIGATION", from: "queued", to: "investigating", occurredAt: "backwards" }], now: Date.parse("2026-01-01T00:00:01.000Z") });
  assert.equal(summary.wallClock.elapsedMs, 0);
  assert.doesNotMatch(renderQualitySummary(summary), /not-a-date|backwards/);
  assert.equal(summary.redaction, "controller-evidence-only");
});
