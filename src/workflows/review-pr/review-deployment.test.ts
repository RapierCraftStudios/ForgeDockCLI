// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_REVIEW_CI } from "../../core/config/forgedock-config.js";
import type { ForgeHost, PullRequestMergeGate, PullRequestSnapshot } from "../../core/ports/forge-host.js";
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

class DeploymentHost implements ForgeHost {
  readonly publications: Array<{ repo: string; pullRequest: number; marker: string; body: string }> = [];
  pullRequest = deploymentPr;
  pullRequestSnapshots: PullRequestSnapshot[] = [];
  requiredChecks: PullRequestMergeGate["requiredChecks"] = [{ name: "CI", state: "passed" }];
  mergeGateIdentity: Partial<Pick<PullRequestMergeGate, "repo" | "pullRequest" | "headSha" | "baseBranch">> = {};

  async materializeDecomposition() { return []; }
  async createPullRequest(): Promise<PullRequestSnapshot> { return this.pullRequest; }
  async getPullRequest(): Promise<PullRequestSnapshot> { return this.pullRequestSnapshots.shift() ?? this.pullRequest; }
  async getPullRequestDiff(): Promise<string> {
    return "diff --git a/src/release.ts b/src/release.ts\n+export const release = true;";
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
    return {
      repo: deploymentPr.repo,
      number: 100,
      title: "finding",
      body: "",
      url: "https://github.test/a/b/issues/100",
      state: "OPEN" as const,
    };
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

  it("allows configured pending CI to overlap review, then asks for a green exact head", async () => {
    const host = new DeploymentHost();
    host.requiredChecks = [{ name: "CI", state: "pending", detailsUrl: "https://github.test/checks/ci" }];
    const runtime = new FakeAgentRuntime(Array.from({ length: 8 }, () => clean));
    const workspaces = new TestWorkspaces();

    await assert.rejects(
      reviewExistingPullRequest(
        { repo: deploymentPr.repo, pr: deploymentPr.number, ci: { policy: DEFAULT_REVIEW_CI } },
        { runtime, host, workspaces, artifacts: new InMemoryArtifactRepository(), runs: new InMemoryRunRepository() },
      ),
      /CI=pending.*Please fix.*rerun \/review-pr/s,
    );

    assert.ok(runtime.tasks.length > 0);
    assert.equal(workspaces.removed, true);
    assertNoDeploymentGate(host.publications);
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
