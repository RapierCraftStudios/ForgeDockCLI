// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { deriveEvidenceContract, validateEvidenceContract } from "./evidence-contract.js";

const base = {
  acceptanceCriteria: ["Fix behavior", "Staging review"],
  expectedPaths: ["src/fix.ts", "src/fix.test.ts"],
  evidencePaths: [{ path: "src/fix.test.ts", criterionIds: ["criterion-1"], role: "test" as const }],
  commands: [
    { id: "diff-check", evidenceCapability: "generic" as const },
    { id: "build", evidenceCapability: "generic" as const },
    { id: "test", evidenceCapability: "targeted-test" as const, targets: ["dist/fix.test.js"] },
  ],
};

describe("evidence contract", () => {
  it("rejects generic-only implementation evidence but accepts gate-only criteria", () => {
    const result = deriveEvidenceContract({
      ...base,
      verificationRequirements: [
        { kind: "command", id: "build", criterionIds: ["criterion-1"], rationale: "compile" },
        { kind: "controller-gate", id: "staging-review", criterionIds: ["criterion-2"], rationale: "controller" },
      ],
      controllerGates: [{ id: "staging-review" }],
    });
    assert.equal(result.diagnostics.some(({ code, criterionId }) => code === "generic-only-command" && criterionId === "criterion-1"), true);
    assert.equal(result.diagnostics.some(({ criterionId }) => criterionId === "criterion-2"), false);
  });

  it("requires semantic commands when a criterion mixes a gate and command", () => {
    const result = deriveEvidenceContract({
      ...base,
      verificationRequirements: [
        { kind: "controller-gate", id: "staging-review", criterionIds: ["criterion-1"], rationale: "controller" },
        { kind: "command", id: "build", criterionIds: ["criterion-1"], rationale: "compile" },
      ],
      controllerGates: [{ id: "staging-review" }],
    });
    assert.ok(result.diagnostics.some(({ code }) => code === "generic-only-command"));
  });

  it("requires controller-derived targets and a proving semantic command for invariant rows", () => {
    const result = deriveEvidenceContract({
      ...base,
      commands: [{ id: "test", evidenceCapability: "targeted-test" as const }],
      verificationRequirements: [
        { kind: "command", id: "test", criterionIds: ["criterion-1"], rationale: "regression" },
      ],
      invariantMatrices: [{
        id: "matrix-one", criterionId: "criterion-1", capability: "terminal-metadata",
        dimensions: [{ name: "state", values: ["ok"] }], testId: "invariant:matrix-one",
      }],
    });
    assert.ok(result.diagnostics.some(({ code }) => code === "unusable-semantic-command"));
    assert.ok(result.diagnostics.some(({ code }) => code === "invariant-command-missing"));
  });

  it("reports unknown declaration criteria and deduplicates frozen IDs", () => {
    const result = deriveEvidenceContract({
      ...base,
      evidencePaths: [{ path: "src/fix.ts", criterionIds: ["criterion-9"], role: "source" }],
      verificationRequirements: [
        { kind: "command", id: "test", criterionIds: ["criterion-1"], rationale: "one" },
        { kind: "command", id: "test", criterionIds: ["criterion-1"], rationale: "duplicate" },
      ],
    });
    assert.ok(result.diagnostics.some(({ code, criterionId }) => code === "unknown-criterion" && criterionId === "criterion-9"));
    assert.deepEqual(result.contract.criteria[0]?.requiredCommandIds, ["test"]);
  });

  it("derives deterministic semantic and matrix identities without leaking command execution", () => {
    const result = deriveEvidenceContract({
      ...base,
      verificationRequirements: [
        { kind: "command", id: "test", criterionIds: ["criterion-1"], rationale: "regression" },
        { kind: "command", id: "build", criterionIds: ["criterion-1"], rationale: "compile" },
      ],
      invariantMatrices: [{
        id: "matrix-one", criterionId: "criterion-1", capability: "terminal-metadata",
        dimensions: [{ name: "state", values: ["ok", "failed"] }], testId: "invariant:matrix-one",
      }],
    });
    assert.deepEqual(result.contract.criteria[0], {
      criterionId: "criterion-1",
      requiredCommandIds: ["build", "test"],
      semanticCommandIds: ["test"],
      controllerGateIds: [],
      allowedWritePaths: ["src/fix.test.ts", "src/fix.ts"],
      allowedEvidencePaths: ["src/fix.test.ts"],
      invariantRowIds: ["matrix-one"],
      invariantTestIds: ["invariant:matrix-one"],
      invariantCaseIds: ["invariant:matrix-one:case-001", "invariant:matrix-one:case-002"],
    });
    assert.equal(JSON.stringify(result.contract).includes("dist/fix.test.js"), false);
  });

  it("returns all malformed path diagnostics and detects rederivation mismatch", () => {
    const result = deriveEvidenceContract({ ...base, expectedPaths: ["../escape", "src/ok.ts"], evidencePaths: [
      { path: "*.test.ts", criterionIds: ["criterion-1"], role: "test" },
      { path: "src/ok.ts", criterionIds: ["criterion-1"], role: "source" },
    ] });
    assert.ok(result.diagnostics.some(({ code }) => code === "invalid-write-path"));
    assert.ok(result.diagnostics.some(({ code }) => code === "invalid-evidence-path"));
    const altered = { ...result.contract, criteria: result.contract.criteria.map((criterion) => ({ ...criterion, semanticCommandIds: ["forged"] })) };
    assert.ok(validateEvidenceContract(altered, { ...base, expectedPaths: ["../escape", "src/ok.ts"], evidencePaths: [
      { path: "*.test.ts", criterionIds: ["criterion-1"], role: "test" },
      { path: "src/ok.ts", criterionIds: ["criterion-1"], role: "source" },
    ] }).some(({ code }) => code === "contract-mismatch"));
  });
});
