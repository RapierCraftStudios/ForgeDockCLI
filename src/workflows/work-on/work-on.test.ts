import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createArtifact, type BuildPacketPayload, type InvestigationPayload } from "../../core/artifacts/schema.js";
import type { ForgeHost, PullRequestMergeGate, PullRequestSnapshot, ReviewFindingPublicationFence } from "../../core/ports/forge-host.js";
import { LeaseContinuityError } from "../../core/ports/lease.js";
import { decideSubjectAdmission } from "../../core/state/admission.js";
import { reconcileArtifacts } from "../../core/state/reconcile.js";
import { attachArtifact, createRun, transition } from "../../core/state/machine.js";
import { AdvertisedRemoteHeadMismatchError, type GitWorkspace, type GitWorkspaceManager } from "../../core/ports/git-workspace.js";
import { InMemoryArtifactRepository, InMemoryRunRepository } from "../../core/ports/repositories.js";
import type { CheckResult, VerificationCommand, VerificationRunner } from "../../core/ports/verification.js";
import { AgentExecutionInterruptedError, type AgentTask } from "../../runtime/agent-runtime.js";
import { FakeAgentRuntime } from "../../runtime/fake-runtime.js";
import { scopeManifestForBuildPacket } from "../../runtime/agent-runtime.js";
import { ClaimPromotionRecoveryError } from "../../runtime/orchestration-claim-transport.js";
import { ClaimPromotionConflictError } from "../orchestrate/scheduler.js";
import { terminalOrchestrationResult } from "../orchestrate/terminal-result.js";
import type { BuilderSubmission, VerificationDiagnosis } from "./build.js";
import { planReviewPanel } from "../review-pr/planner.js";
import { WorkflowExecutionError } from "./investigate.js";
import { certifyPacketRelationAuthority, repositoryPathFromLocation, resumeBuildWorkOn, resumeCompletionWorkOn, resumeEarlyWorkOn, resumePublicationWorkOn, resumeReviewWorkOn, resumeWorkOn, shouldAppendFailureOutcome, workspacePathsEquivalent, workOn } from "./work-on.js";
import { digestRelation } from "../../core/packet/relation-graph.js";

const sha = "e".repeat(40);
const fastLane = { kind: "fast", targetBranch: "main", resolution: "repository-default" } as const;
const runTarget = { lane: "fast", targetBranch: "main" } as const;
const workspace: GitWorkspace = { path: "/tmp/work", branch: "forgedock/issue-8", baseRef: "main", baseSha: sha };

describe("durable workspace identity", () => {
  it("treats Windows and WSL spellings as the same retained workspace", () => {
    assert.equal(
      workspacePathsEquivalent(
        "/mnt/c/Users/ItsMr/Documents/Coding Projects/.forgedock-worktrees/forgedockcli/.forgedock-worktrees/staging/issue-256-e-40bb-8202-61811545fa33",
        "C:\\Users\\ItsMr\\Documents\\Coding Projects\\.forgedock-worktrees\\forgedockcli\\.forgedock-worktrees\\staging\\issue-256-e-40bb-8202-61811545fa33",
      ),
      true,
    );
    assert.equal(workspacePathsEquivalent("/tmp/work", "/tmp/WORK"), false);
  });
});

describe("relation checkpoint rollout mode", () => {
  it("keeps graph certification advisory by default and strict only when explicitly enabled", async () => {
    const digest = "a".repeat(64);
    const relationPacket = createArtifact({
      kind: "BuildPacket", runId: "run_relation_shadow", subject: { repo: "a/b", issue: 8 }, producer: { role: "controller" },
      payload: {
        ...packet,
        relationGraph: {
          version: "forgedock.relation-graph/v1", baseSha: sha, graphDigest: digest, configDigest: digest,
          closureDigest: digest, commandPlanDigest: digest, evidenceContractDigest: digest,
          checkpointId: `relation-graph:${digest}`, checkpointDigest: digest,
          writablePaths: packet.expectedPaths, evidencePaths: [], invariantIds: [], commandIds: [],
        },
      },
    });
    const artifacts = new InMemoryArtifactRepository();
    await assert.doesNotReject(certifyPacketRelationAuthority(relationPacket, process.cwd(), sha, artifacts));
    const previous = process.env.FORGEDOCK_STRICT_RELATION_CHECKPOINT;
    process.env.FORGEDOCK_STRICT_RELATION_CHECKPOINT = "1";
    try {
      await assert.rejects(certifyPacketRelationAuthority(relationPacket, process.cwd(), sha, artifacts), /checkpoint is missing/);
    } finally {
      if (previous === undefined) delete process.env.FORGEDOCK_STRICT_RELATION_CHECKPOINT;
      else process.env.FORGEDOCK_STRICT_RELATION_CHECKPOINT = previous;
    }
  });
  it("blocks receipt-bound graph tampering without strict-mode environment flags", async () => {
    const runId = "run_receipt_graph_tamper";
    const subject = { repo: "a/b", issue: 8 } as const;
    const intent = createArtifact({ kind: "Intent", runId, subject, producer: { role: "controller" }, payload: { title: "Fix", problem: "Broken", constraints: [], acceptanceHints: [], dependencies: [] } });
    const investigationArtifact = createArtifact({ kind: "Investigation", runId, subject, producer: { role: "investigator" }, payload: investigation });
    const baseSha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const evidencePath = "src/core/packet/relation-graph.ts";
    const evidenceBytes = readFileSync(evidencePath);
    const limits = { maxComponentRoots: 8, maxTotalPaths: 32, maxNewPaths: 4, maxRelationReads: 32, maxEvidenceBytes: 4_000_000 };
    const receiptBase = {
      version: "forgedock.investigation-scope/v1" as const, runId, subject,
      intentId: intent.id, intentDigest: digestRelation(intent.payload), investigationId: investigationArtifact.id, investigationDigest: digestRelation(investigationArtifact.payload),
      baseSha, proposalDigest: digestRelation(packet.expectedPaths), componentRoots: ["src"], approvedPaths: [...packet.expectedPaths], newPaths: [], evidencePaths: [evidencePath],
      evidenceDigests: [{ path: evidencePath, digest: digestRelation([...evidenceBytes]), bytes: evidenceBytes.byteLength }], evidenceBytes: evidenceBytes.byteLength, relationReads: 0, limits,
      relationCheckpointId: `relation-graph:${"a".repeat(64)}`, relationCheckpointDigest: "a".repeat(64),
    };
    const receipt = { ...receiptBase, decisionDigest: digestRelation({ proposalDigest: receiptBase.proposalDigest, componentRoots: receiptBase.componentRoots, approvedPaths: receiptBase.approvedPaths, newPaths: receiptBase.newPaths, evidencePaths: receiptBase.evidencePaths, evidenceDigests: receiptBase.evidenceDigests, evidenceBytes: receiptBase.evidenceBytes, relationReads: 0, limits }) };
    const relationPacket = createArtifact({ kind: "BuildPacket", runId, subject, producer: { role: "controller" }, payload: { ...packet, relationGraph: { version: "forgedock.relation-graph/v1", baseSha, graphDigest: "a".repeat(64), configDigest: "a".repeat(64), closureDigest: "a".repeat(64), commandPlanDigest: "a".repeat(64), evidenceContractDigest: "a".repeat(64), checkpointId: receipt.relationCheckpointId, checkpointDigest: receipt.relationCheckpointDigest, writablePaths: packet.expectedPaths, evidencePaths: [], invariantIds: [], commandIds: [] }, investigationScopeReceipt: receipt } });
    const artifacts = new InMemoryArtifactRepository();
    await artifacts.append(intent);
    await artifacts.append(investigationArtifact);
    const previous = process.env.FORGEDOCK_STRICT_RELATION_CHECKPOINT;
    delete process.env.FORGEDOCK_STRICT_RELATION_CHECKPOINT;
    try {
      await assert.rejects(certifyPacketRelationAuthority(relationPacket, process.cwd(), baseSha, artifacts), /checkpoint is missing/);
    } finally {
      if (previous === undefined) delete process.env.FORGEDOCK_STRICT_RELATION_CHECKPOINT;
      else process.env.FORGEDOCK_STRICT_RELATION_CHECKPOINT = previous;
    }
  });
});

