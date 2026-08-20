// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { adapterForLanguage, ConfiguredRepositoryAdapter, NoTargetRepositoryAdapter, repositoryAdaptersFor, UnsupportedRepositoryLayoutError } from "../../adapters/repository/bounded-adapter.js";
import { buildRelationGraph, closeRelationGraph, digestRelation, fileNodeId, type RelationGraphLimits } from "./relation-graph.js";

const limits: RelationGraphLimits = { maxNodes: 100, maxEdges: 100, maxDepth: 8, maxFiles: 100, maxBytes: 100_000, maxCollateralPaths: 10 };

async function fixture(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "forgedock-relation-"));
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(root, path, ".."), { recursive: true });
    await writeFile(join(root, path), content);
  }
  return root;
}

describe("controller relation graph", () => {
  it("is deterministic and computes a bounded fixed point", () => {
    const edge = { id: "e", sourceId: fileNodeId("src/a.ts"), targetId: fileNodeId("src/b.ts"), kind: "import" as const, adapterId: "fixture", provenance: "repository" as const, sourcePath: "src/a.ts", targetPath: "src/b.ts", evidenceDigest: digestRelation("a imports b") };
    const nodeDigest = digestRelation("fixture-node");
    const input = { baseSha: "a".repeat(40), seeds: [{ path: "src/a.ts", provenance: "issue" as const }], facts: [{ adapterId: "fixture", nodes: [{ id: fileNodeId("src/a.ts"), kind: "file" as const, identity: "src/a.ts", digest: nodeDigest }, { id: fileNodeId("src/b.ts"), kind: "file" as const, identity: "src/b.ts", digest: nodeDigest }], edges: [edge] }], limits };
    const first = buildRelationGraph(input);
    const second = buildRelationGraph({ ...input, facts: [...input.facts].reverse() });
    assert.equal(first.graphDigest, second.graphDigest);
    const closure = closeRelationGraph(first);
    assert.deepEqual(closure.writablePaths, ["src/a.ts", "src/b.ts"]);
    assert.equal(closure.diagnostics.length, 0);
  });

  it("rejects investigation-only authority and unrelated tests", () => {
    assert.throws(() => buildRelationGraph({ baseSha: "b".repeat(40), seeds: [{ path: "src/a.ts", provenance: "investigation" as never }], limits }), /investigation|suggestions/i);
    const graph = buildRelationGraph({
      baseSha: "c".repeat(40),
      seeds: [{ path: "src/a.ts", provenance: "issue" }],
      facts: [{ adapterId: "fixture", nodes: [
        { id: fileNodeId("src/a.ts"), kind: "file", identity: "src/a.ts", digest: digestRelation("a") },
        { id: fileNodeId("test/a.test.ts"), kind: "test", identity: "test/a.test.ts", digest: digestRelation("test-a") },
        { id: fileNodeId("test/unrelated.test.ts"), kind: "test", identity: "test/unrelated.test.ts", digest: digestRelation("test-unrelated") },
      ], edges: [{ id: "cover", sourceId: fileNodeId("test/a.test.ts"), targetId: fileNodeId("src/a.ts"), kind: "test-covers", adapterId: "fixture", provenance: "repository", sourcePath: "test/a.test.ts", targetPath: "src/a.ts", evidenceDigest: digestRelation("cover") }] }], limits,
    });
    const closure = closeRelationGraph(graph);
    assert.ok(closure.evidencePaths.includes("test/a.test.ts"));
    assert.ok(closure.writablePaths.includes("test/a.test.ts"));
    assert.ok(!closure.evidencePaths.includes("test/unrelated.test.ts"));
  });

  it("rejects conflicting edge IDs and missing authoritative node digests", () => {
    assert.throws(() => buildRelationGraph({ baseSha: "d".repeat(40), seeds: [{ path: "src/./escape.ts", provenance: "issue" }], limits }), /Invalid repository path/);
    assert.throws(() => buildRelationGraph({ baseSha: "d".repeat(40), seeds: [{ path: "..\\escape.ts", provenance: "issue" }], limits }), /Invalid repository path/);
    assert.throws(() => buildRelationGraph({ baseSha: "e".repeat(40), seeds: [{ path: "a.ts", provenance: "issue" }], facts: [{ adapterId: "x", nodes: [], edges: [{ id: "bad", sourceId: "x", targetId: "y", kind: "import", adapterId: "x", provenance: "repository", evidenceDigest: "bad" }] }], limits }), /digest/);
    const digest = digestRelation("node");
    const node = { id: fileNodeId("src/a.ts"), kind: "file" as const, identity: "src/a.ts", digest };
    const edge = { id: "same", sourceId: node.id, targetId: node.id, kind: "import" as const, adapterId: "a", provenance: "repository" as const, sourcePath: "src/a.ts", targetPath: "src/a.ts", evidenceDigest: digestRelation("one") };
    assert.throws(() => buildRelationGraph({ baseSha: "1".repeat(40), seeds: [{ path: "src/a.ts", provenance: "issue", contentDigest: digest }], facts: [{ adapterId: "a", nodes: [node], edges: [edge] }, { adapterId: "b", nodes: [node], edges: [{ ...edge, adapterId: "b", evidenceDigest: digestRelation("two") }] }] }), /edge collision/);
    const { digest: _omittedDigest, ...undigestedNode } = node;
    assert.throws(() => buildRelationGraph({ baseSha: "2".repeat(40), seeds: [{ path: "src/a.ts", provenance: "issue" }], facts: [{ adapterId: "a", nodes: [undigestedNode], edges: [] }] }), /valid content digest/);
  });

  it("keeps closure bounded by bytes, files, depth, and collateral", () => {
    const digest = digestRelation("node");
    const node = (path: string) => ({ id: fileNodeId(path), kind: "file" as const, identity: path, digest });
    assert.throws(() => buildRelationGraph({ baseSha: "3".repeat(40), seeds: [{ path: "src/a.ts", provenance: "issue", contentDigest: digest }], facts: [{ adapterId: "a", nodes: [node("src/a.ts")], edges: [], fileCount: 2, byteCount: 101 }], limits: { ...limits, maxFiles: 1, maxBytes: 100 } }), /maxFiles|maxBytes/);
  });

});

