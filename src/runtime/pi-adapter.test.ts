// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { Type } from "typebox";
import { ArtifactSubmissionGateError, assertPiRuntimeTargetsReady, boundedToolErrorSummary, createVerificationRuntimeState, createVerificationTool, DEFAULT_VERIFY_TOOL_HEARTBEAT_MS, MAX_NESTED_AGENT_RESPONSE_BYTES, NestedReviewerTransportError, PiAgentRuntime, postNestedAgentRequest, reserveToolCallBudget, resolvePiModelPolicy, submissionDiagnosticFor, submissionRejectionKeyFor, terminalErrorSummary, verificationHeartbeatIntervalMs, verificationInvocationTimeoutMs } from "./pi-adapter.js";
import { createScopeManifestReceipt, scopeManifestFor, scopeManifestForReviewer, type AgentEvent } from "./agent-runtime.js";

const REVIEWER_SCOPE = createScopeManifestReceipt(scopeManifestForReviewer());

test("Pi runtime readiness checks provider authentication before dispatch", async () => {
  const authChecks: string[] = [];
  await assert.rejects(
    assertPiRuntimeTargetsReady({
      getModel: () => ({}) as any,
      checkAuth: async (provider) => { authChecks.push(provider); return undefined; },
    }, [{ provider: "provider-a", model: "model-a" }, { provider: "provider-a", model: "model-b" }]),
    /could not resolve authentication for provider provider-a/,
  );
  assert.deepEqual(authChecks, ["provider-a"]);
});

test("Pi runtime readiness validates each unique provider and selected model", async () => {
  const authChecks: string[] = [];
  const models = new Set(["provider-a/model-a", "provider-b/model-b"]);
  await assertPiRuntimeTargetsReady({
    getModel: (provider, model) => models.has(`${provider}/${model}`) ? ({}) as any : undefined,
    checkAuth: async (provider) => { authChecks.push(provider); return { type: "api_key", source: "test" }; },
  }, [{ provider: "provider-a", model: "model-a" }, { provider: "provider-a", model: "model-a" }, { provider: "provider-b", model: "model-b" }]);
  assert.deepEqual(authChecks, ["provider-a", "provider-b"]);
});