class EndToEndGit {
  removed = false;
  refreshes = 0;
  pristineAssertions = 0;
  createdFrom?: string;
  async create(input: { baseRef: string }): Promise<GitWorkspace> { this.createdFrom = input.baseRef; return workspace; }
  async fastForwardToRemoteTarget(current: GitWorkspace, advertisedHeadSha: string): Promise<GitWorkspace> {
    this.refreshes += 1;
    return { ...current, baseSha: advertisedHeadSha };
  }
  async assertPristineAtHead(): Promise<void> { this.pristineAssertions += 1; }
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
class DiagnosticGit extends EndToEndGit {
  override async create(): Promise<GitWorkspace> { return { ...workspace, path: process.cwd() }; }
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
  async run(): Promise<CheckResult[]> { return [{ command: "npm test", commandId: "test", status: "passed", exitCode: 0, durationMs: 10, outputDigest: "f".repeat(64) }]; }
}
class EndToEndHost implements ForgeHost {
  async materializeDecomposition() { return []; }
  snapshot: PullRequestSnapshot = { repo: "a/b", number: 11, title: "Fix", body: "", url: "https://github.test/a/b/pull/11", state: "OPEN", headSha: sha, headBranch: workspace.branch, baseBranch: "main" };
  issueClosed = false;
  findingIssues = 0;
  findingReconciliations: number[] = [];
  remediationChildDepths: number[] = [];
  publicationFence: ReviewFindingPublicationFence | undefined;
  async beginReviewFindingPublication(input: { repo: string; pullRequest: PullRequestSnapshot; runId: string }) {
    this.publicationFence = {
      repo: input.repo, pullRequest: input.pullRequest.number,
      generation: (this.publicationFence?.generation ?? 0) + 1,
      runId: input.runId, headSha: input.pullRequest.headSha,
      headBranch: input.pullRequest.headBranch, baseBranch: input.pullRequest.baseBranch,
    };
    return { ...this.publicationFence };
  }
  async assertReviewFindingPublication(fence: ReviewFindingPublicationFence) { assert.deepEqual(fence, this.publicationFence); }
  async createPullRequest(input: { baseBranch: string }): Promise<PullRequestSnapshot> {
    this.snapshot.baseBranch = input.baseBranch;
    return { ...this.snapshot };
  }
  async getPullRequest(): Promise<PullRequestSnapshot> { return { ...this.snapshot }; }
  async getPullRequestMergeGate(): Promise<PullRequestMergeGate> {
    return {
      repo: "a/b",
      pullRequest: this.snapshot.number,
      headSha: this.snapshot.headSha,
      baseBranch: this.snapshot.baseBranch,
      mergeable: true,
      requiredChecksProvenance: "github-required" as const,
      requiredChecksHeadSha: this.snapshot.headSha,
      requiredChecks: [{ name: "CI", state: "passed" as const }],
      observedAt: new Date().toISOString(),
    };
  }
  async getPullRequestDiff(): Promise<string> { return "diff --git a/src/a.js b/src/a.js\n+guard();"; }
  async getChangedPathsBetween(): Promise<readonly string[]> { return ["src/a.js"]; }
  async getChangedHunksBetween(): Promise<readonly string[]> { return ["src/a.js:L1-L1:guard"]; }
  async getBranchHead(): Promise<string> { return sha; }
  async publishPullRequestComment(): Promise<void> {}
  async materializeReviewFinding() {
    this.findingIssues++;
    return { repo: "a/b", number: 99, title: "finding", body: "", url: "https://github.test/a/b/issues/99", state: "OPEN" as const };
  }
  async reconcileReviewFindings(input: { activeFindings: readonly unknown[] }): Promise<readonly number[]> {
    this.findingReconciliations.push(input.activeFindings.length);
    return [];
  }
  async materializeRemediationChildren(input: { remediationDepth: number }) {
    this.remediationChildDepths.push(input.remediationDepth);
    return [{ repo: "a/b", number: 30, title: "child", body: "", url: "https://github.test/a/b/issues/30", state: "OPEN" as const }];
  }
  async mergePullRequest(_repo: string, _number: number, expected: string, expectedBase: string): Promise<void> {
    assert.equal(expected, this.snapshot.headSha);
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
  expectedPaths: ["src/a.js", "src/workflows/work-on/work-on.test.ts"], verificationPlan: ["npm test"],
  verificationRequirements: [{ kind: "command", id: "test", criterionIds: ["criterion-1"], rationale: "Run the proven regression target" }],
  risks: [], outOfScope: [],
};
const targetedTestVerification = {
  id: "test", command: "npm", args: ["test"], timeoutMs: 60_000, required: true,
  selection: "always" as const, targeting: "expected-test-paths" as const,
  evidenceCapability: "targeted-test" as const, policyVersion: "forgedock.verification/v2", lockScope: "workspace" as const,
  typescriptLayout: { sourceRoot: "src", outputRoot: ".forgedock/verification-dist", project: "tsconfig.json", configDigest: "fixture" },
};
const { verificationRequirements: _legacyRequirements, ...legacyPacket } = packet;

function currentReviewPlan(packetArtifact: ReturnType<typeof createArtifact<"BuildPacket">>, reviewedHeadSha = sha) {
  return planReviewPanel({
    changedPaths: ["src/a.js"], diff: "diff --git a/src/a.js b/src/a.js\n+guard();", packet: packetArtifact,
    context: {
      runId: packetArtifact.runId,
      repo: packetArtifact.subject.repo,
      ...(packetArtifact.subject.issue !== undefined ? { issue: packetArtifact.subject.issue } : {}),
      pullRequest: 11,
      deliveryRunId: packetArtifact.runId,
      buildResultBranch: workspace.branch,
      targetBranch: "main",
      reviewedHeadSha,
      phase: "initial",
      deltaPaths: ["src/a.js"],
      openRootIds: [],
    },
  });
}
const submission: BuilderSubmission = {
  summary: "Added guard", changedPaths: ["src/a.js"], criterionCoverage: [{
    criterionId: "criterion-1", criterion: "Guard runs", implementation: "guard() is called",
    anchors: { paths: ["src/a.js"], symbols: ["guard"], testIds: ["guard-regression"], verificationCommandIds: ["test"] },
  }], decisions: [], residualRisks: [],
};

const fixOpenRoots = (task: AgentTask<unknown>) => ({
  summary: "All assigned durable roots are fixed at the current head",
  findings: [],
  rootAssessments: [...new Set(task.objective.match(/root-[a-f0-9]{20}/g) ?? [])].map((rootId) => ({
    rootId, status: "fixed" as const, evidence: "Focused current-head reproducer and frozen checks pass.",
  })),
});

function createWorkOnIntent(runId: string) {
  return createArtifact({
    kind: "Intent", runId, subject: { repo: "a/b", issue: 8 }, producer: { role: "controller" },
    payload: { title: "Fix", problem: "Broken", constraints: [], acceptanceHints: ["Guard runs"], dependencies: [] },
  });
}

async function createPreparationCheckpointFixture(runId: string) {
  const artifacts = new InMemoryArtifactRepository();
  const runs = new InMemoryRunRepository();
  const git = new EndToEndGit();
  const host = new EndToEndHost();
  const intent = createWorkOnIntent(runId);
  const investigationArtifact = createArtifact({
    kind: "Investigation", runId, subject: intent.subject, producer: { role: "investigator" }, payload: investigation,
  });
  let run = attachArtifact(createRun({ workflow: "work-on", subject: intent.subject, runId, target: runTarget }), "Intent", intent.id);
  await runs.create(run);
  let advanced = transition(run, "START_INVESTIGATION");
  await runs.commit(run.version, advanced.state, advanced.record);
  run = advanced.state;
  run = attachArtifact(run, "Investigation", investigationArtifact.id);
  advanced = transition(run, "INVESTIGATION_CONFIRMED");
  await runs.commit(run.version, advanced.state, advanced.record);
  run = advanced.state;
  await artifacts.append(intent);
  await artifacts.append(investigationArtifact);
  return { artifacts, runs, git, host, intent, investigationArtifact, run };
}

async function createBuildCheckpointFixture(runId: string) {
  const fixture = await createPreparationCheckpointFixture(runId);
  const packetArtifact = createArtifact({
    kind: "BuildPacket", runId, subject: fixture.intent.subject, producer: { role: "packet-author" }, payload: packet,
  });
  await fixture.artifacts.append(packetArtifact);
  const withPacket = attachArtifact(fixture.run, "BuildPacket", packetArtifact.id);
  const advanced = transition(withPacket, "BUILD_PACKET_READY", {
    scopeManifest: scopeManifestForBuildPacket(packetArtifact.payload.expectedPaths),
  });
  await fixture.runs.commit(withPacket.version, advanced.state, advanced.record);
  return { ...fixture, packetArtifact, run: advanced.state };
}

async function assertRetainedBuildPacketCheckpoint(
  artifacts: InMemoryArtifactRepository,
  runs: InMemoryRunRepository,
  git: EndToEndGit,
  runId: string,
): Promise<void> {
  const persisted = await runs.load(runId);
  if (!persisted) throw new Error(`Missing persisted run ${runId}`);
  assert.equal(persisted.state, "building");
  assert.equal(persisted.version, 3);
  assert.deepEqual((await runs.history(runId)).map((record) => record.event), [
    "START_INVESTIGATION", "INVESTIGATION_CONFIRMED", "BUILD_PACKET_READY",
  ]);
  const packetArtifact = artifacts.artifacts.find((artifact) => artifact.kind === "BuildPacket");
  if (!packetArtifact || packetArtifact.kind !== "BuildPacket") throw new Error("Missing Build Packet artifact");
  assert.deepEqual(persisted.artifactIds.BuildPacket, [packetArtifact.id]);
  assert.deepEqual(persisted.scopeManifest, scopeManifestForBuildPacket(packetArtifact.payload.expectedPaths));
  assert.equal(artifacts.artifacts.some((artifact) => artifact.kind === "Outcome"), false);
  assert.equal(git.removed, false);
  assert.equal(reconcileArtifacts(artifacts.artifacts).state, "building");
  const admission = decideSubjectAdmission(artifacts.artifacts, { currentTargetBranch: "main" });
  assert.equal(admission.action, "resume");
  if (admission.action === "resume") assert.equal(admission.checkpoint, "build");
}

const acceptAdjudication = (task: AgentTask<unknown>) => ({
  decisions: [...task.objective.matchAll(/"id": "(review-[a-f0-9]{16})"/g)].map((match) => ({
    findingId: match[1]!, disposition: "accept", rationale: "Directly required by the frozen criterion.",
  })),
});

describe("complete work-on trajectory", () => {
  it("resolves the verification catalog from the fetched workspace base before freezing the packet", async () => {
    const baseB = "b".repeat(40);
    class FetchedBaseGit extends EndToEndGit {
      override async create(input: { baseRef: string }): Promise<GitWorkspace> {
        this.createdFrom = input.baseRef;
        return { ...workspace, baseSha: baseB };
      }
      override async fastForwardToRemoteTarget(current: GitWorkspace): Promise<GitWorkspace> {
        this.refreshes += 1;
        return { ...current, baseSha: baseB };
      }
    }
    class FetchedBaseHost extends EndToEndHost {
      override async getBranchHead(): Promise<string> { return baseB; }
    }
    class CapturingVerifier implements VerificationRunner {
      commands: string[][] = [];
      async run(commands: readonly Omit<VerificationCommand, "cwd">[]): Promise<CheckResult[]> {
        this.commands = commands.map((command) => [command.command, ...command.args]);
        return commands.map((command) => ({
          command: [command.command, ...command.args].join(" "), commandId: command.id,
          status: "passed" as const, exitCode: 0, durationMs: 1, outputDigest: "f".repeat(64),
          ...(command.planId !== undefined ? { planId: command.planId } : {}),
          ...(command.policyVersion !== undefined ? { policyVersion: command.policyVersion } : {}),
          ...(command.targets ? { commandTargets: [...command.targets] } : {}),
        }));
      }
    }
    const stale = [{
      id: "test", command: process.execPath, args: ["stale-authority"], timeoutMs: 1_000, required: true,
      selection: "always" as const, targeting: "expected-test-paths" as const, evidenceCapability: "targeted-test" as const,
      policyVersion: "forgedock.verification/v2", typescriptLayout: { sourceRoot: "src", outputRoot: "dist", project: "tsconfig.json", configDigest: "fixture" },
    }];
    const fresh = [{ ...stale[0]!, args: ["fetched-authority"] }];
    const runtime = new FakeAgentRuntime([
      investigation,
      {
        ...packet, expectedPaths: ["src/a.js", "src/a.test.ts"], verificationPlan: ["test"],
        verificationRequirements: [{ kind: "command", id: "test", criterionIds: ["criterion-1"], rationale: "Run targeted regression" }],
      },
      submission,
      { summary: "Approved", findings: [] },
    ]);
    const artifacts = new InMemoryArtifactRepository();
    const runs = new InMemoryRunRepository();
    const git = new FetchedBaseGit();
    const verifier = new CapturingVerifier();
    const intent = createArtifact({
      kind: "Intent", runId: "run_fetched_catalog", subject: { repo: "a/b", issue: 426 }, producer: { role: "controller" },
      payload: { title: "Fetched authority", problem: "Catalog drift", constraints: [], acceptanceHints: ["Guard runs"], dependencies: [] },
    });
    const result = await workOn({
      intent, repoPath: process.cwd(), lane: fastLane, autoMerge: true, verification: stale,
      resolveVerificationCatalog: (baseSha) => {
        assert.equal(baseSha, baseB);
        return fresh;
      },
    }, {
      runtime, artifacts, runs, git, verifier, host: new FetchedBaseHost(),
    });
    assert.equal(result.run.state, "completed");
    const persisted = artifacts.artifacts.find((artifact) => artifact.kind === "BuildPacket");
    assert.equal(persisted?.kind, "BuildPacket");
    if (persisted?.kind === "BuildPacket") {
      assert.equal(persisted.payload.verificationCommandIdentities?.[0]?.args[0], "fetched-authority");
    }
    assert.ok(verifier.commands.some((command) => command.includes("fetched-authority")));
    assert.equal(verifier.commands.some((command) => command.includes("stale-authority")), false);
  });

  it("rejects a closed issue before creating a fresh workspace or dispatching an agent", async () => {
    const runtime = new FakeAgentRuntime([]);
    const artifacts = new InMemoryArtifactRepository();
    const runs = new InMemoryRunRepository();
    const git = new EndToEndGit();
    const host = new EndToEndHost();
    host.issueClosed = true;
    const intent = createArtifact({
      kind: "Intent", runId: "run_closed_issue", subject: { repo: "a/b", issue: 8 }, producer: { role: "controller" },
      payload: { title: "Closed", problem: "Already closed", constraints: [], acceptanceHints: [], dependencies: [] },
    });

    await assert.rejects(
      workOn({ intent, repoPath: process.cwd(), lane: fastLane, verification: [targetedTestVerification] }, {
        runtime, artifacts, runs, git, verifier: new EndToEndVerifier(), host,
      }),
      /Issue #8 is already closed; refusing to start fresh work/,
    );
    assert.equal(git.createdFrom, undefined);
    assert.deepEqual(runtime.tasks, []);
  });

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
      verification: [targetedTestVerification],
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

  it("retains the frozen building checkpoint when parent claim arbitration suspends the worker", async () => {
    const runtime = new FakeAgentRuntime([investigation, packet]);
    const artifacts = new InMemoryArtifactRepository();
    const runs = new InMemoryRunRepository();
    const git = new EndToEndGit();
    const host = new EndToEndHost();
    const intent = createArtifact({
      kind: "Intent", runId: "run_claim_conflict", subject: { repo: "a/b", issue: 8 }, producer: { role: "controller" },
      payload: { title: "Conflicting scope", problem: "Needs shared file", constraints: [], acceptanceHints: [], dependencies: [] },
    });

    await assert.rejects(
      () => workOn({
        intent,
        repoPath: process.cwd(),
        lane: fastLane,
        verification: [targetedTestVerification],
        onClaimsPromoted: async () => { throw new ClaimPromotionConflictError("issue-8", ["issue-9"]); },
      }, { runtime, artifacts, runs, git, verifier: new EndToEndVerifier(), host }),
      ClaimPromotionConflictError,
    );

    assert.deepEqual(runtime.tasks.map((task) => task.role), ["investigator", "packet-author"]);
    assert.equal((await runs.load(intent.runId))?.state, "building");
    assert.equal(git.removed, false);
    assert.equal((await artifacts.list(intent.subject, "Outcome")).length, 0);
  });

  it("retains the packet without a failed Outcome when the parent receipt is ambiguous", async () => {
    const runtime = new FakeAgentRuntime([investigation, packet]);
    const artifacts = new InMemoryArtifactRepository();
    const runs = new InMemoryRunRepository();
    const git = new EndToEndGit();
    const host = new EndToEndHost();
    const intent = createWorkOnIntent("run_claim_receipt_ambiguous");
    const ambiguity = new ClaimPromotionRecoveryError("receipt lost", "a".repeat(64), "b".repeat(64));

    await assert.rejects(() => workOn({
      intent,
      repoPath: process.cwd(),
      lane: fastLane,
      verification: [targetedTestVerification],
      onClaimsPromoted: async () => { throw ambiguity; },
    }, { runtime, artifacts, runs, git, verifier: new EndToEndVerifier(), host }), (error: unknown) => error === ambiguity);

    assert.equal((await runs.load(intent.runId))?.state, "building");
    assert.equal(git.removed, false);
    assert.equal((await artifacts.list(intent.subject, "Outcome")).length, 0);
    assert.deepEqual(runtime.tasks.map((task) => task.role), ["investigator", "packet-author"]);
  });

  it("resumes preparation from a durable Investigation without replaying the investigator", async () => {
    const artifacts = new InMemoryArtifactRepository();
    const runs = new InMemoryRunRepository();
    const git = new EndToEndGit();
    const host = new EndToEndHost();
    const intent = createArtifact({
      kind: "Intent", runId: "run_early_prepare", subject: { repo: "a/b", issue: 8 }, producer: { role: "controller" },
      payload: { title: "Fix", problem: "Broken", constraints: [], acceptanceHints: ["Guard runs"], dependencies: [] },
    });
    const investigationArtifact = createArtifact({
      kind: "Investigation", runId: intent.runId, subject: intent.subject, producer: { role: "investigator" }, payload: investigation,
    });
    let run = attachArtifact(createRun({ workflow: "work-on", subject: intent.subject, runId: intent.runId, target: runTarget }), "Intent", intent.id);
    await runs.create(run);
    for (const [event, artifact] of [
      ["START_INVESTIGATION", undefined],
      ["INVESTIGATION_CONFIRMED", investigationArtifact],
    ] as const) {
      if (artifact) run = attachArtifact(run, artifact.kind, artifact.id);
      const advanced = transition(run, event);
      await runs.commit(run.version, advanced.state, advanced.record);
      run = advanced.state;
    }
    await artifacts.append(intent);
    await artifacts.append(investigationArtifact);
    const runtime = new FakeAgentRuntime([packet, submission, { summary: "Approved", findings: [] }]);
    let observeClaims!: (claims: readonly string[]) => void;
    const claimsObserved = new Promise<readonly string[]>((resolve) => { observeClaims = resolve; });
    let releaseClaims!: () => void;
    const claimAdmission = new Promise<void>((resolve) => { releaseClaims = resolve; });

    const resumedPromise = resumeEarlyWorkOn({
      checkpoint: "preparation",
      run,
      intent,
      investigation: investigationArtifact,
      priorArtifacts: [intent, investigationArtifact],
      workspace,
      baseBranch: "main",
      autoMerge: true,
      onClaimsPromoted: async (claims) => {
        observeClaims(claims);
        await claimAdmission;
      },
      verification: [targetedTestVerification],
    }, { runtime, artifacts, runs, git, verifier: new EndToEndVerifier(), host });

    assert.deepEqual(await claimsObserved, packet.expectedPaths);
    assert.deepEqual(runtime.tasks.map((task) => task.role), ["packet-author"]);
    releaseClaims();
    const resumed = await resumedPromise;
    assert.equal(resumed.run.state, "completed");
    assert.deepEqual(runtime.tasks.map((task) => task.role), ["packet-author", "builder", "reviewer"]);
  });

  it("retains the committed packet checkpoint and exact conflict for fresh claim promotion", async () => {
    const runtime = new FakeAgentRuntime([investigation, packet]);
    const artifacts = new InMemoryArtifactRepository();
    const runs = new InMemoryRunRepository();
    const git = new EndToEndGit();
    const host = new EndToEndHost();
    const intent = createWorkOnIntent("run_initial_claim_conflict");
    const conflict = new ClaimPromotionConflictError("issue-8", ["issue-7"]);
    let promotedPaths: readonly string[] | undefined;

    await assert.rejects(workOn({
      intent, repoPath: process.cwd(), lane: fastLane, verification: [targetedTestVerification],
      onClaimsPromoted: (paths) => {
        promotedPaths = paths;
        throw conflict;
      },
    }, { runtime, artifacts, runs, git, verifier: new EndToEndVerifier(), host }), (error: unknown) => {
      assert.equal(error, conflict);
      return true;
    });

    assert.deepEqual(promotedPaths, packet.expectedPaths);
    await assertRetainedBuildPacketCheckpoint(artifacts, runs, git, intent.runId);
    assert.deepEqual(runtime.tasks.map((task) => task.role), ["investigator", "packet-author"]);
  });

  it("retains the committed packet checkpoint and exact conflict for preparation resume claim promotion", async () => {
    const fixture = await createPreparationCheckpointFixture("run_preparation_claim_conflict");
    const runtime = new FakeAgentRuntime([packet]);
    const conflict = new ClaimPromotionConflictError("issue-8", ["issue-7"]);
    let promotedPaths: readonly string[] | undefined;

    await assert.rejects(resumeEarlyWorkOn({
      checkpoint: "preparation",
      run: fixture.run,
      intent: fixture.intent,
      investigation: fixture.investigationArtifact,
      priorArtifacts: [fixture.intent, fixture.investigationArtifact],
      workspace,
      baseBranch: "main",
      verification: [targetedTestVerification],
      onClaimsPromoted: (paths) => {
        promotedPaths = paths;
        throw conflict;
      },
    }, {
      runtime, artifacts: fixture.artifacts, runs: fixture.runs, git: fixture.git,
      verifier: new EndToEndVerifier(), host: fixture.host,
    }), (error: unknown) => {
      assert.equal(error, conflict);
      return true;
    });

    assert.deepEqual(promotedPaths, packet.expectedPaths);
    await assertRetainedBuildPacketCheckpoint(fixture.artifacts, fixture.runs, fixture.git, fixture.intent.runId);
    assert.deepEqual(runtime.tasks.map((task) => task.role), ["packet-author"]);
  });

  it("re-promotes frozen packet paths before builder dispatch on build resume", async () => {
    const fixture = await createBuildCheckpointFixture("run_build_claim_conflict");
    const runtime = new FakeAgentRuntime([]);
    const conflict = new ClaimPromotionConflictError("issue-8", ["issue-7"]);
    let promotedPaths: readonly string[] | undefined;

    await assert.rejects(resumeBuildWorkOn({
      run: fixture.run,
      intent: fixture.intent,
      investigation: fixture.investigationArtifact,
      packet: fixture.packetArtifact,
      workspace,
      baseBranch: "main",
      verification: [targetedTestVerification],
      onClaimsPromoted: (paths) => {
        promotedPaths = paths;
        throw conflict;
      },
    }, {
      runtime, artifacts: fixture.artifacts, runs: fixture.runs, git: fixture.git,
      verifier: new EndToEndVerifier(), host: fixture.host,
    }), (error: unknown) => {
      assert.equal(error, conflict);
      return true;
    });

    assert.deepEqual(promotedPaths, fixture.packetArtifact.payload.expectedPaths);
    const persisted = await fixture.runs.load(fixture.intent.runId);
    if (!persisted) throw new Error("Missing persisted build-resume run");
    assert.equal(persisted.state, "building");
    assert.equal(persisted.version, 4);
    assert.deepEqual((await fixture.runs.history(fixture.intent.runId)).map((record) => record.event), [
      "START_INVESTIGATION", "INVESTIGATION_CONFIRMED", "BUILD_PACKET_READY", "RESUME_BUILD",
    ]);
    assert.deepEqual(persisted.artifactIds.BuildPacket, [fixture.packetArtifact.id]);
    assert.deepEqual(persisted.scopeManifest, scopeManifestForBuildPacket(fixture.packetArtifact.payload.expectedPaths));
    assert.equal(fixture.artifacts.artifacts.some((artifact) => artifact.kind === "Outcome"), false);
    assert.equal(fixture.git.removed, false);
    assert.deepEqual(runtime.tasks, []);
  });

  it("refreshes and recomputes baseline for a clean pre-builder build resume", async () => {
    const fixture = await createBuildCheckpointFixture("run_build_clean_refresh");
    const git = new SequencedEndToEndGit([[], ["src/a.js"]]);
    const runtime = new FakeAgentRuntime([submission, { summary: "Approved", findings: [] }]);
    let claimsPromoted = false;
    let verifierRuns = 0;
    const verifier: VerificationRunner = {
      async run() {
        verifierRuns += 1;
        assert.equal(claimsPromoted, true);
        if (verifierRuns === 1) assert.deepEqual(runtime.tasks, []);
        return [{ command: "npm test", commandId: "test", status: "passed", exitCode: 0, durationMs: 1 }];
      },
    };

    const resumed = await resumeBuildWorkOn({
      run: fixture.run,
      intent: fixture.intent,
      investigation: fixture.investigationArtifact,
      packet: fixture.packetArtifact,
      workspace,
      baseBranch: "main",
      autoMerge: true,
      verification: [targetedTestVerification],
      onClaimsPromoted: () => { claimsPromoted = true; },
    }, {
      runtime, artifacts: fixture.artifacts, runs: fixture.runs, git,
      verifier, host: fixture.host,
    });

    assert.equal(resumed.run.state, "completed");
    assert.equal(git.refreshes, 1);
    assert.equal(git.pristineAssertions, 3);
    assert.equal(verifierRuns, 2);
    assert.deepEqual(runtime.tasks.map((task) => task.role), ["builder", "reviewer"]);
  });

  it("refuses to trust mismatched build-resume preflight evidence", async () => {
    const fixture = await createBuildCheckpointFixture("run_build_claim_preflight_mismatch");
    const runtime = new FakeAgentRuntime([]);
    let promoted = false;

    await assert.rejects(resumeBuildWorkOn({
      run: fixture.run,
      intent: fixture.intent,
      investigation: fixture.investigationArtifact,
      packet: fixture.packetArtifact,
      workspace,
      baseBranch: "main",
      verification: [targetedTestVerification],
      preflightedPacketClaims: ["src/not-the-packet.ts"],
      onClaimsPromoted: () => { promoted = true; },
    }, {
      runtime, artifacts: fixture.artifacts, runs: fixture.runs, git: fixture.git,
      verifier: new EndToEndVerifier(), host: fixture.host,
    }), /preflighted Build Packet claims do not match/i);

    assert.equal(promoted, false);
    assert.deepEqual(runtime.tasks, []);
  });

  it("records a non-conflict callback failure from the adopted fresh packet checkpoint", async () => {
    const runtime = new FakeAgentRuntime([investigation, packet]);
    const artifacts = new InMemoryArtifactRepository();
    const runs = new InMemoryRunRepository();
    const git = new EndToEndGit();
    const host = new EndToEndHost();
    const intent = createWorkOnIntent("run_initial_callback_failure");
    const callbackError = new Error("promotion sink failed");

    await assert.rejects(workOn({
      intent, repoPath: process.cwd(), lane: fastLane, verification: [targetedTestVerification],
      onClaimsPromoted: () => { throw callbackError; },
    }, { runtime, artifacts, runs, git, verifier: new EndToEndVerifier(), host }), (error: unknown) => {
      assert.equal(error, callbackError);
      assert.notEqual(error instanceof Error ? error.name : undefined, "ConcurrentRunUpdateError");
      return true;
    });

    const persisted = await runs.load(intent.runId);
    if (!persisted) throw new Error("Missing persisted callback-failure run");
    assert.equal(persisted.state, "failed");
    assert.equal(persisted.version, 4);
    assert.deepEqual((await runs.history(intent.runId)).map((record) => record.event), [
      "START_INVESTIGATION", "INVESTIGATION_CONFIRMED", "BUILD_PACKET_READY", "FAIL",
    ]);
    const outcomes = artifacts.artifacts.filter((artifact) => artifact.kind === "Outcome");
    assert.equal(outcomes.length, 1);
    assert.equal(outcomes[0]?.kind === "Outcome" ? outcomes[0].payload.status : undefined, "failed");
    assert.equal(outcomes[0]?.kind === "Outcome" ? outcomes[0].payload.reason : undefined, callbackError.message);
    assert.equal(git.removed, false);
    assert.deepEqual(runtime.tasks.map((task) => task.role), ["investigator", "packet-author"]);
  });

  it("records a non-conflict callback failure from the adopted preparation checkpoint", async () => {
    const fixture = await createPreparationCheckpointFixture("run_preparation_callback_failure");
    const runtime = new FakeAgentRuntime([packet]);
    const callbackError = new Error("preparation promotion sink failed");

    await assert.rejects(resumeEarlyWorkOn({
      checkpoint: "preparation",
      run: fixture.run,
      intent: fixture.intent,
      investigation: fixture.investigationArtifact,
      priorArtifacts: [fixture.intent, fixture.investigationArtifact],
      workspace,
      baseBranch: "main",
      verification: [targetedTestVerification],
      onClaimsPromoted: () => { throw callbackError; },
    }, {
      runtime, artifacts: fixture.artifacts, runs: fixture.runs, git: fixture.git,
      verifier: new EndToEndVerifier(), host: fixture.host,
    }), (error: unknown) => {
      assert.equal(error, callbackError);
      assert.notEqual(error instanceof Error ? error.name : undefined, "ConcurrentRunUpdateError");
      return true;
    });

    const persisted = await fixture.runs.load(fixture.intent.runId);
    if (!persisted) throw new Error("Missing persisted preparation callback-failure run");
    assert.equal(persisted.state, "failed");
    assert.equal(persisted.version, 4);
    assert.deepEqual((await fixture.runs.history(fixture.intent.runId)).map((record) => record.event), [
      "START_INVESTIGATION", "INVESTIGATION_CONFIRMED", "BUILD_PACKET_READY", "FAIL",
    ]);
    const outcomes = fixture.artifacts.artifacts.filter((artifact) => artifact.kind === "Outcome");
    assert.equal(outcomes.length, 1);
    assert.equal(outcomes[0]?.kind === "Outcome" ? outcomes[0].payload.reason : undefined, callbackError.message);
    assert.equal(fixture.git.removed, false);
    assert.deepEqual(runtime.tasks.map((task) => task.role), ["packet-author"]);
  });

  it("preserves a newer remediating run when build resume catches a stale downstream failure", async () => {
    const fixture = await createBuildCheckpointFixture("run_stale_outer_catch");
    const { artifacts, runs, intent, investigationArtifact, packetArtifact } = fixture;
    const freshBuild = createArtifact({
      kind: "BuildResult", runId: intent.runId, subject: intent.subject, producer: { role: "controller" },
      payload: {
        branch: workspace.branch, headSha: sha, changedPaths: ["src/a.js"], summary: "Fresh build",
        acceptanceEvidence: [{ criterion: "Guard runs", status: "passed", evidence: "npm test" }],
        checks: [{ command: "npm test", commandId: "test", status: "passed", durationMs: 1 }], decisions: [], residualRisks: [],
      },
    });
    const freshVerdict = createArtifact({
      kind: "ReviewVerdict", runId: intent.runId, subject: { ...intent.subject, pr: 11 }, producer: { role: "controller" },
      payload: { headSha: sha, headBranch: workspace.branch, baseBranch: "main", disposition: "request_changes", reviewerRoles: ["correctness"], findings: [], checks: [] },
    });
    const callbackError = new Error("stale downstream callback");
    let injected = false;
    const onClaimsPromoted = async () => {
      if (injected) return;
      injected = true;
      await artifacts.append(freshBuild);
      await artifacts.append(freshVerdict);
      let current = await runs.load(intent.runId);
      if (!current) throw new Error("Missing run during stale catch injection");
      for (const event of ["BUILD_COMPLETED", "VERIFICATION_PASSED", "PR_PUBLISHED", "REVIEW_CHANGES_REQUESTED"] as const) {
        const advanced = transition(current, event, { headSha: sha });
        await runs.commit(current.version, advanced.state, advanced.record);
        current = advanced.state;
      }
      throw callbackError;
    };
    await assert.rejects(resumeBuildWorkOn({
      run: fixture.run, intent, investigation: investigationArtifact, packet: packetArtifact,
      workspace, baseBranch: "main", verification: [targetedTestVerification], onClaimsPromoted,
    }, {
      runtime: new FakeAgentRuntime([]), artifacts, runs, git: fixture.git,
      verifier: new EndToEndVerifier(), host: fixture.host,
    }), (error: unknown) => {
      assert.equal(error instanceof Error ? error.name : undefined, "WorkflowExecutionError");
      assert.notEqual(error instanceof Error ? error.name : undefined, "ConcurrentRunUpdateError");
      return true;
    });
    const persisted = await runs.load(intent.runId);
    assert.equal(persisted?.state, "remediating");
    assert.equal(persisted?.version, 8);
    assert.equal((await runs.history(intent.runId)).some((record) => record.event === "FAIL"), false);
  });
  it("dispatches the builder only after successful claim promotion from the preparation checkpoint", async () => {
    const fixture = await createPreparationCheckpointFixture("run_preparation_claim_success");
    const runtime = new FakeAgentRuntime([packet, submission, { summary: "Approved", findings: [] }]);
    const promoted: string[][] = [];

    const result = await resumeEarlyWorkOn({
      checkpoint: "preparation",
      run: fixture.run,
      intent: fixture.intent,
      investigation: fixture.investigationArtifact,
      priorArtifacts: [fixture.intent, fixture.investigationArtifact],
      workspace,
      baseBranch: "main",
      autoMerge: true,
      verification: [targetedTestVerification],
      onClaimsPromoted: (paths) => { promoted.push([...paths]); },
    }, {
      runtime, artifacts: fixture.artifacts, runs: fixture.runs, git: fixture.git,
      verifier: new EndToEndVerifier(), host: fixture.host,
    });

    assert.equal(result.run.state, "completed");
    assert.deepEqual(promoted, [packet.expectedPaths]);
    assert.deepEqual(runtime.tasks.map((task) => task.role), ["packet-author", "builder", "reviewer"]);
    assert.equal(fixture.git.removed, true);
  });

  it("refreshes after late claim admission, retries the newest target, and baselines only selected local commands", async () => {
    const fixture = await createPreparationCheckpointFixture("run_preparation_target_refresh");
    const targetAfterPredecessor = "a".repeat(40);
    const newestTarget = "b".repeat(40);
    const typedPacket: BuildPacketPayload = {
      ...packet,
      expectedPaths: ["src/a.js", "src/a.test.ts"],
      verificationRequirements: [{
        kind: "command", id: "test", criterionIds: ["criterion-1"], rationale: "Run the expected regression test",
      }],
    };
    const runtime = new FakeAgentRuntime([typedPacket, submission, { summary: "Approved", findings: [] }]);
    let admitted = false;
    let authoritativeTarget = sha;
    const advertised: string[] = [];
    fixture.host.getBranchHead = async (_repo?: string, branch?: string) => branch === "main" ? authoritativeTarget : sha;
    fixture.git.fastForwardToRemoteTarget = async (current, expected) => {
      assert.equal(admitted, true, "target refresh must follow claim admission");
      advertised.push(expected);
      if (advertised.length === 1) {
        authoritativeTarget = newestTarget;
        throw new AdvertisedRemoteHeadMismatchError(expected, newestTarget);
      }
      return { ...current, baseSha: expected };
    };
    let verificationRuns = 0;
    const verifier: VerificationRunner = {
      async run(commands, _signal, onProgress) {
        verificationRuns += 1;
        if (verificationRuns === 1) {
          assert.equal(admitted, true, "baseline must not run before claim admission");
          assert.deepEqual(runtime.tasks.map((task) => task.role), ["packet-author"]);
        }
        assert.deepEqual(commands.map((command) => command.id), ["diff-check", "build", "test"]);
        assert.deepEqual(commands.find((command) => command.id === "test")?.targets, [".forgedock/verification-dist/a.test.js"]);
        for (const [index, command] of commands.entries()) {
          await onProgress?.({ phase: "command-started", commandId: command.id, index, total: commands.length });
        }
        const results = commands.map((command) => ({
          command: [command.command, ...command.args].join(" "),
          commandId: command.id,
          ...(command.policyVersion !== undefined ? { policyVersion: command.policyVersion } : {}),
          ...(command.targets !== undefined ? { commandTargets: [...command.targets] } : {}),
          ...(command.planId !== undefined ? { planId: command.planId } : {}),
          status: "passed" as const,
          exitCode: 0,
          durationMs: 1,
        }));
        for (const [index, command] of commands.entries()) {
          await onProgress?.({
            phase: "command-completed", commandId: command.id, index, total: commands.length,
            status: "passed", durationMs: 1,
          });
        }
        return results;
      },
    };

    const result = await resumeEarlyWorkOn({
      checkpoint: "preparation",
      run: fixture.run,
      intent: fixture.intent,
      investigation: fixture.investigationArtifact,
      priorArtifacts: [fixture.intent, fixture.investigationArtifact],
      workspace,
      baseBranch: "main",
      autoMerge: true,
      verification: [{
        id: "diff-check", command: "git", args: ["diff", "--check"], timeoutMs: 1_000, required: true,
        selection: "always", evidenceCapability: "generic", policyVersion: "forgedock.verification/v2", lockScope: "workspace",
      }, {
        id: "build", command: "npm", args: ["run", "build"], timeoutMs: 1_000, required: true,
        selection: "always", evidenceCapability: "invariant", policyVersion: "forgedock.verification/v2", lockScope: "workspace",
      }, {
        id: "test", command: process.execPath, args: ["--test"], timeoutMs: 1_000, required: true,
        selection: "packet", targeting: "expected-test-paths", evidenceCapability: "targeted-test", policyVersion: "forgedock.verification/v2", lockScope: "workspace",
        typescriptLayout: { sourceRoot: "src", outputRoot: ".forgedock/verification-dist", project: "tsconfig.json", configDigest: "fixture" },
      }],
      onClaimsPromoted: () => {
        admitted = true;
        authoritativeTarget = targetAfterPredecessor;
      },
    }, {
      runtime, artifacts: fixture.artifacts, runs: fixture.runs, git: fixture.git,
      verifier, host: fixture.host,
    });

    assert.equal(result.run.state, "completed");
    assert.deepEqual(advertised, [targetAfterPredecessor, newestTarget]);
    assert.equal(verificationRuns, 2, "one post-refresh baseline and one changed-revision run are expected");
    const progressPhases = (await fixture.runs.listProgress(fixture.intent.runId)).map((progress) => progress.phase);
    assert.ok(progressPhases.includes("verification.baseline.command-started"));
    assert.ok(progressPhases.includes("verification.changed.command-completed"));
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
    const diagnosis: VerificationDiagnosis = {
      rootCause: "The required check remains failed after both bounded repairs.",
      sourceAnchors: [{ path: "src/workflows/work-on/work-on.test.ts", location: "repair cap regression", evidence: "The frozen test file anchors the bounded failure." }],
      reproducer: "Run the required check after the first repair.",
      failureSignatureMapping: "required-check",
      rejectedPreviousHypotheses: ["The failure is not transient because it persists across repairs."],
      minimalFixGuidance: "Make the smallest source-backed repair.",
    };
    const runtime = new FakeAgentRuntime([investigation, packet, submission, submission, diagnosis, submission]);
    const artifacts = new InMemoryArtifactRepository();
    const runs = new InMemoryRunRepository();
    const git = new DiagnosticGit();
    const host = new EndToEndHost();
    const intent = createArtifact({
      kind: "Intent", runId: "run_blocked", subject: { repo: "a/b", issue: 8 }, producer: { role: "controller" },
      payload: { title: "Fix", problem: "Broken", constraints: [], acceptanceHints: ["Guard runs"], dependencies: [] },
    });
    const verifier: VerificationRunner = {
      async run() { return [{ command: "npm test", commandId: "test", status: "failed", exitCode: 1, durationMs: 10, summary: "test failed" }]; },
    };
    const result = await workOn({
      intent, repoPath: process.cwd(), lane: fastLane, autoMerge: true,
      verification: [targetedTestVerification],
    }, { runtime, artifacts, runs, git, verifier, host });
    assert.equal(result.run.state, "blocked");
    assert.equal(git.removed, false);
    const outcomes = artifacts.artifacts.filter((artifact) => artifact.kind === "Outcome");
    assert.equal(outcomes.length, 3);
    assert.deepEqual(outcomes.map((outcome) => outcome.kind === "Outcome" ? outcome.payload.status : undefined), ["repairing", "repairing", "blocked"]);
    assert.deepEqual(outcomes.flatMap((outcome) => outcome.kind === "Outcome" && outcome.payload.failureEvidence?.repairAttempt !== undefined
      ? [outcome.payload.failureEvidence.repairAttempt]
      : []), [1, 2]);
    assert.equal(outcomes[0]?.kind === "Outcome" ? outcomes[0].payload.failureEvidence?.workspacePath : undefined, process.cwd());
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
      verification: [targetedTestVerification],
    }, { runtime, artifacts, runs, git, verifier: new EndToEndVerifier(), host });
    assert.equal(result.run.state, "completed");
    assert.equal(runtime.tasks.filter((task) => task.role === "builder").length, 2);
    const repairAttempts = artifacts.artifacts.flatMap((artifact) => artifact.kind === "Outcome" && artifact.payload.failureEvidence?.repairAttempt !== undefined
      ? [artifact.payload.failureEvidence.repairAttempt]
      : []);
    assert.deepEqual(repairAttempts, [1]);
  });

