import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createArtifact } from "../../core/artifacts/schema.js";
import type { ForgeHost, PullRequestSnapshot } from "../../core/ports/forge-host.js";
import { InMemoryArtifactRepository, InMemoryRunRepository } from "../../core/ports/repositories.js";
import { createRun, transition, type RunState, type TransitionEvent } from "../../core/state/machine.js";
import { FakeAgentRuntime } from "../../runtime/fake-runtime.js";
import { reviewPullRequest, selectReviewerRoles, type ReviewerSubmission } from "./review.js";

const sha = "a".repeat(40);
const pr: PullRequestSnapshot = { repo: "a/b", number: 4, title: "Fix race", body: "", url: "https://github.test/a/b/pull/4", state: "OPEN", headSha: sha, headBranch: "fix", baseBranch: "main" };

class FakeHost implements ForgeHost {
  snapshots: PullRequestSnapshot[] = [pr, pr];
  async materializeDecomposition() { return []; }
  async createPullRequest(): Promise<PullRequestSnapshot> { return pr; }
  async getPullRequest(): Promise<PullRequestSnapshot> { return this.snapshots.shift() ?? pr; }
  async getPullRequestDiff(): Promise<string> { return "diff --git a/src/lock.ts b/src/lock.ts\n+await lock.run(update)"; }
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
    const result = await reviewPullRequest({ run, pullRequest: pr, ...context, workspace: process.cwd() }, {
      runtime, host: new FakeHost(), artifacts: new InMemoryArtifactRepository(), runs,
    });
    assert.equal(result.run.state, "merging");
    assert.deepEqual(result.verdict.payload.reviewerRoles, ["correctness", "concurrency"]);
    assert.equal(new Set(result.sessionRefs).size, 2);
    assert.ok(runtime.tasks.every((task) => task.workspace.mode === "read-only" && !task.tools.includes("edit")));
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
      const result = await reviewPullRequest({ run, pullRequest: pr, ...context, workspace: process.cwd() }, {
        runtime, host: new FakeHost(), artifacts: new InMemoryArtifactRepository(), runs,
      });
      assert.equal(result.run.state, "remediating");
      assert.equal(result.verdict.payload.findings[0]?.blocking, true);
    });
  }

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