async function listen(handler: (request: IncomingMessage, response: ServerResponse) => void) {
  const server = createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address() as AddressInfo;
  return {
    server,
    url: `http://127.0.0.1:${address.port}/v1/run`,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

function taskForRole(role: "investigator" | "packet-author" | "builder" | "reviewer", modelPolicy: Record<string, string> = {}) {
  return {
    id: `run:${role}`,
    role,
    objective: "Test model resolution",
    instructions: "Read only",
    context: [],
    workspace: { cwd: process.cwd(), mode: "read-only" as const, scope: scopeManifestFor("issue-hints", { metadataRoots: ["."] }) },
    tools: ["read" as const],
    outputSchema: Type.Object({ summary: Type.String() }),
    modelPolicy,
  } as any;
}

test("planning model resolution is role-specific and invocation policy wins", () => {
  const environment = {
    FORGEDOCK_PLANNING_MODEL: "env/planner",
    FORGEDOCK_PLANNING_THINKING: "high",
    FORGEDOCK_REVIEWER_MODEL: "env/reviewer",
    PI_PROVIDER: "env/default-provider",
    PI_MODEL: "env/default-model",
  };
  assert.deepEqual(resolvePiModelPolicy(taskForRole("investigator", {
    provider: "generic-provider", model: "generic-model", planningProvider: "flag", planningModel: "planner", planningThinking: "low",
  }), { planningProvider: "option", planningModel: "planner", planningThinking: "max" }, environment), { provider: "flag", model: "planner", thinking: "low" });
  assert.deepEqual(resolvePiModelPolicy(taskForRole("packet-author"), {}, environment), { provider: "env", model: "planner", thinking: "high" });
  assert.deepEqual(resolvePiModelPolicy(taskForRole("builder", { provider: "worker", model: "builder" }), {}, environment), { provider: "worker", model: "builder", thinking: undefined });
  assert.deepEqual(resolvePiModelPolicy(taskForRole("reviewer", { provider: "task", model: "task" }), {}, environment), { provider: "env", model: "reviewer", thinking: undefined });
});

test("frozen role contracts outrank ambient settings without mixing provider/model sources", () => {
  const environment = {
    FORGEDOCK_WORKER_PROVIDER: "ambient-worker-provider",
    FORGEDOCK_WORKER_MODEL: "ambient-worker-model",
    FORGEDOCK_REVIEWER_PROVIDER: "ambient-reviewer-provider",
    FORGEDOCK_REVIEWER_MODEL: "ambient-reviewer-model",
    FORGEDOCK_PLANNING_PROVIDER: "ambient-planner-provider",
    FORGEDOCK_PLANNING_MODEL: "ambient-planner-model",
    PI_PROVIDER: "ambient-pi-provider",
    PI_MODEL: "ambient-pi-model",
  };
  assert.deepEqual(resolvePiModelPolicy(taskForRole("builder", { provider: "frozen-worker-provider", model: "frozen-worker-model" }), {
    provider: "runtime-worker-provider",
    model: "runtime-worker-model",
  }, environment), { provider: "frozen-worker-provider", model: "frozen-worker-model", thinking: undefined });
  assert.deepEqual(resolvePiModelPolicy(taskForRole("investigator"), {
    planningProvider: "frozen-planner-provider",
    planningModel: "frozen-planner-model",
    planningThinking: "low",
  }, environment), { provider: "frozen-planner-provider", model: "frozen-planner-model", thinking: "low" });
  assert.deepEqual(resolvePiModelPolicy(taskForRole("reviewer", { provider: "task-worker-provider", model: "task-worker-model" }), {
    provider: "runtime-worker-provider",
    model: "runtime-worker-model",
    reviewerProvider: "frozen-reviewer-provider",
    reviewerModel: "frozen-reviewer-model",
    reviewerThinking: "high",
  }, environment), { provider: "frozen-reviewer-provider", model: "frozen-reviewer-model", thinking: "high" });
  assert.deepEqual(resolvePiModelPolicy(taskForRole("builder", { provider: "frozen-provider" }), {}, {
    PI_PROVIDER: "ambient-provider",
    PI_MODEL: "ambient-model",
  }), { provider: "frozen-provider", model: undefined, thinking: undefined });
});

test("reviewer execution sends the frozen reviewer contract to the nested bridge", async () => {
  let request: Record<string, unknown> | undefined;
  const endpoint = await listen((incoming, response) => {
    const chunks: Buffer[] = [];
    incoming.on("data", (chunk: Buffer | string) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    incoming.once("end", () => {
      request = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        output: { summary: "review complete" },
        sessionRef: "frozen-reviewer-session",
        scopeVersion: request.scopeVersion,
        scopeDigest: request.scopeDigest,
      }));
    });
  });
  const previousUrl = process.env.FORGEDOCK_NESTED_AGENT_URL;
  const previousToken = process.env.FORGEDOCK_NESTED_AGENT_TOKEN;
  const previousReviewerModel = process.env.FORGEDOCK_REVIEWER_MODEL;
  process.env.FORGEDOCK_NESTED_AGENT_URL = endpoint.url;
  process.env.FORGEDOCK_NESTED_AGENT_TOKEN = "test-token";
  process.env.FORGEDOCK_REVIEWER_MODEL = "ambient-reviewer/ambient-model";
  const runtime = new PiAgentRuntime({
    provider: "worker-provider",
    model: "worker-model",
    reviewerProvider: "frozen-reviewer-provider",
    reviewerModel: "frozen-reviewer-model",
    reviewerThinking: "low",
  });
  try {
    await runtime.run(taskForRole("reviewer", { provider: "task-worker-provider", model: "task-worker-model" }));
    assert.equal(request?.provider, "frozen-reviewer-provider");
    assert.equal(request?.model, "frozen-reviewer-model");
    assert.equal(request?.thinking, "low");
  } finally {
    await runtime.close();
    restoreNestedEnvironment(previousUrl, previousToken);
    if (previousReviewerModel === undefined) delete process.env.FORGEDOCK_REVIEWER_MODEL;
    else process.env.FORGEDOCK_REVIEWER_MODEL = previousReviewerModel;
    await endpoint.close();
  }
});

test("tool-call budget reserves parallel beforeToolCall slots without overshoot", () => {
  const state = { toolCalls: 0 };
  for (let index = 0; index < 20; index += 1) {
    assert.equal(reserveToolCallBudget(state, 20), undefined);
  }
  assert.equal(state.toolCalls, 20);
  assert.deepEqual(reserveToolCallBudget(state, 20), { limit: "maxToolCalls", value: 20, maximum: 20 });
  assert.equal(state.toolCalls, 20);
});

test("verification heartbeat stays inside the command bound and generic idle window", () => {
  assert.equal(verificationHeartbeatIntervalMs(300_000), DEFAULT_VERIFY_TOOL_HEARTBEAT_MS);
  assert.equal(verificationHeartbeatIntervalMs(20_000), 10_000);
  assert.equal(verificationHeartbeatIntervalMs(300_000, 10_000), 5_000);
  assert.equal(verificationHeartbeatIntervalMs(1), 1);
  assert.equal(verificationHeartbeatIntervalMs(0), undefined);
  assert.equal(verificationHeartbeatIntervalMs(Number.POSITIVE_INFINITY), undefined);
  assert.equal(verificationInvocationTimeoutMs([{ timeoutMs: 400 }, { timeoutMs: 500 }]), 900);
  assert.equal(verificationInvocationTimeoutMs([{ timeoutMs: Number.MAX_SAFE_INTEGER }, { timeoutMs: Number.MAX_SAFE_INTEGER }]), 2_147_483_647);
});