  it("diagnoses one repeated timeout signature before the final repair", async () => {
    const diagnosis: VerificationDiagnosis = {
      rootCause: `A literal join("\\n") leaves the escaped separator in the generated command input.`,
      sourceAnchors: [{ path: "src/workflows/work-on/work-on.test.ts", location: "diagnosis regression", evidence: "The frozen test file is the concrete reproducer anchor." }],
      reproducer: "The frozen npm test command repeats the timeout.",
      failureSignatureMapping: `test|failed|timeout||join("\\n")`,
      rejectedPreviousHypotheses: ["The first builder blamed a transient provider timeout; the same frozen signature disproves that."],
      minimalFixGuidance: "Replace only the literal separator and rerun the frozen check.",
    };
    const failure: CheckResult = {
      command: "npm", commandId: "test", status: "failed", failureClass: "timeout", failureSignatures: [`join("\\n")`], durationMs: 10,
    };
    const runtime = new FakeAgentRuntime([investigation, packet, submission, submission, diagnosis, submission]);
    const artifacts = new InMemoryArtifactRepository();
    const runs = new InMemoryRunRepository();
    const git = new DiagnosticGit();
    const host = new EndToEndHost();
    const verifier: VerificationRunner = { async run() { return [failure]; } };
    const result = await workOn({ intent: createWorkOnIntent("run_repeated_diagnosis"), repoPath: process.cwd(), lane: fastLane, autoMerge: true, verification: [targetedTestVerification] }, { runtime, artifacts, runs, git, verifier, host });
    assert.equal(result.run.state, "blocked");
    const diagnosisTasks = runtime.tasks.filter((task) => task.role === "investigator" && task.id.includes("verification-diagnosis"));
    assert.equal(diagnosisTasks.length, 1);
    assert.deepEqual(diagnosisTasks[0]?.tools, ["read", "grep", "find", "ls", "verify"]);
    assert.equal(diagnosisTasks[0]?.workspace.mode, "read-only");
    assert.deepEqual(diagnosisTasks[0]?.workspace.scope.writeRoots, []);
    assert.equal(diagnosisTasks[0]?.workspace.scope.writePaths, undefined);
    const finalBuilder = runtime.tasks.filter((task) => task.role === "builder").at(-1);
    assert.match(finalBuilder?.instructions ?? "", /literal join/);
    assert.match(finalBuilder?.instructions ?? "", /Rejected previous hypotheses/);
    assert.equal(runtime.tasks.filter((task) => task.id.includes("verification-diagnosis")).length, 1);
    const attemptTwo = artifacts.artifacts.find((artifact) => artifact.kind === "Outcome" && artifact.payload.failureEvidence?.repairAttempt === 2);
    assert.equal(attemptTwo?.kind, "Outcome");
    assert.ok(attemptTwo?.payload.failureEvidence?.diagnostics?.some(({ code }) => code === "verification-diagnosis"));
  });

