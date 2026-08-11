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
  async revisionChangedPaths(): Promise<string[]> { return ["src/a.js"]; }
  async syncToRemoteHead(): Promise<void> {}
  async isAncestor(): Promise<boolean> { return true; }
  async prepareWorkspaceDependencies(): Promise<void> {}
  async committedContentMatches(): Promise<boolean> { return true; }
  async commit(): Promise<string> { return sha; }
  async push(): Promise<void> {}
  async head(): Promise<string> { return sha; }
  async remove(): Promise<void> { this.removed = true; }
}
class SequencedEndToEndGit extends EndToEndGit {
  #index = 0;
  constructor(readonly pathSequence: readonly (readonly string[])[]) { super(); }
  override async changedPaths(): Promise<string[]> {
    const paths = this.pathSequence[Math.min(this.#index, this.pathSequence.length - 1)] ?? [];
    this.#index += 1;
    return [...paths];
  }
}
class EndToEndVerifier implements VerificationRunner {
  async run(): Promise<CheckResult[]> { return [{ command: "npm test", status: "passed", exitCode: 0, durationMs: 10, outputDigest: "f".repeat(64) }]; }
}
class EndToEndHost implements ForgeHost {
  async materializeDecomposition() { return []; }
  snapshot: PullRequestSnapshot = { repo: "a/b", number: 11, title: "Fix", body: "", url: "https://github.test/a/b/pull/11", state: "OPEN", headSha: sha, headBranch: workspace.branch, baseBranch: "main" };
  issueClosed = false;
  findingIssues = 0;
  remediationChildDepths: number[] = [];
  async createPullRequest(input: { baseBranch: string }): Promise<PullRequestSnapshot> {
    this.snapshot.baseBranch = input.baseBranch;
    return { ...this.snapshot };
  }
  async getPullRequest(): Promise<PullRequestSnapshot> { return { ...this.snapshot }; }
  async getPullRequestDiff(): Promise<string> { return "diff --git a/src/a.js b/src/a.js\n+guard();"; }
  async getBranchHead(): Promise<string> { return sha; }
  async publishPullRequestComment(): Promise<void> {}
  async materializeReviewFinding() {
    this.findingIssues++;
    return { repo: "a/b", number: 99, title: "finding", body: "", url: "https://github.test/a/b/issues/99", state: "OPEN" as const };
  }
  async materializeRemediationChildren(input: { remediationDepth: number }) {
    this.remediationChildDepths.push(input.remediationDepth);
    return [{ repo: "a/b", number: 30, title: "child", body: "", url: "https://github.test/a/b/issues/30", state: "OPEN" as const }];
  }
  async mergePullRequest(_repo: string, _number: number, expected: string, expectedBase: string): Promise<void> {
    assert.equal(expected, sha);
    assert.equal(expectedBase, this.snapshot.baseBranch);
    this.snapshot.state = "MERGED";
  }
  async getIssue(number: number, repo = "a/b") {
    return { repo, number, title: "Issue", body: "", url: `https://github.test/${repo}/issues/${number}`, state: this.issueClosed ? "CLOSED" as const : "OPEN" as const };
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
  it("closes an invalid investigation without entering build or delivery", async () => {
    const runtime = new FakeAgentRuntime([{
      ...investigation,
      outcome: "invalid",
      rootCause: undefined,
      summary: "The guarded implementation and regression test already cover the report.",
      recommendation: "Close as already resolved.",
    }]);
    const artifacts = new InMemoryArtifactRepository();
    const runs = new InMemoryRunRepository();
    const git = new EndToEndGit();
    const host = new EndToEndHost();
    const intent = createArtifact({
      kind: "Intent", runId: "run_invalid_work_on", subject: { repo: "a/b", issue: 8 }, producer: { role: "controller" },
      payload: { title: "Already fixed", problem: "The report is already covered", constraints: [], acceptanceHints: [], dependencies: [] },
    });
    const result = await workOn({
      intent, repoPath: process.cwd(), lane: fastLane, autoMerge: true,
      verification: [{ id: "test", command: "npm", args: ["test"], timeoutMs: 60_000, required: true }],
    }, { runtime, artifacts, runs, git, verifier: new EndToEndVerifier(), host });
    assert.equal(result.run.state, "invalid");
    assert.equal(host.issueClosed, true);
    assert.equal(host.findingIssues, 0);
    assert.equal(host.snapshot.state, "OPEN");
    assert.deepEqual(runtime.tasks.map((task) => task.role), ["investigator"]);
    assert.equal(git.removed, true);
    const outcomes = (await artifacts.list(intent.subject, "Outcome"))
      .filter((artifact): artifact is import("../../core/artifacts/schema.js").DurableArtifact<"Outcome"> => artifact.kind === "Outcome");
    assert.equal(outcomes.at(-1)?.payload.issueClosure?.status, "completed");
  });

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

  it("retains the worktree after exhausting two automatic verification repairs", async () => {
    const runtime = new FakeAgentRuntime([investigation, packet, submission, submission, submission]);
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
    const outcomes = artifacts.artifacts.filter((artifact) => artifact.kind === "Outcome");
    assert.equal(outcomes.length, 5);
    assert.deepEqual(outcomes.flatMap((outcome) => outcome.kind === "Outcome" && outcome.payload.failureEvidence?.repairAttempt !== undefined
      ? [outcome.payload.failureEvidence.repairAttempt]
      : []), [1, 2]);
    assert.equal(outcomes[0]?.kind === "Outcome" ? outcomes[0].payload.failureEvidence?.workspacePath : undefined, workspace.path);
    assert.equal(runtime.tasks.filter((task) => task.role === "builder").length, 3);
    assert.deepEqual((await runs.history(intent.runId)).map((record) => record.event).slice(-3), [
      "BUILD_COMPLETED", "VERIFICATION_FAILED", "VERIFICATION_REPAIR_EXHAUSTED",
    ]);
  });

  it("repairs a no-change build automatically within the same bounded budget", async () => {
    const runtime = new FakeAgentRuntime([investigation, packet, submission, submission, { summary: "Approved", findings: [] }]);
    const artifacts = new InMemoryArtifactRepository();
    const runs = new InMemoryRunRepository();
    const git = new SequencedEndToEndGit([[], ["src/a.js"]]);
    const host = new EndToEndHost();
    const intent = createArtifact({
      kind: "Intent", runId: "run_no_change_repair", subject: { repo: "a/b", issue: 8 }, producer: { role: "controller" },
      payload: { title: "Fix", problem: "Broken", constraints: [], acceptanceHints: ["Guard runs"], dependencies: [] },
    });
    const result = await workOn({
      intent, repoPath: process.cwd(), lane: fastLane, autoMerge: true,
      verification: [{ id: "test", command: "npm", args: ["test"], timeoutMs: 60_000, required: true }],
    }, { runtime, artifacts, runs, git, verifier: new EndToEndVerifier(), host });
    assert.equal(result.run.state, "completed");
    assert.equal(runtime.tasks.filter((task) => task.role === "builder").length, 2);
    const repairAttempts = artifacts.artifacts.flatMap((artifact) => artifact.kind === "Outcome" && artifact.payload.failureEvidence?.repairAttempt !== undefined
      ? [artifact.payload.failureEvidence.repairAttempt]
      : []);
    assert.deepEqual(repairAttempts, [1]);
  });

  it("repairs a verification failure automatically without another CLI invocation", async () => {
    const runtime = new FakeAgentRuntime([investigation, packet, submission, submission, { summary: "Approved", findings: [] }]);
    const artifacts = new InMemoryArtifactRepository();
    const runs = new InMemoryRunRepository();
    const git = new EndToEndGit();
    const host = new EndToEndHost();
    const intent = createArtifact({
      kind: "Intent", runId: "run_auto_repair", subject: { repo: "a/b", issue: 8 }, producer: { role: "controller" },
      payload: { title: "Fix", problem: "Broken", constraints: [], acceptanceHints: ["Guard runs"], dependencies: [] },
    });
    let verificationCalls = 0;
    const verifier: VerificationRunner = {
      async run() {
        verificationCalls += 1;
        return verificationCalls === 1
          ? [{ command: "npm test", status: "failed", exitCode: 1, durationMs: 10, summary: "test failed" }]
          : [{ command: "npm test", status: "passed", exitCode: 0, durationMs: 10 }];
      },
    };
    const result = await workOn({
      intent, repoPath: process.cwd(), lane: fastLane, autoMerge: true,
      verification: [{ id: "test", command: "npm", args: ["test"], timeoutMs: 60_000, required: true }],
    }, { runtime, artifacts, runs, git, verifier, host });
    assert.equal(result.run.state, "completed");
    assert.equal(verificationCalls, 2);
    assert.deepEqual(runtime.tasks.map((task) => task.role), ["investigator", "packet-author", "builder", "builder", "reviewer"]);
    assert.match(runtime.tasks[3]?.objective ?? "", /controller verification failed/);
    assert.ok((await runs.history(intent.runId)).some((record) => record.event === "VERIFICATION_REPAIR_REQUESTED"));
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
    assert.deepEqual(artifacts.artifacts.flatMap((artifact) => artifact.kind === "Outcome" && artifact.payload.failureEvidence?.repairAttempt !== undefined
      ? [artifact.payload.failureEvidence.repairAttempt]
      : []), [1]);
  });

  it("resumes an already-dispatched verification repair without spending another attempt", async () => {
    const artifacts = new InMemoryArtifactRepository();
    const runs = new InMemoryRunRepository();
    const git = new EndToEndGit();
    const host = new EndToEndHost();
    const intent = createArtifact({
      kind: "Intent", runId: "run_dispatched_repair_resume", subject: { repo: "a/b", issue: 8 }, producer: { role: "controller" },
      payload: { title: "Fix", problem: "Broken", constraints: [], acceptanceHints: ["Guard runs"], dependencies: [] },
    });
    const investigationArtifact = createArtifact({
      kind: "Investigation", runId: intent.runId, subject: intent.subject, producer: { role: "investigator" }, payload: investigation,
    });
    const packetArtifact = createArtifact({
      kind: "BuildPacket", runId: intent.runId, subject: intent.subject, producer: { role: "packet-author" }, payload: packet,
    });
    const dispatchedRepair = createArtifact({
      kind: "Outcome", runId: intent.runId, subject: intent.subject, producer: { role: "controller" },
      payload: {
        status: "blocked", reason: "Verification repair attempt 1 dispatched: Required verification failed", childIssues: [],
        failureEvidence: {
          branch: workspace.branch, workspacePath: workspace.path, builderSummary: "first attempt",
          changedPaths: ["src/a.js"], repairAttempt: 1,
          checks: [{ command: "npm test", status: "failed", failureClass: "command", durationMs: 1 }],
        },
      },
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
    for (const artifact of [intent, investigationArtifact, packetArtifact, dispatchedRepair]) await artifacts.append(artifact);

    const runtime = new FakeAgentRuntime([submission, { summary: "Approved", findings: [] }]);
    const resumed = await resumeBuildWorkOn({
      run,
      intent,
      investigation: investigationArtifact,
      packet: packetArtifact,
      priorVerificationFailure: dispatchedRepair,
      priorVerificationRepairAttempts: 1,
      workspace,
      baseBranch: "main",
      autoMerge: true,
      verification: [{ id: "test", command: "npm", args: ["test"], timeoutMs: 60_000, required: true }],
    }, { runtime, artifacts, runs, git, verifier: new EndToEndVerifier(), host });

    assert.equal(resumed.run.state, "completed");
    assert.deepEqual(runtime.tasks.map((task) => task.role), ["builder", "reviewer"]);
    assert.deepEqual(artifacts.artifacts.flatMap((artifact) => artifact.kind === "Outcome" && artifact.payload.failureEvidence?.repairAttempt !== undefined
      ? [artifact.payload.failureEvidence.repairAttempt]
      : []), [1]);
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
    const remediator = runtime.tasks.find((task) => task.role === "remediator");
    assert.deepEqual(remediator?.workspace.scope.writeRoots, []);
    assert.deepEqual(remediator?.workspace.scope.writePaths, packet.expectedPaths);
    assert.ok(remediator?.workspace.scope.readRoots.includes("src"));
    assert.deepEqual((await runs.history(intent.runId)).map((record) => record.event).slice(-7), [
      "REVIEW_CHANGES_REQUESTED", "REMEDIATION_COMPLETED", "VERIFICATION_PASSED", "PR_PUBLISHED",
      "REVIEW_APPROVED", "MERGE_COMPLETED", "CLOSE_COMPLETED",
    ]);
  });

  it("automatically repairs controller verification after review remediation", async () => {
    const artifacts = new InMemoryArtifactRepository();
    const runs = new InMemoryRunRepository();
    const git = new EndToEndGit();
    const host = new EndToEndHost();
    const intent = createArtifact({
      kind: "Intent", runId: "run_remediation_repair", subject: { repo: "a/b", issue: 8 }, producer: { role: "controller" },
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
      id: "correctness-repair", severity: "high" as const, confidence: "high" as const, blocking: true,
      scopeDisposition: "in_scope" as const, scopeRationale: "Directly violates the frozen guard criterion.",
      matchedAcceptanceCriteria: ["Guard runs"], matchedPriorFindingIds: [] as string[], introducedByRemediation: false,
      title: "Guard is incomplete", evidence: "One accepted case is absent", location: "src/a.js:1",
      intentRelevance: "The frozen criterion requires it", remediation: "Complete the guard",
    };
    let run = createRun({ workflow: "work-on", subject: intent.subject, runId: intent.runId, target: runTarget });
    await runs.create(run);
    for (const event of ["START_INVESTIGATION", "INVESTIGATION_CONFIRMED", "BUILD_PACKET_READY", "BUILD_COMPLETED", "VERIFICATION_PASSED"] as const) {
      const advanced = transition(run, event, { headSha: sha });
      await runs.commit(run.version, advanced.state, advanced.record);
      run = advanced.state;
    }
    const runtime = new FakeAgentRuntime([
      { summary: "Changes required", findings: [finding] },
      acceptAdjudication,
      submission,
      submission,
      { summary: "Approved after verification repair", findings: [] },
    ]);
    let checks = 0;
    const verifier: VerificationRunner = {
      async run() {
        checks += 1;
        return checks === 1
          ? [{ command: "npm test", status: "failed", exitCode: 1, durationMs: 1, summary: "whitespace" }]
          : [{ command: "npm test", status: "passed", exitCode: 0, durationMs: 1 }];
      },
    };
    const resumed = await resumePublicationWorkOn({
      run, intent, investigation: investigationArtifact, packet: packetArtifact, buildResult,
      workspace, baseBranch: "main", autoMerge: true,
      verification: [{ id: "test", command: "npm", args: ["test"], timeoutMs: 60_000, required: true }],
    }, { runtime, artifacts, runs, git, verifier, host });
    assert.equal(
      resumed.run.state,
      "completed",
      JSON.stringify(artifacts.artifacts.filter((artifact) => artifact.kind === "Outcome").map((artifact) => artifact.payload)),
    );
    assert.equal(checks, 2);
    assert.deepEqual(runtime.tasks.map((task) => task.role), ["reviewer", "adjudicator", "remediator", "builder", "reviewer"]);
    assert.ok(runtime.tasks[3]?.context.some((artifact) => artifact.kind === "ReviewVerdict"));
    assert.ok(runtime.tasks[3]?.context.some((artifact) => artifact.kind === "Outcome"));
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

  it("does not grant another remediation when an exhausted-budget reassessment still requests changes", async () => {
    const artifacts = new InMemoryArtifactRepository();
    const runs = new InMemoryRunRepository();
    const git = new EndToEndGit();
    const host = new EndToEndHost();
    const intent = createArtifact({
      kind: "Intent", runId: "run_review_budget_repeat", subject: { repo: "a/b", issue: 8 }, producer: { role: "controller" },
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
      id: "budget-repeat", severity: "high" as const, confidence: "high" as const, blocking: true,
      scopeDisposition: "in_scope" as const, scopeRationale: "Directly violates the frozen criterion.",
      matchedAcceptanceCriteria: ["Guard runs"], matchedPriorFindingIds: [] as string[], introducedByRemediation: false,
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
    const repeatedFinding = { ...finding, matchedPriorFindingIds: [finding.id] };
    const runtime = new FakeAgentRuntime([
      { summary: "Changes still required", findings: [repeatedFinding] },
      acceptAdjudication,
    ]);
    const resumed = await resumeReviewWorkOn({
      run, intent, investigation: investigationArtifact, packet: packetArtifact, buildResult, priorVerdict,
      pullRequest: host.snapshot, workspace, baseBranch: "main", autoMerge: true,
      maxRemediationCycles: 2, priorRemediationCycles: 2,
      verification: [{ id: "test", command: "npm", args: ["test"], timeoutMs: 60_000, required: true }],
    }, { runtime, artifacts, runs, git, verifier: new EndToEndVerifier(), host });

    assert.equal(resumed.run.state, "blocked");
    assert.match(resumed.run.blockedReason ?? "", /Remediation budget exhausted after 2 cycle/);
    assert.deepEqual(runtime.tasks.map((task) => task.role), ["reviewer", "adjudicator"]);
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
    const blocked = await workOn({
      intent, repoPath: process.cwd(), lane: fastLane, autoMerge: true,
      verification: [],
    }, { runtime: initialRuntime, artifacts, runs, git, verifier: new EndToEndVerifier(), host });
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

  it("preserves the remediation budget when verification resumes after a failed remediation", async () => {
    const initialRuntime = new FakeAgentRuntime([investigation, packet, submission]);
    const artifacts = new InMemoryArtifactRepository();
    const runs = new InMemoryRunRepository();
    const git = new EndToEndGit();
    const host = new EndToEndHost();
    const intent = createArtifact({
      kind: "Intent", runId: "run_resume_budget", subject: { repo: "a/b", issue: 8 }, producer: { role: "controller" },
      payload: { title: "Fix", problem: "Broken", constraints: [], acceptanceHints: ["Guard runs"], dependencies: [] },
    });
    const blocked = await workOn({
      intent, repoPath: process.cwd(), lane: fastLane, autoMerge: true,
      verification: [],
    }, { runtime: initialRuntime, artifacts, runs, git, verifier: new EndToEndVerifier(), host });
    assert.equal(blocked.run.state, "blocked");

    const investigationArtifact = artifacts.artifacts.find((artifact) => artifact.kind === "Investigation");
    const packetArtifact = artifacts.artifacts.find((artifact) => artifact.kind === "BuildPacket");
    const outcome = artifacts.artifacts.find((artifact) => artifact.kind === "Outcome");
    assert.ok(investigationArtifact?.kind === "Investigation");
    assert.ok(packetArtifact?.kind === "BuildPacket");
    assert.ok(outcome?.kind === "Outcome");
    const finding = {
      id: "budget-1", severity: "high" as const, confidence: "high" as const, blocking: true,
      scopeDisposition: "in_scope" as const, scopeRationale: "Directly violates the frozen criterion.",
      matchedAcceptanceCriteria: ["Guard runs"], matchedPriorFindingIds: [] as string[], introducedByRemediation: false,
      title: "Guard is still incomplete", evidence: "One accepted case is missing", location: "src/a.js:1",
      intentRelevance: "The frozen criterion requires it", remediation: "Complete the guard",
    };
    const resumedRuntime = new FakeAgentRuntime([
      { summary: "Changes still required", findings: [finding] },
      acceptAdjudication,
    ]);
    const resumed = await resumeWorkOn({
      run: blocked.run,
      intent,
      investigation: investigationArtifact,
      packet: packetArtifact,
      outcome,
      workspace,
      baseBranch: "main",
      autoMerge: true,
      maxRemediationCycles: 1,
      priorRemediationCycles: 1,
      verification: [{ id: "test", command: "npm", args: ["test"], timeoutMs: 60_000, required: true }],
    }, { runtime: resumedRuntime, artifacts, runs, git, verifier: new EndToEndVerifier(), host });

    assert.equal(resumed.run.state, "blocked");
    assert.match(resumed.run.blockedReason ?? "", /Remediation budget exhausted after 1 cycle/);
    assert.deepEqual(resumedRuntime.tasks.map((task) => task.role), ["reviewer", "adjudicator"]);
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

  it("routes an authorized remediation child PR back into the parent delivery branch", async () => {
    const runtime = new FakeAgentRuntime([investigation, packet, submission, { summary: "Approved", findings: [] }]);
    const artifacts = new InMemoryArtifactRepository();
    const runs = new InMemoryRunRepository();
    const git = new EndToEndGit();
    const host = new EndToEndHost();
    const intent = createArtifact({
      kind: "Intent", runId: "run_child_route", subject: { repo: "a/b", issue: 30 }, producer: { role: "controller" },
      payload: { title: "Fix child", problem: "Broken", constraints: [], acceptanceHints: ["Guard runs"], dependencies: [] },
    });
    const result = await workOn({
      intent,
      repoPath: process.cwd(),
      lane: fastLane,
      autoMerge: true,
      verification: [{ id: "test", command: "npm", args: ["test"], timeoutMs: 60_000, required: true }],
      parentRemediation: {
        parentRunId: "run_parent",
        parentIssue: 8,
        parentPullRequest: 11,
        parentBranch: "forgedock/parent",
        parentHeadSha: sha,
        findingId: "finding-1",
        findingLocation: "src/a.js",
        remediationDepth: 1,
        maxRemediationDepth: 2,
      },
    }, { runtime, artifacts, runs, git, verifier: new EndToEndVerifier(), host });
    assert.equal(result.run.state, "completed");
    assert.equal(result.run.targetBranch, "forgedock/parent");
    assert.equal(git.createdFrom, "origin/forgedock/parent");
    assert.equal(host.snapshot.baseBranch, "forgedock/parent");
  });

  it("allows an authorized remediation child to dispatch the configured next recursive level", async () => {
    const finding = {
      id: "nested-scope", severity: "high" as const, confidence: "high" as const, blocking: true,
      scopeDisposition: "in_scope" as const, scopeRationale: "Required by the frozen behavior.",
      matchedAcceptanceCriteria: ["Guard runs"], matchedPriorFindingIds: [] as string[], introducedByRemediation: false,
      title: "Nested delivery path is required", evidence: "The accepted path still fails",
      location: "src/nested.js:1", intentRelevance: "Required by the criterion", remediation: "Fix the nested path",
    };
    const runtime = new FakeAgentRuntime([
      investigation, packet, submission,
      { summary: "Changes required", findings: [finding] },
      { summary: "Scope confirmed", findings: [finding] },
      acceptAdjudication,
    ]);
    const artifacts = new InMemoryArtifactRepository();
    const runs = new InMemoryRunRepository();
    const git = new EndToEndGit();
    const host = new EndToEndHost();
    const intent = createArtifact({
      kind: "Intent", runId: "run_nested_child", subject: { repo: "a/b", issue: 30 }, producer: { role: "controller" },
      payload: { title: "Fix child", problem: "Broken", constraints: [], acceptanceHints: ["Guard runs"], dependencies: [] },
    });
    const result = await workOn({
      intent, repoPath: process.cwd(), lane: fastLane, autoMerge: true,
      scopeExpansion: "recursive", remediationDepth: 1, maxRemediationDepth: 2, maxRemediationChildren: 2,
      verification: [{ id: "test", command: "npm", args: ["test"], timeoutMs: 60_000, required: true }],
      parentRemediation: {
        parentRunId: "run_parent", parentIssue: 8, parentPullRequest: 11,
        parentBranch: "forgedock/parent", parentHeadSha: sha,
        findingId: "finding-1", findingLocation: "src/a.js",
        remediationDepth: 1, maxRemediationDepth: 2,
      },
    }, { runtime, artifacts, runs, git, verifier: new EndToEndVerifier(), host });
    assert.equal(result.run.state, "blocked");
    assert.deepEqual(host.remediationChildDepths, [2]);
    const checkpoint = artifacts.artifacts.findLast((artifact) => artifact.kind === "RemediationBlocked");
    assert.equal(checkpoint?.kind === "RemediationBlocked" ? checkpoint.payload.remediationDepth : undefined, 1);
    assert.equal(checkpoint?.kind === "RemediationBlocked" ? checkpoint.payload.status : undefined, "children-running");
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
