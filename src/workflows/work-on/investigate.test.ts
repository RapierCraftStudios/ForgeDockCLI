import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createArtifact, type DurableArtifact, type InvestigationPayload } from "../../core/artifacts/schema.js";
import type { DecompositionChild, IssueSnapshot } from "../../core/ports/forge-host.js";
import { InMemoryArtifactRepository, InMemoryRunRepository } from "../../core/ports/repositories.js";
import { createRun, transition, type RunState } from "../../core/state/machine.js";
import { FakeAgentRuntime } from "../../runtime/fake-runtime.js";
import { AgentExecutionInterruptedError } from "../../runtime/agent-runtime.js";
import {
  investigateWorkItem,
  latestPriorLearningArtifacts,
  resumeInvestigationWorkItem,
  WorkflowExecutionError,
} from "./investigate.js";

function intent(runId = "run_investigate") {
  return createArtifact({
    kind: "Intent",
    runId,
    subject: { repo: "acme/widget", issue: 17 },
    producer: { role: "controller", runtime: "forgedock" },
    payload: {
      title: "Widget can lose state",
      problem: "The issue reports state loss during concurrent updates.",
      constraints: ["Preserve compatibility"],
      acceptanceHints: ["Regression test"],
      dependencies: [],
    },
  });
}

function confirmed(): InvestigationPayload {
  return {
    outcome: "confirmed",
    confidence: "high",
    summary: "The update path performs a read-modify-write without serialization.",
    evidence: [{ claim: "Update is non-atomic", source: "src/widget.ts:updateWidget", detail: "The write uses stale state read before awaiting I/O." }],
    rootCause: "updateWidget reads before the lock boundary.",
    affectedSurfaces: ["src/widget.ts", "test/widget.test.ts"],
    risks: ["Concurrent callers"],
    recommendation: "Move the read into the lock and add a concurrent regression test.",
  };
}

function dependencies(runtime: FakeAgentRuntime) {
  const materialized: DecompositionChild[][] = [];
  return {
    runtime,
    artifacts: new InMemoryArtifactRepository(),
    runs: new InMemoryRunRepository(),
    materialized,
    decomposer: {
      async materializeDecomposition(input: { repo: string; parentIssue: number; children: DecompositionChild[] }): Promise<IssueSnapshot[]> {
        materialized.push(input.children);
        return input.children.map((child, index) => ({
          repo: input.repo, number: 100 + index, title: child.title, body: child.outcome,
          url: `https://github.test/${input.repo}/issues/${100 + index}`, state: "OPEN" as const,
        }));
      },
    },
  };
}

async function investigatingRun(
  intentArtifact: ReturnType<typeof intent>,
  runs: InMemoryRunRepository,
): Promise<RunState> {
  const queued = createRun({
    workflow: "work-on",
    subject: intentArtifact.subject,
    runId: intentArtifact.runId,
    target: { lane: "fast", targetBranch: "main" },
  });
  await runs.create(queued);
  const started = transition(queued, "START_INVESTIGATION");
  await runs.commit(queued.version, started.state, started.record);
  return started.state;
}

