import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type {
  OrchestrationExecutionAdmission,
  OrchestrationExecutionClaim,
  OrchestrationRecord,
} from "../../core/ports/orchestration.js";
import { InMemoryOrchestrationRepository } from "../../core/ports/repositories.js";
import {
  OrchestrationController,
  type OrchestrationControllerDependencies,
  type OrchestrationWorkerContext,
  type OrchestrationWorkOnWorker,
} from "./controller.js";
import { ClaimPromotionConflictError, materializeClaimDependencies, type ScheduledWorkItem } from "./scheduler.js";

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, resolve, reject };
}

class RecordingOrchestrationRepository extends InMemoryOrchestrationRepository {
  readonly saves: OrchestrationRecord[] = [];

  override async saveOrchestration(record: OrchestrationRecord): Promise<void> {
    this.saves.push(structuredClone(record));
    await super.saveOrchestration(record);
  }
}

class TestExecutionAdmission implements OrchestrationExecutionAdmission {
  readonly #claims = new Map<string, string>();
  #sequence = 0;

  async acquire(orchestrationId: string): Promise<OrchestrationExecutionClaim | undefined> {
    if (this.#claims.has(orchestrationId)) return undefined;
    const claimId = `claim-${++this.#sequence}`;
    this.#claims.set(orchestrationId, claimId);
    return {
      claimId,
      assertValid: () => {
        if (this.#claims.get(orchestrationId) !== claimId) throw new Error(`Stale execution claim: ${claimId}`);
      },
      release: () => {
        if (this.#claims.get(orchestrationId) === claimId) this.#claims.delete(orchestrationId);
      },
    };
  }
}

function controller(
  repository: InMemoryOrchestrationRepository,
  worker: OrchestrationWorkOnWorker,
  overrides: Partial<OrchestrationControllerDependencies> = {},
): OrchestrationController {
  let clock = 0;
  let attempt = 0;
  return new OrchestrationController({
    repository,
    worker,
    executionAdmission: new TestExecutionAdmission(),
    transportCapacity: 4,
    now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, clock++)).toISOString(),
    createOrchestrationId: () => "dag-test",
    createAttemptId: () => `attempt-${++attempt}`,
    ...overrides,
  });
}

function item(id: string, issue: number, dependencies: readonly string[] = []): ScheduledWorkItem {
  return { id, issue, priority: 1, dependencies, claims: [] };
}

async function waitUntil(predicate: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise<void>((resolve) => setTimeout(resolve, 2));
  }
}

