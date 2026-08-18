// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createArtifact, type DurableArtifact } from "../../core/artifacts/schema.js";
import type { ForgeHost, PullRequestSnapshot } from "../../core/ports/forge-host.js";
import type { GitWorkspace, GitWorkspaceManager } from "../../core/ports/git-workspace.js";
import { InMemoryArtifactRepository, InMemoryRunRepository } from "../../core/ports/repositories.js";
import type { CheckResult, VerificationRunner } from "../../core/ports/verification.js";
import { createRun, transition, type RunState, type TransitionEvent } from "../../core/state/machine.js";
import { FakeAgentRuntime } from "../../runtime/fake-runtime.js";
import { recoverConflictingRevision } from "./conflict-recovery.js";
import { publishRemediationRevision } from "./publish-revision.js";
import { resumeConflictRecoveryWorkOn } from "./work-on.js";

const oldSha = "a".repeat(40);
const targetSha = "b".repeat(40);
const newSha = "c".repeat(40);
const workspace: GitWorkspace = {
  path: "/tmp/forgedock-conflict-recovery",
  branch: "forgedock/issue-1",
  baseRef: "origin/staging",
  baseSha: oldSha,
};
const pullRequest: PullRequestSnapshot = {
  repo: "a/b",
  number: 91,
  title: "Fix",
  body: "",
  url: "https://github.test/a/b/pull/91",
  state: "OPEN",
  headSha: oldSha,
  headBranch: workspace.branch,
  baseBranch: "staging",
};
const command = {
  id: "test",
  command: "npm",
  args: ["test"],
  cwd: workspace.path,
  timeoutMs: 1_000,
  required: true,
} as const;
const passed: CheckResult = { command: "npm test", status: "passed", durationMs: 1 };

class FakeGit implements GitWorkspaceManager {
  integrateCalls = 0;
  commitCalls = 0;
  pushCalls = 0;
  onPush?: () => void;
  alreadyCommitted = false;
  throwAfterCommit = false;
  constructor(readonly conflictPaths: string[], readonly target: string) {}
  async create(): Promise<GitWorkspace> { return workspace; }
  async changedPaths(): Promise<string[]> { return this.commitCalls ? [] : this.conflictPaths; }
  async revisionChangedPaths(): Promise<string[]> { return ["src/allowed.ts"]; }
  async syncToRemoteHead(): Promise<void> {}
  async integrateRemoteBase(received: GitWorkspace, input: { expectedHeadSha: string; expectedBaseSha: string }): Promise<{ workspace: GitWorkspace; conflictPaths: string[]; mergeCommitExists: boolean }> {
    this.integrateCalls += 1;
    assert.deepEqual(received, workspace);
    assert.deepEqual(input, { expectedHeadSha: oldSha, expectedBaseSha: this.target });
    return {
      workspace: received,
      conflictPaths: this.alreadyCommitted ? [] : [...this.conflictPaths],
      mergeCommitExists: this.alreadyCommitted,
    };
  }
  async isAncestor(): Promise<boolean> { return true; }
  async prepareWorkspaceDependencies(): Promise<void> {}
  async committedContentMatches(): Promise<boolean> { return true; }
  async commit(received: GitWorkspace): Promise<string> {
    this.commitCalls += 1;
    this.alreadyCommitted = true;
    received.baseSha = targetSha;
    if (this.throwAfterCommit) {
      this.throwAfterCommit = false;
      throw new Error("simulated crash after local merge commit");
    }
    return newSha;
  }
  async push(): Promise<void> { this.pushCalls += 1; this.onPush?.(); }
  async head(): Promise<string> { return this.commitCalls ? newSha : oldSha; }
  async remove(): Promise<void> {}
}

function hostFor(target: string): ForgeHost {
  const host = {
    getPullRequest: async () => pullRequest,
    getBranchHead: async () => target,
  };
  return host as unknown as ForgeHost;
}

async function blockedRun(runs: InMemoryRunRepository): Promise<RunState> {
  let run = createRun({
    workflow: "work-on",
    subject: { repo: "a/b", issue: 1 },
    runId: "run_conflict_test",
    target: { lane: "fast", targetBranch: "staging" },
  });
  await runs.create(run);
  for (const event of [
    "START_INVESTIGATION", "INVESTIGATION_CONFIRMED", "BUILD_PACKET_READY", "BUILD_COMPLETED",
    "VERIFICATION_PASSED", "PR_PUBLISHED", "REVIEW_APPROVED", "BLOCK",
  ] as TransitionEvent[]) {
    const next = transition(run, event, event === "BLOCK" ? { reason: "confirmed conflict" } : {});
    await runs.commit(run.version, next.state, next.record);
    run = next.state;
  }
  return run;
}

