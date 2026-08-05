// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createArtifact } from "../../core/artifacts/schema.js";
import type { ForgeHost, PullRequestSnapshot } from "../../core/ports/forge-host.js";
import type { GitWorkspace, GitWorkspaceManager } from "../../core/ports/git-workspace.js";
import { InMemoryRunRepository } from "../../core/ports/repositories.js";
import { createRun, transition } from "../../core/state/machine.js";
import { publishRemediationRevision } from "./publish-revision.js";

const oldSha = "a".repeat(40);
const verifiedSha = "b".repeat(40);
const workspace: GitWorkspace = { path: "/tmp/revision", branch: "forgedock/issue-6", baseRef: "main" };
const stalePr: PullRequestSnapshot = {
  repo: "a/b", number: 57, title: "Fix", body: "", url: "https://github.test/a/b/pull/57",
  state: "OPEN", headSha: oldSha, headBranch: workspace.branch, baseBranch: "main",
};

class RevisionGit implements GitWorkspaceManager {
  async create(): Promise<GitWorkspace> { return workspace; }
  async changedPaths(): Promise<string[]> { return ["docs/a.md"]; }
  async commit(): Promise<string> { return verifiedSha; }
  async push(): Promise<void> {}
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

describe("remediation revision publication", () => {
  it("uses the directly observed branch ref when GitHub's PR projection briefly lags the push", async () => {
    const runs = new InMemoryRunRepository();
    let run = createRun({ workflow: "work-on", subject: { repo: "a/b", issue: 6 }, runId: "run_revision" });
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
        branch: workspace.branch, headSha: verifiedSha, changedPaths: ["docs/a.md"], summary: "remediated",
        acceptanceEvidence: [], checks: [], decisions: [], residualRisks: [],
      },
    });
    const host = new LaggingPrHost();
    const result = await publishRemediationRevision({ run, pullRequest: stalePr, buildResult, workspace }, {
      git: new RevisionGit(), host, runs,
    });
    assert.equal(result.run.state, "reviewing");
    assert.equal(result.pullRequest.headSha, verifiedSha);
    assert.equal(host.directRefReads, 1);
  });
});
