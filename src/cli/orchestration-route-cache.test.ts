import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { InMemoryOrchestrationRepository } from "../core/ports/repositories.js";
import { OrchestrationController, type OrchestrationWorkOnWorker } from "../workflows/orchestrate/controller.js";
import { revalidateBatchGroup } from "../workflows/orchestrate/materialize.js";
import type { BatchableWorkItem } from "../workflows/orchestrate/batching.js";
import type { ScheduledWorkItem } from "../workflows/orchestrate/scheduler.js";
import {
  getOrchestrationRoute,
  orchestrationRouteCacheKey,
  requiredOrchestrationRoute,
  setOrchestrationRoute,
} from "./orchestration-route-cache.js";

interface Route {
  issue: { repo: string; number: number; title: string };
  lane: { kind: "fast" | "feature"; targetBranch: string };
}

function route(repo: string, issue: number, kind: "fast" | "feature", targetBranch: string): Route {
  return { issue: { repo, number: issue, title: `${repo}#${issue}` }, lane: { kind, targetBranch } };
}

function item(id: string, repository: string, issue: number): ScheduledWorkItem {
  return { id, repository, issue, priority: 10, dependencies: [], claims: [`component:${repository}`] };
}

describe("orchestration route cache identity", () => {
  it("isolates equal issue numbers by normalized repository and fails closed when absent", () => {
    const routes = new Map<string, Route>();
    setOrchestrationRoute(routes, { repository: "Owner/Root", issue: 7 }, route("owner/root", 7, "fast", "root-main"));
    setOrchestrationRoute(routes, { repository: "owner/parent", issue: 7 }, route("owner/parent", 7, "feature", "parent-main"));

    assert.equal(routes.size, 2);
    assert.equal(orchestrationRouteCacheKey("OWNER/ROOT", 7), orchestrationRouteCacheKey("owner/root", 7));
    assert.equal(getOrchestrationRoute(routes, { repository: "owner/root", issue: 7 })?.lane.targetBranch, "root-main");
    assert.equal(getOrchestrationRoute(routes, { repository: "owner/parent", issue: 7 })?.lane.targetBranch, "parent-main");
    assert.throws(
      () => requiredOrchestrationRoute(routes, { repository: "owner/missing", issue: 7 }),
      /owner\/missing#7.*authoritative lane classification/,
    );
  });

  it("revalidates batch routes with the scheduled repository rather than issue number", async () => {
    const makeBatchItem = (repository: string): BatchableWorkItem => ({
      ...item(`${repository}-7`, repository, 7),
      title: `${repository} issue 7`,
      summary: "Fix",
      labels: ["priority:P2"],
      affectedFiles: ["src/shared.ts"],
      targetBranch: `${repository.replace("/", "-")}-main`,
      lane: "fast",
    });
    const root = makeBatchItem("owner/root");
    const parent = makeBatchItem("owner/parent");
    const calls: string[] = [];
    const result = await revalidateBatchGroup(
      { id: "batch:shared", kind: "same-file", key: "src/shared.ts", riskClass: "routine", members: [root, parent] },
      "owner/root",
      {
        async getIssue(number, repository) {
          calls.push(`${repository}#${number}`);
          return {
            repo: repository!, number, title: `${repository} issue ${number}`, body: "## Affected Files\n- `src/shared.ts`",
            url: `https://example.test/${repository}/${number}`, state: "OPEN", labels: ["priority:P2"],
          };
        },
        async materializeBatchIssue() { throw new Error("not expected"); },
        async closeIssue() {},
      },
      new Map([
        [orchestrationRouteCacheKey("owner/root", 7), { targetBranch: "owner-root-main", lane: "fast" as const }],
        [orchestrationRouteCacheKey("owner/parent", 7), { targetBranch: "owner-parent-main", lane: "fast" as const }],
      ]),
    );
    assert.equal(result.members.length, 2);
    assert.deepEqual(calls.sort(), ["owner/parent#7", "owner/root#7"]);
    assert.deepEqual(result.members.map((member) => member.repository).sort(), ["owner/parent", "owner/root"]);
  });

  it("keeps queued root#7 and expanding parent#42 → child#7 deliveries repository-qualified", async () => {
    const routes = new Map<string, Route>();
    setOrchestrationRoute(routes, { repository: "owner/root", issue: 7 }, route("owner/root", 7, "fast", "root-main"));
    setOrchestrationRoute(routes, { repository: "owner/parent", issue: 42 }, route("owner/parent", 42, "fast", "parent-main"));

    const delivered: Array<{ id: string; repository: string; issue: number; lane: string; branch: string; route: string }> = [];
    const worker: OrchestrationWorkOnWorker = async (scheduled) => {
      const scheduledRepository = scheduled.repository!;
      const resolved = requiredOrchestrationRoute(routes, { repository: scheduledRepository, issue: scheduled.issue });
      delivered.push({
        id: scheduled.id,
        repository: scheduledRepository,
        issue: resolved.issue.number,
        lane: resolved.lane.kind,
        branch: resolved.lane.targetBranch,
        route: orchestrationRouteCacheKey(scheduledRepository, scheduled.issue),
      });
      if (scheduled.id === "parent-42") return { status: "skipped", childIssues: [7] };
      return { status: "completed" };
    };
    const repository = new InMemoryOrchestrationRepository();
    const controller = new OrchestrationController({
      repository,
      worker,
      executionAdmission: {
        async acquire(orchestrationId) {
          return {
            claimId: `claim-${orchestrationId}`,
            assertValid() {},
            release() {},
          };
        },
      },
      transportCapacity: 2,
      createOrchestrationId: () => "dag-route-cache",
      createAttemptId: () => "attempt-route-cache",
      resolveDecomposition: async ({ childIssues, item: parent }) => {
        const childIssue = childIssues?.[0] ?? 7;
        const childRepository = parent.repository!;
        setOrchestrationRoute(routes, { repository: childRepository, issue: childIssue }, route(childRepository, childIssue, "feature", "parent-feature"));
        return {
          childIssues: [childIssue],
          items: [{ ...item("child-parent-7", childRepository, childIssue), lane: "feature", targetBranch: "parent-feature" }],
        };
      },
    });

    const result = await controller.createAndRun({
      repository: "owner/root",
      items: [
        { ...item("root-7", "owner/root", 7), lane: "fast", targetBranch: "root-main" },
        { ...item("parent-42", "owner/parent", 42), lane: "fast", targetBranch: "parent-main" },
      ],
      maxParallel: 2,
    });

    assert.equal(result.record.status, "completed");
    assert.deepEqual(delivered.map(({ id }) => id).sort(), ["child-parent-7", "parent-42", "root-7"].sort());
    assert.deepEqual(delivered.find(({ id }) => id === "root-7"), {
      id: "root-7", repository: "owner/root", issue: 7, lane: "fast", branch: "root-main",
      route: orchestrationRouteCacheKey("owner/root", 7),
    });
    assert.deepEqual(delivered.find(({ id }) => id === "child-parent-7"), {
      id: "child-parent-7", repository: "owner/parent", issue: 7, lane: "feature", branch: "parent-feature",
      route: orchestrationRouteCacheKey("owner/parent", 7),
    });
    assert.notEqual(
      delivered.find(({ id }) => id === "root-7")?.route,
      delivered.find(({ id }) => id === "child-parent-7")?.route,
    );
    const rootNode = result.record.nodes.find((node) => node.id === "root-7");
    assert.equal(rootNode?.repository, "owner/root");
    assert.equal(rootNode?.targetBranch, "root-main");
    const child = result.record.nodes.find((node) => node.id === "child-parent-7");
    assert.equal(child?.repository, "owner/parent");
    assert.equal(child?.targetBranch, "parent-feature");
    assert.equal(child?.lane, "feature");
  });
});
