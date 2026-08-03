import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createArtifact } from "../../core/artifacts/schema.js";
import type { ForgeHost, PullRequestSnapshot } from "../../core/ports/forge-host.js";
import type { GitWorkspace, GitWorkspaceManager } from "../../core/ports/git-workspace.js";
import { InMemoryRunRepository } from "../../core/ports/repositories.js";
import { createRun, transition, type RunState, type TransitionEvent } from "../../core/state/machine.js";
import { publishPullRequest } from "./publish.js";

const sha = "d".repeat(40);
const workspace: GitWorkspace = { path: "/tmp/w", branch: "forgedock/fix", baseRef: "main" };
class PublishGit implements GitWorkspaceManager {
  pushed = false;
  async create(): Promise<GitWorkspace> { return workspace; }
  async changedPaths(): Promise<string[]> { return ["src/a.ts"]; }
  async commit(): Promise<string> { return sha; }
  async push(): Promise<void> { this.pushed = true; }
  async head(): Promise<string> { return sha; }
  async remove(): Promise<void> {}
}
class PublishHost implements ForgeHost {
  async materializeDecomposition() { return []; }
  input?: { body: string };
  async createPullRequest(input: { repo: string; issue: number; headBranch: string; baseBranch: string; title: string; body: string }): Promise<PullRequestSnapshot> {
    this.input = input;
    return { repo: input.repo, number: 3, title: input.title, body: input.body, url: "https://github.test/pr/3", state: "OPEN", headSha: sha, headBranch: input.headBranch, baseBranch: input.baseBranch };
  }
  async getPullRequest(): Promise<PullRequestSnapshot> { throw new Error("unused"); }
  async getPullRequestDiff(): Promise<string> { return ""; }
  async mergePullRequest(): Promise<void> {}
  async closeIssue(): Promise<void> {}
}
async function publishingRun(runs: InMemoryRunRepository): Promise<RunState> {
  let run = createRun({ workflow: "work-on", subject: { repo: "a/b", issue: 2 }, runId: "run_publish" });
  await runs.create(run);
  for (const event of ["START_INVESTIGATION", "INVESTIGATION_CONFIRMED", "BUILD_PACKET_READY", "BUILD_COMPLETED", "VERIFICATION_PASSED"] as TransitionEvent[]) {
    const next = transition(run, event, { headSha: sha }); await runs.commit(run.version, next.state, next.record); run = next.state;
  }
  return run;
}

describe("PR publication", () => {
  it("pushes the verified branch and opens a PR carrying the durable handoff", async () => {
    const runs = new InMemoryRunRepository();
    const run = await publishingRun(runs);
    const intent = createArtifact({ kind: "Intent", runId: run.runId, subject: run.subject, producer: { role: "controller" }, payload: { title: "Fix", problem: "Broken", constraints: [], acceptanceHints: [], dependencies: [] } });
    const packet = createArtifact({ kind: "BuildPacket", runId: run.runId, subject: run.subject, producer: { role: "packet-author" }, payload: { scope: ["Fix"], acceptanceCriteria: ["Pass"], context: [], implementationPlan: ["Edit"], expectedPaths: ["src/a.ts"], verificationPlan: ["npm test"], risks: [], outOfScope: [] } });
    const buildResult = createArtifact({ kind: "BuildResult", runId: run.runId, subject: run.subject, producer: { role: "controller" }, payload: { branch: workspace.branch, headSha: sha, changedPaths: ["src/a.ts"], summary: "Fixed", acceptanceEvidence: [{ criterion: "Pass", status: "passed", evidence: "test" }], checks: [{ command: "npm test", status: "passed", durationMs: 1 }], decisions: [], residualRisks: [] } });
    const git = new PublishGit(); const host = new PublishHost();
    const result = await publishPullRequest({ run, intent, packet, buildResult, workspace, baseBranch: "main" }, { git, host, runs });
    assert.equal(result.run.state, "reviewing");
    assert.equal(git.pushed, true);
    assert.match(host.input?.body ?? "", /Build Packet/);
    assert.match(host.input?.body ?? "", /Build Result/);
  });
});
