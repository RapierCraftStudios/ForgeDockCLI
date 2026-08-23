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
  criterionCoverage: [{ criterionId: "criterion-1", criterion: "Paraphrased remediation prose", implementation: "guard fixed", anchors: { paths: ["src/a.ts"], symbols: ["guard"], testIds: ["guard-regression"], verificationCommandIds: ["test"] } }],
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
    const packet = createArtifact({ ...common, kind: "BuildPacket", producer: { role: "packet-author" }, payload: { scope: ["Guard"], acceptanceCriteria: ["Guard remains correct"], context: [], implementationPlan: ["Fix guard"], expectedPaths: ["src/a.ts"], verificationPlan: ["npm test"], risks: [], outOfScope: [], evidenceContract: { version: "forgedock.evidence/v1", criteria: [{ criterionId: "criterion-1", requiredCommandIds: ["test"], semanticCommandIds: ["lint"], controllerGateIds: [], allowedWritePaths: [], allowedEvidencePaths: [], invariantRowIds: [], invariantTestIds: [], invariantCaseIds: [] }] } } });
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
      verification: [
        { id: "test", command: "npm", args: ["test"], cwd: "/tmp/work", timeoutMs: 1_000, required: true },
        { id: "lint", command: "npm", args: ["run", "lint"], cwd: "/tmp/work", timeoutMs: 1_000, required: false },
      ], verificationRunner: verifier,
    }, { runtime, runs, verifier });
    assert.equal(result.run.state, "verifying");
    assert.equal(runtime.tasks.length, 1);
    assert.match(runtime.tasks[0]?.objective ?? "", /medium-root|root-medium/);
    assert.ok(runtime.tasks[0]?.tools.includes("verify"));
    assert.deepEqual(runtime.tasks[0]?.verificationGate, { requiredCommandIds: ["lint", "test"] });
    assert.match(runtime.tasks[0]?.instructions ?? "", /criterion-1.*Guard remains correct/);
    assert.equal(result.submission.criterionCoverage[0]?.criterion, "Guard remains correct");
  });

  it("contracts compatible criterion shards into two packets without dropping roots", () => {
    const roots = Array.from({ length: 6 }, (_, index) => ({
      id: `f-${index}`, rootId: `root-${index}`,
      normalizedRoot: `${index < 4 ? "criterion-1" : "criterion-2"}\nsrc/${index < 3 ? "controller" : "view"}.ts\ncomponent\ninvariant\nfailure-${index}\ntrigger-${index}`,
      severity: "high" as const, confidence: "high" as const, blocking: true, mustFix: true,
      title: `Root ${index}`, evidence: "evidence", location: `src/${index < 4 ? "controller" : "view"}.ts:1`,
      intentRelevance: "criterion", remediation: "fix", scopeDisposition: "in_scope" as const,
    }));
    const clusters = clusterMustFixFindings(roots);
    assert.equal(clusters.length, 2);
    assert.deepEqual(clusters.flatMap((cluster) => cluster.rootIds), roots.map((root) => root.rootId));
  });

  it("contracts the sanitized live ReviewVerdict shape into criterion packets", () => {
    const findings = ([
      ["review-9fae5fca0a19c86c", "root-07b45ac50eda920aa6fd", "criterion-1", "src/workflows/orchestrate/view-model.ts", "src/workflows/orchestrate/view-model.ts (lifecycleStateForItem); src/workflows/orchestrate/controller.ts (execution-dispatch-admitted node mapping)"],
      ["review-d668609680245d59", "root-12976fc5e44911577ccd", "criterion-1", "src/workflows/orchestrate/controller.ts", "src/workflows/orchestrate/controller.ts:2012-2026"],
      ["review-2efddcba4025cbc8", "root-1c77e569343bffe53148", "criterion-2", "src/core/state/machine.ts", "src/core/state/machine.ts:68-72; src/adapters/github/github-client.ts:36-56"],
      ["review-d16d370bf2d109ff", "root-9252c04d79d2b2e4c167", "criterion-2", "src/core/state/machine.ts", "src/core/state/machine.ts:49-68"],
      ["review-0c316dfa5fc35c6e", "root-9572922a6f92914237ee", "criterion-1", "src/workflows/orchestrate/controller.ts", "src/workflows/orchestrate/controller.ts:737-743"],
      ["review-193efb470db7ab28", "root-95851c5113f4997225d9", "criterion-1", "src/workflows/orchestrate/controller.ts", "src/workflows/orchestrate/controller.ts:450-493"],
    ] as const).map(([id, rootId, criterion, component, location]) => ({
      id, rootId, normalizedRoot: `${criterion}\n${component}\ncomponent\ninvariant\nfailure\ntrigger`,
      severity: "high" as const, confidence: "high" as const, blocking: true, mustFix: true,
      title: id, evidence: "sanitized live evidence", location,
      intentRelevance: criterion, remediation: "fix", scopeDisposition: "in_scope" as const,
      matchedAcceptanceCriteria: [`${criterion}: frozen acceptance criterion`],
    }));
    const clusters = clusterMustFixFindings(findings);
    assert.equal(clusters.length, 2);
    assert.deepEqual(clusters.flatMap((cluster) => cluster.rootIds), [
      "root-07b45ac50eda920aa6fd", "root-12976fc5e44911577ccd", "root-9572922a6f92914237ee", "root-95851c5113f4997225d9",
      "root-1c77e569343bffe53148", "root-9252c04d79d2b2e4c167",
    ]);
    assert.deepEqual(clusters.map((cluster) => cluster.productionPaths), [
      ["src/workflows/orchestrate/controller.ts", "src/workflows/orchestrate/view-model.ts"],
      ["src/adapters/github/github-client.ts", "src/core/state/machine.ts"],
    ]);
  });

  it("does not contract unrelated criteria or components", () => {
    const roots = Array.from({ length: 3 }, (_, index) => ({
      id: `f-${index}`, rootId: `root-${index}`,
      normalizedRoot: `criterion-${index + 1}\nsrc/${index}.ts\ncomponent\ninvariant\nfailure\ntrigger`,
      severity: "high" as const, confidence: "high" as const, blocking: true, mustFix: true,
      title: `Root ${index}`, evidence: "evidence", location: `src/${index}.ts:1`,
      intentRelevance: "criterion", remediation: "fix", scopeDisposition: "in_scope" as const,
    }));
    assert.throws(() => clusterMustFixFindings(roots), /maximum is 2.*refuses to hide/i);
  });

  it("blocks a cluster whose production path union exceeds four", () => {
    const roots = Array.from({ length: 3 }, (_, index) => ({
      id: `f-${index}`, rootId: `root-${index}`, normalizedRoot: `criterion-1\nsrc/component.ts\ncomponent\ninvariant\nfailure\ntrigger`,
      severity: "high" as const, confidence: "high" as const, blocking: true, mustFix: true,
      title: `Root ${index}`, evidence: "evidence", location: `src/a${index}.ts:1 src/b${index}.ts:1`,
      intentRelevance: "criterion", remediation: "fix", scopeDisposition: "in_scope" as const,
    }));
    assert.throws(() => clusterMustFixFindings(roots), /spans .* production paths; maximum is 4/i);
  });

});
