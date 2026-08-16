import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { createArtifact } from "../../core/artifacts/schema.js";
import type { GitWorkspace, GitWorkspaceManager } from "../../core/ports/git-workspace.js";
import { InMemoryArtifactRepository, InMemoryRunRepository } from "../../core/ports/repositories.js";
import type { CheckResult, VerificationRunner } from "../../core/ports/verification.js";
import { createRun, transition, type RunState, type TransitionEvent } from "../../core/state/machine.js";
import type { BuilderSubmission } from "./build.js";
import { uncoveredVerificationCommands, verifyAndCommit } from "./verify.js";

const workspace: GitWorkspace = { path: "/tmp/worktree", branch: "forgedock/issue-1", baseRef: "main", baseSha: "0".repeat(40) };
const submission: BuilderSubmission = {
  summary: "Implemented guard", changedPaths: ["src/a.ts"],
  criterionCoverage: [{ criterion: "Preserves state", implementation: "Guard preserves previous state" }],
  decisions: [], residualRisks: [],
};

class FakeGit implements GitWorkspaceManager {
  committed = false;
  dependenciesPrepared = false;
  pushed = false;
  constructor(
    readonly paths: string[],
    readonly revisionPaths: string[] = [],
    readonly committedRevisionPaths = [...new Set([...revisionPaths, ...paths])],
  ) {}
  async create(): Promise<GitWorkspace> { return workspace; }
  async changedPaths(): Promise<string[]> { return this.paths; }
  async revisionChangedPaths(): Promise<string[]> {
    return this.committed ? this.committedRevisionPaths : this.revisionPaths;
  }
  async syncToRemoteHead(): Promise<void> {}
  async isAncestor(): Promise<boolean> { return true; }
  async prepareWorkspaceDependencies(): Promise<void> { this.dependenciesPrepared = true; }
  async committedContentMatches(): Promise<boolean> { return true; }
  async commit(): Promise<string> { this.committed = true; return "a".repeat(40); }
  async push(): Promise<void> { this.pushed = true; }
  async head(): Promise<string> { return "a".repeat(40); }
  async remove(): Promise<void> {}
}
class FakeVerifier implements VerificationRunner {
  constructor(readonly results: CheckResult[]) {}
  async run(): Promise<CheckResult[]> { return this.results; }
}

