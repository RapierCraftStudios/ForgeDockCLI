import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createArtifact } from "../../core/artifacts/schema.js";
import { pullRequestMergeability, type ForgeHost, type PullRequestMergeGate, type PullRequestMergeability, type PullRequestMergeGateOptions, type PullRequestSnapshot } from "../../core/ports/forge-host.js";
import type { GitWorkspace, ReviewWorkspaceManager } from "../../core/ports/git-workspace.js";
import { InMemoryPromotionRepository, type PromotionRecord } from "../../core/ports/promotion.js";
import { InMemoryArtifactRepository, InMemoryRunRepository } from "../../core/ports/repositories.js";
import type { CheckResult, VerificationCommand, VerificationRunner } from "../../core/ports/verification.js";
import { createRun } from "../../core/state/machine.js";
import { promoteBranch, validatePromotionRoute, type PromotionDependencies } from "./promotion.js";

const sourceSha = "a".repeat(40);
const targetSha = "b".repeat(40);
const command: Omit<VerificationCommand, "cwd"> = { id: "tests", command: "npm test", args: [], timeoutMs: 1_000, required: true };
const frozenCommand: Omit<VerificationCommand, "cwd"> = { id: "tests", command: "npm", args: ["test", "--watch=false"], timeoutMs: 1_000, required: true, planId: "plan-test" };

class PromotionHost implements ForgeHost {
  sourceSha = sourceSha;
  targetSha = targetSha;
  protected = true;
  merged = false;
  stagingIsSource = false;
  requiredChecks: PullRequestMergeGate["requiredChecks"] = [{ name: "CI", state: "passed" }];
  requiredChecksSequence: Array<PullRequestMergeGate["requiredChecks"]> = [];
  requiredChecksProvenance: PullRequestMergeGate["requiredChecksProvenance"] = "github-required";
  mergeabilitySequence: PullRequestMergeability[] = ["mergeable"];
  mergeGateReads = 0;
  mergeGateOptions: PullRequestMergeGateOptions[] = [];
  mergeAttempts = 0;
  mergeErrorOnce: Error | undefined;
  mergeGateErrorAtRead: number | undefined;
  pullRequest: PullRequestSnapshot | undefined;
  async getBranchHead(_repo: string, branch: string): Promise<string> {
    return branch === "milestone/feature" || (branch === "staging" && this.stagingIsSource) ? this.sourceSha : this.targetSha;
  }
  async materializeDecomposition() { return []; }
  async createPullRequest(): Promise<PullRequestSnapshot> { throw new Error("not an issue delivery PR"); }
  async materializeReviewFinding(input: { repo: string; pullRequest: PullRequestSnapshot; finding: { id: string } }) {
    return { repo: input.repo, number: 99, title: input.finding.id, body: "", url: "https://github.test/issues/99", state: "OPEN" as const };
  }
  async isBranchProtected(): Promise<boolean> { return this.protected; }
  async findOpenPromotionPullRequest(): Promise<PullRequestSnapshot | undefined> { return this.pullRequest && !this.merged ? this.pullRequest : undefined; }
  async createPromotionPullRequest(input: { repo: string; headBranch: string; baseBranch: string; title: string; body: string }): Promise<PullRequestSnapshot> {
    this.pullRequest = {
      repo: input.repo, number: 7, title: input.title, body: input.body, url: "https://github.test/pull/7", state: "OPEN",
      headSha: this.sourceSha, headBranch: input.headBranch, baseBranch: input.baseBranch,
    };
    return this.pullRequest;
  }
  async getPullRequest(): Promise<PullRequestSnapshot> {
    if (!this.pullRequest) throw new Error("missing promotion PR");
    return { ...this.pullRequest, state: this.merged ? "MERGED" : "OPEN" };
  }
  async getPullRequestMergeGate(_repo: string, _number: number, _headSha: string, _baseBranch: string, options?: PullRequestMergeGateOptions) {
    this.mergeGateOptions.push(options ?? {});
    const read = this.mergeGateReads++;
    if (this.mergeGateErrorAtRead === read) throw new Error("GitHub authentication failed");
    const mergeability = this.mergeabilitySequence[Math.min(read, this.mergeabilitySequence.length - 1)] ?? "unavailable";
    const requiredChecks = this.requiredChecksSequence.length
      ? this.requiredChecksSequence[Math.min(read, this.requiredChecksSequence.length - 1)] ?? []
      : this.requiredChecks;
    return {
      repo: "a/b",
      pullRequest: this.pullRequest?.number ?? 7,
      headSha: this.sourceSha,
      baseBranch: this.pullRequest?.baseBranch ?? "staging",
      mergeable: mergeability === "mergeable",
      mergeability,
      ...(this.requiredChecksProvenance ? { requiredChecksProvenance: this.requiredChecksProvenance } : {}),
      requiredChecksHeadSha: this.sourceSha,
      requiredChecks: [...requiredChecks],
      observedAt: new Date().toISOString(),
    };
  }
  async mergePullRequest(): Promise<void> {
    this.mergeAttempts += 1;
    if (this.mergeErrorOnce) {
      const error = this.mergeErrorOnce;
      this.mergeErrorOnce = undefined;
      throw error;
    }
    this.merged = true;
  }
  async getPullRequestDiff(): Promise<string> { return "diff --git a/src/a.ts b/src/a.ts\n+change"; }
  async closeIssue(): Promise<void> {}
  async publishPullRequestComment(): Promise<void> {}
}

