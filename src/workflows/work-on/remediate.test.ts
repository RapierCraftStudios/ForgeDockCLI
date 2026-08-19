import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createArtifact } from "../../core/artifacts/schema.js";
import { InMemoryRunRepository } from "../../core/ports/repositories.js";
import type { VerificationRunner } from "../../core/ports/verification.js";
import { createRun, transition } from "../../core/state/machine.js";
import { FakeAgentRuntime } from "../../runtime/fake-runtime.js";
import { clusterMustFixFindings, remediateReview } from "./remediate.js";

const submission = {
  summary: "Fixed medium root", changedPaths: ["src/a.ts"],
  criterionCoverage: [{ criterionId: "criterion-1", criterion: "Guard remains correct", implementation: "guard fixed", anchors: { paths: ["src/a.ts"], symbols: ["guard"], testIds: ["guard-regression"], verificationCommandIds: ["test"] } }],
  decisions: [], residualRisks: [],
};

async function remediatingRun(runs: InMemoryRunRepository) {
  let run = createRun({ workflow: "work-on", subject: { repo: "a/b", issue: 14 }, runId: `run-remediate-${crypto.randomUUID()}`, target: { lane: "fast", targetBranch: "main" } });
  await runs.create(run);
  for (const event of ["START_INVESTIGATION", "INVESTIGATION_CONFIRMED", "BUILD_PACKET_READY", "BUILD_COMPLETED", "VERIFICATION_PASSED", "PR_PUBLISHED", "REVIEW_CHANGES_REQUESTED"] as const) {
    const next = transition(run, event, { headSha: "a".repeat(40) });
    await runs.commit(run.version, next.state, next.record);
    run = next.state;
  }
  return run;
}

describe("mustFix remediation", () => {
  it("dispatches an accepted medium mustFix root even when final blocking policy is false", async () => {
    const runs = new InMemoryRunRepository();
    const run = await remediatingRun(runs);
    const common = { runId: run.runId, subject: run.subject };
    const intent = createArtifact({ ...common, kind: "Intent", producer: { role: "controller" }, payload: { title: "Guard", problem: "Guard fails", constraints: [], acceptanceHints: [], dependencies: [] } });
    const investigation = createArtifact({ ...common, kind: "Investigation", producer: { role: "investigator" }, payload: { outcome: "confirmed", confidence: "high", summary: "confirmed", evidence: [{ claim: "gap", source: "src/a.ts", detail: "guard misses case" }], affectedSurfaces: ["src/a.ts"], risks: [], recommendation: "fix" } });
    const packet = createArtifact({ ...common, kind: "BuildPacket", producer: { role: "packet-author" }, payload: { scope: ["Guard"], acceptanceCriteria: ["Guard remains correct"], context: [], implementationPlan: ["Fix guard"], expectedPaths: ["src/a.ts"], verificationPlan: ["npm test"], risks: [], outOfScope: [] } });
    const buildResult = createArtifact({ ...common, kind: "BuildResult", producer: { role: "controller" }, payload: { branch: "fix", targetBranch: "main", headSha: "a".repeat(40), changedPaths: ["src/a.ts"], summary: "built", acceptanceEvidence: [{ criterion: "Guard remains correct", status: "passed", evidence: "legacy" }], checks: [], decisions: [], residualRisks: [] } });
    const verdict = createArtifact({ ...common, kind: "ReviewVerdict", subject: { ...run.subject, pr: 1 }, producer: { role: "controller" }, payload: {
      headSha: "a".repeat(40), disposition: "request_changes", reviewerRoles: ["correctness"], checks: [], findings: [{
        id: "medium-root", rootId: "root-medium", normalizedRoot: "criterion-1\nsrc/a.ts\nguard\ncorrectness\nguard\ncase", causalRoot: "guard misses case",
        severity: "medium", confidence: "high", blocking: false, mustFix: true, title: "Guard misses case", evidence: "guard() returns early", location: "src/a.ts:guard()", intentRelevance: "Guard remains correct", remediation: "Fix guard", reviewerRoles: ["correctness"], scopeDisposition: "in_scope", scopeRationale: "criterion", matchedAcceptanceCriteria: ["Guard remains correct"], matchedPriorFindingIds: [], introducedByRemediation: false,
      }],
    } });
    const runtime = new FakeAgentRuntime([submission]);
    const verifier: VerificationRunner = { async run() { return []; } };
    const result = await remediateReview({
      run, intent, investigation, packet, buildResult, verdict, worktree: "/tmp/work",
      verification: [{ id: "test", command: "npm", args: ["test"], cwd: "/tmp/work", timeoutMs: 1_000, required: true }], verificationRunner: verifier,
    }, { runtime, runs, verifier });
    assert.equal(result.run.state, "verifying");
    assert.equal(runtime.tasks.length, 1);
    assert.match(runtime.tasks[0]?.objective ?? "", /medium-root|root-medium/);
    assert.ok(runtime.tasks[0]?.tools.includes("verify"));
  });

  it("bounds clusters without silently dropping roots", () => {
    const roots = Array.from({ length: 7 }, (_, index) => ({
      id: `f-${index}`, rootId: `root-${index}`, normalizedRoot: `criterion-${index + 1}\nsrc/${index}.ts\nsymbol-${index}\ninvariant-${index}\nfailure-${index}\ntrigger-${index}`,
      severity: "high" as const, confidence: "high" as const, blocking: true, mustFix: true, title: `Root ${index}`, evidence: "evidence", location: `src/${index}.ts:1`, intentRelevance: "criterion", remediation: "fix", scopeDisposition: "in_scope" as const,
    }));
    assert.throws(() => clusterMustFixFindings(roots), /maximum is 2.*refuses to hide/i);
  });
});
