// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_REVIEW_CI } from "../../core/config/forgedock-config.js";
import type { ForgeHost, PullRequestMergeGate, PullRequestSnapshot, ReviewFindingInput } from "../../core/ports/forge-host.js";
import type { GitWorkspace } from "../../core/ports/git-workspace.js";
import { InMemoryArtifactRepository, InMemoryRunRepository } from "../../core/ports/repositories.js";
import { FakeAgentRuntime } from "../../runtime/fake-runtime.js";
import type { ReviewerSubmission } from "./review.js";
import { reviewExistingPullRequest } from "./review-existing.js";

const sha = "a".repeat(40);
const deploymentPr: PullRequestSnapshot = {
  repo: "a/b",
  number: 9,
  title: "Deploy: staging → main",
  body: "Promote the current staging snapshot.",
  url: "https://github.test/a/b/pull/9",
  state: "OPEN",
  headSha: sha,
  headBranch: "staging",
  baseBranch: "main",
};
const clean: ReviewerSubmission = { summary: "No deployment defects", findings: [] };

function deploymentDiff(paths: readonly string[], forms: "canonical" | "normalized" = "canonical"): string {
  return paths.map((path) => {
    const displayed = forms === "normalized" ? `./${path.split("/").join("\\")}` : path;
    return `diff --git a/${displayed} b/${displayed}\n+export const changed = true;`;
  }).join("\n");
}

class DeploymentHost implements ForgeHost {
  readonly publications: Array<{ repo: string; pullRequest: number; marker: string; body: string }> = [];
  materializedFindings = 0;
  reconciliations = 0;
  pullRequest = deploymentPr;
  pullRequestSnapshots: PullRequestSnapshot[] = [];
  diffResponses: Array<string | Error> = [];
  requiredChecks: PullRequestMergeGate["requiredChecks"] = [{ name: "CI", state: "passed" }];
  mergeGateIdentity: Partial<Pick<PullRequestMergeGate, "repo" | "pullRequest" | "headSha" | "baseBranch">> = {};

  async materializeDecomposition() { return []; }
  async createPullRequest(): Promise<PullRequestSnapshot> { return this.pullRequest; }
  async getPullRequest(): Promise<PullRequestSnapshot> { return this.pullRequestSnapshots.shift() ?? this.pullRequest; }
  async getPullRequestDiff(): Promise<string> {
    const response = this.diffResponses.shift() ?? "diff --git a/src/release.ts b/src/release.ts\n+export const release = true;";
    if (response instanceof Error) throw response;
    return response;
  }
  async getPullRequestMergeGate(_repo: string, number: number, headSha: string, baseBranch: string): Promise<PullRequestMergeGate> {
    return {
      repo: deploymentPr.repo,
      pullRequest: number,
      headSha,
      baseBranch,
      ...this.mergeGateIdentity,
      mergeable: true,
      requiredChecks: [...this.requiredChecks],
      observedAt: new Date().toISOString(),
    };
  }
  async publishPullRequestComment(input: { repo: string; pullRequest: number; marker: string; body: string }): Promise<void> {
    if (this.publications.some(({ marker }) => marker === input.marker)) return;
    this.publications.push(input);
  }
  async materializeReviewFinding() {
    this.materializedFindings += 1;
    return {
      repo: deploymentPr.repo,
      number: 100,
      title: "finding",
      body: "",
      url: "https://github.test/a/b/issues/100",
      state: "OPEN" as const,
    };
  }
  async reconcileReviewFindings(_input: {
    repo: string;
    pullRequest: PullRequestSnapshot;
    runId: string;
    activeFindings: readonly ReviewFindingInput[];
  }): Promise<readonly number[]> {
    this.reconciliations += 1;
    return [];
  }
  async mergePullRequest(): Promise<void> {}
  async closeIssue(): Promise<void> {}
}

class TestWorkspaces {
  removed = false;
  readonly workspace: GitWorkspace = { path: process.cwd(), branch: "review/pr-9", baseRef: sha, baseSha: sha };

  async createReview(): Promise<GitWorkspace> { return this.workspace; }
  async remove(): Promise<void> { this.removed = true; }
}