describe("work-on investigation", () => {
  it("projects only the latest durable learning artifact for each phase", () => {
    const artifact = (kind: DurableArtifact["kind"], index: number) => ({ kind, id: `${kind}-${index}` } as unknown as DurableArtifact);
    const projected = latestPriorLearningArtifacts([
      artifact("ReviewVerdict", 1), artifact("Outcome", 1), artifact("ReviewVerdict", 2), artifact("BuildResult", 1), artifact("Outcome", 2),
    ]);
    assert.deepEqual(projected.map(({ kind, id }) => `${kind}:${id}`), ["ReviewVerdict:ReviewVerdict-2", "BuildResult:BuildResult-1", "Outcome:Outcome-2"]);
  });

  it("commits confirmed evidence and stops at the Build Packet boundary", async () => {
    const runtime = new FakeAgentRuntime([confirmed()]);
    const deps = dependencies(runtime);
    const result = await investigateWorkItem({
      intent: intent(),
      cwd: process.cwd(),
      planningProvider: "anthropic",
      planningModel: "claude-sonnet",
      planningThinking: "high",
    }, deps);

    assert.equal(result.run.state, "preparing");
    assert.equal(result.investigation.payload.outcome, "confirmed");
    assert.equal(deps.artifacts.artifacts.map((artifact) => artifact.kind).join(","), "Intent,Investigation");
    assert.deepEqual(runtime.tasks[0]?.tools, ["read", "grep", "find", "ls"]);
    assert.match(runtime.tasks[0]?.instructions ?? "", /missing implementation.*confirmed, not invalid/);
    assert.match(runtime.tasks[0]?.instructions ?? "", /integration boundaries/);
    assert.match(runtime.tasks[0]?.instructions ?? "", /repeated mechanical or integration failure patterns/);
    assert.equal(runtime.tasks[0]?.workspace.mode, "read-only");
    assert.deepEqual(runtime.tasks[0]?.modelPolicy, {
      planningProvider: "anthropic",
      planningModel: "claude-sonnet",
      planningThinking: "high",
    });
    assert.deepEqual((await deps.runs.history(result.run.runId)).map((record) => record.event), [
      "START_INVESTIGATION", "INVESTIGATION_CONFIRMED",
    ]);
  });

  it("cancels an in-flight successful resolution before semantic admission for every outcome", async () => {
    const cancellation = new Error("operator cancellation won the race");
    const payloads: InvestigationPayload[] = [
      confirmed(),
      {
        outcome: "invalid",
        confidence: "high",
        summary: "The report is already covered.",
        evidence: confirmed().evidence,
        affectedSurfaces: ["src/widget.ts"],
        risks: [],
        recommendation: "No delivery is required.",
      },
      {
        outcome: "decompose",
        confidence: "high",
        summary: "The report needs separate deliverables.",
        evidence: confirmed().evidence,
        affectedSurfaces: ["src/widget.ts"],
        risks: [],
        recommendation: "Deliver both child outcomes.",
        decomposition: [
          { title: "First child", outcome: "Deliver the first part", dependsOn: [] },
          { title: "Second child", outcome: "Deliver the second part", dependsOn: [] },
        ],
      },
    ];

    for (const payload of payloads) {
      const outcome = payload.outcome;
      const abort = new AbortController();
      const runtime = new FakeAgentRuntime([() => {
        abort.abort(cancellation);
        return payload;
      }]);
      const deps = dependencies(runtime);
      await assert.rejects(
        investigateWorkItem({ intent: intent(`run_cancel_${outcome}`), cwd: process.cwd(), signal: abort.signal }, deps),
        (error: unknown) => error instanceof WorkflowExecutionError
          && error.run.state === "cancelled"
          && error.message === cancellation.message,
      );
      const runId = `run_cancel_${outcome}`;
      assert.deepEqual((await deps.runs.history(runId)).map((record) => record.event), [
        "START_INVESTIGATION", "CANCEL",
      ]);
      assert.equal((await deps.runs.load(runId))?.state, "cancelled");
      assert.deepEqual(deps.artifacts.artifacts.map((artifact) => artifact.kind), ["Intent"]);
      assert.equal(deps.materialized.length, 0, `${outcome} cancellation must not materialize children`);
    }
  });

  it("records invalid evidence with a provisional closure checkpoint", async () => {
    const runtime = new FakeAgentRuntime([{
      ...confirmed(),
      outcome: "invalid",
      rootCause: undefined,
      summary: "The guarded implementation and regression test already cover the report.",
      recommendation: "Close as already resolved by the linked implementation.",
    }]);
    const deps = dependencies(runtime);
    const result = await investigateWorkItem({ intent: intent("run_invalid"), cwd: process.cwd() }, deps);
    assert.equal(result.run.state, "invalid");
    assert.equal(result.outcome?.payload.status, "invalid");
    assert.deepEqual(result.outcome?.payload.issueClosure, { status: "pending", repo: "acme/widget", issue: 17 });
    assert.deepEqual(deps.artifacts.artifacts.map((artifact) => artifact.kind), ["Intent", "Investigation", "Outcome"]);
  });

  it("materializes concrete child issues before committing a decomposed Outcome", async () => {
    const runtime = new FakeAgentRuntime([{
      ...confirmed(), outcome: "decompose", rootCause: undefined,
      decomposition: [
        { title: "Add locking", outcome: "Serialize updates", dependsOn: [] },
        { title: "Add regression coverage", outcome: "Prove concurrent safety", dependsOn: ["Add locking"] },
      ],
    }]);
    const deps = dependencies(runtime);
    const result = await investigateWorkItem({ intent: intent("run_decompose"), cwd: process.cwd() }, deps);
    assert.equal(result.run.state, "decomposed");
    assert.equal(deps.materialized.length, 1);
    assert.deepEqual(result.outcome?.payload.childIssues, [
      "#100 — Add locking (https://github.test/acme/widget/issues/100)",
      "#101 — Add regression coverage (https://github.test/acme/widget/issues/101)",
    ]);
  });

  it("requires concrete child intents before accepting decomposition", async () => {
    const runtime = new FakeAgentRuntime([{ ...confirmed(), outcome: "decompose", rootCause: undefined }]);
    const deps = dependencies(runtime);
    await assert.rejects(
      investigateWorkItem({ intent: intent("run_bad_decompose"), cwd: process.cwd() }, deps),
      (error: unknown) => error instanceof WorkflowExecutionError && error.run.state === "failed",
    );
    assert.deepEqual((await deps.runs.history("run_bad_decompose")).map((record) => record.event), ["START_INVESTIGATION", "FAIL"]);
  });

  it("records runtime failure as a deterministic failed transition", async () => {
    const runtime = new FakeAgentRuntime([new Error("provider unavailable")]);
    const deps = dependencies(runtime);
    await assert.rejects(
      investigateWorkItem({ intent: intent("run_provider_failure"), cwd: process.cwd() }, deps),
      (error: unknown) => error instanceof WorkflowExecutionError && error.run.failure === "provider unavailable",
    );
  });

  it("preserves an interrupted provider checkpoint for restart instead of failing the run", async () => {
    const runtime = new FakeAgentRuntime([
      new AgentExecutionInterruptedError("provider became semantically idle", { reason: "semantic-idle", idleMs: 120_000 }),
    ]);
    const deps = dependencies(runtime);
    await assert.rejects(
      investigateWorkItem({ intent: intent("run_provider_idle"), cwd: process.cwd() }, deps),
      (error: unknown) => error instanceof WorkflowExecutionError
        && error.recoverable
        && error.run.state === "investigating",
    );
    assert.deepEqual((await deps.runs.history("run_provider_idle")).map((record) => record.event), ["START_INVESTIGATION", "RESUME_INVESTIGATION"]);
  });

  it("recovers an Intent-only crash by dispatching exactly one investigator", async () => {
    const intentArtifact = intent("run_intent_recovery");
    const runtime = new FakeAgentRuntime([confirmed()]);
    const deps = dependencies(runtime);
    await deps.artifacts.append(intentArtifact);
    const run = await investigatingRun(intentArtifact, deps.runs);

    const result = await resumeInvestigationWorkItem({
      run,
      intent: intentArtifact,
      cwd: process.cwd(),
    }, deps);

    assert.equal(result.run.state, "preparing");
    assert.deepEqual(runtime.tasks.map((task) => task.role), ["investigator"]);
    assert.equal(deps.artifacts.artifacts.filter((artifact) => artifact.kind === "Intent").length, 1);
  });

  it("adopts a durable Investigation after fault injection without replaying any agent outcome", async () => {
    for (const outcome of ["confirmed", "invalid", "decompose"] as const) {
      const { rootCause: _rootCause, ...classified } = confirmed();
      const payload: InvestigationPayload = outcome === "confirmed"
        ? confirmed()
        : {
          ...classified,
          outcome,
          ...(outcome === "decompose" ? {
            decomposition: [
              { title: "Add locking", outcome: "Serialize updates", dependsOn: [] },
              { title: "Add regression coverage", outcome: "Prove safety", dependsOn: ["Add locking"] },
            ],
          } : {}),
        };
      const intentArtifact = intent(`run_fault_${outcome}`);
      const runtime = new FakeAgentRuntime([payload]);
      const deps = dependencies(runtime);
      const artifacts = deps.artifacts;
      let injected = false;
      const originalAppend = artifacts.append.bind(artifacts);
      artifacts.append = async (artifact) => {
        await originalAppend(artifact);
        if (!injected && artifact.kind === "Investigation") {
          injected = true;
          throw new Error("fault after durable Investigation append");
        }
      };

      await assert.rejects(
        investigateWorkItem({ intent: intentArtifact, cwd: process.cwd() }, deps),
        /fault after durable Investigation append/,
      );
      const durableInvestigation = artifacts.artifacts.find(
        (artifact): artifact is DurableArtifact<"Investigation"> => artifact.kind === "Investigation",
      );
      assert.ok(durableInvestigation);

      const recover = async () => {
        const recoveredRuns = new InMemoryRunRepository();
        const recoveredRun = await investigatingRun(intentArtifact, recoveredRuns);
        return resumeInvestigationWorkItem({
          run: recoveredRun,
          intent: intentArtifact,
          investigation: durableInvestigation,
          cwd: process.cwd(),
        }, { ...deps, runs: recoveredRuns });
      };
      const recovered = await recover();
      assert.equal(recovered.run.state, outcome === "confirmed" ? "preparing" : outcome === "invalid" ? "invalid" : "decomposed");
      assert.equal(runtime.tasks.length, 1, `${outcome} recovery must not replay the investigator`);

      if (outcome !== "confirmed") {
        const retried = await recover();
        assert.equal(retried.outcome?.id, recovered.outcome?.id);
        assert.equal(artifacts.artifacts.filter((artifact) => artifact.kind === "Outcome").length, 1);
      }
    }
  });
});
