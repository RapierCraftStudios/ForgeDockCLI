import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createArtifact } from "../../core/artifacts/schema.js";
import type { ForgeHost, PullRequestSnapshot } from "../../core/ports/forge-host.js";
import { InMemoryArtifactRepository, InMemoryRunRepository } from "../../core/ports/repositories.js";
import { createRun, transition, type RunState, type TransitionEvent } from "../../core/state/machine.js";
import { completeWorkItem } from "./complete.js";

const sha = "c".repeat(40);
const openPr: PullRequestSnapshot = { repo: "a/b", number: 9, title: "Fix", body: "", url: "https://github.test/a/b/pull/9", state: "OPEN", headSha: sha, headBranch: "fix", baseBranch: "main" };

class CompletionHost implements ForgeHost {
  async materializeDecomposition() { return []; }
  snapshot = { ...openPr };
  merges = 0;
  closes: number[] = [];
  async createPullRequest(): Promise<PullRequestSnapshot> { return this.snapshot; }
  async getPullRequest(): Promise<PullRequestSnapshot> { return { ...this.snapshot }; }
  async getPullRequestDiff(): Promise<string> { return ""; }
  async mergePullRequest(): Promise<void> { this.merges++; this.snapshot.state = "MERGED"; }
  async closeIssue(_repo: string, issue: number): Promise<void> { this.closes.push(issue); }
}

async function mergingRun(runs: InMemoryRunRepository): Promise<RunState> {
  let run = createRun({ workflow: "work-on", subject: { repo: "a/b", issue: 2 }, runId: `run_complete_${crypto.randomUUID()}` });
  await runs.create(run);
  for (const event of ["START_INVESTIGATION", "INVESTIGATION_CONFIRMED", "BUILD_PACKET_READY", "BUILD_COMPLETED", "VERIFICATION_PASSED", "PR_PUBLISHED", "REVIEW_APPROVED"] as TransitionEvent[]) {
    const next = transition(run, event, { headSha: sha });
    await runs.commit(run.version, next.state, next.record);
    run = next.state;
  }
  return run;
}

function verdict(run: RunState) {
  return createArtifact({
    kind: "ReviewVerdict", runId: run.runId, subject: { ...run.subject, pr: 9 }, producer: { role: "controller" },
    payload: { headSha: sha, disposition: "approve", reviewerRoles: ["correctness"], findings: [], checks: [] },
  });
}

describe("merge and close authority", () => {
  it("defaults to a human merge checkpoint without changing state", async () => {
    const runs = new InMemoryRunRepository();
    const run = await mergingRun(runs);
    const host = new CompletionHost();
    const result = await completeWorkItem({ run, pullRequest: openPr, verdict: verdict(run), autoMerge: false }, {
      host, artifacts: new InMemoryArtifactRepository(), runs,
    });
    assert.equal(result.awaitingHuman, true);
    assert.equal(result.run.state, "merging");
    assert.equal(host.merges, 0);
  });

  it("auto-merges only the reviewed SHA then records Outcome and closes", async () => {
    const runs = new InMemoryRunRepository();
    const run = await mergingRun(runs);
    const host = new CompletionHost();
    const result = await completeWorkItem({ run, pullRequest: openPr, verdict: verdict(run), autoMerge: true }, {
      host, artifacts: new InMemoryArtifactRepository(), runs,
    });
    assert.equal(result.run.state, "completed");
    assert.equal(result.outcome?.payload.status, "merged");
    assert.equal(host.merges, 1);
    assert.deepEqual(host.closes, [2]);
  });

  it("projects a successful batch Outcome to every member before closing them", async () => {
    const runs = new InMemoryRunRepository();
    const run = await mergingRun(runs);
    const host = new CompletionHost();
    const artifacts = new InMemoryArtifactRepository();
    const result = await completeWorkItem({
      run, pullRequest: openPr, verdict: verdict(run), autoMerge: true, childIssues: [7, 8, 7, 2],
    }, { host, artifacts, runs });
    assert.deepEqual(result.outcome?.payload.childIssues, ["issue-7", "issue-8"]);
    assert.deepEqual(host.closes, [7, 8, 2]);
    const childOutcomes = (await artifacts.list({ repo: "a/b", issue: 7 }, "Outcome"))
      .filter((artifact) => artifact.kind === "Outcome");
    assert.equal(childOutcomes[0]?.payload.status, "merged");
    assert.match(childOutcomes[0]?.payload.reason ?? "", /batch issue #2/);
  });
});
