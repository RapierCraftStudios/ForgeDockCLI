import assert from "node:assert/strict";
import { test } from "node:test";
import { Type } from "typebox";
import { FakeAgentRuntime } from "./fake-runtime.js";
import { AgentBudgetExceededError, AgentRunError, BudgetedAgentRuntime, TelemetryAgentRuntime, configuredRuntimeBudgetLimits, createScopeManifestReceipt, scopeManifestFor, scopeManifestForBuildPacket, scopeManifestForReviewer, validateScopeManifestReceipt } from "./agent-runtime.js";
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
  assert.equal(timing.unknownMs, 0);
  assert.deepEqual(timing.phases.map((phase) => phase.status), ["queued", "active", "human-held"]);
});

test("controller timing does not call an open phase active without a semantic transition", () => {
  const timing = summarizeControllerTiming("2026-01-01T00:00:00.000Z", [
    { runId: "run", sequence: 1, event: "START_INVESTIGATION", from: "queued", to: "investigating", occurredAt: "2026-01-01T00:00:01.000Z" },
  ], Date.parse("2026-01-01T00:00:08.000Z"));
  assert.equal(timing.activeMs, 0);
  assert.equal(timing.unknownMs, 7_000);
  assert.equal(timing.phases.at(-1)?.status, "unknown");
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

test("scope receipts reject protected write paths", () => {
  assert.throws(() => createScopeManifestReceipt({
    readRoots: ["."],
    writeRoots: [],
    writePaths: [".PI-SUBAGENTS/state.json"],
    source: "remediation",
  }), /Protected builder write paths are not allowed/);
});

test("runtime budgets are opt-in and parse only explicit positive limits", () => {
  assert.deepEqual(configuredRuntimeBudgetLimits({}), {});
  assert.deepEqual(configuredRuntimeBudgetLimits({
    FORGEDOCK_AGENT_MAX_TOTAL_TOKENS: "750000",
    FORGEDOCK_AGENT_MAX_COST_USD: "75.5",
    FORGEDOCK_AGENT_MAX_TOKENS_PER_RUN: "250000",
  }), { maxTotalTokens: 750000, maxCostUsd: 75.5, maxTokensPerRun: 250000 });
  assert.throws(() => configuredRuntimeBudgetLimits({ FORGEDOCK_AGENT_MAX_TOKENS_PER_RUN: "0" }), /positive finite/);
});

test("budget runtime aggregates fulfilled receipts and blocks aggregate overflow", async () => {
  const inner: import("./agent-runtime.js").AgentRuntime = {
    capabilities: async () => ({ runtime: "test", resumableSessions: false, tools: ["read"] }),
    run: async <T>() => ({
      output: { ok: true } as T, sessionRef: "typed", provider: "fake", model: "fake",
      receipt: {
        key: "typed", runId: "run", taskId: "run:task", phase: "task", role: "investigator", sessionRef: "typed", sessionLineage: ["typed"], provider: "fake", model: "fake",
        timing: { queuedAt: "", startedAt: "", completedAt: "", activeMs: 0, queueMs: 0, retryCount: 0 },
        usage: { source: "provider", inputTokens: 3, outputTokens: 4, totalTokens: 7, estimatedCostUsd: 1 },
        execution: { turns: 2, toolCalls: 3 },
      },
    }),
    close: async () => {},
  };
  const bounded = new BudgetedAgentRuntime(inner, { maxTotalTokens: 10, maxCostUsd: 10, maxTokensPerRun: 8 });
  await bounded.run(task("run:task"));
  assert.equal(bounded.usage().totalTokens, 7);
  assert.equal(bounded.usage().executionTurns, 2);
  await assert.rejects(bounded.run(task("run:task-2")), AgentBudgetExceededError);
});

test("budget runtime charges failed execution on run and resume before rethrowing", async () => {
  const failure = new AgentRunError("retryable", {
    sessionRef: "failed-session", resumable: true,
    execution: { turns: 4, toolCalls: 6, inputTokens: 2, outputTokens: 3, totalTokens: 5, estimatedCostUsd: 0.5 },
  });
  const inner: import("./agent-runtime.js").AgentRuntime = {
    capabilities: async () => ({ runtime: "test", resumableSessions: true, tools: ["read"] }),
    run: async () => { throw failure; },
    resume: async () => { throw failure; },
    close: async () => {},
  };
  const bounded = new BudgetedAgentRuntime(inner, { maxTotalTokens: 20, maxCostUsd: 10, maxTokensPerRun: 20 });
  await assert.rejects(bounded.run(task("run:failed")), (error: unknown) => error === failure);
  await assert.rejects(bounded.resume("failed-session", task("run:resume")), (error: unknown) => error === failure);
  assert.deepEqual(bounded.usage(), { inputTokens: 4, outputTokens: 6, totalTokens: 10, estimatedCostUsd: 1, executionTurns: 8, executionToolCalls: 12, observedRuns: 2, unknownUsageRuns: 0 });
});
