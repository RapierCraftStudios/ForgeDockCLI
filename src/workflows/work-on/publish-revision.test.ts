// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createArtifact, type DurableArtifact } from "../../core/artifacts/schema.js";
import type { ForgeHost, PullRequestSnapshot } from "../../core/ports/forge-host.js";
import type { GitWorkspace, GitWorkspaceManager } from "../../core/ports/git-workspace.js";
import { InMemoryArtifactRepository, InMemoryRunRepository } from "../../core/ports/repositories.js";
import { createRun, transition } from "../../core/state/machine.js";
import { publishRemediationRevision } from "./publish-revision.js";

const oldSha = "a".repeat(40);
const verifiedSha = "b".repeat(40);
const workspace: GitWorkspace = { path: "/tmp/revision", branch: "forgedock/issue-6", baseRef: "main" };
const stalePr: PullRequestSnapshot = {
  repo: "a/b", number: 57, title: "Fix", body: "", url: "https://github.test/a/b/pull/57",
  state: "OPEN", headSha: oldSha, headBranch: workspace.branch, baseBranch: "main",
};

function packetFor(run: ReturnType<typeof createRun>): ReturnType<typeof createArtifact<"BuildPacket">> {
  return createArtifact({ kind: "BuildPacket", runId: run.runId, subject: run.subject, producer: { role: "packet-author" }, payload: {
    scope: ["Fix"], acceptanceCriteria: ["Pass"], context: [], implementationPlan: ["Edit"], expectedPaths: ["docs/a.md"], verificationPlan: ["npm test"], risks: [], outOfScope: [],
  } });
}

async function remediationRun(runs: InMemoryRunRepository, runId: string): Promise<ReturnType<typeof createRun>> {
  let run = createRun({ workflow: "work-on", subject: { repo: "a/b", issue: 6 }, runId, target: { lane: "fast", targetBranch: "main" } });
  await runs.create(run);
  for (const event of [
    "START_INVESTIGATION", "INVESTIGATION_CONFIRMED", "BUILD_PACKET_READY", "BUILD_COMPLETED",
    "VERIFICATION_PASSED", "PR_PUBLISHED", "REVIEW_CHANGES_REQUESTED", "REMEDIATION_COMPLETED", "VERIFICATION_PASSED",
  ] as const) {
    const next = transition(run, event, event === "VERIFICATION_PASSED" ? { headSha: verifiedSha } : {});
    await runs.commit(run.version, next.state, next.record);
    run = next.state;
  }
  return run;
}

class RevisionGit implements GitWorkspaceManager {
  pushes = 0;
  async create(): Promise<GitWorkspace> { return workspace; }
  async changedPaths(): Promise<string[]> { return ["docs/a.md"]; }
  async revisionChangedPaths(): Promise<string[]> { return ["docs/a.md"]; }
  async syncToRemoteHead(): Promise<void> {}
  async isAncestor(): Promise<boolean> { return true; }
  async prepareWorkspaceDependencies(): Promise<void> {}
  async committedContentMatches(): Promise<boolean> { return true; }
  async commit(): Promise<string> { return verifiedSha; }
  async push(): Promise<void> { this.pushes += 1; }
  async head(): Promise<string> { return verifiedSha; }
  async remove(): Promise<void> {}
}

class LaggingPrHost implements ForgeHost {
  directRefReads = 0;
  async materializeDecomposition() { return []; }
  async createPullRequest(): Promise<PullRequestSnapshot> { return stalePr; }
  async getPullRequest(): Promise<PullRequestSnapshot> { return { ...stalePr }; }
  async getBranchHead(): Promise<string> { this.directRefReads++; return verifiedSha; }
  async getPullRequestDiff(): Promise<string> { return ""; }
  async publishPullRequestComment(): Promise<void> {}
  async materializeReviewFinding() { return { repo: "a/b", number: 99, title: "finding", body: "", url: "https://github.test/a/b/issues/99", state: "OPEN" as const }; }
  async mergePullRequest(): Promise<void> {}
  async closeIssue(): Promise<void> {}
}

class ThirdHeadHost extends LaggingPrHost {
  override async getBranchHead(_repo?: string, branch?: string): Promise<string> {
    this.directRefReads++;
    return branch === "main" ? verifiedSha : "d".repeat(40);
  }
}

