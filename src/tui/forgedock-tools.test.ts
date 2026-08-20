// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { test } from "node:test";
import type { DurableArtifact } from "../core/artifacts/schema.js";
import type { EffectiveOrchestrationConfig } from "../core/config/forgedock-config.js";
import type {
  OrchestrationExecutionAdmission,
  OrchestrationNodeRecord,
  OrchestrationRecord,
} from "../core/ports/orchestration.js";
import { InMemoryOrchestrationRepository } from "../core/ports/repositories.js";
import { GitHubClient } from "../adapters/github/github-client.js";
import {
  materializeVisibleDecomposition,
  orchestrationItemRepository,
} from "./forgedock-tools.js";
import {
  OrchestrationController,
  type OrchestrationWorkOnWorker,
} from "../workflows/orchestrate/controller.js";

const effective = {
  batchingPolicy: "none",
  maxBatchSize: 10,
  maxSensitiveBatchSize: 10,
  scopeExpansion: "recursive",
  maxRemediationCycles: 1,
  maxRemediationDepth: 2,
  maxRemediationChildren: 10,
  maxParallel: 2,
  autoMerge: false,
  dispatchMode: "auto",
} as const satisfies EffectiveOrchestrationConfig;

function node(overrides: Partial<OrchestrationNodeRecord> = {}): OrchestrationNodeRecord {
  return {
    id: "parent",
    issue: 42,
    priority: 1,
    dependencies: [],
    claims: [],
    status: "queued",
    childRunIds: [],
    ...overrides,
  };
}

function orchestration(overrides: Partial<OrchestrationRecord> = {}): OrchestrationRecord {
  return {
    schema: "forgedock.orchestration/v1",
    orchestrationId: "dag-test",
    repository: "owner/root",
    requestedIssueNumbers: [42],
    issueNumbers: [42],
    maxParallel: 2,
    autoMerge: false,
    status: "running",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    nodes: [node()],
    ...overrides,
  };
}

function decomposedArtifact(repo: string): DurableArtifact {
  return {
    schema: "forgedock.artifact/v2",
    kind: "Outcome",
    id: `outcome-${repo}`,
    runId: "run-parent",
    subject: { repo, issue: 42 },
    createdAt: "2026-01-01T00:00:00.000Z",
    producer: { component: "tui-test", processInstanceId: "tui-test:1", role: "test" },
    payload: { status: "decomposed", reason: "children are authoritative", childIssues: ["#7", "#8"] },
  } as DurableArtifact;
}

function fakeRemote(parentRepository = "owner/parent", distinctChildClaims = false) {
  const repositoryReads: string[] = [];
  const issueReads: Array<{ repo: string; issue: number }> = [];
  const branchReads: Array<{ repo: string; branch: string }> = [];
  const artifactReads: Array<{ repo: string; issue: number }> = [];
  let activeIssueReads = 0;
  let maximumConcurrentIssueReads = 0;
  let failIssue: number | undefined;
  const github = {
    getRepository: async (repo?: string) => {
      const resolved = repo ?? "owner/root";
      repositoryReads.push(resolved);
      return { repo: resolved, defaultBranch: resolved === parentRepository ? "parent-default" : "root-default" };
    },
    getIssue: async (issue: number, repo?: string) => {
      const resolved = repo ?? "owner/root";
      issueReads.push({ repo: resolved, issue });
      activeIssueReads++;
      maximumConcurrentIssueReads = Math.max(maximumConcurrentIssueReads, activeIssueReads);
      await new Promise((resolve) => setTimeout(resolve, 2));
      activeIssueReads--;
      if (issue === failIssue) throw new Error("cancelled child read");
      return {
        repo: resolved,
        number: issue,
        state: "OPEN" as const,
        title: `Child ${issue}`,
        body: distinctChildClaims ? `## Affected Files\n- \`src/child-${issue}.ts\`` : "",
        labels: [],
      };
    },
    listBranches: async () => [],
    getBranchHead: async (repo: string, branch: string) => {
      branchReads.push({ repo, branch });
      return { name: branch, sha: "a".repeat(40) };
    },
  } as unknown as GitHubClient;
  const artifacts = {
    list: async (subject: { repo: string; issue: number }) => {
      artifactReads.push(subject);
      return subject.repo === parentRepository
        ? [decomposedArtifact(parentRepository)]
        : [decomposedArtifact("owner/root")];
    },
  };
  return {
    github,
    artifacts,
    repositoryReads,
    issueReads,
    branchReads,
    artifactReads,
    get maximumConcurrentIssueReads() { return maximumConcurrentIssueReads; },
    set failIssue(issue: number | undefined) { failIssue = issue; },
  };
}

class TestExecutionAdmission implements OrchestrationExecutionAdmission {
  async acquire(): Promise<{ claimId: string; assertValid(): void; release(): void }> {
    return { claimId: "claim-test", assertValid: () => undefined, release: () => undefined };
  }
}