class FakeWorkspaces implements ReviewWorkspaceManager {
  readonly workspace: GitWorkspace = { path: process.cwd(), branch: "review", baseRef: sourceSha, baseSha: sourceSha };
  async createReview(): Promise<GitWorkspace> { return this.workspace; }
  async remove(): Promise<void> {}
}

class FakeVerifier implements VerificationRunner {
  constructor(readonly status: CheckResult["status"] = "passed") {}
  async run(commands: readonly VerificationCommand[]): Promise<CheckResult[]> {
    return commands.map((command) => ({ command: command.command, status: this.status, exitCode: this.status === "passed" ? 0 : 1, durationMs: 1 }));
  }
}

function dependencies(host: PromotionHost, verifier: VerificationRunner = new FakeVerifier()): PromotionDependencies {
  const artifacts = new InMemoryArtifactRepository();
  const runs = new InMemoryRunRepository();
  return {
    host,
    promotions: new InMemoryPromotionRepository(),
    artifacts,
    runs,
    workspaces: new FakeWorkspaces(),
    verifier,
    review: async ({ record, pullRequest }) => {
      const run = createRun({ workflow: "review-pr", subject: { repo: record.repository, pr: pullRequest.number }, runId: `review-${record.promotionId}` });
      const verdict = createArtifact({
        kind: "ReviewVerdict", runId: run.runId, subject: { repo: record.repository, pr: pullRequest.number }, producer: { role: "reviewer" },
        payload: { headSha: pullRequest.headSha, headBranch: pullRequest.headBranch, baseBranch: pullRequest.baseBranch, disposition: "approve", reviewerRoles: ["correctness"], findings: [], checks: [] },
      });
      return { run, verdict };
    },
  };
}

