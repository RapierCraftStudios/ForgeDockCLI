// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  findDurableOrchestrationIssueConflicts,
  findRunningOrchestrationIssueConflicts,
  OrchestrationIssueOwnershipConflictError,
  orchestrationRecordIssueIdentities,
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

test("durable orchestration ownership qualifies nodes, members, and decomposition by repository", () => {
  const active = record({
    requestedIssueNumbers: [10],
    issueNumbers: [10],
    nodes: [
      node({ id: "legacy-root", issue: 11 }),
      node({
        id: "remote-work",
        repository: "C/D",
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
      }),
    ],
  });

  assert.deepEqual(orchestrationRecordIssueIdentities(active), [
    { repository: "a/b", issue: 10 },
    { repository: "a/b", issue: 11 },
    { repository: "c/d", issue: 20 },
    { repository: "c/d", issue: 21 },
    { repository: "c/d", issue: 30 },
    { repository: "c/d", issue: 31 },
    { repository: "c/d", issue: 900 },
  ]);
  assert.deepEqual(orchestrationRecordIssueNumbers(active), [10, 11, 20, 21, 30, 31, 900]);
  assert.deepEqual(findRunningOrchestrationIssueConflicts([active], [
    { repository: "c/d", issue: 21 },
    { repository: "C/D", issue: 900 },
    { repository: "a/b", issue: 900 },
  ]), [{
    orchestrationId: "dag_active",
    repository: "c/d",
    issueNumbers: [21, 900],
  }]);
  assert.deepEqual(findRunningOrchestrationIssueConflicts([active], "a/b", [900]), []);
  assert.deepEqual(findRunningOrchestrationIssueConflicts([
    active,
    record({ orchestrationId: "dag_complete", status: "completed", repository: "c/d", requestedIssueNumbers: [21] }),
    record({ orchestrationId: "dag_other_repo", repository: "e/f", requestedIssueNumbers: [21] }),
  ], "c/d", [21]), [{
    orchestrationId: "dag_active",
    repository: "c/d",
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

test("in-memory create admits only one concurrent owner of a qualified remote node", async () => {
  const repository = new InMemoryOrchestrationRepository();
  const proposal = (orchestrationId: string, rootIssue: number): OrchestrationRecord => record({
    orchestrationId,
    repository: "owner/control",
    requestedIssueNumbers: [rootIssue],
    issueNumbers: [rootIssue],
    nodes: [node({ id: `${orchestrationId}-remote-700`, repository: "OWNER/WORK", issue: 700 })],
  });
  const outcomes = await Promise.allSettled([
    repository.createOrchestration(proposal("dag_contender_a", 2)),
    repository.createOrchestration(proposal("dag_contender_b", 3)),
  ]);

  assert.equal(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 1);
  const rejected = outcomes.find((outcome) => outcome.status === "rejected");
  assert.ok(rejected);
  assert.ok(rejected.reason instanceof OrchestrationIssueOwnershipConflictError);
  const winnerId = outcomes[0]?.status === "fulfilled" ? "dag_contender_a" : "dag_contender_b";
  assert.deepEqual(rejected.reason.conflicts, [{
    orchestrationId: winnerId,
    repository: "owner/work",
    issueNumbers: [700],
  }]);
  assert.equal(repository.records.size, 1);
});

test("in-memory create isolates equal issue numbers across root and remote repositories", async () => {
  const repository = new InMemoryOrchestrationRepository();
  await repository.createOrchestration(record({
    orchestrationId: "dag_remote_owner",
    repository: "owner/control",
    requestedIssueNumbers: [1],
    issueNumbers: [1],
    nodes: [node({ id: "remote-7", repository: "owner/work", issue: 7 })],
  }));

  await assert.doesNotReject(repository.createOrchestration(record({
    orchestrationId: "dag_root-7",
    repository: "owner/control",
    requestedIssueNumbers: [7],
    issueNumbers: [7],
    nodes: [node({ id: "root-7", issue: 7 })],
  })));
});

test("in-memory create ignores terminal ownership history for qualified identities", async () => {
  const repository = new InMemoryOrchestrationRepository();
  await repository.createOrchestration(record({
    orchestrationId: "dag_terminal_remote",
    repository: "owner/control",
    requestedIssueNumbers: [800],
    issueNumbers: [800],
    status: "completed",
    nodes: [node({ id: "terminal-801", repository: "owner/work", issue: 801, status: "completed" })],
  }));

  await assert.doesNotReject(repository.createOrchestration(record({
    orchestrationId: "dag_running_remote",
    repository: "owner/control",
    requestedIssueNumbers: [800],
    issueNumbers: [800],
    nodes: [node({ id: "running-801", repository: "owner/work", issue: 801 })],
  })));
});

test("in-memory save rejects qualified member and decomposition ownership atomically", async () => {
  const repository = new InMemoryOrchestrationRepository();
  await repository.createOrchestration(record({
    orchestrationId: "dag_member_owner",
    repository: "owner/control",
    requestedIssueNumbers: [400],
    issueNumbers: [400],
    nodes: [node({ id: "member-owner", repository: "owner/work", issue: 500, memberIssues: [501] })],
  }));
  await repository.createOrchestration(record({
    orchestrationId: "dag_decomposition_owner",
    repository: "owner/control",
    requestedIssueNumbers: [600],
    issueNumbers: [600],
    nodes: [node({ id: "decomposition-owner", repository: "owner/work", issue: 610, decompositionChildren: [611] })],
  }));
  await repository.createOrchestration(record({
    orchestrationId: "dag_candidate",
    repository: "owner/control",
    requestedIssueNumbers: [410],
    issueNumbers: [410],
    nodes: [node({ id: "candidate", repository: "owner/work", issue: 510 })],
  }));

  const candidate = (await repository.loadOrchestration("dag_candidate"))!;
  const beforeMemberUpdate = structuredClone(candidate);
  candidate.nodes[0]!.memberIssues = [501];
  await assert.rejects(repository.saveOrchestration(candidate), (error: unknown) => {
    if (!(error instanceof OrchestrationIssueOwnershipConflictError)) return false;
    assert.deepEqual(error.conflicts, [{
      orchestrationId: "dag_member_owner",
      repository: "owner/work",
      issueNumbers: [501],
    }]);
    return true;
  });
  assert.deepEqual(await repository.loadOrchestration("dag_candidate"), beforeMemberUpdate);

  const candidateForDecomposition = (await repository.loadOrchestration("dag_candidate"))!;
  const beforeDecompositionUpdate = structuredClone(candidateForDecomposition);
  candidateForDecomposition.nodes[0]!.decompositionChildren = [611];
  await assert.rejects(repository.saveOrchestration(candidateForDecomposition), (error: unknown) => {
    if (!(error instanceof OrchestrationIssueOwnershipConflictError)) return false;
    assert.deepEqual(error.conflicts, [{
      orchestrationId: "dag_decomposition_owner",
      repository: "owner/work",
      issueNumbers: [611],
    }]);
    return true;
  });
  assert.deepEqual(await repository.loadOrchestration("dag_candidate"), beforeDecompositionUpdate);
});
