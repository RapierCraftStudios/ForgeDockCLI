// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createArtifact } from "../core/artifacts/schema.js";
import { materializeCliDecomposition } from "./decomposition-materializer.js";
import { getOrchestrationRoute, setOrchestrationRoute } from "./orchestration-route-cache.js";

function issue(repository: string, number: number, body = "") {
  return {
    repo: repository,
    number,
    title: `${repository} #${number}`,
    body,
    url: `https://github.test/${repository}/issues/${number}`,
    state: "OPEN" as const,
    labels: [],
    comments: [],
  };
}

function node(id: string, repository: string, number: number) {
  return {
    id,
    repository,
    issue: number,
    priority: 1,
    dependencies: [] as string[],
    claims: [] as string[],
    memberIssues: [number],
    targetBranch: `${repository.replace("/", "-")}-main`,
    lane: "fast" as const,
  };
}

describe("CLI decomposition materializer", () => {
  it("keeps equal issue numbers repository-qualified through fresh and resumed materialization", async () => {
    const artifactReads: Array<{ repo: string; issue: number }> = [];
    const issueReads: Array<{ repo: string; issue: number }> = [];
    const outcome = createArtifact({
      kind: "Outcome",
      runId: "run-parent-decomposition",
      subject: { repo: "owner/parent", issue: 42 },
      producer: { role: "controller", runtime: "forgedock" },
      payload: { status: "decomposed", reason: "Split", childIssues: ["#7 Child"] },
    });
    const repositoryReads: string[] = [];
    const artifacts = {
      async list(subject: { repo: string; issue: number }) {
        artifactReads.push(subject);
        return [outcome];
      },
    };
    const github = {
      async getRepository(repository: string) {
        repositoryReads.push(repository);
        return { repo: repository, defaultBranch: "parent-main" };
      },
      async getIssue(number: number, repository: string) {
        issueReads.push({ repo: repository, issue: number });
        return issue(repository, number, "## Dependencies\n- #42\n");
      },
      async listBranches() { return []; },
      async getBranchHead() { return "head"; },
    } as any;
    const orchestration = {
      schema: "forgedock.orchestration/v1" as const,
      orchestrationId: "orch-qualified-materializer",
      repository: "owner/root",
      issueNumbers: [7, 42],
      maxParallel: 2,
      autoMerge: false,
      status: "running" as const,
      createdAt: "now",
      updatedAt: "now",
      nodes: [node("issue-7", "owner/root", 7), node("parent", "owner/parent", 42)],
    } as any;
    const routedIssues = new Map<string, any>();
    const rootRoute = { issue: issue("owner/root", 7), lane: { kind: "fast" as const, targetBranch: "root-main", resolution: "repository-default" as const } };
    setOrchestrationRoute(routedIssues, { repository: "owner/root", issue: 7 }, rootRoute);
    const input = {
      github,
      artifacts,
      repository: "owner/root",
      defaultBranch: "root-main",
      effective: { fastLaneTarget: "parent-main" } as any,
      orchestration,
      node: node("parent", "owner/parent", 42),
      item: { ...node("parent", "owner/parent", 42) },
      routedIssues,
    } as any;

    const fresh = await materializeCliDecomposition(input);
    assert.ok(fresh);
    assert.deepEqual(issueReads, [{ repo: "owner/parent", issue: 7 }]);
    assert.deepEqual(repositoryReads, ["owner/parent"]);
    assert.deepEqual(artifactReads, [{ repo: "owner/parent", issue: 42 }]);
    assert.equal(fresh.items[0]?.id, "issue-owner%2Fparent-7");
    assert.equal(fresh.items[0]?.repository, "owner/parent");
    assert.equal(fresh.items[0]?.targetBranch, "parent-main");
    assert.equal(fresh.items[0]?.lane, "fast");
    assert.deepEqual(fresh.items[0]?.dependencies, ["parent"]);
    assert.equal(getOrchestrationRoute(routedIssues, { repository: "owner/root", issue: 7 }), rootRoute);
    assert.ok(getOrchestrationRoute(routedIssues, { repository: "owner/parent", issue: 7 }));

    issueReads.length = 0;
    repositoryReads.length = 0;
    artifactReads.length = 0;
    const resumed = await materializeCliDecomposition({ ...input, childIssues: [7] });
    assert.ok(resumed);
    assert.deepEqual(issueReads, [{ repo: "owner/parent", issue: 7 }]);
    assert.deepEqual(repositoryReads, ["owner/parent"]);
    assert.deepEqual(artifactReads, []);
    assert.equal(resumed.items[0]?.id, "issue-owner%2Fparent-7");
    assert.deepEqual(resumed.items[0]?.dependencies, ["parent"]);
  });

  it("keeps punctuation-distinct repositories on distinct qualified child IDs", async () => {
    const github = {
      async getRepository(repository: string) {
        return { repo: repository, defaultBranch: `${repository}-main` };
      },
      async getIssue(issueNumber: number, repository: string) {
        return issue(repository, issueNumber);
      },
      async listBranches() { return []; },
      async getBranchHead() { return "head"; },
    } as any;
    const makeNode = (id: string, repository: string, issueNumber: number) => ({
      ...node(id, repository, issueNumber),
      dependencies: [] as string[],
    });
    const orchestration = {
      repository: "owner/root",
      nodes: [
        makeNode("issue-7", "owner/root", 7),
        makeNode("parent-hyphen", "owner/a-b", 42),
        makeNode("parent-underscore", "owner/a_b", 43),
      ],
    } as any;
    const base = {
      github,
      artifacts: { async list() { return []; } },
      repository: "owner/root",
      defaultBranch: "root-main",
      effective: { fastLaneTarget: "staging" } as any,
      orchestration,
      routedIssues: new Map<string, any>(),
    } as any;

    const first = await materializeCliDecomposition({
      ...base,
      node: makeNode("parent-hyphen", "owner/a-b", 42),
      item: makeNode("parent-hyphen", "owner/a-b", 42),
      childIssues: [7],
    });
    assert.ok(first);
    const firstId = first.items[0]?.id;
    assert.notEqual(firstId, "issue-7");

    orchestration.nodes = [...orchestration.nodes, {
      ...makeNode(firstId!, "owner/a-b", 7),
    }];
    const second = await materializeCliDecomposition({
      ...base,
      node: makeNode("parent-underscore", "owner/a_b", 43),
      item: makeNode("parent-underscore", "owner/a_b", 43),
      childIssues: [7],
    });
    assert.ok(second);
    const secondId = second.items[0]?.id;
    assert.notEqual(secondId, "issue-7");
    assert.notEqual(firstId, secondId);
    assert.equal(first.items.filter((item) => item.id === secondId).length, 0);
  });
});
