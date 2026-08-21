import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { createArtifact, type DurableArtifact } from "../../core/artifacts/schema.js";
import type { GitWorkspace, GitWorkspaceManager } from "../../core/ports/git-workspace.js";
import { InMemoryArtifactRepository, InMemoryRunRepository } from "../../core/ports/repositories.js";
import type { CheckResult, VerificationRunner } from "../../core/ports/verification.js";
import { createRun, transition, type RunState, type TransitionEvent } from "../../core/state/machine.js";
import type { BuilderSubmission } from "./build.js";
import { recoverVerificationCheckpoint, uncoveredVerificationCommands, verifyAndCommit, verifyCommittedRepair } from "./verify.js";
import { deriveEvidenceContract } from "./evidence-contract.js";
const workspace: GitWorkspace = { path: "/tmp/worktree", branch: "forgedock/issue-1", baseRef: "main", baseSha: "0".repeat(40) };
const submission: BuilderSubmission = {
  summary: "Implemented guard", changedPaths: ["src/a.ts"],
  criterionCoverage: [{ criterion: "Preserves state", implementation: "Guard preserves previous state" }],
  decisions: [], residualRisks: [],
};

class FakeGit implements GitWorkspaceManager {
  committed = false;
  commitCalls = 0;
  dependenciesPrepared = false;
  pushed = false;
  lastRevisionBaseSha: string | undefined;
  constructor(
    readonly paths: string[],
    readonly revisionPaths: string[] = [],
    readonly committedRevisionPaths = [...new Set([...revisionPaths, ...paths])],
  ) {}
  async create(): Promise<GitWorkspace> { return workspace; }
  async changedPaths(): Promise<string[]> { return this.committed ? [] : this.paths; }
  async revisionChangedPaths(currentWorkspace: GitWorkspace): Promise<string[]> {
    this.lastRevisionBaseSha = currentWorkspace.baseSha;
    return this.committed ? this.committedRevisionPaths : this.revisionPaths;
  }
  async syncToRemoteHead(): Promise<void> {}
  async isAncestor(): Promise<boolean> { return true; }
  async prepareWorkspaceDependencies(): Promise<void> { this.dependenciesPrepared = true; }
  async committedContentMatches(): Promise<boolean> { return true; }
  async commit(): Promise<string> { this.commitCalls += 1; this.committed = true; return "a".repeat(40); }
  async commitParents(): Promise<string[]> { return [workspace.baseSha!]; }
  async assertPristineAtHead(): Promise<void> {}
  async push(): Promise<void> { this.pushed = true; }
  async head(): Promise<string> { return this.committed ? "a".repeat(40) : workspace.baseSha!; }
  async remove(): Promise<void> {}
}
class FakeVerifier implements VerificationRunner {
  constructor(readonly results: CheckResult[]) {}
  async run(): Promise<CheckResult[]> { return this.results; }
}