function assertNoDeploymentGate(publications: DeploymentHost["publications"]): void {
  assert.equal(
    publications.some(({ marker, body }) => /FORGE:GATE_|FORGEDOCK:DEPLOYMENT_GATE_/.test(`${marker}\n${body}`)),
    false,
  );
}

describe("issue-less deployment PR review", () => {
  it("reviews staging-to-main without lifecycle gate comments", async () => {
    const host = new DeploymentHost();
    const runtime = new FakeAgentRuntime(Array.from({ length: 8 }, () => clean));
    const workspaces = new TestWorkspaces();
    const artifacts = new InMemoryArtifactRepository();
    const result = await reviewExistingPullRequest(
      { repo: deploymentPr.repo, pr: deploymentPr.number },
      { runtime, host, workspaces, artifacts, runs: new InMemoryRunRepository() },
    );

    assert.equal(result.run.state, "merging");
    assert.deepEqual(result.verdict.subject, { repo: deploymentPr.repo, pr: deploymentPr.number });
    assert.deepEqual(result.verdict.payload.checks, [{ command: "GitHub required check: CI", status: "passed", durationMs: 0 }]);
    assert.ok(runtime.tasks.length > 0);
    assert.ok(runtime.tasks.every((task) => !task.context.some((artifact) => artifact.kind === "BuildResult")));
    assert.deepEqual((await artifacts.list({ repo: deploymentPr.repo, pr: deploymentPr.number })).map(({ kind }) => kind), ["ReviewVerdict"]);
    assertNoDeploymentGate(host.publications);
    assert.equal(workspaces.removed, true);
  });

  it("reconciles a normalized multi-file diff into every reviewer boundary", async () => {
    const paths = ["src/manifest.ts", "config/version.yml"];
    const host = new DeploymentHost();
    host.diffResponses = [deploymentDiff(paths), deploymentDiff(paths, "normalized")];
    const runtime = new FakeAgentRuntime(Array.from({ length: 8 }, () => clean));
    const workspaces = new TestWorkspaces();
    const artifacts = new InMemoryArtifactRepository();
    const result = await reviewExistingPullRequest(
      { repo: deploymentPr.repo, pr: deploymentPr.number },
      { runtime, host, workspaces, artifacts, runs: new InMemoryRunRepository() },
    );

    const plannedPaths = [...new Set(result.reviewPlan.executionGroups.flatMap(({ scope }) => scope))].sort();
    assert.deepEqual(plannedPaths, [...paths].sort());
    const reviewerTasks = runtime.tasks.filter((task) => task.role === "reviewer");
    assert.equal(reviewerTasks.length, result.reviewPlan.executionGroups.length);
    assert.ok(reviewerTasks.every((task) => task.workspace.scope.readRoots.includes("config") && task.workspace.scope.readRoots.includes("src")));
    assert.ok(result.verdict.payload.reviewPlan);
    assert.deepEqual(result.reviewPlan.executionGroups.flatMap(({ scope }) => scope).sort(), [...paths].sort());
    assert.equal(host.materializedFindings, 0);
    assert.equal(host.reconciliations, 1);
    assert.equal(workspaces.removed, true);
    assertNoDeploymentGate(host.publications);
  });

  it("fails closed when the second diff read omits or adds a deployment path", async () => {
    const paths = ["src/manifest.ts", "config/version.yml"];
    const cases = [
      { name: "omits", second: [paths[0]!] },
      { name: "adds", second: [...paths, "src/extra.ts"] },
    ];
    for (const testCase of cases) {
      const host = new DeploymentHost();
      host.diffResponses = [deploymentDiff(paths), deploymentDiff(testCase.second)];
      const runtime = new FakeAgentRuntime([clean]);
      const workspaces = new TestWorkspaces();
      const artifacts = new InMemoryArtifactRepository();
      const runs = new InMemoryRunRepository();

      await assert.rejects(
        reviewExistingPullRequest(
          { repo: deploymentPr.repo, pr: deploymentPr.number },
          { runtime, host, workspaces, artifacts, runs },
        ),
        /changed-path inventory does not match/,
        testCase.name,
      );

      assert.equal(runtime.tasks.length, 0, testCase.name);
      assert.equal(host.publications.length, 0, testCase.name);
      assert.equal(host.materializedFindings, 0, testCase.name);
      assert.equal(host.reconciliations, 0, testCase.name);
      assert.deepEqual(await artifacts.list({ repo: deploymentPr.repo, pr: deploymentPr.number }), [], testCase.name);
      assert.equal(workspaces.removed, true, testCase.name);
      const failedRun = [...runs.runs.values()][0];
      assert.equal(failedRun?.state, "failed", testCase.name);
    }
  });

  it("removes the deployment workspace when the frozen diff read rejects", async () => {
    const secondReadHost = new DeploymentHost();
    secondReadHost.diffResponses = [deploymentDiff(["src/manifest.ts"]), new Error("second diff unavailable")];
    const secondReadWorkspaces = new TestWorkspaces();
    const secondReadArtifacts = new InMemoryArtifactRepository();
    const secondReadRuns = new InMemoryRunRepository();

    await assert.rejects(
      reviewExistingPullRequest(
        { repo: deploymentPr.repo, pr: deploymentPr.number },
        {
          runtime: new FakeAgentRuntime(), host: secondReadHost, workspaces: secondReadWorkspaces,
          artifacts: secondReadArtifacts, runs: secondReadRuns,
        },
      ),
      /second diff unavailable/,
    );
    assert.equal(secondReadWorkspaces.removed, true);
    assert.equal(secondReadHost.publications.length, 0);
    assert.equal(secondReadHost.reconciliations, 0);
    assert.deepEqual(await secondReadArtifacts.list({ repo: deploymentPr.repo, pr: deploymentPr.number }), []);
    assert.equal([...secondReadRuns.runs.values()][0]?.state, "failed");

    const firstReadHost = new DeploymentHost();
    firstReadHost.diffResponses = [new Error("first diff unavailable")];
    const firstReadWorkspaces = new TestWorkspaces();
    const firstReadRuns = new InMemoryRunRepository();
    await assert.rejects(
      reviewExistingPullRequest(
        { repo: deploymentPr.repo, pr: deploymentPr.number },
        {
          runtime: new FakeAgentRuntime(), host: firstReadHost, workspaces: firstReadWorkspaces,
          artifacts: new InMemoryArtifactRepository(), runs: firstReadRuns,
        },
      ),
      /first diff unavailable/,
    );
    assert.equal(firstReadWorkspaces.removed, false);
    assert.equal(firstReadRuns.runs.size, 0);
    assert.equal(firstReadHost.publications.length, 0);
  });

  it("treats every non-green deployment check as authoritative", async () => {
    const host = new DeploymentHost();
    host.requiredChecks = [{ name: "CI", state: "failed", detailsUrl: "https://github.test/checks/ci" }];
    const runtime = new FakeAgentRuntime();
    const workspaces = new TestWorkspaces();

    await assert.rejects(
      reviewExistingPullRequest(
        { repo: deploymentPr.repo, pr: deploymentPr.number },
        { runtime, host, workspaces, artifacts: new InMemoryArtifactRepository(), runs: new InMemoryRunRepository() },
      ),
      /Deployment PR checks are not green: CI=failed/,
    );

    assert.equal(runtime.tasks.length, 0);
    assert.equal(workspaces.removed, false);
    assertNoDeploymentGate(host.publications);
  });

  it("blocks a pending legacy CodeQL context even when default setup passes", async () => {
    const host = new DeploymentHost();
    host.requiredChecks = [
      { name: "Analyze (javascript-typescript)", state: "pending", detailsUrl: "https://github.test/actions/runs/legacy" },
      { name: "CodeQL default setup", state: "passed", detailsUrl: "https://github.test/actions/runs/default" },
    ];
    const runtime = new FakeAgentRuntime(Array.from({ length: 8 }, () => clean));
    const workspaces = new TestWorkspaces();

    await assert.rejects(
      reviewExistingPullRequest(
        { repo: deploymentPr.repo, pr: deploymentPr.number },
        { runtime, host, workspaces, artifacts: new InMemoryArtifactRepository(), runs: new InMemoryRunRepository() },
      ),
      /Deployment PR checks are not green: Analyze \(javascript-typescript\)=pending/,
    );

    assert.equal(runtime.tasks.length, 0);
    assert.equal(workspaces.removed, false);
    assertNoDeploymentGate(host.publications);
  });

  it("blocks cancelled, failed, and unavailable deployment checks", async () => {
    for (const state of ["cancelled", "failed", "unavailable"] as const) {
      const host = new DeploymentHost();
      host.requiredChecks = [
        { name: "CodeQL default setup", state: "passed" },
        { name: "Analyze (javascript-typescript)", state },
      ];
      await assert.rejects(
        reviewExistingPullRequest(
          { repo: deploymentPr.repo, pr: deploymentPr.number },
          { runtime: new FakeAgentRuntime(), host, workspaces: new TestWorkspaces(), artifacts: new InMemoryArtifactRepository(), runs: new InMemoryRunRepository() },
        ),
        new RegExp(`Deployment PR checks are not green: Analyze \\(javascript-typescript\\)=${state}`),
      );
    }
  });

  it("allows configured pending CI to overlap review, then asks for a green exact head", async () => {
    const host = new DeploymentHost();
    host.requiredChecks = [{ name: "CI", state: "pending", detailsUrl: "https://github.test/checks/ci" }];
    const runtime = new FakeAgentRuntime(Array.from({ length: 8 }, () => clean));
    const workspaces = new TestWorkspaces();

    const artifacts = new InMemoryArtifactRepository();
    await assert.rejects(
      reviewExistingPullRequest(
        { repo: deploymentPr.repo, pr: deploymentPr.number, ci: { policy: DEFAULT_REVIEW_CI } },
        { runtime, host, workspaces, artifacts, runs: new InMemoryRunRepository() },
      ),
      /CI=pending.*Please fix.*rerun \/review-pr/s,
    );

    assert.ok(runtime.tasks.length > 0);
    assert.deepEqual(await artifacts.list({ repo: deploymentPr.repo, pr: deploymentPr.number }), []);
    assert.equal(workspaces.removed, true);
    assertNoDeploymentGate(host.publications);
  });

  it("rechecks the exact-head merge gate before persisting an approving verdict", async () => {
    const host = new DeploymentHost();
    const artifacts = new InMemoryArtifactRepository();
    const runtime = new FakeAgentRuntime([
      async () => {
        host.requiredChecks = [{ name: "CI", state: "failed", detailsUrl: "https://github.test/checks/ci" }];
        return clean;
      },
      ...Array.from({ length: 7 }, () => clean),
    ]);

    await assert.rejects(
      reviewExistingPullRequest(
        { repo: deploymentPr.repo, pr: deploymentPr.number },
        { runtime, host, workspaces: new TestWorkspaces(), artifacts, runs: new InMemoryRunRepository() },
      ),
      /Deployment PR checks are not green: CI=failed/,
    );

    assert.deepEqual(await artifacts.list({ repo: deploymentPr.repo, pr: deploymentPr.number }), []);
    assertNoDeploymentGate(host.publications);
  });

  it("fails closed when deployment merge-gate authority is unavailable", async () => {
    const host = new DeploymentHost();
    Object.defineProperty(host, "getPullRequestMergeGate", { value: undefined });

    await assert.rejects(
      reviewExistingPullRequest(
        { repo: deploymentPr.repo, pr: deploymentPr.number },
        { runtime: new FakeAgentRuntime(), host, workspaces: new TestWorkspaces(), artifacts: new InMemoryArtifactRepository(), runs: new InMemoryRunRepository() },
      ),
      /Deployment review requires an authoritative merge-gate adapter/,
    );
  });

  it("re-freezes an advanced head immediately before reviewer setup", async () => {
    const host = new DeploymentHost();
    const nextSha = "b".repeat(40);
    const advanced = { ...deploymentPr, headSha: nextSha };
    host.pullRequestSnapshots = [deploymentPr, advanced];
    host.pullRequest = advanced;

    const result = await reviewExistingPullRequest(
      { repo: deploymentPr.repo, pr: deploymentPr.number },
      {
        runtime: new FakeAgentRuntime(Array.from({ length: 8 }, () => clean)), host,
        workspaces: new TestWorkspaces(), artifacts: new InMemoryArtifactRepository(), runs: new InMemoryRunRepository(),
      },
    );

    assert.equal(result.verdict.payload.headSha, nextSha);
    assertNoDeploymentGate(host.publications);
  });

  it("fails when the PR route changes during reviewer execution", async () => {
    const host = new DeploymentHost();
    const nextSha = "b".repeat(40);
    const runtime = new FakeAgentRuntime([
      async () => {
        host.pullRequest = { ...deploymentPr, headSha: nextSha };
        return clean;
      },
      clean,
    ]);

    await assert.rejects(
      reviewExistingPullRequest(
        { repo: deploymentPr.repo, pr: deploymentPr.number },
        { runtime, host, workspaces: new TestWorkspaces(), artifacts: new InMemoryArtifactRepository(), runs: new InMemoryRunRepository() },
      ),
      /PR delivery route changed during reviewer execution/,
    );
    assertNoDeploymentGate(host.publications);
  });

  it("does not start a deployment review from a closed frozen snapshot", async () => {
    const host = new DeploymentHost();
    host.pullRequest = { ...deploymentPr, state: "CLOSED" };
    const runtime = new FakeAgentRuntime(Array.from({ length: 8 }, () => clean));
    const workspaces = new TestWorkspaces();

    await assert.rejects(
      reviewExistingPullRequest(
        { repo: deploymentPr.repo, pr: deploymentPr.number },
        { runtime, host, workspaces, artifacts: new InMemoryArtifactRepository(), runs: new InMemoryRunRepository() },
      ),
      /must be OPEN at freeze, found CLOSED/,
    );
    assert.equal(runtime.tasks.length, 0);
    assert.equal(workspaces.removed, false);
    assertNoDeploymentGate(host.publications);
  });

  it("rejects mismatched host snapshots and merge-gate evidence", async () => {
    const initial = new DeploymentHost();
    initial.pullRequestSnapshots = [{ ...deploymentPr, repo: "other/repo", number: 77 }];
    await assert.rejects(
      reviewExistingPullRequest(
        { repo: deploymentPr.repo, pr: deploymentPr.number },
        { runtime: new FakeAgentRuntime(), host: initial, workspaces: new TestWorkspaces(), artifacts: new InMemoryArtifactRepository(), runs: new InMemoryRunRepository() },
      ),
      /initial read returned mismatched PR identity other\/repo#77 for requested a\/b#9/,
    );
    assert.equal(initial.publications.length, 0);

    const gate = new DeploymentHost();
    gate.mergeGateIdentity = { headSha: "c".repeat(40) };
    await assert.rejects(
      reviewExistingPullRequest(
        { repo: deploymentPr.repo, pr: deploymentPr.number },
        { runtime: new FakeAgentRuntime(), host: gate, workspaces: new TestWorkspaces(), artifacts: new InMemoryArtifactRepository(), runs: new InMemoryRunRepository() },
      ),
      /Deployment merge-gate identity mismatch/,
    );
    assertNoDeploymentGate(gate.publications);
  });

  it("still requires an issue for a non-deployment PR", async () => {
    const host = new DeploymentHost();
    host.pullRequest = { ...deploymentPr, headBranch: "feature/release" };
    await assert.rejects(
      reviewExistingPullRequest(
        { repo: host.pullRequest.repo, pr: host.pullRequest.number },
        { runtime: new FakeAgentRuntime(), host, workspaces: new TestWorkspaces(), artifacts: new InMemoryArtifactRepository(), runs: new InMemoryRunRepository() },
      ),
      /not a staging-to-main deployment/,
    );
  });

  it("rejects a closed issue-backed PR before artifact or workspace setup", async () => {
    const host = new DeploymentHost();
    host.pullRequest = { ...deploymentPr, body: "Closes #12", state: "CLOSED", headBranch: "feature/release" };
    const workspaces = new TestWorkspaces();
    await assert.rejects(
      reviewExistingPullRequest(
        { repo: host.pullRequest.repo, pr: host.pullRequest.number },
        { runtime: new FakeAgentRuntime(), host, workspaces, artifacts: new InMemoryArtifactRepository(), runs: new InMemoryRunRepository() },
      ),
      /must be OPEN at freeze, found CLOSED/,
    );
    assert.equal(workspaces.removed, false);
    assert.equal(host.publications.length, 0);
  });
});
