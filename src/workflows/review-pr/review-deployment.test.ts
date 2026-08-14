import assert from "node:assert/strict";
import { describe, it } from "node:test";
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
  readonly comments: string[] = [];

  async materializeDecomposition() { return []; }
  async createPullRequest(): Promise<PullRequestSnapshot> { return deploymentPr; }
  async getPullRequest(): Promise<PullRequestSnapshot> { return deploymentPr; }
  async getPullRequestDiff(): Promise<string> {
    return "diff --git a/src/release.ts b/src/release.ts\n+export const release = true;";
  }
  async getPullRequestMergeGate(_repo: string, number: number, headSha: string, baseBranch: string): Promise<PullRequestMergeGate> {
    return {
      repo: deploymentPr.repo,
      pullRequest: number,
      headSha,
      baseBranch,
      mergeable: true,
      requiredChecks: [{ name: "CI", state: "passed" }],
      observedAt: new Date().toISOString(),
    };
  }
  async publishPullRequestComment(input: { body: string }): Promise<void> {
    this.comments.push(input.body);
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

describe("issue-less deployment PR review", () => {
  it("reviews staging-to-main without an issue or BuildResult", async () => {
    const host = new DeploymentHost();
    const runtime = new FakeAgentRuntime(Array.from({ length: 8 }, () => clean));
    const workspaces = new TestWorkspaces();
    const result = await reviewExistingPullRequest(
      { repo: deploymentPr.repo, pr: deploymentPr.number },
      { runtime, host, workspaces, artifacts: new InMemoryArtifactRepository(), runs: new InMemoryRunRepository() },
    );

    assert.equal(result.run.state, "merging");
    assert.deepEqual(result.verdict.subject, { repo: deploymentPr.repo, pr: deploymentPr.number });
    assert.deepEqual(result.verdict.payload.checks, [{ command: "GitHub required check: CI", status: "passed", durationMs: 0 }]);
    assert.ok(runtime.tasks.length > 0);
    assert.ok(runtime.tasks.every((task) => !task.context.some((artifact) => artifact.kind === "BuildResult")));
    assert.equal(host.comments.length, runtime.tasks.length);
    assert.equal(workspaces.removed, true);
  });

  it("still requires an issue for a non-deployment PR", async () => {
    const host = new DeploymentHost();
    const featurePr = { ...deploymentPr, headBranch: "feature/release" };
    host.getPullRequest = async () => featurePr;

    await assert.rejects(
      reviewExistingPullRequest(
        { repo: featurePr.repo, pr: featurePr.number },
        { runtime: new FakeAgentRuntime(), host, workspaces: new TestWorkspaces(), artifacts: new InMemoryArtifactRepository(), runs: new InMemoryRunRepository() },
      ),
      /not a staging-to-main deployment/,
    );
  });
});