describe("OrchestrationController", () => {
  it("rejects a new DAG node that directly targets protected production", async () => {
    const repository = new RecordingOrchestrationRepository();
    const service = controller(repository, async () => undefined);
    await assert.rejects(() => service.create({
      repository: "owner/repo",
      maxParallel: 1,
      productionTarget: "main",
      items: [{ ...item("issue-1", 1), targetBranch: "main", lane: "fast", productionTarget: "main" }],
    }), /directly targets protected production branch main/);
  });

  it("refreshes a route when interrupted wrappers produced no semantic child run", async () => {
    const repository = new RecordingOrchestrationRepository();
    const launchedTargets: string[] = [];
    const service = controller(repository, async (scheduled) => {
      launchedTargets.push(scheduled.targetBranch ?? "unset");
    }, {
      revalidateRoute: async () => ({ targetBranch: "staging", lane: "fast", productionTarget: "main" }),
      reconcileWorker: async () => ({ disposition: "interrupted", reason: "controller wrapper ended before child run creation" }),
    });
    const created = await service.create({
      repository: "owner/repo",
      maxParallel: 1,
      productionTarget: "main",
      items: [{ ...item("issue-1", 1), targetBranch: "staging", lane: "fast", productionTarget: "main" }],
    });
    await repository.saveOrchestration({
      ...created,
      status: "failed",
      nodes: [{
        ...created.nodes[0]!,
        targetBranch: "main",
        status: "running",
        activeAttemptId: "attempt-launching",
        attempts: [{
          attemptId: "attempt-interrupted",
          attempt: 1,
          recovery: "initial",
          status: "interrupted",
          startedAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:01:00.000Z",
          completedAt: "2026-01-01T00:01:00.000Z",
          taskId: "dead-wrapper",
        }, {
          attemptId: "attempt-launching",
          attempt: 2,
          recovery: "relaunch",
          status: "launching",
          startedAt: "2026-01-01T00:02:00.000Z",
          updatedAt: "2026-01-01T00:02:00.000Z",
        }],
      }],
    });

    const result = await service.resume(created.orchestrationId);
    assert.deepEqual(launchedTargets, ["staging"]);
    assert.equal(result.record.nodes[0]?.targetBranch, "staging");
  });

  it("fails closed instead of retargeting a node with durable attempt evidence", async () => {
    const repository = new RecordingOrchestrationRepository();
    const service = controller(repository, async () => undefined, {
      revalidateRoute: async () => ({ targetBranch: "release", lane: "fast", productionTarget: "main" }),
    });
    const created = await service.create({
      repository: "owner/repo",
      maxParallel: 1,
      productionTarget: "main",
      items: [{ ...item("issue-1", 1), targetBranch: "staging", lane: "fast", productionTarget: "main" }],
    });
    await repository.saveOrchestration({
      ...created,
      status: "failed",
      nodes: [{
        ...created.nodes[0]!,
        status: "failed",
        attempts: [{
          attemptId: "attempt-old",
          attempt: 1,
          recovery: "initial",
          status: "failed",
          startedAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:01:00.000Z",
          completedAt: "2026-01-01T00:01:00.000Z",
          runId: "run-old",
        }],
      }],
    });

    await assert.rejects(
      () => service.resume(created.orchestrationId),
      /Durable route drift.*refusing to retarget started work/,
    );
  });

  it("marks a newly created DAG failed when execution admission throws", async () => {
    const repository = new RecordingOrchestrationRepository();
    const service = controller(repository, async () => undefined, {
      executionAdmission: {
        acquire: async () => { throw new Error("retained witness diverged"); },
      },
    });

    await assert.rejects(() => service.createAndRun({
      repository: "owner/repo",
      maxParallel: 1,
      items: [item("issue-1", 1)],
    }), /retained witness diverged/);

    const durable = await repository.loadOrchestration("dag-test");
    assert.equal(durable?.status, "failed");
    assert.equal(durable?.executionAttempt, 0);
    assert.equal(durable?.nodes[0]?.status, "queued");
  });

  it("creates and runs a fully frozen plan through the caller work-on worker", async () => {
    const repository = new RecordingOrchestrationRepository();
    const events: string[] = [];
    let sawPersistedAttempt = false;
    const service = controller(repository, async (scheduled, context) => {
      const persisted = await repository.loadOrchestration(context.orchestrationId);
      sawPersistedAttempt = persisted?.nodes[0]?.attempts?.[0]?.status === "launching";
      await context.recordTask({
        taskId: `task-${scheduled.id}`,
        controllerTaskId: `controller-${scheduled.id}`,
        agentTaskId: `agent-${scheduled.id}`,
        runId: `run-${scheduled.id}`,
        sessionId: `session-${scheduled.id}`,
      });
      await context.heartbeat();
    }, { onEvent: (event) => events.push(event.name) });

    const result = await service.createAndRun({
      repository: "owner/repo",
      requestedIssueNumbers: [7, 8],
      maxParallel: 3,
      autoMerge: false,
      productionTarget: "main",
      plan: {
        source: "deep-plan",
        planId: "plan-7",
        policy: { scopeExpansion: "scope-locked", maxRemediationCycles: 2 },
      },
      items: [{
        id: "issue-7",
        issue: 7,
        priority: 0,
        dependencies: [],
        claims: ["src/workflows/orchestrate"],
        targetBranch: "staging",
        lane: "fast",
        promotionTarget: "main",
        productionTarget: "main",
        affectedFiles: ["src/workflows/orchestrate/controller.ts"],
        memberIssues: [7, 8],
        title: "Headless controller",
        summary: "Unify orchestration execution",
        plan: { nodeId: "plan-node-1", acceptance: ["durable", "resumable"] },
      }],
    });

    assert.equal(sawPersistedAttempt, true);
    assert.equal(result.record.status, "completed");
    assert.deepEqual(result.record.requestedIssueNumbers, [7, 8]);
    assert.deepEqual(result.record.plan, {
      source: "deep-plan",
      planId: "plan-7",
      policy: { scopeExpansion: "scope-locked", maxRemediationCycles: 2 },
    });
    const node = result.record.nodes[0]!;
    assert.equal(node.targetBranch, "staging");
    assert.equal(node.lane, "fast");
    assert.equal(node.promotionTarget, "main");
    assert.deepEqual(node.claims, ["src/workflows/orchestrate"]);
    assert.equal(node.plan?.nodeId, "plan-node-1");
    assert.equal(node.childRunIds[0], "run-issue-7");
    assert.equal(node.attempts?.[0]?.taskId, "task-issue-7");
    assert.equal(node.attempts?.[0]?.controllerTaskId, "controller-issue-7");
    assert.equal(node.attempts?.[0]?.heartbeatSequence, 1);
    assert.equal(node.attempts?.[0]?.status, "completed");
    assert.ok(events.includes("started"));
    assert.ok(events.includes("completed"));
    assert.deepEqual(await repository.loadOrchestration(result.orchestrationId), result.record);
  });

  it("expands a live decomposition into the same durable DAG and reroutes dependents", async () => {
    const repository = new RecordingOrchestrationRepository();
    const started: string[] = [];
    const service = controller(repository, async (scheduled) => {
      started.push(scheduled.id);
      if (scheduled.id === "parent") return {
        status: "skipped",
        error: "authoritative child scope required",
        childIssues: [11, 12],
      };
    }, {
      resolveDecomposition: async ({ childIssues }) => {
        assert.deepEqual(childIssues, [11, 12]);
        return {
          childIssues: childIssues ?? [],
          items: [item("child-11", 11), item("child-12", 12)],
        };
      },
    });

    const result = await service.createAndRun({
      repository: "owner/repo",
      maxParallel: 2,
      items: [item("parent", 1), item("dependent", 2, ["parent"])],
    });

    assert.deepEqual(started, ["parent", "child-11", "child-12", "dependent"]);
    assert.equal(result.record.status, "completed");
    assert.equal(result.record.nodes.find((node) => node.id === "parent")?.status, "skipped");
    assert.deepEqual(result.record.nodes.find((node) => node.id === "parent")?.decompositionChildren, [11, 12]);
    assert.deepEqual(result.record.nodes.find((node) => node.id === "parent")?.attempts?.at(-1)?.decompositionChildren, [11, 12]);
    assert.deepEqual(result.record.nodes.find((node) => node.id === "dependent")?.dependencies, ["child-11", "child-12"]);
    assert.equal(result.record.nodes.find((node) => node.id === "child-11")?.status, "completed");
    assert.equal(result.record.nodes.find((node) => node.id === "child-12")?.status, "completed");
    assert.deepEqual(result.record.issueNumbers, [1, 2, 11, 12]);
    assert.deepEqual((await repository.loadOrchestration(result.orchestrationId))?.nodes, result.record.nodes);
  });

  it("recovers a legacy skipped decomposition from authoritative child discovery on resume", async () => {
    const repository = new RecordingOrchestrationRepository();
    const launched: string[] = [];
    const service = controller(repository, async (scheduled) => { launched.push(scheduled.id); }, {
      resolveDecomposition: async ({ node, childIssues }) => {
        assert.equal(node.issue, 1);
        assert.equal(childIssues, undefined);
        return {
          childIssues: [21, 22],
          items: [item("child-21", 21), item("child-22", 22)],
        };
      },
    });
    const created = await service.create({ repository: "owner/repo", items: [item("legacy-parent", 1)], maxParallel: 2 });
    await repository.saveOrchestration({
      ...created,
      status: "failed",
      nodes: [{ ...created.nodes[0]!, status: "skipped", error: "decomposed before child expansion" }],
    });

    const result = await service.resume(created.orchestrationId);
    assert.deepEqual(launched, ["child-21", "child-22"]);
    assert.equal(result.record.status, "completed");
    assert.deepEqual(result.record.nodes.find((node) => node.id === "legacy-parent")?.decompositionChildren, [21, 22]);
  });

  it("recovers decomposition children persisted with a terminal attempt before expansion", async () => {
    const repository = new RecordingOrchestrationRepository();
    const launched: string[] = [];
    const service = controller(repository, async (scheduled) => { launched.push(scheduled.id); }, {
      resolveDecomposition: async ({ childIssues }) => {
        assert.deepEqual(childIssues, [41, 42]);
        return {
          childIssues: childIssues ?? [],
          items: [item("child-41", 41), item("child-42", 42)],
        };
      },
    });
    const created = await service.create({ repository: "owner/repo", items: [item("crash-parent", 1)], maxParallel: 2 });
    await repository.saveOrchestration({
      ...created,
      status: "failed",
      nodes: [{
        ...created.nodes[0]!,
        status: "skipped",
        attempts: [{
          attemptId: "attempt-before-crash",
          attempt: 1,
          recovery: "initial",
          status: "skipped",
          startedAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:01.000Z",
          completedAt: "2026-01-01T00:00:01.000Z",
          decompositionChildren: [41, 42],
        }],
      }],
    });

    const result = await service.resume(created.orchestrationId);
    assert.deepEqual(launched, ["child-41", "child-42"]);
    assert.deepEqual(result.record.nodes.find((node) => node.id === "crash-parent")?.decompositionChildren, [41, 42]);
    assert.equal(result.record.nodes.filter((node) => node.issue === 41).length, 1);
    assert.equal(result.record.nodes.filter((node) => node.issue === 42).length, 1);
  });

  it("persists terminal attempt evidence when legacy decomposition reconciliation has none", async () => {
    const repository = new RecordingOrchestrationRepository();
    const launched: string[] = [];
    const service = controller(repository, async (scheduled) => { launched.push(scheduled.id); }, {
      reconcileWorker: async () => ({
        disposition: "terminal",
        result: { status: "skipped", childIssues: [51, 52] },
        reason: "recovered authoritative decomposition",
      }),
      resolveDecomposition: async ({ childIssues }) => ({
        childIssues: childIssues ?? [],
        items: [item("child-51", 51), item("child-52", 52)],
      }),
    });
    const created = await service.create({ repository: "owner/repo", items: [item("legacy-running", 1)], maxParallel: 2 });
    await repository.saveOrchestration({
      ...created,
      status: "failed",
      nodes: [{ ...created.nodes[0]!, status: "running", attempts: [] }],
    });

    const result = await service.resume(created.orchestrationId);
    const durableCheckpoint = repository.saves.find((record) => {
      const node = record.nodes.find((candidate) => candidate.id === "legacy-running");
      return node?.status === "skipped"
        && node.decompositionChildren === undefined
        && node.attempts?.at(-1)?.decompositionChildren?.join(",") === "51,52";
    });
    assert.ok(durableCheckpoint, "reconciliation must durably own child scope before scheduler expansion");
    assert.equal(durableCheckpoint.nodes[0]?.attempts?.at(-1)?.status, "skipped");
    assert.deepEqual(launched, ["child-51", "child-52"]);
    assert.deepEqual(result.record.nodes.find((node) => node.id === "legacy-running")?.decompositionChildren, [51, 52]);
  });

  it("rejects decomposition children already represented by a batch member", async () => {
    const repository = new RecordingOrchestrationRepository();
    const service = controller(repository, async (scheduled) => scheduled.id === "parent"
      ? { status: "skipped", childIssues: [1] }
      : undefined, {
      resolveDecomposition: async ({ childIssues }) => ({
        childIssues: childIssues ?? [],
        items: [{ ...item("issue-1", 1), memberIssues: [1] }],
      }),
    });

    await assert.rejects(
      () => service.createAndRun({
        repository: "owner/repo",
        items: [{ ...item("batch-100", 100), memberIssues: [1, 2] }, item("parent", 10)],
        maxParallel: 2,
      }),
      /existing issue #1 owned by batch-100/i,
    );
  });

  it("rejects an over-limit decomposition before dispatching child work", async () => {
    const repository = new RecordingOrchestrationRepository();
    let resolverCalls = 0;
    const service = controller(repository, async (scheduled) => scheduled.id === "parent"
      ? { status: "skipped", childIssues: [31, 32] }
      : undefined, {
      maxDecompositionChildren: 1,
      resolveDecomposition: async ({ childIssues }) => {
        resolverCalls++;
        return { childIssues: childIssues ?? [], items: [item("child-31", 31), item("child-32", 32)] };
      },
    });

    await assert.rejects(
      () => service.createAndRun({ repository: "owner/repo", items: [item("parent", 1)], maxParallel: 1 }),
      /exceeds the 1-child limit/,
    );
    assert.equal(resolverCalls, 1);
    assert.equal((await repository.loadOrchestration("dag-test"))?.status, "failed");
  });

  it("completes a transient promoted-claim conflict in one controller execution with a durable resume attempt", async () => {
    const repository = new RecordingOrchestrationRepository();
    const firstPromoted = deferred<void>();
    const secondSuspended = deferred<void>();
    const secondDurablyRequeued = deferred<void>();
    const releaseFirst = deferred<void>();
    const recoveries = new Map<string, string[]>();
    const service = controller(repository, async (scheduled, context) => {
      const seen = recoveries.get(scheduled.id) ?? [];
      seen.push(context.recovery);
      recoveries.set(scheduled.id, seen);
      if (scheduled.id === "first") {
        await context.promoteClaims(["src/shared"]);
        firstPromoted.resolve();
        await releaseFirst.promise;
        return;
      }
      await firstPromoted.promise;
      try {
        await context.promoteClaims(["src/shared/file.ts"]);
      } catch (error) {
        if (!(error instanceof ClaimPromotionConflictError)) throw error;
        secondSuspended.resolve();
        return { status: "suspended", error };
      }
    }, {
      onEvent: (event) => {
        if (event.name === "resumed" && event.itemId === "second") secondDurablyRequeued.resolve();
      },
    });

    const execution = service.createAndRun({
      repository: "owner/repo",
      maxParallel: 2,
      items: [item("first", 1), item("second", 2)],
    });
    await secondSuspended.promise;
    await secondDurablyRequeued.promise;
    const waiting = await repository.loadOrchestration("dag-test");
    const waitingSecond = waiting?.nodes.find((node) => node.id === "second");
    assert.equal(waitingSecond?.status, "queued");
    assert.equal(waitingSecond?.waitReason?.kind, "active-claim-conflict");
    releaseFirst.resolve();
    const result = await execution;

    assert.equal(result.record.status, "completed");
    assert.equal(result.record.nodes.every((node) => node.status === "completed"), true);
    assert.deepEqual(recoveries.get("first"), ["initial"]);
    assert.deepEqual(recoveries.get("second"), ["initial", "resume"]);
    assert.deepEqual(result.record.nodes.find((node) => node.id === "second")?.claims, ["src/shared/file.ts"]);
    const attempts = result.record.nodes.find((node) => node.id === "second")?.attempts ?? [];
    assert.deepEqual(attempts.map((attempt) => attempt.status), ["suspended", "completed"]);
    assert.deepEqual(attempts.map((attempt) => attempt.recovery), ["initial", "resume"]);
  });

  it("retains a derived glob serialization edge through durable resume", async () => {
    const repository = new RecordingOrchestrationRepository();
    const predecessorGate = deferred<void>();
    const launched: string[] = [];
    const graph = materializeClaimDependencies([
      { id: "glob", issue: 40, priority: 1, dependencies: [], claims: ["src/**/*.ts"] },
      { id: "concrete", issue: 41, priority: 1, dependencies: [], claims: ["src/foo.ts"] },
    ]);
    const service = controller(repository, async (scheduled) => {
      launched.push(scheduled.id);
      if (scheduled.id === "glob") await predecessorGate.promise;
    }, {
      reconcileWorker: async ({ node }) => {
        assert.equal(node.id, "glob");
        return { disposition: "interrupted", reason: "predecessor transport was lost" };
      },
    });

    const created = await service.create({
      repository: "owner/repo",
      items: graph.items,
      serializationEdges: graph.edges,
      maxParallel: 2,
    });
    assert.deepEqual(created.serializationEdges, graph.edges);
    assert.deepEqual((await repository.loadOrchestration(created.orchestrationId))?.serializationEdges, graph.edges);
    await repository.saveOrchestration({
      ...created,
      status: "failed",
      nodes: [
        {
          ...created.nodes[0]!,
          status: "suspended",
          activeAttemptId: "attempt-old",
          attempts: [{
            attemptId: "attempt-old",
            attempt: 1,
            recovery: "initial",
            status: "suspended",
            startedAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:01:00.000Z",
            completedAt: "2026-01-01T00:01:00.000Z",
          }],
        },
        { ...created.nodes[1]!, status: "queued", attempts: [] },
      ],
    });

    const resumed = service.resume(created.orchestrationId);
    await waitUntil(() => launched.length === 1, "resumed glob predecessor did not dispatch");
    assert.deepEqual(launched, ["glob"]);
    predecessorGate.resolve();
    const result = await resumed;
    assert.deepEqual(result.schedule.startOrder, ["glob", "concrete"]);
    assert.equal(result.record.nodes.every((node) => node.status === "completed"), true);
    assert.deepEqual(result.record.serializationEdges, graph.edges);
    assert.deepEqual((await repository.loadOrchestration(created.orchestrationId))?.serializationEdges, graph.edges);
  });

  it("resumes by attaching to a live worker without launching a duplicate", async () => {
    const repository = new RecordingOrchestrationRepository();
    const completion = deferred<void>();
    const reconciled = deferred<void>();
    let launches = 0;
    const service = controller(repository, async () => { launches++; }, {
      reconcileWorker: async () => {
        reconciled.resolve();
        return {
          disposition: "live",
          identity: { taskId: "task-live", runId: "run-live" },
          heartbeatAt: "2026-01-01T00:00:30.000Z",
          wait: async () => completion.promise,
        };
      },
    });
    const created = await service.create({ repository: "owner/repo", items: [item("issue-1", 1)], maxParallel: 2 });
    const running: OrchestrationRecord = {
      ...created,
      status: "running",
      nodes: [{
        ...created.nodes[0]!,
        status: "running",
        activeAttemptId: "attempt-existing",
        attempts: [{
          attemptId: "attempt-existing",
          attempt: 1,
          recovery: "initial",
          status: "running",
          startedAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:10.000Z",
          taskId: "task-live",
        }],
      }],
    };
    await repository.saveOrchestration(running);

    const resumed = service.resume(created.orchestrationId);
    await reconciled.promise;
    await waitUntil(
      () => repository.saves.some((record) => record.nodes[0]?.lastRecovery?.mode === "reattach"),
      "live reconciliation was not persisted",
    );
    assert.equal(launches, 0);
    assert.equal((await repository.loadOrchestration(created.orchestrationId))?.nodes[0]?.attempts?.length, 1);
    completion.resolve();
    const result = await resumed;

    assert.equal(launches, 0);
    assert.equal(result.record.status, "completed");
    assert.equal(result.record.nodes[0]?.attempts?.length, 1);
    assert.equal(result.record.nodes[0]?.attempts?.[0]?.status, "completed");
    assert.equal(result.record.nodes[0]?.lastRecovery?.mode, "reattach");
  });

  it("rejects a live reconciliation that reuses a terminal attempt id", async () => {
    const repository = new InMemoryOrchestrationRepository();
    let launches = 0;
    let waits = 0;
    const service = controller(repository, async () => { launches++; }, {
      reconcileWorker: async () => ({
        disposition: "live",
        attemptId: "attempt-terminal",
        wait: async () => { waits++; },
      }),
    });
    const created = await service.create({ repository: "owner/repo", items: [item("reused", 27)], maxParallel: 1 });
    await repository.saveOrchestration({
      ...created,
      status: "failed",
      nodes: [{
        ...created.nodes[0]!,
        status: "running",
        attempts: [{
          attemptId: "attempt-terminal",
          attempt: 1,
          recovery: "initial",
          status: "failed",
          startedAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:01:00.000Z",
          completedAt: "2026-01-01T00:01:00.000Z",
          error: "old terminal failure",
        }],
      }],
    });

    await assert.rejects(service.resume(created.orchestrationId), /attempt id .* already present/);
    assert.equal(launches, 0);
    assert.equal(waits, 0);
    const persisted = await repository.loadOrchestration(created.orchestrationId);
    assert.equal(persisted?.nodes[0]?.attempts?.length, 1);
    assert.equal(persisted?.nodes[0]?.activeAttemptId, undefined);
  });

  it("relaunches an interrupted suspended worker as a new durable attempt", async () => {
    const repository = new RecordingOrchestrationRepository();
    const recoveries: string[] = [];
    const service = controller(repository, async (_scheduled, context) => {
      recoveries.push(context.recovery);
      await context.recordTask({ taskId: "task-relaunched", runId: "run-relaunched" });
    }, {
      reconcileWorker: async () => ({ disposition: "interrupted", reason: "transport process is gone" }),
    });
    const created = await service.create({ repository: "owner/repo", items: [item("issue-2", 2)], maxParallel: 1 });
    await repository.saveOrchestration({
      ...created,
      status: "failed",
      nodes: [{
        ...created.nodes[0]!,
        status: "suspended",
        activeAttemptId: "attempt-old",
        attempts: [{
          attemptId: "attempt-old",
          attempt: 1,
          recovery: "initial",
          status: "suspended",
          startedAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:01:00.000Z",
          completedAt: "2026-01-01T00:01:00.000Z",
          taskId: "task-dead",
        }],
      }],
    });

    const result = await service.resume(created.orchestrationId);
    const attempts = result.record.nodes[0]?.attempts ?? [];
    assert.deepEqual(recoveries, ["relaunch"]);
    assert.equal(attempts.length, 2);
    assert.equal(attempts[0]?.status, "interrupted");
    assert.equal(attempts[1]?.recovery, "relaunch");
    assert.equal(attempts[1]?.recoveryOfAttemptId, "attempt-old");
    assert.equal(attempts[1]?.taskId, "task-relaunched");
    assert.equal(attempts[1]?.status, "completed");
    assert.equal(result.record.nodes[0]?.lastRecovery?.mode, "relaunch");
  });

  it("reconciles suspended attempt evidence without an active pointer before relaunching", async () => {
    const repository = new RecordingOrchestrationRepository();
    let reconciliations = 0;
    const recoveries: string[] = [];
    const service = controller(repository, async (_scheduled, context) => {
      recoveries.push(context.recovery);
    }, {
      reconcileWorker: async ({ attempt }) => {
        reconciliations++;
        assert.equal(attempt?.attemptId, "attempt-checkpoint");
        assert.equal(attempt?.status, "suspended");
        return { disposition: "interrupted", reason: "checkpoint has no live transport" };
      },
    });
    const created = await service.create({ repository: "owner/repo", items: [item("issue-3", 3)], maxParallel: 1 });
    await repository.saveOrchestration({
      ...created,
      status: "failed",
      nodes: [{
        ...created.nodes[0]!,
        status: "suspended",
        attempts: [{
          attemptId: "attempt-checkpoint",
          attempt: 1,
          recovery: "initial",
          status: "suspended",
          startedAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:01:00.000Z",
          completedAt: "2026-01-01T00:01:00.000Z",
          taskId: "task-checkpoint",
        }],
      }],
    });

    const result = await service.resume(created.orchestrationId);
    const node = result.record.nodes[0];
    assert.equal(reconciliations, 1);
    assert.deepEqual(recoveries, ["relaunch"]);
    assert.equal(node?.attempts?.length, 2);
    assert.equal(node?.attempts?.[0]?.status, "interrupted");
    assert.equal(node?.attempts?.[1]?.recovery, "relaunch");
    assert.equal(node?.attempts?.[1]?.recoveryOfAttemptId, "attempt-checkpoint");
    assert.equal(node?.attempts?.[1]?.status, "completed");
  });

  it("resumes failed work without replaying completed DAG nodes", async () => {
    const repository = new RecordingOrchestrationRepository();
    const launched: string[] = [];
    const recoveries: string[] = [];
    const service = controller(repository, async (scheduled, context) => {
      launched.push(scheduled.id);
      recoveries.push(context.recovery);
    });
    const created = await service.create({
      repository: "owner/repo",
      items: [item("complete", 10), item("retry", 11, ["complete"])],
      maxParallel: 2,
    });
    await repository.saveOrchestration({
      ...created,
      status: "failed",
      nodes: [
        {
          ...created.nodes[0]!,
          status: "completed",
          childRunIds: ["run-complete"],
          attempts: [{
            attemptId: "attempt-complete",
            attempt: 1,
            recovery: "initial",
            status: "completed",
            startedAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:01:00.000Z",
            completedAt: "2026-01-01T00:01:00.000Z",
          }],
        },
        {
          ...created.nodes[1]!,
          status: "failed",
          error: "old transport failure",
          attempts: [{
            attemptId: "attempt-failed",
            attempt: 1,
            recovery: "initial",
            status: "failed",
            startedAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:01:00.000Z",
            completedAt: "2026-01-01T00:01:00.000Z",
            error: "old transport failure",
          }],
        },
      ],
    });

    const result = await service.resume(created.orchestrationId);
    assert.deepEqual(launched, ["retry"]);
    assert.deepEqual(recoveries, ["resume"]);
    assert.equal(result.record.nodes[0]?.attempts?.length, 1);
    assert.equal(result.record.nodes[0]?.childRunIds[0], "run-complete");
    assert.equal(result.record.nodes[1]?.attempts?.length, 2);
    assert.equal(result.record.nodes[1]?.attempts?.[1]?.recovery, "resume");
    assert.equal(result.record.nodes[1]?.status, "completed");
    assert.equal(result.record.status, "completed");
  });

  it("does not dispatch a dependent until its durable predecessor completes", async () => {
    const repository = new InMemoryOrchestrationRepository();
    const gates = new Map([
      ["a", deferred<void>()],
      ["b", deferred<void>()],
      ["c", deferred<void>()],
    ]);
    const started: string[] = [];
    const service = controller(repository, async (scheduled) => {
      started.push(scheduled.id);
      await gates.get(scheduled.id)!.promise;
    }, { transportCapacity: 2 });

    const execution = service.createAndRun({
      repository: "owner/repo",
      maxParallel: 3,
      items: [item("a", 1), item("b", 2, ["a"]), item("c", 3)],
    });
    await waitUntil(() => started.length === 2, "initial ready set did not dispatch");
    assert.deepEqual(started, ["a", "c"]);
    gates.get("a")!.resolve();
    await waitUntil(() => started.includes("b"), "dependent did not stream after its predecessor");
    assert.deepEqual(started, ["a", "c", "b"]);
    gates.get("b")!.resolve();
    gates.get("c")!.resolve();

    const result = await execution;
    assert.equal(result.record.nodes.find((node) => node.id === "b")?.status, "completed");
    assert.ok(result.schedule.startOrder.indexOf("b") > result.schedule.startOrder.indexOf("a"));
  });

  it("serializes rapid record writes so the terminal snapshot cannot be overwritten", async () => {
    class DelayedRepository extends RecordingOrchestrationRepository {
      override async saveOrchestration(record: OrchestrationRecord): Promise<void> {
        await new Promise<void>((resolve) => setTimeout(resolve, record.status === "completed" ? 1 : 3));
        await super.saveOrchestration(record);
      }
    }
    const repository = new DelayedRepository();
    const service = controller(repository, async (_scheduled, context) => {
      await context.recordTask({ taskId: "task-persisted", runId: "run-persisted" });
      await context.heartbeat();
      await context.heartbeat();
    });

    const result = await service.createAndRun({ repository: "owner/repo", items: [item("persist", 4)], maxParallel: 1 });
    const loaded = await repository.loadOrchestration(result.orchestrationId);
    assert.equal(loaded?.status, "completed");
    assert.equal(loaded?.nodes[0]?.status, "completed");
    assert.equal(loaded?.nodes[0]?.attempts?.[0]?.taskId, "task-persisted");
    assert.equal(loaded?.nodes[0]?.attempts?.[0]?.heartbeatSequence, 2);
    assert.equal(repository.saves.at(-1)?.status, "completed");
    assert.equal(repository.saves.some((record) => {
      const node = record.nodes[0];
      return node?.attempts?.[0]?.status === "completed" && node.activeAttemptId !== undefined;
    }), false, "attempt completion and active-attempt clearing must share one durable write");
  });

  it("passes fixed transport capacity to the scheduler without dynamic polling", async () => {
    const repository = new InMemoryOrchestrationRepository();
    let capacityReads = 0;
    let attempt = 0;
    const dependencies: OrchestrationControllerDependencies = {
      repository,
      worker: async () => undefined,
      executionAdmission: new TestExecutionAdmission(),
      transportCapacity: 2,
      now: () => "2026-01-01T00:00:00.000Z",
      createOrchestrationId: () => "dag-fixed-capacity",
      createAttemptId: () => `attempt-fixed-${++attempt}`,
    };
    Object.defineProperty(dependencies, "transportCapacity", {
      get: () => {
        capacityReads++;
        return 2;
      },
    });
    const service = new OrchestrationController(dependencies);

    const result = await service.createAndRun({
      repository: "owner/repo",
      maxParallel: 4,
      items: [item("a", 1), item("b", 2), item("c", 3)],
    });

    assert.equal(result.record.status, "completed");
    assert.equal(capacityReads, 2, "fixed capacity should be read only for type detection and initial resolution");
  });

  it("caps scheduler concurrency to the caller transport capacity", async () => {
    const repository = new InMemoryOrchestrationRepository();
    const gates = new Map(["a", "b", "c", "d"].map((id) => [id, deferred<void>()] as const));
    const started: string[] = [];
    let active = 0;
    let maximumActive = 0;
    const service = controller(repository, async (scheduled) => {
      started.push(scheduled.id);
      active++;
      maximumActive = Math.max(maximumActive, active);
      await gates.get(scheduled.id)!.promise;
      active--;
    }, { transportCapacity: 2 });
    const execution = service.createAndRun({
      repository: "owner/repo",
      maxParallel: 8,
      items: [item("a", 1), item("b", 2), item("c", 3), item("d", 4)],
    });

    await waitUntil(() => started.length === 2, "transport capacity was not filled");
    assert.equal(maximumActive, 2);
    gates.get(started[0]!)!.resolve();
    await waitUntil(() => started.length === 3, "queued worker did not dispatch after capacity released");
    gates.get(started[1]!)!.resolve();
    await waitUntil(() => started.length === 4, "final queued worker did not dispatch");
    for (const id of started.slice(2)) gates.get(id)!.resolve();

    const result = await execution;
    assert.equal(maximumActive, 2);
    assert.equal(result.effectiveMaxParallel, 2);
    assert.equal(result.record.maxParallel, 8);
    assert.equal(result.record.transportCapacity, 2);
    assert.equal(result.record.effectiveMaxParallel, 2);
  });

  it("keeps queued nodes durable when live transport capacity drops and later recovers", async () => {
    const repository = new InMemoryOrchestrationRepository();
    const gates = new Map(["a", "b", "c"].map((id) => [id, deferred<void>()] as const));
    const started: string[] = [];
    let available = 2;
    let active = 0;
    let maximumActive = 0;
    const service = controller(repository, async (scheduled) => {
      started.push(scheduled.id);
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await gates.get(scheduled.id)!.promise;
      active -= 1;
    }, {
      transportCapacity: () => available,
    });
    const execution = service.createAndRun({
      repository: "owner/repo",
      maxParallel: 4,
      items: [item("a", 1), item("b", 2), item("c", 3)],
    });

    await waitUntil(() => started.length === 2, "live transport capacity was not filled");
    available = 0;
    gates.get("a")!.resolve();
    await new Promise<void>((resolve) => setTimeout(resolve, 60));
    assert.deepEqual(started, ["a", "b"], "queued work must wait while transport capacity is unavailable");

    available = 2;
    gates.get("b")!.resolve();
    await waitUntil(() => started.length === 3, "queued work did not resume after transport capacity recovered");
    gates.get("c")!.resolve();

    const result = await execution;
    assert.equal(result.record.status, "completed");
    assert.deepEqual(result.schedule.startOrder, ["a", "b", "c"]);
    assert.equal(maximumActive, 2);
    assert.equal(active, 0);
    assert.equal(result.record.transportCapacity, 2);
    assert.equal(result.record.effectiveMaxParallel, 2);
  });

  it("persists a terminally complete 500-node controller fleet with exactly one attempt per node", async () => {
    const repository = new RecordingOrchestrationRepository();
    const launches = new Map<string, number>();
    let active = 0;
    let maximumActive = 0;
    const service = controller(repository, async (scheduled) => {
      launches.set(scheduled.id, (launches.get(scheduled.id) ?? 0) + 1);
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise<void>((resolve) => setImmediate(resolve));
      active -= 1;
    }, { transportCapacity: 20 });
    const items = Array.from({ length: 500 }, (_, index) => ({
      ...item(
        `fleet-${index + 1}`,
        20_000 + index,
        index >= 100 && index % 5 === 0 ? [`fleet-${index - 99}`] : [],
      ),
      // Keep a representative mix of concrete claims in the persistence
      // accounting without turning this correctness test into a dense graph.
      ...(index % 10 === 0 ? { claims: [`src/components/${index % 8}/file.ts`] } : {}),
    }));

    const result = await service.createAndRun({
      repository: "owner/repo",
      maxParallel: 20,
      items,
    });
    const durable = await repository.loadOrchestration(result.orchestrationId);

    assert.equal(result.record.status, "completed");
    assert.equal(durable?.status, "completed");
    assert.equal(durable?.nodes.length, 500);
    assert.equal(launches.size, 500);
    assert.ok([...launches.values()].every((count) => count === 1));
    assert.ok(durable?.nodes.every((node) => node.status === "completed"));
    assert.ok(durable?.nodes.every((node) => node.activeAttemptId === undefined));
    assert.ok(durable?.nodes.every((node) => node.attempts?.length === 1 && node.attempts[0]?.status === "completed"));
    assert.ok(maximumActive > 1);
    assert.ok(maximumActive <= 20);
    assert.equal(active, 0);

    const serializedBytes = repository.saves.reduce((total, record) => total + JSON.stringify(record).length, 0);
    assert.ok(repository.saves.length <= 1_200, `scheduler persistence amplification: ${repository.saves.length} full saves`);
    assert.ok(serializedBytes <= 170_000_000, `scheduler serialization amplification: ${serializedBytes} bytes`);
  });

  it("admits only one controller execution for the same orchestration", async () => {
    const repository = new InMemoryOrchestrationRepository();
    const admission = new TestExecutionAdmission();
    const gate = deferred<void>();
    const started = deferred<void>();
    let launches = 0;
    const first = controller(repository, async () => {
      launches++;
      started.resolve();
      await gate.promise;
    }, { executionAdmission: admission });
    const duplicate = controller(repository, async () => { launches++; }, { executionAdmission: admission });
    const created = await first.create({ repository: "owner/repo", items: [item("exclusive", 20)], maxParallel: 1 });

    const execution = first.run(created.orchestrationId);
    await started.promise;
    await assert.rejects(
      first.resume(created.orchestrationId),
      /already active in this controller/,
    );
    await assert.rejects(
      duplicate.resume(created.orchestrationId),
      /already active in another controller/,
    );
    assert.equal(launches, 1);
    gate.resolve();
    assert.equal((await execution).record.status, "completed");
  });

  it("fences worker callbacks after their attempt has completed", async () => {
    const repository = new InMemoryOrchestrationRepository();
    let staleContext: OrchestrationWorkerContext | undefined;
    const service = controller(repository, async (_scheduled, context) => {
      staleContext = context;
      await context.recordTask({ taskId: "task-once" });
      await assert.rejects(
        context.recordTask({ taskId: "task-conflict" }),
        /identity taskId .* is immutable/,
      );
    });

    const result = await service.createAndRun({ repository: "owner/repo", items: [item("fenced", 21)], maxParallel: 1 });
    assert.ok(staleContext);
    await assert.rejects(staleContext.heartbeat(), /Stale orchestration worker context/);
    await assert.rejects(staleContext.recordTask({ taskId: "task-stale" }), /Stale orchestration worker context/);

    const persisted = await repository.loadOrchestration(result.orchestrationId);
    assert.equal(persisted?.nodes[0]?.attempts?.[0]?.status, "completed");
    assert.equal(persisted?.nodes[0]?.attempts?.[0]?.taskId, "task-once");
    assert.equal(persisted?.nodes[0]?.activeAttemptId, undefined);
  });

  it("recovers a terminal attempt/node crash window without relaunching work", async () => {
    const repository = new InMemoryOrchestrationRepository();
    let launches = 0;
    let reconciliations = 0;
    const service = controller(repository, async () => { launches++; }, {
      reconcileWorker: async () => {
        reconciliations++;
        throw new Error("terminal evidence should bypass live reconciliation");
      },
    });
    const created = await service.create({
      repository: "owner/repo",
      items: [item("terminal-referenced", 22), item("terminal-cleared", 28)],
      maxParallel: 2,
    });
    await repository.saveOrchestration({
      ...created,
      status: "failed",
      nodes: created.nodes.map((node, index) => ({
        ...node,
        status: "running",
        ...(index === 0 ? { activeAttemptId: `attempt-${node.id}` } : {}),
        attempts: [{
          attemptId: `attempt-${node.id}`,
          attempt: 1,
          recovery: "initial",
          status: "completed",
          startedAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:01:00.000Z",
          completedAt: "2026-01-01T00:01:00.000Z",
          taskId: `task-${node.id}`,
        }],
      })),
    });

    const result = await service.resume(created.orchestrationId);
    assert.equal(launches, 0);
    assert.equal(reconciliations, 0);
    assert.equal(result.record.status, "completed");
    assert.equal(result.record.nodes.every((node) => node.status === "completed"), true);
    assert.equal(result.record.nodes.every((node) => node.activeAttemptId === undefined), true);
    assert.equal(result.record.nodes.every((node) => node.attempts?.length === 1), true);
  });

  it("persists a failed parent when authoritative resume reconciliation fails", async () => {
    const repository = new InMemoryOrchestrationRepository();
    let launches = 0;
    const service = controller(repository, async () => { launches++; }, {
      reconcileWorker: async () => { throw new Error("worker authority unavailable"); },
    });
    const created = await service.create({ repository: "owner/repo", items: [item("unavailable", 26)], maxParallel: 1 });
    await repository.saveOrchestration({
      ...created,
      status: "running",
      nodes: [{
        ...created.nodes[0]!,
        status: "running",
        activeAttemptId: "attempt-live",
        attempts: [{
          attemptId: "attempt-live",
          attempt: 1,
          recovery: "initial",
          status: "running",
          startedAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:30.000Z",
          taskId: "task-live",
        }],
      }],
    });

    await assert.rejects(service.resume(created.orchestrationId), /worker authority unavailable/);
    assert.equal(launches, 0);
    const persisted = await repository.loadOrchestration(created.orchestrationId);
    assert.equal(persisted?.status, "failed");
    assert.equal(persisted?.nodes[0]?.status, "running");
    assert.equal(persisted?.nodes[0]?.activeAttemptId, "attempt-live");
  });

  it("persists final suspended-predecessor wait reasons", async () => {
    const repository = new InMemoryOrchestrationRepository();
    const service = controller(repository, async (scheduled) => scheduled.id === "parent"
      ? { status: "suspended", error: "checkpoint-parent" }
      : undefined);

    const result = await service.createAndRun({
      repository: "owner/repo",
      items: [item("parent", 23), item("child", 24, ["parent"])],
      maxParallel: 2,
    });
    const child = result.record.nodes.find((node) => node.id === "child");
    assert.equal(result.record.status, "failed");
    assert.deepEqual(child?.waitReason, {
      kind: "suspended-predecessor",
      predecessor: "parent",
      checkpoint: "durable-recovery",
    });
    assert.deepEqual(
      (await repository.loadOrchestration(result.orchestrationId))?.nodes.find((node) => node.id === "child")?.waitReason,
      child?.waitReason,
    );
  });

  it("persists a caught claim conflict as a suspended attempt and resumes after release", async () => {
    const repository = new RecordingOrchestrationRepository();
    const conflict = new ClaimPromotionConflictError("parent", ["active-worker"]);
    const launches: string[] = [];
    let firstAttempt = true;
    const service = controller(repository, async (scheduled, context) => {
      launches.push(`${scheduled.id}:${context.recovery}`);
      if (scheduled.id === "parent" && firstAttempt) {
        firstAttempt = false;
        return { status: "suspended", error: conflict };
      }
    }, {
      reconcileWorker: async ({ item: scheduled }) => {
        assert.equal(scheduled.id, "parent");
        return { disposition: "interrupted", reason: "active claim released" };
      },
    });

    const created = await service.create({
      repository: "owner/repo",
      items: [item("parent", 30), item("child", 31, ["parent"])],
      maxParallel: 2,
    });
    const resumed = await service.run(created.orchestrationId);
    const resumedParent = resumed.record.nodes.find((node) => node.id === "parent");
    assert.deepEqual(
      launches,
      ["parent:initial", "parent:resume", "child:initial"],
    );
    assert.equal(resumed.record.status, "completed");
    assert.deepEqual(resumedParent?.attempts?.map((attempt) => [attempt.status, attempt.recovery]), [
      ["suspended", "initial"],
      ["completed", "resume"],
    ]);
    assert.equal(resumed.record.nodes.find((node) => node.id === "child")?.status, "completed");
  });

  it("re-promotes packet-only claims on an explicit resume after the active claim releases", async () => {
    const repository = new RecordingOrchestrationRepository();
    const activeClaimed = deferred<void>();
    const releaseActive = deferred<void>();
    const launches: string[] = [];
    let conflict: ClaimPromotionConflictError | undefined;
    const service = controller(repository, async (scheduled, context) => {
      launches.push(`${scheduled.id}:${context.recovery}`);
      if (scheduled.id === "active") {
        await context.promoteClaims(["src/packet-only"]);
        activeClaimed.resolve();
        await releaseActive.promise;
        return;
      }
      if (scheduled.id === "parent" && context.recovery === "initial") {
        await activeClaimed.promise;
        try {
          await context.promoteClaims(["src/packet-only"]);
        } catch (error) {
          if (!(error instanceof ClaimPromotionConflictError)) throw error;
          conflict = error;
          return { status: "suspended", error };
        }
        throw new Error("expected the packet-only claim to conflict with active work");
      }
      await context.promoteClaims(["src/packet-only"]);
    }, {
      reconcileWorker: async ({ item: scheduled }) => {
        assert.equal(scheduled.id, "parent");
        return { disposition: "interrupted", reason: "active claim released" };
      },
    });

    const created = await service.create({
      repository: "owner/repo",
      maxParallel: 2,
      items: [
        { id: "parent", issue: 30, priority: 0, dependencies: [], claims: [] },
        { id: "active", issue: 31, priority: 1, dependencies: [], claims: [] },
        { id: "child", issue: 32, priority: 2, dependencies: ["parent"], claims: [] },
      ],
    });
    const firstExecution = service.run(created.orchestrationId);
    await activeClaimed.promise;
    await waitUntil(() => conflict !== undefined, "packet-only claim conflict was not observed");
    releaseActive.resolve();

    const completed = await firstExecution;
    assert.ok(conflict);
    assert.equal(completed.record.status, "completed");
    assert.deepEqual(launches, ["parent:initial", "active:initial", "parent:resume", "child:initial"]);
    assert.deepEqual(completed.record.nodes.find((node) => node.id === "parent")?.claims, ["src/packet-only"]);
    assert.equal(completed.record.nodes.find((node) => node.id === "parent")?.status, "completed");
    assert.equal(completed.record.nodes.find((node) => node.id === "child")?.status, "completed");
  });

  it("delivers events only after persistence and isolates observer failures", async () => {
    class DurableEventRepository extends InMemoryOrchestrationRepository {
      latest: OrchestrationRecord | undefined;

      override async createOrchestration(record: OrchestrationRecord): Promise<void> {
        await super.createOrchestration(record);
        this.latest = structuredClone(record);
      }

      override async saveOrchestration(record: OrchestrationRecord): Promise<void> {
        await new Promise<void>((resolve) => setTimeout(resolve, 1));
        await super.saveOrchestration(record);
        this.latest = structuredClone(record);
      }
    }
    const repository = new DurableEventRepository();
    const durableAtDelivery: boolean[] = [];
    const observerErrors: string[] = [];
    const service = controller(repository, async () => undefined, {
      onEvent: async (event) => {
        durableAtDelivery.push(repository.latest?.updatedAt === event.at);
        throw new Error(`observer failed on ${event.name}`);
      },
      onEventError: (error) => {
        observerErrors.push(error instanceof Error ? error.message : String(error));
      },
    });

    const result = await service.createAndRun({ repository: "owner/repo", items: [item("events", 25)], maxParallel: 1 });
    assert.equal(result.record.status, "completed");
    assert.ok(durableAtDelivery.length > 0);
    assert.equal(durableAtDelivery.every(Boolean), true);
    await waitUntil(
      () => observerErrors.length === durableAtDelivery.length,
      "asynchronous observer failures were not isolated and reported",
    );
    assert.equal(observerErrors.length, durableAtDelivery.length);
  });
});
