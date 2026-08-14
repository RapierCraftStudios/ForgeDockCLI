import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { InMemoryLeaseWitness } from "../../core/ports/lease.js";
import { buildSchedulePreview, claimsConflict, InMemoryLeaseRepository, LeaseContinuityError, materializeClaimDependencies, runSchedule, validateGraph, type ScheduledWorkItem } from "./scheduler.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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

  it("promotes Build Packet paths and rejects a newly discovered active claim conflict", async () => {
    let releaseFirst!: () => void;
    const promoted: Array<[string, string[]]> = [];
    const resultPromise = runSchedule([
      { id: "first", issue: 1, priority: 1, dependencies: [], claims: [] },
      { id: "second", issue: 2, priority: 1, dependencies: [], claims: [] },
    ], 2, async (item, scheduler) => {
      scheduler.promoteClaims(["src/shared"]);
      if (item.id === "first") await new Promise<void>((resolve) => { releaseFirst = resolve; });
    }, { onClaimsPromoted: (id, claims) => promoted.push([id, [...claims]]) });
    await sleep(5);
    assert.deepEqual(promoted, [["first", ["src/shared"]]]);
    releaseFirst();
    const result = await resultPromise;
    assert.equal(result.status.get("first"), "completed");
    assert.equal(result.status.get("second"), "failed");
    assert.match(result.errors.get("second")?.message ?? "", /active work/);
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
