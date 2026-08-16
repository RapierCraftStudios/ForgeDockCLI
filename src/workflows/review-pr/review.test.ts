import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Check } from "typebox/value";
import { createArtifact } from "../../core/artifacts/schema.js";
import type { ForgeHost, PullRequestSnapshot } from "../../core/ports/forge-host.js";
import { InMemoryArtifactRepository, InMemoryRunRepository } from "../../core/ports/repositories.js";
import { createRun, transition, type RunState, type TransitionEvent } from "../../core/state/machine.js";
import { AgentRunError, type AgentEventSink, type AgentRunResult, type AgentRuntime, type AgentTask, type RuntimeCapabilities } from "../../runtime/agent-runtime.js";
import { FakeAgentRuntime } from "../../runtime/fake-runtime.js";
import { computeReviewPlanId, planReviewPanel, type ReviewPlan, type ReviewPlanContext } from "./planner.js";
import { isTransientReviewerTransportFailure, materializeReviewFindings, renderReviewerSubmissionComment, renderReviewerWaveComment, resolveReviewerAttemptTimeoutMs, reviewPullRequest, ReviewerSubmissionSchema, selectReviewerRoles, type ReviewerSubmission } from "./review.js";

const sha = "a".repeat(40);
const pr: PullRequestSnapshot = { repo: "a/b", number: 4, title: "Fix race", body: "", url: "https://github.test/a/b/pull/4", state: "OPEN", headSha: sha, headBranch: "fix", baseBranch: "main" };
const deploymentPr: PullRequestSnapshot = { ...pr, headBranch: "staging", title: "Deploy: staging → main" };

class FakeHost implements ForgeHost {
  snapshots: PullRequestSnapshot[] = [pr, pr];
  comments: Array<{ marker: string; body: string }> = [];
  findingIssues: Array<{ finding: { id: string }; reviewerRoles: readonly string[] }> = [];
  reconciliations: Array<{ activeFindings: readonly { id: string }[] }> = [];
  remediationDeltaPaths: readonly string[] = [];
  remediationDeltaRequests: Array<{ baseSha: string; headSha: string }> = [];
  constructor(readonly events?: string[]) {}
  async materializeDecomposition() { return []; }
  async createPullRequest(): Promise<PullRequestSnapshot> { return pr; }
  async getPullRequest(): Promise<PullRequestSnapshot> { return this.snapshots.shift() ?? pr; }
  async getPullRequestDiff(): Promise<string> { return "diff --git a/src/lock.ts b/src/lock.ts\n+await lock.run(update)"; }
  async getChangedPathsBetween(_repo: string, baseSha: string, headSha: string): Promise<readonly string[]> {
    this.remediationDeltaRequests.push({ baseSha, headSha });
    return this.remediationDeltaPaths;
  }
  async publishPullRequestComment(input: { marker: string; body: string }): Promise<void> {
    this.comments.push(input);
    this.events?.push(`comment:${input.body.includes("ForgeDock Review Evidence") ? "wave" : "other"}`);
  }
  async materializeReviewFinding(input: { finding: { id: string }; reviewerRoles: readonly string[] }) {
    this.findingIssues.push(input);
    this.events?.push(`issue:${input.finding.id}`);
    const number = 100 + this.findingIssues.length;
    return { repo: pr.repo, number, title: input.finding.id, body: "", url: `https://github.test/a/b/issues/${number}`, state: "OPEN" as const };
  }
  async reconcileReviewFindings(input: { activeFindings: readonly { id: string }[] }): Promise<readonly number[]> {
    this.reconciliations.push(input);
    return [];
  }
  async mergePullRequest(): Promise<void> {}
  async closeIssue(): Promise<void> {}
}

async function reviewingRun(runs: InMemoryRunRepository): Promise<RunState> {
  let run = createRun({ workflow: "work-on", subject: { repo: "a/b", issue: 2 }, runId: `run_review_${crypto.randomUUID()}` });
  await runs.create(run);
  for (const event of ["START_INVESTIGATION", "INVESTIGATION_CONFIRMED", "BUILD_PACKET_READY", "BUILD_COMPLETED", "VERIFICATION_PASSED", "PR_PUBLISHED"] as TransitionEvent[]) {
    const next = transition(run, event, { headSha: sha });
    await runs.commit(run.version, next.state, next.record);
    run = next.state;
  }
  return run;
}

function reviewPlanContext(run: RunState): Omit<ReviewPlanContext, "packetId" | "packetDigest"> {
  return {
    runId: run.runId,
    repo: run.subject.repo,
    ...(run.subject.issue !== undefined ? { issue: run.subject.issue } : {}),
    pullRequest: pr.number,
    deliveryRunId: run.runId,
    buildResultBranch: "fix",
    targetBranch: "main",
  };
}

function artifacts(run: RunState) {
  const common = { runId: run.runId, subject: run.subject };
  const intent = createArtifact({ ...common, kind: "Intent", producer: { role: "controller" }, payload: { title: "Fix race", problem: "Updates race", constraints: [], acceptanceHints: [], dependencies: [] } });
  const investigation = createArtifact({ ...common, kind: "Investigation", producer: { role: "investigator" }, payload: {
    outcome: "confirmed", confidence: "high", summary: "Race confirmed", evidence: [{ claim: "Race", source: "src/lock.ts", detail: "No lock" }], rootCause: "No lock", affectedSurfaces: ["src/lock.ts"], risks: ["concurrency"], recommendation: "Lock update",
  } });
  const packet = createArtifact({ ...common, kind: "BuildPacket", producer: { role: "packet-author" }, payload: {
    scope: ["Lock update"], acceptanceCriteria: ["Concurrent updates pass"], context: [], implementationPlan: ["Use lock"], expectedPaths: ["src/lock.ts"], verificationPlan: ["npm test"], risks: [{ risk: "concurrency race", mitigation: "lock" }], outOfScope: [],
  } });
  const buildResult = createArtifact({ ...common, kind: "BuildResult", producer: { role: "controller" }, payload: {
    branch: "fix", targetBranch: "main", headSha: sha, changedPaths: ["src/lock.ts"], summary: "Locked", acceptanceEvidence: [{ criterion: "Concurrent updates pass", status: "passed", evidence: "test" }], checks: [{ command: "npm test", status: "passed", exitCode: 0, durationMs: 1 }], decisions: [], residualRisks: [],
  } });
  return { intent, investigation, packet, buildResult };
}

function deploymentContext(run: RunState, expectedPaths: readonly string[]) {
  const base = artifacts(run);
  return {
    intent: base.intent,
    investigation: base.investigation,
    packet: {
      ...base.packet,
      payload: { ...base.packet.payload, expectedPaths: [...expectedPaths], risks: [] },
    },
    checks: base.buildResult.payload.checks,
  };
}

const clean: ReviewerSubmission = { summary: "No blocking defects", findings: [] };
const inScope = {
  scopeDisposition: "in_scope" as const,
  scopeRationale: "Directly matches the frozen acceptance criterion.",
  matchedAcceptanceCriteria: ["Concurrent updates pass"],
  matchedPriorFindingIds: [] as string[],
  introducedByRemediation: false,
  causalRoot: "lock releases before guarded write",
};
const acceptAdjudication = (task: AgentTask<unknown>) => ({
  decisions: [...task.objective.matchAll(/"id": "(review-[a-f0-9]{16})"/g)].map((match) => ({
    findingId: match[1]!, disposition: "accept", rationale: "Directly required by the frozen criterion.",
  })),
});
const followUpAdjudication = (task: AgentTask<unknown>) => ({
  decisions: [...task.objective.matchAll(/"id": "(review-[a-f0-9]{16})"/g)].map((match) => ({
    findingId: match[1]!, disposition: "follow_up", rationale: "Requires a new adjacent protocol guarantee.",
  })),
});