describe("repository adapter layouts", () => {
  it("supports explicit TS/JS, Python, Go, Rust, JVM, monorepo, and generated manifests", async () => {
    const root = await fixture({
      "src/app.ts": "import './worker.js'", "src/worker.js": "export {}", "src/app.test.ts": "import './app.ts'",
      "py/main.py": "", "pyproject.toml": "", "cmd/main.go": "", "go.mod": "module example",
      "lib/lib.rs": "", "Cargo.toml": "[package]", "jvm/Main.java": "", "pom.xml": "<project />", "generated/app.generated.ts": "",
    });
    try {
      for (const language of ["typescript", "javascript", "python", "go", "rust", "jvm", "monorepo", "generated"]) {
        const adapter = adapterForLanguage(language);
        const result = await adapter.inspect({ cwd: root, limits });
        assert.equal(result.adapterId, language === "typescript" || language === "javascript" ? language : language);
        assert.ok(result.nodes.length > 0, language);
      }
      const generated = await adapterForLanguage("generated").inspect({ cwd: root, limits });
      assert.ok(generated.nodes.some((node) => node.kind === "generated"));
      assert.ok(generated.edges.some((edge) => edge.kind === "generated-by"));    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("supports configured and explicit no-target runners", async () => {
    const root = await fixture({ "src/a.ts": "" });
    try {
      const configured = new ConfiguredRepositoryAdapter("configured", ["configured"], ["src/a.ts"]);
      assert.deepEqual((await configured.inspect({ cwd: root, limits, configuredTargets: ["src/a.ts"] })).targets, ["src/a.ts"]);
      assert.deepEqual((await new NoTargetRepositoryAdapter().inspect({ cwd: root, limits })).nodes, []);
      assert.equal(repositoryAdaptersFor([])[0]?.id, "no-target");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("rejects unsupported and ambiguous layouts", () => {
    assert.throws(() => adapterForLanguage("php"), UnsupportedRepositoryLayoutError);
    assert.throws(() => repositoryAdaptersFor(["python", "rust"]), /ambiguous/);
  });
});
