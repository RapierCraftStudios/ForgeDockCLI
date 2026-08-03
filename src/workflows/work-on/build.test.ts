import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createArtifact, type BuildPacketPayload, type InvestigationPayload } from "../../core/artifacts/schema.js";
import { InMemoryArtifactRepository, InMemoryRunRepository } from "../../core/ports/repositories.js";
import { FakeAgentRuntime } from "../../runtime/fake-runtime.js";
import { buildWorkItem, type BuilderSubmission } from "./build.js";
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

describe("builder boundary", () => {
  it("permits worktree edits but withholds shell and GitHub authority", async () => {
    const runtime = new FakeAgentRuntime([investigation, packet, submission]);
    const artifacts = new InMemoryArtifactRepository();
    const runs = new InMemoryRunRepository();
    const intent = createArtifact({
      kind: "Intent", runId: "run_build", subject: { repo: "a/b", issue: 1 }, producer: { role: "controller" },
      payload: { title: "Guard", problem: "Race", constraints: [], acceptanceHints: [], dependencies: [] },
    });
    const investigated = await investigateWorkItem({ intent, cwd: process.cwd() }, { runtime, artifacts, runs });
    const prepared = await prepareBuildPacket({ run: investigated.run, intent, investigation: investigated.investigation, cwd: process.cwd() }, { runtime, artifacts, runs });
    const built = await buildWorkItem({
      run: prepared.run, intent, investigation: investigated.investigation, packet: prepared.packet, worktree: process.cwd(),
    }, { runtime, runs });

    assert.equal(built.run.state, "verifying");
    assert.equal(built.submission.summary, "Added the guard");
    assert.deepEqual(runtime.tasks[2]?.tools, ["read", "grep", "find", "ls", "edit", "write"]);
    assert.ok(!runtime.tasks[2]?.tools.includes("bash"));
  });
});
