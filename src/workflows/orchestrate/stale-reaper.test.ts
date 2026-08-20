// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { InMemoryLeaseRepository } from "../../core/ports/lease.js";
import { InMemoryOrchestrationRepository } from "../../core/ports/repositories.js";
import type { OrchestrationRecord } from "../../core/ports/orchestration.js";
import { LeaseBackedOrchestrationExecutionAdmission } from "../../adapters/sqlite/orchestration-admission.js";
import { reapStaleOrchestrations } from "./stale-reaper.js";

function runningRecord(orchestrationId: string, executionAttempt = 1, issue = 7): OrchestrationRecord {
  return {
    schema: "forgedock.orchestration/v1",
    orchestrationId,
    repository: "owner/repo",
    requestedIssueNumbers: [issue],
    issueNumbers: [issue],
    maxParallel: 1,
    autoMerge: true,
    executionAttempt,
    executionClaimId: "old-claim",
    status: "running",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:30.000Z",
    nodes: [{
      id: `issue-${issue}`,
      issue,
      priority: 1,
      dependencies: [],
      claims: ["src/example"],
      status: "running",
      childRunIds: [`run-${issue}`],
      activeAttemptId: `attempt-${issue}`,
      attempts: [{
        attemptId: `attempt-${issue}`,
        attempt: 1,
        recovery: "initial",
        status: "running",
        startedAt: "2026-01-01T00:00:01.000Z",
        updatedAt: "2026-01-01T00:00:30.000Z",
        taskId: `task-${issue}`,
        runId: `run-${issue}`,
      }],
    }],
  };
}

function admission(leases: InMemoryLeaseRepository, owner: string, now: () => number): LeaseBackedOrchestrationExecutionAdmission {
  return new LeaseBackedOrchestrationExecutionAdmission(leases, {
    owner,
    ttlMs: 100,
    heartbeatMs: 50,
    now,
  });
}