test("production verify tool emits progress while its runner is pending and stops after settlement", async () => {
  let completeVerification!: (results: Array<{ command: string; commandId: string; status: "passed"; exitCode: number; durationMs: number }>) => void;
  const pendingVerification = new Promise<Array<{ command: string; commandId: string; status: "passed"; exitCode: number; durationMs: number }>>((resolve) => {
    completeVerification = resolve;
  });
  const events: AgentEvent[] = [];
  let observeProgress!: () => void;
  const progressObserved = new Promise<void>((resolve) => { observeProgress = resolve; });
  const task = {
    id: "run:builder:verify-heartbeat",
    role: "builder" as const,
    objective: "Verify the production heartbeat wiring",
    instructions: "Run the approved check",
    context: [],
    workspace: { cwd: process.cwd(), mode: "write" as const, scope: scopeManifestFor("build-packet", { affectedFiles: ["src/runtime/pi-adapter.ts"] }) },
    tools: ["verify" as const],
    verification: {
      commands: [{ id: "test", command: "npm", args: ["test"], cwd: process.cwd(), timeoutMs: 500, required: true }],
      runner: { run: async () => pendingVerification },
    },
    outputSchema: Type.Object({ summary: Type.String() }),
    modelPolicy: {},
  };
  const tool = createVerificationTool(task, (event) => {
    events.push(event);
    if (event.type === "tool.progress") observeProgress();
  }, 20);
  assert.ok(tool);

  const execution = tool.execute("verify-call", { commandId: "test" }, undefined, undefined, {} as any);
  await Promise.race([
    progressObserved,
    new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("verify progress heartbeat was not emitted")), 250)),
  ]);
  const progress = events.find((event) => event.type === "tool.progress");
  assert.deepEqual(progress && {
    type: progress.type,
    taskId: progress.taskId,
    toolCallId: progress.toolCallId,
    tool: progress.tool,
    timeoutMs: progress.timeoutMs,
  }, {
    type: "tool.progress",
    taskId: task.id,
    toolCallId: "verify-call",
    tool: "verify",
    timeoutMs: 500,
  });

  completeVerification([{ command: "npm test", commandId: "test", status: "passed", exitCode: 0, durationMs: 15 }]);
  await execution;
  const progressAtSettlement = events.filter((event) => event.type === "tool.progress").length;
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(events.filter((event) => event.type === "tool.progress").length, progressAtSettlement);
});

test("verification receipts require exact frozen metadata and latest mutation generation", async () => {
  const command = { id: "test", command: "npm", args: ["test"], cwd: process.cwd(), timeoutMs: 500, required: true, policyVersion: "policy-1", targets: ["src/a.test.ts"], planId: "plan-1", coveredBy: ["suite"] } as const;
  const state = createVerificationRuntimeState();
  let result: any = { command: "npm test", commandId: "test", policyVersion: "policy-1", commandTargets: ["src/a.test.ts"], planId: "plan-1", coveredBy: ["suite"], status: "passed", durationMs: 1 };
  const task = {
    id: "run:builder:verify-receipt",
    role: "builder" as const,
    objective: "verify",
    instructions: "verify",
    context: [],
    workspace: { cwd: process.cwd(), mode: "write" as const, scope: scopeManifestFor("build-packet", { affectedFiles: ["src/a.test.ts"] }) },
    tools: ["verify" as const],
    verification: { commands: [command], runner: { run: async () => [result] } },
    outputSchema: Type.Object({ summary: Type.String() }),
    modelPolicy: {},
  } as any;
  const tool = createVerificationTool(task, () => undefined, 20, randomUUID(), state)!;
  await tool.execute("verify-1", { commandId: "test" }, undefined, undefined, {} as never);
  assert.equal(state.verificationRevision, 1);
  assert.deepEqual(state.receipts.get("test"), { commandId: "test", generation: 0 });
  state.mutationGeneration += 1;
  assert.deepEqual(state.receipts.get("test"), { commandId: "test", generation: 0 });
  await tool.execute("verify-2", { commandId: "test" }, undefined, undefined, {} as never);
  assert.deepEqual(state.receipts.get("test"), { commandId: "test", generation: 1 });
  result = { ...result, commandTargets: ["src/other.test.ts"] };
  await assert.rejects(() => tool.execute("verify-3", { commandId: "test" }, undefined, undefined, {} as never), /metadata|stale/i);
  assert.equal(state.receipts.size, 0);
  result = { ...result, commandTargets: ["src/a.test.ts"], status: "failed" };
  await tool.execute("verify-4", { commandId: "test" }, undefined, undefined, {} as never);
  assert.equal(state.receipts.size, 0);
});

