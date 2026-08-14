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
  readonly publications: Array<{ repo: string; pullRequest: number; marker: string; body: string }> = [];
  pullRequest = deploymentPr;
  pullRequestSnapshots: PullRequestSnapshot[] = [];
  requiredChecks: PullRequestMergeGate["requiredChecks"];
  mergeGateIdentity: Partial<Pick<PullRequestMergeGate, "repo" | "pullRequest" | "headSha" | "baseBranch">> = {};

  constructor(markerCheckState?: PullRequestMergeGate["requiredChecks"][number]["state"]) {
    this.requiredChecks = [
      { name: "CI", state: "passed" },
      ...(markerCheckState ? [{ name: "Check for FORGE gate markers", state: markerCheckState }] : []),
    ];
  }

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
    assert.equal(host.comments.length, runtime.tasks.length + 2);
    assert.ok(host.comments.some((comment) => comment.includes("<!-- FORGE:GATE_PASS -->")));
    const gatePublications = host.publications.filter(({ marker }) => marker.includes("FORGEDOCK:DEPLOYMENT_GATE_"));
    assert.equal(gatePublications.length, 2);
    assert.notEqual(gatePublications[0]?.marker, gatePublications[1]?.marker);
    assert.match(gatePublications[0]?.body ?? "", new RegExp(`DEPLOYMENT_GATE_START v2 repo=a/b pr=9 head=${sha}`));
    assert.match(gatePublications[1]?.body ?? "", new RegExp(`DEPLOYMENT_GATE_PASS v2 repo=a/b pr=9 head=${sha}`));
    assert.equal(workspaces.removed, true);
  });

  it("bootstraps a failed marker check and publishes a trusted gate result", async () => {
    const host = new DeploymentHost("failed");
    const runtime = new FakeAgentRuntime(Array.from({ length: 8 }, () => clean));
    const workspaces = new TestWorkspaces();
    const result = await reviewExistingPullRequest(
      { repo: deploymentPr.repo, pr: deploymentPr.number },
      { runtime, host, workspaces, artifacts: new InMemoryArtifactRepository(), runs: new InMemoryRunRepository() },
    );

    assert.equal(result.verdict.payload.disposition, "approve");
    assert.ok(host.comments.some((comment) => comment.includes("<!-- FORGE:GATE_PASS -->")));
    assert.ok(host.comments.some((comment) => comment.includes("<!-- FORGE:SPEC_LOADED -->")));
    assert.deepEqual(result.verdict.payload.checks[1], {
      command: "GitHub required check: Check for FORGE gate markers",
      status: "failed",
      durationMs: 0,
      failureClass: "infrastructure",
      failureSignatures: ["github-required-check:failed"],
      summary: "GitHub state: failed; Self-referential deployment gate; this review must publish its terminal marker before the check can turn green",
    });
  });

  it("preserves a pending marker check as non-green evidence instead of skipped", async () => {
    const host = new DeploymentHost("pending");
    const artifactStore = new InMemoryArtifactRepository();
    const runtime = new FakeAgentRuntime(Array.from({ length: 8 }, () => clean));
    const result = await reviewExistingPullRequest(
      { repo: deploymentPr.repo, pr: deploymentPr.number },
      {
        runtime,
        host,
        workspaces: new TestWorkspaces(),
        artifacts: artifactStore,
        runs: new InMemoryRunRepository(),
      },
    );

    const markerCheck = result.verdict.payload.checks.find(({ command }) => command.includes("FORGE gate markers"));
    assert.equal(markerCheck?.status, "failed");
    assert.equal(markerCheck?.failureClass, "infrastructure");
    assert.deepEqual(markerCheck?.failureSignatures, ["github-required-check:pending"]);
    assert.equal(markerCheck?.summary, "GitHub state: pending; Self-referential deployment gate; this review must publish its terminal marker before the check can turn green");
    const investigation = runtime.tasks
      .flatMap((task) => task.context)
      .find((artifact) => artifact.kind === "Investigation");
    assert.ok(investigation);
    assert.ok(investigation.payload.evidence.some(({ detail }) => detail.includes("GitHub state: pending")));
    const published = await artifactStore.list({ repo: deploymentPr.repo, pr: deploymentPr.number });
    assert.deepEqual(published.map(({ kind }) => kind), ["ReviewVerdict"]);
  });

  it("publishes a current-head failure gate when deployment setup throws", async () => {
    const host = new DeploymentHost();
    host.requiredChecks = [{ name: "CI", state: "failed", detailsUrl: "https://github.test/checks/ci" }];
    const workspaces = new TestWorkspaces();

    await assert.rejects(
      reviewExistingPullRequest(
        { repo: deploymentPr.repo, pr: deploymentPr.number },
        {
          runtime: new FakeAgentRuntime(), host, workspaces,
          artifacts: new InMemoryArtifactRepository(), runs: new InMemoryRunRepository(),
        },
      ),
      /Deployment PR checks are not green: CI=failed/,
    );

    const gatePublications = host.publications.filter(({ marker }) => marker.includes("FORGEDOCK:DEPLOYMENT_GATE_"));
    assert.equal(gatePublications.length, 2);
    assert.notEqual(gatePublications[0]?.marker, gatePublications[1]?.marker);
    assert.match(gatePublications[0]?.body ?? "", new RegExp(`DEPLOYMENT_GATE_START v2 repo=a/b pr=9 head=${sha}`));
    assert.match(gatePublications[1]?.body ?? "", /<!-- FORGE:GATE_FAILURE -->/);
    assert.match(gatePublications[1]?.body ?? "", new RegExp(`DEPLOYMENT_GATE_FAILURE v2 repo=a/b pr=9 head=${sha}`));
    assert.match(gatePublications[1]?.body ?? "", /Detail: Deployment PR checks are not green: CI=failed/);
    assert.equal(workspaces.removed, false);
  });

  it("re-freezes an advanced head immediately before publishing the start marker", async () => {
    const host = new DeploymentHost();
    const nextSha = "b".repeat(40);
    const advanced = { ...deploymentPr, headSha: nextSha };
    host.pullRequestSnapshots = [deploymentPr, advanced];
    host.pullRequest = advanced;

    const result = await reviewExistingPullRequest(
      { repo: deploymentPr.repo, pr: deploymentPr.number },
      {
        runtime: new FakeAgentRuntime(Array.from({ length: 8 }, () => clean)),
        host,
        workspaces: new TestWorkspaces(),
        artifacts: new InMemoryArtifactRepository(),
        runs: new InMemoryRunRepository(),
      },
    );

    assert.equal(result.verdict.payload.headSha, nextSha);
    const gatePublications = host.publications.filter(({ marker }) => marker.includes("FORGEDOCK:DEPLOYMENT_GATE_"));
    assert.equal(gatePublications.length, 2);
    assert.ok(gatePublications.every(({ marker }) => marker.includes(`head=${nextSha}`)));
    assert.equal(gatePublications.some(({ marker }) => marker.includes(`head=${sha}`)), false);
  });

  it("uses the latest trusted freeze when failure re-read is unavailable", async () => {
    const host = new DeploymentHost();
    const nextSha = "b".repeat(40);
    const advanced = { ...deploymentPr, headSha: nextSha };
    host.requiredChecks = [{ name: "CI", state: "failed" }];
    let reads = 0;
    host.getPullRequest = async () => {
      reads++;
      if (reads === 1) return deploymentPr;
      if (reads === 2) return advanced;
      throw new Error("GitHub re-read unavailable");
    };

    await assert.rejects(
      reviewExistingPullRequest(
        { repo: deploymentPr.repo, pr: deploymentPr.number },
        {
          runtime: new FakeAgentRuntime(), host, workspaces: new TestWorkspaces(),
          artifacts: new InMemoryArtifactRepository(), runs: new InMemoryRunRepository(),
        },
      ),
      /Deployment PR checks are not green: CI=failed/,
    );

    const gatePublications = host.publications.filter(({ marker }) => marker.includes("FORGEDOCK:DEPLOYMENT_GATE_"));
    assert.equal(gatePublications.length, 2);
    assert.ok(gatePublications.every(({ marker }) => marker.includes(`head=${nextSha}`)));
    assert.equal(gatePublications.some(({ marker }) => marker.includes(`head=${sha}`)), false);
  });

  it("binds a thrown stale-route failure marker to the new current head", async () => {
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
        {
          runtime, host, workspaces: new TestWorkspaces(),
          artifacts: new InMemoryArtifactRepository(), runs: new InMemoryRunRepository(),
        },
      ),
      /PR delivery route changed during reviewer execution/,
    );

    const failure = host.publications.find(({ body }) => body.includes("DEPLOYMENT_GATE_FAILURE"));
    assert.ok(failure);
    assert.match(failure.body, new RegExp(`repo=a/b pr=9 head=${nextSha}`));
    assert.doesNotMatch(failure.body, /FORGE:GATE_PASS/);
  });

  it("does not start a deployment review from a closed frozen snapshot", async () => {
    const host = new DeploymentHost();
    const closed = { ...deploymentPr, state: "CLOSED" as const };
    host.pullRequestSnapshots = [closed, deploymentPr];
    const runtime = new FakeAgentRuntime(Array.from({ length: 8 }, () => clean));
    const workspaces = new TestWorkspaces();

    await assert.rejects(
      reviewExistingPullRequest(
        { repo: deploymentPr.repo, pr: deploymentPr.number },
        {
          runtime, host, workspaces,
          artifacts: new InMemoryArtifactRepository(), runs: new InMemoryRunRepository(),
        },
      ),
      /must be OPEN at freeze, found CLOSED/,
    );

    assert.equal(runtime.tasks.length, 0);
    assert.equal(workspaces.removed, false);
    assert.equal(host.publications.some(({ body }) => body.includes("DEPLOYMENT_GATE_START")), false);
    const failure = host.publications.find(({ body }) => body.includes("DEPLOYMENT_GATE_FAILURE"));
    assert.ok(failure);
    assert.match(failure.body, new RegExp(`repo=a/b pr=9 head=${sha}`));
  });

  it("never publishes a failure marker against a mismatched host re-read identity", async () => {
    const host = new DeploymentHost();
    host.requiredChecks = [{ name: "CI", state: "failed" }];
    host.pullRequestSnapshots = [
      deploymentPr,
      deploymentPr,
      { ...deploymentPr, repo: "other/repo", number: 77 },
    ];

    await assert.rejects(
      reviewExistingPullRequest(
        { repo: deploymentPr.repo, pr: deploymentPr.number },
        {
          runtime: new FakeAgentRuntime(), host, workspaces: new TestWorkspaces(),
          artifacts: new InMemoryArtifactRepository(), runs: new InMemoryRunRepository(),
        },
      ),
      /Deployment PR checks are not green/,
    );

    const failure = host.publications.find(({ body }) => body.includes("DEPLOYMENT_GATE_FAILURE"));
    assert.ok(failure);
    assert.equal(failure.repo, deploymentPr.repo);
    assert.equal(failure.pullRequest, deploymentPr.number);
    assert.match(failure.body, /host re-read returned mismatched PR identity other\/repo#77/);
    assert.doesNotMatch(failure.body, /repo=other\/repo pr=77/);
  });

  it("rejects a mismatched initial host snapshot without publishing to the wrong PR", async () => {
    const host = new DeploymentHost();
    host.pullRequestSnapshots = [{ ...deploymentPr, repo: "other/repo", number: 77 }];

    await assert.rejects(
      reviewExistingPullRequest(
        { repo: deploymentPr.repo, pr: deploymentPr.number },
        {
          runtime: new FakeAgentRuntime(), host, workspaces: new TestWorkspaces(),
          artifacts: new InMemoryArtifactRepository(), runs: new InMemoryRunRepository(),
        },
      ),
      /initial read returned mismatched PR identity other\/repo#77 for requested a\/b#9/,
    );

    assert.equal(host.publications.length, 0);
  });

  it("rejects merge-gate evidence for a different frozen route", async () => {
    const host = new DeploymentHost();
    host.mergeGateIdentity = { headSha: "c".repeat(40) };

    await assert.rejects(
      reviewExistingPullRequest(
        { repo: deploymentPr.repo, pr: deploymentPr.number },
        {
          runtime: new FakeAgentRuntime(), host, workspaces: new TestWorkspaces(),
          artifacts: new InMemoryArtifactRepository(), runs: new InMemoryRunRepository(),
        },
      ),
      /Deployment merge-gate identity mismatch/,
    );

    assert.ok(host.publications.some(({ body }) => body.includes("DEPLOYMENT_GATE_FAILURE")));
    assert.equal(host.publications.some(({ body }) => body.includes("DEPLOYMENT_GATE_PASS")), false);
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

  it("rejects a closed issue-backed PR before artifact or workspace setup", async () => {
    const host = new DeploymentHost();
    host.pullRequest = {
      ...deploymentPr,
      body: "Closes #12",
      state: "CLOSED",
      headBranch: "feature/release",
    };
    const workspaces = new TestWorkspaces();

    await assert.rejects(
      reviewExistingPullRequest(
        { repo: host.pullRequest.repo, pr: host.pullRequest.number },
        {
          runtime: new FakeAgentRuntime(), host, workspaces,
          artifacts: new InMemoryArtifactRepository(), runs: new InMemoryRunRepository(),
        },
      ),
      /must be OPEN at freeze, found CLOSED/,
    );
    assert.equal(workspaces.removed, false);
    assert.equal(host.publications.length, 0);
  });
});
