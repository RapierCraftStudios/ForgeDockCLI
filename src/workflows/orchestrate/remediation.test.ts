import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createArtifact, type DurableArtifact } from "../../core/artifacts/schema.js";
import type { ForgeHost, PullRequestSnapshot } from "../../core/ports/forge-host.js";
import { InMemoryArtifactRepository, InMemoryRunRepository } from "../../core/ports/repositories.js";
import { createRun, transition } from "../../core/state/machine.js";
import { reconcileArtifacts } from "../../core/state/reconcile.js";
import { RemediationSupervisor } from "./remediation.js";

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
    const first = await supervisor.begin({ parentRun: run, parentPullRequest: pr, packetArtifact: packet, verdictArtifact: verdict, reason: "scope-violation", findings: [{ id: "finding-1", severity: "high", title: "Fix adjacent bug", evidence: "evidence", location: "src/a.ts:10", remediation: "Add guard", acceptanceCriterion: "Fix the bug" }] });
    assert.equal(first.checkpoint.payload.status, "children-running");
    assert.deepEqual(first.childIssues, [30]);
    const second = await supervisor.begin({ parentRun: run, parentPullRequest: pr, packetArtifact: packet, verdictArtifact: verdict, reason: "scope-violation", findings: [{ id: "finding-1", severity: "high", title: "Fix adjacent bug", evidence: "evidence", location: "src/a.ts:10", remediation: "Add guard", acceptanceCriterion: "Fix the bug" }] });
    assert.equal(calls.length, 2);
    assert.equal(second.childIssues[0], 30);
    const reconstructed = await supervisor.reconstruct({ subject: { repo: "owner/repo", issue: 20 } });
    assert.equal(reconstructed?.payload.status, "children-running");
    assert.equal(reconcileArtifacts(await artifacts.list({ repo: "owner/repo", issue: 20 })).state, "blocked");
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
});