test("submission diagnostics enumerate failed, missing, passing, and stale frozen checks", () => {
  const state = createVerificationRuntimeState();
  state.statuses.set("failed", { status: "failed", generation: 1 });
  state.statuses.set("passing", { status: "passed", generation: 0 });
  state.receipts.set("passing", { commandId: "passing", generation: 0 });
  state.statuses.set("stale", { status: "passed", generation: 0 });
  state.receipts.set("stale", { commandId: "stale", generation: 0 });
  state.mutationGeneration = 1;
  const diagnostic = submissionDiagnosticFor({ verificationGate: { requiredCommandIds: ["failed", "missing", "passing", "stale"] } } as any, state);
  assert.deepEqual(diagnostic.statuses.map((item) => [item.commandId, item.status]), [
    ["failed", "failed"], ["missing", "missing"], ["passing", "stale"], ["stale", "stale"],
  ]);
  assert.match(diagnostic.nextAction, /failed, missing, passing, stale/);
  assert.equal(diagnostic.statuses.find((item) => item.commandId === "stale")?.receiptGeneration, 0);
});

test("a current passing receipt is the only submission-gate success", () => {
  const state = createVerificationRuntimeState();
  state.statuses.set("check", { status: "passed", generation: 2 });
  state.receipts.set("check", { commandId: "check", generation: 2 });
  state.mutationGeneration = 2;
  const diagnostic = submissionDiagnosticFor({ verificationGate: { requiredCommandIds: ["check"] } } as any, state);
  assert.deepEqual(diagnostic.statuses[0], { commandId: "check", status: "passing", mutationGeneration: 2, receiptGeneration: 2 });
});


test("submission terminal wording records attempted rejection and typed repeated-gate reason", () => {
  const diagnostic = { requiredCommandIds: ["check"], statuses: [{ commandId: "check", status: "missing" as const, mutationGeneration: 0 }], nextAction: "Run check", verificationRevision: 0 };
  const error = new ArtifactSubmissionGateError(diagnostic, 2);
  assert.equal(error.name, "ArtifactSubmissionGateError");
  assert.match(error.message, /same artifact and verification state twice/);
  assert.doesNotMatch(terminalErrorSummary(new Error("Agent execution maxTurns budget exhausted"), false, 1), /before artifact submission/);
  assert.match(terminalErrorSummary(new Error("Agent execution maxTurns budget exhausted"), false, 0), /without attempting artifact submission/);
});


test("submission corrective window ignores payload churn but resets after fresh verification", () => {
  const state = createVerificationRuntimeState();
  const diagnostic = submissionDiagnosticFor({ verificationGate: { requiredCommandIds: ["check"] } } as any, state);
  const firstKey = submissionRejectionKeyFor(state, diagnostic);
  const changedPayloadKey = submissionRejectionKeyFor(state, { ...diagnostic });
  assert.equal(changedPayloadKey, firstKey, "artifact payload is deliberately absent from the rejection key");
  const reject = (payload: unknown) => {
    const key = submissionRejectionKeyFor(state, diagnostic);
    if (key === firstKey && payload !== undefined && attempts++ > 0) throw new ArtifactSubmissionGateError(diagnostic, attempts);
    return key;
  };
  let attempts = 0;
  assert.equal(reject({ summary: "first" }), firstKey);
  assert.throws(() => reject({ summary: "corrected" }), ArtifactSubmissionGateError);
  assert.throws(() => reject({ summary: "third" }), ArtifactSubmissionGateError);
  assert.notEqual(submissionRejectionKeyFor({ ...state, verificationRevision: state.verificationRevision + 1 }, diagnostic), firstKey);
});


