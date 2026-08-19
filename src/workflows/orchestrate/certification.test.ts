import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { uncoveredVerificationCommands } from "../work-on/verify.js";
import {
  buildSchedulePreview,
  ClaimPromotionConflictError,
  materializeClaimDependencies,
  runSchedule,
  type ClaimMaterializationDiagnostics,
  type ScheduledWorkItem,
} from "./scheduler.js";

interface DeferredSignal {
  promise: Promise<void>;
  resolve(): void;
}

function deferredSignal(): DeferredSignal {
  let resolve!: () => void;
  const promise = new Promise<void>((accept) => { resolve = accept; });
  return { promise, resolve };
}

function diagnostics(): ClaimMaterializationDiagnostics {
  return {
    conflictCandidates: 0,
    reachabilityChecks: 0,
    reachabilityNodeVisits: 0,
    frontierUpdates: 0,
  };
}

describe("non-mutating orchestration certification", () => {
  it("certifies 128 one-issue nodes against effective capacity and a sparse routed frontier", async (t) => {
    const nodeCount = 128;
    const routeCount = 8;
    const maxParallel = 11;
    const transportCapacity = 7;
    const items: ScheduledWorkItem[] = Array.from({ length: nodeCount }, (_, index) => {
      const route = index % routeCount;
      return {
        id: `cert-${index + 1}`,
        issue: 70_000 + index,
        priority: index % 4,
        dependencies: [],
        claims: ["src/shared"],
        repository: `owner/cert-route-${route}`,
        targetBranch: "main",
      };
    });
    const counters = diagnostics();
    const materialized = materializeClaimDependencies(items, counters);
    const preview = buildSchedulePreview(materialized.items, materialized.edges);

    assert.deepEqual(preview.issueSlots, { total: nodeCount, initialReady: routeCount });
    assert.equal(materialized.edges.length, nodeCount - routeCount);
    assert.ok(materialized.edges.length < nodeCount * 2, "claim serialization must stay linear, not become a dense pairwise graph");
    assert.ok(counters.conflictCandidates <= nodeCount);
    assert.ok(counters.reachabilityChecks <= nodeCount);
    assert.equal(counters.reachabilityNodeVisits, 0);
    assert.ok(counters.frontierUpdates <= nodeCount * 12);

    const full = deferredSignal();
    const release = deferredSignal();
    const dispatches = new Map<string, number>();
    const activeRoutes = new Set<string>();
    const firstWave: string[] = [];
    const observedCapacity: number[] = [];
    let active = 0;
    let maximumActive = 0;
    let sameRouteOverlap = false;

    const execution = runSchedule(materialized.items, maxParallel, async (item) => {
      dispatches.set(item.id, (dispatches.get(item.id) ?? 0) + 1);
      const route = item.repository!;
      if (activeRoutes.has(route)) sameRouteOverlap = true;
      activeRoutes.add(route);
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      if (firstWave.length < transportCapacity) firstWave.push(item.id);
      if (active === transportCapacity) full.resolve();
      await release.promise;
      active -= 1;
      activeRoutes.delete(route);
    }, {
      capacity: transportCapacity,
      serializationEdges: materialized.edges,
      onCapacityObserved: (capacity) => observedCapacity.push(capacity),
    });

    await full.promise;
    assert.equal(maximumActive, transportCapacity);
    assert.equal(new Set(firstWave.map((id) => items.find((item) => item.id === id)!.repository)).size, transportCapacity,
      "unrelated routes must stream while same-route successors wait");
    release.resolve();
    const result = await execution;

    assert.equal(sameRouteOverlap, false);
    assert.equal(maximumActive, Math.min(maxParallel, transportCapacity));
    assert.equal(result.observedCapacity, transportCapacity);
    assert.ok(observedCapacity.length >= nodeCount);
    assert.ok(observedCapacity.every((capacity) => capacity === transportCapacity));
    assert.equal(result.startOrder.length, nodeCount);
    assert.equal(new Set(result.startOrder).size, nodeCount);
    assert.equal(dispatches.size, nodeCount);
    assert.ok([...dispatches.values()].every((count) => count === 1));
    assert.ok([...result.status.values()].every((status) => status === "completed"));
    assert.equal(active, 0);
    t.diagnostic(JSON.stringify({
      nodes: nodeCount,
      dispatches: result.startOrder.length,
      maximumActive,
      effectiveCapacity: Math.min(maxParallel, transportCapacity),
      serializationEdges: materialized.edges.length,
      ...counters,
    }));
  });

  it("defers and retries a late promoted claim exactly once after its owner releases", async () => {
    const firstPromoted = deferredSignal();
    const secondDeferred = deferredSignal();
    const releaseFirst = deferredSignal();
    const attempts = new Map<string, number>();
    const lifecycle: string[] = [];

    const execution = runSchedule([
      { id: "promotion-owner", issue: 80_001, priority: 1, dependencies: [], claims: [], repository: "owner/repo", targetBranch: "main" },
      { id: "late-promotion", issue: 80_002, priority: 1, dependencies: [], claims: [], repository: "owner/repo", targetBranch: "main" },
    ], 2, async (item, context) => {
      attempts.set(item.id, (attempts.get(item.id) ?? 0) + 1);
      if (item.id === "promotion-owner") {
        await context.promoteClaims(["src/shared"]);
        firstPromoted.resolve();
        await releaseFirst.promise;
        return;
      }
      await firstPromoted.promise;
      try {
        await context.promoteClaims(["src/shared/file.ts"]);
      } catch (error) {
        assert.ok(error instanceof ClaimPromotionConflictError);
        secondDeferred.resolve();
        return { status: "suspended", error };
      }
    }, {
      onEvent: (event) => lifecycle.push(`${event.type}:${event.itemId ?? ""}`),
    });

    await secondDeferred.promise;
    releaseFirst.resolve();
    const result = await execution;

    assert.deepEqual(result.startOrder, ["promotion-owner", "late-promotion", "late-promotion"]);
    assert.deepEqual(Object.fromEntries(attempts), { "promotion-owner": 1, "late-promotion": 2 });
    assert.equal(result.status.get("promotion-owner"), "completed");
    assert.equal(result.status.get("late-promotion"), "completed");
    assert.equal(result.errors.has("late-promotion"), false);
    assert.ok(lifecycle.includes("suspended:late-promotion"));
    assert.ok(lifecycle.includes("resumed:late-promotion"));
  });

  it("blocks semantic dependents but releases claim-only successors without duplicate attempts", async () => {
    const items: ScheduledWorkItem[] = [
      { id: "failing-owner", issue: 81_001, priority: 1, dependencies: [], claims: ["src/failure"], repository: "owner/repo", targetBranch: "main" },
      { id: "claim-successor", issue: 81_002, priority: 1, dependencies: [], claims: ["src/failure/file.ts"], repository: "owner/repo", targetBranch: "main" },
      { id: "semantic-successor", issue: 81_003, priority: 1, dependencies: ["failing-owner"], claims: ["src/independent"], repository: "owner/repo", targetBranch: "main" },
    ];
    const materialized = materializeClaimDependencies(items);
    const attempts = new Map<string, number>();
    const result = await runSchedule(materialized.items, 3, async (item) => {
      attempts.set(item.id, (attempts.get(item.id) ?? 0) + 1);
      if (item.id === "failing-owner") return { status: "failed", error: "semantic verification failed" };
    }, { serializationEdges: materialized.edges });

    assert.equal(result.status.get("failing-owner"), "failed");
    assert.equal(result.status.get("claim-successor"), "completed");
    assert.equal(result.status.get("semantic-successor"), "blocked");
    assert.deepEqual(Object.fromEntries(attempts), { "failing-owner": 1, "claim-successor": 1 });
    assert.deepEqual(result.startOrder, ["failing-owner", "claim-successor"]);
  });

  it("keeps the certification verification plan scoped to its focused compiled modules", () => {
    const focused = {
      id: "orchestration-certification",
      command: "node",
      args: [
        "--test",
        "dist/workflows/orchestrate/certification.test.js",
        "dist/workflows/orchestrate/scheduler.test.js",
      ],
    } as const;
    const rendered = [focused.command, ...focused.args].join(" ");

    assert.deepEqual(uncoveredVerificationCommands([`Run \`${rendered}\`.`], [focused]), []);
    assert.deepEqual(uncoveredVerificationCommands(["Run `npm test`."], [focused]), ["npm test"]);
    assert.doesNotMatch(rendered, /(?:^|\s)npm(?:\.cmd)?\s+(?:run\s+)?(?:test|test:next)(?:\s|$)/i);
    assert.doesNotMatch(rendered, /dist\/\*\*\/\*\.test\.js/);
  });
});
