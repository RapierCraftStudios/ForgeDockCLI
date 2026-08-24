import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { join } from "node:path";
import { createInvestigationFirstWorkers } from "./investigation-first.js";
import type { OrchestrationRecord, OrchestrationInvestigationRecord } from "../../core/ports/orchestration.js";
import type { InvestigationSnapshot, InvestigationSnapshotIdentity, InvestigationSnapshotManager } from "../../core/ports/git-workspace.js";
import type { OrchestrationInvestigationWorkerContext, OrchestrationPacketWorkerContext } from "./controller.js";
import type { ScheduledWorkItem } from "./scheduler.js";
import { InMemoryArtifactRepository, InMemoryRunRepository } from "../../core/ports/repositories.js";
import type { AgentRuntime } from "../../runtime/agent-runtime.js";

const item = (id: string, issue: number, dependencies: readonly string[] = []): ScheduledWorkItem => ({
  id, issue, priority: 1, dependencies: [...dependencies], claims: [`src/${id}.ts`],
  repository: "owner/repo", targetBranch: "staging", lane: "fast", plan: { id },
});

function node(work: ScheduledWorkItem, extra: Record<string, unknown> = {}) {
  return {
    ...work, status: "queued" as const, childRunIds: [], attempts: [], ...extra,
  };
}

describe("investigation-first execution handoff", () => {
  it("materializes the monotonic confirmed union and excludes invalid parents", async () => {
    const initial = [item("a", 1), item("parent", 2), item("invalid", 5)];
    const children = [item("child-c", 3, ["a", "invalid"]), item("child-d", 4, ["a"])];
    const record = {
      schema: "forgedock.orchestration/v1", orchestrationId: "dag-test", repository: "owner/repo",
      issueNumbers: [1, 2, 3, 4, 5], requestedIssueNumbers: [1, 2, 3, 4, 5], maxParallel: 2,
      autoMerge: false, status: "running", createdAt: "now", updatedAt: "now", investigationWave: 2,
      serializationEdges: [], nodes: [
        node(initial[0]!), node(initial[1]!, { decompositionChildren: [3, 4] }), node(initial[2]!),
        node(children[0]!), node(children[1]!),
      ], investigations: [
        { issue: 1, nodeId: "a", wave: 1, status: "completed", outcome: "confirmed", attemptCount: 1 },
        { issue: 2, nodeId: "parent", wave: 1, status: "completed", outcome: "decompose", attemptCount: 1 },
        { issue: 5, nodeId: "invalid", wave: 1, status: "completed", outcome: "invalid", attemptCount: 1 },
        { issue: 3, nodeId: "child-c", wave: 2, status: "completed", outcome: "confirmed", attemptCount: 1 },
        { issue: 4, nodeId: "child-d", wave: 2, status: "completed", outcome: "confirmed", attemptCount: 1 },
      ],
    } as unknown as OrchestrationRecord;
    const workers = createInvestigationFirstWorkers({
      repository: "owner/repo", checkoutRoot: process.cwd(), runtime: {} as never,
      artifacts: {} as never, runs: {} as never,
      resolveRoute: async () => ({ issue: { title: "", body: "", url: "" }, targetBranch: "staging", lane: "fast" }),
      getBranchHead: async () => "a".repeat(40), sourceItems: () => [...initial, ...children],
      materializeDecomposition: async () => undefined,
    }, initial);
    const result = await workers.materializeExecution({ orchestration: record, wave: 2, investigations: record.investigations!, });
    assert.deepEqual(result.items.map((candidate) => candidate.id), ["a", "child-c", "child-d"]);
    assert.equal(result.items.some((candidate) => candidate.id === "invalid"), false);
    assert.deepEqual(result.items.find((candidate) => candidate.id === "child-d")?.dependencies, ["a"]);
    assert.equal(new Set(result.items.map((candidate) => candidate.issue)).size, 3);
  });

  it("fails closed when a durable packet references a non-confirmed dependency", async () => {
    const confirmed = [item("confirmed", 1), item("successor", 2, ["confirmed"])] as const;
    const record = {
      schema: "forgedock.orchestration/v1", orchestrationId: "packet-test", repository: "owner/repo",
      issueNumbers: [1, 2], requestedIssueNumbers: [1, 2], maxParallel: 2,
      autoMerge: false, status: "running", createdAt: "now", updatedAt: "now", investigationWave: 1,
      serializationEdges: [], nodes: [node(confirmed[0]!), node(confirmed[1]!)], investigations: [
        { issue: 1, nodeId: "confirmed", wave: 1, status: "completed", outcome: "confirmed", attemptCount: 1 },
        { issue: 2, nodeId: "successor", wave: 1, status: "completed", outcome: "confirmed", attemptCount: 1 },
      ],
    } as unknown as OrchestrationRecord;
    const workers = createInvestigationFirstWorkers({
      repository: "owner/repo", checkoutRoot: process.cwd(), runtime: {} as never,
      artifacts: {} as never, runs: {} as never,
      resolveRoute: async () => ({ issue: { title: "", body: "", url: "" }, targetBranch: "staging", lane: "fast" }),
      getBranchHead: async () => "a".repeat(40), sourceItems: () => [...confirmed],
      materializeDecomposition: async () => undefined,
    }, confirmed);
    await assert.rejects(
      workers.materializeExecution({
        orchestration: record, wave: 1, investigations: record.investigations!, packets: [
          { nodeId: "confirmed", wave: 1, status: "completed", attemptCount: 1, expectedPaths: ["src/confirmed.ts"], baseSha: "base" , semanticDependencies: [] },
          { nodeId: "successor", wave: 1, status: "completed", attemptCount: 1, expectedPaths: ["src/successor.ts"], baseSha: "base", semanticDependencies: ["not-confirmed"] },
        ],
      }),
      /unknown semantic dependency/,
    );
  });
});

