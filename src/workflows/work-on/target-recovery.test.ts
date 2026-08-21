import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createArtifact, type DurableArtifact } from "../../core/artifacts/schema.js";
import { InMemoryArtifactRepository, InMemoryRunRepository } from "../../core/ports/repositories.js";
import type { GitWorkspace, GitWorkspaceManager } from "../../core/ports/git-workspace.js";
import type { VerificationRunner } from "../../core/ports/verification.js";
import { attachArtifact, createRun, transition, type RunState } from "../../core/state/machine.js";
import { reconcileLatestRunArtifacts } from "../../core/state/reconcile.js";
import { FakeAgentRuntime } from "../../runtime/fake-runtime.js";
import { normalizedTargetRouteClaim, persistTargetAdvanceCheckpoint } from "./target-recovery.js";
import { resumeTargetAdvanceWorkOn } from "./work-on.js";
import { WorkflowExecutionError } from "./investigate.js";
import { terminalOrchestrationResult } from "../orchestrate/terminal-result.js";

const sourceBase = "a".repeat(40);
const targetBase = "b".repeat(40);
const recoveredHead = "c".repeat(40);
const subject = { repo: "acme/repo", issue: 42 };
const workspace: GitWorkspace = { path: "/tmp/forgedock-target-recovery", branch: "forgedock/issue-42", baseRef: "main", baseSha: sourceBase };
const command = { id: "test", command: "npm", args: ["test"], timeoutMs: 60_000, required: true } as const;

function intent(runId: string) {
  return createArtifact({ kind: "Intent", runId, subject, producer: { role: "controller" }, payload: { title: "Fix target recovery", problem: "target drift", constraints: [], acceptanceHints: ["Guard runs"], dependencies: [] } });
}
function investigation(runId: string) {
  return createArtifact({ kind: "Investigation", runId, subject, producer: { role: "investigator" }, payload: { outcome: "confirmed", confidence: "high", summary: "confirmed", evidence: [{ claim: "guard", source: "src/a.ts", detail: "guard" }], rootCause: "drift", affectedSurfaces: ["src/a.ts"], risks: [], recommendation: "refresh" } });
}
function packet(runId: string) {
  return createArtifact({ kind: "BuildPacket", runId, subject, producer: { role: "packet-author" }, payload: { scope: ["Guard"], acceptanceCriteria: ["Guard runs"], context: [], implementationPlan: ["edit"], expectedPaths: ["src/a.ts"], verificationPlan: ["npm test"], risks: [], outOfScope: [] } });
}
function build(runId: string, baseSha = sourceBase, headSha = "1".repeat(40)) {
  return createArtifact({ kind: "BuildResult", runId, subject, producer: { role: "builder" }, payload: { branch: workspace.branch, targetBranch: "main", baseSha, headSha, changedPaths: ["src/a.ts"], summary: "built", acceptanceEvidence: [{ criterionId: "criterion-1", criterion: "Guard runs", status: "passed", evidence: "guard() and npm test", anchors: { paths: ["src/a.ts"], symbols: ["guard"], testIds: ["guard-test"], verificationCommandIds: ["test"] } }], checks: [{ command: "npm test", commandId: "test", status: "passed", durationMs: 1 }], decisions: [], residualRisks: [] } });
}
async function targetRun(runId: string, i: DurableArtifact<"Intent">, inv: DurableArtifact<"Investigation">, p: DurableArtifact<"BuildPacket">, b: DurableArtifact<"BuildResult">): Promise<{ run: RunState; artifacts: InMemoryArtifactRepository; runs: InMemoryRunRepository; checkpoint: DurableArtifact<"TargetAdvanceCheckpoint"> }> {
  const artifacts = new InMemoryArtifactRepository();
  const runs = new InMemoryRunRepository();
  for (const artifact of [i, inv, p, b]) await artifacts.append(artifact);
  let run = createRun({ workflow: "work-on", subject, runId, target: { lane: "fast", targetBranch: "main" } });
  run = attachArtifact(run, "Intent", i.id);
  let next = transition(run, "START_INVESTIGATION"); await runs.create(run); await runs.commit(run.version, next.state, next.record); run = next.state;
  run = attachArtifact(run, "Investigation", inv.id); next = transition(run, "INVESTIGATION_CONFIRMED"); await runs.commit(run.version, next.state, next.record); run = next.state;
  run = attachArtifact(run, "BuildPacket", p.id); next = transition(run, "BUILD_PACKET_READY"); await runs.commit(run.version, next.state, next.record); run = next.state;
  run = attachArtifact(run, "BuildResult", b.id); next = transition(run, "BUILD_COMPLETED"); await runs.commit(run.version, next.state, next.record); run = next.state;
  next = transition(run, "VERIFICATION_PASSED", { headSha: b.payload.headSha }); await runs.commit(run.version, next.state, next.record); run = next.state;
  next = transition(run, "TARGET_ADVANCE_DETECTED", { reason: "target moved" }); await runs.commit(run.version, next.state, next.record); run = next.state;
  const checkpoint = await persistTargetAdvanceCheckpoint({ run, packet: p, buildResult: b, workspace, targetBranch: "main", observedTargetSha: targetBase, artifacts });
  if (!checkpoint) throw new Error("checkpoint missing");
  return { run, artifacts, runs, checkpoint };
}
class GitFake implements GitWorkspaceManager {
  commits = 0; pushes = 0; creates = 0;
  async create() { this.creates++; return workspace; }
  async syncToRemoteHead() {}
  async changedPaths() { return []; }
  async revisionChangedPaths() { return ["src/a.ts"]; }
  async integrateRemoteBase() { return { workspace, conflictPaths: [], mergeCommitExists: false }; }
  async isAncestor() { return true; }
  async prepareWorkspaceDependencies() {}
  async committedContentMatches() { return true; }
  async commit() { this.commits++; return recoveredHead; }
  async push() { this.pushes++; }
  async head() { return this.commits ? recoveredHead : "1".repeat(40); }
  async remove() {}
}
class Verifier implements VerificationRunner { async run() { return [{ command: "npm test", commandId: "test", status: "passed" as const, durationMs: 1 }]; } }
function host(git: GitFake) {
  const pr = { repo: subject.repo, number: 7, title: "Fix", body: "", url: "https://example.test/pr/7", state: "OPEN" as const, headSha: recoveredHead, headBranch: workspace.branch, baseBranch: "main" };
  return {
    getBranchHead: async () => targetBase,
    createPullRequest: async () => pr,
    getPullRequest: async () => pr,
    getPullRequestDiff: async () => "diff --git a/src/a.ts b/src/a.ts",
    getChangedPathsBetween: async () => ["src/a.ts"],
    getChangedHunksBetween: async () => ["src/a.ts:L1"],
    getPullRequestMergeGate: async () => ({ repo: subject.repo, pullRequest: 7, headSha: recoveredHead, baseBranch: "main", mergeable: true, mergeability: "mergeable" as const, requiredChecks: [], observedAt: new Date().toISOString() }),
    publishPullRequestComment: async () => {},
    beginReviewFindingPublication: async ({ repo, pullRequest, runId }: any) => ({ repo, pullRequest: pullRequest.number, generation: 1, runId, headSha: pullRequest.headSha, headBranch: pullRequest.headBranch, baseBranch: pullRequest.baseBranch }),
    assertReviewFindingPublication: async () => {},
  };
}
function deps(fixture: Awaited<ReturnType<typeof targetRun>>, git = new GitFake()) {
  return { fixture, git, dependencies: { runtime: new FakeAgentRuntime([{ summary: "Approved", findings: [] }]), artifacts: fixture.artifacts, runs: fixture.runs, git, verifier: new Verifier(), host: host(git) } as never };
}