function controller(
  repository: InMemoryOrchestrationRepository,
  worker: OrchestrationWorkOnWorker,
  resolveDecomposition: NonNullable<ConstructorParameters<typeof OrchestrationController>[0]["resolveDecomposition"]>,
): OrchestrationController {
  let attempt = 0;
  return new OrchestrationController({
    repository,
    worker,
    executionAdmission: new TestExecutionAdmission(),
    transportCapacity: 2,
    resolveDecomposition,
    createOrchestrationId: () => "dag-test",
    createAttemptId: () => `attempt-${++attempt}`,
    now: () => "2026-01-01T00:00:00.000Z",
  });
}

test("invariant:matrix-terminal-metadata-97a40690fa7f resolves parent artifacts, routes, claims, and children in the frozen repository", async () => {
  const remote = fakeRemote();
  const result = await materializeVisibleDecomposition({
    github: remote.github,
    artifacts: remote.artifacts,
    repository: "owner/root",
    defaultBranch: "root-default",
    effective,
    orchestration: orchestration({ nodes: [node({ id: "root-7", issue: 7, repository: "owner/root" }), node()] }),
    node: node({ repository: "owner/parent" }),
    item: {
      issue: 42,
      repository: "owner/root",
    },
  });

  assert.deepEqual(remote.repositoryReads, ["owner/parent"]);
  assert.deepEqual(remote.artifactReads, [{ repo: "owner/parent", issue: 42 }]);
  assert.deepEqual(remote.issueReads.map((read) => read.repo), ["owner/parent", "owner/parent"]);
  assert.deepEqual(remote.branchReads, [
    { repo: "owner/parent", branch: "parent-default" },
    { repo: "owner/parent", branch: "parent-default" },
  ]);
  assert.deepEqual(result?.childIssues, [7, 8]);
  assert.deepEqual(result?.items.map((item) => ({ issue: item.issue, repository: item.repository, targetBranch: item.targetBranch, claims: item.claims })), [
    { issue: 7, repository: "owner/parent", targetBranch: "parent-default", claims: ["component:owner/parent"] },
    { issue: 8, repository: "owner/parent", targetBranch: "parent-default", claims: ["component:owner/parent"] },
  ]);
  assert.equal(orchestrationItemRepository(node({ repository: "owner/parent" }), { repository: "owner/item" }, "owner/root"), "owner/parent");
  assert.equal(orchestrationItemRepository(node(), { repository: "owner/item" }, "owner/root"), "owner/item");
  assert.equal(orchestrationItemRepository(node(), {}, "owner/root"), "owner/root");
});

test("invariant:matrix-adapter-lifecycle-5a3b52339646 and invariant:matrix-identity-isolation-ed8d2dfc6b76 preserve concurrent parent identity through controller expansion", async () => {
  const remote = fakeRemote("owner/parent", true);
  const repository = new InMemoryOrchestrationRepository();
  const started: string[] = [];
  let active = 0;
  let maximumActive = 0;
  const service = controller(repository, async (scheduled) => {
    started.push(`${scheduled.repository}#${scheduled.issue}`);
    active++;
    maximumActive = Math.max(maximumActive, active);
    await new Promise((resolve) => setTimeout(resolve, scheduled.id === "parent" ? 1 : 4));
    active--;
    return scheduled.id === "parent" ? { status: "skipped", childIssues: [7, 8] } : undefined;
  }, async ({ orchestration: durable, node: parent, item, childIssues }) => materializeVisibleDecomposition({
    github: remote.github,
    artifacts: remote.artifacts,
    repository: durable.repository,
    defaultBranch: "root-default",
    effective,
    orchestration: durable,
    node: parent,
    item,
    ...(childIssues !== undefined ? { childIssues } : {}),
  }));

  const result = await service.createAndRun({
    repository: "owner/root",
    maxParallel: 2,
    items: [{
      id: "parent",
      issue: 42,
      priority: 1,
      dependencies: [],
      claims: [],
      repository: "owner/parent",
      targetBranch: "parent-default",
      lane: "fast",
      memberIssues: [42],
    }],
  });

  assert.equal(result.record.status, "completed");
  assert.equal(maximumActive, 2);
  assert.deepEqual(started, ["owner/parent#42", "owner/parent#7", "owner/parent#8"]);
  assert.deepEqual(result.record.nodes.filter((candidate) => candidate.issue === 7 || candidate.issue === 8).map((candidate) => candidate.repository), ["owner/parent", "owner/parent"]);
  assert.deepEqual((await repository.loadOrchestration(result.orchestrationId))?.nodes, result.record.nodes);
});

test("invariant:matrix-terminal-metadata-a16005b35fe7 and invariant:matrix-chunk-boundary-25d111030188 do not hand off a partial graph after cancellation", async () => {
  const remote = fakeRemote();
  remote.failIssue = 8;
  await assert.rejects(
    () => materializeVisibleDecomposition({
      github: remote.github,
      artifacts: remote.artifacts,
      repository: "owner/root",
      defaultBranch: "root-default",
      effective,
      orchestration: orchestration(),
      node: node({ repository: "owner/parent" }),
      item: { issue: 42, repository: "owner/parent" },
      childIssues: [7, 8],
    }),
    /cancelled child read/,
  );
  assert.deepEqual(remote.repositoryReads, ["owner/parent"]);
  assert.equal(remote.artifactReads.length, 0);
  assert.equal(remote.maximumConcurrentIssueReads, 2);
});