describe("stale orchestration reaper", () => {
  it("lets exactly one fenced winner interrupt an expired controller and never dispatches", async () => {
    const repository = new InMemoryOrchestrationRepository();
    const leases = new InMemoryLeaseRepository();
    await repository.createOrchestration(runningRecord("dag-stale"));
    leases.acquire("orchestration-execution:dag-stale", "old-controller", 100, 1_000);
    let now = 1_101;
    const first = admission(leases, "reaper-a", () => now);
    const second = admission(leases, "reaper-b", () => now);

    const [left, right] = await Promise.all([
      reapStaleOrchestrations({ repository, executionAdmission: first, now: () => "2026-01-01T00:01:50.000Z" }),
      reapStaleOrchestrations({ repository, executionAdmission: second, now: () => "2026-01-01T00:01:50.000Z" }),
    ]);

    assert.equal(left.reaped.length + right.reaped.length, 1);
    assert.equal(left.skippedLive + right.skippedLive, 1);
    const persisted = await repository.loadOrchestration("dag-stale");
    assert.equal(persisted?.status, "running");
    assert.equal(persisted?.executionAttempt, 2);
    assert.match(persisted?.nodes[0]?.error ?? "", /lease expired/);
    assert.equal(persisted?.nodes[0]?.status, "retry_wait");
    assert.equal(persisted?.nodes[0]?.activeAttemptId, undefined);
    assert.equal(persisted?.nodes[0]?.attempts?.[0]?.status, "retry_wait");
    assert.equal(persisted?.nodes[0]?.waitReason?.kind, "retry");
    assert.equal(persisted?.nodes[0]?.waitReason?.domain, "lease");
    assert.equal(leases.inspect?.("orchestration-execution:dag-stale"), undefined);

    const again = await reapStaleOrchestrations({ repository, executionAdmission: first, now: () => "2026-01-01T00:02:00.000Z" });
    assert.equal(again.reaped.length, 0);
  });

  it("leaves live, terminal, and never-started records untouched", async () => {
    const repository = new InMemoryOrchestrationRepository();
    const leases = new InMemoryLeaseRepository();
    const live = runningRecord("dag-live");
    const terminal = { ...runningRecord("dag-terminal", 1, 8), status: "completed" as const };
    const neverStartedBase = runningRecord("dag-new", 0, 9);
    const { executionClaimId: _executionClaimId, ...neverStartedRecord } = neverStartedBase;
    const { activeAttemptId: _activeAttemptId, ...neverStartedNode } = neverStartedBase.nodes[0]!;
    const neverStarted: OrchestrationRecord = {
      ...neverStartedRecord,
      nodes: [{ ...neverStartedNode, status: "queued", attempts: [] }],
    };
    await repository.createOrchestration(live);
    await repository.createOrchestration(terminal);
    await repository.createOrchestration(neverStarted);
    leases.acquire("orchestration-execution:dag-live", "live-controller", 100, 2_000);

    const result = await reapStaleOrchestrations({
      repository,
      executionAdmission: admission(leases, "reaper", () => 2_050),
      now: () => "2026-01-01T00:02:50.000Z",
      staleAfterMs: 1_000_000,
    });

    assert.equal(result.reaped.length, 0);
    assert.equal(result.skippedLive, 1);
    assert.equal(result.skippedTerminal, 0);
    assert.equal(result.skippedUnstarted, 1);
    assert.equal((await repository.loadOrchestration("dag-live"))?.status, "running");
    assert.equal((await repository.loadOrchestration("dag-terminal"))?.status, "completed");
    assert.equal((await repository.loadOrchestration("dag-new"))?.status, "running");
  });

  it("reaps an old queued attempt-zero start marker but leaves fresh starts alone", async () => {
    const repository = new InMemoryOrchestrationRepository();
    const leases = new InMemoryLeaseRepository();
    const old = runningRecord("dag-old-start", 0);
    const fresh = { ...runningRecord("dag-fresh-start", 0, 8), updatedAt: "2026-01-01T00:01:59.500Z" };
    const { executionClaimId: _oldClaim, ...oldWithoutClaim } = old;
    const { activeAttemptId: _oldActive, ...oldWithoutActive } = old.nodes[0]!;
    const oldQueued: OrchestrationRecord = {
      ...oldWithoutClaim,
      nodes: [{ ...oldWithoutActive, status: "queued", attempts: [] }],
    };
    const { executionClaimId: _freshClaim, ...freshWithoutClaim } = fresh;
    const { activeAttemptId: _freshActive, ...freshWithoutActive } = fresh.nodes[0]!;
    const freshQueued: OrchestrationRecord = {
      ...freshWithoutClaim,
      nodes: [{ ...freshWithoutActive, status: "queued", attempts: [] }],
    };
    await repository.createOrchestration(oldQueued);
    await repository.createOrchestration(freshQueued);
    const result = await reapStaleOrchestrations({
      repository,
      executionAdmission: admission(leases, "reaper", () => 1_000),
      now: () => "2026-01-01T00:02:00.000Z",
      staleAfterMs: 1_000,
    });
    assert.equal(result.reaped.length, 1);
    assert.equal((await repository.loadOrchestration("dag-old-start"))?.status, "failed");
    assert.equal((await repository.loadOrchestration("dag-fresh-start"))?.status, "running");
    assert.equal(result.skippedUnstarted, 1);
  });

  it("reaps aged queued legacy records without execution attempts but skips fresh ones", async () => {
    const repository = new InMemoryOrchestrationRepository();
    const leases = new InMemoryLeaseRepository();
    const old = runningRecord("dag-legacy-old", 1, 10);
    const fresh = { ...runningRecord("dag-legacy-fresh", 1, 11), updatedAt: "2026-01-01T00:01:59.500Z" };
    const { executionAttempt: _oldAttempt, executionClaimId: _oldClaim, ...oldLegacyBase } = old;
    const { activeAttemptId: _oldActive, ...oldLegacyNode } = old.nodes[0]!;
    const oldLegacy: OrchestrationRecord = {
      ...oldLegacyBase,
      nodes: [{ ...oldLegacyNode, status: "queued", attempts: [] }],
    };
    const { executionAttempt: _freshAttempt, executionClaimId: _freshClaim, ...freshLegacyBase } = fresh;
    const { activeAttemptId: _freshActive, ...freshLegacyNode } = fresh.nodes[0]!;
    const freshLegacy: OrchestrationRecord = {
      ...freshLegacyBase,
      nodes: [{ ...freshLegacyNode, status: "queued", attempts: [] }],
    };
    await repository.createOrchestration(oldLegacy);
    await repository.createOrchestration(freshLegacy);

    const result = await reapStaleOrchestrations({
      repository,
      executionAdmission: admission(leases, "reaper", () => 1_000),
      now: () => "2026-01-01T00:02:00.000Z",
      staleAfterMs: 1_000,
    });

    const recovered = await repository.loadOrchestration("dag-legacy-old");
    assert.equal(result.reaped.length, 1);
    assert.equal(result.skippedUnstarted, 1);
    assert.equal(recovered?.status, "failed");
    assert.equal(recovered?.executionAttempt, 1);
    assert.equal(recovered?.executionClaimId !== undefined, true);
    assert.equal(recovered?.nodes[0]?.status, "queued");
    assert.equal((await repository.loadOrchestration("dag-legacy-fresh"))?.status, "running");
  });

  it("releases the winner after a persistence crash so the next status pass can retry", async () => {
    class FailOnceRepository extends InMemoryOrchestrationRepository {
      fail = true;
      override async saveOrchestration(record: OrchestrationRecord): Promise<void> {
        if (this.fail) {
          this.fail = false;
          throw new Error("simulated stale-reaper persistence crash");
        }
        await super.saveOrchestration(record);
      }
    }
    const repository = new FailOnceRepository();
    const leases = new InMemoryLeaseRepository();
    await repository.createOrchestration(runningRecord("dag-crash"));
    leases.acquire("orchestration-execution:dag-crash", "old-controller", 100, 3_000);
    const now = () => 3_101;
    const executionAdmission = admission(leases, "reaper", now);

    await assert.rejects(
      reapStaleOrchestrations({ repository, executionAdmission, now: () => "2026-01-01T00:03:50.000Z" }),
      /simulated stale-reaper persistence crash/,
    );
    assert.equal(leases.inspect?.("orchestration-execution:dag-crash"), undefined);
    const retry = await reapStaleOrchestrations({ repository, executionAdmission, now: () => "2026-01-01T00:04:00.000Z" });
    assert.equal(retry.reaped.length, 1);
    assert.equal((await repository.loadOrchestration("dag-crash"))?.status, "running");
  });

  it("rejects a late stale controller save after reaping advances the execution attempt", async () => {
    const repository = new InMemoryOrchestrationRepository();
    const leases = new InMemoryLeaseRepository();
    const record = runningRecord("dag-fence");
    await repository.createOrchestration(record);
    leases.acquire("orchestration-execution:dag-fence", "old-controller", 100, 4_000);
    const executionAdmission = admission(leases, "reaper", () => 4_101);
    await reapStaleOrchestrations({ repository, executionAdmission, now: () => "2026-01-01T00:04:50.000Z" });

    await assert.rejects(
      repository.saveOrchestration({ ...record, status: "completed", updatedAt: "2026-01-01T00:05:00.000Z" }),
      /Stale orchestration update.*behind persisted attempt/,
    );
    assert.equal((await repository.loadOrchestration("dag-fence"))?.status, "running");
  });

  it("rejects a same-attempt save from a different controller claim in memory", async () => {
    const repository = new InMemoryOrchestrationRepository();
    const record = { ...runningRecord("dag-claim-fence"), executionClaimId: "claim-a" };
    await repository.createOrchestration(record);
    await assert.rejects(
      repository.saveOrchestration({ ...record, executionClaimId: "claim-b", status: "completed" }),
      /Conflicting orchestration claim/,
    );
  });

  it("bounds running-record pages", async () => {
    const repository = new InMemoryOrchestrationRepository();
    await assert.rejects(repository.listRunningOrchestrations(0), /page limit/);
    await assert.rejects(repository.listRunningOrchestrations(101), /page limit/);
  });
});
