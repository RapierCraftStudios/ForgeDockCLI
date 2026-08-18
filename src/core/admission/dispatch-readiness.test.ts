// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { test } from "node:test";
import { InMemoryLeaseWitness } from "../ports/lease.js";
import { collectDispatchReadiness, dispatchModelReference, formatDispatchReadiness, resolveDispatchRuntime } from "./dispatch-readiness.js";

test("dispatch role resolution is deterministic across TUI, headless, and durable sources", () => {
  const resolved = resolveDispatchRuntime({
    config: {
      workerModel: "config/worker",
      workerThinking: "low",
      reviewerModel: "config/reviewer",
      planningModel: "config/planner",
    },
    environment: {
      FORGEDOCK_WORKER_PROVIDER: "env-worker",
      FORGEDOCK_WORKER_MODEL: "env-model",
      FORGEDOCK_REVIEWER_MODEL: "env/reviewer",
      FORGEDOCK_PLANNING_MODEL: "env/planner",
      PI_PROVIDER: "pi-provider",
      PI_MODEL: "pi-model",
    },
    activeModel: "interactive/session",
    invocation: {
      provider: "invocation-provider",
      model: "invocation-model",
      thinking: "max",
    },
    durable: {
      workerProvider: "durable-provider",
      workerModel: "durable-model",
      workerThinking: "high",
      planningProvider: "durable-planning-provider",
      planningModel: "durable-planning-model",
      planningThinking: "high",
    },
  });

  assert.deepEqual(resolved.worker, {
    role: "worker",
    provider: "invocation-provider",
    model: "invocation-model",
    thinking: "max",
    source: "invocation",
  });
  assert.deepEqual(resolved.reviewer, {
    role: "reviewer",
    provider: "invocation-provider",
    model: "invocation-model",
    thinking: "max",
    source: "invocation",
  });
  assert.deepEqual(resolved.planning, {
    role: "planning",
    provider: "durable-planning-provider",
    model: "durable-planning-model",
    thinking: "high",
    source: "durable plan",
  });
  assert.equal(dispatchModelReference(resolved.worker), "invocation-provider/invocation-model:max");
});

test("dispatch role resolution never mixes provider and model across precedence contracts", () => {
  const providerOnly = resolveDispatchRuntime({
    invocation: { provider: "invocation-provider" },
    durable: { workerProvider: "durable-provider", workerModel: "durable-model" },
    environment: {},
  });
  assert.deepEqual(providerOnly.worker, {
    role: "worker",
    provider: "invocation-provider",
    source: "invocation",
  });

  const modelOnly = resolveDispatchRuntime({
    invocation: { model: "invocation-model" },
    durable: { workerProvider: "durable-provider", workerModel: "durable-model" },
    environment: {},
  });
  assert.deepEqual(modelOnly.worker, {
    role: "worker",
    model: "invocation-model",
    source: "invocation",
  });
});

test("role-specific invocation values form one coherent contract with generic invocation values", () => {
  const resolved = resolveDispatchRuntime({
    invocation: {
      provider: "generic-provider",
      model: "generic-model",
      thinking: "low",
      worker: { model: "worker-model", thinking: "high" },
      reviewer: { provider: "reviewer-provider" },
    },
    environment: {},
  });
  assert.deepEqual(resolved.worker, {
    role: "worker",
    provider: "generic-provider",
    model: "worker-model",
    thinking: "high",
    source: "invocation",
  });
  assert.deepEqual(resolved.reviewer, {
    role: "reviewer",
    provider: "reviewer-provider",
    model: "generic-model",
    thinking: "low",
    source: "invocation",
  });
});

test("thinking overrides remain independent while provider and model fall back together", () => {
  const resolved = resolveDispatchRuntime({
    config: {
      workerModel: "provider/worker",
      reviewerThinking: "high",
    },
    environment: {},
  });
  assert.deepEqual(resolved.reviewer, {
    role: "reviewer",
    provider: "provider",
    model: "worker",
    thinking: "high",
    source: "worker fallback",
  });
});