function fixture(run: RunState, expectedPaths: string[] = ["src/allowed.ts"]): {
  intent: DurableArtifact<"Intent">;
  investigation: DurableArtifact<"Investigation">;
  packet: DurableArtifact<"BuildPacket">;
  buildResult: DurableArtifact<"BuildResult">;
  verdict: DurableArtifact<"ReviewVerdict">;
  mergeGate: NonNullable<DurableArtifact<"Outcome">["payload"]["mergeGate"]>;
} {
  const intent = createArtifact({
    kind: "Intent", runId: run.runId, subject: run.subject, producer: { role: "controller" },
    payload: { title: "Fix", problem: "Broken", constraints: [], acceptanceHints: [], dependencies: [] },
  });
  const investigation = createArtifact({
    kind: "Investigation", runId: run.runId, subject: run.subject, producer: { role: "investigator" },
    payload: {
      outcome: "confirmed", confidence: "high", summary: "confirmed",
      evidence: [{ claim: "broken", source: "src/allowed.ts", detail: "missing behavior" }],
      rootCause: "missing behavior", affectedSurfaces: ["src/allowed.ts"], risks: [], recommendation: "fix it",
    },
  });
  const packet = createArtifact({
    kind: "BuildPacket", runId: run.runId, subject: run.subject, producer: { role: "packet-author" },
    payload: {
      scope: ["fix"], acceptanceCriteria: ["works"], context: [], implementationPlan: ["edit"],
      expectedPaths, verificationPlan: ["npm test"], risks: [], outOfScope: [],
    },
  });
  const buildResult = createArtifact({
    kind: "BuildResult", runId: run.runId, subject: run.subject, producer: { role: "controller" },
    payload: {
      branch: workspace.branch, targetBranch: "staging", headSha: oldSha, baseSha: oldSha,
      changedPaths: expectedPaths, summary: "built",
      acceptanceEvidence: [{ criterion: "works", status: "passed", evidence: "built" }],
      checks: [passed], decisions: [], residualRisks: [],
    },
  });
  const verdict = createArtifact({
    kind: "ReviewVerdict", runId: run.runId, subject: { ...run.subject, pr: pullRequest.number }, producer: { role: "reviewer" },
    payload: { headSha: oldSha, disposition: "approve", reviewerRoles: ["correctness"], findings: [], checks: [] },
  });
  const mergeGate = {
    pullRequest: pullRequest.number,
    headSha: oldSha,
    baseBranch: "staging",
    mergeable: false,
    mergeability: "conflicting" as const,
    observedAt: "2026-01-01T00:00:00.000Z",
    requiredChecks: [],
  };
  return { intent, investigation, packet, buildResult, verdict, mergeGate };
}

async function recoverFixture(options: { target?: string; conflicts: string[]; expectedPaths?: string[] }) {
  const runs = new InMemoryRunRepository();
  const artifacts = new InMemoryArtifactRepository();
  const run = await blockedRun(runs);
  const values = fixture(run, options.expectedPaths ?? ["src/allowed.ts"]);
  const git = new FakeGit(options.conflicts, options.target ?? targetSha);
  const runtime = new FakeAgentRuntime([{
    summary: "resolved",
    changedPaths: options.conflicts,
    criterionCoverage: [{ criterion: "works", implementation: "resolved" }],
    decisions: [],
    residualRisks: [],
  }]);
  const verifier: VerificationRunner = { async run() { return [passed]; } };
  const result = await recoverConflictingRevision({
    run,
    ...values,
    pullRequest,
    workspace: { ...workspace },
    commands: [command],
    mergeGate: values.mergeGate,
  }, {
    runtime,
    artifacts,
    runs,
    git,
    verifier,
    host: hostFor(options.target ?? targetSha),
  });
  return { result, git, runtime, artifacts };
}

