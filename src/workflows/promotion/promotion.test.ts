import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createArtifact } from "../../core/artifacts/schema.js";
import type { ForgeHost, PullRequestSnapshot } from "../../core/ports/forge-host.js";
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
  pullRequest: PullRequestSnapshot | undefined;
  async getBranchHead(_repo: string, branch: string): Promise<string> { return branch === "milestone/feature" ? this.sourceSha : this.targetSha; }
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
  async mergePullRequest(): Promise<void> { this.merged = true; }
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

  it("fails closed on verification, review availability, branch drift, and unprotected production", async () => {
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

    const unprotectedHost = new PromotionHost();
    unprotectedHost.protected = false;
    await assert.rejects(() => promoteBranch({ repository: "a/b", mode: "production", sourceBranch: "staging", targetBranch: "main", configuredPromotionTarget: "staging", configuredProductionTarget: "main", cwd: process.cwd(), verification: [command], authorizeCreation: true }, dependencies(unprotectedHost)), /not protected/i);
  });
});
