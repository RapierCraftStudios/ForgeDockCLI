import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createArtifact, type BuildPacketPayload, type InvestigationPayload } from "../../core/artifacts/schema.js";
import { InMemoryArtifactRepository, InMemoryRunRepository } from "../../core/ports/repositories.js";
import { FakeAgentRuntime } from "../../runtime/fake-runtime.js";
import { buildWorkItem, type BuilderSubmission, type VerificationDiagnosis } from "./build.js";
import { investigateWorkItem } from "./investigate.js";
import { prepareBuildPacket } from "./prepare.js";

const investigation: InvestigationPayload = {
  outcome: "confirmed", confidence: "high", summary: "Confirmed",
  evidence: [{ claim: "Broken", source: "src/a.ts", detail: "Missing guard" }], rootCause: "Missing guard",
  affectedSurfaces: ["src/a.ts"], risks: [], recommendation: "Add guard",
};
const packet: BuildPacketPayload = {
  scope: ["Add guard"], acceptanceCriteria: ["State is preserved"], context: [],
  implementationPlan: ["Edit src/a.ts"], expectedPaths: ["src/a.ts"], verificationPlan: ["npm test"], risks: [], outOfScope: [],
};
const submission: BuilderSubmission = {
  summary: "Added the guard", changedPaths: ["src/a.ts"],
  criterionCoverage: [{ criterion: "State is preserved", implementation: "Guard keeps the prior value" }],
  decisions: [], residualRisks: [],
};

const diagnosis: VerificationDiagnosis = {
  rootCause: "The source joins lines with a literal escape instead of a newline.",
  sourceAnchors: [{ path: "src/workflows/work-on/build.ts", location: "buildWorkItem", evidence: "The repair prompt is assembled here." }],
  reproducer: "npm test reproduces the timeout signature.",
  failureSignatureMapping: "test|failed|timeout||",
  rejectedPreviousHypotheses: ["The timeout was caused by a transient provider failure."],
  minimalFixGuidance: "Change only the line-join formatting and rerun the frozen check.",
};

const priorFailure = createArtifact({
  kind: "Outcome", runId: "run_build", subject: { repo: "a/b", issue: 1 }, producer: { role: "controller" },
  payload: {
    status: "blocked", reason: "Required verification failed", childIssues: [],
    failureEvidence: {
      branch: "forgedock/issue-1", workspacePath: process.cwd(), builderSummary: "Timed out",
      changedPaths: ["src/a.ts"], checks: [{ command: "npm test", commandId: "test", status: "failed", failureClass: "timeout", durationMs: 1 }],
    },
  },
});


describe("builder boundary", () => {
  it("permits worktree edits but withholds shell and GitHub authority", async () => {
    const runtime = new FakeAgentRuntime([investigation, packet, submission]);
    const artifacts = new InMemoryArtifactRepository();
    const runs = new InMemoryRunRepository();
    const intent = createArtifact({
      kind: "Intent", runId: "run_build", subject: { repo: "a/b", issue: 1 }, producer: { role: "controller" },
      payload: { title: "Guard", problem: "Race", constraints: [], acceptanceHints: [], dependencies: [] },
    });
    const scopeHints = { affectedFiles: ["src/**/*.ts"], claims: ["src/widget"], metadataRoots: ["package.json"], writePaths: ["src/a.ts"] } as const;
    const investigated = await investigateWorkItem({ intent, cwd: process.cwd(), scopeHints }, { runtime, artifacts, runs });
    const prepared = await prepareBuildPacket({ run: investigated.run, intent, investigation: investigated.investigation, cwd: process.cwd(), scopeHints }, { runtime, artifacts, runs });
    const verification = [{ id: "test", command: "npm", args: ["test"], cwd: process.cwd(), timeoutMs: 60_000, required: true }];
    const verifier = { async run() { return []; } };
    const built = await buildWorkItem({
      run: prepared.run, intent, investigation: investigated.investigation, packet: prepared.packet, scopeHints, worktree: process.cwd(),
      priorVerificationFailure: priorFailure, verificationDiagnosis: diagnosis,
      verification, verificationRunner: verifier,
    }, { runtime, runs, verifier });

    assert.equal(built.run.state, "verifying");
    assert.equal(built.submission.summary, "Added the guard");
    assert.deepEqual(runtime.tasks[2]?.tools, ["read", "grep", "find", "ls", "compute", "verify", "edit", "write"]);
    assert.equal(runtime.tasks[2]?.verification?.commands[0]?.id, "test");
    assert.match(runtime.tasks[2]?.instructions ?? "", /test=npm test/);
    assert.match(runtime.tasks[2]?.instructions ?? "", /Root cause: The source joins lines/);
    assert.match(runtime.tasks[2]?.instructions ?? "", /Rejected previous hypotheses/);
    assert.match(runtime.tasks[2]?.instructions ?? "", /buildWorkItem/);
    assert.match(runtime.tasks[2]?.instructions ?? "", /minimal fix/);
    assert.match(runtime.tasks[2]?.instructions ?? "", /criterion-by-criterion implementation checklist/);
    assert.match(runtime.tasks[2]?.instructions ?? "", /self-review the complete diff/);
    assert.ok(!runtime.tasks[2]?.tools.includes("bash"));
    assert.ok(runtime.tasks[2]?.workspace.scope.readRoots.includes("src"));
    assert.deepEqual(runtime.tasks[2]?.workspace.scope.writeRoots, []);
    assert.deepEqual(runtime.tasks[2]?.workspace.scope.writePaths, ["src/a.ts"]);
  });
});