async function verifyingRun(runs: InMemoryRunRepository, runId = `run_verify_${crypto.randomUUID()}`): Promise<RunState> {
  let run = createRun({
    workflow: "work-on",
    subject: { repo: "a/b", issue: 1 },
    runId,
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

const command = { id: "test", command: "npm", args: ["test"], cwd: "/tmp/worktree", timeoutMs: 1000, required: true, policyVersion: "forgedock.verification/v2", planId: "plan-baseline" } as const;
const passed: CheckResult = { command: "npm test", status: "passed", exitCode: 0, durationMs: 10, outputDigest: "b".repeat(64) };

function linkDirectory(target: string, path: string): void {
  symlinkSync(target, path, process.platform === "win32" ? "junction" : "dir");
}

describe("verification and commit barrier", () => {
  it("rejects a CI repair revision outside the frozen packet", async () => {
    const run = await verifyingRun(new InMemoryRunRepository());
    const git = new FakeGit([], ["src/a.ts", "src/out-of-packet.ts"], ["src/a.ts", "src/out-of-packet.ts"]);
    git.committed = true;
    await assert.rejects(
      verifyCommittedRepair({ packet: packet(run), workspace, expectedHeadSha: "a".repeat(40), parentHeadSha: workspace.baseSha!, commands: [command], verifier: new FakeVerifier([passed]) }, git),
      /outside the Build Packet/,
    );
  });

  it("rejects a stale or unverified CI repair head", async () => {
    const run = await verifyingRun(new InMemoryRunRepository());
    const git = new FakeGit(["src/a.ts"], ["src/a.ts"]);
    git.committed = true;
    await assert.rejects(
      verifyCommittedRepair({ packet: packet(run), workspace, expectedHeadSha: "a".repeat(40), parentHeadSha: "a".repeat(40), commands: [command], verifier: new FakeVerifier([passed]) }, git),
      /no committed child revision/,
    );
  });

  it("retains the delivery base when diffing a repaired head", async () => {
    const run = await verifyingRun(new InMemoryRunRepository());
    const directory = mkdtempSync(join(tmpdir(), "forgedock-repair-base-"));
    mkdirSync(join(directory, "src"));
    writeFileSync(join(directory, "src", "a.ts"), "export const repaired = true;\n");
    const deliveryWorkspace: GitWorkspace = { ...workspace, path: directory, baseSha: workspace.baseSha! };
    const git = new FakeGit([], ["src/a.ts"], ["src/a.ts"]);
    git.committed = true;
    try {
      await verifyCommittedRepair({
        packet: packet(run), workspace: deliveryWorkspace, expectedHeadSha: "a".repeat(40),
        parentHeadSha: workspace.baseSha!, commands: [command], verifier: new FakeVerifier([passed]),
      }, git);
      assert.equal(git.lastRevisionBaseSha, workspace.baseSha);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

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

  it("reconstructs BuildResult from the exact retained commit after rerunning frozen verification", async () => {
    const directory = mkdtempSync(join(tmpdir(), "forgedock-verify-recovery-"));
    mkdirSync(join(directory, "src"), { recursive: true });
    writeFileSync(join(directory, "src", "a.ts"), "export const recovered = true;\n");
    try {
      const firstRuns = new InMemoryRunRepository();
      const run = await verifyingRun(firstRuns);
      const retainedArtifacts = new InMemoryArtifactRepository();
      const crashAfterCommit = {
        append: async (artifact: DurableArtifact) => {
          if (artifact.kind === "BuildResult") throw new Error("simulated crash before BuildResult");
          await retainedArtifacts.append(artifact);
        },
        list: retainedArtifacts.list.bind(retainedArtifacts),
      };
      const git = new FakeGit(["src/a.ts"]);
      await assert.rejects(verifyAndCommit({
        run,
        packet: packet(run),
        submission,
        workspace: { ...workspace, path: directory },
        commands: [command],
      }, {
        verifier: new FakeVerifier([passed]),
        git,
        artifacts: crashAfterCommit,
        runs: firstRuns,
      }), /simulated crash before BuildResult/);
      assert.equal(git.commitCalls, 1);
      const checkpoint = retainedArtifacts.artifacts.find(
        (artifact): artifact is DurableArtifact<"VerificationCheckpoint"> => artifact.kind === "VerificationCheckpoint",
      );
      assert.ok(checkpoint);

      const recoveredRuns = new InMemoryRunRepository();
      const recoveredRun = await verifyingRun(recoveredRuns, run.runId);
      const recovered = await recoverVerificationCheckpoint({
        run: recoveredRun,
        checkpoint,
        workspace: { ...workspace, path: directory },
        commands: [{ ...command, cwd: directory }],
        verifier: new FakeVerifier([{ ...passed, command: "npm test", commandId: "test", policyVersion: "forgedock.verification/v2", planId: "plan-baseline" }]),
      }, { git, artifacts: retainedArtifacts, runs: recoveredRuns });

      assert.equal(recovered.run.state, "publishing");
      assert.equal(recovered.buildResult?.payload.headSha, "a".repeat(40));
      assert.equal(git.commitCalls, 1, "exact retained commit must not be committed again");
      assert.equal(retainedArtifacts.artifacts.filter((artifact) => artifact.kind === "BuildResult").length, 1);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("recovers a frozen target projection and rejects a tampered projection digest", async () => {
    const directory = mkdtempSync(join(tmpdir(), "forgedock-verify-target-projection-"));
    mkdirSync(join(directory, "src"), { recursive: true });
    writeFileSync(join(directory, "src", "a.ts"), "export const recovered = true;\n");
    try {
      const firstRuns = new InMemoryRunRepository();
      const run = await verifyingRun(firstRuns);
      const basePacket = packet(run);
      const targetedPacket = createArtifact({
        ...basePacket,
        payload: {
          ...basePacket.payload,
          verificationCommandTargets: [{ id: "test", sourceTargets: ["src/a.test.ts"], targets: ["dist/a.test.js"] }],
        },
      });
      const targetedCommand = { ...command, cwd: directory, targets: ["dist/a.test.js"] };
      const retainedArtifacts = new InMemoryArtifactRepository();
      const crashAfterCommit = {
        append: async (artifact: DurableArtifact) => {
          if (artifact.kind === "BuildResult") throw new Error("simulated target-projection crash");
          await retainedArtifacts.append(artifact);
        },
        list: retainedArtifacts.list.bind(retainedArtifacts),
      };
      const git = new FakeGit(["src/a.ts"]);
      await assert.rejects(verifyAndCommit({
        run, packet: targetedPacket, submission, workspace: { ...workspace, path: directory }, commands: [targetedCommand],
      }, { verifier: new FakeVerifier([passed]), git, artifacts: crashAfterCommit, runs: firstRuns }), /simulated target-projection crash/);
      const checkpoint = retainedArtifacts.artifacts.find(
        (artifact): artifact is DurableArtifact<"VerificationCheckpoint"> => artifact.kind === "VerificationCheckpoint",
      );
      assert.ok(checkpoint);
      assert.equal((checkpoint.payload.verificationCommandTargets?.[0] as { sourceTargets?: unknown } | undefined)?.sourceTargets, undefined, "checkpoint uses one canonical compiled-target projection");
      const recoveredRuns = new InMemoryRunRepository();
      const recoveredRun = await verifyingRun(recoveredRuns, run.runId);
      const recovered = await recoverVerificationCheckpoint({
        run: recoveredRun, checkpoint, workspace: { ...workspace, path: directory },
        commands: [targetedCommand], verifier: new FakeVerifier([{ ...passed, commandId: "test", planId: "plan-baseline", policyVersion: "forgedock.verification/v2", commandTargets: ["dist/a.test.js"] }]),
      }, { git, artifacts: retainedArtifacts, runs: recoveredRuns });
      assert.equal(recovered.run.state, "publishing");
      const tampered = { ...checkpoint, payload: { ...checkpoint.payload, verificationCommandPlanDigest: "0".repeat(64) } };
      await assert.rejects(recoverVerificationCheckpoint({
        run: recoveredRun, checkpoint: tampered, workspace: { ...workspace, path: directory },
        commands: [targetedCommand], verifier: new FakeVerifier([]),
      }, { git, artifacts: retainedArtifacts, runs: new InMemoryRunRepository() }), /command-target digest is invalid/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
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

  it("requires exact criterion text even when stable packet IDs are present", async () => {
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
    assert.equal(result.run.state, "blocked");
    assert.match(result.outcome?.payload.reason ?? "", /criterion-mismatch|criterion coverage is incomplete/);
    assert.equal(result.buildResult, undefined);
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
      command: "npm test", commandId: "test", policyVersion: "forgedock.verification/v2", planId: "plan-baseline",
      outputDigest: "c".repeat(64), summary: "2 tests failed", failureSignatures: ["not ok - existing Windows test"],
      status: "failed", exitCode: 1, durationMs: 12,    };
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

  it("matches reordered baselines by command identity and persists policy targets", async () => {
    const runs = new InMemoryRunRepository();
    const artifacts = new InMemoryArtifactRepository();
    const run = await verifyingRun(runs);
    const commands = [{
      id: "diff-check", command: "git", args: ["diff", "--check"], cwd: workspace.path,
      timeoutMs: 1_000, required: true, policyVersion: "forgedock.verification/v2", planId: "plan-1",
    }, {
      id: "test", command: process.execPath, args: ["--test", "dist/a.test.js"], cwd: workspace.path,
      timeoutMs: 1_000, required: true, policyVersion: "forgedock.verification/v2", targets: ["dist/a.test.js"], planId: "plan-1",
    }];
    const existingTestFailure: CheckResult = {
      command: `${process.execPath} --test dist/a.test.js`, commandId: "test",
      policyVersion: "forgedock.verification/v2", commandTargets: ["dist/a.test.js"], planId: "plan-1",
      status: "failed", exitCode: 1, durationMs: 2, failureSignatures: ["not ok - retained failure"],
    };
    const diffPass: CheckResult = {
      command: "git diff --check", commandId: "diff-check", policyVersion: "forgedock.verification/v2", planId: "plan-1",
      status: "passed", exitCode: 0, durationMs: 1,
    };
    const typedPacket = packet(run);
    typedPacket.payload.verificationRequirements = [{
      kind: "command", id: "test", criterionIds: ["criterion-1"], rationale: "Targeted regression",
    }];
    const result = await verifyAndCommit({
      run,
      packet: typedPacket,
      submission,
      workspace,
      commands,
      baselineChecks: [diffPass, existingTestFailure],
    }, {
      verifier: new FakeVerifier([{ ...existingTestFailure, durationMs: 3 }, diffPass]),
      git: new FakeGit(["src/a.ts"]), artifacts, runs,
    });
    assert.equal(result.run.state, "blocked");
    const testCheck = result.outcome?.payload.failureEvidence?.checks.find((check) => check.commandId === "test");
    assert.equal(testCheck?.baselineStatus, "failed");
    assert.equal(testCheck?.regression, false);
    assert.equal(testCheck?.policyVersion, "forgedock.verification/v2");
    assert.deepEqual(testCheck?.commandTargets, ["dist/a.test.js"]);
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
      failureKind: "required-check",
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
    const windowsBuild = {
      id: "build",
      command: "C:\\Program Files\\nodejs\\node.exe",
      args: ["C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js", "run", "build"],
    };
    assert.deepEqual(uncoveredVerificationCommands([
      "`C:\\Program Files\\nodejs\\node.exe C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js run build`",
    ], [windowsBuild]), []);
    assert.deepEqual(uncoveredVerificationCommands([
      "`C:\\Program Files\\nodejs\\node.exe C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js run build -- --watch`",
    ], [windowsBuild]), [
      "C:\\Program Files\\nodejs\\node.exe C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js run build -- --watch",
    ]);
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

  it("does not let a green generic check fabricate semantic criterion evidence", async () => {
    const runs = new InMemoryRunRepository();
    const artifacts = new InMemoryArtifactRepository();
    const run = await verifyingRun(runs);
    const typedPacket = packet(run);
    typedPacket.payload.verificationPolicyVersion = "forgedock.verification/v2";
    typedPacket.payload.verificationRequirements = [{
      kind: "command", id: "build-check", criterionIds: ["criterion-1"], rationale: "Generic build health",
    }];
    const genericCommand = { id: "build-check", command: "npm", args: ["run", "build"], cwd: workspace.path, timeoutMs: 1_000, required: true } as const;
    const anchored: BuilderSubmission = {
      ...submission,
      criterionCoverage: [{
        criterionId: "criterion-1", criterion: "Preserves state", implementation: "Guard exists",
        anchors: { paths: ["src/a.ts"], symbols: ["guard"], testIds: ["guard-regression"], verificationCommandIds: ["build-check"] },
      }],
    };
    const result = await verifyAndCommit({ run, packet: typedPacket, submission: anchored, workspace, commands: [genericCommand] }, {
      verifier: new FakeVerifier([{ command: "npm run build", commandId: "build-check", status: "passed", exitCode: 0, durationMs: 1 }]),
      git: new FakeGit(["src/a.ts"]), artifacts, runs,
    });
    assert.equal(result.run.state, "blocked");
    assert.match(result.outcome?.payload.reason ?? "", /generic checks.*targeted test/i);
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

  it("accepts unchanged evidence-only paths but blocks their delivery modification", async () => {
    const requirements = [{ kind: "command" as const, id: "semantic", criterionIds: ["criterion-1"], rationale: "targeted proof" }];
    const evidencePaths = [{ path: "package.json", criterionIds: ["criterion-1"], role: "artifact" as const }];
    const contract = deriveEvidenceContract({
      acceptanceCriteria: ["Preserves state"], expectedPaths: ["src/a.ts"], evidencePaths,
      verificationRequirements: requirements,
      commands: [{ id: "semantic", evidenceCapability: "targeted-test" as const, targets: ["dist/a.test.js"] }],
    }).contract;
    const runs = new InMemoryRunRepository();
    const artifacts = new InMemoryArtifactRepository();
    const run = await verifyingRun(runs);
    const frozen = { ...packet(run), payload: { ...packet(run).payload, verificationRequirements: requirements, evidencePaths, evidenceContract: contract } };
    const covered: BuilderSubmission = {
      ...submission,
      criterionCoverage: [{ criterionId: "criterion-1", criterion: "Preserves state", implementation: "Guard keeps prior state", anchors: { paths: ["package.json"], symbols: ["guard"], testIds: ["guard-test"], verificationCommandIds: ["semantic"] } }],
    };
    let verifierRuns = 0;
    const semanticCommand = { ...command, id: "semantic", evidenceCapability: "targeted-test" as const, targets: ["dist/a.test.js"] };
    const accepted = await verifyAndCommit({ run, packet: frozen, submission: covered, workspace, commands: [semanticCommand] }, {
      verifier: { async run() { verifierRuns += 1; return [{ ...passed, commandId: "semantic" }]; } },
      git: new FakeGit(["src/a.ts"]), artifacts, runs,
    });
    assert.equal(accepted.run.state, "publishing");
    assert.equal(verifierRuns, 1);
    const blockedRuns = new InMemoryRunRepository();
    const blockedArtifacts = new InMemoryArtifactRepository();
    const blockedRun = await verifyingRun(blockedRuns);
    let blockedVerifierRuns = 0;
    const blocked = await verifyAndCommit({ run: blockedRun, packet: frozen, submission: { ...covered, changedPaths: ["src/a.ts", "package.json"] }, workspace, commands: [semanticCommand] }, {
      verifier: { async run() { blockedVerifierRuns += 1; return [{ ...passed, commandId: "semantic" }]; } },
      git: new FakeGit(["src/a.ts", "package.json"]), artifacts: blockedArtifacts, runs: blockedRuns,
    });
    assert.equal(blocked.run.state, "blocked");
    assert.equal(blockedVerifierRuns, 0);
    assert.equal(blocked.buildResult, undefined);
    assert.equal(blockedArtifacts.artifacts.some((artifact) => artifact.kind === "BuildResult"), false);
  });

  it("collects contract diagnostics together and blocks before verifier execution", async () => {
    const requirements = [
      { kind: "command" as const, id: "missing-command", criterionIds: ["criterion-1"], rationale: "missing" },
      { kind: "command" as const, id: "generic", criterionIds: ["criterion-2"], rationale: "generic" },
    ];
    const invariantMatrices = [{ id: "matrix", criterionId: "criterion-1", capability: "terminal-metadata" as const, dimensions: [{ name: "state", values: ["ok", "bad"] }], testId: "root-test" }];
    const contract = deriveEvidenceContract({
      acceptanceCriteria: ["one", "two"], expectedPaths: ["src/a.ts"], verificationRequirements: requirements,
      invariantMatrices, commands: [{ id: "generic", evidenceCapability: "generic" as const }],
    }).contract;
    const runs = new InMemoryRunRepository();
    const artifacts = new InMemoryArtifactRepository();
    const run = await verifyingRun(runs);
    const frozen = createArtifact({ kind: "BuildPacket", runId: run.runId, subject: run.subject, producer: { role: "packet-author" }, payload: {
      scope: ["x"], acceptanceCriteria: ["one", "two"], context: [], implementationPlan: ["x"], expectedPaths: ["src/a.ts"], verificationPlan: ["npm test"], risks: [], outOfScope: [], verificationRequirements: requirements, invariantMatrices, evidenceContract: contract,
    } });
    let verifierRuns = 0;
    const result = await verifyAndCommit({
      run, packet: frozen, submission: { summary: "x", changedPaths: ["src/a.ts"], criterionCoverage: [{ criterionId: "criterion-1", criterion: "one", implementation: "x", anchors: { paths: ["../escape"], symbols: ["x"], testIds: ["wrong-root"], verificationCommandIds: ["unknown"] } }], decisions: [], residualRisks: [] }, workspace,
      commands: [{ ...command, id: "generic" }],
    }, { verifier: { async run() { verifierRuns += 1; return [passed]; } }, git: new FakeGit(["src/a.ts"]), artifacts, runs });
    assert.equal(result.run.state, "blocked");
    assert.equal(verifierRuns, 0);
    assert.deepEqual(result.checks, []);
    assert.equal(result.buildResult, undefined);
    assert.equal(result.outcome?.payload.failureEvidence?.failureKind, "packet-contract");
    const diagnostics = result.outcome?.payload.failureEvidence?.diagnostics ?? [];
    assert.ok(diagnostics.length >= 5);
    assert.ok(new Set(diagnostics.map(({ code }) => code)).size >= 4);
  });

  it("accepts invariant row test IDs and adds cases only after semantic pass", async () => {
    const requirements = [{ kind: "command" as const, id: "invariant", criterionIds: ["criterion-1"], rationale: "matrix" }];
    const invariantMatrices = [{ id: "matrix", criterionId: "criterion-1", capability: "terminal-metadata" as const, dimensions: [{ name: "state", values: ["ok", "bad"] }], testId: "root-test" }];
    const contract = deriveEvidenceContract({ acceptanceCriteria: ["Preserves state"], expectedPaths: ["src/a.ts"], verificationRequirements: requirements, invariantMatrices, commands: [{ id: "invariant", evidenceCapability: "invariant" as const }] }).contract;
    const runs = new InMemoryRunRepository();
    const artifacts = new InMemoryArtifactRepository();
    const run = await verifyingRun(runs);
    const frozen = { ...packet(run), payload: { ...packet(run).payload, verificationRequirements: requirements, invariantMatrices, evidenceContract: contract } };
    const invariantCommand = { ...command, id: "invariant", evidenceCapability: "invariant" as const };
    const result = await verifyAndCommit({
      run, packet: frozen, submission: { ...submission, criterionCoverage: [{ criterionId: "criterion-1", criterion: "Preserves state", implementation: "x", anchors: { paths: ["src/a.ts"], symbols: ["guard"], testIds: ["root-test"], verificationCommandIds: ["invariant"] } }] }, workspace,
      commands: [invariantCommand],
    }, { verifier: new FakeVerifier([{ ...passed, commandId: "invariant" }]), git: new FakeGit(["src/a.ts"]), artifacts, runs });
    assert.equal(result.run.state, "publishing");
    const testIds = result.buildResult?.payload.acceptanceEvidence[0]?.anchors?.testIds ?? [];
    assert.ok(testIds.includes("root-test"));
    assert.ok(testIds.includes("root-test:case-001"));
    assert.ok(testIds.includes("root-test:case-002"));
  });
  it("classifies valid-contract builder anchor defects as repairable semantic evidence", async () => {
    const requirements = [{ kind: "command" as const, id: "semantic", criterionIds: ["criterion-1"], rationale: "targeted proof" }];
    const semanticCommand = { ...command, id: "semantic", evidenceCapability: "targeted-test" as const, targets: ["dist/a.test.js"] };
    const contract = deriveEvidenceContract({ acceptanceCriteria: ["Preserves state"], expectedPaths: ["src/a.ts"], verificationRequirements: requirements, commands: [{ id: "semantic", evidenceCapability: "targeted-test" as const, targets: ["dist/a.test.js"] }] }).contract;
    const runs = new InMemoryRunRepository();
    const artifacts = new InMemoryArtifactRepository();
    const run = await verifyingRun(runs);
    const frozen = { ...packet(run), payload: { ...packet(run).payload, verificationRequirements: requirements, evidenceContract: contract } };
    let verifierRuns = 0;
    const result = await verifyAndCommit({ run, packet: frozen, submission: { ...submission, criterionCoverage: [{ criterionId: "criterion-1", criterion: "Preserves state", implementation: "x" }] }, workspace, commands: [semanticCommand] }, {
      verifier: { async run() { verifierRuns += 1; return [passed]; } }, git: new FakeGit(["src/a.ts"]), artifacts, runs,
    });
    assert.equal(result.run.state, "blocked");
    assert.equal(verifierRuns, 0);
    assert.equal(result.outcome?.payload.failureEvidence?.failureKind, "builder-semantic-evidence");
    assert.deepEqual(result.checks, []);
  });

  it("fails contract criteria when an optional generic command fails despite semantic success", async () => {
    const requirements = [
      { kind: "command" as const, id: "lint", criterionIds: ["criterion-1"], rationale: "style gate" },
      { kind: "command" as const, id: "semantic", criterionIds: ["criterion-1"], rationale: "targeted proof" },
    ];
    const contract = deriveEvidenceContract({
      acceptanceCriteria: ["Preserves state"], expectedPaths: ["src/a.ts"], verificationRequirements: requirements,
      commands: [
        { id: "lint", evidenceCapability: "generic" as const },
        { id: "semantic", evidenceCapability: "targeted-test" as const, targets: ["dist/a.test.js"] },
      ],
    }).contract;
    const runs = new InMemoryRunRepository();
    const artifacts = new InMemoryArtifactRepository();
    const run = await verifyingRun(runs);
    const frozen = { ...packet(run), payload: { ...packet(run).payload, verificationRequirements: requirements, evidenceContract: contract } };
    const result = await verifyAndCommit({
      run, packet: frozen, workspace,
      submission: { ...submission, criterionCoverage: [{ criterionId: "criterion-1", criterion: "Preserves state", implementation: "x", anchors: { paths: ["src/a.ts"], symbols: ["guard"], testIds: ["guard-test"], verificationCommandIds: ["lint", "semantic"] } }] },
      commands: [
        { ...command, id: "lint", required: false, evidenceCapability: "generic" as const },
        { ...command, id: "semantic", required: true, evidenceCapability: "targeted-test" as const, targets: ["dist/a.test.js"] },
      ],
    }, {
      verifier: { async run() { return [
        { ...passed, command: "lint", commandId: "lint", status: "failed" as const },
        { ...passed, command: "semantic", commandId: "semantic", status: "passed" as const },
      ]; } },
      git: new FakeGit(["src/a.ts"]), artifacts, runs,
    });
    assert.equal(result.run.state, "blocked");
    assert.equal(result.buildResult, undefined);
    assert.match(result.outcome?.payload.reason ?? "", /criterion-1.*lint/);
    assert.equal(result.outcome?.payload.failureEvidence?.failureKind, "builder-semantic-evidence");
  });

  it("rejects ambiguous duplicate acceptance text in legacy coverage", async () => {
    const runs = new InMemoryRunRepository();
    const artifacts = new InMemoryArtifactRepository();
    const run = await verifyingRun(runs);
    const frozen = { ...packet(run), payload: { ...packet(run).payload, acceptanceCriteria: ["same text", "same text"] } };
    const result = await verifyAndCommit({
      run, packet: frozen, workspace, commands: [command],
      submission: { ...submission, criterionCoverage: [
        { criterion: "same text", implementation: "first" },
        { criterion: "same text", implementation: "second" },
      ] },
    }, { verifier: new FakeVerifier([passed]), git: new FakeGit(["src/a.ts"]), artifacts, runs });
    assert.equal(result.run.state, "blocked");
    assert.equal(result.buildResult, undefined);
    assert.match(result.outcome?.payload.reason ?? "", /criterion-1|criterion-2|same text/);
  });


  it("permits gate-only criteria to remain prose-only", async () => {
    const requirements = [{ kind: "controller-gate" as const, id: "staging-review", criterionIds: ["criterion-1"], rationale: "controller lifecycle" }];
    const controllerGates = [{ id: "staging-review" as const, description: "Review staging" }];
    const contract = deriveEvidenceContract({ acceptanceCriteria: ["Staging review"], expectedPaths: ["src/a.ts"], verificationRequirements: requirements, controllerGates, commands: [{ id: "generic", evidenceCapability: "generic" as const }] }).contract;
    const runs = new InMemoryRunRepository();
    const artifacts = new InMemoryArtifactRepository();
    const run = await verifyingRun(runs);
    const frozen = { ...packet(run), payload: { ...packet(run).payload, acceptanceCriteria: ["Staging review"], verificationRequirements: requirements, controllerGates, evidenceContract: contract } };
    const result = await verifyAndCommit({
      run, packet: frozen, submission: { summary: "reviewed", changedPaths: ["src/a.ts"], criterionCoverage: [{ criterionId: "criterion-1", criterion: "Staging review", implementation: "Controller gate recorded" }], decisions: [], residualRisks: [] }, workspace,
      commands: [{ ...command, id: "generic", evidenceCapability: "generic" as const }],
    }, { verifier: new FakeVerifier([{ ...passed, commandId: "generic" }]), git: new FakeGit(["src/a.ts"]), artifacts, runs });
    assert.equal(result.run.state, "publishing");
    assert.equal(result.buildResult?.payload.acceptanceEvidence[0]?.anchors, undefined);
  });

});