test("verification replays frozen prerequisites in one staging invocation", async () => {
  const commands = [
    { id: "build", command: "node", args: ["build.js"], cwd: process.cwd(), timeoutMs: 500, required: true, policyVersion: "p", planId: "plan" },
    { id: "test", command: "node", args: ["test.js"], cwd: process.cwd(), timeoutMs: 500, required: true, policyVersion: "p", planId: "plan", targets: ["src/a.test.ts"] },
  ] as const;
  const calls: string[][] = [];
  const resultFor = (command: typeof commands[number]) => ({
    commandId: command.id,
    command: [command.command, ...command.args].join(" "),
    policyVersion: command.policyVersion,
    planId: command.planId,
    commandTargets: "targets" in command ? command.targets : [],
    status: "passed" as const,
    durationMs: 1,
  });
  const task = {
    id: "run:builder:verify-prefix",
    role: "builder" as const,
    objective: "verify",
    instructions: "verify",
    context: [],
    workspace: { cwd: process.cwd(), mode: "write" as const, scope: scopeManifestFor("build-packet", { affectedFiles: ["src/a.test.ts"] }) },
    tools: ["verify" as const],
    verification: {
      commands,
      runner: { run: async (invocation: readonly typeof commands[number][]) => {
        calls.push(invocation.map((command) => command.id));
        return invocation.map(resultFor);
      } },
    },
    outputSchema: Type.Object({ summary: Type.String() }),
    modelPolicy: {},
  } as any;
  const state = createVerificationRuntimeState();
  const tool = createVerificationTool(task, () => undefined, 20, randomUUID(), state)!;
  await tool.execute("verify-build", { commandId: "build" }, undefined, undefined, {} as never);
  await tool.execute("verify-test", { commandId: "test" }, undefined, undefined, {} as never);
  assert.deepEqual(calls, [["build"], ["build", "test"]]);
  assert.deepEqual([...state.receipts.keys()], ["build", "test"]);
});

test("nested reviewer transport does not depend on fetch or an implicit wall-clock timeout", async () => {
  const endpoint = await listen((_request, response) => {
    setTimeout(() => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ output: { summary: "complete" } }));
    }, 50);
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (() => { throw new Error("fetch must not be used"); }) as typeof fetch;
  try {
    const result = await postNestedAgentRequest<{ output: { summary: string } }>({
      url: endpoint.url,
      token: "test-token",
      body: { task: "long review" },
    });
    assert.equal(result.status, 200);
    assert.deepEqual(result.payload.output, { summary: "complete" });
  } finally {
    globalThis.fetch = originalFetch;
    await endpoint.close();
  }
});

test("nested reviewer transport exposes the persisted child identity before terminal completion", async () => {
  const endpoint = await listen((_request, response) => {
    response.writeHead(200, {
      "content-type": "application/json",
      "x-forgedock-nested-session-ref": "persisted-child-run",
    });
    response.flushHeaders();
    setTimeout(() => response.end(JSON.stringify({ output: { summary: "complete" } })), 20);
  });
  const observed: string[] = [];
  try {
    const result = await postNestedAgentRequest<{ output: { summary: string } }>({
      url: endpoint.url,
      token: "test-token",
      body: { task: "identity-bound review" },
      onSessionRef: (sessionRef) => observed.push(sessionRef),
    });
    assert.deepEqual(observed, ["persisted-child-run"]);
    assert.deepEqual(result.payload.output, { summary: "complete" });
  } finally {
    await endpoint.close();
  }
});

test("nested reviewer streamed progress reaches the controller event sink", async () => {
  const endpoint = await listen((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer | string) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    request.once("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
      response.writeHead(200, {
        "content-type": "application/json",
        "x-forgedock-nested-session-ref": "nested-progress-session",
      });
      response.flushHeaders();
      response.write(" ");
      setTimeout(() => response.end(JSON.stringify({
        output: { summary: "complete" },
        sessionRef: "nested-progress-session",
        provider: body.provider,
        model: body.model,
        scopeVersion: body.scopeVersion,
        scopeDigest: body.scopeDigest,
      })), 10);
    });
  });
  const previousUrl = process.env.FORGEDOCK_NESTED_AGENT_URL;
  const previousToken = process.env.FORGEDOCK_NESTED_AGENT_TOKEN;
  process.env.FORGEDOCK_NESTED_AGENT_URL = endpoint.url;
  process.env.FORGEDOCK_NESTED_AGENT_TOKEN = "test-token";
  const runtime = new PiAgentRuntime({ provider: "test-provider", model: "test-model" });
  const events: AgentEvent[] = [];
  try {
    await runtime.run(taskForRole("reviewer") as any, { onEvent: (event) => events.push(event) });
    assert.ok(events.some((event) => event.type === "session.progress" && event.sessionRef === "nested-progress-session"));
  } finally {
    await runtime.close();
    restoreNestedEnvironment(previousUrl, previousToken);
    await endpoint.close();
  }
});

test("nested reviewer transport rejects non-loopback bridge destinations", async () => {
  await assert.rejects(
    postNestedAgentRequest({ url: "http://attacker.example/v1/run", token: "test-token", body: {} }),
    /127\.0\.0\.1 \/v1\/run/,
  );
});

