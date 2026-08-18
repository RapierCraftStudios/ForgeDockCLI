import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createArtifact } from "../../core/artifacts/schema.js";
import type { ForgeHost, PullRequestMergeGate, PullRequestSnapshot } from "../../core/ports/forge-host.js";
import { InMemoryArtifactRepository, InMemoryRunRepository } from "../../core/ports/repositories.js";
import { createRun, transition, type RunState, type TransitionEvent } from "../../core/state/machine.js";
import { completeInvalidWorkItem, completeWorkItem } from "./complete.js";

const sha = "c".repeat(40);
const openPr: PullRequestSnapshot = { repo: "a/b", number: 9, title: "Fix", body: "", url: "https://github.test/a/b/pull/9", state: "OPEN", headSha: sha, headBranch: "fix", baseBranch: "main" };

class CompletionHost implements ForgeHost {
  closedIssues = new Set<number>();
  labelsByIssue = new Map<number, string[]>();
  reads: number[] = [];
  staleClosureProof = false;
  async getIssue(number: number, repo = "a/b") {
    this.reads.push(number);
    return {
      repo,
      number,
      title: `Issue ${number}`,
      body: "",
      url: `https://github.test/${repo}/issues/${number}`,
      state: this.closedIssues.has(number) ? "CLOSED" as const : "OPEN" as const,
      labels: this.labelsByIssue.get(number) ?? [],
    };
  }
  async materializeBatchIssue(input: { repo: string; title: string; body: string; priorityLabel: "priority:P2" | "P2" | "priority:P3" | "P3" }) { return { repo: input.repo, number: 100, title: input.title, body: input.body, url: `https://github.test/${input.repo}/issues/100`, state: "OPEN" as const }; }
  failIssueComment = false;
  failClose = false;
  async publishIssueComment(): Promise<void> {
    if (this.failIssueComment) throw new Error("trajectory publication unavailable");
  }
  async materializeRemediationChildren() { return []; }
  async materializeDecomposition() { return []; }
  snapshot = { ...openPr };
  merges = 0;
  mergeBase?: string;
  mergeGate: PullRequestMergeGate = {
    repo: "a/b", pullRequest: 9, headSha: sha, baseBranch: "main", mergeable: true,
    requiredChecks: [], observedAt: new Date().toISOString(),
  };
  closes: number[] = [];
  async createPullRequest(): Promise<PullRequestSnapshot> { return this.snapshot; }
  async getPullRequest(): Promise<PullRequestSnapshot> { return { ...this.snapshot }; }
  async getPullRequestMergeGate(): Promise<PullRequestMergeGate> { return { ...this.mergeGate, requiredChecks: [...this.mergeGate.requiredChecks] }; }
  async getPullRequestDiff(): Promise<string> { return ""; }
  async publishPullRequestComment(): Promise<void> {}
  async materializeReviewFinding() { return { repo: "a/b", number: 99, title: "finding", body: "", url: "https://github.test/a/b/issues/99", state: "OPEN" as const }; }
  async mergePullRequest(_repo: string, _number: number, _head: string, base: string): Promise<void> {
    this.merges++;
    this.mergeBase = base;
    this.snapshot.state = "MERGED";
  }
  async closeIssue(_repo: string, issue: number): Promise<void> {
    if (this.failClose) throw new Error("issue closure unavailable");
    this.closes.push(issue);
    if (!this.staleClosureProof) this.closedIssues.add(issue);
  }
}

async function mergingRun(runs: InMemoryRunRepository, runId = `run_complete_${crypto.randomUUID()}`): Promise<RunState> {
  let run = createRun({
    workflow: "work-on",
    subject: { repo: "a/b", issue: 2 },
    runId,
    target: { lane: "fast", targetBranch: "main" },
  });
  await runs.create(run);
  for (const event of ["START_INVESTIGATION", "INVESTIGATION_CONFIRMED", "BUILD_PACKET_READY", "BUILD_COMPLETED", "VERIFICATION_PASSED", "PR_PUBLISHED", "REVIEW_APPROVED"] as TransitionEvent[]) {
    const next = transition(run, event, { headSha: sha });
    await runs.commit(run.version, next.state, next.record);
    run = next.state;
  }
  return run;
}

async function invalidRun(runs: InMemoryRunRepository, issue = 2): Promise<RunState> {
  let run = createRun({
    workflow: "work-on",
    subject: { repo: "a/b", issue },
    runId: `run_invalid_${crypto.randomUUID()}`,
    target: { lane: "fast", targetBranch: "main" },
  });
  await runs.create(run);
  for (const event of ["START_INVESTIGATION", "INVESTIGATION_INVALID"] as TransitionEvent[]) {
    const next = transition(run, event);
    await runs.commit(run.version, next.state, next.record);
    run = next.state;
  }
  return run;
}

