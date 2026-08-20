import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createArtifact } from "../../core/artifacts/schema.js";
import type { ForgeHost, PullRequestSnapshot } from "../../core/ports/forge-host.js";
import type { GitWorkspace, GitWorkspaceManager } from "../../core/ports/git-workspace.js";
import { InMemoryArtifactRepository, InMemoryRunRepository } from "../../core/ports/repositories.js";
import type { RunRepository } from "../../core/ports/repositories.js";
import { createRun, transition, type RunState, type TransitionEvent, type TransitionRecord } from "../../core/state/machine.js";
import { publishPullRequest, renderPullRequestHandoff } from "./publish.js";

const sha = "d".repeat(40);
const workspace: GitWorkspace = { path: "/tmp/w", branch: "forgedock/fix", baseRef: "main" };
class PublishGit implements GitWorkspaceManager {
  pushed = false;
  observedHead = sha;
  async create(): Promise<GitWorkspace> { return workspace; }
  async changedPaths(): Promise<string[]> { return ["src/a.ts"]; }
  async revisionChangedPaths(): Promise<string[]> { return ["src/a.ts"]; }
  async syncToRemoteHead(): Promise<void> {}
  async isAncestor(): Promise<boolean> { return true; }
  async prepareWorkspaceDependencies(): Promise<void> {}
  async committedContentMatches(): Promise<boolean> { return true; }
  async commit(): Promise<string> { return sha; }
  async push(): Promise<void> { this.pushed = true; }
  async head(): Promise<string> { return this.observedHead; }
  async remove(): Promise<void> {}
}
class PublishHost implements ForgeHost {
  async materializeDecomposition() { return []; }
  input?: { body: string };
  existing?: PullRequestSnapshot;
  branchHead = sha;
  createCount = 0;
  async findOpenPullRequest(): Promise<PullRequestSnapshot | undefined> { return this.existing; }
  async createPullRequest(input: { repo: string; issue: number; headBranch: string; baseBranch: string; title: string; body: string }): Promise<PullRequestSnapshot> {
    this.createCount++;
    this.input = input;
    this.existing = { repo: input.repo, number: 3, title: input.title, body: input.body, url: "https://github.test/pr/3", state: "OPEN", headSha: sha, headBranch: input.headBranch, baseBranch: input.baseBranch };
    return this.existing;
  }
  async getPullRequest(): Promise<PullRequestSnapshot> {
    if (!this.existing) throw new Error("unused");
    return this.existing;
  }
  async getBranchHead(): Promise<string> { return this.branchHead; }
  async getPullRequestDiff(): Promise<string> { return ""; }
  async publishPullRequestComment(): Promise<void> {}
  async materializeReviewFinding() { return { repo: "a/b", number: 99, title: "finding", body: "", url: "https://github.test/a/b/issues/99", state: "OPEN" as const }; }
  async mergePullRequest(): Promise<void> {}
  async closeIssue(): Promise<void> {}
}
class FailOncePublicationCommitRepository extends InMemoryRunRepository implements RunRepository {
  failPublicationCommit = true;

  override async commit(expectedVersion: number, state: RunState, record: TransitionRecord): Promise<void> {
    if (record.event === "PR_PUBLISHED" && this.failPublicationCommit) {
      this.failPublicationCommit = false;
      throw new Error("simulated crash after PR creation");
    }
    await super.commit(expectedVersion, state, record);
  }
}