test("a stale nested reviewer bridge fails closed without exposing its bearer token", async () => {
  const previousUrl = process.env.FORGEDOCK_NESTED_AGENT_URL;
  const previousToken = process.env.FORGEDOCK_NESTED_AGENT_TOKEN;
  const token = "stale-bridge-token-must-not-appear";
  process.env.FORGEDOCK_NESTED_AGENT_URL = "http://127.0.0.1:1/v1/run";
  process.env.FORGEDOCK_NESTED_AGENT_TOKEN = token;
  const runtime = new PiAgentRuntime({ provider: "test-provider", model: "test-model" });
  try {
    await assert.rejects(runtime.run(taskForRole("reviewer") as any), (error: any) => {
      assert.equal(error.name, "NestedReviewerTransportError");
      assert.ok(error instanceof NestedReviewerTransportError);
      assert.match(error.message, /Nested reviewer transport failed/);
      assert.doesNotMatch(error.message, /stale-bridge-token|authorization|Bearer/i);
      return true;
    });
  } finally {
    await runtime.close();
    restoreNestedEnvironment(previousUrl, previousToken);
  }
});

test("nested reviewer transport bounds response buffering", async () => {
  const endpoint = await listen((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end("x".repeat(MAX_NESTED_AGENT_RESPONSE_BYTES + 1));
  });
  try {
    await assert.rejects(
      postNestedAgentRequest({ url: endpoint.url, token: "test-token", body: {} }),
      /response exceeded/,
    );
  } finally {
    await endpoint.close();
  }
});

test("the controller rejects a malformed nested structured result even after bridge success", async () => {
  const endpoint = await listen((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ output: { wrong: true }, sessionRef: "nested-malformed", scopeVersion: REVIEWER_SCOPE.scopeVersion, scopeDigest: REVIEWER_SCOPE.scopeDigest }));
  });
  const previousUrl = process.env.FORGEDOCK_NESTED_AGENT_URL;
  const previousToken = process.env.FORGEDOCK_NESTED_AGENT_TOKEN;
  process.env.FORGEDOCK_NESTED_AGENT_URL = endpoint.url;
  process.env.FORGEDOCK_NESTED_AGENT_TOKEN = "test-token";
  const runtime = new PiAgentRuntime({ provider: "test-provider", model: "test-model" });
  try {
    await assert.rejects(runtime.run({
      id: "run:review:sha:correctness", role: "reviewer", objective: "Review", instructions: "Read only", context: [],
      workspace: { cwd: process.cwd(), mode: "read-only", scope: scopeManifestFor("issue-hints", { metadataRoots: ["."] }) }, tools: ["read"],
      outputSchema: Type.Object({ summary: Type.String() }), modelPolicy: {},
    }), /invalid structured result/i);
  } finally {
    if (previousUrl === undefined) delete process.env.FORGEDOCK_NESTED_AGENT_URL;
    else process.env.FORGEDOCK_NESTED_AGENT_URL = previousUrl;
    if (previousToken === undefined) delete process.env.FORGEDOCK_NESTED_AGENT_TOKEN;
    else process.env.FORGEDOCK_NESTED_AGENT_TOKEN = previousToken;
    await endpoint.close();
  }
});

test("fresh nested reviewer attempts use unique wire nodes but retain the logical task identity", async () => {
  const requests: Array<Record<string, any>> = [];
  const endpoint = await listen((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer | string) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    request.on("end", () => {
      requests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, any>);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        output: { summary: "complete" }, sessionRef: `nested-${requests.length}`,
        scopeVersion: requests.at(-1)?.scopeVersion, scopeDigest: requests.at(-1)?.scopeDigest,
      }));
    });
  });
  const previousUrl = process.env.FORGEDOCK_NESTED_AGENT_URL;
  const previousToken = process.env.FORGEDOCK_NESTED_AGENT_TOKEN;
  process.env.FORGEDOCK_NESTED_AGENT_URL = endpoint.url;
  process.env.FORGEDOCK_NESTED_AGENT_TOKEN = "test-token";
  const runtime = new PiAgentRuntime({ provider: "test-provider", model: "test-model" });
  const task = taskForRole("reviewer", {}) as any;
  task.id = "run-review:review:sha:correctness";
  task.executionBudget = { maxToolCalls: 64 };
  try {
    await runtime.run(task);
    await runtime.run(task);
    assert.equal(requests.length, 2);
    assert.notEqual(requests[0]?.id, requests[1]?.id);
    assert.deepEqual(requests.map((request) => request.logicalTaskId), [task.id, task.id]);
    assert.deepEqual(requests.map((request) => request.scopeVersion), [1, 1]);
    assert.deepEqual(requests.map((request) => request.scope), [REVIEWER_SCOPE.scope, REVIEWER_SCOPE.scope]);
    assert.deepEqual(requests.map((request) => request.scopeDigest), [REVIEWER_SCOPE.scopeDigest, REVIEWER_SCOPE.scopeDigest]);
    assert.deepEqual(requests.map((request) => request.toolBudget), [64, 64]);
    assert.deepEqual(requests.map((request) => request.turnBudget), [undefined, undefined]);
  } finally {
    if (previousUrl === undefined) delete process.env.FORGEDOCK_NESTED_AGENT_URL;
    else process.env.FORGEDOCK_NESTED_AGENT_URL = previousUrl;
    if (previousToken === undefined) delete process.env.FORGEDOCK_NESTED_AGENT_TOKEN;
    else process.env.FORGEDOCK_NESTED_AGENT_TOKEN = previousToken;
    await endpoint.close();
  }
});