test("readiness aggregates lease, runtime, model, and GitHub blockers without dispatch", async () => {
  let githubCalls = 0;
  const report = await collectDispatchReadiness({
    checkoutRoot: "/checkout",
    config: { reviewerModel: "provider/reviewer" },
    requireLeaseWitness: true,
    runtime: {
      async preflight({ model } = {}) {
        throw new Error(`authentication unavailable for ${model}`);
      },
    },
    githubProbe: async () => {
      githubCalls += 1;
      throw new Error("gh: not logged in");
    },
  });

  assert.equal(report.ready, false);
  assert.equal(githubCalls, 1);
  assert.deepEqual(
    report.diagnostics.map((diagnostic) => `${diagnostic.code}/${diagnostic.role ?? "none"}`),
    [
      "provider-model-missing/worker",
      "provider-model-missing/planning",
      "lease-witness-missing/none",
      "provider-auth/reviewer",
      "github-auth/none",
    ],
  );
  const rendered = formatDispatchReadiness(report);
  assert.match(rendered, /Dispatch was not started/);
  assert.match(rendered, /gh auth status\/login/);
  assert.doesNotMatch(rendered, /not logged in.*provider-key|PRIVATE KEY/i);
});

test("a verified witness and all resolved role models produce a ready report", async () => {
  const witness = new InMemoryLeaseWitness();
  const report = await collectDispatchReadiness({
    checkoutRoot: "/checkout",
    config: {
      workerModel: "provider/worker",
      reviewerModel: "provider/reviewer",
      planningModel: "provider/planner",
    },
    requireLeaseWitness: true,
    leaseWitness: witness,
    runtime: {
      async preflight({ provider, model } = {}) { return { provider: provider!, model: model! }; },
    },
    githubProbe: async () => ({ repo: "owner/repo", defaultBranch: "main" }),
  });

  assert.equal(report.ready, true);
  assert.deepEqual(report.diagnostics, []);
  assert.deepEqual(report.repository, { repo: "owner/repo", defaultBranch: "main" });
});

test("project model references stay strict even when an environment provider exists", async () => {
  const report = await collectDispatchReadiness({
    checkoutRoot: "/checkout",
    config: { workerModel: "bare-worker" },
    environment: { PI_PROVIDER: "environment-provider", PI_MODEL: "environment-model" },
    runtimeInstallCheck: async () => undefined,
    githubProbe: async () => ({ repo: "owner/repo" }),
  });
  assert.equal(report.ready, false);
  assert.equal(report.diagnostics.some((diagnostic) => diagnostic.code === "config-invalid" && diagnostic.role === "worker"), true);
});

test("readiness diagnostics redact credentials across common provider and GitHub error forms", async () => {
  const secrets = [
    "provider-password",
    "bearer.secret.value",
    "github_pat_A1B2C3D4E5F6",
    "sk-abcdefghijklmnop",
    "query-token-value",
    "openai-key-value",
  ];
  const report = await collectDispatchReadiness({
    checkoutRoot: "/checkout",
    config: {
      workerModel: "provider/worker",
      reviewerModel: "provider/reviewer",
      planningModel: "provider/planner",
    },
    runtimeInstallCheck: async () => undefined,
    runtime: {
      async preflight() {
        throw new Error(
          "authentication failed at https://user:provider-password@example.test "
          + "Authorization: Bearer bearer.secret.value "
          + "OPENAI_API_KEY=openai-key-value token github_pat_A1B2C3D4E5F6",
        );
      },
    },
    githubProbe: async () => {
      throw new Error(
        "bad credentials sk-abcdefghijklmnop "
        + "https://example.test/repo?access_token=query-token-value",
      );
    },
  });

  const serializedReport = JSON.stringify(report.diagnostics);
  const rendered = formatDispatchReadiness(report);
  for (const secret of secrets) {
    assert.doesNotMatch(serializedReport, new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.doesNotMatch(rendered, new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.match(rendered, /\[redacted\]/);
  assert.equal(report.diagnostics.every((diagnostic) => diagnostic.code === "provider-auth" || diagnostic.code === "github-auth"), true);
});
