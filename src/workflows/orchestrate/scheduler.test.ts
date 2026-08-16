import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { InMemoryLeaseWitness } from "../../core/ports/lease.js";
import { buildSchedulePreview, ClaimPromotionConflictError, claimsConflict, InMemoryLeaseRepository, LeaseContinuityError, materializeClaimDependencies, runSchedule, validateGraph, type ScheduledWorkItem } from "./scheduler.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function deferredSignal(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((accept) => { resolve = accept; });
  return { promise, resolve };
}

function deferredGate(): { promise: Promise<void>; release: () => void } {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

describe("lean orchestration scheduler", () => {
  it("honors dependencies, priority, concurrency and path claims", async () => {
    const items = [
      { id: "a", issue: 1, priority: 1, dependencies: [], claims: ["db/migrations"] },
      { id: "b", issue: 2, priority: 2, dependencies: [], claims: ["db/migrations/2026"] },
      { id: "c", issue: 3, priority: 1, dependencies: [], claims: ["web/components"] },
      { id: "d", issue: 4, priority: 1, dependencies: ["a"], claims: ["api"] },
    ];
    const active: ScheduledWorkItem[] = [];
    let conflictObserved = false;
    const result = await runSchedule(items, 3, async (item) => {
      if (active.some((other) => claimsConflict(item.claims, other.claims))) conflictObserved = true;
      active.push(item);
      await sleep(15);
      active.splice(active.indexOf(item), 1);
    });
    assert.equal(conflictObserved, false);
    assert.ok(result.startOrder.indexOf("d") > result.startOrder.indexOf("a"));
    assert.equal(result.status.get("a"), "completed");
    assert.equal(result.status.get("b"), "completed");
    assert.equal(result.status.get("c"), "completed");
    assert.equal(result.status.get("d"), "completed");
  });

  it("releases a claim successor after a failed predecessor without blocking it semantically", async () => {
    const started: string[] = [];
    const result = await runSchedule([
      { id: "first", issue: 1, priority: 1, dependencies: [], claims: ["src/shared"] },
      { id: "second", issue: 2, priority: 1, dependencies: [], claims: ["src/shared"] },
    ], 1, async (item) => {
      started.push(item.id);
      if (item.id === "first") throw new Error("first failed");
    }, {
      serializationEdges: [{ predecessor: "first", successor: "second", overlappingClaims: ["src/shared"] }],
    });
    assert.deepEqual(started, ["first", "second"]);
    assert.equal(result.status.get("first"), "failed");
    assert.equal(result.status.get("second"), "completed");
  });

  it("emits typed wait reasons for claim serialization and clears them on dispatch", async () => {
    let release!: () => void;
    const waits: Array<[string, import("./scheduler.js").WaitReason | undefined]> = [];
    const schedule = runSchedule([
      { id: "first", issue: 1, priority: 1, dependencies: [], claims: ["src/shared"] },
      { id: "second", issue: 2, priority: 1, dependencies: [], claims: ["src/shared"] },
    ], 2, async (item) => {
      if (item.id === "first") await new Promise<void>((resolve) => { release = resolve; });
    }, {
      serializationEdges: [{ predecessor: "first", successor: "second", overlappingClaims: ["src/shared"] }],
      onEvent: (event) => waits.push([event.itemId ?? "", event.waitReasons?.get("second")]),
    });
    await sleep(5);
    assert.ok(waits.some(([, reason]) => reason?.kind === "claim-serialization"));
    release();
    const result = await schedule;
    assert.equal(result.status.get("second"), "completed");
  });

  it("materializes claim conflicts as stable DAG edges instead of static batches", () => {
    const materialized = materializeClaimDependencies([
      { id: "a", issue: 1, priority: 2, dependencies: [], claims: ["src/core"] },
      { id: "b", issue: 2, priority: 1, dependencies: [], claims: ["src/core/state"] },
      { id: "c", issue: 3, priority: 1, dependencies: [], claims: ["docs"] },
      { id: "d", issue: 4, priority: 1, dependencies: ["a"], claims: ["src/api"] },
    ]);
    assert.deepEqual(materialized.edges.map((edge) => [edge.predecessor, edge.successor]), [["a", "b"]]);
    const preview = buildSchedulePreview(materialized.items, materialized.edges);
    assert.deepEqual(preview.initialReady.map((item) => item.id), ["c", "a"]);
    assert.equal(preview.criticalPath.length, 2);
    assert.equal(preview.criticalPath[0]?.id, "a");
  });

  it("uses conservative glob scopes for accepted forms, uncertain segments, and boundaries", () => {
    const typescript = materializeClaimDependencies([
      { id: "glob", issue: 1, priority: 1, dependencies: [], claims: ["src/**/*.ts"] },
      { id: "concrete", issue: 2, priority: 1, dependencies: [], claims: ["src/foo.ts"] },
    ]);
    assert.deepEqual(typescript.edges, [{
      predecessor: "glob",
      successor: "concrete",
      overlappingClaims: ["src/**/*.ts ↔ src/foo.ts"],
    }]);

    const components = materializeClaimDependencies([
      { id: "glob", issue: 3, priority: 1, dependencies: [], claims: ["src/components/*.tsx"] },
      { id: "concrete", issue: 4, priority: 1, dependencies: [], claims: ["src/components/button.tsx"] },
    ]);
    assert.deepEqual(components.edges.map(({ predecessor, successor }) => [predecessor, successor]), [["glob", "concrete"]]);
    assert.equal(claimsConflict(["src/**/*.ts"], ["src/components/*.tsx"]), true);
    assert.equal(claimsConflict(["src/components/*.tsx"], ["src/api/*.ts"]), false);
    assert.equal(claimsConflict(["src/**/*.ts"], ["src2/foo.ts"]), false);
    assert.equal(claimsConflict(["src/components/*.tsx"], ["src/components2/button.tsx"]), false);
    assert.equal(claimsConflict(["src/foo*.ts"], ["src/foobar.ts"]), true);
    assert.equal(claimsConflict(["src/[ab].ts"], ["src/a.ts"]), true);
    assert.equal(claimsConflict(["src/{a,b}.ts"], ["src/b.ts"]), true);
    assert.equal(claimsConflict(["src/foo*.ts"], ["docs/foobar.ts"]), false);
    assert.equal(claimsConflict(["./SRC/components/"], ["src/components/button.tsx"]), true);
    assert.equal(claimsConflict(["component:repository"], ["component:repository"]), true);
    assert.equal(claimsConflict(["component:repository"], ["component:repository/subscope"]), false);
    assert.equal(claimsConflict(["component:repository"], ["src/repository"]), false);
    assert.equal(claimsConflict(["*.ts"], ["docs/readme.md"]), true);
  });

  it("serializes matching glob and concrete work while unrelated work uses available capacity", async () => {
    const globGate = deferredGate();
    const unrelatedGate = deferredGate();
    const items = [
      { id: "glob", issue: 1, priority: 1, dependencies: [], claims: ["src/**/*.ts"] },
      { id: "unrelated", issue: 2, priority: 1, dependencies: [], claims: ["docs"] },
      { id: "concrete", issue: 3, priority: 1, dependencies: [], claims: ["src/foo.ts"] },
    ];
    const byId = new Map(items.map((item) => [item.id, item]));
    const active = new Set<string>();
    const started: string[] = [];
    let maximumActive = 0;
    let conflictObserved = false;
    const schedule = runSchedule(items, 2, async (item) => {
      if ([...active].some((id) => claimsConflict(item.claims, byId.get(id)?.claims ?? []))) conflictObserved = true;
      active.add(item.id);
      started.push(item.id);
      maximumActive = Math.max(maximumActive, active.size);
      if (item.id === "glob") await globGate.promise;
      if (item.id === "unrelated") await unrelatedGate.promise;
      active.delete(item.id);
    });

    await sleep(5);
    assert.deepEqual(started, ["glob", "unrelated"]);
    assert.equal(maximumActive, 2);
    unrelatedGate.release();
    await sleep(5);
    assert.deepEqual(started, ["glob", "unrelated"]);
    globGate.release();
    await schedule;
    assert.deepEqual(started, ["glob", "unrelated", "concrete"]);
    assert.equal(conflictObserved, false);
  });

  it("promotes Build Packet paths and rejects a newly discovered active claim conflict", async () => {
    let releaseFirst!: () => void;
    const promoted: Array<[string, string[]]> = [];
    const resultPromise = runSchedule([
      { id: "first", issue: 1, priority: 1, dependencies: [], claims: [] },
      { id: "second", issue: 2, priority: 1, dependencies: [], claims: [] },
    ], 2, async (item, scheduler) => {
      await scheduler.promoteClaims([item.id === "first" ? "src/**/*.ts" : "src/foo.ts"]);
      if (item.id === "first") await new Promise<void>((resolve) => { releaseFirst = resolve; });
    }, { onClaimsPromoted: (id, claims) => { promoted.push([id, [...claims]]); } });
    await sleep(5);
    assert.deepEqual(promoted, [
      ["first", ["src/**/*.ts"]],
    ]);
    releaseFirst();
    const result = await resultPromise;
    assert.equal(result.status.get("first"), "completed");
    assert.equal(result.status.get("second"), "failed");
    assert.ok(result.errors.get("second") instanceof ClaimPromotionConflictError);
    assert.match(result.errors.get("second")?.message ?? "", /active work/);
    assert.equal(promoted.some(([id]) => id === "second"), false);
  });

  it("rolls back a dynamic claim when its durable sink rejects publication", async () => {
    const sinkError = new Error("claims sink rejected publication");
    const published: string[] = [];
    const result = await runSchedule([
      { id: "first", issue: 1, priority: 1, dependencies: [], claims: [] },
      { id: "second", issue: 2, priority: 1, dependencies: [], claims: [] },
    ], 2, async (_item, scheduler) => {
      scheduler.promoteClaims(["src/shared"]);
    }, {
      onClaimsPromoted: (itemId) => {
        if (itemId === "first") throw sinkError;
        published.push(itemId);
      },
    });

    assert.equal(result.status.get("first"), "failed");
    assert.equal(result.errors.get("first"), sinkError);
    assert.equal(result.status.get("second"), "completed");
    assert.deepEqual(published, ["second"]);
  });

  it("checks late claim promotion against workers that started afterward", async () => {
    let signalSecondPromoted!: () => void;
    const secondPromoted = new Promise<void>((resolve) => { signalSecondPromoted = resolve; });
    let signalFirstAttempted!: () => void;
    const firstAttempted = new Promise<void>((resolve) => { signalFirstAttempted = resolve; });
    let releaseSecond!: () => void;
    const keepSecondActive = new Promise<void>((resolve) => { releaseSecond = resolve; });

    const schedule = runSchedule([
      { id: "first", issue: 1, priority: 1, dependencies: [], claims: [] },
      { id: "second", issue: 2, priority: 1, dependencies: [], claims: [] },
    ], 2, async (item, scheduler) => {
      if (item.id === "first") {
        await secondPromoted;
        try {
          await scheduler.promoteClaims(["src/**/*.ts"]);
        } finally {
          signalFirstAttempted();
        }
        return;
      }
      await scheduler.promoteClaims(["src/foo.ts"]);
      signalSecondPromoted();
      await keepSecondActive;
    });

    await firstAttempted;
    releaseSecond();
    const result = await schedule;
    assert.equal(result.status.get("first"), "failed");
    assert.equal(result.status.get("second"), "completed");
    assert.match(result.errors.get("first")?.message ?? "", /active work/);
  });

  it("requeues a typed claim-conflict suspension until the active worker releases its promoted claim", async () => {
    const firstPromoted = deferredSignal();
    const secondSuspended = deferredSignal();
    const releaseFirst = deferredSignal();
    const attempts = new Map<string, number>();
    const events: Array<{ type: string; itemId?: string }> = [];

    const schedule = runSchedule([
      { id: "first", issue: 1, priority: 1, dependencies: [], claims: [] },
      { id: "second", issue: 2, priority: 1, dependencies: [], claims: [] },
    ], 2, async (scheduled, scheduler) => {
      attempts.set(scheduled.id, (attempts.get(scheduled.id) ?? 0) + 1);
      if (scheduled.id === "first") {
        await scheduler.promoteClaims(["src/shared"]);
        firstPromoted.resolve();
        await releaseFirst.promise;
        return;
      }
      await firstPromoted.promise;
      try {
        await scheduler.promoteClaims(["src/shared/file.ts"]);
      } catch (error) {
        if (!(error instanceof ClaimPromotionConflictError)) throw error;
        secondSuspended.resolve();
        return { status: "suspended", error };
      }
    }, {
      onEvent: (event) => events.push({ type: event.type, ...(event.itemId ? { itemId: event.itemId } : {}) }),
    });

    await secondSuspended.promise;
    releaseFirst.resolve();
    const result = await schedule;
    assert.equal(result.status.get("first"), "completed");
    assert.equal(result.status.get("second"), "completed");
    assert.equal(result.errors.has("second"), false);
    assert.equal(attempts.get("first"), 1);
    assert.equal(attempts.get("second"), 2);
    assert.deepEqual(result.startOrder, ["first", "second", "second"]);
    assert.ok(events.some((event) => event.type === "suspended" && event.itemId === "second"));
    assert.ok(events.some((event) => event.type === "resumed" && event.itemId === "second"));
  });

  it("streams a newly ready successor without waiting for an unrelated ready node", async () => {
    const releases = new Map<string, () => void>();
    const started: string[] = [];
    const schedule = runSchedule([
      { id: "a", issue: 1, priority: 1, dependencies: [], claims: [] },
      { id: "b", issue: 2, priority: 1, dependencies: [], claims: [] },
      { id: "d", issue: 4, priority: 1, dependencies: ["a"], claims: [] },
    ], 2, async (item) => {
      started.push(item.id);
      await new Promise<void>((resolve) => releases.set(item.id, resolve));
    });
    await sleep(5);
    assert.deepEqual(started, ["a", "b"]);
    releases.get("a")?.();
    await sleep(5);
    assert.deepEqual(started, ["a", "b", "d"]);
    releases.get("b")?.();
    releases.get("d")?.();
    await schedule;
  });

  it("keeps dependents queued while a recursive parent is suspended and emits lifecycle events", async () => {
    const events: string[] = [];
    const result = await runSchedule([
      { id: "parent", issue: 1, priority: 1, dependencies: [], claims: [] },
      { id: "child", issue: 2, priority: 1, dependencies: ["parent"], claims: [] },
    ], 1, async () => ({ status: "suspended", error: "children running" }), { onEvent: (event) => events.push(event.type) });
    assert.equal(result.status.get("parent"), "suspended");
    assert.equal(result.status.get("child"), "queued");
    assert.ok(events.includes("suspended"));
  });

  it("blocks on any failed dependency even when an earlier dependency is suspended", async () => {
    const result = await runSchedule([
      { id: "suspended", issue: 1, priority: 1, dependencies: [], claims: [] },
      { id: "failed", issue: 2, priority: 1, dependencies: [], claims: [] },
      { id: "dependent", issue: 3, priority: 1, dependencies: ["suspended", "failed"], claims: [] },
    ], 2, async (scheduled) => scheduled.id === "suspended"
      ? { status: "suspended", error: "durable recovery" }
      : { status: "failed", error: "terminal prerequisite failure" });

    assert.equal(result.status.get("suspended"), "suspended");
    assert.equal(result.status.get("failed"), "failed");
    assert.equal(result.status.get("dependent"), "blocked");
    assert.match(result.errors.get("dependent")?.message ?? "", /failed/);
    assert.equal(result.waitReasons?.has("dependent") ?? false, false);
  });

  it("turns a thrown lease continuity failure into suspension without dispatching dependents", async () => {
    const events: string[] = [];
    const result = await runSchedule([
      { id: "leased", issue: 1, priority: 1, dependencies: [], claims: [] },
      { id: "dependent", issue: 2, priority: 1, dependencies: ["leased"], claims: [] },
    ], 1, async () => {
      throw new LeaseContinuityError("retained checkpoint rolled back");
    }, { onEvent: (event) => events.push(event.type) });
    assert.equal(result.status.get("leased"), "suspended");
    assert.equal(result.status.get("dependent"), "queued");
    assert.deepEqual(result.startOrder, ["leased"]);
    assert.ok(events.includes("suspended"));
    assert.match(result.errors.get("leased")?.message ?? "", /continuity/i);
  });

  it("keeps decomposed work terminally skipped and blocks its frozen dependents", async () => {
    const events: string[] = [];
    const result = await runSchedule([
      { id: "parent", issue: 1, priority: 1, dependencies: [], claims: [] },
      { id: "dependent", issue: 2, priority: 1, dependencies: ["parent"], claims: [] },
    ], 1, async () => ({ status: "skipped", error: "authoritative child scope required" }), { onEvent: (event) => events.push(event.type) });
    assert.equal(result.status.get("parent"), "skipped");
    assert.equal(result.status.get("dependent"), "blocked");
    assert.match(result.errors.get("parent")?.message ?? "", /child scope/);
    assert.ok(events.includes("skipped"));
  });

  it("retains authoritative decomposition children for controller replanning", async () => {
    const result = await runSchedule([
      { id: "parent", issue: 1, priority: 1, dependencies: [], claims: [] },
    ], 1, async () => ({
      status: "skipped",
      error: "authoritative child scope required",
      childIssues: [11, 12],
    }));
    assert.deepEqual(result.decompositions && [...result.decompositions.entries()], [["parent", [11, 12]]]);
    assert.deepEqual(result.waitReasons?.get("parent"), { kind: "decomposition-replan", children: [11, 12] });
  });

  it("fails closed on duplicate decomposition child references", async () => {
    const result = await runSchedule([
      { id: "parent", issue: 1, priority: 1, dependencies: [], claims: [] },
    ], 1, async () => ({ status: "skipped", childIssues: [11, 11] }));
    assert.equal(result.status.get("parent"), "failed");
    assert.match(result.errors.get("parent")?.message ?? "", /duplicate child/);
  });

  it("keeps invalid investigations distinct and blocks their dependents", async () => {
    const events: string[] = [];
    const result = await runSchedule([
      { id: "invalid", issue: 1, priority: 1, dependencies: [], claims: [] },
      { id: "dependent", issue: 2, priority: 1, dependencies: ["invalid"], claims: [] },
    ], 1, async () => ({ status: "invalid", error: "issue already resolved" }), { onEvent: (event) => events.push(event.type) });
    assert.equal(result.status.get("invalid"), "invalid");
    assert.equal(result.status.get("dependent"), "blocked");
    assert.ok(events.includes("invalid"));
  });

  it("blocks dependents when a prerequisite fails", async () => {
    const result = await runSchedule([
      { id: "a", issue: 1, priority: 1, dependencies: [], claims: [] },
      { id: "b", issue: 2, priority: 1, dependencies: ["a"], claims: [] },
    ], 2, async (item) => { if (item.id === "a") throw new Error("failed"); });
    assert.equal(result.status.get("a"), "failed");
    assert.equal(result.status.get("b"), "blocked");
  });

  it("rejects unknown dependencies and cycles before dispatch", () => {
    assert.throws(() => validateGraph([{ id: "a", issue: 1, priority: 1, dependencies: ["missing"], claims: [] }]), /Unknown dependency/);
    assert.throws(() => validateGraph([
      { id: "a", issue: 1, priority: 1, dependencies: ["b"], claims: [] },
      { id: "b", issue: 2, priority: 1, dependencies: ["a"], claims: [] },
    ]), /Dependency cycle/);
  });
});

describe("worker leases", () => {
  it("prevents duplicate ownership and permits stale lease recovery", () => {
    const leases = new InMemoryLeaseRepository();
    const first = leases.acquire("issue-1", "worker-a", 100, 1_000);
    assert.ok(first);
    assert.equal(leases.acquire("issue-1", "worker-b", 100, 1_050), undefined);
    const recovered = leases.acquire("issue-1", "worker-b", 100, 1_101);
    assert.equal(recovered?.owner, "worker-b");
    assert.equal(leases.release("issue-1", first?.token ?? ""), false);
    assert.equal(leases.release("issue-1", recovered?.token ?? ""), true);
  });

  it("fails closed when the retained witness rolls back", () => {
    const witness = new InMemoryLeaseWitness();
    const leases = new InMemoryLeaseRepository(witness);
    const lease = leases.acquire("issue-rollback", "worker", 100, 1_000);
    assert.ok(lease);
    witness.rollback(0);
    assert.throws(() => leases.heartbeat("issue-rollback", lease.token, 100, 1_010), /unverifiable|rolled back/i);
    assert.throws(() => leases.release("issue-rollback", lease.token), /unverifiable|rolled back/i);
  });

  it("requires the current token for heartbeat", () => {
    const leases = new InMemoryLeaseRepository();
    const lease = leases.acquire("issue-2", "worker", 100, 1_000);
    assert.throws(() => leases.heartbeat("issue-2", "wrong", 100, 1_050), /another worker/);
    assert.equal(leases.heartbeat("issue-2", lease?.token ?? "", 100, 1_050).expiresAt, 1_150);
  });
});
