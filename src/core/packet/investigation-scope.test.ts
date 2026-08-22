import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { describe, it } from "node:test";
import { createArtifact } from "../artifacts/schema.js";
import { createInvestigationScopeReceipt, deriveInvestigationScopeDecision, validateInvestigationScopeReceipt } from "./investigation-scope.js";

const subject = { repo: "example/repo", issue: 458 } as const;
let baseSha = "a".repeat(40);
function artifacts() {
  const intent = createArtifact({ kind: "Intent", runId: "run-458", subject, producer: { role: "controller" }, payload: { title: "Architecture", problem: "No issue paths", constraints: [], acceptanceHints: [], dependencies: [] } }, { id: "intent-458" });
  const investigation = createArtifact({ kind: "Investigation", runId: "run-458", subject, producer: { role: "investigator" }, payload: { outcome: "confirmed", confidence: "high", summary: "Confirmed", evidence: [{ claim: "anchor", source: "src/component/anchor.ts:1", detail: "read" }], affectedSurfaces: [], risks: [], recommendation: "build" } }, { id: "investigation-458" });
  return { intent, investigation };
}
function commitBase(cwd: string): string {
  execFileSync("git", ["init", "-q"], { cwd });
  execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd });
  execFileSync("git", ["config", "user.name", "Test"], { cwd });
  execFileSync("git", ["add", "."], { cwd });
  execFileSync("git", ["commit", "-qm", "base"], { cwd });
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim();
}

describe("investigation scope receipt", () => {
  it("admits exact existing and genuinely new paths under an evidence-backed component", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "forge-scope-"));
    try {
      await mkdir(join(cwd, "src/component"), { recursive: true });
      await writeFile(join(cwd, "src/component/anchor.ts"), "export const anchor = true;\n");
      await writeFile(join(cwd, "src/related.ts"), "import './component/anchor.js';\n");
      baseSha = commitBase(cwd);
      const { intent, investigation } = artifacts();
      const decision = await deriveInvestigationScopeDecision({ runId: "run-458", subject, intent, investigation, baseSha, cwd, evidencePaths: ["src/component/anchor.ts"], proposedPaths: ["src/component/anchor.ts", "src/component/new-architecture.ts"] });
      assert.deepEqual(decision.approvedPaths, ["src/component/anchor.ts", "src/component/new-architecture.ts"]);
      assert.deepEqual(decision.newPaths, ["src/component/new-architecture.ts"]);
      const overlapInvestigation = { ...investigation, payload: { ...investigation.payload, affectedSurfaces: ["src/component/anchor.ts"] } };
      const overlap = await deriveInvestigationScopeDecision({ runId: "run-458", subject, intent, investigation: overlapInvestigation, baseSha, cwd, evidencePaths: ["src/component/anchor.ts"], proposedPaths: ["src/component/new-architecture.ts"] });
      assert.equal(overlap.evidenceDigests.length, 1);
      assert.equal(overlap.evidenceBytes, Buffer.byteLength("export const anchor = true;\n"));
      await writeFile(join(cwd, "src/related.ts"), "anchor\n");
      await assert.rejects(() => deriveInvestigationScopeDecision({ runId: "run-458", subject, intent, investigation, baseSha, cwd, evidencePaths: ["src/component/anchor.ts"], proposedPaths: ["src/related.ts"] }), /unrelated/);
      await writeFile(join(cwd, "src/component/precreated.ts"), "import './anchor.js';\n");
      const precreated = await deriveInvestigationScopeDecision({ runId: "run-458", subject, intent, investigation, baseSha, cwd, evidencePaths: ["src/component/anchor.ts"], proposedPaths: ["src/component/precreated.ts"] });
      assert.deepEqual(precreated.newPaths, ["src/component/precreated.ts"]);
      const again = await deriveInvestigationScopeDecision({ runId: "run-458", subject, intent, investigation, baseSha, cwd, evidencePaths: ["src/component/anchor.ts"], proposedPaths: ["src/component/anchor.ts", "src/component/new-architecture.ts"] });
      assert.deepEqual(again, decision);
      const receipt = createInvestigationScopeReceipt({ runId: "run-458", subject, intent, investigation, baseSha, decision, relationCheckpointId: "relation-graph:checkpoint", relationCheckpointDigest: "b".repeat(64) });
      assert.doesNotThrow(() => validateInvestigationScopeReceipt({ receipt, runId: "run-458", subject, intent, investigation, baseSha, proposalPaths: decision.proposalPaths, expectedPaths: decision.approvedPaths, relationGraph: { checkpointId: receipt.relationCheckpointId, checkpointDigest: receipt.relationCheckpointDigest, baseSha } }));
    } finally { await rm(cwd, { recursive: true, force: true }); }
  });

  it("rejects foreign, tampered, stale, over-limit, and symlink candidates", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "forge-scope-invalid-"));
    const outside = await mkdtemp(join(tmpdir(), "forge-scope-outside-"));
    try {
      await mkdir(join(cwd, "src/component"), { recursive: true });
      await writeFile(join(cwd, "src/component/anchor.ts"), "anchor\n");
      await writeFile(join(outside, "foreign.ts"), "foreign\n");
      await writeFile(join(cwd, "docs-foreign.ts"), "foreign\n");
      await symlink(join(outside, "foreign.ts"), join(cwd, "src/component/link.ts"));
      baseSha = commitBase(cwd);
      const { intent, investigation } = artifacts();
      const base = { runId: "run-458", subject, intent, investigation, baseSha, cwd, evidencePaths: ["src/component/anchor.ts"] } as const;
      await assert.rejects(() => deriveInvestigationScopeDecision({ ...base, evidencePaths: [], proposedPaths: ["src/component/new.ts"] }), /no safe evidence-backed/);
      await assert.rejects(() => deriveInvestigationScopeDecision({ ...base, proposedPaths: ["../foreign.ts"] }), /exact safe|Unsafe/);
      await assert.rejects(() => deriveInvestigationScopeDecision({ ...base, proposedPaths: ["src/component/link.ts"] }), /Unsafe/);
      await assert.rejects(() => deriveInvestigationScopeDecision({ ...base, proposedPaths: ["docs-foreign.ts"] }), /unrelated/);
      await assert.rejects(() => deriveInvestigationScopeDecision({ ...base, proposedPaths: ["src/component/new.ts"], limits: { maxNewPaths: 0 } }), /New-path bound/);
      const decision = await deriveInvestigationScopeDecision({ ...base, proposedPaths: ["src/component/new.ts"] });
      const receipt = createInvestigationScopeReceipt({ ...base, decision, relationCheckpointId: "relation-graph:checkpoint", relationCheckpointDigest: "b".repeat(64) });
      assert.throws(() => validateInvestigationScopeReceipt({ receipt: { ...receipt, baseSha: "c".repeat(40) }, runId: "run-458", subject, intent, investigation, baseSha, proposalPaths: decision.proposalPaths, expectedPaths: decision.approvedPaths, relationGraph: { checkpointId: receipt.relationCheckpointId, checkpointDigest: receipt.relationCheckpointDigest, baseSha } }), /base SHA/);
      assert.throws(() => validateInvestigationScopeReceipt({ receipt: { ...receipt, approvedPaths: ["src/component/new.ts", "src/foreign.ts"] }, runId: "run-458", subject, intent, investigation, baseSha, proposalPaths: decision.proposalPaths, expectedPaths: decision.approvedPaths, relationGraph: { checkpointId: receipt.relationCheckpointId, checkpointDigest: receipt.relationCheckpointDigest, baseSha } }), /decision digest|expected paths/);
    } finally { await rm(cwd, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
  });
});
