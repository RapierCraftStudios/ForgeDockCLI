import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { InMemoryLeaseWitness } from "../../core/ports/lease.js";
import { buildSchedulePreview, ClaimPromotionConflictError, claimsConflict, InMemoryLeaseRepository, LeaseContinuityError, materializeClaimDependencies, runSchedule, validateGraph, type ScheduledWorkItem } from "./scheduler.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for scheduler state");
    await sleep(2);
  }
}

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
  it("treats maxParallel as issue slots for contracted nodes", async () => {
    const gates = new Map(["batch-a", "single", "batch-b"].map((id) => [id, deferredGate()] as const));
    const started: string[] = [];
    const activeSlots = new Map<string, number>();
    let maximumSlots = 0;
    const execution = runSchedule([
      { id: "batch-a", issue: 10, priority: 1, dependencies: [], claims: [], memberIssues: [1, 2] },
      { id: "single", issue: 20, priority: 1, dependencies: [], claims: [], memberIssues: [3] },
      { id: "batch-b", issue: 30, priority: 1, dependencies: [], claims: [], memberIssues: [4, 5] },
    ], 3, async (scheduled) => {
      const slots = scheduled.memberIssues?.length ?? 1;
      started.push(scheduled.id);
      activeSlots.set(scheduled.id, slots);
      maximumSlots = Math.max(maximumSlots, [...activeSlots.values()].reduce((sum, value) => sum + value, 0));
      await gates.get(scheduled.id)!.promise;
      activeSlots.delete(scheduled.id);
    });

    await waitFor(() => started.length === 2);
    assert.deepEqual(started, ["batch-a", "single"]);
    gates.get("single")!.release();
    await sleep(10);
    assert.deepEqual(started, ["batch-a", "single"], "two occupied issue slots leave no room for another two-member batch");
    gates.get("batch-a")!.release();
    await waitFor(() => started.length === 3);
    assert.deepEqual(started, ["batch-a", "single", "batch-b"]);
    gates.get("batch-b")!.release();
    const result = await execution;
    assert.equal(maximumSlots, 3);
    assert.ok([...result.status.values()].every((status) => status === "completed"));
  });

  it("precomputes issue-slot weights while polling queued work", async () => {
    const reads = new Map<string, number>();
    const weightedItem = (id: string, issue: number, memberIssues: readonly number[]): ScheduledWorkItem => {
      const value: ScheduledWorkItem = { id, issue, priority: issue, dependencies: [], claims: [] };
      Object.defineProperty(value, "memberIssues", {
        enumerable: true,
        get() {
          reads.set(id, (reads.get(id) ?? 0) + 1);
          return memberIssues;
        },
      });
      return value;
    };
    const firstGate = deferredGate();
    let capacitySamples = 0;
    const execution = runSchedule([
      weightedItem("first", 1, [1, 2]),
      weightedItem("second", 2, [3, 4]),
    ], 2, async (scheduled) => {
      if (scheduled.id === "first") await firstGate.promise;
    }, {
      capacity: () => { capacitySamples++; return 2; },
      capacityPollMs: 2,
    });

    try {
      await waitFor(() => capacitySamples >= 4);
      const readsAfterAdmission = [...reads.values()].reduce((sum, count) => sum + count, 0);
      await waitFor(() => capacitySamples >= 8);
      assert.equal(
        [...reads.values()].reduce((sum, count) => sum + count, 0),
        readsAfterAdmission,
        "capacity polling must use the validated slot index rather than rescan active and queued items",
      );
    } finally {
      firstGate.release();
    }
    assert.ok([...(await execution).status.values()].every((status) => status === "completed"));
  });

  it("backpressures a live capacity drop and resumes queued work when slots return", async () => {
    let available = 2;
    const gates = new Map(["a", "b", "c", "d"].map((id) => [id, deferredGate()] as const));
    const started: string[] = [];
    let active = 0;
    let maximumActive = 0;
    const execution = runSchedule(
      ["a", "b", "c", "d"].map((id, index) => ({ id, issue: index + 1, priority: index + 1, dependencies: [], claims: [] })),
      4,
      async (item) => {
        started.push(item.id);
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await gates.get(item.id)!.promise;
        active -= 1;
      },
      { capacity: () => available, capacityPollMs: 5 },
    );

    while (started.length !== 2) await new Promise<void>((resolve) => setTimeout(resolve, 2));
    assert.deepEqual(started, ["a", "b"]);
    available = 0;
    gates.get("a")!.release();
    await new Promise<void>((resolve) => setTimeout(resolve, 30));
    assert.deepEqual(started, ["a", "b"], "a capacity drop must not launch a worker or fail the queued node");

    available = 2;
    while (started.length < 3) await new Promise<void>((resolve) => setTimeout(resolve, 2));
    assert.deepEqual(started, ["a", "b", "c"]);
    available = 0;
    gates.get("b")!.release();
    await new Promise<void>((resolve) => setTimeout(resolve, 30));
    assert.deepEqual(started, ["a", "b", "c"]);
    available = 1;
    gates.get("c")!.release();
    gates.get("d")!.release();
    const result = await execution;
    assert.deepEqual(result.startOrder, ["a", "b", "c", "d"]);
    assert.ok([...result.status.values()].every((status) => status === "completed"));
    assert.equal(maximumActive, 2);
  });

  it("emits and deduplicates dynamic capacity wait reasons before dispatch", async () => {
    let available = 0;
    let capacitySamples = 0;
    const events: Array<{ type: string; reason: import("./scheduler.js").WaitReason | undefined }> = [];
    const execution = runSchedule(
      [{ id: "waiting", issue: 1, priority: 1, dependencies: [], claims: [] }],
      1,
      async () => undefined,
      {
        capacity: () => { capacitySamples++; return available; },
        capacityPollMs: 2,
        onEvent: (event) => events.push({ type: event.type, reason: event.waitReasons?.get("waiting") }),
      },
    );

    await waitFor(() => capacitySamples >= 4);
    assert.equal(events.filter(({ reason }) => reason?.kind === "capacity").length, 1);
    assert.deepEqual(events.find(({ reason }) => reason?.kind === "capacity")?.reason, { kind: "capacity", maxParallel: 0 });
    available = 1;
    await execution;
    const capacityIndex = events.findIndex(({ reason }) => reason?.kind === "capacity");
    const startedIndex = events.findIndex(({ type, reason }) => type === "started" && reason === undefined);
    assert.ok(capacityIndex >= 0 && startedIndex > capacityIndex);
  });

  it("allows a permanently unavailable transport queue to be cancelled", async () => {
    const abort = new AbortController();
    const execution = runSchedule(
      [{ id: "waiting", issue: 1, priority: 1, dependencies: [], claims: [] }],
      1,
      async () => { throw new Error("transport must not launch while capacity is zero"); },
      { capacity: () => 0, capacityPollMs: 5, signal: abort.signal },
    );
    setTimeout(() => abort.abort(new Error("transport capacity wait cancelled")), 20);
    await assert.rejects(execution, /transport capacity wait cancelled/);
  });

  it("retains ownership after cancellation until a fixed-capacity worker settles", async () => {
    const abort = new AbortController();
    const started = deferredSignal();
    const gate = deferredGate();
    const execution = runSchedule(
      [{ id: "running", issue: 1, priority: 1, dependencies: [], claims: [] }],
      1,
      async () => {
        started.resolve();
        await gate.promise;
      },
      { capacity: 1, signal: abort.signal },
    );
    let settled = false;
    void execution.then(
      () => { settled = true; },
      () => { settled = true; },
    );

    await started.promise;
    abort.abort(new Error("fixed worker wait cancelled"));
    await sleep(20);
    assert.equal(settled, false, "scheduler must retain ownership while an admitted worker is still active");
    gate.release();
    await assert.rejects(execution, /fixed worker wait cancelled/);
  });

  it("drains a 500-node fleet without duplicate dispatches, orphaned work, or exceeding capacity", async () => {
    const maxParallel = 20;
    const items: ScheduledWorkItem[] = Array.from({ length: 500 }, (_, index) => ({
      id: `fleet-${index + 1}`,
      issue: 10_000 + index,
      priority: index % 4,
      dependencies: index >= 100 && index % 5 === 0 ? [`fleet-${index - 99}`] : [],
      claims: [`fleet/scope-${index + 1}`],
    }));
    const dispatches = new Map<string, number>();
    let active = 0;
    let maximumActive = 0;

    const result = await runSchedule(items, maxParallel, async (item) => {
      dispatches.set(item.id, (dispatches.get(item.id) ?? 0) + 1);
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise<void>((resolve) => setImmediate(resolve));
      active -= 1;
    });

    assert.equal(result.status.size, 500);
    assert.equal(result.startOrder.length, 500);
    assert.equal(new Set(result.startOrder).size, 500);
    assert.equal(dispatches.size, 500);
    assert.ok([...dispatches.values()].every((count) => count === 1));
    assert.ok([...result.status.values()].every((status) => status === "completed"));
    assert.ok(maximumActive > 1);
    assert.ok(maximumActive <= maxParallel);
    assert.equal(active, 0);
  });

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

  it("emits and clears a dispatch-time active claim wait reason", async () => {
    const firstGate = deferredGate();
    const events: Array<{ type: string; itemId: string | undefined; reason: import("./scheduler.js").WaitReason | undefined }> = [];
    const schedule = runSchedule([
      { id: "first", issue: 1, priority: 1, dependencies: [], claims: ["src/shared"] },
      { id: "second", issue: 2, priority: 1, dependencies: [], claims: ["src/shared/file.ts"] },
    ], 2, async (scheduled) => {
      if (scheduled.id === "first") await firstGate.promise;
    }, {
      serializationEdges: [],
      onEvent: (event) => events.push({
        type: event.type,
        itemId: event.itemId,
        reason: event.waitReasons?.get("second"),
      }),
    });

    await waitFor(() => events.some(({ reason }) => reason?.kind === "active-claim-conflict"));
    assert.equal(events.filter(({ reason }) => reason?.kind === "active-claim-conflict").length, 1);
    assert.deepEqual(events.find(({ reason }) => reason?.kind === "active-claim-conflict")?.reason, {
      kind: "active-claim-conflict",
      node: "first",
      claims: ["src/shared/file.ts ↔ src/shared"],
    });
    firstGate.release();
    await schedule;
    const waitingIndex = events.findIndex(({ reason }) => reason?.kind === "active-claim-conflict");
    const startedIndex = events.findIndex(({ type, itemId, reason }) =>
      type === "started" && itemId === "second" && reason === undefined,
    );
    assert.ok(waitingIndex >= 0 && startedIndex > waitingIndex);
  });

  it("serializes overlapping claims only on the same known repository and target route", () => {
    const sameRoute = materializeClaimDependencies([
      { id: "same-a", issue: 1, priority: 1, dependencies: [], claims: ["src/shared"], repository: "Owner/Repo", targetBranch: "main" },
      { id: "same-b", issue: 2, priority: 1, dependencies: [], claims: ["src/shared/file.ts"], repository: "owner/repo", targetBranch: "main" },
    ]);
    assert.deepEqual(sameRoute.edges.map(({ predecessor, successor }) => [predecessor, successor]), [["same-a", "same-b"]]);
    assert.deepEqual(sameRoute.items.map((item) => item.dependencies), [[], []], "claim ordering must remain release-only");

    const isolatedRoutes = materializeClaimDependencies([
      { id: "repo-a", issue: 3, priority: 1, dependencies: [], claims: ["src/shared"], repository: "owner/repo-a", targetBranch: "main" },
      { id: "repo-b", issue: 4, priority: 1, dependencies: [], claims: ["src/shared"], repository: "owner/repo-b", targetBranch: "main" },
      { id: "target-b", issue: 5, priority: 1, dependencies: [], claims: ["src/shared"], repository: "owner/repo-a", targetBranch: "release" },
    ]);
    assert.deepEqual(isolatedRoutes.edges, []);
  });

  it("keeps missing legacy repository or target evidence conservative", () => {
    const materialized = materializeClaimDependencies([
      { id: "known", issue: 1, priority: 1, dependencies: [], claims: ["src/shared"], repository: "owner/repo", targetBranch: "main" },
      { id: "missing-repository", issue: 2, priority: 1, dependencies: [], claims: ["src/shared"], targetBranch: "other" },
      { id: "missing-target", issue: 3, priority: 1, dependencies: [], claims: ["src/shared"], repository: "other/repo" },
    ]);
    assert.deepEqual(materialized.edges.map(({ predecessor, successor }) => [predecessor, successor]), [
      ["known", "missing-repository"],
      ["missing-repository", "missing-target"],
    ]);
  });

  it("keeps known unrelated routes streaming while same-route overlap waits", async () => {
    const firstGate = deferredGate();
    const otherGate = deferredGate();
    const started: string[] = [];
    const schedule = runSchedule([
      { id: "same-first", issue: 1, priority: 1, dependencies: [], claims: ["src/shared"], repository: "owner/repo", targetBranch: "main" },
      { id: "same-second", issue: 2, priority: 1, dependencies: [], claims: ["src/shared/file.ts"], repository: "owner/repo", targetBranch: "main" },
      { id: "other-repo", issue: 3, priority: 1, dependencies: [], claims: ["src/shared"], repository: "owner/other", targetBranch: "main" },
    ], 3, async (scheduled) => {
      started.push(scheduled.id);
      if (scheduled.id === "same-first") await firstGate.promise;
      if (scheduled.id === "other-repo") await otherGate.promise;
    });

    await waitFor(() => started.length === 2);
    assert.deepEqual(started, ["same-first", "other-repo"]);
    firstGate.release();
    await waitFor(() => started.length === 3);
    assert.deepEqual(started, ["same-first", "other-repo", "same-second"]);
    otherGate.release();
    await schedule;
  });

  it("allows promoted overlapping claims on different known targets", async () => {
    const promoted: string[] = [];
    const result = await runSchedule([
      { id: "main", issue: 1, priority: 1, dependencies: [], claims: [], repository: "owner/repo", targetBranch: "main" },
      { id: "release", issue: 2, priority: 1, dependencies: [], claims: [], repository: "owner/repo", targetBranch: "release" },
    ], 2, async (_scheduled, scheduler) => {
      await scheduler.promoteClaims(["src/shared"]);
    }, { onClaimsPromoted: (id) => { promoted.push(id); } });
    assert.deepEqual(promoted.sort(), ["main", "release"]);
    assert.ok([...result.status.values()].every((status) => status === "completed"));
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
    assert.deepEqual(preview.issueSlots, { total: 4, initialReady: 2 });
  });

  it("keeps unrelated known route partitions off the claim frontier", () => {
    const count = 500;
    const diagnostics = { conflictCandidates: 0, reachabilityChecks: 0, reachabilityNodeVisits: 0, frontierUpdates: 0 };
    const materialized = materializeClaimDependencies(Array.from({ length: count }, (_, index) => ({
      id: `route-${index}`,
      issue: index + 1,
      priority: 1,
      dependencies: [],
      claims: ["src/shared"],
      repository: `owner/repo-${index}`,
      targetBranch: "main",
    })), diagnostics);
    assert.deepEqual(materialized.edges, []);
    assert.equal(diagnostics.conflictCandidates, 0);
    assert.equal(diagnostics.reachabilityChecks, 0);
  });

  it("keeps dense shared fallback claims sparse and dispatches every node exactly once", async () => {
    const items: ScheduledWorkItem[] = Array.from({ length: 500 }, (_, index) => ({
      id: `shared-${index + 1}`,
      issue: 20_000 + index,
      priority: index % 3,
      dependencies: [],
      claims: ["component:repository", "*"],
    }));
    const materialized = materializeClaimDependencies(items);

    // Both claims conflict for every pair, but one immediate predecessor per
    // resource is sufficient to preserve the canonical issue ordering.
    assert.equal(materialized.edges.length, items.length - 1);
    assert.equal(new Set(materialized.edges.map((edge) => `${edge.predecessor}->${edge.successor}`)).size, items.length - 1);
    assert.deepEqual(materialized.edges.slice(0, 2).map(({ predecessor, successor }) => [predecessor, successor]), [
      ["shared-1", "shared-2"],
      ["shared-2", "shared-3"],
    ]);
    assert.deepEqual(materialized.edges.at(-1) && [materialized.edges.at(-1)!.predecessor, materialized.edges.at(-1)!.successor], ["shared-499", "shared-500"]);
    assert.ok(materialized.edges.every((edge) => edge.overlappingClaims.includes("component:repository ↔ component:repository")));
    assert.deepEqual(materialized.items.map((item) => item.dependencies), items.map((item) => item.dependencies));

    const dispatches = new Map<string, number>();
    const result = await runSchedule(materialized.items, 20, async (item) => {
      dispatches.set(item.id, (dispatches.get(item.id) ?? 0) + 1);
    }, { serializationEdges: materialized.edges });
    assert.equal(result.startOrder.length, items.length);
    assert.equal(dispatches.size, items.length);
    assert.ok([...dispatches.values()].every((count) => count === 1));
    assert.ok([...result.status.values()].every((status) => status === "completed"));
  });

  it("keeps repeated broad and unique descendant claims on a bounded frontier", () => {
    const count = 1_000;
    const items: ScheduledWorkItem[] = Array.from({ length: count }, (_, index) => ({
      id: `frontier-${index + 1}`,
      issue: 30_000 + index,
      priority: 1,
      dependencies: [],
      claims: ["*", `src/frontier-${index + 1}/file.ts`],
    }));
    const diagnostics = { conflictCandidates: 0, reachabilityChecks: 0, reachabilityNodeVisits: 0, frontierUpdates: 0 };
    const materialized = materializeClaimDependencies(items, diagnostics);

    // Every broad claim conflicts with every prior descendant claim, but the
    // broad frontier reaches those holders through the preceding chain. The
    // edge count therefore stays linear even with 1,000 sparse descendants.
    assert.equal(materialized.edges.length, count - 1);
    assert.deepEqual(materialized.edges.slice(0, 2).map(({ predecessor, successor }) => [predecessor, successor]), [
      ["frontier-1", "frontier-2"],
      ["frontier-2", "frontier-3"],
    ]);
    assert.deepEqual(materialized.edges.at(-1) && [materialized.edges.at(-1)!.predecessor, materialized.edges.at(-1)!.successor], [
      `frontier-${count - 1}`,
      `frontier-${count}`,
    ]);
    // The old implementation produced the same sparse edges but recursively
    // walked the growing trie/derived chain. These structural counters prove
    // the materializer examines only a constant-size frontier per item.
    assert.ok(diagnostics.conflictCandidates <= count * 2);
    assert.ok(diagnostics.reachabilityChecks <= count * 2);
    assert.ok(diagnostics.reachabilityNodeVisits <= count);
    assert.ok(diagnostics.frontierUpdates <= count * 12);
  });

  it("materializes a late broad scope without pairwise descendant traversal", () => {
    const count = 1_000;
    const items: ScheduledWorkItem[] = Array.from({ length: count }, (_, index) => ({
      id: `unique-${index + 1}`,
      issue: 40_000 + index,
      priority: 1,
      dependencies: [],
      claims: [`src/unique-${index + 1}/file.ts`],
    }));
    items.push({ id: "broad", issue: 50_000, priority: 1, dependencies: [], claims: ["src"] });
    const diagnostics = { conflictCandidates: 0, reachabilityChecks: 0, reachabilityNodeVisits: 0, frontierUpdates: 0 };
    const materialized = materializeClaimDependencies(items, diagnostics);

    // Every unique holder needs one edge to the late broad holder, but finding
    // that irreducible frontier must remain linear rather than comparing every
    // pair of independent descendants.
    assert.equal(materialized.edges.length, count);
    assert.ok(materialized.edges.every((edge) => edge.successor === "broad"));
    assert.ok(diagnostics.conflictCandidates <= count);
    assert.ok(diagnostics.reachabilityChecks <= count);
    assert.equal(diagnostics.reachabilityNodeVisits, 0);
    assert.ok(diagnostics.frontierUpdates <= count * 8);
  });

  it("orders claim materialization topologically when issue numbers run backward", () => {
    const materialized = materializeClaimDependencies([
      { id: "a", issue: 1, priority: 1, dependencies: ["b"], claims: ["src/shared"] },
      { id: "b", issue: 2, priority: 1, dependencies: [], claims: ["src/shared"] },
    ]);
    assert.deepEqual(materialized.edges, []);
    assert.deepEqual(materialized.items.map((item) => item.dependencies), [["b"], []]);
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
      { id: "first", issue: 1, priority: 1, dependencies: [], claims: [], repository: "owner/repo", targetBranch: "main" },
      { id: "second", issue: 2, priority: 1, dependencies: [], claims: [], repository: "owner/repo", targetBranch: "main" },
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
      await scheduler.promoteClaims(["src/shared"]);
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
    let deferredMessage = "";

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
        deferredMessage = error.message;
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
    assert.match(deferredMessage, /deferred.*scheduler will retry automatically after release/);
    assert.doesNotMatch(deferredMessage, /explicit.*resume|resume required/i);
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

  it("keeps a merge-admission blocker distinct from an awaiting-human suspension", async () => {
    const result = await runSchedule([
      { id: "merge-gate", issue: 1, priority: 1, dependencies: [], claims: [] },
      { id: "dependent", issue: 2, priority: 1, dependencies: ["merge-gate"], claims: [] },
    ], 1, async (item) => item.id === "merge-gate"
      ? { status: "blocked", error: "GitHub mergeability query is unavailable" }
      : undefined);
    assert.equal(result.status.get("merge-gate"), "blocked");
    assert.equal(result.status.get("dependent"), "blocked");
    assert.equal(result.errors.get("merge-gate")?.message, "GitHub mergeability query is unavailable");
    assert.equal(result.errors.get("dependent")?.message.includes("merge-gate"), true);
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

it("completes a 1,000-node mixed-route fleet with bounded recovery concurrency", async () => {
  const items = Array.from({ length: 1_000 }, (_, index) => ({
    id: `node-${index}`,
    issue: index + 1,
    priority: index % 7,
    dependencies: [] as string[],
    claims: [`scope/${index % 11}`],
    repository: "owner/repo",
    targetBranch: index % 2 === 0 ? "staging" : `release/${index % 5}`,
  }));
  const graph = materializeClaimDependencies(items);
  const attempts = new Map<string, number>();
  let active = 0;
  let maximumActive = 0;
  const result = await runSchedule(graph.items, 8, async (scheduled) => {
    const attempt = (attempts.get(scheduled.id) ?? 0) + 1;
    attempts.set(scheduled.id, attempt);
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    active -= 1;
    return attempt === 1 && scheduled.issue % 10 === 0
      ? { status: "target_recovery", attempt: 1, maxAttempts: 2 }
      : { status: "completed" };
  }, { serializationEdges: graph.edges });
  assert.equal(result.status.size, 1_000);
  assert.equal([...result.status.values()].every((status) => status === "completed"), true);
  assert.ok(maximumActive <= 8);
  assert.equal(Math.max(...attempts.values()), 2);
  assert.equal(attempts.size, 1_000);
});

it("caps repeated authoritative attempt-one target recovery outcomes monotonically", async () => {
  let calls = 0;
  const events: string[] = [];
  const result = await runSchedule([
    { id: "loop-shape", issue: 1, priority: 1, dependencies: [], claims: [] },
  ], 1, async () => {
    calls += 1;
    return { status: "target_recovery", attempt: 1, maxAttempts: 3 };
  }, { onEvent: (event) => { if (event.itemId) events.push(`${event.type}:${event.itemId}`); } });
  assert.equal(calls, 3);
  assert.equal(result.status.get("loop-shape"), "failed");
  assert.equal(events.filter((event) => event === "failed:loop-shape").length, 1);
  assert.equal(events.filter((event) => event === "resumed:loop-shape").length, 2);
});

it("caps repeated retry-wait target movement attempt-one outcomes", async () => {
  let calls = 0;
  const result = await runSchedule([
    { id: "retry-loop-shape", issue: 2, priority: 1, dependencies: [], claims: [] },
  ], 1, async () => {
    calls += 1;
    return {
      status: "retry_wait",
      attempt: 1,
      maxAttempts: 3,
      retryCode: "target-advanced",
      retryable: true,
      nextAttemptAt: new Date().toISOString(),
    };
  });
  assert.equal(calls, 3);
  assert.equal(result.status.get("retry-loop-shape"), "failed");
});

  it("uses durable target recovery attempt metadata across restart", async () => {
    let calls = 0;
  const result = await runSchedule([
    { id: "resumed", issue: 1, priority: 1, dependencies: [], claims: [] },
  ], 1, async () => {
    calls += 1;
    return calls === 1
      ? { status: "target_recovery", attempt: 2, maxAttempts: 3 }
      : { status: "target_recovery", attempt: 3, maxAttempts: 3 };
  });
  assert.equal(calls, 2);
  assert.equal(result.status.get("resumed"), "failed");
});

it("aborts a long retry wait without dispatching", async () => {
  const signal = new AbortController();
  let calls = 0;
  const execution = runSchedule([
    { id: "retry", issue: 1, priority: 1, dependencies: [], claims: [], retryNextAt: new Date(Date.now() + 60_000).toISOString(), retryAttempt: 1, retryMaxAttempts: 3 },
  ], 1, async () => { calls++; return { status: "completed" }; }, { signal: signal.signal });
  setTimeout(() => signal.abort(new Error("cancel retry wait")), 10);
  await assert.rejects(execution, /cancel retry wait/);
  assert.equal(calls, 0);
});

it("aborts a dynamic retry result wait without redispatching", async () => {
  const signal = new AbortController();
  let calls = 0;
  const execution = runSchedule([
    { id: "dynamic-retry", issue: 1, priority: 1, dependencies: [], claims: [] },
  ], 1, async () => {
    calls++;
    return { status: "retry_wait", nextAttemptAt: new Date(Date.now() + 60_000).toISOString(), attempt: 1, maxAttempts: 3 };
  }, { signal: signal.signal });
  await waitFor(() => calls === 1);
  signal.abort(new Error("cancel dynamic retry wait"));
  await assert.rejects(execution, /cancel dynamic retry wait/);
  assert.equal(calls, 1);
});

it("aborts a long target recovery wait without redispatching", async () => {
  const signal = new AbortController();
  let calls = 0;
  const execution = runSchedule([
    { id: "target", issue: 1, priority: 1, dependencies: [], claims: [] },
  ], 1, async () => {
    calls++;
    return { status: "target_recovery", nextAttemptAt: new Date(Date.now() + 60_000).toISOString(), attempt: 1, maxAttempts: 3 };
  }, { signal: signal.signal });
  await waitFor(() => calls === 1);
  signal.abort(new Error("cancel target wait"));
  await assert.rejects(execution, /cancel target wait/);
  assert.equal(calls, 1);
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

  it("expires mutation authority even while the holder token remains current", () => {
    const leases = new InMemoryLeaseRepository();
    let now = 1_050;
    const lease = leases.acquire("issue-guard", "worker-a", 100, 1_000);
    assert.ok(lease);
    const guard = leases.guard("issue-guard", lease.token, () => now);

    assert.doesNotThrow(() => guard.assertValid());
    now = 1_100;
    assert.throws(() => guard.check(), /expired/i);
    const inspection = leases.inspect?.("issue-guard");
    assert.equal(inspection?.owner, lease.owner, "guard expiry must retain redacted takeover evidence");
    assert.equal("token" in (inspection ?? {}), false);
    assert.equal(leases.acquire("issue-guard", "worker-b", 100, now)?.owner, "worker-b");
  });

  it("retains a non-secret node binding for live reconciliation and changes it only after expiry", () => {
    const leases = new InMemoryLeaseRepository();
    const first = leases.acquire("issue-recovery", "old-worker", 100, 1_000, {
      binding: "orchestration:dag-1:attempt:old:item:issue-recovery",
      recovery: "initial",
    });
    assert.equal(first?.binding, "orchestration:dag-1:attempt:old:item:issue-recovery");
    assert.equal(leases.inspect?.("issue-recovery")?.binding, first?.binding);
    assert.equal(leases.acquire("issue-recovery", "new-worker", 100, 1_050, {
      binding: "orchestration:dag-1:attempt:new:item:issue-recovery",
      recovery: "resume",
    }), undefined, "recovery must not steal a live heartbeat");
    const recovered = leases.acquire("issue-recovery", "new-worker", 100, 1_101, {
      binding: "orchestration:dag-1:attempt:new:item:issue-recovery",
      recovery: "relaunch",
    });
    assert.equal(recovered?.binding, "orchestration:dag-1:attempt:new:item:issue-recovery");
    assert.equal(leases.release("issue-recovery", first?.token ?? ""), false);
    assert.equal(leases.release("issue-recovery", recovered?.token ?? ""), true);
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
