import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createArtifact } from "../../core/artifacts/schema.js";
import type { ForgeHost, PullRequestSnapshot } from "../../core/ports/forge-host.js";
import { InMemoryArtifactRepository, InMemoryRunRepository } from "../../core/ports/repositories.js";
import { createRun, transition, type RunState, type TransitionEvent } from "../../core/state/machine.js";
import { AgentRunError, type AgentRunResult, type AgentTask, type RuntimeCapabilities } from "../../runtime/agent-runtime.js";
import { FakeAgentRuntime } from "../../runtime/fake-runtime.js";
import { isTransientReviewerTransportFailure, renderReviewerSubmissionComment, reviewPullRequest, selectReviewerRoles, type ReviewerSubmission } from "./review.js";

const sha = "a".repeat(40);
const pr: PullRequestSnapshot = { repo: "a/b", number: 4, title: "Fix race", body: "", url: "https://github.test/a/b/pull/4", state: "OPEN", headSha: sha, headBranch: "fix", baseBranch: "main" };

class FakeHost implements ForgeHost {
  snapshots: PullRequestSnapshot[] = [pr, pr];
  comments: Array<{ marker: string; body: string }> = [];
  findingIssues: Array<{ finding: { id: string }; reviewerRoles: readonly string[] }> = [];
  constructor(readonly events?: string[]) {}
  async materializeDecomposition() { return []; }
  async createPullRequest(): Promise<PullRequestSnapshot> { return pr; }
  async getPullRequest(): Promise<PullRequestSnapshot> { return this.snapshots.shift() ?? pr; }
  async getPullRequestDiff(): Promise<string> { return "diff --git a/src/lock.ts b/src/lock.ts\n+await lock.run(update)"; }
  async publishPullRequestComment(input: { marker: string; body: string }): Promise<void> {
    this.comments.push(input);
    this.events?.push(`comment:${/Independent Review · ([^\n]+)/.exec(input.body)?.[1] ?? "unknown"}`);
  }
  async materializeReviewFinding(input: { finding: { id: string }; reviewerRoles: readonly string[] }) {
    this.findingIssues.push(input);
    this.events?.push(`issue:${input.finding.id}`);
    const number = 100 + this.findingIssues.length;
    return { repo: pr.repo, number, title: input.finding.id, body: "", url: `https://github.test/a/b/issues/${number}`, state: "OPEN" as const };
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
    branch: "fix", headSha: sha, changedPaths: ["src/lock.ts"], summary: "Locked", acceptanceEvidence: [{ criterion: "Concurrent updates pass", status: "passed", evidence: "test" }], checks: [{ command: "npm test", status: "passed", exitCode: 0, durationMs: 1 }], decisions: [], residualRisks: [],
  } });
  return { intent, investigation, packet, buildResult };
}

const clean: ReviewerSubmission = { summary: "No blocking defects", findings: [] };