describe("approved target-conflict recovery", () => {
  it("fails closed before integration when the target fence is stale", async () => {
    const runs = new InMemoryRunRepository();
    const artifacts = new InMemoryArtifactRepository();
    const run = await blockedRun(runs);
    const values = fixture(run);
    const git = new FakeGit([], oldSha);
    await assert.rejects(recoverConflictingRevision({
      run, ...values, pullRequest, workspace: { ...workspace }, commands: [command], mergeGate: values.mergeGate,
    }, {
      runtime: new FakeAgentRuntime(), artifacts, runs, git, verifier: { run: async () => [passed] }, host: hostFor(oldSha),
    }), /did not advance/);
    assert.equal(git.integrateCalls, 0);
    assert.equal(git.pushCalls, 0);
  });

  it("rejects a recovery gate that is bound to a different PR, base, or repository", async () => {
    for (const drift of [
      { pullRequest: pullRequest.number + 1 },
      { baseBranch: "main" },
      { repo: "other/repo" },
    ]) {
      const runs = new InMemoryRunRepository();
      const artifacts = new InMemoryArtifactRepository();
      const run = await blockedRun(runs);
      const values = fixture(run);
      const git = new FakeGit([], targetSha);
      await assert.rejects(recoverConflictingRevision({
        run,
        ...values,
        pullRequest,
        workspace: { ...workspace },
        commands: [command],
        mergeGate: { ...values.mergeGate, ...drift },
      }, {
        runtime: new FakeAgentRuntime(),
        artifacts,
        runs,
        git,
        verifier: { run: async () => [passed] },
        host: hostFor(targetSha),
      }), /matching merge-gate, PR, verdict, repository, and base branch identity/);
      assert.equal(git.integrateCalls, 0);
    }
  });

  it("blocks and never dispatches a resolver for an out-of-packet conflict", async () => {
    const { result, git, runtime, artifacts } = await recoverFixture({ conflicts: ["src/outside.ts"] });
    assert.equal(result.run.state, "blocked");
    assert.equal(git.integrateCalls, 1);
    assert.equal(git.commitCalls, 0);
    assert.equal(git.pushCalls, 0);
    assert.equal(runtime.tasks.length, 0);
    assert.equal(artifacts.artifacts.at(-1)?.kind, "Outcome");
    assert.match((artifacts.artifacts.at(-1) as DurableArtifact<"Outcome">).payload.reason, /outside the frozen Build Packet/);
  });

  it("resolves only packet-owned conflicts, commits a descendant, and publishes it normally", async () => {
    const runs = new InMemoryRunRepository();
    const artifacts = new InMemoryArtifactRepository();
    const run = await blockedRun(runs);
    const values = fixture(run);
    const git = new FakeGit(["src/allowed.ts"], targetSha);
    let current = { ...pullRequest };
    git.onPush = () => { current = { ...current, headSha: newSha }; };
    const runtime = new FakeAgentRuntime([{
      summary: "resolved",
      changedPaths: ["src/allowed.ts"],
      criterionCoverage: [{ criterion: "works", implementation: "resolved" }],
      decisions: [],
      residualRisks: [],
    }]);
    const result = await recoverConflictingRevision({
      run,
      ...values,
      pullRequest,
      workspace: { ...workspace },
      commands: [command],
      mergeGate: values.mergeGate,
    }, {
      runtime,
      artifacts,
      runs,
      git,
      verifier: { run: async () => [passed] },
      host: {
        getPullRequest: async () => ({ ...current }),
        getBranchHead: async () => targetSha,
      } as unknown as ForgeHost,
    });
    assert.equal(result.run.state, "reviewing");
    assert.equal(result.buildResult?.payload.headSha, newSha);
    assert.equal(result.buildResult?.payload.baseSha, targetSha);
    assert.deepEqual(result.buildResult?.payload.changedPaths, ["src/allowed.ts"]);
    assert.equal(git.commitCalls, 1);
    assert.equal(git.pushCalls, 1);
    assert.equal(runtime.tasks.length, 1);
    assert.equal(runtime.tasks[0]?.role, "remediator");
    assert.match(runtime.tasks[0]?.instructions ?? "", /Do not invoke GitHub, run git commands, commit, push, merge/);
  });

  it("re-enters after a local merge commit fault without creating a duplicate commit", async () => {
    const runs = new InMemoryRunRepository();
    const artifacts = new InMemoryArtifactRepository();
    const run = await blockedRun(runs);
    const values = fixture(run);
    const git = new FakeGit(["src/allowed.ts"], targetSha);
    git.throwAfterCommit = true;
    let current = { ...pullRequest };
    git.onPush = () => { current = { ...current, headSha: newSha }; };
    const runtime = new FakeAgentRuntime([{
      summary: "resolved before crash",
      changedPaths: ["src/allowed.ts"],
      criterionCoverage: [{ criterion: "works", implementation: "resolved" }],
      decisions: [],
      residualRisks: [],
    }]);
    const dependencies = {
      runtime,
      artifacts,
      runs,
      git,
      verifier: { run: async () => [passed] },
      host: {
        getPullRequest: async () => ({ ...current }),
        getBranchHead: async () => targetSha,
      } as unknown as ForgeHost,
    };
    const first = await recoverConflictingRevision({
      run,
      ...values,
      pullRequest,
      workspace: { ...workspace },
      commands: [command],
      mergeGate: values.mergeGate,
    }, dependencies);
    assert.equal(first.run.state, "blocked");
    assert.equal(first.buildResult, undefined);
    assert.equal(artifacts.artifacts.some((artifact) => artifact.kind === "BuildResult"), false);
    assert.equal(git.commitCalls, 1);

    const second = await recoverConflictingRevision({
      run: first.run,
      ...values,
      pullRequest,
      workspace: { ...workspace },
      commands: [command],
      mergeGate: values.mergeGate,
    }, dependencies);
    assert.equal(second.run.state, "reviewing");
    assert.equal(second.buildResult?.payload.headSha, newSha);
    assert.equal(git.commitCalls, 1, "the completed merge indication prevents a duplicate local commit");
    assert.equal(git.pushCalls, 1);
    assert.equal(runtime.tasks.length, 1, "the re-entry does not dispatch a second conflict resolver");
  });

  it("preserves a push-success publication failure for typed restart", async () => {
    const runs = new InMemoryRunRepository();
    const artifacts = new InMemoryArtifactRepository();
    const run = await blockedRun(runs);
    const values = fixture(run);
    const git = new FakeGit(["src/allowed.ts"], targetSha);
    let current = { ...pullRequest };
    git.onPush = () => { current = { ...current, headSha: newSha }; };
    let pullRequestReads = 0;
    const host = {
      getPullRequest: async () => {
        pullRequestReads += 1;
        // The fourth read is the publication projection read, after the
        // branch push. The first three reads belong to conflict recovery's
        // pre-integration and pre-verification fences.
        if (pullRequestReads === 4) throw new Error("PR projection read unavailable");
        return { ...current };
      },
      getBranchHead: async () => targetSha,
    } as unknown as ForgeHost;
    await assert.rejects(resumeConflictRecoveryWorkOn({
      run,
      intent: values.intent,
      investigation: values.investigation,
      packet: values.packet,
      buildResult: values.buildResult,
      verdict: values.verdict,
      pullRequest,
      workspace: { ...workspace },
      baseBranch: "staging",
      verification: [command],
      mergeGate: values.mergeGate,
    }, {
      runtime: new FakeAgentRuntime([{
        summary: "resolved",
        changedPaths: ["src/allowed.ts"],
        criterionCoverage: [{ criterion: "works", implementation: "resolved" }],
        decisions: [],
        residualRisks: [],
      }]),
      artifacts,
      runs,
      git,
      verifier: { run: async () => [passed] },
      host,
    }), /PR projection read unavailable/);
    const failed = await runs.load(run.runId);
    assert.equal(failed?.state, "failed");
    assert.equal(git.pushCalls, 1, "the first attempt pushed exactly once before the host read failed");
    assert.deepEqual((await runs.history(run.runId)).slice(-2).map((record) => record.event), ["VERIFICATION_PASSED", "FAIL"]);
    assert.equal((await artifacts.list(run.subject, "BuildResult")).length, 1);
    const failureOutcomes = (await artifacts.list(run.subject, "Outcome"))
      .filter((artifact): artifact is DurableArtifact<"Outcome"> => artifact.kind === "Outcome" && artifact.payload.status === "failed");
    assert.equal(failureOutcomes.length, 1, "publication failure must leave one deterministic recovery Outcome");
    assert.match(failureOutcomes[0]!.payload.reason, /PR projection read unavailable/);

    const resumed = transition(failed!, "RECOVER_REVISION_PUBLICATION", {
      reason: "Restarting the failed synchronized publication",
    });
    await runs.commit(failed!.version, resumed.state, resumed.record);
    const buildResult = (await artifacts.list(run.subject, "BuildResult"))[0];
    assert.ok(buildResult?.kind === "BuildResult");
    const retried = await publishRemediationRevision({
      run: resumed.state,
      pullRequest: { ...pullRequest, headSha: newSha },
      buildResult,
      workspace: { ...workspace, baseSha: targetSha },
    }, { git, host, runs });
    assert.equal(retried.run.state, "reviewing");
    assert.equal(git.pushCalls, 2, "typed publication restart retries the existing delivery safely");
    assert.ok(!(await runs.history(run.runId)).some((record) => record.event === "VERIFICATION_FAILED"));
  });
});
