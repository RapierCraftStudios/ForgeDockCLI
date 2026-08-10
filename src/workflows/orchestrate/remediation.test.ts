import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createArtifact, type DurableArtifact } from "../../core/artifacts/schema.js";
import type { ForgeHost, PullRequestSnapshot } from "../../core/ports/forge-host.js";
import { InMemoryLeaseRepository } from "../../core/ports/lease.js";
import type { GitWorkspace, GitWorkspaceManager } from "../../core/ports/git-workspace.js";
import { InMemoryArtifactRepository, InMemoryRunRepository } from "../../core/ports/repositories.js";
import { createRun, transition } from "../../core/state/machine.js";
import { reconcileArtifacts } from "../../core/state/reconcile.js";
import { RemediationSupervisor, verifyParentRevision } from "./remediation.js";

const pr: PullRequestSnapshot = {
  repo: "owner/repo", number: 9, title: "Parent", body: "", url: "https://example.test/pr/9", state: "OPEN",
  headSha: "a".repeat(40), headBranch: "forge/parent", baseBranch: "main",
};

function context() {
  const run = createRun({ workflow: "work-on", subject: { repo: "owner/repo", issue: 20 }, runId: "run_parent", target: { lane: "fast", targetBranch: "main" } });
  const packet = createArtifact({ kind: "BuildPacket", runId: run.runId, subject: run.subject, producer: { role: "controller" }, payload: {
    scope: ["fix"], acceptanceCriteria: ["Fix the bug"], context: [], implementationPlan: ["edit"], expectedPaths: ["src/a.ts"], verificationPlan: ["npm test"], risks: [], outOfScope: [],
  }});
  const verdict = createArtifact({ kind: "ReviewVerdict", runId: run.runId, subject: { ...run.subject, pr: pr.number }, producer: { role: "controller" }, payload: {
    headSha: pr.headSha, disposition: "request_changes", reviewerRoles: ["correctness"], checks: [], findings: [{
      id: "finding-1", severity: "high", confidence: "high", blocking: true, title: "Fix adjacent bug", evidence: "src/a.ts fails", location: "src/a.ts:10", intentRelevance: "needed", remediation: "Add the guard",
    }],
  }});
  return { run, packet, verdict };
}