describe("fresh-context PR review", () => {
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
    assert.equal(new Set(result.sessionRefs).size, 2);
    assert.equal(host.comments.length, 2);
    assert.deepEqual(host.comments.map(({ body }) => /Independent Review · ([^\n]+)/.exec(body)?.[1]).sort(), ["concurrency", "correctness"]);
    assert.ok(host.comments.every(({ body, marker }) => body.includes(marker) && body.includes("consolidated Review Verdict remains authoritative") && body.includes("Session lineage")));
    assert.ok(runtime.tasks.every((task) => task.workspace.mode === "read-only" && !task.tools.includes("edit")));
  });

  it("launches one bounded adaptive escalation wave when correctness exposes a new specialist surface", async () => {
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
        id: "lease-1", severity: "high", confidence: "high", blocking: true,
        title: "Stale lease holder can commit", evidence: "A reassigned worker is not fenced", location: "src/worker.ts:20",
        intentRelevance: "Permits stale writes", remediation: "Fence commits with the active lease epoch",
      }],
    }, clean]);
    const result = await reviewPullRequest({
      run, pullRequest: pr, intent: context.intent, investigation: context.investigation,
      packet: packetWithoutConcurrency, buildResult, workspace: process.cwd(), maxReviewSpecialists: 1,
    }, { runtime, host: new PlainHost(), artifacts: new InMemoryArtifactRepository(), runs });
    assert.deepEqual(result.reviewPlan.selected.map(({ role }) => role), ["correctness", "concurrency"]);
    assert.equal(runtime.tasks.length, 2);
    assert.ok(runtime.tasks.some((task) => task.id.includes(":concurrency")));
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
    assert.ok(runtime.tasks.some((task) => task.id.endsWith(":retry-2")));
    assert.ok(runtime.tasks.find((task) => task.id.endsWith(":retry-2"))?.instructions.includes("previous operational attempt failed"));
  });

  it("resumes an incomplete persisted reviewer once before spending a fresh session", async () => {
    const resumedOutput: ReviewerSubmission = {
      summary: "Resumed with one advisory",
      findings: [{
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
    ]);
    const result = await reviewPullRequest({ run, pullRequest: pr, ...context, workspace: process.cwd() }, {
      runtime, host: new FakeHost(), artifacts: new InMemoryArtifactRepository(), runs,
    });
    assert.equal(result.run.state, "merging");
    assert.deepEqual(runtime.resumed, ["persisted-review"]);
    assert.deepEqual(result.verdict.payload.findings[0]?.sourceSessionRefs, ["persisted-review", "resumed-session"]);
    assert.equal(runtime.tasks.filter((task) => task.id.includes(":correctness")).length, 2);
    assert.ok(runtime.tasks.some((task) => task.id.endsWith(":correctness:resume")));
  });

  it("uses additional fresh attempts for transient reviewer transport failures", async () => {
    const runs = new InMemoryRunRepository();
    const run = await reviewingRun(runs);
    const context = artifacts(run);
    const runtime = new FakeAgentRuntime([
      async () => { throw new Error("WebSocket error"); },
      clean,
      async () => { throw new Error("Nested reviewer transport failed: ECONNRESET"); },
      clean,
    ]);
    const result = await reviewPullRequest({ run, pullRequest: pr, ...context, workspace: process.cwd() }, {
      runtime, host: new FakeHost(), artifacts: new InMemoryArtifactRepository(), runs,
    });
    assert.equal(result.run.state, "merging");
    assert.equal(runtime.tasks.length, 4);
    assert.ok(runtime.tasks.some((task) => task.id.endsWith(":retry-3")));
    assert.equal(isTransientReviewerTransportFailure("read failed: optional path missing"), false);
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

  it("publishes every reviewer report and finding issue before the consolidated verdict", async () => {
    const runs = new InMemoryRunRepository();
    const run = await reviewingRun(runs);
    const context = artifacts(run);
    const events: string[] = [];
    const host = new FakeHost(events);
    const finding = {
      id: "ordered-1", severity: "low" as const, confidence: "high" as const, blocking: false,
      title: "Follow-up documentation", evidence: "One edge case is not documented", location: "src/lock.ts:20",
      intentRelevance: "Clarifies the accepted behavior", remediation: "Add a focused note",
    };
    const runtime = new FakeAgentRuntime([{ summary: "Advisory", findings: [finding] }, clean]);
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
    assert.equal(events.filter((event) => event.startsWith("comment:")).length, 2);
    assert.ok(issueIndex > Math.max(...events.map((event, index) => event.startsWith("comment:") ? index : -1)));
    assert.ok(verdictIndex > issueIndex);
  });

  for (const severity of ["high", "medium"] as const) {
    it(`makes ${severity}-severity evidence blocking regardless of the model's blocking flag`, async () => {
      const runs = new InMemoryRunRepository();
      const run = await reviewingRun(runs);
      const context = artifacts(run);
      const finding = {
        id: "f1", severity, confidence: "high" as const, blocking: false,
        title: "Lock releases before write", evidence: "src/lock.ts releases before await save", location: "src/lock.ts:20",
        intentRelevance: "Reintroduces the reported race", remediation: "Keep save inside lock",
      };
      const runtime = new FakeAgentRuntime([{ summary: "Blocking", findings: [finding] }, clean]);
      const host = new FakeHost();
      const result = await reviewPullRequest({ run, pullRequest: pr, ...context, workspace: process.cwd() }, {
        runtime, host, artifacts: new InMemoryArtifactRepository(), runs,
      });
      assert.equal(result.run.state, "remediating");
      assert.equal(result.verdict.payload.findings[0]?.blocking, true);
      assert.deepEqual(result.verdict.payload.findings[0]?.reviewerRoles, ["correctness"]);
      assert.deepEqual(result.verdict.payload.findings[0]?.sourceFindingIds, ["correctness:f1"]);
      assert.equal(result.verdict.payload.findings[0]?.sourceSessionRefs?.length, 1);
      assert.equal(host.findingIssues.length, 1);
      assert.deepEqual(host.findingIssues[0]?.reviewerRoles, ["correctness"]);
    });
  }

  it("renders bounded provisional reviewer reports without allowing nested comment markers", () => {
    const body = renderReviewerSubmissionComment({
      runId: "run-1", pullRequest: 4, headSha: sha, role: "security",
      submission: {
        summary: "Checked trust boundaries <!-- injected -->",
        findings: [{
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
          id: `large-${index}`, severity: "low" as const, confidence: "medium" as const, blocking: false,
          title: `Finding ${index}`, evidence: "e".repeat(8_000), intentRelevance: "i".repeat(4_000), remediation: "r".repeat(4_000),
        })),
      },
    });
    assert.ok(bounded.length <= 60_000);
    assert.match(bounded, /projection truncated/);
    assert.match(bounded, /FORGEDOCK:REVIEWER-SUBMISSION v1/);
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