async function publishingRun(runs: InMemoryRunRepository): Promise<RunState> {
  let run = createRun({
    workflow: "work-on",
    subject: { repo: "a/b", issue: 2 },
    runId: "run_publish",
    target: { lane: "fast", targetBranch: "main" },
  });
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
    const result = await publishPullRequest({ run, intent, packet, buildResult, workspace }, { git, host, runs });
    assert.equal(result.run.state, "reviewing");
    assert.equal(git.pushed, true);
    assert.match(host.input?.body ?? "", /Build Packet/);
    assert.match(host.input?.body ?? "", /Build Result/);
  });

  it("retains a typed target checkpoint instead of terminally blocking on movement", async () => {
    const runs = new InMemoryRunRepository();
    const artifacts = new InMemoryArtifactRepository();
    const run = await publishingRun(runs);
    const intent = createArtifact({ kind: "Intent", runId: run.runId, subject: run.subject, producer: { role: "controller" }, payload: { title: "Fix", problem: "Broken", constraints: [], acceptanceHints: [], dependencies: [] } });
    const packet = createArtifact({ kind: "BuildPacket", runId: run.runId, subject: run.subject, producer: { role: "packet-author" }, payload: { scope: ["Fix"], acceptanceCriteria: ["Pass"], context: [], implementationPlan: ["Edit"], expectedPaths: ["src/a.ts"], verificationPlan: ["npm test"], risks: [], outOfScope: [] } });
    const buildResult = createArtifact({ kind: "BuildResult", runId: run.runId, subject: run.subject, producer: { role: "controller" }, payload: { branch: workspace.branch, targetBranch: "main", baseSha: sha, headSha: sha, changedPaths: ["src/a.ts"], summary: "Fixed", acceptanceEvidence: [{ criterion: "Pass", status: "passed", evidence: "test" }], checks: [{ command: "npm test", status: "passed", durationMs: 1 }], decisions: [], residualRisks: [] } });
    await artifacts.append(packet); await artifacts.append(buildResult);
    const host = new PublishHost(); host.branchHead = "e".repeat(40);
    await assert.rejects(() => publishPullRequest({ run, intent, packet, buildResult, workspace }, { git: new PublishGit(), host, runs, artifacts }), /advanced before publication/);
    assert.equal((await runs.load(run.runId))?.state, "target_recovery");
    const checkpoint = (await artifacts.list(run.subject, "TargetAdvanceCheckpoint")).at(-1);
    assert.equal(checkpoint?.kind, "TargetAdvanceCheckpoint");
    assert.equal(checkpoint?.payload.observedTargetSha, "e".repeat(40));
  });


  it("refuses to push when the retained workspace no longer matches the verified SHA", async () => {
    const runs = new InMemoryRunRepository();
    const run = await publishingRun(runs);
    const intent = createArtifact({ kind: "Intent", runId: run.runId, subject: run.subject, producer: { role: "controller" }, payload: { title: "Fix", problem: "Broken", constraints: [], acceptanceHints: [], dependencies: [] } });
    const packet = createArtifact({ kind: "BuildPacket", runId: run.runId, subject: run.subject, producer: { role: "packet-author" }, payload: { scope: ["Fix"], acceptanceCriteria: ["Pass"], context: [], implementationPlan: ["Edit"], expectedPaths: ["src/a.ts"], verificationPlan: ["npm test"], risks: [], outOfScope: [] } });
    const buildResult = createArtifact({ kind: "BuildResult", runId: run.runId, subject: run.subject, producer: { role: "controller" }, payload: { branch: workspace.branch, headSha: sha, changedPaths: ["src/a.ts"], summary: "Fixed", acceptanceEvidence: [], checks: [], decisions: [], residualRisks: [] } });
    const git = new PublishGit();
    git.observedHead = "a".repeat(40);
    await assert.rejects(
      publishPullRequest({ run, intent, packet, buildResult, workspace }, { git, host: new PublishHost(), runs }),
      /does not match verified build/,
    );
    assert.equal(git.pushed, false);
  });

  it("reuses an already-created PR when publication is retried", async () => {
    const runs = new InMemoryRunRepository();
    const run = await publishingRun(runs);
    const intent = createArtifact({ kind: "Intent", runId: run.runId, subject: run.subject, producer: { role: "controller" }, payload: { title: "Fix", problem: "Broken", constraints: [], acceptanceHints: [], dependencies: [] } });
    const packet = createArtifact({ kind: "BuildPacket", runId: run.runId, subject: run.subject, producer: { role: "packet-author" }, payload: { scope: ["Fix"], acceptanceCriteria: ["Pass"], context: [], implementationPlan: ["Edit"], expectedPaths: ["src/a.ts"], verificationPlan: ["npm test"], risks: [], outOfScope: [] } });
    const buildResult = createArtifact({ kind: "BuildResult", runId: run.runId, subject: run.subject, producer: { role: "controller" }, payload: { branch: workspace.branch, headSha: sha, changedPaths: ["src/a.ts"], summary: "Fixed", acceptanceEvidence: [], checks: [], decisions: [], residualRisks: [] } });
    const host = new PublishHost();
    host.existing = { repo: "a/b", number: 3, title: "Fix", body: "existing", url: "https://github.test/pr/3", state: "OPEN", headSha: "c".repeat(40), headBranch: workspace.branch, baseBranch: "main" };
    const result = await publishPullRequest({ run, intent, packet, buildResult, workspace }, { git: new PublishGit(), host, runs });
    assert.equal(result.pullRequest.url, host.existing.url);
    assert.equal(result.pullRequest.headSha, sha);
    assert.equal(host.createCount, 0);
  });

  it("reconciles a crash after PR creation before the publication transition commits", async () => {
    const intentPayload = { title: "Fix", problem: "Broken", constraints: [], acceptanceHints: [], dependencies: [] };
    const packetPayload = { scope: ["Fix"], acceptanceCriteria: ["Pass"], context: [], implementationPlan: ["Edit"], expectedPaths: ["src/a.ts"], verificationPlan: ["npm test"], risks: [], outOfScope: [] };
    const buildPayload = { branch: workspace.branch, headSha: sha, changedPaths: ["src/a.ts"], summary: "Fixed", acceptanceEvidence: [], checks: [], decisions: [], residualRisks: [] };
    const firstRuns = new FailOncePublicationCommitRepository();
    const firstRun = await publishingRun(firstRuns);
    const firstIntent = createArtifact({ kind: "Intent", runId: firstRun.runId, subject: firstRun.subject, producer: { role: "controller" }, payload: intentPayload });
    const firstPacket = createArtifact({ kind: "BuildPacket", runId: firstRun.runId, subject: firstRun.subject, producer: { role: "packet-author" }, payload: packetPayload });
    const firstBuild = createArtifact({ kind: "BuildResult", runId: firstRun.runId, subject: firstRun.subject, producer: { role: "controller" }, payload: buildPayload });
    const host = new PublishHost();
    await assert.rejects(
      publishPullRequest({ run: firstRun, intent: firstIntent, packet: firstPacket, buildResult: firstBuild, workspace }, { git: new PublishGit(), host, runs: firstRuns }),
      /simulated crash after PR creation/,
    );
    assert.equal(host.createCount, 1);

    const retryRuns = new InMemoryRunRepository();
    const retryRun = await publishingRun(retryRuns);
    const retryIntent = createArtifact({ kind: "Intent", runId: retryRun.runId, subject: retryRun.subject, producer: { role: "controller" }, payload: intentPayload });
    const retryPacket = createArtifact({ kind: "BuildPacket", runId: retryRun.runId, subject: retryRun.subject, producer: { role: "packet-author" }, payload: packetPayload });
    const retryBuild = createArtifact({ kind: "BuildResult", runId: retryRun.runId, subject: retryRun.subject, producer: { role: "controller" }, payload: buildPayload });
    const result = await publishPullRequest({ run: retryRun, intent: retryIntent, packet: retryPacket, buildResult: retryBuild, workspace }, { git: new PublishGit(), host, runs: retryRuns });
    assert.equal(result.run.state, "reviewing");
    assert.equal(result.pullRequest.number, 3);
    assert.equal(host.createCount, 1, "retry must reconcile the existing PR instead of creating a duplicate");
  });

  it("rejects an existing delivery PR that targets a different lane before pushing", async () => {
    const runs = new InMemoryRunRepository();
    const run = await publishingRun(runs);
    const intent = createArtifact({ kind: "Intent", runId: run.runId, subject: run.subject, producer: { role: "controller" }, payload: { title: "Fix", problem: "Broken", constraints: [], acceptanceHints: [], dependencies: [] } });
    const packet = createArtifact({ kind: "BuildPacket", runId: run.runId, subject: run.subject, producer: { role: "packet-author" }, payload: { scope: ["Fix"], acceptanceCriteria: ["Pass"], context: [], implementationPlan: ["Edit"], expectedPaths: ["src/a.ts"], verificationPlan: ["npm test"], risks: [], outOfScope: [] } });
    const buildResult = createArtifact({ kind: "BuildResult", runId: run.runId, subject: run.subject, producer: { role: "controller" }, payload: { branch: workspace.branch, headSha: sha, changedPaths: ["src/a.ts"], summary: "Fixed", acceptanceEvidence: [], checks: [], decisions: [], residualRisks: [] } });
    const host = new PublishHost();
    host.existing = { repo: "a/b", number: 3, title: "Fix", body: "existing", url: "https://github.test/pr/3", state: "OPEN", headSha: sha, headBranch: workspace.branch, baseBranch: "milestone/other" };
    const git = new PublishGit();
    await assert.rejects(
      publishPullRequest({ run, intent, packet, buildResult, workspace }, { git, host, runs }),
      /targets main, not milestone\/other/,
    );
    assert.equal(git.pushed, false);
  });

  it("keeps large durable artifacts out of GitHub's bounded PR body", () => {
    const runId = "run_large";
    const packet = createArtifact({
      kind: "BuildPacket", runId, subject: { repo: "a/b", issue: 2 }, producer: { role: "packet-author" },
      payload: {
        scope: ["x".repeat(70_000)], acceptanceCriteria: Array.from({ length: 100 }, (_, index) => `criterion ${index} ${"x".repeat(2_000)}`),
        context: [], implementationPlan: ["Write the specification"], expectedPaths: ["docs/spec.md"], verificationPlan: ["npm test"], risks: [], outOfScope: [],
      },
    });
    const buildResult = createArtifact({
      kind: "BuildResult", runId, subject: packet.subject, producer: { role: "controller" },
      payload: {
        branch: workspace.branch, headSha: sha,
        changedPaths: Array.from({ length: 100 }, (_, index) => `docs/${index}-${"p".repeat(1_000)}.md`), summary: "s".repeat(70_000),
        acceptanceEvidence: Array.from({ length: 100 }, (_, index) => ({ criterion: `criterion ${index} ${"y".repeat(2_000)}`, status: "passed" as const, evidence: "e".repeat(2_000) })),
        checks: Array.from({ length: 100 }, (_, index) => ({ command: `check-${index} ${"c".repeat(2_000)}`, status: "passed" as const, durationMs: 1, summary: "o".repeat(2_000) })),
        decisions: [], residualRisks: Array.from({ length: 100 }, () => "r".repeat(2_000)),
      },
    });
    const body = renderPullRequestHandoff({ issue: 2, packet, buildResult });
    assert.ok(body.length < 65_536);
    assert.match(body, new RegExp(packet.id));
    assert.match(body, new RegExp(buildResult.id));
    assert.doesNotMatch(body, /FORGEDOCK:ARTIFACT/);
  });
});
