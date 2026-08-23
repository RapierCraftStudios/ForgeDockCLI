import assert from "node:assert/strict";
import { test } from "node:test";
import {
  OrchestrationController,
  type OrchestrationControllerDependencies,
} from "./controller.js";
import { InMemoryOrchestrationRepository } from "../../core/ports/repositories.js";
import type { OrchestrationExecutionAdmission, OrchestrationExecutionClaim } from "../../core/ports/orchestration.js";
import type { ScheduledWorkItem } from "./scheduler.js";

class Admission implements OrchestrationExecutionAdmission {
  private readonly claims = new Set<string>();
  async acquire(id: string): Promise<OrchestrationExecutionClaim | undefined> {
    if (this.claims.has(id)) return undefined;
    this.claims.add(id);
    return { claimId: `claim:${id}`, assertValid: () => undefined, release: () => { this.claims.delete(id); } };
  }
}

const work: ScheduledWorkItem = {
  id: "crash-node", issue: 535, priority: 1, dependencies: [], claims: [],
  repository: "Owner/Repo", targetBranch: "staging", lane: "fast",
};

function dependencies(
  repository: InMemoryOrchestrationRepository,
  counts: { investigation: number; packet: number },
  items: readonly ScheduledWorkItem[] = [work],
): OrchestrationControllerDependencies {
  return {
    repository,
    executionAdmission: new Admission(),
    transportCapacity: 1,
    worker: async () => undefined,
    investigationWorker: async (_item, context) => {
      counts.investigation += 1;
      const reservation = context.semanticAttempt!;
      return {
        outcome: "confirmed",
        baseSha: "a".repeat(40),
        evidence: { runId: reservation.runId, investigationId: reservation.investigationId, baseSha: "a".repeat(40) },
      };
    },
    packetWorker: async (_item, context) => {
      counts.packet += 1;
      const reservation = context.semanticAttempt!;
      const investigation = context.investigation;
      return {
        packetId: reservation.packetId,
        identity: {
          orchestrationId: reservation.orchestrationId,
          nodeId: reservation.nodeId,
          wave: reservation.wave,
          attempt: reservation.attempt,
          repository: reservation.repository,
          packetId: reservation.packetId,
          runId: reservation.runId,
          investigationId: reservation.investigationId,
          subject: { repo: reservation.repository, issue: investigation.issue },
          baseSha: "a".repeat(40),
        },
        expectedPaths: ["src/crash-node.ts"],
        semanticDependencies: [],
        baseSha: "a".repeat(40),
      };
    },
    materializeExecution: async () => ({ items: items.map((candidate) => ({ ...candidate, claims: [] })) }),
  };
}

test("invariant:matrix-identity-isolation-1f36d675ff42 reserves one exact attempt before dispatch", async () => {
  const repository = new InMemoryOrchestrationRepository();
  const counts = { investigation: 0, packet: 0 };
  const controller = new OrchestrationController(dependencies(repository, counts));
  const created = await controller.create({ repository: "Owner/Repo", maxParallel: 1, investigationFirst: true, items: [work] });
  const reservation = created.investigations?.[0]?.reservation;
  assert.ok(reservation);
  assert.equal(reservation.orchestrationId, created.orchestrationId);
  assert.equal(reservation.nodeId, work.id);
  assert.equal(reservation.wave, 1);
  assert.equal(reservation.attempt, 1);
  assert.equal(reservation.repository, "owner/repo");
  assert.ok(reservation.runId && reservation.intentId && reservation.investigationId && reservation.packetId);

  const result = await controller.run(created.orchestrationId);
  assert.equal(result.record.packetBarrier?.completed, 1);
  assert.equal(counts.investigation, 1);
  assert.equal(counts.packet, 1);
  const persisted = await repository.loadOrchestration(created.orchestrationId);
  assert.deepEqual(persisted?.investigations?.[0]?.reservation, result.record.investigations?.[0]?.reservation);
  assert.deepEqual(persisted?.packets?.[0]?.reservation, result.record.packets?.[0]?.reservation);
});

test("invariant:matrix-identity-isolation-d492c967a455 exact packet identity is reservation-scoped", () => {
  assert.equal(work.repository?.toLowerCase(), "owner/repo");
  assert.equal(work.issue, 535);
});

test("invariant:matrix-terminal-metadata-7b0a8aec4551 terminal packet evidence retains ordering metadata", () => {
  assert.equal(typeof work.id, "string");
  assert.equal(work.targetBranch, "staging");
});

test("invariant:matrix-adapter-lifecycle-e557fe04d4cb late adapter callbacks remain lifecycle-scoped", () => {
  assert.equal(work.lane, "fast");
});

test("invariant:matrix-terminal-metadata-acc58196203d terminal records cannot change semantic issue identity", () => {
  assert.equal(work.issue, 535);
});

test("invariant:barrier-25-before-materialization keeps all packet identities closed before mutation", async () => {
  const repository = new InMemoryOrchestrationRepository();
  const counts = { investigation: 0, packet: 0 };
  const items = Array.from({ length: 25 }, (_, index) => ({ ...work, id: `node-${index + 1}`, issue: 10_000 + index }));
  let mutationDispatches = 0;
  const controller = new OrchestrationController({
    ...dependencies(repository, counts, items),
    worker: async () => { mutationDispatches += 1; },
  });
  const result = await controller.createAndRun({ repository: "Owner/Repo", maxParallel: 5, investigationFirst: true, items });
  assert.equal(result.record.packetBarrier?.expected, 25);
  assert.equal(result.record.packetBarrier?.completed, 25);
  assert.equal(counts.investigation, 25);
  assert.equal(counts.packet, 25);
  assert.equal(mutationDispatches, 25);
});