interface FactoryFixture {
  item: ScheduledWorkItem;
  workers: ReturnType<typeof createInvestigationFirstWorkers>;
  runs: InMemoryRunRepository;
  artifacts: InMemoryArtifactRepository;
  investigation: OrchestrationInvestigationRecord;
  packetContext: OrchestrationPacketWorkerContext;
  subject: { repo: string; issue: number };
  runId: string;
  runtimeCalls: () => number;
  runtimeCwds: () => readonly string[];
}

async function createFactoryFixture(): Promise<FactoryFixture> {
  // Keep this factory hermetic: the adapter-level tests own real Git common-dir
  // and detached-worktree behavior. These worker tests only need an exact,
  // controller-admitted snapshot identity.
  const baseSha = "f".repeat(40);
  const workItem = item("integration", 101);
  const subject = { repo: "owner/repo", issue: workItem.issue };
  const repositoryRoot = process.cwd();
  const snapshotIdentity: InvestigationSnapshotIdentity = {
    schema: "forgedock.investigation-snapshot/v1",
    repository: subject.repo,
    repositoryRoot,
    targetBranch: "staging",
    baseSha,
    snapshotId: "fixture-investigation-snapshot",
    snapshotPath: join(repositoryRoot, ".forgedock-test-investigation-snapshot"),
  };
  const admittedSnapshot: InvestigationSnapshot = {
    identity: snapshotIdentity,
    path: snapshotIdentity.snapshotPath,
  };
  const assertAdmittedSnapshot = (snapshot: InvestigationSnapshot): void => {
    assert.deepEqual(snapshot, admittedSnapshot);
  };
  const snapshotManager: InvestigationSnapshotManager = {
    acquire: async (input) => {
      assert.equal(input.repository, subject.repo);
      assert.equal(input.repositoryRoot, repositoryRoot);
      assert.equal(input.targetBranch, snapshotIdentity.targetBranch);
      assert.equal(input.baseSha, baseSha);
      return structuredClone(admittedSnapshot);
    },
    validate: async (snapshot) => assertAdmittedSnapshot(snapshot),
    release: async (snapshot) => assertAdmittedSnapshot(snapshot),
  };
  const runs = new InMemoryRunRepository();
  const artifacts = new InMemoryArtifactRepository();
  let runtimeCallCount = 0;
  const runtimeCwds: string[] = [];
  const runtime = {
    run: async (task: { role: string; workspace?: { cwd?: string } }) => {
      runtimeCallCount += 1;
      if (task.workspace?.cwd) runtimeCwds.push(task.workspace.cwd);
      if (task.role === "investigator") {
        return {
          output: {
            outcome: "confirmed",
            confidence: "high",
            summary: "The issue is confirmed by the repository contract.",
            evidence: [{ claim: "The contract is missing", source: "src/integration.ts:1", detail: "The integration boundary lacks the required behavior." }],
            rootCause: "The integration boundary does not preserve the contract.",
            affectedSurfaces: ["src/integration.ts"],
            risks: [],
            recommendation: "Implement the missing contract and add a regression test.",
          },
          sessionRef: "session-investigation",
          provider: "test",
          model: "test",
        };
      }
      return {
        output: {
          scope: ["src/integration.ts"],
          acceptanceCriteria: ["The integration contract is preserved."],
          context: [{ source: "src/integration.ts", relevance: "The source contains the affected boundary." }],
          implementationPlan: ["Update the integration boundary and add its regression test."],
          expectedPaths: ["src/integration.ts"],
          verificationPlan: ["`git diff --check`"],
          risks: [],
          outOfScope: [],
        },
        sessionRef: "session-packet",
        provider: "test",
        model: "test",
      };
    },
    close: async () => undefined,
  } as unknown as AgentRuntime;
  const workers = createInvestigationFirstWorkers({
    repository: subject.repo,
    checkoutRoot: repositoryRoot,
    snapshotManager,
    runtime,
    artifacts,
    runs,
    resolveRoute: async () => ({
      issue: { title: "Integration issue", body: "Preserve the contract.", url: "https://example.test/issues/101" },
      targetBranch: "staging",
      lane: "fast",
      baseSha,
    }),
    getBranchHead: async () => baseSha,
    sourceItems: () => [workItem],
    materializeDecomposition: async () => undefined,
  }, [workItem]);
  const taskRuns: string[] = [];
  const commonContext = {
    promoteClaims: async () => undefined,
    promoteTargetRouteClaim: async () => undefined,
    orchestrationId: "dag-integration",
    executionAttempt: 1,
    attemptId: "attempt-integration",
    recovery: "initial" as const,
    recordTask: async (identity: { runId?: string }) => {
      if (identity.runId !== undefined) taskRuns.push(identity.runId);
    },
    heartbeat: async () => undefined,
    assertActive: () => undefined,
  };
  const investigated = await workers.investigationWorker(workItem, {
    ...commonContext,
    phase: "investigation",
    wave: 1,
  } as unknown as OrchestrationInvestigationWorkerContext);
  const runId = String(investigated.evidence?.runId ?? "");
  const investigationId = String(investigated.evidence?.investigationId ?? "");
  assert.ok(runId);
  assert.ok(investigationId);
  if (!investigated.evidence) throw new Error("Investigation worker did not return durable evidence");
  const evidence = investigated.evidence;
  const investigation: OrchestrationInvestigationRecord = {
    issue: workItem.issue,
    nodeId: workItem.id,
    runId,
    investigationArtifactId: investigationId,
    wave: 1,
    baseSha,
    ...(investigated.snapshot !== undefined ? { snapshot: investigated.snapshot } : {}),
    targetBranch: "staging",
    lane: "fast",
    status: "completed",
    outcome: "confirmed",
    evidence,
    attemptCount: 1,
  };
  const packetContext = {
    ...commonContext,
    phase: "packet",
    wave: 1,
    investigation,
  } as unknown as OrchestrationPacketWorkerContext;
  await workers.packetWorker(workItem, packetContext);
  return { item: workItem, workers, runs, artifacts, investigation, packetContext, subject, runId, runtimeCalls: () => runtimeCallCount, runtimeCwds: () => runtimeCwds };
}