async function verifyingRun(runs: InMemoryRunRepository): Promise<RunState> {
  let run = createRun({
    workflow: "work-on",
    subject: { repo: "a/b", issue: 1 },
    runId: `run_verify_${crypto.randomUUID()}`,
    target: { lane: "fast", targetBranch: "main" },
  });
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

function linkDirectory(target: string, path: string): void {
  symlinkSync(target, path, process.platform === "win32" ? "junction" : "dir");
}

describe("verification and commit barrier", () => {
  it("commits only after required executable evidence passes", async () => {
    const runs = new InMemoryRunRepository();
    const artifacts = new InMemoryArtifactRepository();
    const run = await verifyingRun(runs);
    const git = new FakeGit(["src/a.ts"]);
    const verifier: VerificationRunner = {
      async run() {
        assert.equal(git.dependenciesPrepared, true, "changed lockfile state is installed before verification");
        return [passed];
      },
    };
    const result = await verifyAndCommit({
      run, packet: packet(run), submission, workspace, commands: [command],
      subjectEvidence: ["GitHub issue #1 labels: pipeline-probe", "GitHub issue #1 body: Depends on #5"],
    }, { verifier, git, artifacts, runs });
    assert.equal(result.run.state, "publishing");
    assert.equal(result.buildResult?.payload.headSha, "a".repeat(40));
    assert.equal(result.buildResult?.payload.baseSha, workspace.baseSha);
    assert.equal(result.buildResult?.payload.checks[0]?.status, "passed");
    assert.match(result.buildResult?.payload.acceptanceEvidence[0]?.evidence ?? "", /pipeline-probe.*Depends on #5/);
  });

  it("keeps a real regular-file delivery on the publishing path", async () => {
    const directory = mkdtempSync(join(tmpdir(), "forgedock-verify-regular-"));
    mkdirSync(join(directory, "src"), { recursive: true });
    writeFileSync(join(directory, "src", "a.ts"), "export const value = 1;\n");
    try {
      const runs = new InMemoryRunRepository();
      const artifacts = new InMemoryArtifactRepository();
      const run = await verifyingRun(runs);
      const result = await verifyAndCommit({
        run, packet: packet(run), submission, workspace: { ...workspace, path: directory }, commands: [command],
      }, { verifier: new FakeVerifier([passed]), git: new FakeGit(["src/a.ts"]), artifacts, runs });
      assert.equal(result.run.state, "publishing");
      assert.ok(result.buildResult);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("blocks an escaping link created by verification before commit", async () => {
    const root = mkdtempSync(join(tmpdir(), "forgedock-verify-escape-"));
    const directory = join(root, "worktree");
    const outside = join(root, "outside");
    const file = join(directory, "src", "a.ts");
    mkdirSync(join(directory, "src"), { recursive: true });
    mkdirSync(outside);
    writeFileSync(file, "export const value = 1;\n");
    try {
      const runs = new InMemoryRunRepository();
      const artifacts = new InMemoryArtifactRepository();
      const run = await verifyingRun(runs);
      let verifierRuns = 0;
      const verifier: VerificationRunner = {
        async run() {
          verifierRuns++;
          rmSync(file, { force: true });
          linkDirectory(outside, file);
          return [passed];
        },
      };
      const git = new FakeGit(["src/a.ts"]);
      const result = await verifyAndCommit({
        run, packet: packet(run), submission, workspace: { ...workspace, path: directory }, commands: [command],
      }, { verifier, git, artifacts, runs });
      assert.equal(result.run.state, "blocked");
      assert.match(result.outcome?.payload.reason ?? "", /symbolic link/);
      assert.deepEqual(result.outcome?.payload.failureEvidence?.changedPaths, ["src/a.ts"]);
      assert.deepEqual(result.outcome?.payload.failureEvidence?.checks, [passed]);
      assert.equal(result.buildResult, undefined);
      assert.equal(verifierRuns, 1);
      assert.equal(git.committed, false);
      assert.equal(git.pushed, false);
      assert.equal(artifacts.artifacts.some((artifact) => artifact.kind === "BuildResult"), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("blocks a broken delivery link before running verification", async () => {
    const root = mkdtempSync(join(tmpdir(), "forgedock-verify-broken-"));
    const directory = join(root, "worktree");
    const file = join(directory, "src", "a.ts");
    const target = join(root, "missing-target");
    mkdirSync(join(directory, "src"), { recursive: true });
    mkdirSync(target);
    linkDirectory(target, file);
    rmSync(target, { recursive: true, force: true });
    try {
      const runs = new InMemoryRunRepository();
      const artifacts = new InMemoryArtifactRepository();
      const run = await verifyingRun(runs);
      let verifierRuns = 0;
      const verifier: VerificationRunner = { async run() { verifierRuns++; throw new Error("verification must not execute"); } };
      const git = new FakeGit(["src/a.ts"]);
      const result = await verifyAndCommit({
        run, packet: packet(run), submission, workspace: { ...workspace, path: directory }, commands: [command],
      }, { verifier, git, artifacts, runs });
      assert.equal(result.run.state, "blocked");
      assert.match(result.outcome?.payload.reason ?? "", /symbolic link/);
      assert.deepEqual(result.outcome?.payload.failureEvidence?.changedPaths, ["src/a.ts"]);
      assert.deepEqual(result.outcome?.payload.failureEvidence?.checks, []);
      assert.equal(result.buildResult, undefined);
      assert.equal(verifierRuns, 0);
      assert.equal(git.committed, false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("blocks an in-workspace delivery link at the pre-verification seal", async () => {
    const root = mkdtempSync(join(tmpdir(), "forgedock-verify-in-workspace-"));
    const directory = join(root, "worktree");
    const file = join(directory, "src", "a.ts");
    const target = join(directory, "src", "target");
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "value.txt"), "inside\n");
    linkDirectory(target, file);
    try {
      const runs = new InMemoryRunRepository();
      const artifacts = new InMemoryArtifactRepository();
      const run = await verifyingRun(runs);
      const verifier: VerificationRunner = { async run() { throw new Error("verification must not execute"); } };
      const git = new FakeGit(["src/a.ts"]);
      const result = await verifyAndCommit({
        run, packet: packet(run), submission, workspace: { ...workspace, path: directory }, commands: [command],
      }, { verifier, git, artifacts, runs });
      assert.equal(result.run.state, "blocked");
      assert.match(result.outcome?.payload.reason ?? "", /symbolic link/);
      assert.deepEqual(result.outcome?.payload.failureEvidence?.changedPaths, ["src/a.ts"]);
      assert.equal(result.buildResult, undefined);
      assert.equal(git.committed, false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("blocks a link inserted between the post-verification seal and commit", async () => {
    const root = mkdtempSync(join(tmpdir(), "forgedock-verify-race-"));
    const directory = join(root, "worktree");
    const outside = join(root, "outside");
    const file = join(directory, "src", "a.ts");
    mkdirSync(join(directory, "src"), { recursive: true });
    mkdirSync(outside);
    writeFileSync(file, "export const value = 1;\n");
    try {
      const runs = new InMemoryRunRepository();
      const artifacts = new InMemoryArtifactRepository();
      const run = await verifyingRun(runs);
      class RacingGit extends FakeGit {
        override async commit(): Promise<string> {
          rmSync(file, { force: true });
          linkDirectory(outside, file);
          return super.commit();
        }
      }
      const git = new RacingGit(["src/a.ts"]);
      const result = await verifyAndCommit({
        run, packet: packet(run), submission, workspace: { ...workspace, path: directory }, commands: [command],
      }, { verifier: new FakeVerifier([passed]), git, artifacts, runs });
      assert.equal(result.run.state, "blocked");
      assert.match(result.outcome?.payload.reason ?? "", /symbolic link/);
      assert.deepEqual(result.outcome?.payload.failureEvidence?.changedPaths, ["src/a.ts"]);
      assert.deepEqual(result.outcome?.payload.failureEvidence?.checks, [passed]);
      assert.equal(result.buildResult, undefined);
      assert.equal(git.committed, true);
      assert.equal(git.pushed, false);
      assert.equal(artifacts.artifacts.some((artifact) => artifact.kind === "BuildResult"), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("resolves criterion coverage by stable packet IDs rather than model wording", async () => {
    const runs = new InMemoryRunRepository();
    const artifacts = new InMemoryArtifactRepository();
    const run = await verifyingRun(runs);
    const result = await verifyAndCommit({
      run,
      packet: packet(run),
      submission: {
        ...submission,
        criterionCoverage: [{ criterionId: "criterion-1", criterion: "Paraphrased by the builder", implementation: "Guard preserves state" }],
      },
      workspace,
      commands: [command],
    }, { verifier: new FakeVerifier([passed]), git: new FakeGit(["src/a.ts"]), artifacts, runs });
    assert.equal(result.run.state, "publishing");
    assert.equal(result.buildResult?.payload.acceptanceEvidence[0]?.criterion, "Preserves state");
  });

  it("blocks when raw committed blobs differ from the verified worktree content", async () => {
    const runs = new InMemoryRunRepository();
    const artifacts = new InMemoryArtifactRepository();
    const run = await verifyingRun(runs);
    class FilteredGit extends FakeGit {
      override async committedContentMatches(): Promise<boolean> { return false; }
    }
    const result = await verifyAndCommit({
      run, packet: packet(run), submission, workspace, commands: [command],
    }, {
      verifier: new FakeVerifier([passed]), git: new FilteredGit(["src/a.ts"]), artifacts, runs,
    });
    assert.equal(result.run.state, "blocked");
    assert.match(result.outcome?.payload.reason ?? "", /Raw committed blobs do not match/);
    assert.equal(result.buildResult, undefined);
  });

  it("validates and records the complete delivery revision after a partial remediation attempt", async () => {
    const runs = new InMemoryRunRepository();
    const artifacts = new InMemoryArtifactRepository();
    const run = await verifyingRun(runs);
    const frozen = packet(run);
    const completePaths = ["SECURITY.md", "docs/contract.md", "src/a.ts"];
    const result = await verifyAndCommit({
      run,
      packet: { ...frozen, payload: { ...frozen.payload, expectedPaths: completePaths } },
      submission: { ...submission, changedPaths: completePaths },
      workspace,
      commands: [command],
    }, {
      verifier: new FakeVerifier([passed]),
      git: new FakeGit(["src/a.ts"], ["SECURITY.md", "docs/contract.md"]),
      artifacts, runs,
    });
    assert.deepEqual(result.buildResult?.payload.changedPaths, completePaths);
  });

  it("rejects an out-of-packet path already committed on the delivery branch", async () => {
    const runs = new InMemoryRunRepository();
    const artifacts = new InMemoryArtifactRepository();
    const run = await verifyingRun(runs);
    const verifier: VerificationRunner = { async run() { throw new Error("verification must not execute"); } };
    const result = await verifyAndCommit({
      run,
      packet: packet(run),
      submission: { ...submission, changedPaths: ["SECURITY.md", "src/a.ts"] },
      workspace,
      commands: [command],
    }, {
      verifier,
      git: new FakeGit(["src/a.ts"], ["SECURITY.md"]),
      artifacts,
      runs,
    });
    assert.equal(result.run.state, "blocked");
    assert.match(result.outcome?.payload.reason ?? "", /delivery revision contains paths outside the Build Packet.*SECURITY\.md/i);
    assert.equal(result.buildResult, undefined);
  });

  it("rejects a remediation report that omits retained committed paths", async () => {
    const runs = new InMemoryRunRepository();
    const artifacts = new InMemoryArtifactRepository();
    const run = await verifyingRun(runs);
    const frozen = packet(run);
    const result = await verifyAndCommit({
      run,
      packet: { ...frozen, payload: { ...frozen.payload, expectedPaths: ["docs/contract.md", "src/a.ts"] } },
      submission,
      workspace,
      commands: [command],
    }, {
      verifier: new FakeVerifier([passed]),
      git: new FakeGit(["src/a.ts"], ["docs/contract.md"]),
      artifacts,
      runs,
    });
    assert.equal(result.run.state, "blocked");
    assert.match(result.outcome?.payload.reason ?? "", /delivery revision.*omitted docs\/contract\.md/i);
    assert.equal(result.buildResult, undefined);
  });

  it("blocks when verification mutates an allowed file after observing it", async () => {
    const directory = mkdtempSync(join(tmpdir(), "forgedock-verify-content-"));
    const localWorkspace = { ...workspace, path: directory };
    mkdirSync(join(directory, "src"), { recursive: true });
    writeFileSync(join(directory, "src", "a.ts"), "export const value = 1;\n");
    try {
      const runs = new InMemoryRunRepository();
      const artifacts = new InMemoryArtifactRepository();
      const run = await verifyingRun(runs);
      const git = new FakeGit(["src/a.ts"]);
      const verifier: VerificationRunner = {
        async run() {
          writeFileSync(join(directory, "src", "a.ts"), "export const value = 2;\n");
          return [passed];
        },
      };
      const result = await verifyAndCommit({
        run, packet: packet(run), submission, workspace: localWorkspace, commands: [command],
      }, { verifier, git, artifacts, runs });
      assert.equal(result.run.state, "blocked");
      assert.match(result.outcome?.payload.reason ?? "", /verification commands changed.*untested results/i);
      assert.equal(git.committed, false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("blocks when the committed revision gains an unreported out-of-packet path", async () => {
    const runs = new InMemoryRunRepository();
    const artifacts = new InMemoryArtifactRepository();
    const run = await verifyingRun(runs);
    const result = await verifyAndCommit({ run, packet: packet(run), submission, workspace, commands: [command] }, {
      verifier: new FakeVerifier([passed]),
      git: new FakeGit(["src/a.ts"], [], ["outside.ts", "src/a.ts"]),
      artifacts,
      runs,
    });
    assert.equal(result.run.state, "blocked");
    assert.match(result.outcome?.payload.reason ?? "", /committed delivery revision contains paths outside the Build Packet.*outside\.ts/i);
    assert.deepEqual(result.outcome?.payload.failureEvidence?.changedPaths, ["outside.ts", "src/a.ts"]);
    assert.equal(result.buildResult, undefined);
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
      baseRef: workspace.baseRef,
      targetBranch: "main",
      baseSha: workspace.baseSha,
      builderSummary: submission.summary,
      changedPaths: ["src/a.ts"],
      criterionCoverage: submission.criterionCoverage,
      decisions: submission.decisions,
      residualRisks: submission.residualRisks,
      checks: [failed],
    });
  });

  it("blocks rather than claiming an unexecuted frozen verification command passed", async () => {
    const runs = new InMemoryRunRepository();
    const artifacts = new InMemoryArtifactRepository();
    const run = await verifyingRun(runs);
    const frozen = packet(run);
    const result = await verifyAndCommit({
      run,
      packet: { ...frozen, payload: { ...frozen.payload, verificationPlan: ["Run `npm run docs:build`.", "Run `npm test`."] } },
      submission, workspace, commands: [command],
    }, {
      verifier: new FakeVerifier([passed]), git: new FakeGit(["src/a.ts"]), artifacts, runs,
    });
    assert.equal(result.run.state, "blocked");
    assert.match(result.outcome?.payload.reason ?? "", /docs:build/);
    assert.deepEqual(result.outcome?.payload.failureEvidence?.checks, []);
    assert.deepEqual(uncoveredVerificationCommands(["Run `git diff --check`.", "Run `npm test`."], [
      { id: "diff-check", command: "git", args: ["diff", "--check"] }, command,
    ]), []);
    assert.deepEqual(
      uncoveredVerificationCommands(["`node --test test/contract.test.js`"], [command]),
      ["node --test test/contract.test.js"],
    );
    assert.deepEqual(
      uncoveredVerificationCommands([
        "Run `bun test`.",
        "Run `deno test`.",
        "Execute `bash scripts/check.sh`.",
        "Run `dotnet test`.",
        "Run `npm test -- --coverage`.",
        "custom-check --strict",
        "`scripts/check`",
        "Check `scripts/custom-check` exits zero.",
        "Check scripts/custom-check",
        "Ensure `scripts/custom-check` completes successfully.",
        "Confirm `scripts/custom-check` is green.",
        "Confirm that npm test works",
        "Confirm that `scripts/custom-check` works",
      ], [command]),
      [
        "bun test",
        "deno test",
        "bash scripts/check.sh",
        "dotnet test",
        "npm test -- --coverage",
        "custom-check --strict",
        "scripts/check",
        "scripts/custom-check",
        "Check scripts/custom-check",
        "Confirm that npm test works",
      ],
    );
    assert.deepEqual(
      uncoveredVerificationCommands(["Run `npm test`."], [{ id: "test", command: "npm", args: ["--version"] }]),
      ["npm test"],
    );
    assert.deepEqual(uncoveredVerificationCommands([
      "Inspect `src/a.ts` manually.",
      "Inspect `bin/forgedock-terminal` manually.",
      "Inspect `Dockerfile` manually.",
    ], [command]), []);
    assert.deepEqual(uncoveredVerificationCommands([
      "Confirm controller lifecycle gates: independent approval, PR target branch, automatic merge, trajectory publication, and authoritative issue closure.",
      "The controller verifies staging review evidence and owns the lifecycle gate.",
    ], [command]), []);
    assert.deepEqual(uncoveredVerificationCommands(["controller-gate:staging-review"], [command], [
      { id: "staging-review", description: "Controller validates the staging review branch." },
    ]), []);
    assert.deepEqual(uncoveredVerificationCommands(["controller-gate:staging-review"], [command]), ["controller-gate:staging-review"]);
  });

  it("rejects out-of-packet paths before executing repository commands", async () => {
    const runs = new InMemoryRunRepository();
    const artifacts = new InMemoryArtifactRepository();
    const run = await verifyingRun(runs);
    const verifier: VerificationRunner = { async run() { throw new Error("verification must not execute"); } };
    const result = await verifyAndCommit({ run, packet: packet(run), submission, workspace, commands: [command] }, {
      verifier, git: new FakeGit(["src/a.ts", "outside.ts"]), artifacts, runs,
    });
    assert.equal(result.run.state, "blocked");
    assert.match(result.outcome?.payload.reason ?? "", /outside the Build Packet/);
    assert.deepEqual(result.outcome?.payload.failureEvidence?.checks, []);
  });

  it("blocks incomplete criterion coverage instead of manufacturing passed evidence", async () => {
    const runs = new InMemoryRunRepository();
    const artifacts = new InMemoryArtifactRepository();
    const run = await verifyingRun(runs);
    const incomplete = { ...submission, criterionCoverage: [] };
    const result = await verifyAndCommit({ run, packet: packet(run), submission: incomplete, workspace, commands: [command] }, {
      verifier: new FakeVerifier([passed]), git: new FakeGit(["src/a.ts"]), artifacts, runs,
    });
    assert.equal(result.run.state, "blocked");
    assert.match(result.outcome?.payload.reason ?? "", /criterion coverage is incomplete.*Preserves state/);
    assert.equal(result.buildResult, undefined);
    assert.deepEqual(result.outcome?.payload.failureEvidence?.checks, []);
  });

  it("blocks an inaccurate builder change report before verification", async () => {
    const runs = new InMemoryRunRepository();
    const artifacts = new InMemoryArtifactRepository();
    const run = await verifyingRun(runs);
    const inaccurate = { ...submission, changedPaths: ["src/other.ts"] };
    const result = await verifyAndCommit({ run, packet: packet(run), submission: inaccurate, workspace, commands: [command] }, {
      verifier: new FakeVerifier([passed]), git: new FakeGit(["src/a.ts"]), artifacts, runs,
    });
    assert.equal(result.run.state, "blocked");
    assert.match(result.outcome?.payload.reason ?? "", /change report does not match.*omitted src\/a\.ts.*reported unchanged src\/other\.ts/);
    assert.equal(result.buildResult, undefined);
  });

  it("compares canonical packet paths with Git paths", async () => {
    const runs = new InMemoryRunRepository();
    const artifacts = new InMemoryArtifactRepository();
    const run = await verifyingRun(runs);
    const frozen = packet(run);
    const result = await verifyAndCommit({
      run,
      packet: { ...frozen, payload: { ...frozen.payload, expectedPaths: ["src\\a.ts"] } },
      submission, workspace, commands: [command],
    }, {
      verifier: new FakeVerifier([passed]), git: new FakeGit(["src/a.ts"]), artifacts, runs,
    });
    assert.equal(result.run.state, "publishing");
    assert.deepEqual(result.buildResult?.payload.changedPaths, ["src/a.ts"]);
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
