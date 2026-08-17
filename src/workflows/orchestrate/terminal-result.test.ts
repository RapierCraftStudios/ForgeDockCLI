// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createArtifact, type DurableArtifact } from "../../core/artifacts/schema.js";
import { reconcileLatestRunArtifacts } from "../../core/state/reconcile.js";
import { terminalOrchestrationResult } from "./terminal-result.js";

const common = { runId: "run_current", subject: { repo: "a/b", issue: 190 }, producer: { role: "test" } };
const intent = createArtifact({ ...common, kind: "Intent", payload: { title: "Fix", problem: "Broken", constraints: [], acceptanceHints: [], dependencies: [] } });
const investigation = createArtifact({ ...common, kind: "Investigation", payload: { outcome: "confirmed", confidence: "high", summary: "Confirmed", evidence: [{ claim: "Broken", source: "a", detail: "b" }], rootCause: "cause", affectedSurfaces: ["a"], risks: [], recommendation: "fix" } });
const packet = createArtifact({ ...common, kind: "BuildPacket", payload: { scope: ["fix"], acceptanceCriteria: ["pass"], context: [], implementationPlan: ["edit"], expectedPaths: ["a"], verificationPlan: ["test"], risks: [], outOfScope: [] } });
const blocked = createArtifact({ ...common, kind: "Outcome", payload: { status: "blocked", reason: "repairable verification mismatch", childIssues: [] } });
const build = createArtifact({ ...common, kind: "BuildResult", payload: { branch: "fix", headSha: "a".repeat(40), changedPaths: ["a"], summary: "repaired", acceptanceEvidence: [{ criterion: "pass", status: "passed", evidence: "test" }], checks: [{ command: "test", status: "passed", durationMs: 1 }], decisions: [], residualRisks: [] } });

describe("orchestration terminal artifact classification", () => {
  it("does not resurrect a blocked Outcome superseded by a later BuildResult", () => {
    const artifacts = [intent, investigation, packet, blocked, build] as DurableArtifact[];
    const reconciled = reconcileLatestRunArtifacts(artifacts);
    assert.equal(reconciled.state, "publishing");
    assert.equal(terminalOrchestrationResult(190, artifacts, reconciled), undefined);
  });

  it("returns the current run's matching terminal Outcome reason", () => {
    const artifacts = [intent, investigation, packet, blocked] as DurableArtifact[];
    const reconciled = reconcileLatestRunArtifacts(artifacts);
    assert.deepEqual(terminalOrchestrationResult(190, artifacts, reconciled), {
      status: "blocked",
      error: "#190 reached blocked: repairable verification mismatch",
    });
  });

  it("ignores a terminal Outcome owned by an older semantic run", () => {
    const oldIntent = { ...intent, runId: "run_old" };
    const oldBlocked = { ...blocked, runId: "run_old" };
    const artifacts = [oldIntent, oldBlocked, intent] as DurableArtifact[];
    const reconciled = reconcileLatestRunArtifacts(artifacts);
    assert.equal(reconciled.runId, "run_current");
    assert.equal(reconciled.state, "investigating");
    assert.equal(terminalOrchestrationResult(190, artifacts, reconciled), undefined);
  });
});