describe("fresh-context PR review", () => {
  it("normalizes deployment inventory paths before planning and scope construction", async () => {
    const runs = new InMemoryRunRepository();
    const run = await reviewingRun(runs);
    const pathWithBackslash = `./src${String.fromCharCode(92)}worker.ts`;
    const context = deploymentContext(run, ["src/worker.ts"]);
    const host = new FakeHost();
    host.snapshots = Array.from({ length: 4 }, () => deploymentPr);
    host.getPullRequestDiff = async () => {
      const diffPath = pathWithBackslash;
      return `diff --git a/${diffPath} b/${diffPath}\n+await update()`;
    };
    const runtime = new FakeAgentRuntime(Array.from({ length: 8 }, () => clean));
    const result = await reviewPullRequest({
      run,
      pullRequest: deploymentPr,
      ...context,
      deployment: {
        headSha: sha,
        headBranch: "staging",
        baseBranch: "main",
        changedPaths: [` ${pathWithBackslash} `],
        checks: context.checks,
      },
      workspace: process.cwd(),
      maxReviewSpecialists: 1,
    }, { runtime, host, artifacts: new InMemoryArtifactRepository(), runs });

    assert.equal(result.run.state, "merging");
    assert.deepEqual(result.reviewPlan.executionGroups.flatMap(({ scope }) => scope), ["src/worker.ts"]);
    const reviewerTask = runtime.tasks.find((task) => task.role === "reviewer");
    assert.ok(reviewerTask);
    assert.ok(reviewerTask.workspace.scope.readRoots.includes("src"));
  });

  it("rejects empty, unsafe, and malformed deployment evidence or diff before reviewer dispatch", async () => {
    const cases: Array<{ name: string; evidence: unknown; diff: unknown; pattern: RegExp }> = [
      { name: "empty evidence", evidence: [], diff: "diff --git a/src/lock.ts b/src/lock.ts\n+lock()", pattern: /non-empty array/ },
      { name: "unsafe evidence", evidence: ["../secret.ts"], diff: "diff --git a/src/lock.ts b/src/lock.ts\n+lock()", pattern: /malformed or unsafe/ },
      { name: "malformed evidence", evidence: [42], diff: "diff --git a/src/lock.ts b/src/lock.ts\n+lock()", pattern: /malformed or unsafe/ },
      { name: "empty diff", evidence: ["src/lock.ts"], diff: "", pattern: /non-empty array/ },
      { name: "malformed diff", evidence: ["src/lock.ts"], diff: "not a unified diff", pattern: /non-empty array/ },
      { name: "unsafe diff", evidence: ["src/lock.ts"], diff: "diff --git a/../secret.ts b/../secret.ts\n+secret()", pattern: /malformed or unsafe/ },
    ];
    for (const testCase of cases) {
      const runs = new InMemoryRunRepository();
      const run = await reviewingRun(runs);
      const context = deploymentContext(run, ["src/lock.ts"]);
      const host = new FakeHost();
      host.snapshots = [deploymentPr];
      host.getPullRequestDiff = async () => testCase.diff as string;
      const runtime = new FakeAgentRuntime();
      const artifactStore = new InMemoryArtifactRepository();

      await assert.rejects(
        reviewPullRequest({
          run,
          pullRequest: deploymentPr,
          ...context,
          deployment: {
            headSha: sha,
            headBranch: "staging",
            baseBranch: "main",
            changedPaths: testCase.evidence as readonly string[],
            checks: context.checks,
          },
          workspace: process.cwd(),
          maxReviewSpecialists: 1,
        }, { runtime, host, artifacts: artifactStore, runs }),
        (error: unknown) => error instanceof Error
          && error.name === "WorkflowExecutionError"
          && testCase.pattern.test(error.message),
        testCase.name,
      );

      assert.equal(runtime.tasks.length, 0, testCase.name);
      assert.equal(host.comments.length, 0, testCase.name);
      assert.equal(host.findingIssues.length, 0, testCase.name);
      assert.equal(host.reconciliations.length, 0, testCase.name);
      assert.deepEqual(artifactStore.artifacts, [], testCase.name);
      assert.equal((await runs.load(run.runId))?.state, "failed", testCase.name);
    }
  });

  it("routes risk specialists and approves only the frozen SHA", async () => {
    const runs = new InMemoryRunRepository();
    const run = await reviewingRun(runs);
    const context = artifacts(run);
    const runtime = new FakeAgentRuntime([clean, clean]);
    const host = new FakeHost();
    const result = await reviewPullRequest({ run, pullRequest: pr, ...context, workspace: process.cwd() }, {
      runtime, host, artifacts: new InMemoryArtifactRepository(), runs,
    });
    assert.equal(result.run.state, "merging");
    assert.deepEqual(result.verdict.payload.reviewerRoles, ["correctness", "concurrency"]);
    assert.deepEqual(result.reviewPlan.selected.map(({ role }) => role), ["correctness", "concurrency"]);
    assert.equal(result.verdict.payload.reviewPlan?.riskTier, "high");
    assert.equal(result.verdict.payload.headBranch, "fix");
    assert.equal(result.verdict.payload.baseBranch, "main");
    assert.equal(new Set(result.sessionRefs).size, 2);
    assert.equal(host.comments.length, 1);
    assert.match(host.comments[0]?.body ?? "", /ForgeDock Review Evidence/);
    assert.match(host.comments[0]?.body ?? "", /review-correctness · correctness · completed/);
    assert.match(host.comments[0]?.body ?? "", /review-concurrency · concurrency · completed/);
    assert.ok(host.comments.every(({ body, marker }) => body.includes(marker) && body.includes("consolidated Review Verdict remains authoritative") && body.includes("Session lineage")));
    assert.ok(runtime.tasks.every((task) => task.workspace.mode === "read-only" && !task.tools.includes("edit")));
  });

  it("executes a large review as compact bounded shards with one folded durable report", async () => {
    const runs = new InMemoryRunRepository();
    const run = await reviewingRun(runs);
    const base = artifacts(run);
    const paths = Array.from({ length: 55 }, (_, index) => `src/module-${String(index).padStart(2, "0")}.ts`);
    const packet = { ...base.packet, payload: { ...base.packet.payload, expectedPaths: paths } };
    const buildResult = { ...base.buildResult, payload: { ...base.buildResult.payload, changedPaths: paths } };
    const host = new FakeHost();
    host.getPullRequestDiff = async () => paths
      .map((path) => `diff --git a/${path} b/${path}\n+export const changed = true;`)
      .join("\n");
    const tasks: AgentTask<unknown>[] = [];
    const runtime: AgentRuntime = {
      async capabilities() { return { runtime: "test", resumableSessions: false, tools: ["read", "grep", "find", "ls"] }; },
      async run<T>(task: AgentTask<T>): Promise<AgentRunResult<T>> {
        tasks.push(task);
        return { output: clean as T, sessionRef: `session-${tasks.length}`, provider: "test", model: "test" };
      },
      async close() {},
    };
    const result = await reviewPullRequest({ run, pullRequest: pr, ...base, packet, buildResult, workspace: process.cwd() }, {
      runtime, host, artifacts: new InMemoryArtifactRepository(), runs,
    });
    assert.equal(result.reviewPlan.executionGroups.length, 6);
    assert.equal(tasks.length, result.reviewPlan.executionGroups.length);
    assert.deepEqual([...new Set(result.reviewPlan.executionGroups.map(({ role }) => role))], ["correctness", "concurrency"]);
    assert.ok(result.reviewPlan.executionGroups.every(({ scope }) => scope.length > 0 && scope.length <= 24));
    assert.ok(tasks.every((task) => task.context.length === 0));
    assert.ok(tasks.every((task) => task.executionBudget?.maxTurns === undefined));
    assert.ok(tasks.every((task) => Number.isSafeInteger(task.executionBudget?.maxToolCalls)));
    assert.ok(tasks.every((task) => (task.executionBudget?.maxToolCalls ?? 0) >= 16 && (task.executionBudget?.maxToolCalls ?? 0) <= 48));
    assert.ok(tasks.every((task) => task.instructions.includes("runtime warns before exhaustion")));
    assert.ok(tasks.every((task) => task.instructions.includes("Do not list the checkout root")));
    assert.ok(tasks.every((task) => task.objective.length < 60_000));
    assert.ok(tasks.every((task) => task.objective.includes('"totalExpectedPaths": 55')));
    assert.ok(tasks.every((task) => !task.objective.includes('"expectedPaths"')));
    assert.equal(host.comments.length, 1);
    assert.equal((host.comments[0]?.body.match(/<details><summary>/g) ?? []).length, result.reviewPlan.executionGroups.length);
    assert.deepEqual(result.verdict.payload.reviewerRoles, ["correctness", "concurrency"]);
  });

  it("settles the full reviewer wave before one deduplicated issue projection", async () => {
    const runs = new InMemoryRunRepository();
    const run = await reviewingRun(runs);
    const context = artifacts(run);
    const duplicateA = {
      ...inScope, id: "FINDING-A", severity: "high" as const, confidence: "high" as const, blocking: true,
      title: "Guarded write can escape the lock", evidence: "The write occurs after the lock is released.",
      location: "src/lock.ts:20", intentRelevance: "Allows concurrent updates", remediation: "Keep the write inside the lock.",
    };
    const duplicateB = {
      ...duplicateA, id: "FINDING-B", title: "Concurrent update is not fenced", evidence: "A second update can enter after lock release.",
    };
    const events: string[] = [];
    const host = new FakeHost(events);
    const result = await reviewPullRequest({ run, pullRequest: pr, ...context, workspace: process.cwd() }, {
      runtime: new FakeAgentRuntime([{ summary: "correctness", findings: [duplicateA] }, { summary: "concurrency", findings: [duplicateB] }, acceptAdjudication]),
      host, artifacts: new InMemoryArtifactRepository(), runs,
    });
    assert.equal(result.verdict.payload.findings.length, 1);
    assert.equal(host.findingIssues.length, 1);
    const lastReviewerComment = Math.max(...events.map((event, index) => event.startsWith("comment:") ? index : -1));
    const issueProjection = events.findIndex((event) => event.startsWith("issue:"));
    assert.ok(issueProjection > lastReviewerComment, "issue projection must follow every reviewer comment");
  });

  it("fails closed when the PR target branch changes during review", async () => {
    const runs = new InMemoryRunRepository();
    const run = await reviewingRun(runs);
    const context = artifacts(run);
    const runtime = new FakeAgentRuntime([clean, clean]);
    const host = new FakeHost();
    host.snapshots = [pr, { ...pr, baseBranch: "release" }];
    await assert.rejects(
      reviewPullRequest({ run, pullRequest: pr, ...context, workspace: process.cwd() }, {
        runtime, host, artifacts: new InMemoryArtifactRepository(), runs,
      }),
      /PR delivery route changed during reviewer execution/,
    );
  });

  it("requires an open pull request at the frozen review snapshot", async () => {
    const runs = new InMemoryRunRepository();
    const run = await reviewingRun(runs);
    const context = artifacts(run);
    const host = new FakeHost();
    host.snapshots = [{ ...pr, state: "CLOSED" }];
    const runtime = new FakeAgentRuntime([clean, clean]);

    await assert.rejects(
      reviewPullRequest({ run, pullRequest: pr, ...context, workspace: process.cwd() }, {
        runtime, host, artifacts: new InMemoryArtifactRepository(), runs,
      }),
      /must be OPEN at freeze, found CLOSED/,
    );
    assert.equal(runtime.tasks.length, 0);
  });

  it("does not expand a frozen tiny-diff topology from reviewer findings", async () => {
    const runs = new InMemoryRunRepository();
    const run = await reviewingRun(runs);
    const context = artifacts(run);
    const packetWithoutConcurrency = createArtifact({
      kind: "BuildPacket", runId: run.runId, subject: run.subject, producer: { role: "packet-author" },
      payload: {
        ...context.packet.payload,
        expectedPaths: ["src/worker.ts"],
        risks: [],
      },
    });
    const buildResult = createArtifact({
      kind: "BuildResult", runId: run.runId, subject: run.subject, producer: { role: "controller" },
      payload: { ...context.buildResult.payload, changedPaths: ["src/worker.ts"] },
    });
    class PlainHost extends FakeHost {
      override async getPullRequestDiff(): Promise<string> {
        return "diff --git a/src/worker.ts b/src/worker.ts\n+commitResult(worker)";
      }
    }
    const runtime = new FakeAgentRuntime([{
      summary: "Coordination defect",
      findings: [{
        ...inScope,
        id: "lease-1", severity: "high", confidence: "high", blocking: true,
        title: "Stale lease holder can commit", evidence: "A reassigned worker is not fenced", location: "src/worker.ts:20",
        intentRelevance: "Permits stale writes", remediation: "Fence commits with the active lease epoch",
      }],
    }, acceptAdjudication]);
    const result = await reviewPullRequest({
      run, pullRequest: pr, intent: context.intent, investigation: context.investigation,
      packet: packetWithoutConcurrency, buildResult, workspace: process.cwd(), maxReviewSpecialists: 1,
    }, { runtime, host: new PlainHost(), artifacts: new InMemoryArtifactRepository(), runs });
    assert.deepEqual(result.reviewPlan.selected.map(({ role }) => role), ["correctness"]);
    assert.equal(result.reviewPlan.frozen, true);
    assert.equal(runtime.tasks.length, 2);
    assert.equal(runtime.tasks.filter((task) => task.role === "reviewer").length, 1);
    assert.ok(!runtime.tasks.some((task) => task.id.includes("review-concurrency")));
    assert.ok(runtime.tasks.some((task) => task.role === "adjudicator"));
  });

  it("reuses the exact frozen topology after remediation instead of broadening it", async () => {
    const runs = new InMemoryRunRepository();
    const run = await reviewingRun(runs);
    const context = artifacts(run);
    const neutralPacket = createArtifact({
      kind: "BuildPacket", runId: run.runId, subject: run.subject, producer: { role: "packet-author" },
      payload: { ...context.packet.payload, risks: [], expectedPaths: ["src/worker.ts"] },
    });
    const priorPlan = planReviewPanel({
      changedPaths: ["src/worker.ts"], diff: "+work();", packet: neutralPacket,
      context: reviewPlanContext(run),
    });
    const priorVerdict = createArtifact({
      kind: "ReviewVerdict", runId: run.runId, subject: { ...run.subject, pr: pr.number }, producer: { role: "controller" },
      payload: { headSha: "b".repeat(40), headBranch: "fix", baseBranch: "main", disposition: "request_changes", reviewerRoles: ["correctness"], findings: [], checks: [], reviewPlan: priorPlan },
    });
    const runtime = new FakeAgentRuntime([clean]);
    const result = await reviewPullRequest({ run, pullRequest: pr, ...context, packet: neutralPacket, priorVerdict, workspace: process.cwd() }, {
      runtime, host: new FakeHost(), artifacts: new InMemoryArtifactRepository(), runs,
    });
    assert.equal(result.reviewPlan.planId, priorPlan.planId);
    assert.deepEqual(result.reviewPlan.executionGroups.map(({ role }) => role), ["correctness"]);
    assert.equal(runtime.tasks.filter(({ role }) => role === "reviewer").length, 1);
  });

  it("threads an exact host-observed prior-SHA remediation delta into continuity policy", async () => {
    const runs = new InMemoryRunRepository();
    const run = await reviewingRun(runs);
    const context = artifacts(run);
    const priorPlan = planReviewPanel({
      changedPaths: context.buildResult.payload.changedPaths,
      diff: await new FakeHost().getPullRequestDiff(),
      packet: context.packet,
      context: reviewPlanContext(run),
    });
    const priorVerdict = createArtifact({
      kind: "ReviewVerdict", runId: run.runId, subject: { ...run.subject, pr: pr.number }, producer: { role: "controller" },
      payload: {
        headSha: "b".repeat(40), headBranch: "fix", baseBranch: "main", disposition: "request_changes",
        reviewerRoles: ["correctness", "concurrency"], findings: [], checks: [], reviewPlan: priorPlan,
      },
    });
    const introduced = {
      ...inScope,
      id: "introduced-delta",
      introducedByRemediation: true,
      severity: "high" as const,
      confidence: "high" as const,
      blocking: true,
      title: "Remediation broke the guarded write",
      evidence: "The new edit returns before save",
      location: "src/lock.ts:20",
      intentRelevance: "Breaks the frozen criterion",
      remediation: "Keep save in the guard",
    };
    const host = new FakeHost();
    host.remediationDeltaPaths = ["src/lock.ts"];
    const result = await reviewPullRequest({ run, pullRequest: pr, ...context, priorVerdict, workspace: process.cwd() }, {
      runtime: new FakeAgentRuntime([{ summary: "introduced regression", findings: [introduced] }, clean, acceptAdjudication]),
      host, artifacts: new InMemoryArtifactRepository(), runs,
    });
    assert.equal(result.verdict.payload.findings[0]?.blocking, true);
    assert.deepEqual(host.remediationDeltaRequests, [{ baseSha: "b".repeat(40), headSha: sha }]);
  });

  it("rejects a foreign prior verdict before topology, continuity, adjudication, or supersession use", async () => {
    const variants = ["run", "repo", "issue", "pr", "head-branch", "base-branch", "delivery", "packet", "plan-identity", "head-lineage"] as const;
    for (const variant of variants) {
      const runs = new InMemoryRunRepository();
      const run = await reviewingRun(runs);
      const context = artifacts(run);
      const validPlan = planReviewPanel({
        changedPaths: context.buildResult.payload.changedPaths,
        diff: "diff --git a/src/lock.ts b/src/lock.ts\n+await lock.run(update)",
        packet: context.packet,
        context: reviewPlanContext(run),
      });
      let priorVerdict = createArtifact({
        kind: "ReviewVerdict", runId: run.runId, subject: { ...run.subject, pr: pr.number }, producer: { role: "controller" },
        payload: {
          headSha: "b".repeat(40), headBranch: "fix", baseBranch: "main", disposition: "request_changes",
          reviewerRoles: validPlan.selected.map(({ role }) => role), findings: [], checks: [], reviewPlan: validPlan,
        },
      });
      if (variant === "run") priorVerdict = { ...priorVerdict, runId: "foreign-run" };
      if (variant === "repo") priorVerdict = { ...priorVerdict, subject: { ...priorVerdict.subject, repo: "foreign/repo" } };
      if (variant === "issue") priorVerdict = { ...priorVerdict, subject: { ...priorVerdict.subject, issue: 99 } };
      if (variant === "pr") priorVerdict = { ...priorVerdict, subject: { ...priorVerdict.subject, pr: 99 } };
      if (variant === "head-branch") priorVerdict = { ...priorVerdict, payload: { ...priorVerdict.payload, headBranch: "foreign-head" } };
      if (variant === "base-branch") priorVerdict = { ...priorVerdict, payload: { ...priorVerdict.payload, baseBranch: "release" } };
      if (variant === "delivery" || variant === "packet") {
        const changed = {
          ...validPlan,
          context: {
            ...validPlan.context,
            ...(variant === "delivery" ? { deliveryRunId: "foreign-delivery" } : { packetDigest: "f".repeat(64) }),
          },
        };
        const foreignPlan = { ...changed, planId: computeReviewPlanId(changed) };
        priorVerdict = { ...priorVerdict, payload: { ...priorVerdict.payload, reviewPlan: foreignPlan } };
      }
      if (variant === "plan-identity") {
        const changed = { ...validPlan, executionGroups: validPlan.executionGroups.map((group, index) => index ? group : { ...group, score: group.score + 1 }) };
        priorVerdict = { ...priorVerdict, payload: { ...priorVerdict.payload, reviewPlan: changed } };
      }
      if (variant === "head-lineage") priorVerdict = { ...priorVerdict, payload: { ...priorVerdict.payload, headSha: "c".repeat(40) } };
      const runtime = new FakeAgentRuntime([clean, clean]);
      const host = new FakeHost();
      if (variant === "head-lineage") {
        Object.defineProperty(host, "getChangedPathsBetween", { value: async () => { throw new Error("unknown revision"); } });
      }
      const artifactStore = new InMemoryArtifactRepository();
      await assert.rejects(
        reviewPullRequest({ run, pullRequest: pr, ...context, priorVerdict, workspace: process.cwd() }, {
          runtime, host, artifacts: artifactStore, runs,
        }),
        /Cannot use prior Review Verdict/,
        variant,
      );
      assert.equal(runtime.tasks.length, 0, variant);
      assert.equal(host.comments.length, 0, variant);
      assert.equal(artifactStore.artifacts.length, 0, variant);
    }
  });

  it("replans compatibility budgets missing new fields and cannot approve with zero reviewers", async () => {
    const runs = new InMemoryRunRepository();
    const run = await reviewingRun(runs);
    const context = artifacts(run);
    const planned = planReviewPanel({
      changedPaths: context.buildResult.payload.changedPaths,
      diff: await new FakeHost().getPullRequestDiff(), packet: context.packet, context: reviewPlanContext(run),
    });
    const { maxParallelSessions: _parallel, maxModelCalls: _modelCalls, ...legacyBudget } = planned.budget;
    const compatibilityCandidate = { ...planned, schemaVersion: 2, budget: legacyBudget } as unknown as ReviewPlan;
    const compatibilityPlan = { ...compatibilityCandidate, planId: computeReviewPlanId(compatibilityCandidate) };
    const priorVerdict = createArtifact({
      kind: "ReviewVerdict", runId: run.runId, subject: { ...run.subject, pr: pr.number }, producer: { role: "controller" },
      payload: {
        headSha: "b".repeat(40), headBranch: "fix", baseBranch: "main", disposition: "request_changes",
        reviewerRoles: ["correctness", "concurrency"], findings: [], checks: [], reviewPlan: compatibilityPlan,
      },
    });
    const runtime = new FakeAgentRuntime([clean, clean]);
    const result = await reviewPullRequest({ run, pullRequest: pr, ...context, priorVerdict, workspace: process.cwd() }, {
      runtime, host: new FakeHost(), artifacts: new InMemoryArtifactRepository(), runs,
    });
    assert.equal(result.verdict.payload.disposition, "approve");
    assert.notEqual(result.reviewPlan.planId, compatibilityPlan.planId);
    assert.equal(runtime.tasks.filter(({ role }) => role === "reviewer").length, result.reviewPlan.executionGroups.length);
    assert.ok(runtime.tasks.some(({ role }) => role === "reviewer"));
  });

  it("retries one operationally failed reviewer in fresh context without discarding successful peers", async () => {
    const runs = new InMemoryRunRepository();
    const run = await reviewingRun(runs);
    const context = artifacts(run);
    const runtime = new FakeAgentRuntime([
      async () => { throw new Error("read failed: optional path missing"); },
      clean,
      clean,
    ]);
    const result = await reviewPullRequest({ run, pullRequest: pr, ...context, workspace: process.cwd() }, {
      runtime, host: new FakeHost(), artifacts: new InMemoryArtifactRepository(), runs,
    });
    assert.equal(result.run.state, "merging");
    assert.equal(runtime.tasks.length, 3);
    const correctnessTasks = runtime.tasks.filter((task) => task.id.endsWith(":review-correctness"));
    assert.equal(correctnessTasks.length, 2);
    assert.equal(new Set(correctnessTasks.map(({ id }) => id)).size, 1);
    assert.ok(correctnessTasks[1]?.instructions.includes("previous operational attempt failed"));
  });

  it("does not repeat a reviewer request the provider has rejected for context size", async () => {
    const runs = new InMemoryRunRepository();
    const run = await reviewingRun(runs);
    const context = artifacts(run);
    const runtime = new FakeAgentRuntime([
      async () => { throw new Error("Your input exceeds the context window of this model"); },
      clean,
    ]);
    await assert.rejects(
      reviewPullRequest({ run, pullRequest: pr, ...context, workspace: process.cwd() }, {
        runtime, host: new FakeHost(), artifacts: new InMemoryArtifactRepository(), runs,
      }),
      /context window/,
    );
    assert.equal(runtime.tasks.length, 2);
    assert.equal(runtime.tasks.filter((task) => task.id.endsWith(":review-correctness")).length, 1);
  });

  it("does not spend a fresh reviewer attempt after the frozen evidence budget is exhausted", async () => {
    const runs = new InMemoryRunRepository();
    const run = await reviewingRun(runs);
    const context = artifacts(run);
    const runtime = new FakeAgentRuntime([
      async () => { throw new Error("Nested reviewer ended with tool_budget_exhausted"); },
      clean,
    ]);
    await assert.rejects(
      reviewPullRequest({ run, pullRequest: pr, ...context, workspace: process.cwd() }, {
        runtime, host: new FakeHost(), artifacts: new InMemoryArtifactRepository(), runs,
      }),
      /tool_budget_exhausted/,
    );
    assert.equal(runtime.tasks.length, 2);
    assert.equal(runtime.tasks.filter((task) => task.id.endsWith(":review-correctness")).length, 1);
    const progress = await runs.listProgress(run.runId);
    assert.ok(progress.some(({ message }) => message.includes("evidence budget was exhausted")));
  });

  it("resumes an incomplete persisted reviewer once before spending a fresh session", async () => {
    const resumedOutput: ReviewerSubmission = {
      summary: "Resumed with one advisory",
      findings: [{
        ...inScope,
        id: "resume-note", severity: "low", confidence: "high", blocking: false,
        title: "Document lock ownership", evidence: "Ownership is implicit", location: "src/lock.ts:5",
        intentRelevance: "Clarifies maintenance", remediation: "Add a focused comment",
      }],
    };
    class ResumableRuntime extends FakeAgentRuntime {
      readonly resumed: string[] = [];
      override async capabilities(): Promise<RuntimeCapabilities> {
        return { runtime: "fake", resumableSessions: true, tools: ["read", "grep", "find", "ls"] };
      }
      async resume<T>(sessionRef: string, task: AgentTask<T>): Promise<AgentRunResult<T>> {
        this.resumed.push(sessionRef);
        this.tasks.push(task as AgentTask<unknown>);
        return {
          output: resumedOutput as T,
          sessionRef: "resumed-session",
          sessionLineage: [sessionRef, "resumed-session"],
          provider: "fake",
          model: "scripted",
        };
      }
    }
    const runs = new InMemoryRunRepository();
    const run = await reviewingRun(runs);
    const context = artifacts(run);
    const runtime = new ResumableRuntime([
      async () => { throw new AgentRunError("WebSocket error before result", { sessionRef: "persisted-review", resumable: true }); },
      clean,
      acceptAdjudication,
    ]);
    const result = await reviewPullRequest({ run, pullRequest: pr, ...context, workspace: process.cwd() }, {
      runtime, host: new FakeHost(), artifacts: new InMemoryArtifactRepository(), runs,
    });
    assert.equal(result.run.state, "merging");
    assert.deepEqual(runtime.resumed, ["persisted-review"]);
    assert.deepEqual(result.verdict.payload.findings[0]?.sourceSessionRefs, ["persisted-review", "resumed-session"]);
    const correctnessTasks = runtime.tasks.filter((task) => task.id.endsWith(":review-correctness"));
    assert.equal(correctnessTasks.length, 2);
    assert.equal(new Set(correctnessTasks.map(({ id }) => id)).size, 1);
    assert.ok(correctnessTasks[1]?.instructions.includes("Continue only the persisted incomplete reviewer session"));
  });

  it("settles successful siblings, preserves their report, caps attempts at two, and issues no partial approval", async () => {
    const runs = new InMemoryRunRepository();
    const run = await reviewingRun(runs);
    const context = artifacts(run);
    const runtime = new FakeAgentRuntime([
      async () => { throw new Error("WebSocket error"); },
      clean,
      async () => { throw new Error("Nested reviewer transport failed: ECONNRESET"); },
    ]);
    const host = new FakeHost();
    const artifactStore = new InMemoryArtifactRepository();
    await assert.rejects(
      reviewPullRequest({ run, pullRequest: pr, ...context, workspace: process.cwd() }, {
        runtime, host, artifacts: artifactStore, runs,
      }),
      /Review incomplete.*successful reviewer reports were preserved and no partial approval was issued/,
    );
    assert.equal(runtime.tasks.length, 3);
    assert.ok([...new Set(runtime.tasks.map(({ id }) => id))].every((id) => runtime.tasks.filter((task) => task.id === id).length <= 2));
    assert.equal(host.comments.length, 1);
    assert.match(host.comments[0]?.body ?? "", /ForgeDock Review Evidence/);
    assert.match(host.comments[0]?.body ?? "", /wave is incomplete; no partial approval was issued/i);
    assert.equal(artifactStore.artifacts.some(({ kind }) => kind === "ReviewVerdict"), false);
    assert.equal((await runs.load(run.runId))?.state, "blocked");
    assert.equal(isTransientReviewerTransportFailure("read failed: optional path missing"), false);
    assert.equal(isTransientReviewerTransportFailure("Codex error: Our servers are currently overloaded"), true);
  });

  it("enforces the frozen reviewer-attempt budget across the whole wave", async () => {
    const runs = new InMemoryRunRepository();
    const run = await reviewingRun(runs);
    const context = artifacts(run);
    const planned = planReviewPanel({
      changedPaths: context.buildResult.payload.changedPaths, diff: await new FakeHost().getPullRequestDiff(), packet: context.packet,
      context: reviewPlanContext(run),
    });
    const budgeted = {
      ...planned,
      budget: {
        ...planned.budget,
        maxReviewerAttempts: planned.executionGroups.length,
        maxModelCalls: planned.executionGroups.length + planned.budget.maxScopeAdjudicationAttempts,
      },
    };
    const reviewPlan = { ...budgeted, planId: computeReviewPlanId(budgeted) };
    const priorVerdict = createArtifact({
      kind: "ReviewVerdict", runId: run.runId, subject: { ...run.subject, pr: pr.number }, producer: { role: "controller" },
      payload: { headSha: "b".repeat(40), headBranch: "fix", baseBranch: "main", disposition: "request_changes", reviewerRoles: ["correctness", "concurrency"], findings: [], checks: [], reviewPlan },
    });
    const runtime = new FakeAgentRuntime([async () => { throw new Error("first attempt failed"); }, clean]);
    await assert.rejects(
      reviewPullRequest({ run, pullRequest: pr, ...context, priorVerdict, workspace: process.cwd() }, {
        runtime, host: new FakeHost(), artifacts: new InMemoryArtifactRepository(), runs,
      }),
      /reviewer-attempt budget exhausted/,
    );
    assert.equal(runtime.tasks.length, planned.executionGroups.length);
  });

  it("enforces maxModelCalls independently of the reviewer-attempt ceiling", async () => {
    const runs = new InMemoryRunRepository();
    const run = await reviewingRun(runs);
    const context = artifacts(run);
    const planned = planReviewPanel({
      changedPaths: context.buildResult.payload.changedPaths, diff: await new FakeHost().getPullRequestDiff(), packet: context.packet,
      context: reviewPlanContext(run),
    });
    const budgeted = { ...planned, budget: { ...planned.budget, maxModelCalls: planned.executionGroups.length } };
    const reviewPlan = { ...budgeted, planId: computeReviewPlanId(budgeted) };
    const priorVerdict = createArtifact({
      kind: "ReviewVerdict", runId: run.runId, subject: { ...run.subject, pr: pr.number }, producer: { role: "controller" },
      payload: { headSha: "b".repeat(40), headBranch: "fix", baseBranch: "main", disposition: "request_changes", reviewerRoles: ["correctness", "concurrency"], findings: [], checks: [], reviewPlan },
    });
    const runtime = new FakeAgentRuntime([async () => { throw new Error("first attempt failed"); }, clean]);
    await assert.rejects(
      reviewPullRequest({ run, pullRequest: pr, ...context, priorVerdict, workspace: process.cwd() }, {
        runtime, host: new FakeHost(), artifacts: new InMemoryArtifactRepository(), runs,
      }),
      /model-call budget exhausted/,
    );
    assert.equal(runtime.tasks.length, planned.executionGroups.length);
  });

  it("uses maxScopeAdjudicationAttempts as the actual adjudicator-loop limit", async () => {
    const runs = new InMemoryRunRepository();
    const run = await reviewingRun(runs);
    const context = artifacts(run);
    const planned = planReviewPanel({
      changedPaths: context.buildResult.payload.changedPaths, diff: await new FakeHost().getPullRequestDiff(), packet: context.packet,
      context: reviewPlanContext(run),
    });
    const budgeted = {
      ...planned,
      budget: { ...planned.budget, maxScopeAdjudicationAttempts: 1, maxModelCalls: planned.budget.maxReviewerAttempts + 1 },
    };
    const reviewPlan = { ...budgeted, planId: computeReviewPlanId(budgeted) };
    const priorVerdict = createArtifact({
      kind: "ReviewVerdict", runId: run.runId, subject: { ...run.subject, pr: pr.number }, producer: { role: "controller" },
      payload: { headSha: "b".repeat(40), headBranch: "fix", baseBranch: "main", disposition: "approve", reviewerRoles: ["correctness", "concurrency"], findings: [], checks: [], reviewPlan },
    });
    const finding = {
      ...inScope, id: "budget-scope", severity: "high" as const, confidence: "high" as const, blocking: true,
      title: "Guard fails", evidence: "Returns false", location: "src/lock.ts:1", intentRelevance: "Breaks criterion", remediation: "Fix guard",
    };
    const runtime = new FakeAgentRuntime([{ summary: "finding", findings: [finding] }, clean, { decisions: [] }]);
    await assert.rejects(
      reviewPullRequest({ run, pullRequest: pr, ...context, priorVerdict, workspace: process.cwd() }, {
        runtime, host: new FakeHost(), artifacts: new InMemoryArtifactRepository(), runs,
      }),
      /Scope adjudication omitted finding/,
    );
    assert.equal(runtime.tasks.filter(({ role }) => role === "adjudicator").length, 1);
  });

  it("bounds a hanging reviewer attempt and records retry progress", async () => {
    class HangingRuntime extends FakeAgentRuntime {
      override async run<T>(task: AgentTask<T>, options: { signal?: AbortSignal; onEvent?: AgentEventSink } = {}): Promise<AgentRunResult<T>> {
        this.tasks.push(task as AgentTask<unknown>);
        return new Promise<AgentRunResult<T>>((_, reject) => {
          const abort = () => reject(options.signal?.reason ?? new Error("aborted"));
          options.signal?.addEventListener("abort", abort, { once: true });
          if (options.signal?.aborted) abort();
        });
      }
    }
    const runs = new InMemoryRunRepository();
    const run = await reviewingRun(runs);
    const context = artifacts(run);
    const runtime = new HangingRuntime();
    await assert.rejects(
      reviewPullRequest({
        run, pullRequest: pr, ...context, workspace: process.cwd(), maxReviewSpecialists: 1, reviewerAttemptTimeoutMs: 25,
      }, { runtime, host: new FakeHost(), artifacts: new InMemoryArtifactRepository(), runs }),
      /timed out after 25ms/,
    );
    assert.equal(runtime.tasks.length, 4);
    assert.ok([...new Set(runtime.tasks.map(({ id }) => id))].every((id) => runtime.tasks.filter((task) => task.id === id).length === 2));
    const progress = await runs.listProgress(run.runId);
    assert.ok(progress.some(({ message }) => message.includes("timed out")));
    assert.ok(progress.some(({ message }) => message.includes("fresh retry 2/2 scheduled")));
  });

  it("accepts a successful late result after abort without overlapping a retry", async () => {
    class AbortIgnoringLateRuntime extends FakeAgentRuntime {
      abortedAttempts = 0;

      override async run<T>(task: AgentTask<T>, options: { signal?: AbortSignal; onEvent?: AgentEventSink } = {}): Promise<AgentRunResult<T>> {
        this.tasks.push(task as AgentTask<unknown>);
        const sessionRef = `late-session-${this.tasks.length}`;
        options.onEvent?.({ type: "session.started", taskId: task.id, sessionRef, provider: "fake", model: "late" });
        await new Promise<void>((resolve) => setTimeout(resolve, 35));
        if (options.signal?.aborted) this.abortedAttempts++;
        options.onEvent?.({ type: "artifact.submitted", taskId: task.id });
        options.onEvent?.({ type: "session.completed", taskId: task.id, sessionRef });
        return { output: clean as T, sessionRef, provider: "fake", model: "late" };
      }
    }

    const runs = new InMemoryRunRepository();
    const run = await reviewingRun(runs);
    const context = artifacts(run);
    const runtime = new AbortIgnoringLateRuntime();
    const result = await reviewPullRequest({
      run, pullRequest: pr, ...context, workspace: process.cwd(), maxReviewSpecialists: 1, reviewerAttemptTimeoutMs: 10,
    }, { runtime, host: new FakeHost(), artifacts: new InMemoryArtifactRepository(), runs });

    assert.equal(result.run.state, "merging");
    assert.equal(runtime.abortedAttempts, result.reviewPlan.executionGroups.length);
    assert.equal(runtime.tasks.length, result.reviewPlan.executionGroups.length);
    assert.ok([...new Set(runtime.tasks.map(({ id }) => id))].every((id) => runtime.tasks.filter((task) => task.id === id).length === 1));
    assert.deepEqual(result.sessionRefs.sort(), ["late-session-1", "late-session-2"]);
    const progress = await runs.listProgress(run.runId);
    assert.equal(progress.some(({ message }) => message.includes("retry 2/2 scheduled")), false);
  });

  it("does not resume a terminal non-resumable provider failure received during timeout drain", async () => {
    class NonResumableDrainFailureRuntime extends FakeAgentRuntime {
      readonly attempts = new Map<string, number>();
      resumeCalls = 0;

      override async capabilities(): Promise<RuntimeCapabilities> {
        return { runtime: "fake", resumableSessions: true, tools: ["read", "grep", "find", "ls"] };
      }

      async resume<T>(): Promise<AgentRunResult<T>> {
        this.resumeCalls++;
        throw new Error("A terminal provider failure must not be resumed");
      }

      override async run<T>(task: AgentTask<T>, options: { signal?: AbortSignal; onEvent?: AgentEventSink } = {}): Promise<AgentRunResult<T>> {
        this.tasks.push(task as AgentTask<unknown>);
        const attempt = (this.attempts.get(task.id) ?? 0) + 1;
        this.attempts.set(task.id, attempt);
        const sessionRef = `terminal-${task.id}-${attempt}`;
        options.onEvent?.({ type: "session.started", taskId: task.id, sessionRef, provider: "fake", model: "terminal" });
        if (attempt === 1) {
          await new Promise<void>((resolve) => setTimeout(resolve, 20));
          throw new AgentRunError("provider rejected the session as terminal", { sessionRef, resumable: false });
        }
        return { output: clean as T, sessionRef, provider: "fake", model: "terminal" };
      }
    }

    const runs = new InMemoryRunRepository();
    const run = await reviewingRun(runs);
    const context = artifacts(run);
    const runtime = new NonResumableDrainFailureRuntime();
    const result = await reviewPullRequest({
      run, pullRequest: pr, ...context, workspace: process.cwd(), maxReviewSpecialists: 1, reviewerAttemptTimeoutMs: 10,
    }, { runtime, host: new FakeHost(), artifacts: new InMemoryArtifactRepository(), runs });

    assert.equal(result.run.state, "merging");
    assert.equal(runtime.resumeCalls, 0);
    assert.ok([...runtime.attempts.values()].every((attempts) => attempts === 2));
  });

  it("durably reconciles a successful same-plan result that arrives after the bounded drain", async () => {
    class PostDrainRuntime extends FakeAgentRuntime {
      returned = 0;
      readonly allReturned: Promise<void>;
      private resolveAllReturned!: () => void;

      constructor() {
        super();
        this.allReturned = new Promise<void>((resolve) => { this.resolveAllReturned = resolve; });
      }

      override async run<T>(task: AgentTask<T>, options: { signal?: AbortSignal; onEvent?: AgentEventSink } = {}): Promise<AgentRunResult<T>> {
        this.tasks.push(task as AgentTask<unknown>);
        const sessionRef = `post-drain-session-${this.tasks.length}`;
        // The provider ignores abort and does not reveal its session identity
        // until after timeout + the 100ms minimum drain have both elapsed.
        await new Promise<void>((resolve) => setTimeout(resolve, 125));
        options.onEvent?.({ type: "session.started", taskId: task.id, sessionRef, provider: "fake", model: "post-drain" });
        await new Promise<void>((resolve) => setTimeout(resolve, 20));
        options.onEvent?.({ type: "artifact.submitted", taskId: task.id });
        options.onEvent?.({ type: "session.completed", taskId: task.id, sessionRef });
        this.returned++;
        if (this.returned === 2) this.resolveAllReturned();
        return { output: clean as T, sessionRef, provider: "fake", model: "post-drain" };
      }
    }

    const runs = new InMemoryRunRepository();
    const run = await reviewingRun(runs);
    const context = artifacts(run);
    const runtime = new PostDrainRuntime();
    const host = new FakeHost();

    await assert.rejects(
      reviewPullRequest({
        run, pullRequest: pr, ...context, workspace: process.cwd(), maxReviewSpecialists: 1, reviewerAttemptTimeoutMs: 10,
      }, { runtime, host, artifacts: new InMemoryArtifactRepository(), runs }),
      /did not settle within the 100ms drain window/,
    );
    assert.equal(runtime.tasks.length, 2);
    assert.ok([...new Set(runtime.tasks.map(({ id }) => id))].every((id) => runtime.tasks.filter((task) => task.id === id).length === 1));

    await runtime.allReturned;
    for (let attempt = 0; attempt < 20 && host.comments.filter(({ body }) => body.includes("completed after the bounded drain")).length < 2; attempt++) {
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
    const lateComments = host.comments.filter(({ body }) => body.includes("completed after the bounded drain"));
    assert.equal(lateComments.length, 2);
    assert.ok(lateComments.every(({ body }) => /Frozen review plan:\*\* `review-plan-[a-f0-9]{20}`/.test(body)));
    assert.ok(lateComments.every(({ body }) => body.includes("post-drain-session-")));
    const progress = await runs.listProgress(run.runId);
    assert.ok(progress.some(({ message }) => message.includes("late session identity reconciled after bounded drain")));
    assert.equal(progress.filter(({ message }) => message.includes("late completion reconciled after bounded drain")).length, 2);
  });

  it("durably reconciles a successful late scope adjudication for the same frozen plan", async () => {
    const finding = {
      ...inScope,
      id: "late-scope-finding",
      severity: "high" as const,
      confidence: "high" as const,
      blocking: true,
      title: "Guarded write can escape the lock",
      evidence: "The guarded write occurs after the lock is released.",
      location: "src/lock.ts:20",
      intentRelevance: "Breaks Concurrent updates pass",
      remediation: "Keep the write inside the lock.",
    };

    class PostDrainAdjudicationRuntime extends FakeAgentRuntime {
      reviewerCalls = 0;
      readonly adjudicationReturned: Promise<void>;
      private resolveAdjudicationReturned!: () => void;

      constructor() {
        super();
        this.adjudicationReturned = new Promise<void>((resolve) => { this.resolveAdjudicationReturned = resolve; });
      }

      override async run<T>(task: AgentTask<T>, options: { signal?: AbortSignal; onEvent?: AgentEventSink } = {}): Promise<AgentRunResult<T>> {
        this.tasks.push(task as AgentTask<unknown>);
        if (task.role !== "adjudicator") {
          this.reviewerCalls++;
          const sessionRef = `reviewer-${this.reviewerCalls}`;
          options.onEvent?.({ type: "session.started", taskId: task.id, sessionRef, provider: "fake", model: "late-scope" });
          const output = (this.reviewerCalls === 1 ? { summary: "blocking finding", findings: [finding] } : clean) as T;
          return { output, sessionRef, provider: "fake", model: "late-scope" };
        }

        const sessionRef = "post-drain-scope-session";
        await new Promise<void>((resolve) => setTimeout(resolve, 125));
        options.onEvent?.({ type: "session.started", taskId: task.id, sessionRef, provider: "fake", model: "late-scope" });
        await new Promise<void>((resolve) => setTimeout(resolve, 20));
        const output = acceptAdjudication(task) as T;
        this.resolveAdjudicationReturned();
        return { output, sessionRef, provider: "fake", model: "late-scope" };
      }
    }

    const runs = new InMemoryRunRepository();
    const run = await reviewingRun(runs);
    const context = artifacts(run);
    const runtime = new PostDrainAdjudicationRuntime();
    const host = new FakeHost();

    await assert.rejects(
      reviewPullRequest({
        run, pullRequest: pr, ...context, workspace: process.cwd(), maxReviewSpecialists: 1, reviewerAttemptTimeoutMs: 10,
      }, { runtime, host, artifacts: new InMemoryArtifactRepository(), runs }),
      /scope-adjudication.*did not settle within the 100ms drain window/,
    );
    assert.equal(runtime.tasks.filter(({ role }) => role === "adjudicator").length, 1);

    await runtime.adjudicationReturned;
    for (let attempt = 0; attempt < 20 && !host.comments.some(({ body }) => body.includes("Late Scope Adjudication")); attempt++) {
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
    const lateComment = host.comments.find(({ body }) => body.includes("Late Scope Adjudication"));
    assert.ok(lateComment);
    assert.match(lateComment.body, /Frozen review plan:\*\* `review-plan-[a-f0-9]{20}`/);
    assert.match(lateComment.body, /post-drain-scope-session/);
    assert.match(lateComment.body, /:\*\* accept - Directly required by the frozen criterion/);
    const progress = await runs.listProgress(run.runId);
    assert.ok(progress.some(({ message }) => message.includes("late session identity reconciled after bounded drain")));
    assert.ok(progress.some(({ message }) => message.includes("late scope adjudication reconciled after bounded drain")));
  });

  it("runs independently selected reviewer roles concurrently", async () => {
    const runs = new InMemoryRunRepository();
    const run = await reviewingRun(runs);
    const context = artifacts(run);
    let active = 0;
    let maxActive = 0;
    let release!: () => void;
    const bothStarted = new Promise<void>((resolve) => { release = resolve; });
    const response = async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      if (active === 2) release();
      await bothStarted;
      active--;
      return clean;
    };
    const runtime = new FakeAgentRuntime([response, response]);
    await reviewPullRequest({ run, pullRequest: pr, ...context, workspace: process.cwd() }, {
      runtime, host: new FakeHost(), artifacts: new InMemoryArtifactRepository(), runs,
    });
    assert.equal(maxActive, 2);
  });

  it("enforces maxParallelSessions without changing the frozen groups", async () => {
    const runs = new InMemoryRunRepository();
    const run = await reviewingRun(runs);
    const context = artifacts(run);
    const planned = planReviewPanel({
      changedPaths: context.buildResult.payload.changedPaths, diff: await new FakeHost().getPullRequestDiff(), packet: context.packet,
      context: reviewPlanContext(run),
    });
    const limited = { ...planned, budget: { ...planned.budget, maxParallelSessions: 1 } };
    const reviewPlan = { ...limited, planId: computeReviewPlanId(limited) };
    const priorVerdict = createArtifact({
      kind: "ReviewVerdict", runId: run.runId, subject: { ...run.subject, pr: pr.number }, producer: { role: "controller" },
      payload: { headSha: "b".repeat(40), headBranch: "fix", baseBranch: "main", disposition: "approve", reviewerRoles: ["correctness", "concurrency"], findings: [], checks: [], reviewPlan },
    });
    let active = 0;
    let maxActive = 0;
    const response = async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
      return clean;
    };
    await reviewPullRequest({ run, pullRequest: pr, ...context, priorVerdict, workspace: process.cwd() }, {
      runtime: new FakeAgentRuntime([response, response]), host: new FakeHost(), artifacts: new InMemoryArtifactRepository(), runs,
    });
    assert.equal(maxActive, 1);
  });

  it("publishes the folded reviewer wave and finding issue before the consolidated verdict", async () => {
    const runs = new InMemoryRunRepository();
    const run = await reviewingRun(runs);
    const context = artifacts(run);
    const events: string[] = [];
    const host = new FakeHost(events);
    const finding = {
      ...inScope,
      id: "ordered-1", severity: "high" as const, confidence: "high" as const, blocking: false,
      title: "Follow-up documentation", evidence: "One edge case is not documented", location: "src/lock.ts:20",
      intentRelevance: "Clarifies the accepted behavior", remediation: "Add a focused note",
    };
    const runtime = new FakeAgentRuntime([{ summary: "Advisory", findings: [finding] }, clean, acceptAdjudication]);
    const backing = new InMemoryArtifactRepository();
    const projectedArtifacts = {
      append: async (artifact: Parameters<typeof backing.append>[0]) => {
        events.push(`artifact:${artifact.kind}`);
        await backing.append(artifact);
      },
      list: backing.list.bind(backing),
    };
    await reviewPullRequest({ run, pullRequest: pr, ...context, workspace: process.cwd() }, {
      runtime, host, artifacts: projectedArtifacts, runs,
    });
    const verdictIndex = events.indexOf("artifact:ReviewVerdict");
    const issueIndex = events.findIndex((event) => event.startsWith("issue:"));
    assert.equal(events.filter((event) => event.startsWith("comment:")).length, 1);
    assert.ok(issueIndex > Math.max(...events.map((event, index) => event.startsWith("comment:") ? index : -1)));
    assert.ok(verdictIndex > issueIndex);
  });

  it("materializes each controller-accepted root cause as independently actionable work", async () => {
    const runs = new InMemoryRunRepository();
    const run = await reviewingRun(runs);
    const host = new FakeHost();
    const roots = ["root-a", "root-b"].map((id, index) => ({
      ...inScope,
      id,
      severity: "high" as const,
      confidence: "high" as const,
      blocking: true,
      title: `Root cause ${index + 1}`,
      evidence: `Anchored evidence ${index + 1}`,
      location: `src/lock.ts:${20 + index}`,
      intentRelevance: "Breaks the guarded update",
      remediation: `Fix root ${index + 1}`,
      sourceFindingIds: [`correctness:${id}`],
      reviewerRoles: ["correctness"],
    }));
    await materializeReviewFindings({ run, pullRequest: pr, findings: roots }, host);
    assert.deepEqual(host.findingIssues.map(({ finding }) => finding.id), ["root-a", "root-b"]);
  });

  it("reconciles the same individual root identities it materializes", async () => {
    const runs = new InMemoryRunRepository();
    const run = await reviewingRun(runs);
    const context = artifacts(run);
    const findings = ["root-a", "root-b"].map((id, index) => ({
      ...inScope,
      id,
      causalRoot: `independent root ${index}`,
      severity: "high" as const,
      confidence: "high" as const,
      blocking: true,
      title: `Root ${index}`,
      evidence: `Evidence ${index}`,
      location: `src/lock.ts:${index + 1}`,
      intentRelevance: "Breaks criterion",
      remediation: `Fix ${index}`,
    }));
    const host = new FakeHost();
    await reviewPullRequest({ run, pullRequest: pr, ...context, workspace: process.cwd() }, {
      runtime: new FakeAgentRuntime([{ summary: "two roots", findings }, clean, acceptAdjudication]),
      host, artifacts: new InMemoryArtifactRepository(), runs,
    });
    assert.equal(host.findingIssues.length, 2);
    assert.equal(host.reconciliations.length, 1);
    assert.deepEqual(host.reconciliations[0]?.activeFindings.map(({ id }) => id), host.findingIssues.map(({ finding }) => finding.id));
  });

  for (const severity of ["high", "medium"] as const) {
    it(`applies central confidence/corroboration policy to ${severity}-severity evidence`, async () => {
      const runs = new InMemoryRunRepository();
      const run = await reviewingRun(runs);
      const context = artifacts(run);
      const finding = {
        ...inScope,
        id: "f1", severity, confidence: "high" as const, blocking: false,
        title: "Lock releases before write", evidence: "src/lock.ts releases before await save", location: "src/lock.ts:20",
        intentRelevance: "Reintroduces the reported race", remediation: "Keep save inside lock",
      };
      const runtime = new FakeAgentRuntime([{ summary: "Blocking", findings: [finding] }, clean, acceptAdjudication]);
      const host = new FakeHost();
      const result = await reviewPullRequest({ run, pullRequest: pr, ...context, workspace: process.cwd() }, {
        runtime, host, artifacts: new InMemoryArtifactRepository(), runs,
      });
      const expectedBlocking = severity === "high";
      assert.equal(result.run.state, expectedBlocking ? "remediating" : "merging");
      assert.equal(result.verdict.payload.findings[0]?.blocking, expectedBlocking);
      assert.deepEqual(result.verdict.payload.findings[0]?.reviewerRoles, ["correctness"]);
      assert.deepEqual(result.verdict.payload.findings[0]?.sourceFindingIds, ["correctness:f1"]);
      assert.equal(result.verdict.payload.findings[0]?.sourceSessionRefs?.length, 1);
      assert.equal(host.findingIssues.length, 1);
      assert.deepEqual(host.findingIssues[0]?.reviewerRoles, ["correctness"]);
    });
  }

  it("lets an independent scope adjudicator prevent a plausible adjacent concern from blocking delivery", async () => {
    const runs = new InMemoryRunRepository();
    const run = await reviewingRun(runs);
    const context = artifacts(run);
    const finding = {
      ...inScope,
      id: "adjacent-1", severity: "high" as const, confidence: "high" as const, blocking: true,
      title: "Adjacent lease protocol is incomplete", evidence: "The lease profile lacks takeover", location: "src/lock.ts:20",
      intentRelevance: "Adjacent to the guarded update", remediation: "Define a new takeover protocol",
    };
    const host = new FakeHost();
    const result = await reviewPullRequest({ run, pullRequest: pr, ...context, workspace: process.cwd() }, {
      runtime: new FakeAgentRuntime([{ summary: "Adjacent concern", findings: [finding] }, clean, followUpAdjudication]),
      host, artifacts: new InMemoryArtifactRepository(), runs,
    });
    assert.equal(result.run.state, "merging");
    assert.equal(result.verdict.payload.findings[0]?.blocking, false);
    assert.equal(result.verdict.payload.findings[0]?.scopeDisposition, "follow_up");
    assert.equal(result.verdict.payload.scopeAdjudication?.decisions[0]?.disposition, "follow_up");
    assert.equal(host.findingIssues.length, 1);
  });

  it("renders bounded provisional reviewer reports without allowing nested comment markers", () => {
    const body = renderReviewerSubmissionComment({
      runId: "run-1", pullRequest: 4, headSha: sha, role: "security",
      submission: {
        summary: "Checked trust boundaries <!-- injected -->",
        findings: [{
          ...inScope,
          id: "security-1", severity: "low", confidence: "medium", blocking: false,
          title: "Advisory", evidence: "Evidence", location: "src/lock.ts:2",
          intentRelevance: "Relevant", remediation: "Document it",
        }],
      },
    });
    assert.match(body, /ForgeDock Independent Review · security/);
    assert.match(body, /Provisional report/);
    assert.match(body, /FORGEDOCK:REVIEWER-SUBMISSION v1/);
    assert.doesNotMatch(body, /<!-- injected -->/);
    const bounded = renderReviewerSubmissionComment({
      runId: "run-1", pullRequest: 4, headSha: sha, role: "security",
      submission: {
        summary: "large report",
        findings: Array.from({ length: 10 }, (_, index) => ({
          ...inScope,
          id: `large-${index}`, severity: "low" as const, confidence: "medium" as const, blocking: false,
          title: `Finding ${index}`, evidence: "e".repeat(8_000), intentRelevance: "i".repeat(4_000), remediation: "r".repeat(4_000),
        })),
      },
    });
    assert.ok(bounded.length <= 60_000);
    assert.match(bounded, /projection truncated/);
    assert.match(bounded, /FORGEDOCK:REVIEWER-SUBMISSION v1/);
  });

  it("renders one bounded review-wave projection for many execution groups", () => {
    const body = renderReviewerWaveComment({
      runId: "run-wave", pullRequest: 4, headSha: sha, reviewPlanId: "review-plan-1234567890abcdef1234",
      results: Array.from({ length: 16 }, (_, index) => ({
        executionGroupId: `review-correctness-part-${index + 1}-of-16`, role: "correctness" as const,
        output: { summary: `Shard ${index + 1}`, findings: [] }, sessionRef: `session-${index + 1}`, sessionLineage: [`session-${index + 1}`],
      })),
      failures: [],
    });
    assert.ok(body.length <= 60_000);
    assert.equal((body.match(/<details><summary>/g) ?? []).length, 16);
    assert.match(body, /FORGEDOCK:REVIEW-WAVE v1/);
  });

  it("requires causalRoot in current reviewer submissions", () => {
    const finding = {
      ...inScope,
      id: "schema-1", severity: "high" as const, confidence: "high" as const, blocking: true,
      title: "Guard fails", evidence: "Returns false", location: "src/lock.ts:1",
      intentRelevance: "Breaks the criterion", remediation: "Fix the guard",
    };
    assert.equal(Check(ReviewerSubmissionSchema, { summary: "current", findings: [finding] }), true);
    const { causalRoot: _causalRoot, ...legacyShape } = finding;
    assert.equal(Check(ReviewerSubmissionSchema, { summary: "missing root", findings: [legacyShape] }), false);
  });

  it("validates reviewer attempt timeout overrides", () => {
    assert.equal(resolveReviewerAttemptTimeoutMs(), undefined);
    assert.equal(resolveReviewerAttemptTimeoutMs(25), 25);
    assert.throws(() => resolveReviewerAttemptTimeoutMs(0), /must be an integer/);
    assert.throws(() => resolveReviewerAttemptTimeoutMs(Number.MAX_SAFE_INTEGER), /must be an integer/);
  });

  it("selects specialists from changed surfaces instead of a fixed fleet", () => {
    const run = createRun({ workflow: "work-on", subject: { repo: "a/b", issue: 1 } });
    const { packet } = artifacts(run);
    assert.deepEqual(selectReviewerRoles([".github/workflows/ci.yml", "db/migration.sql"], packet), ["correctness", "data", "infrastructure", "concurrency"]);
  });

  it("does not fan out specialists for substrings inside repository URLs or metadata prose", () => {
    const run = createRun({ workflow: "work-on", subject: { repo: "a/b", issue: 1 } });
    const { packet } = artifacts(run);
    const neutralPacket = {
      ...packet,
      payload: { ...packet.payload, risks: [{ risk: "Keep metadata unchanged", mitigation: "Link RapierCraftStudios/ForgeDockCLI#5" }] },
    };
    assert.deepEqual(selectReviewerRoles(["docs/pipeline-probes/decomposition-alpha.md"], neutralPacket), ["correctness"]);
  });
});
