import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createArtifact } from "../../core/artifacts/schema.js";
import type { GitWorkspace, GitWorkspaceManager } from "../../core/ports/git-workspace.js";
import { InMemoryArtifactRepository, InMemoryRunRepository } from "../../core/ports/repositories.js";
import type { CheckResult, VerificationRunner } from "../../core/ports/verification.js";
import { createRun, transition, type RunState, type TransitionEvent } from "../../core/state/machine.js";
import type { BuilderSubmission } from "./build.js";
import { verifyAndCommit } from "./verify.js";

const workspace: GitWorkspace = { path: "/tmp/worktree", branch: "forgedock/issue-1", baseRef: "main", baseSha: "0".repeat(40) };
const submission: BuilderSubmission = {
  summary: "Implemented guard", changedPaths: ["src/a.ts"],
  criterionCoverage: [{ criterion: "Preserves state", implementation: "Guard preserves previous state" }],
  decisions: [], residualRisks: [],
};

class FakeGit implements GitWorkspaceManager {
  constructor(readonly paths: string[], readonly revisionPaths = paths) {}
  async create(): Promise<GitWorkspace> { return workspace; }
  async changedPaths(): Promise<string[]> { return this.paths; }
  async revisionChangedPaths(): Promise<string[]> { return this.revisionPaths; }
  async commit(): Promise<string> { return "a".repeat(40); }
  async push(): Promise<void> {}
  async head(): Promise<string> { return "a".repeat(40); }
  async remove(): Promise<void> {}
}
class FakeVerifier implements VerificationRunner {
  constructor(readonly results: CheckResult[]) {}
  async run(): Promise<CheckResult[]> { return this.results; }
}

async function verifyingRun(runs: InMemoryRunRepository): Promise<RunState> {
  let run = createRun({ workflow: "work-on", subject: { repo: "a/b", issue: 1 }, runId: `run_verify_${crypto.randomUUID()}` });
  await runs.create(run);
  for (const event of ["START_INVESTIGATION", "INVESTIGATION_CONFIRMED", "BUILD_PACKET_READY", "BUILD_COMPLETED"] as TransitionEvent[]) {
    const next = transition(run, event);
    await runs.commit(run.version, next.state, next.record);
    run = next.state;
  }
  return run;
}

function packet(run: RunState) {
  return createArtifact({
    kind: "BuildPacket", runId: run.runId, subject: run.subject, producer: { role: "packet-author" },
    payload: {
      scope: ["Guard"], acceptanceCriteria: ["Preserves state"], context: [], implementationPlan: ["Edit"],
      expectedPaths: ["src/a.ts"], verificationPlan: ["npm test"], risks: [], outOfScope: [],
    },
  });
}

const command = { id: "test", command: "npm", args: ["test"], cwd: "/tmp/worktree", timeoutMs: 1000, required: true } as const;
const passed: CheckResult = { command: "npm test", status: "passed", exitCode: 0, durationMs: 10, outputDigest: "b".repeat(64) };

describe("verification and commit barrier", () => {
  it("commits only after required executable evidence passes", async () => {
    const runs = new InMemoryRunRepository();
    const artifacts = new InMemoryArtifactRepository();
    const run = await verifyingRun(runs);
    const result = await verifyAndCommit({
      run, packet: packet(run), submission, workspace, commands: [command],
      subjectEvidence: ["GitHub issue #1 labels: pipeline-probe", "GitHub issue #1 body: Depends on #5"],
    }, {
      verifier: new FakeVerifier([passed]), git: new FakeGit(["src/a.ts"]), artifacts, runs,
    });
    assert.equal(result.run.state, "publishing");
    assert.equal(result.buildResult?.payload.headSha, "a".repeat(40));
    assert.equal(result.buildResult?.payload.baseSha, workspace.baseSha);
    assert.equal(result.buildResult?.payload.checks[0]?.status, "passed");
    assert.match(result.buildResult?.payload.acceptanceEvidence[0]?.evidence ?? "", /pipeline-probe.*Depends on #5/);
  });

  it("records the complete delivery revision after a partial remediation attempt", async () => {
    const runs = new InMemoryRunRepository();
    const artifacts = new InMemoryArtifactRepository();
    const run = await verifyingRun(runs);
    const result = await verifyAndCommit({ run, packet: packet(run), submission, workspace, commands: [command] }, {
      verifier: new FakeVerifier([passed]),
      git: new FakeGit(["src/a.ts"], ["SECURITY.md", "docs/contract.md", "src/a.ts"]),
      artifacts, runs,
    });
    assert.deepEqual(result.buildResult?.payload.changedPaths, ["SECURITY.md", "docs/contract.md", "src/a.ts"]);
  });

  it("retains unchanged baseline-failure evidence without treating a required failure as passed", async () => {
    const runs = new InMemoryRunRepository();
    const artifacts = new InMemoryArtifactRepository();
    const run = await verifyingRun(runs);
    const knownFailure: CheckResult = {
      command: "npm test", status: "failed", exitCode: 1, durationMs: 12,
      outputDigest: "c".repeat(64), summary: "2 tests failed", failureSignatures: ["not ok - existing Windows test"],
    };
    const result = await verifyAndCommit({
      run, packet: packet(run), submission, workspace, commands: [command], baselineChecks: [knownFailure],
    }, {
      verifier: new FakeVerifier([{ ...knownFailure, outputDigest: "d".repeat(64), durationMs: 14 }]),
      git: new FakeGit(["src/a.ts"]), artifacts, runs,
    });
    assert.equal(result.run.state, "blocked");
    assert.equal(result.buildResult, undefined);
    assert.equal(result.outcome?.payload.failureEvidence?.checks[0]?.baselineStatus, "failed");
    assert.equal(result.outcome?.payload.failureEvidence?.checks[0]?.regression, false);
  });

  it("retains check-level evidence and recovery workspace when verification fails", async () => {
    const runs = new InMemoryRunRepository();
    const artifacts = new InMemoryArtifactRepository();
    const run = await verifyingRun(runs);
    const failed: CheckResult = {
      command: "npm test", status: "failed", exitCode: 1, durationMs: 12,
      outputDigest: "c".repeat(64), summary: "AssertionError: expected 2, received 3",
    };
    const result = await verifyAndCommit({ run, packet: packet(run), submission, workspace, commands: [command] }, {
      verifier: new FakeVerifier([failed]), git: new FakeGit(["src/a.ts"]), artifacts, runs,
    });
    assert.equal(result.run.state, "blocked");
    assert.match(result.outcome?.payload.reason ?? "", /npm test \(exit 1\).*AssertionError/);
    assert.deepEqual(result.outcome?.payload.failureEvidence, {
      branch: workspace.branch,
      workspacePath: workspace.path,
      baseSha: workspace.baseSha,
      builderSummary: submission.summary,
      changedPaths: ["src/a.ts"],
      checks: [failed],
    });
  });

  it("blocks paths outside the frozen Build Packet before commit", async () => {
    const runs = new InMemoryRunRepository();
    const artifacts = new InMemoryArtifactRepository();
    const run = await verifyingRun(runs);
    const result = await verifyAndCommit({ run, packet: packet(run), submission, workspace, commands: [command] }, {
      verifier: new FakeVerifier([passed]), git: new FakeGit(["src/a.ts", "unrelated.ts"]), artifacts, runs,
    });
    assert.equal(result.run.state, "blocked");
    assert.match(result.outcome?.payload.reason ?? "", /outside the Build Packet/);
    assert.equal(result.buildResult, undefined);
  });
});
