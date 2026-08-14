import assert from "node:assert/strict";
import { test } from "node:test";
import { Type } from "typebox";
import { FakeAgentRuntime } from "./fake-runtime.js";
import { AgentRunError, TelemetryAgentRuntime, createScopeManifestReceipt, scopeManifestFor, scopeManifestForReviewer, validateScopeManifestReceipt } from "./agent-runtime.js";
import { summarizeControllerTiming, type AgentRunReceipt } from "../core/ports/telemetry.js";

function task(id: string) {
  return {
    id,
    role: "investigator" as const,
    objective: "test",
    instructions: "test",
    context: [],
    workspace: {
      cwd: process.cwd(),
      mode: "read-only" as const,
      scope: scopeManifestFor("issue-hints", { metadataRoots: ["."] }),
    },
    tools: ["read" as const],
    outputSchema: Type.Object({ ok: Type.Boolean() }),
    modelPolicy: {},
  };
}

test("controller timing separates queued, active, and human-held intervals", () => {
  const timing = summarizeControllerTiming("2026-01-01T00:00:00.000Z", [
    { runId: "run", sequence: 1, event: "START_INVESTIGATION", from: "queued", to: "investigating", occurredAt: "2026-01-01T00:00:01.000Z" },
    { runId: "run", sequence: 2, event: "BLOCK", from: "investigating", to: "blocked", occurredAt: "2026-01-01T00:00:03.000Z" },
  ], Date.parse("2026-01-01T00:00:08.000Z"));
  assert.equal(timing.queuedMs, 1_000);
  assert.equal(timing.activeMs, 2_000);
  assert.equal(timing.humanHeldMs, 5_000);
  assert.deepEqual(timing.phases.map((phase) => phase.status), ["queued", "active", "human-held"]);
});

test("telemetry runtime records successful agent usage exactly once", async () => {
  const receipts: AgentRunReceipt[] = [];
  const runtime = new TelemetryAgentRuntime(new FakeAgentRuntime([{ ok: true }]), (receipt) => { receipts.push(receipt); });
  const result = await runtime.run<{ ok: boolean }>(task("run-success:investigation:1"));
  assert.equal(result.output.ok, true);
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0]?.runId, "run-success");
  assert.equal(receipts[0]?.usage.source, "unavailable");
  assert.equal(receipts[0]?.error, undefined);
});

test("telemetry runtime records bounded failure timing without changing the thrown error", async () => {
  const receipts: AgentRunReceipt[] = [];
  const failure = new Error("provider unavailable");
  const runtime = new TelemetryAgentRuntime(new FakeAgentRuntime([failure]), (receipt) => { receipts.push(receipt); });
  await assert.rejects(runtime.run(task("run-failure:investigation:1")), failure);
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0]?.runId, "run-failure");
  assert.equal(receipts[0]?.usage.source, "unavailable");
  assert.deepEqual(receipts[0]?.error, { name: "Error", message: "provider unavailable" });
  assert.ok((receipts[0]?.timing.activeMs ?? -1) >= 0);
});

test("telemetry failure receipts retain a runtime-provided session identity", async () => {
  const receipts: AgentRunReceipt[] = [];
  const failure = new AgentRunError("provider unavailable", { sessionRef: "pi-real-session" });
  const runtime = new TelemetryAgentRuntime(new FakeAgentRuntime([failure]), (receipt) => { receipts.push(receipt); });
  await assert.rejects(runtime.run(task("run-session-failure:investigation:1")), failure);
  assert.equal(receipts[0]?.sessionRef, "pi-real-session");
  assert.deepEqual(receipts[0]?.sessionLineage, ["pi-real-session"]);
});

test("reviewer scope receipts are whole-checkout read-only and tamper evident", () => {
  const receipt = createScopeManifestReceipt(scopeManifestForReviewer());
  assert.equal(receipt.scopeVersion, 1);
  assert.deepEqual(receipt.scope, { readRoots: ["."], writeRoots: [], source: "issue-hints" });
  assert.deepEqual(validateScopeManifestReceipt(receipt), receipt);
  assert.throws(() => validateScopeManifestReceipt({ ...receipt, scopeDigest: "0".repeat(64) }), /does not match/);
});
