// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  findDurableOrchestrationIssueConflicts,
  findRunningOrchestrationIssueConflicts,
  OrchestrationIssueOwnershipConflictError,
  orchestrationRecordIssueNumbers,
  type OrchestrationNodeRecord,
  type OrchestrationRecord,
} from "./orchestration.js";
import { InMemoryOrchestrationRepository } from "./repositories.js";

function node(overrides: Partial<OrchestrationNodeRecord> = {}): OrchestrationNodeRecord {
  return {
    id: overrides.id ?? "issue-1000",
    issue: overrides.issue ?? 1000,
    priority: 1,
    dependencies: [],
    claims: [],
    status: "queued",
    childRunIds: [],
    ...overrides,
  };
}

function record(overrides: Partial<OrchestrationRecord> = {}): OrchestrationRecord {
  return {
    schema: "forgedock.orchestration/v1",
    orchestrationId: overrides.orchestrationId ?? "dag_active",
    repository: overrides.repository ?? "a/b",
    requestedIssueNumbers: overrides.requestedIssueNumbers ?? [1000],
    issueNumbers: overrides.issueNumbers ?? [1000],
    maxParallel: 1,
    autoMerge: true,
    status: "running",
    createdAt: "2026-08-18T00:00:00.000Z",
    updatedAt: "2026-08-18T00:00:00.000Z",
    nodes: overrides.nodes ?? [node()],
    ...overrides,
  };
}

test("durable orchestration ownership includes requested, contracted, batch, and decomposition issues", () => {
  const active = record({
    requestedIssueNumbers: [10],
    issueNumbers: [10],
    nodes: [node({
      issue: 900,
      memberIssues: [20, 21],
      decompositionChildren: [30],
      attempts: [{
        attemptId: "attempt-crash-window",
        attempt: 1,
        recovery: "initial",
        status: "skipped",
        startedAt: "2026-08-18T00:00:00.000Z",
        updatedAt: "2026-08-18T00:00:01.000Z",
        completedAt: "2026-08-18T00:00:01.000Z",
        decompositionChildren: [31],
      }],
    })],
  });

  assert.deepEqual(orchestrationRecordIssueNumbers(active), [10, 20, 21, 30, 31, 900]);
  assert.deepEqual(findRunningOrchestrationIssueConflicts([active], "A/B", [21, 900, 999]), [{
    orchestrationId: "dag_active",
    repository: "a/b",
    issueNumbers: [21, 900],
  }]);
  assert.deepEqual(findRunningOrchestrationIssueConflicts([
    active,
    record({ orchestrationId: "dag_complete", status: "completed", requestedIssueNumbers: [21] }),
    record({ orchestrationId: "dag_other_repo", repository: "c/d", requestedIssueNumbers: [21] }),
  ], "a/b", [21]), [{
    orchestrationId: "dag_active",
    repository: "a/b",
    issueNumbers: [21],
  }]);
});

test("durable conflict lookup follows running-DAG pages", async () => {
  const repository = new InMemoryOrchestrationRepository();
  await repository.createOrchestration(record({ orchestrationId: "dag_one", requestedIssueNumbers: [7] }));
  await repository.createOrchestration(record({ orchestrationId: "dag_two", requestedIssueNumbers: [8], issueNumbers: [8], nodes: [node({ id: "issue-8", issue: 8 })] }));

  const conflicts = await findDurableOrchestrationIssueConflicts(repository, "a/b", [8]);
  assert.deepEqual(conflicts.map((conflict) => conflict.orchestrationId), ["dag_two"]);
});

test("in-memory orchestration insert rejects overlap with an active generated batch", async () => {
  const repository = new InMemoryOrchestrationRepository();
  await repository.createOrchestration(record({
    orchestrationId: "dag_batch",
    requestedIssueNumbers: [7, 8],
    issueNumbers: [7, 8],
    nodes: [node({ id: "issue-900", issue: 900, memberIssues: [7, 8] })],
  }));

  await assert.rejects(
    repository.createOrchestration(record({ orchestrationId: "dag_duplicate", requestedIssueNumbers: [8] })),
    (error: unknown) => {
      assert.ok(error instanceof OrchestrationIssueOwnershipConflictError);
      assert.match((error as Error).message, /#8.*dag_batch/);
      return true;
    },
  );
});

test("in-memory orchestration save rejects scope acquired by another active DAG", async () => {
  const repository = new InMemoryOrchestrationRepository();
  await repository.createOrchestration(record({
    orchestrationId: "dag_parent",
    requestedIssueNumbers: [1],
    issueNumbers: [1],
    nodes: [node({ id: "issue-1", issue: 1 })],
  }));
  await repository.createOrchestration(record({
    orchestrationId: "dag_child_owner",
    requestedIssueNumbers: [2],
    issueNumbers: [2],
    nodes: [node({ id: "issue-2", issue: 2 })],
  }));
  const parent = (await repository.loadOrchestration("dag_parent"))!;
  parent.nodes[0]!.attempts = [{
    attemptId: "attempt-decomposed",
    attempt: 1,
    recovery: "initial",
    status: "skipped",
    startedAt: "2026-08-18T00:00:00.000Z",
    updatedAt: "2026-08-18T00:00:01.000Z",
    completedAt: "2026-08-18T00:00:01.000Z",
    decompositionChildren: [2],
  }];

  await assert.rejects(repository.saveOrchestration(parent), /#2.*dag_child_owner/);
});

test("in-memory orchestration insert permits overlapping terminal history", async () => {
  const repository = new InMemoryOrchestrationRepository();
  await repository.createOrchestration(record({ orchestrationId: "dag_active", requestedIssueNumbers: [7] }));
  await assert.doesNotReject(repository.createOrchestration(record({
    orchestrationId: "dag_historical",
    requestedIssueNumbers: [7],
    status: "completed",
  })));
});
