// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_REVIEW_CI } from "../../core/config/forgedock-config.js";
import type { ForgeHost, PullRequestMergeGate, PullRequestSnapshot, ReviewFindingPublicationFence } from "../../core/ports/forge-host.js";
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
const deploymentWildcardPolicy = { ...DEFAULT_REVIEW_CI, deploymentChecks: ["Pipeline *"] };

class DeploymentHost implements ForgeHost {
  readonly publications: Array<{ repo: string; pullRequest: number; marker: string; body: string }> = [];
  materializedFindings = 0;
  reconciledFindings = 0;
  readonly mergeGateHeads: string[] = [];
  pullRequest = deploymentPr;
  pullRequestSnapshots: PullRequestSnapshot[] = [];
  requiredChecks: PullRequestMergeGate["requiredChecks"] = [{ name: "CI", state: "passed" }];
  mergeGateIdentity: Partial<Pick<PullRequestMergeGate, "repo" | "pullRequest" | "headSha" | "baseBranch">> = {};
  publicationFence: ReviewFindingPublicationFence | undefined;
  async beginReviewFindingPublication(input: { repo: string; pullRequest: PullRequestSnapshot; runId: string }) {
    this.publicationFence = {
      repo: input.repo, pullRequest: input.pullRequest.number,
      generation: (this.publicationFence?.generation ?? 0) + 1,
      runId: input.runId, headSha: input.pullRequest.headSha,
      headBranch: input.pullRequest.headBranch, baseBranch: input.pullRequest.baseBranch,
    };
    return { ...this.publicationFence };
  }
  async assertReviewFindingPublication(fence: ReviewFindingPublicationFence) { assert.deepEqual(fence, this.publicationFence); }

  async materializeDecomposition() { return []; }
  async createPullRequest(): Promise<PullRequestSnapshot> { return this.pullRequest; }
  async getPullRequest(): Promise<PullRequestSnapshot> { return this.pullRequestSnapshots.shift() ?? this.pullRequest; }
  async getPullRequestDiff(): Promise<string> {
    return "diff --git a/src/release.ts b/src/release.ts\n+export const release = true;";
  }
  async getPullRequestMergeGate(_repo: string, number: number, headSha: string, baseBranch: string): Promise<PullRequestMergeGate> {
    this.mergeGateHeads.push(headSha);
    return {
      repo: deploymentPr.repo,
      pullRequest: number,
      headSha,
      baseBranch,
      ...this.mergeGateIdentity,
      mergeable: true,
      requiredChecksProvenance: "github-required",
      requiredChecksHeadSha: headSha,
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
  async reconcileReviewFindings(): Promise<readonly number[]> {
    this.reconciledFindings += 1;
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
    assert.deepEqual((await artifacts.list({ repo: deploymentPr.repo, pr: deploymentPr.number })).map(({ kind }) => kind), ["FindingRootLedger", "ReviewFindingProjection", "ReviewFindingProjection", "ReviewVerdict"]);
    assertNoDeploymentGate(host.publications);
    assert.equal(workspaces.removed, true);
  });

  it("blocks an unmatched deployment wildcard before reviewer setup", async () => {
    const host = new DeploymentHost();
    const runtime = new FakeAgentRuntime();
    const workspaces = new TestWorkspaces();
    const artifacts = new InMemoryArtifactRepository();

    await assert.rejects(
      reviewExistingPullRequest(
        { repo: deploymentPr.repo, pr: deploymentPr.number, ci: { policy: deploymentWildcardPolicy } },
        { runtime, host, workspaces, artifacts, runs: new InMemoryRunRepository() },
      ),
      /ForgeDock deployment PR checks are not green before independent review: Pipeline \*=unavailable/,
    );

    assert.equal(runtime.tasks.length, 0);
    assert.equal(workspaces.removed, false);
    assert.deepEqual(await artifacts.list({ repo: deploymentPr.repo, pr: deploymentPr.number }), []);
    assert.deepEqual(host.mergeGateHeads, [sha]);
    assertNoDeploymentGate(host.publications);
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

  it("rejects an unmatched deployment wildcard before verdict publication", async () => {
    const host = new DeploymentHost();
    host.requiredChecks = [{ name: "Pipeline Linux", state: "passed" }];
    const runtime = new FakeAgentRuntime([
      () => {
        host.requiredChecks = [{ name: "CI", state: "passed" }];
        return clean;
      },
      ...Array.from({ length: 7 }, () => clean),
    ]);
    const artifacts = new InMemoryArtifactRepository();
    const workspaces = new TestWorkspaces();

    await assert.rejects(
      reviewExistingPullRequest(
        { repo: deploymentPr.repo, pr: deploymentPr.number, ci: { policy: deploymentWildcardPolicy } },
        { runtime, host, workspaces, artifacts, runs: new InMemoryRunRepository() },
      ),
      /ForgeDock deployment PR checks are not green after independent review of the exact head: Pipeline \*=unavailable/,
    );

    assert.ok(runtime.tasks.length > 0);
    assert.equal(workspaces.removed, true);
    assert.deepEqual(await artifacts.list({ repo: deploymentPr.repo, pr: deploymentPr.number }), []);
    assert.equal(host.materializedFindings, 0);
    assert.equal(host.reconciledFindings, 0);
    assert.ok(host.mergeGateHeads.length >= 2);
    assert.equal(host.mergeGateHeads.every((head) => head === sha), true);
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