function invalidInvestigation(run: RunState) {
  return createArtifact({
    kind: "Investigation", runId: run.runId, subject: run.subject, producer: { role: "investigator" },
    payload: {
      outcome: "invalid", confidence: "high", summary: "The guarded implementation and regression test already cover the report.",
      evidence: [{ claim: "Already fixed", source: "src/guard.ts:test", detail: "The regression test proves the reported behavior is covered." }],
      affectedSurfaces: ["src/guard.ts"], risks: [], recommendation: "Close as already resolved.",
    },
  });
}

function invalidOutcome(run: RunState) {
  return createArtifact({
    kind: "Outcome", runId: run.runId, subject: run.subject, producer: { role: "controller" },
    payload: {
      status: "invalid", reason: "The guarded implementation and regression test already cover the report.", childIssues: [],
      issueClosure: { status: "pending", repo: run.subject.repo, issue: run.subject.issue! },
    },
  });
}

function verdict(run: RunState) {
  return createArtifact({
    kind: "ReviewVerdict", runId: run.runId, subject: { ...run.subject, pr: 9 }, producer: { role: "controller" },
    payload: { headSha: sha, disposition: "approve", reviewerRoles: ["correctness"], findings: [], checks: [] },
  });
}

describe("merge and close authority", () => {
  it("closes an invalid investigation only after authoritative proof", async () => {
    const runs = new InMemoryRunRepository();
    const run = await invalidRun(runs);
    const investigation = invalidInvestigation(run);
    const provisional = invalidOutcome(run);
    const artifacts = new InMemoryArtifactRepository();
    await artifacts.append(provisional);
    const host = new CompletionHost();
    const result = await completeInvalidWorkItem({ run, investigation, outcome: provisional }, { host, artifacts });
    assert.equal(result.run.state, "invalid");
    assert.deepEqual(host.closes, [2]);
    assert.equal(result.outcome.payload.issueClosure?.status, "completed");
    assert.match(result.outcome.payload.reason, /already cover/);
    assert.match(result.outcome.payload.reason, /evidence artifact art_/);
    assert.equal(result.outcome.payload.issueClosure?.repo, "a/b");
    const outcomes = (await artifacts.list(run.subject, "Outcome"))
      .filter((artifact): artifact is import("../../core/artifacts/schema.js").DurableArtifact<"Outcome"> => artifact.kind === "Outcome");
    assert.equal(outcomes.length, 2);
  });

  it("leaves a provisional invalid Outcome recoverable when closure fails", async () => {
    const runs = new InMemoryRunRepository();
    const run = await invalidRun(runs);
    const investigation = invalidInvestigation(run);
    const provisional = invalidOutcome(run);
    const artifacts = new InMemoryArtifactRepository();
    await artifacts.append(provisional);
    const host = new CompletionHost();
    host.failClose = true;
    await assert.rejects(
      completeInvalidWorkItem({ run, investigation, outcome: provisional }, { host, artifacts }),
      /issue closure unavailable/,
    );
    const outcomes = (await artifacts.list(run.subject, "Outcome"))
      .filter((artifact): artifact is import("../../core/artifacts/schema.js").DurableArtifact<"Outcome"> => artifact.kind === "Outcome");
    assert.deepEqual(outcomes.map((artifact) => artifact.payload.issueClosure?.status), ["pending"]);
  });

  it("refuses to publish invalid terminal evidence when GitHub remains OPEN", async () => {
    const runs = new InMemoryRunRepository();
    const run = await invalidRun(runs);
    const investigation = invalidInvestigation(run);
    const provisional = invalidOutcome(run);
    const artifacts = new InMemoryArtifactRepository();
    await artifacts.append(provisional);
    const host = new CompletionHost();
    host.staleClosureProof = true;
    await assert.rejects(
      completeInvalidWorkItem({ run, investigation, outcome: provisional }, { host, artifacts }),
      /authoritative host state is OPEN/,
    );
    assert.equal((await artifacts.list(run.subject, "Outcome")).length, 1);
  });

  it("handles an already-closed invalid issue idempotently", async () => {
    const runs = new InMemoryRunRepository();
    const run = await invalidRun(runs);
    const investigation = invalidInvestigation(run);
    const provisional = invalidOutcome(run);
    const artifacts = new InMemoryArtifactRepository();
    await artifacts.append(provisional);
    const host = new CompletionHost();
    host.closedIssues.add(2);
    const result = await completeInvalidWorkItem({ run, investigation, outcome: provisional }, { host, artifacts });
    assert.equal(result.outcome.payload.issueClosure?.status, "completed");
    assert.deepEqual(host.closes, [2]);
  });

  it("closes every invalid batch member and projects idempotent terminal outcomes", async () => {
    const runs = new InMemoryRunRepository();
    const run = await invalidRun(runs, 100);
    const investigation = invalidInvestigation(run);
    const provisional = invalidOutcome(run);
    const artifacts = new InMemoryArtifactRepository();
    await artifacts.append(provisional);
    const host = new CompletionHost();

    const first = await completeInvalidWorkItem({
      run,
      investigation,
      outcome: provisional,
      childIssues: [2, 3, 2, 100],
    }, { host, artifacts });

    assert.deepEqual(host.closes, [2, 3, 100]);
    assert.deepEqual(first.outcome.payload.childIssues, ["issue-2", "issue-3"]);
    for (const issue of [2, 3]) {
      const outcomes = (await artifacts.list({ repo: "a/b", issue }, "Outcome"))
        .filter((artifact): artifact is import("../../core/artifacts/schema.js").DurableArtifact<"Outcome"> => artifact.kind === "Outcome");
      assert.equal(outcomes.length, 1);
      assert.equal(outcomes[0]?.payload.status, "invalid");
      assert.equal(outcomes[0]?.payload.batchParent, 100);
      assert.equal(outcomes[0]?.payload.issueClosure?.status, "completed");
    }

    const retried = await completeInvalidWorkItem({
      run,
      investigation,
      outcome: provisional,
      childIssues: [2, 3],
    }, { host, artifacts });
    assert.equal(retried.outcome.id, first.outcome.id);
    assert.deepEqual(host.closes, [2, 3, 100]);
    assert.equal((await artifacts.list({ repo: "a/b", issue: 2 }, "Outcome")).length, 1);
    assert.equal((await artifacts.list({ repo: "a/b", issue: 3 }, "Outcome")).length, 1);
  });

  it("defaults to a human merge checkpoint without changing state", async () => {
    const runs = new InMemoryRunRepository();
    const run = await mergingRun(runs);
    const host = new CompletionHost();
    const result = await completeWorkItem({ run, pullRequest: openPr, verdict: verdict(run), autoMerge: false }, {
      host, artifacts: new InMemoryArtifactRepository(), runs,
    });
    assert.equal(result.awaitingHuman, true);
    assert.equal(result.run.state, "merging");
    assert.equal(host.merges, 0);
  });

  it("blocks auto-merge and durably preserves every non-passing required state", async () => {
    for (const state of ["pending", "cancelled", "failed", "unavailable"] as const) {
      const runs = new InMemoryRunRepository();
      const run = await mergingRun(runs);
      const host = new CompletionHost();
      const observedAt = host.mergeGate.observedAt;
      host.mergeGate.requiredChecks = [
        { name: "Analyze (javascript-typescript)", state, detailsUrl: "https://github.test/actions/runs/legacy" },
        { name: "CodeQL default setup", state: "passed", detailsUrl: "https://github.test/actions/runs/default" },
      ];
      const artifacts = new InMemoryArtifactRepository();
      const result = await completeWorkItem({ run, pullRequest: openPr, verdict: verdict(run), autoMerge: true }, { host, artifacts, runs });

      assert.equal(result.run.state, "blocked");
      assert.equal(result.outcome?.payload.status, "blocked");
      assert.deepEqual(result.outcome?.payload.mergeGate, {
        pullRequest: 9,
        headSha: sha,
        baseBranch: "main",
        mergeable: true,
        observedAt,
        requiredChecks: [
          { name: "Analyze (javascript-typescript)", state, detailsUrl: "https://github.test/actions/runs/legacy" },
          { name: "CodeQL default setup", state: "passed", detailsUrl: "https://github.test/actions/runs/default" },
        ],
      });
      assert.equal(host.merges, 0);
    }
  });

  it("persists the exact pending legacy CodeQL gate beside a passing replacement", async () => {
    const runs = new InMemoryRunRepository();
    const run = await mergingRun(runs);
    const host = new CompletionHost();
    const observedAt = host.mergeGate.observedAt;
    host.mergeGate.requiredChecks = [
      { name: "Analyze (javascript-typescript)", state: "pending", detailsUrl: "https://github.test/actions/runs/legacy" },
      { name: "CodeQL default setup", state: "passed", detailsUrl: "https://github.test/actions/runs/default" },
    ];
    const artifacts = new InMemoryArtifactRepository();
    const result = await completeWorkItem({ run, pullRequest: openPr, verdict: verdict(run), autoMerge: true }, { host, artifacts, runs });

    assert.equal(result.run.state, "blocked");
    assert.deepEqual(result.outcome?.payload.mergeGate, {
      pullRequest: 9,
      headSha: sha,
      baseBranch: "main",
      mergeable: true,
      observedAt,
      requiredChecks: [
        { name: "Analyze (javascript-typescript)", state: "pending", detailsUrl: "https://github.test/actions/runs/legacy" },
        { name: "CodeQL default setup", state: "passed", detailsUrl: "https://github.test/actions/runs/default" },
      ],
    });
    assert.equal(host.merges, 0);
  });

  it("persists unavailable merge-gate authority without retrying into a merge", async () => {
    const runs = new InMemoryRunRepository();
    const run = await mergingRun(runs);
    const host = new CompletionHost();
    Object.defineProperty(host, "getPullRequestMergeGate", { value: async () => {
      throw new Error("default setup authority unavailable");
    } });
    const result = await completeWorkItem({ run, pullRequest: openPr, verdict: verdict(run), autoMerge: true }, {
      host, artifacts: new InMemoryArtifactRepository(), runs,
    });

    assert.equal(result.run.state, "blocked");
    assert.deepEqual(result.outcome?.payload.mergeGate, {
      pullRequest: 9,
      headSha: sha,
      baseBranch: "main",
      mergeable: false,
      observedAt: result.outcome?.payload.mergeGate?.observedAt,
      requiredChecks: [{
        name: "merge-admission-query",
        state: "unavailable",
        detailsUrl: "default setup authority unavailable",
      }],
    });
    assert.equal(host.merges, 0);
  });

  it("auto-merges only the reviewed SHA then records Outcome and closes", async () => {
    const runs = new InMemoryRunRepository();
    const run = await mergingRun(runs);
    const host = new CompletionHost();
    const result = await completeWorkItem({ run, pullRequest: openPr, verdict: verdict(run), autoMerge: true }, {
      host, artifacts: new InMemoryArtifactRepository(), runs,
    });
    assert.equal(result.run.state, "completed");
    assert.equal(result.outcome?.payload.status, "merged");
    assert.equal(host.merges, 1);
    assert.equal(host.mergeBase, "main");
    assert.deepEqual(host.closes, [2]);
  });

  it("does not publish a terminal Outcome when trajectory publication fails after merge", async () => {
    const runs = new InMemoryRunRepository();
    const run = await mergingRun(runs);
    const host = new CompletionHost();
    host.failIssueComment = true;
    const artifacts = new InMemoryArtifactRepository();
    await assert.rejects(
      completeWorkItem({ run, pullRequest: openPr, verdict: verdict(run), autoMerge: true }, { host, artifacts, runs }),
      /trajectory publication unavailable/,
    );
    assert.equal(host.snapshot.state, "MERGED");
    assert.deepEqual(await artifacts.list(run.subject, "Outcome"), []);
  });

  it("does not publish a terminal Outcome when issue closure fails after merge", async () => {
    const runs = new InMemoryRunRepository();
    const run = await mergingRun(runs);
    const host = new CompletionHost();
    host.failClose = true;
    const artifacts = new InMemoryArtifactRepository();
    await assert.rejects(
      completeWorkItem({ run, pullRequest: openPr, verdict: verdict(run), autoMerge: true }, { host, artifacts, runs }),
      /issue closure unavailable/,
    );
    assert.equal(host.snapshot.state, "MERGED");
    assert.deepEqual(await artifacts.list(run.subject, "Outcome"), []);
  });

  it("does not publish a terminal Outcome when closure returns an OPEN proof", async () => {
    const runs = new InMemoryRunRepository();
    const run = await mergingRun(runs);
    const host = new CompletionHost();
    host.staleClosureProof = true;
    const artifacts = new InMemoryArtifactRepository();
    await assert.rejects(
      completeWorkItem({ run, pullRequest: openPr, verdict: verdict(run), autoMerge: true }, { host, artifacts, runs }),
      /authoritative host state is OPEN/,
    );
    assert.equal(host.snapshot.state, "MERGED");
    assert.deepEqual(await artifacts.list(run.subject, "Outcome"), []);
  });

  it("refuses merge when the PR target changes after approval", async () => {
    const runs = new InMemoryRunRepository();
    const run = await mergingRun(runs);
    const host = new CompletionHost();
    host.snapshot.baseBranch = "milestone/other";
    await assert.rejects(
      completeWorkItem({ run, pullRequest: openPr, verdict: verdict(run), autoMerge: true }, {
        host, artifacts: new InMemoryArtifactRepository(), runs,
      }),
      /targets main, not milestone\/other/,
    );
    assert.equal(host.merges, 0);
  });

  it("projects a successful batch Outcome to every eligible member", async () => {
    const runs = new InMemoryRunRepository();
    const run = await mergingRun(runs);
    const host = new CompletionHost();
    const artifacts = new InMemoryArtifactRepository();
    const result = await completeWorkItem({
      run, pullRequest: openPr, verdict: verdict(run), autoMerge: true, childIssues: [7, 8, 7, 2],
    }, { host, artifacts, runs });
    assert.deepEqual(result.outcome?.payload.childIssues, ["issue-7", "issue-8"]);
    assert.deepEqual(host.closes, [7, 8, 2]);
    const childOutcomes = (await artifacts.list({ repo: "a/b", issue: 7 }, "Outcome"))
      .filter((artifact) => artifact.kind === "Outcome");
    assert.equal(childOutcomes[0]?.payload.status, "merged");
    assert.match(childOutcomes[0]?.payload.reason ?? "", /batch issue #2/);
  });

  it("preserves human and operator-gated batch members as a split outcome", async () => {
    const runs = new InMemoryRunRepository();
    const run = await mergingRun(runs);
    const host = new CompletionHost();
    host.labelsByIssue.set(7, ["needs-human"]);
    host.labelsByIssue.set(8, ["blocked", "operator-only"]);
    const artifacts = new InMemoryArtifactRepository();

    const result = await completeWorkItem({
      run,
      pullRequest: openPr,
      verdict: verdict(run),
      autoMerge: true,
      childIssues: [7, 8, 9],
    }, { host, artifacts, runs });

    assert.equal(result.run.state, "completed");
    assert.deepEqual(host.closes, [9, 2]);
    assert.deepEqual(result.outcome?.payload.childIssues, ["issue-9"]);
    assert.match(result.outcome?.payload.reason ?? "", /#7 \(needs-human\).*#8 \(blocked, operator-only\).*remain open/);
    assert.equal((await artifacts.list({ repo: "a/b", issue: 7 }, "Outcome")).length, 0);
    assert.equal((await artifacts.list({ repo: "a/b", issue: 8 }, "Outcome")).length, 0);
    assert.ok(host.reads.includes(7));
    assert.ok(host.reads.includes(8));
  });

  it("reuses the terminal Outcome identity after a post-append fault", async () => {
    const runId = "run_complete_retry";
    const firstRuns = new InMemoryRunRepository();
    const firstRun = await mergingRun(firstRuns, runId);
    const host = new CompletionHost();
    const artifacts = new InMemoryArtifactRepository();
    const originalAppend = artifacts.append.bind(artifacts);
    let injected = false;
    artifacts.append = async (artifact) => {
      await originalAppend(artifact);
      if (!injected && artifact.kind === "Outcome" && artifact.subject.issue === 2) {
        injected = true;
        throw new Error("fault after terminal Outcome append");
      }
    };
    await assert.rejects(
      completeWorkItem({
        run: firstRun, pullRequest: openPr, verdict: verdict(firstRun), autoMerge: true, childIssues: [7],
      }, {
        host, artifacts, runs: firstRuns,
      }),
      /fault after terminal Outcome append/,
    );
    const originalOutcome = (await artifacts.list(firstRun.subject, "Outcome"))[0];
    assert.ok(originalOutcome?.kind === "Outcome");
    assert.deepEqual(originalOutcome.payload.childIssues, ["issue-7"]);
    assert.deepEqual(host.closes, [7, 2]);
    host.labelsByIssue.set(7, ["needs-human"]);

    const retryRuns = new InMemoryRunRepository();
    const retryRun = await mergingRun(retryRuns, runId);
    const retried = await completeWorkItem({
      run: retryRun,
      pullRequest: { ...openPr, state: "MERGED" },
      verdict: verdict(retryRun),
      autoMerge: true,
      childIssues: [7],
    }, { host, artifacts, runs: retryRuns });

    assert.equal(retried.outcome?.id, originalOutcome.id);
    assert.deepEqual(retried.outcome?.payload.childIssues, ["issue-7"]);
    assert.deepEqual(host.closes, [7, 2], "retry must adopt the durable closure projection without replaying side effects");
    assert.equal((await artifacts.list(firstRun.subject, "Outcome")).length, 1);
  });
});