  it("diagnoses a changed repaired failure signature before the final repair", async () => {
    const diagnosis: VerificationDiagnosis = {
      rootCause: "The first repair changed the failing executable check without resolving the underlying issue.",
      sourceAnchors: [{ path: "src/workflows/work-on/work-on.test.ts", location: "changed-signature regression", evidence: "The frozen test file is the concrete transition anchor." }],
      reproducer: "The repaired workspace changes the failure from first to changed.",
      failureSignatureMapping: "test|failed|||changed",
      rejectedPreviousHypotheses: ["The first failure was transient; the changed signature demonstrates the repair altered the failure mode instead."],
      minimalFixGuidance: "Inspect the transition and make the smallest source-backed correction.",
    };
    const runtime = new FakeAgentRuntime([investigation, packet, submission, submission, diagnosis, submission]);
    const artifacts = new InMemoryArtifactRepository();
    const runs = new InMemoryRunRepository();
    const git = new DiagnosticGit();
    const host = new EndToEndHost();
    let index = 0;
    const verifier: VerificationRunner = {
      async run() {
        index += 1;
        return [{ command: "npm test", commandId: "test", status: "failed", failureSignatures: [index === 2 ? "first" : "changed"], durationMs: 10 }];
      },
    };
    const result = await workOn({ intent: createWorkOnIntent("run_changed_diagnosis"), repoPath: process.cwd(), lane: fastLane, autoMerge: true, verification: [targetedTestVerification] }, { runtime, artifacts, runs, git, verifier, host });
    assert.equal(result.run.state, "blocked");
    const diagnosisTasks = runtime.tasks.filter((task) => task.id.includes("verification-diagnosis"));
    assert.equal(diagnosisTasks.length, 1);
    assert.deepEqual(diagnosisTasks[0]?.tools, ["read", "grep", "find", "ls", "verify"]);
    assert.equal(diagnosisTasks[0]?.workspace.mode, "read-only");
    const finalBuilder = runtime.tasks.filter((task) => task.role === "builder").at(-1);
    assert.match(finalBuilder?.instructions ?? "", /verification failure transition/);
    assert.equal(runtime.tasks.filter((task) => task.id.includes("verification-diagnosis")).length, 1);
    assert.equal(runtime.tasks.filter((task) => task.role === "builder").length, 3);
    assert.deepEqual(artifacts.artifacts.flatMap((artifact) => artifact.kind === "Outcome" && artifact.payload.failureEvidence?.repairAttempt !== undefined ? [artifact.payload.failureEvidence.repairAttempt] : []), [1, 2]);
  });
  it("diagnoses a report-only to executable failure transition before the final repair", async () => {
    const diagnosis: VerificationDiagnosis = {
      rootCause: "Review remediation changed the failure from a report-only mismatch to an executable test failure.",
      sourceAnchors: [{ path: "src/workflows/work-on/work-on.test.ts", location: "report transition regression", evidence: "The frozen test captures the transition." }],
      reproducer: "Submit an incorrect change report, then observe the executable test failure.",
      failureSignatureMapping: "test|failed|||changed",
      rejectedPreviousHypotheses: ["The report-only failure was not a transient test timeout; the executable failure confirms a distinct transition."],
      minimalFixGuidance: "Reconcile the report and executable failure with the smallest in-scope fix.",
    };
    const reportOnlySubmission = { ...submission, changedPaths: ["src/not-observed.ts"] };
    const runtime = new FakeAgentRuntime([investigation, packet, reportOnlySubmission, submission, diagnosis, submission]);
    const artifacts = new InMemoryArtifactRepository();
    const runs = new InMemoryRunRepository();
    const git = new DiagnosticGit();
    const host = new EndToEndHost();
    const verifier: VerificationRunner = { async run() { return [{ command: "npm test", commandId: "test", status: "failed", failureSignatures: ["changed"], durationMs: 10 }]; } };
    const result = await workOn({ intent: createWorkOnIntent("run_report_transition"), repoPath: process.cwd(), lane: fastLane, autoMerge: true, verification: [targetedTestVerification] }, { runtime, artifacts, runs, git, verifier, host });
    assert.equal(result.run.state, "blocked");
    assert.equal(runtime.tasks.filter((task) => task.id.includes("verification-diagnosis")).length, 1);
    assert.match(runtime.tasks.filter((task) => task.role === "builder").at(-1)?.instructions ?? "", /report-only failure/);
  });
  it("rejects malformed and out-of-scope diagnosis before a final builder", async () => {
    for (const [label, diagnosis] of [["malformed", {}], ["out-of-scope", {
      rootCause: "bad", sourceAnchors: [{ path: "outside.ts", location: "x", evidence: "bad" }], reproducer: "x",
      failureSignatureMapping: "test|failed|timeout||first", rejectedPreviousHypotheses: ["bad"], minimalFixGuidance: "bad",
    }]] as const) {
      const runtime = new FakeAgentRuntime([investigation, packet, submission, submission, diagnosis]);
      const artifacts = new InMemoryArtifactRepository();
      const runs = new InMemoryRunRepository();
      const git = new DiagnosticGit();
      const host = new EndToEndHost();
      const verifier: VerificationRunner = { async run() { return [{ command: "npm", commandId: "test", status: "failed", failureClass: "timeout", failureSignatures: ["first"], durationMs: 10 }]; } };
      let error: unknown;
      try {
        await workOn({ intent: createWorkOnIntent(`run_bad_diagnosis_${label}`), repoPath: process.cwd(), lane: fastLane, autoMerge: true, verification: [targetedTestVerification] }, { runtime, artifacts, runs, git, verifier, host });
        assert.fail("expected diagnosis validation to reject");
      } catch (caught) {
        error = caught;
      }
      assert.ok(error instanceof WorkflowExecutionError);
      if (!(error instanceof WorkflowExecutionError)) throw new Error("expected WorkflowExecutionError");
      assert.match(error.message, label === "malformed" ? /bounded schema|malformed|required properties/ : /outside packet read scope/);
      assert.equal(error.run.state, "blocked");
      const history = await runs.history(`run_bad_diagnosis_${label}`);
      const durable = await runs.load(`run_bad_diagnosis_${label}`);
      assert.equal(history.some((record) => record.event === "FAIL"), false, "diagnosis reason must not be masked by a stale FAIL commit");
      assert.equal(history.at(-1)?.event, "VERIFICATION_FAILED");
      assert.equal(durable?.version, history.length, "blocked diagnosis must commit exactly once");
      const outcomes = artifacts.artifacts.filter((artifact) => artifact.kind === "Outcome");
      const latestOutcome = outcomes.at(-1);
      assert.equal(outcomes.length, 2, "diagnosis validation must add one terminal Outcome without duplicating the attempt");
      assert.equal(latestOutcome?.payload.status, "blocked");
      assert.equal(latestOutcome?.payload.reason, error.message);
      assert.equal(latestOutcome?.payload.failureEvidence?.repairAttempt, undefined);
      const reconciled = reconcileArtifacts(artifacts.artifacts);
      assert.equal(reconciled.state, "blocked");
      assert.ok(terminalOrchestrationResult(8, artifacts.artifacts, reconciled));
      assert.equal(runtime.tasks.filter((task) => task.role === "builder").length, 2);
      assert.equal(runtime.tasks.filter((task) => task.id.includes("verification-diagnosis")).length, 1);
    }
  });