test("verification agency requires a frozen controller-approved plan", async () => {
  const runtime = new PiAgentRuntime({ provider: "test-provider", model: "test-model" });
  await assert.rejects(runtime.run({
    id: "run:build:verify-policy", role: "builder", objective: "Build", instructions: "Use the approved checks", context: [],
    workspace: { cwd: process.cwd(), mode: "write", scope: scopeManifestFor("build-packet", { writePaths: ["src/a.ts"], metadataRoots: ["package.json"] }) },
    tools: ["read", "verify", "edit"],
    outputSchema: Type.Object({ summary: Type.String() }), modelPolicy: {},
  }), /no frozen controller-approved command plan/i);
});

test("tool error summaries expose only allowlisted classifications", () => {
  const arbitrary = boundedToolErrorSummary({
    content: [{
      type: "text",
      text: `Edit failed\n token=github_pat_${"a".repeat(80)} C:\\Users\\secret\\key.pem -----BEGIN PRIVATE KEY-----`,
    }],
  });
  assert.equal(arbitrary, "Tool execution failed; inspect the scoped arguments and retry");
  assert.doesNotMatch(arbitrary, /github_pat_|Users|PRIVATE KEY|\n/);
  assert.equal(
    boundedToolErrorSummary({ content: [{ type: "text", text: "oldText occurs 3 times and is not unique" }] }),
    "Edit target text was not unique",
  );
  assert.equal(
    boundedToolErrorSummary({ content: [{ type: "text", text: "Tool write path is outside the assigned scope: C:\\secret" }] }),
    "Path is outside the assigned workspace scope",
  );
  assert.equal(boundedToolErrorSummary({ content: [{ type: "image", data: "secret" }] }), undefined);
});

test("nested reviewer transport still honors explicit cancellation", async () => {
  const endpoint = await listen(() => undefined);
  const controller = new AbortController();
  try {
    const pending = postNestedAgentRequest({
      url: endpoint.url,
      token: "test-token",
      body: { task: "cancelled review" },
      signal: controller.signal,
    });
    controller.abort();
    await assert.rejects(pending, /Nested reviewer transport failed:.*abort/i);
  } finally {
    await endpoint.close();
  }
});

test("pre-aborted nested run and resume reject before bridge dispatch or session start", async () => {
  let requests = 0;
  const endpoint = await listen((_request, response) => {
    requests += 1;
    response.writeHead(500, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "must not dispatch" }));
  });
  const previousUrl = process.env.FORGEDOCK_NESTED_AGENT_URL;
  const previousToken = process.env.FORGEDOCK_NESTED_AGENT_TOKEN;
  process.env.FORGEDOCK_NESTED_AGENT_URL = endpoint.url;
  process.env.FORGEDOCK_NESTED_AGENT_TOKEN = "test-token";
  const runtime = new PiAgentRuntime({ provider: "test-provider", model: "test-model" });
  const controller = new AbortController();
  controller.abort(new Error("cancel before allocation"));
  const events: AgentEvent[] = [];
  try {
    await assert.rejects(runtime.run(taskForRole("reviewer") as any, { signal: controller.signal, onEvent: (event) => events.push(event) }), /cancel before allocation/);
    await assert.rejects(runtime.resume!("persisted-review", taskForRole("reviewer") as any, { signal: controller.signal, onEvent: (event) => events.push(event) }), /cancel before allocation/);
    assert.equal(requests, 0);
    assert.deepEqual(events, []);
  } finally {
    await runtime.close();
    restoreNestedEnvironment(previousUrl, previousToken);
    await endpoint.close();
  }
});

test("nested terminal failure carries the persisted child session identity", async () => {
  const endpoint = await listen((request, response) => {
    request.resume();
    request.once("end", () => {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "provider disconnected", sessionRef: "nested-real-session", resumable: true }));
    });
  });
  const previousUrl = process.env.FORGEDOCK_NESTED_AGENT_URL;
  const previousToken = process.env.FORGEDOCK_NESTED_AGENT_TOKEN;
  process.env.FORGEDOCK_NESTED_AGENT_URL = endpoint.url;
  process.env.FORGEDOCK_NESTED_AGENT_TOKEN = "test-token";
  const runtime = new PiAgentRuntime({ provider: "test-provider", model: "test-model" });
  const events: AgentEvent[] = [];
  try {
    await assert.rejects(runtime.run(taskForRole("reviewer") as any, { onEvent: (event) => events.push(event) }), (error: any) => {
      assert.equal(error.sessionRef, "nested-real-session");
      assert.equal(error.resumable, false, "typed reviewers must retry with a fresh V2 schema contract");
      return true;
    });
    const terminal = events.find((event) => event.type === "session.failed");
    assert.equal(terminal?.sessionRef, "nested-real-session");
    assert.equal(terminal && "errorSummary" in terminal ? terminal.errorSummary : undefined, "Agent session failed");
  } finally {
    await runtime.close();
    restoreNestedEnvironment(previousUrl, previousToken);
    await endpoint.close();
  }
});

