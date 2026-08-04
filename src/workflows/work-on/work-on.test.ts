import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createArtifact, type BuildPacketPayload, type InvestigationPayload } from "../../core/artifacts/schema.js";
import type { ForgeHost, PullRequestSnapshot } from "../../core/ports/forge-host.js";
import { attachArtifact, createRun, transition } from "../../core/state/machine.js";
import type { GitWorkspace, GitWorkspaceManager } from "../../core/ports/git-workspace.js";
import { InMemoryArtifactRepository, InMemoryRunRepository } from "../../core/ports/repositories.js";
import type { CheckResult, VerificationRunner } from "../../core/ports/verification.js";
import { FakeAgentRuntime } from "../../runtime/fake-runtime.js";
import type { BuilderSubmission } from "./build.js";
import { resumeBuildWorkOn, resumePublicationWorkOn, resumeWorkOn, shouldAppendFailureOutcome, workOn } from "./work-on.js";

const sha = "e".repeat(40);
const workspace: GitWorkspace = { path: "/tmp/work", branch: "forgedock/issue-8", baseRef: "main" };
class EndToEndGit implements GitWorkspaceManager {
  removed = false;
  async create(): Promise<GitWorkspace> { return workspace; }
  async changedPaths(): Promise<string[]> { return ["src/a.js"]; }
  async commit(): Promise<string> { return sha; }
  async push(): Promise<void> {}
  async head(): Promise<string> { return sha; }
  async remove(): Promise<void> { this.removed = true; }
}
class EndToEndVerifier implements VerificationRunner {
  async run(): Promise<CheckResult[]> { return [{ command: "npm test", status: "passed", exitCode: 0, durationMs: 10, outputDigest: "f".repeat(64) }]; }
}
class EndToEndHost implements ForgeHost {
  async materializeDecomposition() { return []; }
  snapshot: PullRequestSnapshot = { repo: "a/b", number: 11, title: "Fix", body: "", url: "https://github.test/a/b/pull/11", state: "OPEN", headSha: sha, headBranch: workspace.branch, baseBranch: "main" };
  issueClosed = false;
  async createPullRequest(): Promise<PullRequestSnapshot> { return { ...this.snapshot }; }
  async getPullRequest(): Promise<PullRequestSnapshot> { return { ...this.snapshot }; }
  async getPullRequestDiff(): Promise<string> { return "diff --git a/src/a.js b/src/a.js\n+guard();"; }
  async mergePullRequest(_repo: string, _number: number, expected: string): Promise<void> {
    assert.equal(expected, sha); this.snapshot.state = "MERGED";
  }
  async closeIssue(): Promise<void> { this.issueClosed = true; }
}

const investigation: InvestigationPayload = {
  outcome: "confirmed", confidence: "high", summary: "Confirmed",
  evidence: [{ claim: "Missing guard", source: "src/a.js", detail: "update has no guard" }],
  rootCause: "Missing guard", affectedSurfaces: ["src/a.js"], risks: [], recommendation: "Add guard",
};
const packet: BuildPacketPayload = {
  scope: ["Add guard"], acceptanceCriteria: ["Guard runs"], context: [], implementationPlan: ["Edit src/a.js"],
  expectedPaths: ["src/a.js"], verificationPlan: ["npm test"], risks: [], outOfScope: [],
};
const submission: BuilderSubmission = {
  summary: "Added guard", changedPaths: ["src/a.js"], criterionCoverage: [{ criterion: "Guard runs", implementation: "guard() is called" }], decisions: [], residualRisks: [],
};