describe("explicit branch promotion", () => {
  it("validates feature and production routes without inferring protected targets", () => {
    assert.doesNotThrow(() => validatePromotionRoute({ mode: "feature", sourceBranch: "milestone/feature", targetBranch: "staging", configuredPromotionTarget: "staging", configuredProductionTarget: "main" }));
    assert.doesNotThrow(() => validatePromotionRoute({ mode: "production", sourceBranch: "staging", targetBranch: "main", configuredPromotionTarget: "staging", configuredProductionTarget: "main" }));
    assert.throws(() => validatePromotionRoute({ mode: "feature", sourceBranch: "fix/feature", targetBranch: "staging", configuredPromotionTarget: "staging", configuredProductionTarget: "main" }), /milestone\/feature/);
    assert.throws(() => validatePromotionRoute({ mode: "production", sourceBranch: "staging", targetBranch: "main", configuredPromotionTarget: "staging", configuredProductionTarget: undefined }), /productionTarget/);
  });

  it("creates a durable preview checkpoint without creating a PR", async () => {
    const host = new PromotionHost();
    const deps = dependencies(host);
    const record = await promoteBranch({
      repository: "a/b", mode: "feature", sourceBranch: "milestone/feature", targetBranch: "staging",
      configuredPromotionTarget: "staging", configuredProductionTarget: "main", cwd: process.cwd(), verification: [command],
    }, deps);
    assert.equal(record.phase, "planned");
    assert.equal(record.authorized, false);
    assert.equal(host.pullRequest, undefined);
    assert.equal((await deps.promotions.loadPromotion(record.promotionId))?.sourceHeadSha, sourceSha);
  });

  it("verifies, independently reviews, and merges an explicitly authorized feature promotion", async () => {
    const host = new PromotionHost();
    const deps = dependencies(host);
    const result = await promoteBranch({
      repository: "a/b", mode: "feature", sourceBranch: "milestone/feature", targetBranch: "staging",
      configuredPromotionTarget: "staging", configuredProductionTarget: "main", cwd: process.cwd(), verification: [command],
      authorizeCreation: true, authorizeMerge: true,
    }, deps);
    assert.equal(result.phase, "completed");
    assert.equal(result.review?.disposition, "approve");
    assert.equal(result.pullRequest?.headSha, sourceSha);
    assert.equal(host.merged, true);
  });

  it("refreshes transient UNKNOWN mergeability before authorized promotion merge", async () => {
    const host = new PromotionHost();
    host.mergeabilitySequence = ["unknown", "unknown", "mergeable"];
    const deps = dependencies(host);
    const result = await promoteBranch({
      repository: "a/b", mode: "feature", sourceBranch: "milestone/feature", targetBranch: "staging",
      configuredPromotionTarget: "staging", configuredProductionTarget: "main", cwd: process.cwd(), verification: [command],
      authorizeCreation: true, authorizeMerge: true, mergeGatePollIntervalMs: 1,
    }, deps);
    assert.equal(result.phase, "completed");
    assert.equal(host.merged, true);
    assert.equal(host.mergeGateReads, 3);
    assert.deepEqual(host.mergeGateOptions, [{}, {}, {}]);
  });

  it("fails closed on malformed mergeability projections", () => {
    assert.equal(pullRequestMergeability({ mergeable: false, mergeability: "bogus" as PullRequestMergeability }), "unavailable");
    assert.equal(pullRequestMergeability({ mergeable: false, mergeability: "mergeable" }), "unavailable");
    assert.equal(pullRequestMergeability({ mergeable: true, mergeability: "conflicting" }), "unavailable");
  });

  it("resumes the exact frozen verification command plan", async () => {
    const host = new PromotionHost();
    const observed: VerificationCommand[][] = [];
    const deps = dependencies(host, { run: async (commands) => {
      observed.push(commands.map((item) => ({ ...item, args: [...item.args] })));
      return commands.map((item) => ({ command: [item.command, ...item.args].join(" "), ...(item.planId !== undefined ? { planId: item.planId } : {}), status: "passed" as const, exitCode: 0, durationMs: 1 }));
    } });
    const planned = await promoteBranch({
      repository: "a/b", mode: "feature", sourceBranch: "milestone/feature", targetBranch: "staging",
      configuredPromotionTarget: "staging", configuredProductionTarget: "main", cwd: process.cwd(), verification: [frozenCommand], authorizeCreation: true,
    }, deps);
    assert.equal(planned.phase, "awaiting-merge");
    assert.deepEqual(observed[0]?.[0], { ...frozenCommand, cwd: process.cwd() });
    assert.deepEqual((await deps.promotions.loadPromotion(planned.promotionId))?.verificationCommands?.[0], frozenCommand);
  });

  it("records cancellation as a durable terminal checkpoint", async () => {
    const host = new PromotionHost();
    const deps = dependencies(host);
    const planned = await promoteBranch({
      repository: "a/b", mode: "feature", sourceBranch: "milestone/feature", targetBranch: "staging",
      configuredPromotionTarget: "staging", configuredProductionTarget: "main", cwd: process.cwd(), verification: [command],
    }, deps);
    const cancelled = await promoteBranch({
      repository: "a/b", mode: "feature", sourceBranch: planned.sourceBranch, targetBranch: planned.targetBranch,
      configuredPromotionTarget: "staging", configuredProductionTarget: "main", cwd: process.cwd(), verification: [], promotionId: planned.promotionId,
      cancel: true, cancellationReason: "No longer needed",
    }, deps);
    assert.equal(cancelled.phase, "cancelled");
    assert.equal(cancelled.cancellationReason, "No longer needed");
    assert.equal((await deps.promotions.loadPromotion(planned.promotionId))?.phase, "cancelled");
  });

  it("stops at the merge checkpoint until separately authorized", async () => {
    const host = new PromotionHost();
    const deps = dependencies(host);
    const planned = await promoteBranch({
      repository: "a/b", mode: "feature", sourceBranch: "milestone/feature", targetBranch: "staging",
      configuredPromotionTarget: "staging", configuredProductionTarget: "main", cwd: process.cwd(), verification: [command], authorizeCreation: true,
    }, deps);
    assert.equal(planned.phase, "awaiting-merge");
    const completed = await promoteBranch({
      repository: "a/b", mode: "feature", sourceBranch: planned.sourceBranch, targetBranch: planned.targetBranch,
      configuredPromotionTarget: "staging", configuredProductionTarget: "main", cwd: process.cwd(), verification: [command], promotionId: planned.promotionId, authorizeMerge: true,
    }, deps);
    assert.equal(completed.phase, "completed");
  });

  it("fails closed on verification, review availability, and branch drift", async () => {
    const failedVerification = dependencies(new PromotionHost(), new FakeVerifier("failed"));
    await assert.rejects(() => promoteBranch({ repository: "a/b", mode: "feature", sourceBranch: "milestone/feature", targetBranch: "staging", configuredPromotionTarget: "staging", configuredProductionTarget: "main", cwd: process.cwd(), verification: [command], authorizeCreation: true }, failedVerification), /verification failed/i);

    const unavailableHost = new PromotionHost();
    const unavailable = dependencies(unavailableHost);
    delete unavailable.review;
    await assert.rejects(() => promoteBranch({ repository: "a/b", mode: "feature", sourceBranch: "milestone/feature", targetBranch: "staging", configuredPromotionTarget: "staging", configuredProductionTarget: "main", cwd: process.cwd(), verification: [command], authorizeCreation: true }, unavailable), /review unavailable/i);

    const driftHost = new PromotionHost();
    const drift = dependencies(driftHost);
    const preview = await promoteBranch({ repository: "a/b", mode: "feature", sourceBranch: "milestone/feature", targetBranch: "staging", configuredPromotionTarget: "staging", configuredProductionTarget: "main", cwd: process.cwd(), verification: [command] }, drift);
    driftHost.sourceSha = "c".repeat(40);
    await assert.rejects(() => promoteBranch({ repository: "a/b", mode: "feature", sourceBranch: preview.sourceBranch, targetBranch: preview.targetBranch, configuredPromotionTarget: "staging", configuredProductionTarget: "main", cwd: process.cwd(), verification: [command], promotionId: preview.promotionId }, drift), /checkpoint refs changed/i);
  });

  it("publishes an unprotected production PR but blocks merge authorization", async () => {
    const host = new PromotionHost();
    host.protected = false;
    host.stagingIsSource = true;
    const deps = dependencies(host);
    const published = await promoteBranch({
      repository: "a/b", mode: "production", sourceBranch: "staging", targetBranch: "main",
      configuredPromotionTarget: "staging", configuredProductionTarget: "main", cwd: process.cwd(),
      verification: [command], authorizeCreation: true,
    }, deps);

    assert.equal(published.phase, "awaiting-merge");
    assert.equal(published.pullRequest?.url, "https://github.test/pull/7");
    assert.equal(host.merged, false);

    await assert.rejects(() => promoteBranch({
      repository: "a/b", mode: "production", sourceBranch: published.sourceBranch, targetBranch: published.targetBranch,
      configuredPromotionTarget: "staging", configuredProductionTarget: "main", cwd: process.cwd(),
      verification: [command], promotionId: published.promotionId, authorizeMerge: true,
    }, deps), /not protected/i);
    assert.equal(host.merged, false);
  });

  it("blocks production promotion when legacy CodeQL fails beside a passing replacement", async () => {
    for (const state of ["cancelled", "failed", "unavailable"] as const) {
      const host = new PromotionHost();
      host.stagingIsSource = true;
      host.requiredChecks = [
        { name: "Analyze (javascript-typescript)", state, detailsUrl: "https://github.test/actions/runs/legacy" },
        { name: "CodeQL default setup", state: "passed", detailsUrl: "https://github.test/actions/runs/default" },
      ];
      const deps = dependencies(host);
      const published = await promoteBranch({
        repository: "a/b", mode: "production", sourceBranch: "staging", targetBranch: "main",
        configuredPromotionTarget: "staging", configuredProductionTarget: "main", cwd: process.cwd(),
        verification: [command], authorizeCreation: true,
      }, deps);
      assert.equal(published.phase, "awaiting-merge");

      const blocked = await promoteBranch({
        repository: "a/b", mode: "production", sourceBranch: published.sourceBranch, targetBranch: published.targetBranch,
        configuredPromotionTarget: "staging", configuredProductionTarget: "main", cwd: process.cwd(),
        verification: [command], promotionId: published.promotionId, authorizeMerge: true,
      }, deps);
      assert.equal(blocked.phase, "blocked");
      assert.match(blocked.failure ?? "", new RegExp(`Promotion merge admission is blocked.*Analyze \\(javascript-typescript\\)=${state}`));
      assert.equal(host.merged, false);
    }
  });

  it("polls pending required CI and preserves exact promotion authority", async () => {
    const host = new PromotionHost();
    host.requiredChecksSequence = [
      [{ name: "CI", state: "pending" }],
      [{ name: "CI", state: "passed" }],
    ];
    const deps = dependencies(host);
    const polls: string[] = [];
    const result = await promoteBranch({
      repository: "a/b", mode: "feature", sourceBranch: "milestone/feature", targetBranch: "staging",
      configuredPromotionTarget: "staging", configuredProductionTarget: "main", cwd: process.cwd(), verification: [command],
      authorizeCreation: true, authorizeMerge: true, mergeGatePollIntervalMs: 1,
      onMergeGatePoll: ({ reason, gate }) => { polls.push(`${reason}:${gate.headSha}:${gate.baseBranch}`); },
    }, deps);

    assert.equal(result.phase, "completed");
    assert.deepEqual(polls, [`required-checks-pending:${sourceSha}:staging`]);
    assert.equal(host.mergeAttempts, 1);
  });

  it("records polling cancellation separately from promotion failure", async () => {
    const host = new PromotionHost();
    host.requiredChecks = [{ name: "CI", state: "pending" }];
    const deps = dependencies(host);
    const controller = new AbortController();
    const result = await promoteBranch({
      repository: "a/b", mode: "feature", sourceBranch: "milestone/feature", targetBranch: "staging",
      configuredPromotionTarget: "staging", configuredProductionTarget: "main", cwd: process.cwd(), verification: [command],
      authorizeCreation: true, authorizeMerge: true, mergeGatePollIntervalMs: 1, signal: controller.signal,
      onMergeGatePoll: () => controller.abort("operator cancelled pending CI"),
    }, deps);

    assert.equal(result.phase, "cancelled");
    assert.equal(result.cancellationReason, "operator cancelled pending CI");
    assert.equal(result.failure, undefined);
    assert.equal(host.mergeAttempts, 0);
  });

  it("reclassifies merge command failure only from a fresh typed gate", async () => {
    const host = new PromotionHost();
    host.mergeErrorOnce = new Error("merge rejected");
    host.requiredChecksSequence = [
      [{ name: "CI", state: "passed" }],
      [{ name: "CI", state: "pending" }],
      [{ name: "CI", state: "passed" }],
    ];
    const deps = dependencies(host);
    const result = await promoteBranch({
      repository: "a/b", mode: "feature", sourceBranch: "milestone/feature", targetBranch: "staging",
      configuredPromotionTarget: "staging", configuredProductionTarget: "main", cwd: process.cwd(), verification: [command],
      authorizeCreation: true, authorizeMerge: true, mergeGatePollIntervalMs: 1,
    }, deps);

    assert.equal(result.phase, "completed");
    assert.equal(host.mergeAttempts, 2);
    assert.equal(host.mergeGateReads, 3);
  });

  it("routes terminal merge conflict to blocked after command failure", async () => {
    const host = new PromotionHost();
    host.mergeErrorOnce = new Error("merge rejected");
    host.mergeabilitySequence = ["mergeable", "conflicting"];
    const deps = dependencies(host);
    const result = await promoteBranch({
      repository: "a/b", mode: "feature", sourceBranch: "milestone/feature", targetBranch: "staging",
      configuredPromotionTarget: "staging", configuredProductionTarget: "main", cwd: process.cwd(), verification: [command],
      authorizeCreation: true, authorizeMerge: true,
    }, deps);

    assert.equal(result.phase, "blocked");
    assert.match(result.failure ?? "", /mergeability=conflicting/);
    assert.equal(host.mergeAttempts, 1);
  });

  it("does not turn typed transport unavailability after merge failure into a blocker", async () => {
    const host = new PromotionHost();
    host.mergeErrorOnce = new Error("merge transport failed");
    const readGate = host.getPullRequestMergeGate.bind(host);
    host.getPullRequestMergeGate = async (...args) => {
      const gate = await readGate(...args);
      return host.mergeGateReads > 1
        ? { ...gate, requiredChecksProvenance: "unavailable" as const,
          requiredChecks: [{ name: "required-checks-query", state: "unavailable" as const }] }
        : gate;
    };
    const deps = dependencies(host);
    await assert.rejects(() => promoteBranch({
      repository: "a/b", mode: "feature", sourceBranch: "milestone/feature", targetBranch: "staging",
      configuredPromotionTarget: "staging", configuredProductionTarget: "main", cwd: process.cwd(), verification: [command],
      authorizeCreation: true, authorizeMerge: true,
    }, deps), /merge transport failed/);
    assert.equal((await deps.promotions.listPromotions())[0]?.phase, "failed");
  });

  it("preserves transport and authentication errors as failed promotion execution", async () => {
    const host = new PromotionHost();
    host.mergeErrorOnce = new Error("merge transport failed");
    host.mergeGateErrorAtRead = 1;
    const deps = dependencies(host);
    await assert.rejects(() => promoteBranch({
      repository: "a/b", mode: "feature", sourceBranch: "milestone/feature", targetBranch: "staging",
      configuredPromotionTarget: "staging", configuredProductionTarget: "main", cwd: process.cwd(), verification: [command],
      authorizeCreation: true, authorizeMerge: true,
    }, deps), /GitHub authentication failed/);

    const checkpoint = (await deps.promotions.listPromotions())[0];
    assert.equal(checkpoint?.phase, "failed");
    assert.match(checkpoint?.failure ?? "", /authentication failed/);
  });

  it("recovers an exact already-merged PR before post-merge target ref drift", async () => {
    const host = new PromotionHost();
    const deps = dependencies(host);
    const awaiting = await promoteBranch({
      repository: "a/b", mode: "feature", sourceBranch: "milestone/feature", targetBranch: "staging",
      configuredPromotionTarget: "staging", configuredProductionTarget: "main", cwd: process.cwd(), verification: [command],
      authorizeCreation: true,
    }, deps);
    assert.equal(awaiting.phase, "awaiting-merge");

    host.merged = true;
    host.targetSha = "c".repeat(40);
    const recovered = await promoteBranch({
      repository: "a/b", mode: "feature", sourceBranch: awaiting.sourceBranch, targetBranch: awaiting.targetBranch,
      configuredPromotionTarget: "staging", configuredProductionTarget: "main", cwd: process.cwd(), verification: [command],
      promotionId: awaiting.promotionId,
    }, deps);
    assert.equal(recovered.phase, "completed");
    assert.equal(recovered.pullRequest?.number, 7);
    assert.equal(recovered.pullRequest?.headSha, sourceSha);
  });

  it("refuses to record an externally merged unprotected production PR as completed", async () => {
    const host = new PromotionHost();
    host.stagingIsSource = true;
    const deps = dependencies(host);
    const published = await promoteBranch({
      repository: "a/b", mode: "production", sourceBranch: "staging", targetBranch: "main",
      configuredPromotionTarget: "staging", configuredProductionTarget: "main", cwd: process.cwd(),
      verification: [command], authorizeCreation: true,
    }, deps);
    assert.equal(published.phase, "awaiting-merge");

    host.merged = true;
    host.protected = false;
    await assert.rejects(() => promoteBranch({
      repository: "a/b", mode: "production", sourceBranch: published.sourceBranch, targetBranch: published.targetBranch,
      configuredPromotionTarget: "staging", configuredProductionTarget: "main", cwd: process.cwd(),
      verification: [command], promotionId: published.promotionId, authorizeMerge: true,
    }, deps), /not protected/i);
    assert.equal((await deps.promotions.loadPromotion(published.promotionId))?.phase, "failed");
  });
});