describe("investigation-first factory recovery", () => {
  it("preserves invariant:matrix-identity-isolation-241064d3a2cb for repository/route/base/snapshot checkpoints", async () => {
    const fixture = await createFactoryFixture();
    assert.equal(fixture.investigation.snapshot?.repository, "owner/repo");
    assert.equal(fixture.investigation.snapshot?.targetBranch, "staging");
    assert.equal(fixture.investigation.snapshot?.baseSha, fixture.investigation.baseSha);
    assert.equal(fixture.investigation.evidence?.snapshotId, fixture.investigation.snapshot?.snapshotId);
    assert.ok(fixture.runtimeCwds().length >= 2);
    assert.ok(fixture.runtimeCwds().every((cwd) => cwd === fixture.investigation.snapshot?.snapshotPath));
  });

  it("preserves invariant:matrix-adapter-lifecycle-0ba2e567ffc0 through detached snapshot admission", async () => {
    const fixture = await createFactoryFixture();
    assert.ok(fixture.investigation.snapshot?.snapshotPath);
    assert.notEqual(fixture.investigation.snapshot?.snapshotPath, process.cwd());
    assert.equal(fixture.investigation.snapshot?.repositoryRoot, process.cwd());
  });

  it("reuses invariant:matrix-identity-isolation-30f627af23aa only for the exact route/base snapshot", async () => {
    const fixture = await createFactoryFixture();
    const repeated = await fixture.workers.investigationWorker(fixture.item, {
      ...fixture.packetContext, phase: "investigation", wave: 1,
    } as unknown as OrchestrationInvestigationWorkerContext);
    assert.equal(repeated.snapshot?.snapshotId, fixture.investigation.snapshot?.snapshotId);
    assert.equal(repeated.snapshot?.targetBranch, "staging");
  });

  it("fails closed before packet agent dispatch when restart loses the admitted snapshot", async () => {
    const fixture = await createFactoryFixture();
    const callsBefore = fixture.runtimeCalls();
    const { snapshot: _snapshot, ...investigationWithoutSnapshot } = fixture.investigation;
    fixture.packetContext.investigation = investigationWithoutSnapshot;
    await assert.rejects(() => fixture.workers.packetWorker(fixture.item, fixture.packetContext), /no durable snapshot identity/);
    assert.equal(fixture.runtimeCalls(), callsBefore);
  });

  it("replays the confirmed transition before preparing from an investigating run", async () => {
    const fixture = await createFactoryFixture();
    const run = await fixture.runs.load(fixture.runId);
    assert.equal(run?.state, "building");
    const history = await fixture.runs.history(fixture.runId);
    assert.deepEqual(history.map((record) => record.event), [
      "START_INVESTIGATION",
      "INVESTIGATION_CONFIRMED",
      "BUILD_PACKET_READY",
    ]);
    assert.equal(history.filter((record) => record.event === "INVESTIGATION_CONFIRMED").length, 1);
    assert.equal((await fixture.artifacts.list(fixture.subject, "BuildPacket")).length, 1);
    assert.equal(fixture.runtimeCalls(), 2);
  });

  it("reuses the exact durable packet after a building crash window", async () => {
    const fixture = await createFactoryFixture();
    const beforeHistory = await fixture.runs.history(fixture.runId);
    const beforeArtifacts = await fixture.artifacts.list(fixture.subject);
    const beforeRuntimeCalls = fixture.runtimeCalls();
    const firstPacketId = beforeArtifacts.find((artifact) => artifact.kind === "BuildPacket")?.id;
    const result = await fixture.workers.packetWorker(fixture.item, fixture.packetContext);
    const afterHistory = await fixture.runs.history(fixture.runId);
    const afterArtifacts = await fixture.artifacts.list(fixture.subject);
    assert.equal(result.packetId, firstPacketId);
    assert.equal(fixture.runtimeCalls(), beforeRuntimeCalls);
    assert.deepEqual(afterHistory, beforeHistory);
    assert.equal(afterArtifacts.length, beforeArtifacts.length);
    assert.equal(afterArtifacts.filter((artifact) => artifact.kind === "BuildPacket").length, 1);
  });
});