describe("complete work-on trajectory", () => {
  it("records a new durable failure cause while deduplicating an identical retry", () => {
    const runId = "run_failures";
    const failed = createArtifact({
      kind: "Outcome", runId, subject: { repo: "a/b", issue: 8 }, producer: { role: "controller" },
      payload: { status: "failed", reason: "fetch failed", childIssues: [] },
    });
    assert.equal(shouldAppendFailureOutcome([failed], runId, "fetch failed"), false);
    assert.equal(shouldAppendFailureOutcome([failed], runId, "read failed: optional path missing"), true);
  });

  it("retains the worktree when verification blocks delivery", async () => {
    const runtime = new FakeAgentRuntime([investigation, packet, submission]);
    const artifacts = new InMemoryArtifactRepository();
    const runs = new InMemoryRunRepository();
    const git = new EndToEndGit();
    const host = new EndToEndHost();
    const intent = createArtifact({
      kind: "Intent", runId: "run_blocked", subject: { repo: "a/b", issue: 8 }, producer: { role: "controller" },
      payload: { title: "Fix", problem: "Broken", constraints: [], acceptanceHints: ["Guard runs"], dependencies: [] },
    });
    const verifier: VerificationRunner = {
      async run() { return [{ command: "npm test", status: "failed", exitCode: 1, durationMs: 10, summary: "test failed" }]; },
    };
    const result = await workOn({
      intent, repoPath: process.cwd(), baseBranch: "main", autoMerge: true,
      verification: [{ id: "test", command: "npm", args: ["test"], timeoutMs: 60_000, required: true }],
    }, { runtime, artifacts, runs, git, verifier, host });
    assert.equal(result.run.state, "blocked");
    assert.equal(git.removed, false);
    const outcome = artifacts.artifacts.find((artifact) => artifact.kind === "Outcome");
    assert.equal(outcome?.kind === "Outcome" ? outcome.payload.failureEvidence?.workspacePath : undefined, workspace.path);
  });

  it("resumes an interrupted building run from its frozen packet and retained worktree", async () => {
    const artifacts = new InMemoryArtifactRepository();
    const runs = new InMemoryRunRepository();
    const git = new EndToEndGit();
    const host = new EndToEndHost();
    const intent = createArtifact({
      kind: "Intent", runId: "run_build_resume", subject: { repo: "a/b", issue: 8 }, producer: { role: "controller" },
      payload: { title: "Fix", problem: "Broken", constraints: [], acceptanceHints: ["Guard runs"], dependencies: [] },
    });
    const investigationArtifact = createArtifact({
      kind: "Investigation", runId: intent.runId, subject: intent.subject, producer: { role: "investigator" }, payload: investigation,
    });
    const packetArtifact = createArtifact({
      kind: "BuildPacket", runId: intent.runId, subject: intent.subject, producer: { role: "packet-author" }, payload: packet,
    });
    let run = attachArtifact(createRun({ workflow: "work-on", subject: intent.subject, runId: intent.runId }), "Intent", intent.id);
    await runs.create(run);
    for (const [event, artifact] of [
      ["START_INVESTIGATION", undefined],
      ["INVESTIGATION_CONFIRMED", investigationArtifact],
      ["BUILD_PACKET_READY", packetArtifact],
    ] as const) {
      if (artifact) run = attachArtifact(run, artifact.kind, artifact.id);
      const advanced = transition(run, event);
      await runs.commit(run.version, advanced.state, advanced.record);
      run = advanced.state;
    }
    for (const artifact of [intent, investigationArtifact, packetArtifact]) await artifacts.append(artifact);

    const runtime = new FakeAgentRuntime([submission, { summary: "Approved", findings: [] }]);
    const resumed = await resumeBuildWorkOn({
      run, intent, investigation: investigationArtifact, packet: packetArtifact,
      workspace, baseBranch: "main", autoMerge: true,
      verification: [{ id: "test", command: "npm", args: ["test"], timeoutMs: 60_000, required: true }],
    }, { runtime, artifacts, runs, git, verifier: new EndToEndVerifier(), host });

    assert.equal(resumed.run.state, "completed");
    assert.deepEqual(runtime.tasks.map((task) => task.role), ["builder", "reviewer"]);
  });

  it("resumes publication without replaying build or verification", async () => {
    const artifacts = new InMemoryArtifactRepository();
    const runs = new InMemoryRunRepository();
    const git = new EndToEndGit();
    const host = new EndToEndHost();
    const intent = createArtifact({
      kind: "Intent", runId: "run_publish_resume", subject: { repo: "a/b", issue: 8 }, producer: { role: "controller" },
      payload: { title: "Fix", problem: "Broken", constraints: [], acceptanceHints: ["Guard runs"], dependencies: [] },
    });
    const investigationArtifact = createArtifact({ kind: "Investigation", runId: intent.runId, subject: intent.subject, producer: { role: "investigator" }, payload: investigation });
    const packetArtifact = createArtifact({ kind: "BuildPacket", runId: intent.runId, subject: intent.subject, producer: { role: "packet-author" }, payload: packet });
    const buildResult = createArtifact({
      kind: "BuildResult", runId: intent.runId, subject: intent.subject, producer: { role: "controller" },
      payload: {
        branch: workspace.branch, headSha: sha, changedPaths: ["src/a.js"], summary: "Added guard",
        acceptanceEvidence: [{ criterion: "Guard runs", status: "passed", evidence: "npm test" }],
        checks: [{ command: "npm test", status: "passed", durationMs: 10 }], decisions: [], residualRisks: [],
      },
    });
    let run = createRun({ workflow: "work-on", subject: intent.subject, runId: intent.runId });
    await runs.create(run);
    for (const event of ["START_INVESTIGATION", "INVESTIGATION_CONFIRMED", "BUILD_PACKET_READY", "BUILD_COMPLETED", "VERIFICATION_PASSED"] as const) {
      const advanced = transition(run, event, { headSha: sha });
      await runs.commit(run.version, advanced.state, advanced.record);
      run = advanced.state;
    }
    const runtime = new FakeAgentRuntime([{ summary: "Approved", findings: [] }]);
    const resumed = await resumePublicationWorkOn({
      run, intent, investigation: investigationArtifact, packet: packetArtifact, buildResult,
      workspace, baseBranch: "main", autoMerge: true,
      verification: [{ id: "test", command: "npm", args: ["test"], timeoutMs: 60_000, required: true }],
    }, { runtime, artifacts, runs, git, verifier: new EndToEndVerifier(), host });
    assert.equal(resumed.run.state, "completed");
    assert.deepEqual(runtime.tasks.map((task) => task.role), ["reviewer"]);
    assert.deepEqual((await runs.history(intent.runId)).map((record) => record.event).slice(-5), [
      "RESUME_PUBLICATION", "PR_PUBLISHED", "REVIEW_APPROVED", "MERGE_COMPLETED", "CLOSE_COMPLETED",
    ]);
  });

  it("automatically remediates an in-scope blocking review and obtains a fresh verdict", async () => {
    const artifacts = new InMemoryArtifactRepository();
    const runs = new InMemoryRunRepository();
    const git = new EndToEndGit();
    const host = new EndToEndHost();
    const intent = createArtifact({
      kind: "Intent", runId: "run_publish_remediate", subject: { repo: "a/b", issue: 8 }, producer: { role: "controller" },
      payload: { title: "Fix", problem: "Broken", constraints: [], acceptanceHints: ["Guard runs"], dependencies: [] },
    });
    const investigationArtifact = createArtifact({ kind: "Investigation", runId: intent.runId, subject: intent.subject, producer: { role: "investigator" }, payload: investigation });
    const packetArtifact = createArtifact({ kind: "BuildPacket", runId: intent.runId, subject: intent.subject, producer: { role: "packet-author" }, payload: packet });
    const buildResult = createArtifact({
      kind: "BuildResult", runId: intent.runId, subject: intent.subject, producer: { role: "controller" },
      payload: {
        branch: workspace.branch, headSha: sha, changedPaths: ["src/a.js"], summary: "Added guard",
        acceptanceEvidence: [{ criterion: "Guard runs", status: "passed", evidence: "npm test" }],
        checks: [{ command: "npm test", status: "passed", durationMs: 10 }], decisions: [], residualRisks: [],
      },
    });
    let run = createRun({ workflow: "work-on", subject: intent.subject, runId: intent.runId });
    await runs.create(run);
    for (const event of ["START_INVESTIGATION", "INVESTIGATION_CONFIRMED", "BUILD_PACKET_READY", "BUILD_COMPLETED", "VERIFICATION_PASSED"] as const) {
      const advanced = transition(run, event, { headSha: sha });
      await runs.commit(run.version, advanced.state, advanced.record);
      run = advanced.state;
    }
    const finding = {
      id: "correctness-1", severity: "high" as const, confidence: "high" as const, blocking: true,
      title: "Guard is incomplete", evidence: "The accepted path still misses one case", location: "src/a.js:1",
      intentRelevance: "The guard must cover the accepted behavior", remediation: "Complete the guard in src/a.js",
    };
    const runtime = new FakeAgentRuntime([
      { summary: "Changes required", findings: [finding] },
      submission,
      { summary: "Approved after remediation", findings: [] },
    ]);
    const resumed = await resumePublicationWorkOn({
      run, intent, investigation: investigationArtifact, packet: packetArtifact, buildResult,
      workspace, baseBranch: "main", autoMerge: true,
      verification: [{ id: "test", command: "npm", args: ["test"], timeoutMs: 60_000, required: true }],
    }, { runtime, artifacts, runs, git, verifier: new EndToEndVerifier(), host });
    assert.equal(resumed.run.state, "completed");
    assert.deepEqual(runtime.tasks.map((task) => task.role), ["reviewer", "remediator", "reviewer"]);
    assert.deepEqual((await runs.history(intent.runId)).map((record) => record.event).slice(-7), [
      "REVIEW_CHANGES_REQUESTED", "REMEDIATION_COMPLETED", "VERIFICATION_PASSED", "PR_PUBLISHED",
      "REVIEW_APPROVED", "MERGE_COMPLETED", "CLOSE_COMPLETED",
    ]);
  });

  it("resumes retained verification without replaying investigation, packet authoring, or build", async () => {
    const initialRuntime = new FakeAgentRuntime([investigation, packet, submission]);
    const artifacts = new InMemoryArtifactRepository();
    const runs = new InMemoryRunRepository();
    const git = new EndToEndGit();
    const host = new EndToEndHost();
    const intent = createArtifact({
      kind: "Intent", runId: "run_resume", subject: { repo: "a/b", issue: 8 }, producer: { role: "controller" },
      payload: { title: "Fix", problem: "Broken", constraints: [], acceptanceHints: ["Guard runs"], dependencies: [] },
    });
    const failedVerifier: VerificationRunner = {
      async run() { return [{ command: "npm test", status: "failed", exitCode: 1, durationMs: 10, failureSignatures: ["not ok - existing"] }]; },
    };
    const blocked = await workOn({
      intent, repoPath: process.cwd(), baseBranch: "main", autoMerge: true,
      verification: [{ id: "test", command: "npm", args: ["test"], timeoutMs: 60_000, required: true }],
    }, { runtime: initialRuntime, artifacts, runs, git, verifier: failedVerifier, host });
    assert.equal(blocked.run.state, "blocked");

    const investigationArtifact = artifacts.artifacts.find((artifact) => artifact.kind === "Investigation");
    const packetArtifact = artifacts.artifacts.find((artifact) => artifact.kind === "BuildPacket");
    const outcome = artifacts.artifacts.find((artifact) => artifact.kind === "Outcome");
    assert.ok(investigationArtifact?.kind === "Investigation");
    assert.ok(packetArtifact?.kind === "BuildPacket");
    assert.ok(outcome?.kind === "Outcome");
    const resumedRuntime = new FakeAgentRuntime([{ summary: "Approved", findings: [] }]);
    const resumed = await resumeWorkOn({
      run: blocked.run, intent, investigation: investigationArtifact, packet: packetArtifact, outcome,
      workspace, baseBranch: "main", autoMerge: true,
      verification: [{ id: "test", command: "npm", args: ["test"], timeoutMs: 60_000, required: true }],
    }, { runtime: resumedRuntime, artifacts, runs, git, verifier: new EndToEndVerifier(), host });

    assert.equal(resumed.run.state, "completed");
    assert.deepEqual(resumedRuntime.tasks.map((task) => task.role), ["reviewer"]);
    assert.deepEqual((await runs.history(intent.runId)).map((record) => record.event).slice(-5), [
      "VERIFICATION_PASSED", "PR_PUBLISHED", "REVIEW_APPROVED", "MERGE_COMPLETED", "CLOSE_COMPLETED",
    ]);
  });

  it("blocks instead of letting remediation expand beyond the frozen Build Packet", async () => {
    const finding = {
      id: "scope-1", severity: "high" as const, confidence: "high" as const, blocking: true,
      title: "Related workflow needs a separate fix", evidence: "The unchanged publish workflow has a race",
      location: ".github/workflows/publish.yml:20", intentRelevance: "The change triggers the workflow",
      remediation: "Change the workflow in a separate delivery",
    };
    const runtime = new FakeAgentRuntime([investigation, packet, submission, { summary: "Blocked", findings: [finding] }]);
    const artifacts = new InMemoryArtifactRepository();
    const runs = new InMemoryRunRepository();
    const git = new EndToEndGit();
    const host = new EndToEndHost();
    const intent = createArtifact({
      kind: "Intent", runId: "run_review_scope", subject: { repo: "a/b", issue: 8 }, producer: { role: "controller" },
      payload: { title: "Fix", problem: "Broken", constraints: [], acceptanceHints: ["Guard runs"], dependencies: [] },
    });
    const result = await workOn({
      intent, repoPath: process.cwd(), baseBranch: "main", autoMerge: true,
      verification: [{ id: "test", command: "npm", args: ["test"], timeoutMs: 60_000, required: true }],
    }, { runtime, artifacts, runs, git, verifier: new EndToEndVerifier(), host });

    assert.equal(result.run.state, "blocked");
    assert.equal(git.removed, false);
    assert.deepEqual(runtime.tasks.map((task) => task.role), ["investigator", "packet-author", "builder", "reviewer"]);
    const outcomes = artifacts.artifacts.filter((artifact) => artifact.kind === "Outcome");
    assert.match(outcomes.at(-1)?.kind === "Outcome" ? outcomes.at(-1)!.payload.reason : "", /outside the frozen Build Packet/);
  });

  it("crosses all six quality artifacts with separate agent sessions", async () => {
    const runtime = new FakeAgentRuntime([investigation, packet, submission, { summary: "Approved", findings: [] }]);
    const artifacts = new InMemoryArtifactRepository();
    const runs = new InMemoryRunRepository();
    const git = new EndToEndGit();
    const host = new EndToEndHost();
    const intent = createArtifact({
      kind: "Intent", runId: "run_e2e", subject: { repo: "a/b", issue: 8 }, producer: { role: "controller" },
      payload: { title: "Fix", problem: "Broken", constraints: [], acceptanceHints: ["Guard runs"], dependencies: [] },
    });
    const result = await workOn({
      intent, repoPath: process.cwd(), baseBranch: "main", autoMerge: true,
      verification: [{ id: "test", command: "npm", args: ["test"], timeoutMs: 60_000, required: true }],
    }, { runtime, artifacts, runs, git, verifier: new EndToEndVerifier(), host });

    assert.equal(result.run.state, "completed");
    assert.equal(host.issueClosed, true);
    assert.equal(git.removed, true);
    assert.deepEqual(artifacts.artifacts.map((artifact) => artifact.kind), [
      "Intent", "Investigation", "BuildPacket", "BuildResult", "ReviewVerdict", "Outcome",
    ]);
    assert.deepEqual(runtime.tasks.map((task) => task.role), ["investigator", "packet-author", "builder", "reviewer"]);
    assert.equal(new Set(runtime.tasks.map((task) => task.id)).size, 4);
    assert.deepEqual((await runs.history(intent.runId)).map((record) => record.event), [
      "START_INVESTIGATION", "INVESTIGATION_CONFIRMED", "BUILD_PACKET_READY", "BUILD_COMPLETED",
      "VERIFICATION_PASSED", "PR_PUBLISHED", "REVIEW_APPROVED", "MERGE_COMPLETED", "CLOSE_COMPLETED",
    ]);
  });
});
