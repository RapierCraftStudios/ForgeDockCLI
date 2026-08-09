import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createArtifact, type BuildPacketPayload, type InvestigationPayload } from "../../core/artifacts/schema.js";
import type { ForgeHost, PullRequestSnapshot } from "../../core/ports/forge-host.js";
import { attachArtifact, createRun, transition } from "../../core/state/machine.js";
import type { GitWorkspace, GitWorkspaceManager } from "../../core/ports/git-workspace.js";
import { InMemoryArtifactRepository, InMemoryRunRepository } from "../../core/ports/repositories.js";
import type { CheckResult, VerificationRunner } from "../../core/ports/verification.js";
import type { AgentTask } from "../../runtime/agent-runtime.js";
import { FakeAgentRuntime } from "../../runtime/fake-runtime.js";
import type { BuilderSubmission } from "./build.js";
import { repositoryPathFromLocation, resumeBuildWorkOn, resumeCompletionWorkOn, resumePublicationWorkOn, resumeReviewWorkOn, resumeWorkOn, shouldAppendFailureOutcome, workOn } from "./work-on.js";

const sha = "e".repeat(40);
const fastLane = { kind: "fast", targetBranch: "main", resolution: "repository-default" } as const;
const runTarget = { lane: "fast", targetBranch: "main" } as const;
const workspace: GitWorkspace = { path: "/tmp/work", branch: "forgedock/issue-8", baseRef: "main" };
class EndToEndGit implements GitWorkspaceManager {
  removed = false;
  createdFrom?: string;
  async create(input: { baseRef: string }): Promise<GitWorkspace> { this.createdFrom = input.baseRef; return workspace; }
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
  findingIssues = 0;
  async createPullRequest(input: { baseBranch: string }): Promise<PullRequestSnapshot> {
    this.snapshot.baseBranch = input.baseBranch;
    return { ...this.snapshot };
  }
  async getPullRequest(): Promise<PullRequestSnapshot> { return { ...this.snapshot }; }
  async getPullRequestDiff(): Promise<string> { return "diff --git a/src/a.js b/src/a.js\n+guard();"; }
  async publishPullRequestComment(): Promise<void> {}
  async materializeReviewFinding() {
    this.findingIssues++;
    return { repo: "a/b", number: 99, title: "finding", body: "", url: "https://github.test/a/b/issues/99", state: "OPEN" as const };
  }
  async mergePullRequest(_repo: string, _number: number, expected: string, expectedBase: string): Promise<void> {
    assert.equal(expected, sha);
    assert.equal(expectedBase, this.snapshot.baseBranch);
    this.snapshot.state = "MERGED";
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
const acceptAdjudication = (task: AgentTask<unknown>) => ({
  decisions: [...task.objective.matchAll(/"id": "(review-[a-f0-9]{16})"/g)].map((match) => ({
    findingId: match[1]!, disposition: "accept", rationale: "Directly required by the frozen criterion.",
  })),
});

describe("complete work-on trajectory", () => {
  it("distinguishes durable artifact fields from dotted and extensionless repository paths", () => {
    assert.equal(repositoryPathFromLocation("BuildResult art_f1b0.payload.changedPaths/checks"), undefined);
    assert.equal(repositoryPathFromLocation("Evidence at .github/workflows/publish.yml:20"), ".github/workflows/publish.yml");
    assert.equal(repositoryPathFromLocation("docs/next/contract.md:42"), "docs/next/contract.md");
    assert.equal(repositoryPathFromLocation("bin/forgedock-terminal:8"), "bin/forgedock-terminal");
    assert.equal(repositoryPathFromLocation("Dockerfile:12"), "Dockerfile");
  });

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
      intent, repoPath: process.cwd(), lane: fastLane, autoMerge: true,
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
    let run = attachArtifact(createRun({ workflow: "work-on", subject: intent.subject, runId: intent.runId, target: runTarget }), "Intent", intent.id);
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

    const priorVerificationFailure = createArtifact({
      kind: "Outcome", runId: intent.runId, subject: intent.subject, producer: { role: "controller" },
      payload: {
        status: "blocked", reason: "Required verification failed: npm test (exit 1)", childIssues: [],
        failureEvidence: {
          branch: workspace.branch, workspacePath: workspace.path, builderSummary: "first attempt",
          changedPaths: ["src/a.js"], checks: [{ command: "npm test", status: "failed", durationMs: 1 }],
        },
      },
    });
    const runtime = new FakeAgentRuntime([submission, { summary: "Approved", findings: [] }]);
    const resumed = await resumeBuildWorkOn({
      run, intent, investigation: investigationArtifact, packet: packetArtifact, priorVerificationFailure,
      workspace, baseBranch: "main", autoMerge: true,
      verification: [{ id: "test", command: "npm", args: ["test"], timeoutMs: 60_000, required: true }],
    }, { runtime, artifacts, runs, git, verifier: new EndToEndVerifier(), host });

    assert.equal(resumed.run.state, "completed");
    assert.deepEqual(runtime.tasks.map((task) => task.role), ["builder", "reviewer"]);
    assert.match(runtime.tasks[0]?.objective ?? "", /controller verification failed/);
    assert.ok(runtime.tasks[0]?.context.some((artifact) => artifact.kind === "Outcome"));
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
    let run = createRun({ workflow: "work-on", subject: intent.subject, runId: intent.runId, target: runTarget });
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

  it("recovers a failed stale PR projection only from its newer verified remediation checkpoint", async () => {
    const artifacts = new InMemoryArtifactRepository();
    const runs = new InMemoryRunRepository();
    const git = new EndToEndGit();
    const host = new EndToEndHost();
    const intent = createArtifact({
      kind: "Intent", runId: "run_revision_recover", subject: { repo: "a/b", issue: 8 }, producer: { role: "controller" },
      payload: { title: "Fix", problem: "Broken", constraints: [], acceptanceHints: ["Guard runs"], dependencies: [] },
    });
    const investigationArtifact = createArtifact({ kind: "Investigation", runId: intent.runId, subject: intent.subject, producer: { role: "investigator" }, payload: investigation });
    const packetArtifact = createArtifact({ kind: "BuildPacket", runId: intent.runId, subject: intent.subject, producer: { role: "packet-author" }, payload: packet });
    const oldSha = "d".repeat(40);
    const priorVerdict = createArtifact({
      kind: "ReviewVerdict", runId: intent.runId, subject: { ...intent.subject, pr: host.snapshot.number }, producer: { role: "controller" },
      payload: { headSha: oldSha, disposition: "request_changes", reviewerRoles: ["correctness"], findings: [], checks: [] },
    }, { createdAt: "2026-01-01T00:01:00.000Z" });
    const buildResult = createArtifact({
      kind: "BuildResult", runId: intent.runId, subject: intent.subject, producer: { role: "controller" },
      payload: {
        branch: workspace.branch, headSha: sha, changedPaths: ["src/a.js"], summary: "Remediated guard",
        acceptanceEvidence: [{ criterion: "Guard runs", status: "passed", evidence: "npm test" }],
        checks: [{ command: "npm test", status: "passed", durationMs: 10 }], decisions: [], residualRisks: [],
      },
    }, { createdAt: "2026-01-01T00:02:00.000Z" });
    let run = createRun({ workflow: "work-on", subject: intent.subject, runId: intent.runId, target: runTarget });
    await runs.create(run);
    for (const event of ["START_INVESTIGATION", "INVESTIGATION_CONFIRMED", "BUILD_PACKET_READY", "BUILD_COMPLETED", "VERIFICATION_PASSED"] as const) {
      const advanced = transition(run, event, { headSha: sha });
      await runs.commit(run.version, advanced.state, advanced.record);
      run = advanced.state;
    }
    const reason = `Published remediation head ${oldSha} does not match verified build ${sha}`;
    const failed = transition(run, "FAIL", { reason });
    await runs.commit(run.version, failed.state, failed.record);
    run = failed.state;

    const runtime = new FakeAgentRuntime([{ summary: "Approved recovered revision", findings: [] }]);
    const resumed = await resumePublicationWorkOn({
      run, intent, investigation: investigationArtifact, packet: packetArtifact, buildResult, priorVerdict,
      workspace, baseBranch: "main", autoMerge: true,
      verification: [{ id: "test", command: "npm", args: ["test"], timeoutMs: 60_000, required: true }],
    }, { runtime, artifacts, runs, git, verifier: new EndToEndVerifier(), host });
    assert.equal(resumed.run.state, "completed");
    assert.deepEqual((await runs.history(intent.runId)).map((record) => record.event).slice(-5), [
      "RECOVER_REVISION_PUBLICATION", "PR_PUBLISHED", "REVIEW_APPROVED", "MERGE_COMPLETED", "CLOSE_COMPLETED",
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
    let run = createRun({ workflow: "work-on", subject: intent.subject, runId: intent.runId, target: runTarget });
    await runs.create(run);
    for (const event of ["START_INVESTIGATION", "INVESTIGATION_CONFIRMED", "BUILD_PACKET_READY", "BUILD_COMPLETED", "VERIFICATION_PASSED"] as const) {
      const advanced = transition(run, event, { headSha: sha });
      await runs.commit(run.version, advanced.state, advanced.record);
      run = advanced.state;
    }
    const finding = {
      id: "correctness-1", severity: "high" as const, confidence: "high" as const, blocking: true,
      scopeDisposition: "in_scope" as const, scopeRationale: "Directly violates the frozen guard criterion.",
      matchedAcceptanceCriteria: ["Guard runs"], matchedPriorFindingIds: [] as string[], introducedByRemediation: false,
      title: "Guard is incomplete", evidence: "The accepted path still misses one case", location: "src/a.js:1",
      intentRelevance: "The guard must cover the accepted behavior", remediation: "Complete the guard in src/a.js",
    };
    const runtime = new FakeAgentRuntime([
      { summary: "Changes required", findings: [finding] },
      acceptAdjudication,
      submission,
      { summary: "Approved after remediation", findings: [] },
    ]);
    const resumed = await resumePublicationWorkOn({
      run, intent, investigation: investigationArtifact, packet: packetArtifact, buildResult,
      workspace, baseBranch: "main", autoMerge: true,
      verification: [{ id: "test", command: "npm", args: ["test"], timeoutMs: 60_000, required: true }],
    }, { runtime, artifacts, runs, git, verifier: new EndToEndVerifier(), host });
    assert.equal(resumed.run.state, "completed");
    assert.equal(host.findingIssues, 0, "transient blocking findings remediated in the same run must not create follow-up issues");
    assert.deepEqual(runtime.tasks.map((task) => task.role), ["reviewer", "adjudicator", "remediator", "reviewer"]);
    assert.deepEqual((await runs.history(intent.runId)).map((record) => record.event).slice(-7), [
      "REVIEW_CHANGES_REQUESTED", "REMEDIATION_COMPLETED", "VERIFICATION_PASSED", "PR_PUBLISHED",
      "REVIEW_APPROVED", "MERGE_COMPLETED", "CLOSE_COMPLETED",
    ]);
  });

  it("reassesses a review-budget block without blindly replaying its stale remediation", async () => {
    const artifacts = new InMemoryArtifactRepository();
    const runs = new InMemoryRunRepository();
    const git = new EndToEndGit();
    const host = new EndToEndHost();
    const intent = createArtifact({
      kind: "Intent", runId: "run_review_resume", subject: { repo: "a/b", issue: 8 }, producer: { role: "controller" },
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
    const finding = {
      id: "correctness-resume", severity: "high" as const, confidence: "high" as const, blocking: true,
      title: "Guard is incomplete", evidence: "The accepted path still misses one case", location: "src/a.js:1",
      intentRelevance: "The guard must cover the accepted behavior", remediation: "Complete the guard in src/a.js",
    };
    const priorVerdict = createArtifact({
      kind: "ReviewVerdict", runId: intent.runId, subject: { ...intent.subject, pr: host.snapshot.number }, producer: { role: "controller" },
      payload: { headSha: sha, disposition: "request_changes", reviewerRoles: ["correctness"], findings: [finding], checks: [] },
    });
    let run = createRun({ workflow: "work-on", subject: intent.subject, runId: intent.runId, target: runTarget });
    await runs.create(run);
    for (const event of [
      "START_INVESTIGATION", "INVESTIGATION_CONFIRMED", "BUILD_PACKET_READY", "BUILD_COMPLETED",
      "VERIFICATION_PASSED", "PR_PUBLISHED", "REVIEW_CHANGES_REQUESTED", "BLOCK",
    ] as const) {
      const advanced = transition(run, event, event === "BLOCK" ? { reason: "Remediation budget exhausted after 2 cycle(s)" } : { headSha: sha });
      await runs.commit(run.version, advanced.state, advanced.record);
      run = advanced.state;
    }
    const runtime = new FakeAgentRuntime([{ summary: "Approved after bounded scope reassessment", findings: [] }]);
    const resumed = await resumeReviewWorkOn({
      run, intent, investigation: investigationArtifact, packet: packetArtifact, buildResult, priorVerdict,
      pullRequest: host.snapshot, workspace, baseBranch: "main", autoMerge: true,
      verification: [{ id: "test", command: "npm", args: ["test"], timeoutMs: 60_000, required: true }],
    }, { runtime, artifacts, runs, git, verifier: new EndToEndVerifier(), host });

    assert.equal(resumed.run.state, "completed");
    assert.deepEqual(runtime.tasks.map((task) => task.role), ["reviewer"]);
    assert.deepEqual((await runs.history(intent.runId)).map((record) => record.event).slice(-4), [
      "RESUME_REVIEW", "REVIEW_APPROVED", "MERGE_COMPLETED", "CLOSE_COMPLETED",
    ]);
  });

  it("resumes approved completion idempotently without replaying any agent phase", async () => {
    const artifacts = new InMemoryArtifactRepository();
    const runs = new InMemoryRunRepository();
    const git = new EndToEndGit();
    const host = new EndToEndHost();
    const subject = { repo: "a/b", issue: 8 };
    const verdict = createArtifact({
      kind: "ReviewVerdict", runId: "run_completion_resume", subject: { ...subject, pr: host.snapshot.number }, producer: { role: "controller" },
      payload: { headSha: sha, disposition: "approve", reviewerRoles: ["correctness"], findings: [], checks: [] },
    });
    let run = createRun({ workflow: "work-on", subject, runId: verdict.runId, target: runTarget });
    await runs.create(run);
    for (const event of [
      "START_INVESTIGATION", "INVESTIGATION_CONFIRMED", "BUILD_PACKET_READY", "BUILD_COMPLETED",
      "VERIFICATION_PASSED", "PR_PUBLISHED", "REVIEW_APPROVED",
    ] as const) {
      const advanced = transition(run, event, { headSha: sha });
      await runs.commit(run.version, advanced.state, advanced.record);
      run = advanced.state;
    }
    const resumed = await resumeCompletionWorkOn({
      run, verdict, pullRequest: host.snapshot, autoMerge: true, workspace,
    }, {
      runtime: new FakeAgentRuntime([]), artifacts, runs, git,
      verifier: new EndToEndVerifier(), host,
    });
    assert.equal(resumed.run.state, "completed");
    assert.equal(host.issueClosed, true);
    assert.equal(git.removed, true);
    assert.deepEqual((await runs.history(verdict.runId)).map((record) => record.event).slice(-3), [
      "RESUME_COMPLETION", "MERGE_COMPLETED", "CLOSE_COMPLETED",
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
      intent, repoPath: process.cwd(), lane: fastLane, autoMerge: true,
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

  it("downgrades a concern outside the frozen Build Packet instead of expanding remediation", async () => {
    const finding = {
      id: "scope-1", severity: "high" as const, confidence: "high" as const, blocking: true,
      scopeDisposition: "in_scope" as const, scopeRationale: "The reviewer believes it is related.",
      matchedAcceptanceCriteria: ["Guard runs"], matchedPriorFindingIds: [] as string[], introducedByRemediation: false,
      title: "Related workflow needs a separate fix", evidence: "The unchanged publish workflow has a race",
      location: ".github/workflows/publish.yml:20", intentRelevance: "The change triggers the workflow",
      remediation: "Change the workflow in a separate delivery",
    };
    const runtime = new FakeAgentRuntime([
      investigation, packet, submission,
      { summary: "Blocked", findings: [finding] },
      { summary: "Infrastructure scope confirmed", findings: [] },
      acceptAdjudication,
    ]);
    const artifacts = new InMemoryArtifactRepository();
    const runs = new InMemoryRunRepository();
    const git = new EndToEndGit();
    const host = new EndToEndHost();
    const intent = createArtifact({
      kind: "Intent", runId: "run_review_scope", subject: { repo: "a/b", issue: 8 }, producer: { role: "controller" },
      payload: { title: "Fix", problem: "Broken", constraints: [], acceptanceHints: ["Guard runs"], dependencies: [] },
    });
    const result = await workOn({
      intent, repoPath: process.cwd(), lane: fastLane, autoMerge: true,
      verification: [{ id: "test", command: "npm", args: ["test"], timeoutMs: 60_000, required: true }],
    }, { runtime, artifacts, runs, git, verifier: new EndToEndVerifier(), host });

    assert.equal(result.run.state, "completed");
    assert.equal(host.findingIssues, 0, "a single-reviewer out-of-scope concern must not proliferate into a new issue");
    assert.equal(git.removed, true);
    assert.deepEqual(runtime.tasks.map((task) => task.role), ["investigator", "packet-author", "builder", "reviewer", "reviewer", "adjudicator"]);
    assert.ok(runtime.tasks.some((task) => task.id.includes(":infrastructure")));
    const verdict = artifacts.artifacts.find((artifact) => artifact.kind === "ReviewVerdict");
    assert.equal(verdict?.kind === "ReviewVerdict" ? verdict.payload.findings[0]?.scopeDisposition : undefined, "follow_up");
    assert.equal(verdict?.kind === "ReviewVerdict" ? verdict.payload.findings[0]?.blocking : undefined, false);
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
      intent, repoPath: process.cwd(), lane: fastLane, autoMerge: true,
      verification: [{ id: "test", command: "npm", args: ["test"], timeoutMs: 60_000, required: true }],
    }, { runtime, artifacts, runs, git, verifier: new EndToEndVerifier(), host });

    assert.equal(result.run.state, "completed");
    assert.equal(result.run.targetBranch, "main");
    assert.equal(git.createdFrom, "origin/main");
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