describe("remediation revision publication", () => {
  it("rejects a target/build base mismatch before any remediation push", async () => {
    const runs = new InMemoryRunRepository();
    const run = await remediationRun(runs, "run_revision_base_mismatch");
    const buildResult = createArtifact({
      kind: "BuildResult", runId: run.runId, subject: run.subject, producer: { role: "controller" },
      payload: {
        branch: workspace.branch, baseSha: verifiedSha, headSha: verifiedSha, changedPaths: ["docs/a.md"], summary: "remediated",
        acceptanceEvidence: [], checks: [], decisions: [], residualRisks: [],
      },
    });
    const git = new RevisionGit();
    await assert.rejects(
      publishRemediationRevision({ run, pullRequest: stalePr, packet: packetFor(run), buildResult, workspace, expectedTargetHeadSha: oldSha }, {
        git, host: new LaggingPrHost(), runs,
      }),
      /does not match verified BuildResult base/,
    );
    assert.equal(git.pushes, 0);
  });

  it("rejects a workspace base mismatch before any remediation push", async () => {
    const runs = new InMemoryRunRepository();
    const run = await remediationRun(runs, "run_revision_workspace_base_mismatch");
    const buildResult = createArtifact({
      kind: "BuildResult", runId: run.runId, subject: run.subject, producer: { role: "controller" },
      payload: {
        branch: workspace.branch, baseSha: verifiedSha, headSha: verifiedSha, changedPaths: ["docs/a.md"], summary: "remediated",
        acceptanceEvidence: [], checks: [], decisions: [], residualRisks: [],
      },
    });
    const git = new RevisionGit();
    await assert.rejects(
      publishRemediationRevision({ run, pullRequest: stalePr, packet: packetFor(run), buildResult, workspace: { ...workspace, baseSha: oldSha }, expectedTargetHeadSha: verifiedSha }, {
        git, host: new LaggingPrHost(), runs,
      }),
      /workspace base .* does not match verified target base/,
    );
    assert.equal(git.pushes, 0);
  });

  it("rejects mixed old/fresh remote and PR heads without pushing", async () => {
    const runs = new InMemoryRunRepository();
    const run = await remediationRun(runs, "run_revision_mixed_heads");
    const buildResult = createArtifact({
      kind: "BuildResult", runId: run.runId, subject: run.subject, producer: { role: "controller" },
      payload: { branch: workspace.branch, baseSha: verifiedSha, headSha: verifiedSha, changedPaths: ["docs/a.md"], summary: "remediated", acceptanceEvidence: [], checks: [], decisions: [], residualRisks: [] },
    });
    const prior = createArtifact({
      kind: "ReviewVerdict", runId: run.runId, subject: { ...run.subject, pr: stalePr.number }, producer: { role: "reviewer" },
      payload: { disposition: "request_changes", headSha: oldSha, baseBranch: "main", reviewerRoles: ["reviewer"], findings: [], checks: [] },
    });
    const git = new RevisionGit();
    await assert.rejects(
      publishRemediationRevision({
        run, pullRequest: stalePr, packet: packetFor(run), verdict: prior, buildResult, sourceBuildResult: buildResult, workspace,
        expectedTargetHeadSha: verifiedSha, expectedExistingHeadSha: oldSha, fencedReplay: true,
      }, { git, host: new LaggingPrHost(), runs }),
      /remote branch and PR heads disagree/,
    );
    assert.equal(git.pushes, 0);
  });

  it("rejects a third remote head without pushing", async () => {
    const runs = new InMemoryRunRepository();
    const run = await remediationRun(runs, "run_revision_third_head");
    const buildResult = createArtifact({
      kind: "BuildResult", runId: run.runId, subject: run.subject, producer: { role: "controller" },
      payload: { branch: workspace.branch, baseSha: verifiedSha, headSha: verifiedSha, changedPaths: ["docs/a.md"], summary: "remediated", acceptanceEvidence: [], checks: [], decisions: [], residualRisks: [] },
    });
    const prior = createArtifact({
      kind: "ReviewVerdict", runId: run.runId, subject: { ...run.subject, pr: stalePr.number }, producer: { role: "reviewer" },
      payload: { disposition: "request_changes", headSha: oldSha, baseBranch: "main", reviewerRoles: ["reviewer"], findings: [], checks: [] },
    });
    const git = new RevisionGit();
    await assert.rejects(
      publishRemediationRevision({
        run, pullRequest: stalePr, packet: packetFor(run), verdict: prior, buildResult, sourceBuildResult: buildResult, workspace,
        expectedTargetHeadSha: verifiedSha, expectedExistingHeadSha: oldSha, fencedReplay: true,
      }, { git, host: new ThirdHeadHost(), runs }),
      /unexpected head/,
    );
    assert.equal(git.pushes, 0);
  });

  it("uses the directly observed branch ref when GitHub's PR projection briefly lags the push", async () => {
    const runs = new InMemoryRunRepository();
    let run = createRun({
      workflow: "work-on",
      subject: { repo: "a/b", issue: 6 },
      runId: "run_revision",
      target: { lane: "fast", targetBranch: "main" },
    });
    await runs.create(run);
    for (const event of [
      "START_INVESTIGATION", "INVESTIGATION_CONFIRMED", "BUILD_PACKET_READY", "BUILD_COMPLETED",
      "VERIFICATION_PASSED", "PR_PUBLISHED", "REVIEW_CHANGES_REQUESTED", "REMEDIATION_COMPLETED", "VERIFICATION_PASSED",
    ] as const) {
      const next = transition(run, event, event === "VERIFICATION_PASSED" ? { headSha: verifiedSha } : {});
      await runs.commit(run.version, next.state, next.record);
      run = next.state;
    }
    const buildResult = createArtifact({
      kind: "BuildResult", runId: run.runId, subject: run.subject, producer: { role: "controller" },
      payload: {
        branch: workspace.branch, baseSha: verifiedSha, headSha: verifiedSha, changedPaths: ["docs/a.md"], summary: "remediated",
        acceptanceEvidence: [], checks: [], decisions: [], residualRisks: [],
      },
    });
    const host = new LaggingPrHost();
    const result = await publishRemediationRevision({ run, pullRequest: stalePr, packet: packetFor(run), buildResult, workspace, expectedTargetHeadSha: verifiedSha }, {
      git: new RevisionGit(), host, runs,
    });
    assert.equal(result.run.state, "reviewing");
    assert.equal(result.pullRequest.headSha, verifiedSha);
    assert.equal(host.directRefReads, 2);
  });

  it("fences a target that advanced after remediation verification before pushing", async () => {
    const runs = new InMemoryRunRepository();
    let run = createRun({
      workflow: "work-on",
      subject: { repo: "a/b", issue: 6 },
      runId: "run_revision_target_fence",
      target: { lane: "fast", targetBranch: "main" },
    });
    await runs.create(run);
    for (const event of [
      "START_INVESTIGATION", "INVESTIGATION_CONFIRMED", "BUILD_PACKET_READY", "BUILD_COMPLETED",
      "VERIFICATION_PASSED", "PR_PUBLISHED", "REVIEW_CHANGES_REQUESTED", "REMEDIATION_COMPLETED", "VERIFICATION_PASSED",
    ] as const) {
      const next = transition(run, event, event === "VERIFICATION_PASSED" ? { headSha: verifiedSha } : {});
      await runs.commit(run.version, next.state, next.record);
      run = next.state;
    }
    const expectedBaseSha = oldSha;
    const buildResult = createArtifact({
      kind: "BuildResult", runId: run.runId, subject: run.subject, producer: { role: "controller" },
      payload: {
        branch: workspace.branch, baseSha: expectedBaseSha, headSha: verifiedSha, changedPaths: ["docs/a.md"], summary: "remediated",
        acceptanceEvidence: [], checks: [], decisions: [], residualRisks: [],
      },
    });
    const git = new RevisionGit();
    const host = new LaggingPrHost();
    const artifacts = new InMemoryArtifactRepository();
    const verdict = createArtifact({
      kind: "ReviewVerdict", runId: run.runId, subject: { ...run.subject, pr: stalePr.number }, producer: { role: "reviewer" },
      payload: { disposition: "request_changes", headSha: oldSha, baseBranch: "main", reviewerRoles: ["reviewer"], findings: [], checks: [] },
    });
    await artifacts.append(verdict);
    await assert.rejects(
      publishRemediationRevision({ run, pullRequest: stalePr, packet: packetFor(run), verdict, buildResult, workspace: { ...workspace, baseSha: expectedBaseSha }, expectedTargetHeadSha: expectedBaseSha }, {
        git, host, runs, artifacts,
      }),
      /Target branch main advanced before publication/,
    );
    assert.equal(git.pushes, 0);
    assert.equal((await runs.load(run.runId))?.state, "target_recovery");
    const checkpoints = (await artifacts.list(run.subject, "TargetAdvanceCheckpoint"))
      .filter((artifact): artifact is DurableArtifact<"TargetAdvanceCheckpoint"> => artifact.kind === "TargetAdvanceCheckpoint");
    assert.equal(checkpoints.length, 1);
    assert.equal(checkpoints[0]?.payload.observedTargetSha, verifiedSha);
    assert.equal(checkpoints[0]?.payload.phase, "target-read");
    assert.equal(checkpoints[0]?.payload.sourceVerdictId, verdict.id);
    assert.equal(checkpoints[0]?.payload.pullRequest, stalePr.number);
  });
});