test("Pi does not advertise generic session resume as typed reviewer recovery", async () => {
  const previousUrl = process.env.FORGEDOCK_NESTED_AGENT_URL;
  const previousToken = process.env.FORGEDOCK_NESTED_AGENT_TOKEN;
  process.env.FORGEDOCK_NESTED_AGENT_URL = "http://127.0.0.1:1/v1/run";
  process.env.FORGEDOCK_NESTED_AGENT_TOKEN = "test-token";
  const runtime = new PiAgentRuntime({ provider: "test-provider", model: "test-model" });
  try {
    assert.equal((await runtime.capabilities()).resumableSessions, false);
    await assert.rejects(
      runtime.resume!("persisted-review", taskForRole("reviewer") as any),
      (error: any) => error.sessionRef === "persisted-review" && error.resumable === false
        && /fresh bounded delegation/.test(error.message),
    );
  } finally {
    await runtime.close();
    restoreNestedEnvironment(previousUrl, previousToken);
  }
});

test("closing the runtime cancels and awaits an active nested reviewer", async () => {
  let requests = 0;
  const endpoint = await listen((request, response) => {
    requests += 1;
    request.resume();
    response.writeHead(200, {
      "content-type": "application/json",
      "x-forgedock-nested-session-ref": "nested-active-child",
    });
    response.flushHeaders();
  });
  const previousUrl = process.env.FORGEDOCK_NESTED_AGENT_URL;
  const previousToken = process.env.FORGEDOCK_NESTED_AGENT_TOKEN;
  process.env.FORGEDOCK_NESTED_AGENT_URL = endpoint.url;
  process.env.FORGEDOCK_NESTED_AGENT_TOKEN = "test-token";
  const runtime = new PiAgentRuntime({ provider: "test-provider", model: "test-model" });
  const events: AgentEvent[] = [];
  try {
    const pending = runtime.run(taskForRole("reviewer") as any, { onEvent: (event) => events.push(event) });
    for (let attempt = 0; attempt < 100
      && !events.some((event) => event.type === "session.started" && event.sessionRef === "nested-active-child"); attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    assert.equal(requests, 1);
    assert.ok(events.some((event) => event.type === "session.started" && event.sessionRef === "nested-active-child"));
    const closing = runtime.close();
    await assert.rejects(pending, /Pi runtime closed|aborted/i);
    await closing;
    const terminals = events.filter((event) => event.type === "session.cancelled");
    assert.equal(terminals.length, 1);
    assert.equal(terminals[0]?.sessionRef, "nested-active-child");
  } finally {
    restoreNestedEnvironment(previousUrl, previousToken);
    await endpoint.close();
  }
});

test("nested success without the exact scope acknowledgement fails closed", async () => {
  const endpoint = await listen((request, response) => {
    request.resume();
    request.once("end", () => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ output: { summary: "complete" }, sessionRef: "nested-unbound" }));
    });
  });
  const previousUrl = process.env.FORGEDOCK_NESTED_AGENT_URL;
  const previousToken = process.env.FORGEDOCK_NESTED_AGENT_TOKEN;
  process.env.FORGEDOCK_NESTED_AGENT_URL = endpoint.url;
  process.env.FORGEDOCK_NESTED_AGENT_TOKEN = "test-token";
  const runtime = new PiAgentRuntime({ provider: "test-provider", model: "test-model" });
  try {
    await assert.rejects(runtime.run(taskForRole("reviewer") as any), /did not acknowledge the exact scope manifest receipt/);
  } finally {
    await runtime.close();
    restoreNestedEnvironment(previousUrl, previousToken);
    await endpoint.close();
  }
});

function restoreNestedEnvironment(previousUrl: string | undefined, previousToken: string | undefined): void {
  if (previousUrl === undefined) delete process.env.FORGEDOCK_NESTED_AGENT_URL;
  else process.env.FORGEDOCK_NESTED_AGENT_URL = previousUrl;
  if (previousToken === undefined) delete process.env.FORGEDOCK_NESTED_AGENT_TOKEN;
  else process.env.FORGEDOCK_NESTED_AGENT_TOKEN = previousToken;
}