  it("retains the verifying checkpoint on recoverable diagnosis interruption", async () => {
    const runtime = new FakeAgentRuntime([
      investigation,
      packet,
      submission,
      submission,
      new AgentExecutionInterruptedError("diagnosis provider interrupted", {
        reason: "cancelled",
        resumable: true,
      }),
    ]);
    const artifacts = new InMemoryArtifactRepository();
    const runs = new InMemoryRunRepository();
    const git = new DiagnosticGit();
    const host = new EndToEndHost();
    const verifier: VerificationRunner = {
      async run() {
        return [{ command: "npm", commandId: "test", status: "failed", failureClass: "timeout", failureSignatures: ["first"], durationMs: 10 }];
      },
    };
    let error: unknown;
    try {
      await workOn({ intent: createWorkOnIntent("run_recoverable_diagnosis"), repoPath: process.cwd(), lane: fastLane, autoMerge: true, verification: [targetedTestVerification] }, { runtime, artifacts, runs, git, verifier, host });
      assert.fail("expected diagnosis interruption");
    } catch (caught) {
      error = caught;
    }
    assert.ok(error instanceof WorkflowExecutionError);
    if (!(error instanceof WorkflowExecutionError)) throw new Error("expected WorkflowExecutionError");
    assert.equal(error.recoverable, true);
    assert.equal(error.run.state, "verifying");
    const durable = await runs.load("run_recoverable_diagnosis");
    const history = await runs.history("run_recoverable_diagnosis");
    assert.equal(durable?.version, error.run.version);
    assert.equal(durable?.version, history.length);
    assert.equal(history.some((record) => record.event === "FAIL"), false);
    assert.equal(artifacts.artifacts.filter((artifact) => artifact.kind === "Outcome").length, 1);
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
        return verificationCalls === 2
          ? [{ command: "npm test", commandId: "test", status: "failed", exitCode: 1, durationMs: 10, summary: "test failed" }]
          : [{ command: "npm test", commandId: "test", status: "passed", exitCode: 0, durationMs: 10 }];
      },
    };
    const result = await workOn({
      intent, repoPath: process.cwd(), lane: fastLane, autoMerge: true,
      verification: [targetedTestVerification],
    }, { runtime, artifacts, runs, git, verifier, host });
    assert.equal(result.run.state, "completed");
    assert.equal(verificationCalls, 3);
    assert.deepEqual(runtime.tasks.map((task) => task.role), ["investigator", "packet-author", "builder", "builder", "reviewer"]);
    const repairTask = runtime.tasks[3];
    assert.match(repairTask?.objective ?? "", /controller verification failed/);
    assert.ok(repairTask?.tools.includes("verify"));
    assert.deepEqual(repairTask?.verification?.commands.map(({ id }) => id), ["test"]);
    assert.match(repairTask?.instructions ?? "", /reproduce every controller-recorded failed check/i);
    assert.match(repairTask?.instructions ?? "", /neighboring frozen check/i);
    assert.match(repairTask?.instructions ?? "", /re-audit every still-open frozen criterion/i);
    assert.match(repairTask?.instructions ?? "", /prior builder checklist\/submission/i);
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
          changedPaths: ["src/a.js"],
          diagnostics: [{ code: "contract-mismatch", message: "Immutable evidence contract differs from catalog" }],
          checks: [{ command: "npm test", commandId: "test", status: "failed", durationMs: 1 }],
        },
      },
    });
    const runtime = new FakeAgentRuntime([submission, { summary: "Approved", findings: [] }]);
    const resumed = await resumeBuildWorkOn({
      run, intent, investigation: investigationArtifact, packet: packetArtifact, priorVerificationFailure,
      workspace, baseBranch: "main", autoMerge: true,
      verification: [targetedTestVerification],
    }, { runtime, artifacts, runs, git, verifier: new EndToEndVerifier(), host });

    assert.equal(resumed.run.state, "completed");
    assert.equal(git.refreshes, 0, "a retained partially built revision must not be fast-forwarded");
    assert.deepEqual(runtime.tasks.map((task) => task.role), ["builder", "reviewer"]);
    assert.match(runtime.tasks[0]?.objective ?? "", /controller verification failed/);
    assert.ok(runtime.tasks[0]?.context.some((artifact) => artifact.kind === "Outcome"));
    assert.ok(runtime.tasks[0]?.context.some((artifact) => artifact.kind === "Outcome"
      && artifact.payload.failureEvidence?.diagnostics?.some(({ code }) => code === "contract-mismatch")));
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
          checks: [{ command: "npm test", commandId: "test", status: "failed", failureClass: "command", durationMs: 1 }],
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
      verification: [targetedTestVerification],
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
        checks: [{ command: "npm test", commandId: "test", status: "passed", durationMs: 10 }], decisions: [], residualRisks: [],
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
      verification: [targetedTestVerification],
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
      payload: {
        headSha: oldSha, headBranch: workspace.branch, baseBranch: "main", disposition: "request_changes",
        reviewerRoles: ["correctness"], findings: [], checks: [], reviewPlan: currentReviewPlan(packetArtifact, oldSha),
      },
    }, { createdAt: "2026-01-01T00:01:00.000Z" });
    const buildResult = createArtifact({
      kind: "BuildResult", runId: intent.runId, subject: intent.subject, producer: { role: "controller" },
      payload: {
        branch: workspace.branch, headSha: sha, changedPaths: ["src/a.js"], summary: "Remediated guard",
        acceptanceEvidence: [{ criterion: "Guard runs", status: "passed", evidence: "npm test" }],
        checks: [{ command: "npm test", commandId: "test", status: "passed", durationMs: 10 }], decisions: [], residualRisks: [],
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
      verification: [targetedTestVerification],
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
    const remediatedSha = "f".repeat(40);
    let currentHead = sha;
    git.commit = async () => {
      currentHead = remediatedSha;
      host.snapshot.headSha = remediatedSha;
      return remediatedSha;
    };
    git.head = async () => currentHead;
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
        checks: [{ command: "npm test", commandId: "test", status: "passed", durationMs: 10 }], decisions: [], residualRisks: [],
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
      id: "correctness-1", causalRoot: "guard misses an accepted case", severity: "high" as const, confidence: "high" as const, blocking: true,
      scopeDisposition: "in_scope" as const, scopeRationale: "Directly violates the frozen guard criterion.",
      matchedAcceptanceCriteria: ["Guard runs"], matchedPriorFindingIds: [] as string[], introducedByRemediation: false,
      title: "Guard is incomplete", evidence: "The accepted path still misses one case", location: "src/a.js:1",
      intentRelevance: "The guard must cover the accepted behavior", remediation: "Complete the guard in src/a.js",
    };
    const runtime = new FakeAgentRuntime([
      { summary: "Changes required", findings: [finding] },
      acceptAdjudication,
      submission,
      fixOpenRoots,
    ]);
    const resumed = await resumePublicationWorkOn({
      run, intent, investigation: investigationArtifact, packet: packetArtifact, buildResult,
      workspace, baseBranch: "main", autoMerge: true,
      verification: [targetedTestVerification],
    }, { runtime, artifacts, runs, git, verifier: new EndToEndVerifier(), host });
    assert.equal(resumed.run.state, "completed");
    assert.equal(host.findingIssues, 1, "the blocked review must preserve its accepted root as a durable issue");
    assert.deepEqual(host.findingReconciliations, [1, 0], "the clean remediation verdict must reconcile the resolved root");
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
    const remediatedSha = "f".repeat(40);
    let currentHead = sha;
    git.commit = async () => {
      currentHead = remediatedSha;
      host.snapshot.headSha = remediatedSha;
      return remediatedSha;
    };
    git.head = async () => currentHead;
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
        checks: [{ command: "npm test", commandId: "test", status: "passed", durationMs: 10 }], decisions: [], residualRisks: [],
      },
    });
    const finding = {
      id: "correctness-repair", causalRoot: "guard misses an accepted case", severity: "high" as const, confidence: "high" as const, blocking: true,
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
      fixOpenRoots,
    ]);
    let checks = 0;
    const verifier: VerificationRunner = {
      async run() {
        checks += 1;
        return checks === 1
          ? [{ command: "npm test", commandId: "test", status: "failed", exitCode: 1, durationMs: 1, summary: "whitespace" }]
          : [{ command: "npm test", commandId: "test", status: "passed", exitCode: 0, durationMs: 1 }];
      },
    };
    const resumed = await resumePublicationWorkOn({
      run, intent, investigation: investigationArtifact, packet: packetArtifact, buildResult,
      workspace, baseBranch: "main", autoMerge: true,
      verification: [targetedTestVerification],
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
        checks: [{ command: "npm test", commandId: "test", status: "passed", durationMs: 10 }], decisions: [], residualRisks: [],
      },
    });
    const finding = {
      id: "correctness-resume", causalRoot: "guard misses an accepted case", severity: "high" as const, confidence: "high" as const, blocking: true,
      title: "Guard is incomplete", evidence: "The accepted path still misses one case", location: "src/a.js:1",
      intentRelevance: "The guard must cover the accepted behavior", remediation: "Complete the guard in src/a.js",
    };
    const priorVerdict = createArtifact({
      kind: "ReviewVerdict", runId: intent.runId, subject: { ...intent.subject, pr: host.snapshot.number }, producer: { role: "controller" },
      payload: {
        headSha: sha, headBranch: workspace.branch, baseBranch: "main", disposition: "request_changes",
        reviewerRoles: ["correctness"], findings: [finding], checks: [], reviewPlan: currentReviewPlan(packetArtifact),
      },
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
      verification: [targetedTestVerification],
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
        checks: [{ command: "npm test", commandId: "test", status: "passed", durationMs: 10 }], decisions: [], residualRisks: [],
      },
    });
    const finding = {
      id: "budget-repeat", causalRoot: "guard misses an accepted case", severity: "high" as const, confidence: "high" as const, blocking: true,
      scopeDisposition: "in_scope" as const, scopeRationale: "Directly violates the frozen criterion.",
      matchedAcceptanceCriteria: ["Guard runs"], matchedPriorFindingIds: [] as string[], introducedByRemediation: false,
      title: "Guard is incomplete", evidence: "The accepted path still misses one case", location: "src/a.js:1",
      intentRelevance: "The guard must cover the accepted behavior", remediation: "Complete the guard in src/a.js",
    };
    const priorVerdict = createArtifact({
      kind: "ReviewVerdict", runId: intent.runId, subject: { ...intent.subject, pr: host.snapshot.number }, producer: { role: "controller" },
      payload: {
        headSha: sha, headBranch: workspace.branch, baseBranch: "main", disposition: "request_changes",
        reviewerRoles: ["correctness"], findings: [finding], checks: [], reviewPlan: currentReviewPlan(packetArtifact),
      },
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
      verification: [targetedTestVerification],
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

  it("preserves a recoverable closing checkpoint across resume and completes idempotently", async () => {
    const artifacts = new InMemoryArtifactRepository();
    const runs = new InMemoryRunRepository();
    const git = new EndToEndGit();
    const host = new EndToEndHost();
    const subject = { repo: "a/b", issue: 8 };
    const verdict = createArtifact({
      kind: "ReviewVerdict", runId: "run_completion_recoverable", subject: { ...subject, pr: host.snapshot.number }, producer: { role: "controller" },
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
    let failClose = true;
    host.closeIssue = async () => {
      if (failClose) {
        failClose = false;
        throw new Error("TLS handshake timeout");
      }
      host.issueClosed = true;
    };

    await assert.rejects(resumeCompletionWorkOn({ run, verdict, pullRequest: host.snapshot, autoMerge: true, workspace }, {
      runtime: new FakeAgentRuntime([]), artifacts, runs, git, verifier: new EndToEndVerifier(), host,
    }), (error: unknown) => (error as { recoverable?: boolean }).recoverable === true);
    assert.equal((await runs.load(run.runId))?.state, "closing");
    assert.equal(git.removed, false);
    assert.equal((await artifacts.list(subject, "Outcome")).length, 0);

    const closing = await runs.load(run.runId);
    assert.ok(closing);
    const resumed = await resumeCompletionWorkOn({ run: closing!, verdict, pullRequest: { ...host.snapshot, state: "MERGED" }, autoMerge: true, workspace }, {
      runtime: new FakeAgentRuntime([]), artifacts, runs, git, verifier: new EndToEndVerifier(), host,
    });
    assert.equal(resumed.run.state, "completed");
    assert.equal(host.issueClosed, true);
    assert.equal(git.removed, true);
  });

  it("keeps required-CI polling cancellation at the resumable merging checkpoint", async () => {
    const artifacts = new InMemoryArtifactRepository();
    const runs = new InMemoryRunRepository();
    const git = new EndToEndGit();
    const host = new EndToEndHost();
    const controller = new AbortController();
    const reason = new Error("orchestration lease cancelled CI polling");
    const subject = { repo: "a/b", issue: 8 };
    const verdict = createArtifact({
      kind: "ReviewVerdict", runId: "run_completion_cancelled", subject: { ...subject, pr: host.snapshot.number }, producer: { role: "controller" },
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
    host.getPullRequestMergeGate = async () => {
      controller.abort(reason);
      return {
        repo: "a/b", pullRequest: host.snapshot.number, headSha: sha, baseBranch: "main",
        mergeable: true, requiredChecksProvenance: "github-required" as const, requiredChecksHeadSha: sha,
        requiredChecks: [{ name: "CI", state: "pending" as const }], observedAt: new Date().toISOString(),
      };
    };

    await assert.rejects(resumeCompletionWorkOn({
      run, verdict, pullRequest: host.snapshot, autoMerge: true, workspace, signal: controller.signal,
    }, {
      runtime: new FakeAgentRuntime([]), artifacts, runs, git,
      verifier: new EndToEndVerifier(), host,
    }), (error: unknown) => error === reason);

    assert.equal((await runs.load(verdict.runId))?.state, "merging");
    assert.equal(git.removed, false);
    assert.equal((await artifacts.list(subject, "Outcome")).length, 0);
    assert.equal((await runs.history(verdict.runId)).at(-1)?.event, "RESUME_COMPLETION");
  });

  it("denies completion mutations after lease continuity is lost", async () => {
    const artifacts = new InMemoryArtifactRepository();
    const runs = new InMemoryRunRepository();
    const git = new EndToEndGit();
    const host = new EndToEndHost();
    const subject = { repo: "a/b", issue: 8 };
    const verdict = createArtifact({
      kind: "ReviewVerdict", runId: "run_completion_fenced", subject: { ...subject, pr: host.snapshot.number }, producer: { role: "controller" },
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
    let guardChecks = 0;
    const leaseGuard = {
      assertValid: () => {
        guardChecks += 1;
        if (guardChecks >= 2) throw new LeaseContinuityError("retained checkpoint is unverifiable");
      },
      check: () => undefined,
    };

    await assert.rejects(resumeCompletionWorkOn({
      run, verdict, pullRequest: host.snapshot, autoMerge: true,
    }, {
      runtime: new FakeAgentRuntime([]), artifacts, runs, git, verifier: new EndToEndVerifier(), host, leaseGuard,
    }), LeaseContinuityError);
    assert.ok(guardChecks >= 2);
    assert.equal(host.snapshot.state, "OPEN", "lease loss must fence merge and later completion writes");
  });

  it("resumes retained verification without replaying investigation, packet authoring, or build", async () => {
    const initialRuntime = new FakeAgentRuntime([investigation, legacyPacket, submission]);
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
    const resumedPacket = createArtifact({
      kind: "BuildPacket", runId: intent.runId, subject: intent.subject, producer: { role: "packet-author" }, payload: packet,
    });
    const resumedRuntime = new FakeAgentRuntime([{ summary: "Approved", findings: [] }]);
    const resumed = await resumeWorkOn({
      run: blocked.run, intent, investigation: investigationArtifact, packet: resumedPacket, outcome,
      workspace, baseBranch: "main", autoMerge: true,
      verification: [targetedTestVerification],
    }, { runtime: resumedRuntime, artifacts, runs, git, verifier: new EndToEndVerifier(), host });

    assert.equal(resumed.run.state, "completed");
    assert.deepEqual(resumedRuntime.tasks.map((task) => task.role), ["reviewer"]);
    assert.deepEqual((await runs.history(intent.runId)).map((record) => record.event).slice(-5), [
      "VERIFICATION_PASSED", "PR_PUBLISHED", "REVIEW_APPROVED", "MERGE_COMPLETED", "CLOSE_COMPLETED",
    ]);
  });

  it("preserves the remediation budget when verification resumes after a failed remediation", async () => {
    const initialRuntime = new FakeAgentRuntime([investigation, legacyPacket, submission]);
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
      id: "budget-1", causalRoot: "guard misses an accepted case", severity: "high" as const, confidence: "high" as const, blocking: true,
      scopeDisposition: "in_scope" as const, scopeRationale: "Directly violates the frozen criterion.",
      matchedAcceptanceCriteria: ["Guard runs"], matchedPriorFindingIds: [] as string[], introducedByRemediation: false,
      title: "Guard is still incomplete", evidence: "One accepted case is missing", location: "src/a.js:1",
      intentRelevance: "The frozen criterion requires it", remediation: "Complete the guard",
    };
    const resumedPacket = createArtifact({
      kind: "BuildPacket", runId: intent.runId, subject: intent.subject, producer: { role: "packet-author" }, payload: packet,
    });
    const resumedRuntime = new FakeAgentRuntime([
      { summary: "Changes still required", findings: [finding] },
      acceptAdjudication,
    ]);
    const resumed = await resumeWorkOn({
      run: blocked.run,
      intent,
      investigation: investigationArtifact,
      packet: resumedPacket,
      outcome,
      workspace,
      baseBranch: "main",
      autoMerge: true,
      maxRemediationCycles: 1,
      priorRemediationCycles: 1,
      verification: [targetedTestVerification],
    }, { runtime: resumedRuntime, artifacts, runs, git, verifier: new EndToEndVerifier(), host });

    assert.equal(resumed.run.state, "blocked");
    assert.match(resumed.run.blockedReason ?? "", /Remediation budget exhausted after 1 cycle/);
    assert.deepEqual(resumedRuntime.tasks.map((task) => task.role), ["reviewer", "adjudicator"]);
  });

  it("downgrades a concern outside the frozen Build Packet instead of expanding remediation", async () => {
    const finding = {
      id: "scope-1", causalRoot: "unchanged publish workflow races", severity: "high" as const, confidence: "high" as const, blocking: true,
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
      verification: [targetedTestVerification],
    }, { runtime, artifacts, runs, git, verifier: new EndToEndVerifier(), host });

    assert.equal(result.run.state, "completed");
    assert.equal(host.findingIssues, 1, "an accepted follow-up must remain independently actionable without blocking delivery");
    assert.deepEqual(host.findingReconciliations, [1]);
    assert.equal(git.removed, true);
    assert.deepEqual(runtime.tasks.map((task) => task.role), ["investigator", "packet-author", "builder", "reviewer"]);
    assert.ok(!runtime.tasks.some((task) => task.id.includes("review-infrastructure")), "reviewer prose must not expand the frozen topology");
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
      verification: [targetedTestVerification],
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
      id: "nested-scope", causalRoot: "nested delivery path remains broken", severity: "high" as const, confidence: "high" as const, blocking: true,
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
      verification: [targetedTestVerification],
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
      verification: [targetedTestVerification],
    }, { runtime, artifacts, runs, git, verifier: new EndToEndVerifier(), host });

    assert.equal(result.run.state, "completed");
    assert.equal(result.run.targetBranch, "main");
    assert.equal(git.createdFrom, "origin/main");
    assert.equal(host.issueClosed, true);
    assert.equal(git.removed, true);
    assert.deepEqual(artifacts.artifacts.map((artifact) => artifact.kind), [
      "Intent", "Investigation", "BuildPacket", "VerificationCheckpoint", "BuildResult", "FindingRootLedger", "ReviewFindingProjection", "ReviewFindingProjection", "ReviewVerdict", "Outcome",
    ]);
    assert.deepEqual(runtime.tasks.map((task) => task.role), ["investigator", "packet-author", "builder", "reviewer"]);
    assert.equal(new Set(runtime.tasks.map((task) => task.id)).size, 4);
    assert.deepEqual((await runs.history(intent.runId)).map((record) => record.event), [
      "START_INVESTIGATION", "INVESTIGATION_CONFIRMED", "BUILD_PACKET_READY", "BUILD_COMPLETED",
      "VERIFICATION_PASSED", "PR_PUBLISHED", "REVIEW_APPROVED", "MERGE_COMPLETED", "CLOSE_COMPLETED",
    ]);
  });
});
