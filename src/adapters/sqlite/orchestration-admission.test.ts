// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { InMemoryLeaseRepository, InMemoryLeaseWitness } from "../../core/ports/lease.js";
import type { OrchestrationRecord, OrchestrationRepository } from "../../core/ports/orchestration.js";
import { InMemoryOrchestrationRepository } from "../../core/ports/repositories.js";
import { OrchestrationController } from "../../workflows/orchestrate/controller.js";
import { LeaseBackedOrchestrationExecutionAdmission } from "./orchestration-admission.js";
import { SqliteRepositories } from "./sqlite-repositories.js";

describe("lease-backed orchestration execution admission", () => {
  it("never exposes the secret lease token in its durable claim identity", async () => {
    const inner = new InMemoryLeaseRepository();
    let holderToken = "";
    const leases = {
      acquire(itemId: string, owner: string, ttlMs: number, now?: number) {
        const lease = inner.acquire(itemId, owner, ttlMs, now);
        holderToken = lease?.token ?? "";
        return lease;
      },
      heartbeat: inner.heartbeat.bind(inner),
      release: inner.release.bind(inner),
      guard: inner.guard.bind(inner),
      reEnroll: inner.reEnroll.bind(inner),
      continuity: inner.continuity.bind(inner),
    };
    const admission = new LeaseBackedOrchestrationExecutionAdmission(leases);
    const claim = await admission.acquire("dag-secret");
    assert.ok(claim);
    assert.ok(holderToken);
    assert.equal(claim.claimId.includes(holderToken), false);
    assert.match(claim.claimId, /^\d+:[a-f0-9]{16}$/);
    await claim.release();
  });

  it("never exposes the secret lease token in claim failures", async () => {
    const inner = new InMemoryLeaseRepository();
    let holderToken = "";
    const leases = {
      acquire(itemId: string, owner: string, ttlMs: number, now?: number) {
        const lease = inner.acquire(itemId, owner, ttlMs, now);
        holderToken = lease?.token ?? "";
        return lease;
      },
      inspect: inner.inspect.bind(inner),
      heartbeat: inner.heartbeat.bind(inner),
      release: inner.release.bind(inner),
      guard: inner.guard.bind(inner),
      reEnroll: inner.reEnroll.bind(inner),
      continuity: inner.continuity.bind(inner),
    };
    let now = 1_000;
    const admission = new LeaseBackedOrchestrationExecutionAdmission(leases, { owner: "first", ttlMs: 100, heartbeatMs: 50, now: () => now });
    const claim = await admission.acquire("dag-secret-error");
    assert.ok(claim);
    assert.ok(holderToken);
    assert.equal("token" in (inner.inspect?.("orchestration-execution:dag-secret-error") ?? {}), false);
    now = 1_101;
    inner.acquire("orchestration-execution:dag-secret-error", "replacement", 100, now);
    assert.throws(() => claim.assertValid(), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /claim/);
      assert.equal(error.message.includes(holderToken), false);
      return true;
    });
    await claim.release();
  });

  it("refuses an unfenced repository before writing durable state", async () => {
    const leases = new InMemoryLeaseRepository();
    const admission = new LeaseBackedOrchestrationExecutionAdmission(leases, { owner: "unfenced-test" });
    const claim = await admission.acquire("dag-unfenced");
    assert.ok(claim);
    const backing = new InMemoryOrchestrationRepository();
    let writes = 0;
    const unfenced: OrchestrationRepository = {
      createOrchestration: (record) => backing.createOrchestration(record),
      loadOrchestration: (id) => backing.loadOrchestration(id),
      saveOrchestration: async (record: OrchestrationRecord) => { writes++; await backing.saveOrchestration(record); },
      listOrchestrations: (limit) => backing.listOrchestrations(limit),
      listRunningOrchestrations: (limit, before) => backing.listRunningOrchestrations(limit, before),
    };
    assert.ok(claim.persist);
    await assert.rejects(
      claim.persist(unfenced, {
        schema: "forgedock.orchestration/v1",
        orchestrationId: "dag-unfenced",
        repository: "a/b",
        issueNumbers: [],
        maxParallel: 1,
        autoMerge: true,
        executionAttempt: 1,
        executionClaimId: claim.claimId,
        status: "failed",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:01.000Z",
        nodes: [],
      }),
      /atomic fenced repository.*refused/i,
    );
    assert.equal(writes, 0);
    await claim.release();
  });

  it("persists only the non-secret claim identity in the orchestration record", async () => {
    const inner = new InMemoryLeaseRepository();
    let holderToken = "";
    const leases = {
      acquire(itemId: string, owner: string, ttlMs: number, now?: number) {
        const lease = inner.acquire(itemId, owner, ttlMs, now);
        holderToken = lease?.token ?? "";
        return lease;
      },
      heartbeat: inner.heartbeat.bind(inner),
      release: inner.release.bind(inner),
      guard: inner.guard.bind(inner),
      reEnroll: inner.reEnroll.bind(inner),
      continuity: inner.continuity.bind(inner),
    };
    const repository = new InMemoryOrchestrationRepository();
    const controller = new OrchestrationController({
      repository,
      executionAdmission: new LeaseBackedOrchestrationExecutionAdmission(leases),
      transportCapacity: 1,
      worker: async () => undefined,
    });

    const result = await controller.createAndRun({
      orchestrationId: "dag-persisted-secret",
      repository: "owner/repo",
      maxParallel: 1,
      items: [{ id: "issue-7", issue: 7, priority: 1, dependencies: [], claims: [] }],
    });
    const persisted = await repository.loadOrchestration(result.orchestrationId);

    assert.ok(holderToken);
    assert.ok(persisted?.executionClaimId);
    assert.equal(persisted.executionClaimId.includes(holderToken), false);
    assert.match(persisted.executionClaimId, /^\d+:[a-f0-9]{16}$/);
  });

  it("fences concurrent controllers across SQLite repository instances", async () => {
    const directory = mkdtempSync(join(tmpdir(), "forgedock-orchestration-admission-"));
    const path = join(directory, "state.db");
    const witness = new InMemoryLeaseWitness();
    const firstStore = new SqliteRepositories(path, { witness });
    const secondStore = new SqliteRepositories(path, { witness });
    try {
      const firstAdmission = new LeaseBackedOrchestrationExecutionAdmission(firstStore);
      const secondAdmission = new LeaseBackedOrchestrationExecutionAdmission(secondStore);
      const first = await firstAdmission.acquire("dag-one");
      assert.ok(first);
      assert.equal(await secondAdmission.acquire("dag-one"), undefined);
      first.assertValid();
      await first.release();
      const replacement = await secondAdmission.acquire("dag-one");
      assert.ok(replacement);
      replacement.assertValid();
      await replacement.release();
    } finally {
      firstStore.close();
      secondStore.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("fences cross-process semantic stop and preserves queued successors", async () => {
    const directory = mkdtempSync(join(tmpdir(), "forgedock-orchestration-stop-"));
    const path = join(directory, "state.db");
    const witness = new InMemoryLeaseWitness();
    const firstStore = new SqliteRepositories(path, { witness });
    const secondStore = new SqliteRepositories(path, { witness });
    try {
      const firstAdmission = new LeaseBackedOrchestrationExecutionAdmission(firstStore, { owner: "first-controller" });
      const secondAdmission = new LeaseBackedOrchestrationExecutionAdmission(secondStore, { owner: "stop-controller" });
      const firstController = new OrchestrationController({
        repository: firstStore,
        executionAdmission: firstAdmission,
        transportCapacity: 1,
        worker: async () => undefined,
      });
      await firstController.create({
        orchestrationId: "dag-cross-process-stop",
        repository: "owner/repo",
        maxParallel: 1,
        items: [
          { id: "root", issue: 1, priority: 1, dependencies: [], claims: [] },
          { id: "successor", issue: 2, priority: 2, dependencies: ["root"], claims: [] },
        ],
      });
      const liveClaim = await firstAdmission.acquire("dag-cross-process-stop");
      assert.ok(liveClaim);
      const stopController = new OrchestrationController({
        repository: secondStore,
        executionAdmission: secondAdmission,
        transportCapacity: 1,
        worker: async () => undefined,
      });
      await assert.rejects(
        stopController.stop("dag-cross-process-stop", true),
        /active orchestration execution|Stop the owning controller/i,
      );
      assert.equal((await secondStore.loadOrchestration("dag-cross-process-stop"))?.status, "running");
      await liveClaim.release();
      const stopped = await stopController.stop("dag-cross-process-stop", true);
      assert.equal(stopped.status, "cancelled");
      assert.deepEqual(stopped.nodes.map((node) => node.status), ["queued", "queued"]);
      assert.equal(stopped.nodes[1]?.attempts?.length ?? 0, 0, "semantic successor must never launch");
      assert.ok(liveClaim.persist);
      await assert.rejects(
        liveClaim.persist(firstStore, { ...stopped, status: "failed", updatedAt: "2030-01-01T00:00:02.000Z" }),
        /released|stale|continuity/i,
      );
    } finally {
      firstStore.close();
      secondStore.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it("does not let a local-stop fallback overwrite a newer controller claim", async () => {
    const directory = mkdtempSync(join(tmpdir(), "forgedock-orchestration-stop-race-"));
    const path = join(directory, "state.db");
    const witness = new InMemoryLeaseWitness();
    const firstStore = new SqliteRepositories(path, { witness });
    const secondStore = new SqliteRepositories(path, { witness });
    try {
      const firstAdmission = new LeaseBackedOrchestrationExecutionAdmission(firstStore, { owner: "first-controller" });
      const secondAdmission = new LeaseBackedOrchestrationExecutionAdmission(secondStore, { owner: "second-controller" });
      const creator = new OrchestrationController({ repository: firstStore, executionAdmission: firstAdmission, transportCapacity: 1, worker: async () => undefined });
      await creator.create({
        orchestrationId: "dag-local-stop-race",
        repository: "owner/repo",
        maxParallel: 1,
        items: [{ id: "root", issue: 1, priority: 1, dependencies: [], claims: [] }],
      });
      const firstClaim = await firstAdmission.acquire("dag-local-stop-race");
      assert.ok(firstClaim);
      const stopper = new OrchestrationController({ repository: secondStore, executionAdmission: secondAdmission, transportCapacity: 1, worker: async () => undefined });
      const controls = (stopper as any).executions as Map<string, { abort: AbortController; stopRequested: boolean }>;
      controls.set("dag-local-stop-race", { abort: new AbortController(), stopRequested: false });
      const stopping = stopper.stop("dag-local-stop-race", true);
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      await firstClaim.release();
      const replacement = await secondAdmission.acquire("dag-local-stop-race");
      assert.ok(replacement);
      replacement.assertValid();
      const current = await secondStore.loadOrchestration("dag-local-stop-race");
      assert.ok(current);
      await replacement.persist?.(secondStore, { ...current, executionClaimId: replacement.claimId, updatedAt: "2030-01-01T00:00:02.000Z" });
      controls.delete("dag-local-stop-race");
      await assert.rejects(stopping, /already active in another controller|owning controller/i);
      assert.equal((await secondStore.loadOrchestration("dag-local-stop-race"))?.status, "running");
      await replacement.release();
    } finally {
      firstStore.close();
      secondStore.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it("fails closed when a claim expires before its next heartbeat", async () => {
    const store = new SqliteRepositories(":memory:", { witness: new InMemoryLeaseWitness() });
    let now = 1_000;
    try {
      const admission = new LeaseBackedOrchestrationExecutionAdmission(store, {
        ttlMs: 100,
        heartbeatMs: 90,
        now: () => now,
      });
      const claim = await admission.acquire("dag-expired");
      assert.ok(claim);
      now = 1_101;
      assert.throws(() => claim.assertValid(), /expired|continuity/i);
      await claim.release();
    } finally {
      store.close();
    }
  });

  it("reports non-secret holder and expiry diagnostics for status surfaces", async () => {
    const leases = new InMemoryLeaseRepository();
    let now = 1_000;
    leases.acquire("orchestration-execution:dag-diagnostics", "controller-owner", 100, now);
    const admission = new LeaseBackedOrchestrationExecutionAdmission(leases, { now: () => now });

    assert.deepEqual(await admission.describe?.("dag-diagnostics"), {
      state: "active",
      owner: "controller-owner",
      heartbeatAt: 1_000,
      expiresAt: 1_100,
    });
    now = 1_101;
    assert.deepEqual(await admission.describe?.("dag-diagnostics"), {
      state: "expired",
      owner: "controller-owner",
      heartbeatAt: 1_000,
      expiresAt: 1_100,
    });
    assert.deepEqual(await admission.describe?.("dag-absent"), { state: "absent" });
  });
});