describe("direct target recovery integration", () => {
  it("integrates an initially un-PRed target and creates fresh verification/build evidence and review", async () => {
    const runId = "target-success"; const i = intent(runId); const inv = investigation(runId); const p = packet(runId); const b = build(runId);
    const fixture = await targetRun(runId, i, inv, p, b); const { git, dependencies } = deps(fixture);
    const result = await resumeTargetAdvanceWorkOn({ run: fixture.run, checkpoint: fixture.checkpoint, intent: i, investigation: inv, packet: p, buildResult: b, workspace, verification: [command] }, dependencies);
    assert.equal(result.pullRequest?.baseBranch, "main");
    assert.equal(git.commits, 1); assert.equal(git.pushes, 1);
    assert.equal((await fixture.artifacts.list(subject, "VerificationCheckpoint")).length, 1);
    assert.equal((await fixture.artifacts.list(subject, "BuildResult")).length, 2);
    assert.equal((await fixture.artifacts.list({ ...subject, pr: 7 }, "ReviewVerdict")).length, 1);
  });
  it("rejects checkpoint identity drift before target mutation", async () => {
    const runId = "target-identity"; const i = intent(runId); const inv = investigation(runId); const p = packet(runId); const b = build(runId);
    const fixture = await targetRun(runId, i, inv, p, b); const { git, dependencies } = deps(fixture);
    const drifted = { ...fixture.checkpoint, payload: { ...fixture.checkpoint.payload, targetBranch: "release" } } as typeof fixture.checkpoint;
    await assert.rejects(() => resumeTargetAdvanceWorkOn({ run: fixture.run, checkpoint: drifted, intent: i, investigation: inv, packet: p, buildResult: b, workspace, verification: [command] }, dependencies), /target route/);
    assert.equal(git.commits, 0);
  });
  it("retains source verdict identity but never treats it as fresh approval", async () => {
    const runId = "target-verdict"; const i = intent(runId); const inv = investigation(runId); const p = packet(runId); const b = build(runId);
    const fixture = await targetRun(runId, i, inv, p, b); const verdict = createArtifact({ kind: "ReviewVerdict", runId, subject: { ...subject, pr: 7 }, producer: { role: "reviewer" }, payload: { disposition: "approve", headSha: b.payload.headSha, baseBranch: "main", reviewerRoles: ["reviewer"], findings: [], checks: [] } });
    const checkpoint = await persistTargetAdvanceCheckpoint({ run: fixture.run, packet: p, buildResult: b, verdict, workspace, targetBranch: "main", observedTargetSha: targetBase, artifacts: fixture.artifacts });
    assert.equal(checkpoint?.payload.sourceVerdictId, verdict.id);
    const wrongVerdict = createArtifact({ kind: "ReviewVerdict", runId, subject: { ...subject, pr: 7 }, producer: { role: "reviewer" }, payload: { ...verdict.payload } }, { id: "wrong-verdict" });
    await assert.rejects(() => resumeTargetAdvanceWorkOn({ run: fixture.run, checkpoint: checkpoint!, intent: i, investigation: inv, packet: p, buildResult: b, priorVerdict: wrongVerdict, workspace, verification: [command] }, deps(fixture).dependencies), /source verdict/);
  });
  it("propagates durable target checkpoint attempt bounds to terminal recovery", async () => {
    const runId = "target-terminal-attempt";
    const fixture = await targetRun(runId, intent(runId), investigation(runId), packet(runId), build(runId));
    const reconciled = reconcileLatestRunArtifacts(await fixture.artifacts.list(subject));
    const result = terminalOrchestrationResult(subject.issue, await fixture.artifacts.list(subject), reconciled);
    assert.equal(result?.status, "target_recovery");
    assert.equal(result?.attempt, fixture.checkpoint.payload.attempt.number);
    assert.equal(result?.maxAttempts, fixture.checkpoint.payload.attempt.max);
  });
  it("persists a retry checkpoint and exposes its exact identity on target movement", async () => {
    const runId = "target-retry"; const i = intent(runId); const inv = investigation(runId); const p = packet(runId); const b = build(runId); const fixture = await targetRun(runId, i, inv, p, b);
    const git = new GitFake(); const baseDeps = deps(fixture, git).dependencies as any; const d = { ...baseDeps, host: { ...host(git), getBranchHead: async () => { throw Object.assign(new Error("HTTP 503"), { status: 503 }); } } } as never;
    await assert.rejects(() => resumeTargetAdvanceWorkOn({ run: fixture.run, checkpoint: fixture.checkpoint, intent: i, investigation: inv, packet: p, buildResult: b, workspace, verification: [command] }, d), (error: unknown) => {
      assert.ok(error instanceof Error); assert.match(error.message, /503|retry|target/i); assert.ok((error as WorkflowExecutionError).retryCheckpointId);
      return true;
    });
    assert.equal((await fixture.artifacts.list(subject, "RetryCheckpoint")).length, 1);
  });
  it("rejects route claims, frozen scope, plan, and workspace identity drift", async () => {
    const runId = "target-drift-fields"; const i = intent(runId); const inv = investigation(runId); const p = packet(runId); const b = build(runId); const fixture = await targetRun(runId, i, inv, p, b);
    for (const mutate of [
      (payload: any) => ({ ...payload, routeClaimKey: "target-route:other/repo:main" }),
      (payload: any) => ({ ...payload, expectedPaths: ["src/other.ts"] }),
      (payload: any) => ({ ...payload, verificationPlanId: "0".repeat(64) }),
      (payload: any) => ({ ...payload, workspace: { ...payload.workspace, branch: "wrong" } }),
      (payload: any) => ({ ...payload, workspace: { ...payload.workspace, baseRef: "release" } }),
    ]) {
      const drifted = { ...fixture.checkpoint, payload: mutate(fixture.checkpoint.payload) } as typeof fixture.checkpoint;
      await assert.rejects(() => resumeTargetAdvanceWorkOn({ run: fixture.run, checkpoint: drifted, intent: i, investigation: inv, packet: p, buildResult: b, workspace, verification: [command] }, deps(fixture).dependencies));
    }
  });
  it("fences route promotion and every target mutation on lease loss", async () => {
    const runId = "target-lease"; const i = intent(runId); const inv = investigation(runId); const p = packet(runId); const b = build(runId); const fixture = await targetRun(runId, i, inv, p, b); const git = new GitFake(); let promotions = 0;
    const depsWithLease = { ...(deps(fixture, git).dependencies as any), leaseGuard: { assertValid: () => { throw new Error("lease lost"); } }, promoteTargetRouteClaim: async () => { promotions++; } } as never;
    await assert.rejects(() => resumeTargetAdvanceWorkOn({ run: fixture.run, checkpoint: fixture.checkpoint, intent: i, investigation: inv, packet: p, buildResult: b, workspace, verification: [command] }, depsWithLease), /lease lost/);
    assert.equal(promotions, 0); assert.equal(git.commits, 0); assert.equal(git.pushes, 0);
  });
  it("turns the max-attempt boundary into one exhausted retry and blocked outcome", async () => {
    const runId = "target-exhaustion"; const i = intent(runId); const inv = investigation(runId); const p = packet(runId); const b = build(runId); const fixture = await targetRun(runId, i, inv, p, b);
    const checkpoint = { ...fixture.checkpoint, payload: { ...fixture.checkpoint.payload, attempt: { number: 1, max: 2 } } } as typeof fixture.checkpoint;
    const git = new GitFake(); const baseDeps = deps(fixture, git).dependencies as any; const d = { ...baseDeps, host: { ...host(git), getBranchHead: async () => { throw Object.assign(new Error("HTTP 503"), { status: 503 }); } } } as never;
    await assert.rejects(() => resumeTargetAdvanceWorkOn({ run: fixture.run, checkpoint, intent: i, investigation: inv, packet: p, buildResult: b, workspace, verification: [command] }, d), (error: unknown) => {
      assert.ok(error instanceof WorkflowExecutionError); assert.equal(error.recoverable, false); assert.equal(error.retryDisposition.code, "target-advance-exhausted"); return true;
    });
    assert.equal((await fixture.artifacts.list(subject, "RetryCheckpoint")).length, 1);
    assert.equal((await fixture.artifacts.list(subject, "Outcome")).length, 1);
  });
  it("rejects forged source base and checkpoint attempt bounds before Git mutation", async () => {
    const runId = "target-authority";
    const i = intent(runId); const inv = investigation(runId); const p = packet(runId); const b = build(runId);
    const fixture = await targetRun(runId, i, inv, p, b);
    const forgedBase = { ...fixture.checkpoint, payload: { ...fixture.checkpoint.payload, sourceBaseSha: "d".repeat(40) } } as typeof fixture.checkpoint;
    await assert.rejects(() => resumeTargetAdvanceWorkOn({ run: fixture.run, checkpoint: forgedBase, intent: i, investigation: inv, packet: p, buildResult: b, workspace, verification: [command] }, deps(fixture).dependencies), /source base/);
    const forgedMax = { ...fixture.checkpoint, payload: { ...fixture.checkpoint.payload, attempt: { number: 1, max: 1_000_000_000 } } } as typeof fixture.checkpoint;
    await assert.rejects(() => resumeTargetAdvanceWorkOn({ run: fixture.run, checkpoint: forgedMax, intent: i, investigation: inv, packet: p, buildResult: b, workspace, verification: [command] }, deps(fixture).dependencies), /attempt/);
    const forgedOrder = { ...fixture.checkpoint, payload: { ...fixture.checkpoint.payload, attempt: { number: 3, max: 2 } } } as typeof fixture.checkpoint;
    await assert.rejects(() => resumeTargetAdvanceWorkOn({ run: fixture.run, checkpoint: forgedOrder, intent: i, investigation: inv, packet: p, buildResult: b, workspace, verification: [command] }, deps(fixture).dependencies), /attempt/);
    await assert.rejects(() => persistTargetAdvanceCheckpoint({ run: fixture.run, packet: p, buildResult: b, workspace, targetBranch: "main", observedTargetSha: targetBase, maxAttempts: 1_000_000_000, artifacts: fixture.artifacts }), /attempt/);
  });
  it("normalizes route claims and keeps unrelated retry keys independent", async () => {
    assert.equal(normalizedTargetRouteClaim("HTTPS://ACME/Repo/", "refs/heads/main"), "target-route:acme/repo:main");
    const runId = "retry-scope"; const i = intent(runId); const inv = investigation(runId); const p = packet(runId); const b = build(runId); const fixture = await targetRun(runId, i, inv, p, b);
    const { persistRetryCheckpoint } = await import("../../core/state/retry-checkpoint.js");
    const first = await persistRetryCheckpoint({ artifacts: fixture.artifacts, runId, subject, domain: "workflow", code: "one", phase: "read", operationKey: "one", semanticKey: "route-one", attempt: 1, maxAttempts: 3, cause: "temporary" });
    const second = await persistRetryCheckpoint({ artifacts: fixture.artifacts, runId, subject, domain: "workflow", code: "two", phase: "read", operationKey: "two", semanticKey: "route-two", attempt: 1, maxAttempts: 3, cause: "temporary" });
    assert.equal(first.payload.supersedes, undefined); assert.equal(second.payload.supersedes, undefined);
  });
});
