// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { adapterForLanguage } from "../../adapters/repository/bounded-adapter.js";
import { buildRelationGraph, closeRelationGraph, graphCommandPlanDigest, graphConfigDigest, graphEvidenceContractDigest, relationGraphCheckpointPayload, digestRelation } from "./relation-graph.js";
import { certifyRelationGraphCheckpoint } from "./relation-checkpoint-certification.js";

const limits = { maxNodes: 100, maxEdges: 100, maxDepth: 8, maxFiles: 100, maxBytes: 100_000, maxCollateralPaths: 10 };

describe("relation checkpoint certification", () => {
  it("re-reads synthetic TypeScript authority and rejects byte drift", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "forgedock-relation-cert-"));
    try {
      await writeFile(join(cwd, "src-a.ts"), "import './src-b.js';");
      await writeFile(join(cwd, "src-b.js"), "export const b = true;");
      await writeFile(join(cwd, "evidence-only.ts"), "export const evidence = true;");
      const adapter = adapterForLanguage("typescript");
      const facts = [await adapter.inspect({ cwd, limits })];
      const seedNode = facts[0]!.nodes.find((node) => node.identity === "src-a.ts")!;
      const seeds = [{ path: "src-a.ts", provenance: "issue" as const, contentDigest: seedNode.digest! }];
      const graph = buildRelationGraph({ baseSha: "a".repeat(40), seeds, facts, limits });
      const closure = closeRelationGraph(graph);
      const commandPlan = {
        verificationPolicyVersion: "forgedock.verification/v2",
        verificationCommandTargets: [{ id: "build", targets: [] }],
        verificationCommandIdentities: [{ id: "build", command: "npm", args: ["run", "build"], evidenceCapability: "generic" as const, identityDigest: digestRelation("npm run build") }],
      };
      const authoritativeEvidencePaths = [...new Set([...closure.evidencePaths, "evidence-only.ts"])].sort();
      const authoritativeClosure = {
        ...closure,
        evidencePaths: authoritativeEvidencePaths,
        commandIds: ["build"],
        closureDigest: digestRelation({ graphDigest: graph.graphDigest, writablePaths: closure.writablePaths, evidencePaths: authoritativeEvidencePaths, invariantIds: closure.invariantIds, commandIds: ["build"] }),
      };
      const configDigest = graphConfigDigest({ adapters: graph.adapterIds, limits: graph.limits });
      const commandPlanDigest = graphCommandPlanDigest(commandPlan);
      const evidenceContractDigest = graphEvidenceContractDigest(undefined);
      const checkpoint = relationGraphCheckpointPayload({ graph, closure: authoritativeClosure, configDigest, commandPlanDigest, evidenceContractDigest });
      const packet = {
        relationGraph: {
          version: "forgedock.relation-graph/v1" as const, baseSha: graph.baseSha, graphDigest: graph.graphDigest,
          configDigest, closureDigest: authoritativeClosure.closureDigest, commandPlanDigest, evidenceContractDigest,
          checkpointId: checkpoint.checkpointId, checkpointDigest: checkpoint.checkpointDigest,
          writablePaths: authoritativeClosure.writablePaths, evidencePaths: authoritativeClosure.evidencePaths,
          invariantIds: authoritativeClosure.invariantIds, commandIds: authoritativeClosure.commandIds,
        },
        expectedPaths: authoritativeClosure.writablePaths,
        evidencePaths: [{ path: "evidence-only.ts", criterionIds: ["criterion-1"], role: "source" as const }],
        ...commandPlan,
      };
      await certifyRelationGraphCheckpoint({ checkpoint, packet, cwd, baseSha: "a".repeat(40), adapters: [adapter] });
      await writeFile(join(cwd, "src-b.js"), "export const b = false;");
      await assert.rejects(() => certifyRelationGraphCheckpoint({ checkpoint, packet, cwd, baseSha: "a".repeat(40), adapters: [adapter] }), /graph-drift|graph-authority/);
      assert.equal(digestRelation("keeps the fixture content-based" ).length, 64);
    } finally { await rm(cwd, { recursive: true, force: true }); }
  });
});
