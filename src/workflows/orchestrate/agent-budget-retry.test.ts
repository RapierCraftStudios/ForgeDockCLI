import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AgentExecutionBudgetExceededError } from "../../runtime/agent-runtime.js";
import type { DurableArtifact } from "../../core/artifacts/schema.js";
import { InMemoryArtifactRepository } from "../../core/ports/repositories.js";
import type { RunState } from "../../core/state/machine.js";
import { WorkflowExecutionError } from "../work-on/investigate.js";
import {
  retryWorkOnAgentBudget,
  WORK_ON_AGENT_BUDGET_RETRY_BACKOFF_MS,
  WORK_ON_AGENT_BUDGET_RETRY_DEADLINE_MS,
  WORK_ON_AGENT_BUDGET_RETRY_MAX_ATTEMPTS,
} from "./agent-budget-retry.js";

const subject = { repo: "owner/repo", issue: 443 };

function run(): RunState {
  return {
    schema: "forgedock.run/v1",
    runId: "run-budget",
    workflow: "work-on",
    subject,
    state: "remediating",
    attempt: 19,
    version: 4,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    artifactIds: {},
  };
}

function wrappedBudget(runState = run()): WorkflowExecutionError {
  const cause = new AgentExecutionBudgetExceededError("maxTurns", 25, 24, {
    sessionRef: "session-remediator",
    execution: { turns: 25, toolCalls: 42, exhausted: "maxTurns" },
  });
  return new WorkflowExecutionError("remediation resumed after native budget exhaustion", runState, {
    cause,
    recoverable: true,
  });
}

function lineageArtifact(id: string): DurableArtifact {
  return {
    schema: "forgedock.artifact/v2",
    id,
    kind: "Intent",
    runId: "run-budget",
    subject,
    producer: { role: "controller", runtime: "test" },
    payload: {} as never,
    createdAt: "2026-01-01T00:00:00.000Z",
  } as unknown as DurableArtifact;
}