describe("durable recursive remediation", () => {
  it("materializes deterministic children and reconstructs a running checkpoint", async () => {
    const { run, packet, verdict } = context();
    const artifacts = new InMemoryArtifactRepository();
    const runs = new InMemoryRunRepository();
    await runs.create(run);
    const calls: string[] = [];
    const host = {
      async materializeRemediationChildren(input: { checkpointKey: string }) {
        calls.push(input.checkpointKey);
        return [{ repo: "owner/repo", number: 30, title: "Child", body: "", url: "https://example.test/issues/30", state: "OPEN" as const }];
      },
    } as unknown as ForgeHost;
    const supervisor = new RemediationSupervisor({ host, artifacts, runs });
    const first = await supervisor.begin({ parentRun: run, parentPullRequest: pr, packetArtifact: packet, verdictArtifact: verdict, reason: "scope-violation", findings: [
      { id: "finding-1", severity: "high", title: "Fix adjacent bug", evidence: "evidence", location: "src/a.ts:10", remediation: "Add guard", acceptanceCriterion: "Fix the bug" },
      { id: "finding-ineligible", severity: "high", title: "Unscoped prose", evidence: "evidence", location: "src/ineligible.ts", remediation: "Do not authorize", acceptanceCriterion: "" },
    ] });
    assert.equal(first.checkpoint.payload.status, "children-running");
    assert.deepEqual(first.childIssues, [30]);
    assert.deepEqual(first.checkpoint.payload.approvedPaths, ["src/a.ts"]);
    const second = await supervisor.begin({ parentRun: run, parentPullRequest: pr, packetArtifact: packet, verdictArtifact: verdict, reason: "scope-violation", findings: [{ id: "finding-1", severity: "high", title: "Fix adjacent bug", evidence: "evidence", location: "src/a.ts:10", remediation: "Add guard", acceptanceCriterion: "Fix the bug" }] });
    assert.equal(calls.length, 1);
    assert.deepEqual(second.childIssues, first.childIssues);
    assert.equal(second.checkpoint.id, first.checkpoint.id);
    const reconstructed = await supervisor.reconstruct({ subject: { repo: "owner/repo", issue: 20 } });
    assert.equal(reconstructed?.payload.status, "children-running");
    assert.equal(reconcileArtifacts(await artifacts.list({ repo: "owner/repo", issue: 20 })).state, "blocked");
  });

  it("admits concurrent begins once and preserves the complete authoritative child set", async () => {
    const { run, packet, verdict } = context();
    const artifacts = new InMemoryArtifactRepository();
    const leases = new InMemoryLeaseRepository();
    let calls = 0;
    const host = {
      async materializeRemediationChildren() {
        calls += 1;
        await new Promise((resolve) => setTimeout(resolve, 10));
        return [{ repo: "owner/repo", number: 30 + calls, title: "Child", body: "", url: "", state: "OPEN" as const }];
      },
    } as unknown as ForgeHost;
    const supervisor = new RemediationSupervisor({ host, artifacts, leaseRepository: leases, leaseOwner: "test-owner" });
    const [first, second] = await Promise.all([
      supervisor.begin({ parentRun: run, parentPullRequest: pr, packetArtifact: packet, verdictArtifact: verdict, reason: "scope-violation", findings: [{
        id: "finding-1", severity: "high", title: "Fix", evidence: "e", location: "src/a.ts", remediation: "r", acceptanceCriterion: "Fix the bug",
      }] }),
      supervisor.begin({ parentRun: run, parentPullRequest: pr, packetArtifact: packet, verdictArtifact: verdict, reason: "scope-violation", findings: [{
        id: "finding-1", severity: "high", title: "Fix", evidence: "e", location: "src/a.ts", remediation: "r", acceptanceCriterion: "Fix the bug",
      }] }),
    ]);
    assert.equal(calls, 1);
    assert.deepEqual(first.childIssues, [31]);
    assert.deepEqual(second.childIssues, first.childIssues);
    const latest = await supervisor.reconstruct({ subject: { repo: "owner/repo", issue: 20 }, checkpointKey: first.checkpoint.payload.checkpointKey });
    assert.deepEqual(latest?.payload.childIssues, first.childIssues);
  });

  it("uses the explicit expanded-review transition only after child outcomes are merged", async () => {
    const { run, packet, verdict } = context();
    const artifacts = new InMemoryArtifactRepository();
    const runs = new InMemoryRunRepository();
    await runs.create(run);
    const host = { async materializeRemediationChildren() { return [{ repo: "owner/repo", number: 30, title: "Child", body: "", url: "", state: "OPEN" as const }]; } } as unknown as ForgeHost;
    const supervisor = new RemediationSupervisor({ host, artifacts, runs });
    const started = await supervisor.begin({ parentRun: run, parentPullRequest: pr, packetArtifact: packet, verdictArtifact: verdict, reason: "scope-violation", findings: [{ id: "finding-1", severity: "high", title: "Fix", evidence: "e", location: "src/a.ts", remediation: "r", acceptanceCriterion: "Fix the bug" }] });
    const childOutcome = createArtifact({ kind: "Outcome", runId: "child", subject: { repo: "owner/repo", issue: 30 }, producer: { role: "controller" }, payload: { status: "merged", reason: "merged", finalSha: pr.headSha, prUrl: pr.url, childIssues: [] } });
    const ready = await supervisor.reconcileChildren({ checkpoint: started.checkpoint, childOutcomes: [childOutcome], parentPullRequest: { ...pr, headSha: "b".repeat(40) } });
    assert.equal(ready.payload.status, "ready-to-resume");
    const blockedTransition = transition(run, "BLOCK", { reason: "recursive" });
    await runs.commit(run.version, blockedTransition.state, blockedTransition.record);
    const blocked = blockedTransition.state;
    const resumed = await supervisor.resumeParent({ run: blocked, checkpoint: ready });
    assert.equal(resumed.state, "reviewing");
  });

  it("synchronizes and verifies the actual advanced parent revision", async () => {
    const { run, packet, verdict } = context();
    const artifacts = new InMemoryArtifactRepository();
    const runs = new InMemoryRunRepository();
    await runs.create(run);
    const advancedSha = "b".repeat(40);
    const host = {
      async materializeRemediationChildren() {
        return [{ repo: "owner/repo", number: 30, title: "Child", body: "", url: "", state: "OPEN" as const }];
      },
      async getPullRequest() { return { ...pr, headSha: advancedSha }; },
    } as unknown as ForgeHost;
    const supervisor = new RemediationSupervisor({ host, artifacts, runs });
    const started = await supervisor.begin({
      parentRun: run,
      parentPullRequest: pr,
      packetArtifact: packet,
      verdictArtifact: verdict,
      reason: "scope-violation",
      findings: [{
        id: "finding-1", severity: "high", title: "Fix", evidence: "e", location: "src/a.ts",
        remediation: "r", acceptanceCriterion: "Fix the bug",
      }],
    });
    const childOutcome = createArtifact({
      kind: "Outcome", runId: "child", subject: { repo: "owner/repo", issue: 30 }, producer: { role: "controller" },
      payload: { status: "merged", reason: "merged", finalSha: pr.headSha, prUrl: pr.url, childIssues: [] },
    });
    const ready = await supervisor.reconcileChildren({
      checkpoint: started.checkpoint,
      childOutcomes: [childOutcome],
      parentPullRequest: { ...pr, headSha: advancedSha },
    });
    const blockedTransition = transition(run, "BLOCK", { reason: "recursive" });
    await runs.commit(run.version, blockedTransition.state, blockedTransition.record);
    const workspace: GitWorkspace = {
      path: "/tmp/parent", branch: pr.headBranch, baseRef: pr.baseBranch, baseSha: "0".repeat(40),
    };
    let localHead = pr.headSha;
    let synchronizedTo: string | undefined;
    let containsChild = false;
    const git: GitWorkspaceManager = {
      async create() { return workspace; },
      async changedPaths() { return []; },
      async revisionChangedPaths() { return ["src/a.ts"]; },
      async syncToRemoteHead(_workspace, expectedHeadSha) { synchronizedTo = expectedHeadSha; localHead = expectedHeadSha; },
      async isAncestor() { return containsChild; },
      async prepareWorkspaceDependencies() {},
      async committedContentMatches() { return true; },
      async commit() { return localHead; },
      async push() {},
      async head() { return localHead; },
      async remove() {},
    };
    const command = { id: "test", command: "npm", args: ["test"], cwd: workspace.path, timeoutMs: 1_000, required: true } as const;
    await assert.rejects(
      verifyParentRevision({
        run: blockedTransition.state,
        packet: { ...packet, payload: { ...packet.payload, verificationPlan: ["npm run lint"] } },
        checkpoint: ready,
        pullRequest: pr,
        commands: [command],
        workspace,
        verifier: { async run() { return [{ command: "npm test", status: "passed", durationMs: 1 }]; } },
      }, { host, git, artifacts, runs }),
      /does not cover the frozen plan.*npm run lint/,
    );
    await assert.rejects(
      verifyParentRevision({
        run: blockedTransition.state,
        packet,
        checkpoint: ready,
        pullRequest: pr,
        commands: [command],
        workspace,
        verifier: { async run() { return [{ command: "npm test", status: "passed", durationMs: 1 }]; } },
      }, { host, git, artifacts, runs }),
      /does not contain remediated child/,
    );
    containsChild = true;
    const proof = await verifyParentRevision({
      run: blockedTransition.state,
      packet,
      checkpoint: ready,
      pullRequest: pr,
      commands: [command],
      workspace,
      verifier: { async run() { return [{ command: "npm test", status: "passed", durationMs: 1 }]; } },
    }, { host, git, artifacts, runs });
    assert.equal(synchronizedTo, advancedSha);
    assert.equal(proof.buildResult?.payload.headSha, advancedSha);
    assert.deepEqual(proof.buildResult?.payload.changedPaths, ["src/a.ts"]);
    assert.equal(proof.run.state, "reviewing");
  });
});
