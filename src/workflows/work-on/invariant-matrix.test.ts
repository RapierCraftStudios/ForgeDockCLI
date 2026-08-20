import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { deriveSecurityInvariantMatrices, expandInvariantMatrix, invariantMatrixCaseIds, invariantMatrixIdentities } from "./invariant-matrix.js";

describe("security-sensitive invariant matrices", () => {
  it("derives deterministic redaction, chunk, adapter, identity, and terminal evidence from criterion semantics", () => {
    const packet = {
      acceptanceCriteria: [
        "Credential redaction grammar handles marker suffixes and every split chunk boundary.",
        "Controller adapter lifecycle keeps interleaved node and session identity isolated.",
        "Successful, failed, and cancelled terminal events retain metadata ordering.",
      ],
      risks: [{ risk: "security credential exposure and identity collision", mitigation: "focused matrix regressions" }],
    };
    const first = deriveSecurityInvariantMatrices(packet);
    const second = deriveSecurityInvariantMatrices(packet);
    assert.deepEqual(first, second);
    assert.deepEqual(new Set(first.map(({ capability }) => capability)), new Set([
      "redaction-grammar", "chunk-boundary", "adapter-lifecycle", "identity-isolation", "terminal-metadata",
    ]));
    assert.ok(first.every(({ id, testId, criterionId }) => testId === `invariant:${id}` && /^criterion-[1-9]/.test(criterionId)));
    const redaction = first.find(({ capability }) => capability === "redaction-grammar");
    assert.ok(redaction);
    const cases = expandInvariantMatrix(redaction);
    assert.equal(cases.length, 4 * 4 * 4);
    assert.deepEqual(cases[0]?.values, { grammar: "key-value", marker: "plain", delimiter: "end" });
  });

  it("does not manufacture security matrices for unrelated routine packets and bounds expansion", () => {
    assert.deepEqual(deriveSecurityInvariantMatrices({
      acceptanceCriteria: ["Documentation renders."], risks: [{ risk: "formatting", mitigation: "snapshot" }],
    }), []);
    assert.throws(() => expandInvariantMatrix({
      id: "matrix-bounded", criterionId: "criterion-1", capability: "chunk-boundary",
      dimensions: [{ name: "a", values: ["1", "2"] }, { name: "b", values: ["1", "2"] }],
      testId: "invariant:matrix-bounded",
    }, 3), /expands beyond 3 cases/);

    const exact = expandInvariantMatrix({
      id: "matrix-exact", criterionId: "criterion-1", capability: "chunk-boundary",
      dimensions: [{ name: "a", values: ["1", "2"] }, { name: "b", values: ["x", "y"] }],
      testId: "invariant:matrix-exact",
    }, 4);
    assert.deepEqual(exact, [
      { id: "invariant:matrix-exact:case-001", values: { a: "1", b: "x" } },
      { id: "invariant:matrix-exact:case-002", values: { a: "1", b: "y" } },
      { id: "invariant:matrix-exact:case-003", values: { a: "2", b: "x" } },
      { id: "invariant:matrix-exact:case-004", values: { a: "2", b: "y" } },
    ]);

    const values = new Proxy(["1", "2"], {
      get(target, property, receiver) {
        if (property === "map") throw new Error("allocation attempted");
        return Reflect.get(target, property, receiver) as unknown;
      },
    });
    assert.throws(() => expandInvariantMatrix({
      id: "matrix-prechecked", criterionId: "criterion-1", capability: "chunk-boundary",
      dimensions: [{ name: "a", values }],
      testId: "invariant:matrix-prechecked",
    }, 1), /expands beyond 1 cases/);
  });

  it("centralizes stable row, test, and expanded case IDs", () => {
    const row = {
      id: "matrix-terminal", criterionId: "criterion-1" as const, capability: "terminal-metadata" as const,
      dimensions: [{ name: "state", values: ["passed", "failed"] }], testId: "invariant:matrix-terminal",
    };
    const expectedCases = expandInvariantMatrix(row).map(({ id }) => id);
    assert.deepEqual(invariantMatrixCaseIds([row]), [row.testId, ...expectedCases]);
    assert.deepEqual(invariantMatrixIdentities([row]), { rowIds: [row.id], testIds: [row.testId], caseIds: expectedCases });
  });
});