describe("native work-on agent budget retry", () => {
  it("ignores unrelated recoverable, lease, and reviewer-like errors", async () => {
    const artifacts = new InMemoryArtifactRepository();
    const unrelated = new WorkflowExecutionError("provider interrupted", run(), { recoverable: true, cause: new Error("semantic idle") });
    assert.equal(await retryWorkOnAgentBudget(unrelated, { artifacts, subject, nodeId: "issue-443" }), undefined);
    assert.equal(await retryWorkOnAgentBudget(new Error("lease lost"), { artifacts, subject, nodeId: "issue-443" }), undefined);
    const reviewer = new WorkflowExecutionError("reviewer execution maxTurns budget exhausted", run(), { recoverable: true, cause: new Error("review plan retry suppressed") });
    assert.equal(await retryWorkOnAgentBudget(reviewer, { artifacts, subject, nodeId: "issue-443" }), undefined);
    assert.equal(artifacts.artifacts.length, 0);
  });

  it("does not retry or checkpoint a pre-aborted worker", async () => {
    const artifacts = new InMemoryArtifactRepository();
    const controller = new AbortController();
    controller.abort(new Error("lease liveness lost"));
    const result = await retryWorkOnAgentBudget(wrappedBudget(), {
      artifacts,
      subject,
      nodeId: "issue-443",
      signal: controller.signal,
    });
    assert.equal(result, undefined);
    assert.equal(artifacts.artifacts.length, 0);
  });
  it("creates one bounded waiting checkpoint with fixed deadline, backoff, and lineage", async () => {
    const artifacts = new InMemoryArtifactRepository();
    await artifacts.append(lineageArtifact("intent-lineage"));
    const result = await retryWorkOnAgentBudget(wrappedBudget(), {
      artifacts,
      subject,
      nodeId: "issue-443",
      attemptId: "attempt-controller",
    });
    assert.equal(result?.status, "retry_wait");
    assert.equal(result?.retryDomain, "workflow");
    assert.equal(result?.retryCode, "agent-execution-budget");
    assert.equal(result?.retryAfterMs, WORK_ON_AGENT_BUDGET_RETRY_BACKOFF_MS);
    const checkpoints = (await artifacts.list(subject, "RetryCheckpoint"))
      .filter((artifact): artifact is DurableArtifact<"RetryCheckpoint"> => artifact.kind === "RetryCheckpoint");
    const checkpoint = checkpoints[0]!;
    assert.equal(checkpoint.payload.attempt.number, 1);
    assert.equal(checkpoint.payload.attempt.max, WORK_ON_AGENT_BUDGET_RETRY_MAX_ATTEMPTS);
    assert.equal(checkpoint.payload.attempt.deadlineAt !== undefined, true);
    const deadlineWindow = Date.parse(checkpoint.payload.attempt.deadlineAt!) - Date.parse(checkpoint.payload.attempt.firstAt);
    assert.ok(deadlineWindow <= WORK_ON_AGENT_BUDGET_RETRY_DEADLINE_MS);
    assert.ok(deadlineWindow >= WORK_ON_AGENT_BUDGET_RETRY_DEADLINE_MS - 1_000);
    assert.deepEqual(checkpoint.payload.artifactIds, ["intent-lineage"]);
    assert.equal(checkpoint.payload.sessionRef, "session-remediator");
  });

  it("increments only the checkpoint attempt and terminalizes max/deadline exhaustion", async () => {
    const artifacts = new InMemoryArtifactRepository();
    const first = await retryWorkOnAgentBudget(wrappedBudget(), { artifacts, subject, nodeId: "issue-443" });
    const second = await retryWorkOnAgentBudget(wrappedBudget(), { artifacts, subject, nodeId: "issue-443" });
    assert.equal(first?.status, "retry_wait");
    assert.equal(second?.status, "retry_wait");
    const checkpoints = (await artifacts.list(subject, "RetryCheckpoint"))
      .filter((artifact): artifact is DurableArtifact<"RetryCheckpoint"> => artifact.kind === "RetryCheckpoint");
    assert.equal(checkpoints.length, 2);
    assert.equal(checkpoints[1]!.payload.attempt.number, 2);
    assert.equal(run().attempt, 19);

    const deadlineArtifacts = new InMemoryArtifactRepository();
    await retryWorkOnAgentBudget(wrappedBudget(), { artifacts: deadlineArtifacts, subject, nodeId: "issue-443" });
    const deadlineCheckpoint = deadlineArtifacts.artifacts.findLast((artifact) => artifact.kind === "RetryCheckpoint")! as DurableArtifact<"RetryCheckpoint">;
    deadlineCheckpoint.payload.attempt.deadlineAt = new Date(Date.now() - 1).toISOString();
    const deadlineResult = await retryWorkOnAgentBudget(wrappedBudget(), { artifacts: deadlineArtifacts, subject, nodeId: "issue-443" });
    assert.equal(deadlineResult?.status, "failed");
    const deadlineCheckpoints = (await deadlineArtifacts.list(subject, "RetryCheckpoint"))
      .filter((artifact): artifact is DurableArtifact<"RetryCheckpoint"> => artifact.kind === "RetryCheckpoint");
    assert.equal(deadlineCheckpoints.at(-1)?.payload.status, "exhausted");
    assert.equal(deadlineCheckpoints.at(-1)?.payload.attempt.number, 2);

    const exhausted = await retryWorkOnAgentBudget(wrappedBudget(), { artifacts, subject, nodeId: "issue-443" });
    assert.equal(exhausted?.status, "failed");
    assert.equal(exhausted?.retryable, false);
    assert.equal(exhausted?.retryCode, "agent-execution-budget-exhausted");
    const final = (await artifacts.list(subject, "RetryCheckpoint"))
      .filter((artifact): artifact is DurableArtifact<"RetryCheckpoint"> => artifact.kind === "RetryCheckpoint")
      .at(-1)!;
    assert.equal(final.payload.status, "exhausted");
    assert.equal(final.payload.attempt.number, 3);
  });
});
